#!/usr/bin/env bash
# 콘솔 지표 payload(JSON)를 백오피스 ingest 로 POST 한다(토큰 취급 분리).
#
# 수집은 온디맨드다: 콘솔 MCP(mcp.toss.im)는 대화형 세션 OAuth 로만 인증되고 토큰이 짧게
# 만료돼 headless/무인 실행이 불가능하다(cloud routine·claude -p 모두 'Needs auth'). 따라서
# 대화형 Claude 세션이 MCP dashboard_* 로 지표를 조회·정규화해 payload 를 만들고 이 스크립트로
# push 한다. 절차는 runbook.md 참고.
#
# 자격증명: ~/.config/seorilabs/backoffice.env 의 INTERNAL_ADMIN_TOKEN(필수), BACKOFFICE_URL(선택).
# 사용: bash push.sh /path/to/payload.json
set -euo pipefail
PAYLOAD="${1:?payload JSON 경로 필요 — 사용: bash push.sh payload.json}"
CONF="${SEORILABS_CONF:-$HOME/.config/seorilabs/backoffice.env}"
[ -f "$CONF" ] && { set -a; . "$CONF"; set +a; }
: "${INTERNAL_ADMIN_TOKEN:?INTERNAL_ADMIN_TOKEN 미설정 — $CONF 에 넣어라}"
: "${BACKOFFICE_URL:=https://backoffice.vzyx.xyz}"
curl -sS --max-time 120 -w '\nHTTP %{http_code}\n' -X POST \
  "$BACKOFFICE_URL/api/admin/analytics/console-collect" \
  -H "x-admin-token: $INTERNAL_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @"$PAYLOAD"
