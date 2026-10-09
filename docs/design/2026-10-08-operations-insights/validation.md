# BO-OPS-20261008-v1 검증

구현 승인: 사용자 “Implement the plan.” · 실행 이슈 #442. 운영 배포 및 자격증명·권한 변경은 승인 범위 밖.

## 격리 환경

- MySQL 9.2 임시 컨테이너 backoffice-ops-qa-20261008 / localhost:33316 / backoffice_qa. 실제 데이터·운영 credential을 복제하지 않음.
- 개발 서버 localhost:3108. 별도 브라우저 root /tmp/bo-ops-browser, 프로필 seorilabs-admin. 테스트 ADMIN qa-operator, 두 QA 앱.
- 14일 지표·7일 보고서·같은 날짜 두 버전, 리뷰·수집 실패·근거 있는 인사이트 fixture. 공급자 비활성; 외부 메시지/Issue/승인 write 없음.

## 1회차 계획 — 시작 전 기록

- 목적: 통합 메뉴·종합 현황·앱 지표·피드백·수집 상태·이슈 초안 흐름.
- 기대: 주요 8개 메뉴 하나만 선택, 앱 탭 7개, 종합 현황 D1은 성숙 코호트 실제 분모 20명/복귀 6명, 미수집 0 처리 없음.
- 시나리오: 모든 주요 경로, 과거 보고서 버전, 과거 URL 연결, 인사이트 상세 근거와 수동 초안 생성까지. GitHub 등록 버튼은 외부 write이므로 실행하지 않음.
- 환경: 위 격리 DB·개발 서버, desktop 1440×1000/mobile 390×844. 실패·빈 상태 포함.
- 증거: 소유 탭의 스크린샷·DOM·콘솔/서버 오류, QA 데이터 재조회.
- 검수자: 작성 agent + 별도 independent_review agent. 독립 검수는 코드/실행 근거를 직접 읽고 재현함.
- 결과: 8개 메뉴·7개 앱 탭·13개 과거 URL·성숙 코호트 D1·모바일 메뉴 초점/넘침 검증 완료. 전체 통과 아님: 인사이트 상세 validator 오류로 초안 흐름 차단. 없는 리포트 버전 안내, 미수집 수익, 자동 실행 링크, 앱 지표 이동 링크, 운영 연결 안내를 보완함.
- 첫 실패와 DOM/스크린샷은 격리 브라우저 6042ce10f8d24e9b887e1adb9ad718ee 세션 및 /tmp/bo-ops-review-round1-* 자료에 보존. 종료 후 세션 반납.

## 2회차 계획 — 시작 전 기록

- 목적: 1회차 결함 수정 확인과 피드백 → 근거 → 수동 이슈 초안, 자동 실행 관리·안정성 관측의 실제 사용성.
- 환경: 동일 격리 DB·localhost:3108·운영 credential 없음. 기준 지표 2026-10-07을 고정; 검수 중 KST 날짜 변경과 실제 D-1을 분리. 시장 데이터는 QA fixture임.
- 기대: 인사이트 상세 200, 근거·분석 역할 표시, 초안 생성 후 앱 개발 화면으로 이동; 반복 열기는 같은 초안 사용. AI 공급자 비활성에도 기존 초안 수정 가능. GitHub 전송은 실행하지 않음.
- 기대: v1 badge·선택 표시, 없는 v999는 버전 없음; 콘솔 미수집을 0원으로 표현하지 않음; 자동 실행 링크가 실제 관리 화면으로 연결; 앱 비교 행에서 지표로 이동.
- 기대: Android 안정성은 공개 OS/테스터·버전·국가·실제 공급자 기준일·0.03%/100명 표시, 없는 비율은 미상.
- 범위: desktop 1440×1000/mobile 390×844, 주요 8개 경로·앱 7개 탭·과거 URL 회귀·빈/설정 필요/실패 상태. 모바일 메뉴·큰 글자·키보드·폼 및 오류 문구.
- 증거: 스크린샷·DOM·browser/server 오류, 생성한 초안 수 재조회. 검수자는 independent_review agent이며 코드 변경·외부 write 없음.
- 결과: 전체 통과 아님. 8개 메뉴·앱 7개 탭·13개 과거 URL·보고서 버전·미수집·안정성 관측·초안 재사용은 통과. 초안 0→1, DRAFT·claimedAt null 확인. 모바일에서 실제 키보드 입력 후 Tab 이동 시 본문이 기존 값으로 돌아오는 결함과 입력 접근성 이름 누락 발견. 첫 실패를 재시도하지 않고 보존했으며, React 초기화 전 입력을 비활성화하고 이름을 추가함.
- 증거: `/tmp/bo-ops-review-round2-summary.json`, `/tmp/bo-ops-review-round2-first-failure-context.json`, 세션 `6f3f785c655c41a495c80240ff4f03d0`의 42개 화면. 세션 반납 완료. 소프트웨어 키보드는 실제 기기 검증이 아니라 Chrome 입력과 높이 500px로 확인함.

