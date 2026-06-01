# Agent entry-point + skill review

Independent verification & critical review of `bin/starfish-cdp.mjs`, the
`starfish-control` skill, and the README/package.json updates.

Environment: Node v24.13.1, binary at default
`/home/bwikbs/workspace/work_lwe/work1/starfish/out/headless/bin/Starfish`
(`STARFISH_BIN` unset). Started with zero Starfish running and no state file.

**VERDICT: SHIP** — the entry point and skill work correctly across the full
agent loop, the critical keep-alive gotcha is handled, `stop` is genuinely
port-scoped (no broad-kill), nothing hangs, and no orphans are left. Findings are
all LOW severity; none block shipping. One doc-claim (blank screenshots) was
empirically *confirmed* against this build, contradicting ANALYSIS §5.3 — the
skill's claim is correct, ANALYSIS is stale.

---

## 1. End-to-end agent flow (fresh instance)

All commands sub-second, exit 0 on success.

| Step | Command | Result | Exit |
| --- | --- | --- | --- |
| start | `start` | `started Starfish on port 9222` + ws/url/ready | 0 |
| status | `status` | `ALIVE port=9222 ... url=data:...ready...` | 0 |
| goto | `goto '<form data: url with #name/#go/#result + keep-alive>'` | `navigated to: ...` / `load: complete (keep-alive re-injected)` | 0 |
| perceive | `text` | `gosetInterval(function(){},300)` (body innerText) | 0 |
| perceive | `eval 'document.querySelectorAll("button").length'` | `1` | 0 |
| act | `type '#name' Starfish` | `typed into #name` / `value: Starfish` | 0 |
| act | `click '#go'` | `clicked #go at (363,18)` | 0 |
| **verify** | `eval 'document.getElementById("result").textContent'` | **`hello Starfish`** | 0 |
| screenshot | `screenshot /tmp/sf-shot.png` | `saved 800x600 PNG ...` + blank NOTE | 0 |
| stop | `stop` | `stopped Starfish on port 9222 (pid ...)` | 0 |

Closed loop proven: typed value flowed through the button handler into `#result`.
Also re-ran the full type/click/verify loop with a multi-word value
(`type '#name' hello world from agent` → `eval` result `hello world from agent`)
to confirm argv spaces survive.

## 2. Keep-alive survival (the §0.4 gotcha) — PASS

- `goto` to `data:text/html,<body><h1>no-timer page</h1>...</body>` (NO keep-alive
  timer in markup), waited 3.5s, then `status` → **ALIVE**, `text` → reachable.
  The CLI's post-navigation `reinjectKeepAlive` works.
- Additional robustness probe: raw-navigated via `eval 'location.href="data:...no-timer..."'`
  (no CLI re-inject path), waited 4s → **still ALIVE**. This build keeps the
  instance up even without re-injection on this navigation, likely because
  `Page.addScriptToEvaluateOnNewDocument(KEEP_ALIVE_EXPR)` (line 166) persists the
  timer across subsequent navigations. So the CLI has belt-and-suspenders coverage.
  The documented manual re-inject example (`eval 'setInterval(function(){},300)'`)
  also runs fine (returns a timer id).

No keep-alive death observed in any scenario. No HIGH bug here.

## 3. Error contracts — PASS (all clear message + correct exit)

With instance running:

| Case | Output | Exit |
| --- | --- | --- |
| `eval 'throw new Error("boom")'` | `eval exception: Error: boom` | 1 |
| `eval 'this is not js'` | `eval exception: Line 1: Unexpected token is` | 1 |
| `text '#nope'` | `element not found: #nope` | 1 |
| `html '#nope'` | `element not found: #nope` | 1 |
| `click '#nope'` | `element not found: #nope` | 1 |
| `type '#nope' hi` | `element not found: #nope` | 1 |
| `goto` (no arg) | `usage: goto <url>` | 1 |
| `eval` (no arg) | `usage: eval <expression>` | 1 |
| `click` (no arg) | `usage: click <selector>` | 1 |
| `type '#name'` (no text) | `usage: type <selector> <text>` | 1 |
| `bogus` | `unknown command: bogus` | 1 |

