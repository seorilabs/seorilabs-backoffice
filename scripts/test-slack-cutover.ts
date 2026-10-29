// 빈 작업 전용 MySQL에 migration을 적용한 뒤 실행한다. 기존 데이터를 지우지 않는다.
import assert from "node:assert/strict";
import type { NotificationDeliveryStatus, NotificationKind, OperatorCommandStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cutoverSlackNotifications } from "@/lib/notifications/slack-cutover";
import { drainAllNotifications } from "@/lib/notifications/deploy";
import { maintainSlackRetention } from "@/lib/notifications/retention";

const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
assert.ok(["127.0.0.1", "localhost"].includes(database.hostname) && ["/backoffice_slack_cutover_test", "/backoffice_slack_cutover_contract_test"].includes(database.pathname), "빈 로컬 backoffice_slack_cutover_test 또는 backoffice_slack_cutover_contract_test DB만 허용한다");

type ApiCall = { method: string; body: Record<string, unknown> };
type File = { bytes?: Buffer; channel?: string; ts?: string; length: number };
const calls: ApiCall[] = [];
const messages = new Map<string, Record<string, unknown>>();
const files = new Map<string, File>();
const unknownMessages: string[] = [];
let sequence = 0, fileSequence = 0;
let mode: "normal" | "partial" | "unknown" | "delete-blocked" | "delete" = "normal";
let blockedFile = "";
const timestamp = () => `2200000000.${String(++sequence).padStart(6, "0")}`;
const channels = { backoffice: "C000COMMAND", "github-issues": "C000THREAD", "ops-alerts": "C000INCIDENT", "release-ops": "C000APPROVAL", "user-reviews": "C000REVIEW" };

