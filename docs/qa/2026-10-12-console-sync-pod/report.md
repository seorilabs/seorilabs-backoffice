# 파드 콘솔 수집 검수

설계 ID: `2026-10-12-console-sync-pod`. [승인·실행 티켓](../../design/2026-10-12-console-sync-pod/execution.md).

## 환경·실행 계획

등록된 콘솔 OAuth 자격증명이 없어 실제 공급자 갱신은 차단이다. 로컬 HTTP MCP 시험 서버는 공식 SDK와 합성 응답만 사용한다. MySQL 9.2 격리 DB는 `127.0.0.1:33319/backoffice_console_qa`이며 운영 키·데이터를 사용하지 않는다.

테스트 순서: 실패 조건 확인 → 매핑·ingest 수정 → OAuth·HTTP MCP 경계 → 격리 DB 수집·보존·잠금·readback → 타입·린트·전체 회귀 → 중앙 개발 근거 검증 → PR CI·교차 리뷰.

## 진행 결과

- ingest 원본에서 불완전한 행·다른 리스팅 ID가 저장되어 회귀 assertion 2개 실패(예상 결과).
- mapper 미구현 상태에서 정상 행·누락 사유 assertion 2개 실패(예상 결과).
- 수정 후 매핑·저장 보호 및 기존 검사 9개 통과.
- OAuth 격리 검사 5개, 날짜·분할 2개 통과.
- 실제 loopback HTTP MCP 검사 2개 통과: refresh·429·동시 조회 최대 2·쓰기 도구 차단·IOS 누락·재시도 소진.
- 격리 MySQL에서 전체 14개 리스팅 저장·완료 판정·readback 통과. 출시일 미확인 차단, 결측 시 기존 행/관측 보존, 동시 DB 잠금, 실패 뒤 잠금 해제와 새 OAuth 인스턴스 조회도 통과.
- 타입 검사·린트 통과. 기존 `release-tag-ledger.test.ts`의 미사용 변수 경고 1개는 범위 밖으로 남긴다.
- 전체 회귀 1,748개 통과(실패·skip 0).
- worker 개발용 묶음 생성 통과, 자격증명 없는 `verify-refresh`는 안전 코드 `OAUTH_CREDENTIAL_REQUIRED`로 종료 1.
- 중앙 검증기 실제 실행은 실패(예상된 차단): AC-1/2/6의 blocked 상태와 전체 E2E 미실행을 통과로 허용하지 않는다.
- `pnpm build`: 전체 기능 E2E 차단으로 미실행. worker 묶음은 개발용 실행 검증이며 제품 빌드 gate 통과가 아니다.
- PR CI·교차 리뷰: PR에서 최신 결과를 확인한다. 이번 단계는 운영 배포·병합을 수행하지 않는다.

## 남은 gate

- AC-1 실제 최초 인가·토큰 만료 후 refresh·파드 재시작: 차단, 자격증명 없음.
- AC-2 실제 revoke 및 AC-6 실제 공급자/운영 DB readback: 미실행.
- 이번 후보의 Backoffice 전체 기능 43개 E2E 증거: 미실행. 과거 후보를 재사용하거나 서비스 fixture를 전체 제품 검수로 표시하지 않는다.
- 운영 배포·Secret 적용·CronJob 활성화: 미승인, 미실행. manifest는 suspend=true이고 기존 배포 적용 목록 밖이다.

## 재현 명령·근거

```bash
pnpm typecheck
pnpm lint
pnpm test
# 운영 DB에 실행하지 않는다. localhost:33319/backoffice_console_qa만 허용한다.
DATABASE_URL='<격리 DB URL>' node --import tsx scripts/test-console-metrics.ts
```

TDD 기준은 origin/main `f7682393443e3a6d0436af7ad3d4dafb4b30341e`의 ingest다.
누락 IAP와 slug/miniAppId 불일치에서 `1 !== 0` assertion이 실패했고, 수정 후 동일 검사가 통과했다.
OAuth·HTTP 검사는 실제 공급자 실패를 재현한 합성 응답 시험이며 실측 OAuth 성공을 증명하지 않는다.

로컬 `console-sync` 스킬은 승인된 조회 전용 경로에 한해 개정했다. 최초 동의·등록 identity·실제
갱신·회전·재시작 검증·별도 운영 승인·만료 우회 금지 조건을 유지한다.

## 교차 리뷰 반영

[PR #462](https://github.com/seorilabs/seorilabs-backoffice/pull/462)에 읽기 전용 Claude 원문을 게시했다.
Copilot 자동 리뷰의 일반 token 키와 중복 날짜 지적을 수용해 먼저 실패하는 assertion을 추가했다.
Claude의 불완전한 회전 응답·OAuth 설정 오류·HTTP 전체 시간 예산·429 중단·저장소 명령 계약·
비어 있지 않은 DAU 경로·죽은 분기·필수 필드 타입·무관한 auth lockfile 변경을 보완한다.

행 전체 보류와 공통 minLastDate overlap은 승인 설계·기존 런북의 의도된 정책이다. 빈 배열을 0으로
확정하거나 nullable 스키마/부분 필드 갱신을 도입하지 않는다. DB 전용 리스팅은 현재 상태 응답에
workspace가 없으므로 자동 수집에서 확인 필요로 차단하고 기존 상태·push API는 보존한다.

기존 PR CI는 Next 빌드까지 통과했다. 전체 제품 E2E 중앙 gate는 여전히 차단이다.
리뷰 반영 후보의 최신 테스트·CI와 2회차 수정분 리뷰는 PR 코멘트에서 확인한다.

리뷰 반영 후 typecheck·lint 및 전체 1,754개 테스트(실패·skip 0), 격리 DB 14개 리스팅의
저장·readback·기존 행 보존·요청 제한 시 후속 조회 중단이 통과했다. HTTP 전체 예산 검사는
대기 중인 재시도가 취소된 뒤 추가 요청이 없음을 확인한다.
