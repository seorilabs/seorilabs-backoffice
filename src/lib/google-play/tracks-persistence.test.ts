import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Prisma, PrismaClient, type StoreReviewSubmissionObservation } from "@prisma/client";
import { googlePlaySubmissionWrites } from "@/lib/google-play/tracks-collector";
import { PLAY_UNAVAILABLE, type PlayLifecycle, type PlayTrackStatus } from "@/lib/google-play/release-state";
import { persistPlaySubmission } from "@/lib/store-reviews/submissions/persist";

type Row = StoreReviewSubmissionObservation;
interface Fixture {
  db: Pick<PrismaClient, "$transaction">;
  rows: () => Promise<Row[]>;
  events: () => Promise<Array<{ payload: unknown }>>;
  expire: () => Promise<void>;
  legacy: (appId: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

// 실제 Prisma 경계를 사용하는 저장·rollback 회귀 테스트. 동시 DB 잠금은
// 아래 동일 시나리오를 임시 MySQL에 실행해 별도로 검증한다.
function memoryFixture(): Fixture {
  let rows: Row[] = [];
  let events: Array<{ payload: unknown }> = [];
  let tail = Promise.resolve();
  const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>, options: { isolationLevel: string }) => {
    assert.equal(options.isolationLevel, "ReadCommitted");
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    const savedRows = structuredClone(rows);
    const savedEvents = structuredClone(events);
    let locked = false;
    const tx = {
      storeReviewSubmissionSync: { upsert: async () => { locked = true; } },
      storeReviewSubmissionObservation: {
        findFirst: async ({ where, orderBy }: { where: Prisma.StoreReviewSubmissionObservationWhereInput; orderBy: Prisma.StoreReviewSubmissionObservationOrderByWithRelationInput | Prisma.StoreReviewSubmissionObservationOrderByWithRelationInput[] }) => {
          assert.ok(locked, "관측을 읽기 전에 sync 행의 쓰기 잠금을 잡아야 한다");
          const filter = typeof where.state === "object" ? where.state as { startsWith?: string; not?: string } : null;
          const found = rows.filter((row) => row.appId === where.appId && row.store === where.store && row.externalVersionId === where.externalVersionId && row.trackName === where.trackName && (!filter || (row.state.startsWith(filter.startsWith ?? "") && row.state !== filter.not)));
          const order = Array.isArray(orderBy) ? orderBy[0]! : orderBy;
          const field = order.lastObservedAt ? "lastObservedAt" : "sourceEventAt";
          const direction = order[field] === "asc" ? 1 : -1;
          return found.sort((a, b) => direction * (a[field].getTime() - b[field].getTime()))[0] ?? null;
        },
        create: async ({ data }: { data: Prisma.StoreReviewSubmissionObservationUncheckedCreateInput }) => {
          if (rows.some((row) => row.store === data.store && row.externalEventId === data.externalEventId)) throw new Error("duplicate external event");
          const row = { id: randomUUID(), createdAt: new Date(), ...data } as Row;
          rows.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          Object.assign(rows.find((row) => row.id === where.id)!, data);
        },
      },
      notificationEvent: { upsert: async ({ create }: { create: { payload: unknown } }) => {
        events.push({ payload: create.payload });
        return { id: randomUUID() };
      } },
    };
    try { return await fn(tx); }
    catch (error) { rows = savedRows; events = savedEvents; throw error; }
    finally { unlock(); }
  } } as unknown as Pick<PrismaClient, "$transaction">;
  return {
    db, rows: async () => structuredClone(rows), events: async () => structuredClone(events),
    expire: async () => { rows.forEach((row) => { row.rawPayload = {}; row.expiresAt = null; }); },
    legacy: async (appId) => { rows.push({ appId, store: "GOOGLE_PLAY", externalVersionId: "legacy", trackName: "production", state: "completed" } as Row); },
    cleanup: async () => {},
  };
}

