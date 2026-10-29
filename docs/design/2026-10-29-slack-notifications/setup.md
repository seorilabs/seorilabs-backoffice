# Slack 초기 설정 확인

확인일: 2026-10-29. 워크스페이스와 봇 설정만 완료했으며 Backoffice 자동 알림의 구현, 운영 배포와 자연 수신은 아직 실행하지 않았다.

## 설정과 공식 API 확인

| 항목 | 확인한 값과 상태 |
| --- | --- |
| 워크스페이스 | `https://seorilabs.slack.com`, `T0CCP49NJAK` |
| 운영 계정 | 사용자가 지정한 회사 계정으로 로그인하고 Slack 프로필의 이메일을 대조함 |
| 연동 앱 | `Seorilabs Backoffice`, `A0CD8B7CLH2`, 설치 완료 |
| 봇 | `seori`, `U0CD4EU0Y4S`, `B0CD6H934QZ` |
| 권한 | `chat:write`, `channels:read`, `files:write` |
| 인증 | `auth.test`: `ok: true`, team ID와 URL 일치 |
| 채널 참여 | `conversations.info`, `conversations.members`로 아래 4개 채널의 이름, 생성자, 봇과 운영자 참여 확인 |
| 현재 플랜 | Slack 관리자 화면은 11월 27일까지 Pro 무료 평가판이며 업그레이드하지 않으면 무료 플랜으로 돌아간다고 표시함. 결제와 업그레이드는 실행하지 않음 |

| 채널 | ID |
| --- | --- |
| 운영보고 | `C0CD4FA4LAW` |
| 사용자리뷰 | `C0CD4FX486N` |
| 장애알림 | `C0CD2NL3GGN` |
| 수집결과 | `C0CD4FX1Y7L` |

채널은 워크스페이스 공개 채널로 생성했다. 기존 `all-seorilabs`, `new-channel`, `social`은 보존했다. 다른 사람 초대나 계정 권한 변경, 기존 채널 삭제는 하지 않았다. 초기 생성 UI의 자동완성이 바꾼 채널 이름 1개는 이번 작업에서 만든 정확한 채널 ID를 대조한 뒤 `사용자리뷰`로 수정하고 API로 다시 확인했다.

## 검증 메시지

- `chat.postMessage`: `ok: true`, 채널 `C0CD4FA4LAW`, 메시지 `1793260580.472039`.
- `chat.update`: `ok: true`, 같은 채널과 같은 메시지 ID.
- [검증 메시지](https://seorilabs.slack.com/archives/C0CD4FA4LAW/p1793260580472039).
- 최종 본문은 초기 채널과 봇 준비, 게시와 수정 확인, Backoffice 자동 알림 연결 전 상태를 구분한다. 가짜 제품 지표나 운영 성공을 게시하지 않았다.
- 채널 화면에서 최종 제목과 확인 항목, 자동 알림 미연결 안내가 모두 일치하고 같은 검증 메시지가 1개만 표시되는 것을 확인했다. 운영보고 채널에는 운영 보고의 목적과 Backoffice, GitHub의 기록 역할을 설명으로 추가했다.
- 브라우저에서 운영보고 채널의 최종 메시지 본문을 확인했다. 처음 직접 채널 URL과 메시지 링크를 열었을 때 `알 수 없는 채널`이 표시되어 통과로 기록하지 않았다. 같은 시점에 공식 API와 브라우저 요청의 `conversations.view`는 채널과 멤버를 정상 반환했다. Slack 채널 검색에서 운영보고를 다시 연 뒤 채널과 최종 본문이 표시되는 것을 확인했다. 채널 설명을 저장한 뒤에는 직접 채널 URL을 새로 열어도 제목과 최종 본문이 표시되고 검증 메시지가 1개인 것을 다시 확인했다. 초기 표시 차이의 원인은 확정하지 않았다.

## 자격증명과 백업

로컬 정본은 카탈로그 논리 ID `shared/slack/backoffice-bot`이다. 값은 문서, Git과 로그에 넣지 않았다. 파일 권한 `0600`, 전용 디렉터리 `0700`, catalog preflight 오류 0개를 확인했다. 기존 카탈로그 경고 10개는 이번 Slack 항목과 무관하며 변경하지 않았다.

신규 봇 키와 메타데이터를 포함한 암호화 백업 `20261029T165135+0900`을 로컬과 BeeStation 양쪽에 만들었다. 두 사본 모두 복원 검사에 통과했다.

- 로컬 백업: `~/.seorilabs-credential-backups/20261029T165135+0900/`
- BeeStation 백업: `~/Library/CloudStorage/BeeStation-ChaedaStation/vault/seorilabs-credentials/backups/20261029T165135+0900/`
- archive SHA-256: `7eba527f2eb2ecdc52413ca06d12049489d57400fb9b621163d5f89794b9fed0`
- 복원 파일 수: 각 5,167개. 원문 비밀값은 이 기록에 포함하지 않는다.

## 소프트웨어 변경 전 상태

별도 worktree의 [설계](design.md), [테스트 계획](test-plan.json), [실제 앱 구성](slack-app-manifest.json)을 준비했다. 최신 중앙 `test-plan.schema.json` 검증, 기존 기능 ID와 기준 SHA 대조, manifest JSON과 권한 집합 검사를 통과했다. 제품 코드와 DB, 운영 컨테이너, 기존 Discord 설정은 아직 변경하지 않았다.

승인 범위는 L1 개발 환경 검증, 한국어 Ready PR과 검토, 호환 migration, Backoffice 서비스 운영 배포, Slack 검증 게시와 최초 실제 자동 보고 확인으로 제안한다. 별도 앱의 마켓 출시와 심사, 기기 접근, Discord 중단은 포함하지 않는다.
