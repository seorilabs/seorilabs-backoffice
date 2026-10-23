# 책 판매 수집

등록된 KDP 독립 Edge를 재사용하고 공식 XLSX를 월별로 내려받는다. 현재 월과 이전 두 달을 매일 09:00 KST에 다시 수집한다. 서버는 계정과 월별 최신 성공 관측을 조회하고 인증 실패 시 이전 성공 데이터를 보존한다.

## 전제와 실행

- `shared/browser-login/kdp-wellknowngeek`와 `shared/backoffice/operator`가 활성 상태여야 한다. 원본은 `~/.config/seorilabs`이며 비밀값과 쿠키를 서버로 복사하지 않는다.
- `~/.agent/scripts/agent_browser.py`, 공용 Playwright Python과 로그인된 KDP 전용 Edge가 필요하다. 최초 인증과 추가 인증은 브라우저 세션 스킬로 처리한다. 예약 실행은 비밀번호나 인증번호를 반복 제출하지 않는다.
- NAS의 `/Volumes/Data/Backup/agent-artifacts`가 연결돼 있어야 한다. 원본은 `book-sales/<UTC 날짜>/<SHA-256>.xlsx`에 저장하고 크기와 해시를 확인한 뒤 로컬 다운로드를 삭제한다.

```bash
PY=~/.local/share/seorilabs/playwright/venv/bin/python
# 실제 다운로드와 파싱, NAS 보관. 서버 전송은 하지 않는다.
$PY scripts/book-sales/collect.py --since 2026-10 --dry-run
# 초기 이력. 시작 월부터 현재 월까지 수집한다.
$PY scripts/book-sales/collect.py --since 2026-01
# 정기 수집과 같은 최근 세 달 실행
$PY scripts/book-sales/collect.py
# 해당 월의 저장 결과를 다시 조회
$PY scripts/book-sales/collect.py --status --since 2026-10
# 검증과 병합된 커밋에서 처음 설치한다.
$PY scripts/book-sales/install_launchd.py
# 기존 설치 교체: 현재 커밋, 설치 해시와 실행 상태를 검사하고 bootstrap 실패 시 복구한다.
$PY scripts/book-sales/install_launchd.py --replace-source <기존_40자리_SHA>
launchctl print gui/$(id -u)/xyz.seorilabs.book-sales
```

`--session`은 현재 작업이 직접 배정받은 세션에만 사용한다. 예약 작업은 자기 프로세스 소유로 새 lease를 배정받고 `finally`에서 반납한다. 다른 작업의 세션은 지정하지 않는다. Mac이 자거나 꺼져 있으면 정시 수집을 보장하지 않는다. 잠든 동안 지난 예약은 깨어난 뒤 실행되며 최근 세 달 재조회로 누락을 보정한다.

API는 `GET /api/admin/book-sales?month=YYYY-MM`과 `POST /api/admin/book-sales`이며 기존 `x-admin-token`을 사용한다. HTTP 전송과 리다이렉트로 토큰이 외부에 나가는 것을 거부한다. 개발 환경의 localhost HTTP만 예외다. 정상 응답은 `state`, `lastAttemptAt`, `lastSuccessfulAt`, `periodEnd`, `sourceHash`, `books`, `totals`를 포함한다. `state=needs_input`의 이전 성공 수량은 현재 재수집 결과가 아니다.

## 숫자의 의미

판형별 Royalty의 `unitsSold`, `refunds`, `netUnits`와 예상 로열티를 별도로 집계한다. Orders Processed는 `paidOrders`, `freeOrders`, KENP는 읽은 페이지와 들은 페이지다. 같은 판매가 Combined Sales와 Summary에도 있으므로 이 두 시트의 금액을 다시 더하지 않는다. Summary는 소계 검증에만 사용한다.

정규화한 보고서는 최대 8,000행, 전송 본문은 24MiB까지 허용하며 Ingress의 25MiB 한도 안에 둔다. 수집 상태 화면은 원본 판매 행을 읽지 않는다.

통화는 합치지 않는다. KDP 원본의 달력일과 월 단위를 보존하며 시간대는 `marketplace-local`이다. 확정 로열티와 실제 지급은 연결하지 않았으므로 `confirmedRoyalties`와 `payments`는 `null`이다. 필수 시트가 모두 있는 빈 보고서만 0건이며, 형식 변경이나 인증 실패는 0건으로 저장하지 않는다.

`SourceCollectionRun`의 `source=book-sales-kdp`, `target=<계정>:<월>`에 정규화된 전체 관측을 저장한다. 재전송은 실행 ID로 구분하며 같은 ID에 다른 내용을 보내면 HTTP 409다. DB schema와 중앙 설정은 바꾸지 않는다.

## 상태와 복구

로컬 마지막 결과는 `~/.local/state/seorilabs/book-sales/last-result.json`에 남고 launchd 로그는 `~/Library/Logs/Seorilabs/book-sales*.log`에 남는다. KDP 인증과 다운로드 실패는 서버 수집 이력에 기록한다. 서버 자체에 연결할 수 없으면 로컬 실패 상태만 남는다. 현재 월과 최근 두 달의 성공 관측이 36시간보다 오래됐으면 조회 상태가 `stale`이다.

`KDP_AUTH_REQUIRED`가 발생하면 자기 독립 Edge에서 등록 계정을 확인하고 재인증한 뒤 같은 수집기를 다시 실행한다. 비밀번호 거부, 보안키, CAPTCHA를 우회하거나 세션 쿠키를 다른 프로필로 복사하지 않는다. NAS 오류면 원본을 삭제하지 않으며 NAS 연결을 복구한 뒤 수집한다. 실패한 다운로드의 원본이 로컬 세션에 남았는지도 확인해 NAS 이관 후 정리한다.

중단은 `launchctl bootout gui/$(id -u)/xyz.seorilabs.book-sales`로 이 작업만 해제한다. 보고서 이력과 다른 브라우저 작업은 보존한다. 다음 자연 예약 실행은 실제 실행 뒤 별도로 확인한다.

판매 내용 변경 알림과 전체 수집 실행 결과는 [서비스 배치 결과 알림](../../docs/OPERATIONS_BATCH_RESULTS.md)을 따른다.
