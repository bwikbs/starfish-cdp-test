// HeapProfiler (🟡) — mostly honest synthetic stub. collectGarbage runs the
// REAL Boehm GC; the snapshot/sampling surface is SYNTHETIC. Never assert
// fabricated heap contents; only the documented stub shapes:
//   enable/disable/startTrackingHeapObjects/stopTrackingHeapObjects/
//     startSampling/takeHeapSnapshot/addInspectedHeapObject -> ack {}
//   collectGarbage          -> ack {} (real Boehm GC runs)
//   stopSampling/getSamplingProfile -> {profile:{head:{callFrame:{
//     functionName:"(root)",...}, selfSize:0, id:1, children:[]}, samples:[]}}
//   getObjectByHeapObjectId/getHeapObjectId -> error -32000 "Object is not available"

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9314;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>heapprofiler</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack)", async () => {
  const res = await client.send("HeapProfiler.enable");
  assert.equal(typeof res, "object");
});

test("collectGarbage resolves (real Boehm GC runs)", async () => {
  const res = await client.send("HeapProfiler.collectGarbage");
  assert.equal(typeof res, "object");
});

test("startSampling + stopSampling returns a synthetic profile", async () => {
  // Synthetic: the head node and empty samples array are fabricated, not a
  // real allocation profile. Assert only the documented shape.
  const start = await client.send("HeapProfiler.startSampling");
  assert.equal(typeof start, "object");
  const res = await client.send("HeapProfiler.stopSampling");
  assert.ok(res.profile, "profile present");
  assert.equal(res.profile.head.callFrame.functionName, "(root)");
  assert.ok(Array.isArray(res.profile.samples), "samples is an array");
});

test("getSamplingProfile returns the synthetic profile head", async () => {
  const res = await client.send("HeapProfiler.getSamplingProfile");
  assert.ok(res.profile, "profile present");
  assert.equal(res.profile.head.callFrame.functionName, "(root)");
});

test("takeHeapSnapshot resolves (ack/shape only)", async () => {
  // Synthetic: no real snapshot is streamed; assert the ack only.
  const res = await client.send("HeapProfiler.takeHeapSnapshot");
  assert.equal(typeof res, "object");
});

test("getHeapObjectId rejects with 'Object is not available' (-32000)", async () => {
  await assert.rejects(
    () =>
      client.send("HeapProfiler.getHeapObjectId", {
        objectId: "stub-object-id",
      }),
    (err) => {
      assert.match(err.message, /not available/i);
      return true;
    }
  );
});

test("disable resolves (ack)", async () => {
  const res = await client.send("HeapProfiler.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises HeapProfiler", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "HeapProfiler"),
    "HeapProfiler is advertised"
  );
});
