// Media (🟡) — ack-only stub. The headless build has no player registry, so
// enable/disable just ack and no playerPropertiesChanged / playerEventsAdded /
// playersCreated events are ever emitted. Never assert real player state; only
// the documented stub shapes:
//   enable/disable     -> ack {}

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9317;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>media</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack/shape only)", async () => {
  const res = await client.send("Media.enable");
  assert.equal(typeof res, "object");
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("Media.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises Media", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "Media"),
    "Media is advertised"
  );
});
