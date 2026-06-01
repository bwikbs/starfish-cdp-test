// Database (🟡) — honest stub. Starfish has NO WebSQL engine (the Database
// domain is the deprecated legacy WebSQL API), so there is no database
// registry to back database ids:
//   enable/disable           -> ack {}
//   getDatabaseTableNames    -> error "Database not found"
//   executeSQL               -> error "Database not found"
// No addDatabase events are emitted (no WebSQL host wired).
// puppeteer drops error codes, so error tests assert via message regex only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9324;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>database</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack/shape only)", async () => {
  const res = await client.send("Database.enable");
  assert.equal(typeof res, "object");
});

test("getDatabaseTableNames rejects (no database registry)", async () => {
  await assert.rejects(
    () =>
      client.send("Database.getDatabaseTableNames", {
        databaseId: "d1",
      }),
    (err) => {
      assert.match(err.message, /Database not found/i);
      return true;
    }
  );
});

test("executeSQL rejects (no database registry)", async () => {
  await assert.rejects(
    () =>
      client.send("Database.executeSQL", {
        databaseId: "d1",
        query: "SELECT 1",
      }),
    (err) => {
      assert.match(err.message, /Database not found/i);
      return true;
    }
  );
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("Database.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises Database", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "Database"),
    "Database is advertised"
  );
});
