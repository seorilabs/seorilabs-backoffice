import assert from "node:assert/strict";
import test from "node:test";
import { encodePlayState, PLAY_UNAVAILABLE, type PlayLifecycle, type PlayTrackStatus } from "@/lib/google-play/release-state";
import { googlePlaySubmissionWrites, googlePlaySubmissionCard } from "@/lib/google-play/tracks-collector";
import { normalizeSubmissionState } from "@/lib/store-reviews/submissions/normalizer";

const at = new Date("2026-10-04T12:00:00Z");
const input = {
  appId: "test-app", appDisplayName: "테스트 앱", packageName: "com.example.test", sourceEventAt: at,
  release: { trackName: "production", releaseName: "v1", versionCodes: ["101", "102"], status: "completed" as const, lifecycle: "PUBLISHED" as const },
};
function label(lifecycle: PlayLifecycle, status: PlayTrackStatus = "completed", userFraction: number | null = null, trackName = "production") {
  return normalizeSubmissionState({ store: "GOOGLE_PLAY", state: encodePlayState({ lifecycle, status, userFraction }), trackName }).stateLabel;
}

test("completed만으로 심사 중·승인 대기를 공개로 표시하지 않는다", () => {
  assert.equal(label("DRAFT", "draft"), "작성 중");
  assert.equal(label("NOT_SENT_FOR_REVIEW"), "심사 제출 대기");
  assert.equal(label("IN_REVIEW"), "심사 중");
  assert.equal(label("APPROVED_NOT_PUBLISHED"), "승인 완료 · 게시 대기");
  assert.equal(label("NOT_APPROVED"), "심사 거절");
  assert.equal(label("PUBLISHED"), "프로덕션 공개 확인 · 전체 출시");
});

test("출시율·중지·재개와 테스트 트랙의 문구를 구분한다", () => {
  assert.equal(label("PUBLISHED", "inProgress", 0.1), "프로덕션 공개 확인 · 10% 단계적 출시");
  assert.equal(label("PUBLISHED", "halted", 0.1), "프로덕션 출시 중지 · 10%");
  assert.equal(label("PUBLISHED", "halted"), "프로덕션 출시 중지");
  assert.equal(label("PUBLISHED", "completed", null, "internal"), "내부 테스트 제공 확인 · 전체 출시");
  assert.equal(label("PUBLISHED", "inProgress", 0.07, "beta"), "공개 테스트 제공 확인 · 7% 단계적 출시");
  assert.equal(label("PUBLISHED", "halted", 0.2, "closed-test"), "비공개 테스트 출시 중지 · 20%");
  assert.equal(label("PUBLISHED", "completed", null, "wear:production"), "프로덕션 공개 확인 · 전체 출시");
});

test("잘못된 출시율·모순은 확인 불가이며 전체 출시를 추정하지 않는다", () => {
  for (const fraction of [null, 0, 1, -0.1, NaN, Infinity, 1.1]) assert.equal(label("PUBLISHED", "inProgress", fraction), "출시 상태 확인 불가");
  assert.equal(label("PUBLISHED", "draft"), "출시 상태 확인 불가");
  assert.equal(label("PUBLISHED", "completed", 0.1), "출시 상태 확인 불가");
});

test("이름·시각·다중 artifact 구성 변경은 버전 식별자나 저장 상태를 바꾸지 않는다", () => {
  const original = googlePlaySubmissionWrites(input);
  const renamed = googlePlaySubmissionWrites({ ...input, sourceEventAt: new Date(at.getTime() + 1000), release: { ...input.release, releaseName: "rename", versionCodes: ["101"] } });
  assert.equal(original[0]!.externalVersionId, renamed[0]!.externalVersionId);
  assert.equal(original[0]!.state, renamed[0]!.state);
  assert.notEqual(original[0]!.externalEventId, renamed[0]!.externalEventId);
  assert.notEqual(original[0]!.externalVersionId, original[1]!.externalVersionId);
  const internal = googlePlaySubmissionWrites({ ...input, release: { ...input.release, trackName: "internal" } });
  assert.notEqual(original[0]!.externalVersionId, internal[0]!.externalVersionId);
  const otherPackage = googlePlaySubmissionWrites({ ...input, packageName: "com.example.other" });
  assert.notEqual(original[0]!.externalVersionId, otherPackage[0]!.externalVersionId);
});

test("카드는 최초 공개 확인 시각을 표시하고 API·매칭 실패는 확인 불가 상태로 저장한다", () => {
  const state = googlePlaySubmissionWrites(input)[0]!.state;
  const firstPublished = new Date(at.getTime() - 60_000);
  const card = googlePlaySubmissionCard(input, state, "completed", firstPublished);
  assert.match(String(card.text), /공개 확인 시각: 2026-10-04T11:59:00.000Z/);
  assert.match(String(card.text), /이전 단계: 트랙 상태 completed · 실제 공개 확인 불가/);
  assert.doesNotMatch(String(card.text), /실제 공개 시각/);
  assert.equal(googlePlaySubmissionWrites({ ...input, release: { ...input.release, unavailableReason: "결합 실패" } })[0]?.state, PLAY_UNAVAILABLE);
});
