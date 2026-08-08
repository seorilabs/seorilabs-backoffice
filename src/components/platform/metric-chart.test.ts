import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlatformMetricChart } from "./index";
import type { PlatformMetricSample } from "@/lib/platform/metric-samples";

function sample(
  capturedAt: string,
  over: Partial<PlatformMetricSample> = {},
): PlatformMetricSample {
  return {
    capturedAt,
    totalUsers: 1000,
    hourlyActiveUsers: 5,
    dailyActiveUsers: 50,
    weeklyActiveUsers: 200,
    ...over,
  };
}

const SERIES = [
  sample("2026-08-08T09:00:00.000Z", { hourlyActiveUsers: 4 }),
  sample("2026-08-08T10:00:00.000Z", { hourlyActiveUsers: 9 }),
  sample("2026-08-08T11:00:00.000Z", { hourlyActiveUsers: 6 }),
];

describe("플랫폼 지표 시계열 차트", () => {
  it("샘플이 있으면 선을 그린다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformMetricChart, { samples: SERIES }),
    );

    assert.match(html, /<svg/);
    // 세 점이면 M...L...L... 형태의 path가 나온다.
    assert.match(html, /<path[^>]*d="M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L/);
    assert.doesNotMatch(html, /아직 표시할 시계열이 없습니다/);
  });

  it("활성과 전체를 서로 다른 차트로 그린다", () => {
    // 자릿수가 달라 한 축에 두면 활성 곡선이 바닥에 눌린다.
    // 축을 둘로 나누는 것은 더 나쁘다 — 눈금 선택만으로 아무
    // 상관관계나 만들어 낼 수 있다.
    const html = renderToStaticMarkup(
      createElement(PlatformMetricChart, { samples: SERIES }),
    );

    assert.match(html, /활성 사용자/);
    assert.match(html, /전체 사용자/);
    assert.equal((html.match(/<svg/g) ?? []).length, 2);
  });

  it("계열을 색만으로 구분하게 두지 않는다", () => {
    // 라이트 모드 aqua가 표면 대비 3:1 미만이라 relief가 필요하다.
    const html = renderToStaticMarkup(
      createElement(PlatformMetricChart, { samples: SERIES }),
    );

    // 직접 라벨: 이름과 마지막 값이 선 끝에 붙는다.
    assert.match(html, /1시간<\/text>|1시간 6/);
    assert.match(html, /24시간/);
    assert.match(html, /7일/);
    // 표 보기가 존재해야 한다.
    assert.match(html, /표로 보기/);
    assert.match(html, /<table/);
  });

  it("결측 구간에서 선을 끊는다", () => {
    // 백필이 불가능하므로 이어 그리면 없는 시간에도 그 정도였다는
    // 거짓을 보여준다.
    const gapped = [
      sample("2026-08-08T09:00:00.000Z"),
      sample("2026-08-08T13:00:00.000Z"),
      sample("2026-08-08T14:00:00.000Z"),
    ];
    const html = renderToStaticMarkup(
      createElement(PlatformMetricChart, { samples: gapped }),
    );

    assert.match(html, /수집이 누락된 구간이 3시간 있어/);
    // 끊긴 만큼 path가 늘어난다. 연속 3점이면 계열당 1개다.
    const continuous = renderToStaticMarkup(
      createElement(PlatformMetricChart, { samples: SERIES }),
    );
    const count = (s: string) => (s.match(/<path/g) ?? []).length;
    assert.ok(
      count(html) > count(continuous),
      `끊긴 차트의 path가 더 많아야 한다: ${count(html)} vs ${count(continuous)}`,
    );
  });

  it("수집 전에는 장애가 아니라 모으는 중으로 안내한다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformMetricChart, { samples: [], collecting: true }),
    );

    assert.match(html, /아직 표시할 시계열이 없습니다/);
    assert.match(html, /매시 정각에 수집합니다/);
    // 백필 불가를 함께 알린다. 과거가 채워지길 기다리면 안 된다.
    assert.match(html, /과거는 복원할 수 없어/);
  });

  it("수집이 설정되지 않은 경우와 구분한다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformMetricChart, { samples: [], collecting: false }),
    );

    assert.match(html, /수집이 설정되지 않았습니다/);
  });

  it("점이 하나뿐이어도 값이 보이게 마커를 남긴다", () => {
    // 수집 시작 직후가 이 상태다. 선이 안 그려져 빈 화면처럼 보이면
    // 수집이 안 되는 줄 알게 된다.
    const html = renderToStaticMarkup(
      createElement(PlatformMetricChart, { samples: [SERIES[0]] }),
    );

    assert.match(html, /<circle/);
  });
});
