import type { Prisma } from "@prisma/client";

// 이슈 알림 메시지에 딸린 쓰레드 본문.
//
// 채널에는 한 줄만 남기고, 본문·댓글·PR 링크처럼 길어지는 맥락은 그 메시지에서 시작한
// 쓰레드로 보낸다. 메시지에서 시작한 public thread 는 ID 가 원본 메시지 ID 와 같아서
// 쓰레드 ID 를 따로 저장하지 않는다.

/** 쓰레드 게시 요청. parentDedupeKey 의 알림이 이미 나가 있어야 붙일 곳이 생긴다. */
export interface IssueThreadPayload {
  text: string;
  parentDedupeKey: string;
  threadName: string;
  plain: boolean;
  attachment?: {
    filename: string;
    contentType: string;
    base64: string;
  };
}

export function issueThreadPayload(
  payload: Prisma.JsonValue,
): IssueThreadPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const object = payload as Prisma.JsonObject;
  const thread = object.thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread))
    return null;
  const { parentDedupeKey, threadName, plain } = thread as Prisma.JsonObject;
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
  const attachmentValue = object.attachment;
  const attachment =
    attachmentValue &&
    typeof attachmentValue === "object" &&
    !Array.isArray(attachmentValue)
      ? (attachmentValue as Prisma.JsonObject)
      : null;
  const parsedAttachment =
    typeof attachment?.filename === "string" &&
    typeof attachment.contentType === "string" &&
    typeof attachment.base64 === "string"
      ? {
          filename: attachment.filename,
          contentType: attachment.contentType,
          base64: attachment.base64,
        }
      : undefined;
  return {
    text,
    parentDedupeKey,
    threadName,
    plain: typeof plain === "boolean" ? plain : true,
    ...(parsedAttachment ? { attachment: parsedAttachment } : {}),
  };
}

/**
 * 쓰레드 생성 실패를 전달 결과로 옮긴다.
 *
 * 권한 부족(403)은 재시도로 풀리지 않는다. 봇 역할에 CREATE_PUBLIC_THREADS 를 주기
 * 전까지 이벤트마다 열 번씩 실패하면 원인이 로그에 묻힌다. 즉시 끝내고 사유를 남긴다.
 */
export function threadStartFailure<
  T extends { ok: boolean; error?: string; statusCode?: number },
>(result: T): T & { terminal?: boolean } {
  if (result.statusCode !== 403) return result;
  return {
    ...result,
    terminal: true,
    error: `${result.error ?? "권한 부족"} — 봇 역할에 CREATE_PUBLIC_THREADS 필요`,
  };
}
