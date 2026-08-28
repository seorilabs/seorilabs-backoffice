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
  k8s/repository-discovery-worker.yaml
  k8s/provider-execution-worker.yaml
  k8s/store-review-cronjob.yaml
  k8s/vault-rag.yaml
  k8s/fleet-parity-wave-job.yaml
)

echo "== 치환 =="
for m in "${MANIFESTS[@]}"; do
  out="$("$render" "$root/$m" "$IMG" "$SHA")" || { ng "$m 렌더가 실패했다"; continue; }

  if printf '%s' "$out" | grep -q "${REPO}:latest"; then
    ng "$m 에 :latest 가 남았다"
    continue
  fi

  # 매니페스트에 있던 이미지 줄 수만큼 치환돼야 한다.
  want=$(( $(grep -c "${REPO}:latest" "$root/$m") + $(grep -c '__BACKOFFICE_IMAGE_DIGEST__' "$root/$m") ))
  got=$(printf '%s' "$out" | grep -c "${REPO}@sha256:${DIGEST}")
  if [ "$want" -ne "$got" ]; then
    ng "$m 치환 개수가 다르다: 기대 $want, 실제 $got"
    continue
  fi
  ok "$m ($got 곳)"
done

deployment_out="$("$render" "$root/k8s/deployment.yaml" "$IMG" "$SHA")"
if [ "$(printf '%s' "$deployment_out" | grep -c "seorilabs.dev/source-sha: \"${SHA}\"")" -eq 2 ] &&
   ! printf '%s' "$deployment_out" | grep -q '__BACKOFFICE_IMAGE_TAG__'; then
  ok "web Pod label/annotation은 exact source SHA를 노출"
else
  ng "web Pod source SHA identity가 깨졌다"
fi

echo "== control-plane snapshot signing Secret 격리 =="
snapshot_secret_name="backoffice-control-plane-snapshot-signing"
snapshot_key="CONTROL_PLANE_SNAPSHOT_SIGNING_KEY"
snapshot_env_ref="$(awk -v key="$snapshot_key" '
  $0 ~ "- name: " key { capture=1 }
  capture { print }
  capture && /optional:/ { exit }
' "$root/k8s/deployment.yaml")"
snapshot_sealed="$root/k8s/control-plane-snapshot-signing-sealedsecret.yaml"
broad_sealed="$root/k8s/backoffice-sealedsecret.yaml"
secret_example="$root/k8s/secret.example.yaml"
sealed_key_count="$(awk '
  /^  encryptedData:/ { encrypted=1; next }
  /^  template:/ { encrypted=0 }
  encrypted && /^    [A-Z0-9_]+:/ { count += 1 }
  END { print count + 0 }
' "$snapshot_sealed")"
if printf '%s' "$snapshot_env_ref" | grep -q "name: ${snapshot_secret_name}" &&
   ! printf '%s' "$snapshot_env_ref" | grep -q 'name: backoffice-secrets' &&
   grep -q "secretName: ${snapshot_secret_name}" "$root/k8s/restore-rehearsal-job.yaml" &&
   [ "$(grep -c "^    ${snapshot_key}:" "$snapshot_sealed")" -eq 1 ] &&
   [ "$sealed_key_count" -eq 1 ] &&
   [ "$(grep -c "name: ${snapshot_secret_name}$" "$snapshot_sealed")" -eq 2 ] &&
   ! grep -q "^    ${snapshot_key}:" "$broad_sealed" &&
   [ "$(grep -c "^  ${snapshot_key}:" "$secret_example")" -eq 1 ] &&
   [ "$(grep -c "^  name: ${snapshot_secret_name}$" "$secret_example")" -eq 1 ]; then
  ok "snapshot signing key는 exact-key 전용 Secret 하나에서만 공급"
else
  ng "snapshot signing key가 broad Secret에 남았거나 consumer 경계가 깨졌다"
fi

