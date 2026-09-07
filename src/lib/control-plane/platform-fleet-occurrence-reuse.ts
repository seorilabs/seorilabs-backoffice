/**
 * 이미 있는 Platform Fleet occurrence를 어떻게 쓸지 정한다.
 *
 * occurrence idempotency key는 `{scope, manifestDigest, appId}`뿐이라 같은 릴리스·앱의
 * 계획은 언제나 같은 occurrence를 만난다. 계획이 superseded 되면 run을 종료하고
 * `workKey`를 비우는데(unique 제약 해제), 그 뒤 같은 릴리스·앱에서 계획이 다시 필요해지면
 * — 저장소가 움직여 binding이 뒤처지면 — 이 occurrence를 다시 만난다.
 *
 * 그때 workKey가 null이라는 이유로 거부하면 producer가 영구히 409로 멈춘다. 그리고 그
 * 409는 실행 전체를 중단시키므로 **모든 앱의** reconcile이 함께 멈춘다.
 */
export type PlatformOccurrenceRun = {
  workKey: string | null;
};

export type PlatformOccurrenceReuse =
  | { kind: "REUSE_RUN"; index: number }
  | { kind: "CREATE_RUN" }
  | { kind: "CONFLICT" };

export function resolvePlatformOccurrenceReuse(input: {
  occurrenceDefinitionId: string;
  expectedDefinitionId: string;
  runs: readonly PlatformOccurrenceRun[];
  workKey: string;
}): PlatformOccurrenceReuse {
  if (input.occurrenceDefinitionId !== input.expectedDefinitionId) return { kind: "CONFLICT" };
  const index = input.runs.findIndex((run) => run.workKey === input.workKey);
  if (index >= 0) return { kind: "REUSE_RUN", index };
  // workKey를 아직 쥔 run이 하나라도 있으면 그건 다른 work다. 그대로 fail-closed한다.
  if (input.runs.some((run) => run.workKey !== null)) return { kind: "CONFLICT" };
  return { kind: "CREATE_RUN" };
}
