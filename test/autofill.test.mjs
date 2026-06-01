// Autofill (🟡) — ack-only stub. The headless build has no autofill engine, so
// enable/disable/trigger/setAddresses just ack and no events are ever emitted.
// Never assert real autofill state; only the documented stub shapes:
//   enable/disable/trigger/setAddresses -> ack {}

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9322;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>autofill</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack/shape only)", async () => {
  const res = await client.send("Autofill.enable");
  assert.equal(typeof res, "object");
});

test("setAddresses resolves (ack/shape only)", async () => {
  const res = await client.send("Autofill.setAddresses", { addresses: [] });
  assert.equal(typeof res, "object");
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("Autofill.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises Autofill", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "Autofill"),
    "Autofill is advertised"
  );
});
