import { vitalsPresentation } from "@/lib/market/vitals-presentation";
import Link from "next/link";
import { feedbackOverview } from "@/lib/insights/queries";
import { dbDay } from "@/lib/analytics/metric-day";
import { kstDateTimeShort } from "@/lib/format/kst";
import { keywordMonitoring } from "@/lib/market/keyword-monitoring";
export async function FeedbackView({ appId, date }: { appId?: string; date?: string }) {
  const [data, monitoring] = await Promise.all([feedbackOverview(appId), keywordMonitoring(appId, new Date(), date)]);
  const names = new Map(data.apps.map((app) => [app.id, app.displayName]));
  const vitals = data.market.filter((row) => row.kind === "android-vitals");
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">검색 순위 모니터링</h2><Link className="text-sm text-blue-700" href={`/feedback/keywords?date=${monitoring.day}${appId ? `&app=${encodeURIComponent(appId)}` : ""}`}>순위 그래프 보기 →</Link></div>
        <p className="mb-2 text-sm">
          추적 {new Set(monitoring.rows.map((row) => row.appId)).size}개 앱 · {monitoring.rows.length}조합
          {" / "}{monitoring.day} 수집 {monitoring.collected} · 미수집·실패 {monitoring.rows.length - monitoring.collected}
        </p>
        <p className="mb-3 text-xs text-neutral-500">App Store · 한국 KR / 미국 US · 매일 21:20 KST 수집 · Apple 검색 API 최대 200개 결과 순서이며 기기 화면과 다를 수 있습니다.</p>
        <ul className="divide-y divide-neutral-100">
          {monitoring.apps.filter((app) => app.keywords.length).map((app) => {
            const rows = monitoring.rows.filter((row) => row.appId === app.id);
            const collected = rows.filter((row) => row.state === "수집됨").length;
            const latest = rows.map((row) => row.observedAt).filter((at): at is Date => Boolean(at)).sort((a, b) => b.getTime() - a.getTime())[0];
            return <li key={app.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="min-w-0 break-words">{app.displayName}</strong>
                <Link className="text-blue-700" href={`/apps/${app.id}/fleet`}>설정 보기</Link>
              </div>
              <p className="mt-1 break-words">{app.countries.map((country) => country.toUpperCase()).join(" · ")} · {app.keywords.join(", ")}</p>
              <p className="mt-1 text-xs text-neutral-500">{app.status !== "ACTIVE" ? "일시중지" : !app.iosBundle ? "iOS 앱 식별자 미설정" : `기준일 수집 ${collected}/${rows.length}조합`} · 최근 시도 {kstDateTimeShort(latest)} KST · 현재 설정 버전 {app.revision}</p>
              {rows.some((row) => row.state !== "수집됨") && <p className="mt-1 text-xs text-amber-700">{[...new Set(rows.filter((row) => row.state !== "수집됨").map((row) => row.state))].join(" · ")}</p>}
            </li>;
          })}
        </ul>
        {!monitoring.rows.length && <p className="text-sm text-neutral-500">추적 중인 검색어 없음 · 앱 통합 관리에서 국가와 검색어를 설정하세요.</p>}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-neutral-600">검색어 미설정 앱 {monitoring.apps.filter((app) => !app.keywords.length).length}개</summary>
          <ul className="mt-2 space-y-1">{monitoring.apps.filter((app) => !app.keywords.length).map((app) => <li key={app.id}><Link className="text-blue-700" href={`/apps/${app.id}/fleet`}>{app.displayName}</Link> · {app.status !== "ACTIVE" ? "일시중지" : "검색어 미설정"}</li>)}</ul>
        </details>
      </section>
      <section id="daily-search-ranks" className="scroll-mt-32 rounded-lg border border-neutral-200 bg-white p-4 md:scroll-mt-4">
        <h2 className="mb-2 font-semibold">{monitoring.day} 전체 검색 순위표</h2>
        <p className="mb-3 text-xs text-neutral-500">현재 추적 설정의 기준일 관측과 이전의 마지막 성공 수집을 비교합니다. 결과 목록 없음·수집 실패·미수집·국가별 공개 리스팅 미확인을 구분합니다. 일일 알림의 CSV는 발행 시점 기록입니다.</p>
        {monitoring.rows.length ? <div className="overflow-x-auto" role="region" aria-label="전체 검색 순위표" tabIndex={0}>
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead><tr className="border-b"><th className="p-2">앱</th><th className="p-2">국가</th><th className="p-2">검색어</th><th className="p-2">기준일 순위</th><th className="p-2">이전 수집</th><th className="p-2">변화</th><th className="p-2">수집 시각 KST</th><th className="p-2">추이</th></tr></thead>
            <tbody>{monitoring.rows.map((row) => <tr className="border-b border-neutral-100" key={`${row.appId}:${row.country}:${row.term}`}>
              <td className="p-2">{row.appName}</td><td className="p-2">{row.country.toUpperCase()}</td><td className="p-2">{row.term}</td><td className="p-2">{row.rankLabel}</td><td className="p-2">{row.previousDay ? `${row.previousRank === null ? "결과 목록에 없음" : `${row.previousRank}위`} · ${row.previousDay}` : "비교 자료 없음"}</td><td className="p-2">{row.change}</td><td className="p-2">{kstDateTimeShort(row.observedAt)}</td><td className="p-2"><Link className="text-blue-700 whitespace-nowrap" href={`/feedback/keywords?app=${encodeURIComponent(row.appId)}&country=${encodeURIComponent(row.country)}&date=${monitoring.day}&term=${encodeURIComponent(row.term)}`}>추이 보기</Link></td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="text-sm text-neutral-500">순위 추적 설정 없음</p>}
      </section>
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
        <h2 className="mb-3 font-semibold">검색 순위·평점·경쟁 앱</h2>
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
                            ? "결과 목록에 없음"
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
