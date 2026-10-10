import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedEvidenceLabel,
  renderInsight,
  renderInsightCard,
  readInsight,
  validatedEvidence,
  fallbackInsight,
  insightInputHash,
  validateInsight,
  type Insight,
} from "./contract";
const facts = [{ id: "dau", label: "활성 합계", value: "42명", source: "GA4 2026-10-07" }];
const valid: Insight = {
  bullets: [
    { kind: "fact", text: "{dau} 관측됨", evidenceIds: ["dau"] },
    { kind: "hypothesis", text: "유입 변화 가능성 있음", evidenceIds: ["dau"] },
    { kind: "action", text: "획득 경로 비교 필요", evidenceIds: ["dau"] },
  ],
};
test("서버의 근거 값만 숫자로 렌더하고 가설을 구분함", () => {
  const text = renderInsight(validateInsight(valid, facts), facts);
  assert.match(text, /42명/);
  assert.match(text, /가설:/);
  assert.equal(text.split("\n").length, 3);
});
test("날조 숫자·없는 근거·명령 주입·장문·음슴체 위반을 거부함", () => {
  for (const patch of [
    { text: "99% 증가함" },
    { evidenceIds: ["invented"] },
    { text: "@everyone 실행하세요" },
    { text: "좋아졌습니다" },
    { text: "가".repeat(601) },
  ]) {
    assert.throws(() =>
      validateInsight(
        { bullets: [{ ...valid.bullets[0], ...patch }, ...valid.bullets.slice(1)] },
        facts,
      ),
    );
  }
});
test("실패 요약은 근거와 다음 행동을 보존하고 입력 순서에 무관한 해시를 사용함", () => {
  assert.match(renderInsight(validateInsight(fallbackInsight(facts), facts), facts), /42명/);
  assert.equal(insightInputHash(facts), insightInputHash([...facts].reverse()));
});

test("다른 근거 ID를 붙인 날조 사실을 거부함", () => {
  assert.throws(
    () =>
      validateInsight(
        {
          bullets: [
            { ...valid.bullets[0], text: "모든 앱 출시 심사 승인됨" },
            ...valid.bullets.slice(1),
          ],
        },
        facts,
      ),
    /FACT_TEMPLATE/,
  );
});

test("기존 잘못된 저장 문서는 안전한 사실 요약으로 조회하고 비밀 근거는 거부함", () => {
  assert.doesNotThrow(() => validateInsight(readInsight({ bullets: [] }, facts), facts));
  assert.throws(
    () => validatedEvidence([{ ...facts[0], value: "-----BEGIN PRIVATE KEY-----" }]),
    /UNSAFE/,
  );
});

test("최대 검색어와 Unicode 라벨을 근거 제한 내에서 안전하게 표시함", () => {
  for (const term of ["가".repeat(100), "😀".repeat(50)]) {
    const label = boundedEvidenceLabel("US " + term);
    assert.ok(label.length <= 100);
    assert.equal(label.includes("\uFFFD"), false);
    assert.doesNotThrow(() => validatedEvidence([{ ...facts[0], label }]));
  }
});

test("카드는 사실을 라벨·값으로, 기준을 한 줄로 쓰고 실패 시 고정 가설을 싣지 않음", () => {
  const ready = renderInsightCard(facts, { content: valid, fallback: false });
  assert.match(ready, /^- 활성 합계: 42명\n기준: GA4 2026-10-07\n- 가설: 유입 변화 가능성 있음\n- 획득 경로 비교 필요$/);
  const failed = renderInsightCard(facts, {
    content: fallbackInsight(facts),
    fallback: true,
    errorCode: "MINIMAX_NOT_CONFIGURED",
  });
  assert.doesNotMatch(failed, /원인 확정할 수 없음|관측됨/);
  assert.match(failed, /해설 없음 · 분석 모델 미설정/);
  assert.match(renderInsightCard(facts), /해설 준비 중/);
});
