import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const CONFIG_MAP_NAME = "backoffice-platform-fleet-trust";
const CONFIG_MAP_KEY = "trusted-release-keys.json";
const ENV_NAME = "PLATFORM_FLEET_APPROVAL_PUBLIC_KEYS_JSON";
// shared/platform/fleet-release-approval-signing의 공개 identity다. 비밀값이 아니다.
const REGISTERED_KEY_ID = "platform-fleet-release-20260829-5458c56b";
const REGISTERED_FINGERPRINT = "5458c56b0e687c6328c54fce00f17112b5e1f0fc2704f1fe9fd055ec731b1525";

const manifest = readFileSync(join(ROOT, "k8s/platform-fleet-trust-configmap.yaml"), "utf8");
const deployment = readFileSync(join(ROOT, "k8s/deployment.yaml"), "utf8");

/** ConfigMap의 block scalar 값만 꺼낸다. YAML 파서를 새로 들이지 않는다. */
function trustRegistryJson(): string {
  const marker = `${CONFIG_MAP_KEY}: |`;
  const start = manifest.indexOf(marker);
  assert.notEqual(start, -1, `${CONFIG_MAP_KEY} block scalar가 없다.`);
  const lines = manifest.slice(start + marker.length).split("\n").slice(1);
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (!line.startsWith("    ")) break;
    body.push(line.slice(4));
  }
  return body.join("\n");
}

test("ConfigMap 이름과 key가 deployment의 configMapKeyRef와 정확히 일치한다", () => {
  assert.match(manifest, new RegExp(`^  name: ${CONFIG_MAP_NAME}$`, "mu"));
  assert.match(manifest, /^  namespace: platform$/mu);
  assert.match(manifest, new RegExp(`^  ${CONFIG_MAP_KEY}: \\|$`, "mu"));

  // deployment가 같은 이름·key를 참조해야 env 주입이 성립한다.
  const reference = deployment.slice(deployment.indexOf(`- name: ${ENV_NAME}`));
  assert.notEqual(reference.length, 0, `${ENV_NAME} env가 deployment에 없다.`);
  const block = reference.slice(0, reference.indexOf("- name: ", 1));
  assert.match(block, new RegExp(`name: ${CONFIG_MAP_NAME}`, "u"));
  assert.match(block, new RegExp(`key: ${CONFIG_MAP_KEY}`, "u"));
});

test("trust root가 producer의 strict registry schema를 통과한다", () => {
  const registry = JSON.parse(trustRegistryJson()) as {
    schemaVersion: number;
    keys: Record<string, unknown>[];
  };
  assert.deepEqual(Object.keys(registry).sort(), ["keys", "schemaVersion"]);
  assert.equal(registry.schemaVersion, 1);
  assert.ok(registry.keys.length >= 1 && registry.keys.length <= 100);
  for (const entry of registry.keys) {
    // producer의 trustedReleaseKeyRegistrySchema는 strict라 추가 필드를 거부한다.
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["algorithm", "keyId", "publicKeyPem", "status"],
    );
    assert.equal(entry.algorithm, "Ed25519");
    assert.ok(["ACTIVE", "REVOKED"].includes(entry.status as string));
  }
  assert.ok(
    registry.keys.some((entry) => entry.status === "ACTIVE"),
    "ACTIVE 공개키가 최소 하나 있어야 한다.",
  );
});

test("공개키가 canonical SPKI Ed25519이고 개인키를 포함하지 않는다", () => {
  const registry = JSON.parse(trustRegistryJson()) as { keys: { publicKeyPem: string }[] };
  for (const { publicKeyPem } of registry.keys) {
    assert.ok(!publicKeyPem.includes("PRIVATE KEY"), "trust root에 개인키를 두지 않는다.");
    const normalized = publicKeyPem.trim().replace(/\r\n/gu, "\n");
    assert.match(
      normalized,
      /^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/]{1,64}\n)*[A-Za-z0-9+/]{1,64}={0,2}\n-----END PUBLIC KEY-----$/u,
    );
    const key = createPublicKey(normalized);
    assert.equal(key.type, "public");
    assert.equal(key.asymmetricKeyType, "ed25519");
    assert.equal(key.export({ type: "spki", format: "pem" }).toString().trim(), normalized);
  }
});

test("등록된 릴리스 승인 signer의 공개 identity와 일치한다", () => {
  const registry = JSON.parse(trustRegistryJson()) as {
    keys: { keyId: string; publicKeyPem: string; status: string }[];
  };
  const active = registry.keys.filter((entry) => entry.status === "ACTIVE");
  assert.equal(active.length, 1);
  const [entry] = active;
  assert.equal(entry.keyId, REGISTERED_KEY_ID);

  const der = createPublicKey(entry.publicKeyPem).export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256").update(der).digest("hex");
  assert.equal(fingerprint, REGISTERED_FINGERPRINT);
  // keyId 접미사는 공개 fingerprint 앞 8자리를 그대로 쓴다.
  assert.ok(entry.keyId.endsWith(fingerprint.slice(0, 8)));
});

test("trust ConfigMap에 비밀값을 담지 않는다", () => {
  assert.ok(!manifest.includes("PRIVATE KEY"));
  assert.ok(!/\bsecretKeyRef\b/u.test(manifest));
  assert.match(manifest, /^kind: ConfigMap$/mu);
});
