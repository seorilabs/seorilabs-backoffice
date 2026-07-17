#!/usr/bin/env bash
# AppsInToss 콘솔 지표 일일 수집 → 백오피스 ingest push.
# launchd(com.seorilabs.backoffice.console-metrics)가 매일 호출한다.
# 콘솔 MCP 는 사용자 OAuth 세션이라 pod 가 pull 불가 → 인증된 로컬 claude 세션이 조회·push 한다.
#
# 자격증명: ~/.config/seorilabs/backoffice.env 에 INTERNAL_ADMIN_TOKEN(필수), BACKOFFICE_URL(선택).
#           토큰은 로그/커밋 금지. 이 스크립트는 토큰을 출력하지 않는다.
set -euo pipefail

REPO="${CONSOLE_METRICS_REPO:-/Users/syous/Repositories/seorilabs/seorilabs-backoffice}"
CONF="${SEORILABS_CONF:-$HOME/.config/seorilabs/backoffice.env}"
LOG_DIR="$HOME/Library/Logs/seorilabs"
LOG="$LOG_DIR/console-metrics.log"
mkdir -p "$LOG_DIR"

# 자격증명 로드
if [ -f "$CONF" ]; then
  set -a; . "$CONF"; set +a
fi
: "${INTERNAL_ADMIN_TOKEN:?INTERNAL_ADMIN_TOKEN 미설정 — $CONF 에 넣어라}"
: "${BACKOFFICE_URL:=https://backoffice.vzyx.xyz}"
export INTERNAL_ADMIN_TOKEN BACKOFFICE_URL

cd "$REPO"
{
  echo "=== $(date -u +%FT%TZ) console-metrics 시작 ==="
  # claude 헤드리스: 콘솔 MCP 조회 + curl push. 필요한 도구만 허용.
  claude -p "$(cat "$REPO/scripts/console-metrics/prompt.md")" \
    --allowedTools "Bash,Read,mcp__apps-in-toss-console__dashboard_dau,mcp__apps-in-toss-console__dashboard_session,mcp__apps-in-toss-console__dashboard_revenue_iaa,mcp__apps-in-toss-console__dashboard_revenue_iap,mcp__apps-in-toss-console__dashboard_retention" \
    || echo "!! claude 실행 실패 exit=$?"
  echo "=== $(date -u +%FT%TZ) console-metrics 종료 ==="
} >> "$LOG" 2>&1
