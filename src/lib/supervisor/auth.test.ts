import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { machinePrincipal, requireSlackOwner } from "./auth";
import { proposalSchema } from "./contracts";
test("AC2 PC 인증은 등록된 기기와 기존 토큰을 함께 요구한다", () => {
  const before = { ...process.env };
  try {
    process.env.SUPERVISOR_MACHINE_ID = "qa-pc";
    process.env.INTERNAL_ADMIN_TOKEN = "qa-credential";
    const req = (machine: string, token: string) =>
      new NextRequest("https://backoffice.test/api/supervisor/snapshot", {
        headers: {
          "x-supervisor-machine": machine,
          authorization: "Bearer " + token,
        },
      });
    assert.equal(machinePrincipal(req("qa-pc", "qa-credential")), "qa-pc");
    assert.equal(machinePrincipal(req("other", "qa-credential")), null);
    assert.equal(machinePrincipal(req("qa-pc", "wrong")), null);
    delete process.env.SUPERVISOR_MACHINE_ID;
    assert.equal(machinePrincipal(req("qa-pc", "qa-credential")), null);
  } finally {
    process.env = before;
  }
});
test("AC2 Slack은 다른 사용자, 채널, workspace와 미설정을 거부한다", () => {
  const before = { ...process.env };
  try {
    process.env.SUPERVISOR_SLACK_OWNER_ID = "UOWNER";
    process.env.SLACK_WORKSPACE_ID = "TQA";
    process.env.SLACK_CHANNEL_PRIVATE_FEED_ID = "CQA";
    const scope = { workspaceId: "TQA", channelId: "CQA", userId: "UOWNER" };
    assert.equal(requireSlackOwner(scope), "slack:UOWNER");
    for (const key of Object.keys(scope))
      assert.throws(
        () => requireSlackOwner({ ...scope, [key]: "other" }),
        /SCOPE_DENIED/,
      );
    delete process.env.SUPERVISOR_SLACK_OWNER_ID;
    assert.throws(() => requireSlackOwner(scope), /SCOPE_DENIED/);
  } finally {
    process.env = before;
  }
});
test("AC4 제안은 실행할 테스트와 결과 확인 조건을 요구한다", () => {
  assert.equal(
    proposalSchema.safeParse({ title: "검토 없이 실행" }).success,
    false,
  );
});
