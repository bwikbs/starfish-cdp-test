# Starfish CDP — Test Suite & Agent-Control Demo: PLAN

Test project for the experimental Chrome DevTools Protocol (CDP) server in
Starfish. Goal: (1) a feature test suite validating the *real* CDP domains, and
(2) an "agent drives Starfish via CDP" demo flow.

Authoritative scope: `starfish/docs/CDP.md` and `starfish/docs/CDP_DOMAINS.md`.
Binary under test: `starfish/out/cdp_test/bin/Starfish` (a `glib_headless`
build → **Mock graphics backend**: screenshots/PDF are structurally valid but
blank/transparent pixels).

---

## 1. Test tooling decision

**Runner:** Node.js built-in `node:test` (+ `node:assert/strict`).
**CDP client:** `puppeteer-core` connecting to `ws://127.0.0.1:<port>/`.
Raw CDP via `page.target().createCDPSession()` (a `CDPSession`) for methods
Puppeteer's high-level API does not expose (Performance, Memory, SystemInfo,
DOMSnapshot, Accessibility, CSS, DOMStorage, Storage, Schema, Animation, etc.).

**Rationale:**
- `node:test` is dependency-free, ships with Node ≥ 18, supports
  `before`/`after` hooks, subtests, `--test-concurrency`, and TAP/spec output.
  No Jest/Mocha config overhead.
- `puppeteer-core` (not `puppeteer`) downloads **no** bundled Chromium — it is a
  pure CDP client. `docs/CDP.md §3` documents `puppeteer.connect()` against
  Starfish as the supported path, so it is the most faithful client.
- The raw `CDPSession.send(method, params)` escape hatch lets us assert on exact
  CDP wire results/events for domains with no Puppeteer sugar, and lets us check
  ack-only/partial domains without fighting Puppeteer abstractions.
- Tests run **serially** (`--test-concurrency=1`). The CDP server is a single
  shared Starfish process with one GLib main loop (`CDP.md §6`); concurrent test
  files hammering one server would interleave events unpredictably.

**Node version:** pin `>=18` in `package.json` engines; `puppeteer-core` as the
only runtime dep. No transpiler — author tests as ESM `.mjs`.

---

## 2. Project layout

```
starfish-cdp-skill/
  PLAN.md                      ← this file
  package.json                 ← type:module, scripts: test / demo, dep puppeteer-core
  README.md                    ← how to run (added later, not by planner)
  helpers/
    starfish.mjs               ← launch/teardown harness (the core fixture)
    cdp.mjs                    ← thin helpers: connect, newSession, waitForEvent, collectEvents
    fixtures.mjs               ← reusable data: URLs, keep-alive HTML wrapper, a tiny local HTTP server
  test/
    target.test.mjs            ← Target domain (discovery, multi-tab)
    page.test.mjs              ← Page (navigate, lifecycle, history, content, screenshot shape)
    runtime.test.mjs           ← Runtime (evaluate, callFunctionOn, getProperties, bindings)
    dom.test.mjs               ← DOM (tree, query, mutation, box model, search)
    input.test.mjs             ← Input (mouse/key → DOM effects)
    network.test.mjs           ← Network (real HTTP via local server + synthetic data: path, cookies)
    css.test.mjs               ← CSS computed/inline/matched styles
    storage.test.mjs           ← DOMStorage + Storage + Network cookies
    misc-real.test.mjs         ← Performance, Memory, SystemInfo, Browser, Schema, DOMSnapshot, Accessibility, Log
    partial.test.mjs           ← 🟡 domains: ack/shape-only assertions (Animation, Tracing, Overlay, DOMDebugger, Inspector, DeviceOrientation)
  demo/
    agent-control.mjs          ← the agent-style automation flow (§5)
```

### 2.1 The launch/teardown harness (`helpers/starfish.mjs`)

Single most important fixture. Responsibilities, derived from `CDP.md §2`:

