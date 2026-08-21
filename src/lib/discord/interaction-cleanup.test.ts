import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteOriginalInteractionResponse,
  shouldDeleteEphemeralConfirmation,
} from "@/lib/discord/interaction-cleanup";
import { deferredUpdate, ephemeral } from "@/lib/discord/responses";
import { InteractionType, type DiscordInteraction } from "@/lib/discord/types";

function component(customId: string): DiscordInteraction {
  return {
    id: "interaction-1",
    application_id: "1234567890",
    token: "secret-token",
    type: InteractionType.MESSAGE_COMPONENT,
    data: { custom_id: customId },
  };
}

test("성공한 ephemeral 확인과 취소만 원본 확인창 삭제 대상으로 삼는다", () => {
  assert.equal(
    shouldDeleteEphemeralConfirmation(component("command:econfirm:run-1"), deferredUpdate()),
    true,
  );
  assert.equal(
    shouldDeleteEphemeralConfirmation(component("command:ecancel:run-1"), deferredUpdate()),
    true,
  );
  assert.equal(
    shouldDeleteEphemeralConfirmation(component("deploycard:appstore_refresh:release-1"), deferredUpdate()),
    false,
  );
  assert.equal(
    shouldDeleteEphemeralConfirmation(component("command:econfirm:run-1"), ephemeral("실패")),
    false,
  );
});

test("interaction token은 저장하지 않고 원본 응답 삭제 요청에만 사용한다", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const result = await deleteOriginalInteractionResponse(
    { applicationId: "1234567890", interactionToken: "secret/token" },
    async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(null, { status: 204 });
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(
    requestedUrl,
    "https://discord.com/api/v10/webhooks/1234567890/secret%2Ftoken/messages/@original",
  );
  assert.equal(requestedInit?.method, "DELETE");
  assert.equal(new Headers(requestedInit?.headers).has("authorization"), false);
});
