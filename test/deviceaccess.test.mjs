// DeviceAccess (🟡) — honest stub. Starfish has NO CDP-reachable device-chooser
// engine (WebHID/WebUSB/Web Serial/Web Bluetooth prompt registry), so:
//   enable/disable        -> ack {}
//   selectPrompt/cancelPrompt -> error "Prompt not found" (no prompt registry)
// No deviceRequestPrompted events are emitted (no device chooser wired).
// puppeteer drops error codes, so error tests assert via message regex only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9325;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>deviceaccess</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack/shape only)", async () => {
  const res = await client.send("DeviceAccess.enable");
  assert.equal(typeof res, "object");
});

test("cancelPrompt rejects (no prompt registry)", async () => {
  await assert.rejects(
    () => client.send("DeviceAccess.cancelPrompt", { id: "p1" }),
    (err) => {
      assert.match(err.message, /Prompt not found/i);
      return true;
    }
  );
});

test("selectPrompt rejects (no prompt registry)", async () => {
  await assert.rejects(
    () =>
      client.send("DeviceAccess.selectPrompt", { id: "p1", deviceId: "d1" }),
    (err) => {
      assert.match(err.message, /Prompt not found/i);
      return true;
    }
  );
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("DeviceAccess.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises DeviceAccess", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "DeviceAccess"),
    "DeviceAccess is advertised"
  );
});
