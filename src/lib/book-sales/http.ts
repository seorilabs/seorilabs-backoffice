import { verifyStaticToken } from "@/lib/security";
import { ZodError } from "zod";

// 최대 8,000행의 다국어 제목을 허용하고 Ingress 25MiB 한도 안에서 차단한다.
export const BOOK_SALES_MAX_BODY_BYTES = 24 * 1024 * 1024;

export async function handleBookSalesPost(
  header: string | null, token: string | undefined, readBody: () => Promise<string>,
  save: (raw: unknown) => Promise<{ runId: string; status: string }>,
) {
  if (!verifyStaticToken(header, token)) return { status: 401, body: { error: "unauthorized" } };
  try {
    const text = await readBody();
    if (Buffer.byteLength(text) > BOOK_SALES_MAX_BODY_BYTES) return { status: 413, body: { error: "payload too large" } };
    const result = await save(JSON.parse(text));
    return { status: 200, body: { ok: true, ...result } };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError || (error instanceof Error && /^BOOK_SALES_(FUTURE|PERIOD|ROW|NET)/.test(error.message))) return { status: 400, body: { error: "invalid book sales report" } };
    if (error instanceof Error && error.message === "BOOK_SALES_RUN_CONFLICT") return { status: 409, body: { error: "run content conflict" } };
    return { status: 500, body: { error: "book sales storage failed" } };
  }
}
