import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  verify as verifyEd25519,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { promisify } from "node:util";
import test from "node:test";

import { fleetMigrationInventoryIssuerContract } from "seorilabs-org-contracts/repo-contract/trusted-inventory-issuer";

import { createFleetMigrationMtlsSigningTransport } from "@/lib/control-plane/fleet-migration-inventory-issuer-adapter";
import {
  createFleetMigrationInventorySigningServer,
  FLEET_MIGRATION_INVENTORY_ISSUER_SPIFFE_ID,
  FLEET_MIGRATION_INVENTORY_SIGNING_ROUTE,
  signFleetMigrationInventoryPayload,
} from "@/lib/control-plane/fleet-migration-inventory-signing-service";

const execFileAsync = promisify(execFile);
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const DIGEST_D = `sha256:${"d".repeat(64)}`;
const NOW = new Date("2026-08-31T06:00:00.000Z");

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort(compareUtf8)
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: "der", type: "spki" });
  try {
    return `sha256:${createHash("sha256").update(spki).digest("hex")}`;
  } finally {
    spki.fill(0);
  }
}

function signingFixture(input: {
  signedAt?: string;
  inventoryDigest?: string;
  coverageProvider?: string;
} = {}) {
  const signedAt = input.signedAt ?? NOW.toISOString();
  const inventoryDigest = input.inventoryDigest ?? DIGEST_A;
  const payload = Buffer.from(canonicalJson({
    algorithm: "Ed25519",
    capturedAt: "2026-08-31T05:59:55.000Z",
    contract: "seorilabs-fleet-migration-inventory-attestation-v2",
    coverageObservedAt: "2026-08-31T05:59:57.000Z",
    coverageProvider: input.coverageProvider ?? "GITHUB_APP_INSTALLATION_REPOSITORY_READBACK",
    coverageQuery: { affiliation: "organization", first: 100 },
    coverageReadbackId: "coverage-readback-0001",
    coverageSnapshotId: "coverage-snapshot-0001",
    detectorSourceSha: "e".repeat(40),
    expectedCounts: { repositories: 4 },
    expiresAt: "2026-08-31T07:00:00.000Z",
    installationId: "142120077",
    inventoryDigest,
    inventoryId: "fleet-inventory-0001",
    keyId: fleetMigrationInventoryIssuerContract.keyId,
    lineage: { mode: "INITIAL" },
    organizationId: "283115031",
    organizationLogin: "seorilabs",
    policyRevision: fleetMigrationInventoryIssuerContract.policyRevision,
    providerTotalCount: 4,
    repositoriesDigest: DIGEST_B,
    signedAt,
  }), "utf8");
  const request = {
    algorithm: "Ed25519" as const,
    collectionCapabilityEvidenceDigest: DIGEST_B,
    collectionDigest: DIGEST_C,
    credentialId: fleetMigrationInventoryIssuerContract.signingCredentialId,
    inventoryDigest,
    inventoryId: "fleet-inventory-0001",
    issuanceCapabilityEvidenceDigest: DIGEST_D,
    keyId: fleetMigrationInventoryIssuerContract.keyId,
    keyPurpose: fleetMigrationInventoryIssuerContract.keyPurpose,
    payload,
    payloadDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
    policyRevision: fleetMigrationInventoryIssuerContract.policyRevision,
    signedAt,
  };
  return {
    payload,
    request,
    wire: {
      ...request,
      payload: payload.toString("base64"),
      payloadEncoding: "base64" as const,
    },
  };
}

async function openssl(...args: string[]): Promise<void> {
  await execFileAsync("openssl", args, { maxBuffer: 1024 * 1024 });
}

