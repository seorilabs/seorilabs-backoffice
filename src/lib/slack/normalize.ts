import { createHash } from "node:crypto";
import { COMMAND_DEFINITIONS } from "@/lib/operator/command-definitions";
import { InteractionType, type OperatorInteraction, type OperatorOption } from "@/lib/operator/types";

export type CommandDefinition = typeof COMMAND_DEFINITIONS[number];
export interface SlackContext { workspaceId: string; channelId: string; userId: string; messageId?: string; createdAt: number; mode?: "command"; command?: string }
export interface SlackIngress { kind: "command" | "action" | "submission" | "options"; interaction: OperatorInteraction; context: SlackContext; definition?: CommandDefinition; missing?: boolean; triggerId?: string; responseUrl?: string; viewId?: string; viewHash?: string; fieldIds: string[] }
export function object(value: unknown): Record<string,unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {}; }
const string = (value: unknown) => typeof value === "string" ? value : "";

export function parseCommand(command: string, text: string): { definition: CommandDefinition; options: OperatorOption[]; missing: boolean } | null {
  const tokens = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (command !== "/seori") return null;
  const root = tokens.shift();
  const definition = COMMAND_DEFINITIONS.find(item => item.path[0] === root && (item.path.length === 1 || item.path[1] === tokens[0]));
  if (!definition) return null;
  if (definition.path.length > 1) tokens.shift();
  const options: OperatorOption[] = [];
  for (const token of tokens) {
    const index = token.indexOf(":");
    if (index <= 0) return null;
    const name = token.slice(0,index);
    const value = token.slice(index + 1).replace(/^(["'])([\s\S]*)\1$/,"$2");
    const spec = definition.options.find(option => option.name === name);
    if (!spec || !value || options.some(option => option.name === name) || (spec.choices && !spec.choices.some(choice => choice.value === value))) return null;
    options.push({name,type:3,value});
  }
  return {definition,options,missing:definition.options.some(option => option.required && !options.some(value => value.name === option.name))};
}

export function normalizeSlackRequest(body: string, roles: (userId: string) => string[], now = Date.now()): SlackIngress {
  const form = new URLSearchParams(body);
  const payload = form.has("payload") ? object(JSON.parse(form.get("payload")!)) : {};
  const kind = string(payload.type);
  const view = object(payload.view);
  let metadata: SlackContext | undefined;
  if (view.private_metadata) metadata = JSON.parse(string(view.private_metadata)) as SlackContext;
  const user = object(payload.user);
  const team = object(payload.team);
  const workspaceId = form.get("team_id") || string(team.id);
  const userId = form.get("user_id") || string(user.id);
  if (metadata && (metadata.workspaceId !== workspaceId || metadata.userId !== userId || !Number.isFinite(metadata.createdAt) || Math.abs(now - metadata.createdAt) > 3600000)) throw new Error("SLACK_CONTEXT_MISMATCH");
  const container = object(payload.container);
  const channelId = form.get("channel_id") || string(object(payload.channel).id) || string(container.channel_id) || metadata?.channelId || "";
  const messageId = string(object(payload.message).ts) || string(container.message_ts) || metadata?.messageId;
  const context: SlackContext = { workspaceId,channelId,userId,...(messageId ? {messageId} : {}),createdAt:metadata?.createdAt ?? now };
  const interaction: OperatorInteraction = {
    id:`slack:${createHash("sha256").update(body).digest("hex")}`,applicationId:form.get("api_app_id") || string(payload.api_app_id),
    type:InteractionType.APPLICATION_COMMAND,workspaceId,channelId,actor:{id:userId,username:form.get("user_name") || string(user.username),roles:roles(userId)},
    ...(messageId ? {message:{id:messageId}} : {}),
  };
  const result: SlackIngress = {kind:"command",interaction,context,triggerId:form.get("trigger_id") || string(payload.trigger_id),responseUrl:form.get("response_url") || string(payload.response_url),viewId:string(view.id),viewHash:string(view.hash),fieldIds:[]};
  if (!kind && form.has("command")) {
    const command = parseCommand(form.get("command")!,form.get("text") ?? "");
    if (!command) throw new Error("SLACK_COMMAND_INVALID");
    result.definition = command.definition; result.missing = command.missing;
    interaction.data = {name:command.definition.path.join(" "),options:command.options};
    return result;
  }
  if (kind === "block_actions") {
    const action = object(Array.isArray(payload.actions) ? payload.actions[0] : undefined);
    if (typeof action.action_id !== "string") throw new Error("SLACK_ACTION_INVALID");
    result.kind = "action"; interaction.type = InteractionType.MESSAGE_COMPONENT;
    interaction.data = {custom_id:action.action_id};
    return result;
  }
  if (kind === "block_suggestion") {
    const definition = COMMAND_DEFINITIONS.find(item => item.path.join(" ") === metadata?.command);
    if (!definition || payload.action_id !== "app") throw new Error("SLACK_OPTIONS_INVALID");
    result.kind = "options"; result.definition = definition; interaction.type = InteractionType.AUTOCOMPLETE;
    interaction.data = {name:definition.path.join(" "),options:[{name:"app",type:3,value:string(payload.value),focused:true}]};
    return result;
  }
  if (kind !== "view_submission" || !metadata) throw new Error("SLACK_REQUEST_INVALID");
  result.kind = "submission";
  const values = object(object(view.state).values);
  const fields = Object.entries(values).flatMap(([blockId,actions]) => Object.entries(object(actions)).map(([actionId,item]) => {
    result.fieldIds.push(blockId);
    const value = object(item);
    return {custom_id:actionId,value:string(value.value) || string(object(value.selected_option).value)};
  }));
  const merged = fields.filter(field => !field.custom_id.endsWith("__continuation")).map(field => ({...field,value:field.value + (fields.find(extra => extra.custom_id === `${field.custom_id}__continuation`)?.value ?? "")}));
  if (metadata.mode === "command") {
    const definition = COMMAND_DEFINITIONS.find(item => item.path.join(" ") === metadata!.command);
    if (!definition) throw new Error("SLACK_COMMAND_INVALID");
    result.definition = definition;
    interaction.data = {name:definition.path.join(" "),options:merged.filter(field => field.value).map(field => ({name:field.custom_id,type:3,value:field.value}))};
  } else {
    interaction.type = InteractionType.MODAL_SUBMIT;
    interaction.data = {custom_id:string(view.callback_id).replace(/^operator:/,""),components:[{components:merged}]};
  }
  return result;
}

export function validateSlackScope(input: SlackIngress, expected: { workspaceId: string; applicationId: string }): boolean {
  return !!expected.workspaceId && !!expected.applicationId && input.interaction.workspaceId === expected.workspaceId && input.interaction.applicationId === expected.applicationId && !!input.context.userId && !!input.context.channelId;
}
