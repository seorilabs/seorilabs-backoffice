#!/usr/bin/env bash
#
# render-manifest.sh 계약을 고정한다.
#
# 이 스크립트가 조용히 빗나가면 :latest 로 배포된다. 어떤 이미지가 도는지
# 아무도 모르는 상태가 되므로, 실패는 반드시 exit 1 이어야 한다.
#
# CD 가 실제로 쓰는 이미지 매니페스트를 그대로 넣어 돌린다. 매니페스트에서
# 이미지 줄이 사라지거나 이름이 바뀌면 여기서 걸린다.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
render="$here/render-manifest.sh"

REPO="registry.vzyx.xyz/seorilabs/seorilabs-backoffice"
SHA="0123456789abcdef0123456789abcdef01234567"
DIGEST="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
IMG="${REPO}@sha256:${DIGEST}"

fail=0
ok() { printf '  ok   %s\n' "$1"; }
ng() { printf '  FAIL %s\n' "$1" >&2; fail=1; }

# CD 가 render 를 거쳐 apply 하는 매니페스트.
MANIFESTS=(
  k8s/migration-job.yaml
  k8s/deployment.yaml
  k8s/app-ops-worker.yaml
  k8s/discord-workers.yaml
  k8s/teammate-worker.yaml
  k8s/store-review-cronjob.yaml
  k8s/vault-rag.yaml
)

echo "== 치환 =="
for m in "${MANIFESTS[@]}"; do
  out="$("$render" "$root/$m" "$IMG" "$SHA")" || { ng "$m 렌더가 실패했다"; continue; }

  if printf '%s' "$out" | grep -q "${REPO}:latest"; then
    ng "$m 에 :latest 가 남았다"
    continue
  fi

  # 매니페스트에 있던 이미지 줄 수만큼 치환돼야 한다.
  want=$(grep -c "${REPO}:latest" "$root/$m")
  got=$(printf '%s' "$out" | grep -c "${REPO}@sha256:${DIGEST}")
  if [ "$want" -ne "$got" ]; then
    ng "$m 치환 개수가 다르다: 기대 $want, 실제 $got"
    continue
  fi
  ok "$m ($got 곳)"
done

echo "== migration Job identity =="
migration_out="$("$render" "$root/k8s/migration-job.yaml" "$IMG" "$SHA")"
if printf '%s' "$migration_out" | grep -q "generateName: backoffice-migrate-${SHA:0:12}-" &&
   printf '%s' "$migration_out" | grep -q "seorilabs.dev/source-sha: \"${SHA}\"" &&
   ! printf '%s' "$migration_out" | grep -q '__BACKOFFICE_IMAGE_TAG'; then
  ok "exact SHA Job identity"
else
  ng "migration Job identity에 exact SHA가 반영되지 않았다"
fi

if "$render" "$root/k8s/migration-job.yaml" "$IMG" "not-a-sha" >/dev/null 2>&1; then
  ng "migration Job이 잘못된 source SHA를 허용했다"
else
  ok "migration Job의 잘못된 source SHA 거부"
fi

catchup_out="$("$render" "$root/k8s/scheduler-catchup-job.yaml" "$IMG" "$SHA")"
if printf '%s' "$catchup_out" | grep -q "generateName: backoffice-scheduler-catchup-${SHA:0:12}-" &&
   printf '%s' "$catchup_out" | grep -q "seorilabs.dev/source-sha: \"${SHA}\""; then
  ok "scheduler catch-up source SHA identity"
else
  ng "scheduler catch-up source SHA identity가 깨졌다"
fi

