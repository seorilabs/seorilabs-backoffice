import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { joinTrackReleases, listGooglePlayTrackReleases } from "@/lib/google-play/tracks-fetcher";
import { resetGoogleTokenCache } from "@/lib/google-play/service-account";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const claims = {
  client_email: "test@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://example.invalid/token",
};
const release = { name: "1.0.1", versionCodes: ["101"], status: "completed" };
const summary = { track: "production", activeArtifacts: [{ versionCode: 101 }], releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" };

function fixture(input: { summaryStatus?: number; summaries?: object[]; tracksStatus?: number; tracks?: object[]; deleteStatus?: number; emptySummaries?: boolean } = {}) {
  resetGoogleTokenCache();
  const calls: Array<{ path: string; method: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("Authorization") });
    if (path === "/token") return Response.json({ access_token: "test", expires_in: 3600, token_type: "Bearer" });
    if (path.endsWith("/edits") && init?.method === "POST") return Response.json({ id: "real-edit-1" });
    if (path.endsWith("/edits/real-edit-1/tracks")) return Response.json({ tracks: input.tracks ?? [{ track: "production", releases: [release] }] }, { status: input.tracksStatus ?? 200 });
    if (path.endsWith("/tracks/production/releases")) return input.emptySummaries ? new Response(null, { status: 200 }) : Response.json({ releases: input.summaries ?? [summary] }, { status: input.summaryStatus ?? 200 });
    if (path.endsWith("/edits/real-edit-1") && init?.method === "DELETE") return new Response(null, { status: input.deleteStatus ?? 204 });
    throw new Error("unexpected request");
  };
  return { calls, run: () => listGooglePlayTrackReleases({ packageName: "com.example.test", claims, fetchImpl }) };
}

test("트랙별 releases GET은 같은 토큰을 재사용하고 edit을 정리하며 commit하지 않는다", async () => {
  const { calls, run } = fixture();
  const releases = await run();
  assert.equal(releases[0]?.lifecycle, "PUBLISHED");
  assert.equal(releases[0]?.status, "completed");
  assert.deepEqual(calls.map((item) => item.method), ["POST", "POST", "GET", "GET", "DELETE"]);
  assert.ok(calls[3]?.path.endsWith("/applications/com.example.test/tracks/production/releases"));
  assert.ok(calls.slice(1).every((item) => item.authorization === "Bearer test"));
  assert.ok(calls.every((item) => !item.path.includes("commit")));
});

for (const status of [403, 500]) test(`releases HTTP ${status}는 확인 불가로 반환하고 edit을 삭제한다`, async () => {
  const { calls, run } = fixture({ summaryStatus: status });
  const result = await run();
  assert.match(result[0]!.unavailableReason!, new RegExp(String(status)));
  assert.equal(result[0]!.lifecycle, undefined);
  assert.equal(calls.at(-1)?.method, "DELETE");
});

test("tracks 오류와 edit 정리 오류는 수집 실패다", async () => {
  const tracks = fixture({ tracksStatus: 403 });
  await assert.rejects(tracks.run, /tracks 조회 실패: 403/);
  assert.equal(tracks.calls.at(-1)?.method, "DELETE");
  await assert.rejects(fixture({ deleteStatus: 500 }).run, /edit 정리 실패: 500/);
});

test("빈 tracks는 빈 관측이고 비어 있는 releases 응답은 기존 버전을 공개로 추정하지 않는다", async () => {
  assert.deepEqual(await fixture({ tracks: [] }).run(), []);
  assert.ok((await fixture({ summaries: [] }).run())[0]?.unavailableReason);
});

test("알 수 없는 단계·트랙 상태와 출시율 누락·잘못된 값은 확인 불가다", () => {
  for (const state of [undefined, "RELEASE_LIFECYCLE_STATE_UNSPECIFIED", "FUTURE_STATE"]) {
    assert.ok(joinTrackReleases("production", [release], [{ ...summary, releaseLifecycleState: state }])[0]?.unavailableReason);
  }
  for (const bad of [{ ...release, status: "future" }, { ...release, status: "inProgress" }, { ...release, userFraction: 0.5 }, { ...release, status: "inProgress", userFraction: 1.2 }]) {
    assert.ok(joinTrackReleases("production", [bad], [summary])[0]?.unavailableReason);
  }
});

test("버전·트랙이 일치해야 하며 이름·최신 버전으로 대체 결합하지 않는다", () => {
  for (const bad of [{ ...summary, track: "internal" }, { ...summary, activeArtifacts: [{ versionCode: 102 }] }]) {
    assert.ok(joinTrackReleases("production", [release], [bad])[0]?.unavailableReason);
  }
  assert.equal(joinTrackReleases("production", [{ ...release, name: "renamed" }], [summary])[0]?.lifecycle, "PUBLISHED");
});

test("중복 매칭과 트랙의 초안·완료 충돌에서 임의 선택하지 않는다", () => {
  assert.ok(joinTrackReleases("production", [release], [summary, summary])[0]?.unavailableReason);
  assert.ok(joinTrackReleases("production", [release], [{ ...summary, activeArtifacts: [{ versionCode: 101 }, { versionCode: 101 }] }])[0]?.unavailableReason);
  const result = joinTrackReleases("production", [release, { ...release, status: "draft" }], [summary]);
  assert.ok(result.every((item) => item.unavailableReason));
});

test("여러 versionCode는 각 매칭이 유일하고 모든 출시 단계가 같아야 한다", () => {
  const multiple = { ...release, versionCodes: ["101", "102"] };
  const second = { ...summary, activeArtifacts: [{ versionCode: 102 }] };
  assert.equal(joinTrackReleases("production", [multiple], [summary, second])[0]?.lifecycle, "PUBLISHED");
  assert.ok(joinTrackReleases("production", [multiple], [summary])[0]?.unavailableReason);
  assert.ok(joinTrackReleases("production", [multiple], [summary, { ...second, releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_IN_REVIEW" }])[0]?.unavailableReason);
});

test("성공이지만 본문 없는 releases는 확인 불가로 구분하고 JSON 파싱 오류를 노출하지 않음", async () => {
  const releases = await fixture({ emptySummaries: true }).run();
  assert.match(releases[0]!.unavailableReason!, /응답 본문 없음/);
  assert.equal(releases[0]!.lifecycle, undefined);
});
test("사용하지 않는 빈 트랙 때문에 정상 트랙 수집을 실패시키지 않음", async () => {
  const result = await fixture({ tracks: [{ track: "production", releases: [release] }, { track: "internal", releases: [] }] }).run();
  assert.equal(result[0]?.lifecycle, "PUBLISHED");
});