async function syntheticSlack(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  assert.ok(init);
  assert.equal(init?.method, "POST", "검수 중 허용하지 않은 요청");
  if (url.origin === "https://files.slack.com") {
    const id = url.pathname.split("/").pop()!;
    const file = files.get(id);
    assert.ok(file && Buffer.isBuffer(init.body));
    assert.equal(init.body.length, file.length);
    file.bytes = Buffer.from(init.body);
    calls.push({ method: "upload", body: { file: id } });
    return new Response("ok");
  }
  assert.equal(url.origin, "https://slack.com", "실제 공급자 통신을 허용하지 않는다");
  const method = url.pathname.replace(/^\/api\//, "");
  const form = ["files.getUploadURLExternal", "files.info", "files.delete"].includes(method);
  assert.match(new Headers(init?.headers).get("content-type") ?? "", form ? /^application\/x-www-form-urlencoded/ : /^application\/json/);
  const body: Record<string, unknown> = form ? Object.fromEntries(new URLSearchParams(String(init?.body))) : JSON.parse(String(init?.body));
  calls.push({ method, body });
  if (method === "chat.postMessage") {
    assert.ok(Object.values(channels).includes(String(body.channel)));
    const ts = timestamp();
    messages.set(`${body.channel}:${ts}`, body);
    if (mode === "unknown") {
      unknownMessages.push(`${body.channel}:${ts}`);
      throw new TypeError("합성 응답 유실");
    }
    return Response.json({ ok: true, channel: body.channel, ts, message: body });
  }
  if (method === "chat.update") {
    if (mode === "partial") return Response.json({ ok: false, error: "cant_update_message" });
    if (!messages.has(`${body.channel}:${body.ts}`)) return Response.json({ ok: false, error: "message_not_found" });
    messages.set(`${body.channel}:${body.ts}`, body);
    return Response.json({ ok: true, channel: body.channel, ts: body.ts });
  }
  if (method === "files.getUploadURLExternal") {
    const id = `F${String(++fileSequence).padStart(9, "0")}`;
    files.set(id, { length: Number(body.length) });
    return Response.json({ ok: true, file_id: id, upload_url: `https://files.slack.com/upload/${id}` });
  }
  if (method === "files.completeUploadExternal") {
    assert.ok(Array.isArray(body.files) && body.files.length === 1);
    const id = (body.files[0] as { id: string }).id, file = files.get(id);
    assert.ok(file?.bytes);
    assert.equal(file.ts, undefined, "같은 파일을 두 번 게시하지 않는다");
    file.channel = String(body.channel_id); file.ts = timestamp();
    messages.set(`${file.channel}:${file.ts}`, { text: body.initial_comment, file: id });
    return Response.json({ ok: true, files: [{ id }] });
  }
  if (method === "files.info") {
    const file = files.get(String(body.file));
    assert.ok(file?.channel && file.ts);
    return Response.json({ ok: true, file: { shares: { public: { [file.channel]: [{ ts: file.ts }] } } } });
  }
  if (method === "chat.delete") {
    const deleted = messages.delete(`${body.channel}:${body.ts}`);
    return Response.json(deleted ? { ok: true } : { ok: false, error: "message_not_found" });
  }
  if (method === "files.delete") {
    if (mode === "delete-blocked" && body.file === blockedFile) return Response.json({ ok: false, error: "missing_scope" });
    return Response.json(files.delete(String(body.file)) ? { ok: true } : { ok: false, error: "file_not_found" });
  }
  assert.fail(`합성 경계에 없는 Slack 메서드: ${method}`);
}

const payload = (text: string): Prisma.InputJsonObject => ({ text, report: { category: "response", reason: "ISOLATED_FIXTURE" } });
async function event(key: string, status: NotificationDeliveryStatus, options: { provider?: "DISCORD" | "SLACK"; destination?: string; kind?: NotificationKind; payload?: Prisma.InputJsonObject; messageId?: string; createdAt?: Date } = {}) {
  return prisma.notificationEvent.create({ data: {
    dedupeKey: `qa-slack-cutover:${key}`, kind: options.kind ?? "OPS_ALERT", payload: options.payload ?? payload(key),
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    deliveries: { create: { provider: options.provider ?? "DISCORD", destinationKey: options.destination ?? "backoffice", status, providerMessageId: options.messageId ?? null, attempts: status === "SENT" ? 2 : 0, lastError: status === "DEAD_LETTER" ? "SYNTHETIC_PERMANENT_FAILURE" : null, sentAt: status === "SENT" ? new Date("2026-10-28T00:00:00Z") : null } },
  }, include: { deliveries: true } });
}
async function command(key: string, status: OperatorCommandStatus, provider: "DISCORD" | "SLACK" | null = "DISCORD") {
  return prisma.operatorCommandRun.create({ data: { sourceInteractionId: `qa-cutover:${key}`, sourceProvider: provider, actorUserId: provider === "SLACK" ? "U000OPERATOR" : "10000001", actorLabel: `${provider}:${key}`, channelId: provider === "SLACK" ? channels.backoffice : "10000002", operation: "deploy", params: { tag: "v1.2.3", target: "PLAY" }, status, expiresAt: new Date(Date.now() + 86400000) } });
}

async function main() {
  const counts = await Promise.all([prisma.notificationEvent.count(), prisma.operatorCommandRun.count(), prisma.operationalIncident.count(), prisma.deploymentApproval.count(), prisma.auditLog.count({ where: { action: "notification.slack_cutover" } })]);
  assert.deepEqual(counts, [0, 0, 0, 0, 0], "기존 검수 자료를 보존한다. 이 스크립트는 빈 전용 DB에서만 실행한다");
  Object.assign(process.env, { SLACK_ENABLED: "true", SLACK_BOT_TOKEN: "isolated-cutover-token", SLACK_WORKSPACE_ID: "T000CUTOVER", SLACK_APP_ID: "A000CUTOVER", SLACK_ROLE_RELEASE_OPS_USERS: "U000RELEASE", SLACK_REVIEW_RETENTION_DAYS: "30", SLACK_CUTOVER_ACK: "", PLATFORM_SLACK_APPROVAL_ENVIRONMENTS: "", NOTIFICATION_REPORTS_PAUSED: "false" });
  for (const [key, value] of Object.entries(channels)) process.env[`SLACK_CHANNEL_${key.toUpperCase().replaceAll("-", "_")}_ID`] = value;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = syntheticSlack;
  try {
    const pending = await event("pending", "PENDING");
    const processing = await event("processing", "PROCESSING");
    const parent = await event("parent", "SENT", { destination: "github-issues", messageId: "111111111" });
    const child = await event("thread", "PENDING", { destination: "github-issues", payload: { ...payload("쓰레드 본문"), thread: { parentDedupeKey: parent.dedupeKey, threadName: "합성 이슈", plain: true } } });
    const sent = await event("sent-history", "SENT", { messageId: "222222222" });
    const dead = await event("dead-history", "DEAD_LETTER");
    const native = await event("native-slack", "PENDING", { provider: "SLACK" });
    const history = [parent, sent, dead].map(row => row.deliveries[0]);
    const blockedPending = await command("pending", "PENDING"), blockedProcessing = await command("processing", "PROCESSING", null);
    const awaiting = await command("awaiting", "AWAITING_CONFIRMATION"), legacyAwaiting = await command("awaiting-null", "AWAITING_CONFIRMATION", null);
    const slackAwaiting = await command("slack-awaiting", "AWAITING_CONFIRMATION", "SLACK"), succeeded = await command("succeeded", "SUCCEEDED");
    const now = new Date();
    const incidents = await Promise.all((["OPEN", "ACKNOWLEDGED", "RECOVERED"] as const).map((status, index) => prisma.operationalIncident.create({ data: { dedupeKey: `qa-cutover-incident:${status}`, source: "synthetic", kind: "synthetic", severity: "critical", status, summary: `합성 장애 ${status}`, destinationKey: "ops-alerts", providerMessageId: String(300000000 + index), messageProvider: "DISCORD", firstDetectedAt: now, lastDetectedAt: now } })));
    const approvals = await Promise.all(["WAITING", "success"].map((providerState, index) => prisma.deploymentApproval.create({ data: { repository: "seorilabs/platform", runId: BigInt(900000000 + index), runAttempt: 1, environmentId: 10n, environment: "staging", sourceSha: "a".repeat(40), workflow: "합성 승인", runNumber: index + 1, waitingSince: now, observedAt: now, providerState, initialNotifiedAt: now } })));
    const existingApproval = await prisma.notificationEvent.create({ data: { dedupeKey: `platform-approval:${approvals[0].id}`, kind: "OPS_ALERT", payload: { deploymentApprovalId: approvals[0].id }, deliveries: { create: { provider: "DISCORD", destinationKey: "release-ops", status: "SENT", providerMessageId: "444444444" } } }, include: { deliveries: true } });
    history.push(existingApproval.deliveries[0]);

    const dry = await cutoverSlackNotifications();
    assert.deepEqual(dry, { applied: false, pendingDeliveries: 3, runningCommands: 2, confirmationCommands: 2, activeIncidents: 2, waitingApprovals: 1 });
    await assert.rejects(cutoverSlackNotifications(true), /실행 조건/);
    process.env.SLACK_CUTOVER_ACK = "OLD_WORKERS_STOPPED";
    await assert.rejects(cutoverSlackNotifications(true), /실행 중 명령/);
    assert.equal(await prisma.notificationDelivery.count({ where: { provider: "SLACK" } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: "notification.slack_cutover" } }), 0);
    assert.equal((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: pending.deliveries[0].id } })).status, "PENDING");
    // 합성 실행의 외부 결과를 확인한 상태로 바꿔 전환을 허용한다. 실제 명령을 실행하지 않는다.
    await prisma.operatorCommandRun.updateMany({ where: { id: { in: [blockedPending.id, blockedProcessing.id] } }, data: { status: "FAILED", completedAt: now, error: "합성 외부 결과 확인 완료" } });
    const first = await cutoverSlackNotifications(true);
    assert.equal(first.applied, true);
    assert.ok("createdSlackDeliveries" in first);
    assert.equal(first.createdSlackDeliveries, 7);
    assert.equal(first.suppressedDiscordDeliveries, 3);
    assert.equal(first.expiredDiscordConfirmations, 2);
    for (const row of [pending, processing, child]) {
      const old = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: row.deliveries[0].id } });
      assert.equal(old.status, "SUPPRESSED"); assert.equal(old.suppressionReason, "PROVIDER_MIGRATED_SLACK"); assert.ok(old.suppressedAt);
      const slack = await prisma.notificationDelivery.findUniqueOrThrow({ where: { eventId_provider_destinationKey: { eventId: row.id, provider: "SLACK", destinationKey: old.destinationKey } } });
      assert.equal(slack.status, "PENDING"); assert.equal(slack.providerMessageId, null);
    }
    for (const row of history) assert.deepEqual(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: row.id } }), row, "과거 발송과 실패 기록 보존");
    for (const row of [sent, dead]) assert.equal(await prisma.notificationDelivery.count({ where: { eventId: row.id, provider: "SLACK" } }), 0);
    const slackParent = await prisma.notificationDelivery.findUniqueOrThrow({ where: { eventId_provider_destinationKey: { eventId: parent.id, provider: "SLACK", destinationKey: "github-issues" } } });
    assert.equal(slackParent.providerMessageId, null);
    for (const row of [awaiting, legacyAwaiting]) assert.equal((await prisma.operatorCommandRun.findUniqueOrThrow({ where: { id: row.id } })).status, "EXPIRED");
    for (const row of [slackAwaiting, succeeded]) assert.deepEqual(await prisma.operatorCommandRun.findUniqueOrThrow({ where: { id: row.id } }), row);
    for (const row of incidents.slice(0, 2)) assert.equal(await prisma.notificationEvent.count({ where: { dedupeKey: `slack-cutover:incident:${row.id}`, deliveries: { some: { provider: "SLACK", status: "PENDING" } } } }), 1);
    assert.equal(await prisma.notificationEvent.count({ where: { dedupeKey: `slack-cutover:incident:${incidents[2].id}` } }), 0);
    assert.equal(await prisma.notificationDelivery.count({ where: { eventId: existingApproval.id, provider: "SLACK" } }), 1);
    assert.equal(await prisma.notificationEvent.count({ where: { dedupeKey: `platform-approval:${approvals[1].id}` } }), 0);
    const second = await cutoverSlackNotifications(true);
    assert.equal(second.applied, false); assert.ok("alreadyApplied" in second && second.alreadyApplied);
    assert.equal(await prisma.notificationDelivery.count({ where: { provider: "SLACK" } }), 8);
    const audit = await prisma.auditLog.findMany({ where: { action: "notification.slack_cutover" } });
    assert.equal(audit.length, 1); assert.deepEqual(audit[0].payload, first);
    assert.equal(calls.length, 0, "전환 자체는 외부 전송과 작업 실행을 하지 않는다");
    // 부모보다 먼저 생성된 쓰레드 대기도 부모 발송 뒤 원래 채널에 연결된다.
    for (let attempt = 0; attempt < 3; attempt++) {
      await prisma.notificationDelivery.updateMany({ where: { provider: "SLACK", status: "PENDING" }, data: { nextAttemptAt: new Date() } });
      await drainAllNotifications(100);
    }
    assert.equal(await prisma.notificationDelivery.count({ where: { provider: "SLACK", status: "SENT" } }), 8);
    const publishedParent = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: slackParent.id } });
    const threadPost = calls.find(call => call.method === "chat.postMessage" && call.body.text === "쓰레드 본문");
    assert.ok(threadPost);
    assert.equal(threadPost.body.channel, channels["github-issues"]); assert.equal(threadPost.body.thread_ts, publishedParent.providerMessageId);
    assert.equal(calls.filter(call => call.method === "chat.postMessage").length, 8);
    for (const row of incidents.slice(0, 2)) {
      const current = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(current.messageProvider, "SLACK"); assert.match(current.providerMessageId!, /^\d+\.\d+$/);
    }
    for (const row of history) assert.deepEqual(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: row.id } }), row);
    assert.equal((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: native.deliveries[0].id } })).status, "SENT");

    const retentionNow = new Date("2200-06-01T00:00:00Z"), expiredAt = new Date(retentionNow.getTime() - 31 * 86400000);
    const partial = [];
    mode = "partial";
    for (const [key, kind] of [["raw-partial", "STORE_REVIEW"], ["summary-partial", "OPS_ALERT"]] as const) {
      partial.push(await event(key, "PENDING", { provider: "SLACK", destination: "user-reviews", kind, createdAt: expiredAt, payload: { ...payload(`합성 리뷰 원문 ${key}`), ...(kind === "OPS_ALERT" ? { reviewReport: true } : {}), attachment: { filename: "review.csv", contentType: "text/csv", base64: Buffer.from(`합성 첨부 ${key}`).toString("base64") } } }));
    }
    await drainAllNotifications(100);
    const partialDeliveries = await Promise.all(partial.map(row => prisma.notificationDelivery.findUniqueOrThrow({ where: { id: row.deliveries[0].id } })));
    for (const row of partialDeliveries) {
      assert.equal(row.status, "DEAD_LETTER"); assert.equal(row.lastError, "cant_update_message"); assert.equal(row.providerMessageId, null);
      const receipt = row.providerReceipt as { postState: string; postedMessageId: string; file: { complete: boolean; fileIds: string[] } };
      assert.equal(receipt.postState, "CONFIRMED"); assert.ok(receipt.file.complete);
      assert.ok(messages.has(`${channels["user-reviews"]}:${receipt.postedMessageId}`));
      for (const id of receipt.file.fileIds) assert.ok(files.has(id));
    }
    mode = "unknown";
    const unknown = [];
    for (const [key, kind] of [["raw-unknown", "STORE_REVIEW"], ["summary-unknown", "OPS_ALERT"]] as const) unknown.push(await event(key, "PENDING", { provider: "SLACK", destination: "user-reviews", kind, createdAt: expiredAt, payload: { ...payload(`결과 불명 원문 ${key}`), ...(kind === "OPS_ALERT" ? { reviewReport: true } : {}) } }));
    await drainAllNotifications(100);
    for (const row of unknown) {
      const delivery = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: row.deliveries[0].id } });
      assert.equal(delivery.status, "DEAD_LETTER"); assert.equal(delivery.lastError, "SLACK_DELIVERY_OUTCOME_UNKNOWN"); assert.equal(delivery.providerMessageId, null);
      assert.equal((delivery.providerReceipt as { postState: string }).postState, "STARTED");
    }
    const rootReceipt = partialDeliveries[0].providerReceipt as { postedMessageId: string; file: { fileIds: string[] } };
    blockedFile = rootReceipt.file.fileIds[0];
    mode = "delete-blocked";
    await maintainSlackRetention(retentionNow);
    assert.equal((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: partialDeliveries[0].id } })).deletedAt, null);
    assert.ok(await prisma.notificationEvent.findUnique({ where: { id: partial[0].id } }), "파일 삭제가 실패하면 원문을 지우지 않는다");
    assert.equal(messages.has(`${channels["user-reviews"]}:${rootReceipt.postedMessageId}`), false);
    assert.equal(files.has(blockedFile), true, "삭제하지 못한 파일은 재시도 대상으로 남는다");
    assert.equal(calls.filter(call => call.method === "chat.delete" && call.body.ts === rootReceipt.postedMessageId).length, 1);
    mode = "delete";
    await maintainSlackRetention(retentionNow);
    assert.equal(await prisma.notificationEvent.findUnique({ where: { id: partial[0].id } }), null, "원문은 메시지와 파일 삭제 확인 뒤 정리한다");
    const summary = await prisma.notificationEvent.findUniqueOrThrow({ where: { id: partial[1].id } });
    assert.equal((summary.payload as { reviewReportExpired?: boolean }).reviewReportExpired, true);
    assert.doesNotMatch(JSON.stringify(summary.payload), /합성 리뷰 원문/);
    assert.ok((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: partialDeliveries[1].id } })).deletedAt);
    assert.equal(calls.filter(call => call.method === "chat.delete" && call.body.ts === rootReceipt.postedMessageId).length, 2, "재시도 시 이미 지운 원본의 message_not_found도 삭제 확인으로 처리한다");
    for (const row of partialDeliveries) {
      const receipt = row.providerReceipt as { postedMessageId: string; file: { fileIds: string[] } };
      assert.equal(messages.has(`${channels["user-reviews"]}:${receipt.postedMessageId}`), false);
      assert.ok(calls.some(call => call.method === "chat.delete" && call.body.ts === receipt.postedMessageId));
      for (const id of receipt.file.fileIds) { assert.equal(files.has(id), false); assert.ok(calls.some(call => call.method === "files.delete" && call.body.file === id)); }
    }
    for (const row of unknown) {
      const current = await prisma.notificationEvent.findUniqueOrThrow({ where: { id: row.id } });
      assert.deepEqual(current.payload, row.payload, "무ID 결과 불명 원문은 보존한다");
      assert.equal((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: row.deliveries[0].id } })).deletedAt, null);
    }
    assert.equal(unknownMessages.length, 2);
    assert.ok(unknownMessages.every(key => messages.has(key)), "결과 불명 게시물을 삭제 완료로 꾸미지 않는다");
    console.log(JSON.stringify({ scope: "Slack cutover isolated fixture", verified: ["apply guard", "pending and processing only", "thread parent", "history preserved", "active incident and waiting approval reissue", "old confirmations expire", "idempotence and audit", "partial receipt root and file deletion", "payload cleanup after deletion", "unknown outcome retained"] }));
  } finally { globalThis.fetch = originalFetch; }
}

main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
