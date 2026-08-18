import { prisma } from "@/lib/prisma";
import { collectStoreReviews } from "@/lib/store-reviews/collector";

async function main(): Promise<void> {
  const result = await collectStoreReviews();
  console.log("[store-review-collector] result", JSON.stringify({
    targets: result.targets,
    storeCoverage: result.storeCoverage,
    fetched: result.fetched,
    baselined: result.baselined,
    enqueued: result.enqueued,
    unchanged: result.unchanged,
    errors: result.errors,
  }));
  if (result.errors.length) {
    console.warn("[store-review-collector] 일부 대상 실패", JSON.stringify(result.errors));
  }
  const unavailableStores = Object.entries(result.storeCoverage)
    .filter(([, coverage]) => coverage.targets > 0 && coverage.succeeded === 0)
    .map(([store]) => store);
  if (unavailableStores.length) {
    throw new Error(`리뷰 수집 store 전체 실패: ${unavailableStores.join(", ")}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(
      "[store-review-collector] 실패:",
      error instanceof Error ? error.message : "알 수 없는 오류",
    );
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
