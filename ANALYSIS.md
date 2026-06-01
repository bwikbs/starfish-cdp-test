# Starfish CDP — Empirical Analysis (binary-of-record)

Reference for the IMPLEMENTATION phase. Built from (a) reading
`starfish/src/core/cdp/**` and (b) probing the **deployed binary**
`starfish/out/cdp_test/bin/Starfish` over raw WebSocket. Where source and binary
disagree, **the binary wins** — that is what tests run against.

> Probing method: raw WS client (Node 24 global `WebSocket`, no deps) against
> `ws://127.0.0.1:9222/`. All findings below were observed live unless marked
> "(source)".

---

## 0.0 ⭐ TARGET-BINARY DECISION (read first — supersedes parts of §0)

The original analysis below was run against `out/cdp_test/bin/Starfish`
(`uv_cairo_gl`/`glfw`), which is **STALE** (older than source). We instead target:

**`/home/bwikbs/workspace/work_lwe/work1/starfish/out/headless/bin/Starfish`**
(`glib_headless`/`glib_headless`, CDP enabled, built **2026-06-01 09:05 — NEWER than
all CDP source**). Rationale: it matches the *current* CDP support range (the user's
requirement) and the docs' headless assumptions.

**What FLIPS vs the cdp_test findings below (verified live on the headless binary):**

| Behavior | cdp_test (stale, §0–§5 below) | **headless (TARGET)** |
| -------- | ----------------------------- | --------------------- |
| `Runtime.getHeapUsage` | -32601 (absent) | ✅ `{usedSize,totalSize}` |
| `Runtime.globalLexicalScopeNames`/`compileScript`/`runScript` | -32601 | ✅ present (treat as real) |
| `Schema.getDomains` | `{}` | ✅ `{domains:[...]}` (**29 domains**) |
| `Memory.getDOMCounters` | `{}` | ✅ `{documents,nodes,jsEventListeners}` |
| `SystemInfo.*`, `DOMSnapshot.*`, `DOMDebugger.getEventListeners`, `DOM.performSearch`, `Page.setDocumentContent` | absent/empty | present (verify per §6 capability gate) |
| `Target.createTarget` / multi-tab | ⛔ **crashes process** | ✅ **WORKS** (2 targets, process alive) |
| `Page.captureScreenshot` | real pixels (GL) | **BLANK/transparent** PNG (Mock gfx) — structurally valid, assert shape/dims only (matches PLAN §4) |

**What STAYS the same** (transport, dispatch, RemoteObject shapes §4, keep-alive-lost-on-
navigation §0.4, `lifecycleEvent` needs enabling, process state persists §0.3, unknown-
method vs unknown-domain §2, getProperties own-enumerable-only, console level remap,
JS dialogs ack-only): treat §1–§5 below as accurate EXCEPT the rows in the flip table.

**Net effect on PLAN:** the headless binary restores most of the original PLAN —
multi-tab tests are back IN, the "newer methods" (Memory/Schema/SystemInfo/getHeapUsage/
DOM-search) are testable as real, and screenshots are blank (assert structure only, as
PLAN §4 already specified). Still keep the §6 capability gate for forward/backward
robustness. **Re-verify Network real-vs-synthetic on glib_headless during
implementation** (cdp_test had a real loader hook; confirm headless does too — if not,
fall back to synthetic-event assertions per CDP.md §6).

Launch (note port 9222 used by the suite; readiness via `/json/version` poll):
```
cd starfish/out/headless
setsid env STARFISH_ENABLE_CDP=1 STARFISH_CDP_PORT=9222 ./bin/Starfish \
  "data:text/html,<body><script>setInterval(function(){},300)</script></body>" \
  </dev/null >/tmp/sf.log 2>&1 &
```

---

## 0. HEADLINE FINDINGS — read these before writing any test

These overturn several PLAN.md assumptions. The PLAN was written against the
*source* and the *docs*; the deployed binary differs materially.

### 0.1 The deployed binary is OLDER than the source tree
- Binary mtime: **2026-05-30 11:41**. Several CDP sources are dated **2026-06-01**
  (RuntimeDomain, DOMDomain, NetworkDomain, PageDomain, CSSDomain, EmulationDomain,
  InputDomain, TargetDomain). The binary therefore **lacks features that exist in
  the source today**.
