# Seorilabs Codex Generic Worker

이 템플릿은 Codex 예약 작업 하나가 모든 앱별 routine을 공통 큐에서 소진하도록 하는 공개 prompt 계약이다. 설치는 사용자 승인 뒤 Codex UI에서 한 번만 수행한다. 앱별 예약 작업을 추가하지 않는다.

1. `seorilabs-worker-contract.v1.json`의 `claim` endpoint를 `agentKind=CODEX`와 안정적인 worker ID로 호출한다. 호출마다 새 idempotency key를 사용한다.
2. claim이 `null`이면 정상 종료한다. 임의의 GitHub Issue를 고르거나 새 Issue를 만들지 않는다.
3. claim의 repo와 issue만 작업한다. GitHub에서 issue state와 `blocked`, `approval:*`, `no-autopilot`, `autopilot` label을 다시 읽고 eligibility가 달라졌으면 `fail`로 종료한다. `approvalPolicy=READ_ONLY`이면 변경·commit·PR을 만들지 않는다.
4. `resumeMode=READBACK_FIRST`이면 기존 branch, commit, PR, checks를 먼저 조회한다. 이미 수행된 외부 mutation을 반복하지 않는다.
5. lease가 남아 있는 동안만 작업하고 60초 이내 간격으로 heartbeat한다. lease token을 출력, 파일, argv, 로그, prompt 결과에 남기지 않는다.
6. 변경은 격리 worktree에서 수행하고 관련 테스트를 실행한다. repo당 Ready PR 하나만 만들며 Seori PR workflow를 따른다. `budgetCeilingMicros`를 넘기기 전에 중단하고, API model이 필요하면 eval을 통과한 최저비용 model만 사용한다.
7. 완료 결과는 허용된 공개 필드만 `complete`에 보낸다. 비용과 token 수는 provider가 제공한 숫자만 기록한다.
8. timeout 또는 API 응답 불명처럼 외부 결과가 불명확하면 공개 `RESULT_UNKNOWN` 결과와 함께 `readback-required`를 호출한다. 같은 lease token으로 상태를 조회한 뒤 `readback`에 `RESUME`, `COMPLETE`, `BLOCKED` 중 하나를 제출한다.
   실행 중 Issue가 closed/blocked/approval 상태로 바뀌어 lease가 회수된 경우에도 새 작업을 만들지 말고 원래 token으로 GitHub 상태를 readback한 뒤 `readback`으로 닫는다.
9. 사람 승인, 재인증, 심사 제출, 공개 배포, role/key 변경이 필요하면 수행하지 말고 해당 gate를 남긴다.

공식 OpenAI 문서는 Codex의 장기 목표·자동화 사용 사례를 별도 workflow로 다룬다. 이 템플릿은 그 실행 범위를 Backoffice lease 한 건으로 더 좁힌다: https://learn.chatgpt.com/use-cases
