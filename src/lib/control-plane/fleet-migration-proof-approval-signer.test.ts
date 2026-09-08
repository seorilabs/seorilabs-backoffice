import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 승인 서명기는 trusted operator 로컬에서만 돈다. private key가 파일 경로로 새거나
 * 승인 TTL이 writer의 상한을 넘거나 한 실행에서 여러 저장소를 서명하면, 그 결과는
 * 실행 중에는 정상으로 보이고 나중에 writer나 발급기에서야 무효로 드러난다.
 * 그래서 소스에서 고정한다.
 */
const source = readFileSync(
  join(process.cwd(), "scripts/fleet-migration-proof-approval-signer.ts"),
  "utf8",
);

test("private key를 fd로만 받는다", () => {
  // 경로로 받으면 키가 프로세스 인자와 로그에 남을 수 있다.
  assert.match(source, /FLEET_MIGRATION_APPROVAL_PRIVATE_KEY_FD/u);
  assert.equal(
    /APPROVAL_PRIVATE_KEY_PATH|readFileSync\(privateKeyPath/u.test(source),
    false,
    "private key를 경로로 받는다",
  );
  assert.match(source, /privateKey\?\.fill\(0\)/u, "사용 후 키 버퍼를 지우지 않는다");
});

test("승인 TTL이 writer 상한보다 짧다", () => {
  // writer의 MAX_APPROVAL_TTL_MS는 5분이다. 같은 값을 쓰면 서명과 소비 사이의
  // 지연만으로 만료돼 실패한다.
  const match = /const APPROVAL_TTL_MS = (\d+) \* 60_000;/u.exec(source);
  assert.ok(match, "APPROVAL_TTL_MS 상수를 찾지 못했다");
  assert.ok(Number(match[1]) < 5, `TTL ${match[1]}분은 writer 상한 5분 미만이어야 한다`);
});

test("한 실행에서 저장소 하나만 서명한다", () => {
  // 5분 만료라 일괄 서명하면 뒤쪽 저장소는 Job이 도는 사이 만료된다.
  assert.match(source, /targets\.length !== 1/u);
  assert.match(source, /FLEET_MIGRATION_PROOF_APPROVAL_TARGET_INVALID/u);
});

test("requestHash를 writer와 같은 필드로 계산한다", () => {
  // writer가 같은 다섯 필드로 다시 계산해 승인문과 대조한다
  // (fleet-migration-proof-writer.ts:205-211). 하나라도 다르면 전부 거부된다.
  const match = /const requestHash = jsonDigest\(\{([\s\S]*?)\}\);/u.exec(source);
  assert.ok(match, "requestHash 계산부를 찾지 못했다");
  // shorthand 속성(`proofDigest,`)도 세야 한다.
  const fields = [...match[1]!.matchAll(/^\s{6}([a-zA-Z]+)[:,]/gmu)].map((entry) => entry[1]);
  assert.deepEqual(
    [...fields].sort(),
    ["contract", "createdBy", "idempotencyKey", "observedAt", "proofDigest"],
    "writer와 다른 필드로 requestHash를 만든다",
  );
});

test("멱등성 키를 요청 전체에 결박한다", () => {
  // repositoryId + sourceSha만 쓰면 sha가 그대로인 채 readiness digest나 stable
  // Backoffice state가 바뀌어 새 proof가 필요할 때도 같은 키가 나온다. writer는
  // IDEMPOTENCY_CONFLICT로 거부하므로 그 저장소는 commit을 움직이지 않는 한 proof를
  // 얻을 수 없다. proofDigest는 그 값들을 모두 덮는다.
  assert.match(source, /const idempotencyKey = `fleet-proof-\$\{proofDigest\.slice\(0, 40\)\}`/u);
  assert.equal(
    /idempotencyKey = `fleet-proof-\$\{target\.repositoryId\}/u.test(source),
    false,
    "멱등성 키가 저장소와 sha에만 결박돼 있다",
  );
});

test("승인 payload가 writer의 exact key 집합과 같다", () => {
  const match = /payload: \{([\s\S]*?)\n {6}\},/u.exec(source);
  assert.ok(match, "승인 payload를 찾지 못했다");
  const keys = [...match[1]!.matchAll(/^\s{8}([a-zA-Z]+)[:,]/gmu)].map((entry) => entry[1]);
  assert.deepEqual(
    [...keys].sort(),
    [
      "actor",
      "approvalId",
      "contract",
      "detectorSourceSha",
      "proofDigest",
      "repositoryId",
      "requestHash",
      "schemaVersion",
      "sourceSha",
    ],
    "writer의 APPROVAL_PAYLOAD_KEYS와 다르다",
  );
});
