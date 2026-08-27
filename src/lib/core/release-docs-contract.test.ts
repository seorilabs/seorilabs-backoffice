import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 릴리스 운영 원장(문서)이 코드 계약과 어긋나지 않게 고정한다.
// 폐기된 marker 정책이 문서로 되살아나거나, GitHub-first/Xcode-last 규칙이 문서에서
// 사라지면 운영자가 잘못된 절차를 따르게 된다.

const ORG_DOC = "docs/ci-cd/org-cicd-release-system.md";
const DEPLOY_DOC = "docs/DEPLOY.md";

function doc(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

// 인수조건: 문서 2종에서 marker 정책이 "운영 규칙"으로 남아 있지 않다.
test("문서에 릴리즈 마커 커밋 생성 절차가 남아 있지 않다", () => {
  for (const path of [ORG_DOC, DEPLOY_DOC]) {
    const text = doc(path);
    // 폐기 사실을 설명하는 문장은 허용하되, 생성 절차·함수 참조는 남기지 않는다.
    assert.equal(text.includes("pushReleaseMarkerCommit"), false, path);
    assert.match(text, /마커 커밋 정책은 폐기|마커 커밋 방식 폐기|폐기됐다/, path);
    // "빈 커밋을 push 한다" 류의 지시문이 남아 있으면 안 된다.
    assert.equal(/빈 커밋 .*push 하고 그 커밋에 태그를 단다/.test(text), false, path);
  }
});

// 인수조건: exact-source preflight 가 두 문서 모두에 원장화돼 있다.
test("문서에 exact-source preflight 가 원장화돼 있다", () => {
  const org = doc(ORG_DOC);
  assert.match(org, /fail-closed 소스 버전 계약/);
  assert.match(org, /scripts\/check_release_version\.py/);
  assert.match(org, /scripts\/resolve-release-version\.mjs/);
  assert.match(org, /default branch 의 exact SHA 를 고정/);
  assert.match(org, /bump 는 소스에 없는 버전을 만들지 않는다/);

  const deploy = doc(DEPLOY_DOC);
  assert.match(deploy, /exact SHA 를 고정/);
  assert.match(deploy, /소스에 없는 버전을 만들지 않는다/);
  assert.match(deploy, /pinned-source/);
});

// 인수조건: GitHub-first / Xcode-last 규칙이 두 문서 모두에 원장화돼 있다.
test("문서에 GitHub-first · Xcode-last 실행 순서가 원장화돼 있다", () => {
  for (const path of [ORG_DOC, DEPLOY_DOC]) {
    const text = doc(path);
    assert.match(text, /GitHub dispatch/, path);
    assert.match(text, /ciBuildRuns/, path);
    assert.match(text, /마지막/, path);
    // 순서가 뒤집혀 서술되지 않았는지: Xcode Cloud 를 먼저 트리거한다는 문장이 없어야 한다.
    assert.equal(/Xcode Cloud.{0,20}먼저 (트리거|실행)/.test(text), false, path);
  }

  const deploy = doc(DEPLOY_DOC);
  assert.match(deploy, /GitHub 이 거부하면 `ciBuildRuns` 는 0회로 남는다/);
  assert.match(deploy, /APPSTORE` 단독도 같은 preflight 를 전부 통과한 뒤에만/);
});
