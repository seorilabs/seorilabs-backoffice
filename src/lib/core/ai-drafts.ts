import type { AiDraftKind, Prisma } from "@prisma/client";
import { getInstallationOctokit } from "@/lib/github/app";
import { prisma } from "@/lib/prisma";
import { asStringArray } from "@/lib/format";
import { llmComplete, llmChatConfigured, llmChatModel } from "@/lib/ai/llm";
import {
  AGENTS,
  buildPlanningPrompt,
  buildBugReportPrompt,
  buildDecomposePrompt,
  buildQaPrompt,
  buildReleaseNotesPrompt,
  buildStoreCopyPrompt,
  buildImprovementPrompt,
} from "@/lib/ai/agents";
import { createIssue, addIssueComment } from "@/lib/github/write";
import { getRepoContext, getIssue, findDraftRegistration } from "@/lib/github/read";
import { upsertIssue } from "@/lib/sync/mirror";
import {
  HIDDEN_APP_ERROR,
  isDisabledAppStatus,
  visibleAppWhere,
} from "@/lib/domain/app-visibility";

// 세션 비의존 코어(텔레그램·웹 공용). actorLabel 로 행위자 추적.

export interface PlanningDraftResult {
  id: string;
  title: string;
  outputText: string;
  repoFullName: string;
  displayName: string;
}

// 기획 초안 생성 → AiDraft(PLANNING_SPEC, DRAFT) 저장.
export async function createPlanningDraftCore(input: {
  appId: string;
  idea: string;
  title?: string;
  actorLabel?: string;
}): Promise<PlanningDraftResult> {
  if (!llmChatConfigured()) throw new Error("챗 LLM 비활성");
  const app = await prisma.app.findFirst({ where: { id: input.appId, ...visibleAppWhere } });
  if (!app) throw new Error(HIDDEN_APP_ERROR);

  const title = (input.title ?? input.idea).trim().slice(0, 120) || "무제 기획";
  const codebaseContext = await getRepoContext(app.repoFullName).catch(() => "");
  const { system, prompt } = buildPlanningPrompt({
    displayName: app.displayName,
    type: app.type,
    engine: app.engine,
    marketTargets: asStringArray(app.marketTargets),
    title,
    idea: input.idea,
    codebaseContext: codebaseContext || undefined,
  });
  // 텔레그램 등 지연 민감 경로 — 토큰 상한을 낮춰 생성 지연을 억제.
  const outputText = await llmComplete({
    system,
    prompt,
    maxTokens: 2048,
    usage: { path: "draft" },
  });

  const draft = await prisma.aiDraft.create({
    data: {
      appId: app.id,
      repoFullName: app.repoFullName,
      stage: "PLANNING",
      kind: "PLANNING_SPEC",
      title,
      inputJson: { idea: input.idea },
      outputText,
      model: llmChatModel(),
      createdBy: input.actorLabel ?? null,
    },
  });

  return {
    id: draft.id,
    title,
    outputText,
    repoFullName: app.repoFullName,
    displayName: app.displayName,
  };
}

// 버그 리포트 초안 생성 → AiDraft(BUG_REPORT, DRAFT) 저장. 커밋 시 label: bug 새 이슈.
export async function createBugDraftCore(input: {
  appId: string;
  symptom: string;
  title?: string;
  actorLabel?: string;
}): Promise<PlanningDraftResult> {
  if (!llmChatConfigured()) throw new Error("챗 LLM 비활성");
  const app = await prisma.app.findFirst({ where: { id: input.appId, ...visibleAppWhere } });
  if (!app) throw new Error(HIDDEN_APP_ERROR);

  const title =
    (input.title ?? input.symptom).trim().replace(/\s+/g, " ").slice(0, 120) || "버그 리포트";
  const codebaseContext = await getRepoContext(app.repoFullName).catch(() => "");
  const { system, prompt } = buildBugReportPrompt({
    displayName: app.displayName,
    type: app.type,
    engine: app.engine,
    marketTargets: asStringArray(app.marketTargets),
    title,
    symptom: input.symptom,
    codebaseContext: codebaseContext || undefined,
  });
  // 텔레그램 등 지연 민감 경로 — 토큰 상한을 낮춰 생성 지연을 억제.
  const outputText = await llmComplete({
    system,
    prompt,
    maxTokens: 2048,
    usage: { path: "draft" },
  });

  const draft = await prisma.aiDraft.create({
    data: {
      appId: app.id,
      repoFullName: app.repoFullName,
      stage: "DEVELOPMENT",
      kind: "BUG_REPORT",
      title,
      inputJson: { symptom: input.symptom },
      outputText,
      model: llmChatModel(),
      createdBy: input.actorLabel ?? null,
    },
  });

  return {
    id: draft.id,
    title,
    outputText,
    repoFullName: app.repoFullName,
    displayName: app.displayName,
  };
}