- Concretely, methods present in source but **NOT in the binary** (they return
  `-32601 "'method' wasn't found"`, or `{}` if their whole domain falls through to
  the ack path):
  - `Runtime.getHeapUsage` → **-32601** (source implements it; binary does not)
  - `Runtime.globalLexicalScopeNames` → **-32601**
  - `Runtime.compileScript` / `Runtime.runScript` → **-32601**
  - `DOM.performSearch` / `getSearchResults` / `discardSearchResults` → **-32601**
  - `DOM.getFlattenedDocument` → **-32601**
  - `Page.setDocumentContent` → **-32601**
  - `Memory.getDOMCounters` / `forciblyPurgeJavaScriptMemory` → **`{}`** (acked-empty)
  - `SystemInfo.getInfo` / `getProcessInfo` → **`{}`**
  - `Schema.getDomains` → **`{}`**
  - `DOMSnapshot.captureSnapshot` / `getSnapshot` → **`{}`**
  - `DOMDebugger.getEventListeners` → **`{}`**
  - `Overlay.getHighlightObjectForTest` → **`{}`**
  - `Animation.getPlaybackRate` (and likely other Animation methods) → **`{}`**
  - `Tracing.start`/`end` → **`{}`**, and **no `tracingComplete` event** fires.
- **Action for IMPLEMENTATION:** do not test the above as "real". Either skip them
  or assert the actual binary contract (`-32601` or empty `{}`). If a rebuilt
  binary is later provided, revisit. (See §3 per-domain table for the verified list
  of what *does* work.)

### 0.2 The build is `uv_cairo_gl` + `glfw`, NOT `glib_headless`/Mock
- `out/cdp_test/CMakeCache.txt`: `BACKEND=uv_cairo_gl`, `SHELL=glfw`.
- Consequences that contradict PLAN/CDP.md:
  - **Screenshots contain REAL rendered pixels**, not blank/transparent. A red-bg
    page produced a 1920×1056 PNG with rich pixel variance. **Do NOT assert "every
    pixel transparent."** You *may* assert valid PNG + dimensions; asserting real
    content is now possible but fragile (font/AA dependent) — prefer structure-only.
  - The message loop is **libuv** (`RunLoopLibUV`/`TimerLibUV`), not GLib. Docs'
    "single GLib main loop" wording is inaccurate for this build (behavior — one
    shared loop — still holds).
  - **`Target.createTarget` (newPage / multi-tab) CRASHES THE PROCESS.** The spawned
    WebView has no GLFW surface; its first render tick calls
    `RendererGL::makeCurrent()` and `abort()`s, taking down the whole server
    (verified: SIGABRT backtrace through `RendererGL::rendering`). The crash fires
    on the spawned tab's first rendering timer — usually within a few hundred ms of
    `createTarget`, sometimes before you can even read `window.X`. **Multi-tab is
    unusable on this binary.** Do not write a multi-tab/isolation test; it will kill
    the server mid-suite. (`createTarget` itself returns a `targetId` and, with
    auto-attach, even emits `attachedToTarget` — then dies on the render tick.)

### 0.3 Single shared, persistent process state
- One WebView, one process. Navigation history, cookies, localStorage, and the
  current URL **persist across separate client connections** (the WebView is not
  recreated on reconnect — only the CDP session is reset). Cookies set in one probe
  were still present in a later probe. **Tests must not assume a clean slate** from
  merely reconnecting; the PLAN's "one Starfish per test file" strategy is the right
  mitigation, but be aware even a fresh *connection* to the same process keeps page
  state.

### 0.4 Keep-alive timer is per-page and is LOST on navigation
- The headless shell exits after `onload` if the page has no pending timer. The
  launch URL carries `setInterval(...)`. **But `Page.navigate` to a new URL replaces
  the document and drops that timer** — if the new page has no keep-alive of its own,
  the shell can exit after its load. In probing, navigating a sequence of plain
  `data:` pages let the process shut down.
