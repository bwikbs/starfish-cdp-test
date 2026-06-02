#pragma once
#include <map>
#include <string>
#include <vector>

#include "json.hpp"
#include "ws_client.h"

using json = nlohmann::json;

// Owns CDP id allocation, the Target flat-session handshake, and page tracking.
// Emits IPC lines (compact JSON strings, no trailing newline) into `out` for the
// caller (main) to write to stdout.
class CdpClient {
 public:
  explicit CdpClient(WsClient& ws) : m_ws(ws) {}

  // setDiscoverTargets + setAutoAttach{flatten}; pump socket until the initial
  // page attaches (or 5s). Fills `ready` with the {type:"ready",...} line.
  bool handshake(std::string& readyLine, std::string& err);

  // Send a bridge command. bridgeId maps to an internally-allocated CDP id.
  void sendCommand(long bridgeId, const std::string& method, const json& params,
                   const std::string& sessionId);

  // Classify one inbound WS message; append zero or more IPC lines to `out`.
  void onWsMessage(const std::string& text, std::vector<std::string>& out);

  json pagesArray() const;  // [{targetId, sessionId}]

 private:
  long allocId() { return ++m_lastId; }
  void route(const json& msg, std::vector<std::string>& out);

  WsClient& m_ws;
  long m_lastId = 0;
  std::map<long, long> m_cdpToBridge;        // cdpId -> bridgeId (forwarded cmds)
  std::map<std::string, std::string> m_pages;  // targetId -> sessionId
};
