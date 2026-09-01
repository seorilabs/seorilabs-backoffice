import { prisma } from "@/lib/prisma";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import { approvalIssueWhere, visibleAppWhere, visibleIssueWhere } from "@/lib/domain/app-visibility";
import type { IncidentStatus, Lifecycle, Priority, ReleaseStatus } from "@prisma/client";

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
  {
    name: "app_metrics",
    description:
      "앱의 GA4 일별 지표(DAU·신규·D1 잔존·참여·광고). 인자 slug(필수), days(선택, 기본 7, 최대 28).",
  },
  {
    name: "console_metrics",
    description:
      "앱의 AppsInToss 콘솔 일별 지표(DAU·세션·광고 수익·인앱결제). 인자 slug(필수), days(선택, 기본 7, 최대 28).",
  },
  {
    name: "list_releases",
    description:
      "릴리스 기록(마켓 배포 상태). 선택 인자 slug, status(PENDING|IN_PROGRESS|SUCCEEDED|FAILED|ROLLED_BACK).",
  },
  {
    name: "list_incidents",
    description: "운영 장애 카드 목록. 선택 인자 status(OPEN|ACKNOWLEDGED|RECOVERED, 기본 OPEN).",
  },
  {
    name: "list_workflow_failures",
    description: "최근 48시간 GitHub Actions workflow 실패 목록.",
  },
  {
    name: "review_summary",
    description:
      "스토어 리뷰 별점 요약(앱·스토어별 건수/평균/저평점). 선택 인자 slug, days(기본 7, 최대 28). 리뷰 본문은 저장하지 않아 별점 통계만 제공.",
  },
  {
    name: "cost_summary",
    description: "이번 달 종량제 비용 현황(GitHub Actions 분량·GCP·Stability 크레딧).",
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

const INCIDENT_STATUS_SET = new Set<string>(["OPEN", "ACKNOWLEDGED", "RECOVERED"]);
const RELEASE_STATUS_SET = new Set<string>([
  "PENDING",
  "IN_PROGRESS",
  "SUCCEEDED",
  "FAILED",
  "ROLLED_BACK",
]);
const DAY_MS = 86_400_000;

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};
const clampInt = (a: Args, k: string, fallback: number, min: number, max: number): number => {
  const v = a[k];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};
const dateStr = (d: Date): string => d.toISOString().slice(0, 10);

