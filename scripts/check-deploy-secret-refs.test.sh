#!/usr/bin/env bash
#
# check-deploy-secret-refs.sh 계약. fake kubectl은 YAML을 저장소 yaml 패키지로 JSON으로
# 바꾸고, SealedSecret 조회는 $FAKE_SEALED_DIR/<ns>/<name>.json 고정 자료로 응답한다.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fake="$tmp/kubectl"
log="$tmp/kubectl.log"
sealed_dir="$tmp/sealed"

cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_KUBECTL_LOG:?}"
: "${FAKE_SEALED_DIR:?}"
: "${FAKE_YAML_TO_JSON:?}"

args="$*"

if [[ "$args" == "create --dry-run=client -o json --validate=false "* ]]; then
  printf 'PARSE\n' >> "$FAKE_KUBECTL_LOG"
  if [ "${FAKE_PARSE_FAIL:-false}" = true ]; then
    printf 'error: unable to recognize "x.yaml": no matches for kind\n' >&2
    exit 1
  fi
  files=()
  shift 5
  while [ "$#" -gt 0 ]; do
    [ "$1" = -f ] || { printf 'unexpected arg: %s\n' "$1" >&2; exit 1; }
    files+=("$2")
    shift 2
  done
  node "$FAKE_YAML_TO_JSON" "${files[@]}"
  exit
fi

if [[ "$args" =~ ^-n\ ([a-z0-9-]+)\ get\ sealedsecret\ ([a-z0-9-]+)\ -o\ json$ ]]; then
  ns="${BASH_REMATCH[1]}"
  name="${BASH_REMATCH[2]}"
  printf 'READ_SEALED %s/%s\n' "$ns" "$name" >> "$FAKE_KUBECTL_LOG"
  if [ -f "$FAKE_SEALED_DIR/$ns/$name.forbidden" ]; then
    printf 'Error from server (Forbidden): sealedsecrets.bitnami.com "%s" is forbidden: User "system:serviceaccount:platform:ci-deployer" cannot get resource "sealedsecrets"\n' "$name" >&2
    exit 1
  fi
  if [ ! -f "$FAKE_SEALED_DIR/$ns/$name.json" ]; then
    printf 'Error from server (NotFound): sealedsecrets.bitnami.com "%s" not found\n' "$name" >&2
    exit 1
  fi
  cat "$FAKE_SEALED_DIR/$ns/$name.json"
  exit 0
fi

printf '지원하지 않는 fake kubectl 호출: %s\n' "$args" >&2
exit 1
FAKE
chmod +x "$fake"

# 저장소 SealedSecret을 현재 generation이 동기화된 클러스터 객체로 만든다.
sealed_from_repo() {
  local file="$1"
  local name
  name="$(node "$here/fixtures/yaml-to-json.cjs" "$file" | jq -r '.metadata.name')"
  mkdir -p "$sealed_dir/platform"
  node "$here/fixtures/yaml-to-json.cjs" "$file" \
    | jq '.metadata.generation = 3 | .status = {observedGeneration: 3, conditions: [{type: "Synced", status: "True"}]}' \
    > "$sealed_dir/platform/$name.json"
}

# 키 목록만으로 동기화된 SealedSecret 고정 자료를 만든다.
sealed_with_keys() {
  local ns="$1" name="$2"
  shift 2
  mkdir -p "$sealed_dir/$ns"
  jq -n --arg ns "$ns" --arg name "$name" --args '
    {
      apiVersion: "bitnami.com/v1alpha1",
      kind: "SealedSecret",
      metadata: {name: $name, namespace: $ns, generation: 1},
      spec: {encryptedData: ($ARGS.positional | map({key: ., value: "AgCIPHER\(.)"}) | from_entries)},
      status: {observedGeneration: 1, conditions: [{type: "Synced", status: "True"}]}
    }' "$@" > "$sealed_dir/$ns/$name.json"
}

edit_sealed() {
  local path="$sealed_dir/$1.json" filter="$2"
  jq "$filter" "$path" > "$path.tmp"
  mv "$path.tmp" "$path"
}

