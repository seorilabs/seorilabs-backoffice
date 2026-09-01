import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  APP_CHECK_ENFORCEMENTS,
  ASSET_KINDS,
  BUDGET_CURRENCIES,
  COMPLIANCE_DECLARATIONS,
  FIREBASE_PLATFORMS,
  MARKETS,
  WORKSPACE_ROLES,
} from "@/components/fleet/config-form";
import { legacyConfigResolutionTargetSchema, RELEASE_GATE_NAMES } from "@/lib/control-plane/contracts";
import { FLEET_LIFECYCLE_STAGES } from "@/lib/control-plane/lifecycle-policy";
import {
  configOptionLabel,
  legacyEvidenceLabel,
  lifecycleStageLabel,
  managementStatusLabel,
  releaseGateLabel,
} from "@/lib/control-plane/presentation";

test("개발·출시 14단계와 확인 항목 13개에 한국어 표시 이름이 있다", () => {
  for (const stage of FLEET_LIFECYCLE_STAGES) {
    assert.match(lifecycleStageLabel(stage), /[가-힣]/, stage);
  }
  for (const gate of RELEASE_GATE_NAMES) {
    assert.match(releaseGateLabel(gate), /[가-힣]/, gate);
  }
  assert.equal(new Set(FLEET_LIFECYCLE_STAGES.map(lifecycleStageLabel)).size, 14);
  assert.equal(new Set(RELEASE_GATE_NAMES.map(releaseGateLabel)).size, 13);
});

test("업로드·심사·출시 승인·배포·공개 확인은 다른 이름으로 표시한다", () => {
  assert.equal(lifecycleStageLabel("SUBMITTED"), "업로드 완료");
  assert.equal(lifecycleStageLabel("REVIEW"), "심사 중");
  assert.equal(lifecycleStageLabel("APPROVED_FOR_RELEASE"), "출시 승인");
  assert.equal(lifecycleStageLabel("DEPLOYED"), "배포 완료");
  assert.equal(lifecycleStageLabel("PUBLIC_VERIFIED"), "공개 상태 확인");
  assert.equal(releaseGateLabel("UPLOAD"), "업로드");
  assert.equal(releaseGateLabel("REVIEW"), "심사");
  assert.equal(managementStatusLabel("GRANTED"), "권한 있음");
  assert.notEqual(managementStatusLabel("GRANTED"), managementStatusLabel("APPROVED"));
});

test("설정 선택지와 기존 설정 대체 항목은 코드 대신 표시 이름을 사용한다", () => {
  for (const option of [
    ...MARKETS, ...ASSET_KINDS, ...COMPLIANCE_DECLARATIONS,
    ...APP_CHECK_ENFORCEMENTS, ...FIREBASE_PLATFORMS, ...WORKSPACE_ROLES, ...BUDGET_CURRENCIES,
  ]) {
    assert.notEqual(configOptionLabel(option), option, option);
  }
  for (const target of legacyConfigResolutionTargetSchema.options) {
    assert.match(legacyEvidenceLabel(target), /[가-힣]/, target);
  }
  assert.match(legacyEvidenceLabel("IGNORED_NON_OPERATIONAL"), /이관 제외/);
  const editor = readFileSync(join(process.cwd(), "src/components/fleet/FleetConfigEditor.tsx"), "utf8");
  assert.ok(editor.includes("value={option}>{configOptionLabel(option)}</option>"));
});

test("알 수 없는 상태는 숨기거나 성공으로 바꾸지 않고 그대로 표시한다", () => {
  for (const display of [configOptionLabel, legacyEvidenceLabel, lifecycleStageLabel, managementStatusLabel, releaseGateLabel]) {
    for (const value of ["FUTURE_UNKNOWN", "__proto__", "constructor", "toString", ""]) {
      assert.equal(display(value), value);
    }
  }
  assert.equal(managementStatusLabel("HUMAN_REAUTH_REQUIRED"), "직접 로그인 필요");
  assert.equal(managementStatusLabel("WAITING_HUMAN_APPROVAL"), "승인 대기");
  assert.equal(managementStatusLabel("READBACK_REQUIRED"), "외부 결과 확인 필요");
});

const visibleAttributes = new Set(["title", "label", "k", "description", "hint", "empty", "placeholder", "addLabel", "allowEmpty"]);
const internalTerms = /\b(Fleet|ConfigRevision|ProjectBlueprint|DiscoveryObservation|ProviderObservation|PlatformFleetBinding|CredentialBinding|Dead-letter|lifecycle|desired state|shadow import|parity wave|readback|append-only|cohort|validator|trusted-local)\b/i;

function literalText(expression: ts.Expression): string[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) return [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)];
  if (ts.isConditionalExpression(expression)) return [...literalText(expression.whenTrue), ...literalText(expression.whenFalse)];
  return [];
}

test("관리 화면의 고정 문구에는 내부 개발 용어를 직접 노출하지 않는다", () => {
  const components = "src/components/fleet";
  const files = [
    "src/app/(app)/apps/[id]/fleet/page.tsx",
    "src/app/(app)/settings/page.tsx",
    ...readdirSync(join(process.cwd(), components)).filter((file) => file.endsWith(".tsx")).map((file) => `${components}/${file}`),
  ];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(join(process.cwd(), file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function check(text: string) {
      assert.equal(internalTerms.test(text), false, `${file}: ${text.trim()}`);
    }
    function visit(node: ts.Node) {
      if (ts.isJsxText(node)) check(node.text);
      if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(source)) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) check(node.initializer.text);
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) literalText(node.initializer.expression).forEach(check);
      }
      if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
        literalText(node.expression).forEach(check);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
