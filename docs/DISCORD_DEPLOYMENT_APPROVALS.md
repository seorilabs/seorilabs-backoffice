# 플랫폼 배포 승인

`seorilabs/platform`의 `production`, `staging` 환경 승인만 다룬다. Presence Edge도 포함하며 Issue 승인·SDK·마켓 제출과 독립된 경로다.

## 초기 상태와 운영 적용

- 조회·알림은 기본 활성, `PLATFORM_APPROVAL_MONITOR_ENABLED=false`로 중단한다.
- 직접 처리는 기본 비활성이다. `PLATFORM_DISCORD_APPROVAL_ENVIRONMENTS`가 비어 있으면 GitHub 링크만 사용할 수 있다. 운영 승인 후 web·알림 worker·operator worker에 동일한 값 `staging`을 설정하고, staging 검증 뒤에만 `staging,production`으로 넓힌다.
- 현재 Backoffice main push는 운영 배포를 자동 실행한다. 코드 병합만 하고 배포를 보류하려면 기존 배포 정책을 먼저 명시적으로 결정해야 한다. 이 변경은 배포 workflow를 바꾸지 않는다.
- Prisma 확장 migration을 먼저 적용해야 한다. 기존 중앙 설정/ConfigRevision payload를 직접 변경하거나 환경 보호 규칙을 수정하지 않는다.
- 플랫폼 workflow의 `approval-target` job은 비밀값 없이 실행 ID·재실행 번호·소스 SHA·이미지 SHA·환경·이미지·배포 대상을 artifact로 발행한다. staging은 소스 SHA와 `inputs.image_sha`가 다를 수 있다. 누락·만료·불일치 artifact는 직접 처리 차단이며 GitHub 수동 처리는 가능하다.

## 개인 인증과 계정 연결

1. `seorilabs-credentials` 절차로 local catalog를 먼저 확인한다. 이미 등록된 인증이 동일 사용자·저장소·목적에 맞으면 재사용한다. 새 토큰 생성·조직 승인은 사람이 수행한다.
2. fine-grained PAT의 repository selection은 `seorilabs/platform` 하나, 권한은 Actions read, Contents read, Deployments write다. 토큰 소유자 `/user` ID를 반드시 확인한다. classic PAT와 GitHub App installation token으로 승인을 대체하지 않는다.
3. 등록된 catalog logical ID와 공개 GitHub ID를 운영 기록에 연결한다. 토큰 실행 복제본은 **operator-command-worker만** 읽는 디렉터리에 `<GitHub 숫자 ID>.token` 파일로 읽기 전용 mount하고 `PLATFORM_APPROVER_TOKEN_DIRECTORY`를 지정한다. web/알림 worker에는 개인 토큰을 제공하지 않는다. DB·Discord·브라우저 저장소·로그에 토큰을 넣지 않는다.
4. 로그인한 승인자는 `/approvals`에서 일회용 코드를 발급받고 10분 안에 Discord `#backoffice`에서 `/connect code:…`를 실행한다. 코드는 SHA-256 해시만 저장한다. GitHub ID와 Discord ID는 각각 유일하며, 다른 계정으로 변경하려면 기존 연결을 먼저 해제한다.
5. 연결·해제와 실행 요청·거절 사유는 audit log에 남는다. Discord 역할과 Backoffice 접근 허용, 개인 PAT identity 및 GitHub `current_user_can_approve`를 실행 직전 다시 확인한다. 원 실행자와 재실행자는 자기 승인할 수 없다.

## 처리와 복구

- 버튼은 ephemeral 최종 확인을 띄운다. 거절은 사유를 받은 뒤 확인한다. 같은 Discord 사용자만 10분 안에 실행할 수 있다.
- `OperatorCommandRun`이 처리하고 `DeploymentApproval`의 요청 단위 CAS가 외부 전송을 한 번으로 제한한다. 요청 키는 repository/run ID/run attempt/environment ID다.
- GitHub POST retry와 throttling retry는 비활성이다. 전송 직전 `SENDING`을 기록하고 성공 응답 또는 GitHub review history의 명령 ID·환경·사용자·결정 일치로만 `CONFIRMED`를 만든다.
- timeout·worker 중단은 `UNKNOWN`으로 남겨 자동 재전송을 막는다. recovery worker가 GitHub 이력을 다시 조회한다. 결과 미확정은 #ops-alerts와 카드에 표시한다. 운영자가 DB를 IDLE로 돌려 재전송하지 않는다.
- GitHub API는 review 요청에 SHA/attempt 조건부 쓰기를 지원하지 않는다. 실행 직전 readback과 작업 결합으로 변경을 차단하지만 readback과 POST 사이의 공급자 측 경쟁을 원자적으로 잠글 수는 없다. 실제 활성화 전 재실행 경쟁 시나리오를 staging에서 검증해야 한다.
- 승인과 배포 결과는 별도다. GitHub 관측 상태가 진행 중이면 배포 진행 중, run conclusion이 확인돼야 성공·실패로 표시한다. 외부에서 처리돼 pending 목록이 비어도 Discord 승인 완료로 기록하지 않는다.
- 최초 성공 발송 30분 후, 이후 성공 재알림 기준 2시간 간격이다. KST 22:00~09:00에는 최초 요청만 발송한다. 미발송 재알림이 있으면 추가 enqueue하지 않고 09시 이후 한 번으로 합친다.
- webhook 조회와 60초 worker reconcile을 병행한다. 관측 실패는 기존 상태를 지우지 않으며 #ops-alerts에 알린다. Discord 전송 실패는 기존 outbox backoff를 사용하고 dead letter도 다음 재시도 시각 이후 복구한다.

## 운영 인수 검증 — 코드 검증과 별도

staging에서 실제 Discord 역할/PAT 권한 차단, 계정 연결·해제, 자기 승인 차단, 정상 승인·거절, 10분 만료, 재실행/대상 변경, timeout/worker 재시작, 외부 GitHub 처리, 야간 재알림과 09시 복구를 확인한다. 대기 발생에서 최초 Discord 발송까지 2분 이내, 요청당 GitHub 처리 1회, 처리 후 재알림 중단을 계측한다. 실제 Discord·GitHub 검증 전 production 직접 처리를 활성화하지 않는다.

## 화면

`/approvals`는 기존 Issue 승인과 별도 구역에서 환경·workflow·run/attempt·소스 SHA·관측 시각·조회 오류를 보여 준다. 핵심 행동은 GitHub 상세 확인이고 계정 연결은 보조 행동이다. 기존 화면 스타일을 따른다. 로컬 폐기용 DB와 테스트 세션으로 390px/1280px 화면, 큰 글자 가로 넘침, 연결 코드 발급·해제를 검증했다. 실제 Discord·운영 로그인 연동은 운영 적용 전 별도 검증한다.

## 재현 가능한 로컬 검증

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm build:scripts`
- `bash scripts/check-migration-safety.sh`
- 폐기용 `127.0.0.1` MySQL의 `approval_test` DB에 `prisma migrate deploy` 후 `DATABASE_URL=... pnpm exec tsx scripts/test-deployment-approvals.ts`. 이 스크립트는 다른 호스트/DB 이름을 거부한다.
- 추가 단위 테스트: `pnpm exec tsx --test src/lib/deployment-approvals/*.test.ts`

주기적 GitHub 조회는 GitHub App 인증이 있는 operator command worker의 독립 반복문에서 60초마다 실행한다. 알림 worker에는 GitHub 자격증명을 제공하지 않으며, 발송 대기열과 카드 전송만 맡긴다. 명령 처리 중에도 조회 반복문은 계속 실행된다.
