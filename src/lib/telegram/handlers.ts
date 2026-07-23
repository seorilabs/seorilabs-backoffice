import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  sendMessage,
  sendWithReplyKeyboard,
  answerCallback,
  editMessageText,
  sendChatAction,
  esc,
  mdToTelegramHtml,
} from "@/lib/telegram/client";
import type { AiDraftKind } from "@prisma/client";
import { toggleApprovalCore } from "@/lib/core/approvals";
import {
  createPlanningDraftCore,
  createBugDraftCore,
  commitDraftCore,
  generateStageDraftCore,
} from "@/lib/core/ai-drafts";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO, STAGES } from "@/lib/domain/lifecycle";
import {
  activeAppWhere,
  HIDDEN_APP_ERROR,
  isDisabledAppStatus,
  visibleAppWhere,
  visibleIssueWhere,
} from "@/lib/domain/app-visibility";
import { handleChat, resetChat } from "@/lib/telegram/chat";
import { getPending, setPending, clearPending } from "@/lib/telegram/state";
import { enqueueVaultWrite } from "@/lib/vault/write-core";
import {
  createReleaseTagWithNotes,
  dispatchMarketDeploy,
  promoteGooglePlay,
  prepareAppStore,
  submitAppStore,
  previewNextTag,
  deployTargetsFor,
  DEPLOY_TARGET_KO,
  type DeployTarget,
  type Bump,
} from "@/lib/core/release-ops";
import { listVersionTags } from "@/lib/github/release";
import { resolveGa4Target, isoDate } from "@/lib/ga4/datasets";
import { engagementRate, platformSegments, type MetricBreakdowns } from "@/lib/ga4/metric-shapes";
import {
  buildReleaseDeployButtons,
  buildMarketReviewButtons,
  deployStateCallbackText,
  deployTargetFromCode,
  platformDeployTargets,
  resolveDeployButtonStates,
  type DeployButtonState,
  type DeployButtonStates,
  type DeployDispatchStateInput,
  type DeployRunStateInput,
  type PlatformDeployTarget,
} from "@/lib/telegram/release-deploy-buttons";

interface TgFrom {
  id: number;
}
interface TgMessage {
  message_id: number;
  text?: string;
  chat: { id: number };
  from?: TgFrom;
}
interface TgCallback {
  id: string;
  data?: string;
  from?: TgFrom;
  message?: { message_id: number; chat: { id: number } };
}
export interface TgUpdate {
  message?: TgMessage;
  callback_query?: TgCallback;
}

// "/" 명령어 메뉴 정의는 commands.ts(경량)로 분리. 하위 호환 위해 re-export.
export { BOT_COMMANDS } from "@/lib/telegram/commands";

// 하단 고정 빠른 버튼.
const QUICK_KEYBOARD = [
  ["📋 승인", "🔥 P1"],
  ["📊 현황", "📈 지표"],
  ["📝 기획", "🐞 버그"],
  ["ℹ️ 도움말", "🧹 초기화"],
];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/i;
const ID_RE = /^[a-z0-9]{20,40}$/i;

function authorized(fromId?: number): boolean {
  if (!fromId) return false;
  return env.telegramAllowedIds().includes(String(fromId));
}

function helpText(): string {
  return [
    "<b>📖 Seorilabs Backoffice 봇 사용 가이드</b>",
    "",
    "앱 제작 공장(기획→개발→QA→마켓→출시→운영)을 폰에서 운영합니다.",
    "",
    "<b>💬 AI 비서와 대화</b>",
    "그냥 메시지를 보내면 됩니다. 비서가 실제 데이터(앱·이슈·PR·승인)와 <b>Obsidian 지식 볼트</b>(기획서·아이디어·과거 결정)를 조회해 답합니다.",
    "예) <i>운영 단계 앱 뭐 있어?</i> · <i>happy-farm 열린 P1 알려줘</i> · <i>예전에 정리한 게임 아이디어 찾아줘</i>",
    "맥락을 기억하니 이어서 질문해도 됩니다. <code>/reset</code> 으로 초기화.",
    "",
    "<b>📥 볼트에 메모 저장</b> (<code>/save</code>)",
    "<code>/save 내용</code> → 볼트 <b>받은함</b>에 .md 초안 저장(5분 내 동기화). 첫 줄이 제목.",
    "",
    "<b>🔄 볼트 즉시 재인덱싱</b> (<code>/index</code>)",
    "문서를 추가·수정한 직후 검색에 바로 반영하고 싶을 때. 변경분만 임베딩(평소엔 2시간마다 자동 증분).",
    "",
    "<b>📝 기획 → 이슈 생성</b> (<code>/plan</code> 또는 📝 기획)",
    "앱 선택 → 아이디어 한 줄 입력 → AI가 코드베이스를 반영한 초안 작성 → <b>[✅ 이슈 생성]</b> 버튼.",
    "버튼을 눌러야 실제 GitHub 이슈가 생깁니다(자동 생성 아님).",
    "",
    "<b>🐞 버그 → 이슈 생성</b> (<code>/bug</code> 또는 🐞 버그)",
    "앱 선택 → 증상 답장 → AI가 재현 절차·기대/실제·심각도로 정리 → <b>[✅ 커밋]</b> 버튼 → GitHub 이슈(라벨 <code>bug</code>).",
    "",
    "<b>⚡ 빠른 버튼 / 명령어</b>",
    "📋 승인 (<code>/approvals</code>) — 승인 대기 + 버튼 승인",
    "🔥 P1 (<code>/p1</code>) — 전 레포 P1 이슈",
    "📊 현황 (<code>/status</code>) — 앱 선택 → 상세",
    "📈 지표 (<code>/metrics</code>) — GA4 DAU·잔존·광고 (앱 선택 → 상세)",
    "🧹 초기화 (<code>/reset</code>) — 대화 맥락 비우기",
    "ℹ️ 도움말 (<code>/help</code>) — 이 안내",
    "",
    "<b>🔒 원칙</b>: 조회·대화는 자유, 쓰기(이슈/승인)는 항상 버튼 확인 후.",
    "🌐 웹 백오피스: https://backoffice.vzyx.xyz",
  ].join("\n");
}

export async function handleTelegramUpdate(u: TgUpdate): Promise<void> {
  if (u.callback_query) return handleCallback(u.callback_query);
  if (u.message) return handleMessage(u.message);
}

