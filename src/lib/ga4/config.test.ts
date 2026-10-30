import assert from "node:assert/strict";
import test from "node:test";
import { ga4ConnectionSchema, activeGa4ConfigSelect } from "./config";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";

test("중앙 설정은 선택 GA4 연결을 검증하며 기존 payload도 유지한다", () => {
  const payload = { schemaVersion: 1, markets: [] };
  const ga4 = { enabled: true, projectId: "seorilabs-ungeul", datasetId: "analytics_552066659" };
  assert.equal(configRevisionPayloadSchema.safeParse(payload).success, true);
  assert.deepEqual(configRevisionPayloadSchema.parse({ ...payload, ga4 }).ga4, ga4);
  for (const bad of [{ ...ga4, datasetId: "analytics_1`;DROP" }, { ...ga4, projectId: "x" }, { ...ga4, enabled: "true" }, { ...ga4, secret: "forbidden" }]) {
    assert.equal(ga4ConnectionSchema.safeParse(bad).success, false);
  }
  assert.deepEqual(activeGa4ConfigSelect.where, { status: "ACTIVE" });
  assert.equal(activeGa4ConfigSelect.take, 1);
});
