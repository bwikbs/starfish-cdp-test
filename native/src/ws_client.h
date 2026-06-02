#pragma once
#include <string>
#include <vector>
#include <cstdint>

// Minimal RFC6455 WebSocket client over a raw blocking POSIX TCP socket.
// One connection. Client frames are masked (RFC requirement); server frames are
// unmasked. Partial TCP reads are accumulated until a full frame is available.
class WsClient {
 public:
  // Connect ws://host:port/path: TCP connect + HTTP Upgrade handshake.
  // Returns false and sets `err` on failure.
  bool connectUrl(const std::string& wsUrl, std::string& err);

  // Send one TEXT frame (FIN+0x1, masked). Returns false on write error.
  bool sendText(const std::string& utf8);

  // Read available bytes into the internal buffer, then decode every complete
  // TEXT message into `out`. Auto-replies pong to ping. Returns false when the
  // socket is closed/errored or a close frame was received.
  bool poll(std::vector<std::string>& out);

  void sendClose();
  int fd() const { return m_fd; }
  bool closed() const { return m_closed; }

 private:
  bool sendFrame(uint8_t opcode, const std::string& payload, bool mask);
  bool tryDecode(std::vector<std::string>& out);

  int m_fd = -1;
  bool m_closed = false;
  std::string m_recvBuf;   // raw bytes not yet decoded into frames
  std::string m_fragment;  // reassembled payload across continuation frames
  int m_fragOpcode = 0;    // opcode of the message being reassembled (0 = none)
};