async function handleMessage(m: TgMessage): Promise<void> {
  if (m.chat?.id == null) return;
  if (!authorized(m.from?.id)) {
    await sendMessage(m.chat.id, "권한이 없습니다.");
    return;
  }
  const chatId = m.chat.id;
  const text = (m.text ?? "").trim();
  if (!text) return;

  // 1) 빠른 버튼(reply keyboard) 라벨
  switch (text) {
    case "📋 승인":
      return cmdApprovals(chatId);
    case "🔥 P1":
      return cmdP1(chatId);
    case "📊 현황":
      return cmdStatusList(chatId);
    case "📈 지표":
      return cmdMetricsList(chatId);
    case "📝 기획":
      return cmdPlanStart(chatId);
    case "🐞 버그":
      return cmdBugStart(chatId);
    case "ℹ️ 도움말":
      return sendHelp(chatId);
    case "🧹 초기화":
      await resetChat(chatId);
      await clearPending(chatId);
      await sendMessage(chatId, "🧹 대화 맥락을 초기화했습니다.");
      return;
  }

  // 2) 다단계 흐름(아이디어 입력 대기 등) — 명령이 아닐 때만 소비
  const pending = await getPending(chatId);
  if (pending && !text.startsWith("/")) {
    await clearPending(chatId);
    if (pending.action === "plan_idea") {
      return handlePlanIdea(chatId, m.from?.id, String(pending.data.slug ?? ""), text);
    }
    if (pending.action === "bug_report") {
      return handleBugReport(chatId, m.from?.id, String(pending.data.slug ?? ""), text);
    }
  }

  // 3) 일반 텍스트 → AI 채팅(tool-loop)
  if (!text.startsWith("/")) {
    return cmdChat(chatId, text);
  }

  // 4) 슬래시 명령
  const [cmd, ...args] = text.split(/\s+/);
  switch (cmd) {
    case "/start":
    case "/help":
      await sendHelp(chatId);
      break;
    case "/approvals":
      await cmdApprovals(chatId);
      break;
    case "/p1":
      await cmdP1(chatId);
      break;
    case "/status":
      if (args[0]) await cmdStatusDetail(chatId, args[0]);
      else await cmdStatusList(chatId);
      break;
    case "/metrics":
      if (args[0]) await cmdMetricsDetail(chatId, args[0]);
      else await cmdMetricsList(chatId);
      break;
    case "/plan":
      await cmdPlanStart(chatId);
      break;
    case "/bug":
      await cmdBugStart(chatId);
      break;
    case "/release":
      await cmdReleaseStart(chatId);
      break;
    case "/deploy":
      await cmdDeployStart(chatId);
      break;
    case "/reset":
      await resetChat(chatId);
      await clearPending(chatId);
      await sendMessage(chatId, "🧹 대화 맥락을 초기화했습니다.");
      break;
    case "/chat": {
      const msg = args.join(" ").trim();
      if (!msg) await sendMessage(chatId, "사용법: /chat <메시지> — 또는 그냥 메시지를 보내세요.");
      else await cmdChat(chatId, msg);
      break;
    }
    case "/save": {
      const msg = args.join(" ").trim();
      await cmdSave(chatId, msg);
      break;
    }
    case "/index":
      await cmdIndex(chatId);
      break;
    default:
      await sendMessage(chatId, "알 수 없는 명령입니다. /help");
      break;
  }
}

async function sendHelp(chatId: number): Promise<void> {
  await sendWithReplyKeyboard(chatId, helpText(), QUICK_KEYBOARD);
}

// AI 비서 턴 기반 채팅.
async function cmdChat(chatId: number, text: string): Promise<void> {
  await sendChatAction(chatId, "typing");
  const reply = await handleChat(chatId, text);
  await sendMessage(chatId, mdToTelegramHtml(reply));
}

// /save: 메모를 볼트 받은함 draft 로 적재(라이터 CronJob 이 5분 내 파일 생성).
async function cmdSave(chatId: number, text: string): Promise<void> {
  if (!text) {
    await sendMessage(chatId, "사용법: /save <메모 내용> — 첫 줄이 제목이 됩니다.");
    return;
  }
  const title = text.split("\n")[0].slice(0, 60).trim() || "메모";
  await enqueueVaultWrite({
    folder: "받은함",
    title,
    content: text,
    source: "telegram",
    requestedBy: String(chatId),
  });
  await sendMessage(
    chatId,
    esc(`📥 받은함에 저장 예약됨: “${title}”\n5분 내 Obsidian 으로 동기화됩니다.`),
  );
}

// /index: 볼트 즉시 재인덱싱(data ns 인덱서 Job 생성). 변경분만 임베딩.
async function cmdIndex(chatId: number): Promise<void> {
  try {
    const { triggerVaultIndex } = await import("@/lib/k8s/vault-trigger");
    const r = await triggerVaultIndex();
    await sendMessage(
      chatId,
      esc(
        r.triggered
          ? `🔄 ${r.message} (${r.name})\n변경/신규 파일만 임베딩되며 잠시 후 검색에 반영됩니다.`
          : `⏳ ${r.message}`,
      ),
    );
  } catch (e) {
    await sendMessage(chatId, esc(`인덱싱 트리거 실패: ${(e as Error).message}`));
  }
}

// ── /plan: 앱 선택 → 아이디어 → 미리보기 → 버튼 커밋 ──
async function cmdPlanStart(chatId: number): Promise<void> {
  if (!env.geminiChatConfigured()) {
    await sendMessage(chatId, "AI 기획이 비활성 상태입니다 (Gemini 미설정).");
    return;
  }
  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: { slug: true, displayName: true },
  });
  if (apps.length === 0) {
    await sendMessage(chatId, "등록된 앱이 없습니다.");
    return;
  }
  const buttons = chunk2(
    apps.map((a) => ({ text: a.displayName, callback_data: `plan:app:${a.slug}` })),
  );
  await sendMessage(chatId, "<b>📝 기획할 앱을 선택하세요</b>", buttons);
}

async function handlePlanIdea(
  chatId: number,
  fromId: number | undefined,
  slug: string,
  idea: string,
): Promise<void> {
  if (!SLUG_RE.test(slug)) {
    await sendMessage(chatId, "잘못된 앱입니다. /plan 다시 시도하세요.");
    return;
  }
  const app = await prisma.app.findFirst({
    where: { slug, ...visibleAppWhere },
    select: { id: true },
  });
  if (!app) {
    await sendMessage(chatId, `'${esc(slug)}' 앱을 찾을 수 없습니다.`);
    return;
  }
  await sendChatAction(chatId, "typing");
  await sendMessage(chatId, "⏳ 기획 초안 생성 중… (수십 초)");
  try {
    const d = await createPlanningDraftCore({
      appId: app.id,
      idea,
      actorLabel: `telegram:${fromId ?? "?"}`,
    });
    await sendDraftPreview(chatId, "📝 기획 초안", d);
  } catch (e) {
    await sendMessage(chatId, "초안 생성 실패: " + (e instanceof Error ? e.message : "error"));
  }
}

// ── /bug: 앱 선택 → 증상 → AI 정리 → 버튼 커밋(label: bug) ──
async function cmdBugStart(chatId: number): Promise<void> {
  if (!env.geminiChatConfigured()) {
    await sendMessage(chatId, "AI 정리가 비활성 상태입니다 (Gemini 미설정).");
    return;
  }
  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: { slug: true, displayName: true },
  });
  if (apps.length === 0) {
    await sendMessage(chatId, "등록된 앱이 없습니다.");
    return;
  }
  const buttons = chunk2(
    apps.map((a) => ({ text: a.displayName, callback_data: `bug:app:${a.slug}` })),
  );
  await sendMessage(chatId, "<b>🐞 버그를 등록할 앱을 선택하세요</b>", buttons);
}

