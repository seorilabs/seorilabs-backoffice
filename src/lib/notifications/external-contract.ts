import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "@/lib/notifications/channel";
import {
  CHANNEL_PRIVATE_FEED,
  CHANNEL_SEORI_REVIEW,
  type DestinationKey,
} from "@/lib/notifications/destinations";

export const OPS_NOTIFICATION_SUBJECT_PREFIX = "ops.notification.v1";
export const MAX_CHANNEL_ATTACHMENT_BASE64_CHARS =
  4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);

const ROUTES = new Set<DestinationKey>([
  CHANNEL_PRIVATE_FEED,
  CHANNEL_SEORI_REVIEW,
]);

const payloadSchema = z
  .object({
    version: z.literal(1),
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9._:-]+$/),
    source: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9._-]+$/),
    text: z.string().trim().min(1).max(16_000),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    report: z
      .object({
        category: z.enum(["internal", "change", "urgent", "response"]),
        subject: z.string().trim().min(1).max(160),
        conclusion: z.string().trim().min(1).max(300),
        evidence: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
        meaning: z.string().trim().max(500).optional(),
        action: z.string().trim().max(500).optional(),
        topicKey: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
      })
      .strict()
      .optional(),
    attachment: z
      .object({
        filename: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[^/\\]+$/),
        contentType: z.string().min(1).max(100),
        base64: z.string().min(1).max(MAX_CHANNEL_ATTACHMENT_BASE64_CHARS),
      })
      .optional(),
    thread: z
      .object({
        parentId: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[A-Za-z0-9._:-]+$/),
        name: z.string().trim().min(1).max(100),
        plain: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.thread?.parentId === payload.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thread", "parentId"],
        message: "thread parentId는 자기 알림 id와 달라야 합니다",
      });
    }
  });

export type ExternalNotification = z.infer<typeof payloadSchema>;

export function notificationSubject(route: DestinationKey): string {
  if (!ROUTES.has(route)) throw new Error(`허용되지 않은 알림 route: ${route}`);
  return `${OPS_NOTIFICATION_SUBJECT_PREFIX}.${route}`;
}

export function routeFromNotificationSubject(
  subject: string,
): DestinationKey | null {
  const prefix = `${OPS_NOTIFICATION_SUBJECT_PREFIX}.`;
  if (!subject.startsWith(prefix)) return null;
  const route = subject.slice(prefix.length) as DestinationKey;
  return ROUTES.has(route) ? route : null;
}

export function parseExternalNotification(
  value: unknown,
): ExternalNotification {
  const parsed = payloadSchema.parse(value);
  if (parsed.attachment) {
    const bytes = Buffer.from(parsed.attachment.base64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error("Slack 첨부 크기 제한 초과");
    }
  }
  return parsed;
}

export interface NotificationAck {
  accepted: boolean;
  id?: string;
  error?: string;
}
