#!/usr/bin/env node
// Agent-facing CLI to drive a live, headless Starfish browser over CDP.
//
// Starfish + its CDP/page state PERSIST across separate process invocations
// (ANALYSIS §0.3), so this CLI is stateless-per-call: each command connects to
// the already-running Starfish, performs ONE action, prints a result, and
// disconnects (NEVER close — that would tear down Starfish). A tiny state file
// at ~/.starfish-cdp/state.json records the managed instance's port.
//
// Keep-alive (ANALYSIS §0.4): the headless shell exits after onload unless a
// pending timer keeps it alive, and Page.navigate drops the timer. So after any
// navigation we RE-INJECT `setInterval(function(){},300)` into the page.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const STATE_DIR = join(homedir(), ".starfish-cdp");
const STATE_FILE = join(STATE_DIR, "state.json");
const DEFAULT_PORT = 9222;
const KEEP_ALIVE_EXPR = "setInterval(function(){},300)";
const MAX_OUTPUT = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

// ---- state file -----------------------------------------------------------

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState() {
  try {
    rmSync(STATE_FILE);
  } catch {
    // already gone
  }
}

// ---- HTTP discovery --------------------------------------------------------

function getJson(port, path, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs },
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
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function isAlive(port) {
  try {
    const v = await getJson(port, "/json/version");
    return !!(v && v.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

// Resolve the Starfish pid whose env carries our managed CDP port (ANALYSIS
// §0.0, mirrors helpers/starfish.mjs). Port-scoped so `stop` never touches an
// unrelated Starfish (e.g. one the test suite launched on another port).
function findPidByPort(port) {
  let pids;
  try {
    pids = execFileSync("pgrep", ["-x", "Starfish"], { encoding: "utf8" })
      .trim()
      .split("\n");
  } catch {
    return undefined; // none running
  }
  for (const pid of pids) {
    if (!pid) continue;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (env.includes(`STARFISH_CDP_PORT=${port}\0`)) return Number(pid);
    } catch {
      // race: process gone / environ unreadable
    }
  }
  return undefined;
}

// ---- per-call connection ---------------------------------------------------

// Connect to the managed running instance. Errors clearly if none is live.
// Returns { browser, page, client, port }. Caller MUST call disconnect().
async function attach() {
  const state = readState();
  if (!state || !state.port) {
    die("no running Starfish; run `start` first", 1);
  }
  const { port } = state;
  if (!(await isAlive(port))) {
    die(
      `no live Starfish on port ${port} (state file stale); run \`stop\` then \`start\``,
      1
    );
  }
  const wsEndpoint = `ws://127.0.0.1:${port}/`;
  const browser = await connect(wsEndpoint);
  const page = await initialPage(browser);
  const client = await page.createCDPSession();
  return { browser, page, client, port };
}

// Disconnect (NOT close) and exit. close() would tear down Starfish; also
// puppeteer keeps sockets open, so we force exit to never hang.
async function finish(browser, code = 0) {
  try {
    await browser.disconnect();
  } catch {
    // already gone
  }
  process.exit(code);
}

function truncate(s) {
  if (typeof s !== "string") return s;
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} chars]`;
}

// Re-inject the keep-alive timer after a navigation (ANALYSIS §0.4). Also try
// addScriptToEvaluateOnNewDocument as belt-and-suspenders; drop it if it errors.
async function reinjectKeepAlive(client) {
  await client.send("Runtime.evaluate", { expression: KEEP_ALIVE_EXPR });
  try {
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: KEEP_ALIVE_EXPR,
    });
  } catch {
    // not supported on this binary — the Runtime.evaluate injection suffices
  }
}

// ---- commands --------------------------------------------------------------

async function cmdStart(args) {
  const port = Number(getOpt(args, "--port") || DEFAULT_PORT);
  const url = getOpt(args, "--url") || dataUrl("<h1>starfish-cdp ready</h1>");

  const existing = readState();
  if (existing && existing.port && (await isAlive(existing.port))) {
    die(
      `Starfish already running on port ${existing.port} (since ${existing.startedAt}); ` +
        `run \`stop\` first or use it directly`,
      1
    );
  }
  if (await isAlive(port)) {
    die(`port ${port} already has a live CDP server; refusing to launch`, 1);
  }

  const sf = await launchStarfish({ port, url });
  // launchStarfish already detached the process (setsid + detached + unref).
  // We must NOT call sf.stop() and must let this CLI exit without holding it.
  writeState({ port, startedAt: new Date().toISOString() });
  console.log(`started Starfish on port ${port}`);
  console.log(`wsEndpoint: ${sf.wsEndpoint}`);
  console.log(`url: ${url}`);
  console.log("ready");
  process.exit(0);
}

