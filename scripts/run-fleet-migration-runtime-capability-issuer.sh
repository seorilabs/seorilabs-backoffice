#!/usr/bin/env bash

set -euo pipefail
set +x

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
crane_bin="${CRANE_BIN:-crane}"
jq_bin="${JQ_BIN:-jq}"
openssl_bin="${OPENSSL_BIN:-openssl}"
od_bin="${OD_BIN:-od}"
tr_bin="${TR_BIN:-tr}"
namespace="platform"
image="${BACKOFFICE_IMAGE:-}"
source_sha="${BACKOFFICE_SOURCE_SHA:-}"
detector_sha="${FLEET_MIGRATION_DETECTOR_SOURCE_SHA:-}"
execution_id="${FLEET_MIGRATION_EXECUTION_ID:-}"
runtime_key_fingerprint="${FLEET_MIGRATION_RUNTIME_KEY_FINGERPRINT:-}"
timeout="${FLEET_MIGRATION_RUNTIME_ISSUER_TIMEOUT_SECONDS:-660}"

fail() {
  echo "오류: $1" >&2
  exit 1
}

if [[ ! "$image" =~ ^registry\.vzyx\.xyz/seorilabs/seorilabs-backoffice@sha256:[0-9a-f]{64}$ ]]; then
  echo "오류: BACKOFFICE_IMAGE는 canonical repository의 immutable sha256 digest여야 한다" >&2
  exit 2
