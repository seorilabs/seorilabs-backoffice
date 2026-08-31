import { z } from "zod";
import type { Movement, MovementVerdict } from "@/lib/core/metric-highlights";

// Org 종합 지표 보고서 문서(OrgReportDocument)의 정본 스키마.
// OrgReportDaily.report JSON 은 항상 이 스키마를 통과한 문서만 담는다. 읽기 경로도
// parseOrgReportDocument 를 거쳐, 깨진 스냅샷이 화면을 죽이는 대신 재계산으로 강등된다.
//
// Movement 는 spec 에 format 함수가 들어 있어 그대로 직렬화할 수 없다. 저장은
// metricKey 만 남기고(MovementSnapshot), 렌더 시 METRIC_SPECS 로 스펙을 복원한다.

export const ORG_REPORT_SCHEMA_VERSION = 1;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const movementSnapshotSchema = z
  .object({
    label: z.string(),
    metricKey: z.string(),
    latest: z.number(),
    baseline: z.number().nullable(),
    sample: z.number().nullable().optional(),
    change: z.number().nullable(),
    verdict: z.enum(["highlight", "lowlight", "flat", "insufficient", "absent"]),
    score: z.number(),
    date: isoDay,
  })
  .strict();

export type MovementSnapshot = z.infer<typeof movementSnapshotSchema>;

/** GA4·콘솔 요약 카드용 셀. prev 는 전일 값(없으면 null — 변화율을 지어내지 않는다). */
const platformCellSchema = z
  .object({ dau: z.number(), dauPrev: z.number().nullable() })
  .strict();

const segmentCellSchema = z
  .object({
    apps: z.number(),
    dau: z.number(),
    dauPrev: z.number().nullable(),
    iaaKrw: z.number(),
    iapTrxKrw: z.number(),
  })
  .strict();

const appGa4Schema = z
  .object({
    date: isoDay,
    dau: z.number(),
    dauPrev: z.number().nullable(),
    /** 직전 7일 중앙값(baselineOf). 관측이 모자라면 null. */
    dau7dMedian: z.number().nullable(),
    newUsers: z.number(),
    d1Pct: z.number().nullable(),
    engagedUsers: z.number(),
    adCompletions: z.number(),
    dauAndroid: z.number(),
    dauIos: z.number(),
    dauWeb: z.number(),
  })
  .strict();

const appListingSchema = z
  .object({
    miniAppId: z.number(),
    /** 같은 App 의 다중 리스팅 구분 라벨. 단일 리스팅이면 null. */
    label: z.string().nullable(),
    date: isoDay,
    /** 보고서 기준일 대비 이 리스팅 최신 스냅샷의 지연 일수(0=기준일 값). */
    lagDays: z.number(),
    dau: z.number().nullable(),
    newUsers: z.number().nullable(),
    iaaKrw: z.number(),
    iapTrxKrw: z.number(),
    payingUsers: z.number(),
  })
  .strict();

const costFiguresSchema = z
  .object({
    github: z
      .object({
        quotaMinutes: z.number(),
        includedMinutes: z.number(),
        grossUsd: z.number(),
        netUsd: z.number(),
      })
      .strict()
      .nullable(),
    gcp: z.object({ total: z.number(), currency: z.string() }).strict().nullable(),
    llm: z.object({ totalUsd: z.number() }).strict().nullable(),
    stability: z.object({ credits: z.number() }).strict().nullable(),
  })
  .strict();

export type CostFigures = z.infer<typeof costFiguresSchema>;

export const orgReportDocumentSchema = z
  .object({
    version: z.literal(ORG_REPORT_SCHEMA_VERSION),
    /** 보고서 기준일(D-1). */
    refDate: isoDay,
    /** 문서를 만든 시각(ISO datetime). */
    generatedAt: z.string(),
    /**
     * 수치가 만들어진 방식. published=당일 11:00 발행, recomputed=원본에서 소급 계산
     * (비용·LLM 해설은 과거 시점을 복원할 수 없어 null 이다).
     */
    origin: z.enum(["published", "recomputed"]),
    summary: z
      .object({
        ga4: z
          .object({
            dau: z.number(),
            dauPrev: z.number().nullable(),
            newUsers: z.number(),
            engagedUsers: z.number(),
            adCompletions: z.number(),
            apps: z.number(),
          })
          .strict(),
        console: z
          .object({
            iaaKrw: z.number(),
            iaaPrevKrw: z.number().nullable(),
            iapTrxKrw: z.number(),
            iapSettlementKrw: z.number(),
            payingUsers: z.number(),
            listings: z.number(),
          })
          .strict(),
      })
      .strict(),
    /** GA4 dauAndroid/dauIos/dauWeb 합산. */
    platform: z
      .object({ android: platformCellSchema, ios: platformCellSchema, web: platformCellSchema })
      .strict(),
    /** App.type 기준 게임/비게임 분해. */
    segments: z.object({ game: segmentCellSchema, app: segmentCellSchema }).strict(),
    apps: z.array(
      z
        .object({
          slug: z.string(),
          displayName: z.string(),
          type: z.enum(["APP", "GAME"]),
          /** 기준일 GA4 스냅샷. 그 날 수집이 없으면 null(합계에서도 빠진 앱). */
          ga4: appGa4Schema.nullable(),
          listings: z.array(appListingSchema),
        })
        .strict(),
    ),
    /** 하이라이트 판정 전량(하이라이트·로우라이트만이 아니라 flat/insufficient/absent 포함). */
    movements: z.array(movementSnapshotSchema),
    referrers: z.array(z.object({ dimension: z.string(), rate: z.number() }).strict()),
    /** LLM 해설(발행 당시 고정). 미설정·실패·재계산이면 null. */
    narrative: z.string().nullable(),
    /** 발행 시점 종량제 비용(월누적). 재계산 모드에서는 복원 불가라 null. */
    costs: z
      .object({
        month: z.string(),
        summaryLines: z.array(z.string()),
        warnings: z.array(
          z
            .object({
              key: z.string(),
              title: z.string(),
              detail: z.string(),
              evidence: z.array(z.string()),
            })
            .strict(),
        ),
        figures: costFiguresSchema,
      })
      .strict()
      .nullable(),
    /** 콘솔 수집 상태. 콘솔은 온디맨드 push 라 기준일보다 늦을 수 있다. */
    consoleMeta: z
      .object({
        refDate: isoDay.nullable(),
        lagDays: z.number().nullable(),
        listings: z.number(),
        onRefDate: z.number(),
        /** push 수집이 아예 없는 리스팅 라벨. */
        missing: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type OrgReportDocument = z.infer<typeof orgReportDocumentSchema>;

/** Movement → 저장형. spec(함수 포함)을 버리고 metricKey 만 남긴다. */
export function serializeMovement(movement: Movement): MovementSnapshot {
  return {
    label: movement.label,
    metricKey: movement.metricKey,
    latest: movement.latest,
    baseline: movement.baseline,
    ...(movement.sample !== undefined ? { sample: movement.sample } : {}),
    change: movement.change,
    verdict: movement.verdict as MovementVerdict,
    score: movement.score,
    date: movement.date,
  };
}

/**
 * 저장된 report JSON 을 문서로 복원한다. 스키마 위반(미래 버전 포함)이면 null —
 * 호출부는 재계산으로 강등하고 로그를 남긴다. 깨진 스냅샷이 페이지를 죽이지 않게 한다.
 */
export function parseOrgReportDocument(raw: unknown): OrgReportDocument | null {
  const parsed = orgReportDocumentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
