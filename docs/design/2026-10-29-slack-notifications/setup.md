# Slack 설정과 전환 상태

확인일: 2026-10-29. Slack 설정과 개발 구현을 완료하고 최종 검수 중이다. 운영 배포, Discord 명령 해제와 자연 수신은 아직 완료하지 않았다.

워크스페이스는 `seorilabs.slack.com` (`T0CCP49NJAK`), 앱은 `Seorilabs Backoffice` (`A0CD8B7CLH2`), 봇은 `seori` (`U0CD4EU0Y4S`)다. 실제 로그인 프로필과 회사 계정을 대조했다. 운영자 Slack ID는 `U0CD2GKL36J`다.

공식 `auth.test`, `users.info`, `conversations.info`, `conversations.members` 응답으로 워크스페이스, 봇과 운영자의 활성 상태, 아래 채널 이름과 참여, 공개 범위를 대조했다. 봇 권한은 `chat:write`, `channels:read`, `groups:read`, `files:write`, `files:read`, `users:read`, `commands` 7개다. `/seori` 명령과 버튼, 선택창 요청 URL은 `https://backoffice.vzyx.xyz/api/slack/interactions`로 저장하고 앱을 다시 설치했다. 기존 봇 토큰의 공개 지문은 유지됐다.

| 목적지 | 채널 | ID | 공개 범위 |
| --- | --- | --- | --- |
| metrics-daily | 운영보고 | `C0CD4FA4LAW` | 공개 |
| user-reviews | 사용자리뷰 | `C0CD4FX486N` | 공개 |
| ops-alerts | 장애알림 | `C0CD2NL3GGN` | 공개 |
| batch-monitoring | 수집결과 | `C0CD4FX1Y7L` | 공개 |
| backoffice | 운영명령 | `C0CDZKX73CG` | 공개 |
| action-events | 앱이벤트 | `C0CD00CHJ93` | 공개 |
| release-ops | 출시관리 | `C0CD3A50RFY` | 공개 |
| seori-review | 개발검토 | `C0CD75ZV1H7` | 공개 |
| private-feed | 개인피드 | `C0CD8VDS4AY` | 비공개 |
| app-ops | 재무보고 | `C0CD54HMJ2E` | 공개 |
| iap | 결제알림 | `C0CCPU9J85V` | 공개 |
| ad-rewards | 광고보상 | `C0CD54GJ24S` | 공개 |
| github-issues | 개발이슈 | `C0CD77103MF` | 공개 |

기존 `all-seorilabs`, `new-channel`, `social`은 보존했다. 다른 사람 초대, 기존 채널 삭제, 유료 플랜 변경은 하지 않았다. 관리자 화면은 11월 27일까지 Pro 무료 평가판이며 업그레이드하지 않으면 무료 플랜으로 돌아간다고 표시했다.

## 게시 확인

초기 [검증 메시지](https://seorilabs.slack.com/archives/C0CD4FA4LAW/p1793260580472039)를 게시하고 같은 메시지를 수정한 뒤 Slack 화면에서 최종 본문이 하나만 표시됨을 확인했다. 이는 초기 연결 증거이며 자동 운영 전환 완료를 뜻하지 않는다. 최초 직접 채널 진입에 표시 차이가 있어 채널 검색과 다시 연 화면으로 확인했고 원인은 확정하지 않았다.

## 자격증명

정본 논리 ID는 `shared/slack/backoffice-bot`이다. 로컬 파일 0600과 디렉터리 0700, 카탈로그 오류 0개를 확인했다. 봇과 서명 키, 실제 채널과 역할별 사용자 설정을 같은 원본에 보관했다. 기존 비밀값 54개를 보존하고 Slack 키 27개만 기존 SealedSecret에 추가했다. 운영 Secret 동기화는 배포 단계에서 실제 상태를 확인한다.

암호화 백업 `20261029T182305+0900`의 로컬과 BeeStation 사본 모두 SHA-256 `c8164ab8822fa61477851d8a3e3f46981fde3df60e48035dba7b0e92d7430e97`, 복원 파일 5,167개로 검사를 통과했다. 비밀값은 Git과 로그, 문서에 기록하지 않았다.

## 운영 전환 전 관측

실제 DB 초기 조회에서 Discord 미발송과 실행 중 명령은 0건, 열린 장애는 2건, 대기 배포 승인은 0건이었다. 기존 worker의 이미지 digest는 `sha256:2a226aaa44278a4a3a63c30e86e588e1682a33cdbd567935ac02fa72b031eea1`이었다. 이 값은 전환 직전 다시 읽는다. 신규 Slack 카드와 자연 수신은 최종 후보를 배포한 후 확인한다.

승인과 실행 범위는 [설계](design.md), [실행 티켓](execution-ticket.md), [이슈 #548](https://github.com/seorilabs/seorilabs-backoffice/issues/548)에 연결한다.
