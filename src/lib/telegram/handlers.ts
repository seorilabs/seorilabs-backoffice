import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  sendMessage,
  sendWithReplyKeyboard,
  answerCallback,
  editMessageText,
  sendChatAction,
  esc,
} from "@/lib/telegram/client";
import { toggleApprovalCore } from "@/lib/core/approvals";
import { createPlanningDraftCore, commitDraftCore } from "@/lib/core/ai-drafts";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO, STAGES } from "@/lib/domain/lifecycle";
import { handleChat, resetChat } from "@/lib/telegram/chat";
import { getPending, setPending, clearPending } from "@/lib/telegram/state";

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

// "/" 명령어 메뉴(setMyCommands)용. admin 라우트에서 등록.
export const BOT_COMMANDS = [
  { command: "plan", description: "기획 초안 → 이슈 생성" },
  { command: "approvals", description: "승인 대기" },
  { command: "p1", description: "열린 P1 이슈" },
  { command: "status", description: "앱 현황" },
  { command: "reset", description: "대화 맥락 초기화" },
  { command: "help", description: "도움말 · 빠른 버튼" },
];

// 하단 고정 빠른 버튼.
const QUICK_KEYBOARD = [
  ["📋 승인", "🔥 P1"],
  ["📊 현황", "📝 기획"],
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
    "<b>Seorilabs Backoffice 봇</b>",
    "",
    "💬 그냥 메시지를 보내면 AI 비서와 대화합니다(실시간 데이터 조회).",
    "아래 버튼이나 / 메뉴로 빠르게 실행하세요.",
    "",
    "📝 기획 — 초안 생성 후 버튼으로 이슈 생성",
    "📋 승인 · 🔥 P1 · 📊 현황 · 🧹 초기화",
    "",
    "웹: https://backoffice.vzyx.xyz",
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
    case "📝 기획":
      return cmdPlanStart(chatId);
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
    case "/plan":
      await cmdPlanStart(chatId);
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
  await sendMessage(chatId, esc(reply));
}

// ── /plan: 앱 선택 → 아이디어 → 미리보기 → 버튼 커밋 ──
async function cmdPlanStart(chatId: number): Promise<void> {
  if (!env.minimaxConfigured()) {
    await sendMessage(chatId, "AI 기획이 비활성 상태입니다 (MiniMax 미설정).");
    return;
  }
  const apps = await prisma.app.findMany({
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
  const app = await prisma.app.findFirst({ where: { slug }, select: { id: true } });
  if (!app) {
    await sendMessage(chatId, `'${esc(slug)}' 앱을 찾을 수 없습니다.`);
    return;
  }
  await sendChatAction(chatId, "typing");
  try {
    const d = await createPlanningDraftCore({
      appId: app.id,
      idea,
      actorLabel: `telegram:${fromId ?? "?"}`,
    });
    const preview = [
      `<b>📝 기획 초안</b> — ${esc(d.displayName)}`,
      `<b>${esc(d.title)}</b>`,
      "",
      esc(d.outputText.slice(0, 1400)),
      d.outputText.length > 1400 ? "…(이하 생략, 이슈에는 전체 반영)" : "",
    ].join("\n");
    await sendMessage(chatId, preview, [
      [
        { text: "✅ 이슈 생성", callback_data: `plan:make:${d.id}` },
        { text: "✖️ 취소", callback_data: `plan:cancel:${d.id}` },
      ],
    ]);
  } catch (e) {
    await sendMessage(chatId, "초안 생성 실패: " + (e instanceof Error ? e.message : "error"));
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

  if (action === "status" && rest[0] === "app") {
    await answerCallback(cq.id);
    if (cq.message) await cmdStatusDetail(cq.message.chat.id, arg);
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
    where: { state: "OPEN" },
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
    where: { state: "OPEN", priority: "P1" },
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
    where: { slug },
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

// 인라인 버튼 2열 배치.
function chunk2<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}
