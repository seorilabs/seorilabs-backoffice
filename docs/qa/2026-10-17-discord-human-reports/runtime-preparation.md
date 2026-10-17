# 격리 실행 검수 준비와 인계

2026-10-17 독립 판단 품질 검수 담당이 준비했다. 이 문서는 환경 준비 기록이다. **공식 독립 검수 1~3회는 아직 시작하지 않았다.** 준비 중 생성한 fixture나 예전 실행 결과를 최종 후보의 통과 근거로 쓰지 않는다.

## 준비한 환경

| 항목 | 값·제약 |
| --- | --- |
| 작업 소스 | `/Users/syous/Repositories/seorilabs/seorilabs-backoffice.worktrees/discord-human-reports` |
| 검수 자료 | `/tmp/discord-human-reports-qa` |
| MySQL | 로컬에 있던 `mysql:9.2` 이미지. 컨테이너 `bo-discord-human-reports-qa-20261017` |
| DB 연결 범위 | `127.0.0.1:33327/backoffice_qa`. 이 작업에서 새로 만들었다. |
| 웹 | `http://localhost:3317`. `owned-web.json`으로 이 작업의 프로세스만 추적한다. |
| 로그인 | fixture 사용자 `qa-operator`. 임시 NextAuth 쿠키는 `auth-cookie.json`에만 저장, 모드 0600. |
| 환경 변수 | `qa-env.json`·`docker.env` 모드 0600. 운영 자격증명 파일을 읽거나 상속하지 않는다. |
| 외부 통신 | `network-boundary.cjs`가 Node의 fetch·HTTP·TCP 외부 연결을 차단한다. provider·NATS 워커를 시작하지 않는다. 브라우저 실행 파일도 localhost 외 요청을 차단한다. |
| 전송 검수 | 실제 `drainAllNotifications`를 호출하되 Discord fetch는 메모리 캡처로 대체한다. 운영 발송은 하지 않는다. |

`run-qa.py`는 최소 OS 환경만 넘기고 저장소의 `.env` 계열 파일이 있으면 실행을 거부한다. 비밀값을 `cat`·로그·명령 인수로 출력하지 않는다. 신규 격리 DB에서 기존 trigger 생성 migration의 MySQL 1419 조건이 확인되어, 이 컨테이너의 `log_bin_trust_function_creators`만 켰다. 실패 직후 이 작업 소유의 빈 검수 DB를 다시 만들고 처음부터 적용했으며 운영 DB에는 접근하지 않았다.

## 스키마 준비 근거

- 실제 MySQL에 43개 migration을 적용했다. 마지막은 `20261017130000_notification_report_suppression`이다.
- `scripts/verify-migration-state.ts --history=fresh --print-contract`의 실제 출력으로 `prisma/schema-contract-current.json`을 생성했다.
- 결과: table 96, column 1297, index 594, foreign key 108.
- column SHA-256: `098428fbf5037671435dec1377024a97870c713f19eff92a674f18b3458e4cd7`.
- `--history=fresh` 읽기 확인: migration row 43, append-only trigger 6개 통과.
- 원본 출력: `/tmp/discord-human-reports-qa/schema-contract-generation.log`, `schema-contract-current.json`.
- 최종 후보가 고정되면 같은 후보의 migration·Prisma client로 다시 읽는다. 현재 기록은 공식 회차의 대체물이 아니다.

## fixture와 실행 파일

| 파일 | 용도 |
| --- | --- |
| `qa-seed.ts` | 3개 가상 앱, 28일 지표·검색 관측, 7일 보고서와 수정 이력, 권외·첫 관측·결측·실패·진행 중 사례, 근거 문서와 임시 로그인 쿠키. 빈 app table에만 실행한다. |
| `runtime-judgment.ts` | 공식 1회차용 실제 DB 서비스 검수. 작은 평점·수집·회복·출시 후 단일 DAU 억제, 과거 대기 문서 재분류, 실제 피해·승인 보존, 보고 중지, 중요 검색 보고·중복 방지·분석 실패를 확인할 준비 상태다. 최종 SHA와 공식 회차 환경변수가 없으면 실행을 거부한다. |
| `browser-regression.py` | 공식 3회차용 준비 파일. 기존 30화면·11 redirect와 최신 검색 이력 화면, 국가·검색어 조작, 큰 글자·모바일, 38개 health/권한 거부 API 경계를 실행하도록 준비했다. `async def main(session)` 형식이며 전용 Edge 세션에서 실행한다. |
| `prepare-web-harness.py` | 현재 기능 목록에 맞춘 `feature-evidence-map.planned.json` 생성. 모두 `planned-not-executed` 상태다. |
| `start-web.py` | 전용 3317 웹 프로세스를 시작하고 PID·그룹·작업 경로를 기록한다. 이미 이 작업 프로세스가 있으면 중복 시작하지 않는다. |

