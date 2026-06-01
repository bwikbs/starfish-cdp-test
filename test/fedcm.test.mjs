// FedCm (🟡) — honest stub. Starfish has NO FedCm (Federated Credential
// Management) engine and no account-chooser dialog registry, so:
//   enable/disable/resetCooldown -> ack {}
//   selectAccount/clickDialogButton/dismissDialog/openUrl -> error "Dialog not found"
// No dialogShown/dialogClosed events are emitted (no FedCm flow wired).
// puppeteer drops error codes, so error tests assert via message regex only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl, newSession, disconnect, pages } from "../helpers/starfish.mjs";

const PORT = 9323;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>fedcm</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await newSession(browser, page);
});

after(async () => {
  await disconnect(browser).catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack/shape only)", async () => {
  const res = await client.send("FedCm.enable", { disableRejectionDelay: true });
  assert.equal(typeof res, "object");
});

test("resetCooldown resolves (ack/shape only)", async () => {
  const res = await client.send("FedCm.resetCooldown");
  assert.equal(typeof res, "object");
});

test("selectAccount rejects (no dialog registry)", async () => {
  await assert.rejects(
    () =>
      client.send("FedCm.selectAccount", {
        dialogId: "d1",
        accountIndex: 0,
      }),
    (err) => {
      assert.match(err.message, /Dialog not found/i);
      return true;
    }
  );
});

test("disable resolves (ack/shape only)", async () => {
  const res = await client.send("FedCm.disable");
  assert.equal(typeof res, "object");
});

test("Schema.getDomains advertises FedCm", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "FedCm"),
    "FedCm is advertised"
  );
});