No instance (no state file):

| Case | Output | Exit |
| --- | --- | --- |
| `status` | `status: no managed instance` | 0 (informational) |
| `goto`/`eval`/`text`/`click`/`screenshot` | `no running Starfish; run \`start\` first` | 1 |

Stale state (state file → dead port 9999):

| Case | Output | Exit |
| --- | --- | --- |
| `status` | `status: DEAD (state points at port 9999, not responding)` | 0 |
| `eval` | `no live Starfish on port 9999 (state file stale); run \`stop\` then \`start\`` | 1 |

Double-start refusal: `start` while running →
`Starfish already running on port 9222 (since ...); run \`stop\` first ...` exit 1.

## 4. No-hang — PASS

Every per-call command returned and exited promptly. Measured wall times:
start .28s, status .35s, goto .69s, text .35s, eval .34s, type .34s, click .65s,
screenshot .36s. `goto 'https://example.com'` (network) returned in well under the
30s timeout. The `finish()` helper uses `browser.disconnect()` (not `close`) then
`process.exit` — confirmed no lingering process.

## 5. State & port-scoped stop — PASS (no broad-kill)

Launched a 2nd UNMANAGED Starfish on port 9444 via the documented setsid launch
(`setsid env STARFISH_ENABLE_CDP=1 STARFISH_CDP_PORT=9444 <bin> '<keepalive url>'`).
With both alive (managed pid 1256079 / 9222, unmanaged pid 1256588 / 9444):

- `stop` → killed ONLY 9222 (pid 1256079 gone); **9444 SURVIVED** (`/json/version`
  still served). Proves `findPidByPort` + group-kill is port-scoped, no
  `pkill -x Starfish` broad-kill in the CLI path.
- State file removed after stop.
- `stop` again → `no managed instance (nothing to stop)` exit 0 (idempotent).
- Cleaned up 9444 myself (resolved its pid via `/proc/<pid>/environ` match,
  group-kill). Final `pgrep -x Starfish` → empty.

## 6. Skill / doc accuracy audit (documented example → actual → verdict)

| Documented example | Actual result | Verdict |
| --- | --- | --- |
| `start` | started on 9222, ready | OK |
| `stop` | port-scoped kill, idempotent | OK |
| `status` | port + current URL | OK |
| `goto 'https://example.com'` | navigated, network path works | OK |
| `text` | `Example Domain...` innerText | OK |
| `text '#result'` | `hello world from agent` | OK |
| `eval 'document.title'` | `Example Domain` | OK |
| `eval 'document.querySelectorAll("a").length'` | `1` | OK |
| `html '#go'` (missing) | `element not found: #go` exit 1 | OK (honest) |
| `type '#name' Starfish` | typed, prints value | OK |
| `click '#go'` | clicked at center coords | OK |
| `screenshot /tmp/shot.png` | saved PNG + blank NOTE | OK |
| raw-nav re-inject `eval 'setInterval(function(){},300)'` | runs, returns id | OK |

No doc drift in commands/flags: every documented example runs as described.

**Limitations honesty:**
- "Screenshots are BLANK" — **empirically CONFIRMED on this build.** Decoded the
  PNG (zlib-inflated IDAT, sampled pixels): every sampled pixel is `(0,0,0,0)`
  transparent. Rendered a full-viewport solid-red page and got a byte-identical
  1941-byte PNG (also all-transparent). So the skill/README/CLI NOTE telling the
  agent to perceive via `text`/`eval`/`html` instead of screenshots is correct and
  valuable guidance. NOTE: this contradicts ANALYSIS §5.3 / lines 94-96/239-240
  ("REAL pixels 1920×1056") — ANALYSIS is internally inconsistent (its own summary
  table line 34 says BLANK) and **stale for the current binary**. The skill is
  right; ANALYSIS should be reconciled (out of scope here, noted for follow-up).
  Minor: actual dimensions are 800×600 here, not 1920×1056; the CLI doesn't assert
  a dimension so no drift.
