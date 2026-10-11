import test from "node:test";
import assert from "node:assert/strict";
import { incidentShouldMention } from "./mention-policy";
test("critical OPEN 최초 신규 발송만 멘션하고 편집·대체·warning은 조용히 보낸다", () => {
  assert.equal(incidentShouldMention({ status: "OPEN", severity: "critical", providerMessageId: null }), true);
  for (const status of ["ACKNOWLEDGED", "RECOVERED"]) assert.equal(incidentShouldMention({ status, severity: "critical", providerMessageId: null }), false);
  assert.equal(incidentShouldMention({ status: "OPEN", severity: "warning", providerMessageId: null }), false);
  assert.equal(incidentShouldMention({ status: "OPEN", severity: "critical", providerMessageId: "deleted-message" }), false);
});