fi
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: BACKOFFICE_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
if [[ ! "$detector_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: FLEET_MIGRATION_DETECTOR_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
if [[ ! "$execution_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ ]]; then
  echo "오류: FLEET_MIGRATION_EXECUTION_ID가 public identifier 계약과 다르다" >&2
  exit 2
fi
if [[ ! "$runtime_key_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
  echo "오류: FLEET_MIGRATION_RUNTIME_KEY_FINGERPRINT는 catalog의 Ed25519 SPKI SHA-256이어야 한다" >&2
  exit 2
fi
if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]] || [ "$timeout" -gt 1200 ]; then
  echo "오류: FLEET_MIGRATION_RUNTIME_ISSUER_TIMEOUT_SECONDS는 1..1200이어야 한다" >&2
  exit 2
fi
for command in "$kubectl_bin" "$crane_bin" "$jq_bin" "$openssl_bin" "$od_bin" "$tr_bin"; do
  command -v "$command" >/dev/null || { echo "오류: 필수 실행 도구가 없다" >&2; exit 2; }
done

execution_digest="$(printf '%s' "$execution_id" \
  | "$openssl_bin" dgst -sha256 -binary \
  | "$od_bin" -An -v -tx1 \
  | "$tr_bin" -d ' \n')"
[[ "$execution_digest" =~ ^[0-9a-f]{64}$ ]] || fail "execution ID digest가 canonical hex가 아니다"
short="${execution_digest:0:20}"
job_name="fleet-runtime-issuer-${execution_digest:0:40}"
service_account="fleet-runtime-issuer-$short"
role_name="fleet-runtime-issuer-$short"
runtime_config_map="fleet-runtime-public-${execution_digest:0:24}"
github_token_secret="fleet-runtime-token-${execution_digest:0:24}"
for name in "$job_name" "$service_account" "$role_name" "$runtime_config_map" "$github_token_secret"; do
  [[ "$name" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])$ ]] && [ "${#name}" -le 63 ] \
    || fail "execution 기반 Kubernetes 이름이 DNS-1123 계약과 다르다"
done

image_revision="$($crane_bin config "$image" | "$jq_bin" -er '.config.Labels["org.opencontainers.image.revision"]')"
[ "$image_revision" = "$source_sha" ] || fail "image OCI source revision이 BACKOFFICE_SOURCE_SHA와 다르다"

read_bound_key_markers() {
  local kind="$1"
  local name="$2"
  local logical_id="$3"
  local key_template="$4"
  local expected="$5"
  local template="{{if eq (index .metadata.annotations \"seorilabs.dev/credential-id\") \"$logical_id\"}}i{{end}}$key_template"
  local markers=""
  markers="$($kubectl_bin -n "$namespace" get "$kind/$name" -o "go-template=$template" 2>/dev/null)" \
    || fail "required execution object가 없다: $kind/$name"
  [ "$markers" = "i$expected" ] \
    || fail "required execution object identity/key 계약이 불완전하다: $kind/$name"
}
read_bound_key_markers secret fleet-migration-shadow-db shared/seori-auth/fleet-migration-shadow-db '{{if index .data "DATABASE_URL"}}d{{end}}' d
read_bound_key_markers secret fleet-migration-inventory-issuer-github-app shared/github/backoffice-app-private-key '{{if index .data "private-key.pem"}}g{{end}}' g
read_bound_key_markers secret backoffice-control-plane-snapshot-signing shared/backoffice/control-plane-snapshot-signing '{{if index .data "CONTROL_PLANE_SNAPSHOT_SIGNING_KEY"}}s{{end}}' s
read_bound_key_markers secret fleet-migration-runtime-attestation-signing shared/platform/fleet-migration-runtime-attestation-signing '{{if index .data "private-key.pem"}}s{{end}}{{if index .data "public-key.pem"}}p{{end}}' sp

registry_markers="$($kubectl_bin -n "$namespace" get secret/registry-pull-cred \
  -o go-template='{{if eq .type "kubernetes.io/dockerconfigjson"}}t{{end}}{{if index .data ".dockerconfigjson"}}d{{end}}')"
[ "$registry_markers" = "td" ] || fail "registry-pull-cred type/key 계약이 불완전하다"

api_ip="$($kubectl_bin -n default get service/kubernetes -o 'jsonpath={.spec.clusterIP}')"
if [[ ! "$api_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  fail "Kubernetes API service ClusterIP를 확인하지 못했다"
fi
api_cidr="$api_ip/32"
api_endpoints="$($kubectl_bin -n default get endpointslice \
  -l kubernetes.io/service-name=kubernetes -o json)"
api_endpoint_ip="$(printf '%s' "$api_endpoints" | "$jq_bin" -er '
  [.items[].endpoints[] | select(.conditions.ready != false) | .addresses[]] | unique
  | if length == 1 then .[0] else error("exact endpoint required") end
')" || fail "Kubernetes API EndpointSlice의 exact 단일 endpoint를 확인하지 못했다"
api_endpoint_port="$(printf '%s' "$api_endpoints" | "$jq_bin" -er '
  [.items[].ports[] | select(.name == "https" and .protocol == "TCP") | .port] | unique
  | if length == 1 then .[0] else error("exact port required") end
')" || fail "Kubernetes API EndpointSlice의 exact https port를 확인하지 못했다"
[[ "$api_endpoint_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] \
  || fail "Kubernetes API endpoint가 IPv4 계약과 다르다"
[[ "$api_endpoint_port" =~ ^[1-9][0-9]{0,4}$ ]] \
  || fail "Kubernetes API endpoint port가 정수 계약과 다르다"
api_endpoint_cidr="$api_endpoint_ip/32"

rendered="$("$here/render-manifest.sh" "$root/k8s/fleet-migration-runtime-capability-issuer-job.yaml" "$image" "$source_sha" \
  | sed \
      -e "s|__FLEET_MIGRATION_DETECTOR_SOURCE_SHA__|$detector_sha|g" \
      -e "s|__FLEET_MIGRATION_EXECUTION_ID__|$execution_id|g" \
      -e "s|__FLEET_MIGRATION_RUNTIME_KEY_FINGERPRINT__|$runtime_key_fingerprint|g" \
      -e "s|__FLEET_MIGRATION_RUNTIME_CONFIG_MAP__|$runtime_config_map|g" \
      -e "s|__FLEET_MIGRATION_GITHUB_TOKEN_SECRET__|$github_token_secret|g" \
      -e "s|__FLEET_MIGRATION_RUNTIME_ISSUER_JOB__|$job_name|g" \
      -e "s|__FLEET_MIGRATION_RUNTIME_ISSUER_SERVICE_ACCOUNT__|$service_account|g" \
      -e "s|__FLEET_MIGRATION_RUNTIME_ISSUER_ROLE__|$role_name|g" \
      -e "s|__KUBERNETES_API_SERVICE_CIDR__|$api_cidr|g" \
      -e "s|__KUBERNETES_API_ENDPOINT_CIDR__|$api_endpoint_cidr|g" \
      -e "s|__KUBERNETES_API_ENDPOINT_PORT__|$api_endpoint_port|g")"
if grep -q '__[A-Z0-9_]*__\|:latest' <<<"$rendered"; then
  fail "runtime capability issuer manifest에 unresolved placeholder 또는 mutable image가 남았다"
fi

documents="$(printf '%s\n' "$rendered" | "$kubectl_bin" create --dry-run=client -f - -o json | "$jq_bin" -cs '.')"
if ! printf '%s' "$documents" | "$jq_bin" -e '
  length == 7
  and ([.[].kind] | sort) == ["ConfigMap","Job","NetworkPolicy","Role","RoleBinding","Secret","ServiceAccount"]
  and ([.[] | select(.kind == "Job")] | length) == 1
' >/dev/null; then
  fail "runtime capability issuer resource set이 canonical contract와 다르다"
fi
expected_job="$(printf '%s' "$documents" | "$jq_bin" -c '[.[] | select(.kind == "Job")][0]')"
expected_policy="$(printf '%s' "$documents" | "$jq_bin" -Sc '[.[] | select(.kind == "NetworkPolicy")][0].spec')"

for ref in \
  "serviceaccount/$service_account" \
  "role/$role_name" \
  "rolebinding/$role_name" \
  "secret/$github_token_secret" \
  "configmap/$runtime_config_map" \
  "job/$job_name" \
  "networkpolicy/$role_name"; do
  if "$kubectl_bin" -n "$namespace" get "$ref" >/dev/null 2>&1; then
    fail "runtime capability 실행 객체가 이미 존재한다: $ref. overwrite나 자동 재시도 없이 readback이 필요하다"
  fi
done

if ! printf '%s\n' "$rendered" | "$kubectl_bin" create -f - >/dev/null; then
  fail "runtime capability issuer resource create 결과가 불명이다. exact 이름으로 readback해야 한다"
fi

actual_job="$($kubectl_bin -n "$namespace" get "job/$job_name" -o json)"
if ! printf '%s\n%s\n' "$expected_job" "$actual_job" | "$jq_bin" -e -s \
  --arg image "$image" \
  --arg source "$source_sha" \
  --arg detector "$detector_sha" \
  --arg execution "$execution_id" \
  --arg serviceAccount "$service_account" \
  --arg runtimeConfigMap "$runtime_config_map" \
  --arg tokenSecret "$github_token_secret" \
  --arg fingerprint "$runtime_key_fingerprint" '
    .[0] as $e | .[1] as $a
    | $a.metadata.deletionTimestamp == null
    and $a.spec.suspend == true
    and $a.spec.backoffLimit == 0
    and $a.spec.activeDeadlineSeconds == 600
    and $a.metadata.labels["seorilabs.dev/source-sha"] == $source
    and $a.metadata.labels["seorilabs.dev/execution-id"] == $execution
    and $a.spec.template.spec.serviceAccountName == $serviceAccount
    and $a.spec.template.spec.automountServiceAccountToken == false
    and $a.spec.template.spec.restartPolicy == "Never"
    and ($a.spec.template.spec.containers | length) == 1
    and ($a.spec.template.spec.containers[0] as $c
      | $c.image == $image
      and $c.command == ["/usr/bin/prlimit","--core=0:0","--","node","/app/scripts-dist/fleet-migration-runtime-capability-issuer.cjs"]
      and ($c.env | map(select(.name == "BACKOFFICE_SOURCE_SHA"))[0].value) == $source
      and ($c.env | map(select(.name == "FLEET_MIGRATION_DETECTOR_SOURCE_SHA"))[0].value) == $detector
      and ($c.env | map(select(.name == "FLEET_MIGRATION_EXECUTION_ID"))[0].value) == $execution
      and ($c.env | map(select(.name == "FLEET_MIGRATION_RUNTIME_ATTESTATION_KEY_FINGERPRINT"))[0].value) == $fingerprint
      and ($c.env | map(select(.name == "FLEET_MIGRATION_RUNTIME_CONFIG_MAP"))[0].value) == $runtimeConfigMap
      and ($c.env | map(select(.name == "FLEET_MIGRATION_GITHUB_TOKEN_SECRET"))[0].value) == $tokenSecret
      and $c.securityContext.allowPrivilegeEscalation == false
      and $c.securityContext.readOnlyRootFilesystem == true
      and $c.securityContext.capabilities.drop == ["ALL"])
    and $a.spec.template.spec.volumes == $e.spec.template.spec.volumes
  ' >/dev/null; then
  fail "runtime capability issuer Job binding이 canonical contract와 다르다"
fi
created_job_uid="$(printf '%s' "$actual_job" | "$jq_bin" -er '.metadata.uid')"
created_job_resource_version="$(printf '%s' "$actual_job" | "$jq_bin" -er '.metadata.resourceVersion')"
[[ "$created_job_uid" =~ ^[0-9a-f-]{16,64}$ ]] || fail "runtime capability issuer Job UID가 유효하지 않다"
[[ "$created_job_resource_version" =~ ^[1-9][0-9]{0,31}$ ]] \
  || fail "runtime capability issuer Job resourceVersion이 유효하지 않다"

if ! "$kubectl_bin" -n "$namespace" get "serviceaccount/$service_account" -o json | "$jq_bin" -e \
  --arg name "$service_account" '
    .metadata.name == $name
    and .automountServiceAccountToken == false
    and .metadata.deletionTimestamp == null
  ' >/dev/null; then
  fail "runtime capability issuer ServiceAccount binding이 canonical contract와 다르다"
fi
if ! "$kubectl_bin" -n "$namespace" get "rolebinding/$role_name" -o json | "$jq_bin" -e \
  --arg name "$role_name" --arg serviceAccount "$service_account" '
    .metadata.name == $name
    and .roleRef == {apiGroup:"rbac.authorization.k8s.io",kind:"Role",name:$name}
    and .subjects == [{kind:"ServiceAccount",name:$serviceAccount,namespace:"platform"}]
  ' >/dev/null; then
  fail "runtime capability issuer RoleBinding이 canonical contract와 다르다"
fi

actual_policy="$($kubectl_bin -n "$namespace" get "networkpolicy/$role_name" -o json | "$jq_bin" -Sc '.spec')"
[ "$actual_policy" = "$expected_policy" ] || fail "runtime capability issuer NetworkPolicy가 canonical spec과 다르다"
if ! "$kubectl_bin" -n "$namespace" get "role/$role_name" -o json | "$jq_bin" -e \
  --arg secret "$github_token_secret" --arg configMap "$runtime_config_map" '
    (.rules | length) == 2
    and ([.rules[] | select(.resources == ["secrets"] and .resourceNames == [$secret] and (.verbs | sort) == ["delete","get","update"])] | length) == 1
    and ([.rules[] | select(.resources == ["configmaps"] and .resourceNames == [$configMap] and (.verbs | sort) == ["delete","get","update"])] | length) == 1
  ' >/dev/null; then
  fail "runtime capability issuer Role이 exact output object 경계와 다르다"
fi
for ref in "secret/$github_token_secret" "configmap/$runtime_config_map"; do
  if [ "$($kubectl_bin -n "$namespace" get "$ref" -o go-template='{{len .data}}|{{.immutable}}')" != "0|<no value>" ]; then
    fail "runtime capability output CAS 객체가 비어 있지 않거나 immutable 상태다"
  fi
done
if [ -n "$($kubectl_bin -n "$namespace" get pods -l "job-name=$job_name" -o 'jsonpath={.items[0].metadata.name}')" ]; then
  fail "binding 검증 전 suspended runtime capability issuer에 Pod가 생겼다"
fi

unsuspend_patch="$("$jq_bin" -nc \
  --arg uid "$created_job_uid" \
  --arg job "$job_name" \
  --arg resourceVersion "$created_job_resource_version" '
    [
      {op:"test",path:"/metadata/uid",value:$uid},
      {op:"test",path:"/metadata/resourceVersion",value:$resourceVersion},
      {op:"test",path:"/spec/suspend",value:true},
      {op:"replace",path:"/spec/suspend",value:false}
    ]
  ')"
started_job="$($kubectl_bin -n "$namespace" patch "job/$job_name" --type=json -p "$unsuspend_patch" -o json)" \
  || fail "runtime capability issuer Job 상태가 검증 뒤 바뀌었거나 시작 결과가 불명이다. 자동 재실행하지 않는다"
if ! printf '%s' "$started_job" | "$jq_bin" -e \
  --arg uid "$created_job_uid" '
    .metadata.uid == $uid
    and .metadata.deletionTimestamp == null
    and .spec.suspend == false
  ' >/dev/null; then
  fail "검증된 runtime capability issuer Job 시작 readback이 불완전하다"
fi

deadline=$(( $(date +%s) + timeout ))
terminal=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  complete="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.status.conditions[?(@.type=="Complete")].status}')"
  failed="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.status.conditions[?(@.type=="Failed")].status}')"
  if [ "$complete" = "True" ]; then terminal="complete"; break; fi
  if [ "$failed" = "True" ]; then terminal="failed"; break; fi
  sleep 5
done
if [ -z "$terminal" ]; then
  fail "runtime capability issuer terminal 상태 timeout. 자동 재실행하지 않는다"
fi
if [ "$terminal" = "failed" ]; then
  pod_name="$($kubectl_bin -n "$namespace" get pods -l "job-name=$job_name" -o 'jsonpath={.items[0].metadata.name}')"
  reason="$($kubectl_bin -n "$namespace" get "pod/$pod_name" -o 'jsonpath={.status.containerStatuses[0].state.terminated.reason}')"
  exit_code="$($kubectl_bin -n "$namespace" get "pod/$pod_name" -o 'jsonpath={.status.containerStatuses[0].state.terminated.exitCode}')"
  fail "runtime capability issuer failed reason=$reason exit_code=$exit_code. 동일 execution ID를 반복하지 않는다"
fi

pods="$($kubectl_bin -n "$namespace" get pods -l "job-name=$job_name" -o json)"
if ! printf '%s' "$pods" | "$jq_bin" -e \
  --arg uid "$created_job_uid" \
  --arg job "$job_name" \
  --arg source "$source_sha" \
  --arg image "$image" \
  --arg serviceAccount "$service_account" '
    (.items | length) == 1
    and (.items[0] as $p
      | ([ $p.metadata.ownerReferences[]?
          | select(.apiVersion == "batch/v1" and .kind == "Job" and .name == $job and .uid == $uid and .controller == true) ] | length) == 1
      and $p.metadata.labels["seorilabs.dev/source-sha"] == $source
      and $p.spec.serviceAccountName == $serviceAccount
      and $p.spec.automountServiceAccountToken == false
      and ($p.spec.initContainers // []) == []
      and ($p.spec.ephemeralContainers // []) == []
      and ($p.spec.containers | length) == 1
      and $p.spec.containers[0].name == "runtime-capability-issuer"
      and $p.spec.containers[0].image == $image
      and $p.status.phase == "Succeeded"
      and ($p.status.containerStatuses | length) == 1
      and $p.status.containerStatuses[0].name == "runtime-capability-issuer"
      and $p.status.containerStatuses[0].state.terminated.exitCode == 0
      and ($p.status.containerStatuses[0].imageID | endswith("@" + ($image | split("@")[1]))))
  ' >/dev/null; then
  fail "runtime capability issuer terminal Pod의 owner/source/image/exit binding이 canonical contract와 다르다"
fi
pod_name="$(printf '%s' "$pods" | "$jq_bin" -er '.items[0].metadata.name')"
evidence="$($kubectl_bin -n "$namespace" logs "pod/$pod_name" -c runtime-capability-issuer --tail=1)"
if ! printf '%s\n' "$evidence" | "$jq_bin" -e \
  --arg source "$source_sha" \
  --arg detector "$detector_sha" \
  --arg execution "$execution_id" \
  --arg fingerprint "$runtime_key_fingerprint" \
  --arg configMap "$runtime_config_map" \
  --arg secret "$github_token_secret" '
    (keys | sort) == ["approvedProofCount","attestationDigest","configMapName","configSnapshotCount","contract","detectorSourceSha","domainMutations","executionId","expiresAt","githubMutations","keyFingerprint","keyId","readinessCohortDigest","readinessEvidenceDigest","repositoryCount","schemaVersion","secretName","secretValuesReturned","sourceSha","state"]
    and .schemaVersion == 1
    and .contract == "fleet-migration-runtime-capability-issuance/v1"
    and .state == "PRESERVED"
    and .sourceSha == $source
    and .detectorSourceSha == $detector
    and .executionId == $execution
    and .keyFingerprint == $fingerprint
    and .configMapName == $configMap
    and .secretName == $secret
    and (.repositoryCount | type == "number" and . > 0)
    and (.attestationDigest | test("^[0-9a-f]{64}$"))
    and (.readinessEvidenceDigest | test("^[0-9a-f]{64}$"))
    and (.readinessCohortDigest | test("^[0-9a-f]{64}$"))
    and .githubMutations == 1
    and .domainMutations == 0
    and .secretValuesReturned == false
  ' >/dev/null; then
  fail "runtime capability issuer public terminal evidence를 검증하지 못했다"
fi

secret_markers="$($kubectl_bin -n "$namespace" get "secret/$github_token_secret" \
  -o go-template='{{if .immutable}}i{{end}}{{if index .data "installation.token"}}t{{end}}{{len .data}}')"
config_markers="$($kubectl_bin -n "$namespace" get "configmap/$runtime_config_map" \
  -o go-template='{{if .immutable}}i{{end}}{{if index .data "runtime-attestation.json"}}a{{end}}{{if index .data "runtime-attestation-public.pem"}}p{{end}}{{len .data}}')"
[ "$secret_markers" = "it1" ] || fail "one-run token Secret readback이 exact immutable key 계약과 다르다"
[ "$config_markers" = "iap2" ] || fail "runtime public ConfigMap readback이 exact immutable key 계약과 다르다"

# terminal Pod 뒤에는 Kubernetes API write 권한이 남지 않게 exact 임시 RBAC와 SA를 제거한다.
"$kubectl_bin" -n "$namespace" delete rolebinding "$role_name" role "$role_name" serviceaccount "$service_account" networkpolicy "$role_name" --wait=true >/dev/null
for ref in "rolebinding/$role_name" "role/$role_name" "serviceaccount/$service_account" "networkpolicy/$role_name"; do
  if "$kubectl_bin" -n "$namespace" get "$ref" >/dev/null 2>&1; then
    fail "terminal runtime capability issuer support 권한 제거 readback에 실패했다: $ref"
  fi
done

printf '%s\n' "$evidence"
