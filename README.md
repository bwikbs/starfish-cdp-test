# starfish-cdp-test

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

The client is [`puppeteer-core`](https://github.com/puppeteer/puppeteer)
connected over `ws://127.0.0.1:<port>/`; domains without a high-level puppeteer
API are driven through a raw `CDPSession`. The runner is Node's built-in
`node:test` (no Jest/Mocha).

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
npm install
```

(Installs only `puppeteer-core` — no bundled Chromium is downloaded.)

## Run the tests

```
npm test
```

Runs `node --test --test-concurrency=1 "test/*.test.mjs"`. Tests run serially;
each file launches its own Starfish process.

## Run the demo

```
npm run demo
```

Prints a step-by-step `[agent]` narration (boot → instrument → navigate →
perceive → act → verify → observe → screenshot → multi-tab → teardown), writes a
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