async function cbBugApp(cq: TgCallback, slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) {
    await answerCallback(cq.id, "잘못된 앱");
    return;
  }
  if (cq.message) await setPending(cq.message.chat.id, "bug_report", { slug });
  await answerCallback(cq.id);
  if (cq.message) {
    await editMessageText(
      cq.message.chat.id,
      cq.message.message_id,
      `🐞 <b>${esc(slug)}</b> 버그 — 증상을 답장으로 적어주세요.\n무엇을/어디서/어떻게 하면 발생하는지 있는 그대로 쓰면 됩니다.`,
      [],
    );
  }
}

async function handleBugReport(
  chatId: number,
  fromId: number | undefined,
  slug: string,
  symptom: string,
): Promise<void> {
  if (!SLUG_RE.test(slug)) {
    await sendMessage(chatId, "잘못된 앱입니다. /bug 다시 시도하세요.");
    return;
  }
  const app = await prisma.app.findFirst({
    where: { slug, ...visibleAppWhere },
    select: { id: true },
  });
  if (!app) {
    await sendMessage(chatId, `'${esc(slug)}' 앱을 찾을 수 없습니다.`);
    return;
  }
  await sendChatAction(chatId, "typing");
  await sendMessage(chatId, "⏳ 버그 리포트 정리 중… (수십 초)");
  try {
    const d = await createBugDraftCore({
      appId: app.id,
      symptom,
      actorLabel: `telegram:${fromId ?? "?"}`,
    });
    await sendDraftPreview(chatId, "🐞 버그 리포트", d);
  } catch (e) {
    await sendMessage(chatId, "정리 실패: " + (e instanceof Error ? e.message : "error"));
  }
}

// 초안 미리보기 + 커밋/취소 버튼(기획·단계 에이전트 공용).
async function sendDraftPreview(
  chatId: number,
  heading: string,
  d: { id: string; title: string | null; outputText: string },
): Promise<void> {
  const head = `<b>${esc(heading)}</b>${d.title ? `\n<b>${esc(d.title)}</b>` : ""}`;
  const body = esc(d.outputText.slice(0, 1400)) + (d.outputText.length > 1400 ? "\n…(이하 생략, 커밋 시 전체 반영)" : "");
  await sendMessage(chatId, `${head}\n\n${body}`, [
    [
      { text: "✅ 커밋", callback_data: `plan:make:${d.id}` },
      { text: "✖️ 취소", callback_data: `plan:cancel:${d.id}` },
    ],
  ]);
}

const GEN_KINDS = new Set<AiDraftKind>([
  "TASK_BREAKDOWN",
  "QA_CHECKLIST",
  "RELEASE_NOTES",
  "STORE_COPY",
  "IMPROVEMENT_HYPOTHESIS",
]);
const GEN_HEADING: Record<string, string> = {
  TASK_BREAKDOWN: "🧩 작업 분해",
  QA_CHECKLIST: "🧪 QA 체크리스트",
  RELEASE_NOTES: "🚀 릴리스 노트",
  STORE_COPY: "🏬 스토어 문안",
  IMPROVEMENT_HYPOTHESIS: "💡 개선 가설",
};

// 넛지/주간리뷰 버튼 → 단계 에이전트 초안 생성 → 미리보기.
async function cbGen(cq: TgCallback, fromId: number, kindRaw: string, appId: string): Promise<void> {
  const kind = kindRaw as AiDraftKind;
  if (!GEN_KINDS.has(kind) || !ID_RE.test(appId)) {
    await answerCallback(cq.id, "잘못된 요청");
    return;
  }
  await answerCallback(cq.id, "⏳ 생성 중…");
  const chatId = cq.message?.chat.id;
  if (chatId == null) return;
  await sendChatAction(chatId, "typing");
  try {
    let issueNumber: number | undefined;
    if (kind === "TASK_BREAKDOWN" || kind === "QA_CHECKLIST") {
      const latest = await prisma.issueMirror.findFirst({
        where: { appId, state: "OPEN" },
        orderBy: { ghUpdatedAt: "desc" },
        select: { number: true },
      });
      if (!latest) {
        await sendMessage(chatId, "열린 이슈가 없어 생성할 수 없습니다.");
        return;
      }
      issueNumber = latest.number;
    }
    await sendMessage(chatId, `⏳ ${GEN_HEADING[kind] ?? "초안"} 생성 중… (수십 초)`);
    const d = await generateStageDraftCore({
      appId,
      kind,
      issueNumber,
      actorLabel: `telegram:${fromId}`,
    });
    await sendDraftPreview(chatId, GEN_HEADING[kind] ?? "AI 초안", d);
  } catch (e) {
    await sendMessage(chatId, "생성 실패: " + (e instanceof Error ? e.message : "error"));
  }
}

async function handleCallback(cq: TgCallback): Promise<void> {
  const fromId = cq.from?.id;
  if (!fromId || !authorized(fromId)) {
    await answerCallback(cq.id, "권한 없음");
    return;
  }
  const [action, ...rest] = (cq.data ?? "").split(":");
  const arg = rest.slice(1).join(":");

  if (action === "approve") return cbApprove(cq, fromId, rest);

  if (action === "plan") {
    const sub = rest[0];
    if (sub === "app") return cbPlanApp(cq, arg);
    if (sub === "make") return cbPlanMake(cq, fromId, arg);
    if (sub === "cancel") return cbPlanCancel(cq, arg);
  }

  // 버그: 앱 선택만 전용. 커밋/취소는 plan:make · plan:cancel 재사용(kind 무관).
  if (action === "bug" && rest[0] === "app") return cbBugApp(cq, arg);

  if (action === "gen") return cbGen(cq, fromId, rest[0], arg);

  if (action === "rel") return cbRelease(cq, fromId, rest);
  if (action === "deploy") return cbDeploy(cq, fromId, rest);
  if (action === "dq") return cbReleaseDeploy(cq, fromId, rest);
  if (action === "ds") {
    await answerCallback(cq.id, deployStateCallbackText(rest[3] ?? ""));
    return;
  }
  if (action === "pp") return cbPlayPromote(cq, fromId, rest);
  if (action === "ap") return cbAppStorePrepare(cq, fromId, rest);
  if (action === "as") return cbAppStoreSubmit(cq, fromId, rest);

  if (action === "status" && rest[0] === "app") {
    await answerCallback(cq.id);
    if (cq.message) await cmdStatusDetail(cq.message.chat.id, arg);
    return;
  }

  if (action === "metrics" && rest[0] === "app") {
    await answerCallback(cq.id);
    if (cq.message) await cmdMetricsDetail(cq.message.chat.id, arg);
    return;
  }

  await answerCallback(cq.id);
}