provider_worker="$root/k8s/provider-execution-worker.yaml"
provider_out="$("$render" "$provider_worker" "$IMG" "$SHA")"
if ! grep -q ':latest' "$provider_worker" &&
   grep -q 'image: __BACKOFFICE_IMAGE_DIGEST__' "$provider_worker" &&
   printf '%s' "$provider_out" | grep -q "image: ${IMG}" &&
   ! printf '%s' "$provider_out" | grep -q '__BACKOFFICE_IMAGE_DIGEST__'; then
  ok "provider worker는 raw mutable image 없이 digest renderer만 허용"
else
  ng "provider worker immutable image 계약이 깨졌다"
fi

echo "== repository discovery worker 최소권한 =="
discovery_worker="$root/k8s/repository-discovery-worker.yaml"
if grep -q 'repository-discovery-worker.cjs' "$discovery_worker" &&
   grep -q '^  replicas: 1$' "$discovery_worker" &&
   grep -q 'readOnlyRootFilesystem: true' "$discovery_worker" &&
   grep -q 'automountServiceAccountToken: false' "$discovery_worker" &&
   grep -q 'key: DATABASE_URL' "$discovery_worker" &&
   grep -q 'key: GITHUB_APP_ID' "$discovery_worker" &&
   grep -q 'key: GITHUB_PRIVATE_KEY' "$discovery_worker" &&
   ! grep -q 'GITHUB_WEBHOOK_SECRET\|CONTROL_PLANE_ADMIN_TOKEN\|AGENT_WORKER_TOKEN' "$discovery_worker"; then
  ok "discovery worker는 DB와 GitHub read identity만 주입"
else
  ng "discovery worker 최소권한 경계가 깨졌다"
fi

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

resolve_out="$("$render" "$root/k8s/migration-baseline-resolve-job.yaml" "$IMG" "$SHA")"
if printf '%s' "$resolve_out" | grep -q "generateName: backoffice-baseline-resolve-${SHA:0:12}-" &&
   printf '%s' "$resolve_out" | grep -q "seorilabs.dev/source-sha: \"${SHA}\"" &&
   printf '%s' "$resolve_out" | grep -q "image: ${IMG}" &&
   printf '%s' "$resolve_out" | grep -q 'baseline-sha256:' &&
   printf '%s' "$resolve_out" | grep -q -- '--history=legacy' &&
   printf '%s' "$resolve_out" | grep -q -- '--history=cutover'; then
  ok "baseline resolve Job exact artifact identity"
else
  ng "baseline resolve Job artifact identity가 깨졌다"
fi

provider_trigger_out="$("$render" "$root/k8s/provider-audit-trigger-recovery-job.yaml" "$IMG" "$SHA")"
provider_resolve_out="$("$render" "$root/k8s/provider-migration-resolve-job.yaml" "$IMG" "$SHA")"
if printf '%s' "$provider_trigger_out" | grep -q "backoffice-provider-audit-triggers-${SHA:0:12}-" &&
   printf '%s' "$provider_trigger_out" | grep -q 'namespace: data' &&
   printf '%s' "$provider_trigger_out" | grep -q 'mysql-root-cred' &&
   ! printf '%s' "$provider_trigger_out" | grep -q 'log_bin_trust_function_creators\|GRANT TRIGGER\|MYSQL_PWD' &&
   printf '%s' "$provider_resolve_out" | grep -q "backoffice-provider-migration-resolve-${SHA:0:12}-" &&
   printf '%s' "$provider_resolve_out" | grep -q "image: ${IMG}" &&
   printf '%s' "$provider_resolve_out" | grep -q -- '--recovery-state="$migration"' &&
   printf '%s' "$provider_resolve_out" | grep -q 'provider migration recovery already complete' &&
   printf '%s' "$provider_resolve_out" | grep -q '미해결 migration attempt가 있다' &&
   printf '%s' "$provider_resolve_out" | grep -q 'prisma migrate resolve --applied'; then
  ok "provider audit partial migration은 exact trigger와 immutable resolve Job으로만 복구"
else
  ng "provider audit partial migration 복구 경계가 깨졌다"
fi

