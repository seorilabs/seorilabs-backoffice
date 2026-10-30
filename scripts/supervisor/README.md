# 개인 대표 에이전트 실행기

설계와 승인 범위는 [정본](../../docs/design/2026-10-30-personal-supervisor/design.md)을 따른다. 서버가 관측, 제안, 사람 결정과 실행의 정본이다. 로컬 경로와 기존 자격증명은 PC에 둔다. 실행기는 Codex를 사용하며 Claude, Gemini와 MiniMax는 승인한 제안의 도구 범위와 현행 전문 스킬에 따라 사용한다. 한도나 거절을 다른 계정과 유료 API로 우회하지 않는다.

## 설정과 설치

`~/.config/seorilabs/supervisor.json`을 0600으로 만들고 확인된 대상만 연결한다.

```json
{
  "url": "https://backoffice.vzyx.xyz",
  "machineId": "Ilhwanui-MacBookAir",
  "credentialFile": "~/.config/seorilabs/backoffice.env",
  "analysisRoot": "~/.agent",
  "targets": {
    "environment:agent": {
      "name": "공통 에이전트 환경",
      "kind": "ENVIRONMENT",
      "path": "~/.agent",
      "repository": "magicsih/agent-config"
    }
  }
}
```

앱은 `/api/supervisor/sources`의 최신 중앙 등록 대상과 실제 존재하는 checkout을 연결한다. 앱의 `appId`, `repository`, 최신 `policySha`는 서버에서 검증한다. 제외 대상, 경로가 없거나 확인되지 않은 프로젝트는 추가하지 않는다. 책과 집필 폴더도 확인한 항목만 등록한다.

```sh
python3 scripts/supervisor/install.py --config ~/.config/seorilabs/supervisor.json --start
launchctl print gui/$(id -u)/com.seorilabs.personal-supervisor
```

서버 웹 Deployment에는 `SUPERVISOR_OWNER_LOGIN`, `SUPERVISOR_SLACK_OWNER_ID`, `SUPERVISOR_MACHINE_ID`의 공개 식별자를 설정한다. 기존 `INTERNAL_ADMIN_TOKEN`과 Slack 서명 키를 재사용한다. 모델 환경에는 이 값을 전달하지 않는다. 인증 파일을 CLI 인자와 로그에 넣지 않는다. 기존 중앙 worker와 adapter 권한은 이 API와 별개이며 잠금을 바꾸지 않는다.

새 서버 상태는 `OBSERVE`다. 관측은 PC가 깨어 있을 때 서버 시각을 기준으로 매시간 갱신하며, 오전 9시 이후 하루 한 번 30분 이내로 후보를 검토한다. 후보가 없으면 제안 메시지를 보내지 않는다. `/work/supervisor`에서 관찰 결과를 확인한 뒤 `제안 발송과 승인 실행`으로 바꾸면 같은 시각 규칙으로 최대 3건을 발송한다. 사람만 진행, 보류, 제외와 취소를 결정한다.

## 복구와 정지

`~/.local/state/seorilabs/supervisor`에는 전송 중인 보고, claim 요청 식별자와 세션 및 프로세스 식별자만 둔다. 전체 CLI 스트림은 저장하지 않는다. `--last`로 임의 세션을 선택하지 않는다. 실행 실패는 자동 재시도하지 않으므로 최대 1회 한도를 넘지 않는다. 결과가 불명확한 쓰기는 재실행하지 않는다.

heartbeat 실패와 시간 초과에는 자식 프로세스 그룹을 중단한다. 재시작 후 정확한 프로세스 시작 정보와 실제 Git 상태를 확인한다. 외부 결과가 남으면 전역 잠금은 유지한다. 웹에 실제 PR이나 공급자 결과 근거를 기록한 뒤 잠금을 해제한다. 새로운 구현은 새 검토본을 승인받는다. 취소 후 늦은 성공 보고는 거부한다.

신규 관측과 claim을 멈추려면 웹에서 `관측과 신규 실행 중지`를 고른다. 실행 중 작업은 계속 상태를 보고하며 별도 중단 요청으로 멈춘다. 로컬 실행기를 중단할 때는 아래 명령을 사용한다. 승인, 관측과 실행 이력, 미반영 worktree는 삭제하지 않는다.

```sh
launchctl bootout gui/$(id -u)/com.seorilabs.personal-supervisor
```

완료한 실행의 테스트 로그와 검토 산출물은 공통 NAS 검증 절차로 이관한다. 설치나 정적 검사, 가짜 CLI 실행을 자연 관측이나 실제 승인 실행의 증거로 표시하지 않는다.

## 개발 검증

`python3 -m unittest discover -s scripts/supervisor -p 'test_*.py'`, `pnpm test`, 필수 정적 검사를 실행한다. 실제 MySQL 검수는 로컬 `supervisor_test` 또는 CI의 `backoffice_*_contract_test` DB에서만 허용한다. `dev-fixture.ts`는 127.0.0.1:33367의 전용 DB만 허용하며 개발용 JWT를 비공개 산출물 폴더에 쓴다. 인증을 끄는 테스트 경로는 없다.