async function cbPlanApp(cq: TgCallback, slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) {
    await answerCallback(cq.id, "잘못된 앱");
    return;
  }
  if (cq.message) await setPending(cq.message.chat.id, "plan_idea", { slug });
  await answerCallback(cq.id);
  if (cq.message) {
    await editMessageText(
      cq.message.chat.id,
      cq.message.message_id,
      `✏️ <b>${esc(slug)}</b> 기획 — 핵심 아이디어를 한 줄로 답장하세요.`,
      [],
    );
  }
}

async function cbPlanMake(cq: TgCallback, fromId: number, draftId: string): Promise<void> {
  if (!ID_RE.test(draftId)) {
    await answerCallback(cq.id, "잘못된 요청");
    return;
  }
  try {
    const r = await commitDraftCore({ draftId, actorLabel: `telegram:${fromId}` });
    await answerCallback(cq.id, "이슈 생성됨");
    if (cq.message) {
      const repo = esc(r.repoFullName.replace("seorilabs/", ""));
      await editMessageText(
        cq.message.chat.id,
        cq.message.message_id,
        `✅ 이슈 생성됨 — ${repo} #${r.issueNumber}\n${r.url}`,
        [],
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "실패";
    await answerCallback(cq.id, msg.includes("이미") ? "이미 처리됨" : "생성 실패");
  }
}

async function cbPlanCancel(cq: TgCallback, draftId: string): Promise<void> {
  if (ID_RE.test(draftId)) {
    const draft = await prisma.aiDraft.findUnique({ where: { id: draftId } });
    if (draft && draft.status === "DRAFT") {
      await prisma.aiDraft.update({ where: { id: draftId }, data: { status: "DISCARDED" } });
    }
  }
  await answerCallback(cq.id, "취소됨");
  if (cq.message) {
    await editMessageText(cq.message.chat.id, cq.message.message_id, "✖️ 기획 초안 취소됨", []);
  }
}

async function cbApprove(cq: TgCallback, fromId: number, rest: string[]): Promise<void> {
  const gate = rest[0];
  const issueId = rest.slice(1).join(":");
  if ((gate !== "planning" && gate !== "release") || !ID_RE.test(issueId)) {
    await answerCallback(cq.id, "잘못된 요청");
    return;
  }
  try {
    const issue = await prisma.issueMirror.findUnique({
      where: { id: issueId },
      select: { repoFullName: true, app: { select: { status: true } } },
    });
    if (!issue) {
      await answerCallback(cq.id, "이슈 없음");
      return;
    }
    const appStatus =
      issue.app?.status ??
      (
        await prisma.app.findUnique({
          where: { repoFullName: issue.repoFullName },
          select: { status: true },
        })
      )?.status;
    if (appStatus && isDisabledAppStatus(appStatus)) {
      await answerCallback(cq.id, HIDDEN_APP_ERROR);
      return;
    }
    const r = await toggleApprovalCore({
      issueId,
      gate,
      on: false,
      reason: "텔레그램에서 승인",
      actorLabel: `telegram:${fromId}`,
    });
    await answerCallback(cq.id, r.changed ? "승인 처리됨" : "이미 처리됨");
    if (cq.message) {
      const repo = esc(r.repoFullName.replace("seorilabs/", ""));
      await editMessageText(
        cq.message.chat.id,
        cq.message.message_id,
        r.changed ? `✅ 승인됨 — ${repo} #${r.number}` : `ℹ️ 이미 처리됨 — ${repo} #${r.number}`,
        [],
      );
    }
  } catch (e) {
    console.error("[telegram] approve error:", e instanceof Error ? e.message : "error");
    await answerCallback(cq.id, "승인 처리 실패");
  }
}

async function cmdApprovals(chatId: number): Promise<void> {
  const open = await prisma.issueMirror.findMany({
    where: { ...visibleIssueWhere, state: "OPEN" },
    orderBy: [{ priority: "asc" }],
    take: 200,
  });
  const pend = open.filter((i) => {
    const l = asStringArray(i.labels);
    return hasApproval(l, "planning") || hasApproval(l, "release");
  });
  if (pend.length === 0) {
    await sendMessage(chatId, "✅ 승인 대기 없음");
    return;
  }
  await sendMessage(chatId, `<b>승인 대기 ${pend.length}건</b>`);
  for (const i of pend.slice(0, 10)) {
    const gate = hasApproval(asStringArray(i.labels), "release") ? "release" : "planning";
    const repo = i.repoFullName.replace("seorilabs/", "");
    await sendMessage(
      chatId,
      `${gate === "release" ? "🚀" : "📝"} <b>${esc(repo)} #${i.number}</b>\n${esc(i.title)}`,
      [[{ text: `승인 (${gate})`, callback_data: `approve:${gate}:${i.id}` }]],
    );
  }
}

async function cmdP1(chatId: number): Promise<void> {
  const issues = await prisma.issueMirror.findMany({
    where: { ...visibleIssueWhere, state: "OPEN", priority: "P1" },
    orderBy: [{ ghUpdatedAt: "desc" }],
    take: 20,
  });
  if (issues.length === 0) {
    await sendMessage(chatId, "P1 이슈 없음");
    return;
  }
  const lines = issues.map(
    (i) => `• <b>${esc(i.repoFullName.replace("seorilabs/", ""))} #${i.number}</b> ${esc(i.title)}`,
  );
  await sendMessage(chatId, `<b>열린 P1 ${issues.length}건</b>\n${lines.join("\n")}`);
}

// 앱 현황 — 단계 요약 1줄 + 앱 선택 버튼(텍스트 최소화).
async function cmdStatusList(chatId: number): Promise<void> {
  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: [{ currentStage: "asc" }, { displayName: "asc" }],
    select: { slug: true, displayName: true, currentStage: true },
  });
  if (apps.length === 0) {
    await sendMessage(chatId, "등록된 앱이 없습니다.");
    return;
  }
  const counts: Record<string, number> = {};
  for (const a of apps) counts[a.currentStage] = (counts[a.currentStage] ?? 0) + 1;
  const summary = STAGES.filter((s) => counts[s])
    .map((s) => `${STAGE_KO[s]} ${counts[s]}`)
    .join(" · ");
  const buttons = chunk2(
    apps.map((a) => ({ text: a.displayName, callback_data: `status:app:${a.slug}` })),
  );
  await sendMessage(chatId, `<b>📊 앱 ${apps.length}개</b>\n${summary}`, buttons);
}

async function cmdStatusDetail(chatId: number, slug: string): Promise<void> {
  const app = await prisma.app.findFirst({
    where: { slug, ...visibleAppWhere },
    include: {
      issues: { where: { state: "OPEN" }, select: { priority: true } },
      pullRequests: { where: { state: "OPEN" }, select: { id: true } },
      releases: { orderBy: { updatedAt: "desc" }, take: 1 },
    },
  });
  if (!app) {
    await sendMessage(chatId, `'${esc(slug)}' 앱을 찾을 수 없습니다.`);
    return;
  }
  const p1 = app.issues.filter((i) => i.priority === "P1").length;
  const rel = app.releases[0];
  await sendMessage(
    chatId,
    [
      `<b>${esc(app.displayName)}</b> — ${STAGE_KO[app.currentStage]}`,
      `타입: ${app.type}/${app.engine}`,
      `열린 이슈 ${app.issues.length} (P1 ${p1}) · PR ${app.pullRequests.length}`,
      rel ? `최근 릴리스: ${esc(rel.version)} ${esc(rel.market)} ${esc(rel.status)}` : "릴리스 없음",
      `https://backoffice.vzyx.xyz/apps/${app.id}`,
    ].join("\n"),
  );
}

