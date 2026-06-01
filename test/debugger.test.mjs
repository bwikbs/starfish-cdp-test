// Debugger (🟡 handshake/shape stub) — the domain handshakes and returns
// well-shaped replies so DevTools/puppeteer clients don't choke, but there is
// NO real pause path: breakpoints never fire, no Debugger.paused is ever
// emitted, and resume/step/etc. just ack. setBreakpointByUrl hands back a
// breakpointId but an empty `locations` (nothing was actually bound), and
// setBreakpoint / evaluateOnCallFrame reject the way Chrome does when nothing
// is paused/resolvable.
//
// HONEST EXCEPTION: getScriptSource is REAL — it returns the exact source of a
// script persisted via Runtime.compileScript {persistScript:true}, and rejects
// for any unknown scriptId.
//
// NOTE: puppeteer-core's CDPSession.send wraps protocol errors and discards the
// numeric code but preserves the message, so error-path assertions match on the
// MESSAGE regex, not the error code (matches partial.test.mjs / webauthn.test.mjs).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9329;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>debugger</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("enable returns a debuggerId string", async () => {
  const res = await client.send("Debugger.enable");
  assert.equal(typeof res.debuggerId, "string");
  assert.ok(res.debuggerId.length > 0, "debuggerId is non-empty");
});

test("setBreakpointByUrl returns a non-empty breakpointId + empty locations", async () => {
  const res = await client.send("Debugger.setBreakpointByUrl", {
    lineNumber: 0,
    url: "http://x/y.js",
  });
  assert.equal(typeof res.breakpointId, "string");
  assert.ok(res.breakpointId.length > 0, "breakpointId is non-empty");
  assert.ok(Array.isArray(res.locations), "locations is an array");
  assert.equal(res.locations.length, 0, "locations is empty (nothing bound)");
});

test("getPossibleBreakpoints returns empty locations", async () => {
  const res = await client.send("Debugger.getPossibleBreakpoints", {
    start: { scriptId: "1", lineNumber: 0, columnNumber: 0 },
  });
  assert.ok(Array.isArray(res.locations), "locations is an array");
  assert.equal(res.locations.length, 0, "locations is empty");
});

test("setBreakpoint rejects /resolve breakpoint/i", async () => {
  await assert.rejects(
    () =>
      client.send("Debugger.setBreakpoint", {
        location: { scriptId: "1", lineNumber: 0 },
      }),
    /resolve breakpoint/i
  );
});

test("evaluateOnCallFrame rejects /while paused/i", async () => {
  await assert.rejects(
    () =>
      client.send("Debugger.evaluateOnCallFrame", {
        callFrameId: "0",
        expression: "1",
      }),
    /while paused/i
  );
});

test("getScriptSource is REAL for a Runtime.compileScript {persistScript:true}", async () => {
  const compiled = await client.send("Runtime.compileScript", {
    expression: "40+2",
    sourceURL: "u.js",
    persistScript: true,
  });
  assert.equal(typeof compiled.scriptId, "string");
  assert.ok(compiled.scriptId.length > 0, "scriptId is non-empty");

  const src = await client.send("Debugger.getScriptSource", {
    scriptId: compiled.scriptId,
  });
  assert.equal(src.scriptSource, "40+2", "exact persisted source round-trips");
});

test("getScriptSource(unknown scriptId) rejects /No script/i", async () => {
  await assert.rejects(
    () => client.send("Debugger.getScriptSource", { scriptId: "nope-1" }),
    /No script/i
  );
});

test("disable resolves (ack)", async () => {
  const res = await client.send("Debugger.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises Debugger", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "Debugger"),
    "Debugger is advertised"
  );
});
