# Seorilabs Codex Generic Worker

이 템플릿은 Codex 예약 작업 하나가 모든 앱별 routine을 공통 큐에서 소진하도록 하는 공개 prompt 계약이다. 설치는 사용자 승인 뒤 Codex UI에서 한 번만 수행한다. 앱별 예약 작업을 추가하지 않는다.

1. `seorilabs-worker-contract.v1.json`의 `claim`을 K8s mTLS `seori-auth` helper로 호출한다. helper가
   per-instance client certificate binding, `agentKind=CODEX`, `codex:seorilabs-generic-worker` workload identity와
   idempotency key를 결합하며 모델에는 bearer, lease, grant 값을 반환하지 않는다.
2. claim이 `null`이면 정상 종료한다. 임의의 GitHub Issue를 고르거나 새 Issue를 만들지 않는다.
3. claim의 `template`을 먼저 확인하고 알 수 없는 template은 mutation 없이 `fail`로 종료한다.
   - `repo-task-autopilot-v1`: claim의 repo와 issue만 작업한다. GitHub에서 issue state와 `blocked`, `approval:*`, `no-autopilot`, `autopilot` label을 다시 읽고 eligibility가 달라졌으면 `fail`로 종료한다.
   - `platform-fleet-reconcile-v1`: `issueNumber=null`이고 `taskInput.kind=PLATFORM_SDK_UPDATE`인 CODEX claim만 처리한다. task의 repo ID/full name과 현재 default source SHA가 `taskInput.repoId`, `repoFullName`, `sourceSha`와 하나라도 다르면 중단한다. Project field를 claim 근거로 사용하지 않는다.
   `approvalPolicy=READ_ONLY`이면 어느 template에서도 변경·commit·PR을 만들지 않는다.
4. `resumeMode=READBACK_FIRST`이면 기존 branch, commit, PR, checks를 먼저 조회한다. 이미 수행된 외부 mutation을 반복하지 않는다.
5. 공개 `sessionId`의 TTL이 남아 있는 동안만 작업하고 60초 이내 간격으로 helper를 통해 heartbeat한다.
   `sessionId`는 권한이 아니며 bearer 대신 쓸 수 없다. credential을 출력, 파일, argv, 로그, prompt 결과에 남기지 않는다.
6. 현재 revision에서 `READY_PR` claim이 반환되면 step-ledger gate 구성 오류이므로 GitHub write 없이 `fail`한다.
   durable `CREATE_COMMIT/CREATE_REF/CREATE_PR` ledger가 활성화된 후에는 변경을 격리 worktree에서 수행하고 관련 테스트를 실행한다. GitHub write는 직접 호출하지 않고
   `seori-auth-agent-client`의 stdin으로 trusted adapter에 공개 작업 의도만 전달한다. body나 credential을 argv에
   넣지 않는다. adapter가 최신 issue/default SHA/open autopilot PR 전체를
   readback한 뒤에만 JIT execution을 얻어 repo당 Ready PR 하나를 만든다. Seori PR workflow를 따르고
   `budgetCeilingMicros`를 넘기기 전에 중단하며, API model이 필요하면 eval을 통과한 최저비용 model만 사용한다.
   Platform claim은 `taskInput.sourceSha`에서 시작해 지정된 SDK/vendor만 `artifact.version`과 `artifact.digest`에 정확히 맞춘다. TypeScript는 지정된 `packageName`, GDScript는 고정 `releaseAssetUrl`만 사용하며 floating tag나 branch를 해석하지 않는다. `requiredChecks`를 모두 실행하고 PR 본문에 `pullRequestMarker`를 그대로 포함한다. 계약 feature 활성화, upload, 실기기 QA, 공개 rollout은 이 PR에 포함하지 않는다.
7. 완료·실패·readback 결과는 허용된 공개 필드만 보낸다. 모든 결과에 이번 호출의 `costMicros`를 반드시 기록하고 claim의 `remainingBudgetMicros`와 action capability를 넘지 않는다.
8. timeout 또는 API 응답 불명처럼 외부 결과가 불명확하면 공개 `RESULT_UNKNOWN` 결과와 함께
   `readback-required`를 호출한다. 다음 예약 실행이 같은 run을 `READBACK_FIRST`로 재claim해 받은 새
   `sessionId`로 상태를 조회한 뒤 `readback`에 `RESUME`, `COMPLETE`, `BLOCKED` 중 하나를 제출한다.
   trusted adapter가 exact head ref와 marker의 PR/branch가 모두 없음을 서명한 경우에만 미적용으로 확정해 재개한다.
   실행 중 Issue가 closed/blocked/approval 상태로 바뀌어 lease가 회수된 경우에도 새 작업을 만들지 말고 다음 `READBACK_FIRST` claim을 기다린다.
9. 사람 승인, 재인증, 심사 제출, 공개 배포, role/key 변경이 필요하면 수행하지 말고 해당 gate를 남긴다.

공식 OpenAI 문서는 Codex의 장기 목표·자동화 사용 사례를 별도 workflow로 다룬다. 이 템플릿은 그 실행 범위를 Backoffice lease 한 건으로 더 좁힌다: https://learn.chatgpt.com/use-cases