// ── /metrics: GA4 지표 조회(웹 analytics 와 동일한 AppMetricDaily 재사용) ──
function pctStr(v: number | null): string {
  return v == null ? "—" : `${v}%`;
}

// 지표 목록 — GA4 대상 앱별 최신 스냅샷 1줄 + 앱 선택 버튼(상세용).
async function cmdMetricsList(chatId: number): Promise<void> {
  const all = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: { id: true, slug: true, displayName: true, firebaseProject: true, ga4Dataset: true },
  });
  const apps = all.filter((a) => resolveGa4Target(a));
  if (apps.length === 0) {
    await sendMessage(chatId, "GA4 지표 대상 앱이 없습니다. (firebaseProject/dataset 매핑 필요)");
    return;
  }
  const items = await Promise.all(
    apps.map(async (a) => ({
      app: a,
      latest: await prisma.appMetricDaily.findFirst({
        where: { appId: a.id },
        orderBy: { date: "desc" },
      }),
    })),
  );
  const lines = items.map(({ app, latest }) =>
    latest
      ? `• <b>${esc(app.displayName)}</b> — DAU ${latest.dau} · 신규 ${latest.newUsers} · D1 ${pctStr(latest.d1Pct)} · D7 ${pctStr(latest.d7Pct)} <i>(${isoDate(latest.date)})</i>`
      : `• <b>${esc(app.displayName)}</b> — <i>수집 데이터 없음</i>`,
  );
  const buttons = chunk2(
    apps.map((a) => ({ text: a.displayName, callback_data: `metrics:app:${a.slug}` })),
  );
  await sendMessage(
    chatId,
    `<b>📈 앱 지표</b> (GA4 · 기준 D-1)\n${lines.join("\n")}\n\n앱을 선택하면 상세를 봅니다.`,
    buttons,
  );
}

// 지표 상세 — 최신 핵심 지표 + 최근 7일 DAU 추이.
async function cmdMetricsDetail(chatId: number, slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) {
    await sendMessage(chatId, "잘못된 앱입니다. /metrics 다시 시도하세요.");
    return;
  }
  const app = await prisma.app.findFirst({
    where: { slug, ...visibleAppWhere },
    select: { id: true, slug: true, displayName: true, firebaseProject: true, ga4Dataset: true },
  });
  if (!app) {
    await sendMessage(chatId, `'${esc(slug)}' 앱을 찾을 수 없습니다.`);
    return;
  }
  const rowsDesc = await prisma.appMetricDaily.findMany({
    where: { appId: app.id },
    orderBy: { date: "desc" },
    take: 14,
  });
  if (rowsDesc.length === 0) {
    const mapped = resolveGa4Target(app) != null;
    await sendMessage(
      chatId,
      `<b>📈 ${esc(app.displayName)}</b>\n수집된 지표가 아직 없습니다.${mapped ? " (GA4 export 활성화 후 수집)" : "\nGA4 매핑이 없습니다(firebaseProject/dataset)."}`,
    );
    return;
  }
  const latest = rowsDesc[0];
  const trend = rowsDesc
    .slice(0, 7)
    .reverse()
    .map((r) => `${isoDate(r.date).slice(5)}  DAU ${r.dau}`);

  // 플랫폼 비중(0 인 것 제외).
  const platform = platformSegments(latest.dauAndroid, latest.dauIos, latest.dauWeb)
    .segs.map((s) => `${s.label} ${s.value}`)
    .join(" · ");

  // 국가 Top 3(raw JSON).
  const bd = (latest.raw ?? {}) as MetricBreakdowns;
  const countries = (bd.countries ?? [])
    .slice(0, 3)
    .map((c) => `${c.k} ${c.dau}`)
    .join(" · ");

  const rate = engagementRate(latest.engagedUsers, latest.dau);

  await sendMessage(
    chatId,
    [
      `<b>📈 ${esc(app.displayName)}</b> <i>(기준 ${isoDate(latest.date)})</i>`,
      "",
      `DAU <b>${latest.dau}</b> · 신규 ${latest.newUsers}`,
      `잔존 D1 ${pctStr(latest.d1Pct)} · D3 ${pctStr(latest.d3Pct)} · D7 ${pctStr(latest.d7Pct)}`,
      `활성사용자 ${latest.engagedUsers}명 · 참여율 ${pctStr(rate)}${latest.avgEngageSec != null ? ` · 평균 ${latest.avgEngageSec}s` : ""}`,
      platform ? `플랫폼 ${platform}` : null,
      countries ? `국가 ${countries}` : null,
      `광고 노출 ${latest.adImpressions}`,
      "",
      `<b>DAU 추이(최근 ${trend.length}일)</b>`,
      esc(trend.join("\n")),
      "",
      `https://backoffice.vzyx.xyz/analytics?app=${app.slug}`,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
}

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const BUMPS = new Set(["patch", "minor", "major"]);
const DEPLOY_TARGETS = new Set(["AIT", "PLAY", "APPSTORE", "ALL"]);

async function appBySlug(slug: string) {
  if (!SLUG_RE.test(slug)) return null;
  return prisma.app.findFirst({
    where: { slug, ...visibleAppWhere },
    select: { id: true, slug: true, displayName: true, repoFullName: true, marketTargets: true },
  });
}

async function appById(id: string) {
  if (!ID_RE.test(id)) return null;
  return prisma.app.findFirst({
    where: { id, ...visibleAppWhere },
    select: { id: true, slug: true, displayName: true, repoFullName: true, marketTargets: true },
  });
}

type ReleaseDeployApp = NonNullable<Awaited<ReturnType<typeof appBySlug>>>;

function deployTargetFromAuditPayload(payload: unknown): DeployTarget | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const target = String((payload as { target?: unknown }).target ?? "") as DeployTarget;
  return DEPLOY_TARGETS.has(target) ? target : null;
}

async function loadReleaseDeployStates(
  app: ReleaseDeployApp,
  tag: string,
  targets: PlatformDeployTarget[],
): Promise<DeployButtonStates> {
  const [auditRows, releaseRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        action: "release.deploy.dispatch",
        entityType: "release",
        entityId: `${app.repoFullName}@${tag}`,
      },
      select: { payload: true, createdAt: true },
    }),
    prisma.releaseRecord.findMany({
      where: { appId: app.id, version: tag, market: { in: targets } },
      select: { market: true, status: true, updatedAt: true },
    }),
  ]);

  const dispatches = auditRows.flatMap((row): DeployDispatchStateInput[] => {
    const target = deployTargetFromAuditPayload(row.payload);
    return target ? [{ target, createdAt: row.createdAt }] : [];
  });
  const runs = releaseRows.map(
    (row): DeployRunStateInput => ({
      target: row.market as PlatformDeployTarget,
      status: row.status,
      updatedAt: row.updatedAt,
    }),
  );
  return resolveDeployButtonStates(targets, dispatches, runs);
}