echo "== availability-preserving deploy 계약 =="
deployment="$root/k8s/deployment.yaml"
migration_job="$root/k8s/migration-job.yaml"
scheduler_cronjobs="$root/k8s/scheduler-cronjobs.yaml"
catchup_job="$root/k8s/scheduler-catchup-job.yaml"
networking="$root/k8s/backoffice-networking.yaml"
if grep -q 'type: RollingUpdate' "$deployment" &&
   grep -q 'maxUnavailable: 0' "$deployment" &&
   grep -q 'maxSurge: 1' "$deployment" &&
   ! grep -q 'initContainers:' "$deployment" &&
   ! grep -q 'RECONCILE_INTERVAL_MS' "$deployment" &&
   grep -q 'app.kubernetes.io/component: web' "$deployment" &&
   grep -q 'app.kubernetes.io/component: web' "$networking"; then
  ok "웹 RollingUpdate와 scheduler 분리"
else
  ng "웹 availability 계약이 깨졌다"
fi

if grep -q 'automountServiceAccountToken: false' "$catchup_job" &&
   grep -q 'ttlSecondsAfterFinished: 604800' "$catchup_job" &&
   grep -q 'curlimages/curl@sha256:' "$catchup_job" &&
   grep -q 'kubernetes.io/hostname: rpi5' "$catchup_job"; then
  ok "scheduler catch-up 격리와 감사 보존"
else
  ng "scheduler catch-up 실행 경계가 깨졌다"
fi

if grep -q 'backoffLimit: 0' "$migration_job" &&
   grep -q 'ttlSecondsAfterFinished: 604800' "$migration_job" &&
   grep -q 'automountServiceAccountToken: false' "$migration_job" &&
   [ "$(grep -c 'key: DATABASE_URL' "$migration_job")" -eq 1 ]; then
  ok "migration Job 최소권한과 7일 감사 보존"
else
  ng "migration Job 실행 경계가 깨졌다"
fi

if [ "$(grep -c '^kind: CronJob' "$scheduler_cronjobs")" -eq 3 ] &&
   [ "$(grep -c 'concurrencyPolicy: Forbid' "$scheduler_cronjobs")" -eq 3 ] &&
   [ "$(grep -c 'kubernetes.io/hostname: rpi5' "$scheduler_cronjobs")" -eq 3 ] &&
   [ "$(grep -c 'curlimages/curl@sha256:' "$scheduler_cronjobs")" -eq 3 ] &&
   [ "$(grep -c 'suspend: false' "$scheduler_cronjobs")" -eq 3 ] &&
   [ "$(grep -c 'curl -fsS -o /dev/null' "$scheduler_cronjobs")" -eq 3 ] &&
   grep -q '/api/admin/reconcile' "$scheduler_cronjobs" &&
   grep -q '/api/admin/xcode-cloud/sync' "$scheduler_cronjobs" &&
   grep -q '/api/admin/seed' "$scheduler_cronjobs"; then
  ok "scheduler CronJob 3개 직렬화"
else
  ng "scheduler CronJob 계약이 깨졌다"
fi

platform_rbac="$root/k8s/ci-deployer-rbac.yaml"
data_rbac="$root/k8s/ci-deployer-data-rbac.yaml"
if grep -q 'resources: \["jobs"\]' "$platform_rbac" &&
   ! grep -q 'resources: \["pods/log"\]' "$platform_rbac" &&
   ! grep -q 'resources: \["secrets"\]' "$platform_rbac" &&
   grep -q 'resourceNames: \["vault-indexer", "vault-writer"\]' "$data_rbac" &&
   ! grep -q 'verbs:.*create' "$data_rbac"; then
  ok "CI migration·Vault image 최소권한"
else
  ng "CI deployer 최소권한 계약이 깨졌다"
fi

echo "== Discord worker 권한 분리 =="
discord_workers="$root/k8s/discord-workers.yaml"
notification_doc="$(awk 'BEGIN { RS="---" } /name: backoffice-notification-worker/ { print }' "$discord_workers")"
operator_doc="$(awk 'BEGIN { RS="---" } /name: backoffice-operator-command-worker/ { print }' "$discord_workers")"
if printf '%s' "$notification_doc" | grep -q 'automountServiceAccountToken: false' &&
   ! printf '%s' "$notification_doc" | grep -q 'GITHUB_PRIVATE_KEY' &&
   printf '%s' "$operator_doc" | grep -q 'serviceAccountName: backoffice' &&
   printf '%s' "$operator_doc" | grep -q 'operator-command-worker.cjs'; then
  ok "알림 worker와 쓰기 권한 command worker 분리"
