# 콘솔 OAuth 운영 적용

설계 ID `2026-10-12-console-sync-pod`, 승인 설계 v2 `17c5f6cf1513d6e9d0d0e725af0deb34effeff3c`를 따른다. 사용자는 2026-10-13 KST 운영 리소스 적용과 Secret Manager/WIF 실측·전체 제품 E2E를 승인했다. 두 검증과 기존 PR 조건이 모두 통과하면 PR #462 머지·운영 배포·스케줄 활성화·첫 수집 readback을 진행한다. 승인은 검증 실패를 통과로 바꾸지 않는다.

## 고정 대상과 권한

| 항목 | 대상 |
| --- | --- |
| 논리 ID·토스 workspace | `shared/apps-in-toss/console-oauth`, `38345` |
| GCP 프로젝트 | `seorilabs-ci`, 번호 `321365398093` |
| Secret Manager | `projects/321365398093/secrets/backoffice-ait-console-oauth` |
| WIF pool / provider | `backoffice-console` / `vzyx-cluster` |
| Kubernetes subject | `system:serviceaccount:platform:backoffice-console-metrics` |
| 공개 runtime principal | `k8s:platform:backoffice-console-metrics` |
| 운영 CronJob | `platform/backoffice-ait-console-metrics`, 매일 21:30 KST |

기존 클러스터 issuer `https://kubernetes.default.svc`와 운영 API의 `/openid/v1/jwks`에서 읽은 공개 JWKS를 WIF provider에 등록한다. 클러스터 issuer를 변경하지 않는다. provider는 `google.subject=assertion.sub`와 위 subject의 정확한 일치 조건만 허용한다. [Google의 Kubernetes WIF 절차](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-kubernetes)에 따라 projected JWT를 제출하고 Google 서비스 계정 키나 ADC fallback을 사용하지 않는다.

정확한 subject principal에 Secret 하나의 `roles/secretmanager.secretAccessor`와 `roles/secretmanager.secretVersionAdder`만 부여한다. 프로젝트 전체 Secret 관리·버전 삭제·IAM 변경 권한은 worker에게 주지 않는다. Secret은 자동 복제로 보존하고 버전의 자동 삭제·폐기 정책을 두지 않는다. 별도 보관 정책 승인이 없는 동안 모든 버전을 유지한다.

JWKS 키 변경 시 운영자가 live JWKS를 다시 읽어 provider를 갱신하고 WIF readback을 재검증한다. worker는 이를 변경할 권한이 없다. 인증·보존·잠금 실패는 안전한 오류 코드와 영속 중단 상태로 확인한다. 오래된 grant나 `latest`로 되돌리지 않는다.

## 적용·정본 전환 순서

1. 로컬/BeeStation 자격증명 전체 백업과 양쪽 복원 검증을 완료한다.
2. WIF provider·Secret IAM·[공개 Kubernetes 연결](../../../k8s/console-oauth-wif.yaml)을 적용하고 실제 subject·audience·최소 권한을 readback한다.
3. 보호된 로컬 최신 generation 3만 메모리에서 읽어 Secret의 불변 버전에 보존한다. 소비된 generation 1/2와 최초 인가 파일은 사용하지 않는다. 정확한 버전과 checksum·generation을 확인한다.
4. 격리 DB를 사용하는 실제 클러스터 시험 파드에서 WIF 접근·실제 자연 만료 갱신·회전 보존·새 UID의 파드 재조회를 확인한다. 운영 DB에는 쓰지 않는다. 성공한 최신 버전만 카탈로그 정본 전환과 향후 운영 등록에 사용한다.
5. 전체 44개 기능의 제품 E2E와 중앙 검증·필수 CI를 통과한다. UI 핵심 11개는 독립 에이전트의 세 회차 검수 근거를 포함한다. 외부 결제·환불·심사 제출 등은 격리된 전달 경계로 검증하며 실제 외부 쓰기 성공으로 표시하지 않는다.
6. 정확한 최종 소스 SHA의 빌드 전 근거를 확인한 뒤 이미지를 만든다. 운영 DB 백업·복원 rehearsal 후 승인된 배포 절차로 migration·배포·공개 runtime 등록을 수행한다.
7. CronJob을 중지 상태로 적용하고 실제 Job의 결과·DB 지표/ledger readback을 확인한 뒤 승인된 스케줄을 활성화한다. 결측은 0으로 만들지 않고 partial을 complete로 표시하지 않는다.

## 중단과 복구

실측·E2E·CI·복원 gate가 실패하면 머지·배포·활성화를 진행하지 않는다. `REFRESH_IN_FLIGHT`는 같은 provider refresh를 다시 전송하지 않는다. 운영자는 정확한 버전의 보존 여부와 runtime generation을 대조한 뒤 기존 등록 서비스의 권한·CAS·멱등·감사 경로로 복구한다. 소비된 refresh는 백업 복원으로 되살릴 수 없으므로 보존 결과가 불명이면 새 사람 인가가 필요하다.

스케줄 중단은 `spec.suspend=true`로 수행한다. 실행 중 Job은 별도로 상태를 확인하며 반복 실행하지 않는다. 새 OAuth runtime 테이블·감사와 Secret 버전은 보존한다. 이미지 rollback만으로 최신 grant나 runtime generation을 되돌리지 않는다.

## 이번 실행 상태

변경 전 백업 `20261013T201825+0900`: 로컬·BeeStation 모두 6,360개 파일 전체 복원 통과, SHA-256 `9f7b609905f4dd8a43b168cd959d9b9b5ab3543ff09078878968188e3ac5df2b`.

최초 WIF pool 생성은 provisioner의 `roles/iam.workloadIdentityPoolAdmin`이 2026-09-07 14:00 UTC에 만료되어 거부됐다. 사용자가 기존 identity의 해당 역할만 2026-10-14 08:00 KST까지 복구한 뒤 실제 IAM readback을 확인했다. 프로젝트 IAM 관리자 역할·정적 키는 추가하지 않았다.

풀·provider·정확한 Secret IAM·KSA·공개 WIF ConfigMap을 적용하고 실제 Google 호출을 검증했다. worker는 버전 읽기·추가만 허용되고 삭제·중지·Secret 변경·IAM 변경은 거부된다. 다른 KSA subject와 잘못된 JWT audience는 각각 STS HTTP 400으로 거부됐다.

최신 generation 3을 Secret 버전 1에 보존한 뒤, 운영 클러스터의 격리 DB 시험 파드에서 2026-10-13 20:49:03 KST 실제 자연 만료 갱신을 수행했다. HTTP 200 한 번으로 generation 4가 Secret 버전 2에 회전 보존됐다. 새 UID의 파드가 20:51:19 KST에 같은 버전을 읽고 refresh 0회로 조회했다. IOS 광고 결측은 0으로 채우지 않았으며 운영 DB 쓰기는 없다.

카탈로그의 정본은 Secret Manager로 전환했다. generation 4의 로컬 암호화 복구 사본과 소비된 과거 버전은 보존한다. 전환 후 백업 `20261013T205437+0900`은 로컬·BeeStation 모두 6,377개 파일 전체 복원에 통과했다. SHA-256 `333a042c6d4f579bb1fce70b0f3bf6e08bd156efa9dd3abfeea688c474ac4be1`.

[공개 실측 근거](../../qa/2026-10-12-console-sync-pod/provider-wif-secret-manager.json)에는 실제 소스 SHA·파드 UID·세대·정확한 Secret 버전과 실패 경계를 기록했다. 제품 전체 E2E·PR 머지·운영 migration/배포·CronJob 적용/활성화·첫 운영 수집은 아직 완료되지 않았다.
