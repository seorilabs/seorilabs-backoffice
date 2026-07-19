// 모델이 머리말/코드펜스를 섞어 뱉어도 JSON 객체를 견고하게 추출.

export function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : s).trim();
}

// 첫 균형 잡힌 {...} 객체 문자열 추출(문자열 내 중괄호 무시).
export function extractObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 느슨한 JSON 파싱: 직접 → 코드펜스 제거 → 객체 추출 순으로 시도. */
export function parseLooseJson<T = unknown>(raw: string): T | null {
  const base = stripFences(raw);
  for (const cand of [base, extractObject(base)]) {
    if (!cand) continue;
    try {
      return JSON.parse(cand) as T;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}