async function mtlsFixture() {
  const root = await mkdtemp(join(tmpdir(), "fleet-inventory-signer-canary-"));
  const caKey = join(root, "ca.key");
  const ca = join(root, "ca.pem");
  const serverKey = join(root, "server.key");
  const serverCsr = join(root, "server.csr");
  const serverCertificate = join(root, "server.crt");
  const clientKey = join(root, "client.key");
  const clientCsr = join(root, "client.csr");
  const clientCertificate = join(root, "client.crt");
  const wrongClientKey = join(root, "wrong-client.key");
  const wrongClientCsr = join(root, "wrong-client.csr");
  const wrongClientCertificate = join(root, "wrong-client.crt");
  const serverExtension = join(root, "server.ext");
  const clientExtension = join(root, "client.ext");
  const wrongClientExtension = join(root, "wrong-client.ext");

  await openssl("req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes", "-subj", "/CN=Seorilabs Fleet Fake CA", "-keyout", caKey, "-out", ca);
  await openssl("req", "-newkey", "rsa:2048", "-sha256", "-nodes", "-subj", "/CN=fleet-migration-inventory-signer", "-keyout", serverKey, "-out", serverCsr);
  await writeFile(serverExtension, "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n", { mode: 0o400 });
  await openssl("x509", "-req", "-in", serverCsr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", serverExtension, "-out", serverCertificate);

  await openssl("req", "-newkey", "rsa:2048", "-sha256", "-nodes", "-subj", "/CN=fleet-migration-inventory-issuer", "-keyout", clientKey, "-out", clientCsr);
  await writeFile(clientExtension, `subjectAltName=URI:${FLEET_MIGRATION_INVENTORY_ISSUER_SPIFFE_ID}\nextendedKeyUsage=clientAuth\n`, { mode: 0o400 });
  await openssl("x509", "-req", "-in", clientCsr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", clientExtension, "-out", clientCertificate);

  await openssl("req", "-newkey", "rsa:2048", "-sha256", "-nodes", "-subj", "/CN=wrong-fleet-client", "-keyout", wrongClientKey, "-out", wrongClientCsr);
  await writeFile(wrongClientExtension, "subjectAltName=URI:spiffe://seorilabs.local/ns/platform/sa/wrong-issuer\nextendedKeyUsage=clientAuth\n", { mode: 0o400 });
  await openssl("x509", "-req", "-in", wrongClientCsr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", wrongClientExtension, "-out", wrongClientCertificate);

  for (const path of [ca, clientCertificate, clientKey, wrongClientCertificate, wrongClientKey]) {
    await chmod(path, 0o400);
  }
  await chmod(root, 0o700);
  return {
    root,
    ca,
    serverKey,
    serverCertificate,
    client: { caFile: "ca.pem", certificateFile: "client.crt", privateKeyFile: "client.key" },
    wrongClient: { caFile: "ca.pem", certificateFile: "wrong-client.crt", privateKeyFile: "wrong-client.key" },
  };
}

async function directRequest(input: {
  port: number;
  root: string;
  client: { caFile: string; certificateFile: string; privateKeyFile: string };
  path: string;
  body?: Buffer;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string; protocol: string | null }> {
  const [ca, certificate, key] = await Promise.all([
    readFile(join(input.root, input.client.caFile)),
    readFile(join(input.root, input.client.certificateFile)),
    readFile(join(input.root, input.client.privateKeyFile)),
  ]);
  const body = input.body ?? Buffer.from("{}", "utf8");
  try {
    return await new Promise((resolve, reject) => {
      const request = httpsRequest({
        protocol: "https:",
        hostname: "localhost",
        port: input.port,
        path: input.path,
        method: "POST",
        ca,
        cert: certificate,
        key,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        headers: input.headers ?? {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        const protocol = (response.socket as TLSSocket).getProtocol();
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: responseBody.toString("utf8"),
              protocol,
            });
          } finally {
            responseBody.fill(0);
            chunks.forEach((chunk) => chunk.fill(0));
          }
        });
      });
      request.once("error", reject);
      request.end(body);
    });
  } finally {
    ca.fill(0);
    certificate.fill(0);
    key.fill(0);
  }
}

