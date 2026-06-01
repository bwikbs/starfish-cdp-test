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
  build with CDP enabled:

  ```
  /home/bwikbs/workspace/work_lwe/work1/starfish/out/headless/bin/Starfish
  ```

  Override the path with the `STARFISH_BIN` environment variable:

  ```
  STARFISH_BIN=/abs/path/to/Starfish npm test
  ```

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
