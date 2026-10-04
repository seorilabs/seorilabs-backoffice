import { createHash } from "node:crypto";
import { z } from "zod";

export const REPOSITORY = "seorilabs/platform";
export const targetSchema = z.object({
  version: z.literal(1),
  repository: z.literal(REPOSITORY),
  runId: z.string().regex(/^\d+$/),
  runAttempt: z.number().int().positive(),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  imageSha: z.string().regex(/^[a-f0-9]{40}$/),
  environment: z.enum(["production", "staging"]),
  workflow: z.enum(["deploy.yml", "deploy-staging.yml", "presence-edge.yml"]),
  image: z.string().max(300),
  targets: z.array(z.string().min(1).max(200)).min(1).max(20),
}).strict();
export type DeploymentTarget = z.infer<typeof targetSchema>;
export function targetHash(target: DeploymentTarget) {
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}
export function validateTarget(value: unknown, run: { id: number; run_attempt?: number; head_sha: string; path: string }, environment: string) {
  const target = targetSchema.parse(value);
  if (target.runId !== String(run.id) || target.runAttempt !== run.run_attempt || target.sourceSha !== run.head_sha || target.environment !== environment || !run.path.endsWith(`/${target.workflow}`)) throw new Error("실행·재실행·SHA·환경·대상 불일치");
  if (target.workflow !== "deploy-staging.yml" && target.imageSha !== target.sourceSha) throw new Error("이미지 SHA 불일치");
  if ((target.workflow === "deploy-staging.yml") !== (environment === "staging")) throw new Error("환경 불일치");
  const expectedImage = target.workflow === "presence-edge.yml" ? "registry.vzyx.xyz/seorilabs/platform-presence-edge" : "asia-northeast3-docker.pkg.dev/seorilabs-platform/platform/platform";
  if (target.image !== `${expectedImage}:${target.imageSha}`) throw new Error("이미지 대상 불일치");
  const expectedTargets = target.workflow === "deploy-staging.yml"
    ? ["cloud-run:seorilabs-platform:asia-northeast3:platform-api-stg"]
    : target.workflow === "presence-edge.yml" ? ["kubernetes:platform:deployment/platform-presence-edge:edge"]
    : ["platform-api", "platform-ingest", "platform-iap", "platform-admin", "platform-ads"].map(name => `cloud-run:seorilabs-platform:asia-northeast3:${name}`).concat("cloud-run-job:seorilabs-platform:asia-northeast3:platform-worker");
  if (JSON.stringify(target.targets) !== JSON.stringify(expectedTargets)) throw new Error("배포 대상 불일치");
  return target;
}
export function remindersAllowed(now: Date) {
  const hour = (now.getUTCHours() + 9) % 24;
  return hour >= 9 && hour < 22;
}
export function directApprovalEnabled(environment: string) {
  return (process.env.PLATFORM_DISCORD_APPROVAL_ENVIRONMENTS ?? "").split(",").includes(environment);
}
export function monitoringEnabled() { return process.env.PLATFORM_APPROVAL_MONITOR_ENABLED !== "false"; }
export function assertCanReview(input: { currentUserCanApprove: boolean; githubId: string; triggeringActorId: string; actorId: string; expectedAttempt: number; actualAttempt: number; expectedSha: string; actualSha: string; expectedTargetHash: string; actualTargetHash: string }) {
  if (!input.currentUserCanApprove || input.githubId === input.triggeringActorId || input.githubId === input.actorId) throw new Error("GitHub 승인 권한 없음 또는 자기 승인 금지");
  if (input.expectedAttempt !== input.actualAttempt || input.expectedSha !== input.actualSha || input.expectedTargetHash !== input.actualTargetHash) throw new Error("승인 확인 이후 실행 또는 배포 대상 변경");
}
// API 오류 본문은 요청 헤더/토큰을 포함할 수 있어 영구 기록하지 않는다.
export function providerError(error: unknown) {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  if (status === 401) return "GitHub 토큰 만료 또는 인증 실패";
  if (status === 403) return "GitHub 권한 부족 또는 조직 승인 필요";
  if (status === 404) return "GitHub 실행 또는 자격증명 범위 확인 필요";
  return "공급자 조회·통신 실패 — GitHub에서 확인 필요";
}

export class ApprovalCredentialError extends Error {}
export function reminderDue(row: { initialNotifiedAt: Date | null; nextReminderAt: Date | null }, now: Date, hasUnsent: boolean) {
  if (!row.initialNotifiedAt || hasUnsent || !remindersAllowed(now)) return false;
  return now >= (row.nextReminderAt ?? new Date(row.initialNotifiedAt.getTime() + 30 * 60_000));
}

export function reviewMatches(review: { comment: string; state: string; user?: { id: number } | null; environments: Array<{ id?: number }> }, expected: { commandId: string; githubId: string; environmentId: string; decision: string }) {
  return review.comment.split("\n")[0] === `backoffice:${expected.commandId}` && String(review.user?.id) === expected.githubId && review.state === expected.decision && review.environments.some(environment => String(environment.id) === expected.environmentId);
}
