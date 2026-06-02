#include "ws_client.h"
#include "base64.h"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <ctime>

namespace {

// Parse ws://host:port/path into components. Returns false if not ws://.
bool parseUrl(const std::string& url, std::string& host, std::string& port,
              std::string& path) {
  std::string rest;
  if (url.rfind("ws://", 0) == 0) {
    rest = url.substr(5);
  } else if (url.rfind("http://", 0) == 0) {
    rest = url.substr(7);
  } else {
    return false;
  }
  size_t slash = rest.find('/');
  std::string authority = slash == std::string::npos ? rest : rest.substr(0, slash);
  path = slash == std::string::npos ? "/" : rest.substr(slash);
  if (path.empty()) path = "/";
  size_t colon = authority.find(':');
  if (colon == std::string::npos) {
    host = authority;
    port = "80";
  } else {
    host = authority.substr(0, colon);
    port = authority.substr(colon + 1);
  }
  return !host.empty();
}

void fillRandom(uint8_t* buf, size_t n) {
  for (size_t i = 0; i < n; i++) buf[i] = static_cast<uint8_t>(rand() & 0xFF);
}

bool writeAll(int fd, const char* data, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t w = ::send(fd, data + off, len - off, 0);
    if (w <= 0) {
      if (w < 0 && (errno == EINTR)) continue;
      return false;
    }
    off += static_cast<size_t>(w);
  }
  return true;
}

}  // namespace

bool WsClient::connectUrl(const std::string& wsUrl, std::string& err) {
  srand(static_cast<unsigned>(time(nullptr)) ^ static_cast<unsigned>(getpid()));

  std::string host, port, path;
  if (!parseUrl(wsUrl, host, port, path)) {
    err = "invalid ws url: " + wsUrl;
    return false;
  }

  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  if (getaddrinfo(host.c_str(), port.c_str(), &hints, &res) != 0 || !res) {
    err = "getaddrinfo failed for " + host + ":" + port;
    return false;
  }

  int fd = -1;
  for (addrinfo* ai = res; ai; ai = ai->ai_next) {
    fd = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) continue;
    if (::connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
    ::close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0) {
    err = "TCP connect failed to " + host + ":" + port;
    return false;
  }

  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  m_fd = fd;

  // Build handshake request.
  uint8_t key[16];
  fillRandom(key, sizeof(key));
  std::string keyB64 = base64Encode(key, sizeof(key));

  std::string req = "GET " + path + " HTTP/1.1\r\n";
  req += "Host: " + host + ":" + port + "\r\n";
  req += "Upgrade: websocket\r\n";
  req += "Connection: Upgrade\r\n";
  req += "Sec-WebSocket-Key: " + keyB64 + "\r\n";
  req += "Sec-WebSocket-Version: 13\r\n\r\n";

  if (!writeAll(fd, req.data(), req.size())) {
    err = "handshake write failed";
    ::close(fd);
    m_fd = -1;
    return false;
  }

  // Read response headers up to and including the terminating \r\n\r\n.
  std::string resp;
  char buf[1024];
  while (resp.find("\r\n\r\n") == std::string::npos) {
    ssize_t r = ::recv(fd, buf, sizeof(buf), 0);
    if (r <= 0) {
      if (r < 0 && errno == EINTR) continue;
      err = "handshake read failed";
      ::close(fd);
      m_fd = -1;
      return false;
    }
    resp.append(buf, static_cast<size_t>(r));
    if (resp.size() > 65536) {
      err = "handshake response too large";
      ::close(fd);
      m_fd = -1;
      return false;
    }
  }

  if (resp.find(" 101") == std::string::npos) {
    err = "handshake did not return 101: " + resp.substr(0, 64);
    ::close(fd);
    m_fd = -1;
    return false;
  }

  // Any bytes after the header terminator are the start of the WS stream.
  size_t hdrEnd = resp.find("\r\n\r\n") + 4;
  if (hdrEnd < resp.size()) m_recvBuf.append(resp.substr(hdrEnd));

  // Non-blocking from here on: poll() is driven by select() in the main loop and
  // by a bounded loop during handshake.
  int flags = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, flags | O_NONBLOCK);

  // The handshake response may already contain a buffered WS frame; decode it.
  return true;
}

