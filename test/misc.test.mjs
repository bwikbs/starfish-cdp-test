// Misc real domains — Browser.getVersion, Performance.getMetrics,
// Accessibility.getFullAXTree, Memory.getDOMCounters, Schema.getDomains,
// Log.entryAdded + Runtime.consoleAPICalled with the console level remap.
// Contract: ANALYSIS §3 (Browser/Performance/Accessibility/Log), §0.0 (Memory/
// Schema present on headless), §5.13 (console.log -> Log level "info",
// consoleAPICalled type "log").

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9308;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>misc</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("Browser.getVersion: product Starfish/1.0, protocol 1.3", async () => {
  const v = await client.send("Browser.getVersion");
  assert.match(v.product, /Starfish/);
  assert.equal(v.protocolVersion, "1.3");
});

test("Performance.getMetrics includes Nodes and Documents", async () => {
  await client.send("Performance.enable");
  const { metrics } = await client.send("Performance.getMetrics");
  const names = metrics.map((m) => m.name);
  assert.ok(names.includes("Nodes"), `metrics: ${names}`);
  assert.ok(names.includes("Documents"), `metrics: ${names}`);
});

test("Accessibility.getFullAXTree has a RootWebArea", async () => {
  await client.send("Accessibility.enable");
  const { nodes } = await client.send("Accessibility.getFullAXTree");
  assert.ok(Array.isArray(nodes) && nodes.length > 0);
  const root = nodes.find((n) => n.role && n.role.value === "RootWebArea");
  assert.ok(root, "RootWebArea node present");
});

test("Memory.getDOMCounters returns numeric counts (ANALYSIS §0.0 flip)", async () => {
  const c = await client.send("Memory.getDOMCounters");
  assert.equal(typeof c.documents, "number");
  assert.equal(typeof c.nodes, "number");
  assert.equal(typeof c.jsEventListeners, "number");
});

test("Schema.getDomains returns a domains array (ANALYSIS §0.0 flip)", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(s.domains.length > 0);
});

test("console.log bridges to Log.entryAdded(info) and consoleAPICalled(log)", async () => {
  await client.send("Runtime.enable");
  await client.send("Log.enable");

  const logEntry = new Promise((resolve) => client.once("Log.entryAdded", resolve));
  const consoleApi = new Promise((resolve) =>
    client.once("Runtime.consoleAPICalled", resolve)
  );
  await client.send("Runtime.evaluate", { expression: "console.log('hi-agent')" });

  const entry = (await logEntry).entry;
  // console.log remaps to Log level "info" (ANALYSIS §5.13).
  assert.equal(entry.level, "info");
  assert.match(entry.text, /hi-agent/);

  const api = await consoleApi;
  // consoleAPICalled type stays "log".
  assert.equal(api.type, "log");
});