export interface StageDraftResult {
  id: string;
  kind: AiDraftKind;
  title: string | null;
  issueNumber: number | null;
  outputText: string;
  model: string;
  appId: string;
}

// 단계 에이전트(분해/QA/릴리스노트/스토어/개선) 초안 생성 → AiDraft 저장. 세션 비의존.
export async function generateStageDraftCore(input: {
  appId: string;
  kind: AiDraftKind;
  issueNumber?: number;
  actorLabel?: string;
}): Promise<StageDraftResult> {
  if (!llmChatConfigured()) throw new Error("챗 LLM 비활성");
  const app = await prisma.app.findFirst({ where: { id: input.appId, ...visibleAppWhere } });
  if (!app) throw new Error(HIDDEN_APP_ERROR);
  const meta = AGENTS[input.kind];

  let system: string;
  let prompt: string;
  let title: string | null = null;
  let issueNumber: number | null = null;
  let inputJson: Prisma.InputJsonObject;

  if (input.kind === "TASK_BREAKDOWN" || input.kind === "QA_CHECKLIST") {
    if (!input.issueNumber) throw new Error("대상 이슈 번호가 필요합니다.");
    const issue = await getIssue(app.repoFullName, input.issueNumber);
    issueNumber = input.issueNumber;
    const issueCtx = {
      displayName: app.displayName,
      type: app.type,
      engine: app.engine,
      issueNumber: input.issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
    };
    ({ system, prompt } =
      input.kind === "QA_CHECKLIST" ? buildQaPrompt(issueCtx) : buildDecomposePrompt(issueCtx));
    inputJson = { issueNumber: input.issueNumber, issueTitle: issue.title };
  } else if (input.kind === "RELEASE_NOTES") {
    const mergedPrs = await prisma.pullRequestMirror.findMany({
      where: { appId: app.id, state: "MERGED" },
      orderBy: { mergedAt: "desc" },
      take: 30,
      select: { number: true, title: true },
    });
    const latestRelease = await prisma.releaseRecord.findFirst({
      where: { appId: app.id },
      orderBy: { updatedAt: "desc" },
      select: { version: true },
    });
    const version = latestRelease?.version ?? "vNext";
    title = `릴리스 노트: ${app.displayName} ${version}`;
    ({ system, prompt } = buildReleaseNotesPrompt({
      displayName: app.displayName,
      type: app.type,
      marketTargets: asStringArray(app.marketTargets),
      version,
      mergedPrs,
    }));
    inputJson = { version, prCount: mergedPrs.length };
  } else if (input.kind === "STORE_COPY") {
    const recentPrs = await prisma.pullRequestMirror.findMany({
      where: { appId: app.id, state: "MERGED" },
      orderBy: { mergedAt: "desc" },
      take: 20,
      select: { number: true, title: true },
    });
    title = `스토어 등록 문안: ${app.displayName}`;
    ({ system, prompt } = buildStoreCopyPrompt({
      displayName: app.displayName,
      type: app.type,
      engine: app.engine,
      marketTargets: asStringArray(app.marketTargets),
      recentPrs,
    }));
    inputJson = { prCount: recentPrs.length };
  } else if (input.kind === "IMPROVEMENT_HYPOTHESIS") {
    const [openIssues, recentPrs, recentReleases] = await Promise.all([
      prisma.issueMirror.findMany({
        where: { appId: app.id, state: "OPEN" },
        orderBy: [{ priority: "asc" }, { ghUpdatedAt: "desc" }],
        take: 20,
        select: { number: true, title: true },
      }),
      prisma.pullRequestMirror.findMany({
        where: { appId: app.id, state: "MERGED" },
        orderBy: { mergedAt: "desc" },
        take: 15,
        select: { number: true, title: true },
      }),
      prisma.releaseRecord.findMany({
        where: { appId: app.id },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { version: true, market: true },
      }),
    ]);
    title = `개선 가설: ${app.displayName}`;
    ({ system, prompt } = buildImprovementPrompt({
      displayName: app.displayName,
      type: app.type,
      marketTargets: asStringArray(app.marketTargets),
      openIssues,
      recentPrs,
      recentReleases: recentReleases.map((r) => ({ version: r.version, market: r.market })),
    }));
    inputJson = { openIssues: openIssues.length, prCount: recentPrs.length };
  } else {
    throw new Error("지원하지 않는 에이전트입니다.");
  }

  const outputText = await llmComplete({
    system,
    prompt,
    maxTokens: 2048,
    usage: { path: "draft" },
  });

  const draft = await prisma.aiDraft.create({
    data: {
      appId: app.id,
      repoFullName: app.repoFullName,
      stage: meta.stage,
      kind: input.kind,
      title,
      issueNumber,
      inputJson,
      outputText,
      model: llmChatModel(),
      createdBy: input.actorLabel ?? null,
    },
  });

  return {
    id: draft.id,
    kind: draft.kind,
    title: draft.title,
    issueNumber: draft.issueNumber,
    outputText: draft.outputText,
    model: draft.model,
    appId: app.id,
  };
}

