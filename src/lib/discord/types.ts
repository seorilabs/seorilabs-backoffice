export interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: {
    user?: { id?: string; username?: string };
    roles?: string[];
  };
  message?: { id?: string };
  data?: {
    id?: string;
    name?: string;
    custom_id?: string;
    component_type?: number;
    options?: DiscordInteractionOption[];
    components?: Array<{
      components?: Array<{ custom_id?: string; value?: string }>;
    }>;
  };
}

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
  UPDATE_MESSAGE: 7,
  AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

export const EPHEMERAL_FLAG = 1 << 6;
