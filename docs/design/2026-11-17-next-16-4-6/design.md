# Next.js 16.4.6 보안 패치

2026-11-17 사용자가 장애 후속 보고의 남은 항목 처리를 "남은것 처리해"로 지시했다. 그 항목 중 하나가 로컬 `next build`를 멈춘 Next.js 보안 권고였다. 승인 범위는 이 패치 업그레이드, 검증, Ready PR, 병합과 운영 배포 1회다.

## 근거

- 권고: [GHSA-mfr8-8qww-v76h](https://github.com/advisories/GHSA-mfr8-8qww-v76h), 중간 위험. `'use cache'` 함수를 `unstable_cache()`로 호출하면 root params가 다른 요청으로 노출될 수 있다. 영향 버전은 16.3.0부터 16.4.4까지이고 16.4.5에서 수정됐다.
- 현재 버전은 16.4.2다. Backoffice 코드는 `unstable_cache`와 `'use cache'`를 쓰지 않아 실제 노출 경로는 없다. 그러나 `next build`가 이 권고를 이유로 종료 코드 1을 반환해 로컬 품질 게이트가 막힌다.

## 변경

`next`와 `eslint-config-next`를 16.4.2에서 16.4.6(현재 latest, 같은 16.4 계열)으로 올린다. lock 파일에서는 `next`, `@next/*`, `eslint-config-next`가 바뀌고 `next-auth`의 peer 참조가 따라 바뀐다. `caniuse-lite` 중복 버전 하나가 정리된다. React와 다른 의존성은 바뀌지 않는다.

## 대안

| 안 | 판단 |
| --- | --- |
| 16.4.5(최소 수정 버전) | 16.4.6이 같은 계열의 최신 패치라 이후 패치를 다시 올리는 작업을 줄인다. |
| 16.5 canary | 기각. 정식 배포가 아니다. |
| 업그레이드하지 않음 | 기각. 실제 노출은 없지만 빌드 게이트가 계속 멈추고 권고가 남는다. |

## 인수조건

| ID | 조건 |
| --- | --- |
| AC1 | `next`, `eslint-config-next`가 16.4.6이다. lock 파일의 Next 계열 외 변경은 `next`가 참조하는 `caniuse-lite`가 이미 있던 1.0.30001816으로 합쳐지며 1.0.30001799 항목이 빠지는 것뿐이다. |
| AC2 | 보안 권고 일괄 조회에서 `next@16.4.6`에 해당하는 권고가 없다. |
| AC3 | `next build`가 보안 권고로 멈추지 않고 성공한다. |
| AC4 | 전체 단위 테스트, typecheck, lint, 배포 계약 셸 테스트, migration 계약이 통과한다. |
| AC5 | 운영 배포 뒤 웹과 worker 6개가 새 이미지로 Ready이고 로그인 화면과 health가 응답한다. |

## 검증

lock 파일 변경은 중앙 정책의 회귀 경로라 L3, 개발 환경이다. 전체 회귀는 PR CI의 verify job(전체 단위 테스트, typecheck, lint, 셸 계약 테스트, `pnpm build`)과 migration-contract job이 실행하며 확인된 CI 실행을 근거로 쓴다. 작성자는 같은 검사를 로컬에서도 실행한다. 기기는 사용하지 않는다.

## 적용과 복구

병합 뒤 Deploy workflow를 `deploy=true`로 실행한다. 이상이 있으면 이 변경을 되돌리는 PR을 병합하고 다시 배포한다. 데이터와 스키마는 바뀌지 않는다.
