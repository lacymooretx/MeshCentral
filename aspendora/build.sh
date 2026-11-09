#!/usr/bin/env bash
# Build the Aspendora MeshCentral image from this fork on the Docker host, by default VM 301.
# Usage: aspendora/build.sh <image-tag> [docker-host-ssh]
#   e.g. aspendora/build.sh aspendora/meshcentral:1.3.1-asp1
# BASE_VERSION (the upstream image to overlay) comes from aspendora/BASE_VERSION.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
TAG=${1:?image tag}; HOST=${2:-root@10.10.30.101}
BASE=$(cat aspendora/BASE_VERSION)
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; commit first" >&2; exit 1; }
COMMIT=$(git rev-parse HEAD)
# Every file changed since the upstream base tag must be in the overlay list (and vice versa), or the image won't match the fork.
CHANGED=$(git diff --name-only "$BASE" HEAD -- . ':!aspendora' ':!.github' | sort)
LISTED=$(grep -v '^#' aspendora/OVERLAY | sed '/^$/d' | sort)
if [ "$CHANGED" != "$LISTED" ]; then
  echo "aspendora/OVERLAY does not match the files changed since $BASE:" >&2; diff <(echo "$LISTED") <(echo "$CHANGED") >&2; exit 1
fi
CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
mkdir "$CTX/overlay"; cp aspendora/Dockerfile "$CTX/"
git archive HEAD $LISTED | COPYFILE_DISABLE=1 tar -x -C "$CTX/overlay"
echo "Building $TAG from $COMMIT on $HOST (base $BASE, overlay: $(echo $LISTED))"
COPYFILE_DISABLE=1 tar -C "$CTX" -cz . | ssh "$HOST" "docker build --build-arg BASE_VERSION=$BASE --build-arg GIT_COMMIT=$COMMIT -t $TAG -"
