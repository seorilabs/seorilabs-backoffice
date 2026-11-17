# 주간 지표 점검 발송 재개와 밀린 분석 실행 정리

2026-11-17 사용자가 "주간 지표 점검이 10/26 이후 Slack에 한 번도 나가지 않았다"는 보고의 선택지 중 (a) "워커가 주간 신호도 처리하게 하고, 쌓인 오래된 실행은 취소한다"를 골랐다. 승인 범위는 구현, 검증, Ready PR, 병합과 운영 배포다.

## 원인

월요일 `backoffice-weekly-liveops`(09:00 KST)와 `backoffice-weekly-insights`(10:30 KST)가 `publishWeeklySignals`로 `metric-weekly` 신호와 분석 실행을 만든다. 11/04 설계(#570)는 operations-insights worker를 `metric-collections` 모드로 켜고 `metric-collection` 종류만 가져가게 했다. 주간 신호를 가져갈 worker가 없어 11/02, 11/09, 11/16 주간 실행이 시도 0회로 남았다. 11/13 설계는 주간 지표를 `metric-insights`로 옮긴다고 했지만 처리 경로를 열지 않았다.

같은 이유로 `public-listing-confirmed`(Apple 공개 리스팅 확인) 실행 29건도 10/29부터 쌓였다. 이 신호는 스토어 제출 수집의 "프로덕션 공개 확인" 카드와 같은 사실을 알린다. 같은 이유로 `published`는 이미 보고하지 않는 종류다. 11건은 실행 입력에 신호 종류가 없어 종류 필터로는 찾을 수도 없었다.

11/17에는 운영자가 화요일에 `weekly-liveops`를 다시 실행해 `weekly:2026-11-16` 신호가 하나 더 생겼다. `publishWeeklySignals`가 실행 시점의 전날을 주의 끝으로 잡기 때문이다.

## 동작

1. worker 모드 이름을 `metric-insights`로 바꾸고 다음 종류를 가져간다.
   - `metric-collection`, `metric-weekly`: 분석해 `metric-insights`(지표보고)로 보낸다.
   - 보고하지 않는 종류(`INTERNAL_SIGNAL_KINDS`): 예전에 만든 실행만 남아 있다. AI 호출과 발송 없이 `INTERNAL_OBSERVATION`으로 끝낸다.
2. 실행을 고를 때 실행 입력의 `signalKind`가 아니라 분석 문서의 신호 종류로 고른다. 입력에 종류가 없는 예전 실행도 정리된다.
3. 주간 신호는 처리 시점에 끝난 마지막 주(월~일, KST)의 신호일 때만 보낸다. 그 밖의 주간 신호는 `STALE_WEEKLY`로 발송 없이 끝낸다. 실행 시도 초과로 정리될 때도 같은 규칙으로 보내지 않는다.
4. `publishWeeklySignals`는 주의 끝을 항상 지난 일요일로 잡는다. 다른 요일에 다시 실행해도 같은 `weekly:<일요일>` 신호로 합쳐진다.
5. `public-listing-confirmed`를 보고하지 않는 종류에 넣는다. 관측 기록은 지금처럼 남는다. 10/28 이후 Slack에 나간 적이 없으므로 사용자가 보던 알림은 바뀌지 않는다.

배포 직후 현재 대기열의 결과는 다음과 같다(배포가 11/18~11/22 KST일 때).

| 실행 | 결과 |
| --- | --- |
| `weekly:2026-11-15`(11/09~11/15) | 분석 후 지표보고로 발송 |
| `weekly:2026-11-01`, `weekly:2026-11-08` | `STALE_WEEKLY`, 발송 없음 |
| `weekly:2026-11-16`(화요일 재실행으로 생긴 신호) | `STALE_WEEKLY`, 발송 없음 |
| `public-listing-confirmed` 29건 | `INTERNAL_OBSERVATION`, 발송 없음 |

## 대안

| 안 | 판단 |
| --- | --- |
| SQL로 대기 실행을 취소 | 기각. 실행 이벤트와 문서 상태를 남기지 않는다. control-plane `CANCEL_RUN`은 이 분석 정의를 관리하지 않아 409로 거부한다. |
| worker를 전체 모드(`worker`)로 전환 | 기각. 11/04에 끈 운영 신호 탐지와 리뷰 통계 발송까지 다시 켜진다. |
| 밀린 주간 신호를 모두 발송 | 기각. 사용자가 오래된 실행 취소를 골랐다. |

## 검증 (L1, 개발 환경)

- 단위: 끝난 마지막 주 계산(월, 화 재실행, 일, 월 0시대), 지난 주간 신호 판정, 보고하지 않는 종류 목록, worker 매니페스트와 스크립트 모드 일치.
- 격리 MySQL 인수 시험(`scripts/test-metric-collection-insights.ts`): 현재 주 신호는 `metric-insights`로 발송, 지난 주와 다른 기준일 신호는 `STALE_WEEKLY`, 입력에 종류가 없는 공개 리스팅 실행은 `INTERNAL_OBSERVATION`, 다른 종류의 대기 실행은 그대로인지 확인한다. 같은 대기열을 쓰는 `test-operations-insights.ts`, `test-slack-report-cleanup.ts`도 실행한다.
- 전체 `pnpm test`, typecheck, lint, build와 CI.
- 운영: 배포 뒤 대기열이 위 표대로 끝나고 지표보고 채널에 주간 보고 1건이 나갔는지 확인한다.

## 인수조건

- AC1 지표 worker가 `metric-weekly`를 처리해 지표보고로 보낸다.
- AC2 끝난 마지막 주가 아닌 주간 신호는 발송 없이 `STALE_WEEKLY`로 끝난다.
- AC3 보고하지 않는 종류의 예전 실행은 실행 입력에 종류가 없어도 발송 없이 끝난다.
- AC4 주간 신호는 실행 요일과 관계없이 지난 일요일을 끝으로 하는 주를 가리킨다.
- AC5 `public-listing-confirmed`는 관측만 기록하고 분석 실행을 만들지 않는다.
- AC6 운영 배포 뒤 대기 중인 주간, 공개 리스팅 실행이 0건이다.
