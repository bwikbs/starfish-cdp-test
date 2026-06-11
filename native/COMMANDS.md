# `starfish-cdp-native` — command reference

The node-free C++ CLI (`native/build/starfish-cdp-native`) drives a headless
Starfish WebView over CDP. Its vocabulary is modeled on
[`agent-browser`](../../agent-browser/README.md), scoped to the CDP surface
Starfish actually implements (see [`ANALYSIS.md` §3](../ANALYSIS.md)). Every
command is **stateless-per-call**: it connects to the already-running Starfish,
does one thing, prints a result, and disconnects — it never closes Starfish
(only `stop` does). Page state (URL, DOM, cookies, storage) persists between
calls because there is one shared, persistent WebView.

```sh
npm run build:native            # build once
B=native/build/starfish-cdp-native
$B <command> [args]             # run from the project root (so ./starfish.config.json resolves)
```

State + logs live in `$HOME/.starfish-cdp/` (`state.json`, `sf-<port>.log`),
shared with the Node CLI (`bin/starfish-cdp.mjs`).

---

## Command summary

| Group | Command | Args | Does |
| --- | --- | --- | --- |
| **Lifecycle** | `start` | `[--port N] [--url URL]` | fork+detach Starfish, poll `/json/version`, write state |
| | `stop` | — | port-scoped group-kill of the managed Starfish, clear state |
| | `status` | — | is the managed instance alive? port + client + url |
| **Perceive** | `text` | `[selector]` | `body.innerText` or `selector.textContent` |
| | `html` | `[selector]` | `documentElement.outerHTML` or `selector.outerHTML` |
| | `eval` | `<expression>` | `Runtime.evaluate` (returnByValue, awaitPromise); prints JSON value |
| | `cdp` | `<Domain.method> [json]` | raw CDP passthrough (any method) |
| | `screenshot` | `[path]` | `Page.captureScreenshot` → PNG file |
| | `pdf` | `[path]` | `Page.printToPDF` → PDF file |
| | `snapshot` | — | `Accessibility.getFullAXTree` → indented role/name tree |
| | `get` | `<field> [sel] [attr]` | `title`,`url`,`value`,`attr`,`count`,`box`,`styles` |
| | `is` | `<state> <selector>` | `visible`,`enabled`,`checked` → `true`/`false` |
| **Act** | `goto` | `<url>` | `Page.navigate` + wait load + re-inject keep-alive |
| | `click` | `<selector>` | box-model-center mouse press+release |
| | `dblclick` | `<selector>` | two press+release at the element center |
| | `hover` | `<selector>` | `Input.dispatchMouseEvent {mouseMoved}` to center |
| | `type` | `<selector> <text>` | `DOM.focus` + `Input.insertText` |
| | `fill` | `<selector> <text>` | clear value + `insertText` + fire `input`/`change` |
| | `focus` | `<selector>` | `DOM.focus` (JS `el.focus()` fallback) |
| | `press` | `<key>` | `Input.dispatchKeyEvent` down+up (named keys, single chars, modifiers) |
| | `keydown` / `keyup` | `<key>` | a single half of a key event |
| | `keyboard` | `type <text>` / `inserttext <text>` | per-char key events at focus / raw `Input.insertText` |
| | `mouse` | `move x y` / `down\|up [btn]` / `wheel dy [dx]` | raw `Input.dispatchMouseEvent` |
| | `select` | `<selector> <value>` | set `<select>.value` + `change` event |
| | `check` | `<selector>` | tick a checkbox/radio + `change` event |
| | `uncheck` | `<selector>` | untick a checkbox/radio + `change` event |
| | `scroll` | `<dir> [px] [--selector S]` | `scrollBy` on window or an element |
| | `scrollintoview` | `<selector>` | `el.scrollIntoView({block:'center'})` |
| | `highlight` | `<selector>` | transient red outline (2 s) + bounding box |
| **Navigate** | `back` | — | `Page.getNavigationHistory` + `navigateToHistoryEntry` (−1) |
| | `forward` | — | history forward (+1) |
| | `reload` | — | re-navigate the current url |
| | `pushstate` | `<url>` | SPA nav: Next.js router if present, else `history.pushState` + `popstate` |
| | `wait` | `<sel\|ms>` / `--text T` / `--fn EXPR` | poll until visible/elapsed/present/truthy (`--timeout MS`, default 5000) |
| **State** | `cookies` | `[list\|set n v\|clear]` | `Network.getAllCookies`/`setCookie`, `Storage.clearDataForOrigin` |
| | `storage` | `<local\|session> [key\|set k v\|clear]` | read/write `localStorage`/`sessionStorage` |
| | `set` | `offline [on\|off]` | `Network.emulateNetworkConditions` (other `set.*` are rejected — ack-only) |
| | `addinitscript` | `<js>` | `Page.addScriptToEvaluateOnNewDocument` — **ACK-ONLY: not executed** on this build |
| | `removeinitscript` | `<identifier>` | `Page.removeScriptToEvaluateOnNewDocument` |
| **Misc** | `help` | — | usage |

