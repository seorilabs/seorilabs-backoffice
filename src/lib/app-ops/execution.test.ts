import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appOpsResultSchema,
  encodeTargetRef,
  findManifestOperation,
  operationKey,
  validateOperationConfirmation,
  validateOperationInputs,
} from "./execution";
import { parseAppOpsManifest } from "./manifest";

const manifest = parseAppOpsManifest({
  version: 1,
  tools: [
    {
      id: "iap",
      section: "commerce",
      title: "IAP",
      description: "IAP 테스트 도구",
      operations: [
        {
          id: "lookup",
          label: "조회",
          intent: "read",
          inputs: [
            { key: "environment", label: "환경", type: "select", options: [
              { value: "sandbox", label: "Sandbox" },
            ] },
            { key: "limit", label: "개수", type: "number", required: false },
          ],
        },
        {
          id: "reconcile",
          label: "재조정",
          intent: "mutate",
          risk: "high",
          confirmation: "typed",
        },
      ],
    },
  ],
}).manifest!;

test("manifest 오퍼레이션을 찾고 입력 타입과 select allowlist를 검증한다", () => {
  const lookup = findManifestOperation(manifest, "iap", "lookup");
  assert.ok(lookup);
  const values = validateOperationInputs(lookup.operation, {
    environment: "sandbox",
    limit: "5",
  });
  assert.deepEqual(values, { environment: "sandbox", limit: 5 });
  assert.equal(encodeTargetRef(values), '{"environment":"sandbox","limit":5}');
  assert.throws(
    () => validateOperationInputs(lookup.operation, { environment: "production" }),
    /허용 목록/,
  );
  assert.throws(
    () => validateOperationInputs(lookup.operation, { environment: "sandbox", token: "x" }),
    /허용되지 않은 입력/,
  );
});

test("고위험 변경은 사유와 정확한 typed 문구를 요구한다", () => {
  const reconcile = findManifestOperation(manifest, "iap", "reconcile");
  assert.ok(reconcile);
  assert.equal(operationKey("iap", "reconcile"), "iap:reconcile");
  assert.throws(
    () =>
      validateOperationConfirmation({
        toolId: "iap",
        operation: reconcile.operation,
        reason: "",
        typedConfirmation: "iap:reconcile",
      }),
    /사유/,
  );
  assert.throws(
    () =>
      validateOperationConfirmation({
        toolId: "iap",
        operation: reconcile.operation,
        reason: "환불 상태 확인",
        typedConfirmation: "wrong",
      }),
    /재확인/,
  );
});

test("workflow 결과 계약은 requestId와 완료 시각을 검증한다", () => {
  assert.equal(
    appOpsResultSchema.safeParse({
      version: 1,
      requestId: "86aa4c7c-bf75-4f38-a1c8-50ac398de7dc",
      operation: "iap:lookup",
      status: "success",
      summary: "2건 조회",
      data: { count: 2 },
      completedAt: "2026-07-30T01:00:00.000Z",
    }).success,
    true,
  );
  assert.equal(
    appOpsResultSchema.safeParse({
      version: 1,
      requestId: "not-a-uuid",
      operation: "iap:lookup",
      status: "success",
      summary: "2건 조회",
      completedAt: "today",
    }).success,
    false,
  );
});
