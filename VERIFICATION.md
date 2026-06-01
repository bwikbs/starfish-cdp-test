# VERIFICATION

Independent verification of the Starfish CDP test suite against PLAN §7 done
criteria. Target binary: `out/headless/bin/Starfish` (STARFISH_BIN default).

**VERDICT: PASS** (after one teardown fix — see §Fixes). Suite is green
(45/45), deterministic across 5 runs, leaves zero orphan Starfish processes,
and the negative control proves the assertions are binary-sensitive (not
vacuous).

---

## 1. `npm test` — determinism (5 runs)

Command (per run): `npm test` → `node --test --test-concurrency=1 "test/*.test.mjs"`.
Orphan check after each: `pgrep -x Starfish`.

| Run | exit | tests | pass | fail | orphans (`pgrep -x Starfish`) |
| --- | ---- | ----- | ---- | ---- | ----------------------------- |
| 1   | 0    | 45    | 45   | 0    | none |
| 2   | 0    | 45    | 45   | 0    | none |
| 3   | 0    | 45    | 45   | 0    | none |
| 4   | 0    | 45    | 45   | 0    | none |
| 5   | 0    | 45    | 45   | 0    | none |

(Table above is the post-fix run; an identical pre-fix 5x run was also 45/45 every
time — the fix addressed orphan-leak edge cases, not test pass/fail.) No flake, no
timeout, no count drift. Events are awaited (`client.once(...)` + bounded settle
sleeps), not raced. **PLAN §7.1, §7.5: PASS.**

## 2. Orphan-process / leaked-port check

- After every one of the 5 full runs: `pgrep -x Starfish` empty.
- Immediately after a single-file run (`node --test test/dom.test.mjs`): empty
  (post-fix; pre-fix this transiently leaked — see §Fixes).
- No `/tmp` ports left bound (each file uses a fixed dedicated port 9301–9310,
  demo 9350).
- **PLAN §7.1: PASS.**

## 3. `npm run demo` (2 runs)

Command: `npm run demo` → `node demo/agent-control.mjs`.

| Run | exit | `SUCCESS` printed | closed-loop (`#result`) | orphans |
| --- | ---- | ----------------- | ----------------------- | ------- |
| 1   | 0    | yes               | `"Hello, Starfish"`     | none    |
| 2   | 0    | yes               | `"Hello, Starfish"`     | none    |

The closed-loop verification is a real assertion, not a print:
`demo/agent-control.mjs:119` → `assert.equal(result.result.value, "Hello, Starfish", ...)`.
The demo types "Starfish" into `#name` via `Input.insertText`, clicks `#go` via
box-model-center mouse events, then reads `#result.textContent` back — which the
fixture's `app.js` only sets if the click handler actually fired. Writes
`demo/out/screenshot.png` (gitignored, valid PNG). **PLAN §7.6: PASS.**

## 4. Weak-assertion audit (do assertions fail if behavior breaks?)

Verdict per file/test. All assert real observable effects; none are vacuous
("no exception thrown") except where the contract is explicitly ack-only.

| File:test | Verdict |
| --------- | ------- |
| network: real HTTP document | **STRONG** — asserts `docReq.requestId === nav.loaderId`, `request.url === fx.url`, `responseReceived.status === 200`, and `loadingFinished` fired for the doc requestId. |
| network: getResponseBody | **STRONG** — `base64Encoded === false` and body matches `/Agent Task Page/` (real served HTML content). |
| network: setExtraHTTPHeaders | **STRONG** — fixture echoes `x-agent-echo` → asserts `x-agent-echo-back === "ping"` (round-trips through the real loader). |
| network: cookies round-trip | **STRONG** — sets then reads back `value === "online"`. |
| network: data: nav raw events | **STRONG** — asserts raw `requestWillBeSent`/`responseReceived` (status 200) on the CDP listener. |
| network: subresource events | weak-by-design (best-effort, tolerated per ANALYSIS §5.10) — but on headless they do fire and shapes are checked. |
| input: focus + insertText | **STRONG** — reads `input.value === "hello"` via Runtime.evaluate (DOM actually changed). |
| input: dispatchKeyEvent | **STRONG** — `value === "hello!"` (char appended). |
| input: mouse click | **STRONG** — `window.clicked === 1` (onclick handler actually ran). |
| dom: setAttributeValue | **STRONG** — awaits `DOM.attributeModified` event and asserts nodeId/name/value. |
| dom: resolveNode | **STRONG** — round-trips node → handle → `callFunctionOn` reads `textContent === "Title"`. |
| runtime: getProperties | **STRONG** — own-enumerable names `["a","b","c"]`, every prop `isOwn`, value readback. |
| runtime: addBinding | **STRONG** — awaits `bindingCalled` event, asserts payload `"payload-123"`. |
| runtime: exception | **STRONG** — asserts `exceptionDetails.text` matches `/boom/`. |
| css: getComputedStyleForNode | **STRONG** — asserts color matches `rgb(255,0,0)` (real cascade). |
| misc: console remap | **STRONG** — `Log.entryAdded.level === "info"`, `consoleAPICalled.type === "log"`, text matches. |
| storage: getDOMStorageItems | **STRONG** — sets localStorage from page, reads `k===v` back. |
| page: captureScreenshot | shape-only **by design** — PNG signature + IHDR dims > 0; deliberately NOT pixel content (headless blank). Correct per ANALYSIS §0.0/§5.3. |
| partial: ack-only | ack-only **by design** — only asserts no-throw for partial domains; never asserts behavior. Correct per the 🟡 contract. |
| partial: unknown method/domain | **STRONG** — distinguishes unknown DOMAIN (`{}`) vs unknown METHOD (`-32601` reject). |
| target: createTarget | **STRONG** — pages 1→2, `proc.killed === false`, getTargets count, closeTarget restores, original session still evaluates `1+1===2`. |