export interface CommitDraftResult {
  issueNumber: number;
  url: string;
  repoFullName: string;
  appId: string;
}

// 초안 커밋: kind 별 새 이슈 또는 코멘트 → 미러 수렴. DRAFT 일 때만 동작(멱등).
export async function commitDraftCore(input: {
  draftId: string;
  actorLabel: string;
  editedText?: string;
  editedTitle?: string;
}): Promise<CommitDraftResult> {
  const draft = await prisma.aiDraft.findUnique({
    where: { id: input.draftId },
    include: { app: { select: { status: true } } },
  });
  if (!draft) throw new Error("초안을 찾을 수 없습니다.");
  if (isDisabledAppStatus(draft.app.status)) throw new Error(HIDDEN_APP_ERROR);
  if (draft.status === "COMMITTED" && draft.committedIssueNumber && draft.committedUrl)
    return {
      issueNumber: draft.committedIssueNumber,
      url: draft.committedUrl,
      repoFullName: draft.repoFullName,
      appId: draft.appId,
    };
  if (draft.status !== "DRAFT") throw new Error("이미 처리된 초안입니다.");

  const meta = AGENTS[draft.kind];
  const body = (input.editedText ?? draft.outputText).trim();
  if (!body) throw new Error("본문이 비어 있습니다.");

  const title = (input.editedTitle ?? draft.title ?? "").trim();
  if (meta.commitTarget !== "ISSUE_COMMENT" && !title) throw new Error("이슈 제목이 필요합니다.");
  if (meta.commitTarget === "ISSUE_COMMENT" && !draft.issueNumber)
    throw new Error("코멘트 대상 이슈가 없습니다.");
  await getInstallationOctokit(); // 인증 설정 오류는 외부 쓰기 claim 전에 확정한다.
  const claimed = await prisma.aiDraft.updateMany({
    where: { id: draft.id, status: "DRAFT", claimedAt: null },
    data: { claimedAt: new Date() },
  });
  if (claimed.count !== 1)
    throw new Error(
      "등록 진행 중이거나 결과 확인이 필요합니다. GitHub 등록 기록을 먼저 확인하세요.",
    );
  const tracedBody = body + "\n\n<!-- backoffice-draft:" + draft.id + " -->";
  let committedIssueNumber: number;
  let url: string;
  let externalSucceeded = false;

  try {
    if (meta.commitTarget === "ISSUE_COMMENT") {
      if (!draft.issueNumber) throw new Error("코멘트 대상 이슈가 없습니다.");
      await addIssueComment({
        repoFullName: draft.repoFullName,
        issueNumber: draft.issueNumber,
        body: tracedBody,
      });
      externalSucceeded = true;
      committedIssueNumber = draft.issueNumber;
      url = `https://github.com/${draft.repoFullName}/issues/${draft.issueNumber}`;
    } else {
      const title = (input.editedTitle ?? draft.title ?? "").trim();
      if (!title) throw new Error("이슈 제목이 필요합니다.");
      const created = await createIssue({
        repoFullName: draft.repoFullName,
        title,
        body: tracedBody,
        labels: meta.commitLabels,
      });
      externalSucceeded = true;
      await upsertIssue(draft.repoFullName, {
        number: created.number,
        node_id: created.node_id,
        title: created.title,
        state: created.state,
        state_reason: created.state_reason ?? null,
        body: created.body ?? null,
        user: created.user ? { login: created.user.login } : null,
        assignees: (created.assignees ?? []).map((a) => ({ login: a.login })),
        labels: created.labels,
        milestone: created.milestone ? { title: created.milestone.title } : null,
        created_at: created.created_at,
        updated_at: created.updated_at,
      });
      committedIssueNumber = created.number;
      url = created.html_url;
    }
  } catch (error) {
    // 명시적으로 거절된 HTTP 요청만 재시도를 허용한다. timeout/network/5xx 결과는 readback한다.
    if (
      !externalSucceeded &&
      [401, 403, 404, 422].includes((error as { status?: number }).status ?? 0)
    )
      await prisma.aiDraft.updateMany({
        where: { id: draft.id, status: "DRAFT" },
        data: { claimedAt: null },
      });
    throw error;
  }
  await prisma.aiDraft.update({
    where: { id: draft.id },
    data: {
      status: "COMMITTED",
      outputText: body,
      title: input.editedTitle ?? draft.title,
      committedIssueNumber,
      committedUrl: url,
      committedAt: new Date(),
    },
  });

  return {
    issueNumber: committedIssueNumber,
    url,
    repoFullName: draft.repoFullName,
    appId: draft.appId,
  };
}

