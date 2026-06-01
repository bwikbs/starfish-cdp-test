// Tethering (🟡) — ack-only stub. No reverse tunnel: bind/unbind just ack and no
// `accepted` event is ever emitted, so a bound port never forwards a connection.
// Never assert real tethering; only the documented stub shapes:
//   bind {port} / unbind {port}  -> ack {}

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9327;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>tethering</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("bind resolves (ack/shape only)", async () => {
  const res = await client.send("Tethering.bind", { port: 9999 });
  assert.equal(typeof res, "object");
});

test("unbind resolves (ack/shape only)", async () => {
  const res = await client.send("Tethering.unbind", { port: 9999 });
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises Tethering", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "Tethering"),
    "Tethering is advertised"
  );
});
