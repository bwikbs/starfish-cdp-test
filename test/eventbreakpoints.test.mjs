// EventBreakpoints (🟡) — ack-only stub. set/removeInstrumentationBreakpoint and
// disable just ack {}; no debugger pause is ever wired, so an instrumentation
// breakpoint never fires (no Debugger.paused). Never assert real pause behavior;
// only the documented stub shapes:
//   setInstrumentationBreakpoint {eventName}    -> ack {}
//   removeInstrumentationBreakpoint {eventName} -> ack {}
//   disable                                     -> ack {}

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9320;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>eventbreakpoints</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("setInstrumentationBreakpoint resolves (ack/shape only)", async () => {
  const res = await client.send("EventBreakpoints.setInstrumentationBreakpoint", {
    eventName: "load",
  });
  assert.equal(typeof res, "object");
});

test("removeInstrumentationBreakpoint resolves (ack/shape only)", async () => {
  const res = await client.send("EventBreakpoints.removeInstrumentationBreakpoint", {
    eventName: "load",
  });
  assert.equal(typeof res, "object");
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("EventBreakpoints.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises EventBreakpoints", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "EventBreakpoints"),
    "EventBreakpoints is advertised"
  );
});
