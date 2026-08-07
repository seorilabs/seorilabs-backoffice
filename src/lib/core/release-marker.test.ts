import assert from "node:assert/strict";
import test from "node:test";
import {
  excludeReleaseMarkers,
  isReleaseMarkerMessage,
  releaseMarkerMessage,
  shouldPushReleaseMarker,
} from "@/lib/core/release-marker";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function marker(input: Partial<Parameters<typeof shouldPushReleaseMarker>[0]> = {}) {
  return shouldPushReleaseMarker({
    tagAlreadyExists: false,
    branchHeadSha: HEAD,
    targetSha: HEAD,
    parentMessage: "Google Play 환불 검토 화면 추가 (#77)",
    ...input,
  });
}

test("마커 커밋 메시지는 제목 한 줄이다", () => {
  assert.equal(releaseMarkerMessage("v1.3.2"), "chore(release): v1.3.2");
});

// 인수조건: push:tags 로 도는 배포를 마커 커밋이 삼키지 않는다.
test("마커 커밋 메시지에 CI skip 지시어를 넣지 않는다", () => {
  const message = releaseMarkerMessage("v1.3.2");

  for (const directive of ["[skip ci]", "[ci skip]", "[skip actions]", "***NO_CI***"]) {
    assert.equal(message.includes(directive), false, `${directive} 가 포함되면 안 된다`);
  }
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

// 인수조건: 브랜치 헤드에 릴리즈 태그를 찍으면 마커 커밋을 남긴다.
test("대상 SHA 가 브랜치 헤드이고 부모가 일반 커밋이면 마커를 남긴다", () => {
  assert.equal(marker(), true);
});

// 인수조건: 재실행이 main 에 마커를 중복으로 쌓지 않는다.
test("태그가 이미 있으면 마커를 남기지 않는다(재실행 멱등)", () => {
  assert.equal(marker({ tagAlreadyExists: true }), false);
});

// 인수조건: 태그/SHA 를 직접 지정한 릴리즈는 브랜치를 건드리지 않는다.
test("대상 ref 가 브랜치가 아니면 마커를 남기지 않는다", () => {
  assert.equal(marker({ branchHeadSha: null }), false);
});

// 인수조건: 조회~push 사이에 브랜치가 움직이면 남의 커밋 위에 얹지 않는다.
test("브랜치 헤드가 대상 SHA 와 다르면 마커를 남기지 않는다", () => {
  assert.equal(marker({ branchHeadSha: OTHER }), false);
});

// 인수조건: 직전 릴리즈 이후 새 커밋이 없으면 마커가 연쇄로 쌓이지 않는다.
test("부모가 이미 마커 커밋이면 마커를 남기지 않는다", () => {
  assert.equal(marker({ parentMessage: releaseMarkerMessage("v1.3.1") }), false);
});

// 인수조건: 출시노트에 마커 커밋이 섞이지 않는다.
test("출시노트 집계에서 마커 커밋만 제외하고 나머지는 순서대로 남긴다", () => {
  const messages = [
    "환불 검토 운영 화면 추가 (#77)",
    "chore(release): v1.3.2",
    "fix: 태그 동기화 지연 대응 (#72)",
  ];

  assert.deepEqual(excludeReleaseMarkers(messages), [
    "환불 검토 운영 화면 추가 (#77)",
    "fix: 태그 동기화 지연 대응 (#72)",
  ]);
});
