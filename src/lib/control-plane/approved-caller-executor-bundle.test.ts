import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 실행기 번들은 top-level await ESM 계약을 dynamic import 해야 해서 ESM이어야 하고, 그
 * 안으로 들어오는 CJS 의존(yaml 등)은 require가 있어야 로드된다. 이 조합이 깨지면 파드가
 * 첫 실행에서 `Dynamic require of "process" is not supported`로 죽는다. build 플래그만
 * 보는 것으로는 못 잡아서 실제로 번들을 만들고 실행한다.
 */
function esmBuildCommand(): string {
  const scripts = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = scripts.scripts["build:scripts"];
  const esm = command
    .split("&&")
    .map((part) => part.trim())
    .find((part) => part.includes("approved-caller-reconciliation-executor.ts"));
  assert.ok(esm, "실행기 ESM build 명령을 package.json에서 찾지 못했다");
  return esm;
}

test("실행기 ESM 번들은 CJS 의존을 포함한 채로 실제 import된다", () => {
  // 외부 의존(@prisma/client 등)은 번들에 들어가지 않으므로 저장소 node_modules에서
  // 해석돼야 한다. 그래서 출력은 저장소 안에 둔다.
  const outdir = mkdtempSync(join(process.cwd(), ".acr-bundle-"));
  try {
    const command = esmBuildCommand().replace("--outdir=scripts-dist", `--outdir=${outdir}`);
    execFileSync("sh", ["-c", `npx --no-install ${command}`], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    const bundle = join(outdir, "approved-caller-reconciliation-executor.mjs");

    // 모듈 최상위가 끝까지 평가돼야 실행기 자체 guard에 닿는다. 그 지점에 닿았다는 것은
    // 번들 안 CJS 의존이 모두 로드됐다는 뜻이다.
    const run = spawnSync(process.execPath, [bundle], {
      env: {
        ...process.env,
        SEORI_BACKOFFICE_ORIGIN: "https://backoffice.invalid/",
        SEORI_EGRESS_PROXY_ORIGIN: "https://proxy.invalid/",
        APPROVED_CALLER_RECONCILIATION_ADAPTER_PRINCIPAL: "seori-auth:not-the-adapter",
        APPROVED_CALLER_RECONCILIATION_ADAPTER_RUNTIME_IDENTITY: "spiffe://invalid",
        APPROVED_CALLER_RECONCILIATION_EXECUTION_ID: "bundle-test-0001",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.doesNotMatch(output, /Dynamic require of/u, output.slice(0, 400));
    assert.match(output, /APPROVED_CALLER_ADAPTER_PRINCIPAL_INVALID/u, output.slice(0, 400));
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});
