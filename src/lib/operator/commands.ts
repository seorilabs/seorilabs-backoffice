import { COMMAND_DEFINITIONS } from "./command-definitions";

export const OPERATOR_COMMANDS = COMMAND_DEFINITIONS;
export function slackAppManifest(baseUrl: string) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("Slack 요청 URL은 HTTPS여야 합니다.");
  const url = new URL("/api/slack/interactions",base).href;
  return {
    display_information:{name:"Seorilabs Backoffice",description:"Seorilabs 운영 보고, 이슈와 배포 승인",background_color:"#243447"},
    features:{bot_user:{display_name:"seori",always_online:false},slash_commands:[{command:"/seori",description:"운영 조회, 이슈 작성, 릴리스와 승인",usage_hint:"help 또는 app status app:앱이름",url,should_escape:false}]},
    oauth_config:{scopes:{bot:["chat:write","channels:read","groups:read","files:write","files:read","users:read","commands"]}},
    settings:{interactivity:{is_enabled:true,request_url:url,message_menu_options_url:url},org_deploy_enabled:false,socket_mode_enabled:false,token_rotation_enabled:false},
  };
}
