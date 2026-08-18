import { z } from "zod";
import { MAX_DISCORD_ATTACHMENT_BYTES } from "@/lib/notifications/discord";
import {
  DISCORD_FINANCE_ALERTS,
  DISCORD_PRIVATE_FEED,
  DISCORD_SEORI_REVIEW,
  type DiscordDestinationKey,
} from "@/lib/notifications/destinations";

export const OPS_NOTIFICATION_SUBJECT_PREFIX = "ops.notification.v1";

const ROUTES = new Set<DiscordDestinationKey>([
  DISCORD_PRIVATE_FEED,
  DISCORD_FINANCE_ALERTS,
  DISCORD_SEORI_REVIEW,
]);

const payloadSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/),
  source: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  text: z.string().trim().min(1).max(16_000),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  attachment: z.object({
    filename: z.string().min(1).max(120).regex(/^[^/\\]+$/),
    contentType: z.string().min(1).max(100),
    base64: z.string().min(1),
  }).optional(),
}).strict();

export type ExternalNotification = z.infer<typeof payloadSchema>;

export function notificationSubject(route: DiscordDestinationKey): string {
  if (!ROUTES.has(route)) throw new Error(`허용되지 않은 알림 route: ${route}`);
  return `${OPS_NOTIFICATION_SUBJECT_PREFIX}.${route}`;
}

export function routeFromNotificationSubject(subject: string): DiscordDestinationKey | null {
  const prefix = `${OPS_NOTIFICATION_SUBJECT_PREFIX}.`;
  if (!subject.startsWith(prefix)) return null;
  const route = subject.slice(prefix.length) as DiscordDestinationKey;
  return ROUTES.has(route) ? route : null;
}

export function parseExternalNotification(value: unknown): ExternalNotification {
  const parsed = payloadSchema.parse(value);
  if (parsed.attachment) {
    const bytes = Buffer.from(parsed.attachment.base64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_DISCORD_ATTACHMENT_BYTES) {
      throw new Error("Discord 첨부 크기 제한 초과");
    }
  }
  return parsed;
}

export interface NotificationAck {
  accepted: boolean;
  id?: string;
  error?: string;
}