async function mysqlFixture(url: string, appId: string): Promise<Fixture> {
  // 운영 DB로 잘못 실행하지 않도록 임시 로컬 DB만 허용한다.
  const target = new URL(url);
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname) && target.pathname === "/play_release_test");
  const db = new PrismaClient({ datasourceUrl: url });
  await db.app.create({ data: { id: appId, slug: appId, repoFullName: `test/${appId}`, displayName: "Test", type: "APP", engine: "RN", marketTargets: [] } });
  const where = { appId };
  return {
    db, rows: () => db.storeReviewSubmissionObservation.findMany({ where }),
    events: () => db.notificationEvent.findMany({ where: { payload: { path: "$.appId", equals: appId } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    expire: async () => { await db.storeReviewSubmissionObservation.updateMany({ where, data: { rawPayload: {}, expiresAt: null } }); },
    legacy: async () => { await db.storeReviewSubmissionObservation.create({ data: {
      appId, store: "GOOGLE_PLAY", externalEventId: randomUUID(), externalVersionId: "legacy", trackName: "production", state: "completed", stateLabel: "출시 완료", rawPayload: {}, contentHash: "legacy", sourceEventAt: new Date("2026-01-01Z"),
    } }); },
    cleanup: async () => {
      await db.notificationEvent.deleteMany({ where: { payload: { path: "$.appId", equals: appId } } });
      await db.app.delete({ where: { id: appId } });
      await db.$disconnect();
    },
  };
}

for (const mode of ["memory", "mysql"] as const) describe(`Play 저장·알림 회귀 · ${mode}`, { skip: mode === "mysql" && !process.env.PLAY_SUBMISSION_TEST_DATABASE_URL }, () => {
  let fixture: Fixture;
  let appId: string;
  before(async () => { appId = `play-${randomUUID()}`; fixture = mode === "memory" ? memoryFixture() : await mysqlFixture(process.env.PLAY_SUBMISSION_TEST_DATABASE_URL!, appId); });
  after(async () => fixture?.cleanup());
  let tick = 0;
  function write(code: string, lifecycle: PlayLifecycle = "PUBLISHED", status: PlayTrackStatus = "completed", fraction?: number, trackName = "production") {
    return googlePlaySubmissionWrites({
      appId, appDisplayName: "테스트", packageName: "com.example.test", sourceEventAt: new Date(Date.UTC(2026, 9, 4, 12, 0, ++tick)),
      release: { trackName, releaseName: `v${code}`, versionCodes: [code], lifecycle, status, ...(fraction !== undefined ? { userFraction: fraction } : {}) },
    })[0]!;
  }
  async function persist(code: string, lifecycle: PlayLifecycle = "PUBLISHED", status: PlayTrackStatus = "completed", fraction?: number, trackName = "production") {
    return persistPlaySubmission(write(code, lifecycle, status, fraction, trackName), fixture.db);
  }

  test("최초 sync 생성 경합·tracks만의 기존 관측·이후 새 버전도 첫 정상 결합은 기준 상태다", async () => {
    await fixture.legacy(appId);
    const beforeCount = (await fixture.events()).length;
    const first = write("101");
    const second = write("101");
    const results = await Promise.all([persistPlaySubmission(first, fixture.db), persistPlaySubmission(second, fixture.db)]);
    assert.equal(results.filter((result) => result === "baseline").length, 1);
    assert.equal(await persist("102"), "baseline");
    assert.equal((await fixture.events()).length, beforeCount);
  });

  test("completed + IN_REVIEW와 승인 게시 대기→공개 전환은 각각 한 번만 알린다", async () => {
    assert.equal(await persist("201", "IN_REVIEW"), "baseline");
    const beforeCount = (await fixture.events()).length;
    assert.equal(await persist("201", "APPROVED_NOT_PUBLISHED"), "transition");
    assert.equal(await persist("201"), "transition");
    assert.equal(await persist("201"), "no-change");
    const events = (await fixture.events()).slice(beforeCount);
    assert.equal(events.length, 2);
    assert.match(JSON.stringify(events[0]), /승인 완료 · 게시 대기/);
    assert.match(JSON.stringify(events[1]), /프로덕션 공개 확인 · 전체 출시/);
  });

  test("이름·조회 시각 변경은 마지막 확인 시각만 갱신한다", async () => {
    const initial = write("301");
    await persistPlaySubmission(initial, fixture.db);
    const later = { ...write("301"), rawPayload: { releaseName: "renamed" } };
    assert.equal(await persistPlaySubmission(later, fixture.db), "no-change");
    const rows = (await fixture.rows()).filter((row) => row.externalVersionId === initial.externalVersionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sourceEventAt.toISOString(), initial.sourceEventAt.toISOString());
    assert.equal(rows[0]!.lastObservedAt.toISOString(), later.sourceEventAt.toISOString());
  });

  test("실패→동일 상태 복구는 알리지 않고 마지막 정상 상태에서 달라진 복구만 알린다", async () => {
    const base = write("401", "IN_REVIEW");
    await persistPlaySubmission(base, fixture.db);
    const beforeCount = (await fixture.events()).length;
    const failed = () => ({ ...write("401"), state: PLAY_UNAVAILABLE, rawPayload: { reason: "403" } });
    await persistPlaySubmission(failed(), fixture.db);
    assert.equal(await persist("401", "IN_REVIEW"), "no-change");
    assert.equal((await fixture.events()).length, beforeCount);
    await persistPlaySubmission(failed(), fixture.db);
    assert.equal(await persist("401"), "transition");
    assert.equal((await fixture.events()).length, beforeCount + 1);
    assert.match(JSON.stringify((await fixture.events()).at(-1)), /이전 단계: 심사 중/);
  });

  test("실패가 먼저 나타난 버전도 첫 정상 상태는 기준 상태다", async () => {
    await persistPlaySubmission({ ...write("402"), state: PLAY_UNAVAILABLE }, fixture.db);
    const beforeCount = (await fixture.events()).length;
    assert.equal(await persist("402"), "baseline");
    assert.equal((await fixture.events()).length, beforeCount);
  });

  test("출시율 변경·중지·재개는 구분해서 알리고 최초 공개 확인 시각을 보존한다", async () => {
    const initial = write("501", "PUBLISHED", "inProgress", 0.1);
    await persistPlaySubmission(initial, fixture.db);
    const beforeCount = (await fixture.events()).length;
    assert.equal(await persist("501", "PUBLISHED", "inProgress", 0.2), "transition");
    assert.equal(await persist("501", "PUBLISHED", "halted", 0.2), "transition");
    assert.equal(await persist("501", "PUBLISHED", "inProgress", 0.2), "transition");
    assert.equal(await persist("501"), "transition");
    const events = (await fixture.events()).slice(beforeCount);
    assert.equal(events.length, 4);
    assert.match(JSON.stringify(events[1]), /프로덕션 출시 중지/);
    assert.match(JSON.stringify(events[2]), /20% 단계적 출시/);
    assert.ok(events.every((event) => JSON.stringify(event).includes(`공개 확인 시각: ${initial.sourceEventAt.toISOString()}`)));
  });

  test("내부 테스트는 제공 확인으로 알리며 production과 기준 상태가 독립적이다", async () => {
    assert.equal(await persist("601", "IN_REVIEW", "completed", undefined, "internal"), "baseline");
    assert.equal(await persist("601", "PUBLISHED", "completed", undefined, "internal"), "transition");
    assert.match(JSON.stringify((await fixture.events()).at(-1)), /내부 테스트 제공 확인/);
    assert.equal(await persist("601"), "baseline");
  });

  test("알림 생성 실패는 관측도 rollback하며 부분 처리 후 재시도는 중복 전송하지 않는다", async () => {
    await persist("701", "IN_REVIEW");
    await persist("702", "IN_REVIEW");
    const beforeCount = (await fixture.events()).length;
    const first = write("701");
    const second = write("702");
    assert.equal(await persistPlaySubmission(first, fixture.db), "transition");
    await assert.rejects(() => persistPlaySubmission({ ...second, card: () => { throw new Error("카드 실패"); } }, fixture.db), /카드 실패/);
    assert.equal(await persistPlaySubmission(first, fixture.db), "duplicate");
    assert.equal(await persistPlaySubmission(second, fixture.db), "transition");
    assert.equal((await fixture.events()).length, beforeCount + 2);
  });

  test("동일 상태 동시 처리에서 알림을 중복 등록하지 않는다", async () => {
    await persist("801", "IN_REVIEW");
    const beforeCount = (await fixture.events()).length;
    const one = write("801");
    const two = write("801");
    const results = await Promise.all([persistPlaySubmission(one, fixture.db), persistPlaySubmission(two, fixture.db)]);
    assert.equal(results.filter((result) => result === "transition").length, 1);
    assert.equal((await fixture.events()).length, beforeCount + 1);
  });

  test("역순·동일 시각 관측은 마지막 상태와 알림을 되돌리지 않는다", async () => {
    const initial = write("802", "IN_REVIEW");
    await persistPlaySubmission(initial, fixture.db);
    const published = write("802");
    await persistPlaySubmission(published, fixture.db);
    const beforeCount = (await fixture.events()).length;
    assert.equal(await persistPlaySubmission(initial, fixture.db), "duplicate");
    assert.equal(await persistPlaySubmission({ ...initial, sourceEventAt: published.sourceEventAt }, fixture.db), "duplicate");
    assert.equal((await fixture.events()).length, beforeCount);
    assert.equal(await persist("802"), "no-change");
  });

  test("원본 응답 만료 후에도 기준 상태·중복 방지·공개 확인 시각이 남는다", async () => {
    const initial = write("901");
    await persistPlaySubmission(initial, fixture.db);
    await fixture.expire();
    const beforeCount = (await fixture.events()).length;
    assert.equal(await persist("901"), "no-change");
    assert.equal((await fixture.events()).length, beforeCount);
    assert.equal(await persist("901", "PUBLISHED", "halted"), "transition");
    assert.match(JSON.stringify((await fixture.events()).at(-1)), new RegExp(initial.sourceEventAt.toISOString().replaceAll(".", "\\.")));
  });
});
