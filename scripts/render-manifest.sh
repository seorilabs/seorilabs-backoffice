#!/usr/bin/env bash
#
# 매니페스트의 :latest 이미지를 지정한 태그로 바꿔 stdout 으로 내보낸다.
#
#   scripts/render-manifest.sh k8s/deployment.yaml registry/x/y:abc123 | kubectl apply -f -
#
# apply 뒤에 kubectl set image 로 고치는 방법도 되지만, 그 사이 :latest 로 한 번
# rollout 이 돌아 노드 캐시에 남은 예전 :latest 가 잠깐 뜰 수 있다.
# imagePullPolicy 가 Always 라도 창은 남는다. 치환해서 한 번만 굴린다.
#
# 치환이 조용히 빗나가면 :latest 로 배포된다. 그게 가장 나쁜 실패라
# 대상이 없으면 출력하지 않고 죽는다.
set -euo pipefail

usage() {
  echo "사용법: $0 <매니페스트> <이미지태그>" >&2
  echo "  예: $0 k8s/deployment.yaml registry.vzyx.xyz/seorilabs/seorilabs-backoffice:abc123" >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

manifest="$1"
image="$2"

if [ ! -f "$manifest" ]; then
  echo "오류: $manifest 가 없다" >&2
  exit 1
fi

# 태그를 떼어 저장소 이름을 얻는다. 이 이름의 :latest 만 바꾼다.
# 다른 이미지(curlimages/curl 등)는 건드리지 않는다.
repo="${image%:*}"
if [ "$repo" = "$image" ]; then
  echo "오류: 이미지에 태그가 없다: $image" >&2
  exit 1
fi

if ! grep -q "${repo}:latest" "$manifest"; then
  echo "오류: $manifest 에 ${repo}:latest 가 없다. 이미지 치환이 깨졌다." >&2
  exit 1
fi

sed "s|${repo}:latest|${image}|g" "$manifest"