---

## Perceive

```sh
$B text                         # whole-body innerText
$B text '#result'               # one element's textContent
$B html '#main'                 # element outerHTML
$B eval 'document.title'        # any JS, returnByValue
$B get title                    # document.title
$B get url                      # location.href (current document URL)
$B get value '#email'           # input value
$B get attr 'a.more' href       # an attribute
$B get count '.item'            # querySelectorAll length
$B get box '#go'                # getBoundingClientRect → {x,y,width,height,...}
$B get styles '#go'             # full computed-style object
$B is visible '#spinner'        # → true / false (false if display:none/hidden/0-size)
$B is enabled '#submit'         # → !disabled
$B is checked '#agree'          # → checkbox state
$B snapshot                     # accessibility tree (best perception surface for an agent)
$B screenshot /tmp/p.png        # PNG (real pixels on the GL build; see ANALYSIS §0.2)
$B pdf /tmp/p.pdf               # PDF (begins %PDF-, ~few KB)
```

`snapshot` prints an indented role/name outline synthesized from the DOM, e.g.:

```
RootWebArea "starfish-cdp ready"
  heading "starfish-cdp ready"
  textbox
  button "go"
```

## Act

```sh
$B click '#go'                  # press+release at the box-model center
$B dblclick '.cell'             # double-click
$B hover '.menu'                # move the mouse over an element
$B type '#name' Starfish        # focus + insertText (appends)
$B fill '#name' Starfish        # clear, then type, then fire input/change
$B focus '#name'                # just focus
$B press Enter                  # Enter / Tab / Escape / ArrowDown / a / Control+a
$B keydown Shift                # hold a key down …
$B keyup Shift                  # … and release it
$B keyboard type "hello world" # per-char key events at the current focus
$B keyboard inserttext "héllo"  # insert text with no key events
$B mouse move 120 240           # move the pointer
$B mouse down ; $B mouse up      # press/release the left button at last point
$B mouse wheel 240              # scroll wheel by deltaY
$B select '#country' KR         # set a <select> value
$B check '#agree'               # tick a checkbox/radio
$B uncheck '#agree'             # untick
$B scroll down 500              # window.scrollBy(0, 500)
$B scroll right 200 --selector '#pane'   # scroll an element
$B scrollintoview '#footer'     # bring an element into view
$B highlight '#go'              # flash a red outline for 2s
```

`press` understands the common named keys (`Enter`, `Tab`, `Backspace`,
`Delete`, `Escape`, `ArrowUp/Down/Left/Right`, `Home`, `End`, `PageUp`,
`PageDown`, `Space`), any single printable character, and modifier chords
(`Control+a`, `Shift+Tab`, `Meta+c`). Modifiers map to CDP's bitmask
(Alt=1, Ctrl=2, Meta=4, Shift=8); the chord's `keydown`/`keyup` carry the right
`key`/`code`/`modifiers`, so app shortcut handlers (`e.ctrlKey && e.key==='a'`)
fire correctly.

> ⚠️ **Engine quirk (verified):** Starfish inserts a character whenever the
> `key` is a single printable char, **regardless of modifiers** — so
> `press Control+a` *also* types an `a` into a focused input (it does not
> suppress text the way a real browser does). Use it for chords whose base key
> is non-printable (`Control+Enter`, `Shift+Tab`) without side effects; for
> printable-letter chords, expect the letter to land in any focused field.

> `dblclick` fires two real `click`s via synthetic mouse input **and** then
> dispatches a DOM `dblclick` event — the engine does not coalesce synthetic
> clicks into a `dblclick` on its own (verified), so the command adds it
> explicitly to make `dblclick` handlers run.

## Navigate

