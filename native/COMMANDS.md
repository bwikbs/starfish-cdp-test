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
| | `press` | `<key>` | `Input.dispatchKeyEvent` (named keys, single chars, modifiers) |
| | `select` | `<selector> <value>` | set `<select>.value` + `change` event |
| | `check` | `<selector>` | tick a checkbox/radio + `change` event |
| | `uncheck` | `<selector>` | untick a checkbox/radio + `change` event |
| | `scroll` | `<dir> [px] [--selector S]` | `scrollBy` on window or an element |
| **Navigate** | `back` | — | `Page.getNavigationHistory` + `navigateToHistoryEntry` (−1) |
| | `forward` | — | history forward (+1) |
| | `reload` | — | re-navigate the current url |
| | `wait` | `<sel\|ms>` / `--text T` / `--fn EXPR` | poll until visible/elapsed/present/truthy (`--timeout MS`, default 5000) |
| **State** | `cookies` | `[list\|set n v\|clear]` | `Network.getAllCookies`/`setCookie`, `Storage.clearDataForOrigin` |
| | `storage` | `<local\|session> [key\|set k v\|clear]` | read/write `localStorage`/`sessionStorage` |
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
$B select '#country' KR         # set a <select> value
$B check '#agree'               # tick a checkbox/radio
$B uncheck '#agree'             # untick
$B scroll down 500              # window.scrollBy(0, 500)
$B scroll right 200 --selector '#pane'   # scroll an element
```

`press` understands the common named keys (`Enter`, `Tab`, `Backspace`,
`Delete`, `Escape`, `ArrowUp/Down/Left/Right`, `Home`, `End`, `PageUp`,
`PageDown`, `Space`), any single printable character, and modifier chords
(`Control+a`, `Shift+Tab`, `Meta+c`). Modifiers map to CDP's bitmask
(Alt=1, Ctrl=2, Meta=4, Shift=8); a modified key does **not** emit `text`, so
`Control+a` selects-all rather than typing `a`.

## Navigate

```sh
$B goto https://example.com     # navigate (re-injects the keep-alive timer)
$B back                         # history back
$B forward                      # history forward
$B reload                       # re-navigate the current url
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
```

> Web storage and cookies are only meaningful on a real **HTTP origin** —
> `data:`/`about:` origins are opaque, so `localStorage` access throws and
> `cookies` is empty there (ANALYSIS §3 DOMStorage/Storage).

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

## What is *not* ported (and why)

These `agent-browser` commands are intentionally **omitted** — the Starfish CDP
binary cannot back them (see [`ANALYSIS.md`](../ANALYSIS.md) §0–§3):

| agent-browser feature | Why not ported |
| --- | --- |
| `tab` / `window` / multi-target | `Target.createTarget` **crashes** the single shared WebView (ANALYSIS §0.2, §3 Target). One tab only. |
| `console` / `errors` | Console arrives as **events** (`Log.entryAdded`, `Runtime.consoleAPICalled`); the stateless-per-call model can't capture events emitted between invocations. Use `cdp Log.enable` + a long-lived raw session if you need them. |
| `network route` / `requests` / `har` | Request interception/recording is event-stream + `Fetch` interception, which isn't behaviorally verified on the binary and needs a persistent listener. |
| `set viewport/device/geo/media/offline` | `Emulation.*` is **ack-only** on the binary (effects not applied; ANALYSIS §3 Emulation). Viewport is fixed at launch via `--width/--height`. `offline` does work via raw `cdp Network.emulateNetworkConditions`. |
| `find role/text/label/...` | `DOM.performSearch` is **not in the binary** (-32601). Use `snapshot` to read roles/names, then act by CSS selector, or `eval` a custom query. |
| `diff` / `trace` / `profiler` / `react` / `vitals` | Tracing/Profiler are ack-empty; React/Vitals need an injected DevTools hook the engine doesn't host. |
| `clipboard` / `dialog` / `frame` | No clipboard surface; dialogs are **ack-only** (`handleJavaScriptDialog` can't change the value the page already saw, ANALYSIS §3 Page); single main frame. |

When in doubt, reach for `cdp <Domain.method>` — it covers every method the
server implements, including ones with no convenience wrapper.

---

## Verification status

All commands compile clean (`npm run build:native`) and validate their
arguments. Each maps to a CDP method that ANALYSIS.md records as
**verified-working** on the target binary (Runtime/DOM/Input/Page/CSS/
Accessibility/Network/Storage). End-to-end behavior should be re-checked
against a live Starfish build (`STARFISH_BIN` or `starfish.config.json`
`defaultBinary`) with the worked example above.