- Spawn the binary with `STARFISH_ENABLE_CDP=1` and a **per-run**
  `STARFISH_CDP_PORT` (allow override via env; default 9222) using
  `child_process.spawn` under `setsid`-equivalent isolation
  (`detached: true`, own process group) so SIGTERM propagation does not kill the
  test runner (`CDP.md §2` note 2).
- Launch with a **keep-alive initial page** so the headless shell does not exit
  after `onload` (`CDP.md §2` note 1):
  `data:text/html,<body><script>setInterval(function(){},300)</script></body>`.
- **Readiness:** poll `GET http://127.0.0.1:<port>/json/version` until it returns
  the `{"Browser":"Starfish/1.0",...,"webSocketDebuggerUrl":...}` JSON (do not
  sleep-and-pray). Time out ~10 s.
- Expose `{ wsEndpoint, port, proc, logPath }`. Pipe stdout/stderr to a temp log
  for debugging.
- **Teardown:** `browser.disconnect()` then kill the whole process group
  (`process.kill(-pid)`); fall back to `pkill -x Starfish`. Never
  `pkill -f bin/Starfish` (`CDP.md §2` note 3).
- Strategy: **one Starfish per test file** (fresh process in `before`, killed in
  `after`). Cheaper than per-test; avoids cross-test state bleed (cookies, DOM
  storage, navigation history) that a shared process would cause.

### 2.2 Local HTTP server fixture (`helpers/fixtures.mjs`)

