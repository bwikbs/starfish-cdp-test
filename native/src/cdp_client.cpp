#include "cdp_client.h"

#include <chrono>
#include <thread>

json CdpClient::pagesArray() const {
  json arr = json::array();
  for (const auto& [targetId, sessionId] : m_pages)
    arr.push_back({{"targetId", targetId}, {"sessionId", sessionId}});
  return arr;
}

void CdpClient::sendCommand(long bridgeId, const std::string& method,
                            const json& params, const std::string& sessionId) {
  long id = allocId();
  m_cdpToBridge[id] = bridgeId;
  json frame = {{"id", id}, {"method", method}, {"params", params}};
  if (!sessionId.empty()) frame["sessionId"] = sessionId;
  m_ws.sendText(frame.dump());
}

void CdpClient::route(const json& msg, std::vector<std::string>& out) {
  // Reply to a command?
  if (msg.contains("id") && msg["id"].is_number_integer()) {
    long id = msg["id"].get<long>();
    auto it = m_cdpToBridge.find(id);
    if (it == m_cdpToBridge.end()) return;  // internal handshake reply: consume
    long bridgeId = it->second;
    m_cdpToBridge.erase(it);
    if (msg.contains("error")) {
      out.push_back(json({{"type", "error"},
                          {"bridgeId", bridgeId},
                          {"error", msg["error"]}})
                        .dump());
    } else {
      json result = msg.contains("result") ? msg["result"] : json::object();
      out.push_back(json({{"type", "result"},
                          {"bridgeId", bridgeId},
                          {"result", result}})
                        .dump());
    }
    return;
  }

  // Event.
  if (!msg.contains("method")) return;
  std::string method = msg["method"].get<std::string>();
  json params = msg.contains("params") ? msg["params"] : json::object();

  bool pagesChanged = false;
  if (method == "Target.attachedToTarget") {
    if (params.contains("targetInfo") &&
        params["targetInfo"].value("type", "") == "page") {
      std::string targetId = params["targetInfo"].value("targetId", "");
      std::string sessionId = params.value("sessionId", "");
      if (!targetId.empty()) {
        m_pages[targetId] = sessionId;
        pagesChanged = true;
      }
    }
  } else if (method == "Target.detachedFromTarget") {
    std::string targetId = params.value("targetId", "");
    std::string sessionId = params.value("sessionId", "");
    if (!targetId.empty() && m_pages.erase(targetId)) pagesChanged = true;
    if (!sessionId.empty()) {
      for (auto it = m_pages.begin(); it != m_pages.end();) {
        if (it->second == sessionId) {
          it = m_pages.erase(it);
          pagesChanged = true;
        } else {
          ++it;
        }
      }
    }
  } else if (method == "Target.targetDestroyed") {
    std::string targetId = params.value("targetId", "");
    if (!targetId.empty() && m_pages.erase(targetId)) pagesChanged = true;
  } else {
    // Regular protocol event; forward with envelope sessionId if present.
    json line = {{"type", "event"}, {"method", method}, {"params", params}};
    if (msg.contains("sessionId")) line["sessionId"] = msg["sessionId"];
    out.push_back(line.dump());
  }

  if (pagesChanged)
    out.push_back(json({{"type", "pages"}, {"pages", pagesArray()}}).dump());
}

void CdpClient::onWsMessage(const std::string& text, std::vector<std::string>& out) {
  json msg = json::parse(text, nullptr, /*allow_exceptions=*/false);
  if (msg.is_discarded()) return;
  route(msg, out);
}

bool CdpClient::handshake(std::string& readyLine, std::string& err) {
  // Internal handshake commands use ids that never map into m_cdpToBridge, so
  // their replies are silently consumed by route().
  json disc = {{"id", allocId()},
               {"method", "Target.setDiscoverTargets"},
               {"params", {{"discover", true}}}};
  json auto_ = {{"id", allocId()},
                {"method", "Target.setAutoAttach"},
                {"params",
                 {{"autoAttach", true},
                  {"waitForDebuggerOnStart", false},
                  {"flatten", true}}}};
  if (!m_ws.sendText(disc.dump()) || !m_ws.sendText(auto_.dump())) {
    err = "failed to send handshake commands";
    return false;
  }

  // Pump the socket until the initial page attaches or 5s elapse.
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (m_pages.empty() && std::chrono::steady_clock::now() < deadline) {
    std::vector<std::string> msgs;
    if (!m_ws.poll(msgs)) {
      if (m_ws.closed()) {
        err = "connection closed during handshake";
        return false;
      }
    }
    std::vector<std::string> drop;  // discard any IPC lines during handshake
    for (const auto& m : msgs) onWsMessage(m, drop);
    if (m_pages.empty())
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }

  if (m_pages.empty()) {
    err = "no initial page attached within timeout";
    return false;
  }

  json ready = {{"type", "ready"}, {"pages", pagesArray()}};
  // initialPage = the first page (deterministic via the ordered map).
  auto first = m_pages.begin();
  ready["initialPage"] = {{"targetId", first->first}, {"sessionId", first->second}};
  readyLine = ready.dump();
  return true;
}
