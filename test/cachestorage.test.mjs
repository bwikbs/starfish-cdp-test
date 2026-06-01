// CacheStorage (🟡) — honest synthetic stub. The headless build has no real
// Cache Storage backend, so reads return empty and writes ack. Never assert
// fabricated cache contents; only the documented stub shapes:
//   requestCacheNames     -> {caches: []}
//   requestEntries        -> {cacheDataEntries: [], returnCount: 0}
//   deleteCache/deleteEntry-> ack {}
//   requestCachedResponse -> error -32000 "cache not found"

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9311;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>cachestorage</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("requestCacheNames returns an empty caches array (stub)", async () => {
  const res = await client.send("CacheStorage.requestCacheNames", {
    securityOrigin: "http://localhost",
  });
  assert.ok(Array.isArray(res.caches), "caches is an array");
  assert.equal(res.caches.length, 0);
});

test("requestEntries returns empty cacheDataEntries + returnCount 0 (stub)", async () => {
  const res = await client.send("CacheStorage.requestEntries", {
    cacheId: "stub-cache-id",
  });
  assert.ok(Array.isArray(res.cacheDataEntries), "cacheDataEntries is an array");
  assert.equal(res.returnCount, 0);
});

test("deleteCache and deleteEntry resolve (ack/shape only)", async () => {
  // Synthetic stub: there is nothing to delete. Assert both ack to an object;
  // do NOT assert any real deletion effect.
  const delCache = await client.send("CacheStorage.deleteCache", {
    cacheId: "stub-cache-id",
  });
  assert.equal(typeof delCache, "object");
  const delEntry = await client.send("CacheStorage.deleteEntry", {
    cacheId: "stub-cache-id",
    request: "http://localhost/x",
  });
  assert.equal(typeof delEntry, "object");
});

test("requestCachedResponse rejects with 'cache not found' (-32000)", async () => {
  await assert.rejects(
    () =>
      client.send("CacheStorage.requestCachedResponse", {
        cacheId: "stub-cache-id",
        requestURL: "http://localhost/x",
        requestHeaders: [],
      }),
    (err) => {
      assert.match(err.message, /cache not found/i);
      return true;
    }
  );
});

test("Schema.getDomains advertises CacheStorage", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "CacheStorage"),
    "CacheStorage is advertised"
  );
});
