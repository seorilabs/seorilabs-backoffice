# 보고서 초기화의 공통 런타임 오류 수정

기존에 승인된 L3 개발 환경 전체 회귀와 web, service 운영 공개 범위에서 초기화 오류를 수정한다. 저장 계약과 지표 계산, 권한 및 발행 동작은 바꾸지 않는다.

## 실패와 원인 범위

`964ac33`의 전체 회귀에서 React #418이 두 번 발생했다. 원래 이동 순서의 단일 재현에서는 `/report`가 `/`로 이동하는 중 코호트 표에서 같은 예외를 확인했다. React는 `tbody`를 예상했지만 DOM 커서는 그 본문의 첫 `tr`을 가리켰다. 수집 현황표만 지연한 수정으로는 공통 문제를 해결하지 못했다. 원래 실패와 집중 검수 결과를 각각 보존한다.

실제 Next 15.5.19의 App Router는 npm React 버전과 별개로 `19.2.0-canary-0bdb9206-20250818`을 포함한다. HTML을 모두 읽은 뒤 늦게 완료되는 자식을 concurrent hydration으로 처리하는 최소 재현에서 3회 모두 #418과 원래 DOM 교체가 발생했다. 같은 재현을 Next 16.4.2의 포함 렌더러에서 실행한 3회는 오류 없이 원래 노드를 유지했다. 이것은 앱 전체 회귀나 운영 확인을 대신하지 않는다.

[React #37584](https://github.com/react/react/issues/37584)는 재실행 시 DOM 커서를 복구하는 수정이 19.3에 포함됐음을 설명한다. [원래 수정](https://github.com/react/react/pull/35494)과 Next 16.4.2의 실제 포함 소스를 대조했다. 문서를 읽는 시점만 늦추는 스케줄러 패치와 오류 숨김은 사용하지 않는다.

## 변경 범위

- Next 16.4.2, React와 React DOM 19.3.1 및 eslint-config-next 16.4.2를 고정한다. 실제 App Router 렌더러는 포함된 19.3 canary다.
- 개발과 배포 빌드는 지원되는 `--webpack`으로 기존 번들러를 유지한다. Turbopack 전환은 이 수정에 포함하지 않는다.
- 제거된 `next lint`를 ESLint CLI로 대체하고 기존 Next lint의 `src` 범위를 유지한다. 기존 두 hooks 규칙과 나머지 lint를 유지하며, 새 Compiler 진단 중 기존에 꺼져 있던 effect와 ref 설계 규칙은 이번 런타임 수정에서 새로 도입하지 않는다. React Compiler는 사용하지 않는다. 전후 유효 설정을 대조한다.
- ESLint FlatCompat와 해당 직접 의존성, 제거된 Next eslint 설정을 정리한다.
- 공통 런타임 수정으로 대체된 수집 표 지연 컴포넌트와 초기 본문 생략 테스트를 제거하고 기존 서버 표를 복원한다. 원래 판과 표의 모든 값은 그대로 사용한다.
- 기기의 SDK와 인증 경계, 중앙 설정과 DB, worker 실행 정책은 변경하지 않는다. 기존 middleware 이름과 matcher를 유지한다. 새 빌드의 정적 분석이 해석할 수 있도록 같은 `NextAuth(authConfig).auth`를 명시한 상수로 내보낸다. 기존 구조 분해와 같은 함수를 한 번 생성하며 인증 설정은 바꾸지 않는다.

## 실행과 검증

`node scripts/serve-hydration-replay.mjs 3393`은 loopback에서 최소 재현을 연다. 브라우저에서 `window.replayResult`를 읽고 오류가 없으며 `sameTarget`, `sameChild`, `assertionPassed`가 참인지 검사한다. 자식은 한 번의 microtask 뒤 완료되며 지표나 실제 계정을 사용하지 않는다. 기존 런타임의 실패부터 기록한 뒤 같은 fixture의 바이트가 새 런타임과 일치함을 확인한다.

최종 후보에서 전체 test, typecheck와 lint, 웹과 worker 빌드, migration 및 중앙 검증기를 실행한다. 독립 실행자는 기존 44개 기능과 브라우저 49개, API 42개와 관리자 5개, 저장과 재시작, 실제 고정 보고의 모든 표 및 CSV와 DB 보존을 검증한다. 캐시가 켜진 로딩과 코호트 표도 확인한다. 원래 화면 검수 1~3회는 보존하고 새 회차로 바꾸지 않는다.

정확한 SHA와 이미지로 배포한 뒤 실제 v1~v5 보고서와 CSV, 같은 Discord 본문과 이미지 및 링크를 읽는다. 표시 수정 때문에 새 보고서 판이나 메시지를 만들지 않는다. 실패하면 현재 운영 이미지를 유지하고 통과 근거를 만들지 않는다.
