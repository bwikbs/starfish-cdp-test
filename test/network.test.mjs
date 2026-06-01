// Network domain — real HTTP path via fixture server + synthetic data: path.
// Re-verified live on headless (ANALYSIS §0.0 re-verify note): real events fire
// for the document AND subresources; getResponseBody returns the served HTML;
// cookies round-trip; setExtraHTTPHeaders is echoed back by the fixture.
// Contract: ANALYSIS §3 (Network), §5.10/§5.11.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";
import { startFixtureServer } from "../helpers/fixtureServer.mjs";

const PORT = 9305;
let sf, browser, page, client, fx;

before(async () => {
  fx = await startFixtureServer();
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>net</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
  await client.send("Page.enable");
  await client.send("Network.enable");
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
  await fx?.close();
});

// Navigate and collect raw Network events until loadingFinished for the doc.
async function navigateAndCollect(url) {
  const reqs = [];
  const resps = [];
  const finished = [];
  const onReq = (p) => reqs.push(p);
  const onResp = (p) => resps.push(p);
  const onFin = (p) => finished.push(p);
  client.on("Network.requestWillBeSent", onReq);
  client.on("Network.responseReceived", onResp);
  client.on("Network.loadingFinished", onFin);

  const loaded = new Promise((r) => client.once("Page.loadEventFired", r));
  const nav = await client.send("Page.navigate", { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 600)); // let subresource events settle

  client.off("Network.requestWillBeSent", onReq);
  client.off("Network.responseReceived", onResp);
  client.off("Network.loadingFinished", onFin);
  return { nav, reqs, resps, finished };
}

test("real HTTP document: requestId===loaderId, type Document, status 200", async () => {
  const { nav, reqs, resps, finished } = await navigateAndCollect(fx.url);

  const docReq = reqs.find((p) => p.type === "Document");
  assert.ok(docReq, "document requestWillBeSent fired");
  assert.equal(docReq.requestId, nav.loaderId, "requestId === loaderId");
  assert.equal(docReq.request.url, fx.url);

  const docResp = resps.find((p) => p.requestId === docReq.requestId);
  assert.ok(docResp, "document responseReceived fired");
  assert.equal(docResp.response.status, 200);

  assert.ok(
    finished.some((p) => p.requestId === docReq.requestId),
    "document loadingFinished fired"
  );
});

test("getResponseBody returns the served HTML", async () => {
  const { nav, reqs } = await navigateAndCollect(fx.url);
  const docReq = reqs.find((p) => p.type === "Document") || { requestId: nav.loaderId };
  const body = await client.send("Network.getResponseBody", { requestId: docReq.requestId });
  assert.equal(body.base64Encoded, false);
  assert.match(body.body, /Agent Task Page/);
});

test("subresource events fire (best-effort)", async () => {
  const { reqs, resps } = await navigateAndCollect(fx.url);
  const subReqs = reqs.filter((p) => p.type !== "Document");
  // Re-verified: headless emits subresource events (app.js, style.css). Keep
  // best-effort so the suite stays robust if a future build drops them.
  if (subReqs.length === 0) {
    console.log("[network] no subresource events (tolerated per ANALYSIS §5.10)");
    return;
  }
  for (const r of subReqs) {
    assert.equal(typeof r.request.url, "string");
    const resp = resps.find((p) => p.requestId === r.requestId);
    if (resp) assert.equal(typeof resp.response.status, "number");
  }
});

test("cookies set/get round-trip", async () => {
  await client.send("Network.setCookie", {
    name: "agent",
    value: "online",
    url: fx.origin,
  });
  const { cookies } = await client.send("Network.getCookies", { urls: [fx.origin] });
  const c = cookies.find((x) => x.name === "agent");
  assert.ok(c, "cookie present");
  assert.equal(c.value, "online");
});

test("setExtraHTTPHeaders is echoed back by the fixture", async () => {
  await client.send("Network.setExtraHTTPHeaders", {
    headers: { "x-agent-echo": "ping" },
  });
  const { resps } = await navigateAndCollect(fx.url);
  const docResp = resps.find((p) => p.type === "Document");
  assert.ok(docResp, "document response present");
  const echoed = docResp.response.headers["x-agent-echo-back"];
  assert.equal(echoed, "ping", "fixture echoed the injected header");
});

test("data: navigation still emits raw Network events (via CDP listener)", async () => {
  // Puppeteer's high-level API hides data: requests, but raw CDP events fire
  // (ANALYSIS §3 Network data: path). Keep-alive baked into the data: URL.
  const { reqs, resps } = await navigateAndCollect(dataUrl("<h1>data-nav</h1>"));
  const docReq = reqs.find((p) => p.type === "Document");
  assert.ok(docReq, "data: document requestWillBeSent fired");
  const docResp = resps.find((p) => p.requestId === docReq.requestId);
  assert.ok(docResp, "data: responseReceived fired");
  assert.equal(docResp.response.status, 200);
});
