import { getGoogleAccessToken, type GoogleServiceAccountClaims } from "@/lib/google-play/service-account";

export interface GooglePlayTracksRelease {
  trackName: string;
  releaseName: string;
  versionCodes: string[];
  status: "completed" | "inProgress" | "halted" | "draft";
  userFraction?: number;
}

interface TracksResponse {
  tracks?: Array<{ track?: string; releases?: Array<{
    name?: string; versionCodes?: string[]; status?: string; userFraction?: number;
  }> }>;
}

export async function listGooglePlayTrackReleases(input: {
  packageName: string;
  claims: GoogleServiceAccountClaims;
  fetchImpl?: typeof fetch;
}): Promise<GooglePlayTracksRelease[]> {
  const impl = input.fetchImpl ?? fetch;
  const { token } = await getGoogleAccessToken({ claims: input.claims, fetchImpl: impl });
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(input.packageName)}/edits`;
  const headers = { Authorization: `Bearer ${token}` };
  const created = await impl(base, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
  });
  if (!created.ok) throw new Error(`Google Play edit 생성 실패: ${created.status}`);
  const { id } = await created.json() as { id?: string };
  if (!id) throw new Error("Google Play edit 응답에 id 없음");
  const edit = `${base}/${encodeURIComponent(id)}`;
  try {
    const response = await impl(`${edit}/tracks`, { headers });
    if (!response.ok) throw new Error(`Google Play tracks 조회 실패: ${response.status}`);
    const json = await response.json() as TracksResponse;
    return (json.tracks ?? []).flatMap((track) =>
      (track.releases ?? []).flatMap((release) => {
        if (!track.track || !release.versionCodes?.length ||
            !["completed", "inProgress", "halted", "draft"].includes(release.status ?? "")) return [];
        return [{
          trackName: track.track,
          releaseName: release.name ?? release.versionCodes.join(","),
          versionCodes: release.versionCodes,
          status: release.status as GooglePlayTracksRelease["status"],
          ...(typeof release.userFraction === "number" ? { userFraction: release.userFraction } : {}),
        }];
      }));
  } finally {
    const deleted = await impl(edit, { method: "DELETE", headers });
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(`Google Play edit 정리 실패: ${deleted.status}`);
    }
  }
}