- **Action:** every URL a test navigates to (data: or the fixture server's HTML)
  must itself embed `<script>setInterval(function(){},300)</script>`, OR the test
  must complete its work before onload-idle shutdown. Bake the keep-alive into the
  fixture HTML and into every `data:` literal used with `Page.navigate`.

---

## 1. Endpoints, handshake, readiness

- **HTTP discovery** (same port):
  - `GET /json/version` → `{"Browser":"Starfish/1.0","Protocol-Version":"1.3",
    "User-Agent":"Starfish/1.0","webSocketDebuggerUrl":"ws://127.0.0.1:9222/"}`
  - `GET /json/list` → array of one target:
    `{"description":"","id":"TID-0000000001","title":"Starfish"|"","type":"page",
    "url":"...","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/page/TID-0000000001"}`
    (Note: at startup `/json/list` `url` showed `about:blank` briefly even though the
    launch URL was a data: URL — `url` lags the actual document early on.)
- **Browser WS endpoint:** `ws://127.0.0.1:9222/` — what `puppeteer.connect({
  browserWSEndpoint })` uses. Puppeteer issues `Target.setAutoAttach` here; the
  binary replies by issuing a session and emitting `Target.attachedToTarget`
  (one event, for the single initial page) — this is how `browser.pages()` finds the
  first page.
- **Per-target WS endpoint:** `ws://127.0.0.1:9222/devtools/page/TID-0000000001`.
  Verified working. On this endpoint you may send commands **with no `sessionId`** and
  they operate on the initial target (e.g. `Runtime.evaluate {expression}` → works).
- **Session id scheme:** `SID-<n>0000000` (e.g. `SID-10000000`, `SID-21111111`).
  `attachToTarget`/`setAutoAttach` both mint/reuse the initial session id.
  `flatten:true` is honored.
- **No-session dispatch:** a command with empty `sessionId` (or `sessionId:"STARTUP"`)
  targets the **initial** context. So you do NOT strictly need to attach to drive the
  first tab.
- **Readiness signal:** poll `GET /json/version` until it returns JSON. The log line
  `CDPServer.cpp: acceptLoop(...) > cdp: devtools server listening on port 9222`
  marks readiness. In practice `/json/version` answered ~2 s after launch. Poll, do
  not sleep-and-pray.
- **Launch (verified):**
  ```
  cd starfish/out/cdp_test
  pkill -x Starfish; sleep 0.5
  setsid env STARFISH_ENABLE_CDP=1 STARFISH_CDP_PORT=9222 ./bin/Starfish \
    "data:text/html,<body><h1>hi</h1><script>setInterval(function(){},300)</script></body>" \
    </dev/null >/tmp/sf.log 2>&1 &
  ```
  Always `pkill -x Starfish` (exact name) to stop.

---

## 2. Unknown-method / ack-empty behavior (precise)

Two distinct behaviors — tests must not conflate them:

1. **Unknown DOMAIN** (not in the dispatcher's big domain switch, e.g. `Totally.unknown`,
   `WebAuthn.*`, `IndexedDB.*`): returns **empty success `{}`**. The handshake-friendly
   ack path (`CDPDispatcher::route` final `else`).
2. **Unknown METHOD inside a KNOWN domain** (e.g. `Runtime.bogus`, `Page.bogus`,
   `Runtime.getHeapUsage` on this binary): returns **error `-32601 "'method' wasn't
   found"`**. Each domain's `processMessage` ends with `sendError(-32601, ...)`.
   - Exception: a few in-dispatcher domains (Security, Browser, DeviceOrientation,
     Inspector, PerformanceTimeline, Audits) ack-empty unknown methods rather than
     erroring (their `else` branch calls `sendResultEmpty()`).
- A request with no/invalid `method` → `-32600 "'method' is missing"`. Missing
  required params → `-32602`. Bad sessionId → `-32001 "Unknown sessionId"`.

---

## 3. Per-domain verified contract (binary)

Legend: ✅ works on binary · ⛔ -32601 on binary · 🅿️ acked-empty `{}` on binary.

### Target ✅ (with one fatal caveat)
- `getTargets` ✅ → `{ targetInfos:[ { targetId, type:"page", title, url, attached,
  canAccessOpener, browserContextId } ] }`. Initial `targetId="TID-0000000001"`,
  `browserContextId="BID-0000000001"`.
- `getTargetInfo` ✅ → `{ targetInfo:{...} }`.
- `getBrowserContexts` ✅ (source) → `{ browserContextIds:[...] }`.
- `attachToTarget {targetId, flatten}` ✅ → `{ sessionId }`, also emits
  `Target.attachedToTarget` with `{ sessionId, targetInfo, waitingForDebugger:false }`.
- `setAutoAttach {autoAttach,waitForDebuggerOnStart,flatten}` ✅ — emits one
  `attachedToTarget` for the initial page (only when sessionId-less and not yet
  emitted). This is puppeteer's `browser.pages()` path.
- `setDiscoverTargets {discover:true}` ✅ — emits `Target.targetCreated`.
- `createTarget {url}` ⛔ **DO NOT USE** — returns a `targetId` but the spawned tab
  crashes the process on first render (see §0.2). `closeTarget` likewise untestable.
- Events: `targetCreated`, `attachedToTarget` (verified). `targetDestroyed`,
  `detachedFromTarget` (source) — not observable because spawning crashes.

### Page ✅ (most methods) — `page` session
- `enable`/`disable` ✅.
- `getFrameTree` ✅ → `{ frameTree:{ frame:{ id, loaderId, url, domainAndRegistry,
  securityOrigin, mimeType, secureContextType, crossOriginIsolatedContextType,
  gatedAPIFeatures } } }`. `frame.id` == the target id (`TID-0000000001`).
- `navigate {url}` ✅ → `{ frameId, loaderId }`. `loaderId` non-empty (e.g.
  `LID-2000000`). Emits (in order): `frameStartedLoading`, `lifecycleEvent(init)`,
  `frameNavigated`, `DOM.documentUpdated`, more `lifecycleEvent`s,
  `loadEventFired`, `frameStoppedLoading`.
- **`lifecycleEvent` only fires after `setLifecycleEventsEnabled {enabled:true}`.**
  Without it, navigation emits NO lifecycle events (verified empty). With it, names
  observed: `init`, `DOMContentLoaded`, `load`, `networkAlmostIdle`, `networkIdle`.
- `loadEventFired` ✅ fires on every navigation regardless of lifecycle toggle.
- `frameNavigated` ✅ → `{ frame:{...same shape as getFrameTree...} }`.
- `getNavigationHistory` ✅ → `{ currentIndex, entries:[{ id, url, userTypedURL,
  title, transitionType }] }`. Verified 3 entries after 3 navs, `currentIndex` tracks.
- `navigateToHistoryEntry {entryId}` ✅ → `{}`; back navigation lands on prior URL
  (verified h1 text reverted to "A").
- `handleJavaScriptDialog {accept,promptText}` ✅ → `{}`, then emits
  `javascriptDialogClosed {result:<accept>, userInput}`. **Ack-only semantics**: the
  page already resumed with the default before the client responds (single-thread MVP),
  so `accept`/`promptText` cannot retroactively change the value the page saw.
- `javascriptDialogOpening` ✅ event → `{ url, message, type:"alert"|"confirm"|"prompt",
  hasBrowserHandler:false, defaultPrompt }`. (Trigger via `setTimeout(()=>alert(...))`.)
- `getLayoutMetrics` ✅ → `{ layoutViewport, visualViewport, cssLayoutViewport,
  contentSize }` with numeric `clientWidth/Height` (1920×1056 default).
- `getResourceTree` ✅ → `{ frameTree:{ frame:{...}, resources:[] } }`.
- `captureScreenshot {format}` ✅ → `{ data: <base64 PNG> }`. **Real pixels**, sig
  `89 50 4e 47`, IHDR = viewport (1920×1056). `format:"jpeg"` → **PNG bytes**
  (libjpeg not linked) — assert PNG sig, not JPEG. **`clip` is IGNORED**: requesting
  `clip:{width:300,height:200}` still produced 1920×1056. Do NOT assert clip
  dimensions/cropping.
- `printToPDF` ✅ → `{ data: <base64> }` beginning `%PDF-` (~5 KB). Assert header +
  non-zero length only.
- `setDocumentContent` ⛔ -32601 on binary (source has it; binary doesn't). Use
  `Runtime.evaluate` with `document.write`/innerHTML instead if you need to set content.
- `setLifecycleEventsEnabled` ✅, `addScriptToEvaluateOnNewDocument` (source) — not
  re-verified; treat as ack/works.

### Runtime ✅ (core) — see §4 for shapes
- `enable` ✅ → `{}` + emits `Runtime.executionContextCreated {context:{ id, origin,
  name:"", uniqueId:"1", auxData:{ isDefault:true, type:"default", frameId } }}`.
  `executionContextId` is `1` for the main context.
- `evaluate {expression, returnByValue?, awaitPromise?, contextId?}` ✅. Result shapes
  in §4.
- `callFunctionOn {functionDeclaration, objectId?, arguments?, returnByValue?}` ✅.
  `objectId` receiver works; **`objectId`-typed arguments are handled in source** but
  treat as best-effort; value-typed args via `arguments:[{value:...}]` work.
- `getProperties {objectId}` ✅ — **IMPLEMENTED** (overturns CDP.md §6 which lists it
  unimplemented; PLAN already anticipated this). Returns **own enumerable properties
  only**. Each entry: `{ name, value:<RemoteObject>, writable, enumerable, configurable,
  isOwn:true }`. `ownProperties:false` is ignored — still returns only own props
  (verified: 3 props for `{a,b,c}` with or without the flag; no prototype chain, no
  accessors). Do NOT assert prototype-chain/getter entries.
- `addBinding {name}` ✅ → `{}`; calling `window[name](payload)` in the page emits
  `Runtime.bindingCalled {name, payload, executionContextId}` (verified payload
  round-trips). `removeBinding` (source) ✅.
- `releaseObject {objectId}` ✅ → `{}`.
- `getHeapUsage` ⛔ -32601 on binary.
- `globalLexicalScopeNames` ⛔ -32601 on binary.
- `compileScript` / `runScript` ⛔ -32601 on binary.
- `queryObjects` → -32000 "not supported" (source); not in binary path either.
- Events: `executionContextCreated` ✅, `consoleAPICalled` ✅ (§ Log),
  `bindingCalled` ✅. `executionContextsCleared` (source).

### DOM ✅ (tree/query/mutate) — search NOT in binary
- `enable`/`disable` ✅.
- `getDocument` ✅ → `{ root:{ nodeId:1, backendNodeId, nodeType, nodeName:"#document",
  localName, nodeValue, childNodeCount, children:[...] } }`. nodeIds are usable.
- `querySelector {nodeId, selector}` ✅ → `{ nodeId }` (0 if no match — confirm).
- `querySelectorAll {nodeId, selector}` ✅ → `{ nodeIds:[...] }`.
- `getOuterHTML {nodeId}` ✅ → `{ outerHTML }`.
- `setOuterHTML {nodeId, outerHTML}` ✅ → `{}` (replaces node; original nodeId becomes
  stale afterwards).
- `getAttributes {nodeId}` ✅ → `{ attributes:["name","val","name2","val2",...] }`
  (flat name/value pairs; empty `[]` when none).
- `setAttributeValue {nodeId,name,value}` ✅ → `{}`, emits `DOM.attributeModified
  {nodeId,name,value}`.
- `removeAttribute {nodeId,name}` ✅ → `{}`, emits `DOM.attributeRemoved {nodeId,name}`.
- `removeNode {nodeId}` ✅ → `{}`, emits `DOM.childNodeRemoved` (source) — verify event
  name on a live node (stale nodeId returns -32000 "Could not find node with given id").
- `getBoxModel {nodeId}` ✅ → `{ model:{ content:[8 nums], padding, border, margin,
  width, height } }`. Use the `content` quad for click coords (feeds Input).
- `getContentQuads {nodeId}` ✅ returns `{ quads:[] }` — **empty for the elements
  probed** (an h1). Don't rely on it for coords; use `getBoxModel`.
- `describeNode {nodeId}` ✅ → `{ node:{ nodeId, backendNodeId, parentId, nodeType,
  nodeName, localName, nodeValue, childNodeCount } }`.
- `resolveNode {nodeId}` ✅ → `{ object:{ type:"object", subtype:"node", className,
  description, objectId:"OBJ-n" } }`. Round-trips to a Runtime handle.
- `focus {nodeId}` ✅ → `{}`.
- `performSearch` / `getSearchResults` / `discardSearchResults` ⛔ -32601 on binary.
- `getFlattenedDocument` ⛔ -32601 on binary.
- Events: `documentUpdated` ✅ (on navigate), `attributeModified` ✅,
  `attributeRemoved` ✅, `setChildNodes`/`characterDataModified`/`childNodeRemoved`
  (source).

### Input ✅ (full effect, verified)
- `dispatchMouseEvent {type:"mousePressed"|"mouseReleased", x,y,button,clickCount,buttons}`
  ✅ → `{}`. A press+release at a button's box-model center fired its onclick
  (`window.clicked` incremented to 1). Coords come from `DOM.getBoxModel` content quad.
- `insertText {text}` ✅ → `{}`; focused input received the text (value === "hello").
- `dispatchKeyEvent {type:"keyDown"|"keyUp", key, text}` ✅ → `{}`; with `text:"!"` the
  char was appended to the focused input (value became "hello!"). (`text` drives
  character insertion.)
- `dispatchTouchEvent {type, touchPoints:[{x,y}]}` ✅ → `{}` (ack; no effect asserted).
- `dispatchDragEvent` ✅ → `{}` (**ack-only**; do not assert drag side effects).

### Network ✅ — REAL on HTTP, synthetic on data:
Verified against a local `node:http` fixture serving a doc + subresources.
- `enable`/`disable` ✅.
- HTTP navigation emits the full set: `requestWillBeSent` → `responseReceived` →
  `loadingFinished`, for the **document AND every subresource** (img, script). This
  **resolves the doc contradiction in favor of subresources being tracked** —
  CDP.md §6's "subresource traffic is not tracked" is OUTDATED; subresources DO fire
  here (verified REQ-1/REQ-2/REQ-3 with `type:"Other"`, status 200).
  - Document request: `requestWillBeSent.params.requestId === loaderId` (e.g.
    `LID-2000000`), `type:"Document"`, `request.url` = the doc URL. This makes
    puppeteer's `isNavigationRequest()` hold.
  - Subresource requests: `requestId` like `REQ-1`, `type:"Other"`.
  - `responseReceived.params.response` for HTTP: `{ url, status:200, statusText:"OK",
    headers:{...}, mimeType, connectionReused, connectionId, fromDiskCache,
    fromServiceWorker, encoded... }`.
- `getResponseBody {requestId}` ✅ → `{ body:"<...doc bytes...>", base64Encoded:false }`.
  Returns the real captured document. (Works for the document request; subresources
  best-effort.)
- `getCookies {urls}` ✅ / `getAllCookies` ✅ → `{ cookies:[{ name, value, domain, path,
  expires:-1, size, httpOnly, secure, session:true, sameSite:"None" }] }`.
- `setCookie {name,value,url}` ✅ → `{ success:true }`. `setCookies` (source).
- `deleteCookies` (source) — not re-verified.
- `setExtraHTTPHeaders {headers}` ✅ → `{}` (header injection itself works; to assert,
  echo the header from the fixture server's response and read it back, since the CDP
  response object's request headers aren't echoed to the client).
- `emulateNetworkConditions {offline:true,...}` ✅ → `{}`. A subsequent navigation
  emits `requestWillBeSent` then **`loadingFailed {errorText:"net::ERR_INTERNET_
  DISCONNECTED"}`** (verified). Set `offline:false` to recover.
- `setBlockedURLs {urls:[pattern]}` ✅ → `{}`.
- **data: URL path:** still emits `requestWillBeSent` → `responseReceived` →
  `loadingFinished`. The raw `responseReceived.params.response` for data: has
  `status:200, statusText:"OK", mimeType:"text/html", headers:{}`. (Note: puppeteer's
  high-level API drops `requestWillBeSent` for data: and reports a null HTTPResponse,
  but the **raw CDP events DO fire** — assert via a raw listener, not via puppeteer's
  `response`.)

### CSS ✅ (real)
- `enable` ✅.
- `getComputedStyleForNode {nodeId}` ✅ → `{ computedStyle:[{name,value},...] }` —
  real values, e.g. `color: rgb(255, 0, 0)`, `display: block`.
- `getInlineStylesForNode {nodeId}` ✅ → `{ inlineStyle:{ cssProperties:[{name,value}],
  shorthandEntries:[], cssText } }` (e.g. `font-weight: bold`).
- `getMatchedStylesForNode {nodeId}` ✅ → `{ inlineStyle:{...}, matchedCSSRules:[{ rule:{
  selectorList:{selectors:[{text}],text}, origin:"regular", styleSheetId:"sheet-0",
  style:{ cssProperties:[...] } } }] }`.
- `getStyleSheetText` (source/docs) — not re-verified.

### DOMStorage ✅ / Storage ✅ (on an HTTP origin)
- `DOMStorage.enable` ✅.
- `DOMStorage.getDOMStorageItems {storageId:{securityOrigin, isLocalStorage}}` ✅ →
  `{ entries:[["k","v"],...] }`. Verified after `localStorage.setItem` on the HTTP
  origin. (`data:`/`about:` origin is opaque — use the fixture HTTP origin.)
- `DOMStorage.setDOMStorageItem`/`removeDOMStorageItem`/`clear` (source/docs).
- `Storage.getStorageKeyForFrame {frameId}` ✅ → `{ storageKey:"http://127.0.0.1:PORT" }`.
- `Storage.getCookies` ✅ → `{ cookies:[...] }` (shares the Network cookie jar).
- `Storage.clearDataForOrigin {origin, storageTypes:"all"}` ✅ → `{}`.

### Performance ✅
- `enable` ✅. `getMetrics` ✅ → `{ metrics:[{name,value},...] }` with real entries:
  `Timestamp, Documents, Frames, JSEventListeners, Nodes, LayoutCount,
  RecalcStyleCount, LayoutDuration, RecalcStyleDuration, ScriptDuration, TaskDuration`.

### Accessibility ✅
- `enable` ✅.
- `getFullAXTree` ✅ → `{ nodes:[{ nodeId:"ax-root", ignored:false, role:{type:"role",
  value:"RootWebArea"}, name:{type:"computedString",value}, properties:[...],
  backendDOMNodeId, childIds:[...] }, ...] }`. Synthesized from DOM.
- `getRootAXNode` ✅ → `{ node:{ nodeId:"ax-root", role:{...RootWebArea}, ... } }`.

### Log ✅ + console bridging
- `Log.enable` ✅. A page `console.error("X"); console.log("Y")` emits:
  - `Log.entryAdded {entry:{ source:"console-api", level:"error"|"info", text,
    timestamp, url }}` — note `console.log` maps to level **`info`** (not `log`),
    `console.error` → `error`.
  - `Runtime.consoleAPICalled {type:"error"|"log"|"info"|"warning"|"debug", timestamp,
    executionContextId, args:[<typed RemoteObject per arg>] }` (requires
    `Runtime.enable`). Each arg is serialized as a typed RemoteObject (string/number/
    object/...), so puppeteer `msg.args()` works.
- **Console bridging is INITIAL-TAB only** (per source: routed by WebView; spawned tabs
  crash anyway, see §0.2). Don't expect console from any other tab.

### Browser ✅
- `getVersion` ✅ → `{ protocolVersion:"1.3", product:"Starfish/1.0", revision:"",
  userAgent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)
  Starfish/1.0 Safari/537.36", jsVersion:"" }`. Note `product` is `"Starfish/1.0"` (the
  PLAN's regex `/Starfish/` matches).

### Fetch ✅ / Emulation ✅ / Security 🅿️ / DeviceOrientation 🅿️ / Inspector 🅿️
- `Fetch.enable` ✅ → `{}`. (Interception via continue/fulfill/fail — source; not
  behaviorally verified.)
- `Emulation.setUserAgentOverride`/`setDeviceMetricsOverride` ✅ → `{}` (ack; effects
  not verified).
- `Security.setIgnoreCertificateErrors` flips a global TLS flag (source); other
  Security.* ack-empty.
- `DeviceOrientation.*` ack-empty; engine has no DeviceOrientationEvent — no event
  reaches page JS.
- `Inspector.enable`/`disable` ack-empty; no crash/detach events.

### NOT in binary (return ⛔ -32601 or 🅿️ `{}` — see §0.1)
`Runtime.getHeapUsage`, `Runtime.globalLexicalScopeNames`, `Runtime.compileScript`,
`Runtime.runScript`, `DOM.performSearch`/`getSearchResults`/`discardSearchResults`,
`DOM.getFlattenedDocument`, `Page.setDocumentContent` (all ⛔);
`Memory.*`, `SystemInfo.*`, `Schema.getDomains`, `DOMSnapshot.*`,
`DOMDebugger.getEventListeners`, `Overlay.getHighlightObjectForTest`,
`Animation.getPlaybackRate`, `Tracing.start`/`end` (all 🅿️ empty `{}`).

---

## 4. Runtime RemoteObject shapes (verified, `Runtime.evaluate`)

`result` field of `Runtime.evaluate`:

| expression        | RemoteObject                                                                 |
|-------------------|------------------------------------------------------------------------------|
| `6*7`             | `{type:"number", value:42}`                                                  |
| `"hello"`         | `{type:"string", value:"hello"}`                                             |
| `true`            | `{type:"boolean", value:true}`                                               |
| `null`            | `{type:"object", subtype:"null", value:null}`                               |
| `undefined`       | `{type:"undefined", description:"undefined"}`                                |
| `({a:1,b:2})`     | `{type:"object", className:"Object", description:"[object Object]", objectId:"OBJ-n"}` |
| `[1,2,3]`         | `{type:"object", subtype:"array", className:"Array", description:"1,2,3", objectId:"OBJ-n"}` |
| `NaN`             | `{type:"number", description:"NaN"}` (no `value`)                            |
| `1/0`             | `{type:"number", description:"Infinity"}` (no `value`)                       |
| `Symbol("x")`     | `{type:"symbol", description:"Error while converting to string,..."}` (desc is broken text) |
| `10n`             | `{type:"bigint", description:"10"}`                                          |
| `(function f(){})`| `{type:"function", className:"Function", description:"function f(){}", objectId:"OBJ-n"}` |
| DOM node (resolveNode / `document.body`) | `{type:"object", subtype:"node", className:"H1"/"BODY", description, objectId:"OBJ-n"}` |

- **`returnByValue:true`** on an object → adds `value:<deep JSON>` alongside
  `type/className/description` (e.g. `({a:1,b:[2,3]})` → `value:{a:1,b:[2,3]}`).
- **Exception (throw):** result is
  `{ result:<RemoteObject of the thrown Error>, exceptionDetails:{ exceptionId:1, text:
  "Error: boom", lineNumber:1, columnNumber:7, exception:<RemoteObject> } }`. (Note:
  the command still resolves successfully with an `exceptionDetails` field — it does
  NOT come back as a JSON-RPC error.) The thrown value's RemoteObject has
  `subtype:"error", className:"Error", description:"Error: boom", objectId`.
- **Syntax error:** `{ result:{type:"undefined"}, exceptionDetails:{ exceptionId:1,
  text:"Line 1: Unexpected token ILLEGAL", lineNumber:0, columnNumber:0 } }` (no
  `exception` sub-object for parse errors).
- **objectId format:** `"OBJ-<n>"`, monotonic per process, served by `RemoteObjectStore`.
- `getProperties` value RemoteObjects use the **same serializer** (e.g. a nested array
  prop comes back with `subtype:"array"` and its own `objectId`).

---

## 5. GOTCHAS FOR TEST AUTHORS (the things that will break naive tests)

1. **Binary < source.** Many "documented" methods are -32601 or empty `{}` here. Treat
   §0.1 / §3 ⛔🅿️ lists as the authority. The PLAN's `misc-real.test.mjs` (Memory,
   SystemInfo, Schema, DOMSnapshot) and DOM search tests will FAIL — these are NOT in
   the binary. Either gate them behind a capability probe or assert the empty/error
   contract.
2. **`Target.createTarget`/`newPage()` CRASHES the whole server** (no GLFW surface →
   `RendererGL::makeCurrent` abort). Skip the entire multi-tab story
   (`target.test.mjs` newPage/isolation/close, demo step 9). Asserting >1 page is
   impossible without killing the process.
3. **This is a GL build, screenshots have REAL pixels** (1920×1056). Do NOT assert
   "transparent/blank." Assert PNG signature + IHDR dims. `clip` is **ignored** — never
   assert cropped dimensions. `jpeg` → PNG bytes (assert PNG sig).
4. **Keep-alive timer is lost on navigation.** Embed
   `<script>setInterval(function(){},300)</script>` in EVERY navigated page (fixture
   HTML and every `data:` literal), or the shell shuts down mid-test.
5. **`lifecycleEvent` requires `Page.setLifecycleEventsEnabled({enabled:true})` first.**
   Otherwise zero lifecycle events fire (loadEventFired still does).
6. **Process state persists across connections.** Cookies, localStorage, navigation
   history, current URL survive disconnect/reconnect (one persistent WebView). Use a
   fresh process per file (PLAN already does); don't trust reconnect to reset.
7. **Unknown method vs unknown domain differ:** known-domain/unknown-method → -32601;
   unknown-domain → `{}`. A capability probe should call a *known-domain* method and
   check for the -32601 error (e.g. probe `Runtime.getHeapUsage`).
8. **getProperties returns own-enumerable only**, always `isOwn:true`,
   `ownProperties:false` ignored. No prototype chain, no accessors.
9. **JS dialogs are ack-only.** `handleJavaScriptDialog` cannot change the value the
   page already received; the page resumes with the default (confirm=false,
   prompt=null) before the client can respond. Assert the events fire, not that accept
   changed page behavior.
10. **Network: assert the DOCUMENT request firmly** (`requestId===loaderId`,
    `type:"Document"`). Subresources DO fire on this binary (contra CDP.md §6) — you
    may assert them, but keep them best-effort to stay robust. For `data:`, use a RAW
    CDP listener (puppeteer hides the data: request/response).
11. **`setExtraHTTPHeaders`** can't be verified from the CDP response object; echo the
    header from your fixture server and read it back.
12. **`getContentQuads` returned empty** for a block element; prefer `getBoxModel`
    `content` quad for Input coordinates.
13. **Console levels remap:** `console.log` → `Log.entryAdded.level:"info"` and
    `Runtime.consoleAPICalled.type:"log"`. Don't assert level `"log"` in Log entries.
14. **`product` is `"Starfish/1.0"`**, `protocolVersion:"1.3"`. The `userAgent` in
    `Browser.getVersion` is the Chrome-like UA string (not "Starfish/1.0").

---

## 6. Recommended capability gate for the suite

Because the binary lags the source, have the harness run one probe at startup and
expose booleans the tests can branch on (skip vs assert):

```
const has = async (m, params={}) =>
  send(m, params).then(() => true)
                 .catch(e => e.cdp?.code !== -32601); // -32601 => absent
// or for ack-empty domains, detect a missing expected field on the result.
```
Suggested probes: `Runtime.getHeapUsage` (→ absent here), `DOM.performSearch`,
`Memory.getDOMCounters` (empty `{}` here → treat as absent),
`Schema.getDomains`, `DOMSnapshot.captureSnapshot`. Gate the corresponding tests.
This keeps the suite green on this binary and forward-compatible with a rebuilt one.
