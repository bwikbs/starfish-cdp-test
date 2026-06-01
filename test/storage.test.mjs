// DOMStorage + Storage — must run on an HTTP origin (data:/about: are opaque).
// DOMStorage.getDOMStorageItems after localStorage.setItem;
// Storage.getStorageKeyForFrame. Contract: ANALYSIS §3 (DOMStorage/Storage).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";
import { startFixtureServer } from "../helpers/fixtureServer.mjs";

const PORT = 9307;
let sf, browser, page, client, fx;

before(async () => {
  fx = await startFixtureServer();
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>storage</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("DOMStorage.enable");

  // Navigate to the HTTP origin so storage is non-opaque.
  const loaded = new Promise((r) => client.once("Page.loadEventFired", r));
  await client.send("Page.navigate", { url: fx.url });
  await loaded;
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
  await fx?.close();
});

test("getDOMStorageItems returns a localStorage item set from the page", async () => {
  await client.send("Runtime.evaluate", {
    expression: "localStorage.setItem('k', 'v')",
  });
  const { entries } = await client.send("DOMStorage.getDOMStorageItems", {
    storageId: { securityOrigin: fx.origin, isLocalStorage: true },
  });
  const pair = entries.find((e) => e[0] === "k");
  assert.ok(pair, "key 'k' present in localStorage");
  assert.equal(pair[1], "v");
});

test("Storage.getStorageKeyForFrame returns the HTTP origin key", async () => {
  const { frameTree } = await client.send("Page.getFrameTree");
  const frameId = frameTree.frame.id;
  const { storageKey } = await client.send("Storage.getStorageKeyForFrame", { frameId });
  assert.equal(typeof storageKey, "string");
  assert.match(storageKey, new RegExp(`127\\.0\\.0\\.1:${fx.port}`));
});