export async function runTool(name: string, args: Args = {}): Promise<string> {
  switch (name) {
    case "list_apps": {
      const stage = str(args, "stage")?.toUpperCase();
      const where =
        stage && STAGES_SET.has(stage)
          ? { ...visibleAppWhere, currentStage: stage as Lifecycle }
          : visibleAppWhere;
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
        where: { slug, ...visibleAppWhere },
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
          ...visibleIssueWhere,
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
        where: { ...approvalIssueWhere, state: "OPEN" },
        orderBy: [{ priority: "asc" }],
        take: 500,
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
        where: { ...visibleIssueWhere, state: "OPEN", priority: "P1" },
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
        // 모델 컨텍스트와 요청 비용을 보호하는 문서 본문 상한.
        return `[${doc.path}]\n${doc.text.slice(0, 6000)}`;
      } catch (e) {
        return `문서 읽기 실패: ${(e as Error).message}`;
      }
    }
    case "app_metrics": {
      const slug = str(args, "slug");
      if (!slug) return "slug 인자가 필요합니다.";
      const days = clampInt(args, "days", 7, 1, 28);
      const app = await prisma.app.findFirst({
        where: { slug, ...visibleAppWhere },
        select: { id: true, displayName: true },
      });
      if (!app) return `'${slug}' 앱 없음`;
      const rows = await prisma.appMetricDaily.findMany({
        where: { appId: app.id },
        orderBy: { date: "desc" },
        take: days,
      });
      if (rows.length === 0) return `${app.displayName}: GA4 일별 지표 없음(export 미설정 또는 미수집)`;
      return rows
        .reverse()
        .map((r) => {
          const parts = [
            `DAU ${r.dau}(And ${r.dauAndroid}/iOS ${r.dauIos}/Web ${r.dauWeb})`,
            `신규 ${r.newUsers}`,
          ];
          if (r.d1Pct != null) parts.push(`D1 ${r.d1Pct.toFixed(1)}%`);
          if (r.avgEngageSec != null) parts.push(`평균참여 ${Math.round(r.avgEngageSec)}초`);
          if (r.networkAdImpressions > 0) parts.push(`광고노출 ${r.networkAdImpressions}`);
          return `- ${dateStr(r.date)}: ${parts.join(" · ")}`;
        })
        .join("\n");
    }
    case "console_metrics": {
      const slug = str(args, "slug");
      if (!slug) return "slug 인자가 필요합니다.";
      const days = clampInt(args, "days", 7, 1, 28);
      const app = await prisma.app.findFirst({
        where: { slug, ...visibleAppWhere },
        select: { id: true, displayName: true },
      });
      if (!app) return `'${slug}' 앱 없음`;
      const rows = await prisma.appConsoleMetricDaily.findMany({
        where: { appId: app.id, date: { gte: new Date(Date.now() - days * DAY_MS) } },
        orderBy: [{ date: "asc" }, { miniAppId: "asc" }],
        take: days * 4,
      });
      if (rows.length === 0) return `${app.displayName}: 콘솔 지표 없음(미등록 또는 미수집)`;
      return rows
        .map((r) => {
          const dau = r.dau == null ? "미집계" : String(r.dau);
          const parts = [
            `DAU ${dau}`,
            `IAA ${Math.round(r.iaaEarningKrw).toLocaleString()}원(${r.iaaImpressions}회)`,
          ];
          if (r.iapTrxAmountKrw > 0)
            parts.push(`IAP ${Math.round(r.iapTrxAmountKrw).toLocaleString()}원`);
          if (r.avgSessionSec != null) parts.push(`세션 ${Math.round(r.avgSessionSec)}초`);
          return `- ${dateStr(r.date)} [${r.miniAppId}]: ${parts.join(" · ")}`;
        })
        .join("\n");
    }
    case "list_releases": {
      const slug = str(args, "slug");
      const status = str(args, "status")?.toUpperCase();
      const releases = await prisma.releaseRecord.findMany({
        where: {
          ...(slug ? { app: { slug } } : {}),
          ...(status && RELEASE_STATUS_SET.has(status) ? { status: status as ReleaseStatus } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: 10,
        include: { app: { select: { slug: true } } },
      });
      if (releases.length === 0) return "릴리스 기록 없음";
      return releases
        .map((r) => {
          const track = r.track ? `/${r.track}` : "";
          const deployed = r.deployedAt ? ` · 배포 ${dateStr(r.deployedAt)}` : "";
          return `- ${r.app.slug} ${r.version} ${r.market}${track} ${r.status}${deployed}`;
        })
        .join("\n");
    }
    case "list_incidents": {
      const statusArg = str(args, "status")?.toUpperCase() ?? "OPEN";
      const status = INCIDENT_STATUS_SET.has(statusArg) ? statusArg : "OPEN";
      const incidents = await prisma.operationalIncident.findMany({
        where: { status: status as IncidentStatus },
        orderBy: { lastDetectedAt: "desc" },
        take: 10,
        include: { app: { select: { slug: true } } },
      });
      if (incidents.length === 0) return `${status} 장애 없음`;
      return incidents
        .map(
          (i) =>
            `- [${i.severity}] ${i.app?.slug ?? "org"} ${i.kind} · ${i.summary.slice(0, 80)} · 최초 ${dateStr(i.firstDetectedAt)}`,
        )
        .join("\n");
    }
    case "list_workflow_failures": {
      const runs = await prisma.workflowRunMirror.findMany({
        where: { conclusion: "failure", ghUpdatedAt: { gte: new Date(Date.now() - 2 * DAY_MS) } },
        orderBy: { ghUpdatedAt: "desc" },
        take: 15,
      });
      if (runs.length === 0) return "최근 48시간 workflow 실패 없음";
      return runs
        .map(
          (r) =>
            `- ${repoShort(r.repoFullName)} · ${r.name ?? "?"} · ${r.headBranch ?? "-"} · ${r.ghUpdatedAt.toISOString().slice(0, 16)}`,
        )
        .join("\n");
    }
    case "review_summary": {
      const slug = str(args, "slug");
      const days = clampInt(args, "days", 7, 1, 28);
      const reviews = await prisma.storeReviewObservation.findMany({
        where: {
          lastObservedAt: { gte: new Date(Date.now() - days * DAY_MS) },
          ...(slug ? { app: { slug } } : {}),
        },
        select: { rating: true, store: true, app: { select: { slug: true } } },
        take: 500,
      });
      if (reviews.length === 0) return `최근 ${days}일 스토어 리뷰 없음`;
      const groups = new Map<string, { count: number; sum: number; low: number }>();
      for (const r of reviews) {
        const key = `${r.app.slug} (${r.store})`;
        const g = groups.get(key) ?? { count: 0, sum: 0, low: 0 };
        g.count += 1;
        g.sum += r.rating;
        if (r.rating <= 2) g.low += 1;
        groups.set(key, g);
      }
      return [...groups.entries()]
        .sort((a, b) => b[1].low - a[1].low)
        .map(
          ([key, g]) =>
            `- ${key}: ${g.count}건 · 평균 ${(g.sum / g.count).toFixed(1)} · 2점 이하 ${g.low}건`,
        )
        .join("\n");
    }
    case "cost_summary": {
      // 동적 import: BigQuery/외부 API 의존 경로가 웹 번들·테스트 그래프에 실리지 않게 격리.
      const { collectFinanceCosts } = await import("@/lib/core/finance-costs");
      try {
        const result = await collectFinanceCosts(new Date());
        return result.summaryLines.join("\n");
      } catch (e) {
        return `비용 현황 조회 실패: ${(e as Error).message}`;
      }
    }
    default:
      return `알 수 없는 도구: ${name}`;
  }
}
