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
$B screenshot [path]              # Page.captureScreenshot -> PNG file
```

State lives in `$HOME/.starfish-cdp/state.json` (same file the Node CLI uses).
`start` spawns Starfish via `fork`+`setsid`+`execv` (binary from `STARFISH_BIN`
or `starfish.config.json`'s `defaultBinary`, with `--width/--height` from config);
`stop` matches the pid by `STARFISH_CDP_PORT` in `/proc/<pid>/environ` and group-kills.
A convenience npm alias: `npm run cdp:native -- <command>`.

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
