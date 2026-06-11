# starfish-cdp-skill

A Chrome DevTools Protocol (CDP) test suite and an "agent controls the browser
via CDP" demo for the [Starfish](../starfish) browser engine's experimental CDP
server.

It does two things:

1. **`test/`** — a behavioral test suite over the CDP domains Starfish actually
   implements (Runtime, DOM, Page, Input, Network, CSS, DOMStorage/Storage,
   Browser, Performance, Accessibility, Memory, Schema, Log, Target), plus
   shape/ack-only checks for partial domains and the unknown-method/-domain
   error contract.
2. **`demo/agent-control.mjs`** — a narrated, end-to-end script showing CDP used
   as an autonomous-agent control surface: perceive the DOM, act via Input, then
   verify the effect in a closed loop.

The suite runs against **three** CDP clients from the *same* test files:
[`puppeteer-core`](https://github.com/puppeteer/puppeteer) (`puppeteer.connect`),
[`playwright-core`](https://playwright.dev) (`chromium.connectOverCDP`), and a
**native C++ client** (`native/`, a from-scratch raw-socket WebSocket + CDP
client that replaces puppeteer/playwright — see [native/README.md](native/README.md)),
each connected over `ws://127.0.0.1:<port>/`. Domains without a high-level
client API are driven through a raw `CDPSession`. The client is selected per
process by the **`CDP_CLIENT`** env var (`puppeteer` default, `playwright`, or
`native`); test files never touch client-specific APIs — they go through the
helper shims `connect` / `initialPage` / `newSession` / `pages` / `disconnect`
in `helpers/starfish.mjs`. The runner is Node's built-in `node:test` (no Jest/Mocha).

> The **native** client is a standalone C++ binary (`native/build/starfish-cdp-native`)
> with zero external deps (raw POSIX sockets + vendored single-header JSON). The
> Node side spawns it and bridges `CDPSession.send/on/once/off` over stdin/stdout
> JSON-RPC. Build it once with `npm run build:native` before `CDP_CLIENT=native`.

> Playwright's `connectOverCDP` needs `Target.attachToBrowserTarget`, which the
> Starfish CDP server implements (the page session is then attached through that
> flat browser session). Both clients exercise the identical 143-test suite.

## Prerequisites

- **Node ≥ 18** (developed/verified on Node 24).
- **A built Starfish headless binary.** The suite targets the `glib_headless`
  build with CDP enabled. The default path lives in one place —
  **`starfish.config.json`** at the repo root (`defaultBinary`):

  ```json
  {
    "defaultBinary": "/home/bwikbs/workspace/work_lwe/work1/starfish/out/headless/bin/Starfish",
    "width": 1280,
    "height": 720
  }
  ```

  Edit that file to retarget the build for every entry point at once. The
  `STARFISH_BIN` environment variable still overrides it per-invocation:

  ```
  STARFISH_BIN=/abs/path/to/Starfish npm test
  ```

### Viewport size (`width` / `height`)

  Optional `width` / `height` in `starfish.config.json` set the viewport
  Starfish launches with — passed as `--width=/--height=` flags. They also make
  the harness disable puppeteer's `defaultViewport` (which would otherwise force
  every page to **800×600**), so `window.innerWidth/innerHeight` and
  `screen.width/height` match the configured size.

  ```json
  { "defaultBinary": "...", "width": 1280, "height": 720 }
  ```

  `STARFISH_WIDTH` / `STARFISH_HEIGHT` env vars override the config per-invocation.
  Omit both dimensions to keep puppeteer's 800×600 default (prior behavior).

The harness launches one Starfish process per test file on its own port,
polls `GET /json/version` for readiness, and tears it down via process-group
kill plus a `pkill -x Starfish` safety net, so no orphan processes are left
behind.

## Install

```
npm install            # puppeteer-core + playwright-core (no bundled browser)
npm run build:native   # compile the native C++ client (cmake + make)
```

`puppeteer-core`/`playwright-core` are used purely as CDP clients (no Chromium
download). `build:native` compiles `native/` to `native/build/starfish-cdp-native`
(needs `cmake` + a C++17 compiler; zero external libs). Skip it if you only run
the puppeteer/playwright clients.

## Run the tests

```
npm test                 # all three clients: puppeteer, playwright, native (143 ×3)
npm run test:puppeteer   # puppeteer only  (CDP_CLIENT=puppeteer)
npm run test:playwright  # playwright only (CDP_CLIENT=playwright)
npm run test:native      # native C++  only (CDP_CLIENT=native; needs build:native)
```

`npm test` runs the suite once per client — every test is asserted against
`puppeteer.connect`, `chromium.connectOverCDP`, and the native C++ client. Each
variant is `node --test --test-concurrency=1 "test/*.test.mjs"` with `CDP_CLIENT`
set. Tests run serially; each file launches its own Starfish process. To target a
specific client ad hoc: `CDP_CLIENT=native node --test test/runtime.test.mjs`.

## Run the demo

```
npm run demo              # default client (puppeteer)
npm run demo:playwright   # same flow over playwright connectOverCDP
```

Prints a step-by-step `[agent]` narration (boot → instrument → navigate →
perceive → act → verify → observe → screenshot → raw CDP (Emulation/Storage/
Performance/Accessibility) → multi-tab → teardown), writes a
screenshot to `demo/out/screenshot.png` (gitignored), and exits 0 on success or
non-zero if the closed-loop verification fails.

## Agent control (skill + CLI entry point)

For driving the browser interactively from an agent (rather than running the
scripted demo), there's a stateless-per-call CLI: `bin/starfish-cdp.mjs`.
Starfish and its CDP/page state persist across separate process invocations
(ANALYSIS §0.3), so each command connects to the already-running Starfish, does
one action, prints a result, and disconnects (never `close` — that would tear
Starfish down). A small state file at `~/.starfish-cdp/state.json` records the
managed instance's port.

Invoke directly or via npm:

```
node bin/starfish-cdp.mjs <command>
npm run cdp -- <command>
```

Commands:

| Command | What it does |
| --- | --- |
| `start [--port N] [--url URL]` | Launch + detach Starfish (default port 9222). Refuses to double-launch. |
| `stop` | Kill the managed instance, port-scoped (never touches another Starfish). Idempotent. |
| `status` | Whether the managed instance is alive, its port, and current URL. |
| `goto <url>` | Navigate, then re-inject the keep-alive timer (ANALYSIS §0.4). |
| `eval <expression>` | `Runtime.evaluate` (returnByValue); prints the JSON value, non-zero exit on exception. |
| `cdp <Domain.method> [json]` | Raw CDP passthrough — send any supported method with optional JSON params, prints the JSON result. Covers every domain (full table in the `starfish-control` skill). |
| `text [selector]` | `innerText` of `<body>`, or `textContent` of a selector. |
| `html [selector]` | `outerHTML` of `<html>`, or of a selector. |
| `click <selector>` | Click the element's center (box-model coords); re-injects keep-alive if it navigates. |
| `type <selector> <text>` | Focus + insert text; prints the input's value. |
| `screenshot [path]` | Save a PNG (blank pixels on headless). |
| `help` | Usage. |

Start → act → verify → stop:

```
node bin/starfish-cdp.mjs start
node bin/starfish-cdp.mjs goto 'https://example.com'
node bin/starfish-cdp.mjs text
node bin/starfish-cdp.mjs type '#name' Starfish
node bin/starfish-cdp.mjs click '#go'
node bin/starfish-cdp.mjs eval 'document.getElementById("result").textContent'
node bin/starfish-cdp.mjs stop
```

Perceive with `text` / `eval` / `html` (screenshots render blank on headless).
Always `stop` when done so no process is left running.

### Node-free: the native C++ CLI

The same command set runs with **no Node** via the native C++ binary — it manages
the Starfish process and drives CDP directly. Build once, then call it instead of
`node bin/starfish-cdp.mjs`:

```
npm run build:native
B=native/build/starfish-cdp-native
$B start; $B goto 'data:text/html,<h1>hi</h1>'; $B eval 'document.title'; $B stop
```

It shares `~/.starfish-cdp/state.json` with the Node CLI and covers a broad
`agent-browser`-style command surface: lifecycle (`start`/`stop`/`status`),
perceive (`text`/`html`/`eval`/`cdp`/`screenshot`/`pdf`/`snapshot`/`get`/`is`),
act (`click`/`dblclick`/`hover`/`type`/`fill`/`focus`/`press`/`keydown`/`keyup`/
`keyboard`/`mouse`/`select`/`check`/`uncheck`/`scroll`/`scrollintoview`/
`highlight`), navigate (`goto`/`back`/`forward`/`reload`/`pushstate`/`wait`), and
state (`cookies`/`storage`/`set offline`/`addinitscript`). See
**[native/COMMANDS.md](native/COMMANDS.md)** for the full per-command reference
and the **complete agent-browser coverage matrix** (implemented / ack-only / not
supported, each with reasons), and **[native/README.md](native/README.md)** for
the build/IPC internals and a worked perceive→act→verify example.

### The `starfish-control` skill

A Claude Code skill that wraps this CLI lives at
`.claude/skills/starfish-control/SKILL.md`. It's auto-discovered for this
project. To use it globally, copy or symlink it into `~/.claude/skills/`:

```
ln -s "$PWD/.claude/skills/starfish-control" ~/.claude/skills/starfish-control
```

## Headless limitations (why some things are asserted "shape only")

This is the **headless** build with a mock graphics backend, so the test scope
deliberately tracks what Starfish's current CDP support can actually do:

- **Screenshots / PDF are blank but structurally valid.** Tests assert the PNG
  signature and IHDR dimensions / the `%PDF-` header, never pixel content.
- **`Target.createTarget` works** (a 2nd target spawns, the process survives,
  `closeTarget` restores), **but the engine is a single shared WebView** — tabs
  are not isolated JS contexts, so the suite asserts the target lifecycle, not
  `window.X` isolation.
- **Network events are real** on the HTTP loader path (document + subresources);
  `data:` navigations still emit raw CDP events (asserted via a raw listener,
  since puppeteer hides `data:` requests).
- **Console levels remap:** `console.log` → `Log.entryAdded` level `"info"` and
  `Runtime.consoleAPICalled` type `"log"`.
- **`getProperties`** returns own-enumerable properties only (no prototype chain
  / accessors).

Scope and the empirical contract these tests are written against are documented
in [`PLAN.md`](./PLAN.md) (intended structure) and [`ANALYSIS.md`](./ANALYSIS.md)
(verified per-domain behavior of the target binary). For the engine's own CDP
notes see `starfish/docs/CDP.md`.
