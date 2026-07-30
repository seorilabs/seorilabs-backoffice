import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_OPS_WORKFLOW_INPUTS,
  appOpsResultSchema,
  prepareAppOperation,
} from "./operation";

const manifest = {
  version: 1,
  tools: [
    {
      id: "slot-math",
      section: "content",
      title: "슬롯 수학",
      description: "RTP 리포트를 실행합니다.",
      operations: [
        {
          id: "rtp-report",
          label: "RTP 리포트",
          intent: "read",
          inputs: [
            {
              key: "volatility",
              label: "변동성",
              type: "select",
              options: [
                { value: "all", label: "전체" },
                { value: "high", label: "높음" },
              ],
            },
            {
              key: "spins",
              label: "스핀 수",
              type: "number",
            },
          ],
        },
        {
          id: "publish",
          label: "수학 설정 반영",
          intent: "mutate",
          risk: "high",
          confirmation: "typed",
          inputs: [],
        },
      ],
    },
  ],
};

test("manifest에 선언된 조회 오퍼레이션 입력을 정규화한다", () => {
  const prepared = prepareAppOperation({
    manifestValue: manifest,
    toolId: "slot-math",
    operationId: "rtp-report",
    values: { volatility: "all", spins: "20000" },
  });

  assert.equal(prepared.operationKey, "slot-math.rtp-report");
  assert.deepEqual(prepared.params, { volatility: "all", spins: 20_000 });
  assert.equal(prepared.paramsJson, '{"volatility":"all","spins":20000}');
  assert.equal(prepared.reason, null);
});

test("선언되지 않은 입력과 select 값을 거부한다", () => {
  assert.throws(
    () =>
      prepareAppOperation({
        manifestValue: manifest,
        toolId: "slot-math",
        operationId: "rtp-report",
        values: { volatility: "medium", spins: 20_000 },
      }),
    /허용되지 않은 값/,
  );
  assert.throws(
    () =>
      prepareAppOperation({
        manifestValue: manifest,
        toolId: "slot-math",
        operationId: "rtp-report",
        values: { volatility: "all", spins: 20_000, token: "secret" },
      }),
    /선언되지 않은 입력/,
  );
});

test("변경 오퍼레이션은 사유와 정확한 typed 확인 문구를 요구한다", () => {
  assert.throws(
    () =>
      prepareAppOperation({
        manifestValue: manifest,
        toolId: "slot-math",
        operationId: "publish",
      }),
    /사유가 필요/,
  );
  assert.throws(
    () =>
      prepareAppOperation({
        manifestValue: manifest,
        toolId: "slot-math",
        operationId: "publish",
        reason: "운영 설정 반영",
        confirmationText: "확인",
      }),
    /수학 설정 반영/,
  );

  const prepared = prepareAppOperation({
    manifestValue: manifest,
    toolId: "slot-math",
    operationId: "publish",
    reason: "운영 설정 반영",
    confirmationText: "수학 설정 반영",
  });
  assert.equal(prepared.reason, "운영 설정 반영");
});

test("표준 workflow 입력과 결과 artifact 계약을 검증한다", () => {
  assert.deepEqual(APP_OPS_WORKFLOW_INPUTS, [
    "operation",
    "request_id",
    "params_json",
    "reason",
  ]);
  assert.equal(
    appOpsResultSchema.safeParse({
      version: 1,
      requestId: "86aa4c7c-bf75-4f38-a1c8-50ac398de7dc",
      operation: "iap-ledger.recent-purchases",
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
      operation: "iap-ledger.recent-purchases",
      status: "success",
      summary: "2건 조회",
      completedAt: "today",
    }).success,
    false,
  );
});
