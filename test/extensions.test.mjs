// Extensions (🟡) — honest stub. Starfish has NO extension subsystem: no
// extension loader, no extension-id registry, and no chrome.storage backing
// store, so every method names a resource that cannot exist:
//   loadUnpacked/uninstall/getStorageItems/setStorageItems/
//   removeStorageItems/clearStorageItems -> error -32000
//   "Extensions are not supported"
// No events in this domain (nothing to load, nothing to store).
// puppeteer drops error codes, so error tests assert via message regex only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9328;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>extensions</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("loadUnpacked rejects (no extension loader)", async () => {
  await assert.rejects(
    () => client.send("Extensions.loadUnpacked", { path: "/tmp/x" }),
    (err) => {
      assert.match(err.message, /not supported/i);
      return true;
    }
  );
});

test("getStorageItems rejects (no chrome.storage backend)", async () => {
  await assert.rejects(
    () =>
      client.send("Extensions.getStorageItems", {
        id: "e1",
        storageArea: "local",
      }),
    (err) => {
      assert.match(err.message, /not supported/i);
      return true;
    }
  );
});

test("Schema.getDomains advertises Extensions", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "Extensions"),
    "Extensions is advertised"
  );
});
