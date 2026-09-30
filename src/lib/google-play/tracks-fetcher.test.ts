import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { collapseSameVersionReleases, listGooglePlayTrackReleases } from "@/lib/google-play/tracks-fetcher";
import { resetGoogleTokenCache } from "@/lib/google-play/service-account";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const claims = {
  client_email: "test@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

test("Google edit 생성, 트랙 조회, edit 삭제 순서를 지킨다", async () => {
  resetGoogleTokenCache();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/token") return Response.json({ access_token: "test", expires_in: 3600, token_type: "Bearer" });
    if (path.endsWith("/edits") && init?.method === "POST") return Response.json({ id: "real-edit-1" });
    if (path.endsWith("/edits/real-edit-1/tracks")) return Response.json({
      tracks: [{ track: "internal", releases: [{ name: "1.0.1", versionCodes: ["101"], status: "completed" }] }],
    });
    if (path.endsWith("/edits/real-edit-1") && init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error("unexpected request");
  };
  const releases = await listGooglePlayTrackReleases({
    packageName: "com.example.test",
    claims: { ...claims, token_uri: "https://example.invalid/token" },
    fetchImpl,
  });
  assert.equal(releases[0]?.status, "completed");
  assert.deepEqual(calls.map((item) => item.split(" ")[0]), ["POST", "POST", "GET", "DELETE"]);
  assert.ok(calls[2]?.includes("/edits/real-edit-1/tracks"));
});

test("같은 트랙·버전 코드의 초안과 출시본은 출시본 하나로 합친다", () => {
  const releases = collapseSameVersionReleases([
    { trackName: "alpha", releaseName: "0.3.0 (8)", versionCodes: ["8"], status: "draft" },
    { trackName: "alpha", releaseName: "v0.3.0", versionCodes: ["8"], status: "completed" },
    { trackName: "internal", releaseName: "0.3.0 (8)", versionCodes: ["8"], status: "completed" },
    { trackName: "alpha", releaseName: "0.4.0 (9)", versionCodes: ["9"], status: "draft" },
  ]);
  assert.deepEqual(releases.map((item) => `${item.trackName}:${item.versionCodes[0]}:${item.status}`), [
    "alpha:8:completed", "internal:8:completed", "alpha:9:draft",
  ]);
});
