// LayerTree (🟡) — honest stub. Starfish has NO CDP-reachable compositor /
// render-layer tree and no layer-id or snapshot registry, so:
//   enable/disable/releaseSnapshot -> ack {}
//   compositingReasons -> {compositingReasons: [], compositingReasonIds: []}
//   makeSnapshot          -> error -32000 "No layer with given id found"
//   load/profile/replaySnapshot/snapshotCommandLog -> error "No snapshot ..."
// No layerTreeDidChange/layerPainted events are emitted (no compositor wired).
// puppeteer drops error codes, so error tests assert via message regex only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9318;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>layertree</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack/shape only)", async () => {
  const res = await client.send("LayerTree.enable");
  assert.equal(typeof res, "object");
});

test("compositingReasons returns two empty arrays (stub)", async () => {
  const res = await client.send("LayerTree.compositingReasons", {
    layerId: "stub-layer-id",
  });
  assert.ok(Array.isArray(res.compositingReasons), "compositingReasons is an array");
  assert.equal(res.compositingReasons.length, 0);
  assert.ok(Array.isArray(res.compositingReasonIds), "compositingReasonIds is an array");
  assert.equal(res.compositingReasonIds.length, 0);
});

test("makeSnapshot rejects (no layer registry)", async () => {
  await assert.rejects(
    () =>
      client.send("LayerTree.makeSnapshot", {
        layerId: "stub-layer-id",
      }),
    (err) => {
      assert.match(err.message, /No layer|given id/i);
      return true;
    }
  );
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("LayerTree.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises LayerTree", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "LayerTree"),
    "LayerTree is advertised"
  );
});
