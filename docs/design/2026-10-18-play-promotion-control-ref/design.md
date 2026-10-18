# Play 승격 제어 워크플로를 기본 브랜치에서 읽기

승인: 2026-10-18 KST 사용자의 “둘다 진행”. 검토한 최소 패치 SHA-256 `693ec7058afb3963e47488310c93b6c660d9f8675ab6f5151ecf8395907363af`와 동일 범위다.

## 문제와 변경

현재 promoteGooglePlay는 불변 릴리스 태그에서 승격 워크플로 입력을 읽고 그 태그로 실행한다. 13개 앱과 Bloomhand의 기본 브랜치 caller에 Actions 읽기 권한을 보완해도 과거 태그의 caller는 바뀌지 않아 중앙 승격 워크플로의 CI 근거 조회 권한을 충족하지 못한다.

흐름은 `승격 요청 → 최신 기본 브랜치의 입력 계약/워크플로 → release_tag의 불변 SHA 검증 → 기존 내부 빌드 승격`이다. 이미 쓰는 getRepoDefaultBranch로 저장소의 실제 기본 브랜치를 한 번 읽고 입력 계약과 dispatch ref에 같은 값을 사용한다. release_tag, resolveStableAuthority, expectedTag의 태그/SHA 결합, 입력 선택, 감사 기록은 유지한다. 기본 브랜치 이름을 main으로 고정하지 않는다.

화면·DB·상품·권한·태그·빌드 데이터 형식 변경은 없다. 기존 계약/권한/태그 검증 실패는 그대로 전파한다. 제어 ref와 빌드 ref를 혼합하지 않는다.

## 인수조건과 검수

- AC1: 승격의 계약 조회와 실행 ref가 모두 실제 기본 브랜치이며 과거 태그가 아니다.
- AC2: release_tag와 expectedTag의 정확한 태그·SHA는 유지하고 불일치 시 dispatch 전에 거부한다.
- AC3: 기본 브랜치가 main이 아니어도 동작하고 입력·출시노트·감사 기록은 기존 경로를 유지한다.

L1/dev. 기존 배선 회귀 검사에 AC1의 실패를 먼저 추가하고 최소 코드로 통과시킨다. 실제 dispatch 경계의 기본 브랜치·정확한 태그 결합 및 거부 시나리오는 기존 단위 검사와 실행한다. typecheck/lint/build와 저장소 CI를 확인하고 릴리스 실행 변경이므로 읽기 전용 Claude 교차 리뷰를 요청한다. 기기·마켓 실제 승격은 이 수정의 시험으로 실행하지 않는다.

## 의존성과 운영

별도 Ready PR에서 검증·리뷰·병합한다. 중앙 seorilabs/.github#271은 13개 caller 권한과 이 경로의 운영 반영을 확인한 뒤 병합한다. Backoffice 운영 배포는 기존 명시적 배포 절차와 승인 범위를 별도로 확인하며 소스 병합을 배포로 표시하지 않는다. 다른 13개 앱의 마켓 배포는 하지 않는다. 장애 시 이 커밋의 제어 ref 변경만 되돌리는 PR로 복구하며 릴리스 태그는 이동하지 않는다.

## 1차 교차 리뷰의 결과 기록 보완

리뷰에서 기본 브랜치 HEAD의 태그를 승격 대상 버전으로 잘못 기록하는 재현 경로를 확인했다. AC3의 기존 기록 보존을 충족하도록 같은 수정 범위에서 보완한다. GitHub 공식 [workflow dispatch 응답](https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event)의 `return_run_details:true`를 사용해 실제 workflow_run_id를 받는다. 정확한 태그/SHA와 실행 ID를 기존 append-only 릴리스 감사에 저장하고, workflow_run 미러가 그 결합으로 version/commitSha를 결정한다. 요청 함수에서 ReleaseRecord를 직접 만들지 않는다.

승격의 제어 브랜치 HEAD나 그 HEAD의 다른 태그로 결과를 추정하지 않는다. 결합이 아직 없으면 raw workflow 미러만 남기고 기존 정기 reconcile에서 다시 확인한다. GitHub 실행 뒤 응답/감사 저장이 실패하면 결과 미확인으로 명시하고 자동 재실행하지 않는다. 기존 태그에서 시작한 승격은 그 실제 태그/SHA로 처리한다. DB 스키마·중앙 workflow·14개 caller 변경은 없다. 일반 배포의 기존 HEAD 추정 문제는 별도 후속으로 분리한다.

추가 회귀: 다른 태그가 달린/태그 없는 제어 HEAD, queued/in_progress/completed, 정확한 실행ID·repo·tag·SHA 결합, 응답 누락·감사 저장 실패·미확인 실행, 기존 태그 실행. 보완 후 새 분기만 2차 교차 리뷰로 확인한다.