reset_sealed() {
  rm -rf "$sealed_dir"
  mkdir -p "$sealed_dir"
}

out="$tmp/out"
err="$tmp/err"

run_check() {
  : > "$log"
  FAKE_KUBECTL_LOG="$log" \
  FAKE_SEALED_DIR="$sealed_dir" \
  FAKE_YAML_TO_JSON="$here/fixtures/yaml-to-json.cjs" \
  FAKE_PARSE_FAIL="${FAKE_PARSE_FAIL:-false}" \
  KUBECTL_BIN="$fake" \
  BACKOFFICE_NAMESPACE=platform \
  "$here/check-deploy-secret-refs.sh" "$@" > "$out" 2> "$err"
}

expect_pass() {
  local label="$1"
  shift
  if ! run_check "$@"; then
    echo "FAIL $label: 통과해야 하는데 실패했다" >&2
    cat "$err" >&2
    exit 1
  fi
  echo "  ok   $label"
}

expect_fail() {
  local label="$1" needle="$2"
  shift 2
  if run_check "$@"; then
    echo "FAIL $label: 실패해야 하는데 통과했다" >&2
    cat "$out" >&2
    exit 1
  fi
  if ! grep -qF -- "$needle" "$err"; then
    echo "FAIL $label: 오류 출력에 '$needle'이 없다" >&2
    cat "$err" >&2
    exit 1
  fi
  echo "  ok   $label"
}

# deploy-backoffice.sh가 점검하는 실제 매니페스트 목록을 그대로 쓴다.
deploy_manifests=()
while IFS= read -r manifest; do
  deploy_manifests+=("$root/k8s/$manifest")