bool WsClient::sendFrame(uint8_t opcode, const std::string& payload, bool mask) {
  std::string frame;
  frame.push_back(static_cast<char>(0x80 | opcode));  // FIN + opcode

  uint8_t maskBit = mask ? 0x80 : 0x00;
  size_t n = payload.size();
  if (n <= 125) {
    frame.push_back(static_cast<char>(maskBit | static_cast<uint8_t>(n)));
  } else if (n < 65536) {
    frame.push_back(static_cast<char>(maskBit | 126));
    frame.push_back(static_cast<char>((n >> 8) & 0xFF));
    frame.push_back(static_cast<char>(n & 0xFF));
  } else {
    frame.push_back(static_cast<char>(maskBit | 127));
    for (int s = 56; s >= 0; s -= 8)
      frame.push_back(static_cast<char>((static_cast<uint64_t>(n) >> s) & 0xFF));
  }

  if (mask) {
    uint8_t key[4];
    fillRandom(key, 4);
    frame.append(reinterpret_cast<char*>(key), 4);
    size_t base = frame.size();
    frame.append(payload);
    for (size_t i = 0; i < n; i++)
      frame[base + i] = static_cast<char>(frame[base + i] ^ key[i % 4]);
  } else {
    frame.append(payload);
  }

  return writeAll(m_fd, frame.data(), frame.size());
}

bool WsClient::sendText(const std::string& utf8) {
  if (m_fd < 0) return false;
  return sendFrame(0x1, utf8, /*mask=*/true);
}

void WsClient::sendClose() {
  if (m_fd >= 0 && !m_closed) sendFrame(0x8, "", /*mask=*/true);
}

bool WsClient::poll(std::vector<std::string>& out) {
  char buf[8192];
  ssize_t r = ::recv(m_fd, buf, sizeof(buf), 0);
  if (r == 0) {
    m_closed = true;
    return false;
  }
  if (r < 0) {
    if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)
      return tryDecode(out);  // still flush any already-buffered frames
    m_closed = true;
    return false;
  }
  m_recvBuf.append(buf, static_cast<size_t>(r));
  return tryDecode(out);
}

bool WsClient::tryDecode(std::vector<std::string>& out) {
  while (true) {
    if (m_recvBuf.size() < 2) return true;
    const uint8_t* p = reinterpret_cast<const uint8_t*>(m_recvBuf.data());
    bool fin = (p[0] & 0x80) != 0;
    int opcode = p[0] & 0x0F;
    bool masked = (p[1] & 0x80) != 0;  // server should never mask
    uint64_t len = p[1] & 0x7F;
    size_t pos = 2;

    if (len == 126) {
      if (m_recvBuf.size() < pos + 2) return true;
      len = (static_cast<uint64_t>(p[2]) << 8) | p[3];
      pos += 2;
    } else if (len == 127) {
      if (m_recvBuf.size() < pos + 8) return true;
      len = 0;
      for (int i = 0; i < 8; i++) len = (len << 8) | p[pos + i];
      pos += 8;
    }

    // Sanity guard: a corrupt/hostile frame length would otherwise make us
    // buffer forever (the size check below never satisfies). CDP payloads
    // (even full-page screenshots) are well under this, so close the
    // connection instead of hanging.
    if (len > (uint64_t)512 * 1024 * 1024) {
      m_closed = true;
      return false;
    }

    size_t maskLen = masked ? 4 : 0;
    if (m_recvBuf.size() < pos + maskLen + len) return true;  // need more bytes

    const char* payloadStart = m_recvBuf.data() + pos + maskLen;
    std::string payload(payloadStart, static_cast<size_t>(len));
    if (masked) {
      const uint8_t* mk = reinterpret_cast<const uint8_t*>(m_recvBuf.data() + pos);
      for (size_t i = 0; i < payload.size(); i++)
        payload[i] = static_cast<char>(payload[i] ^ mk[i % 4]);
    }

    m_recvBuf.erase(0, pos + maskLen + static_cast<size_t>(len));

    if (opcode == 0x8) {  // close
      m_closed = true;
      return false;
    } else if (opcode == 0x9) {  // ping -> pong
      sendFrame(0xA, payload, /*mask=*/true);
      continue;
    } else if (opcode == 0xA) {  // pong, ignore
      continue;
    } else if (opcode == 0x0) {  // continuation
      m_fragment.append(payload);
      if (fin) {
        out.push_back(m_fragment);
        m_fragment.clear();
        m_fragOpcode = 0;
      }
      continue;
    } else if (opcode == 0x1 || opcode == 0x2) {  // text / binary
      if (fin) {
        out.push_back(payload);
      } else {
        m_fragment = payload;
        m_fragOpcode = opcode;
      }
      continue;
    }
    // Unknown opcode: skip.
  }
}
