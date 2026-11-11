#!/usr/bin/env bash
set -euo pipefail

BRANCH="main"
REPO="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$REPO/docker-compose.yml"
SERVER_IMAGE="car-tracker-server:latest"
CLIENT_IMAGE="car-tracker-client:latest"

# --pull-base-images: opt-in registry check for a newer base image (FROM ...).
# Off by default — pulling the base on every rebuild is slow for basically no
# benefit; run it manually now and then to pick up upstream base updates.
# --force: rebuild and restart even if the pull brought no new commits.
PULL_BASE_IMAGES=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --pull-base-images) PULL_BASE_IMAGES=1 ;;
    --force) FORCE=1 ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--pull-base-images] [--force]"
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

echo "==> Fetching latest code..."
git -C "$REPO" fetch origin "$BRANCH"

echo "==> Switching to branch: $BRANCH"
git -C "$REPO" checkout "$BRANCH"

# Discard ALL local changes - tracked edits and untracked files alike - and
# land exactly on origin's history, no matter what state the working copy or
# local branch was in (diverged history, a failed merge, manual edits...).
# git clean skips anything gitignored (.env, data/), so those are untouched.
echo "==> Discarding any local changes..."
git -C "$REPO" reset --hard "origin/$BRANCH"
git -C "$REPO" clean -fd

HEAD_COMMIT=$(git -C "$REPO" rev-parse HEAD)

# running_commit <service>: the car-tracker.commit label baked into the image
# a running container for that service was built from, or empty if the
# service isn't running (or was built before this label existed).
running_commit() {
  local cid
  cid=$(docker compose -f "$COMPOSE_FILE" ps -q "$1" 2>/dev/null)
  [ -n "$cid" ] || return 0
  docker inspect --format '{{ index .Config.Labels "car-tracker.commit" }}' "$cid" 2>/dev/null || true
}

# Skip the (slow) build + restart only if what's actually running already
# matches HEAD - not just "the pull brought no new commits", which misses a
# container restarted from a stale image, an interrupted previous run, etc.
# --force always proceeds.
if [ "$FORCE" -eq 0 ] \
   && [ "$(running_commit server)" = "$HEAD_COMMIT" ] \
   && [ "$(running_commit client)" = "$HEAD_COMMIT" ]; then
  echo "==> Running containers already match HEAD ($HEAD_COMMIT) - nothing to do."
  echo "    (use --force to rebuild/restart anyway)"
  docker compose -f "$COMPOSE_FILE" ps
  exit 0
fi

# Ensure host-side data dir exists before Docker bind-mounts it (all persisted
# data lives under $REPO/data so a backup/restore is just that one folder).
echo "==> Creating data directories..."
mkdir -p "$REPO/data/postgres"

# Build both images directly with buildx so BuildKit is guaranteed. Compose's
# buildx detection is unreliable on some hosts and can silently fall back to the
# legacy (non-BuildKit) builder. --load makes each built image available to the
# local Docker daemon so Compose can pick it up by the tag pinned in
# docker-compose.yml (image: car-tracker-server:latest / car-tracker-client:latest).
# The car-tracker.commit label is what running_commit() above reads on the
# next run to tell whether a deployed container matches the current HEAD.
#
# NOTE: use --tag (long form), never -t — on some hosts -t has tripped a bogus
# "unknown shorthand flag" error even though `docker buildx build` works fine.
BUILD_ARGS=(--load --label "car-tracker.commit=$HEAD_COMMIT")
if [ "$PULL_BASE_IMAGES" -eq 1 ]; then
  echo "    (--pull-base-images set: forcing a base-image registry check)"
  BUILD_ARGS+=(--pull)
fi

echo "==> Building $SERVER_IMAGE with buildx (commit: $HEAD_COMMIT)..."
docker buildx build --tag "$SERVER_IMAGE" "${BUILD_ARGS[@]}" "$REPO/server"

echo "==> Building $CLIENT_IMAGE with buildx (commit: $HEAD_COMMIT)..."
docker buildx build --tag "$CLIENT_IMAGE" "${BUILD_ARGS[@]}" "$REPO/client"

echo "==> Restarting containers..."
docker compose -f "$COMPOSE_FILE" down
# --no-build: Compose must use the images buildx just built, never build its own
# (its unreliable builder is exactly the problem we're routing around).
docker compose -f "$COMPOSE_FILE" up -d --no-build

echo "==> Done. Containers are running."
docker compose -f "$COMPOSE_FILE" ps
