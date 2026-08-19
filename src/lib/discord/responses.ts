import { EPHEMERAL_FLAG, InteractionResponseType } from "@/lib/discord/types";

export function ephemeral(content: string, components: unknown[] = []) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE,
    data: {
      content: content.slice(0, 2_000),
      ...(components.length ? { components } : {}),
      flags: EPHEMERAL_FLAG,
      allowed_mentions: { parse: [] },
    },
  };
}

export function modal(customId: string, title: string, label: string, placeholder = "") {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: customId,
      title: title.slice(0, 45),
      components: [{
        type: 1,
        components: [{
          type: 4,
          custom_id: "text",
          label: label.slice(0, 45),
          style: 2,
          required: true,
          min_length: 1,
          max_length: 4_000,
          ...(placeholder ? { placeholder: placeholder.slice(0, 100) } : {}),
        }],
      }],
    },
  };
}
