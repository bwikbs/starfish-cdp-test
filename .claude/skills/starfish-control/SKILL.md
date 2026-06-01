---
name: starfish-control
description: Drive a headless Starfish WebView browser over the Chrome DevTools Protocol (CDP) from the shell. Use when the user wants to browse, automate, script, or test a web page in a headless browser; control Starfish; perceive a live page's DOM/text and act on it (click, type, navigate, run JS); or "drive a browser via CDP" from an agent. Triggers on phrases like "open this page in Starfish", "automate the browser", "click the button / fill the form headlessly", "scrape/read the page", "test this page in a headless browser".
---

# Starfish browser control (CDP)

Drive a live, headless Starfish WebView over CDP using one shell CLI:
`bin/starfish-cdp.mjs`. Starfish runs as a persistent background process; each
command connects, does ONE action, prints a result, and disconnects. Page state
(URL, DOM, cookies, localStorage) PERSISTS between commands — there is one shared
WebView.

## Prerequisites

- A built Starfish headless binary. The default path is set in one place —
  `starfish.config.json` (`defaultBinary`) at the project root. Edit it to
  retarget, or override per-invocation with `STARFISH_BIN=/abs/path/to/Starfish`.
- Node >= 18, `npm install` already run (only `puppeteer-core`).
- Run commands from the project root. Invoke as `node bin/starfish-cdp.mjs <cmd>`
  or `npm run cdp -- <cmd>`.

## Command reference

Lifecycle (state persisted in `~/.starfish-cdp/state.json`):

- `start [--port N] [--url URL]` — launch + detach Starfish (default port 9222).
  Refuses if one is already running. Example: `node bin/starfish-cdp.mjs start`
- `stop` — kill the managed instance (port-scoped, never touches other Starfish
  processes) and clear state. Idempotent. Example: `node bin/starfish-cdp.mjs stop`
- `status` — is it alive? prints port + current page URL.
  Example: `node bin/starfish-cdp.mjs status`

Perceive (read the live page — THIS is how you "see"):

- `text [selector]` — `innerText` of `<body>`, or `textContent` of a selector.
  Example: `node bin/starfish-cdp.mjs text '#result'`
- `html [selector]` — `outerHTML` of `<html>`, or of a selector.
  Example: `node bin/starfish-cdp.mjs html '#go'`
- `eval <expression>` — run JS, print the JSON return value; non-zero exit on a
  thrown exception. Primary perception+scripting tool.
  Example: `node bin/starfish-cdp.mjs eval 'document.title'`
- `screenshot [path]` — save a PNG (default `~/.starfish-cdp/screenshot.png`).
  Example: `node bin/starfish-cdp.mjs screenshot /tmp/shot.png`

Raw CDP (any domain Starfish supports — see the full table below):

- `cdp <Domain.method> [paramsJson]` — send any CDP method with optional JSON
  params; prints the JSON result (pretty-printed). This is the escape hatch to
  every domain not covered by a high-level command above.
  Example: `node bin/starfish-cdp.mjs cdp Page.navigate '{"url":"https://example.com"}'`
  Example: `node bin/starfish-cdp.mjs cdp DOM.getDocument`
  - Many domains need an `enable` first (their events/state are off by default).
    Since each command is a fresh connection, enabling and using in **one**
    process won't carry across calls for *event* subscriptions — but request/
    response methods (getDocument, getMetrics, evaluate, getCookies, …) work
    standalone. For methods that require their domain enabled, call
    `cdp <Domain>.enable` immediately before in the same command sequence;
    state that lives in the shared WebView (cookies, storage, DOM) persists.
  - Unknown **domain** returns `{}` (success); unknown **method** in a known
    domain returns a `-32601` error (non-zero exit). That's Starfish's contract.

## Supported CDP domains and methods

Everything Starfish's CDP server implements, callable via `cdp <Domain.method>`.
(Source of truth: `starfish/src/core/cdp/domains/*Domain.cpp`.)

