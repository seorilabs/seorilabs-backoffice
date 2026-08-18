import crypto from "node:crypto";
import type { StoreReviewStore } from "@prisma/client";
import type {
  ReviewChangeKind,
  ReviewObservationState,
  StoreReview,
} from "@/lib/store-reviews/types";

const BODY_PREVIEW_CHARS = 1_600;

export function normalizeReviewText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim()
    : "";
}

export function reviewContentHash(review: StoreReview): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([
      review.rating,
      normalizeReviewText(review.title),
      normalizeReviewText(review.body),
    ]))
    .digest("hex");
}

export function reviewNotificationDedupeKey(input: {
  appId: string;
  review: StoreReview;
  contentHash: string;
}): string {
  const signal = crypto
    .createHash("sha256")
    .update([
      input.review.externalReviewId,
      input.review.sourceModifiedAt?.toISOString() ?? "",
      input.contentHash,
    ].join(":"))
    .digest("hex")
    .slice(0, 32);
  return `store-review:${input.appId}:${input.review.store}:${signal}`;
}

export function classifyReviewChange(input: {
  initialized: boolean;
  existing: ReviewObservationState | null;
  contentHash: string;
}): ReviewChangeKind {
  if (!input.initialized) return "baseline";
  if (!input.existing || input.existing.notifiedHash === null) return "new";
  return input.existing.notifiedHash === input.contentHash
    ? "unchanged"
    : "updated";
}

function escapeDiscordMarkdown(value: string): string {
  return value.replace(/([\\`*_~|\[\]])/g, "\\$1");
}

function preview(value: string): string {
  const normalized = normalizeReviewText(value);
  if (normalized.length <= BODY_PREVIEW_CHARS) return normalized;
  return `${normalized.slice(0, BODY_PREVIEW_CHARS - 1).trimEnd()}…`;
}

function quote(value: string): string {
  const escaped = escapeDiscordMarkdown(preview(value) || "본문 없음");
  return escaped.split("\n").map((line) => `> ${line}`).join("\n");
}

export function storeLabel(store: StoreReviewStore): string {
  return store === "GOOGLE_PLAY" ? "Google Play" : "App Store";
}

function stars(rating: number): string {
  return `${"★".repeat(rating)}${"☆".repeat(5 - rating)}`;
}

export function storeReviewDiscordText(input: {
  appDisplayName: string;
  review: StoreReview;
  change: Exclude<ReviewChangeKind, "baseline" | "unchanged">;
  previousRating?: number;
  observedAt?: Date;
}): string {
  const { review } = input;
  const heading = input.change === "new" ? "새 리뷰" : "리뷰 수정";
  const lines = [
    `${input.change === "new" ? "💬" : "✏️"} **${storeLabel(review.store)} ${heading} · ${escapeDiscordMarkdown(input.appDisplayName)}**`,
  ];
  const rating = `${stars(review.rating)} ${review.rating}/5`;
  lines.push(
    input.change === "updated" &&
      input.previousRating != null &&
      input.previousRating !== review.rating
      ? `평점: ${rating} · 이전 ${input.previousRating}/5`
      : `평점: ${rating}`,
  );
  const displayedAt = input.change === "updated"
    ? review.sourceModifiedAt ?? input.observedAt
    : review.sourceCreatedAt ?? review.sourceModifiedAt ?? input.observedAt;
  const timeLabel = input.change === "updated"
    ? review.sourceModifiedAt ? "수정" : "변경 관측"
    : review.sourceCreatedAt ? "작성" : "작성/관측";
  const metadata = [
    review.locale ? `지역/언어: ${escapeDiscordMarkdown(review.locale)}` : "",
    displayedAt
      ? `${timeLabel}: ${displayedAt.toISOString()}`
      : "",
  ].filter(Boolean);
  if (metadata.length) lines.push(metadata.join(" · "));
  if (review.title) lines.push(`제목: **${escapeDiscordMarkdown(preview(review.title))}**`);
  lines.push(quote(review.body));
  return lines.join("\n");
}
