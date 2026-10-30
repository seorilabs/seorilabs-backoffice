import assert from "node:assert/strict";
import test from "node:test";

import { supervisorSlackChannelId } from "./channel";
import { publishProposals } from "./slack";

test("대표 채널 미설정은 제안 예약 전에 거부하며 뉴스 채널을 사용하지 않는다", async () => {
  const before = { ...process.env };
  try {
    process.env.SLACK_CHANNEL_PRIVATE_FEED_ID = "CNEWS";
    for (const value of [undefined, "", "invalid"]) {
      if (value === undefined) delete process.env.SLACK_CHANNEL_SUPERVISOR_ID;
      else process.env.SLACK_CHANNEL_SUPERVISOR_ID = value;
      assert.equal(supervisorSlackChannelId(), "");
      await assert.rejects(
        publishProposals(),
        /SUPERVISOR_SLACK_CHANNEL_NOT_CONFIGURED/,
      );
    }
    process.env.SLACK_CHANNEL_SUPERVISOR_ID = " CAGENT ";
    assert.equal(supervisorSlackChannelId(), "CAGENT");
    assert.equal(process.env.SLACK_CHANNEL_PRIVATE_FEED_ID, "CNEWS");
  } finally {
    process.env = before;
  }
});
