import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { miniMaxEmbed } from "@/lib/ai/embeddings";
import { packFloat32 } from "@/lib/vault/pack";
import { chunkMarkdown } from "@/lib/vault/chunk";

// 볼트 인덱서 코어. data ns CronJob 에서 PVC(읽기전용)를 root 로 받아 실행.
// 증분: 파일 sha256 이 DB 의 path 별 fileHash 와 같으면 스킵. 사라진 path 는 청크 삭제.

export interface IndexOptions {
  root: string;
  excludeDirs?: string[];
  log?: (msg: string) => void;
}

export interface IndexResult {
  scanned: number;
  changed: number;
  unchanged: number;
  removed: number;
  chunks: number;
}

async function walkMarkdown(
  root: string,
  excludeDirs: Set<string>,
): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || excludeDirs.has(e.name)) continue;
        await rec(abs);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        out.push(abs);
      }
    }
  }
  await rec(root);
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function indexVaultCore(opts: IndexOptions): Promise<IndexResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const excludeDirs = new Set(opts.excludeDirs ?? []);
  const root = path.resolve(opts.root);

  const files = await walkMarkdown(root, excludeDirs);
  log(`[vault-index] 대상 .md ${files.length}개 (root=${root})`);

  // DB 의 path 별 현재 fileHash 맵.
  const existing = await prisma.vaultChunk.findMany({
    distinct: ["path"],
    select: { path: true, fileHash: true },
  });
  const dbHash = new Map(existing.map((r) => [r.path, r.fileHash]));
  const seen = new Set<string>();

  let changed = 0;
  let unchanged = 0;
  let chunkTotal = 0;

  for (const abs of files) {
    const rel = path.relative(root, abs);
    seen.add(rel);
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (e) {
      log(`[vault-index] 읽기 실패 skip: ${rel} (${(e as Error).message})`);
      continue;
    }
    const hash = sha256(content);
    if (dbHash.get(rel) === hash) {
      unchanged++;
      continue;
    }

    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) {
      // 빈 파일/헤딩만 → 기존 청크 정리하고 넘어감.
      await prisma.vaultChunk.deleteMany({ where: { path: rel } });
      changed++;
      continue;
    }

    let vectors: number[][];
    try {
      vectors = await miniMaxEmbed(
        chunks.map((c) => c.text),
        "db",
      );
    } catch (e) {
      log(`[vault-index] 임베딩 실패 skip: ${rel} (${(e as Error).message})`);
      continue;
    }

    await prisma.$transaction([
      prisma.vaultChunk.deleteMany({ where: { path: rel } }),
      prisma.vaultChunk.createMany({
        data: chunks.map((c, i) => ({
          path: rel,
          ord: c.ord,
          heading: c.heading,
          text: c.text,
          fileHash: hash,
          embedding: packFloat32(vectors[i] ?? []),
          dim: vectors[i]?.length ?? 0,
          chars: c.text.length,
        })),
      }),
    ]);
    changed++;
    chunkTotal += chunks.length;
    log(`[vault-index] 갱신 ${rel} (${chunks.length} chunks)`);
  }

  // 디스크에서 사라진 path 의 청크 삭제.
  let removed = 0;
  for (const p of dbHash.keys()) {
    if (!seen.has(p)) {
      const r = await prisma.vaultChunk.deleteMany({ where: { path: p } });
      removed += r.count > 0 ? 1 : 0;
    }
  }

  const result: IndexResult = {
    scanned: files.length,
    changed,
    unchanged,
    removed,
    chunks: chunkTotal,
  };
  log(`[vault-index] 완료 ${JSON.stringify(result)}`);
  return result;
}
