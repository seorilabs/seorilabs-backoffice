#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fake="$tmp/kubectl"
cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

args="$*"
if [[ "$args" == "create -f - -o name" ]]; then
  cat >/dev/null
  echo "job.batch/backoffice-restore-rehearsal-test"
  exit 0
fi
if [[ "$args" == *"get job/backoffice-restore-rehearsal-test"*"jsonpath={range .status.conditions"* ]]; then
  case "${FAKE_JOB_RESULT:-complete}" in
    complete) echo "Complete=True" ;;
    failed) echo "Failed=True" ;;
    pending) : ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "$args" == *"get job/backoffice-restore-rehearsal-test -o wide"* ]]; then
  echo "sanitized job state"
  exit 0
fi
if [[ "$args" == *"get job/backoffice-restore-rehearsal-test"*"containers[2].image"* ]]; then
  printf '%s' "$FAKE_IMAGE"
  exit 0
fi
if [[ "$args" == *"get job/backoffice-restore-rehearsal-test"*"source-sha"* ]]; then
  printf '%s' "$FAKE_SHA"
  exit 0
fi
if [[ "$args" == *"logs job/backoffice-restore-rehearsal-test -c verify --tail=1"* ]]; then
  printf '%s\n' "${FAKE_EVIDENCE:-{\"schemaVersion\":1,\"status\":\"PASSED\"}}"
  exit 0
fi
echo "unsupported fake kubectl call: $args" >&2
exit 2
FAKE
chmod +x "$fake"

image="registry.example.test/backoffice@sha256:$(printf 'a%.0s' {1..64})"
sha="$(printf 'b%.0s' {1..40})"
dump="backoffice-20260828T010203Z.sql.gz"

run_restore() {
  env \
    KUBECTL_BIN="$fake" \
    FAKE_IMAGE="$image" \
    FAKE_SHA="$sha" \
    BACKOFFICE_IMAGE="$image" \
    BACKOFFICE_SOURCE_SHA="$sha" \
    BACKOFFICE_RESTORE_DUMP_BASENAME="$dump" \
    BACKOFFICE_RESTORE_POLL_SECONDS=1 \
    "$@" \
    "$here/run-restore-rehearsal.sh"
}

echo "== Complete Job은 sanitized PASSED evidence까지 확인한다 =="
output="$(run_restore FAKE_JOB_RESULT=complete)"
grep -q 'restore_rehearsal_job=backoffice-restore-rehearsal-test' <<< "$output"
grep -q '"status":"PASSED"' <<< "$output"
echo "  ok   exact image/source와 PASSED evidence"

echo "== Failed Job은 timeout을 기다리지 않고 즉시 실패한다 =="
started="$SECONDS"
if run_restore FAKE_JOB_RESULT=failed BACKOFFICE_RESTORE_TIMEOUT_SECONDS=30 \
    >"$tmp/failed.out" 2>&1; then
  echo "FAIL Failed Job이 통과했다" >&2
  exit 1
fi
if (( SECONDS - started >= 5 )); then
  echo "FAIL Failed Job 판정이 지연됐다" >&2
  exit 1
fi
grep -q 'secret 보호를 위해 자동 로그 출력은 하지 않는다' "$tmp/failed.out"
echo "  ok   terminal failure fail-fast"

echo "== Pending Job은 제한된 timeout 뒤 실패한다 =="
if run_restore FAKE_JOB_RESULT=pending BACKOFFICE_RESTORE_TIMEOUT_SECONDS=1 \
    >"$tmp/timeout.out" 2>&1; then
  echo "FAIL pending Job이 통과했다" >&2
  exit 1
fi
grep -q 'restore rehearsal Job timeout: 1s' "$tmp/timeout.out"
echo "  ok   bounded timeout"

echo "run-restore-rehearsal 계약 통과"
