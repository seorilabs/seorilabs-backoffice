# 통합 지표 연결과 일간 보고 운영

설계·승인과 L3 테스트 계획은 [승인 설계](design/2026-10-18-unified-daily-metrics/design.md)에 있다. 자료가 없는 소스는 성과 0으로 표시하지 않는다.

## 연결

앱 통합 관리의 **지표 보고 소스**에서 계정·앱 공개 식별자·원천 시간대와 기존 credential logical ID를 입력한다. 기존 중앙 설정의 초안→검증→활성화 서비스, 앱 권한, revision 동시성 검사를 그대로 사용한다. 다른 설정을 편집해도 이 연결을 보존한다. 각 연결의 수집 사용 여부를 개별 중지할 수 있다. 비밀값은 이 화면과 DB에 저장하지 않는다.

| 소스 | 기존 자격증명 | 필요한 입력·확인 |
|---|---|---|
| App Store 분석 | `shared/apple/app-store-connect-uploader` | issuer ID, 숫자 app ID, UTC. bundle ID를 공급자에서 다시 확인한다. 최초 ONGOING·ONE_TIME_SNAPSHOT 생성에는 계정의 보고서 관리 권한이 필요하다. |
| Google Play 설치 보고 | `shared/google-play/publisher` | `pubsite_prod_rev_*` bucket, package, 원천 보고 시간대. 게시 권한과 보고서 bucket 읽기 권한은 별개다. |
| Android 품질 | `shared/google-play/publisher` | 기존 identity의 공개 client ID, package, America/Los_Angeles. 공식 앱 목록·품질 API 권한·DAILY 최신 종료일을 확인한다. |
| AdMob 네트워크 보고 | `shared/admob/reporting` | publisher·AdMob app ID, 별도 보고 OAuth 동의(`admob.report`·`admob.readonly`)와 계정 시간대. 같은 설정의 ads 식별자와 공식 앱 목록을 대조한다. iOS는 bundle과 Apple 숫자 app ID의 기존 연결도 검증한다. Play/Firebase 인증으로 대체하지 않는다. 현재 미등록이면 기존 연결을 제공받기 전까지 입력 필요다. |

Apple은 Standard 보고서만 사용하여 Detailed와 중복 합산하지 않는다. 다운로드·발견/참여·설치/삭제·세션·오류·동의·구매·구독 이벤트/상태를 지원한다. 모든 페이지와 segment를 확인하고 MD5·크기 검증을 마친 뒤 날짜 partition을 저장한다. 같은 날짜의 더 최신 processingDate는 이전 차원 행을 통째로 대체한다. 최초 자료 생성 대기와 개인정보 보호에 따른 빈 셀은 확인된 0이 아니다.

Play는 국가별 월간 설치 파일의 generation을 고정하고 CRC32C를 검증한다. 전체 합계 파일을 함께 합산하지 않는다. API 연결이 없는 공식 파일은 `POST /api/admin/analytics/import-play-report`로 원본 base64·SHA256·공식 gs 경로·generation·processingDate를 제공한다. 관리자 토큰과 기존 identity의 공식 파일 메타데이터 읽기 권한이 필요하며 앱/계정/패키지/월/설정/해시/generation/크기/CRC32C가 다르면 거절한다. 임의 버전 숫자는 자동 수집의 기준값을 높이지 못한다. 응답은 runId와 처리 날짜 범위다.

AdMob은 header·row·footer와 matchingRowCount·경고를 검사한다. micro 금액은 실제 통화 단위로 변환하며 응답률·표시율·eCPM은 원천 분자·분모로 계산한다. GA4 광고 수익과 더하지 않는다. 광고 소스별 mediation 보고는 네트워크 보고와 서로 다른 범위이며 네트워크 자료로 광고 소스별 수치를 만들어내지 않는다.

판매·환불·정산 파일, 광고 집행 계정, Firebase 품질·실험·메시지 내보내기는 실제 계정/자료와 필수 입력을 확인하기 전까지 연결로 표시하지 않는다. Apple 판매·정산에는 Vendor Number와 보고서 역할, Play 판매·정산에는 실제 보고 bucket·유형이 필요하다. GA4 export만으로 Crashlytics·Performance 내보내기 존재를 판단하지 않는다.

## 수집과 발행

