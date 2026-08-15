import assert from "node:assert/strict";
import { test } from "node:test";
import { computeRepoSeed, type Octo, type RepoLite } from "./compute";

// seedRepo 통합 경로 회귀 테스트: octokit(getContent) 워크플로우 존재 read → deriveMarketTargets → configHash.
// deriveMarketTargets 단위 테스트(market-targets.test.ts)는 순수 함수만 검증하므로,
// 여기서는 그 앞단(레포 파일 존재 판정)과 뒷단(configHash)이 실제로 배선돼 있는지를 가짜 octokit 으로 고정한다.
// 목적: "config 만 있고 배포 워크플로우가 없으면 marketTargets 에 play/appstore/ait 가 들어가지 않는다"는
//       계약이 seedRepo 경로에서 회귀하지 않도록(= config 존재 기반으로 되돌아가지 않도록) CI 로 가드한다.

// getContent 를 흉내내는 최소 octokit. present 에 있는 경로만 파일로 resolve 하고, 없으면 404(throw).
// pathExists 는 throw 여부로 존재를 판정하고, getText/getJson 은 base64 content 를 디코드한다.
function fakeOctokit(present: Record<string, string>): Octo {
  return {
    rest: {
      repos: {
        async getContent({ path }: { path: string }) {
          if (!(path in present)) {
            const err = new Error(`Not Found: ${path}`) as Error & { status: number };
            err.status = 404;
            throw err;
          }
          return {
            data: {
              type: "file" as const,
              content: Buffer.from(present[path], "utf8").toString("base64"),
            },
          };
        },
      },
    },
  } as unknown as Octo;
}

const ORG = "seorilabs";
const REPO: RepoLite = {
  name: "sample-game",
  full_name: "seorilabs/sample-game",
  id: 42,
  private: true,
  defaultBranch: "main",
};

const PLAY_CFG = JSON.stringify({
  packageName: "com.seorilabs.sample",
  appType: "game",
  storeListing: { appName: "Sample Game" },
});
const APPSTORE_CFG = JSON.stringify({
  bundleId: "com.seorilabs.sample",
  appleTeamId: "TEAM123",
  sku: "sample-sku",
  appType: "game",
});
const NESTED_APPSTORE_CFG = JSON.stringify({
  app: {
    bundleId: "com.seorilabs.nested",
    appleTeamId: "TEAM456",
    sku: "nested-sku",
    appType: "game",
  },
});
const FIREBASERC = JSON.stringify({ projects: { default: "seorilabs-sample" } });

const WF_PLAY = ".github/workflows/deploy-google-play.yml";
const WF_APPSTORE = ".github/workflows/deploy-app-store.yml";
const WF_AIT = ".github/workflows/deploy-apps-in-toss.yml";
const OPS_MANIFEST = ".seorilabs/backoffice.json";

// Godot 게임 실제 사례: project.godot + play/app-store config 는 있지만
// 표준 배포 워크플로우는 없고 deploy-godot-pages.yml 만 있다(=/deploy 404 근본 원인 시나리오).
const godotConfigOnly: Record<string, string> = {
  "project.godot": "[application]",
  "play-store/google-play.config.json": PLAY_CFG,
  "app-store/app-store.config.json": APPSTORE_CFG,
  ".firebaserc": FIREBASERC,
  ".github/workflows/deploy-godot-pages.yml": "name: pages", // 표준 배포 caller 아님 → 무시돼야 함
};

test("배포 워크플로우 3종 존재 → marketTargets=[play,appstore,ait], configHash 가 이를 반영", async () => {
  const seed = await computeRepoSeed(
    fakeOctokit({
      "package.json": "{}",
      "play-store/google-play.config.json": PLAY_CFG,
      "app-store/app-store.config.json": APPSTORE_CFG,
      ".firebaserc": FIREBASERC,
      [WF_PLAY]: "name: play",
      [WF_APPSTORE]: "name: appstore",
      [WF_AIT]: "name: ait",
    }),
    ORG,
    REPO,
  );
  assert.ok(seed);
  assert.deepEqual(seed.marketTargets, ["play", "appstore", "ait"]);
  assert.equal(seed.configHash.length, 64); // sha256 hex
});