async function cmdStop() {
  const state = readState();
  if (!state || !state.port) {
    console.log("no managed instance (nothing to stop)");
    process.exit(0);
  }
  const { port } = state;
  const pid = findPidByPort(port);
  if (pid) {
    try {
      // Group-kill: setsid made the Starfish pid its own session leader, so
      // pgid === pid. Port-scoped — never a broad `pkill -x Starfish`.
      process.kill(-pid, "SIGKILL");
    } catch {
      // group already gone
    }
    // Block until that pid is actually reaped.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!findPidByPort(port)) break;
      await sleep(50);
    }
  }
  clearState();
  console.log(`stopped Starfish on port ${port}${pid ? ` (pid ${pid})` : " (was not running)"}`);
  process.exit(0);
}

async function cmdStatus() {
  const state = readState();
  if (!state || !state.port) {
    console.log("status: no managed instance");
    process.exit(0);
  }
  const { port } = state;
  const alive = await isAlive(port);
  if (!alive) {
    console.log(`status: DEAD (state points at port ${port}, not responding)`);
    process.exit(0);
  }
  // Report current page url via Target.getTargets.
  let url = "?";
  try {
    const browser = await connect(`ws://127.0.0.1:${port}/`);
    const page = await initialPage(browser);
    const client = await page.createCDPSession();
    const { frameTree } = await client.send("Page.getFrameTree");
    url = frameTree.frame.url;
    await browser.disconnect();
  } catch {
    // best-effort url
  }
  console.log(`status: ALIVE port=${port} startedAt=${state.startedAt} url=${url}`);
  process.exit(0);
}

async function cmdGoto(args) {
  const url = args[0];
  if (!url) die("usage: goto <url>", 1);
  const { browser, client } = await attach();
  try {
    const loaded = new Promise((r) => client.once("Page.loadEventFired", r));
    await client.send("Page.enable");
    await client.send("Page.navigate", { url });
    await Promise.race([loaded, sleep(8000)]);
    await sleep(300); // let subresources settle
    await reinjectKeepAlive(client);
    const { frameTree } = await client.send("Page.getFrameTree");
    console.log(`navigated to: ${frameTree.frame.url}`);
    console.log("load: complete (keep-alive re-injected)");
  } catch (e) {
    console.error(`goto failed: ${e.message}`);
    await finish(browser, 1);
  }
  await finish(browser, 0);
}

async function cmdEval(args) {
  const expression = args.join(" ");
  if (!expression) die("usage: eval <expression>", 1);
  const { browser, client } = await attach();
  try {
    const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      const text =
        exceptionDetails.exception?.description ||
        exceptionDetails.text ||
        "evaluation threw";
      console.error(`eval exception: ${text}`);
      await finish(browser, 1);
    }
    const value = result?.value;
    console.log(typeof value === "string" ? value : JSON.stringify(value));
  } catch (e) {
    console.error(`eval failed: ${e.message}`);
    await finish(browser, 1);
  }
  await finish(browser, 0);
}

async function cmdText(args) {
  const selector = args[0];
  const expr = selector
    ? `(function(){var el=document.querySelector(${JSON.stringify(
        selector
      )});return el?el.textContent:null;})()`
    : "document.body.innerText";
  const { browser, client } = await attach();
  try {
    const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    if (exceptionDetails) {
      console.error(`text failed: ${exceptionDetails.text}`);
      await finish(browser, 1);
    }
    if (result.value === null) {
      console.error(`element not found: ${selector}`);
      await finish(browser, 1);
    }
    console.log(truncate(result.value));
  } catch (e) {
    console.error(`text failed: ${e.message}`);
    await finish(browser, 1);
  }
  await finish(browser, 0);
}

async function cmdHtml(args) {
  const selector = args[0] || "documentElement";
  // Default = whole document; a selector targets one element's outerHTML.
  const expr =
    selector === "documentElement"
      ? "document.documentElement.outerHTML"
      : `(function(){var el=document.querySelector(${JSON.stringify(
          selector
        )});return el?el.outerHTML:null;})()`;
  const { browser, client } = await attach();
  try {
    const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    if (exceptionDetails) {
      console.error(`html failed: ${exceptionDetails.text}`);
      await finish(browser, 1);
    }
    if (result.value === null) {
      console.error(`element not found: ${selector}`);
      await finish(browser, 1);
    }
    console.log(truncate(result.value));
  } catch (e) {
    console.error(`html failed: ${e.message}`);
    await finish(browser, 1);
  }
  await finish(browser, 0);
}

