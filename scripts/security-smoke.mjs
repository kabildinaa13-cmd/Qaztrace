import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 18_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(join(tmpdir(), "chainsentinel-security-"));
const processHandle = spawn(process.execPath, ["backend/server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    STORAGE_DRIVER: "json",
    AUTH_SECRET: "security-smoke-secret-not-for-production-0123456789",
    CORS_ALLOWED_ORIGINS: "http://localhost:5174,http://127.0.0.1:5174",
    REGISTRATION_ENABLED: "true",
    LOGIN_RATE_LIMIT: "3",
    DATA_DIR: dataDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // API is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Security smoke API did not start");
}

try {
  await waitForApi();

  const allowed = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "http://localhost:5174" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5174");

  const blockedOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "https://malicious.example" },
  });
  assert.equal(blockedOrigin.status, 403);

  const entities = await fetch(`${baseUrl}/api/entities`);
  assert.equal(entities.status, 401);

  const audit = await fetch(`${baseUrl}/api/audit`);
  assert.equal(audit.status, 401);

  const v2Networks = await fetch(`${baseUrl}/api/v2/networks`);
  assert.equal(v2Networks.status, 200);
  const v2NetworksBody = await v2Networks.json();
  const networkKeys = v2NetworksBody.items.map((item) => item.key);
  assert.equal(networkKeys.length, 23);
  for (const requiredNetwork of ["ETH", "BNB", "ARB", "BASE", "POLYGON", "TRX", "BTC"]) {
    assert.ok(networkKeys.includes(requiredNetwork));
  }

  const v2Transactions = await fetch(
    `${baseUrl}/api/v2/addresses/TApXXKRdJqTRNhjcn8894Nci75zymcmBEr/transactions?network=TRX`
  );
  assert.equal(v2Transactions.status, 401);

  const transactions = await fetch(
    `${baseUrl}/api/wallets/TApXXKRdJqTRNhjcn8894Nci75zymcmBEr/transactions?networkKey=TRX`
  );
  assert.equal(transactions.status, 401);

  const invalidJson = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{invalid json",
  });
  assert.equal(invalidJson.status, 400);

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "security-smoke", password: "correct-horse-battery-staple" }),
  });
  assert.equal(registration.status, 200);
  const session = await registration.json();
  const authorizedHeaders = {
    Authorization: `Bearer ${session.token}`,
    "Content-Type": "application/json",
  };

  const authorizedEntities = await fetch(`${baseUrl}/api/entities`, { headers: authorizedHeaders });
  assert.equal(authorizedEntities.status, 200);

  const detectedNetwork = await fetch(`${baseUrl}/api/v2/networks/detect`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }),
  });
  assert.equal(detectedNetwork.status, 200);
  const detectedNetworkBody = await detectedNetwork.json();
  assert.equal(detectedNetworkBody.ambiguous, true);
  assert.equal(detectedNetworkBody.candidates.length, 21);
  assert.ok(detectedNetworkBody.candidates.some((item) => item.network.key === "BNB"));

  const createdCase = await fetch(`${baseUrl}/api/cases`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({ title: "Security smoke case", rootAddress: "0x0000000000000000000000000000000000000001" }),
  });
  assert.equal(createdCase.status, 200);
  const createdCaseBody = await createdCase.json();

  const analystRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "security-analyst", password: "correct-horse-battery-staple" }),
  });
  assert.equal(analystRegistration.status, 200);
  const analystSession = await analystRegistration.json();
  const analystHeaders = {
    Authorization: `Bearer ${analystSession.token}`,
    "Content-Type": "application/json",
  };

  const forbiddenCaseOverwrite = await fetch(`${baseUrl}/api/cases`, {
    method: "POST",
    headers: analystHeaders,
    body: JSON.stringify({
      id: createdCaseBody.id,
      title: "Attempted overwrite",
      rootAddress: "0x0000000000000000000000000000000000000002",
    }),
  });
  assert.equal(forbiddenCaseOverwrite.status, 403);

  const forbiddenLabelWrite = await fetch(`${baseUrl}/api/entities`, {
    method: "POST",
    headers: analystHeaders,
    body: JSON.stringify({
      address: "0x0000000000000000000000000000000000000002",
      networkKey: "ETH",
      category: "exchange",
      name: "Unauthorized label",
    }),
  });
  assert.equal(forbiddenLabelWrite.status, 403);

  const auditResult = await fetch(`${baseUrl}/api/audit`, { headers: authorizedHeaders });
  assert.equal(auditResult.status, 200);
  const auditBody = await auditResult.json();
  assert.equal(auditBody.integrity, "sha256_hash_chain");
  assert.equal(auditBody.items[0]?.action, "case.create");
  assert.match(auditBody.items[0]?.eventHash || "", /^[a-f0-9]{64}$/);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: authorizedHeaders,
  });
  assert.equal(logout.status, 200);
  const revokedSession = await fetch(`${baseUrl}/api/auth/me`, { headers: authorizedHeaders });
  assert.equal(revokedSession.status, 401);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "rate-test", password: "wrong-password" }),
    });
    assert.equal(response.status, 401);
  }
  const limitedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "rate-test", password: "wrong-password" }),
  });
  assert.equal(limitedLogin.status, 429);

  process.stdout.write("Security smoke checks passed.\n");
} finally {
  processHandle.kill("SIGTERM");
  await rm(dataDir, { recursive: true, force: true });
}
