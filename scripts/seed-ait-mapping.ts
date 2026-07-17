// App ↔ AppsInToss 콘솔 miniAppId 매핑을 DB 에 채운다(선택적: ingest 는 slug 로도 해석 가능).
// 정본 표(ait-apps.ts)를 읽어 App.slug 기준으로 aitMiniAppId/aitWorkspaceId 를 upsert 한다.
// 로컬 원샷 실행: DATABASE_URL=... npx tsx scripts/seed-ait-mapping.ts
// (프로덕션 DB 는 클러스터 내부이므로 kubectl port-forward svc/backoffice 등으로 터널 후 실행)
import { prisma } from "../src/lib/prisma";
import { AIT_WORKSPACE_ID, AIT_MINIAPP_BY_SLUG } from "../src/lib/analytics/ait-apps";

async function main() {
  let updated = 0;
  const missing: string[] = [];
  for (const [slug, miniAppId] of Object.entries(AIT_MINIAPP_BY_SLUG)) {
    const r = await prisma.app.updateMany({
      where: { slug },
      data: { aitMiniAppId: miniAppId, aitWorkspaceId: AIT_WORKSPACE_ID },
    });
    if (r.count === 0) missing.push(slug);
    else updated += r.count;
  }
  console.log(JSON.stringify({ updated, missing }, null, 2));
  if (missing.length) {
    console.warn(
      `[seed-ait-mapping] App 레코드 없는 slug ${missing.length}개 — 콘솔엔 있으나 backoffice App 미등록. ` +
        `ingest 는 이 앱들을 skip 한다(App 등록 후 재실행).`,
    );
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
