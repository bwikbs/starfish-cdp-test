// Native CDP client entry point.
//
//   argv[1] = ws endpoint (ws://host:port/path)
//
// Connects to Starfish over a raw-socket WebSocket, runs the Target flat-session
// handshake, prints a {"type":"ready",...} line, then bridges line-delimited
// JSON-RPC on stdin <-> CDP frames on the socket, multiplexed with select().

#include <unistd.h>
#include <sys/select.h>
#include <csignal>
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>

#include "cdp_client.h"
#include "cli.h"
#include "json.hpp"
#include "ws_client.h"

using json = nlohmann::json;

static void emit(const std::string& line) {
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

int main(int argc, char** argv) {
  std::signal(SIGPIPE, SIG_IGN);

  if (argc < 2) {
    emit(json({{"type", "fatal"}, {"message", "usage: starfish-cdp-native <wsEndpoint>"}}).dump());
    return 1;
  }

  // Mode branch: bridge mode when argv[1] is a ws endpoint or "--bridge"
  // (unchanged behavior, used by the Node helpers); otherwise standalone CLI.
  std::string arg1 = argv[1];
  bool bridgeMode = arg1.rfind("ws://", 0) == 0 || arg1 == "--bridge";
  if (!bridgeMode) {
    return runCli(argc, argv);
  }
  if (arg1 == "--bridge") {
    if (argc < 3) {
      emit(json({{"type", "fatal"}, {"message", "usage: starfish-cdp-native --bridge <wsEndpoint>"}}).dump());
      return 1;
    }
    arg1 = argv[2];
  }
  std::string wsEndpoint = arg1;

  WsClient ws;
  std::string err;
  if (!ws.connectUrl(wsEndpoint, err)) {
    emit(json({{"type", "fatal"}, {"message", err}}).dump());
    return 1;
  }

  CdpClient cdp(ws);
  std::string readyLine;
  if (!cdp.handshake(readyLine, err)) {
    emit(json({{"type", "fatal"}, {"message", err}}).dump());
    return 1;
  }
  emit(readyLine);

  std::string stdinBuf;
  bool running = true;

  while (running) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(STDIN_FILENO, &rfds);
    FD_SET(ws.fd(), &rfds);
    int maxfd = ws.fd() > STDIN_FILENO ? ws.fd() : STDIN_FILENO;

    int n = select(maxfd + 1, &rfds, nullptr, nullptr, nullptr);
    if (n < 0) {
      if (errno == EINTR) continue;
      break;
    }

    // stdin: parse complete lines, handle ops.
    if (FD_ISSET(STDIN_FILENO, &rfds)) {
      char buf[8192];
      ssize_t r = ::read(STDIN_FILENO, buf, sizeof(buf));
      if (r <= 0) {
        running = false;  // EOF on stdin -> shut down
      } else {
        stdinBuf.append(buf, static_cast<size_t>(r));
        size_t nl;
        while ((nl = stdinBuf.find('\n')) != std::string::npos) {
          std::string line = stdinBuf.substr(0, nl);
          stdinBuf.erase(0, nl + 1);
          if (line.empty()) continue;
          json cmd = json::parse(line, nullptr, false);
          if (cmd.is_discarded() || !cmd.contains("op")) continue;
          std::string op = cmd.value("op", "");
          if (op == "close") {
            running = false;
            break;
          } else if (op == "send") {
            long bridgeId = cmd.value("bridgeId", 0L);
            std::string method = cmd.value("method", "");
            json params = cmd.contains("params") ? cmd["params"] : json::object();
            std::string sessionId = cmd.value("sessionId", "");
            cdp.sendCommand(bridgeId, method, params, sessionId);
          }
        }
      }
    }

    // socket: decode frames -> route -> emit IPC lines.
    if (running && FD_ISSET(ws.fd(), &rfds)) {
      std::vector<std::string> msgs;
      bool ok = ws.poll(msgs);
      std::vector<std::string> out;
      for (const auto& m : msgs) cdp.onWsMessage(m, out);
      for (const auto& line : out) emit(line);
      if (!ok && ws.closed()) {
        emit(json({{"type", "closed"}}).dump());
        running = false;
      }
    }
  }

  ws.sendClose();
  return 0;
}
