// BackgroundService (🟡) — ack-only stub. The SW host is compiled out of the
// headless build, so startObserving/stopObserving/setRecording/clearEvents just
// ack {} and no recordingStateChanged / backgroundServiceEventReceived events are
// ever emitted. Never assert real background-service state; only the documented
// stub shapes:
//   startObserving {service}              -> ack {}
//   stopObserving {service}               -> ack {}
//   setRecording {shouldRecord,service}   -> ack {}
//   clearEvents {service}                 -> ack {}

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9321;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>backgroundservice</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("startObserving resolves (ack/shape only)", async () => {
  const res = await client.send("BackgroundService.startObserving", {
    service: "backgroundFetch",
  });
  assert.equal(typeof res, "object");
});

test("setRecording resolves (ack/shape only)", async () => {
  const res = await client.send("BackgroundService.setRecording", {
    shouldRecord: true,
    service: "backgroundFetch",
  });
  assert.equal(typeof res, "object");
});

test("clearEvents resolves (ack/shape only)", async () => {
  const res = await client.send("BackgroundService.clearEvents", {
    service: "backgroundFetch",
  });
  assert.equal(typeof res, "object");
});

test("stopObserving resolves (ack/shape only)", async () => {
  const res = await client.send("BackgroundService.stopObserving", {
    service: "backgroundFetch",
  });
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises BackgroundService", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "BackgroundService"),
    "BackgroundService is advertised"
  );
});