trigger_verifier="$root/k8s/provider-audit-trigger-verifier.yaml"
if grep -q 'kind: CronJob' "$trigger_verifier" &&
   grep -q 'namespace: data' "$trigger_verifier" &&
   grep -q 'image: mysql@sha256:' "$trigger_verifier" &&
   grep -q 'mysql-root-cred' "$trigger_verifier" &&
   grep -q 'readOnlyRootFilesystem: true' "$trigger_verifier" &&
   grep -q "trap 'rm -f \"\$cnf\"' EXIT INT TERM" "$trigger_verifier" &&
   grep -q 'automountServiceAccountToken: false' "$trigger_verifier" &&
   grep -q 'image: curlimages/curl@sha256:' "$trigger_verifier" &&
   grep -q 'kind: NetworkPolicy' "$trigger_verifier" &&
   grep -q 'resourceNames: \["backoffice-provider-audit-trigger-state"\]' "$trigger_verifier" &&
   ! grep -qE 'CREATE TRIGGER|DROP TRIGGER|GRANT |REVOKE |ALTER TABLE|DELETE FROM|INSERT INTO|MYSQL_PWD' "$trigger_verifier" &&
   ! grep -q ':latest' "$trigger_verifier"; then
  ok "고정 verifier는 read-only 확인과 공개 관측 기록만 수행"
else
  ng "trigger verifier 경계가 깨졌다"
fi

# CI deploy 경로가 verifier manifest를 apply하지 않는다. apply하면 CI가 root secret을
# mount하는 workload spec을 바꿀 수 있게 된다.
if ! grep -vE '^[[:space:]]*(#|echo )' "$here/deploy-backoffice.sh" \
     | grep -qE '(apply|create|render)[[:space:]].*provider-audit-trigger'; then
  ok "CI deploy는 verifier workload spec을 만들거나 바꾸지 않는다"
else
  ng "CI deploy가 verifier workload를 건드린다"
fi

restore_dump="backoffice-20260828T010203Z.sql.gz"
restore_out="$("$here/render-restore-rehearsal.sh" \
  "$root/k8s/restore-rehearsal-job.yaml" "$IMG" "$SHA" "$restore_dump")"
if printf '%s' "$restore_out" | grep -q "generateName: backoffice-restore-rehearsal-${SHA:0:12}-" &&
   printf '%s' "$restore_out" | grep -q "seorilabs.dev/source-sha: \"${SHA}\"" &&
   [ "$(printf '%s' "$restore_out" | grep -c "image: ${IMG}")" -eq 2 ] &&
   [ "$(printf '%s' "$restore_out" | grep -c "value: \"${restore_dump}\"")" -eq 2 ] &&
   ! printf '%s' "$restore_out" | grep -q '__BACKOFFICE_'; then
  ok "restore rehearsal exact artifact와 dump identity"
else
  ng "restore rehearsal renderer가 exact identity를 고정하지 못했다"
fi
if "$here/render-restore-rehearsal.sh" \
  "$root/k8s/restore-rehearsal-job.yaml" "$IMG" "$SHA" '../unsafe.sql.gz' >/dev/null 2>&1; then
  ng "restore rehearsal renderer가 안전하지 않은 dump 이름을 허용했다"
else
  ok "restore rehearsal의 안전하지 않은 dump 이름 거부"
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
   grep -q '409) echo "$label=busy"' "$catchup_job" &&
   grep -q 'repository-discovery/backfill' "$catchup_job" &&
   grep -q 'automation/platform-fleet' "$catchup_job" &&
   grep -q 'kubernetes.io/hostname: rpi5' "$catchup_job"; then
  ok "scheduler catch-up 격리와 감사 보존"
else
  ng "scheduler catch-up 실행 경계가 깨졌다"
fi

echo "== repository discovery backfill 스케줄 =="
backfill_doc="$(awk 'BEGIN { RS="---" } /name: backoffice-repository-discovery-backfill/ { print }' "$scheduler_cronjobs")"
if grep -q 'schedule: "7 \* \* \* \*"' <<<"$backfill_doc" &&
   grep -q 'concurrencyPolicy: Forbid' <<<"$backfill_doc" &&
   grep -q 'repository-discovery/backfill' <<<"$backfill_doc" &&
   grep -q 'automountServiceAccountToken: false' <<<"$backfill_doc" &&
   grep -q 'readOnlyRootFilesystem: true' <<<"$backfill_doc" &&
   ! grep -q 'GITHUB_PRIVATE_KEY\|GITHUB_WEBHOOK_SECRET' <<<"$backfill_doc"; then
  ok "full-org backfill은 hourly read-only trigger 하나로 직렬 실행"
