import assert from "node:assert/strict";
import test from "node:test";
import { grafanaAppSlugs } from "@/lib/notifications/grafana";

test("Grafana 알림의 app slug를 중복 없이 한 번에 조회할 목록으로 만든다", () => {
  assert.deepEqual(grafanaAppSlugs([
    { labels: { app: "happy-farm" } },
    { labels: { app_slug: "babycare" } },
    { labels: { app: "happy-farm" } },
    { labels: {} },
  ]), ["happy-farm", "babycare"]);
});
