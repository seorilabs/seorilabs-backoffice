#!/usr/bin/env bash
#
# 배포 매니페스트가 필수로 참조하는 Secret 키가 클러스터 SealedSecret에 있는지 rollout 전에
# 확인한다. 아무것도 바꾸지 않는다.
#
#   scripts/check-deploy-secret-refs.sh k8s/deployment.yaml [k8s/<매니페스트>.yaml ...]
#
# 배포는 SealedSecret을 적용하지 않는다(trusted operator 전용). Secret에 키를 직접 넣으면
# rollout은 통과하지만, sealed-secrets 컨트롤러가 재시작하면 Secret을 SealedSecret 기준으로
# 다시 써서 키가 지워진다. 그 뒤 재시작한 Pod는 CreateContainerConfigError로 멈춘다
# (2026-11-15 Slack 31시간·웹 21시간 중단). 그래서 Secret이 아니라 SealedSecret을 기준으로
# 본다. CI는 Secret을 읽지 않고, SealedSecret 암호문은 공개 저장소에 이미 있다.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
namespace="${BACKOFFICE_NAMESPACE:-platform}"

fail() {
  echo "오류: $*" >&2
  exit 1
}

if [ "$#" -eq 0 ]; then
  echo "사용법: $0 <매니페스트>..." >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || fail "jq가 필요하다"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

parse_args=()
for manifest in "$@"; do
  [ -f "$manifest" ] || fail "$manifest 가 없다"
  parse_args+=(-f "$manifest")
done

# YAML 해석은 kubectl에 맡긴다. 직접 해석하다 한 줄·여러 줄 형식을 놓치면 점검이 조용히 통과한다.
objects="$("$kubectl_bin" create --dry-run=client -o json --validate=false "${parse_args[@]}")" \
  || fail "매니페스트를 해석하지 못했다"

# Pod spec마다 필수 참조를 <namespace> <secret> <key> 로 뽑는다. key가 비면 시크릿 전체가 필요하다.
# optional: true는 없어도 Pod가 뜨므로 제외한다. imagePullSecrets는 컨테이너 설정 오류를 만들지 않는다.
refs="$(printf '%s\n' "$objects" | jq -r --arg ns "$namespace" '
  (if .kind == "List" then .items[] else . end) as $object
  | ($object.metadata.namespace // $ns) as $n
  | $object | .. | objects | select(has("containers")) as $pod
  | (
      ( (($pod.containers // []) + ($pod.initContainers // []))[]
        | ( (.env // [])[] | .valueFrom.secretKeyRef // empty | select(.optional != true)
            | [$n, .name, .key] ),
          ( (.envFrom // [])[] | .secretRef // empty | select(.optional != true)
            | [$n, .name, ""] )
      ),
      ( ($pod.volumes // [])[]
        | ( .secret // empty | select(.optional != true) | {name: .secretName, items} ),
          ( (.projected.sources // [])[] | .secret // empty | select(.optional != true) | {name, items} )
        | if ((.items // []) | length) > 0
          then .name as $secret | .items[] | [$n, $secret, .key]
          else [$n, .name, ""]
          end
      )
    )
  | @tsv
' | sort -u)" || fail "시크릿 참조를 추출하지 못했다"

# 문제가 있을 때만 부른다. 저장소에서 같은 이름의 SealedSecret 매니페스트를 찾아 적용 명령을 만든다.
apply_fix() {
  local ns="$1" name="$2" file
  for file in "$root"/k8s/*.yaml; do
    grep -q '^kind: SealedSecret$' "$file" || continue
    if [ "$(awk '/^metadata:/ { m = 1; next } m && /^[^ ]/ { exit } m && $1 == "name:" { print $2; exit }' "$file")" = "$name" ]; then
      printf 'kubectl apply -f k8s/%s' "${file##*/}"
      return
    fi
  done
  printf '저장소에 %s/%s SealedSecret 매니페스트가 없다. 봉인해 커밋한 뒤 적용한다.' "$ns" "$name"
}

problems=()
fixes=()
secret_count=0
key_count=0

while IFS=$'\t' read -r ns name; do
  [ -n "$name" ] || continue
  secret_count=$((secret_count + 1))
  required="$(printf '%s\n' "$refs" | awk -F'\t' -v ns="$ns" -v name="$name" '$1 == ns && $2 == name && $3 != "" { print $3 }')"
  key_count=$((key_count + $(printf '%s' "$required" | grep -c . || true)))

  if ! sealed="$("$kubectl_bin" -n "$ns" get sealedsecret "$name" -o json </dev/null 2>"$tmp/get.err")"; then
    problems+=("${ns}/${name}: SealedSecret을 읽지 못했다: $(head -n1 "$tmp/get.err")")
    fixes+=("$(apply_fix "$ns" "$name")")
    continue
  fi
  state="$(printf '%s\n' "$sealed" | jq -r '[
      (.metadata.generation // "" | tostring),
      (.status.observedGeneration // "" | tostring),
      ([.status.conditions[]? | select(.type == "Synced") | .status] | first // "")
    ] | @tsv')" || fail "${ns}/${name} SealedSecret 응답을 해석하지 못했다"
  IFS=$'\t' read -r generation observed synced <<< "$state"
  if [ -z "$generation" ] || [ "$observed" != "$generation" ] || [ "$synced" != True ]; then
    problems+=("${ns}/${name}: 현재 generation ${generation:-unknown} 동기화 안 됨 (observedGeneration=${observed:-none}, Synced=${synced:-none})")
    fixes+=("sealed-secrets 컨트롤러 로그로 ${ns}/${name} 복호화 실패 원인을 확인한다")
    continue
  fi

  provided="$(printf '%s\n' "$sealed" | jq -r '((.spec.encryptedData // {}) + (.spec.template.data // {})) | keys[]')" \
    || fail "${ns}/${name} SealedSecret 키 목록을 해석하지 못했다"
  missing="$(comm -23 <(printf '%s\n' "$required" | sed '/^$/d' | LC_ALL=C sort -u) \
    <(printf '%s\n' "$provided" | LC_ALL=C sort -u))"
  if [ -n "$missing" ]; then
    while IFS= read -r key; do
      problems+=("${ns}/${name}: ${key}")
    done <<< "$missing"
    fixes+=("$(apply_fix "$ns" "$name")")
  fi
done < <(printf '%s\n' "$refs" | cut -f1,2 | sort -u)

if [ "${#problems[@]}" -gt 0 ]; then
  {
    echo "오류: 배포 매니페스트가 필수로 참조하는 시크릿이 클러스터 SealedSecret에 없거나 준비되지 않았다. 배포하지 않는다."
    printf '  %s\n' "${problems[@]}"
    echo "조치(trusted operator):"
    printf '%s\n' "${fixes[@]}" | sort -u | sed 's/^/  /'
    echo "Secret을 직접 고치지 않는다. sealed-secrets 컨트롤러가 재시작하면 SealedSecret 기준으로 지워진다."
  } >&2
  exit 1
fi

echo "secret_refs=PASS secrets=${secret_count} keys=${key_count}"
