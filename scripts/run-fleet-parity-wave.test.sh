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
  echo "job.batch/backoffice-fleet-parity-test"
  exit 0
fi
if [[ "$args" == *"get job/backoffice-fleet-parity-test"*"containers[0].image"* ]]; then
  printf '%s' "$FAKE_IMAGE"
  exit 0
fi
if [[ "$args" == *"get job/backoffice-fleet-parity-test"*"source-sha"* ]]; then
  printf '%s' "$FAKE_SHA"
  exit 0
fi
if [[ "$args" == *"get job/backoffice-fleet-parity-test"*"status.conditions"* ]]; then
  case "${FAKE_JOB_RESULT:-complete}" in
    complete) echo "Complete=True" ;;
    failed) echo "Failed=True" ;;
    pending) : ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "$args" == *"logs job/backoffice-fleet-parity-test -c parity-wave --tail=1"* ]]; then
  printf '%s\n' "${FAKE_EVIDENCE:-{\"schemaVersion\":1,\"status\":\"PASSED\"}}"
  exit 0
fi
if [[ "$args" == *"get job/backoffice-fleet-parity-test -o wide"* ]]; then
  echo "sanitized job state"
  exit 0
fi
echo "unsupported fake kubectl call: $args" >&2
exit 2
FAKE
chmod +x "$fake"

image="registry.example.test/backoffice@sha256:$(printf 'a%.0s' {1..64})"
sha="$(printf 'b%.0s' {1..40})"

run_wave() {
  env \
    KUBECTL_BIN="$fake" \
    FAKE_IMAGE="$image" \
    FAKE_SHA="$sha" \
    BACKOFFICE_IMAGE="$image" \
    BACKOFFICE_SOURCE_SHA="$sha" \
    BACKOFFICE_FLEET_PARITY_POLL_SECONDS=1 \
    "$@" \
    "$here/run-fleet-parity-wave.sh"
}

echo "== Complete Job은 sanitized PASSED evidence까지 확인한다 =="
output="$(run_wave FAKE_JOB_RESULT=complete)"
grep -q 'fleet_parity_job=backoffice-fleet-parity-test' <<< "$output"
grep -q '"status":"PASSED"' <<< "$output"
echo "  ok   exact image/source와 PASSED evidence"

echo "== BLOCKED Job은 timeout 전에 sanitized evidence를 남기고 실패한다 =="
started="$SECONDS"
if run_wave \
    FAKE_JOB_RESULT=failed \
    FAKE_EVIDENCE='{"schemaVersion":1,"status":"BLOCKED","reasonCodes":["TRANSFORM_NEEDS_INPUT"]}' \
    BACKOFFICE_FLEET_PARITY_TIMEOUT_SECONDS=30 >"$tmp/blocked.out" 2>&1; then
  echo "FAIL BLOCKED Job이 통과했다" >&2
  exit 1
fi
if (( SECONDS - started >= 5 )); then
  echo "FAIL BLOCKED Job 판정이 지연됐다" >&2
  exit 1
fi
grep -q '"status":"BLOCKED"' "$tmp/blocked.out"
grep -q '자동 재실행하지 않는다' "$tmp/blocked.out"
echo "  ok   terminal failure fail-fast"

echo "== Pending Job은 제한된 timeout 뒤 실패한다 =="
if run_wave FAKE_JOB_RESULT=pending BACKOFFICE_FLEET_PARITY_TIMEOUT_SECONDS=1 \
    >"$tmp/timeout.out" 2>&1; then
  echo "FAIL pending Job이 통과했다" >&2
  exit 1
fi
grep -q 'Fleet parity wave timeout: 1s' "$tmp/timeout.out"
echo "  ok   bounded timeout"

echo "run-fleet-parity-wave 계약 통과"
