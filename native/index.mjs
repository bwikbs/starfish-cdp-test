// Entry point for the native CDP client. Delegates to the C++ binary via
// bridge.mjs. Exposes the functional wrappers the helper shim imports
// (connect / pages / newSession / disconnect).

export { NativeBrowser, NativeSession } from "./bridge.mjs";

import { NativeBrowser } from "./bridge.mjs";

export const nativeConnect = (wsEndpoint) => NativeBrowser.connect(wsEndpoint);
export const nativePages = (browser) => browser.pages();
export const nativeNewSession = (browser, page) => browser.newSession(page);
export const nativeDisconnect = (browser) => browser?.close();
