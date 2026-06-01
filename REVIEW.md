# REVIEW — Starfish CDP test suite + agent-control demo

Final critical audit. Baseline confirmed green before review: `npm test` →
45/45, exit 0, `pgrep -x Starfish` empty. Demo exits 0 with a real closed-loop
assertion. One HIGH-severity vacuous-assertion fix applied (see Fixes); suite
re-confirmed 45/45 after the fix, no orphans.

**ASSESSMENT: SHIP-WITH-FOLLOWUPS.** The suite is correct, deterministic, and
binary-honest. Assertions check real observable effects (not vacuous), event
listeners are subscribed before the triggering action everywhere, teardown
survives a mid-file assertion throw, and no test asserts a known-broken path.
The follow-ups are coverage gaps (not bugs): a few domains/methods that are
*real on the headless target* (verified live during this review) are listed in
PLAN but not exercised — SystemInfo, DOMSnapshot, DOMDebugger.getEventListeners,
JS-dialog event, Network `loadingFailed`/`setBlockedURLs`, DOM
removeNode/removeAttribute mutation events.

---

## 1. CORRECTNESS

| Finding | Severity | Detail / fix |
| --- | --- | --- |
| `test/partial.test.mjs:36-42` (pre-fix) — Tracing test was vacuous | **HIGH** | `Tracing.start/end` both **resolve `{}`** on headless (verified live), so the `.catch()` handlers were dead code and `assert.ok(end !== undefined)` could never fail — it would still "pass" if a future build broke Tracing into a JSON-RPC reject (swallowed) or returned a non-object. **FIXED**: now `await`s without a catch and asserts `typeof === "object"` on both calls, so a regression to a reject fails loudly. |
| Event-listener races | — (none) | Audited every event-driven test: `Page.loadEventFired`/`lifecycleEvent` (page, network, storage before-hook), `Runtime.bindingCalled`/`consoleAPICalled`, `Log.entryAdded`, `DOM.attributeModified`, and `Network.*` collectors are **all subscribed before** the action that emits them. No subscribe-after-emit races. |
| `test/network.test.mjs:113` — `resps.find(p => p.type === "Document")` | low | Relies on `responseReceived` params carrying `type`; confirmed correct (test passes and `assert.ok(docResp)` would fail loudly otherwise — not vacuous). |
| Promise/await usage | — (none) | No floating promises in load-bearing paths; all `client.send`/event promises are awaited. The settle `setTimeout`s (300-600 ms) are bounded and used only to collect trailing events, with the primary signal (`loadEventFired`/`once`) awaited first. |
| Field assertions vs ANALYSIS §4 shapes | — (none) | RemoteObject type/value, `exceptionDetails.text`, `requestId===loaderId`, `isOwn`, console level remap (`Log` `info` / `consoleAPICalled` `log`) all match the documented contract. |

## 2. ROBUSTNESS

| Finding | Severity | Detail |
| --- | --- | --- |
| Teardown on mid-file THROW | — (none) | `node:test` runs `after` hooks even when a `test()` throws. Every `after` does `browser?.disconnect().catch(()=>{})` then `sf?.stop()`; both are null-guarded, and `launchStarfish` self-cleans on a `before` failure (internal try/catch calls `stop()`). `stop()` is idempotent (`stopped` flag) and **blocks ≤5 s until `pgrep -x Starfish` is empty**, so no orphan/port leak even if a test aborts. Verified: full run leaves 0 orphans. |
| Hardcoded ports 9301-9310 (+demo 9350) | low | One dedicated port per file; serial runner means no intra-suite collision. A pre-existing squatter on a port causes a loud failure + clean teardown (per VERIFICATION §7), not a silent pass. Acceptable under the documented serial contract. |
| Unbounded waits | — (none) | All polling loops (`waitForReady` 15 s, `initialPage` 5 s, `createTarget` page-discovery 5 s, `stop()` reap 5 s) are deadline-bounded. No infinite `while`. |
| `/tmp` log-dir accumulation | low | Each launch `mkdtempSync`s a dir and never removes it (intentional post-mortem aid, noted in VERIFICATION). ~10 dirs/run accumulate. Cleanup decision for the owner; not a correctness bug. |

