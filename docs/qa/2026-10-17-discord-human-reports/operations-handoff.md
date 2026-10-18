# Discord 보고 운영 역할과 적용 절차

## 채널 역할

| 채널 | 자동 보고 |
| --- | --- |
| 수집시장정보 (`metrics-daily`) | 21:40 KST 중요 검색 순위·지속 추세, 본문 PNG·같은 기준일 전체 보고서. CSV는 웹 보조 다운로드. |
| 일일보고 (`app-ops`) | 표본·비교 기간이 있는 사용자·잔존·매출 변화, 출시·제품 사건 맥락, 중요한 비용 단계·해소. |
| 장애알림 (`ops-alerts`) | 확인된 결제·보상 지급 문제와 사용자 영향 사건. 단순 수집 실패는 내부 기록. |
| 사용자리뷰 (`user-reviews`) | 실제 원문에서 드러난 불편·요청·칭찬을 앱·버전·국가/제공 언어별 묶음으로 전달. 평점만 바뀐 개별 카드는 제외. |
| 출시관리 (`release-ops`) | 앱·버전·마켓의 실제 상태 전환·실패 이유·필요한 승인. 빌드·업로드·심사·공개 확인 구별. |
| 개발·외부 연동·명령 채널 | 영향을 받는 앱·작업·결정과 상세 링크. 자동 감사·단순 상태는 내부 기록. 사용자 명령 결과·승인 카드는 그대로 응답. |

## 운영 외부 경로 조사

2026-10-18 읽기 전용으로 최근 12채널의 발신자를 대조했다. 주 발신자는 Backoffice·서리이며 출시관리에는 기존 release-run 웹훅도 있다. Bot API로 다른 발신자의 content/embeds가 비어 보였으나 이를 빈 보고로 판단하지 않았다. 등록된 동일 웹훅의 공식 GET으로 다시 읽어 Vernhald 1.0.2·1.0.3, Reascend 1.2.0의 실제 테스트 배포 안내를 확인했다. 앱·버전·마켓 상태·변경 이유·테스트 링크가 있으며 사용자가 실행한 릴리스의 요청 결과다.

로컬 `seorilabs-release-run/scripts/notify_release_discord.py`가 같은 구조·기존 logical credential `shared/discord/backoffice-release-ops-webhook`을 사용한다. CLI 호출형이고 자체 스케줄은 없다. Backoffice 자동 수집 보고와 구별하며 기존 웹훅을 회수하거나 과거 메시지를 수정하지 않았다. 조사 근거는 `release-webhook-own-readback.json`이다. 외부 `seori-pr-bot`의 NATS 자동 감사·쓰레드·쿼터 본문은 Backoffice ingest의 source 기준으로 내부 분류하고 명시 응답·승인은 유지한다. 외부 저장소의 코드는 변경하지 않는다. Discord 앱에서 별도 GitHub 직접 연동의 코드변경 채널도 확인했다. 이는 Backoffice outbox를 통과하지 않는 GitHub 원문 채널이며, 이번 Backoffice 배포의 적용 대상으로 표시하지 않는다. Backoffice 자체의 이슈 전량 발송·원문 스레드 경로는 선정 기준과 원문 링크 방식으로 전환한다.

## 배포와 readback

- 기존 delivery enum 값을 보존하는 SUPPRESSED 확장 migration을 먼저 적용한다. 원장·감사는 보존하고 과거 SENT를 일괄 수정·삭제하지 않는다.
- 정확히 검수한 source SHA와 이미지 digest를 고정한다. 중앙 검증·typecheck·lint·build·PR CI를 통과한 뒤 승인된 Backoffice 운영 배포를 실행한다.
- 기본 deploy 스크립트 대상 외에 `backoffice-operations-insights`와 검색 순위·시장·주간 인사이트·콘솔 수집 CronJob의 현재 replicas/suspend/schedule/env를 읽는다. 활성 설정을 보존하며 이미지와 source 표기만 바꾼다. 기본 replicas=0·suspend=true 매니페스트를 통째로 덮어쓰지 않는다.
- 웹·알림·인사이트·관련 정기 실행의 실제 imageID/digest/source, migration 적용 상태를 각각 재조회한다. 웹의 성공만으로 worker/CronJob 적용을 주장하지 않는다.
- 실제 자료의 유용한 보고를 한 번 실행해 원장·Discord 메시지 본문·PNG·버튼·날짜·수치를 대조한다. `keyword-daily YYYY-MM-DD`는 수집된 기준일을 명시할 수 있고 capturedAt은 실제 발행 시각을 보존한다.
- 대기 제외는 SUPPRESSED와 사유로 세며 전송 성공에 더하지 않는다. 오류·회복 횟수·분석 실패는 내부에 남긴다.

## 중지·복구

`NOTIFICATION_REPORTS_PAUSED=true`는 보고 delivery를 PENDING으로 유지한다. 긴급 사건·승인·사용자 요청 응답은 계속 전달한다. 문제 발생 시 notification worker의 기존 환경 변경 절차로 적용하고 readback하며, 원장과 schema를 되돌리거나 삭제하지 않는다. 원인 수정 후 false로 복구하면 같은 대기열과 멱등 키로 이어간다.

## 알려진 제한

- 동시 실제 지급 두 건에서 최초 성과 보고가 누락될 수 있는 보수적 처리는 [#483](https://github.com/seorilabs/seorilabs-backoffice/issues/483)에서 분리한다. 실제 지급·원장에는 영향이 없다.
- 같은 기준일 순위의 일부 중요 항목이 조회 불확실이면 기존 카드 전체를 유지한다. 해당 항목이 확정된 뒤 결론을 갱신한다.
- 개발 검수의 provider 대체 응답·권한 거부·계약 실행과 실제 provider 성공을 구분한다. 이번 범위에는 앱 마켓 배포·기기 사용·실결제가 없다.
- Discord API 수신·첨부 직접 보기와 Discord 앱 화면 조작은 별도 근거로 기록한다.