function releaseDeployMessage(opts: {
  app: ReleaseDeployApp;
  tag: string;
  releaseUrl?: string;
  created?: boolean;
  note?: string;
}): string {
  const targets = platformDeployTargets(deployTargetsFor(opts.app.marketTargets));
  const releaseUrl =
    opts.releaseUrl ??
    `https://github.com/${opts.app.repoFullName}/releases/tag/${encodeURIComponent(opts.tag)}`;
  const lines = [
    `✅ <b>${esc(opts.app.displayName)} ${esc(opts.tag)}</b> 릴리즈 생성됨${opts.created === false ? " (기존 태그 재사용)" : ""}`,
    esc(releaseUrl),
    "출시노트 번역은 백그라운드에서 생성 중입니다.",
  ];
  if (targets.length > 0) {
    lines.push("", "<b>📦 플랫폼별 배포</b>", "각 버튼은 독립적으로 트리거됩니다.");
  } else {
    lines.push("", "배포 가능한 플랫폼 워크플로우가 설정되어 있지 않습니다.");
  }
  if (opts.note) lines.push("", opts.note);
  return lines.join("\n");
}

async function editReleaseDeployMessage(opts: {
  chatId: number;
  messageId: number;
  app: ReleaseDeployApp;
  tag: string;
  states: DeployButtonStates;
  releaseUrl?: string;
  created?: boolean;
  note?: string;
}): Promise<void> {
  const targets = platformDeployTargets(deployTargetsFor(opts.app.marketTargets));
  await editMessageText(
    opts.chatId,
    opts.messageId,
    releaseDeployMessage(opts),
    [
      ...buildReleaseDeployButtons(opts.app.id, opts.tag, targets, opts.states, DEPLOY_TARGET_KO),
      ...buildMarketReviewButtons(opts.app.id, opts.tag, targets),
    ],
  );
}

/** appId+tag 로 릴리즈 배포 메시지(버튼 포함)를 재구성. 확인 취소/후속 액션 결과 표시에 사용. */
async function rebuildReleaseDeployMessage(
  chatId: number,
  messageId: number,
  app: ReleaseDeployApp,
  tag: string,
  note?: string,
): Promise<void> {
  const targets = platformDeployTargets(deployTargetsFor(app.marketTargets));
  const states = await loadReleaseDeployStates(app, tag, targets);
  await editReleaseDeployMessage({ chatId, messageId, app, tag, states, note });
}

// ── 릴리즈 메시지의 마켓 마무리 버튼: Google 프로덕션 승격 / App Store 심사 준비·제출 ──

async function cbPlayPromote(cq: TgCallback, fromId: number, rest: string[]): Promise<void> {
  const sub = rest[0]; // "c" | "go" | "cancel"
  const appId = rest[1] ?? "";
  const tag = rest[2] ?? "";
  const chatId = cq.message?.chat.id;
  const mid = cq.message?.message_id;
  if (!ID_RE.test(appId) || !TAG_RE.test(tag)) {
    await answerCallback(cq.id, "잘못된 요청");
    return;
  }
  const app = await appById(appId);
  if (!app || chatId == null || mid == null) {
    await answerCallback(cq.id, "앱/메시지 없음");
    return;
  }

  if (sub === "cancel") {
    await answerCallback(cq.id, "취소됨");
    await rebuildReleaseDeployMessage(chatId, mid, app, tag);
    return;
  }
  if (sub === "c") {
    await answerCallback(cq.id);
    await editMessageText(
      chatId,
      mid,
      `⚠️ <b>${esc(app.displayName)} ${esc(tag)}</b> — 내부 빌드를 Google Play <b>프로덕션</b>으로 승격(심사 제출)합니다. 재빌드 없이 진행됩니다. 계속할까요?`,
      [
        [
          { text: "⬆️ 승격 실행", callback_data: `pp:go:${appId}:${tag}` },
          { text: "✖️ 취소", callback_data: `pp:cancel:${appId}:${tag}` },
        ],
      ],
    );
    return;
  }
  if (sub === "go") {
    await answerCallback(cq.id, "⏳ 프로덕션 승격 트리거 중…");
    try {
      await promoteGooglePlay({
        repoFullName: app.repoFullName,
        tag,
        actorLabel: `telegram:${fromId}`,
      });
      await rebuildReleaseDeployMessage(
        chatId,
        mid,
        app,
        tag,
        "⬆️ Google Play 프로덕션 승격을 트리거했습니다. 완료 시 결과 알림이 옵니다.",
      );
    } catch (e) {
      await rebuildReleaseDeployMessage(
        chatId,
        mid,
        app,
        tag,
        `❌ 프로덕션 승격 실패: ${esc((e as Error).message)}`,
      );
    }
    return;
  }
  await answerCallback(cq.id);
}

async function cbAppStorePrepare(cq: TgCallback, fromId: number, rest: string[]): Promise<void> {
  const appId = rest[0] ?? "";
  const tag = rest[1] ?? "";
  const chatId = cq.message?.chat.id;
  const mid = cq.message?.message_id;
  if (!ID_RE.test(appId) || !TAG_RE.test(tag)) {
    await answerCallback(cq.id, "잘못된 요청");
    return;
  }
  const app = await appById(appId);
  if (!app || chatId == null || mid == null) {
    await answerCallback(cq.id, "앱/메시지 없음");
    return;
  }
  await answerCallback(cq.id, "⏳ 심사 준비 중…");
  try {
    const r = await prepareAppStore({
      repoFullName: app.repoFullName,
      tag,
      actorLabel: `telegram:${fromId}`,
    });
    const note = r.ready
      ? `📝 App Store 심사 준비 완료 — what's new ${r.localizationsUpdated.length}개 언어 반영 + 빌드 연결. 이제 '🚀 심사 제출' 가능.`
      : `⏳ 노트 반영됨. ${esc(r.reason ?? "빌드 처리 대기 중")}`;
    await rebuildReleaseDeployMessage(chatId, mid, app, tag, note);
  } catch (e) {
    await rebuildReleaseDeployMessage(
      chatId,
      mid,
      app,
      tag,
      `❌ 심사 준비 실패: ${esc((e as Error).message)}`,
    );
  }
}

