#include "cli.h"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "base64.h"
#include "cdp_client.h"
#include "json.hpp"
#include "ws_client.h"

using json = nlohmann::json;

namespace {

const int DEFAULT_PORT = 9222;
const char* KEEP_ALIVE_EXPR = "setInterval(function(){},300)";
// Matches helpers/starfish.mjs dataUrl("<h1>starfish-cdp ready</h1>").
const char* DEFAULT_URL =
    "data:text/html,<body><h1>starfish-cdp ready</h1>"
    "<script>setInterval(function(){},300)</script></body>";

const auto SLEEP = [](int ms) {
  std::this_thread::sleep_for(std::chrono::milliseconds(ms));
};

std::string stateDir() {
  const char* home = getenv("HOME");
  return std::string(home ? home : ".") + "/.starfish-cdp";
}
std::string stateFile() { return stateDir() + "/state.json"; }

int die(const std::string& msg, int code = 1) {
  std::cerr << msg << "\n";
  return code;
}

// ---- state file ----

bool readState(json& out) {
  std::ifstream f(stateFile());
  if (!f) return false;
  std::stringstream ss;
  ss << f.rdbuf();
  out = json::parse(ss.str(), nullptr, false);
  return !out.is_discarded() && out.is_object();
}

void writeState(const json& state) {
  ::mkdir(stateDir().c_str(), 0755);
  std::ofstream f(stateFile());
  f << state.dump(2);
}

void clearState() { ::remove(stateFile().c_str()); }

std::string nowIso() {
  std::time_t t = std::time(nullptr);
  std::tm tm{};
  gmtime_r(&t, &tm);
  char buf[32];
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S.000Z", &tm);
  return buf;
}

// ---- HTTP GET /json/version on 127.0.0.1:<port> ----
// Returns webSocketDebuggerUrl (empty on any failure). Reuses a plain blocking
// socket; small bounded read with Connection: close.
bool httpGetVersion(int port, std::string& wsUrl, int timeoutMs = 1500) {
  int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return false;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

  timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

  if (::connect(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
    ::close(fd);
    return false;
  }
  std::string req =
      "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
  if (::send(fd, req.data(), req.size(), 0) < 0) {
    ::close(fd);
    return false;
  }
  std::string resp;
  char buf[4096];
  for (;;) {
    ssize_t r = ::recv(fd, buf, sizeof(buf), 0);
    if (r <= 0) break;
    resp.append(buf, (size_t)r);
    if (resp.size() > 1 << 20) break;
  }
  ::close(fd);

  size_t hdrEnd = resp.find("\r\n\r\n");
  if (hdrEnd == std::string::npos) return false;
  std::string body = resp.substr(hdrEnd + 4);
  json v = json::parse(body, nullptr, false);
  if (v.is_discarded() || !v.is_object()) return false;
  if (!v.contains("webSocketDebuggerUrl")) return false;
  wsUrl = v["webSocketDebuggerUrl"].get<std::string>();
  return !wsUrl.empty();
}

bool isAlive(int port) {
  std::string ws;
  return httpGetVersion(port, ws);
}

// ---- attach to the managed running instance ----
struct Attached {
  WsClient ws;
  CdpClient* cdp = nullptr;
  std::string sessionId;
  ~Attached() {
    delete cdp;
    ws.sendClose();
  }
};

// Reads state, verifies liveness, connects + handshakes. Returns nullptr and
// prints an error (matching the Node CLI) on failure.
Attached* attach() {
  json state;
  if (!readState(state) || !state.contains("port")) {
    die("no running Starfish; run `start` first", 1);
    return nullptr;
  }
  int port = state["port"].get<int>();
  if (!isAlive(port)) {
    die("no live Starfish on port " + std::to_string(port) +
            " (state file stale); run `stop` then `start`",
        1);
    return nullptr;
  }
  auto* a = new Attached();
  std::string err;
  std::string wsEndpoint = "ws://127.0.0.1:" + std::to_string(port) + "/";
  if (!a->ws.connectUrl(wsEndpoint, err)) {
    die("connect failed: " + err, 1);
    delete a;
    return nullptr;
  }
  a->cdp = new CdpClient(a->ws);
  if (!a->cdp->attachInitialPage(a->sessionId, err)) {
    die("attach failed: " + err, 1);
    delete a;
    return nullptr;
  }
  return a;
}

// Render a json value the way JS JSON.stringify would. nlohmann keeps the wire
// type, so a whole-number float (e.g. Starfish sends 42.0) must print as "42".
std::string jsonStringify(const json& v) {
  if (v.is_number_float()) {
    double d = v.get<double>();
    if (d == (double)(long long)d &&
        std::abs(d) < 9007199254740992.0 /* 2^53 */) {
      return std::to_string((long long)d);
    }
  }
  if (v.is_array() || v.is_object()) {
    // Recurse so nested whole-number floats also normalize.
    if (v.is_array()) {
      std::string s = "[";
      for (size_t i = 0; i < v.size(); i++) {
        if (i) s += ",";
        s += jsonStringify(v[i]);
      }
      return s + "]";
    }
    std::string s = "{";
    bool first = true;
    for (auto it = v.begin(); it != v.end(); ++it) {
      if (!first) s += ",";
      first = false;
      s += json(it.key()).dump() + ":" + jsonStringify(it.value());
    }
    return s + "}";
  }
  return v.dump();
}

// JSON.stringify-equivalent: string value printed raw, everything else as JSON.
std::string valueToString(const json& v) {
  if (v.is_string()) return v.get<std::string>();
  if (v.is_null()) return "null";
  return jsonStringify(v);
}

// ---- process spawn / kill ----

// Resolve the Starfish pid whose env carries STARFISH_CDP_PORT=<port>.
int findPidByPort(int port) {
  FILE* p = popen("pgrep -x Starfish", "r");
  if (!p) return 0;
  std::string needle = "STARFISH_CDP_PORT=" + std::to_string(port);
  char line[64];
  int found = 0;
  while (fgets(line, sizeof(line), p)) {
    int pid = atoi(line);
    if (pid <= 0) continue;
    std::string envPath = "/proc/" + std::to_string(pid) + "/environ";
    std::ifstream f(envPath, std::ios::binary);
    if (!f) continue;
    std::stringstream ss;
    ss << f.rdbuf();
    std::string env = ss.str();
    // environ entries are NUL-separated: match "STARFISH_CDP_PORT=<port>\0".
    for (size_t i = 0; i + needle.size() <= env.size();) {
      size_t z = env.find('\0', i);
      if (z == std::string::npos) z = env.size();
      std::string entry = env.substr(i, z - i);
      if (entry == needle) {
        found = pid;
        break;
      }
      i = z + 1;
    }
    if (found) break;
  }
  pclose(p);
  return found;
}

int cmdStart(const std::vector<std::string>& opts) {
  int port = DEFAULT_PORT;
  std::string url = DEFAULT_URL;
  for (size_t i = 0; i + 1 < opts.size(); i++) {
    if (opts[i] == "--port") port = atoi(opts[i + 1].c_str());
    else if (opts[i] == "--url") url = opts[i + 1];
  }

  json existing;
  if (readState(existing) && existing.contains("port") &&
      isAlive(existing["port"].get<int>())) {
    return die("Starfish already running on port " +
                   std::to_string(existing["port"].get<int>()) +
                   " (since " + existing.value("startedAt", "?") +
                   "); run `stop` first or use it directly");
  }
  if (isAlive(port)) {
    return die("port " + std::to_string(port) +
               " already has a live CDP server; refusing to launch");
  }

  // Resolve binary: STARFISH_BIN > config defaultBinary.
  std::string bin;
  if (const char* envBin = getenv("STARFISH_BIN")) {
    bin = envBin;
  } else {
    std::ifstream cf("./starfish.config.json");
    if (!cf) {
      return die(
          "Cannot read ./starfish.config.json. Set 'defaultBinary' there or "
          "pass STARFISH_BIN.");
    }
    std::stringstream ss;
    ss << cf.rdbuf();
    json cfg = json::parse(ss.str(), nullptr, false);
    if (cfg.is_discarded() || !cfg.contains("defaultBinary")) {
      return die(
          "Cannot read default binary from ./starfish.config.json: missing "
          "'defaultBinary'. Set it there or pass STARFISH_BIN.");
    }
    bin = cfg["defaultBinary"].get<std::string>();
  }

  // Viewport: env STARFISH_WIDTH/HEIGHT > config width/height.
  auto pickDim = [](const char* env, json& cfg, const char* key) -> int {
    const char* e = getenv(env);
    if (e && *e) {
      int n = atoi(e);
      return n > 0 ? n : 0;
    }
    if (cfg.contains(key) && cfg[key].is_number()) {
      int n = cfg[key].get<int>();
      return n > 0 ? n : 0;
    }
    return 0;
  };
  json cfg = json::object();
  {
    std::ifstream cf("./starfish.config.json");
    if (cf) {
      std::stringstream ss;
      ss << cf.rdbuf();
      json parsed = json::parse(ss.str(), nullptr, false);
      if (!parsed.is_discarded()) cfg = parsed;
    }
  }
  int width = pickDim("STARFISH_WIDTH", cfg, "width");
  int height = pickDim("STARFISH_HEIGHT", cfg, "height");

  // Build argv = [bin, url, --width=W, --height=H].
  std::vector<std::string> argvStr = {bin, url};
  if (width) argvStr.push_back("--width=" + std::to_string(width));
  if (height) argvStr.push_back("--height=" + std::to_string(height));

  std::string logPath = stateDir() + "/sf-" + std::to_string(port) + ".log";
  ::mkdir(stateDir().c_str(), 0755);

  // fork -> setsid -> redirect stdio to log -> execve with CDP env.
  pid_t pid = fork();
  if (pid < 0) return die("fork failed");
  if (pid == 0) {
    setsid();
    int logfd = ::open(logPath.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (logfd < 0) logfd = ::open("/dev/null", O_WRONLY);
    if (logfd >= 0) {
      dup2(logfd, STDOUT_FILENO);
      dup2(logfd, STDERR_FILENO);
      if (logfd > STDERR_FILENO) ::close(logfd);
    }
    int devnull = ::open("/dev/null", O_RDONLY);
    if (devnull >= 0) {
      dup2(devnull, STDIN_FILENO);
      if (devnull > STDERR_FILENO) ::close(devnull);
    }

    std::vector<char*> argv;
    for (auto& s : argvStr) argv.push_back(const_cast<char*>(s.c_str()));
    argv.push_back(nullptr);

    // Inherit parent env + STARFISH_ENABLE_CDP + STARFISH_CDP_PORT.
    setenv("STARFISH_ENABLE_CDP", "1", 1);
    setenv("STARFISH_CDP_PORT", std::to_string(port).c_str(), 1);
    execv(bin.c_str(), argv.data());
    _exit(127);  // execv failed
  }
  // Parent: detach (don't reap; child re-sessioned). Poll /json/version.
  std::string wsEndpoint;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
  while (std::chrono::steady_clock::now() < deadline) {
    if (httpGetVersion(port, wsEndpoint)) break;
    SLEEP(150);
  }
  if (wsEndpoint.empty()) {
    return die("Starfish on port " + std::to_string(port) +
               " did not become ready in 15000ms");
  }

  json state = {{"port", port}, {"startedAt", nowIso()}, {"client", "native"}};
  writeState(state);
  std::cout << "started Starfish on port " << port << "\n";
  std::cout << "wsEndpoint: " << wsEndpoint << "\n";
  std::cout << "url: " << url << "\n";
  std::cout << "client: native\n";
  std::cout << "ready\n";
  return 0;
}

int cmdStop() {
  json state;
  if (!readState(state) || !state.contains("port")) {
    std::cout << "no managed instance (nothing to stop)\n";
    return 0;
  }
  int port = state["port"].get<int>();
  int pid = findPidByPort(port);
  if (pid) {
    kill(-pid, SIGKILL);  // setsid leader: pgid == pid
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
      if (!findPidByPort(port)) break;
      SLEEP(50);
    }
  }
  clearState();
  std::cout << "stopped Starfish on port " << port;
  if (pid)
    std::cout << " (pid " << pid << ")\n";
  else
    std::cout << " (was not running)\n";
  return 0;
}

int cmdStatus() {
  json state;
  if (!readState(state) || !state.contains("port")) {
    std::cout << "status: no managed instance\n";
    return 0;
  }
  int port = state["port"].get<int>();
  if (!isAlive(port)) {
    std::cout << "status: DEAD (state points at port " << port
              << ", not responding)\n";
    return 0;
  }
  std::string url = "?";
  {
    WsClient ws;
    std::string err;
    if (ws.connectUrl("ws://127.0.0.1:" + std::to_string(port) + "/", err)) {
      CdpClient cdp(ws);
      std::string sid;
      if (cdp.attachInitialPage(sid, err)) {
        json result;
        if (cdp.sendAndWait("Page.getFrameTree", json::object(), sid, 3000,
                            result, err) &&
            result.contains("frameTree"))
          url = result["frameTree"]["frame"].value("url", "?");
      }
      ws.sendClose();
    }
  }
  std::cout << "status: ALIVE port=" << port
            << " client=" << state.value("client", "native")
            << " startedAt=" << state.value("startedAt", "?") << " url=" << url
            << "\n";
  return 0;
}

int cmdEval(const std::vector<std::string>& args) {
  std::string expr;
  for (size_t i = 0; i < args.size(); i++) {
    if (i) expr += " ";
    expr += args[i];
  }
  if (expr.empty()) return die("usage: eval <expression>");
  Attached* a = attach();
  if (!a) return 1;
  json params = {{"expression", expr},
                 {"returnByValue", true},
                 {"awaitPromise", true}};
  json result;
  std::string err;
  int rc = 0;
  if (!a->cdp->sendAndWait("Runtime.evaluate", params, a->sessionId, 10000,
                          result, err)) {
    std::cerr << "eval failed: " << err << "\n";
    rc = 1;
  } else if (result.contains("exceptionDetails")) {
    const json& ex = result["exceptionDetails"];
    std::string text = "evaluation threw";
    if (ex.contains("exception") && ex["exception"].contains("description"))
      text = ex["exception"]["description"].get<std::string>();
    else if (ex.contains("text"))
      text = ex["text"].get<std::string>();
    std::cerr << "eval exception: " << text << "\n";
    rc = 1;
  } else {
    json v = result.contains("result") ? result["result"].value("value", json())
                                       : json();
    std::cout << valueToString(v) << "\n";
  }
  delete a;
  return rc;
}

int cmdCdp(const std::vector<std::string>& args) {
  if (args.empty() || args[0].find('.') == std::string::npos) {
    return die(
        "usage: cdp <Domain.method> [paramsJson]\n  e.g. cdp Page.navigate "
        "'{\"url\":\"https://example.com\"}'");
  }
  std::string method = args[0];
  json params = json::object();
  if (args.size() > 1) {
    params = json::parse(args[1], nullptr, false);
    if (params.is_discarded()) return die("invalid params JSON");
  }
  Attached* a = attach();
  if (!a) return 1;
  json result;
  std::string err;
  int rc = 0;
  if (!a->cdp->sendAndWait(method, params, a->sessionId, 30000, result, err)) {
    std::cerr << "cdp " << method << " failed: " << err << "\n";
    rc = 1;
  } else {
    std::cout << result.dump(2) << "\n";
  }
  delete a;
  return rc;
}

// text / html share the eval-and-print shape.
int evalAndPrint(const std::string& label, const std::string& selector,
                 const std::string& expr) {
  Attached* a = attach();
  if (!a) return 1;
  json params = {{"expression", expr}, {"returnByValue", true}};
  json result;
  std::string err;
  int rc = 0;
  if (!a->cdp->sendAndWait("Runtime.evaluate", params, a->sessionId, 10000,
                          result, err)) {
    std::cerr << label << " failed: " << err << "\n";
    rc = 1;
  } else if (result.contains("exceptionDetails")) {
    std::cerr << label << " failed: "
              << result["exceptionDetails"].value("text", "evaluation threw")
              << "\n";
    rc = 1;
  } else {
    json v = result.contains("result") ? result["result"].value("value", json())
                                       : json();
    if (v.is_null()) {
      std::cerr << "element not found: " << selector << "\n";
      rc = 1;
    } else {
      std::cout << valueToString(v) << "\n";
    }
  }
  delete a;
  return rc;
}

std::string jsStringLiteral(const std::string& s) {
  return json(s).dump();  // produces a valid JS/JSON double-quoted string
}

int cmdText(const std::vector<std::string>& args) {
  std::string selector = args.empty() ? "" : args[0];
  std::string expr = selector.empty()
                         ? "document.body.innerText"
                         : "(function(){var el=document.querySelector(" +
                               jsStringLiteral(selector) +
                               ");return el?el.textContent:null;})()";
  return evalAndPrint("text", selector, expr);
}

int cmdHtml(const std::vector<std::string>& args) {
  std::string selector = args.empty() ? "documentElement" : args[0];
  std::string expr =
      selector == "documentElement"
          ? "document.documentElement.outerHTML"
          : "(function(){var el=document.querySelector(" +
                jsStringLiteral(selector) + ");return el?el.outerHTML:null;})()";
  return evalAndPrint("html", selector, expr);
}

void reinjectKeepAlive(CdpClient* cdp, const std::string& sid) {
  json r;
  std::string e;
  cdp->sendAndWait("Runtime.evaluate", {{"expression", KEEP_ALIVE_EXPR}}, sid,
                   3000, r, e);
  cdp->sendAndWait("Page.addScriptToEvaluateOnNewDocument",
                   {{"source", KEEP_ALIVE_EXPR}}, sid, 3000, r, e);
}

int cmdGoto(const std::vector<std::string>& args) {
  if (args.empty()) return die("usage: goto <url>");
  std::string url = args[0];
  Attached* a = attach();
  if (!a) return 1;
  json result;
  std::string err;
  if (!a->cdp->sendAndWait("Page.enable", json::object(), a->sessionId, 5000,
                          result, err) ||
      !a->cdp->sendAndWait("Page.navigate", {{"url", url}}, a->sessionId, 8000,
                          result, err)) {
    std::cerr << "goto failed: " << err << "\n";
    delete a;
    return 1;
  }
  a->cdp->waitEvent("Page.loadEventFired", 8000);
  SLEEP(300);
  reinjectKeepAlive(a->cdp, a->sessionId);
  std::string finalUrl = url;
  if (a->cdp->sendAndWait("Page.getFrameTree", json::object(), a->sessionId,
                         3000, result, err) &&
      result.contains("frameTree"))
    finalUrl = result["frameTree"]["frame"].value("url", url);
  std::cout << "navigated to: " << finalUrl << "\n";
  std::cout << "load: complete (keep-alive re-injected)\n";
  delete a;
  return 0;
}

// Resolve a selector center via DOM.getBoxModel, falling back to bbox eval.
bool elementCenter(CdpClient* cdp, const std::string& sid,
                   const std::string& selector, double& x, double& y) {
  json doc, qs, err_;
  std::string err;
  if (!cdp->sendAndWait("DOM.getDocument", json::object(), sid, 5000, doc, err))
    return false;
  int rootNodeId = doc["root"].value("nodeId", 0);
  if (!cdp->sendAndWait("DOM.querySelector",
                       {{"nodeId", rootNodeId}, {"selector", selector}}, sid,
                       5000, qs, err))
    return false;
  int nodeId = qs.value("nodeId", 0);
  if (!nodeId) return false;
  json bm;
  if (cdp->sendAndWait("DOM.getBoxModel", {{"nodeId", nodeId}}, sid, 5000, bm,
                      err) &&
      bm.contains("model") && bm["model"].contains("content")) {
    const json& q = bm["model"]["content"];
    x = (q[0].get<double>() + q[2].get<double>() + q[4].get<double>() +
         q[6].get<double>()) /
        4;
    y = (q[1].get<double>() + q[3].get<double>() + q[5].get<double>() +
         q[7].get<double>()) /
        4;
    return true;
  }
  // Fallback: getBoundingClientRect.
  json ev;
  std::string expr = "(function(){var el=document.querySelector(" +
                     jsStringLiteral(selector) +
                     ");var r=el.getBoundingClientRect();return "
                     "{x:r.left+r.width/2,y:r.top+r.height/2};})()";
  if (!cdp->sendAndWait("Runtime.evaluate",
                       {{"expression", expr}, {"returnByValue", true}}, sid,
                       5000, ev, err))
    return false;
  if (!ev.contains("result") || !ev["result"].contains("value")) return false;
  const json& v = ev["result"]["value"];
  x = v.value("x", 0.0);
  y = v.value("y", 0.0);
  return true;
}

int cmdClick(const std::vector<std::string>& args) {
  if (args.empty()) return die("usage: click <selector>");
  std::string selector = args[0];
  Attached* a = attach();
  if (!a) return 1;
  json result;
  std::string err;
  int rc = 0;
  do {
    if (!a->cdp->sendAndWait("DOM.enable", json::object(), a->sessionId, 5000,
                            result, err)) {
      std::cerr << "click failed: " << err << "\n";
      rc = 1;
      break;
    }
    double x = 0, y = 0;
    if (!elementCenter(a->cdp, a->sessionId, selector, x, y)) {
      std::cerr << "element not found: " << selector << "\n";
      rc = 1;
      break;
    }
    std::string urlBefore;
    if (a->cdp->sendAndWait("Page.getFrameTree", json::object(), a->sessionId,
                           3000, result, err) &&
        result.contains("frameTree"))
      urlBefore = result["frameTree"]["frame"].value("url", "");
    a->cdp->sendAndWait("Input.dispatchMouseEvent",
                        {{"type", "mousePressed"},
                         {"x", x},
                         {"y", y},
                         {"button", "left"},
                         {"clickCount", 1},
                         {"buttons", 1}},
                        a->sessionId, 5000, result, err);
    a->cdp->sendAndWait("Input.dispatchMouseEvent",
                        {{"type", "mouseReleased"},
                         {"x", x},
                         {"y", y},
                         {"button", "left"},
                         {"clickCount", 1},
                         {"buttons", 0}},
                        a->sessionId, 5000, result, err);
    SLEEP(300);
    std::string urlAfter = urlBefore;
    if (a->cdp->sendAndWait("Page.getFrameTree", json::object(), a->sessionId,
                           3000, result, err) &&
        result.contains("frameTree"))
      urlAfter = result["frameTree"]["frame"].value("url", urlBefore);
    std::cout << "clicked " << selector << " at (" << (long)(x + 0.5) << ","
              << (long)(y + 0.5) << ")\n";
    if (urlAfter != urlBefore) {
      reinjectKeepAlive(a->cdp, a->sessionId);
      std::cout << "navigated to: " << urlAfter
                << " (keep-alive re-injected)\n";
    }
  } while (false);
  delete a;
  return rc;
}

int cmdType(const std::vector<std::string>& args) {
  std::string selector = args.empty() ? "" : args[0];
  std::string text;
  for (size_t i = 1; i < args.size(); i++) {
    if (i > 1) text += " ";
    text += args[i];
  }
  if (selector.empty() || text.empty())
    return die("usage: type <selector> <text>");
  Attached* a = attach();
  if (!a) return 1;
  json result, doc, qs;
  std::string err;
  int rc = 0;
  do {
    if (!a->cdp->sendAndWait("DOM.enable", json::object(), a->sessionId, 5000,
                            result, err) ||
        !a->cdp->sendAndWait("DOM.getDocument", json::object(), a->sessionId,
                            5000, doc, err)) {
      std::cerr << "type failed: " << err << "\n";
      rc = 1;
      break;
    }
    int rootNodeId = doc["root"].value("nodeId", 0);
    if (!a->cdp->sendAndWait("DOM.querySelector",
                            {{"nodeId", rootNodeId}, {"selector", selector}},
                            a->sessionId, 5000, qs, err)) {
      std::cerr << "type failed: " << err << "\n";
      rc = 1;
      break;
    }
    int nodeId = qs.value("nodeId", 0);
    if (!nodeId) {
      std::cerr << "element not found: " << selector << "\n";
      rc = 1;
      break;
    }
    json focus;
    if (!a->cdp->sendAndWait("DOM.focus", {{"nodeId", nodeId}}, a->sessionId,
                            5000, focus, err)) {
      std::string fexpr =
          "document.querySelector(" + jsStringLiteral(selector) + ").focus()";
      a->cdp->sendAndWait("Runtime.evaluate", {{"expression", fexpr}},
                          a->sessionId, 5000, focus, err);
    }
    a->cdp->sendAndWait("Input.insertText", {{"text", text}}, a->sessionId,
                        5000, result, err);
    std::string vexpr = "(function(){var el=document.querySelector(" +
                        jsStringLiteral(selector) +
                        ");return ('value' in el)?el.value:null;})()";
    json valr;
    a->cdp->sendAndWait("Runtime.evaluate",
                        {{"expression", vexpr}, {"returnByValue", true}},
                        a->sessionId, 5000, valr, err);
    std::cout << "typed into " << selector << "\n";
    if (valr.contains("result") && valr["result"].contains("value") &&
        !valr["result"]["value"].is_null())
      std::cout << "value: " << valueToString(valr["result"]["value"]) << "\n";
  } while (false);
  delete a;
  return rc;
}

int cmdScreenshot(const std::vector<std::string>& args) {
  std::string path = args.empty() ? (stateDir() + "/screenshot.png") : args[0];
  Attached* a = attach();
  if (!a) return 1;
  json result;
  std::string err;
  int rc = 0;
  if (!a->cdp->sendAndWait("Page.captureScreenshot", {{"format", "png"}},
                          a->sessionId, 30000, result, err)) {
    std::cerr << "screenshot failed: " << err << "\n";
    rc = 1;
  } else {
    std::string b64 = result.value("data", "");
    std::string bytes;
    if (!base64Decode(b64, bytes)) {
      std::cerr << "screenshot failed: invalid base64 data\n";
      rc = 1;
    } else {
      // Ensure parent dir exists (single level under cwd/home is typical).
      size_t slash = path.find_last_of('/');
      if (slash != std::string::npos)
        ::mkdir(path.substr(0, slash).c_str(), 0755);
      std::ofstream f(path, std::ios::binary);
      f.write(bytes.data(), (std::streamsize)bytes.size());
      f.close();
      // PNG IHDR: width at bytes 16-19, height at 20-23 (big-endian).
      auto be32 = [&](size_t o) -> unsigned {
        return ((unsigned char)bytes[o] << 24) |
               ((unsigned char)bytes[o + 1] << 16) |
               ((unsigned char)bytes[o + 2] << 8) | (unsigned char)bytes[o + 3];
      };
      unsigned w = bytes.size() >= 24 ? be32(16) : 0;
      unsigned h = bytes.size() >= 24 ? be32(20) : 0;
      std::cout << "saved " << w << "x" << h << " PNG to " << path << "\n";
      std::cout << "NOTE: the headless build renders BLANK pixels (valid PNG, "
                   "transparent); use `text`/`eval`/`html` for perception, not "
                   "screenshots\n";
    }
  }
  delete a;
  return rc;
}

void usage() {
  std::cout
      << "starfish-cdp-native — drive a headless Starfish browser over CDP\n\n"
         "Lifecycle (state in ~/.starfish-cdp/state.json):\n"
         "  start [--port N] [--url URL]   launch + detach Starfish (port 9222)\n"
         "  stop                           kill the managed instance\n"
         "  status                         is it alive? port + url\n\n"
         "Perceive:\n"
         "  text [selector]                innerText / textContent\n"
         "  html [selector]                outerHTML\n"
         "  eval <expression>              Runtime.evaluate; prints JSON value\n"
         "  cdp <Domain.method> [json]     raw CDP passthrough\n"
         "  screenshot [path]              save PNG\n\n"
         "Act:\n"
         "  goto <url>                     navigate + re-inject keep-alive\n"
         "  click <selector>               click element center\n"
         "  type <selector> <text>         focus + insert text\n";
}

}  // namespace

int runCli(int argc, char** argv) {
  std::vector<std::string> args;
  for (int i = 2; i < argc; i++) args.push_back(argv[i]);
  std::string cmd = argv[1];

  // Positional args: strip "--flag value" pairs (mirrors Node positional()).
  auto positional = [&]() {
    std::vector<std::string> out;
    for (size_t i = 0; i < args.size(); i++) {
      if (args[i].rfind("--", 0) == 0) {
        i++;  // skip value
        continue;
      }
      out.push_back(args[i]);
    }
    return out;
  };

  if (cmd == "start") return cmdStart(args);
  if (cmd == "stop") return cmdStop();
  if (cmd == "status") return cmdStatus();
  if (cmd == "goto") return cmdGoto(positional());
  if (cmd == "eval") return cmdEval(args);   // raw: preserve spaces
  if (cmd == "cdp") return cmdCdp(args);      // raw: method + JSON params
  if (cmd == "text") return cmdText(positional());
  if (cmd == "html") return cmdHtml(positional());
  if (cmd == "click") return cmdClick(positional());
  if (cmd == "type") return cmdType(positional());
  if (cmd == "screenshot") return cmdScreenshot(positional());
  if (cmd == "help" || cmd == "-h" || cmd == "--help") {
    usage();
    return 0;
  }
  std::cerr << "unknown command: " << cmd << "\nrun `help` for usage\n";
  return 1;
}
