# 승인된 마켓 검색 개선안 적용 기록

2026-10-25, [실행 이슈 #534](https://github.com/seorilabs/seorilabs-backoffice/issues/534). 사용자가 이 대화에서 “승인”한 설계 v1과 문안의 커밋은 `612c2de3d5690ec152671cfd69a2858d0bba3594`다. 문구 자체는 승인 뒤 바꾸지 않았다.

## 적용 결과

- 중앙 설정 8개 앱에 새 ConfigRevision을 만들고 활성화했다. 5개 앱의 문안 36개, 두 마켓 대조 필드 45개를 중앙에 저장했다. 검색어는 5개 앱에 16개를 추가했으며 기존 검색어를 보존했다.
- Google Play 5개 앱, 기존 언어 등록 9건을 저장했다. 대조 필드 18개 중 기존 값과 다른 제목 6개와 짧은 설명 9개, 총 15개 필드가 바뀌었다. 저장 후 다른 언어와 상세 설명, 영상 링크, 배포 트랙과 앱 상세 정보가 유지됐는지 비교했다.
- App Store는 루시드 체스의 기존 3.0.28 제출 준비 초안에 한국어와 영어 제목, 부제와 키워드 6개 필드를 저장했다. 다른 4개 앱은 수정 가능한 기존 다음 버전이 없어 중앙에 문안을 저장하고 다음 승인된 릴리스 이슈에 연결했다.
- 적용 직후 Google Play 5개 앱은 일반 문제에 대한 빠른 검사 단계였다. 이후 16:14 KST 재조회에서 가로세로 퍼즐과 루시드 체스는 공개 문구가 일치했고, 블룸핸드와 조물조물은 검토 중이었다. 함께봄은 조직 계정 요건으로 거절됐다. App Store는 초안 저장 상태이며 심사 제출과 공개 반영은 미실행이다.

## 계정과 중앙 인증 재확인

Google Play Console에서 `SeoriLabs`, 개인 계정, 개발자 ID `7593567020638200144`와 대상 5개 패키지를 확인했다. 등록된 `shared/google-play/publisher`로 앱별 편집 생성과 조회, 저장을 수행해 접근을 확인했다. 계정 권한이나 credential은 변경하지 않았다.

앞선 문서의 중앙 저장 차단 판정을 정정한다. 전용 CONTROL_PLANE_ADMIN_TOKEN 미설정만으로 차단이라고 판단했으나, 인증 코드는 기존 INTERNAL_ADMIN_TOKEN을 허용한다. 등록된 `shared/backoffice/operator`와 고정 principal을 사용한 공식 control-plane GET이 200으로 통과했다. 같은 API의 validator, 원본 SHA 확인, 설정 revision 비교, 멱등성과 감사 기록을 거쳐 저장했다. 직접 Prisma 쓰기나 SQL 변경은 하지 않았다.

## 중앙 설정 버전

GitHub 기본 브랜치와 최신 discovery SHA를 8개 앱에서 대조했다. 조물조물은 기존 ACTIVE 설정보다 최신 discovery가 있어, 기존 payload의 다른 항목을 보존한 새 설정을 현재 소스에 결합했다. 각 앱에 생성과 활성화 감사 기록 2개씩 총 16개를 확인했다.

| 앱 | 이전 설정 | 새 ACTIVE 설정 | 적용한 범위 |
| --- | --- | --- | --- |
| babycare | 58 | 59 | 마켓 문구와 검색어 |
| bloomhand | 20 | 21 | 마켓 문구 |
| crossword-puzzle | 67 | 68 | 마켓 문구 |
| jomul | 51 | 52 | 마켓 문구 |
| lizard-tycoon | 205 | 206 | 검색어 |
| lucid-chess | 72 | 73 | 마켓 문구와 검색어 |
| reascend | 161 | 162 | 검색어 |
| spiritgate-defenders | 62 | 63 | 검색어 |

검색어 추가는 기존 국가 설정에서 총 32개 검색어와 국가 조합을 더한다. 실제 수집 결과를 새로 생성한 상태는 아니다. 기존 market-feedback 정기 수집은 매일 21:20 KST, 일일 순위 보고는 21:40 KST이며 둘 다 중지되지 않은 상태를 확인했다. 새 스케줄을 만들거나 알림을 수동 발송하지 않았다.

## Google Play 저장과 검토

같은 publisher 편집 안에서 기존 현지화 값을 읽고 제목과 짧은 설명만 교체했다. 기존 전체 설명과 영상 링크를 포함한 다른 필드는 그대로 보존했다. 편집 검사 뒤 commit하고 새 조회용 편집으로 값을 다시 읽어 대조했다. 조회용 편집은 확인 후 삭제했다.

| 앱 | 실제 바뀐 필드 | 저장 후 조회 | 적용 직후 Console |
| --- | --- | --- | --- |
| 함께봄 | 제목 1개, 짧은 설명 2개 | 일치 | 검토 전 빠른 검사 |
| 블룸핸드 | 제목 1개, 짧은 설명 2개 | 일치 | 검토 전 빠른 검사 |
| 가로세로 퍼즐 | 짧은 설명 1개 | 일치 | 검토 전 빠른 검사 |
| 조물조물 | 제목 2개, 짧은 설명 2개 | 일치 | 검토 전 빠른 검사 |
| 루시드 체스 | 제목 2개, 짧은 설명 2개 | 일치 | 검토 전 빠른 검사 |

검토 중인 다른 항목을 취소하지 않도록 commit에 `changesInReviewBehavior=ERROR_IF_IN_REVIEW`를 지정했다. `changesNotSentForReview=true`는 provider가 이 앱들의 변경을 자동으로 검토에 보낸다며 저장 전에 거부했다. 같은 편집의 실제 값을 다시 확인한 뒤 해당 선택값만 제외하고 commit했다. 기존 검토를 취소하는 기본 동작은 사용하지 않았다.

조물조물은 작업 전부터 관리형 게시가 켜져 있었으며 기존 production v1.1.2 항목 1개가 게시 준비 상태였다. 작업 후에도 해당 항목은 그대로 남아 있고, 새 스토어 등록 정보 4개만 빠른 검사에 추가됐다. 게시 버튼, 트랙과 버전을 변경하지 않았다. 다른 4개 앱의 관리형 게시 상태도 변경하지 않았다.

공식 동작 근거: [edits.commit](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit), [edits.listings.update](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.listings/update). 승인 또는 공개는 별도 readback이 필요하다.

### 빠른 검사 이후 재조회

2026-10-25 16:14 KST의 Console과 공개 상세 페이지를 대조한 결과다. 가로세로 퍼즐 한국어, 루시드 체스 한국어와 영어의 제목과 짧은 설명이 승인 문안과 일치했다. 검토 중인 앱을 공개 완료로 기록하지 않는다.

| 앱 | 확인한 상태 | 남은 조건 |
| --- | --- | --- |
| 가로세로 퍼즐 | 한국어 공개 문구 일치 | 공개 시각 이후 효과 관측 |
| 루시드 체스 | 한국어와 영어 공개 문구 일치 | 공개 시각 이후 효과 관측 |
| 블룸핸드 | 등록 정보 검토 중 | 승인과 공개값 확인 |
| 조물조물 | 등록 정보 검토 중, 기존 production 게시 대기 보존 | 검토 완료 후 기존 승인 릴리스와 게시 범위 확인 |
| 함께봄 | 업데이트 거부, 새 문구는 나중을 위해 저장 | 조직 개발자 계정 요건 해결 |

함께봄의 정책 세부정보는 `Play Console Requirements` 위반으로, 선택한 카테고리 또는 선언 기능 때문에 조직 계정으로 제출해야 한다고 명시했다. Console은 이전 버전 사용 가능을 표시했고 공개 페이지도 기존 문구를 유지했다. 계정 유형, 소유권과 App content 선언은 이번 승인 범위 밖이므로 바꾸거나 재전송하지 않았다. [babycare #151](https://github.com/seorilabs/babycare/issues/151)에 실제 거절과 해결 조건을 연결했다. 공식 기준은 [Play Console Requirements](https://support.google.com/googleplay/android-developer/answer/10788890?hl=en)이다.

## App Store 초안과 다음 릴리스

루시드 체스의 `com.etlegame.chess`, App Store ID `1041884410`을 확인한 뒤 기존 3.0.28의 PREPARE_FOR_SUBMISSION 상태만 수정했다. 두 언어의 제목과 부제, 키워드를 공식 API로 저장하고 다시 읽었다. 상세 설명, 홍보 문구, 출시 노트와 지원 URL은 그대로다.

두 언어의 iPhone과 iPad 스크린샷 36장을 직접 보고 기능과 다른 마켓 표시 여부를 확인했다. 미리보기는 없었다. 모든 이미지 처리는 COMPLETE였으며 저장 후 36개 이미지의 식별자와 checksum이 같은지 확인했다. 공개 AppInfo와 제출 준비 AppInfo는 구분한다. 새 버전 생성, 빌드 업로드와 선택, 심사 제출은 하지 않았다.

다음 4개 앱은 수정 가능한 기존 다음 버전이 없었다. 임의 버전으로 확장하지 않고 다음 승인된 릴리스에서 중앙 문안을 읽도록 연결했다.

| 앱 | 다음 App Store 릴리스 작업 |
| --- | --- |
| babycare | [#150](https://github.com/seorilabs/babycare/issues/150) |
| bloomhand | [#92](https://github.com/seorilabs/bloomhand/issues/92) |
| crossword-puzzle | [#448](https://github.com/seorilabs/crossword-puzzle/issues/448) |
| jomul | [#217](https://github.com/seorilabs/jomul/issues/217) |

이 후속 이슈는 새 버전이나 바이너리 출시 승인으로 사용하지 않는다. 해당 앱의 기존 릴리스 승인과 테스트 계획 안에서 문구를 반영하고 모든 활성 언어와 이미지를 다시 검수한다. 앱인토스의 등록 정보와 노출 중단 상태는 이번 1차 적용으로 바꾸지 않았다.

## 관측과 검증

- 중앙 설정 8개의 payload를 계획한 값과 대조했다. localizations와 monitoring.keywords 외의 모든 항목이 보존됐다.
- 설정 생성과 활성화 감사 16개를 확인했다. 적용 직후 provider 저장 조회 6개를 ProviderObservation으로 기록했다. 이후 Google Play 최종 상태 5개를 새 관측으로 추가해 공개 확인 2개, 검토 중 2개, 거절 1개를 구분했다. App Store는 DRAFT_SAVED와 PREPARE_FOR_SUBMISSION이며 공개 상태로 올리지 않았다.
- Google Play는 9개 등록 언어의 저장값과 보호 필드, 기존 트랙과 앱 상세 정보가 일치했다. 전체 18개 대상 필드 중 15개를 실제로 변경했다.
- App Store는 6개 필드가 승인 문안과 일치하고 나머지 텍스트와 스크린샷이 보존됐다. 36장 검수는 마켓 이미지 검수이며 기기 실행 증거가 아니다.
- pnpm typecheck, pnpm lint, 더미 DATABASE_URL을 사용한 pnpm build가 통과했다. lint에는 기존 미사용 변수 경고 1개가 있다. 제품 코드는 변경하지 않아 추가 기능 회귀나 기기 실행을 만들지 않았다.
- 순위와 설치 전환의 개선 효과는 아직 측정하지 않았다. 공개값 확인 시각 이후의 14일을 기존 기준선과 비교하며 미확보 지표를 0으로 채우지 않는다.

## 실행 원본 보존

실제 nas1dual의 Data SMB 마운트를 확인하고 원시 API 응답, Console 상태, 최초 실패와 정정 과정, 스크린샷과 검증 로그 83개, 총 14,421,325바이트를 아래 고유 폴더로 스트림 복사했다. NAS 사본을 직접 읽어 모든 파일의 크기와 SHA-256을 대조했다.

```text
/Volumes/Data/Backup/agent-artifacts/seorilabs-backoffice/2026-10-25/612c2de3d5690ec152671cfd69a2858d0bba3594/market-seo-apply-20261025T071039Z
```

검증 목록은 `verified-manifest.json`이며 SHA-256은 아래와 같다.

```text
21455dbe02197931fff6f6f6c17a42a9ef1c0493410326cb8d4b302b59f5ee68
```

후속 공개 상태 조회가 필요하면 별도 검증 목록으로 보존한다. 원본 보관 기간은 미정이며 추가 승인 전 NAS 원본을 삭제하지 않는다. 작업 전용 로컬 원본과 요청용 임시 파일은 최종 조회와 이관 검증 후 정리한다. 공유 캐시, 기존 인증 프로필과 사용자 작업은 보존한다.