```sh
$B goto https://example.com     # navigate (re-injects the keep-alive timer)
$B back                         # history back
$B forward                      # history forward
$B reload                       # re-navigate the current url
$B pushstate /dashboard         # SPA client-side nav (HTTP origin only)
$B wait '#ready'                # until the element is visible (≤5s)
$B wait 800                     # a plain timer (milliseconds)
$B wait --text 'Welcome'        # until body text contains a substring
$B wait --fn 'window.app.ready' # until a JS expression is truthy
$B wait '#slow' --timeout 15000 # raise the timeout
```

> **Keep-alive:** Starfish shuts the WebView down if no timer is pending
> (ANALYSIS §0.4). `goto`/`back`/`forward`/`reload` all re-inject
> `setInterval(()=>{},300)` after navigating, so you don't have to.

## State

```sh
$B cookies                      # all cookies (JSON)
$B cookies set session abc123   # Network.setCookie scoped to the current url
$B cookies clear                # Storage.clearDataForOrigin (cookies) for the current origin
$B storage local                # whole localStorage as a JSON object
$B storage local token          # one key
$B storage local set token xyz  # write a key
$B storage local clear          # wipe localStorage
$B storage session ...          # same four forms for sessionStorage
$B set offline on               # go offline (next navigation fails)
$B set offline off              # back online
$B addinitscript 'window.x=1'   # register a per-document script (see note)
$B removeinitscript SCRIPT-1    # unregister it
```

> Web storage and cookies are only meaningful on a real **HTTP origin** —
> `data:`/`about:` origins are opaque, so `localStorage` access throws and
> `cookies` is empty there (ANALYSIS §3 DOMStorage/Storage).

> `set offline` is the only `set.*` knob with real effect (it drives
> `Network.emulateNetworkConditions`, verified — the next navigation fails with
> `net::ERR_INTERNET_DISCONNECTED`). `set viewport/device/geo/media/headers/
> credentials` are rejected with a message: `Emulation.*` is **ack-only** on
> this build, and the viewport is fixed at launch via `--width/--height`.

> ⚠️ **`addinitscript` is ACK-ONLY here (verified):** Starfish returns an
> `identifier` for `Page.addScriptToEvaluateOnNewDocument` but never runs the
> script on subsequent documents. The command prints a NOTE saying so. Until a
> build honors it, use `eval` right after each navigation instead.

## Raw CDP escape hatch

Anything not wrapped above is reachable with `cdp` (and read domains usually
need an `enable` first):

```sh
$B cdp Performance.enable && $B cdp Performance.getMetrics
$B cdp DOM.getDocument
$B cdp Network.getAllCookies
$B cdp Runtime.evaluate '{"expression":"1+1","returnByValue":true}'
```

---

## Worked example — perceive → act → verify (node-free)

```sh
B=native/build/starfish-cdp-native
URL="data:text/html,<body><input id=name><button id=go>go</button><span id=result></span><script>document.getElementById('go').addEventListener('click',function(){document.getElementById('result').textContent='Hello '+document.getElementById('name').value});setInterval(function(){},300)</script></body>"

$B start                                 # client: native / ready
$B goto "$URL"
$B get count button                      # 1
$B is visible '#go'                      # true
$B fill '#name' Starfish                 # filled #name / value: Starfish
$B click '#go'                           # clicked #go at (x,y)
$B get text '#result'                    # textContent route
$B eval 'document.getElementById("result").textContent'   # Hello Starfish ← verified
$B snapshot                              # role/name outline
$B stop
```

---

## agent-browser command coverage

