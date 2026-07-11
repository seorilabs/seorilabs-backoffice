// 콘텐츠 수집 라우트의 부분 실패 판정(순수, 테스트 가능). 각 수집기 결과는 성공 결과
// 객체이거나 { error } 이다. 한 수집기라도 실패하면 ok=false 로 내려 크론/모니터링이
// 부분 실패를 정상으로 오인하지 않게 한다(개별 결과는 응답 본문에 그대로 포함).

/** 결과가 { error } 형태(실패)인지. */
export function isFailedPart(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

export interface ContentCollectSummary {
  ok: boolean; // 모든 수집기 성공일 때만 true
  failed: string[]; // 실패한 수집기 이름(부분 실패 명시)
}

/** 수집기별 (이름, 결과) → ok/failed 요약. ok 는 전부 성공(AND)일 때만 true. */
export function summarizeContentCollect(
  parts: { name: string; result: unknown }[],
): ContentCollectSummary {
  const failed = parts.filter((p) => isFailedPart(p.result)).map((p) => p.name);
  return { ok: failed.length === 0, failed };
}
