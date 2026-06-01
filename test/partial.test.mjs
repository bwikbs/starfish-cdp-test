// Partial (🟡) domains — ack/shape-only. Plus the unknown-domain vs
// unknown-method-in-known-domain distinction (ANALYSIS §2):
//   unknown DOMAIN            -> empty success {}
//   unknown METHOD (known dom) -> error -32601
// Never assert real behavioral effect for these domains.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, newSession, disconnect, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9310;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>partial</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("partial domain enables ack without error", async () => {
  // These resolve (ack) — we only assert no throw, not behavior.
  await client.send("Animation.enable");
  await client.send("Overlay.enable");
  await client.send("Inspector.enable");
  await client.send("DeviceOrientation.setDeviceOrientationOverride", {
    alpha: 0, beta: 0, gamma: 0,
  });
});

test("Tracing start/end resolves (ack/shape only)", async () => {
  // Tracing is acked-empty on headless (no tracingComplete). Assert both calls
  // resolve to an object (the ack contract); do NOT swallow errors or wait for
  // trace data. If a future build rejected these, the test would fail loudly.
  const start = await client.send("Tracing.start", {});
  assert.equal(typeof start, "object");
  const end = await client.send("Tracing.end", {});
  assert.equal(typeof end, "object");
});

test("unknown DOMAIN returns empty success {}", async () => {
  const res = await client.send("Totally.unknownMethod", {});
  assert.deepEqual(res, {});
});

test("unknown METHOD in a known domain returns -32601", async () => {
  await assert.rejects(
    () => client.send("Runtime.definitelyNotAMethod", {}),
    (err) => {
      // puppeteer surfaces the JSON-RPC error message; -32601 text is
      // "'method' wasn't found".
      assert.match(err.message, /wasn't found|-32601|not found/i);
      return true;
    }
  );
});
