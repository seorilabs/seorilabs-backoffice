import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  connectionPresentation,
  deadLetterPresentation,
  environmentPresentation,
  overviewConnectionState,
  overviewMessage,
  writeStatePresentation,
} from "./presentation";

describe("플랫폼 환경 표현", () => {
  it("Production과 Sandbox를 서로 다른 위험 색상으로 구분한다", () => {
    const production = environmentPresentation("production");
    const sandbox = environmentPresentation("sandbox");

    assert.deepEqual(production, { label: "Production 원장", tone: "red" });
    assert.deepEqual(sandbox, { label: "Sandbox 원장", tone: "amber" });
    assert.notEqual(production.tone, sandbox.tone);
  });

  it("알 수 없는 환경을 추측하지 않는다", () => {
    assert.deepEqual(environmentPresentation("future"), {
      label: "환경 미확인",
      tone: "neutral",
    });
  });
});

describe("플랫폼 운영 상태 표현", () => {
  it("dead-letter가 한 건이라도 있으면 확인 필요로 표시한다", () => {
    assert.deepEqual(deadLetterPresentation(0), {
      label: "0건 · 정상",
      tone: "green",
    });
    assert.deepEqual(deadLetterPresentation(2), {
      label: "2건 · 확인 필요",
      tone: "red",
    });
  });

  it("미확인 값을 정상으로 표현하지 않는다", () => {
    assert.equal(deadLetterPresentation(null).tone, "neutral");
    assert.equal(connectionPresentation("unavailable").tone, "red");
    assert.equal(writeStatePresentation("error").tone, "red");
    assert.deepEqual(writeStatePresentation("unknown"), {
      label: "결과 미확인",
      tone: "amber",
    });
    assert.deepEqual(writeStatePresentation("expired_unknown"), {
      label: "대조 필요",
      tone: "red",
    });
  });
});

describe("개요 연결 상태", () => {
  const base = {
    configured: true,
    reachable: true,
    deadLetterCount: 0,
    environmentMismatchCount: 0,
  };

  it("환경 불일치는 dead-letter와 같은 등급으로 degraded다", () => {
    // 서비스는 살아 있지만 운영자가 할 수 있는 일이 막혀 있다.
    // connected로 두면 화면이 초록이라 아무도 안 본다.
    assert.equal(
      overviewConnectionState({ ...base, environmentMismatchCount: 1 }),
      "degraded",
    );
    assert.equal(
      overviewConnectionState({ ...base, deadLetterCount: 1 }),
      "degraded",
    );
  });

  it("둘 다 없으면 connected다", () => {
    assert.equal(overviewConnectionState(base), "connected");
  });

  it("연결 자체가 안 되면 불일치보다 그게 먼저다", () => {
    // 응답을 못 받았으면 불일치 개수도 믿을 값이 아니다.
    assert.equal(
      overviewConnectionState({
        ...base,
        reachable: false,
        environmentMismatchCount: 3,
      }),
      "unavailable",
    );
    assert.equal(
      overviewConnectionState({ ...base, configured: false, reachable: false }),
      "unconfigured",
    );
  });
});

describe("개요 요약 문구", () => {
  const base = {
    configuredMessage: null,
    errorMessage: null,
    deadLetterCount: 0,
    environmentMismatchCount: 0,
  };

  it("환경 불일치를 dead-letter보다 먼저 알린다", () => {
    // dead-letter는 워커가 재시도하지만 환경 불일치는 사람이
    // regsync를 돌리기 전에는 저절로 낫지 않는다.
    const message = overviewMessage({
      ...base,
      deadLetterCount: 5,
      environmentMismatchCount: 1,
    });

    assert.match(message, /환경이 어긋나/);
    assert.doesNotMatch(message, /dead-letter/);
  });

  it("불일치가 없으면 dead-letter를 알린다", () => {
    assert.match(
      overviewMessage({ ...base, deadLetterCount: 1 }),
      /dead-letter/,
    );
  });

  it("설정·조회 오류가 있으면 그것이 우선한다", () => {
    assert.equal(
      overviewMessage({ ...base, configuredMessage: "설정 없음", environmentMismatchCount: 1 }),
      "설정 없음",
    );
    assert.equal(
      overviewMessage({ ...base, errorMessage: "조회 실패", environmentMismatchCount: 1 }),
      "조회 실패",
    );
  });
});
