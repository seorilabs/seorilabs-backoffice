# Seorilabs Claude Generic Worker

이 템플릿은 Claude 예약 작업 하나가 모든 앱별 routine을 공통 큐에서 소진하도록 하는 공개 prompt 계약이다. 설치는 사용자 승인 뒤 Claude UI에서 한 번만 수행한다. 앱별 예약 작업을 추가하지 않는다.

1. `seorilabs-worker-contract.v1.json`의 `claim`을 worker 전용 Unix socket의 `seori-auth` helper로 호출한다. root relay가
   native peer UID/GID/PID, per-instance client certificate binding, `agentKind=CLAUDE`, `claude:seorilabs-generic-worker` workload identity와
   idempotency key를 결합하며 모델에는 bearer, lease, grant 값을 반환하지 않는다.
2. claim이 없으면 정상 종료하며, queue 밖의 Issue나 PR을 새로 만들지 않는다.
3. `template=repo-task-autopilot-v1`과 지정된 repo/issue만 처리한다. 현재 GitHub state/label을 readback하고 승인 gate가 있으면 중단한다. `platform-fleet-reconcile-v1`은 CODEX 전용이므로 Claude에 반환되면 구성 오류로 mutation 없이 `fail`한다. `approvalPolicy=READ_ONLY`이면 변경·commit·PR을 만들지 않는다.
4. `READBACK_FIRST` claim은 일반 `GITHUB_READY_PR`이 아니라 read-only `GITHUB_READY_PR_READBACK`만 호출한다.
   adapter가 서버의 기존 immutable ledger에서 exact commit/ref/marker를 불러와 branch와 PR을 확인하며 외부 write를 하지 않는다.
5. 공개 `sessionId`로 60초 이내 heartbeat를 유지한다. `sessionId`는 권한이 아니며 bearer 대신 쓸 수 없다.
   모든 credential은 helper 경계 밖으로 내보내지 않는다.
6. 현재 revision에서 `READY_PR` claim이 반환되면 step-ledger gate 구성 오류이므로 GitHub write 없이 `fail`한다.
   durable step ledger가 활성화된 후에는 격리 worktree, 관련 테스트와 Seori PR workflow를 사용한다. GitHub write는 직접 호출하지 않고
   `seori-auth-agent-client`의 stdin으로 공개 작업 의도만 전달하며 body나 credential을 argv에 넣지 않는다. trusted
   adapter가 최신 issue/default SHA/open autopilot PR 전체를 서명 readback한 직후 발급·소비한 JIT execution으로만
   수행한다. repo당 자율 PR 하나를 넘지 않고 `budgetCeilingMicros`를 넘기기 전에 중단한다.
7. 허용된 공개 결과만 complete/fail endpoint에 남기고 모든 결과에 이번 호출의 `costMicros`를 기록한다.
   결과 불명은 공개 `RESULT_UNKNOWN`으로 readback-required를 기록한다. 다음 예약 실행에서 같은 run을
   `READBACK_FIRST`로 재claim해 받은 새 `sessionId`로 `GITHUB_READY_PR_READBACK`을 마친 뒤에만 resolution을 제출한다.
   일부 step이 적용됐다면 전체 미적용으로 판정하지 않는다. `RESUME` 뒤 같은 execution의 확인된 step은 건너뛰고
   signed readback이 미적용으로 확인한 최초 미완료 step부터만 새 TTL로 재개하며, Issue eligibility가 바뀌어도 새 작업을 만들지 않는다.
8. 사람 승인, 재인증, 심사 제출, 공개 배포, role/key 변경은 수행하지 않는다.