export async function confirmDraftRegistrationCore(draftId: string) {
  const draft = await prisma.aiDraft.findUniqueOrThrow({
    where: { id: draftId },
    include: { app: { select: { status: true } } },
  });
  if (isDisabledAppStatus(draft.app.status)) throw new Error(HIDDEN_APP_ERROR);
  if (draft.status === "COMMITTED")
    return { confirmed: true, url: draft.committedUrl!, pending: false };
  if (draft.status !== "DRAFT" || !draft.claimedAt)
    return { confirmed: false, url: null, pending: false };
  const comment = AGENTS[draft.kind].commitTarget === "ISSUE_COMMENT";
  const found = await findDraftRegistration({
    repoFullName: draft.repoFullName,
    draftId: draft.id,
    issueNumber: comment ? draft.issueNumber : null,
    since: new Date(draft.claimedAt.getTime() - 120000),
  });
  if (!found) return { confirmed: false, url: null, pending: true }; // 읽기 결과 없음은 전송 실패의 증거가 아니다.
  await prisma.aiDraft.updateMany({
    where: { id: draft.id, status: "DRAFT", claimedAt: draft.claimedAt },
    data: {
      status: "COMMITTED",
      committedIssueNumber: found.issueNumber,
      committedUrl: found.url,
      committedAt: new Date(),
    },
  });
  return { confirmed: true, url: found.url, pending: false };
}