test("signer binds canonical payload, time, exact public identity, and Ed25519 fingerprint", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const expectedKeyFingerprint = fingerprint(publicKey);
  const fixture = signingFixture();
  const result = signFleetMigrationInventoryPayload({
    body: fixture.wire,
    privateKey,
    expectedKeyFingerprint,
    now: NOW,
  });
  assert.equal(result.keyFingerprint, expectedKeyFingerprint);
  assert.equal(
    verifyEd25519(null, fixture.payload, publicKey, Buffer.from(result.value, "base64url")),
    true,
  );

  assert.throws(
    () => signFleetMigrationInventoryPayload({
      body: { ...fixture.wire, inventoryDigest: DIGEST_D },
      privateKey,
      expectedKeyFingerprint,
      now: NOW,
    }),
    /FLEET_MIGRATION_SIGNING_REQUEST_BINDING_MISMATCH/,
  );
  assert.throws(
    () => signFleetMigrationInventoryPayload({
      body: signingFixture({ signedAt: "2026-08-31T06:01:00.000Z" }).wire,
      privateKey,
      expectedKeyFingerprint,
      now: NOW,
    }),
    /FLEET_MIGRATION_SIGNING_TIME_INVALID/,
  );
  assert.throws(
    () => signFleetMigrationInventoryPayload({
      body: signingFixture({ coverageProvider: "SUBSTITUTED_PROVIDER" }).wire,
      privateKey,
      expectedKeyFingerprint,
      now: NOW,
    }),
    /FLEET_MIGRATION_SIGNING_PAYLOAD_INVALID/,
  );
  assert.throws(
    () => signFleetMigrationInventoryPayload({
      body: fixture.wire,
      privateKey,
      expectedKeyFingerprint: DIGEST_D,
      now: NOW,
    }),
    /FLEET_MIGRATION_SIGNING_KEY_FINGERPRINT_MISMATCH/,
  );
});

test("fake-key canary accepts only TLS 1.3, exact route, and exact issuer SPIFFE", async (t) => {
  const mtls = await mtlsFixture();
  t.after(async () => rm(mtls.root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const expectedKeyFingerprint = fingerprint(publicKey);
  const [ca, certificate, serverKey] = await Promise.all([
    readFile(mtls.ca),
    readFile(mtls.serverCertificate),
    readFile(mtls.serverKey),
  ]);
  const server = createFleetMigrationInventorySigningServer({
    tls: { ca, cert: certificate, key: serverKey },
    privateKey,
    expectedKeyFingerprint,
    now: () => NOW,
  });
  ca.fill(0);
  certificate.fill(0);
  serverKey.fill(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  assert.equal(server.headersTimeout, 15_000);
  assert.equal(server.requestTimeout, 15_000);
  assert.equal(server.maxHeadersCount, 24);

  const fixture = signingFixture();
  const transport = createFleetMigrationMtlsSigningTransport({
    origin: `https://localhost:${port}`,
    root: mtls.root,
    ...mtls.client,
  });
  const result = await transport(fixture.request);
  assert.equal(result.keyFingerprint, expectedKeyFingerprint);
  assert.equal(
    verifyEd25519(null, fixture.payload, publicKey, Buffer.from(result.value, "base64url")),
    true,
  );

  const accepted = await directRequest({
    port,
    root: mtls.root,
    client: mtls.client,
    path: FLEET_MIGRATION_INVENTORY_SIGNING_ROUTE,
    body: Buffer.from(JSON.stringify(fixture.wire), "utf8"),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.protocol, "TLSv1.3");

  const wrongRoute = await directRequest({
    port,
    root: mtls.root,
    client: mtls.client,
    path: "/v1/fleet-migration/inventory-signatures/export",
  });
  assert.equal(wrongRoute.status, 403);
  assert.deepEqual(JSON.parse(wrongRoute.body), { error: "FLEET_MIGRATION_SIGNING_REQUEST_REJECTED" });

  const wrongIdentity = createFleetMigrationMtlsSigningTransport({
    origin: `https://localhost:${port}`,
    root: mtls.root,
    ...mtls.wrongClient,
  });
  await assert.rejects(
    wrongIdentity(fixture.request),
    /FLEET_MIGRATION_SIGNING_SERVICE_RESPONSE_INVALID/,
  );

  const oversized = await directRequest({
    port,
    root: mtls.root,
    client: mtls.client,
    path: FLEET_MIGRATION_INVENTORY_SIGNING_ROUTE,
    headers: {
      "content-type": "application/json",
      "content-length": String(32 * 1024 * 1024),
    },
  });
  assert.equal(oversized.status, 403);
});

test("mTLS client rejects an oversized signing response", async (t) => {
  const mtls = await mtlsFixture();
  t.after(async () => rm(mtls.root, { recursive: true, force: true }));
  const [ca, certificate, serverKey] = await Promise.all([
    readFile(mtls.ca),
    readFile(mtls.serverCertificate),
    readFile(mtls.serverKey),
  ]);
  const server = createHttpsServer({
    ca,
    cert: certificate,
    key: serverKey,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
  }, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: "A".repeat(9 * 1024) }));
  });
  ca.fill(0);
  certificate.fill(0);
  serverKey.fill(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => resolve());
  });
  const transport = createFleetMigrationMtlsSigningTransport({
    origin: `https://localhost:${(server.address() as AddressInfo).port}`,
    root: mtls.root,
    ...mtls.client,
  });
  await assert.rejects(
    transport(signingFixture().request),
    /FLEET_MIGRATION_SIGNING_SERVICE_RESPONSE_LIMIT/,
  );
});

