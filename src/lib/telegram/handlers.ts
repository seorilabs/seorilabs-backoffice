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
  commitDraftCore,
  generateStageDraftCore,
} from "@/lib/core/ai-drafts";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO, STAGES } from "@/lib/domain/lifecycle";
import { handleChat, resetChat } from "@/lib/telegram/chat";
import { getPending, setPending, clearPending } from "@/lib/telegram/state";
import { enqueueVaultWrite } from "@/lib/vault/write-core";
import {
  createReleaseTagWithNotes,
  dispatchMarketDeploy,
  previewNextTag,
  deployTargetsFor,
  DEPLOY_TARGET_KO,
  type DeployTarget,
  type Bump,
} from "@/lib/core/release-ops";
import { listVersionTags } from "@/lib/github/release";

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
  { command: "release", description: "릴리즈 태그 생성 + 출시노트" },
  { command: "deploy", description: "마켓 배포(태그 선택)" },
  { command: "save", description: "메모를 볼트 받은함에 저장" },
  { command: "index", description: "볼트 즉시 재인덱싱" },
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
    "<b>⚡ 빠른 버튼 / 명령어</b>",
    "📋 승인 (<code>/approvals</code>) — 승인 대기 + 버튼 승인",
    "🔥 P1 (<code>/p1</code>) — 전 레포 P1 이슈",
    "📊 현황 (<code>/status</code>) — 앱 선택 → 상세",
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

  if (action === "gen") return cbGen(cq, fromId, rest[0], arg);

  if (action === "rel") return cbRelease(cq, fromId, rest);
  if (action === "deploy") return cbDeploy(cq, fromId, rest);

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

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const BUMPS = new Set(["patch", "minor", "major"]);
const DEPLOY_TARGETS = new Set(["AIT", "PLAY", "APPSTORE", "ALL"]);

async function appBySlug(slug: string) {
  if (!SLUG_RE.test(slug)) return null;
  return prisma.app.findFirst({
    where: { slug },
    select: { slug: true, displayName: true, repoFullName: true, marketTargets: true },
  });
}

// ── /release: 앱 선택 → bump → 확인 → 태그 + 출시노트(ko/en) + GitHub Release ──
async function cmdReleaseStart(chatId: number): Promise<void> {
  const apps = await prisma.app.findMany({
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
        `🚀 <b>${esc(app.displayName)}</b>\n최신: ${esc(preview.latest ?? "(없음)")} → 생성: <b>${esc(preview.next)}</b>\n태그 + 출시노트(ko/en) + GitHub Release 를 진행할까요?`,
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
      const ko = r.koKR ? "\n\n" + esc(r.koKR.slice(0, 600)) : "";
      await editMessageText(
        chatId,
        mid,
        `✅ <b>${esc(app.displayName)} ${esc(r.tag)}</b> 릴리즈 생성됨${r.created ? "" : " (기존 태그 재사용)"}\n${esc(r.releaseUrl)}${ko}`,
        [],
      );
    } catch (e) {
      await editMessageText(chatId, mid, "릴리즈 실패: " + esc((e as Error).message), []);
    }
    return;
  }

  await answerCallback(cq.id);
}

// ── /deploy: 앱 → 태그 → 마켓 → 확인 → workflow_dispatch ──
async function cmdDeployStart(chatId: number): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { status: { not: "PAUSED" } },
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
      await dispatchMarketDeploy({
        repoFullName: app.repoFullName,
        target,
        tag,
        actorLabel: `telegram:${fromId}`,
      });
      await editMessageText(
        chatId,
        mid,
        `🚀 <b>${esc(app.displayName)} ${esc(tag)}</b> → ${esc(DEPLOY_TARGET_KO[target])} 배포를 트리거했습니다.\n빌드/업로드 완료 시 결과 알림이 옵니다.`,
        [],
      );
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