- "Single shared WebView" — accurate (matches ANALYSIS §0.3 / §5.2).
- "State persists across commands" — accurate (verified: page state survives each
  stateless invocation).
- "Always stop when done" — present and emphasized.

**Trigger description:** the frontmatter `description` covers realistic phrasings
("open this page in Starfish", "automate the browser", "click the button / fill
the form headlessly", "scrape/read the page", "test this page in a headless
browser", "drive a browser via CDP") — should match agent routing well.

**Workflow followability:** the canonical perceive→act→verify loop is concrete and
runnable without guessing. Good.

## 7. Code review findings (severity-tagged)

- **LOW — `bin/starfish-cdp.mjs:530` `positional()` strips any positional token
  starting with `--`.** `type '#n' --hello there` → mangled to just `#n` →
  `usage: type ...` exit 1 (reproduced). Affects positional args for
  `type`/`click`/`text`/`html`/`goto` that begin with `--`. Realistically only
  bites `type`ing a literal `--flag` into a field; `eval`-based typing is the
  workaround and `eval` correctly uses raw `rest`. Not fixed: fixing risks
  entangling the `--port`/`--url` parsing `start` depends on; matches the
  intentionally-minimal arg parser. Documented limitation candidate.

- **LOW — `text`/innerText leaks the injected keep-alive script text.** Because the
  default `--url`/`dataUrl` and `reinjectKeepAlive` put `setInterval(...)` in the
  document, `text` (body innerText) shows `...setInterval(function(){},300)`. Only
  cosmetic; an agent reading the page sees a trailing timer string. The
  `addScriptToEvaluateOnNewDocument` injection (no inline `<script>`) does not add
  visible text, but the baked-in keep-alive in `dataUrl` and the default start URL
  do. Not fixed (would change the helper's documented `dataUrl` shape).

- **LOW — `eval` of a non-JSON / `undefined` value prints `undefined`.**
  `eval 'void 0'` → `undefined`; `eval 'setInterval(...)'` → a timer id. Correct
  but worth the agent knowing return values are best-effort JSON. No action.

- **INFO — exit-after-error fallthrough is safe.** In `cmdGoto`/`cmdEval`/`cmdText`/
  `cmdHtml`/`cmdClick`/`cmdType`, the error branches `await finish(browser,1)` then
  textually fall through to a trailing `finish(browser,0)`; because `finish` calls
  `process.exit`, the trailing call never runs. Verified behaviorally (all error
  cases exit 1, never 0). No double-finish, no hang.

- **INFO — `stop` correctly relies on session-leader pgid.** `process.kill(-pid)`
  works because `launchStarfish` uses `setsid` (pgid === sfPid). The CLI's `stop`
  has NO `pkill -x` safety net (unlike the helper's `stop`), which is *why* it is
  truly port-scoped — confirmed by the 9444-survival test. Good design.

- **Coverage gap (note, not fix):** no test/guard for `start --port` with a
  non-numeric value (`Number("abc")` → NaN → would attempt NaN port). Edge, agent
  unlikely to hit. No automated test file for the CLI itself (only manual here).

## Fixes applied

None required. All findings are LOW/INFO; no HIGH-severity issue (no keep-alive
death, no hang, no orphan leak, no broad-kill, no doc command that fails to work)
was found, so no surgical fix was warranted.

## End state

- `pgrep -x Starfish` → empty (no Starfish left running).
- `~/.starfish-cdp/state.json` → removed.
- `STARFISH_BIN` unset (default binary).
- Changes uncommitted.