test("disabled manifests keep signer key-isolated and issuer non-authoritative until activation", async () => {
  const [signer, issuer, dockerfile, signerEntrypoint] = await Promise.all([
    readFile("k8s/fleet-migration-inventory-signer.yaml", "utf8"),
    readFile("k8s/fleet-migration-inventory-issuer-job.yaml", "utf8"),
    readFile("Dockerfile", "utf8"),
    readFile("scripts/fleet-migration-inventory-signer.ts", "utf8"),
  ]);
  assert.match(signer, /replicas: 0/u);
  assert.match(issuer, /suspend: true/u);
  for (const manifest of [signer, issuer]) {
    assert.match(manifest, /automountServiceAccountToken: false/u);
    assert.match(manifest, /readOnlyRootFilesystem: true/u);
    assert.match(manifest, /runAsUser: 10001/u);
    assert.match(manifest, /command: \["\/usr\/bin\/prlimit", "--core=0:0", "--", "node"/u);
    assert.match(manifest, /--disable-sigusr1/u);
    assert.match(manifest, /--no-report-on-fatalerror/u);
    assert.doesNotMatch(manifest, /command: \["\/bin\/(?:ba)?sh"/u);
  }
  assert.match(signer, /policyTypes: \[Ingress, Egress\]/u);
  assert.doesNotMatch(signer, /^\s*egress:/mu);
  assert.match(signer, /name: fleet-release-approval-signing/u);
  assert.doesNotMatch(issuer, /name: fleet-release-approval-signing/u);
  assert.doesNotMatch(signerEntrypoint, /stdout\.write\([^\n]*(?:secret|privateKey|fingerprint)/iu);
  assert.doesNotMatch(signerEntrypoint, /\/(?:export|secrets|keys)(?:["'\/]|$)/iu);
  assert.match(signerEntrypoint, /`FLEET_MIGRATION_SIGNER_\$\{name\}`/u);
  assert.match(signer, /name: FLEET_MIGRATION_SIGNER_INVENTORY_KEY_FINGERPRINT/u);
  assert.match(dockerfile, /apt-get install[^\n]*openssl ca-certificates util-linux/u);
});
