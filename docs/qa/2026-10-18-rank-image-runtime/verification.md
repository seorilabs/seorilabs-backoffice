# 운영 순위 PNG 로딩 보완

통합 보고 개편 PR #484의 실제 운영 검증에서 본문·버튼은 도착했지만 이미지 생성 실패로 본문만 전송됐다. 메시지 `1561173058939781163`과 발행 snapshot `2026-10-17-58ce82715deb10d6111ec58a`를 보존한다. 새 보고를 중복 발송하지 않고 동일 카드의 이미지 보완으로 확인한다.

운영 arm64 notification Pod에서 `require("sharp")`는 `/opt/chart-renderer/node_modules/sharp`를 찾았지만 `import("sharp")`는 `ERR_MODULE_NOT_FOUND`였다. ESM은 `NODE_PATH`를 검색하지 않는다. `/app/node_modules/sharp`에서 기존 target 패키지로 연결하고, target 이미지의 동적 import와 실제 한글 SVG→PNG 변환을 빌드 단계의 실행 검사로 고정한다. 제품 `src/`·schema·보고 숫자·선정 기준은 변경하지 않는다.

원래 승인된 L3·개발 환경·Backoffice 운영 적용 범위 안의 배포 검증 결함 수정이다. 기존 사용자 승인과 새 전체 검수 3회(누적 5회)의 UI 판정은 그대로 보존한다. 새 UX 4회차를 추가하거나 기존 실행을 새 SHA로 소급하지 않는다. 최종 정확 후보에서 독립 전체 개발 회귀를 다시 실행하고 중앙 before-build/deploy·타입·린트·빌드·CI·교차 리뷰를 확인한다. 실제 이미지의 동적 import/PNG, Pod별 파일·imageID, 동일 Discord 카드의 PNG·본문·버튼을 재조회한다.

진단 중 `kubectl exec deployment/backoffice`가 넓은 공통 앱 selector를 따라 교체 전 인사이트 Pod에 접속해 새 필드가 없다고 보인 도구 대상 선택 오류도 있었다. 실제 웹 Pod 이름으로 다시 읽고 OCI 이미지를 별도 추출해 schema hash `e96ce2c2a987a9efcfa368f07430ae7b570420ebd7f907a4b8c3ea9f3e181257`와 CLI 코드를 확인했다. 이미지 내용 불일치로 분류하지 않으며 초기 로그는 보존한다. 이후 운영 readback은 정확한 Pod·container 이름을 사용한다.
