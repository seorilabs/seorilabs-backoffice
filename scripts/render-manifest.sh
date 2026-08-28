#!/usr/bin/env bash
#
# 매니페스트의 :latest 이미지를 지정한 immutable digest로 바꿔 stdout 으로 내보낸다.
# Job 매니페스트는 source SHA를 metadata에도 넣어 실행 기록을 소스와 결합한다.
#
#   scripts/render-manifest.sh k8s/deployment.yaml registry/x/y@sha256:<digest> <source-sha>
#
# apply 뒤에 kubectl set image 로 고치는 방법도 되지만, 그 사이 :latest 로 한 번
# rollout 이 돌아 노드 캐시에 남은 예전 :latest 가 잠깐 뜰 수 있다.
# imagePullPolicy 가 Always 라도 창은 남는다. 치환해서 한 번만 굴린다.
#
# 치환이 조용히 빗나가면 :latest 로 배포된다. 그게 가장 나쁜 실패라
# 대상이 없으면 출력하지 않고 죽는다.
set -euo pipefail

usage() {
  echo "사용법: $0 <매니페스트> <이미지> [source-sha]" >&2
  echo "  예: $0 k8s/deployment.yaml registry.example/app@sha256:<64자리-digest> <40자리-git-sha>" >&2
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  usage
  exit 2
fi

manifest="$1"
image="$2"
source_sha="${3:-}"

if [ ! -f "$manifest" ]; then
  echo "오류: $manifest 가 없다" >&2
  exit 1
fi

# digest 또는 tag를 떼어 저장소 이름을 얻는다. 이 이름의 :latest 만 바꾼다.
# 다른 이미지(curlimages/curl 등)는 건드리지 않는다.
if [[ "$image" =~ ^(.+)@sha256:([0-9a-f]{64})$ ]]; then
  repo="${BASH_REMATCH[1]}"
elif [[ "$image" == *:* ]]; then
  repo="${image%:*}"
  tag="${image##*:}"
  if [ -z "$source_sha" ] && [[ "$tag" =~ ^[0-9a-f]{40}$ ]]; then
    source_sha="$tag"
  fi
else
  echo "오류: 이미지에 digest 또는 tag가 없다: $image" >&2
  exit 1
fi

has_image=false
has_source=false
has_digest_placeholder=false
grep -q "${repo}:latest" "$manifest" && has_image=true
grep -q '__BACKOFFICE_IMAGE_TAG__' "$manifest" && has_source=true
grep -q '__BACKOFFICE_IMAGE_DIGEST__' "$manifest" && has_digest_placeholder=true
if [ "$has_image" = false ] && [ "$has_source" = false ] && [ "$has_digest_placeholder" = false ]; then
  echo "오류: $manifest 에 이미지나 source SHA placeholder가 없다. 치환이 깨졌다." >&2
  exit 1
fi

if [ "$has_source" = true ]; then
  if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "오류: Job identity에는 40자리 source SHA가 필요하다" >&2
    exit 1
  fi
  short_tag="${source_sha:0:12}"
  sed \
    -e "s|${repo}:latest|${image}|g" \
    -e "s|__BACKOFFICE_IMAGE_DIGEST__|${image}|g" \
    -e "s|__BACKOFFICE_IMAGE_TAG_SHORT__|${short_tag}|g" \
    -e "s|__BACKOFFICE_IMAGE_TAG__|${source_sha}|g" \
    "$manifest"
else
  sed \
    -e "s|${repo}:latest|${image}|g" \
    -e "s|__BACKOFFICE_IMAGE_DIGEST__|${image}|g" \
    "$manifest"
fi
