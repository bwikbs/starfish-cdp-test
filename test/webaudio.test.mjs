// WebAudio (🟡) — ack-only stub. No audio engine is wired into the headless
// build (no real BaseAudioContext / Web Audio graph), so enable/disable just
// ack and getRealtimeData has no context to look up. Never assert real audio
// state; only the documented stub shapes:
//   enable/disable     -> ack {}
//   getRealtimeData    -> error "Cannot find BaseAudioContext with such id"
// puppeteer-core drops the numeric JSON-RPC code, so assert error paths via the
// MESSAGE regex (like test/partial.test.mjs).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9316;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>webaudio</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack/shape only)", async () => {
  const res = await client.send("WebAudio.enable");
  assert.equal(typeof res, "object");
});

test("getRealtimeData rejects 'Cannot find BaseAudioContext' (stub)", async () => {
  // No audio engine wired: there is no BaseAudioContext to resolve. The numeric
  // error code is dropped by puppeteer-core, so match on the message.
  await assert.rejects(
    () =>
      client.send("WebAudio.getRealtimeData", {
        contextId: "stub-context-id",
      }),
    (err) => {
      assert.match(err.message, /Cannot find|BaseAudioContext/i);
      return true;
    }
  );
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("WebAudio.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises WebAudio", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "WebAudio"),
    "WebAudio is advertised"
  );
});
