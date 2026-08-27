import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  collectReleaseSourceFiles,
  type ReleaseSourceReaders,
} from "@/lib/core/release-source-files";

const SHA = "076e09e4b2c1d0a9f8e7d6c5b4a39281706f5e4d";

function recordingReaders(
  files: Record<string, string | unknown>,
): { readers: ReleaseSourceReaders; calls: Array<{ path: string; ref: string }> } {
  const calls: Array<{ path: string; ref: string }> = [];
  return {
    calls,
    readers: {
      async readText(path, ref) {
        calls.push({ path, ref });
        const value = files[path];
        return typeof value === "string" ? value : null;
      },
      async readJson(path, ref) {
        calls.push({ path, ref });
        return path in files ? files[path] : null;
      },
    },
  };
}

// 인수조건: 계약 입력 조회는 전부 확정된 SHA 를 명시적으로 받는다(브랜치/태그 이름 사용 금지).
test("계약 입력 5종을 모두 같은 SHA 로 조회한다", async () => {
  const { readers, calls } = recordingReaders({
    "scripts/check_release_version.py": "#!/usr/bin/env python3\n",
    "project.godot": '[application]\n\nconfig/version="1.1.12"\n',
    "play-store/google-play.config.json": { release: { versionName: "1.1.12" } },
    "app-store/app-store.config.json": { release: { appleMarketingVersion: "1.1.12" } },
  });

  const files = await collectReleaseSourceFiles(SHA, readers);

  assert.equal(files.sha, SHA);
  assert.equal(files.hasContractScript, true);
  assert.equal(files.hasTagDerivedScript, false);
  assert.deepEqual(files.godotProject?.path, "project.godot");
  assert.deepEqual(
    calls.map((call) => call.path).sort(),
    [
      "app-store/app-store.config.json",
      "godot/project.godot",
      "play-store/google-play.config.json",
      "project.godot",
      "scripts/check_release_version.py",
      "scripts/resolve-release-version.mjs",
    ],
  );
  // 어떤 조회도 브랜치·태그 이름으로 새어나가지 않는다.
  assert.deepEqual([...new Set(calls.map((call) => call.ref))], [SHA]);
});

test("project.godot 이 godot/ 하위에만 있어도 같은 SHA 에서 찾는다", async () => {
  const { readers } = recordingReaders({
    "godot/project.godot": '[application]\n\nconfig/version="2.2.5"\n',
  });

  const files = await collectReleaseSourceFiles(SHA, readers);

  assert.equal(files.godotProject?.path, "godot/project.godot");
  assert.equal(files.hasContractScript, false);
});

// 인수조건: GitHub 파일 read API 가 ref/SHA/tag 를 명시적으로 받는다.
test("GitHub 조회 래퍼는 ref 를 명시적으로 전달한다", () => {
  const read = readFileSync(join(process.cwd(), "src/lib/github/read.ts"), "utf8");
  for (const fn of ["getRepoTextFile", "getRepoJsonFile"]) {
    const start = read.indexOf(`export async function ${fn}(`);
    assert.ok(start !== -1, `${fn} 가 없습니다`);
    const body = read.slice(start, start + 900);
    assert.match(body, /ref\?: string/);
    assert.match(body, /\.\.\.\(ref \? \{ ref \} : \{\}\)/);
  }

  const wiring = readFileSync(join(process.cwd(), "src/lib/github/release-source.ts"), "utf8");
  assert.match(wiring, /readText: \(path, ref\) => getRepoTextFile\(repoFullName, path, ref\)/);
  assert.match(wiring, /readJson: \(path, ref\) => getRepoJsonFile\(repoFullName, path, ref\)/);
});
