import type { Prisma } from "@prisma/client";

// 이슈 알림 메시지에 딸린 쓰레드 본문.
//
// 채널에는 한 줄만 남기고, 본문·댓글·PR 링크처럼 길어지는 맥락은 그 메시지에서 시작한
// 쓰레드로 보낸다. 메시지에서 시작한 public thread 는 ID 가 원본 메시지 ID 와 같아서
// 쓰레드 ID 를 따로 저장하지 않는다.

const BODY_LIMIT = 1_200;
const COMMENT_LIMIT = 300;
const MAX_COMMENTS = 8;

/** 쓰레드 게시 요청. parentDedupeKey 의 알림이 이미 나가 있어야 붙일 곳이 생긴다. */
export interface IssueThreadPayload {
  text: string;
  parentDedupeKey: string;
  threadName: string;
}

export function issueThreadPayload(payload: Prisma.JsonValue): IssueThreadPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const object = payload as Prisma.JsonObject;
  const thread = object.thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return null;
  const { parentDedupeKey, threadName } = thread as Prisma.JsonObject;
  const text = object.text;
  if (
    typeof text !== "string" ||
    typeof parentDedupeKey !== "string" ||
    typeof threadName !== "string" ||
    !text ||
    !parentDedupeKey ||
    !threadName
  ) {
    return null;
  }
  return { text, parentDedupeKey, threadName };
}

/** Discord 쓰레드 이름은 100자 제한. 이슈 번호는 반드시 남긴다. */
export function issueThreadName(repo: string, number: number, title: string): string {
  const prefix = `${repo} #${number} `;
  return (prefix + title.trim()).slice(0, 100);
}

function clamp(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * 이슈 본문. 비어 있어도 쓰레드는 연다 — 종료 시 붙일 댓글·PR 이 갈 곳이 필요하다.
 * autopilot 마커 주석은 사람에게 의미가 없어 걷어낸다.
 */
export function issueOpenedThreadText(body: string | null | undefined): string {
  const cleaned = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  return cleaned ? clamp(cleaned, BODY_LIMIT) : "_본문 없음_";
}

export interface IssueComment {
  author: string;
  body: string;
}

export interface LinkedPull {
  number: number;
  title: string;
  url: string;
  merged: boolean;
}

/** 종료 시 붙이는 마무리. 댓글과 연결된 PR 이 모두 없으면 null(게시하지 않는다). */
export function issueClosedThreadText(input: {
  stateReason: string | null | undefined;
  comments: readonly IssueComment[];
  pulls: readonly LinkedPull[];
}): string | null {
  const lines: string[] = [];
  if (input.pulls.length > 0) {
    lines.push("**연결된 PR**");
    for (const pull of input.pulls) {
      lines.push(`- ${pull.merged ? "머지됨" : "미머지"} [#${pull.number} ${clamp(pull.title, 80)}](${pull.url})`);
    }
  }
  if (input.comments.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`**댓글 ${input.comments.length}건**`);
    for (const comment of input.comments.slice(0, MAX_COMMENTS)) {
      lines.push(`- **${comment.author}**: ${clamp(comment.body.replace(/\s+/g, " "), COMMENT_LIMIT)}`);
    }
    if (input.comments.length > MAX_COMMENTS) {
      lines.push(`- … 외 ${input.comments.length - MAX_COMMENTS}건`);
    }
  }
  if (lines.length === 0) return null;
  const reason = input.stateReason === "not_planned"
    ? "🚫 미진행 종료"
    : input.stateReason === "duplicate"
      ? "♻️ 중복 종료"
      : "✅ 처리완료";
  return [reason, "", ...lines].join("\n");
}


// ── 쓰레드 게시 계획 ──────────────────────────────────────────────────────────

export interface IssueThreadDeps {
  /**
   * 같은 이슈의 "생성" 쓰레드 알림 dedupeKey. 없으면 붙일 부모 메시지가 없다는 뜻이다.
   * (기능 도입 전에 열린 이슈, 또는 생성 알림이 보존기한으로 지워진 경우)
   */
  findOpenedThreadKey(threadName: string): Promise<string | null>;
  listComments(): Promise<IssueComment[]>;
  listLinkedPulls(): Promise<LinkedPull[]>;
}

export interface IssueThreadPlan {
  dedupeKey: string;
  text: string;
  parentDedupeKey: string;
  threadName: string;
}

/**
 * 이슈 이벤트 → 쓰레드 게시 계획. null 이면 게시하지 않는다.
 *
 * 생성은 부모가 같은 요청에서 막 enqueue 되므로 존재를 확인하지 않는다 — 첫 전달
 * 시도가 실패해도 outbox 재시도가 곧 해소한다. 종료는 반대로 부모가 영영 안 생길 수
 * 있어(도입 전 이슈) 여기서 확인하고 없으면 건너뛴다. 같은 재시도 정책을 쓰면 후자가
 * 매일 dead letter 를 쌓는다.
 */
export async function planIssueThread(
  input: {
    action: "opened" | "closed";
    parentDedupeKey: string;
    repo: string;
    number: number;
    title: string;
    body?: string | null;
    stateReason?: string | null;
  },
  deps: IssueThreadDeps,
): Promise<IssueThreadPlan | null> {
  const threadName = issueThreadName(input.repo, input.number, input.title);
  const dedupeKey = `${input.parentDedupeKey}:thread`;

  if (input.action === "opened") {
    return {
      dedupeKey,
      text: issueOpenedThreadText(input.body),
      parentDedupeKey: input.parentDedupeKey,
      threadName,
    };
  }

  const openedThreadKey = await deps.findOpenedThreadKey(threadName);
  if (!openedThreadKey) return null;

  const [comments, pulls] = await Promise.all([deps.listComments(), deps.listLinkedPulls()]);
  const text = issueClosedThreadText({ stateReason: input.stateReason, comments, pulls });
  if (!text) return null;
  return {
    dedupeKey,
    text,
    // 종료 맥락은 "생성" 알림 메시지의 쓰레드에 붙는다. 종료 메시지가 아니다.
    parentDedupeKey: openedThreadKey.replace(/:thread$/, ""),
    threadName,
  };
}
