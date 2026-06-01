// Agent-control demo: an agent perceives and acts on a page via CDP, then
// verifies the effect in a closed loop. Standalone script (not a test). Exits 0
// on success, non-zero (throws) on any verification failure.
//
// Run: npm run demo
//
// Honors ANALYSIS gotchas: keep-alive on every page, screenshots are blank-but-
// valid PNGs (assert structure only), multi-tab is a single shared WebView
// (assert lifecycle, not isolation).

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  launchStarfish,
  connect,
  initialPage,
  dataUrl,
} from "../helpers/starfish.mjs";
import { startFixtureServer } from "../helpers/fixtureServer.mjs";

const PORT = 9350;
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");

const step = (msg) => console.log(`\n[agent] === ${msg} ===`);
const log = (msg) => console.log(`[agent]   ${msg}`);

async function main() {
  // 1. BOOT & CONNECT
  step("1. boot Starfish + fixture server, connect");
  const fx = await startFixtureServer();
  const sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>booting</h1>") });
  const browser = await connect(sf.wsEndpoint);
  const page = await initialPage(browser);
  const client = await page.createCDPSession();
  log(`connected to ${sf.wsEndpoint}`);
  log(`task page: ${fx.url}`);

  // 2. INSTRUMENT PERCEPTION
  step("2. instrument perception channels (Runtime/Log/Network/Page)");
  await client.send("Runtime.enable");
  await client.send("Log.enable");
  await client.send("Network.enable");
  await client.send("Page.enable");

  const consoleMsgs = [];
  const requests = [];
  client.on("Runtime.consoleAPICalled", (e) =>
    consoleMsgs.push({ type: e.type, args: e.args.map((a) => a.value ?? a.description) })
  );
  client.on("Network.requestWillBeSent", (e) =>
    requests.push({ id: e.requestId, type: e.type, url: e.request.url })
  );
  log("subscribed to console + network");

  // 3. NAVIGATE
  step("3. navigate to the task page");
  const loaded = new Promise((r) => client.once("Page.loadEventFired", r));
  await client.send("Page.navigate", { url: fx.url });
  await loaded;
  await new Promise((r) => setTimeout(r, 400)); // let subresources settle
  log("page loaded");

  // 4. PERCEIVE (read the DOM)
  step("4. perceive: read the DOM (input + button)");
  const doc = await client.send("DOM.getDocument");
  await client.send("DOM.enable");
  const input = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#name",
  });
  const button = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#go",
  });
  assert.ok(input.nodeId > 0 && button.nodeId > 0, "found input and button");
  const placeholder = await client.send("Runtime.evaluate", {
    expression: "document.getElementById('name').placeholder",
    returnByValue: true,
  });
  log(`input placeholder: "${placeholder.result.value}"`);

  // read a computed style to demonstrate "reading the screen"
  await client.send("CSS.enable");
  const title = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#title",
  });
  const cs = await client.send("CSS.getComputedStyleForNode", { nodeId: title.nodeId });
  const color = cs.computedStyle.find((p) => p.name === "color");
  log(`title color: ${color ? color.value : "?"}`);

  // 5. ACT (focus, type, click)
  step("5. act: focus + insertText, then click submit via box-model coords");
  await client.send("DOM.focus", { nodeId: input.nodeId });
  await client.send("Input.insertText", { text: "Starfish" });

  const { model } = await client.send("DOM.getBoxModel", { nodeId: button.nodeId });
  const q = model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0,
  });
  log("typed 'Starfish' and clicked submit");

  // 6. VERIFY (closed loop)
  step("6. verify: result element reflects the typed value");
  const result = await client.send("Runtime.evaluate", {
    expression: "document.getElementById('result').textContent",
    returnByValue: true,
  });
  log(`#result now reads: "${result.result.value}"`);
  assert.equal(result.result.value, "Hello, Starfish", "closed-loop verification");

  // inspect a structured object via getProperties (agent reads structured data)
  const handle = await client.send("Runtime.evaluate", {
    expression: "({ name: window.submitted, ok: true })",
  });
  const props = await client.send("Runtime.getProperties", {
    objectId: handle.result.objectId,
  });
  const propNames = props.result.filter((p) => p.isOwn).map((p) => p.name);
  log(`inspected result object props: ${propNames.join(", ")}`);

  // 7. OBSERVE side effects
  step("7. observe captured network + console");
  log(`captured ${requests.length} network request(s):`);
  for (const r of requests) log(`  - [${r.type}] ${r.url}`);
  await client.send("Runtime.evaluate", { expression: "console.log('agent done')" });
  await new Promise((r) => setTimeout(r, 150));
  log(`captured ${consoleMsgs.length} console message(s)`);
  for (const m of consoleMsgs) log(`  - ${m.type}: ${m.args.join(" ")}`);

  // 8. SCREENSHOT (blank-but-valid PNG on headless)
  step("8. capture screenshot (valid PNG, blank pixels on headless)");
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(shot.data, "base64");
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "valid PNG");
  mkdirSync(outDir, { recursive: true });
  const shotPath = join(outDir, "screenshot.png");
  writeFileSync(shotPath, buf);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  log(`saved ${w}x${h} PNG to ${shotPath} (NOTE: headless renders blank pixels)`);

  // 9. MULTI-TAB (single shared WebView on headless — lifecycle only)
  step("9. multi-tab: open a 2nd target, then close it");
  const before = (await browser.pages()).length;
  const created = await client.send("Target.createTarget", {
    url: dataUrl("<h1>second context</h1>"),
  });
  let pages = await browser.pages();
  const deadline = Date.now() + 4000;
  while (pages.length < before + 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    pages = await browser.pages();
  }
  log(`pages: ${before} -> ${pages.length} (process alive: ${!sf.proc.killed})`);
  log("note: this engine is a single shared WebView; tabs are not isolated contexts");
  await client.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  log(`pages after close: ${(await browser.pages()).length}`);

  // 10. TEARDOWN
  step("10. teardown");
  await browser.disconnect().catch(() => {});
  await sf.stop();
  await fx.close();
  log("clean shutdown, no orphan Starfish");

  console.log(
    "\n[agent] SUCCESS — exercised Page, Runtime, DOM, CSS, Input, Network, " +
      "Log, Target; closed-loop verification passed."
  );
}

main().catch(async (err) => {
  console.error("\n[agent] FAILURE:", err.message);
  // best-effort cleanup so a failed demo never leaks a process
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("pkill", ["-x", "Starfish"], { stdio: "ignore" });
  } catch {}
  process.exit(1);
});
