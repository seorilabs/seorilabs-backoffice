type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const bytes = (value: unknown): string => typeof value === "string" && /^\d+$/.test(value) ? value
  : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "unknown";

/** query()의 두 번째 값은 다음 페이지 옵션이며, 공식 응답은 세 번째 값이다. */
export async function readQueryResult(
  response: readonly unknown[],
  readMetadata: (jobId: string, location?: string) => Promise<unknown>,
) {
  if (!Array.isArray(response[0])) throw new Error("BIGQUERY_RESULT_INVALID");
  const api = object(response[2]), reference = object(api.jobReference);
  const jobId = typeof reference.jobId === "string" && reference.jobId ? reference.jobId : null;
  const usage = {
    jobId, bytesProcessed: bytes(api.totalBytesProcessed), bytesBilled: bytes(api.totalBytesBilled),
    cacheHit: typeof api.cacheHit === "boolean" ? api.cacheHit : null,
  };
  if (jobId && (usage.bytesProcessed === "unknown" || usage.bytesBilled === "unknown" || usage.cacheHit === null)) {
    try {
      const metadata = object(await readMetadata(jobId, typeof reference.location === "string" ? reference.location : undefined));
      if (object(metadata.jobReference).jobId !== jobId) throw new Error("BIGQUERY_USAGE_JOB_MISMATCH");
      const query = object(object(metadata.statistics).query);
      if (usage.bytesProcessed === "unknown") usage.bytesProcessed = bytes(query.totalBytesProcessed);
      if (usage.bytesBilled === "unknown") usage.bytesBilled = bytes(query.totalBytesBilled);
      if (usage.cacheHit === null && typeof query.cacheHit === "boolean") usage.cacheHit = query.cacheHit;
    } catch {
      // 자료 조회가 성공했어도 비용 조회가 불가능할 수 있다. 행은 보존하고 일부 수집으로 기록한다.
    }
  }
  return { rows: response[0], usage, complete: usage.bytesProcessed !== "unknown" && usage.bytesBilled !== "unknown" && usage.cacheHit !== null && jobId !== null };
}
