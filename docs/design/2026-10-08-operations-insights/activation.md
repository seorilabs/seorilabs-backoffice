# 운영 적용과 복구 — BO-OPS-20261008-v1

이 문서는 적용 절차다. 운영 배포·DB migration·신규 수집/분석 실행·Discord 명령 등록은 실행하지 않았다. 구현·PR 병합 승인과 운영 적용 승인을 구분한다. 기존 자격증명 identity와 실제 대상의 조회 결과를 승인 기록에 결합한 뒤 실행한다.

## 후보와 기존 운영 상태

1. [DEPLOY.md](../../DEPLOY.md)의 backup·격리 restore rehearsal·migration 원장 검사·CI deployer 권한 검사를 통과한다. schema contract와 이미 적용된 migration checksum이 다르면 중단한다. 운영 DB 원장을 임의 resolve하거나 기존 migration SQL을 수정하지 않는다.
2. 승인할 후보는 main의 source SHA와 `Deploy` workflow build가 기록한 immutable image digest다. main push는 검증·이미지 build만 수행한다. production 적용은 `workflow_dispatch`의 `deploy=true`로 실행하는 기존 `scripts/deploy-backoffice.sh`가 migration → exact image rollout → 실행기 일치 조회를 처리한다. 배포 직전 같은 후보의 개발 환경 E2E가 필요하다.
3. trusted operator가 namespace `platform`, 웹·notification worker·기존 collector의 현재 image digest, 새 worker/CronJob 존재 여부·활성 상태, DB backup과 복구 검증 기록을 읽어 보존한다. secret 값과 토큰을 기록하지 않는다. 기존 수집과 신규 수집의 책임이 겹치지 않는지 확인한다.

## 신규 실행기

아래 렌더링은 파일만 만든다. `approved_image`와 `approved_sha`에는 승인한 build의 값을 지정한다. 출력물의 image가 전부 동일 digest이며 신규 worker는 `replicas: 0`, 두 CronJob은 `suspend: true`인지 검토한다.

```bash
scripts/render-manifest.sh k8s/operations-insights-worker.yaml "$approved_image" "$approved_sha" > /tmp/backoffice-operations-insights.yaml
scripts/render-manifest.sh k8s/market-feedback-cronjobs.yaml "$approved_image" "$approved_sha" > /tmp/backoffice-market-feedback.yaml
```

운영 적용 승인 후 trusted operator가 두 파일을 적용한다. 신규 실행기에는 GitHub mutation credential을 주입하지 않는다. 별도 Secret/서비스 계정/유료 공급자를 만들지 않고 등록된 공용 identity를 재사용한다.

- 분석 worker: 기존 DB와 MiniMax credential만 사용한다. `INSIGHTS_WORKER_ID`는 pod 이름으로 구분한다. 동시 분석 2개·기본 KST 하루 200건 입장 제한, 8분 작업 lease, 4분 API permit이다. `INSIGHTS_DAILY_LIMIT=0`은 새 공급자 호출을 막는다. MiniMax 비활성/형식 실패 시 근거 기반 음슴체 요약을 남긴다.
- 시장 수집: 매일 KST 12:20. 앱별 활성 중앙 설정의 키워드·국가·경쟁 앱·공식 피드·지원/개인정보 링크만 조회한다. Apple 공개 검색은 API 관측 순서이며 실제 기기 검색 순위를 보장하지 않는다. 키워드 최대 30개×국가 5개는 API 간격·재시도에 따라 실행 시간이 늘므로 활성 앱 수와 1시간 Job 제한을 함께 검토한다. incomplete/failed/needs_input은 기존 좋은 관측을 지우지 않는다.
- Android 안정성: 기존 Play identity의 Android Developer Reporting 접근 권한과 package 연결을 확인한다. 접근 불가 시 `needs_input`으로 남긴다. 공개 OS/테스터·버전·국가·LA 기준일·백분율과 공급자 분모를 유지한다. 0.03은 0.03%로 표시하며 빈 비율을 0%로 만들지 않는다.
- 주간 보고: 월요일 KST 10:30, 전주 월~일. 신규 리뷰는 작성일이 아닌 최초 관측일 기준이며 수집 성공 범위를 표시한다. 누락된 날은 부분 보고다. 기존 09:00 운영 알림 및 23:50 일간 보고는 유지한다.
- notification worker가 동일 source SHA/digest로 올라왔는지 확인한다. 새 신호의 최초 사실 카드 → 분석 후 같은 Seori Bot 메시지 편집 → PNG attachment를 하나의 provider message ID로 추적한다. 초기화한 별도 notification worker를 추가로 만들지 않는다.

중앙 앱 설정은 앱 설정 화면 또는 `/api/control-plane/`의 동일 validator/service로 새 ConfigRevision을 만들고 활성화한다. DB SQL로 desired state를 수정하지 않는다. 계정·법적 선언·결제·마켓 심사/공개 승인은 기존 사람 전용 경계를 유지한다.

활성화 승인 범위에 포함된 경우 worker replica를 1로, 두 CronJob의 suspend를 false로 바꾼다. 첫 수집과 분석 완료 후 수집 상태 화면의 관측 시각·데이터 기준일·실패 코드, API 사용량, occurrence/run/lease, Discord 사실·분석·첨부와 발신자를 재조회한다. provider 접근 미확인 항목을 정상 수집으로 기록하지 않는다.

## Discord 명령

```bash
pnpm discord:register --dry-run
```

20개 명령 목록을 먼저 검토한다. 실제 등록 전 기존 catalog의 Discord application ID·guild ID·봇 공개 identity, 현재 서버 명령 목록과 interaction endpoint를 읽어 보존한다. 기존 credential을 출력하거나 회전하지 않는다. bulk PUT은 서버 명령 목록 전체를 바꾸므로 기존 15개와 신규 `/report`, `/reviews`, `/keywords`, `/health`, `/insights`가 모두 포함된 목록에 대해 승인한다.

등록 승인 후 같은 공개 application/guild 대상으로 `pnpm discord:register --apply`를 실행하고 서버 목록을 다시 읽는다. 조회 명령의 예약 응답→결과 편집, 빈 상태·권한 오류를 확인한다. 명령 복구 검수에서 실제 배포 승인·Issue 등록·마켓 제출을 자동 실행하지 않는다.

## 복구

1. 신규 두 CronJob을 suspend하고 분석 worker replica를 0으로 낮춘다. 진행 중 Job/lease를 읽어 종료 여부를 확인한다. 통신 결과가 불명확한 Discord/Issue 쓰기는 반복 전송하지 않는다. 초안은 “등록 결과 확인”으로 GitHub marker를 조회한다.
2. 이전의 검증된 immutable image로 웹과 기존 실행기를 복구하고 runtime imageID와 실제 응답을 재조회한다. 추가 테이블·nullable 필드는 유지한다. down migration이나 보고서/관측 원장 삭제를 수행하지 않는다. 새 분석 문서와 미전송 outbox는 정본으로 보존한다.
3. Discord 명령 rollback이 필요하면 보존한 기존 목록을 같은 application/guild에 등록하고 재조회한다. 코드 rollback만으로 외부 명령 목록이 되돌아간다고 판단하지 않는다.
4. 원인·수집 공백·처리된 provider message ID·복구 SHA/digest를 운영 기록에 남긴다. #156/#158의 두 번 연속 shadow parity·마켓 build-only·복구 gate 전에는 legacy parser를 제거하지 않는다.