`backoffice-extended-metrics`는 10:00 KST에 같은 배포 이미지의 전용 worker로 실행한다. 조회에 필요한 자격증명만 전달하며 Discord·GitHub mutation 토큰은 주입하지 않는다. 활성 연결의 제공되는 최근 90일 자료를 가져오고 원천 버전·해시로 재처리를 구분한다. Apple 다운로드 캐시는 모든 checksum과 인스턴스 전체 저장 완료 범위가 확인될 때 재사용한다. 실행 전체의 일부 실패나 설정 revision 변경은 성공한 인스턴스의 기록을 무효화하지 않는다. 수집 실행 API는 `/api/admin/analytics/extended-collect`이며 실행별 ID·범위·상태를 반환한다. 웹에 필요한 source credential이 없으면 원장을 쓰기 전에 `409 worker_required`로 전용 작업 실행을 안내한다. `failed` worker 실행만 실패 exit로 남고, 일부 인스턴스 실패는 `partial`로 보존하여 성공한 원본까지 작업 전체 재시도로 내려받지 않는다. `not_landed`는 원장에 기록한다. 연결마다 원천 시간대의 요청 범위를 반환한다.

10:45 준비와 11:00 발행은 별도 작업이다. 발행은 저장된 문서·PNG만 읽고 외부 수집·AI 응답을 기다리지 않는다. 부족한 입력은 수집 현황에 표시하며 변화가 없어도 발행한다. 늦은 자료는 버전과 근거를 함께 보존하고 구형 보고서는 자동 변환하지 않는다. 월요일에는 같은 발행본에 주간 관측 범위와 추이를 포함한다. 월간 비용은 기존 비용 수집의 실제 기준월과 상태로 표시하고 앱별 배분을 추정하지 않는다.

종합 보고서·Discord·CSV는 같은 발행 버전의 자료를 사용한다. 앱별 지표 화면은 최신 자료 탐색이며 발행 당시 고정 수치와 구분한다. 원천 기간·시간대·통화·대상·분모를 유지하고 고유 기기 수를 차원 사이에 합산하지 않는다. 국가·버전·유입·광고 형식은 최신 기준일의 원천 차원 행을 최대 200행 표시하고 전체 원천은 DB에 보존한다. 구독 상태·이벤트, 다운로드 종류는 별도 시계열로 유지하며 순서가 없는 행동 집계를 사용자 전환 퍼널로 만들지 않는다.

배포·전송 응답만으로 완료를 판정하지 않는다. exact SHA/digest·migration·웹 표시·CronJob·worker·Discord 메시지/첨부/고정 버전 링크와 숫자를 각각 다시 읽는다.

공급자 시간대에서 완료된 마지막 날까지만 요청하며 최근 AdMob 추정 수익도 잠정 구간을 변화 판정에서 제외한다. 원천이 확인된 분모 0은 해당 없음이고, 누락 셀과 구분하여 다른 행의 가중 비율을 계산한다. 월 비용은 기존 09:00 수집에서 보존한 snapshot과 수집 시각을 10:45에 고정한다. 전환일 첫 발행 전에 비용 작업을 한 번 수동 실행하고, 이미 지난 컷오프를 소급하지 않는다. 정정은 당시 재고정한 비용 수치도 반영하되 수집 시각만 바뀐 것은 정정하지 않는다. 입력 고정 뒤 공급자 비용을 다시 조회하지 않는다.

같은 날짜의 값·차원·완성 상태가 동일하면 파일 해시·수집일이 바뀌어도 중복 적재와 정정을 생략한다. Play generation의 high-water mark는 수집 원장에 보존하고 낮은 버전의 수동 가져오기를 거절한다. Apple의 동일 날짜 교체 근거는 [Data Completeness and Corrections](https://developer.apple.com/documentation/analytics-reports/data-completeness-corrections)이며 구독 2종과 실제 연속 원본 대조는 자료 도착 뒤 별도 확인한다.

전환 배포가 11시 이후이면 `POST /api/admin/metric-highlights?day=YYYY-MM-DD`로 전일의 미발행 여부를 확인하고 한 번 발행한다. 이미 발행된 보고서의 원래 시각을 덮지 않는다. 연결을 저장한 뒤 이전 이미지로 복구할 때에는 추가 필드를 읽는 이 버전 이상을 사용하거나 중앙 설정 서비스에서 이전 설정을 새 버전으로 활성화한 뒤 이미지 복구를 진행한다. 기존 ACTIVE revision의 payload를 직접 수정하지 않는다.

Android vitals는 오류·응답 없음의 일별 공급자 비율과 반올림 표본을 별개 지표로 보존한다. 빈 응답은 미도착이며 0을 생성하지 않는다. 공식 비율은 정확한 분자·분모가 없어 합산·자동 변화 판정·개선 이슈 근거로 사용하지 않는다. [공식 품질 보고 정의](https://developers.google.com/play/developer/reporting/reference/rest/v1beta1/vitals.crashrate/query)의 LA 달력과 최신 종료일(끝 미포함)을 지킨다.
