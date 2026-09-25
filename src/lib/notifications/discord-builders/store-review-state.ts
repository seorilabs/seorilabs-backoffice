import {
  STORE_COLOR_HEX,
  STORE_NAME,
  type NormalizedState,
} from "@/lib/store-reviews/submissions/normalizer";

export interface StoreReviewStateEmbedInput {
  appDisplayName: string;
  bundleIdOrPackage: string;
  versionLabel: string;
  normalized: NormalizedState;
  sourceEventAt: Date;
  appHomeUrl?: string;
}

export interface StoreReviewStateEmbed {
  title: string;
  description: string;
  fields: ReadonlyArray<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  color: number;
  footer?: { text: string };
  timestamp: string;
}

export function buildStoreReviewStateEmbed(
  input: StoreReviewStateEmbedInput,
): StoreReviewStateEmbed {
  const badge = STORE_NAME[input.normalized.store];
  const color = STORE_COLOR_HEX[input.normalized.store];
  const title = `[${badge}] ${input.appDisplayName} v${input.versionLabel} — ${input.normalized.stateLabel}`;
  const description = `${input.normalized.emoji} ${input.normalized.stateLabel}`;
  const fields: ReadonlyArray<{
    name: string;
    value: string;
    inline?: boolean;
  }> = [
    { name: "단계", value: input.normalized.stateLabel, inline: true },
    { name: "스토어", value: badge, inline: true },
    { name: "App", value: input.bundleIdOrPackage, inline: false },
  ];
  const embed: StoreReviewStateEmbed = {
    title,
    description,
    fields,
    color,
    timestamp: input.sourceEventAt.toISOString(),
  };
  if (input.appHomeUrl) {
    embed.footer = { text: input.appHomeUrl };
  }
  return embed;
}
