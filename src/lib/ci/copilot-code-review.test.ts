import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// Copilot 코드 리뷰 러너 계약.
//
// 이 워크플로가 깨지는 방식은 조용하다. 잡 이름이 어긋나면 Copilot 은 파일을 무시하고
// GitHub-hosted ubuntu-latest 로 되돌아가는데, 워크플로 자체는 계속 성공한다. 그래서
// 포함 분량이 다시 새는 것을 아무도 눈치채지 못한다. 계약을 test 로 고정한다.

const WORKFLOW_PATH = ".github/workflows/copilot-code-review.yml";

// GitHub 은 Copilot 리뷰에 ARC 로 관리되는 자체호스팅 러너만 허용한다(비-ARC 금지).
const ARC_SCALE_SETS = new Set(["seorilabs-rpi-arm64", "seorilabs-rpi-arm64-dind"]);

interface WorkflowJob {
  "runs-on"?: unknown;
  steps?: Array<{ name?: string; run?: string; uses?: string }>;
}

function workflow(): { jobs: Record<string, WorkflowJob> } {
  return parse(readFileSync(WORKFLOW_PATH, "utf8")) as { jobs: Record<string, WorkflowJob> };
}

test("Copilot 리뷰 잡 이름은 copilot-setup-steps 하나뿐이다", () => {
  // 이름이 다르면 Copilot 이 파일을 무시하고 hosted 러너로 되돌아간다.
  assert.deepEqual(Object.keys(workflow().jobs), ["copilot-setup-steps"]);
});

test("Copilot 리뷰는 ARC 스케일셋에서 실행한다", () => {
  const runsOn = workflow().jobs["copilot-setup-steps"]["runs-on"];
  assert.equal(typeof runsOn, "string");
  assert.ok(
    ARC_SCALE_SETS.has(runsOn as string),
    `runs-on 이 등록된 ARC 스케일셋이어야 한다: ${String(runsOn)}`,
  );
  // GitHub-hosted 로 되돌아가면 포함 분량을 다시 소모한다.
  assert.doesNotMatch(runsOn as string, /^(ubuntu|macos|windows)/);
});

test("Copilot 리뷰 setup step 은 의존성을 설치하지 않는다", () => {
  const steps = workflow().jobs["copilot-setup-steps"].steps ?? [];
  assert.ok(steps.length > 0, "잡에는 step 이 최소 1개 필요하다");
  // 설치를 넣으면 리뷰마다 ARC 러너(maxRunners 3)를 오래 점유해 CI 를 밀어낸다.
  // 리뷰 대상 체크아웃은 Copilot 이 이 잡 뒤에 스스로 한다.
  for (const step of steps) {
    const command = `${step.run ?? ""} ${step.uses ?? ""}`;
    assert.doesNotMatch(
      command,
      /pnpm install|npm ci|npm install|yarn install|bundle install|pip install/,
      `의존성 설치 step 금지: ${step.name ?? command.trim()}`,
    );
  }
});
