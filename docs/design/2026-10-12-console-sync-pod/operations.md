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

등록된 provisioner 계정의 `roles/iam.workloadIdentityPoolAdmin`이 2026-09-07 14:00 UTC에 만료되어 WIF pool 생성은 실제 권한 거부로 실패했다. 새 풀·provider가 만들어졌다고 표시하지 않는다. 기존 identity에 한시적인 해당 역할 복구가 필요하며 별도 프로젝트 IAM 관리자 역할·정적 키는 요청하지 않는다. Secret의 빈 리소스는 생성했으나 grant를 넣거나 정본을 전환하지 않았다. 나머지 실제 검증 결과는 완료 후 [검수 기록](../../qa/2026-10-12-console-sync-pod/report.md)에 추가한다.