## 3회차 계획 — 시작 전 기록

- 목적: 고정 후보에서 모바일 초안 입력 보존과 입력 이름, 실제 빈 날짜를 확인하고 전체 핵심 흐름을 회귀 검수함.
- 환경: 동일 격리 DB·localhost:3108·공급자 비활성. 고정 지표 2026-10-07, QA 소유의 2026-10-01 지표·수집 원장·보고서만 제거해 범위 안 미수집 날짜를 만듦. 운영 데이터 변경 없음.
- 기대: 새 SSR 진입 후 초기화된 이름 있는 textarea에 실제 키보드로 문구 입력 → Tab 이동해도 문구 유지. 제목도 같은 방식으로 확인. 모바일 390×844·가용 높이 500px·200% 글자에서 입력과 버튼 사용 가능.
- 기대: 2026-10-01 미수집은 0 사용자/0원으로 단정하지 않고 빈 상태로 표시, 추이는 선을 끊음. 2026-10-07의 D1 30%·분모 20명/복귀 6명, 보고서 v1/v999, Vitals 0.03%/100명·테스터 미상은 유지.
- 범위: 주요 8개 메뉴·앱 7개 탭·과거 URL·설정/수집 실패/빈 상태, 인사이트 → 같은 로컬 초안, 모바일 메뉴 초점·Escape·복귀, desktop 및 모바일 화면·콘솔·서버 오류. 외부 Issue 등록·Discord 전송 없음.
- 검수자: independent_review agent. 제품 코드 변경 없이 첫 실패 증거를 보존하며 회차 안 반복 수정은 하지 않음.
- 결과: PASS. 제품 후보 `4f98b0123b29ca0f4bd09a40251522cd9b7570de`의 8개 메뉴·앱 7개 탭·13개 URL·보고서 버전·빈 날짜·성숙 D1·인사이트와 같은 초안·모바일 입력/메뉴/200% 글자·Vitals 표 스크롤 통과. DB 초안 1→1, 동일 DRAFT·claimedAt null. 독립 검수자가 코드 변경 없이 확인하고 세션을 반납함.
- pageerror·페이지 HTTP500 없음. 격리 환경 GA4 미설정에 따른 realtime API503 및 GitHub App 미설정 안내는 원문 보존. hidden input style hydration 경고는 Playwright screenshot 기본 caret 숨김이 DOM style을 변경하는 설치 코드에서 원인 확인; 이후 촬영은 `caret=initial` 사용함. 공급자가 정상 동작했다는 증거로 집계하지 않음.
- 기존 개발 화면의 용어 한 곳은 검수 종료 후 “개발·출시 단계 변경 이력”으로 바꿈. 동작·상태·데이터 변경 없음. 빌드 직전 E2E에서 해당 표시와 기존 흐름을 함께 확인할 예정임.
- [독립 검수 요약](evidence/round3-summary.json), [첫 키보드 입력](evidence/round3-keyboard-first.json), [200% 입력](evidence/round3-large-text.json), [종합 현황](evidence/home.png), [Vitals](evidence/vitals.png). 전체 41개 화면과 회차별 첫 실패는 로컬 `Workspace/artifacts/backoffice/operations-insights-20261009`에 보존함.

## 빌드 직전 E2E 계획 — 시작 전 기록

