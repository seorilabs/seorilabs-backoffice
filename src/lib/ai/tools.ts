import { prisma } from "@/lib/prisma";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import type { Lifecycle, Priority } from "@prisma/client";

// 채팅 비서가 사실 기반으로 답하도록 호출하는 read-only 도구.
// 모델이 {"tool":name,"args":{...}} 로 요청 → runTool 이 미러 DB 조회 → 결과 텍스트 반환.
// 쓰기/배포 도구는 없음(쓰기는 항상 버튼 확인 흐름).

export interface ToolDef {
  name: string;
  description: string;
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_apps",
    description:
      "앱/게임 목록과 현재 단계. 선택 인자 stage(PLANNING|DEVELOPMENT|QA|MARKET_SUBMISSION|RELEASE|LIVEOPS).",
  },
  {
    name: "app_detail",
    description: "특정 앱 상세(단계·열린 이슈/PR·최근 릴리스). 인자 slug(필수).",
  },
  {
    name: "search_issues",
    description:
      "열린 이슈 검색. 선택 인자 query(제목 부분일치), priority(P1|P2|P3|P4), repo(slug).",
  },
  { name: "list_approvals", description: "승인 대기 이슈 목록." },
  { name: "list_p1", description: "열린 P1 이슈 목록(우선순위 최상)." },
  {
    name: "search_knowledge",
    description:
      "Obsidian 지식 볼트 의미검색 — 질문과 관련된 문서 본문 발췌를 찾음. 인자 query(필수). 내용 질문·요약·맥락 참고에 사용.",
  },
  {
    name: "browse_knowledge",
    description:
      "지식 볼트에서 경로/제목에 키워드가 든 문서 목록을 열거(정확, 의미검색 아님). 인자 query(필수). '특정 주제/폴더에 어떤 문서가 있는지'(예: TAS 제안서 목록) 알 때.",
  },
  {
    name: "read_knowledge",
    description:
      "특정 문서의 전체 본문을 읽어옴(요약·상세 답변용). 인자 path(필수 — browse/search 결과의 경로, 부분일치 가능).",
  },
];

const STAGES_SET = new Set<string>([
  "PLANNING",
  "DEVELOPMENT",
  "QA",
  "MARKET_SUBMISSION",
  "RELEASE",
  "LIVEOPS",
]);
const PRIO_SET = new Set<string>(["P1", "P2", "P3", "P4"]);

function repoShort(full: string): string {
  return full.replace("seorilabs/", "");
}

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

