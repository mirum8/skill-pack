#!/usr/bin/env bash
#
# worktree-deploy.sh — location-aware deploy for /test-app verification.
#
# The behaviour is decided purely by WHERE you run it, never by who calls it:
#
#   * main working tree  -> default port + default config (today's behaviour).
#   * linked git worktree -> a fully isolated, ephemeral docker compose stack:
#                            unique project name, ephemeral host port, unique
#                            container names, its own volumes -> per-worktree
#                            ephemeral DB. Removed after the run.
#
# Subcommands (each branches on main vs worktree):
#
#   deploy [DEFAULT_CMD]   main: runs DEFAULT_CMD verbatim (the project's normal
#                          rebuild/redeploy). worktree: brings up an isolated
#                          stack and records its live URL.
#   prewarm                builds the app image but starts NOTHING, so a later
#                          deploy hits a warm layer cache. Best-effort: always
#                          exits 0. main: the project's own tag. worktree: that
#                          worktree's per-id tag, never the shared one.
#   base-url [DEFAULT_URL] main: echoes DEFAULT_URL. worktree: echoes the live
#                          URL of this worktree's isolated stack (exit 1 if it
#                          is not up yet).
#   teardown               main: no-op. worktree: docker compose down -v for this
#                          worktree's stack (removes its containers + volumes).
#   mode                   prints "main" or "worktree".
#
# Knobs (env, only needed in worktree mode; auto-detected otherwise):
#   COMPOSE_FILE         compose file(s), compose-native (colon-separated).
#   APP_SERVICE          the service to publish/test (default: first service
#                        with a build: section).
#   APP_CONTAINER_PORT   the port the app listens on inside the container
#                        (default: the app service's first mapped target port).
#
set -euo pipefail

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "worktree-deploy: required command not found: $1" >&2
    exit 127
  }
}
require_bin git
require_bin python3
require_bin lsof
require_bin docker
docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1 || {
  echo "worktree-deploy: 'docker compose' (or docker-compose) not available" >&2
  exit 127
}

sub=${1:-}
[ -n "$sub" ] && shift || true

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "worktree-deploy: not inside a git repo" >&2
  exit 2
}
git_dir=$(cd "$(git rev-parse --git-dir)" && pwd)
common_dir=$(cd "$(git rev-parse --git-common-dir)" && pwd)

if [ "$git_dir" = "$common_dir" ]; then
  mode=main
else
  mode=worktree
  id="wt-$(printf '%s' "$root" | shasum | cut -c1-8)"
  state_url="${TMPDIR:-/tmp}/worktree-deploy-$id.url"
  state_cfg="${TMPDIR:-/tmp}/worktree-deploy-$id.json"
  state_ext="${TMPDIR:-/tmp}/worktree-deploy-$id.extvols"
fi

discover_compose() {
  if [ -n "${COMPOSE_FILE:-}" ]; then printf '%s' "$COMPOSE_FILE"; return 0; fi
  local f
  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    [ -f "$root/$f" ] && { printf '%s' "$f"; return 0; }
  done
  return 1
}

