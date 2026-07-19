#!/usr/bin/env bash
# 콘솔 지표 동기화 상태(앱별 마지막 저장 날짜/수집 시각/row 수)를 backoffice 에서 읽는다.
#
# 온디맨드 수집(runbook.md)의 증분 윈도우 판정용이다: 콘솔 수집은 cron 이 아니라 대화형 Claude
# 세션이 돌리므로 마지막 동기화가 오래됐을 수 있다. 이 GET 으로 앱별 lastDate 를 받아
# startDate 를 "가장 뒤처진 앱의 lastDate − overlap" 으로 잡고, rows=0 인 앱은 백필 대상으로 처리.
#
# 자격증명: ~/.config/seorilabs/backoffice.env 의 INTERNAL_ADMIN_TOKEN(필수), BACKOFFICE_URL(선택).
# 사용: bash status.sh            # 사람이 읽는 요약(jq 있으면 표)
#      bash status.sh --raw       # 원본 JSON 그대로(파이프/파싱용)
set -euo pipefail
CONF="${SEORILABS_CONF:-$HOME/.config/seorilabs/backoffice.env}"
[ -f "$CONF" ] && { set -a; . "$CONF"; set +a; }
: "${INTERNAL_ADMIN_TOKEN:?INTERNAL_ADMIN_TOKEN 미설정 — $CONF 에 넣어라}"
: "${BACKOFFICE_URL:=https://backoffice.vzyx.xyz}"

RESP="$(curl -sS --max-time 60 -X GET \
  "$BACKOFFICE_URL/api/admin/analytics/console-collect" \
  -H "x-admin-token: $INTERNAL_ADMIN_TOKEN")"

if [ "${1:-}" = "--raw" ] || ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$RESP"
  exit 0
fi

echo "$RESP" | jq -r '
  "minLastDate=\(.minLastDate // "-")  maxLastDate=\(.maxLastDate // "-")  noData=[\(.appsWithNoData | join(","))]",
  "",
  (["slug","miniAppId","lastDate","rows","lastCollectedAt"] | @tsv),
  (.apps[] | [.slug, (.miniAppId // "-"), (.lastDate // "-"), .rows, (.lastCollectedAt // "-")] | @tsv)
' | column -t -s "$(printf '\t')"
