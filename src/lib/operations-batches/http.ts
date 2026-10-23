import { ZodError } from "zod";
import { verifyStaticToken } from "@/lib/security";
import { batchInputSchema } from "./contract";

export async function handleBatchPost(header: string | null, token: string | undefined, read: () => Promise<string>, save: (raw: unknown) => Promise<{ accepted: number }>) {
  if (!verifyStaticToken(header, token)) return { status: 401, body: { error: "unauthorized" } };
  try {
    const body = await read();
    if (Buffer.byteLength(body) > 2_000_000) return { status: 413, body: { error: "payload too large" } };
    return { status: 200, body: { ok: true, ...await save(batchInputSchema.parse(JSON.parse(body))) } };
  } catch (error) {
    const invalid = error instanceof SyntaxError || error instanceof ZodError || error instanceof Error && /^BATCH_(INVALID|RUN_CONFLICT)/.test(error.message);
    return { status: invalid ? 400 : 500, body: { error: invalid ? "invalid batch observation" : "batch storage failed" } };
  }
}
