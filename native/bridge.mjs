// Node bridge for the C++ native CDP client.
//
// Spawns the `starfish-cdp-native` binary, awaits its `ready` line, and
// re-implements the helper-facing surfaces (NativeBrowser: pages/newSession/
// disconnect; NativeSession: send/on/once/off) over the line-delimited
// stdin/stdout JSON-RPC protocol the binary speaks.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function nativeBinPath() {
  const envBin = process.env.STARFISH_CDP_NATIVE_BIN;
  if (envBin) return envBin;
  return join(__dirname, "build", "starfish-cdp-native");
}

// NativeSession: per-page CDP session surface. Bound to one sessionId.
// Listeners receive the event's `params` object directly.
export class NativeSession {
  #browser;
  #sessionId;
  #listeners = new Map(); // event -> Set<cb>
  #onceWrappers = new Map(); // originalCb -> wrapper

  constructor(browser, sessionId) {
    this.#browser = browser;
    this.#sessionId = sessionId;
  }

  get sessionId() {
    return this.#sessionId;
  }

  send(method, params = {}) {
    return this.#browser._send(method, params, this.#sessionId);
  }

  on(event, cb) {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(cb);
    return this;
  }

  once(event, cb) {
    const wrapper = (params) => {
      this.off(event, cb);
      cb(params);
    };
    this.#onceWrappers.set(cb, wrapper);
    return this.on(event, wrapper);
  }

  off(event, cb) {
    const set = this.#listeners.get(event);
    if (set) {
      set.delete(cb);
      const wrapper = this.#onceWrappers.get(cb);
      if (wrapper) {
        set.delete(wrapper);
        this.#onceWrappers.delete(cb);
      }
    }
    return this;
  }

  _emit(event, params) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) cb(params); // copy => safe against off() during emit
  }
}

export class NativeBrowser {
  #child;
  #stdoutBuf = "";
  #lastBridgeId = 0;
  #pending = new Map(); // bridgeId -> { resolve, reject, method }
  #sessions = new Map(); // sessionId -> NativeSession
  #pages = new Map(); // targetId -> { targetId, sessionId }
  #closed = false;

  constructor(child) {
    this.#child = child;
  }

  static connect(wsEndpoint) {
    const bin = nativeBinPath();
    if (!existsSync(bin)) {
      throw new Error(
        `native client not built. Run: npm run build:native (expected binary at ${bin})`
      );
    }
    const child = spawn(bin, [wsEndpoint], { stdio: ["pipe", "pipe", "pipe"] });
    const browser = new NativeBrowser(child);

    return new Promise((resolve, reject) => {
      let settled = false;
      const onReady = (msg) => {
        if (settled) return;
        settled = true;
        browser._applyPages(msg.pages ?? []);
        resolve(browser);
      };
      const onFatal = (message) => {
        if (settled) return;
        settled = true;
        reject(new Error(`native client failed: ${message}`));
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        browser._onStdout(chunk, onReady, onFatal);
      });
      child.on("exit", () => {
        browser._onExit();
        if (!settled) {
          settled = true;
          reject(new Error("native client exited before ready"));
        }
      });
      child.on("error", (e) => {
        browser._onExit();
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    });
  }

  // --- helper-facing surface ---

  pages() {
    return [...this.#pages.values()];
  }

  newSession(page) {
    let session = this.#sessions.get(page.sessionId);
    if (!session) {
      session = new NativeSession(this, page.sessionId);
      this.#sessions.set(page.sessionId, session);
    }
    return session;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#child.stdin.write('{"op":"close"}\n');
    } catch {
      // stdin may already be gone; ignore.
    }
    this.#child.kill("SIGTERM");
    this._rejectPending(new Error("Connection closed."));
  }

  // --- internal ---

  _send(method, params, sessionId) {
    if (this.#closed) {
      return Promise.reject(new Error(`Protocol error (${method}): Connection closed.`));
    }
    const bridgeId = ++this.#lastBridgeId;
    const frame = { op: "send", bridgeId, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(bridgeId, { resolve, reject, method });
      this.#child.stdin.write(JSON.stringify(frame) + "\n");
    });
  }

  _applyPages(pages) {
    this.#pages = new Map(pages.map((p) => [p.targetId, p]));
  }

  _onStdout(chunk, onReady, onFatal) {
    this.#stdoutBuf += chunk;
    let nl;
    while ((nl = this.#stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.#stdoutBuf.slice(0, nl);
      this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._handle(msg, onReady, onFatal);
    }
  }

  _handle(msg, onReady, onFatal) {
    switch (msg.type) {
      case "ready":
        onReady?.(msg);
        break;
      case "fatal":
        onFatal?.(msg.message ?? "unknown error");
        break;
      case "result": {
        const p = this.#pending.get(msg.bridgeId);
        if (p) {
          this.#pending.delete(msg.bridgeId);
          p.resolve(msg.result ?? {});
        }
        break;
      }
      case "error": {
        const p = this.#pending.get(msg.bridgeId);
        if (p) {
          this.#pending.delete(msg.bridgeId);
          const e = msg.error ?? {};
          const detail = (e.message ?? "unknown error") + (e.data != null ? " " + e.data : "");
          p.reject(new Error(`Protocol error (${p.method}): ${detail}`));
        }
        break;
      }
      case "event": {
        const sid = msg.sessionId;
        const session = sid != null ? this.#sessions.get(sid) : this.#sessions.get("");
        session?._emit(msg.method, msg.params ?? {});
        break;
      }
      case "pages":
        this._applyPages(msg.pages ?? []);
        break;
      case "closed":
        this._rejectPending(new Error("Connection closed."));
        break;
      default:
        break; // forward-compat: ignore unknown types
    }
  }

  _onExit() {
    this.#closed = true;
    this._rejectPending(new Error("Connection closed."));
  }

  _rejectPending(baseErr) {
    for (const { reject, method } of this.#pending.values()) {
      reject(new Error(`Protocol error (${method}): ${baseErr.message}`));
    }
    this.#pending.clear();
  }
}

export const connectNative = (wsEndpoint) => NativeBrowser.connect(wsEndpoint);
