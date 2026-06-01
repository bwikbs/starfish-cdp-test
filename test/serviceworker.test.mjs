// ServiceWorker (🟡) — honest ack-only stub. The headless/CDP build has the
// ServiceWorker host compiled out (SERVICE_WORKER=0), so no registration or
// version state is reachable from the CDP main frame and NO events
// (workerRegistrationUpdated/workerVersionUpdated/workerErrorReported) are
// emitted. Every command acks to an empty object; never assert any real
// SW effect, only the ack contract:
//   enable/disable                       -> ack {}
//   unregister {scopeURL}                -> ack {}
//   updateRegistration                   -> ack {}
//   startWorker {scopeURL}/stopWorker    -> ack {}
//   stopAllWorkers/skipWaiting           -> ack {}
//   setForceUpdateOnPageLoad {flag}      -> ack {}
//   inspectWorker {versionId}            -> ack {}
//   deliverPushMessage/dispatch*Event    -> ack {}

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9313;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>serviceworker</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("enable and disable resolve (ack/shape only)", async () => {
  // Ack-only stub: SW host compiled out. Assert each acks to an object;
  // do NOT assert any real enable/disable effect or expect events.
  const en = await client.send("ServiceWorker.enable");
  assert.equal(typeof en, "object");
  const dis = await client.send("ServiceWorker.disable");
  assert.equal(typeof dis, "object");
});

test("unregister resolves (ack/shape only)", async () => {
  // Nothing is registered (no SW registry reachable). Assert ack only.
  const res = await client.send("ServiceWorker.unregister", {
    scopeURL: "http://localhost/",
  });
  assert.equal(typeof res, "object");
});

test("startWorker resolves (ack/shape only)", async () => {
  // No worker host to start. Assert ack only; do NOT assert a worker started.
  const res = await client.send("ServiceWorker.startWorker", {
    scopeURL: "http://localhost/",
  });
  assert.equal(typeof res, "object");
});

test("stopAllWorkers resolves (ack/shape only)", async () => {
  // No workers to stop. Assert ack only.
  const res = await client.send("ServiceWorker.stopAllWorkers");
  assert.equal(typeof res, "object");
});

test("setForceUpdateOnPageLoad resolves (ack/shape only)", async () => {
  // No registry to flag. Assert ack only; do NOT assert the flag took effect.
  const res = await client.send("ServiceWorker.setForceUpdateOnPageLoad", {
    forceUpdateOnPageLoad: true,
  });
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises ServiceWorker", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "ServiceWorker"),
    "ServiceWorker is advertised"
  );
});