- 최종 commit의 제품 코드와 문서 후보를 고정한 뒤 localhost:3108에서 작성자가 별도 소유 탭으로 실행함. 앞의 3회 UI 검수 뒤 코드 동작을 수정하거나 추가 디버깅 회차를 만들지 않음.
- 주요 8개 경로·앱 7개 탭·수집 상태/자동 실행, 지표 152명·D1 30%·미수집, 빈 날짜·없는 버전, 인사이트→기존 초안, 쉬운 한국어 표시, 모바일 실제 키보드 입력 유지·메뉴 Escape/초점 복귀·가로 넘침을 확인함.
- 같은 source에서 격리 DB 서비스 acceptance를 실행하고 dev 서버를 종료한 다음 더미 DATABASE_URL로 production build함. 정확한 candidate SHA·명령·결과는 PR에 기록함. 실제 운영/마켓 외부 write 없음.


## 서비스 검증

- RED→GREEN: GitHub 자기 승인 허용 정책, Play 빈 HTTP 응답/빈 트랙, Discord PNG 생성·동일 봇 편집.
- 격리 DB: 신호 중복 occurrence 방지, API lease generic 회수 제외/전용 만료 처리, 입력 근거 fallback, Discord 최초 전송과 분석 완료 경합, 동시 호출 2개, 하루 상한, 공식 공개 근거 상태 구분 통과.
- 최종 schema로 최초 빈 DB 및 legacy cutover 전체 39개 migration·데이터 보존·99개 테이블 계약·운영 acceptance 통과. 실제 운영 migration은 실행하지 않음.
- 단위 테스트 1,754개, typecheck, lint, worker bundle 통과. lint에는 기존 release-tag-ledger 테스트의 미사용 변수 경고 1개가 남음.
- ARM64 Linux Node 24.16의 target-native sharp PNG 생성 통과. 일간·주간 차트는 실제 QA 관측으로 렌더해 확인: [주간 PNG](evidence/weekly-operations.png). Discord 실제 업로드는 운영 적용 gate로 남음.
- 신규 실행기 YAML·동일 digest 렌더링·replicas 0/suspend true 검증, 명령 등록 dry-run 20개 통과. 프로덕션 명령 등록·worker 활성화 없음.
- GitHub Wiki 기능은 enabled지만 wiki.git 조회가 Repository not found로 실패해 초기화되지 않은 것으로 관측함. 설계 목록은 [저장소 목록](../README.md)을 정본으로 제공하고 Obsidian inbox에는 정본 링크만 기록함.

## 운영 키워드 수집 응답 상한 수정 — 2026-10-09

- 사용자 배포·마이그레이션·활성화 요청과 일괄 승인에 따라 운영 readback 중 발견한 기존 범위의 결함을 수정함. 검색 순위 200위 범위·국가·데이터 모델·화면은 그대로 유지함.
- 한국 검색 `farm tycoon`, `3매치`, `매치3 퍼즐`, `match 3`은 HTTP 200과 유효한 196–199개 결과를 반환했으나, 응답 2,119,177–2,130,980바이트가 공통 2MiB 상한을 넘어서 모두 실패함. 공식 [Apple Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html)는 검색 결과 최대 200개를 지원함.
- 검색 응답만 8MiB까지 허용함. lookup·공식 피드의 기존 제한, 검색 결과 200개 제한, timeout·재시도·요청 간격은 유지함. 검색 범위를 줄여 정상 순위를 누락하거나 무제한 응답을 허용하지 않음.
- TDD: 설명을 포함한 200개·2MiB 초과 응답을 끝 순위까지 수집하는 테스트가 `SOURCE_RESPONSE_TOO_LARGE`로 실패한 뒤 통과함. 8MiB 초과·201개 검색 결과·2MiB 초과 lookup 거부도 확인함. 근거는 `Workspace/artifacts/backoffice/production-activation-20261009/apple-search-size-{red,green}.log`와 `apple-keyword-failure-diagnostic.json`에 보존함.
- UI·스키마·운영 설정 변경 없음. 기존 독립 UI 검수 범위를 재사용하고 새 후보 SHA에서 전체 개발 환경 E2E를 빌드 직전·배포 직전에 각각 다시 실행함. 정확한 SHA·CI·이미지·운영 재수집 결과는 PR과 같은 증거 폴더에 추가함.
