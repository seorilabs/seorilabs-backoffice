import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * proof request builder는 승인 서비스의 수집 단계다. 여기서 쓰기가 한 번이라도 일어나면
 * proof 없이 shadow occurrence가 생겨 P7 원장이 오염된다. 그리고 readiness verifier를
 * 진단 기본값으로 두면 digest가 shadow와 갈려 만들어 둔 승인이 전부 무효가 된다.
 * 둘 다 실행 로그에 드러나지 않으므로 소스에서 고정한다.
 */
const source = readFileSync(
  join(process.cwd(), "scripts/fleet-migration-proof-request-builder.ts"),
  "utf8",
);

test("collector의 쓰기 콜백 세 개가 모두 거부한다", () => {
  for (const callback of ["claimOccurrence", "completeOccurrence", "readOccurrence"]) {
    const match = new RegExp(`${callback}: \\(\\) => \\{\\s*throw new Error\\(([^)]+)\\)`, "u")
      .exec(source);
    assert.ok(match, `${callback}가 즉시 throw하지 않는다`);
  }
  assert.match(
    source,
    /completeOccurrence: \(\) => \{\s*throw new Error\("FLEET_MIGRATION_PROOF_REQUEST_BUILDER_MUST_NOT_WRITE"\)/u,
    "completion이 거부되지 않으면 proof 없이 occurrence가 기록된다",
  );
});

test("proof가 필요한 읽기 경로를 쓰지 않는다", () => {
  // readBackofficePublicEvidence(requireProof=true)를 부르면 아직 없는 proof를 요구해
  // 수집 자체가 불가능하다. 승인 서비스용 진입점은 readStableBackofficeState다.
  assert.match(source, /backoffice\s*\.readStableBackofficeState\(/u);
  assert.equal(
    /backoffice\.readBackofficePublicEvidence\(/u.test(source),
    false,
    "proof를 요구하는 진입점을 호출한다",
  );
});

test("readiness verifier를 명시적으로 주입한다", () => {
  // 기본값은 `verifyConfigSnapshot: () => false`라 모든 저장소가
  // ACTIVE_SNAPSHOT_INVALID가 되고 evidence digest가 shadow와 달라진다.
  assert.match(source, /verifyConfigSnapshot: \(\{ snapshot, digest, signature \}\) => verifySnapshot\(/u);
  assert.match(source, /CONTROL_PLANE_SNAPSHOT_SIGNING_KEY/u);
});

test("cohort를 ID가 아니라 exact vector로 대조한다", () => {
  // issuer의 resolveFleetMigrationApprovedProofDigests는 ID뿐 아니라 full name과
  // source SHA도 현재 readiness cohort와 비교한다. readiness 평가 뒤 스캔 사이에
  // HEAD가 움직이면 ID만 맞는 요청이 만들어지고 그 승인은 전부 버려진다.
  assert.match(source, /FLEET_MIGRATION_PROOF_REQUEST_COVERAGE_INVALID/u);
  for (const field of [
    "repository.repoFullName",
    "repository.sourceSha",
    "item.repositoryFullName",
    "item.sourceSha",
  ]) {
    assert.ok(source.includes(field), `${field}를 대조 벡터에 넣지 않는다`);
  }
});

test("HMAC 키를 issuer와 같은 바이트열로 읽는다", () => {
  // trim하면 값에 개행이나 공백이 섞였을 때 issuer는 유효하다고 보는 snapshot을
  // 여기서만 무효로 판정해 수집이 막힌다.
  assert.match(source, /process\.env\.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY \?\? ""/u);
  assert.equal(
    /CONTROL_PLANE_SNAPSHOT_SIGNING_KEY\?\.trim\(\)/u.test(source),
    false,
    "키를 trim해 issuer와 다른 바이트열을 쓴다",
  );
  assert.match(source, /snapshotSigningKey\.length < 32 \|\| snapshotSigningKey\.length > 4096/u);
});

test("candidate의 proofs는 비운 채 기록한다", () => {
  // sourceReadback은 읽기 시점에 Backoffice adapter가 채운다. 여기서 채우면 하지 않은
  // 대조를 했다고 기록하는 것이 된다.
  assert.match(source, /proofs: \{\},/u);
  // 주석의 언급이 아니라 실제 생성만 막는다.
  assert.equal(
    /sourceReadback\s*[:=]/u.test(source),
    false,
    "builder가 sourceReadback을 직접 만든다",
  );
});

test("승인 서명을 하지 않는다", () => {
  // 승인 private key는 클러스터에 두지 않는다. 이 스크립트가 서명까지 하면 키를
  // Pod로 옮겨야 하므로 경계가 무너진다.
  for (const forbidden of ["signFleetMigrationPublicAttestation", "createPrivateKey", "privateKey"]) {
    assert.equal(source.includes(forbidden), false, `${forbidden}를 참조한다`);
  }
});
