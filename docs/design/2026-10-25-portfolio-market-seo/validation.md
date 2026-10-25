# 점검 근거와 검증 결과

2026-10-25 KST, 저장소 기준 `e49e6e4e9f33698c52b978b845aa3e4335509dbc`에서 문서만 작성했다. 제품 코드, DB, 중앙 설정 버전과 마켓 정보는 변경하지 않았다.

## 작성한 자료

- [design.md](design.md): 앱별 상태, 점검 한계, 우선순위, 저장과 공개 확인 순서, 성과 관측 계획.
- [proposed-copy.md](proposed-copy.md): 5개 앱의 9개 언어 등록에 대한 36개 고유 문안. 제목을 두 마켓에 적용하므로 저장 대조 대상은 45개 필드다. 현재 값과 같은 필드는 불필요하게 다시 쓰지 않는다.
- [test-plan.json](test-plan.json): L1 개발 환경 검증 계획. 현재 단계는 문서 준비이므로 `release: null`이다. 제품 빌드의 검수 통과나 새 버전의 공개 승인을 나타내지 않는다.

## 자료 수집

| 자료 | 확인 범위 | 원본 |
| --- | --- | --- |
| Backoffice | 등록 36행, ACTIVE 설정, 최신 discovery, 7일 검색어 관측 777행 | provider-readback.jsonl |
| App Store Connect | 앱 25개, AppInfo 언어 레코드 69개, 최신 두 버전의 언어 레코드 111개 | provider-readback.jsonl |
| Apple 공개 조회 | 한국 16개, 미국 16개 응답 앱 | apple-public.json |
| Google Play 공개 조회 | 29개 패키지, 국가와 언어 조합 58회 중 46회 상세 페이지 확인 | play-public.json, play-extra-public.json |
| Google Play 기존 계정 | Seolee Apps 개인 계정 5547060480954653351, 앱 11개 | play-legacy-console.json, play-legacy-rows.json, play-legacy-last.json |
| Google Play 새 계정 | 자동 인증 결과 provider_blocked, 소유 계정 ID와 앱 목록 미확인 | 브라우저 인증 도구 반환값, play-primary-console.json은 인증 전 공개 페이지이며 인증 근거가 아님 |
| 앱인토스 | 작업공간 38345의 등록 문구와 출시 화면 19개 | ait-all-metadata.json, ait-rest-metadata.json, ait-release-states.json |
| 경쟁 검색 표본 | 미국 poker roguelike, baby tracker, merge puzzle, chess hints의 공식 검색 응답 | competitor-search.json |
| 첫 스크린샷 | 1차 5개 앱의 한국과 미국 9장 | screenshots.json, first-screenshots.jpg와 개별 jpg |

앱인토스 `crossword-puzzle`은 노출 중단이며, `crossword-puzzle-game`은 Console에서 현재 출시 버전 `20261023-22`가 표시됐다. 상세 위반 사유 대화상자는 일반 수정 안내만 반환했으므로 구체적인 위반 내용은 미확인이다. 토스앱 진입이나 검색 검수를 실행하지 않았다.

이 문단은 최초 점검 당시의 관측이다. 이후 사용자는 게임으로 재론칭했으므로 기존 웹앱 `crossword-puzzle`을 삭제하고 더 이상 다루지 말라고 지시했다. 현재 후속 범위에서는 기존 웹앱의 위반 원인 조사와 노출 복구를 제외한다. 실제 종료 처리 결과는 [실행 기록](execution.md)에 구분한다.

기존 수유로그와 함께봄은 서로 다른 bundle ID의 별도 공개 앱으로 확인했다. 식별자 오류로 처리하거나 등록 행을 합치지 않았다.

## 검증

| 검사 | 결과 |
| --- | --- |
| 문안 길이 | 45개 필드 모두 해당 마켓의 제목, 부제, 키워드와 짧은 설명 한도 통과 |
| test-plan 스키마 | 최신 중앙 contracts/test-plan.schema.json으로 통과 |
| 현재 Apple 텍스트 기계 검사 | AppInfo 69개, 버전 언어 레코드 111개에서 길이 초과와 Android, Google Play, 앱인토스 문자열 일치 없음. 내용과 이미지의 전체 정책 검수는 아님 |
| pnpm typecheck 최초 실행 | 오래된 로컬 Prisma 생성 코드 때문에 실패. 실패 로그 보존 |
| pnpm build | Prisma 재생성 뒤 Next 빌드 통과. 빌드용 더미 DATABASE_URL 사용, 운영 DB 변경 없음 |
| pnpm typecheck 재실행 | Prisma 재생성 뒤 통과 |
| pnpm lint | 오류 0개, 기존 release-tag-ledger.test.ts 미사용 변수 경고 1개 |
| git diff --check | 통과 |
| 실제 마켓 저장과 공식 저장값 대조 | 미실행 |
| 기기 실행과 앱 기능 회귀 | 미실행. 문서와 문구 준비 단계이며 기기가 필요한 변경 없음 |

문서와 제안 문구만 바뀌어 로컬 모델 코드 리뷰 대상이 아니다. 단위 테스트를 새로 만들거나 제품 실행 기록을 만들지 않았다. 테스트 계획의 승인을 실제 실행 증거로 대체하지 않는다.

## 원본 보존

실제 SMB 마운트 `//syous@nas1dual/Data`를 확인하고 아래 고유 폴더로 스트림 복사했다. NAS 파일을 직접 다시 읽어 57개 원본, 총 11,178,923바이트의 크기와 SHA-256을 모두 대조했다. 최초 타입 검사 실패 로그도 포함한다.

```text
/Volumes/Data/Backup/agent-artifacts/seorilabs-backoffice/2026-10-25/e49e6e4e9f33698c52b978b845aa3e4335509dbc/market-seo-20261025T035123Z
```

검증 목록: `verified-manifest.json`

```text
SHA-256 df84e8b83f5b6731b356c809ca93892db420f995b5da9fb1937eea9d13152bf7
```

보관 기간은 미정이며 별도 승인 없이 NAS 원본을 삭제하지 않는다. 복사 검증 뒤 작업 전용 로컬 원본 `Workspace/artifacts/backoffice/market-seo-20261025`를 삭제했다. 기존 공유 node_modules, 2026-08-29부터 존재한 .next 캐시와 브라우저의 인증 프로필은 보존했다. 사용한 Edge 세션 3개는 정상 반납했다.

## 최초 점검 당시 조건과 후속 실행

1. 설계 v1과 문안은 이후 사용자가 이 대화에서 “승인”했다. 승인 대상 문서 커밋은 `612c2de3d5690ec152671cfd69a2858d0bba3594`다.
2. Play 새 계정은 승인 후 정상 인증과 실제 소유 계정 ID를 확인했다.
3. 중앙 토큰 미구성에 따른 최초 차단 판정을 정정한다. `src/lib/control-plane/security.ts`는 전용 토큰이 없으면 기존 운영 토큰을 허용한다. 등록된 토큰과 고정 principal로 공식 API를 호출해 인증을 통과했다. 직접 DB 쓰기나 인증 경계 변경은 하지 않았다.
4. 승인한 저장과 검증은 [execution.md](execution.md)에 이어 기록한다. App Store 새 버전이 필요한 앱은 다음 승인된 릴리스 이슈에 연결한다.
5. 공개 확인과 변경 전후 14일 관측은 저장과 구분한다. 별도 예약 작업은 생성하지 않았다.
