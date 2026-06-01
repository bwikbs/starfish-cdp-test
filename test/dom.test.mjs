// DOM domain — getDocument, querySelector/All, getOuterHTML, getAttributes,
// setAttributeValue -> attributeModified event, getBoxModel, resolveNode.
// Contract: ANALYSIS §3 (DOM).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9302;
const BODY =
  '<h1 id="title">Title</h1><p class="para">one</p><p class="para">two</p>' +
  '<button id="btn">Go</button>';

let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl(BODY) });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
  await client.send("DOM.enable");
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

async function rootNodeId() {
  const doc = await client.send("DOM.getDocument");
  return doc.root.nodeId;
}

test("getDocument returns the #document root", async () => {
  const doc = await client.send("DOM.getDocument");
  assert.equal(doc.root.nodeName, "#document");
  assert.equal(typeof doc.root.nodeId, "number");
});

test("querySelector / querySelectorAll find expected nodes", async () => {
  const root = await rootNodeId();
  const one = await client.send("DOM.querySelector", { nodeId: root, selector: "#title" });
  assert.ok(one.nodeId > 0);

  const all = await client.send("DOM.querySelectorAll", { nodeId: root, selector: "p.para" });
  assert.equal(all.nodeIds.length, 2);
});

test("getOuterHTML returns element markup", async () => {
  const root = await rootNodeId();
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root, selector: "#title" });
  const { outerHTML } = await client.send("DOM.getOuterHTML", { nodeId });
  assert.match(outerHTML, /<h1[^>]*id="title"[^>]*>Title<\/h1>/);
});

test("getAttributes returns flat name/value pairs", async () => {
  const root = await rootNodeId();
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root, selector: "#title" });
  const { attributes } = await client.send("DOM.getAttributes", { nodeId });
  const i = attributes.indexOf("id");
  assert.ok(i >= 0 && i % 2 === 0, "id is a name slot");
  assert.equal(attributes[i + 1], "title");
});

test("setAttributeValue emits attributeModified", async () => {
  const root = await rootNodeId();
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root, selector: "#btn" });
  const got = new Promise((resolve) => client.once("DOM.attributeModified", resolve));
  await client.send("DOM.setAttributeValue", { nodeId, name: "data-x", value: "42" });
  const evt = await got;
  assert.equal(evt.nodeId, nodeId);
  assert.equal(evt.name, "data-x");
  assert.equal(evt.value, "42");
});

test("getBoxModel yields numeric quads", async () => {
  const root = await rootNodeId();
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root, selector: "#btn" });
  const { model } = await client.send("DOM.getBoxModel", { nodeId });
  assert.equal(model.content.length, 8);
  for (const n of model.content) assert.equal(typeof n, "number");
  assert.ok(model.width >= 0 && model.height >= 0);
});

test("resolveNode round-trips a node to a Runtime handle", async () => {
  const root = await rootNodeId();
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root, selector: "#title" });
  const { object } = await client.send("DOM.resolveNode", { nodeId });
  assert.equal(object.type, "object");
  assert.equal(object.subtype, "node");
  assert.ok(object.objectId);

  // Use the handle to read textContent back via Runtime.
  await client.send("Runtime.enable");
  const res = await client.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function () { return this.textContent; }",
    returnByValue: true,
  });
  assert.equal(res.result.value, "Title");
});
