import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addedBlockedVersions,
  compareVersionsDesc,
  joinVersions,
  needsBlockConfirmation,
  platformUpdatePolicyConfirmationText,
  sameVersion,
  splitVersions,
  type UpdatePolicyPlatformInput,
  type UpdatePolicyPlatformView,
} from "./update-policy";

function view(versions: string[]): UpdatePolicyPlatformView {
  return { blockedVersions: versions.map((version) => ({ version })) };
}

function input(
  platform: "android" | "ios",
  blockedVersions: string[],
  recommendOverride = "",
): UpdatePolicyPlatformInput {
  return { platform, blockedVersions, recommendOverride };
}

describe("버전 비교", () => {
  // 서버는 자리 수가 모자라도 0으로 채운다. 여기서만 엄격하면 같은 빌드를
  // 다르다고 판정해 확인 문구가 어긋난다.
  it("v 접두사와 자리 수가 달라도 같은 빌드로 본다", () => {
    assert.equal(sameVersion("1.4.0", "v1.4.0"), true);
    assert.equal(sameVersion("1.4", "1.4.0"), true);
    assert.equal(sameVersion("1.4.0", "1.4.1"), false);
  });

  it("해석 불가한 값은 원문으로 비교한다", () => {
    assert.equal(sameVersion("nightly", "nightly"), true);
    assert.equal(sameVersion("nightly", "1.4.0"), false);
  });

  it("최신 빌드를 먼저 두고 해석 불가한 값을 뒤로 보낸다", () => {
    const sorted = ["1.4.0", "build-x", "1.10.0", "1.5.0"].sort(compareVersionsDesc);
    assert.deepEqual(sorted, ["1.10.0", "1.5.0", "1.4.0", "build-x"]);
  });
});

describe("버전 목록 직렬화", () => {
  it("쉼표 문자열과 배열을 오간다", () => {
    assert.equal(joinVersions(["1.4.0", "1.4.1"]), "1.4.0,1.4.1");
    assert.deepEqual(splitVersions(" 1.4.0 , 1.4.1 "), ["1.4.0", "1.4.1"]);
    assert.deepEqual(splitVersions(""), []);
  });
});

describe("새로 추가되는 강제 대상", () => {
  it("이미 막혀 있던 버전은 새 추가로 세지 않는다", () => {
    const added = addedBlockedVersions(
      { android: view(["1.4.0"]) },
      [input("android", ["1.4.0", "1.4.1"])],
    );
    assert.deepEqual(added.android, ["1.4.1"]);
    assert.deepEqual(added.ios, []);
  });

  it("v 접두사만 다른 재저장은 새 추가가 아니다", () => {
    const added = addedBlockedVersions(
      { android: view(["1.4.0"]) },
      [input("android", ["v1.4.0"])],
    );
    assert.deepEqual(added.android, []);
  });

  // 되돌리기는 언제나 즉시 가능해야 한다.
  it("해제에는 새 추가가 없다", () => {
    const added = addedBlockedVersions(
      { android: view(["1.4.0"]) },
      [input("android", [])],
    );
    assert.deepEqual(added.android, []);
  });
});

describe("확인 문구", () => {
  // 서버 구현과 같은 규칙이어야 한다. 어긋나면 운영자가 이유를 알 수 없는
  // 거절을 받는다.
  it("플랫폼·버전 정렬 순으로 이어 붙인다", () => {
    const text = platformUpdatePolicyConfirmationText("happy-farm", {
      ios: ["2.0.0"],
      android: ["1.4.1", "1.4.0"].sort(),
    });
    assert.equal(
      text,
      "BLOCK happy-farm android 1.4.0; BLOCK happy-farm android 1.4.1; BLOCK happy-farm ios 2.0.0",
    );
  });

  it("새로 막는 버전이 없으면 빈 문자열이다", () => {
    assert.equal(
      platformUpdatePolicyConfirmationText("happy-farm", { android: [], ios: [] }),
      "",
    );
  });
});

describe("강제 추가 확인", () => {
  // 강제가 한 번의 클릭으로 등록되면 안 된다.
  it("새로 막는 버전이 있으면 문구를 그대로 입력해야 한다", () => {
    const text = "BLOCK happy-farm android 1.4.0";
    assert.equal(needsBlockConfirmation(text, undefined), true);
    assert.equal(needsBlockConfirmation(text, ""), true);
    assert.equal(needsBlockConfirmation(text, "BLOCK happy-farm android 1.4.1"), true);
    assert.equal(needsBlockConfirmation(text, text), false);
  });

  // 해제와 권장 변경은 확인 없이 통과한다. 되돌리기가 막히면 사고 대응이
  // 불가능해진다.
  it("새로 막는 버전이 없으면 확인이 없다", () => {
    assert.equal(needsBlockConfirmation("", undefined), false);
    assert.equal(needsBlockConfirmation("", "아무거나"), false);
  });
});