async function cbAppStoreSubmit(cq: TgCallback, fromId: number, rest: string[]): Promise<void> {
  const sub = rest[0]; // "c" | "go" | "cancel"
  const appId = rest[1] ?? "";
  const tag = rest[2] ?? "";
  const chatId = cq.message?.chat.id;
  const mid = cq.message?.message_id;
  if (!ID_RE.test(appId) || !TAG_RE.test(tag)) {
    await answerCallback(cq.id, "잘못된 요청");
    return;
  }
  const app = await appById(appId);
  if (!app || chatId == null || mid == null) {
    await answerCallback(cq.id, "앱/메시지 없음");
    return;
  }

  if (sub === "cancel") {
    await answerCallback(cq.id, "취소됨");
    await rebuildReleaseDeployMessage(chatId, mid, app, tag);
    return;
  }
  if (sub === "c") {
    await answerCallback(cq.id);
    await editMessageText(
      chatId,
      mid,
      `⚠️ <b>${esc(app.displayName)} ${esc(tag)}</b> — App Store <b>심사에 제출</b>합니다. 되돌리기 어렵습니다. 계속할까요?\n(먼저 '심사 준비'로 빌드가 연결돼 있어야 합니다.)`,
      [
        [
          { text: "🚀 심사 제출", callback_data: `as:go:${appId}:${tag}` },
          { text: "✖️ 취소", callback_data: `as:cancel:${appId}:${tag}` },
        ],
      ],
    );
    return;
  }
  if (sub === "go") {
    await answerCallback(cq.id, "⏳ 심사 제출 중…");
    try {
      await submitAppStore({
        repoFullName: app.repoFullName,
        tag,
        actorLabel: `telegram:${fromId}`,
      });
      await rebuildReleaseDeployMessage(chatId, mid, app, tag, "🚀 App Store 심사에 제출했습니다.");
    } catch (e) {
      await rebuildReleaseDeployMessage(
        chatId,
        mid,
        app,
        tag,
        `❌ 심사 제출 실패: ${esc((e as Error).message)}`,
      );
    }
    return;
  }
  await answerCallback(cq.id);
}

// ── /release: 앱 선택 → bump → 확인 → 태그 + GitHub Release (출시노트는 webhook 후 비동기) ──
async function cmdReleaseStart(chatId: number): Promise<void> {
  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: { slug: true, displayName: true },
  });
  if (apps.length === 0) {
    await sendMessage(chatId, "등록된 앱이 없습니다.");
    return;
  }
  const buttons = chunk2(
    apps.map((a) => ({ text: a.displayName, callback_data: `rel:app:${a.slug}` })),
  );
  await sendMessage(chatId, "<b>🚀 릴리즈할 앱을 선택하세요</b>", buttons);
}

async function cbRelease(cq: TgCallback, fromId: number, rest: string[]): Promise<void> {
  const sub = rest[0];
  const slug = rest[1] ?? "";
  const chatId = cq.message?.chat.id;
  const mid = cq.message?.message_id;

  if (sub === "app") {
    if (!SLUG_RE.test(slug)) {
      await answerCallback(cq.id, "잘못된 앱");
      return;
    }
    await answerCallback(cq.id);
    if (chatId != null && mid != null) {
      await editMessageText(chatId, mid, `🚀 <b>${esc(slug)}</b> — 버전 증가 단위를 선택하세요.`, [
        [
          { text: "patch", callback_data: `rel:bump:${slug}:patch` },
          { text: "minor", callback_data: `rel:bump:${slug}:minor` },
          { text: "major", callback_data: `rel:bump:${slug}:major` },
        ],
      ]);
    }
    return;
  }

  if (sub === "cancel") {
    await answerCallback(cq.id, "취소됨");
    if (chatId != null && mid != null) await editMessageText(chatId, mid, "✖️ 릴리즈 취소됨", []);
    return;
  }

  const bump = rest[2] ?? "";
  if (!SLUG_RE.test(slug) || !BUMPS.has(bump)) {
    await answerCallback(cq.id, "잘못된 요청");
    return;
  }
  const app = await appBySlug(slug);
  if (!app) {
    await answerCallback(cq.id, "앱 없음");
    return;
  }

  if (sub === "bump") {
    await answerCallback(cq.id, "⏳ 확인 중…");
    if (chatId == null || mid == null) return;
    try {
      const preview = await previewNextTag(app.repoFullName, bump as Bump);
      await editMessageText(
        chatId,
        mid,
        `🚀 <b>${esc(app.displayName)}</b>\n최신: ${esc(preview.latest ?? "(없음)")} → 생성: <b>${esc(preview.next)}</b>\n태그 + GitHub Release 를 진행할까요? 출시노트 번역은 이후 비동기로 생성됩니다.`,
        [
          [
            { text: `✅ ${preview.next} 생성`, callback_data: `rel:go:${slug}:${bump}` },
            { text: "✖️ 취소", callback_data: `rel:cancel:${slug}` },
          ],
        ],
      );
    } catch (e) {
      await editMessageText(chatId, mid, "태그 조회 실패: " + esc((e as Error).message), []);
    }
    return;
  }

  if (sub === "go") {
    await answerCallback(cq.id, "⏳ 릴리즈 생성 중…");
    if (chatId == null || mid == null) return;
    try {
      const r = await createReleaseTagWithNotes({
        repoFullName: app.repoFullName,
        bump: bump as Bump,
        actorLabel: `telegram:${fromId}`,
      });
      const targets = platformDeployTargets(deployTargetsFor(app.marketTargets));
      const states = await loadReleaseDeployStates(app, r.tag, targets);
      await editReleaseDeployMessage({
        chatId,
        messageId: mid,
        app,
        tag: r.tag,
        releaseUrl: r.releaseUrl,
        created: r.created,
        states,
      });
    } catch (e) {
      await editMessageText(chatId, mid, "릴리즈 실패: " + esc((e as Error).message), []);
    }
    return;
  }

  await answerCallback(cq.id);
}

