import assert from "node:assert/strict";
import test from "node:test";

import {
  publicExecutorError,
  withExecutorStage,
} from "@/lib/control-plane/trusted-mutation-executor-client";

const SECRET_LOOKING = "connect ECONNREFUSED 10.42.0.7:8443 while reading /var/run/secret";

test("공개 코드가 아닌 오류는 단계 코드로 바뀐다", async () => {
  await assert.rejects(
    withExecutorStage("APPROVED_CALLER", "EGRESS_BACKOFFICE", async () => {
      throw new Error(SECRET_LOOKING);
    }),
    (error: unknown) => error instanceof Error
      && error.message === "APPROVED_CALLER_STAGE_EGRESS_BACKOFFICE_FAILED",
  );
});

test("이미 공개 코드인 오류는 그대로 보존된다", async () => {
  for (const code of ["SEORI_AUTH_SECRET_FILE_UNSAFE", "SEORI_BACKOFFICE_REJECTED_401"]) {
    await assert.rejects(
      withExecutorStage("APPROVED_CALLER", "RUN", async () => {
        throw new Error(code);
      }),
      (error: unknown) => error instanceof Error && error.message === code,
      code,
    );
  }
});

test("오류 원문은 단계 코드 밖으로 나가지 않는다", async () => {
  const thrown = await withExecutorStage("APPROVED_CALLER", "READ_ATTESTATION_KEY", async () => {
    throw new Error(SECRET_LOOKING);
  }).catch((error: unknown) => error as Error);
  assert.doesNotMatch(thrown.message, /ECONNREFUSED|10\.42\.0\.7|\/var\/run/u);
  // Error 객체 전체를 직렬화해도 원문이 남지 않는다.
  assert.doesNotMatch(JSON.stringify({ message: thrown.message }), /ECONNREFUSED/u);
});

test("성공 경로는 값을 그대로 통과시킨다", async () => {
  assert.equal(await withExecutorStage("APPROVED_CALLER", "RUN", async () => 42), 42);
});

test("publicExecutorError는 공개 형식만 통과시킨다", () => {
  assert.equal(publicExecutorError(new Error("SEORI_BACKOFFICE_REJECTED_409"), "FALLBACK_CODE"),
    "SEORI_BACKOFFICE_REJECTED_409");
  assert.equal(publicExecutorError(new Error("APPROVED_CALLER_TASK_STALE"), "FALLBACK_CODE"),
    "APPROVED_CALLER_TASK_STALE");
  assert.equal(publicExecutorError(new Error(SECRET_LOOKING), "FALLBACK_CODE"), "FALLBACK_CODE");
  assert.equal(publicExecutorError("not an error", "FALLBACK_CODE"), "FALLBACK_CODE");
});
