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

test("candidate의 sourceReadback은 스캔 값에서만 만들고 나머지 proof는 비운다", () => {
  // collector의 bindCandidates가 스캔한 detection마다 candidate 하나를 요구하고, 그
  // candidate의 sourceReadback을 자신이 방금 읽은 tree/blob과 대조한다. 그래서 이 단계에서
  // 반드시 만들어야 하고, 동시에 스캔 값 밖에서 가져오면 대조에서 걸린다.
  const readback = /const sourceReadback: Record<string, unknown> = \{([\s\S]*?)\n    \};/u
    .exec(source);
  assert.ok(readback, "sourceReadback 생성 블록이 있어야 한다");
  for (const field of [
    "path: scanned.path",
    "gitEntry: structuredClone(scanned.gitEntry)",
    "contentDigest: scanned.contentDigest",
    "treeSha: input.treeSha",
    "sourceSha: input.sourceSha",
    "sourceRef: input.sourceRef",
  ]) {
    assert.ok(readback[1].includes(field), `sourceReadback이 ${field}를 스캔에서 가져와야 한다`);
  }

  // 나머지 슬롯은 이 단계에서 하지 않은 대조다. 채우면 하지 않은 확인을 기록하게 된다.
  for (const slot of [
    "activeConfigReadback",
    "marketProfileReadback",
    "workflowBundleReadback",
    "platformFleetBindingReadback",
    "parityStream",
    "consumerReadback",
    "controlPlaneReadback",
  ]) {
    assert.match(source, new RegExp(`${slot}: null,`, "u"), `${slot}은 null이어야 한다`);
  }
  assert.match(source, /buildOnly: \[\],/u);
  assert.match(source, /credentialBindings: \[\],/u);
  assert.match(source, /gitRestore: null,/u);
  assert.match(source, /replacement: null,/u);
});

test("candidate subject는 공개 증거에 있는 사실만 옮긴다", () => {
  // subject를 지어내면 그 저장소에 대해 하지 않은 귀속을 기록하게 된다. 공개 증거와
  // 요청 값에서만 가져오는지 고정한다.
  const subject = /function subjectFromEvidence\([\s\S]*?\n\}/u.exec(source);
  assert.ok(subject, "subjectFromEvidence가 있어야 한다");
  for (const field of [
    "appId: app?.appId ?? null",
    "repositoryId: request.repositoryId",
    "fullName: request.fullName",
    "sourceSha: request.sourceSha",
    "platformAppId: binding?.platformAppId ?? null",
    "classificationDecisionRevision: publicEvidence.classificationDecisionRevision",
  ]) {
    assert.ok(subject[0].includes(field), `subject가 ${field}를 그대로 옮겨야 한다`);
  }
  // Platform 원장 미등록과 App 부재는 null로 남긴다. 임의 기본값을 넣지 않는다.
  assert.doesNotMatch(subject[0], /platformAppId: "/u);
  assert.doesNotMatch(subject[0], /appId: "/u);
});

test("승인 서명을 하지 않는다", () => {
  // 승인 private key는 클러스터에 두지 않는다. 이 스크립트가 서명까지 하면 키를
  // Pod로 옮겨야 하므로 경계가 무너진다.
  for (const forbidden of ["signFleetMigrationPublicAttestation", "createPrivateKey", "privateKey"]) {
    assert.equal(source.includes(forbidden), false, `${forbidden}를 참조한다`);
  }
});

test("backoffice 증거 읽기 실패도 저장소와 code를 남긴다", () => {
  // collector가 이 콜백의 예외를 FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_FAILED
  // 하나로 감싸므로, 감싸지 않으면 어느 저장소에서 무엇이 닫혔는지 알 수 없다.
  // legacy 검증과 같은 계열이다.
  assert.match(source, /backoffice 증거 읽기 실패: repository=\$\{/u);
  assert.match(source, /code=\$\{code\}/u);
  // 공개 식별자만 남긴다. 증거 내용이나 payload를 로그에 싣지 않는다.
  const block = /const read = async \(\) => \{[\s\S]*?\n      \};/u.exec(source);
  assert.ok(block, "읽기 래퍼가 있어야 한다");
  for (const forbidden of ["publicEvidence", "payload", "snapshot"]) {
    assert.equal(
      block[0].includes(`${forbidden}`),
      false,
      `실패 로그에 ${forbidden}를 싣지 않는다`,
    );
  }
  // 삼키지 않고 다시 던진다. 삼키면 수집이 잘못된 증거로 계속된다.
  assert.match(block[0], /throw error;/u);
});
