import { writeFileSync, mkdirSync } from "node:fs";
import { encode } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";
import {
  registerTarget,
  submitObservations,
  createProposal,
  setMode,
} from "@/lib/supervisor/service";
async function main() {
  if (!process.env.DATABASE_URL?.includes("127.0.0.1:33367/supervisor_test"))
    throw Error("isolated development database required");
  const artifact = process.env.SUPERVISOR_QA_ARTIFACT;
  if (!artifact) throw Error("private artifact directory required");
  mkdirSync(artifact, { recursive: true, mode: 0o700 });
  await prisma.user.upsert({
    where: { login: "qa-owner" },
    create: {
      login: "qa-owner",
      githubId: 999999999999n,
      role: "ADMIN",
      allowlisted: true,
    },
    update: {},
  });
  await registerTarget({
    id: "qa-book",
    name: "집필 검수 자료",
    kind: "WRITING",
    repository: null,
    appId: null,
    policySha: null,
    enabled: true,
  });
  const now = new Date();
  await submitObservations([
    {
      id: "qa-book-observation",
      targetId: "qa-book",
      problemKey: "unfinished-chapter",
      source: "writing",
      summary: "격리된 원고의 마지막 문단에 미완료 표시가 남았습니다.",
      references: ["file:qa-book/chapter.md#sha256=fixture"],
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86400000).toISOString(),
      waitUntil: null,
      samples: 1,
      minSamples: 1,
    },
  ]);
  const p = await createProposal(
    {
      targetId: "qa-book",
      problemKey: "unfinished-chapter",
      title: "원고의 미완료 문단을 검토한다",
      problem:
        "마지막 문단의 사건 연결이 끝나지 않았습니다. 격리된 개발 검수 자료입니다.",
      observationIds: ["qa-book-observation"],
      scope: "chapter.md의 마지막 문단만 수정합니다.",
      design:
        "시작과 갈등은 보존하고 마지막 행동의 결과를 한 문장으로 연결합니다.",
      preview:
        "변경 전: 주인공이 문을 열었다. [미완료]\n변경 후: 주인공이 문을 열자 친구들이 기다리고 있었다.",
      acceptance: ["미완료 표시가 사라진다", "앞 문단과 인물 이름이 일치한다"],
      tests: "승인한 원본과 결과의 해시, 인물 이름과 미완료 표시를 확인합니다.",
      testCommands: [
        [
          "python3",
          "-c",
          'from pathlib import Path; assert "[미완료]" not in Path("chapter.md").read_text()',
        ],
      ],
      verification: {
        kind: "files",
        files: [{ path: "chapter.md", sha256: "b".repeat(64) }],
      },
      tools: ["codex", "python"],
      executor: "codex",
      timeLimitMinutes: 10,
      impact: 2,
      confidence: 1,
      effortMinutes: 5,
      deadline: null,
      release: null,
      binding: {
        kind: "files",
        files: [{ path: "chapter.md", sha256: "a".repeat(64) }],
      },
    },
    "qa-pc",
  );
  await setMode("OBSERVE", "@qa-owner");
  const token = await encode({
    token: { login: "qa-owner", sub: "999999999999" },
    secret: "supervisor-development-session-only",
    salt: "authjs.session-token",
  });
  writeFileSync(
    artifact + "/cookies.json",
    JSON.stringify([
      {
        name: "authjs.session-token",
        value: token,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]),
    { mode: 0o600 },
  );
  writeFileSync(
    artifact + "/fixture.json",
    JSON.stringify({ proposalId: p.id, version: p.version, digest: p.digest }),
    { mode: 0o600 },
  );
  await prisma.$disconnect();
}
void main();
