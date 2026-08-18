import { prisma } from "@/lib/prisma";
import { collectStoreReviews } from "@/lib/store-reviews/collector";

async function main(): Promise<void> {
  const result = await collectStoreReviews();
  console.log("[store-review-collector] result", JSON.stringify({
    targets: result.targets,
    fetched: result.fetched,
    baselined: result.baselined,
    enqueued: result.enqueued,
    unchanged: result.unchanged,
    errors: result.errors,
  }));
  if (result.errors.length) {
    throw new Error(`리뷰 수집 대상 ${result.errors.length}개 실패`);
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