The native CLI tracks [`agent-browser`](../../agent-browser/README.md)'s
vocabulary. Below is the **complete** top-level command list (from
`agent-browser`'s `parse_command`), classified by status against this CLI:

- **✅ implemented** — a native wrapper exists (verified E2E unless noted).
- **◐ not wrapped, reachable** — no convenience wrapper, but the underlying CDP
  works, so it's doable today via `cdp <Domain.method>` / `eval`.
- **✗ not supported** — the Starfish binary or the stateless-per-call model
  can't back it (see [`ANALYSIS.md`](../ANALYSIS.md) §0–§3).

### ✅ Implemented (37 commands)

| agent-browser | native | notes |
| --- | --- | --- |
| `open <url>` / `goto` / `navigate` | `goto <url>` | `open` with no URL ≈ `start` (launches on a keep-alive page); there is no separate no-nav `open`. |
| `back` | `back` | |
| `forward` | `forward` | |
| `reload` | `reload` | re-navigates the current URL. |
| `pushstate` | `pushstate` | Next.js router if present, else `history.pushState` + `popstate`. **Needs an HTTP origin** — `data:` is opaque and throws. |
| `click` | `click` | `--new-tab` unsupported (single WebView). |
| `dblclick` | `dblclick` | also dispatches a DOM `dblclick` (engine won't synthesize it). |
| `hover` | `hover` | |
| `type` | `type` | |
| `fill` | `fill` | clear + type + fire `input`/`change`. |
| `focus` | `focus` | |
| `check` / `uncheck` | `check` / `uncheck` | via JS + `change` event. |
| `select` | `select` | |
| `press` / `key` | `press` | named keys, single chars, modifier chords (see the `press` quirk above). |
| `keydown` / `keyup` | `keydown` / `keyup` | one half of a key event each. |
| `keyboard type` | `keyboard type` | per-character key events at the current focus. |
| `keyboard inserttext` | `keyboard inserttext` | raw `Input.insertText`, no key events. |
| `mouse move/down/up/wheel` | `mouse …` | raw `Input.dispatchMouseEvent`. |
| `scroll` | `scroll` | window or `--selector`. |
| `scrollintoview` / `scrollinto` | `scrollintoview` | `el.scrollIntoView({block:'center'})`. |
| `highlight` | `highlight` | transient red outline (2 s); no DevTools overlay surface, so it mutates `style.outline`. |
| `wait` | `wait` | selector / ms / `--text` / `--fn` / `--timeout`. |
| `screenshot` | `screenshot` | real PNG pixels on the GL build. |
| `pdf` | `pdf` | |
| `snapshot` | `snapshot` | role/name tree from `Accessibility.getFullAXTree`. |
| `eval` | `eval` | |
| `get text` / `get html` | `text` / `html` | top-level in native. |
| `get title\|url\|value\|attr\|count\|box\|styles` | `get <field>` | `styles` via `CSS.getComputedStyleForNode`. |
| `is visible\|enabled\|checked` | `is <state>` | |
| `cookies` (list/set/clear) | `cookies` | meaningful on an HTTP origin. |
| `storage local\|session` | `storage` | get/set/dump/clear. |
| `set offline [on\|off]` | `set offline` | `Network.emulateNetworkConditions` — the one `set.*` with real effect; others are rejected with a clear message (Emulation is ack-only). |
| `close` / `quit` / `exit` | `stop` | native manages the process lifecycle (`start`/`stop`), so teardown is `stop`, not a per-page `close`. |
| — | `start` / `status` / `cdp` | native-only: process lifecycle + raw CDP passthrough. |

### ◐ Implemented but ACK-ONLY on this build (no effect)

| agent-browser | native | finding |
| --- | --- | --- |
| `addinitscript` / `removeinitscript` | `addinitscript` / `removeinitscript` | `Page.addScriptToEvaluateOnNewDocument` returns an `identifier` but the script is **never executed** on new documents (verified no-op via E2E). The wrappers exist and print a NOTE; they'll start working if a future build honors the method. Until then, `eval` after each navigation is the substitute. |

### Reachable via `cdp` / `eval` (no wrapper, by choice)

| agent-browser | how to do it now | why no wrapper |
| --- | --- | --- |
| `drag` / `tap` / `swipe` | `cdp Input.dispatchDragEvent` / `dispatchTouchEvent` | **ack-only** — they return `{}` but side effects are not applied (ANALYSIS §3 Input), so a wrapper would look like it works without doing anything. |
| `find role/text/label/...` | `snapshot` for roles/names, then act by CSS selector; or `eval` a custom query | `DOM.performSearch` is **absent** (-32601), so a faithful `find` can't use it — only an `eval`/AX-tree emulation. |

### ✗ Not supported (engine / model constraints)

| agent-browser | why not |
| --- | --- |
| `tab` / `window` | `Target.createTarget` **crashes** the single shared WebView on first render (ANALYSIS §0.2, §3 Target). One tab only. |
| `frame` | single main frame; no child-frame attachment to switch into. |
| `console` / `errors` | these arrive as **events** (`Log.entryAdded`, `Runtime.consoleAPICalled`); the stateless-per-call CLI connects fresh each time and can't capture events emitted between invocations. Needs a long-lived `cdp Log.enable` session. |
| `network route` / `unroute` / `requests` / `request` / `har` | request capture/interception is an event stream + `Fetch` interception, which isn't behaviorally verified on the binary and needs a persistent listener. |
| `stream` (enable/status/disable) | agent-browser's runtime WebSocket streaming — an event-stream feature with no CDP equivalent here. |
| `dialog` (accept/dismiss/status) | `handleJavaScriptDialog` is **ack-only**: the page already resumed with the default before the client responds, so accept/promptText can't change what the page saw (ANALYSIS §3 Page, §5#9). |
| `set viewport/device/geo/media/headers/credentials` | `Emulation.*` is **ack-only** (effects not applied; ANALYSIS §3 Emulation). Viewport is fixed at launch via `--width/--height`. |
| `device` / `tap` / `swipe` | touch/device emulation is ack-only (see Input above). |
| `upload` / `download` | no exposed file-chooser interception or download-manager surface. |
| `clipboard` (read/write/copy/paste) | no clipboard surface in the headless engine. |
| `trace` / `profiler` / `record` | `Tracing.*` is ack-empty `{}`; no profiler/recording backend. |
| `react` (tree/inspect/renders/suspense) / `vitals` | need the React DevTools / web-vitals hook injected at launch, which this engine doesn't host. |
| `diff` (snapshot/screenshot/url) | a client-side compute feature (baseline diffing), not a CDP capability — out of scope for the thin native wrapper. |
| `inspect` | opens the DevTools UI — no GUI inspector in headless. |
| `auth` / `confirm` / `deny` | agent-browser's own permission-prompt workflow, not a browser/CDP feature. |
| `state` (save/load/list/...) | agent-browser's auth-state persistence format; the building blocks (`cookies`, `storage`) are exposed, but the bundled state file format is not reproduced. |
| `batch` | agent-browser runs many commands in one process; the native CLI is one-command-per-process by design (Starfish persists between calls, so a shell loop is the equivalent). |
| `chat` / `install` / `upgrade` / `connect` / `dashboard` | AI/packaging/connection-management features with no role in this CDP wrapper (`connect` is implicit — every command attaches to the managed instance). |

When in doubt, reach for `cdp <Domain.method>` — it covers every method the
server implements, including ones with no convenience wrapper.

---

## Verification status

All commands compile clean (`npm run build:native`) and were exercised
**end-to-end against a live `glib_cairo_gl` Starfish build** (debug, X11 shell,
`STARFISH_ENABLE_CDP=1`) over a `data:` fixture and a local HTTP origin:

- ✅ perceive: `text`, `html`, `eval`, `cdp`, `get` (title/url/value/attr/count/
  box/styles), `is` (visible/enabled/checked), `snapshot`, `screenshot` (real
  PNG pixels), `pdf` (`%PDF-` header)
- ✅ act: `click` (fires onclick), `dblclick` (fires the `dblclick` handler),
  `hover`, `type`, `fill` (clear+type+`input`/`change`), `focus`, `press`
  (named keys + single chars + chord shortcuts), `keydown`/`keyup` (real
  `keydown` event observed), `keyboard type`/`inserttext`, `mouse`
  move/down/up/wheel, `select`, `check`/`uncheck`, `scroll`, `scrollintoview`
  (page scrolled), `highlight`
- ✅ navigate: `goto`, `back`, `forward`, `reload`, `pushstate` (URL changes +
  `popstate` fires on an HTTP origin), `wait` (selector/ms/`--text`/`--fn`/timeout)
- ✅ state on an HTTP origin: `cookies` (list/set/clear), `storage` local &
  session (get/set/dump/clear), `set offline on/off` (+ other `set.*` rejected).
  On a `data:`/`about:` origin storage is opaque (empty), cookies are empty, and
  `pushstate` throws — expected per ANALYSIS §3.

Three issues found during E2E were resolved: `get styles` now uses
`CSS.getComputedStyleForNode` (Starfish's `getComputedStyle` exposes no indexed
iteration, so the JS-enumeration approach returned `{}`); `dblclick` now also
dispatches a DOM `dblclick` event (the engine fires two `click`s but no
`dblclick` from synthetic input); and `addinitscript` was found to be
**ack-only** (the engine returns an identifier but never executes the script),
so its wrapper now prints a NOTE and it is classified accordingly above. Two
engine quirks are documented and not fixable at the CLI layer: a modifier chord
on a printable letter still inserts the letter (see the `press` note), and
`addinitscript` does not run.

> **Build/run note:** the verified build was launched with
> `STARFISH_BIN=…/out/x11/debug/bin/Starfish`. That tree bundles
> `libssl.so.3`/`libcrypto.so.3` exporting only `OPENSSL_3.0.0`, which collides
> with a system `libcurl` needing `OPENSSL_3.2.0`; preloading the system libs
> (`LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libssl.so.3:…/libcrypto.so.3`) resolves
> it. This is a packaging detail of that particular build, not a CLI concern.