else
  ng "repository discovery backfill schedule 또는 최소권한 경계가 깨졌다"
fi

if grep -q 'backoffLimit: 0' "$migration_job" &&
   grep -q 'ttlSecondsAfterFinished: 604800' "$migration_job" &&
   grep -q 'automountServiceAccountToken: false' "$migration_job" &&
   grep -q 'verify-migration-state.cjs' "$migration_job" &&
   grep -q -- '--history=predeploy' "$migration_job" &&
   grep -q -- '--expected-lineage=cutover' "$migration_job" &&
   grep -q 'fresh|cutover' "$migration_job" &&
   grep -q -- '--from-schema-datasource prisma/schema.prisma' "$migration_job" &&
   [ "$(grep -c 'key: DATABASE_URL' "$migration_job")" -eq 1 ]; then
  ok "migration Job 최소권한, checksum/schema gate와 7일 감사 보존"
else
  ng "migration Job 실행 경계가 깨졌다"
fi

backup_cronjob="$root/k8s/backup-cronjob.yaml"
backup_pvc="$root/k8s/backup-pvc.yaml"
if [ "$(grep -c '^kind: CronJob' "$backup_cronjob")" -eq 1 ] &&
   ! grep -q '^kind: PersistentVolumeClaim' "$backup_cronjob" &&
   grep -q '^kind: PersistentVolumeClaim' "$backup_pvc" &&
   grep -q 'automountServiceAccountToken: false' "$backup_cronjob" &&
   grep -q 'runAsNonRoot: true' "$backup_cronjob" &&
   grep -q 'readOnlyRootFilesystem: true' "$backup_cronjob" &&
   grep -q 'umask 077' "$backup_cronjob" &&
   grep -q -- '--skip-triggers' "$backup_cronjob" &&
   grep -q 'activeDeadlineSeconds: 1800' "$backup_cronjob" &&
   grep -q 'path: db-password' "$backup_cronjob" &&
   ! grep -q 'name: MYSQL_PWD' "$backup_cronjob"; then
  ok "backup CronJob credential 경계와 PVC mutation 분리"
else
  ng "backup CronJob credential 경계 또는 PVC 분리가 깨졌다"
fi

restore_job="$root/k8s/restore-rehearsal-job.yaml"
if grep -q 'claimName: backoffice-backup' "$restore_job" &&
   grep -q 'mountPath: /backup' "$restore_job" &&
   grep -q 'readOnly: true' "$restore_job" &&
   grep -q 'medium: Memory' "$restore_job" &&
   grep -q 'backoffice_rehearsal' "$restore_job" &&
   grep -q 'POD_SCOPED_EMPTYDIR' "$root/scripts/verify-restore-rehearsal.ts" &&
   grep -q 'ensureRestoredAppendOnlyTriggers' "$root/scripts/verify-restore-rehearsal.ts" &&
   grep -q 'RECONSTRUCTED_FROM_SOURCE_CONTRACT' "$root/src/lib/control-plane/restore-rehearsal.ts" &&
   ! grep -q 'key: DATABASE_URL' "$restore_job" &&
   ! grep -q 'key: DB_PASSWORD' "$restore_job" &&
   grep -q 'CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_FILE' "$restore_job" &&
   grep -q 'secretName: backoffice-control-plane-snapshot-signing' "$restore_job" &&
   ! grep -A8 'name: signing-key' "$restore_job" | grep -q 'secretName: backoffice-secrets' &&
   grep -q 'touch /state/stop' "$restore_job" &&
   grep -q 'Failed=True' "$root/scripts/run-restore-rehearsal.sh" &&
   ! grep -q 'wait --for=condition=complete' "$root/scripts/run-restore-rehearsal.sh"; then
  ok "restore rehearsal production DB 비접근·ephemeral cleanup 경계"