공식 1회차 실행 형태:

```bash
python3 /tmp/discord-human-reports-qa/run-qa.py env \
  QA_OFFICIAL_REVIEW=round1 QA_REVIEW_SHA=<최종후보SHA> \
  pnpm exec tsx /tmp/discord-human-reports-qa/runtime-judgment.ts
```

결과와 메시지·이미지 캡처는 `/tmp/discord-human-reports-qa/round1/`에 남는다. 실행 전 회차 계획, 정확한 후보 SHA, 격리 데이터와 검수자를 기록해야 한다. 실패를 같은 회차 안에서 무제한 재시도하지 않는다.

공식 3회차 실행자는 최종 SHA가 적힌 `round3/plan.json`을 먼저 쓰고 실제 후보의 전체 `pnpm test`, 브라우저 실행, 추가 DB 서비스 회귀 결과를 같은 후보로 묶는다. 웹 서버를 같은 `.next` 경로에서 운영하는 동안 `pnpm build`를 동시에 실행하지 않는다. 빌드가 필요하면 이 작업 소유 서버만 멈춘 뒤 빌드하고, 실제 후보로 다시 시작한다.

## 예전 42기능 자료의 재사용 한계

참고한 자료는 `/Users/syous/Workspace/artifacts/backoffice/nightly-rank-time-20261011/ui-qa/`다.

- 예전 feature map은 **42개**다. 현재 44개 중 `ait-console-pod-collection`, `keyword-rank-history-and-charts`가 빠져 있어 두 항목을 준비 목록에 보강했다.
- 예전 컨테이너·환경 파일·쿠키는 cleanup 기록대로 제거됐다. 오래된 파일 경로나 쿠키를 복원한 척하지 않는다.
- 예전 브라우저 통과는 화면 조회, 로컬 초안 편집, 비로그인 API 차단과 계약 테스트 조합이었다. 권한 있는 외부 provider 업무 성공을 실행한 증거로 넓히지 않는다.
- 예전 `collection-policy-runtime.ts`는 수집 지연·회복 카드, ‘회복 2회’, CSV 중심 보고를 성공 조건으로 삼는다. 새 요구와 충돌하므로 그대로 실행하지 않는다.
- 예전 `final-tests.py`는 오래된 컨테이너와 DB 이름에 `DROP DATABASE`를 수행한다. 그대로 실행하지 않는다.
- 예전 `assemble-evidence.py`는 과거 UI 회차와 과거 source SHA를 이어받는다. 이번 UI 3회차의 실제 기록으로 다시 작성해야 하며 과거 회차를 복사해 세면 안 된다.

## 기능 범위와 아직 하지 않은 것

준비한 기능 map에는 현재 44개 기능 ID가 모두 있고 참조 테스트 경로의 누락은 없다. 실제 전부 통과했다는 뜻은 아니다. 기능별로 브라우저 동작·실제 로컬 서비스·계약 테스트 중 무엇을 실행했는지 구분한다. OAuth provider 연결, 실제 마켓 배포·결제, 운영 Discord 발송, 실제 계정 권한 실행은 이 격리 검수 범위에서 실행하지 않았다. 실제 Discord 보고 확인은 운영 적용 담당이 승인 범위 안에서 별도 수행한다.

정리할 때는 이 작업의 `owned-runtime.json`·`owned-web.json` 대상과 실제 프로세스·컨테이너를 읽어 확인한다. 다른 컨테이너·브라우저·사용자 파일은 종료하거나 삭제하지 않는다.
