// CSS domain — getComputedStyleForNode (color), getInlineStylesForNode,
// getMatchedStylesForNode. Contract: ANALYSIS §3 (CSS).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9306;
const BODY =
  "<style>#title { color: red; }</style>" +
  '<h1 id="title" style="font-weight: bold;">Styled</h1>';

let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl(BODY) });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
  await client.send("DOM.enable");
  await client.send("CSS.enable");
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

async function titleNodeId() {
  const doc = await client.send("DOM.getDocument");
  const { nodeId } = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#title",
  });
  return nodeId;
}

test("getComputedStyleForNode reports the red color", async () => {
  const nodeId = await titleNodeId();
  const { computedStyle } = await client.send("CSS.getComputedStyleForNode", { nodeId });
  const color = computedStyle.find((p) => p.name === "color");
  assert.ok(color, "color computed");
  assert.match(color.value, /rgb\(\s*255,\s*0,\s*0\s*\)/);
});

test("getInlineStylesForNode reports the inline font-weight", async () => {
  const nodeId = await titleNodeId();
  const { inlineStyle } = await client.send("CSS.getInlineStylesForNode", { nodeId });
  const fw = inlineStyle.cssProperties.find((p) => p.name === "font-weight");
  assert.ok(fw, "font-weight inline prop present");
  assert.equal(fw.value, "bold");
});

test("getMatchedStylesForNode returns matched rules", async () => {
  const nodeId = await titleNodeId();
  const matched = await client.send("CSS.getMatchedStylesForNode", { nodeId });
  assert.ok(Array.isArray(matched.matchedCSSRules), "matchedCSSRules is an array");
  assert.ok(matched.inlineStyle, "inlineStyle present");
});
