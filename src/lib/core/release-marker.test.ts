import assert from "node:assert/strict";
import test from "node:test";
import {
  isReleaseMarkerMessage,
  releaseMarkerMessage,
} from "@/lib/core/release-marker";

test("마커 커밋 메시지는 제목에 태그를, 본문에 skip ci 를 담는다", () => {
  const message = releaseMarkerMessage("v1.3.2");
  const [subject, blank, body] = message.split("\n");

  assert.equal(subject, "chore(release): v1.3.2");
  assert.equal(blank, "");
  assert.equal(body, "[skip ci]");
});

test("자기 자신이 만든 마커 메시지를 다시 마커로 인식한다(연쇄 방지)", () => {
  assert.equal(isReleaseMarkerMessage(releaseMarkerMessage("v1.3.2")), true);
});

test("제목이 아닌 본문에 접두사가 있으면 마커가 아니다", () => {
  assert.equal(
    isReleaseMarkerMessage("fix: 태그 생성 정리\n\nchore(release): v1.0.0 참고"),
    false,
  );
});

test("일반 커밋과 PR 머지 커밋은 마커가 아니다", () => {
  assert.equal(isReleaseMarkerMessage("Google Play 환불 검토 화면 추가 (#77)"), false);
  assert.equal(isReleaseMarkerMessage("chore: 의존성 정리"), false);
});