| Domain | Methods |
| --- | --- |
| **Runtime** | addBinding, callFunctionOn, compileScript, disable, enable, evaluate, getHeapUsage, getProperties, globalLexicalScopeNames, queryObjects, releaseObject, removeBinding, runIfWaitingForDebugger, runScript |
| **Page** | addScriptToEvaluateOnNewDocument, bringToFront, captureScreenshot, captureSnapshot, crash, createIsolatedWorld, disable, enable, generateTestReport, getAppManifest, getFrameTree, getInstallabilityErrors, getLayoutMetrics, getManifestIcons, getNavigationHistory, getResourceContent, getResourceTree, handleJavaScriptDialog, navigate, navigateToHistoryEntry, printToPDF, reload, removeScriptToEvaluateOnNewDocument, resetNavigationHistory, screencastFrameAck, setBypassCSP, setDocumentContent, setInterceptFileChooserDialog, setLifecycleEventsEnabled, startScreencast, stopScreencast |
| **DOM** | collectClassNamesFromSubtree, copyTo, describeNode, disable, discardSearchResults, enable, focus, getAttributes, getBoxModel, getContentQuads, getDocument, getFlattenedDocument, getNodeForLocation, getNodeStackTraces, getOuterHTML, getSearchResults, markUndoableState, moveTo, performSearch, pushNodesByBackendIdsToFrontend, querySelector, querySelectorAll, redo, removeAttribute, removeNode, requestChildNodes, requestNode, resolveNode, scrollIntoViewIfNeeded, setAttributeValue, setFileInputFiles, setNodeName, setNodeValue, setOuterHTML, undo |
| **DOMDebugger** | getEventListeners |
| **DOMSnapshot** | disable, enable, getSnapshot |
| **CSS** | addRule, createStyleSheet, disable, enable, getComputedStyleForNode, getInlineStylesForNode, getMatchedStylesForNode, getStyleSheetText, setPropertyText, setStyleSheetText, setStyleTexts |
| **Input** | dispatchDragEvent, dispatchKeyEvent, dispatchMouseEvent, dispatchTouchEvent, imeSetComposition, insertText, synthesizePinchGesture, synthesizeScrollGesture, synthesizeTapGesture |
| **Network** | clearBrowserCache, clearBrowserCookies, deleteCookies, disable, emulateNetworkConditions, enable, getAllCookies, getCertificate, getCookies, getRequestPostData, getResponseBody, replayXHR, searchInResponseBody, setBlockedURLs, setCacheDisabled, setCookie, setCookies, setExtraHTTPHeaders, setUserAgentOverride |
| **Fetch** | continueRequest, disable, enable, failRequest, fulfillRequest |
| **Emulation** | clearDeviceMetricsOverride, clearGeolocationOverride, setDeviceMetricsOverride, setEmulatedMedia, setGeolocationOverride, setScriptExecutionDisabled, setUserAgentOverride, setVisibleSize |
| **DOMStorage** | clear, disable, enable, getDOMStorageItems, removeDOMStorageItem, setDOMStorageItem |
| **Storage** | clearCookies, clearDataForOrigin, getCookies, getStorageKeyForFrame, setCookies, setStorageBucketTracking, trackCacheStorageForOrigin, trackIndexedDBForOrigin, untrackCacheStorageForOrigin, untrackIndexedDBForOrigin |
| **CacheStorage** | deleteCache, deleteEntry, requestCacheNames, requestCachedResponse, requestEntries (synthetic stub: reads empty, writes ack, requestCachedResponse errors `cache not found`) |
| **IndexedDB** | clearObjectStore, deleteDatabase, deleteObjectStoreEntries, disable, enable, getMetadata, requestData, requestDatabase, requestDatabaseNames (synthetic stub: reads empty, writes ack, requestDatabase echoes databaseName with `version:1` and empty objectStores) |
| **ServiceWorker** | deliverPushMessage, disable, dispatchPeriodicSyncEvent, dispatchSyncEvent, enable, inspectWorker, setForceUpdateOnPageLoad, skipWaiting, startWorker, stopAllWorkers, stopWorker, unregister, updateRegistration (ack-only stub: SW host compiled out, every method acks `{}`, no events emitted) |
| **Target** | activateTarget, attachToTarget, closeTarget, createBrowserContext, createTarget, detachFromTarget, disposeBrowserContext, getBrowserContexts, getTargetInfo, getTargets, setAutoAttach, setDiscoverTargets |
| **Accessibility** | disable, enable, getFullAXTree, getRootAXNode |
| **Animation** | disable, enable, getCurrentTime, getPlaybackRate, releaseAnimations, resolveAnimation, seekAnimations, setPaused, setPlaybackRate, setTiming |
| **Performance** | disable, enable, getMetrics, setTimeDomain |
| **Memory** | forciblyPurgeJavaScriptMemory, getAllTimeSamplingProfile, getBrowserSamplingProfile, getDOMCounters, getDOMCountersForLeakDetection, setPressureNotificationsSuppressed, simulatePressureNotification |
| **Log** | clear, disable, enable |
| **Tracing** | end, getCategories, requestMemoryDump, start |
| **Overlay** | disable, enable, getHighlightObjectForTest, setInspectMode |

> Headless caveats still apply (blank screenshots, single shared WebView, no
> isolated targets). Some methods are ack/shape-only on the headless build — see
> README "Headless limitations" and `ANALYSIS.md` for per-domain specifics.

Act (drive the page):

- `goto <url>` — navigate, then re-inject the keep-alive timer.
  Example: `node bin/starfish-cdp.mjs goto 'https://example.com'`
