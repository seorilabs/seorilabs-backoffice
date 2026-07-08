import { env } from "@/lib/env";
import { notify, esc } from "@/lib/telegram/client";

// Godot 최신 stable 버전을 감지해, pin 된 버전과 다르면 Telegram 으로 알린다.
// 실제 bump(코드 수정)는 하지 않는다 — 감지+알림 전용. CronJob 이 주기 호출.

const RELEASES_API =
  "https://api.github.com/repos/godotengine/godot/releases?per_page=30";

// 릴리스 태그: "4.6.3-stable", "4.7-stable" 형태. 안정판만 취급(rc/dev/beta 제외).
const STABLE_TAG = /^(\d+\.\d+(?:\.\d+)?)-stable$/;

type GithubRelease = {
  tag_name?: string;
  prerelease?: boolean;
  draft?: boolean;
  html_url?: string;
  published_at?: string;
};

export type GodotCheckResult =
  | { status: "up_to_date"; pinned: string; latest: string }
  | { status: "outdated"; pinned: string; latest: string; url: string }
  | { status: "skipped"; reason: string };

// "4.6.3" → [4,6,3]. semver 비교(누락 자리 0 취급).
function parts(v: string): number[] {
  return v.split(".").map((n) => Number(n) || 0);
}

// a 가 b 보다 크면(더 최신) true.
function isNewer(a: string, b: string): boolean {
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// GitHub 릴리스 목록에서 최신 stable 버전과 릴리스 URL 을 뽑는다.
async function fetchLatestStable(): Promise<{ version: string; url: string }> {
  const res = await fetch(RELEASES_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "seorilabs-backoffice-godot-check",
    },
    // GitHub 캐시 회피(주 1회라 부담 없음).
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`GitHub releases API ${res.status}`);
  }
  const list = (await res.json()) as GithubRelease[];
  let best: { version: string; url: string } | null = null;
  for (const r of list) {
    if (r.prerelease || r.draft || !r.tag_name) continue;
    const m = STABLE_TAG.exec(r.tag_name);
    if (!m) continue;
    const version = m[1];
    if (!best || isNewer(version, best.version)) {
      best = { version, url: r.html_url ?? "" };
    }
  }
  if (!best) throw new Error("no stable release found");
  return best;
}

export async function checkGodotVersion(): Promise<GodotCheckResult> {
  const pinned = env.godotPinnedVersion().trim();
  if (!pinned) {
    return { status: "skipped", reason: "GODOT_PINNED_VERSION 미설정" };
  }

  const { version: latest, url } = await fetchLatestStable();

  // 최신이 pin 보다 더 높은 경우에만 알림(내려간 경우/동일은 무시).
  if (!isNewer(latest, pinned)) {
    return { status: "up_to_date", pinned, latest };
  }

  const text = [
    "🎮 <b>Godot 새 stable 릴리스 감지</b>",
    `현재 pin: <code>${esc(pinned)}</code> → 최신: <code>${esc(latest)}</code>`,
    "",
    "bump 시 함께 갱신:",
    "· global-versions.yaml (tools.godot.version)",
    "· godot-game 스킬 github-actions.md (GODOT_VERSION)",
    "· backoffice GODOT_PINNED_VERSION",
    "",
    `릴리스: ${esc(url)}`,
    "마이그레이션 노트 확인 후 승격하세요.",
  ].join("\n");
  await notify(text);

  return { status: "outdated", pinned, latest, url };
}