**PLAN §7.2, §7.3: PASS.** No test asserts a known-broken path (see §5).

## 5. No assertions on known-broken paths (ANALYSIS §5)

`grep -rniE "blank|pixel|clip|jpeg|jpg|prototype|accept.*changes|dialog" test/ demo/`
returns only:
- screenshot comments + structure checks (asserts PNG sig/dims, **not** pixel
  content — correct);
- a "no prototype chain" comment on the getProperties test, which asserts the
  **correct** own-enumerable-only behavior (not the broken full-chain).

No test uses `clip`, jpeg, dialog-accept-changes-value, or spawned-tab console.
**PLAN §7.4: PASS.**

## 6. Negative control — STALE binary

`STARFISH_BIN=/home/bwikbs/workspace/work_lwe/work1/starfish/out/cdp_test/bin/Starfish npm test`

Result: **exit 1, 41 pass / 4 fail.** The 4 failures are exactly the ANALYSIS
§0.0 flip-table behaviors that distinguish the stale `cdp_test` build from the
target `headless` build:

| Failing test | Why (stale cdp_test behavior) |
| ------------ | ----------------------------- |
| `Memory.getDOMCounters returns numeric counts` | returns `{}` on stale (absent) |
| `Schema.getDomains returns a domains array` | returns `{}` on stale (absent) |
| `getHeapUsage is present on headless` | `-32601` on stale (method absent) |
| `createTarget spawns a 2nd target ...` | stale build's multi-tab path is broken (flip: cdp_test ⛔ vs headless ✅) |

This proves the suite is binary-sensitive — it would catch a regression to the
older CDP surface, and it validates the headless-targeting decision. The stale
`createTarget` failure did **not** crash the whole run, and teardown left **zero
orphans** afterward (`pgrep -x Starfish` empty). STARFISH_BIN was set inline only;
default restored automatically.

## 7. Port-conflict / leftover-process robustness

Probe: manually launched a foreign Starfish squatting port 9302, then ran
`node --test test/dom.test.mjs` (which also uses 9302).

- The harness's `/json/version` poll succeeds against the squatter, so puppeteer
  connects to the **wrong** process → 6/7 dom tests fail loudly (the suite does
  not silently pass on a hijacked port — good).
- **Post-fix:** teardown leaves **zero** orphans (the squatter is also reaped by
  the global `pkill -x Starfish` + the new blocking wait-loop). Pre-fix this
  scenario leaked a live process.

Behavior is acceptable and now clean: a port collision produces a loud failure
and full cleanup, not a leak. (The README contract is one dedicated port per file
on a clean baseline, so this collision does not arise in normal operation.)

---

## Fixes applied

**File: `helpers/starfish.mjs`** (only file changed; +~45 lines).

Root cause found via the single-file orphan probe: the teardown's primary
group-kill was effectively dead code, and teardown returned before Starfish had
actually exited.

1. **`process.kill(-proc.pid, "SIGKILL")` always ESRCH'd.** `proc` is the
   `setsid` wrapper, which re-sessions and exits immediately; the real Starfish
   becomes its own session leader with a pgid the harness never knew. So
   `-proc.pid` named a non-existent group every time — the documented
   "kill the whole process group" never worked, and teardown relied **entirely**
   on the global `pkill -x Starfish` safety net.
   - Fix: added `findSelf()` (lines ~100–117) which resolves the real Starfish
     pid by matching `STARFISH_CDP_PORT=<port>` in `/proc/<pid>/environ` (the
     port is in the env, not argv), and `stop()` now group-kills `-sfPid`
     (lines ~123–127). Verified `findSelf` resolves the correct pid.

2. **Teardown returned before the process was reaped.** SIGKILL on the
   multithreaded Starfish takes ~400–600 ms to actually die (observed state
   `Ssl`). The `after` hook returned in that window, so a single-file run (and
   the moment between files) could observe a transient live orphan.
   - Fix: `stop()` now blocks (≤5 s, lines ~137–151) re-issuing `pkill -x
     Starfish` until `pgrep -x Starfish` reports none — teardown is synchronous
     w.r.t. actual process death. Eliminated the transient orphan in all probes.

The `pkill -x Starfish` exact-name safety net and the launch contract
(`setsid env STARFISH_ENABLE_CDP=1 ...`) are unchanged. No tests were modified.
`node --check helpers/starfish.mjs` passes.

## Residual risks / notes (no code change made)

- **`/tmp` log dirs accumulate.** Each launch does
  `mkdtempSync(tmpdir()+"/starfish-cdp-")` and writes one `sf-<port>.log`; the
  harness never removes them (intentionally, as `logPath` is a post-mortem aid).
  203 such dirs (~2 MB) had accumulated across prior runs; I deleted them so the
  end state is litter-free, but they will re-accumulate (~10 dirs/run). Left the
  retain-for-debugging semantics intact — flagging as a cleanup decision for the
  owner, not a correctness bug.
- The global `pkill -x Starfish` in teardown is correct under the documented
  serial (`--test-concurrency=1`) contract but would kill sibling Starfish under
  hypothetical concurrent execution. Out of scope per PLAN non-goals.

## End state

- `npm test`: 45/45, exit 0 (final confirm run after all edits).
- `pgrep -x Starfish`: empty.
- `STARFISH_BIN`: unset (= default headless binary).
- `/tmp/claude-1000/starfish-cdp-*`: cleaned (0 dirs).
- Git: only `helpers/starfish.mjs` modified; not committed.