// 릴리즈 생성 메시지의 플랫폼 버튼. 한 플랫폼을 눌러도 나머지 버튼과 상태를 유지한다.
async function cbReleaseDeploy(cq: TgCallback, fromId: number, rest: string[]): Promise<void> {
  const appId = rest[0] ?? "";
  const tag = rest[1] ?? "";
  const target = deployTargetFromCode(rest[2] ?? "");
  const chatId = cq.message?.chat.id;
  const mid = cq.message?.message_id;

  if (!ID_RE.test(appId) || !TAG_RE.test(tag) || !target) {
    await answerCallback(cq.id, "잘못된 배포 요청");
    return;
  }
  const app = await appById(appId);
  if (!app) {
    await answerCallback(cq.id, "앱 없음");
    return;
  }
  const targets = platformDeployTargets(deployTargetsFor(app.marketTargets));
  if (!targets.includes(target)) {
    await answerCallback(cq.id, "설정되지 않은 배포 대상");
    return;
  }
  if (chatId == null || mid == null) {
    await answerCallback(cq.id, "메시지 상태를 찾을 수 없음");
    return;
  }

  const states = await loadReleaseDeployStates(app, tag, targets);
  const current = states[target] ?? "READY";
  if (current !== "READY" && current !== "FAILED") {
    const stateText: Record<Exclude<DeployButtonState, "READY" | "FAILED">, string> = {
      TRIGGERING: "배포를 트리거하고 있습니다.",
      TRIGGERED: "이미 배포를 요청했습니다.",
      IN_PROGRESS: "배포가 진행 중입니다.",
      SUCCEEDED: "배포가 완료되었습니다.",
    };
    await answerCallback(cq.id, stateText[current]);
    await editReleaseDeployMessage({ chatId, messageId: mid, app, tag, states });
    return;
  }

  await answerCallback(cq.id, "🚀 배포 트리거 중…");
  const triggeringStates: DeployButtonStates = { ...states, [target]: "TRIGGERING" };
  await editReleaseDeployMessage({
    chatId,
    messageId: mid,
    app,
    tag,
    states: triggeringStates,
    note: `⏳ ${esc(DEPLOY_TARGET_KO[target])} 배포를 트리거하고 있습니다.`,
  });

  try {
    const res = await dispatchMarketDeploy({
      repoFullName: app.repoFullName,
      target,
      tag,
      actorLabel: `telegram:${fromId}`,
    });
    const refreshed = await loadReleaseDeployStates(app, tag, targets);
    // GitHub dispatch 성공 직후 audit 저장이 일시 실패해도 버튼은 중복 실행을 막는다.
    refreshed[target] = "TRIGGERED";
    let note = `☑️ ${esc(DEPLOY_TARGET_KO[target])} 배포를 트리거했습니다.`;
    if (res.xcodeCloudBuild != null) {
      note += `\n📱 Xcode Cloud 빌드 #${res.xcodeCloudBuild}`;
    }
    if (res.workflowFile) note += "\n빌드/업로드 완료 시 결과 알림이 옵니다.";
    await editReleaseDeployMessage({
      chatId,
      messageId: mid,
      app,
      tag,
      states: refreshed,
      note,
    });
  } catch (e) {
    const refreshed = await loadReleaseDeployStates(app, tag, targets);
    refreshed[target] = "FAILED";
    const message = e instanceof Error ? e.message : "알 수 없는 오류";
    await editReleaseDeployMessage({
      chatId,
      messageId: mid,
      app,
      tag,
      states: refreshed,
      note: `❌ ${esc(DEPLOY_TARGET_KO[target])} 트리거 실패: ${esc(message)}`,
    });
  }
}

// ── /deploy: 앱 → 태그 → 마켓 → 확인 → workflow_dispatch ──
async function cmdDeployStart(chatId: number): Promise<void> {
  const apps = await prisma.app.findMany({
    where: activeAppWhere,
    orderBy: { displayName: "asc" },
    select: { slug: true, displayName: true },
  });
  if (apps.length === 0) {
    await sendMessage(chatId, "등록된 앱이 없습니다.");
    return;
  }
  const buttons = chunk2(
    apps.map((a) => ({ text: a.displayName, callback_data: `deploy:app:${a.slug}` })),
  );
  await sendMessage(chatId, "<b>📦 배포할 앱을 선택하세요</b>", buttons);
}

async function cbDeploy(cq: TgCallback, fromId: number, rest: string[]): Promise<void> {
  const sub = rest[0];
  const slug = rest[1] ?? "";
  const chatId = cq.message?.chat.id;
  const mid = cq.message?.message_id;

  if (sub === "cancel") {
    await answerCallback(cq.id, "취소됨");
    if (chatId != null && mid != null) await editMessageText(chatId, mid, "✖️ 배포 취소됨", []);
    return;
  }

  const app = await appBySlug(slug);
  if (!app) {
    await answerCallback(cq.id, "앱 없음");
    return;
  }

  if (sub === "app") {
    await answerCallback(cq.id, "⏳ 태그 조회…");
    if (chatId == null || mid == null) return;
    try {
      const tags = await listVersionTags(app.repoFullName);
      if (tags.length === 0) {
        await editMessageText(chatId, mid, `${esc(app.displayName)} — 릴리즈 태그가 없습니다. 먼저 /release 로 생성하세요.`, []);
        return;
      }
      const buttons = chunk2(
        tags.slice(0, 6).map((t) => ({ text: t.name, callback_data: `deploy:tag:${slug}:${t.name}` })),
      );
      await editMessageText(chatId, mid, `📦 <b>${esc(app.displayName)}</b> — 배포할 릴리즈 태그를 선택하세요.`, buttons);
    } catch (e) {
      await editMessageText(chatId, mid, "태그 조회 실패: " + esc((e as Error).message), []);
    }
    return;
  }

  const tag = rest[2] ?? "";
  if (!TAG_RE.test(tag)) {
    await answerCallback(cq.id, "잘못된 태그");
    return;
  }

  if (sub === "tag") {
    await answerCallback(cq.id);
    if (chatId == null || mid == null) return;
    const targets = deployTargetsFor(app.marketTargets);
    if (targets.length === 0) {
      await editMessageText(chatId, mid, `${esc(app.displayName)} — 배포 마켓이 설정되어 있지 않습니다.`, []);
      return;
    }
    const btns = targets.map((t) => ({ text: DEPLOY_TARGET_KO[t], callback_data: `deploy:mk:${slug}:${tag}:${t}` }));
    await editMessageText(chatId, mid, `📦 <b>${esc(app.displayName)} ${esc(tag)}</b> — 배포 대상을 선택하세요.`, chunk2(btns));
    return;
  }

  const target = (rest[3] ?? "") as DeployTarget;
  if (!DEPLOY_TARGETS.has(target)) {
    await answerCallback(cq.id, "잘못된 대상");
    return;
  }

  if (sub === "mk") {
    await answerCallback(cq.id);
    if (chatId != null && mid != null) {
      await editMessageText(
        chatId,
        mid,
        `⚠️ <b>${esc(app.displayName)} ${esc(tag)}</b> → <b>${esc(DEPLOY_TARGET_KO[target])}</b> 배포를 실행합니다. 계속할까요?`,
        [
          [
            { text: "🚀 배포 실행", callback_data: `deploy:go:${slug}:${tag}:${target}` },
            { text: "✖️ 취소", callback_data: `deploy:cancel:${slug}` },
          ],
        ],
      );
    }
    return;
  }

  if (sub === "go") {
    await answerCallback(cq.id, "🚀 배포 트리거 중…");
    if (chatId == null || mid == null) return;
    try {
      const res = await dispatchMarketDeploy({
        repoFullName: app.repoFullName,
        target,
        tag,
        actorLabel: `telegram:${fromId}`,
      });
      let body = `🚀 <b>${esc(app.displayName)} ${esc(tag)}</b> → ${esc(DEPLOY_TARGET_KO[target])} 배포를 트리거했습니다.`;
      if (res.xcodeCloudBuild != null) {
        body += `\n📱 iOS: Xcode Cloud 빌드 #${res.xcodeCloudBuild} (결과는 App Store Connect/TestFlight 에서 확인)`;
      }
      if (res.workflowFile) {
        body += `\n빌드/업로드 완료 시 결과 알림이 옵니다.`;
      }
      await editMessageText(chatId, mid, body, []);
    } catch (e) {
      await editMessageText(chatId, mid, "배포 트리거 실패: " + esc((e as Error).message), []);
    }
    return;
  }

  await answerCallback(cq.id);
}

// 인라인 버튼 2열 배치.
function chunk2<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}