test("config 만 있고 표준 배포 워크플로우 없음(Godot pages-only) → marketTargets 에 play/appstore/ait 없음", async () => {
  const seed = await computeRepoSeed(fakeOctokit(godotConfigOnly), ORG, REPO);
  assert.ok(seed);
  // 핵심 계약: config(play/app-store) 존재만으로는 dispatch 대상이 아니다.
  assert.deepEqual(seed.marketTargets, []);
  // config 는 marketTargets 와 분리돼 다른 필드 산출에는 그대로 쓰인다(회귀 방지).
  assert.equal(seed.playPackage, "com.seorilabs.sample");
  assert.equal(seed.iosBundle, "com.seorilabs.sample");
  assert.equal(seed.appleTeamId, "TEAM123");
  assert.equal(seed.iosSku, "sample-sku");
  assert.equal(seed.firebaseProject, "seorilabs-sample");
  assert.equal(seed.type, "GAME");
  assert.equal(seed.engine, "GODOT");
});

test("중첩형 app.* App Store 설정 → iOS 식별자와 appstore 마켓 대상 시드", async () => {
  const seed = await computeRepoSeed(
    fakeOctokit({
      "project.godot": "[application]",
      "app-store/app-store.config.json": NESTED_APPSTORE_CFG,
      [WF_APPSTORE]: "name: appstore",
    }),
    ORG,
    REPO,
  );
  assert.ok(seed);
  assert.equal(seed.iosBundle, "com.seorilabs.nested");
  assert.equal(seed.appleTeamId, "TEAM456");
  assert.equal(seed.iosSku, "nested-sku");
  assert.equal(seed.type, "GAME");
  assert.deepEqual(seed.marketTargets, ["appstore"]);
});

test("동일 config 라도 배포 워크플로우가 나중에 추가되면 configHash 변동(stale skip 방지)", async () => {
  const before = await computeRepoSeed(fakeOctokit(godotConfigOnly), ORG, REPO);
  // config 는 그대로 두고 deploy-google-play.yml 만 추가.
  const after = await computeRepoSeed(
    fakeOctokit({ ...godotConfigOnly, [WF_PLAY]: "name: play" }),
    ORG,
    REPO,
  );
  assert.ok(before && after);
  assert.notEqual(before.configHash, after.configHash); // 워크플로우 존재 신호가 hash 에 반영됨
  assert.deepEqual(before.marketTargets, []);
  assert.deepEqual(after.marketTargets, ["play"]);
});

test("동일 read 결과 → 동일 configHash (결정적, configSyncedAt 은 hash 입력에서 제외)", async () => {
  const a = await computeRepoSeed(fakeOctokit(godotConfigOnly), ORG, REPO);
  const b = await computeRepoSeed(fakeOctokit(godotConfigOnly), ORG, REPO);
  assert.ok(a && b);
  assert.equal(a.configHash, b.configHash);
});

test("게임 저장소의 관리툴 manifest를 검증해 시드하고 변경을 configHash에 반영한다", async () => {
  const base = {
    "package.json": "{}",
    [OPS_MANIFEST]: JSON.stringify({
      version: 1,
      tools: [
        {
          id: "flags",
          section: "flags",
          title: "Feature Flags",
          description: "게임 기능 플래그를 조회합니다.",
          operations: [
            {
              id: "list",
              label: "목록 조회",
              intent: "read",
            },
          ],
        },
      ],
    }),
  };
  const before = await computeRepoSeed(fakeOctokit(base), ORG, REPO);
  const after = await computeRepoSeed(
    fakeOctokit({
      ...base,
      [OPS_MANIFEST]: JSON.stringify({
        version: 1,
        tools: [
          {
            id: "flags",
            section: "flags",
            title: "Feature Flags",
            description: "게임 기능 플래그를 조회하고 변경합니다.",
            operations: [
              { id: "list", label: "목록 조회", intent: "read" },
              {
                id: "set",
                label: "값 변경",
                intent: "mutate",
                risk: "medium",
                confirmation: "reason",
              },
            ],
          },
        ],
      }),
    }),
    ORG,
    REPO,
  );
  assert.ok(before && after);
  assert.equal(before.opsManifestError, null);
  assert.equal(before.opsManifest?.tools[0].id, "flags");
  assert.notEqual(before.configHash, after.configHash);
});

