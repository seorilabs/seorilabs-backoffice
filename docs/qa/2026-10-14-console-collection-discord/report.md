# 앱인토스 수집 종료 알림 검증

- 실행 티켓: [#466](https://github.com/seorilabs/seorilabs-backoffice/issues/466)
- 설계: [수집 종료 알림 v1](../../design/2026-10-12-console-sync-pod/collection-notification.md)
- 실제 CLI/HTTP에서 성공·저장 실패 뒤 알림 누락 2건을 먼저 재현했다. 최소 구현 후 2건 모두 통과했다.
- 부분 완료·실패의 비밀값 제외·인증 실패 코드·알림 DB 실패·인증 점검/동시 실행 무알림 6건이 통과했다.
- 전체 회귀 1,800건 통과. typecheck 통과. lint 오류 없음(기존 미사용 변수 경고).
- 최종 후보 SHA의 MySQL 서비스·전송 경로·제품 전체 E2E, 중앙 검증, 실제 Discord 전송은 소스 밖 근거에 기록한다. 준비·fixture 결과를 운영 전송 성공으로 표시하지 않는다.
- 제품 화면 변경 없음. 기존 UI 검수의 추가 회차를 만들지 않으며 새 SHA의 최종 제품 E2E를 별도로 실행한다.
- 새 봇/자격증명·DB 스키마·토스 인증/지표 매핑·기존 웹/다른 worker의 운영 변경은 없다.
