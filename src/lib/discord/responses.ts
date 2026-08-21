import { EPHEMERAL_FLAG, InteractionResponseType } from "@/lib/discord/types";
import type { DiscordActionRow } from "@/lib/notifications/discord";

export function ephemeral(content: string, components: DiscordActionRow[] = []) {
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

/** 버튼이 붙어 있던 메시지를 갱신해 별도 interaction 답글이 쌓이지 않게 한다. */
export function updateMessage(content: string) {
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      content: content.slice(0, 2_000),
      components: [],
      allowed_mentions: { parse: [] },
    },
  };
}

/** 컴포넌트 요청만 확인하고 원본 메시지는 worker 결과가 준비될 때까지 건드리지 않는다. */
export function deferredUpdate() {
  return { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };
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