// Resolve a selector to a center {x,y}. Prefer DOM.getBoxModel; fall back to
// getBoundingClientRect via eval if the box model is empty (ANALYSIS §5.12).
async function elementCenter(client, selector) {
  const doc = await client.send("DOM.getDocument");
  const { nodeId } = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!nodeId) return null;
  try {
    const { model } = await client.send("DOM.getBoxModel", { nodeId });
    const q = model.content;
    return {
      nodeId,
      x: (q[0] + q[2] + q[4] + q[6]) / 4,
      y: (q[1] + q[3] + q[5] + q[7]) / 4,
    };
  } catch {
    // box model empty — fall back to getBoundingClientRect
  }
  const { result } = await client.send("Runtime.evaluate", {
    expression: `(function(){var el=document.querySelector(${JSON.stringify(
      selector
    )});var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    returnByValue: true,
  });
  return { nodeId, x: result.value.x, y: result.value.y };
}

async function cmdClick(args) {
  const selector = args[0];
  if (!selector) die("usage: click <selector>", 1);
  const { browser, client } = await attach();
  try {
    await client.send("DOM.enable");
    const center = await elementCenter(client, selector);
    if (!center) {
      console.error(`element not found: ${selector}`);
      await finish(browser, 1);
    }
    const urlBefore = (await client.send("Page.getFrameTree")).frameTree.frame.url;
    const { x, y } = center;
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(300);
    const urlAfter = (await client.send("Page.getFrameTree")).frameTree.frame.url;
    console.log(`clicked ${selector} at (${Math.round(x)},${Math.round(y)})`);
    if (urlAfter !== urlBefore) {
      await reinjectKeepAlive(client);
      console.log(`navigated to: ${urlAfter} (keep-alive re-injected)`);
    }
  } catch (e) {
    console.error(`click failed: ${e.message}`);
    await finish(browser, 1);
  }
  await finish(browser, 0);
}

async function cmdType(args) {
  const selector = args[0];
  const text = args.slice(1).join(" ");
  if (!selector || text === "") die("usage: type <selector> <text>", 1);
  const { browser, client } = await attach();
  try {
    await client.send("DOM.enable");
    const doc = await client.send("DOM.getDocument");
    const { nodeId } = await client.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!nodeId) {
      console.error(`element not found: ${selector}`);
      await finish(browser, 1);
    }
    try {
      await client.send("DOM.focus", { nodeId });
    } catch {
      await client.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)}).focus()`,
      });
    }
    await client.send("Input.insertText", { text });
    const { result } = await client.send("Runtime.evaluate", {
      expression: `(function(){var el=document.querySelector(${JSON.stringify(
        selector
      )});return ('value' in el)?el.value:null;})()`,
      returnByValue: true,
    });
    console.log(`typed into ${selector}`);
    if (result.value !== null) console.log(`value: ${result.value}`);
  } catch (e) {
    console.error(`type failed: ${e.message}`);
    await finish(browser, 1);
  }
  await finish(browser, 0);
}

async function cmdScreenshot(args) {
  const path = args[0] || join(STATE_DIR, "screenshot.png");
  const { browser, client } = await attach();
  try {
    const shot = await client.send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(shot.data, "base64");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf);
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    console.log(`saved ${w}x${h} PNG to ${path}`);
    console.log(
      "NOTE: the headless build renders BLANK pixels (valid PNG, transparent); " +
        "use `text`/`eval`/`html` for perception, not screenshots"
    );
  } catch (e) {
    console.error(`screenshot failed: ${e.message}`);
    await finish(browser, 1);
  }
  await finish(browser, 0);
}

function usage() {
  console.log(`starfish-cdp — drive a headless Starfish browser over CDP

Lifecycle (state in ~/.starfish-cdp/state.json):
  start [--port N] [--url URL]   launch + detach Starfish (default port ${DEFAULT_PORT})
  stop                           kill the managed instance (port-scoped), clear state
  status                         is it alive? port + current url

Perceive (read the live page):
  text [selector]                innerText of body, or textContent of a selector
  html [selector]                outerHTML of <html>, or of a selector
  eval <expression>              Runtime.evaluate (returnByValue); prints JSON value
  screenshot [path]              save PNG (blank pixels on headless)

Act (drive the page):
  goto <url>                     navigate + re-inject keep-alive
  click <selector>               click element center (box-model coords)
  type <selector> <text>         focus + insert text

  help                           this message

Examples:
  node bin/starfish-cdp.mjs start
  node bin/starfish-cdp.mjs goto 'data:text/html,<h1>hi</h1>'
  node bin/starfish-cdp.mjs eval 'document.title'
  node bin/starfish-cdp.mjs text
  node bin/starfish-cdp.mjs type '#name' Starfish
  node bin/starfish-cdp.mjs click '#go'
  node bin/starfish-cdp.mjs stop`);
}

// ---- arg parsing -----------------------------------------------------------

// Pull a `--flag value` option out (minimal; no library).
function getOpt(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}

function positional(args) {
  // strip --flag value pairs, keep the rest
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i++; // skip its value
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const pos = positional(rest);
  switch (cmd) {
    case "start":
      return cmdStart(rest);
    case "stop":
      return cmdStop();
    case "status":
      return cmdStatus();
    case "goto":
      return cmdGoto(pos);
    case "eval":
      return cmdEval(rest); // keep raw so expression spaces/flags survive
    case "text":
      return cmdText(pos);
    case "html":
      return cmdHtml(pos);
    case "click":
      return cmdClick(pos);
    case "type":
      return cmdType(pos);
    case "screenshot":
      return cmdScreenshot(pos);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      usage();
      return;
    default:
      die(`unknown command: ${cmd}\nrun \`help\` for usage`, 1);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