else
  ng "restore rehearsal 격리 또는 cleanup 경계가 깨졌다"
fi

fleet_parity_job="$root/k8s/fleet-parity-wave-job.yaml"
if grep -q 'fieldPath: metadata.uid' "$fleet_parity_job" &&
   grep -q '^  backoffLimit: 0$' "$fleet_parity_job" &&
   grep -q 'automountServiceAccountToken: false' "$fleet_parity_job" &&
   grep -q 'GITHUB_PRIVATE_KEY_FILE' "$fleet_parity_job" &&
   grep -q 'path: private-key' "$fleet_parity_job" &&
   ! grep -q 'name: GITHUB_PRIVATE_KEY$' "$fleet_parity_job" &&
   grep -q 'ttlSecondsAfterFinished: 604800' "$fleet_parity_job"; then
  ok "Fleet parity 단일 occurrence와 secret file 경계"
else
  ng "Fleet parity Job occurrence 또는 secret 경계가 깨졌다"
fi

if [ "$(grep -c '^kind: CronJob' "$scheduler_cronjobs")" -eq 6 ] &&
   [ "$(grep -c 'concurrencyPolicy: Forbid' "$scheduler_cronjobs")" -eq 6 ] &&
   [ "$(grep -c 'kubernetes.io/hostname: rpi5' "$scheduler_cronjobs")" -eq 6 ] &&
   [ "$(grep -c 'curlimages/curl@sha256:' "$scheduler_cronjobs")" -eq 6 ] &&
   [ "$(grep -c 'suspend: false' "$scheduler_cronjobs")" -eq 6 ] &&
   [ "$(grep -c 'curl --config - -fsS -o /dev/null' "$scheduler_cronjobs")" -eq 6 ] &&
   [ "$(grep -c 'path: admin-token' "$scheduler_cronjobs")" -eq 6 ] &&
   ! grep -q 'name: ADMIN_TOKEN' "$scheduler_cronjobs" "$catchup_job" &&
   grep -q '/api/admin/reconcile' "$scheduler_cronjobs" &&
   grep -q '/api/admin/repository-discovery/backfill' "$scheduler_cronjobs" &&
   grep -q '/api/admin/xcode-cloud/sync' "$scheduler_cronjobs" &&
   grep -q '/api/admin/seed' "$scheduler_cronjobs" &&
   grep -q '/api/admin/automation/schedule' "$scheduler_cronjobs" &&
   grep -q '/api/admin/automation/platform-fleet' "$scheduler_cronjobs"; then
  ok "scheduler CronJob 6개 직렬화"
else
  ng "scheduler CronJob 계약이 깨졌다"
fi

platform_rbac="$root/k8s/ci-deployer-rbac.yaml"
data_rbac="$root/k8s/ci-deployer-data-rbac.yaml"
if grep -q 'resources: \["jobs"\]' "$platform_rbac" &&
   ! grep -q 'resources: \["pods/log"\]' "$platform_rbac" &&
   ! grep -q 'resources: \["secrets"\]' "$platform_rbac" &&
   grep -q 'resourceNames: \["vault-indexer", "vault-writer"\]' "$data_rbac" &&
   grep -q 'resourceNames: \["backoffice-provider-audit-trigger-state"\]' "$data_rbac" &&
   grep -q 'resourceNames: \["vault-indexer", "vault-writer"\]' "$data_rbac" &&
   [ "$(grep -c 'verbs: \["get"\]' "$data_rbac")" -eq 2 ] &&
   ! grep -q 'resources: \["jobs"\]' "$data_rbac" &&
   ! grep -q 'resources: \["pods"\]' "$data_rbac" &&
   ! grep -q 'resources: \["secrets"\]' "$data_rbac" &&
   ! grep -q 'resources: \["pods/log"\]' "$data_rbac" &&
   ! grep -qE 'verbs:.*(create|patch|update|delete)' "$data_rbac"; then
  ok "CI는 data ns workload를 만들거나 바꿀 수 없고 관측만 읽는다"
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