# Polls until the published host port accepts a TCP connection, or the bounded
# deadline (WTD_READY_TIMEOUT secs, default 90) passes. Returns non-zero on
# timeout so the caller can tear the partial stack down.
wait_ready() {
  local host_port="$1" deadline
  deadline=$(( $(date +%s) + ${WTD_READY_TIMEOUT:-90} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if lsof -iTCP:"$host_port" -sTCP:LISTEN >/dev/null 2>&1 \
       || (exec 3<>"/dev/tcp/localhost/$host_port") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      return 0
    fi
    sleep 2
  done
  return 1
}

# Rewrites the resolved compose config ($IN, JSON) so the stack is safe to run
# alongside the main one: the app port is republished on an ephemeral host port
# (Docker picks, read back after `up -d` — no check-then-use race) and every
# container_name is suffixed with the worktree id. Writes the result to $OUT (a
# self-contained compose file fed back via `-f`). Prints the app service name.
# The program comes in over the heredoc, so the config travels by file, not stdin.
rewrite_config() {
  IN="$1" OUT="$2" EXT_VOLS_OUT="$state_ext" WT_ID="$id" python3 - <<'PY'
import json, os, sys
with open(os.environ["IN"]) as fh:
    cfg = json.load(fh)
services = cfg.get("services", {})

app = os.environ.get("APP_SERVICE", "")
if not app:
    app = next((n for n, s in services.items() if s.get("build")), "")
if not app:
    sys.stderr.write("worktree-deploy: could not detect the app service; set APP_SERVICE\n")
    sys.exit(3)

port = os.environ.get("APP_CONTAINER_PORT", "")
if not port:
    ports = services.get(app, {}).get("ports", [])
    if ports:
        port = ports[0].get("target", "")
if not port:
    sys.stderr.write("worktree-deploy: could not detect the app container port; set APP_CONTAINER_PORT\n")
    sys.exit(3)

wt = os.environ.get("WT_ID", "wt")

def ephemeral(ports):
    # Drop the fixed host port so Docker assigns a random one — supporting
    # services (db, minio, mailhog, ...) must not collide across worktrees.
    out = []
    for p in ports:
        if isinstance(p, dict):
            out.append({k: v for k, v in p.items() if k != "published"})
        elif isinstance(p, str) and ":" in p:
            out.append(p.rsplit(":", 1)[-1])
        else:
            out.append(p)
    return out

for name, svc in services.items():
    if svc.get("container_name"):
        svc["container_name"] = f'{svc["container_name"]}-{wt}'
    # A locally-built service with an explicit image tag would otherwise clobber
    # the shared tag (e.g. app:local) — give each worktree its own tag.
    if svc.get("build") and svc.get("image"):
        svc["image"] = f'{svc["image"]}-{wt}'
    if name == app:
        # published "0" => Docker assigns a free host port atomically on `up -d`;
        # we read it back afterwards, so two worktrees can never pick the same one.
        svc["ports"] = [{"target": int(port), "published": "0", "protocol": "tcp", "mode": "ingress"}]
    elif svc.get("ports"):
        svc["ports"] = ephemeral(svc["ports"])

# External volumes are shared (e.g. with the main stack); record their names so
# teardown can avoid wiping them with `down -v`.
external = sorted(
    n for n, v in (cfg.get("volumes") or {}).items()
    if isinstance(v, dict) and v.get("external")
)
ext_path = os.environ.get("EXT_VOLS_OUT", "")
if ext_path:
    with open(ext_path, "w") as fh:
        fh.write("\n".join(external))

cfg.pop("name", None)
with open(os.environ["OUT"], "w") as fh:
    json.dump(cfg, fh)
print(app)
PY
}

case "$sub" in
  mode)
    echo "$mode"
    ;;

  deploy)
    if [ "$mode" = main ]; then
      [ "$#" -gt 0 ] && eval "$1"
      exit 0
    fi
    compose=$(discover_compose) || {
      echo "worktree-deploy: no compose file found; set COMPOSE_FILE" >&2
      exit 2
    }
    # Tear down the partial stack only on the failure path; a successful deploy
    # must leave it UP for the caller to test (teardown is a separate command).
    # Skip `-v` if external (shared) volumes are present, to not clobber them.
    # An explicit `exit` does NOT fire an ERR trap, so the explicit-failure
    # branches below call this directly; the trap covers implicit failures.
    wt_teardown() { local fw; [ -s "$state_ext" ] && fw= || fw=-v; docker compose -p "$id" down $fw 2>/dev/null || true; }
    trap wt_teardown ERR
    raw_cfg="${TMPDIR:-/tmp}/worktree-deploy-$id.raw.json"
    COMPOSE_FILE="$compose" docker compose config --format json > "$raw_cfg"
    app_service=$(rewrite_config "$raw_cfg" "$state_cfg")
    rm -f "$raw_cfg"
    container_port=${APP_CONTAINER_PORT:-}
    if [ -z "$container_port" ]; then
      container_port=$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); p=c["services"][sys.argv[2]]["ports"][0]; print(p["target"])' "$state_cfg" "$app_service")
    fi
    docker compose -p "$id" -f "$state_cfg" up -d --build >&2
    # Docker chose the host port; read it back (no check-then-use race).
    host_port=$(docker compose -p "$id" -f "$state_cfg" port "$app_service" "$container_port" | sed 's/.*://')
    if [ -z "$host_port" ]; then
      echo "worktree-deploy: could not resolve the published host port for '$app_service' — tearing down" >&2
      wt_teardown
      exit 1
    fi
    if ! wait_ready "$host_port"; then
      echo "worktree-deploy: $id not ready within ${WTD_READY_TIMEOUT:-90}s — tearing down" >&2
      wt_teardown
      exit 1
    fi
    trap - ERR
    url="http://localhost:$host_port"
    printf '%s' "$url" > "$state_url"
    echo "worktree-deploy: $id up at $url (service '$app_service')" >&2
    echo "$url"
    ;;

  prewarm)
    # Build the app image WITHOUT starting anything, so a later `deploy` hits a warm
    # layer cache instead of building from scratch on the critical path. Called while
    # the review's end-verify still runs. Nothing is started, so it cannot serve stale
    # code: a source edit below only invalidates the layers that file touches, and the
    # real deploy rebuilds those. Best-effort by DESIGN — every failure path exits 0,
    # because a cold cache is slow, not wrong, and this must never fail a review.
    compose=$(discover_compose) || {
      echo "worktree-deploy: prewarm skipped — no compose file found" >&2; exit 0; }
    if [ "$mode" = worktree ]; then
      # Build the worktree's OWN image tag. A bare `docker compose build` here would
      # rebuild the shared tag (e.g. app:local) with this worktree's code — the exact
      # cross-worktree bleed the rest of this script exists to prevent.
      raw_cfg="${TMPDIR:-/tmp}/worktree-deploy-$id.prewarm.json"
      COMPOSE_FILE="$compose" docker compose config --format json > "$raw_cfg" 2>/dev/null || {
        echo "worktree-deploy: prewarm skipped — could not resolve the compose config" >&2
        rm -f "$raw_cfg"; exit 0; }
      app_service=$(rewrite_config "$raw_cfg" "$state_cfg") || {
        echo "worktree-deploy: prewarm skipped — could not detect the app service" >&2
        rm -f "$raw_cfg"; exit 0; }
      rm -f "$raw_cfg"
      if docker compose -p "$id" -f "$state_cfg" build "$app_service" >&2; then
        echo "worktree-deploy: prewarm built '$app_service' for $id — layer cache warm" >&2
      else
        echo "worktree-deploy: prewarm build failed — ignored, the deploy will build" >&2
      fi
      exit 0
    fi
    # Main tree: this builds the project's own tag, which is exactly what the deploy a
    # few minutes later would build anyway — same image, just earlier.
    svc=${APP_SERVICE:-}
    if [ -z "$svc" ]; then
      svc=$(COMPOSE_FILE="$compose" docker compose config --format json 2>/dev/null \
        | python3 -c 'import json,sys; c=json.load(sys.stdin); print(next((n for n,s in (c.get("services") or {}).items() if s.get("build")),""))' 2>/dev/null) || svc=""
    fi
    [ -n "$svc" ] || { echo "worktree-deploy: prewarm skipped — no buildable service" >&2; exit 0; }
    if COMPOSE_FILE="$compose" docker compose build "$svc" >&2; then
      echo "worktree-deploy: prewarm built '$svc' — layer cache warm" >&2
    else
      echo "worktree-deploy: prewarm build failed — ignored, the deploy will build" >&2
    fi
    exit 0
    ;;

  base-url)
    if [ "$mode" = main ]; then
      [ "$#" -gt 0 ] && printf '%s\n' "$1"
      exit 0
    fi
    if [ -s "$state_url" ]; then
      cat "$state_url"
    else
      echo "worktree-deploy: $id is not deployed (run 'deploy' first)" >&2
      exit 1
    fi
    ;;

  teardown)
    if [ "$mode" = main ]; then exit 0; fi
    # `-v` wipes the stack's named volumes (the ephemeral per-worktree DB) but
    # would also try to clobber shared external: true volumes — skip it then.
    wipe=-v
    if [ -s "$state_ext" ]; then
      wipe=
      echo "worktree-deploy: $id has external volumes ($(tr '\n' ' ' < "$state_ext")); keeping volumes (no -v)" >&2
    fi
    if [ -f "$state_cfg" ]; then
      docker compose -p "$id" -f "$state_cfg" down $wipe >&2 || true
    else
      docker compose -p "$id" down $wipe >&2 || true
    fi
    rm -f "$state_url" "$state_cfg" "$state_ext"
    echo "worktree-deploy: $id torn down" >&2
    ;;

  *)
    echo "usage: worktree-deploy.sh {deploy [CMD] | prewarm | base-url [URL] | teardown | mode}" >&2
    exit 64
    ;;
esac
