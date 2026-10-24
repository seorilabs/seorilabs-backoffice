interface ConsoleOutcome {
  state: string;
  blocked?: readonly unknown[];
  results?: ReadonlyArray<{ errors: readonly unknown[]; storageErrors: readonly unknown[]; skipped?: readonly unknown[]; verification?: { expected: number; verified: number; mismatched: readonly unknown[] } }>;
  notification?: { state: string };
}

/** 공급자 결측과 작업 실패를 구분한다. 자료의 partial 상태는 그대로 보존한다. */
export function consoleExecutionFailed(result: ConsoleOutcome): boolean {
  return result.state === "failed" || result.notification?.state === "failed"
    || !!result.blocked?.length || !!result.results?.some((row) => row.errors.length || row.storageErrors.length || !!row.skipped?.length
      || !!row.verification && (row.verification.expected !== row.verification.verified || row.verification.mismatched.length > 0));
}
