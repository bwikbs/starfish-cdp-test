# Native C++ CDP client

A from-scratch, zero-dependency CDP client that **replaces puppeteer/playwright**
as the driver behind this test suite. Selected with `CDP_CLIENT=native`.

The C++ binary is the actual CDP client (raw-socket WebSocket + CDP JSON-RPC).
It has **two modes**:

- **CLI mode** (`starfish-cdp-native <command> …`) — a standalone command-line
  driver, **no Node involved**. Replaces `bin/starfish-cdp.mjs` for the native
  client: it manages the Starfish process and runs every CDP command directly.
- **Bridge mode** (`starfish-cdp-native <wsEndpoint>` / `--bridge`) — spawned by
  the Node helper so the *same* `helpers/starfish.mjs` shims and the *same* 143
  tests run unchanged under `CDP_CLIENT=native`.

`argv[1]` selects the mode: a `ws://…` endpoint (or `--bridge`) → bridge; anything
else → CLI.

## CLI mode (node-free)

```
npm run build:native                                   # build once
B=native/build/starfish-cdp-native

$B start [--port N] [--url URL]   # launch + detach Starfish, write state, wait ready
$B status                         # alive? port + client + current url
$B stop                           # port-scoped kill of the managed Starfish

$B eval '6*7'                     # Runtime.evaluate -> 42
$B cdp Schema.getDomains          # raw CDP passthrough -> pretty JSON
$B text [selector]                # innerText / textContent
$B html [selector]                # outerHTML
$B goto <url>                     # navigate + re-inject keep-alive
$B click <selector>               # box-model-center click
$B type <selector> <text>         # focus + insertText
$B fill <selector> <text>         # clear + type + fire input/change
$B press <key>                    # Enter / Tab / a / Control+a
$B snapshot                       # accessibility role/name tree (AI-friendly)
$B get <field> [sel] [attr]       # title|url|value|attr|count|box|styles
$B is <state> <selector>          # visible|enabled|checked -> true/false
$B back | forward | reload        # history navigation
$B wait <sel|ms> | --text | --fn  # wait for element/time/text/condition
$B cookies | storage <area> …     # cookies + local/sessionStorage
$B screenshot [path]              # Page.captureScreenshot -> PNG file
```

The full surface (perceive / act / navigate / state groups, options, and the
agent-browser commands deliberately **not** ported) lives in
**[COMMANDS.md](COMMANDS.md)**.

