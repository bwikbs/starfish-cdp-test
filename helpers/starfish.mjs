// Launch / teardown harness for the Starfish CDP server.
//
// Targets the headless build per ANALYSIS.md §0.0:
//   starfish/out/headless/bin/Starfish  (glib_headless, CDP enabled)
// Override with STARFISH_BIN.
//
// Launch contract (verified, ANALYSIS §0.0 / §1):
//   setsid env STARFISH_ENABLE_CDP=1 STARFISH_CDP_PORT=<port> <bin> "<keepalive-url>" </dev/null &
//   poll GET /json/version until JSON, then connect puppeteer to ws://127.0.0.1:<port>/.
//   stop: kill the process group + `pkill -x Starfish` safety net.

import { spawn, execFileSync, execSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openSync } from "node:fs";
import puppeteer from "puppeteer-core";

// Single source of truth for the default binary path: starfish.config.json at
// the repo root. Edit that file to retarget the build; STARFISH_BIN still wins.
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "starfish.config.json");

function defaultBin() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.defaultBinary) return cfg.defaultBinary;
    throw new Error("missing 'defaultBinary'");
  } catch (e) {
    throw new Error(
      `Cannot read default binary from ${CONFIG_PATH}: ${e.message}. ` +
        `Set 'defaultBinary' there or pass STARFISH_BIN.`
    );
  }
}

export function binPath() {
  return process.env.STARFISH_BIN || defaultBin();
}

// The headless shell exits after onload unless a pending timer keeps it alive
// (ANALYSIS §0.4). This snippet must be embedded in EVERY navigated page.
export const keepAlive = "<script>setInterval(function(){},300)</script>";

// Build a keep-alive data: URL. `body` is raw HTML placed inside <body>.
export function dataUrl(body = "") {
  return `data:text/html,<body>${body}${keepAlive}</body>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await getJson(port, "/json/version");
      if (v && v.webSocketDebuggerUrl) return v;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`Starfish on port ${port} did not become ready in ${timeoutMs}ms`);
}

// Launch a fresh Starfish process on `port`, navigating to `url` (keep-alive
// data: URL by default). Returns { wsEndpoint, port, proc, logPath, stop() }.
export async function launchStarfish({ port, url } = {}) {
  if (!port) throw new Error("launchStarfish: port is required");
  const startUrl = url || dataUrl("<h1>boot</h1>");

  // Safety: never collide with a stray process on this port.
  const logDir = mkdtempSync(join(tmpdir(), "starfish-cdp-"));
  const logPath = join(logDir, `sf-${port}.log`);
  const out = openSync(logPath, "a");

  // setsid gives the child its own session/process-group so we can kill the
  // whole group on teardown without touching the test runner.
  const proc = spawn(
    "setsid",
    ["env", "STARFISH_ENABLE_CDP=1", `STARFISH_CDP_PORT=${port}`, binPath(), startUrl],
    {
      detached: true,
      stdio: ["ignore", out, out],
    }
  );
  proc.unref();

  // `setsid` re-sessions the child, so `proc.pid` is the short-lived setsid
  // wrapper, NOT the Starfish session leader — `process.kill(-proc.pid)` would
  // ESRCH (the leak this fixes). We resolve the real Starfish pid by matching
  // our unique CDP port in /proc/<pid>/environ, then group-kill THAT instead.
  const findSelf = () => {
    try {
      const pids = execSync("pgrep -x Starfish", { encoding: "utf8" }).trim().split("\n");
      for (const pid of pids) {
        if (!pid) continue;
        // The port lives in the env, not argv, so match /proc/<pid>/environ.
        try {
          const env = readFileSync(`/proc/${pid}/environ`, "utf8");
          if (env.includes(`STARFISH_CDP_PORT=${port}\0`)) return Number(pid);
        } catch {
          // race: process gone or environ unreadable
        }
      }
    } catch {
      // none running
    }
    return undefined;
  };

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const sfPid = findSelf();
    try {
      // Kill our Starfish's process group (negative pid). sfPid is the session
      // leader, so its pgid === sfPid.
      if (sfPid) process.kill(-sfPid, "SIGKILL");
    } catch {
      // group already gone
    }
    try {
      // Safety net: exact-name kill (never `pkill -f bin/Starfish`).
      execFileSync("pkill", ["-x", "Starfish"], { stdio: "ignore" });
    } catch {
      // nothing to kill
    }
    // SIGKILL on a multithreaded Starfish takes a few hundred ms to reap.
    // Block until it's actually gone so the next file / the test runner's
    // exit never observes a transient orphan.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        execFileSync("pgrep", ["-x", "Starfish"], { stdio: "ignore" });
      } catch {
        return; // pgrep non-zero => no Starfish left
      }
      try {
        execFileSync("pkill", ["-x", "Starfish"], { stdio: "ignore" });
      } catch {}
      await sleep(50);
    }
  };

  try {
    const version = await waitForReady(port);
    return { wsEndpoint: version.webSocketDebuggerUrl, port, proc, logPath, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

// Connect a puppeteer-core browser to a running Starfish.
export async function connect(wsEndpoint) {
  return puppeteer.connect({ browserWSEndpoint: wsEndpoint });
}

// The initial page that Starfish exposes via Target.setAutoAttach.
export async function initialPage(browser, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    if (pages.length) return pages[0];
    await sleep(50);
  }
  throw new Error("no initial page appeared");
}
