// Runtime domain — evaluate, exception shape, callFunctionOn, getProperties
// (own-enumerable only), addBinding -> bindingCalled, getHeapUsage.
// Contract: ANALYSIS §3 (Runtime), §4 (RemoteObject shapes), §0.0 (getHeapUsage
// is present on headless).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9301;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>runtime</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
  await client.send("Runtime.enable");
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("evaluate number / string / object returnByValue", async () => {
  const num = await client.send("Runtime.evaluate", { expression: "6*7" });
  assert.equal(num.result.type, "number");
  assert.equal(num.result.value, 42);

  const str = await client.send("Runtime.evaluate", { expression: '"hello"' });
  assert.equal(str.result.type, "string");
  assert.equal(str.result.value, "hello");

  const obj = await client.send("Runtime.evaluate", { expression: "({a:1,b:2})" });
  assert.equal(obj.result.type, "object");
  assert.ok(obj.result.objectId, "object result carries an objectId");

  const byVal = await client.send("Runtime.evaluate", {
    expression: "({a:1,b:[2,3]})",
    returnByValue: true,
  });
  assert.deepEqual(byVal.result.value, { a: 1, b: [2, 3] });
});

test("exception produces exceptionDetails (not a JSON-RPC error)", async () => {
  const res = await client.send("Runtime.evaluate", {
    expression: "throw new Error('boom')",
  });
  assert.ok(res.exceptionDetails, "exceptionDetails present");
  assert.match(res.exceptionDetails.text, /boom/);
});

test("callFunctionOn invokes a function on an object handle", async () => {
  const obj = await client.send("Runtime.evaluate", { expression: "({x:21})" });
  const res = await client.send("Runtime.callFunctionOn", {
    objectId: obj.result.objectId,
    functionDeclaration: "function () { return this.x * 2; }",
    returnByValue: true,
  });
  assert.equal(res.result.value, 42);
});

test("getProperties returns own enumerable properties only", async () => {
  const obj = await client.send("Runtime.evaluate", { expression: "({a:1,b:2,c:3})" });
  const props = await client.send("Runtime.getProperties", {
    objectId: obj.result.objectId,
  });
  const own = props.result.filter((p) => p.isOwn);
  const names = own.map((p) => p.name).sort();
  assert.deepEqual(names, ["a", "b", "c"]);
  // every returned prop is own (no prototype chain). ANALYSIS §5.8.
  for (const p of props.result) assert.equal(p.isOwn, true);
  const a = own.find((p) => p.name === "a");
  assert.equal(a.value.value, 1);
});

test("addBinding -> bindingCalled when the page calls window[name]", async () => {
  await client.send("Runtime.addBinding", { name: "agentBridge" });
  const got = new Promise((resolve) =>
    client.once("Runtime.bindingCalled", resolve)
  );
  await client.send("Runtime.evaluate", {
    expression: "window.agentBridge('payload-123')",
  });
  const evt = await got;
  assert.equal(evt.name, "agentBridge");
  assert.equal(evt.payload, "payload-123");
});

test("getHeapUsage is present on headless (ANALYSIS §0.0 flip)", async () => {
  const heap = await client.send("Runtime.getHeapUsage");
  assert.equal(typeof heap.usedSize, "number");
  assert.equal(typeof heap.totalSize, "number");
  assert.ok(heap.usedSize > 0);
});
