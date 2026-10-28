import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { metricDayOf, toDbDay } from "@/lib/analytics/metric-day";
import { createApplePublicClient } from "./public-sources";
import { createPlaySearchClient, playSearchUrl } from "./play-search";
import { brandKeyword, keywordCycle, keywordSource, type KeywordMarket } from "./keyword-cycle";
export interface KeywordTask { appId: string; market: KeywordMarket; country: string; language: string; term: string; revision: number; identity: string; brandNames?: string[]; }
export const keywordTaskKey = (task: Pick<KeywordTask, "appId" | "market" | "country" | "language" | "term">) => JSON.stringify([task.appId, task.market, keywordSource(task.market), task.country, task.language, task.term]);
export const keywordObservationId = (batchId: string, task: KeywordTask) => createHash("sha256").update(batchId + keywordTaskKey(task)).digest("hex");
export const keywordSuccess = (status: string) => status === "observed" || status === "absent";
export async function saveKeywordObservation(data: Prisma.KeywordObservationCreateInput) {
  return prisma.$transaction(async tx => {
    // createMany skipDuplicates는 재실행 시 기존 원문과 관측 시각을 바꾸지 않는다.
    await tx.keywordObservation.createMany({ data: [data], skipDuplicates: true });
    const stored = await tx.keywordObservation.findUniqueOrThrow({ where: { id: data.id } });
    if (stored.market === "app-store" && keywordSuccess(stored.status)) {
      const key = { appId: stored.appId, kind: "keyword", target: stored.term, country: stored.country, day: toDbDay(metricDayOf(stored.observedAt)) };
      await tx.marketObservation.createMany({ data: [{ ...key, value: { rank: stored.rank, resultCount: stored.resultCount }, sourceUrl: stored.sourceUrl, observedAt: stored.observedAt }], skipDuplicates: true });
      await tx.marketObservation.updateMany({ where: { ...key, observedAt: { lt: stored.observedAt } }, data: { value: { rank: stored.rank, resultCount: stored.resultCount }, sourceUrl: stored.sourceUrl, observedAt: stored.observedAt } });
    }
    await tx.sourceCollectionRun.createMany({data:[{
      id:`keyword:${stored.id}`,appId:stored.appId,source:stored.market==="app-store"?"apple-keyword":"google-play-web",target:stored.country+":"+stored.term,
      status:keywordSuccess(stored.status)?"observed":stored.status,startedAt:stored.observedAt,completedAt:stored.observedAt,dataThrough:keywordSuccess(stored.status)?stored.observedAt:null,
      errorCode:stored.errorCode,coverage:{batchId:stored.batchId,sourceSha:stored.sourceSha,observations:stored.resultCount??0}
    }],skipDuplicates:true});
    return stored;
  });
}
export async function collectKeywordRanks(now = new Date()) {
  const cycle = keywordCycle(now), sourceSha = process.env.BACKOFFICE_SOURCE_SHA ?? "";
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw Error("KEYWORD_SOURCE_SHA_REQUIRED");
  let batch = await prisma.keywordCollectionBatch.findUnique({ where: { id: cycle.id } });
  if (!batch) {
    const apps = await prisma.app.findMany({ where: { status: "ACTIVE" }, select: { id: true, displayName:true, repoFullName:true, iosBundle: true, playPackage: true, configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1 } } });
    const tasks: KeywordTask[] = [];
    for (const app of apps) {
      const revision = app.configRevisions[0], parsed = configRevisionPayloadSchema.safeParse(revision?.payload);
      if (!parsed.success || !parsed.data.monitoring?.enabled) continue;
      const config = parsed.data.monitoring;
      for (const market of ["app-store", "google-play"] as const) {
        if (market === "google-play" && process.env.KEYWORD_PLAY_ENABLED !== "true") continue;
        const identity = market === "app-store" ? app.iosBundle : app.playPackage;
        if (!identity) continue;
        for (const country of config.countries) for (const term of config.keywords) tasks.push({ appId: app.id, market, identity, brandNames:[app.displayName,app.repoFullName.split("/")[1].replaceAll("-"," ")], revision: revision.revision, country, language: market === "app-store" ? "en_us" : "en", term });
      }
    }
    // 지난 회차 미수집을 먼저 배치한다. 최초 회차는 앱별 한 검색어씩 번갈아 처리한다.
    const missing = await prisma.keywordObservation.findMany({ where: { status: "not_collected", batchId: { not: cycle.id } }, orderBy: { observedAt: "desc" }, take: 5000 });
    const priority = new Set(missing.map(row => keywordTaskKey({ ...row, market: row.market as KeywordMarket })));
    tasks.sort((a,b) => Number(priority.has(keywordTaskKey(b))) - Number(priority.has(keywordTaskKey(a))) || a.term.localeCompare(b.term) || a.appId.localeCompare(b.appId));
    await prisma.keywordCollectionBatch.createMany({ data: [{ id: cycle.id, sourceSha, startedAt: now, plan: tasks as unknown as Prisma.InputJsonValue }], skipDuplicates: true });
    batch = await prisma.keywordCollectionBatch.findUniqueOrThrow({ where: { id: cycle.id } });
  }
  if (!batch.completedAt && batch.sourceSha !== sourceSha) throw Error("KEYWORD_BATCH_SOURCE_MISMATCH");
  if (batch.completedAt) return { batchId: batch.id, status: "already_complete" };
  const tasks = batch.plan as unknown as KeywordTask[], apple = createApplePublicClient(), play = createPlaySearchClient();
  const listings = new Map<string, Promise<{id:string|number;name:string}|undefined>>();
  const searches = new Map<string, Promise<Array<string | number>>>();
  const deadline = Math.min(batch.startedAt.getTime() + 65 * 60_000, cycle.start.getTime() + 65 * 60_000);
  for (const task of tasks) {
    const id = keywordObservationId(batch.id, task);
    if (await prisma.keywordObservation.findUnique({ where: { id }, select: { id: true } })) continue;
    const sourceUrl = task.market === "app-store" ? `https://itunes.apple.com/search?term=${encodeURIComponent(task.term)}&country=${task.country}&entity=software&limit=200` : playSearchUrl(task.term, task.country, task.language);
    let status = "not_collected", rank: number | null = null, resultCount: number | null = null, errorCode: string | null = "CYCLE_BUDGET_EXCEEDED", isBrand=brandKeyword(task.term,task.brandNames??[]);
    if (Date.now() < deadline - 300_000) {
      try {
        const listingKey = JSON.stringify([task.market, task.identity, task.country]);
        if (!listings.has(listingKey)) listings.set(listingKey, task.market === "app-store" ? apple.lookup({ bundleId: task.identity }, task.country).then(rows => rows.filter(row=>row.bundleId===task.identity).map(row=>({id:row.trackId,name:row.trackName}))[0]) : play.publicListing(task.identity, task.country).then(ok => ok ? {id:task.identity,name:task.brandNames?.[0]??task.identity} : undefined));
        const identity = await listings.get(listingKey)!;
        if (!identity) { status = "not_collected"; errorCode = "PUBLIC_LISTING_UNCONFIRMED"; }
        else {
          const searchKey = JSON.stringify([task.market, task.country, task.language, task.term]);
          if (!searches.has(searchKey)) searches.set(searchKey, task.market === "app-store" ? apple.search(task.term, task.country).then(rows => rows.map(row => row.trackId)) : play.search(task.term, task.country, task.language));
          const results = await searches.get(searchKey)!;
          const index = results.indexOf(identity.id); isBrand ||= brandKeyword(task.term,[identity.name]); rank = index < 0 ? null : index + 1; resultCount = results.length;
          status = rank === null ? "absent" : "observed"; errorCode = null;
        }
      } catch (error) {
        status = /PARSE|TRUNCATED|TOO_LARGE/.test(String(error)) || error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError") ? "unparseable" : "failed";
        errorCode = status === "unparseable" ? "SOURCE_PARSE_FAILED" : /BLOCKED|HTTP_403|HTTP_429/.test(String(error)) ? "SOURCE_BLOCKED" : "SOURCE_REQUEST_FAILED";
      }
    }
    await saveKeywordObservation({ id, batchId: batch.id, appId: task.appId, market: task.market, source: keywordSource(task.market), country: task.country, language: task.language, term: task.term, revision: task.revision, sourceSha: batch.sourceSha, observedAt: new Date(), status, rank, resultCount, isBrand, sourceUrl, errorCode });
  }
  await prisma.keywordCollectionBatch.updateMany({ where: { id: batch.id, completedAt: null }, data: { completedAt: new Date() } });
  return { batchId: batch.id, count: tasks.length };
}
