// Schema (capstone) — parity check for Schema.getDomains.
//
// 49 is the routed-domain count as of this project's completion (iteration 20
// reconciliation: the server now advertises exactly 49 domains and DOMSnapshot,
// previously routed but absent from Schema, is now advertised).
//
// NOTE: 49 is a hard-coded count. If a future iteration adds or removes a routed
// domain, this test WILL fail and MUST be updated — the count is intentionally a
// loud tripwire, not a silent trap.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9330;
let sf, browser, page, client;

// The 19 domains this project added; every one must be advertised.
const ADDED_DOMAINS = [
  "CacheStorage",
  "IndexedDB",
  "ServiceWorker",
  "HeapProfiler",
  "WebAuthn",
  "WebAudio",
  "Media",
  "LayerTree",
  "Preload",
  "EventBreakpoints",
  "BackgroundService",
  "Autofill",
  "FedCm",
  "Database",
  "DeviceAccess",
  "Cast",
  "Tethering",
  "Extensions",
  "Debugger",
];

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>schema</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("Schema.getDomains returns an array of length 49", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.equal(s.domains.length, 49, "advertises exactly 49 domains");
});

test("Schema.getDomains advertises DOMSnapshot (regression guard)", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(
    s.domains.some((d) => d.name === "DOMSnapshot"),
    "DOMSnapshot is advertised"
  );
});

test("Schema.getDomains advertises every domain added this project", async () => {
  const s = await client.send("Schema.getDomains");
  const names = new Set(s.domains.map((d) => d.name));
  for (const d of ADDED_DOMAINS) {
    assert.ok(names.has(d), `${d} is advertised`);
  }
});

test("every advertised domain has a name and version string", async () => {
  const s = await client.send("Schema.getDomains");
  for (const d of s.domains) {
    assert.equal(typeof d.name, "string", "domain.name is a string");
    assert.equal(typeof d.version, "string", "domain.version is a string");
  }
});
