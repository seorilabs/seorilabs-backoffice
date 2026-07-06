import assert from "node:assert/strict";
import test from "node:test";
import { buildGooglePlayUploadInputs } from "@/lib/core/gplay-inputs";

const ctx = { repoFullName: "seorilabs/lucid-chess", workflowFile: "deploy-google-play.yml" };

test("send_to_google_play 토글 감지 + 선언된 배포옵션/버전 채움", () => {
  const declared = new Set([
    "release_tag",
    "send_to_google_play",
    "track",
    "release_status",
    "version_name",
  ]);
  const out = buildGooglePlayUploadInputs(declared, "v1.1.1", ctx);
  assert.equal(out.send_to_google_play, "true");
  assert.equal(out.track, "internal");
  assert.equal(out.release_status, "completed");
  assert.equal(out.version_name, "1.1.1"); // v 접두 제거
});

test("upload / upload_to_internal 토글도 감지한다", () => {
  assert.equal(buildGooglePlayUploadInputs(new Set(["upload"]), "v2.0.0", ctx).upload, "true");
  assert.equal(
    buildGooglePlayUploadInputs(new Set(["upload_to_internal"]), "v2.0.0", ctx).upload_to_internal,
    "true",
  );
});

test("선언 안 된 입력은 넣지 않는다(422 방지)", () => {
  const out = buildGooglePlayUploadInputs(new Set(["send_to_google_play"]), "v1.0.0", ctx);
  assert.equal(out.send_to_google_play, "true");
  assert.equal(out.track, undefined);
  assert.equal(out.after_upload, undefined);
  assert.equal(out.version_name, undefined);
});

test("토글 없으면 태그를 포함한 명확한 에러(구버전 태그 함정)", () => {
  assert.throws(
    () => buildGooglePlayUploadInputs(new Set(["release_tag", "track"]), "v1.1.0", ctx),
    /태그 v1\.1\.0.*업로드 토글이 포함된 최신 태그/s,
  );
});
