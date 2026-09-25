import { getGoogleAccessToken } from "@/lib/google-play/service-account";

export interface GooglePlayTracksRelease {
  trackName: string;
  releaseName: string;
  status:
    | "completed"
    | "inProgress"
    | "halted"
    | "draft"
    | "unknown";
  userFraction?: number;
}

interface EditingTracksResponse {
  tracks?: Array<{
    track?: string;
    releases?: Array<{
      name?: string;
      status?: string;
      userFraction?: number;
    }>;
  }>;
}

function normalizeStatus(input: string | undefined): GooglePlayTracksRelease["status"] {
  switch (input) {
    case "completed":
      return "completed";
    case "inProgress":
      return "inProgress";
    case "halted":
      return "halted";
    case "draft":
      return "draft";
    default:
      return "unknown";
  }
}

export async function listGooglePlayTrackReleases(input: {
  packageName: string;
  editId: string;
  claims: { client_email: string; private_key: string; token_uri?: string };
  fetchImpl?: typeof fetch;
}): Promise<GooglePlayTracksRelease[]> {
  const { token } = await getGoogleAccessToken({ claims: input.claims });
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    input.packageName,
  )}/edits/${encodeURIComponent(input.editId)}/tracks`;
  const impl = input.fetchImpl ?? fetch;
  const response = await impl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Google Play tracks fetch failed (${response.status}) for ${input.packageName}: ${body.slice(0, 200)}`,
    );
  }
  const json = (await response.json()) as EditingTracksResponse;
  return (json.tracks ?? []).flatMap((track) => {
    const trackName = track.track ?? "unknown";
    return (track.releases ?? []).map((release) => ({
      trackName,
      releaseName: release.name ?? "unknown",
      status: normalizeStatus(release.status),
      ...(typeof release.userFraction === "number"
        ? { userFraction: release.userFraction }
        : {}),
    }));
  });
}
