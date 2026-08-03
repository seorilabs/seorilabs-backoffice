import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  APP_OPS_MANIFEST_PATH,
  contentSpecFromManifest,
  parseAppOpsManifest,
  parseAppOpsManifestText,
  toolsForSection,
} from "./manifest";

const validManifest = {
  version: 1,
  summary: "농장 게임 운영 도구",
  tools: [
    {
      id: "iap-support",
      section: "commerce",
      title: "IAP 테스트 지원",
      description: "테스트 계정의 entitlement를 조회하고 지급 또는 회수합니다.",
      runbook: "docs/08-ops/iap.md",
      operations: [
        {
          id: "lookup",
          label: "entitlement 조회",
          intent: "read",
          risk: "low",
          confirmation: "none",
          inputs: [{ key: "player_id", label: "플레이어 ID", type: "text" }],
        },
        {
          id: "grant",
          label: "무료 지급",
          intent: "mutate",
          risk: "high",
          confirmation: "typed",
          inputs: [{ key: "player_id", label: "플레이어 ID", type: "text" }],
        },
      ],
    },
  ],
  analytics: {
    content: {
      metrics: [
        { key: "starts", label: "시작", event: "game_start", agg: "count" },
        { key: "manual", label: "직접 수확", event: "crop_harvested", agg: "count", where: [{ param: "harvest_source", op: "ne_or_unset", value: "auto" }] },
        {
          key: "avg_duration",
          label: "평균 플레이",
          event: "game_end",
          agg: "avg",
          param: "duration_sec",
        },
      ],
    },
  },
};

test("표준 manifest 경로와 정상 manifest를 파싱한다", () => {
  assert.equal(APP_OPS_MANIFEST_PATH, ".seorilabs/backoffice.json");
  const result = parseAppOpsManifest(validManifest);
  assert.equal(result.error, null);
  assert.equal(result.manifest?.tools[0].operations[0].risk, "low");
});

test("변경 오퍼레이션은 확인 정책이 반드시 필요하다", () => {
  const result = parseAppOpsManifest({
    version: 1,
    tools: [
      {
        id: "flags",
        section: "flags",
        title: "플래그",
        description: "기능 플래그를 변경합니다.",
        operations: [{ id: "set", label: "변경", intent: "mutate" }],
      },
    ],
  });
  assert.equal(result.manifest, null);
  assert.match(result.error ?? "", /confirmation/);
});

test("고위험 오퍼레이션은 typed 확인만 허용한다", () => {
  const result = parseAppOpsManifest({
    version: 1,
    tools: [
      {
        id: "iap",
        section: "commerce",
        title: "IAP",
        description: "지급을 회수합니다.",
        operations: [
          {
            id: "revoke",
            label: "회수",
            intent: "mutate",
            risk: "high",
            confirmation: "reason",
          },
        ],
      },
    ],
  });
  assert.equal(result.manifest, null);
  assert.match(result.error ?? "", /typed/);
});

test("임의 runbook 경로와 깨진 JSON은 거부한다", () => {
  const unsafe = structuredClone(validManifest);
  unsafe.tools[0].runbook = "https://example.com/runbook";
  assert.match(parseAppOpsManifest(unsafe).error ?? "", /runbook/);
  assert.match(parseAppOpsManifestText("{").error ?? "", /JSON/);
});

test("비밀번호·영수증·구매 토큰 입력은 manifest 단계에서 거부한다", () => {
  for (const key of ["password", "receipt_data", "purchase_token", "private_key"]) {
    const unsafe = structuredClone(validManifest);
    unsafe.tools[0].operations[0].inputs = [
      { key, label: "민감 입력", type: "text" },
    ];
    assert.equal(parseAppOpsManifest(unsafe).manifest, null);
    assert.match(parseAppOpsManifest(unsafe).error ?? "", /비밀 입력/);
  }
});

test("같은 도구 안의 operation id 중복은 거부한다", () => {
  const unsafe = structuredClone(validManifest);
  unsafe.tools[0].operations.push(structuredClone(unsafe.tools[0].operations[0]));
  assert.equal(parseAppOpsManifest(unsafe).manifest, null);
  assert.match(parseAppOpsManifest(unsafe).error ?? "", /중복 operation id/);
});

test("manifest 컨텐츠 스펙과 섹션별 도구를 해석한다", () => {
  const spec = contentSpecFromManifest("happy-farm", validManifest);
  assert.equal(spec?.slug, "happy-farm");
  assert.equal(spec?.metrics?.[1].where?.[0].op, "ne_or_unset");
  assert.equal(spec?.metrics?.[2].param, "duration_sec");
  assert.equal(toolsForSection(validManifest, "commerce").length, 1);
  assert.equal(toolsForSection(validManifest, "ads").length, 0);
});

test("문서의 게임 기여 예제가 실제 런타임 스키마를 통과한다", () => {
  const path = fileURLToPath(
    new URL(
      "../../../docs/app-ops/examples/game-backoffice.example.json",
      import.meta.url,
    ),
  );
  const result = parseAppOpsManifestText(readFileSync(path, "utf8"));
  assert.equal(result.error, null);
  assert.equal(result.manifest?.tools.length, 4);
});
