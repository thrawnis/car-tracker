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

echo "==> Switching to branch: $BRANCH"
git -C "$REPO" checkout "$BRANCH"

echo "==> Discarding any local changes..."
git -C "$REPO" reset --hard

BEFORE_COMMIT=$(git -C "$REPO" rev-parse HEAD)

echo "==> Pulling latest code..."
git -C "$REPO" pull origin "$BRANCH"

AFTER_COMMIT=$(git -C "$REPO" rev-parse HEAD)

# Skip the (slow) build + restart if nothing changed and the stack is already
# up - re-running this unattended (e.g. from cron) shouldn't bounce containers
# for no reason. --force, or no containers currently running, always proceeds.
if [ "$FORCE" -eq 0 ] && [ "$BEFORE_COMMIT" = "$AFTER_COMMIT" ] \
   && [ -n "$(docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null)" ]; then
  echo "==> No new commits and containers are already running - nothing to do."
  echo "    (use --force to rebuild/restart anyway)"
  docker compose -f "$COMPOSE_FILE" ps
  exit 0
fi

# Ensure host-side data dir exists before Docker bind-mounts it (all persisted
# data lives under $REPO/data so a backup/restore is just that one folder).
echo "==> Creating data directories..."
mkdir -p "$REPO/data/postgres"

COMMIT=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Build both images directly with buildx so BuildKit is guaranteed. Compose's
# buildx detection is unreliable on some hosts and can silently fall back to the
# legacy (non-BuildKit) builder. --load makes each built image available to the
# local Docker daemon so Compose can pick it up by the tag pinned in
# docker-compose.yml (image: car-tracker-server:latest / car-tracker-client:latest).
#
# NOTE: use --tag (long form), never -t — on some hosts -t has tripped a bogus
# "unknown shorthand flag" error even though `docker buildx build` works fine.
BUILD_ARGS=(--load)
if [ "$PULL_BASE_IMAGES" -eq 1 ]; then
  echo "    (--pull-base-images set: forcing a base-image registry check)"
  BUILD_ARGS+=(--pull)
fi

echo "==> Building $SERVER_IMAGE with buildx (commit: $COMMIT)..."
docker buildx build --tag "$SERVER_IMAGE" "${BUILD_ARGS[@]}" "$REPO/server"

echo "==> Building $CLIENT_IMAGE with buildx (commit: $COMMIT)..."
docker buildx build --tag "$CLIENT_IMAGE" "${BUILD_ARGS[@]}" "$REPO/client"

echo "==> Restarting containers..."
docker compose -f "$COMPOSE_FILE" down
# --no-build: Compose must use the images buildx just built, never build its own
# (its unreliable builder is exactly the problem we're routing around).
docker compose -f "$COMPOSE_FILE" up -d --no-build

echo "==> Done. Containers are running."
docker compose -f "$COMPOSE_FILE" ps
