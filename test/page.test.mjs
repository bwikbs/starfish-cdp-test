// Page domain — navigate + loadEventFired, setLifecycleEventsEnabled + lifecycle
// names, getNavigationHistory + navigateToHistoryEntry (back), getFrameTree,
// captureScreenshot (PNG sig + IHDR dims; NOT pixel content — headless is blank),
// printToPDF (%PDF- header). Contract: ANALYSIS §3 (Page), §0.0 (screenshot blank),
// §5 (lifecycle needs enabling; keep-alive on every navigated page).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9303;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>A</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
  await client.send("Page.enable");
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("getFrameTree exposes a frame with an id", async () => {
  const { frameTree } = await client.send("Page.getFrameTree");
  assert.ok(frameTree.frame.id, "frame.id present");
  assert.equal(typeof frameTree.frame.url, "string");
});

test("navigate returns {frameId, loaderId} and fires loadEventFired", async () => {
  const loaded = new Promise((resolve) => client.once("Page.loadEventFired", resolve));
  const res = await client.send("Page.navigate", { url: dataUrl("<h1>B</h1>") });
  assert.ok(res.frameId);
  assert.ok(res.loaderId, "loaderId non-empty");
  await loaded;
});

test("setLifecycleEventsEnabled then lifecycleEvent names appear", async () => {
  await client.send("Page.setLifecycleEventsEnabled", { enabled: true });
  const names = new Set();
  const onLifecycle = (p) => names.add(p.name);
  client.on("Page.lifecycleEvent", onLifecycle);
  const loaded = new Promise((resolve) => client.once("Page.loadEventFired", resolve));
  await client.send("Page.navigate", { url: dataUrl("<h1>C</h1>") });
  await loaded;
  await new Promise((r) => setTimeout(r, 300)); // let trailing lifecycle events arrive
  client.off("Page.lifecycleEvent", onLifecycle);
  // ANALYSIS §3: names include init / DOMContentLoaded / load.
  assert.ok(names.has("load"), `expected 'load' lifecycle, got ${[...names]}`);
  assert.ok(names.has("init") || names.has("DOMContentLoaded"), `got ${[...names]}`);
});

test("getNavigationHistory tracks navs; navigateToHistoryEntry goes back", async () => {
  // We've navigated A(boot)->B->C above; add one more deterministic nav.
  const l1 = new Promise((r) => client.once("Page.loadEventFired", r));
  await client.send("Page.navigate", { url: dataUrl("<h1>D</h1>") });
  await l1;

  const hist = await client.send("Page.getNavigationHistory");
  assert.ok(hist.entries.length >= 2);
  assert.equal(typeof hist.currentIndex, "number");
  assert.ok(hist.currentIndex >= 1);

  const prev = hist.entries[hist.currentIndex - 1];
  const l2 = new Promise((r) => client.once("Page.loadEventFired", r));
  await client.send("Page.navigateToHistoryEntry", { entryId: prev.id });
  await l2;
  await new Promise((r) => setTimeout(r, 200));

  const after = await client.send("Page.getNavigationHistory");
  assert.ok(after.currentIndex < hist.currentIndex, "currentIndex moved back");
});

test("captureScreenshot returns a valid PNG with viewport IHDR dims", async () => {
  const { data } = await client.send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(data, "base64");
  // PNG signature.
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  // IHDR width/height (big-endian at bytes 16..24). Headless renders blank but
  // structurally valid; assert dims are positive only (ANALYSIS §0.0 / §5.3).
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.ok(w > 0 && h > 0, `IHDR dims ${w}x${h}`);
});

test("printToPDF returns a %PDF- document", async () => {
  const { data } = await client.send("Page.printToPDF", {});
  const buf = Buffer.from(data, "base64");
  assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(buf.length > 0);
});
