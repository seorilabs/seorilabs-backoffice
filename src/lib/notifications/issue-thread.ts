import type { Prisma } from "@prisma/client";

// 이슈 알림 메시지에 딸린 쓰레드 본문.
//
// 채널에는 한 줄만 남기고, 본문·댓글·PR 링크처럼 길어지는 맥락은 그 메시지에서 시작한
// 쓰레드로 보낸다. Slack 쓰레드는 원본 메시지의 ts를 thread_ts로 사용하므로
// 쓰레드 ID를 따로 저장하지 않는다.

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