export async function runTool(name: string, args: Args = {}): Promise<string> {
  switch (name) {
    case "list_apps": {
      const stage = str(args, "stage")?.toUpperCase();
      const where = stage && STAGES_SET.has(stage) ? { currentStage: stage as Lifecycle } : {};
      const apps = await prisma.app.findMany({
        where,
        orderBy: [{ currentStage: "asc" }, { displayName: "asc" }],
        select: { slug: true, displayName: true, currentStage: true, type: true },
      });
      if (apps.length === 0) return "결과 없음";
      return apps
        .map((a) => `- ${a.displayName} (${a.slug}) · ${STAGE_KO[a.currentStage]} · ${a.type}`)
        .join("\n");
    }
    case "app_detail": {
      const slug = str(args, "slug");
      if (!slug) return "slug 인자가 필요합니다.";
      const app = await prisma.app.findFirst({
        where: { slug },
        include: {
          issues: { where: { state: "OPEN" }, select: { priority: true } },
          pullRequests: { where: { state: "OPEN" }, select: { id: true } },
          releases: { orderBy: { updatedAt: "desc" }, take: 1 },
        },
      });
      if (!app) return `'${slug}' 앱 없음`;
      const p1 = app.issues.filter((i) => i.priority === "P1").length;
      const rel = app.releases[0];
      return [
        `${app.displayName} (${app.slug})`,
        `단계: ${STAGE_KO[app.currentStage]} · 타입: ${app.type}/${app.engine}`,
        `열린 이슈 ${app.issues.length}(P1 ${p1}) · 열린 PR ${app.pullRequests.length}`,
        rel ? `최근 릴리스: ${rel.version} ${rel.market} ${rel.status}` : "릴리스 없음",
        `마켓: ${asStringArray(app.marketTargets).join(", ") || "미정"}`,
      ].join("\n");
    }
    case "search_issues": {
      const query = str(args, "query");
      const priority = str(args, "priority")?.toUpperCase();
      const repo = str(args, "repo");
      const issues = await prisma.issueMirror.findMany({
        where: {
          state: "OPEN",
          ...(query ? { title: { contains: query } } : {}),
          ...(priority && PRIO_SET.has(priority) ? { priority: priority as Priority } : {}),
          ...(repo ? { repoFullName: { contains: repo } } : {}),
        },
        orderBy: [{ priority: "asc" }, { ghUpdatedAt: "desc" }],
        take: 20,
      });
      if (issues.length === 0) return "결과 없음";
      return issues
        .map(
          (i) =>
            `- ${repoShort(i.repoFullName)} #${i.number} [${i.priority ?? "-"}] ${i.title}`,
        )
        .join("\n");
    }
    case "list_approvals": {
      const open = await prisma.issueMirror.findMany({
        where: { state: "OPEN" },
        orderBy: [{ priority: "asc" }],
        take: 200,
      });
      const pend = open.filter((i) => {
        const l = asStringArray(i.labels);
        return hasApproval(l, "planning") || hasApproval(l, "release");
      });
      if (pend.length === 0) return "승인 대기 없음";
      return pend
        .slice(0, 20)
        .map((i) => {
          const gate = hasApproval(asStringArray(i.labels), "release") ? "release" : "planning";
          return `- ${repoShort(i.repoFullName)} #${i.number} (${gate}) ${i.title}`;
        })
        .join("\n");
    }
    case "list_p1": {
      const issues = await prisma.issueMirror.findMany({
        where: { state: "OPEN", priority: "P1" },
        orderBy: [{ ghUpdatedAt: "desc" }],
        take: 20,
      });
      if (issues.length === 0) return "P1 없음";
      return issues
        .map((i) => `- ${repoShort(i.repoFullName)} #${i.number} ${i.title}`)
        .join("\n");
    }
    case "search_knowledge": {
      const query = str(args, "query");
      if (!query) return "query 인자가 필요합니다.";
      // 동적 import: 인덱스 비활성/미구성 환경에서도 다른 도구 영향 없음.
      const { searchVaultText } = await import("@/lib/vault/retrieve");
      try {
        return await searchVaultText(query, 6);
      } catch (e) {
        return `지식 볼트 검색 실패: ${(e as Error).message}`;
      }
    }
    case "browse_knowledge": {
      const query = str(args, "query");
      if (!query) return "query 인자가 필요합니다.";
      const { browseVault } = await import("@/lib/vault/retrieve");
      try {
        const paths = await browseVault(query, 40);
        if (paths.length === 0) return "일치하는 문서 없음";
        return `문서 ${paths.length}개:\n` + paths.map((p) => `- ${p}`).join("\n");
      } catch (e) {
        return `문서 목록 조회 실패: ${(e as Error).message}`;
      }
    }
    case "read_knowledge": {
      const p = str(args, "path");
      if (!p) return "path 인자가 필요합니다.";
      const { readVaultDoc } = await import("@/lib/vault/retrieve");
      try {
        const doc = await readVaultDoc(p);
        if (!doc) return `문서를 찾지 못함: ${p}`;
        // 컨텍스트 보호용 상한(MiniMax MAX_MSG_CHARS 고려).
        return `[${doc.path}]\n${doc.text.slice(0, 6000)}`;
      } catch (e) {
        return `문서 읽기 실패: ${(e as Error).message}`;
      }
    }
    default:
      return `알 수 없는 도구: ${name}`;
  }
}
