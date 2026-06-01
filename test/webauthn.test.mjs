// WebAuthn (🟢 state / 🔴 engine) — REAL in-memory virtual-authenticator
// registry. add/get/remove/clearCredential(s) genuinely mutate and read back a
// per-authenticator store; unknown ids error -32000 (Chrome's exact messages,
// "Could not find a Virtual Authenticator matching the ID" / "Could not find a
// credential matching the ID"). HONEST LIMIT: the engine has no
// navigator.credentials / PublicKeyCredential, so this registry is fully
// inspectable/manipulable over CDP but is NOT wired to navigator.credentials —
// nothing consults these authenticators and no credentialAdded/credentialAsserted
// event is ever emitted. Credentials are echoed back as the exact object added.
//
// NOTE: puppeteer-core's CDPSession.send wraps protocol errors and discards the
// numeric code but preserves the message, so error-path assertions match on the
// MESSAGE regex (/Could not find/), not the -32000 code (matches partial.test.mjs).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchStarfish, connect, initialPage, dataUrl } from "../helpers/starfish.mjs";

const PORT = 9315;
let sf, browser, page, client;

before(async () => {
  sf = await launchStarfish({ port: PORT, url: dataUrl("<h1>webauthn</h1>") });
  browser = await connect(sf.wsEndpoint);
  page = await initialPage(browser);
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.disconnect().catch(() => {});
  await sf?.stop();
});

test("enable resolves (ack)", async () => {
  const res = await client.send("WebAuthn.enable");
  assert.equal(typeof res, "object");
});

test("addVirtualAuthenticator returns a non-empty authenticatorId", async () => {
  const res = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
    },
  });
  assert.equal(typeof res.authenticatorId, "string");
  assert.ok(res.authenticatorId.length > 0, "authenticatorId is non-empty");
});

test("addCredential then getCredentials echoes the SAME credentialId (real state)", async () => {
  const { authenticatorId } = await client.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: false,
        hasUserVerification: false,
      },
    }
  );

  const credentialId = "Y3JlZC0x"; // base64 of "cred-1"
  await client.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId,
      rpId: "example.com",
      privateKey: "MEcCAQ", // opaque, echoed verbatim
      signCount: 0,
      isResidentCredential: false,
    },
  });

  const list = await client.send("WebAuthn.getCredentials", { authenticatorId });
  assert.ok(Array.isArray(list.credentials), "credentials is an array");
  assert.equal(list.credentials.length, 1, "exactly one stored credential");
  assert.equal(
    list.credentials[0].credentialId,
    credentialId,
    "the SAME credentialId is echoed back"
  );

  // getCredential(known) returns it; getCredential(missing) rejects.
  const one = await client.send("WebAuthn.getCredential", {
    authenticatorId,
    credentialId,
  });
  assert.equal(one.credential.credentialId, credentialId);

  await assert.rejects(
    () =>
      client.send("WebAuthn.getCredential", {
        authenticatorId,
        credentialId: "missing-id",
      }),
    /Could not find/
  );

  // removeCredential then getCredentials returns length 0 (real mutation).
  await client.send("WebAuthn.removeCredential", { authenticatorId, credentialId });
  const after = await client.send("WebAuthn.getCredentials", { authenticatorId });
  assert.equal(after.credentials.length, 0, "credential was actually removed");
});

test("getCredentials(unknown authenticatorId) rejects /Could not find/", async () => {
  await assert.rejects(
    () =>
      client.send("WebAuthn.getCredentials", {
        authenticatorId: "authenticator-does-not-exist",
      }),
    /Could not find/
  );
});

test("removeVirtualAuthenticator then getCredentials(that id) rejects /Could not find/", async () => {
  const { authenticatorId } = await client.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "nfc",
        hasResidentKey: false,
        hasUserVerification: false,
      },
    }
  );

  // setUserVerified / setAutomaticPresenceSimulation ack on a known id.
  const uv = await client.send("WebAuthn.setUserVerified", {
    authenticatorId,
    isUserVerified: true,
  });
  assert.equal(typeof uv, "object");
  const aps = await client.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: true,
  });
  assert.equal(typeof aps, "object");

  const removed = await client.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId,
  });
  assert.equal(typeof removed, "object");

  await assert.rejects(
    () => client.send("WebAuthn.getCredentials", { authenticatorId }),
    /Could not find/
  );
});

test("Schema.getDomains advertises WebAuthn", async () => {
  const s = await client.send("Schema.getDomains");
  assert.ok(Array.isArray(s.domains), "domains is an array");
  assert.ok(
    s.domains.some((d) => d.name === "WebAuthn"),
    "WebAuthn is advertised"
  );
});
