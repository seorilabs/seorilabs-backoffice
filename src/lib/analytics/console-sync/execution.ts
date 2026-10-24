interface ConsoleOutcome {
  state: string;
  blocked?: readonly unknown[];
  results?: ReadonlyArray<{ errors: readonly unknown[]; storageErrors: readonly unknown[]; skipped?: readonly unknown[]; verification?: { expected: number; verified: number; mismatched: readonly unknown[] } }>;
  notification?: { state: string };
}

/** 공급자 결측과 작업 실패를 구분한다. 자료의 partial 상태는 그대로 보존한다. */
export function consoleExecutionFailed(result: ConsoleOutcome): boolean {
  return result.state === "failed" || result.notification?.state === "failed"
    || !!result.blocked?.length || !!result.results?.some((row) => row.errors.length || row.storageErrors.length || rejectedConsoleSkips(row.skipped ?? []).length > 0
      || !!row.verification && (row.verification.expected !== row.verification.verified || row.verification.mismatched.length > 0));
}


/** 정상 대상 제외는 명시적 분류만 인정한다. 매핑 오류를 정상 제외로 추정하지 않는다. */
export function rejectedConsoleSkips(skipped: readonly unknown[]): readonly unknown[] {
  return skipped.filter((item) => !item || typeof item !== "object" || !("category" in item) || item.category !== "excluded");
}
export function consoleExecutionSkipped(result: ConsoleOutcome): boolean {
  if (consoleExecutionFailed(result)) return false;
  return result.state === "already_running" || !!result.results?.length && result.results.every((row) =>
    !!row.skipped?.length && rejectedConsoleSkips(row.skipped).length === 0 && row.verification?.expected === 0);
}