test("깨진 관리툴 manifest는 앱 등록을 막지 않고 오류를 시드한다", async () => {
  const seed = await computeRepoSeed(
    fakeOctokit({
      "package.json": "{}",
      [OPS_MANIFEST]: JSON.stringify({ version: 1, tools: [{ id: "broken" }] }),
    }),
    ORG,
    REPO,
  );
  assert.ok(seed);
  assert.equal(seed.opsManifest, null);
  assert.match(seed.opsManifestError ?? "", /tools/);
});

test("web/ 은 배포 워크플로우와 독립적으로 marketTargets 에 포함", async () => {
  const seed = await computeRepoSeed(
    fakeOctokit({
      "package.json": "{}",
      web: "", // 디렉터리 존재(pathExists 만 사용)
      ".firebaserc": FIREBASERC,
    }),
    ORG,
    REPO,
  );
  assert.ok(seed);
  assert.deepEqual(seed.marketTargets, ["web"]);
});

test("project.godot/package.json 모두 없음 → null(시드 대상 아님)", async () => {
  const seed = await computeRepoSeed(fakeOctokit({ [WF_PLAY]: "name: play" }), ORG, REPO);
  assert.equal(seed, null);
});

test("game/project.godot 레이아웃도 등록하고 저장소 설명의 짧은 한글명을 우선한다", async () => {
  const seed = await computeRepoSeed(
    fakeOctokit({
      "game/project.godot": '[application]\nconfig/name="Merge Lizard"',
    }),
    ORG,
    {
      ...REPO,
      name: "merge-lizard",
      full_name: "seorilabs/merge-lizard",
      description: "햇살비늘 정원 - 결정형 환경 진화 머지 게임",
    },
  );
  assert.ok(seed);
  assert.equal(seed.engine, "GODOT");
  assert.equal(seed.displayName, "햇살비늘 정원");
});

test("한국어 마켓명이 있으면 영문 프로젝트명보다 우선한다", async () => {
  const seed = await computeRepoSeed(
    fakeOctokit({
      "project.godot": '[application]\nconfig/name="Lucid Chess"',
      "play-store/google-play.config.json": JSON.stringify({
        storeListing: {
          appName: { "ko-KR": "루시드 체스", "en-US": "Lucid Chess" },
        },
      }),
    }),
    ORG,
    REPO,
  );
  assert.ok(seed);
  assert.equal(seed.displayName, "루시드 체스");
});

test("App Store 한국어 이름도 릴리즈 목록 표시명으로 사용한다", async () => {
  const seed = await computeRepoSeed(
    fakeOctokit({
      "project.godot": '[application]\nconfig/name="Spiritgate Defenders"',
      "app-store/app-store.config.json": JSON.stringify({
        storeListing: { name: "영혼의 문 디펜스" },
      }),
    }),
    ORG,
    REPO,
  );
  assert.ok(seed);
  assert.equal(seed.displayName, "영혼의 문 디펜스");
});

test("Backoffice 운영 표시명은 스토어 이름과 별도로 고정한다", async () => {
  for (const [name, expected] of [
    ["slotmachine-game", "루시드 슬롯머신"],
    ["trait-test-hub", "성향 테스트"],
  ] as const) {
    const seed = await computeRepoSeed(
      fakeOctokit({
        "package.json": "{}",
        "play-store/google-play.config.json": JSON.stringify({
          storeListing: { appName: "Store Product Name" },
        }),
      }),
      ORG,
      { ...REPO, name, full_name: `${ORG}/${name}` },
    );
    assert.ok(seed);
    assert.equal(seed.displayName, expected);
  }
});