- `click <selector>` — click the element's center (box-model coords).
  Example: `node bin/starfish-cdp.mjs click '#go'`
- `type <selector> <text>` — focus + insert text; prints the input's value.
  Example: `node bin/starfish-cdp.mjs type '#name' Starfish`

## Canonical workflow

```
node bin/starfish-cdp.mjs start                       # boot once
node bin/starfish-cdp.mjs goto 'https://example.com'  # navigate
node bin/starfish-cdp.mjs text                         # perceive: read the page
node bin/starfish-cdp.mjs eval 'document.querySelectorAll("a").length'
node bin/starfish-cdp.mjs type '#name' Starfish        # act
node bin/starfish-cdp.mjs click '#go'
node bin/starfish-cdp.mjs eval 'document.getElementById("result").textContent'  # verify
node bin/starfish-cdp.mjs stop                         # ALWAYS stop when done
```

Loop: goto/click/type to act, then text/eval/html to perceive and verify the
effect before the next action.

## Raw `cdp` workflows

Use `cdp <Domain.method> [paramsJson]` for anything the high-level commands
don't cover. Each line is its own process+connection; WebView state (DOM,
cookies, storage, navigation) persists between them.

Inspect the DOM tree via the DOM domain instead of `eval`:

```
node bin/starfish-cdp.mjs cdp DOM.enable
node bin/starfish-cdp.mjs cdp DOM.getDocument '{"depth":2}'
node bin/starfish-cdp.mjs cdp DOM.querySelector '{"nodeId":1,"selector":"#go"}'
node bin/starfish-cdp.mjs cdp DOM.getBoxModel '{"nodeId":<id from querySelector>}'
```

Cookies + headers (Network / Storage domains):

```
node bin/starfish-cdp.mjs cdp Network.enable
node bin/starfish-cdp.mjs cdp Network.setCookie '{"name":"sid","value":"abc","domain":"example.com"}'
node bin/starfish-cdp.mjs cdp Storage.getCookies
node bin/starfish-cdp.mjs cdp Network.setExtraHTTPHeaders '{"headers":{"X-Test":"1"}}'
```

Emulate a viewport / media at runtime (Emulation domain):

```
node bin/starfish-cdp.mjs cdp Emulation.setDeviceMetricsOverride '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}'
node bin/starfish-cdp.mjs cdp Emulation.setEmulatedMedia '{"media":"print"}'
node bin/starfish-cdp.mjs eval 'matchMedia("print").matches'   # verify
node bin/starfish-cdp.mjs cdp Emulation.clearDeviceMetricsOverride
```

Computed style of a node (CSS domain), end to end:

```
node bin/starfish-cdp.mjs goto 'data:text/html,<p id=x style="color:red">hi</p>'
node bin/starfish-cdp.mjs cdp DOM.enable
node bin/starfish-cdp.mjs cdp CSS.enable
node bin/starfish-cdp.mjs cdp DOM.getDocument '{"depth":-1}'
# find the <p> nodeId in the returned tree, then:
node bin/starfish-cdp.mjs cdp CSS.getComputedStyleForNode '{"nodeId":<id>}'
```

Page metrics + accessibility tree:

```
node bin/starfish-cdp.mjs cdp Page.getLayoutMetrics
node bin/starfish-cdp.mjs cdp Performance.enable
node bin/starfish-cdp.mjs cdp Performance.getMetrics
node bin/starfish-cdp.mjs cdp Accessibility.getFullAXTree
```

Pattern: `cdp <Domain>.enable` once if the method needs it, run the method,
then perceive/verify with `eval`/`text`. Always `stop` when done.

## Limitations an agent MUST know

- **Screenshots are BLANK.** The headless build renders transparent pixels — the
  PNG is valid but shows nothing. Do NOT use screenshots for perception. Use
  `text`, `html`, and `eval` to read the page.
- **Single shared WebView.** There are no real isolated tabs; do not rely on
  multi-tab isolation. One page, one context.
- **State persists across commands** (URL, DOM, cookies, localStorage). A fresh
  command does not reset the page — it operates on the live state left by the
  previous command.
- **Keep-alive is handled for you** on `goto`/`click` navigations (the headless
  shell would otherwise exit after onload). If you navigate via raw `eval`
  (`location.href = ...`), re-inject it yourself:
  `eval 'setInterval(function(){},300)'`.
- **Always `stop` when done** so no Starfish process is left running.

## Installing this skill globally

This skill lives at `.claude/skills/starfish-control/` in the project. To make it
available in any project, copy or symlink it into `~/.claude/skills/`:

```
ln -s "$PWD/.claude/skills/starfish-control" ~/.claude/skills/starfish-control
```
