// Cast (🟡) — honest stub. Starfish has NO CDP-wired DIAL/Cast presentation
// backend (the DIAL CastServer is not CDP-reachable), so:
//   enable/disable -> ack {}
//   setSinkToUse/startDesktopMirroring/startTabMirroring/stopCasting
//                  -> error "Sink not found"
// No sinksUpdated/issueUpdated events are emitted (no Cast backend wired).
// puppeteer drops error codes, so error tests assert via message regex only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9326;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>cast</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack/shape only)", async () => {
  const res = await client.send("Cast.enable");
  assert.equal(typeof res, "object");
});

test("setSinkToUse rejects (no Cast backend)", async () => {
  await assert.rejects(
    () => client.send("Cast.setSinkToUse", { sinkName: "tv" }),
    (err) => {
      assert.match(err.message, /Sink not found/i);
      return true;
    }
  );
});

test("startTabMirroring rejects (no Cast backend)", async () => {
  await assert.rejects(
    () => client.send("Cast.startTabMirroring", { sinkName: "tv" }),
    (err) => {
      assert.match(err.message, /Sink not found/i);
      return true;
    }
  );
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("Cast.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises Cast", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "Cast"),
    "Cast is advertised"
  );
});
