import { prisma } from "@/lib/prisma";
import { asc, asArray } from "@/lib/app-store/asc-client";
import { env } from "@/lib/env";

const URL = "https://backoffice.vzyx.xyz/api/webhooks/appstore";
const TYPE = "APP_STORE_VERSION_APP_VERSION_STATE_UPDATED";

async function main(): Promise<void> {
  const secret = env.optional("APP_STORE_WEBHOOK_SECRET").trim();
  if (!secret) throw new Error("Apple webhook 서명 secret 없음");
  const apply = process.argv.includes("--apply");
  const apps = await prisma.app.findMany({
    where: { iosBundle: { not: null } },
    select: { id: true, iosBundle: true, marketTargets: true },
  });
  let targets = 0;
  let configured = 0;
  for (const app of apps) {
    if (!app.iosBundle || !Array.isArray(app.marketTargets) ||
        !app.marketTargets.includes("appstore")) continue;
    targets++;
    const found = asArray((await asc(
      `/v1/apps?filter[bundleId]=${encodeURIComponent(app.iosBundle)}&limit=1`
    )).data)[0];
    if (!found) throw new Error(`ASC 앱 없음: ${app.id}`);
    const hooks = asArray((await asc(
      `/v1/apps/${encodeURIComponent(found.id)}/webhooks?limit=200`
    )).data);
    const existing = hooks.find((item) => item.attributes?.url === URL);
    if (!apply) {
      console.log("[appstore-webhook] 대상", app.id, existing ? "existing" : "create");
      continue;
    }
    const attributes = {
      enabled: true, eventTypes: [TYPE], name: "Seorilabs Backoffice review state",
      secret, url: URL,
    };
    const doc = existing
      ? await asc(`/v1/webhooks/${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ data: { type: "webhooks", id: existing.id, attributes } }),
        })
      : await asc("/v1/webhooks", {
          method: "POST",
          body: JSON.stringify({
            data: { type: "webhooks", attributes, relationships: {
              app: { data: { type: "apps", id: found.id } },
            } },
          }),
        });
    const hook = asArray(doc.data)[0];
    if (!hook) throw new Error(`ASC webhook readback 없음: ${app.id}`);
    const readback = asArray((await asc(`/v1/webhooks/${encodeURIComponent(hook.id)}`)).data)[0];
    if (readback?.attributes?.url !== URL ||
        readback.attributes?.enabled !== true ||
        !Array.isArray(readback.attributes.eventTypes) ||
        !readback.attributes.eventTypes.includes(TYPE)) {
      throw new Error(`ASC webhook readback 불일치: ${app.id}`);
    }
    await prisma.storeReviewSubmissionSync.upsert({
      where: { appId_store: { appId: app.id, store: "APP_STORE" } },
      create: { appId: app.id, store: "APP_STORE", webhookId: hook.id },
      update: { webhookId: hook.id },
    });
    configured++;
    console.log("[appstore-webhook] 확인", app.id, hook.id);
  }
  console.log("[appstore-webhook] result", JSON.stringify({ targets, configured, apply }));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("[appstore-webhook] 실패", error instanceof Error ? error.message : "unknown");
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
  });
