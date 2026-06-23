import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { sendMessage, answerCallback, editMessageText, esc } from "@/lib/telegram/client";
import { toggleApprovalCore } from "@/lib/core/approvals";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO } from "@/lib/domain/lifecycle";

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

function authorized(fromId?: number): boolean {
  if (!fromId) return false;
  return env.telegramAllowedIds().includes(String(fromId));
}

function helpText(): string {
  return [
    "<b>Seorilabs Backoffice 봇</b>",
    "",
    "/approvals — 승인 대기 목록(버튼으로 승인)",
    "/p1 — 전 레포 P1 이슈",
    "/status [slug] — 앱 현황",
    "",
    "웹: https://backoffice.vzyx.xyz",
  ].join("\n");
}

export async function handleTelegramUpdate(u: TgUpdate): Promise<void> {
  if (u.callback_query) return handleCallback(u.callback_query);
  if (u.message) return handleMessage(u.message);
}

async function handleMessage(m: TgMessage): Promise<void> {
  if (m.chat?.id == null) return; // 비정형 update 방어
  if (!authorized(m.from?.id)) {
    await sendMessage(m.chat.id, "권한이 없습니다.");
    return;
  }
  const text = (m.text ?? "").trim();
  const [cmd, ...args] = text.split(/\s+/);
  switch (cmd) {
    case "/start":
    case "/help":
      await sendMessage(m.chat.id, helpText());
      break;
    case "/approvals":
      await cmdApprovals(m.chat.id);
      break;
    case "/p1":
      await cmdP1(m.chat.id);
      break;
    case "/status":
      await cmdStatus(m.chat.id, args[0]);
      break;
    default:
      await sendMessage(m.chat.id, "알 수 없는 명령입니다. /help");
      break;
  }
}

async function handleCallback(cq: TgCallback): Promise<void> {
  const fromId = cq.from?.id;
  if (!fromId || !authorized(fromId)) {
    await answerCallback(cq.id, "권한 없음");
    return;
  }
  const [action, ...rest] = (cq.data ?? "").split(":");
  if (action !== "approve") {
    await answerCallback(cq.id);
    return;
  }
  // gate/issueId 엄격 검증 (임의 callback_data 로 다른 이슈/게이트 조작 차단)
  const gate = rest[0];
  const issueId = rest.slice(1).join(":");
  if ((gate !== "planning" && gate !== "release") || !/^[a-z0-9]{20,40}$/i.test(issueId)) {
    await answerCallback(cq.id, "잘못된 요청");
    return;
  }
  try {
    const r = await toggleApprovalCore({
      issueId,
      gate,
      on: false, // approval:<gate> 라벨 제거 = 게이트 해제(승인). 코어가 pending 일 때만 동작.
      reason: "텔레그램에서 승인",
      actorLabel: `telegram:${fromId}`,
    });
    await answerCallback(cq.id, r.changed ? "승인 처리됨" : "이미 처리됨");
    if (cq.message) {
      const repo = esc(r.repoFullName.replace("seorilabs/", ""));
      await editMessageText(
        cq.message.chat.id,
        cq.message.message_id,
        r.changed
          ? `✅ 승인됨 — ${repo} #${r.number}`
          : `ℹ️ 이미 처리됨 — ${repo} #${r.number}`,
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
    (i) =>
      `• <b>${esc(i.repoFullName.replace("seorilabs/", ""))} #${i.number}</b> ${esc(i.title)}`,
  );
  await sendMessage(chatId, `<b>열린 P1 ${issues.length}건</b>\n${lines.join("\n")}`);
}

async function cmdStatus(chatId: number, slug?: string): Promise<void> {
  if (!slug) {
    const apps = await prisma.app.findMany({
      orderBy: [{ currentStage: "asc" }, { displayName: "asc" }],
      select: { slug: true, displayName: true, currentStage: true },
    });
    const lines = apps.map(
      (a) => `• ${esc(a.displayName)} — ${STAGE_KO[a.currentStage]} <code>${esc(a.slug)}</code>`,
    );
    await sendMessage(chatId, `<b>앱 ${apps.length}개</b>\n${lines.join("\n")}`);
    return;
  }
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
      rel
        ? `최근 릴리스: ${esc(rel.version)} ${esc(rel.market)} ${esc(rel.status)}`
        : "릴리스 없음",
    ].join("\n"),
  );
}
