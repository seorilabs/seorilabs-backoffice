import { prisma } from "@/lib/prisma";
import { embedQuery } from "@/lib/ai/embeddings";
import { unpackFloat32, cosine } from "@/lib/vault/pack";

// 볼트 검색(backoffice/platform 측). PVC 접근 없이 MySQL 의 vault_chunk 만 사용.
// ANN 인덱스가 없으므로 임베딩을 메모리에 캐시하고 brute-force cosine.
// 캐시는 (행수, 최신 indexedAt) 시그니처가 바뀌면 갱신.

export interface VaultHit {
  path: string;
  heading: string | null;
  text: string;
  score: number;
}

interface CacheEntry {
  id: string;
  path: string;
  vec: Float32Array;
}

let cache: CacheEntry[] | null = null;
let cacheSig = "";

async function signature(): Promise<string> {
  const agg = await prisma.vaultChunk.aggregate({
    _count: { _all: true },
    _max: { indexedAt: true },
  });
  return `${agg._count._all}:${agg._max.indexedAt?.getTime() ?? 0}`;
}

async function ensureCache(): Promise<CacheEntry[]> {
  const sig = await signature();
  if (cache && sig === cacheSig) return cache;
  // 임베딩만 로드(텍스트는 top-k 만 별도 조회 → 메모리 절약).
  const rows = await prisma.vaultChunk.findMany({
    select: { id: true, path: true, embedding: true },
  });
  cache = rows.map((r) => ({
    id: r.id,
    path: r.path,
    vec: unpackFloat32(r.embedding),
  }));
  cacheSig = sig;
  return cache;
}

/** 질의와 가장 가까운 청크 top-k. 빈 인덱스면 []. */
export async function searchVault(query: string, k = 6): Promise<VaultHit[]> {
  const q = query.trim();
  if (!q) return [];
  const entries = await ensureCache();
  if (entries.length === 0) return [];

  const qvec = await embedQuery(q);
  if (qvec.length === 0) return [];
  const qf = Float32Array.from(qvec);

  const scored = entries
    .map((e) => ({ id: e.id, score: cosine(qf, e.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const byId = new Map(scored.map((s) => [s.id, s.score]));
  const rows = await prisma.vaultChunk.findMany({
    where: { id: { in: scored.map((s) => s.id) } },
    select: { id: true, path: true, heading: true, text: true },
  });
  return rows
    .map((r) => ({
      path: r.path,
      heading: r.heading,
      text: r.text,
      score: byId.get(r.id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}

/** 챗 도구/프롬프트용 텍스트 블록. 출처 경로 포함. */
export async function searchVaultText(query: string, k = 6): Promise<string> {
  const hits = await searchVault(query, k);
  if (hits.length === 0) return "(볼트 인덱스에 관련 내용 없음)";
  return hits
    .map(
      (h, i) =>
        `[${i + 1}] ${h.path}${h.heading ? ` › ${h.heading}` : ""} (유사도 ${h.score.toFixed(3)})\n${h.text.slice(0, 700)}`,
    )
    .join("\n\n");
}

/** 경로/제목에 키워드가 포함된 문서 목록 열거(의미검색 아님, 정확). */
export async function browseVault(query: string, limit = 40): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await prisma.vaultChunk.findMany({
    where: { path: { contains: q } },
    distinct: ["path"],
    select: { path: true },
    orderBy: { path: "asc" },
    take: limit,
  });
  return rows.map((r) => r.path);
}

/** 특정 문서의 전체 본문(청크를 ord 순으로 결합). path 부분일치면 첫 매칭 사용. */
export async function readVaultDoc(
  pathQuery: string,
): Promise<{ path: string; text: string } | null> {
  const q = pathQuery.trim();
  if (!q) return null;
  // 정확 일치 우선, 없으면 부분일치 첫 문서.
  let target = q;
  const exact = await prisma.vaultChunk.count({ where: { path: q } });
  if (exact === 0) {
    const hit = await prisma.vaultChunk.findFirst({
      where: { path: { contains: q } },
      select: { path: true },
      orderBy: { path: "asc" },
    });
    if (!hit) return null;
    target = hit.path;
  }
  const rows = await prisma.vaultChunk.findMany({
    where: { path: target },
    orderBy: { ord: "asc" },
    select: { text: true },
  });
  if (rows.length === 0) return null;
  return { path: target, text: rows.map((r) => r.text).join("\n\n") };
}

/** 테스트/관리용 캐시 무효화. */
export function invalidateVaultCache(): void {
  cache = null;
  cacheSig = "";
}