else
  ng "Discord worker 최소권한 경계가 깨졌다"
fi

echo "== Vault 일일 스케줄 =="
vault_manifest="$root/k8s/vault-rag.yaml"
indexer_doc="$(awk 'BEGIN { RS="---" } /name: vault-indexer/ { print }' "$vault_manifest")"
writer_doc="$(awk 'BEGIN { RS="---" } /name: vault-writer/ { print }' "$vault_manifest")"
if printf '%s' "$indexer_doc" | grep -q 'schedule: "0 5 \* \* \*"' &&
   printf '%s' "$indexer_doc" | grep -q 'timeZone: Asia/Seoul' &&
   printf '%s' "$writer_doc" | grep -q 'schedule: "30 4 \* \* \*"' &&
   printf '%s' "$writer_doc" | grep -q 'timeZone: Asia/Seoul'; then
  ok "indexer 05:00, writer 04:30 KST"
else
  ng "Vault CronJob 일일 스케줄 계약이 깨졌다"
fi

echo "== Grafana alert 연동 제거 =="
if [ ! -e "$root/src/app/api/internal/grafana/alerts/route.ts" ] &&
   [ ! -e "$root/src/lib/notifications/grafana.ts" ] &&
   ! grep -q 'GRAFANA_ALERT_HMAC_SECRET' "$root/k8s/deployment.yaml" "$root/k8s/secret.example.yaml" &&
   ! grep -q 'grafana/alerts' "$root/src/middleware.ts"; then
  ok "수신 route, 처리기, 배포 환경변수 제거"
else
  ng "Grafana alert 연동이 runtime 또는 배포 계약에 남아 있다"
fi

echo "== 대상이 없으면 죽는다 =="
# :latest 가 없는 매니페스트를 만들어 넣는다. 조용히 통과하면 안 된다.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf 'apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - image: curlimages/curl:8.11.1\n' > "$tmp"

out="$("$render" "$tmp" "$IMG" "$SHA" 2>/dev/null)"
code=$?
if [ "$code" -eq 0 ]; then
  ng ":latest 가 없는데 exit 0 이다"
elif [ -n "$out" ]; then
  ng "실패했는데 stdout 으로 매니페스트를 내보냈다"
else
  ok "exit $code, 출력 없음"
fi

echo "== 다른 이미지는 건드리지 않는다 =="
# 같은 파일에 curl 이미지가 섞여 있어도 우리 저장소만 바꿔야 한다.
printf 'a: %s:latest\nb: curlimages/curl:latest\n' "$REPO" > "$tmp"
out="$("$render" "$tmp" "$IMG" "$SHA")"
if printf '%s' "$out" | grep -q "curlimages/curl:latest"; then
  ok "curlimages/curl:latest 유지"
else
  ng "관계없는 이미지가 바뀌었다"
fi

echo "== 인자 검증 =="
"$render" "$root/k8s/deployment.yaml" >/dev/null 2>&1
if [ $? -eq 2 ]; then
  ok "인자 부족은 exit 2"
else
  ng "인자 부족인데 exit 2 가 아니다"
fi

"$render" "$root/k8s/deployment.yaml" "$REPO" >/dev/null 2>&1
if [ $? -eq 1 ]; then
  ok "태그 없는 이미지는 exit 1"
else
  ng "태그가 없는데 통과했다"
fi

"$render" "$root/k8s/없는파일.yaml" "$IMG" >/dev/null 2>&1
if [ $? -eq 1 ]; then
  ok "없는 파일은 exit 1"
else
  ng "없는 파일인데 통과했다"
fi

if [ "$fail" -ne 0 ]; then
  echo "render-manifest 계약이 깨졌다." >&2
  exit 1
fi
echo "render-manifest 계약 통과"
