import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 두 실행기가 공개 오류 경계를 각자 구현하면 계열이 조용히 갈린다. 실제로 그랬다 —
 * bootstrap shadow에는 `GITHUB_APP_*`가 빠져 있었고, 양쪽 다 소문자 hex 접미사를
 * 받지 못했다. 소스 수준에서 공통 함수 사용을 고정한다.
 */
const SCRIPTS = [
  "fleet-migration-runtime-capability-issuer.ts",
  "fleet-migration-bootstrap-shadow.ts",
] as const;

function read(script: string): string {
  return readFileSync(join(process.cwd(), "scripts", script), "utf8");
}

test("두 실행기가 공통 공개 오류 함수를 쓴다", () => {
  for (const script of SCRIPTS) {
    const source = read(script);
    assert.match(
      source,
      /import \{ fleetMigrationPublicError \} from "@\/lib\/control-plane\/fleet-migration-public-error";/u,
      `${script}가 공통 함수를 import하지 않는다`,
    );
    assert.match(
      source,
      /return fleetMigrationPublicError\(error, "[A-Z0-9_]+"\);/u,
      `${script}의 publicError가 공통 함수에 위임하지 않는다`,
    );
  }
});

test("실행기가 자체 공개 code 패턴을 다시 만들지 않는다", () => {
  for (const script of SCRIPTS) {
    const source = read(script);
    assert.equal(
      /\/\^(?:FLEET_MIGRATION|FLEET_GITHUB|GITHUB_APP|REPOSITORY_BACKFILL)_/u.test(source),
      false,
      `${script}에 자체 공개 code 정규식이 남아 있다`,
    );
  }
});

test("proof writer도 실패 code를 삼키지 않는다", () => {
  // 종전에는 모든 실패를 FLEET_MIGRATION_PROOF_WRITE_FAILED 하나로 삼켰다. 승인 만료인지,
  // stable state 불일치인지, idempotency 충돌인지 구분할 수 없어 Job 로그만으로는 조사할
  // 수 없었다. 이 실행기는 Job으로만 돌아 다른 관측 경로가 없다.
  const source = read("fleet-migration-proof-writer.ts");
  assert.match(
    source,
    /import \{ fleetMigrationPublicError \} from "@\/lib\/control-plane\/fleet-migration-public-error";/u,
  );
  assert.match(
    source,
    /fleetMigrationPublicError\(error, "FLEET_MIGRATION_PROOF_WRITE_FAILED"\)/u,
  );
  // 반증: 인자 없는 catch로 되돌아가면 잡힌다.
  assert.doesNotMatch(source, /\.catch\(\(\) => \{/u);
});
