# Fleet automation 설치·운영 계약

## 현재 제공되는 것

- Backoffice routine template: 앱 Fleet 화면에서 Codex/Claude, 수동·매시간·매일 cadence, 1회 예산 상한, `READY_PR`/`READ_ONLY` 승인 정책을 선택한다.
- durable scheduler endpoint: `/api/admin/automation/schedule`이 누락 schedule, webhook inbox, 만료 lease를 재조정한다.
- generic worker contract: Codex와 Claude 각각 조직당 설치 상한 1개다.
- Project projector: `Priority`, `App`, `Kind`, `Lifecycle`, `Agent`, `Approval`, `Outcome`을 desired/observed ledger로 분리하고 write 뒤 readback한다.

## 설치 gate

이 디렉터리의 CronJob은 `suspend: true`인 비활성 템플릿이며 실제 배포 manifest에 포함되지 않는다. 다음을 확인한 뒤 사용자 승인으로만 활성화한다.

1. migration이 운영 DB에 적용되고 Backoffice 새 revision이 배포됐다.
2. `INTERNAL_ADMIN_TOKEN`, `AGENT_WORKER_TOKEN`, `AGENT_LEASE_SIGNING_KEY`가 기존 broker 경계로 공급된다.
3. Codex와 Claude generic worker가 각각 0개 또는 1개인지 확인한다. 이미 있으면 새로 만들지 않고 업데이트한다.
4. GitHub App의 기존 권한으로 Fleet Project read/write가 가능한지 확인한다. 권한이 없으면 확대하지 않고 projection을 `READBACK_REQUIRED`로 둔다.
   관리 앱의 `projectV2Id`는 승인된 단일 `Seorilabs Fleet` Project node ID와 모두 일치해야 하며 projector는 Project나 field/option을 생성하지 않는다.
5. canary 앱에서 claim 경쟁, TTL 재claim, 결과 불명 readback, repo PR guard를 검증한다.

`docs/automation/automation-scheduler-cronjob.yaml`을 활성화하거나 Codex/Claude 예약 작업을 실제 생성하는 행위는 이 구현에 포함하지 않는다.
