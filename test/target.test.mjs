// Target domain — multi-tab. On headless, Target.createTarget WORKS (ANALYSIS
// §0.0 flip vs the cdp_test crash, re-verified live): a 2nd target spawns,
// pages(browser) becomes 2, the process stays alive, getTargets shows 2, and
// closeTarget brings it back to 1 with the original session still responsive.
//
// NOTE on isolation: the ANALYSIS §0.0 flip table mentions "window.X isolation",
// but re-verifying on this build showed the engine is a single shared WebView
// (ANALYSIS §0.3). A CDP session opened on the 2nd page routes to the INITIAL
// context (reports the first tab's DOM) AND deadlocks the original session.
// So we assert the reliable lifecycle subset and drive everything through the
// ORIGINAL session only — we do NOT open a 2nd CDP session or assert window.X
// isolation (it does not hold here).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9309;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>tab1</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("getTargets lists at least the initial page", async () => {
  const { targetInfos } = await client.send("Target.getTargets");
  assert.ok(Array.isArray(targetInfos) && targetInfos.length >= 1);
  assert.ok(targetInfos.some((t) => t.type === "page"));
});

test("createTarget spawns a 2nd target, process survives, closeTarget restores", async () => {
  const before = (await pages(browser)).length;

  let secondTargetId;
  try {
    const created = await client.send("Target.createTarget", {
      url: dataUrl("<h1>tab2</h1>"),
    });
    secondTargetId = created.targetId;
    assert.ok(secondTargetId, "createTarget returned a targetId");

    // Wait for the 2nd page to be discovered.
    const deadline = Date.now() + 5000;
    let pgs = await pages(browser);
    while (pgs.length < before + 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      pgs = await pages(browser);
    }
    assert.equal(pgs.length, before + 1, "a second page appeared");
    assert.equal(sf.proc.killed, false, "process survived createTarget (§0.0 flip)");

    const { targetInfos } = await client.send("Target.getTargets");
    assert.equal(targetInfos.length, before + 1, "getTargets reports both targets");
  } finally {
    if (secondTargetId) {
      const closed = await client
        .send("Target.closeTarget", { targetId: secondTargetId })
        .catch(() => ({}));
      void closed;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const afterPages = await pages(browser);
  assert.equal(afterPages.length, before, "closeTarget restored the tab count");

  // Original session must still be responsive after the multi-tab dance.
  await client.send("Runtime.enable");
  const e = await client.send("Runtime.evaluate", {
    expression: "1+1",
    returnByValue: true,
  });
  assert.equal(e.result.value, 2);
});
