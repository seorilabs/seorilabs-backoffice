import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  connectionPresentation,
  deadLetterPresentation,
  environmentPresentation,
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