done < <(awk '
  /^secret_ref_manifests=\($/ { inside = 1; next }
  inside && /^\)$/ { exit }
  inside { gsub(/[[:space:]]/, ""); if ($0 != "") print }
' "$here/deploy-backoffice.sh")
if [ "${#deploy_manifests[@]}" -lt 10 ]; then
  echo "FAIL deploy-backoffice.sh의 secret_ref_manifests 목록을 읽지 못했다" >&2
  exit 1
fi

load_repo_sealed() {
  reset_sealed
  local file
  for file in "$root"/k8s/*sealedsecret*.yaml; do
    sealed_from_repo "$file"
  done
}

echo "== AC8 현재 저장소 매니페스트와 저장소 SealedSecret 조합은 통과한다 =="
load_repo_sealed
expect_pass "저장소 배포 매니페스트 ${#deploy_manifests[@]}개" "${deploy_manifests[@]}"
grep -q '^secret_refs=PASS ' "$out"
grep -q '^READ_SEALED platform/backoffice-secrets$' "$log"
grep -q '^READ_SEALED platform/backoffice-app-ops-secrets$' "$log"
grep -q '^READ_SEALED platform/platform-deployment-approvers$' "$log"
if grep -q 'registry-pull-cred' "$log"; then
  echo "FAIL imagePullSecrets까지 SealedSecret으로 요구했다" >&2
  exit 1
fi
echo "  ok   env, volume 참조 시크릿만 조회하고 imagePullSecrets는 제외"

echo "== AC1·AC7 2026-11-15 장애 재현: 클러스터 SealedSecret에 키가 없으면 실패한다 =="
load_repo_sealed
edit_sealed platform/backoffice-secrets 'del(.spec.encryptedData.SLACK_CHANNEL_METRIC_INSIGHTS_ID)'
expect_fail "누락 키 이름" "platform/backoffice-secrets: SLACK_CHANNEL_METRIC_INSIGHTS_ID" "${deploy_manifests[@]}"
grep -qF 'kubectl apply -f k8s/backoffice-sealedsecret.yaml' "$err"
echo "  ok   적용할 저장소 파일 안내"
leaked=0
while IFS= read -r cipher; do
  if grep -qF -- "${cipher:0:32}" "$out" "$err"; then
    leaked=1
  fi
done < <(jq -r '.spec.encryptedData[]' "$sealed_dir/platform/backoffice-secrets.json")
if [ "$leaked" -ne 0 ]; then
  echo "FAIL 출력에 암호문이 나왔다" >&2
  exit 1
fi
echo "  ok   출력에 암호문 없음"

echo "== AC5 참조 형식별 추출 =="
cat > "$tmp/forms.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: forms-web
  namespace: platform
spec:
  selector: { matchLabels: { app: forms } }
  template:
    metadata: { labels: { app: forms } }
    spec:
      initContainers:
        - name: init
          image: busybox
          env:
            - name: INIT_TOKEN
              valueFrom: { secretKeyRef: { name: app-secrets, key: INIT_TOKEN } }
      containers:
        - name: web
          image: busybox
          env:
            - name: BLOCK_STYLE
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: BLOCK_STYLE
            - name: FLOW_STYLE
              valueFrom: {secretKeyRef: {name: app-secrets, key: FLOW_STYLE}}
            - name: OPTIONAL_KEY
              valueFrom: { secretKeyRef: { name: app-secrets, key: OPTIONAL_KEY, optional: true } }
            - name: FIELD_REF
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
          envFrom:
            - secretRef: { name: whole-env }
            - secretRef: { name: optional-env, optional: true }
      volumes:
        - name: token
          secret:
            secretName: app-secrets
            items:
              - key: VOLUME_ITEM
                path: token
        - name: whole
          secret: { secretName: whole-volume }
        - name: optional-volume
          secret: { secretName: optional-volume, optional: true }
        - name: projected
          projected:
            sources:
              - secret:
                  name: projected-secrets
                  items:
                    - key: PROJECTED_ITEM
                      path: p
        - name: scratch
          emptyDir: {}
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: forms-cron
  namespace: other
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: job
              image: busybox
              env:
                - name: CRON_KEY
                  valueFrom: { secretKeyRef: { name: app-secrets, key: CRON_KEY } }
YAML

load_forms_sealed() {
  reset_sealed
  sealed_with_keys platform app-secrets INIT_TOKEN BLOCK_STYLE FLOW_STYLE VOLUME_ITEM
  sealed_with_keys platform whole-env
  sealed_with_keys platform whole-volume
  sealed_with_keys platform projected-secrets PROJECTED_ITEM
  sealed_with_keys other app-secrets CRON_KEY
}

load_forms_sealed
expect_pass "모든 형식의 필수 참조가 있으면 통과" "$tmp/forms.yaml"
grep -q '^secret_refs=PASS secrets=5 keys=6$' "$out"
echo "  ok   시크릿 5개, 키 6개 집계"
if grep -q 'optional-env\|optional-volume' "$log"; then
  echo "FAIL optional 시크릿 전체 참조를 조회했다" >&2
  exit 1
fi
echo "  ok   AC2 optional 참조는 요구하지 않는다"

for key in INIT_TOKEN BLOCK_STYLE FLOW_STYLE VOLUME_ITEM; do
  load_forms_sealed
  edit_sealed platform/app-secrets "del(.spec.encryptedData.$key)"
  expect_fail "$key 누락" "platform/app-secrets: $key" "$tmp/forms.yaml"
done
load_forms_sealed
edit_sealed platform/projected-secrets 'del(.spec.encryptedData.PROJECTED_ITEM)'
expect_fail "projected 키 누락" "platform/projected-secrets: PROJECTED_ITEM" "$tmp/forms.yaml"
load_forms_sealed
edit_sealed other/app-secrets 'del(.spec.encryptedData.CRON_KEY)'
expect_fail "CronJob은 자기 namespace의 SealedSecret을 본다" "other/app-secrets: CRON_KEY" "$tmp/forms.yaml"
for whole in whole-env whole-volume; do
  load_forms_sealed
  rm "$sealed_dir/platform/$whole.json"
  expect_fail "$whole 시크릿 전체 참조" "platform/$whole" "$tmp/forms.yaml"
done

echo "== template.data의 평문 키도 제공 키로 인정한다 =="
load_forms_sealed
edit_sealed platform/app-secrets 'del(.spec.encryptedData.FLOW_STYLE) | .spec.template.data.FLOW_STYLE = "plain"'
expect_pass "template.data 키" "$tmp/forms.yaml"

echo "== AC2 optional 키는 SealedSecret에 없어도 통과한다 =="
load_forms_sealed
if jq -e '.spec.encryptedData | has("OPTIONAL_KEY")' "$sealed_dir/platform/app-secrets.json" >/dev/null; then
  echo "FAIL 고정 자료에 OPTIONAL_KEY가 들어 있다" >&2
  exit 1
fi
expect_pass "optional secretKeyRef 누락" "$tmp/forms.yaml"

echo "== AC3 SealedSecret 조회 실패는 통과로 보지 않는다 =="
load_forms_sealed
rm "$sealed_dir/platform/app-secrets.json"
expect_fail "SealedSecret 없음" "NotFound" "$tmp/forms.yaml"
load_forms_sealed
rm "$sealed_dir/platform/app-secrets.json"
: > "$sealed_dir/platform/app-secrets.forbidden"
expect_fail "조회 거부" "Forbidden" "$tmp/forms.yaml"
grep -qF 'kubectl apply -f k8s/ci-deployer-rbac.yaml' "$err"
if grep -q '저장소에 platform/app-secrets SealedSecret 매니페스트가 없다' "$err"; then
  echo "FAIL 권한 거부를 SealedSecret 누락으로 안내했다" >&2
  exit 1
fi
echo "  ok   권한 거부는 배포 계정 권한 적용을 안내"
load_forms_sealed
rm "$sealed_dir/platform/app-secrets.json"
expect_fail "NotFound는 SealedSecret 적용을 안내" "저장소에 platform/app-secrets SealedSecret 매니페스트가 없다" "$tmp/forms.yaml"

echo "== AC4 컨트롤러가 현재 generation을 풀지 못했으면 실패한다 =="
load_forms_sealed
edit_sealed platform/app-secrets '.metadata.generation = 2'
expect_fail "observedGeneration 뒤처짐" "platform/app-secrets: 현재 generation 2" "$tmp/forms.yaml"
load_forms_sealed
edit_sealed platform/app-secrets '.status.conditions = [{type: "Synced", status: "False", message: "no key could decrypt secret"}]'
expect_fail "Synced False" "Synced=False" "$tmp/forms.yaml"
load_forms_sealed
edit_sealed platform/app-secrets 'del(.status)'
expect_fail "status 없음" "platform/app-secrets: 현재 generation 1" "$tmp/forms.yaml"

echo "== 여러 문제는 한 번에 모두 출력한다 =="
load_forms_sealed
edit_sealed platform/app-secrets 'del(.spec.encryptedData.INIT_TOKEN, .spec.encryptedData.VOLUME_ITEM)'
rm "$sealed_dir/platform/whole-env.json"
expect_fail "누락 여러 건" "platform/app-secrets: INIT_TOKEN" "$tmp/forms.yaml"
grep -qF 'platform/app-secrets: VOLUME_ITEM' "$err"
grep -qF 'platform/whole-env' "$err"
echo "  ok   누락 키와 조회 실패를 함께 출력"

echo "== 매니페스트 해석 실패와 잘못된 인자는 실패한다 =="
load_forms_sealed
FAKE_PARSE_FAIL=true expect_fail "kubectl 해석 실패" "매니페스트를 해석하지 못했다" "$tmp/forms.yaml"
expect_fail "없는 매니페스트" "가 없다" "$tmp/missing.yaml"
if run_check; then
  echo "FAIL 인자 없는 실행이 통과했다" >&2
  exit 1
fi
echo "  ok   인자 없음"

echo "== 시크릿 참조가 없는 매니페스트는 조회 없이 통과한다 =="
cat > "$tmp/none.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata: { name: plain, namespace: platform }
data: { a: b }
YAML
reset_sealed
expect_pass "참조 없음" "$tmp/none.yaml"
grep -q '^secret_refs=PASS secrets=0 keys=0$' "$out"
if grep -q '^READ_SEALED' "$log"; then
  echo "FAIL 참조가 없는데 SealedSecret을 조회했다" >&2
  exit 1
fi

echo "check-deploy-secret-refs 계약 통과"
