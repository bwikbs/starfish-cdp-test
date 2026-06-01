// IndexedDB (🟡) — honest synthetic stub. The headless build has no real
// IndexedDB backend, so reads return empty and writes ack. Never assert
// fabricated database contents; only the documented stub shapes:
//   requestDatabaseNames -> {databaseNames: []}
//   requestDatabase      -> {databaseWithObjectStores:{name:<echo>, version:1, objectStores:[]}}
//   requestData          -> {objectStoreDataEntries: [], hasMore: false}
//   getMetadata          -> {entriesCount: 0, keyGeneratorValue: 0}
//   deleteDatabase/deleteObjectStoreEntries/clearObjectStore/enable/disable -> ack {}

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9312;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>indexeddb</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("requestDatabaseNames returns an empty databaseNames array (stub)", async () => {
  const res = await client.send("IndexedDB.requestDatabaseNames", {
    securityOrigin: "http://localhost",
  });
  assert.ok(Array.isArray(res.databaseNames), "databaseNames is an array");
  assert.equal(res.databaseNames.length, 0);
});

test("requestDatabase echoes databaseName with empty objectStores (stub)", async () => {
  const res = await client.send("IndexedDB.requestDatabase", {
    securityOrigin: "http://localhost",
    databaseName: "stub-db",
  });
  const db = res.databaseWithObjectStores;
  assert.equal(typeof db, "object");
  assert.equal(db.name, "stub-db", "name echoes the requested databaseName");
  assert.equal(db.version, 1);
  assert.ok(Array.isArray(db.objectStores), "objectStores is an array");
  assert.equal(db.objectStores.length, 0);
});

test("requestData returns empty objectStoreDataEntries + hasMore false (stub)", async () => {
  const res = await client.send("IndexedDB.requestData", {
    securityOrigin: "http://localhost",
    databaseName: "stub-db",
    objectStoreName: "stub-store",
    indexName: "",
    skipCount: 0,
    pageSize: 25,
  });
  assert.ok(Array.isArray(res.objectStoreDataEntries), "objectStoreDataEntries is an array");
  assert.equal(res.objectStoreDataEntries.length, 0);
  assert.equal(res.hasMore, false);
});

test("getMetadata returns zeroed counts (stub)", async () => {
  const res = await client.send("IndexedDB.getMetadata", {
    securityOrigin: "http://localhost",
    databaseName: "stub-db",
    objectStoreName: "stub-store",
  });
  assert.equal(res.entriesCount, 0);
  assert.equal(res.keyGeneratorValue, 0);
});

test("enable, clearObjectStore and deleteDatabase resolve (ack/shape only)", async () => {
  // Synthetic stub: there is nothing to enable/clear/delete. Assert each acks
  // to an object; do NOT assert any real effect.
  const en = await client.send("IndexedDB.enable");
  assert.equal(typeof en, "object");
  const clear = await client.send("IndexedDB.clearObjectStore", {
    securityOrigin: "http://localhost",
    databaseName: "stub-db",
    objectStoreName: "stub-store",
  });
  assert.equal(typeof clear, "object");
  const del = await client.send("IndexedDB.deleteDatabase", {
    securityOrigin: "http://localhost",
    databaseName: "stub-db",
  });
  assert.equal(typeof del, "object");
});

test("Schema.getDomains advertises IndexedDB", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "IndexedDB"),
    "IndexedDB is advertised"
  );
});