## 3. SCOPE DISCIPLINE — assert-NOT list (PLAN §4)

| Anti-pattern | Present? |
| --- | --- |
| Pixel/blank-content assertion | NO — screenshot tests assert PNG sig + IHDR dims only (`page.test.mjs:81-86`, demo:144). Demo prints an explicit "blank pixels" caveat. |
| `clip` cropping assertion | NO |
| JPEG assertion | NO — only `format:"png"` is requested; no jpeg path. |
| Prototype-chain / accessor `getProperties` | NO — `runtime.test.mjs:64-76` asserts the **correct** own-enumerable-only behavior (`isOwn===true` for all). |
| `handleJavaScriptDialog` accept-changes-value | NO — dialogs not asserted at all. |
| Spawned-tab console/log | NO — console tests run on the initial tab only. |
| `objectId`-typed `callFunctionOn` *arguments* | NO — only value-typed args / objectId *receiver* used. |
| Dead code / copy-paste drift | minor — the `before`/`after`/`nodeId`/`evalValue` boilerplate is duplicated across files, but that is idiomatic per-file `node:test` fixturing, not extractable without a shared helper the PLAN didn't call for. No unused imports/exports (`connect`, `initialPage`, `dataUrl`, `keepAlive` all used; `helpers/starfish.mjs` `binPath` used internally). |

No test asserts a known-broken path. PLAN §7.4 honored.

## 4. COVERAGE vs PLAN (gap table)

Legend: real-on-headless verified live this review unless noted.

| Domain / method | Tested? | Gap (severity) |
| --- | --- | --- |
| Target getTargets / createTarget / closeTarget | YES | — |
| Page navigate, loadEventFired, lifecycle, history, frameTree, screenshot, printToPDF | YES | — |
| **Page JS dialog** (`javascriptDialogOpening` event) | **NO** | PLAN §3 + ANALYSIS §5.9 say the *event fires* (only the accept-value is ack-only). Untested. (**med**) |
| Runtime evaluate/exception/callFunctionOn/getProperties/addBinding/getHeapUsage | YES | — |
| DOM getDocument/querySelector(All)/getOuterHTML/getAttributes/setAttributeValue→attributeModified/getBoxModel/resolveNode | YES | — |
| **DOM setOuterHTML, removeAttribute→attributeRemoved, removeNode→childNodeRemoved, describeNode** | **NO** | Only `attributeModified` mutation event covered; the removed/childNodeRemoved events (real per ANALYSIS §3) are untested. (**med**) |
| Input insertText / dispatchKeyEvent / mouse click | YES | mouse move/down/up sequence (PLAN) reduced to a single click — minor (**low**) |
| Network real-doc / getResponseBody / subresource / cookies / setExtraHTTPHeaders / data: raw events | YES | — |
| **Network `emulateNetworkConditions({offline})`→loadingFailed, `setBlockedURLs`→loadingFailed, deleteCookies** | **NO** | `loadingFailed` is verified-real (ANALYSIS §3) and agent-relevant; untested. (**med**) |
| CSS computed / inline / matched | YES | `getStyleSheetText` untested (source-only, fine to skip) |
| DOMStorage getDOMStorageItems / Storage getStorageKeyForFrame | YES | DOMStorage set/remove/clear from the **CDP** side, Storage.getCookies/clearDataForOrigin untested (**low**) |
| Performance.getMetrics / Memory.getDOMCounters / Schema.getDomains | YES | — |
| Accessibility.getFullAXTree | YES | `getRootAXNode` untested (**low**) — verified real this review |
| **SystemInfo.getInfo / getProcessInfo** | **NO** | PLAN §3 misc-real lists these ✅; **verified REAL on headless this review** (`getProcessInfo` returns a real pid). The §3 "NOT in binary" list is stale (cdp_test); the §0.0 flip table is right. Untested. (**med**) |
| **DOMSnapshot.captureSnapshot** | **NO** | PLAN §3 lists ✅; **verified REAL on headless this review** (returns populated `documents`/`strings`). Untested. (**med**) |
| Log.entryAdded + consoleAPICalled remap | YES | — |
| Partial: Animation/Overlay/Inspector/DeviceOrientation/Tracing ack | YES | shape/ack-only, correct |
| **DOMDebugger.getEventListeners** | **NO** | PLAN §3 partial lists it as "real"; **verified present on headless** (returns `{listeners:[]}`). Not even ack-probed. (**low-med**) |
| Unknown-domain `{}` vs unknown-method `-32601` | YES | — |

