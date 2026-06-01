// Input domain — focus + insertText sets value; click via getBoxModel center
// coords fires onclick; dispatchKeyEvent with text appends a char.
// Contract: ANALYSIS §3 (Input), §5.12 (use getBoxModel, not getContentQuads).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9304;
// An input and a button whose handler increments window.clicked.
const BODY =
  '<input id="inp" type="text">' +
  '<button id="btn" onclick="window.clicked=(window.clicked||0)+1">Go</button>';

let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl(BODY) });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
  await client.send("DOM.enable");
  await client.send("Runtime.enable");
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

async function nodeId(selector) {
  const doc = await client.send("DOM.getDocument");
  const { nodeId } = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  return nodeId;
}

async function evalValue(expression) {
  const r = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  return r.result.value;
}

test("focus + insertText sets the input value", async () => {
  const id = await nodeId("#inp");
  await client.send("DOM.focus", { nodeId: id });
  await client.send("Input.insertText", { text: "hello" });
  assert.equal(await evalValue("document.getElementById('inp').value"), "hello");
});

test("dispatchKeyEvent with text appends a char", async () => {
  const id = await nodeId("#inp");
  await client.send("DOM.focus", { nodeId: id });
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "!", text: "!" });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "!" });
  assert.equal(await evalValue("document.getElementById('inp').value"), "hello!");
});

test("mouse click at box-model center fires onclick", async () => {
  const id = await nodeId("#btn");
  const { model } = await client.send("DOM.getBoxModel", { nodeId: id });
  const q = model.content; // [x1,y1, x2,y2, x3,y3, x4,y4]
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;

  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x, y, button: "left", clickCount: 1, buttons: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x, y, button: "left", clickCount: 1, buttons: 0,
  });
  assert.equal(await evalValue("window.clicked || 0"), 1);
});
