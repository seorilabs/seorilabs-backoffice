import { getGoogleAccessToken, type GoogleServiceAccountClaims } from "@/lib/google-play/service-account";
import { PLAY_LIFECYCLES, playStateError, type PlayLifecycle, type PlayTrackStatus } from "@/lib/google-play/release-state";

export interface GooglePlayTracksRelease {
  trackName: string;
  releaseName: string;
  versionCodes: string[];
  status: PlayTrackStatus;
  userFraction?: number;
  lifecycle?: PlayLifecycle;
  unavailableReason?: string;
  rawResponse?: { trackRelease: TrackRelease; releaseSummaries: ReleaseSummary[] };
}

interface TrackRelease {
  name?: string; versionCodes?: string[]; status?: string; userFraction?: number;
}
interface ReleaseSummary {
  track?: string;
  activeArtifacts?: Array<{ versionCode?: number }>;
  releaseLifecycleState?: string;
}

// 릴리스 이름은 결합 키가 아니다. 각 코드가 두 응답에서 정확히 한 번씩
// 나타나고 모든 코드의 단계가 같아야만 정상 관측으로 받아들인다.
export function joinTrackReleases(trackName: string, releases: TrackRelease[], summaries: ReleaseSummary[]): GooglePlayTracksRelease[] {
  return releases.map((release) => {
    const codes = release.versionCodes ?? [];
    let reason = !codes.length || codes.some((code) => !/^[1-9]\d*$/.test(code)) ? "버전 코드 없음 또는 형식 오류" : null;
    const matches = codes.map((code) => {
      if (releases.filter((item) => item.versionCodes?.includes(code)).length !== 1 || codes.filter((item) => item === code).length !== 1) reason = "트랙 버전 코드 중복";
      const found = summaries.flatMap((summary) => (summary.activeArtifacts ?? [])
        .filter((artifact) => String(artifact.versionCode) === code).map(() => summary));
      if (found.length !== 1 || found[0]?.track !== trackName) reason = "출시 단계 버전·트랙 결합 실패";
      const state = found[0]?.releaseLifecycleState;
      return state?.startsWith("RELEASE_LIFECYCLE_STATE_") ? state.slice("RELEASE_LIFECYCLE_STATE_".length) : undefined;
    });
    const lifecycle = matches[0] as PlayLifecycle;
    if (!PLAY_LIFECYCLES.includes(lifecycle) || matches.some((state) => state !== lifecycle)) reason = "출시 단계 없음·알 수 없음·불일치";
    const status = release.status as PlayTrackStatus;
    reason ??= playStateError({ lifecycle, status, userFraction: release.userFraction ?? null });
    return {
      trackName, releaseName: release.name ?? codes.join(","), versionCodes: codes, status,
      ...(release.userFraction !== undefined ? { userFraction: release.userFraction } : {}),
      ...(reason ? { unavailableReason: reason } : { lifecycle }),
      rawResponse: { trackRelease: release, releaseSummaries: summaries },
    };
  });
}

export async function listGooglePlayTrackReleases(input: {
  packageName: string;
  claims: GoogleServiceAccountClaims;
  fetchImpl?: typeof fetch;
}): Promise<GooglePlayTracksRelease[]> {
  const impl = input.fetchImpl ?? fetch;
  const { token } = await getGoogleAccessToken({ claims: input.claims, fetchImpl: impl });
  const application = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(input.packageName)}`;
  const base = `${application}/edits`;
  const headers = { Authorization: `Bearer ${token}` };
  const created = await impl(base, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
  });
  if (!created.ok) throw new Error(`Google Play edit 생성 실패: ${created.status}`);
  const { id } = await readPlayJson<{ id?: string }>(created, "edit");
  if (!id) throw new Error("Google Play edit 응답에 id 없음");
  const edit = `${base}/${encodeURIComponent(id)}`;
  try {
    const response = await impl(`${edit}/tracks`, { headers });
    if (!response.ok) throw new Error(`Google Play tracks 조회 실패: ${response.status}`);
    const json = await readPlayJson<{ tracks?: Array<{ track?: string; releases?: TrackRelease[] }> }>(response, "tracks");
    const result: GooglePlayTracksRelease[] = [];
    const seen = new Set<string>();
    for (const track of json.tracks ?? []) {
      if (!track.track || seen.has(track.track)) throw new Error("Google Play 트랙 이름 없음 또는 중복");
      seen.add(track.track);
      // 빈 트랙은 출시 관측이 없으며 lifecycle API를 조회할 대상도 없다.
      if (!track.releases?.length) continue;
      let summaries: ReleaseSummary[] = [];
      let unavailableReason: string | undefined;
      try {
        const summaryResponse = await impl(`${application}/tracks/${encodeURIComponent(track.track)}/releases`, { method: "GET", headers });
        if (!summaryResponse.ok) throw new Error(`Google Play releases 조회 실패: ${summaryResponse.status}`);
        summaries = (await readPlayJson<{ releases?: ReleaseSummary[] }>(summaryResponse, "releases")).releases ?? [];
      } catch (error) {
        unavailableReason = error instanceof Error ? error.message : "Google Play releases 조회 실패";
      }
      if (!track.releases?.length && (unavailableReason || summaries.length)) throw new Error(unavailableReason ?? "트랙 릴리스와 출시 단계 응답 불일치");
      result.push(...joinTrackReleases(track.track, track.releases ?? [], summaries).map((release) =>
        unavailableReason ? { ...release, lifecycle: undefined, unavailableReason } : release));
    }
    return result;
  } finally {
    const deleted = await impl(edit, { method: "DELETE", headers });
    if (!deleted.ok && deleted.status !== 404) throw new Error(`Google Play edit 정리 실패: ${deleted.status}`);
  }
}

async function readPlayJson<T>(response: Response, resource: string): Promise<T> {
  const text = await response.text();
  if (!text.trim()) throw new Error(`Google Play ${resource} 응답 본문 없음`);
  try { return JSON.parse(text) as T; } catch { throw new Error(`Google Play ${resource} JSON 응답 형식 오류`); }
}
