import { getInstallationOctokit } from "@/lib/github/app";
import { readExactTagCommitSha } from "@/lib/github/release-write-operations";
import { excludeHistoricalReleaseMarkers } from "@/lib/core/release-marker-history";
import {
  compareStableSemVerTagsDesc,
  stableVersionTags,
} from "@/lib/core/stable-semver";

// 릴리즈/태그 관련 GitHub 조회. 출시노트 생성 + untagged 보정에 사용.

function splitRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/");
  return { owner, repo };
}

export interface VersionTag {
  name: string;
  sha: string;
}

/** exact refs/tags/vX.Y.Z만 읽고 annotated tag도 실제 commit까지 peel한다. */
export async function resolveStableTagSha(
  repoFullName: string,
  tag: string,
): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  return readExactTagCommitSha(octokit, { owner, repo, tag });
}

/** stable·후보·레거시를 포함한 전체 태그. 후보 순번 충돌 방지에 사용한다. */
export async function listRepositoryTags(
  repoFullName: string,
): Promise<VersionTag[]> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const tags = await octokit.paginate(octokit.rest.repos.listTags, {
    owner,
    repo,
    per_page: 100,
  });
  return tags.map((tag) => ({ name: tag.name, sha: tag.commit.sha }));
}

/** stable SemVer(vX.Y.Z) 태그 목록(내림차순). */
export async function listVersionTags(
  repoFullName: string,
  limit = 100,
): Promise<VersionTag[]> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  // snapshot/legacy 태그가 첫 페이지를 채워도 뒤 페이지의 stable 태그를 놓치지 않는다.
  // `limit`은 provider page size가 아니라 stable 정렬 이후 반환 개수다.
  const tags = await octokit.paginate(octokit.rest.repos.listTags, {
    owner,
    repo,
    per_page: 100,
  });
  return stableVersionTags(
    tags.map((tag) => ({ name: tag.name, sha: tag.commit.sha })),
  ).slice(0, limit);
}

/** version 직전(더 낮은) 릴리즈 태그. 없으면 null(첫 릴리스). */
export function previousTag(tags: VersionTag[], version: string): string | null {
  const idx = tags.findIndex((t) => t.name === version);
  if (idx >= 0) return tags[idx + 1]?.name ?? null;
  // 목록에 아직 없으면(반영 지연) semver 비교로 더 낮은 첫 태그.
  for (const t of tags) {
    if (compareStableSemVerTagsDesc(version, t.name) < 0) return t.name;
  }
  return tags[0]?.name ?? null;
}

export interface CompareResult {
  url: string;
  commitCount: number;
  prs: Array<{ number: number; title: string }>;
}

function extractPrs(messages: string[]): Array<{ number: number; title: string }> {
  const seen = new Set<number>();
  const out: Array<{ number: number; title: string }> = [];
  for (const m of messages) {
    const sq = m.match(/\(#(\d+)\)\s*$/); // squash: "제목 (#123)"
    const mg = m.match(/^Merge pull request #(\d+)/); // merge commit
    const num = sq ? Number(sq[1]) : mg ? Number(mg[1]) : null;
    if (num && !seen.has(num)) {
      seen.add(num);
      const title = sq
        ? m.replace(/\s*\(#\d+\)\s*$/, "").trim()
        : m.replace(/^Merge pull request #\d+ from \S+\s*/, "").trim();
      out.push({ number: num, title: title || m });
    }
  }
  return out;
}

/** base...head 비교 → 커밋 수 + 머지 PR 추출. */
export async function compareTags(
  repoFullName: string,
  base: string,
  head: string,
): Promise<CompareResult> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const res = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
  });
  // 마커 커밋 생성은 폐기됐지만 폐기 이전 커밋이 히스토리에 남아 있다. 읽기에서만 제외한다.
  const messages = excludeHistoricalReleaseMarkers(
    (res.data.commits ?? []).map((c) => c.commit.message.split("\n")[0]),
  );
  return {
    url: res.data.html_url,
    commitCount: messages.length,
    prs: extractPrs(messages),
  };
}

/** head_sha 를 가리키는 v* 태그(untagged 보정). 없으면 null. */
export async function findTagForSha(
  repoFullName: string,
  sha: string,
): Promise<string | null> {
  if (!sha) return null;
  try {
    const tags = await listVersionTags(repoFullName);
    return tags.find((t) => t.sha === sha)?.name ?? null;
  } catch {
    return null;
  }
}