Network events are **real only on the HTTP loader path** (`CDP_DOMAINS.md`:
"'Real' Network events require the HTTP(S) loader path; `data:`/`about:` use a
synthetic event triple"). So network.test.mjs spins up a throwaway
`node:http` server on `127.0.0.1:0` serving a known HTML doc + one subresource,
and points navigation at it to exercise the real loader-hooked path.

---

## 3. Test cases by domain

Priority: **P0** = core real domains an agent depends on; **P1** = real but
secondary; **P2** = partial/shape-only.

### Target ✅ (P0) — `target.test.mjs`
- `browser.pages()` returns ≥1 page after connect → first page exists.
- `/json/list` (HTTP) lists a `type:"page"` target with a
  `webSocketDebuggerUrl` of form `ws://.../devtools/page/<id>`.
- `newPage()` (`Target.createTarget`) → `pages().length` increments; new page is
  an **independent** WebView: set `window.X='one'` on p1, `window.X='two'` on p2,
  assert each `evaluate(()=>window.X)` is isolated (`CDP.md §3 multi-tab`).
- `page2.close()` (`closeTarget`) → `pages().length` decrements.
- Raw `Target.getTargets` → result has `targetInfos` array.

### Page ✅ (P0) — `page.test.mjs`
- `page.goto("data:text/html,<h1>navigated</h1>")` resolves; `<h1>` text === "navigated".
- `Page.getFrameTree` → `frameTree.frame.id` present (string).
- Lifecycle: enable `Page`, navigate, assert `loadEventFired` fires and
  `lifecycleEvent` includes `init`/`DOMContentLoaded`/`load` names.
- `Page.navigate` returns `{frameId, loaderId}` (loaderId non-empty for the doc).
- Navigation history: `getNavigationHistory` after two `goto`s → ≥2 entries,
  `currentIndex` correct; `navigateToHistoryEntry` (back) lands on prior URL.
- `Page.setDocumentContent` on the frame → DOM reflects the new HTML.
- JS dialog: page with `setTimeout(()=>alert('hi'))`; assert
  `javascriptDialogOpening` event fires; `handleJavaScriptDialog({accept:true})`
  resolves it (Puppeteer `page.on('dialog')`).
- **Screenshot (shape only — headless):** `page.screenshot({type:'png'})`
  returns a buffer that is a **valid PNG** (signature `89 50 4E 47`) with
  IHDR width/height matching the requested viewport. **DO assert** structure,
  dimensions, base64 round-trip. **DO NOT assert** any pixel is non-transparent
  (`CDP.md §6`: Mock backend → every pixel transparent).
- **printToPDF (shape only):** returns a buffer beginning with `%PDF-`. Assert
  header + non-zero length; do not assert rendered content.

### Runtime ✅ (P0) — `runtime.test.mjs`
- `evaluate(()=>6*7)` === 42; `evaluate((a,b)=>a+b, 20, 22)` === 42 (args work).
- `evaluate(()=>document.title)` returns a string.
- Typed RemoteObjects: evaluate returning number/string/boolean/null/undefined/
  object each round-trips with correct type (assert via raw `Runtime.evaluate`
  `result.type`/`subtype`).
- Exception path: `evaluate(()=>{throw new Error('boom')})` rejects /
  `exceptionDetails` present with the message.
- `callFunctionOn`: get a JSHandle, call a method on it returning a primitive.
- `getProperties`: resolve an object handle (e.g. `({a:1,b:2})`), call raw
  `Runtime.getProperties({objectId})` → `result[]` contains own enumerable
  props `a` and `b` with values. (Implemented in source — `RuntimeDomain.cpp`
  enumerates own properties. NOTE: `CDP.md §6` lists getProperties as
  unimplemented, but `CDP_DOMAINS.md` and the source say otherwise; assert only
  **own enumerable** props, not prototype chain / accessors.)
  **DO NOT assert** `objectId`-typed `callFunctionOn` *arguments* — passing a
  JSHandle as an argument is documented unimplemented (`CDP.md §6`).
- `addBinding('name')` + `Runtime.bindingCalled` event fires when page calls it.
- ElementHandle: `page.$('h1')` then `.evaluate(el=>el.textContent)` (exercises
  `subtype:"node"` serialization + `callFunctionOn` on a node handle).
- `getHeapUsage` → `{usedSize, totalSize}` numeric; `globalLexicalScopeNames` →
  array.

### DOM ✅ (P0) — `dom.test.mjs`
- `DOM.getDocument` → root node with `nodeId`, `nodeName:"#document"`.
- `page.$('selector')` / `$$` (`querySelector`/`All`) find expected counts.
- `getOuterHTML(nodeId)` returns the element's HTML; `setOuterHTML` replaces it
  and re-query reflects the change.
- Attributes: `getAttributes`, `setAttributeValue`, `removeAttribute` — verify
  via re-read and via `evaluate` on the live DOM.
- `getBoxModel` / `getContentQuads` on a sized element → numeric quad arrays
  (these feed Input click coords).
- `performSearch`/`getSearchResults`/`discardSearchResults` over a known doc →
  expected match count.
- `describeNode`, `resolveNode` (node → RemoteObject and back), `focus`.
- Mutation events: enable DOM, `setAttributeValue` → `attributeModified` event;
  `removeNode` → `childNodeRemoved`.

### Input ✅ (P0) — `input.test.mjs`
- Click: page with a button whose handler sets `window.clicked=true`;
  `page.click('button')` (uses `getBoxModel` coords + `dispatchMouseEvent`) →
  `evaluate(()=>window.clicked)` true.
- Keyboard: focus an `<input>`, `page.keyboard.type('hello')` → input.value ===
  "hello" (exercises `dispatchKeyEvent` + `insertText`).
- Mouse move/down/up sequence on an element with mousedown/mouseup listeners
  records both.
- **NOTE:** `dispatchDragEvent` is documented ack-only ("drag(ack)" in
  `CDP.md`); do not assert drag side-effects. `imeSetComposition` is niche —
  optional shape-only test, no behavioral assertion.

### Network ✅ (P0) — `network.test.mjs`
Split into the **real** and **synthetic** paths to avoid false expectations.
- **Real HTTP path** (against the local fixture server): enable Network, goto
  `http://127.0.0.1:<fixturePort>/page.html` which references one subresource.
  - Assert `requestWillBeSent` fires for the document; `requestId === loaderId`
    and `type:"Document"` (so Puppeteer's `isNavigationRequest()` holds —
    `NetworkDomain.cpp` comments confirm this contract).
  - Assert `responseReceived` with a real HTTP `status` (200) and headers.
  - `Network.getResponseBody({requestId})` returns the document bytes captured by
    the ResourceLoader hook.
  - **Subresource caveat:** `CDP.md §6` says subresource traffic "is not tracked
    (no ResourceLoader hook)", while `CDP_DOMAINS.md`/source claim loader-hooked
    document + subresources. **Resolve at test time:** assert the document
    request firmly; treat subresource events as *best-effort* — if present,
    assert their shape; do not fail the suite if absent. Document this divergence
    in the test comment.
- **Synthetic data: path:** goto a `data:text/html,...` URL. Per `CDP.md §6`,
  Puppeteer ignores `requestWillBeSent` for `data:` and the response is `null`.
  - **DO assert** the `responseReceived` *event still fires* (raw CDP listener),
    and that navigation completes.
  - **DO NOT assert** a real HTTP status or response body for `data:`.
- Cookies (real): `setCookie`/`setCookies` then `getCookies`/`getAllCookies`
  round-trip on an HTTP origin; `deleteCookies` removes them.
- `setExtraHTTPHeaders` → next request carries the header (assert via the fixture
  server echoing received headers).
- `emulateNetworkConditions({offline:true})` then goto → `loadingFailed`
  (offline gates the loader blocking hook per `NetworkDomain.cpp`); re-enable and
  recover.
- `setBlockedURLs([pattern])` → matching request yields `loadingFailed`.

### CSS ✅ (P1) — `css.test.mjs`
- `getComputedStyleForNode(nodeId)` → array of `{name,value}` incl. expected
  `color`/`display` for a styled element.
- `getInlineStylesForNode` on an element with a `style=""` attr → inline props.
- `getMatchedStylesForNode` → matched rules array present.
- `getStyleSheetText` for a `<style>` sheet returns its text.

### DOMStorage / Storage ✅ (P1) — `storage.test.mjs`
- DOMStorage: enable; `evaluate(()=>localStorage.setItem('k','v'))` then
  `DOMStorage.getDOMStorageItems` → contains `['k','v']`. `setDOMStorageItem`/
  `removeDOMStorageItem`/`clear` round-trip. (session + local both.)
- Storage: `Storage.getCookies`, `clearCookies`, `clearDataForOrigin`,
  `getStorageKeyForFrame` → returns a storage key string.
- These run on an HTTP origin (the fixture server) — `data:`/`about:` have an
  opaque origin and storage may be unavailable.

### Misc real domains ✅ (P1) — `misc-real.test.mjs`
- **Performance:** `enable` then `getMetrics` → array of `{name,value}` incl.
  heap / node / document counts.
- **Memory:** `getDOMCounters` → `{documents, nodes, jsEventListeners}` numeric;
  `forciblyPurgeJavaScriptMemory` acks.
- **SystemInfo:** `getInfo` → object; `getProcessInfo` → array with a real `id`
  (pid) and process type (source claims real pid/uname).
- **Browser:** `getVersion` → `{product:/Starfish/, protocolVersion:"1.3", ...}`.
- **Schema:** `getDomains` → array of `{name,version}`.
- **DOMSnapshot:** `captureSnapshot({computedStyles:[]})` → `documents` +
  `strings` arrays; `getSnapshot` legacy → flattened nodes/layout.
- **Accessibility:** `enable` then `getFullAXTree` → `nodes[]` synthesized from
  DOM, root has a role; `getRootAXNode` returns the root.
- **Log:** `enable`; trigger a `console.error` in page → `Log.entryAdded` (or via
  Runtime.consoleAPICalled) on the **initial tab** (see limitation below).

### Partial domains 🟡 (P2 — ack/shape only) — `partial.test.mjs`
For each, assert the method **resolves without error** and the event/result has
the right *shape*; never assert real behavioral effect.
- **Animation:** `enable`; load a page with a CSS `@keyframes` animation →
  `animationCreated`/`animationStarted` event shape (these are real per
  `CDP_DOMAINS.md`). `setPlaybackRate`/`setPaused` ack only — playback rate is
  *stored, not applied*: **DO NOT** assert timing changes.
- **Tracing:** `start` then `end` → `tracingComplete` fires and a stream/data is
  produced. Events are *synthetic minimal*: assert presence/shape, not real
  trace semantics.
- **Overlay:** `getHighlightObjectForTest(nodeId)` returns a highlight object
  (real). `highlightNode`/`setInspectMode` ack only — no visual assertion.
- **DOMDebugger:** `getEventListeners` on a node with a listener → listeners
  array (real). Breakpoint methods ack only — do not assert breakpoint behavior.
- **Inspector:** `enable`/`disable` ack (no crash/detach events to assert).
- **DeviceOrientation:** `setDeviceOrientationOverride` acks; engine has no
  `DeviceOrientationEvent`, so **DO NOT** assert any event reaches page JS.

---

## 4. Headless / known-limitation guard rails (assert-NOT list)

These come straight from `CDP.md §6` and `CDP_DOMAINS.md`. Encode them as
explicit comments + "shape-only" assertions so tests never depend on broken
paths:

1. **Blank pixels.** Screenshot/printToPDF/screencast on the Mock backend are
   structurally valid but fully transparent/blank. Assert format + dimensions
   only; never assert pixel content. (`clip` x/y offset is parsed but not
   applied → don't assert cropping by offset; width/height/scale do affect size.)
2. **JPEG → PNG fallback.** Requesting `type:'jpeg'` returns PNG bytes (libjpeg
   not linked). If tested, assert PNG signature, not JPEG.
3. **Console bridging is initial-tab only.** `Log.entryAdded` /
   `Runtime.consoleAPICalled` only forward the **first** WebView's console. **DO
   NOT** assert console/log events from a spawned (`newPage`) tab.
4. **Network synthetic vs real.** Only the HTTP loader path emits real
   request/response/body. `data:`/`about:` → synthetic triple, `null` response,
   Puppeteer drops `requestWillBeSent` for `data:`. Test the two paths
   separately (see Network section). Subresource tracking is doc-contradictory →
   best-effort assertion only.
5. **`getProperties` scope.** Own enumerable properties only; do not assert
   prototype-chain / accessor descriptors. `objectId`-typed `callFunctionOn`
   *arguments* are unimplemented — don't pass handles as args.
6. **Spawned tabs have no render surface.** Don't screenshot/printToPDF a
   `newPage()` tab and expect anything (even structurally) reliable; keep visual
   ops on the initial tab.
7. **Single shared process / one GLib loop.** Run tests serially; don't assert
   true parallelism across tabs.
8. **Animation/Tracing/Overlay/DeviceOrientation** are partial — see §3 P2 notes.

---

## 5. Agent-control demo (`demo/agent-control.mjs`)

A single narrated script showing CDP as an **agent control surface** — i.e. the
operations an autonomous agent would use to perceive and act on a page. Uses the
same launch harness; logs each step with a clear `[agent]` prefix. Steps:

1. **Boot & connect.** Launch Starfish via the harness; `puppeteer.connect()` to
   the wsEndpoint; grab the initial page. Open a raw `CDPSession` alongside for
   low-level domains.
2. **Instrument (perception channels).** Enable `Page`, `Runtime`, `DOM`,
   `Network`, `Log`. Wire listeners that collect: console messages
   (`page.on('console')`), network requests (`page.on('request')`/`'response'`),
   page errors. This is the agent's "sensorium".
3. **Navigate to a task page.** `page.goto()` the local fixture server page
   (HTTP, so Network events are real) — a small form: a text input, a button,
   and a results area updated by JS. Wait for `load`.
4. **Observe the DOM (read the screen).** `DOM.getDocument` + `querySelectorAll`
   to enumerate interactive elements; `evaluate` to read labels/placeholder text
   — the agent "reads" what's on the page and decides what to do.
5. **Act via Input.** `page.type('#name', 'Starfish')` then `page.click('#go')`
   (real mouse/key dispatch through Input + box-model coords). Demonstrates the
   agent taking an action.
6. **Verify the result (closed loop).** `evaluate(()=>document.querySelector('#result').textContent)`
   to confirm the action's effect; assert it changed as expected. Show the agent
   using `getProperties` on a returned object handle to inspect structured data.
7. **Inspect network + console.** Print the collected request/response log and
   console output — the agent reviewing side-effects of its action.
8. **Capture a screenshot.** `page.screenshot()` saved to `demo/out.png`. Print
   an explicit caveat that on this headless Mock backend the PNG is a valid but
   blank image — included to show the *capability/wiring*, not pixels.
9. **Multi-tab.** `browser.newPage()`, navigate it independently, show the two
   contexts are isolated (`window.X` differs), then close it — an agent managing
   parallel sub-tasks.
10. **Teardown.** `disconnect()` + harness kill. Exit 0 on success; print a
    one-line summary of everything exercised.

The demo deliberately touches every P0 domain (Target, Page, Runtime, DOM,
Input, Network) plus Log, so it doubles as an end-to-end smoke of the agent
surface.

---

## 6. Out of scope (with one-line reasons)

- **Debugger domain** — Escargot's debugger is not wired to CDP (`CDP_DOMAINS.md`
  / `CDP.md §6`); breakpoints/stepping unavailable.
- **Profiler / HeapProfiler** — no V8 sampler / Boehm-GC has no snapshot; acked
  only.
- **WebAuthn, CacheStorage, IndexedDB, ServiceWorker, WebAudio, Media,
  LayerTree, PerformanceTimeline, Preload/Autofill/FedCm/Cast/etc.** — ❌ not
  implemented, acked with empty result; nothing real to assert.
- **Console domain** — deprecated/acked; use Runtime + Log instead.
- **Real rendered pixels** — Mock graphics backend produces blank output; any
  pixel-content assertion is impossible here (would need a `*_cairo_gl` build).
- **Spawned-tab console/log forwarding** — known unimplemented (initial-tab
  only).
- **`objectId` args to `callFunctionOn`** — documented unimplemented.
- **True multi-core parallelism** — single process / one GLib loop.

Ack-only domains MAY get a tiny "does not error" probe inside `partial.test.mjs`
to confirm the empty-result handshake behavior, but no behavioral assertions.

---

## 7. Definition of done / success criteria

The suite is "done" when:

1. **Harness reliable.** `helpers/starfish.mjs` launches, becomes ready (via
   `/json/version` poll), and tears down cleanly with no orphaned `Starfish`
   processes across the full run (verify with `pgrep -x Starfish` post-run = 0).
2. **All ✅ real domains** (Target, Page, Runtime, DOM, Input, Network, CSS,
   DOMStorage, Storage, Performance, Memory, SystemInfo, Browser, Schema,
   DOMSnapshot, Accessibility, Log) have ≥1 passing behavioral test asserting a
   real effect — per the cases in §3.
3. **All 🟡 partial domains** have a passing ack/shape-only test that never
   asserts a known-broken behavior.
4. **Guard rails honored:** no test asserts pixel content, spawned-tab console,
   real `data:` HTTP status, prototype-chain getProperties, or
   handle-as-argument. (Reviewable by grep for the documented anti-patterns.)
5. **`npm test`** (node:test, `--test-concurrency=1`) exits 0 with a green TAP/
   spec summary, deterministically across ≥3 consecutive runs (no flakiness from
   event timing — events awaited, not slept).
6. **`npm run demo`** runs `demo/agent-control.mjs` end-to-end, exits 0, prints
   the step-by-step `[agent]` narration, produces `demo/out.png`, and the result
   verification step (step 6) passes.
7. **README** documents prerequisites (Node ≥18, the prebuilt binary path,
   `STARFISH_CDP_PORT` override) and the two commands.

Non-goals for "done": code coverage %, CI wiring, testing the `*_cairo_gl`
pixel path, or any ❌ domain behavior.