All ✅ real P0 domains (Target, Page, Runtime, DOM, Input, Network) and most P1
have ≥1 real-effect test. All 🟡 partial domains have an ack/shape probe. The
gaps above are P1/secondary methods, not whole domains.

## 5. CLARITY / README / DEMO

- Tests state intent clearly (each file's header comment cites the ANALYSIS
  section it's written against; assertion messages are descriptive).
- **README accurate**: `npm install` / `npm test` / `npm run demo` all run as
  documented; `STARFISH_BIN` override documented and matches the helper default;
  screenshot path (`demo/out/screenshot.png`) matches the code and `.gitignore`
  (`demo/out/`). Headless limitations section is honest and matches behavior.
- **PLAN §7.7 minor divergence (low):** PLAN promised documenting a
  `STARFISH_CDP_PORT` *override*; the implementation hardcodes one port per file
  (`launchStarfish({port})`) and never reads `STARFISH_CDP_PORT` from the env for
  the suite's own port selection. The README does **not** claim port override, so
  the README is accurate — only the PLAN promise is unmet. No fix needed.
- **Demo genuinely closed-loop**: types "Starfish" via `Input.insertText`, clicks
  `#go` via box-model-center mouse events, then `assert.equal(result, "Hello,
  Starfish")` — the fixture only sets `#result` if the click handler actually
  ran, so the assertion fails if Input is broken. Confirmed exit 0, real PNG
  written, multi-tab 1→2→1, no orphan.

## 6. ANALYSIS §3 STALENESS NOTE (informational, not a suite bug)

ANALYSIS §3's "NOT in binary (⛔/🅿️)" list reflects the **stale cdp_test** build.
On the **headless target** the §0.0 flip table governs, and I verified live that
`SystemInfo.*`, `DOMSnapshot.captureSnapshot`, and `DOMDebugger.getEventListeners`
are **real** there (the §3 prose still says they're empty `{}`). The tests
correctly follow the flip table for the methods they cover; the untested ones
(row by row in §4) are coverage gaps, not because the methods are broken.

---

## Fixes applied

1. **`test/partial.test.mjs:36-44`** — replaced the vacuous Tracing assertion.
   Was: `await ...start.catch(()=>{}); const end = await ...end.catch(e=>({err})); assert.ok(end !== undefined)`
   (always true; swallowed errors). Now awaits both `Tracing.start`/`end` without
   a catch and asserts each resolves to an object — preserves the ack-only intent
   (no behavioral claim) while making a future reject/regression fail loudly.
   Suite re-run after fix: 45/45, exit 0, no orphans.

No other code changed.

## Top follow-ups (if a v2 is wanted, in priority order)

1. Add a JS-dialog test: `setTimeout(()=>alert('x'))` → assert
   `Page.javascriptDialogOpening` fires (event only — accept-value stays ack-only).
2. Add `Network.emulateNetworkConditions({offline:true})` → assert `loadingFailed`
   on the next navigation, then recover. (Real, agent-relevant.)
3. Add shape tests for `SystemInfo.getProcessInfo` (real pid) and
   `DOMSnapshot.captureSnapshot` (populated `documents`/`strings`) — both real on
   the headless target and listed ✅ in PLAN §3.
4. Cover the remaining DOM mutation events (`removeAttribute`→`attributeRemoved`,
   `removeNode`→`childNodeRemoved`) and `DOMDebugger.getEventListeners` on a node
   with a real listener.

## End state

- `npm test`: 45/45, exit 0 (post-fix confirm).
- `pgrep -x Starfish`: empty.
- `STARFISH_BIN`: default (unset).
- Git: only `test/partial.test.mjs` modified; uncommitted.