State lives in `$HOME/.starfish-cdp/state.json` (same file the Node CLI uses).
`start` spawns Starfish via `fork`+`setsid`+`execv` (binary from `STARFISH_BIN`
or `starfish.config.json`'s `defaultBinary`, with `--width/--height` from config);
`stop` matches the pid by `STARFISH_CDP_PORT` in `/proc/<pid>/environ` and group-kills.
A convenience npm alias: `npm run cdp:native -- <command>`.

The model is **stateless-per-call**: Starfish keeps running between invocations,
so each command opens its own CDP connection, does one thing, prints a result,
and disconnects (it never closes Starfish — only `stop` does). Run from the
project root (so `./starfish.config.json` resolves). Build once with
`npm run build:native`; then everything below uses `B=native/build/starfish-cdp-native`.

### Commands

| Command | Args | Does | Prints / exit |
| ------- | ---- | ---- | ------------- |
| `start` | `[--port N]` (9222) `[--url URL]` | fork+setsid+execv Starfish (CDP on), poll `/json/version`, write state | `started … / wsEndpoint / url / client: native / ready`; refuses if one is already running |
| `stop` | — | port-scoped group-kill of the managed Starfish, clear state | `stopped Starfish on port N (pid …)`; idempotent |
| `status` | — | is the managed instance alive? | `status: ALIVE port=N client=native startedAt=… url=…` (or `no managed instance` / `DEAD`) |
| `eval` | `<expression>` | `Runtime.evaluate {returnByValue, awaitPromise}` | the JS value (string as-is, else JSON); whole-number floats normalized (`42.0`→`42`); exit 1 on a thrown exception |
| `cdp` | `<Domain.method> [paramsJSON]` | raw passthrough — any CDP method | the `result` as pretty JSON (2-space); exit 1 on a protocol error |
| `text` | `[selector]` | `body.innerText`, or `querySelector(sel).textContent` | the text, or `element not found` |
| `html` | `[selector]` | `documentElement.outerHTML`, or the selector's `outerHTML` | the HTML |
| `goto` | `<url>` | `Page.navigate` + wait `loadEventFired` + re-inject keep-alive | `navigated to: <url>` |
| `click` | `<selector>` | box-model-center `Input.dispatchMouseEvent` (press+release); re-injects keep-alive if it navigates | `clicked <sel> at (x,y)` |
| `type` | `<selector> <text…>` | `DOM.focus` + `Input.insertText` | `typed into <sel>` / `value: <v>` |
| `fill` | `<selector> <text…>` | clear value + `Input.insertText` + fire `input`/`change` | `filled <sel>` / `value: <v>` |
| `focus` | `<selector>` | `DOM.focus` (JS fallback) | `focused <sel>` |
| `press` | `<key>` | `Input.dispatchKeyEvent` (named keys / single char / modifier chords) | `pressed <key>` |
| `hover` | `<selector>` | `Input.dispatchMouseEvent {mouseMoved}` to center | `hovered <sel> at (x,y)` |
| `dblclick` | `<selector>` | two press+release at the center | `double-clicked <sel> at (x,y)` |
| `select` | `<selector> <value>` | set `<select>.value` + `change` (via JS) | `selected <v> in <sel>` |
| `check` / `uncheck` | `<selector>` | set `.checked` + `change` (via JS) | `checked/unchecked <sel>` |
| `scroll` | `<dir> [px] [--selector S]` | `scrollBy` on window or an element | `scrolled <dir> <px>px` |
| `get` | `<field> [sel] [attr]` | `title`/`url`/`value`/`attr`/`count`/`box`/`styles` (via JS) | the value, or `element not found` |
| `is` | `<state> <selector>` | `visible`/`enabled`/`checked` (via JS) | `true`/`false`, or `element not found` |
| `snapshot` | — | `Accessibility.getFullAXTree` → indented role/name tree | the outline (best agent perception surface) |
| `back` / `forward` | — | `Page.getNavigationHistory` + `navigateToHistoryEntry` (±1) | `back/forward to: <url>` |
| `reload` | — | re-navigate the current url + re-inject keep-alive | `reloaded: <url>` |
| `wait` | `<sel\|ms>` / `--text T` / `--fn EXPR` / `--timeout MS` | poll until visible / elapsed / text present / truthy (default 5000ms) | `ready: <what>` or `timed out` (exit 1) |
| `cookies` | `[list\|set n v\|clear]` | `Network.getAllCookies`/`setCookie`; `Storage.clearDataForOrigin` | JSON list / confirmation |
| `storage` | `<local\|session> [key\|set k v\|clear]` | read/write `localStorage`/`sessionStorage` (via JS) | value / object / confirmation |
| `pdf` | `[path]` (`~/.starfish-cdp/page.pdf`) | `Page.printToPDF` → decode → file | `saved N-byte PDF to <path>` |
| `screenshot` | `[path]` (`~/.starfish-cdp/screenshot.png`) | `Page.captureScreenshot{png}` → decode → file | `saved WxH PNG to <path>` |
| `help` | — | usage | — |

### Worked example — perceive → act → verify (node-free)

A closed loop against a tiny in-page fixture (the live result is read back to
confirm the action actually changed the DOM):

```sh
B=native/build/starfish-cdp-native
URL="data:text/html,<body><input id=name><button id=go>go</button><span id=result></span><script>document.getElementById('go').addEventListener('click',function(){document.getElementById('result').textContent='Hello '+document.getElementById('name').value});setInterval(function(){},300)</script></body>"

$B start                                              # client: native / ready
$B status                                             # ALIVE port=9222 client=native
$B goto "$URL"                                         # navigated to: data:…
$B eval 'document.querySelectorAll("button").length'  # 1
$B type '#name' Starfish                               # typed into #name / value: Starfish
$B click '#go'                                         # clicked #go at (363,18)
$B eval 'document.getElementById("result").textContent'   # Hello Starfish   ← verified
$B html '#result'                                     # <span id="result">Hello Starfish</span>
$B screenshot /tmp/shot.png                           # saved 1280x720 PNG to /tmp/shot.png
$B stop                                               # stopped Starfish on port 9222 (pid …)
```

### Raw CDP — any domain/method

`cdp` reaches every domain the server implements (full table in the
`starfish-control` skill). Many read domains need an `enable` first:

```sh
$B cdp Schema.getDomains                              # → 49 domains
$B cdp Runtime.evaluate '{"expression":"1+1","returnByValue":true}'
$B cdp Page.navigate '{"url":"data:text/html,<h1>hi</h1>"}'
$B cdp DOM.getDocument                                 # pretty-printed node tree
$B cdp Performance.enable && $B cdp Performance.getMetrics
$B cdp Network.getAllCookies
```

### Options & environment

- `--port N` / `--url URL` on `start` (defaults: `9222`, a keep-alive `data:` page).
- `STARFISH_BIN` overrides the Starfish binary; otherwise `starfish.config.json`
  `defaultBinary` (+ `width`/`height` → `--width/--height`).
- State + logs in `$HOME/.starfish-cdp/` (`state.json`, `sf-<port>.log`).
- Quoting: wrap a `data:` URL or a JS expression in shell quotes; keep JS string
  literals to single quotes so the whole arg can be double-quoted in the shell.

```
Node test / bin CLI / demo
        │  connect / pages / newSession / disconnect   (helpers/starfish.mjs, CDP_CLIENT=native)
        ▼
   native/index.mjs ─► native/bridge.mjs
        │  spawn child, stdin/stdout line-JSON-RPC
        ▼
   native/build/starfish-cdp-native  (C++)
        │  raw POSIX socket, RFC6455 WebSocket, CDP JSON-RPC
        ▼
   Starfish CDP server  ws://127.0.0.1:<port>/
```

## Layout

| File | Role |
| ---- | ---- |
| `src/ws_client.{h,cpp}` | raw TCP + RFC6455 client: handshake, **masked** client frames, 3-way length (7/16/64-bit BE), partial-read reassembly, ping→pong, close |
| `src/cdp_client.{h,cpp}` | CDP JSON-RPC: id allocation, `bridgeId↔cdpId` map, flat-session handshake (`setDiscoverTargets` + `setAutoAttach{flatten}`), target/page tracking |
| `src/base64.{h,cpp}` | base64 encode for `Sec-WebSocket-Key` |
| `src/json.hpp` | vendored [nlohmann/json](https://github.com/nlohmann/json) v3.11.3 single header (MIT) |
| `src/main.cpp` | arg `wsEndpoint`; `select()` loop over the WS socket + stdin; emits `ready` then bridges |
| `CMakeLists.txt` | C++17, `-O2 -Wall`, pthread, single exe, no external libs |
| `bridge.mjs` | Node: spawn binary, line-JSON-RPC, `NativeBrowser` + `NativeSession` (`send`/`on`/`once`/`off`) |
| `index.mjs` | exports `nativeConnect/nativePages/nativeNewSession/nativeDisconnect` for the helper |

## Build

```
npm run build:native
# == cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build -j
```

Produces `native/build/starfish-cdp-native` (gitignored). Re-run after editing `src/`.

## Bridge IPC (stdin/stdout, one JSON object per line)

Node → C++:
- `{"op":"send","bridgeId":N,"method":"...","params":{...},"sessionId":"..."?}`
- `{"op":"close"}`

C++ → Node:
- `{"type":"ready","initialPage":{"targetId":..,"sessionId":..},"pages":[..]}`
- `{"type":"result","bridgeId":N,"result":{...}}`
- `{"type":"error","bridgeId":N,"error":{"code":..,"message":"..","data":".."?}}`
- `{"type":"event","method":"..","params":{...},"sessionId":".."?}`
- `{"type":"pages","pages":[{"targetId":..,"sessionId":..}]}`
- `{"type":"fatal","message":".."}`

`bridgeId` is allocated by the Node bridge and echoed by C++ (mapped to the real
CDP `id` internally). `disconnect()` kills the child only — Starfish keeps running.

## Wire notes (Starfish CDP server)

- Handshake: `GET /` + `Upgrade`/`Sec-WebSocket-Key`; the server ignores the path
  and the `Sec-WebSocket-Accept` is not verified by the client.
- Client→server frames are **masked**; server→client are unmasked, single-frame,
  with 64-bit length used for large payloads (e.g. screenshot base64) — the client
  decoder handles all three length encodings.
- One TCP connection only (MVP server); multiple targets are multiplexed over it
  via the flat-session `sessionId` field.
