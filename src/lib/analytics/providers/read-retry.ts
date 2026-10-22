const retryable = new Set([429, 500, 502, 503, 504]);
interface ReadOptions {
  request?: typeof fetch;
  timeoutMs?: number;
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** 조회 전용 공급자 경계에서만 사용한다. OAuth와 외부 쓰기는 호출하지 않는다. */
export async function fetchReadWithRetry(input: Parameters<typeof fetch>[0], init: RequestInit = {}, options: ReadOptions = {}) {
  const request = options.request ?? fetch, now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random, started = now(), budget = options.budgetMs ?? 90_000;
  for (let attempt = 0; ; attempt++) {
    const remaining = budget - (now() - started);
    if (remaining <= 0) throw new DOMException("Provider read budget exhausted", "TimeoutError");
    const signal = AbortSignal.any([AbortSignal.timeout(Math.min(options.timeoutMs ?? 30_000, remaining)), ...(init.signal ? [init.signal] : [])]);
    let response: Response | undefined;
    try {
      response = await request(input, { ...init, signal });
      if (!retryable.has(response.status) || attempt >= 2) return response;
    } catch (error) {
      if (attempt >= 2 || init.signal?.aborted || !(error instanceof Error) || !["AbortError", "TimeoutError", "TypeError"].includes(error.name)) throw error;
    }
    const header = response?.headers.get("retry-after");
    const delay = header !== null && header !== undefined
      ? /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - now())
      : 1000 * 2 ** attempt + Math.floor(random() * 250);
    const wait = Number.isFinite(delay) ? delay : 1000 * 2 ** attempt;
    if (wait >= budget - (now() - started)) {
      if (response) return response;
      throw new DOMException("Provider read retry budget exhausted", "TimeoutError");
    }
    await response?.body?.cancel();
    await sleep(wait);
  }
}
