#!/usr/bin/env bash
set -euo pipefail

command="${1:-up}"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stack_dir="$project_root/.laminar-stack"
repository="https://github.com/lmnr-ai/lmnr.git"

require_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "Docker Desktop (with Docker Compose v2) is required." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is installed but its daemon is not running. Start Docker Desktop, then run npm run laminar:up again." >&2
    exit 1
  fi
}

bootstrap() {
  if [[ ! -d "$stack_dir/.git" ]]; then
    git clone --depth 1 "$repository" "$stack_dir"
  fi
}

compose() {
  docker compose \
    --project-directory "$stack_dir" \
    --env-file "$stack_dir/.env" \
    -f "$stack_dir/docker-compose.yml" \
    "$@"
}

case "$command" in
  bootstrap)
    bootstrap
    echo "Laminar Docker files are ready in .laminar-stack/."
    ;;
  up)
    require_docker
    bootstrap
    compose up -d
    echo "Laminar is starting. Open http://localhost:5667 when the containers are healthy."
    ;;
  down)
    require_docker
    [[ -d "$stack_dir" ]] || exit 0
    compose down
    ;;
  logs)
    require_docker
    [[ -d "$stack_dir" ]] || { echo "Run npm run laminar:up first." >&2; exit 1; }
    compose logs -f
    ;;
  update)
    require_docker
    bootstrap
    git -C "$stack_dir" pull --ff-only
    compose up -d
    ;;
  *)
    echo "Usage: $0 {bootstrap|up|down|logs|update}" >&2
    exit 1
    ;;
esac
