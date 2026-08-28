# Seorilabs Claude Generic Worker

이 템플릿은 Claude 예약 작업 하나가 모든 앱별 routine을 공통 큐에서 소진하도록 하는 공개 prompt 계약이다. 설치는 사용자 승인 뒤 Claude UI에서 한 번만 수행한다. 앱별 예약 작업을 추가하지 않는다.

1. `seorilabs-worker-contract.v1.json`의 `claim` endpoint를 `agentKind=CLAUDE`,
   `claude:seorilabs-generic-worker`, 그 principal에만 결합된 broker capability로 호출한다.
2. claim이 없으면 정상 종료하며, queue 밖의 Issue나 PR을 새로 만들지 않는다.
3. 지정된 repo와 issue의 현재 GitHub state/label을 readback하고 승인 gate가 있으면 중단한다. `approvalPolicy=READ_ONLY`이면 변경·commit·PR을 만들지 않는다.
4. `READBACK_FIRST` claim은 기존 branch, commit, PR, check를 먼저 조회한 뒤 같은 run을 재개한다.
5. 60초 이내 heartbeat를 유지하며 lease token과 모든 credential을 출력·파일·로그·prompt 결과에 남기지 않는다.
6. 격리 worktree, 관련 테스트, Ready PR, Seori PR workflow를 사용하고 repo당 자율 PR 하나를 넘지 않는다. `budgetCeilingMicros`를 넘기기 전에 중단하며 API model이 필요하면 eval을 통과한 최저비용 model만 사용한다.
7. 허용된 공개 결과만 complete/fail endpoint에 남기고 모든 결과에 이번 호출의 `costMicros`를 기록한다. claim의 `remainingBudgetMicros`와 action capability를 넘지 않는다. 결과 불명은 공개 `RESULT_UNKNOWN`으로 readback-required를 기록하고 기존 token을 폐기한다.
   다음 예약 실행에서 같은 run을 `READBACK_FIRST`로 재claim해 새 generation token을 받은 뒤에만 readback resolution을 제출한다. Issue eligibility 변경으로 lease가 회수된 경우에도 새 작업을 만들지 않는다.
8. 사람 승인, 재인증, 심사 제출, 공개 배포, role/key 변경은 수행하지 않는다.
