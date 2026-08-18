#!/usr/bin/env bash
#
# render-manifest.sh 계약을 고정한다.
#
# 이 스크립트가 조용히 빗나가면 :latest 로 배포된다. 어떤 이미지가 도는지
# 아무도 모르는 상태가 되므로, 실패는 반드시 exit 1 이어야 한다.
#
# CD 가 실제로 쓰는 두 매니페스트를 그대로 넣어 돌린다. 매니페스트에서
# 이미지 줄이 사라지거나 이름이 바뀌면 여기서 걸린다.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
render="$here/render-manifest.sh"

REPO="registry.vzyx.xyz/seorilabs/seorilabs-backoffice"
SHA="0123456789abcdef0123456789abcdef01234567"
IMG="${REPO}:${SHA}"

fail=0
ok() { printf '  ok   %s\n' "$1"; }
ng() { printf '  FAIL %s\n' "$1" >&2; fail=1; }

# CD 가 render 를 거쳐 apply 하는 매니페스트.
MANIFESTS=(k8s/deployment.yaml k8s/app-ops-worker.yaml k8s/discord-workers.yaml k8s/store-review-cronjob.yaml)

echo "== 치환 =="
for m in "${MANIFESTS[@]}"; do
  out="$("$render" "$root/$m" "$IMG")" || { ng "$m 렌더가 실패했다"; continue; }

  if printf '%s' "$out" | grep -q "${REPO}:latest"; then
    ng "$m 에 :latest 가 남았다"
    continue
  fi

  # 매니페스트에 있던 이미지 줄 수만큼 치환돼야 한다.
  # deployment.yaml 은 initContainer(migrate)와 앱 컨테이너 둘이다.
  want=$(grep -c "${REPO}:latest" "$root/$m")
  got=$(printf '%s' "$out" | grep -c "${REPO}:${SHA}")
  if [ "$want" -ne "$got" ]; then
    ng "$m 치환 개수가 다르다: 기대 $want, 실제 $got"
    continue
  fi
  ok "$m ($got 곳)"
done

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

echo "== 대상이 없으면 죽는다 =="
# :latest 가 없는 매니페스트를 만들어 넣는다. 조용히 통과하면 안 된다.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf 'apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - image: curlimages/curl:8.11.1\n' > "$tmp"

out="$("$render" "$tmp" "$IMG" 2>/dev/null)"
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
out="$("$render" "$tmp" "$IMG")"
if printf '%s' "$out" | grep -q "curlimages/curl:latest"; then
  ok "curlimages/curl:latest 유지"
else
  ng "관계없는 이미지가 바뀌었다"
fi

echo "== 인자 검증 =="
"$render" "$root/k8s/deployment.yaml" >/dev/null 2>&1
[ $? -eq 2 ] && ok "인자 부족은 exit 2" || ng "인자 부족인데 exit 2 가 아니다"

"$render" "$root/k8s/deployment.yaml" "$REPO" >/dev/null 2>&1
[ $? -eq 1 ] && ok "태그 없는 이미지는 exit 1" || ng "태그가 없는데 통과했다"

"$render" "$root/k8s/없는파일.yaml" "$IMG" >/dev/null 2>&1
[ $? -eq 1 ] && ok "없는 파일은 exit 1" || ng "없는 파일인데 통과했다"

if [ "$fail" -ne 0 ]; then
  echo "render-manifest 계약이 깨졌다." >&2
  exit 1
fi
echo "render-manifest 계약 통과"
