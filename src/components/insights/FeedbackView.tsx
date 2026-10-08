import { vitalsPresentation } from "@/lib/market/vitals-presentation";
import Link from "next/link";
import { feedbackOverview } from "@/lib/insights/queries";
import { dbDay } from "@/lib/analytics/metric-day";
import { kstDateTimeShort } from "@/lib/format/kst";
export async function FeedbackView({ appId }: { appId?: string }) {
  const data = await feedbackOverview(appId);
  const names = new Map(data.apps.map((app) => [app.id, app.displayName]));
  const vitals = data.market.filter((row) => row.kind === "android-vitals");
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 font-semibold">인사이트와 다음 행동</h2>
        {data.insights.length ? (
          <ul className="divide-y divide-neutral-100">
            {data.insights.map((item) => (
              <li key={item.id} className="py-3">
                <Link className="text-sm text-blue-700" href={`/feedback/insights/${item.id}`}>
                  {item.signal.title}
                </Link>
                <p className="text-xs text-neutral-500">
                  {names.get(item.signal.appId ?? "") ?? "조직"} ·{" "}
                  {item.status === "READY"
                    ? "분석 완료"
                    : item.status === "FALLBACK"
                      ? "사실 요약"
                      : "분석 대기·확인 필요"}{" "}
                  · {kstDateTimeShort(item.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">
            관측이 쌓이면 근거를 붙인 인사이트가 표시됩니다.
          </p>
        )}
      </section>
      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 font-semibold">리뷰 평점</h2>
        <p className="mb-3 text-xs text-neutral-500">
          원문·작성자 정보는 이 화면에 저장하지 않습니다. 최신 수집 리뷰이며 전체 스토어 평점과
          다릅니다.
        </p>
        {data.reviews.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.reviews.map((review) => (
              <li key={review.id} className="rounded bg-neutral-50 p-3 text-sm">
                {names.get(review.appId)} ·{" "}
                {review.store === "APP_STORE" ? "App Store" : "Google Play"} · {review.rating}/5점
                <p className="text-xs text-neutral-500">
                  최근 관측 {kstDateTimeShort(review.lastObservedAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">
            수집된 리뷰 없음 · 수집 상태에서 권한과 일정을 확인하세요.
          </p>
        )}
      </section>
      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 font-semibold">검색 노출·평점·경쟁 앱</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Apple 공개 검색 API의 상위 200개 관측 순서입니다. 기기·개인화·광고에 따라 실제 검색 순위와
          다를 수 있습니다.
        </p>
        {data.market.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="p-2">앱·대상</th>
                  <th>국가</th>
                  <th>관측</th>
                  <th>기준일</th>
                </tr>
              </thead>
              <tbody>
                {data.market.map((row) => {
                  const value = row.value as Record<string, unknown>;
                  return (
                    <tr className="border-b border-neutral-100" key={row.id}>
                      <td className="p-2">
                        <a href={row.sourceUrl} className="text-blue-700">
                          {names.get(row.appId)} · {row.target}
                        </a>
                      </td>
                      <td>{row.country.toUpperCase()}</td>
                      <td>
                        {row.kind === "keyword"
                          ? value.rank == null
                            ? "200위 밖"
                            : `${value.rank}위`
                          : row.kind === "support-link"
                            ? "HTTP " + value.status
                            : row.kind === "android-vitals"
                              ? "안정성 · 버전·국가·테스터 구분 수집"
                              : row.kind === "rating"
                                ? `${value.averageRating ?? "미상"}점 · ${value.ratingCount ?? "미상"}개`
                                : `${value.name ?? "경쟁 앱"} · ${value.version ?? "버전 미상"}`}
                      </td>
                      <td>{dbDay(row.day)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">앱 설정에서 검색어·국가·경쟁 앱을 지정하세요.</p>
        )}
      </section>
      {vitals.length > 0 && (
        <section className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 font-semibold">Android 안정성</h2>
          <p className="mb-3 text-xs text-neutral-500">
            Play 공식 백분율 · LA 기준일 · 사용자 수는 공급자가 반올림한 분모이며 합산하지 않습니다.
            자료 없음은 장애 없음의 증거가 아닙니다.
          </p>
          {vitals.map((item) => {
            const rows = vitalsPresentation(item.value);
            return (
              <div key={item.id} className="mb-4">
                <h3 className="mb-2 text-sm font-medium">{names.get(item.appId)}</h3>
                {rows.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[600px] text-left text-sm">
                      <thead>
                        <tr className="border-b">
                          <th>기준일</th>
                          <th>버전·국가</th>
                          <th>사용자</th>
                          <th>지표</th>
                          <th>비율</th>
                          <th>분모</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 50).map((row, i) => (
                          <tr key={i} className="border-b border-neutral-100">
                            <td className="py-2">{row.date}</td>
                            <td>
                              {row.version} · {row.country}
                            </td>
                            <td>{row.cohort}</td>
                            <td>{row.kind}</td>
                            <td>{row.rate === null ? "미상" : row.rate + "%"}</td>
                            <td>{row.users === null ? "미상" : row.users + "명"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-neutral-500">
                    표시할 안정성 관측 없음 · 권한·사용자 표본·수집 상태 확인 필요
                  </p>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
