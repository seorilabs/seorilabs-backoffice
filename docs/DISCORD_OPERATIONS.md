# Discord 운영 명령과 채널

명령의 정본은 `src/lib/discord/command-definitions.ts`다. `/help`는 같은 정의에서 전체 명령·입력·예시를 보여 준다. 명령 시작은 **운영명령**에서만 허용한다. 기존 카드의 버튼은 카드가 놓인 허용 채널에서 계속 처리한다. 기존 작업 operation·카드 ID·실행자 확인·만료·승인 절차를 보존한다. 워커 시작은 명령을 등록하지 않는다. 명령 교체는 명시적인 등록 도구만 수행한다. Discord 캐시와 원본 명령 복구를 위해 알려진 기존 단일 명령 이름도 같은 정의로 해석하며 새 목록에는 등록하지 않는다.

| 명령 | 하위 명령 |
| --- | --- |
| `/help` | 명령·채널·예시 |
| `/account` | `connect` |
| `/app` | `status`, `metrics`, `report`, `reviews`, `keywords`, `health`, `insights` |
| `/issue` | `create`, `plan`, `bug`, `approvals`, `urgent` |
| `/release` | `create`, `deploy`, `snapshot` |
| `/note` | `save`, `index` |
| `/chat` | `ask`, `reset` |

`/issue create app:happy-farm`으로 일반 요청을 입력한다. 대상 앱·저장소와 제목·본문을 검토한 뒤 **수정·이슈 등록·취소**를 사용한다. 기획 또는 버그 작성 역할과 연결된 GitHub 계정의 앱 쓰기 권한이 필요하다. 연결은 웹 승인 화면에서 코드를 발급받아 `/account connect`로 처리한다. 이슈 등록이 코드 구현이나 제품 배포를 시작하지 않는다.

| 카테고리 | 기존 내부 이름 → 표시 이름·순서 | 용도·대표 예시 |
| --- | --- | --- |
| 운영·분석 | backoffice → 운영명령 | 운영 명령·초안 검토. `/help`, `/issue create app:happy-farm` |
| 운영·분석 | ops-alerts → 장애알림 | 장애·확인·담당 지정. 장애 카드의 확인 버튼 |
| 운영·분석 | app-ops → 일일보고 | 일일·재무 보고와 활성 사용자 급증. `/app report`는 운영명령에서 사용 |
| 운영·분석 | metrics-daily → 수집시장정보 | 지표 수집·시장 관측. `/app health`, `/app keywords`는 운영명령에서 사용 |
| 운영·분석 | private-feed → 개인피드 | 개인 피드 구독 결과 열람 |
| 앱·수익 | action-events → 앱운영이벤트 | 가입·버전 유입 등 앱 이벤트 열람 |
| 앱·수익 | iap → 결제알림 | 지급 확정·실패·앱별 일 결제 요약 |
| 앱·수익 | ad-rewards → 광고보상 | 광고 보상 지급 성공·실패 |
| 앱·수익 | user-reviews → 사용자리뷰 | 스토어 리뷰·평점. `/app reviews`는 운영명령에서 사용 |
| 개발·출시 | issues → 개발이슈 | GitHub 이슈 생성·종료 알림과 원본 링크 |
| 개발·출시 | release-ops → 출시관리 | 업로드·심사·승인·공개를 구분한 출시 카드와 기존 후속 작업 버튼 |
| 개발·출시 | github → 코드변경 | GitHub 코드·PR 변경 웹훅 알림 |
| 아카이브 | seori-review → 검토기록 | 과거 검토 기록 열람 |

내부 알림 키와 기존 채널·카테고리 ID는 유지한다. `issues` 채널의 내부 목적지 키는 `github-issues`다. 메시지·스레드·카드·웹훅·permission overwrite는 변경하지 않는다. `general`, `test`는 대상에서 제외한다. 채널을 다른 카테고리로 옮길 때 권한 동기화를 선택하지 않는다.

## 운영 적용·복구

1. 등록된 `shared/discord/backoffice-bot`의 공개 Application·Guild ID와 live identity를 확인한다. 원본 명령 목록, 채널의 ID·이름·topic·parent·position·permission overwrite를 저장한다. 관리자 세션의 계정과 대상 서버를 확인한다.
2. migration은 기존 enum 순서를 보존하고 `GENERAL_ISSUE`를 끝에 추가한다. 웹·명령 작업기와 초안을 읽는 관련 작업기를 같은 호환 이미지로 배포한다. `prisma/schema-contract-current.json`은 실제 MySQL에서 읽은 확장 스키마 지문이다.
3. `FEATURE_GENERAL_ISSUES_ENABLED`는 기본 false다. 호환 이미지 readback 뒤 `platform/backoffice-runtime-flags` ConfigMap의 같은 키를 `true`로 두고 웹·명령 작업기를 재시작한다. 두 Pod의 플래그·source SHA·imageID를 다시 확인한다. 이 ConfigMap은 일반 배포로 덮어쓰지 않는다.
4. 새 이미지의 `node /app/scripts-dist/register-discord-commands.cjs`로 dry-run을 확인하고 `--apply`로 기존 20개 명령을 위 7개 트리로 교체한다. 실제 GET 결과를 정본과 비교한다. 대기 중인 작업·기존 카드는 삭제하지 않는다.
5. 기존 Discord 관리자 세션에서 표의 이름·topic·카테고리·순서를 적용한다. 봇 권한을 추가하지 않는다. API와 실제 화면에서 ID·권한·목적지·기존 메시지와 새 알림을 대조한다.
6. 운영 조회·비민감 일반 초안 생성·수정·취소를 확인한다. 제품 릴리스·마켓 배포 명령은 실행하지 않는다. 격리 검수의 가짜 GitHub 등록을 실제 운영 등록으로 보고하지 않는다.

장애 시 ConfigMap의 기능 플래그를 false로 두고 웹·명령 작업기를 재시작한다. 저장한 명령·채널 구성을 복원하되 확장 스키마와 초안은 보존한다. `GENERAL_ISSUE`를 읽을 수 있는 호환 이미지를 유지하며 enum을 축소하지 않는다. 결과 불명확 초안은 재전송하지 않고 **등록 결과 확인**으로 조회한다.

플래그를 꺼도 본인이 만든 기존 초안 목록·등록 결과 확인·취소는 제공한다. timeout/5xx 뒤 재조회에서 결과가 없다는 사실만으로 등록 잠금을 해제하지 않는다. GitHub 쓰기의 성패가 확인되지 않은 초안은 계속 확인 필요로 보존한다. 임의 재등록이나 시간만으로 잠금 해제를 허용하지 않는다.
