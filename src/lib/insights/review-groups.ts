import { z } from "zod";
const reviewPayload = z.object({
  appId: z.string(),
  store: z.enum(["APP_STORE", "GOOGLE_PLAY"]),
  rating: z.number().int().min(1).max(5),
  change: z.enum(["new", "updated"]),
});
export function closedReviewGroups(
  events: Array<{ id: string; createdAt: Date; payload: unknown }>,
  now: Date,
) {
  const groups = new Map<
    string,
    {
      appId: string;
      store: string;
      observedAt: Date;
      count: number;
      updated: number;
      lowRating: number;
    }
  >();
  for (const event of events) {
    const parsed = reviewPayload.safeParse(event.payload);
    if (!parsed.success) continue;
    const window = Math.floor(event.createdAt.getTime() / 900000);
    if ((window + 1) * 900000 > now.getTime()) continue;
    const row = parsed.data,
      key = row.appId + ":" + row.store + ":" + window;
    const group = groups.get(key) ?? {
      appId: row.appId,
      store: row.store,
      observedAt: event.createdAt,
      count: 0,
      updated: 0,
      lowRating: 0,
    };
    group.count++;
    group.updated += row.change === "updated" ? 1 : 0;
    group.lowRating += row.rating <= 2 ? 1 : 0;
    if (event.createdAt > group.observedAt) group.observedAt = event.createdAt;
    groups.set(key, group);
  }
  return groups;
}
