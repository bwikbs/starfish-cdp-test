// Preload (🟡) — ack-only stub. The headless build has no prerender/prefetch
// pipeline, so enable/disable just ack and no prerenderStatusUpdated /
// prefetchStatusUpdated / ruleSetUpdated events are ever emitted. Never assert
// real preload state; only the documented stub shapes:
//   enable/disable     -> ack {}

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9319;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>preload</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack/shape only)", async () => {
  const res = await client.send("Preload.enable");
  assert.equal(typeof res, "object");
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("Preload.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises Preload", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "Preload"),
    "Preload is advertised"
  );
});
