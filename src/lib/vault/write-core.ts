import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

// 볼트 쓰기 큐. backoffice(platform)는 enqueue 만, 라이터(data ns)가 PVC 에 기록.
// 안전장치: 폴더 allowlist, 경로 탈출 차단, 덮어쓰기 금지(중복 시 -N 접미).

const MAX_CONTENT = 200_000;

function slugFilename(title: string): string {
  const base = title
    .replace(/[\/\\:*?"<>|\n\r\t]/g, " ") // 경로/제어문자 제거
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return base || "무제";
}

/** 쓰기 요청 적재(검토용 draft). 즉시 파일을 만들지 않고 큐에만 넣는다. */
export async function enqueueVaultWrite(input: {
  folder?: string;
  title: string;
  content: string;
  source?: string;
  requestedBy?: string;
}): Promise<{ id: string }> {
  const content = input.content.slice(0, MAX_CONTENT);
  const row = await prisma.vaultWriteRequest.create({
    data: {
      folder: input.folder?.trim() || "받은함",
      filename: slugFilename(input.title),
      content,
      source: input.source ?? "agent",
      requestedBy: input.requestedBy,
    },
  });
  return { id: row.id };
}

async function uniquePath(dir: string, base: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const name = i === 0 ? `${base}.md` : `${base}-${i}.md`;
    const full = path.join(dir, name);
    try {
      await fs.access(full);
    } catch {
      return full; // 존재하지 않음 → 사용
    }
  }
  return path.join(dir, `${base}-${Date.now()}.md`);
}

export interface DrainOptions {
  root: string;
  allowedFolders: string[];
  datePrefix?: string; // 파일명 앞에 붙일 날짜(예: "2026-06-25"). 미지정 시 생략.
  log?: (msg: string) => void;
}

export interface DrainResult {
  processed: number;
  done: number;
  failed: number;
}

export async function drainVaultWrites(opts: DrainOptions): Promise<DrainResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const root = path.resolve(opts.root);
  const allowed = new Set(opts.allowedFolders);

  const pending = await prisma.vaultWriteRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  log(`[vault-writer] PENDING ${pending.length}건`);

  let done = 0;
  let failed = 0;
  for (const req of pending) {
    try {
      if (!allowed.has(req.folder)) {
        throw new Error(`허용되지 않은 폴더: ${req.folder}`);
      }
      const dir = path.resolve(root, req.folder);
      // 경로 탈출 차단(allowlist 폴더 밖으로 못 나가게).
      if (dir !== path.join(root, req.folder)) {
        throw new Error(`경로 탈출 의심: ${req.folder}`);
      }
      await fs.mkdir(dir, { recursive: true });
      const base = opts.datePrefix
        ? `${opts.datePrefix} ${req.filename}`
        : req.filename;
      const full = await uniquePath(dir, base);
      await fs.writeFile(full, req.content, "utf8");
      const rel = path.relative(root, full);
      await prisma.vaultWriteRequest.update({
        where: { id: req.id },
        data: { status: "DONE", writtenPath: rel, processedAt: new Date() },
      });
      done++;
      log(`[vault-writer] 기록 ${rel}`);
    } catch (e) {
      failed++;
      await prisma.vaultWriteRequest.update({
        where: { id: req.id },
        data: {
          status: "FAILED",
          error: (e as Error).message.slice(0, 1000),
          processedAt: new Date(),
        },
      });
      log(`[vault-writer] 실패 ${req.id}: ${(e as Error).message}`);
    }
  }
  return { processed: pending.length, done, failed };
}
