export interface OperatorOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
  options?: OperatorOption[];
}

export interface OperatorInteraction {
  id: string;
  applicationId: string;
  type: number;
  workspaceId?: string;
  channelId?: string;
  actor?: {
    id?: string;
    username?: string;
    roles?: string[];
  };
  message?: { id?: string };
  data?: {
    id?: string;
    name?: string;
    custom_id?: string;
    component_type?: number;
    options?: OperatorOption[];
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
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

export const EPHEMERAL_FLAG = 1 << 6;
