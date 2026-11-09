#!/usr/bin/env bash
# Tests setup.sh and update.sh without a server: everything goes under a temporary
# folder, and the system commands (apt-get, ufw, useradd, systemctl, ...) are
# stand-ins that only log, except `systemctl restart loop-finder`, which starts the
# real backend from the installed copy with the written settings file. The Python
# packages, the UI build, the settings file and the Caddy config are real.
#
#   bash deploy/test_setup.sh        (Linux; needs python3, node/npm, git, internet
#                                     for pip/npm, and `caddy` on PATH for the
#                                     config check, else that step is skipped)
#
# The project is copied into a git repository (a stand-in for GitHub) in a
# subfolder, the harder layout: /opt/loop-finder is then a link to that subfolder.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(dirname "$HERE")"
T="$(mktemp -d /tmp/loop-setup-test.XXXX)"
PORT=8765
PASS=0
FAILED=0
check() {  # check NAME COMMAND...
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then echo "  [PASS] $name"; PASS=$((PASS + 1))
    else echo "  [FAIL] $name"; FAILED=$((FAILED + 1)); fi
}
cleanup() {
    [ -f "$T/server.pid" ] && kill "$(cat "$T/server.pid")" 2>/dev/null || true
}
trap cleanup EXIT

if curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    echo "Something already answers on port $PORT; stop it first." >&2
    exit 1
fi

echo "Test folder: $T"

# --- "GitHub": a bare repository with the project in a subfolder
mkdir -p "$T/work/site"
tar -C "$PROJECT" --exclude=node_modules --exclude=venv --exclude=dist --exclude=map_data \
    --exclude=check_frontend_out --exclude=__pycache__ -cf - . \
    | tar -C "$T/work/site" -xf -
git -C "$T/work" init -q -b main
git -C "$T/work" -c user.email=t@t -c user.name=test add -A
git -C "$T/work" -c user.email=t@t -c user.name=test commit -qm "first version"
git clone -q --bare "$T/work" "$T/github.git"

# --- The "server": clone, and /opt/loop-finder -> the project subfolder
git clone -q "$T/github.git" "$T/opt/repo"
ln -s "$T/opt/repo/site" "$T/opt/loop-finder"
mkdir -p "$T/etc/systemd" "$T/etc/caddy" "$T/data/map_data" "$T/home"
cp -r "$PROJECT/backend/map_data/tiles-v1" "$T/data/map_data/" 2>/dev/null || true

# --- Stand-ins for the system commands
mkdir -p "$T/bin"
for cmd in apt-get ufw useradd chown gpg fallocate mkswap; do
    printf '#!/bin/sh\necho "[stand-in] %s $*" >> "%s/system.log"\n' "$cmd" "$T" > "$T/bin/$cmd"
done
cat > "$T/bin/id" <<EOF
#!/bin/sh
[ "\$1" = "-u" ] && { echo "\${FAKE_UID:-0}"; exit 0; }
exit 0
EOF
cat > "$T/bin/swapon" <<EOF
#!/bin/sh
echo "/swapfile file 2G 0B -2"
EOF
cat > "$T/bin/journalctl" <<EOF
#!/bin/sh
cat "$T/server.log" 2>/dev/null
EOF
cat > "$T/bin/systemctl" <<EOF
#!/bin/bash
echo "[stand-in] systemctl \$*" >> "$T/system.log"
if [ "\$1" = restart ] && [ "\$2" = loop-finder ]; then
    [ -f "$T/server.pid" ] && kill "\$(cat "$T/server.pid")" 2>/dev/null && sleep 1
    set -a; . "$T/etc/loop-finder.env"; set +a
    # As the service would, from the installed copy; map tiles in the test folder.
    export LOOP_MAP_DIR="$T/data/map_data" HOME="$T/home" PYTHONUNBUFFERED=1
    cd "$T/opt/loop-finder/backend" || exit 1
    nohup "$T/opt/loop-finder/venv/bin/python" server.py > "$T/server.log" 2>&1 &
    echo \$! > "$T/server.pid"
fi
exit 0
EOF
if ! command -v caddy >/dev/null; then
    printf '#!/bin/sh\necho "[stand-in] caddy $*"\n' > "$T/bin/caddy"
    echo "(caddy not found: its config check is skipped)"
fi
chmod +x "$T/bin"/*
export PATH="$T/bin:$PATH"
export LOOP_SETUP_APP="$T/opt/loop-finder" LOOP_SETUP_DATA="$T/data" LOOP_SETUP_ENV_FILE="$T/etc/loop-finder.env"
export LOOP_SETUP_SYSTEMD_DIR="$T/etc/systemd" LOOP_SETUP_CADDY_DIR="$T/etc/caddy"
SETUP="$T/opt/loop-finder/deploy/setup.sh"
UPDATE="$T/opt/loop-finder/deploy/update.sh"

echo
echo "== Wrong use"
check "no arguments: refused with the usage" bash -c "bash '$SETUP' 2>&1 | grep -q usage"
check "...and a non-zero exit" bash -c "! bash '$SETUP'"
check "not root: refused" bash -c "FAKE_UID=1000 bash '$SETUP' a.example b@c 2>&1 | grep -q 'run as root'"

echo
echo "== First run (pip and npm really install; a few minutes)"
if bash "$SETUP" test.example.org me@test.example.org > "$T/setup1.log" 2>&1; then
    echo "  setup.sh finished"
else
    echo "  setup.sh FAILED; last lines:"; tail -20 "$T/setup1.log"
fi
check "setup.sh succeeded" grep -q "^Done. Next:" "$T/setup1.log"
check "settings: the site's address" grep -qx "LOOP_ALLOWED_ORIGINS=https://test.example.org" "$T/etc/loop-finder.env"
check "settings: the contact" grep -qx "LOOP_CONTACT=me@test.example.org" "$T/etc/loop-finder.env"
check "service file installed" test -f "$T/etc/systemd/loop-finder.service"
check "Caddyfile for the domain" grep -q "^test.example.org {" "$T/etc/caddy/Caddyfile"
check "...and no placeholder left in it" bash -c "! grep -q loops.example.com '$T/etc/caddy/Caddyfile'"
check "UI built" test -f "$T/opt/loop-finder/route-loop-finder/dist/index.html"
check "backend answers /healthz" curl -fsS "http://localhost:$PORT/healthz"
check "backend uses the written settings" grep -q "sites allowed: https://test.example.org; map data contact: me@test.example.org" "$T/server.log"
check "...without the placeholder warning" bash -c "! grep -q 'LOOP_CONTACT is still the placeholder' '$T/server.log'"

echo
echo "== Second run (nothing to redo; settings kept)"
echo "LOOP_MAX_AREAS=3" >> "$T/etc/loop-finder.env"
bash "$SETUP" test.example.org me@test.example.org > "$T/setup2.log" 2>&1 || true
check "setup.sh succeeded again" grep -q "^Done. Next:" "$T/setup2.log"
check "settings file kept (an edit survives)" grep -qx "LOOP_MAX_AREAS=3" "$T/etc/loop-finder.env"
check "...and used" grep -q "memory: 3 areas" "$T/server.log"

echo
echo "== Update from GitHub"
echo "test change" >> "$T/work/site/README-test.txt"
git -C "$T/work" -c user.email=t@t -c user.name=test add -A
git -C "$T/work" -c user.email=t@t -c user.name=test commit -qm "second version"
git -C "$T/work" push -q "$T/github.git" main
bash "$UPDATE" > "$T/update.log" 2>&1 || true
check "update.sh succeeded" grep -q "^Updated to .* second version" "$T/update.log"
check "the new file arrived" test -f "$T/opt/loop-finder/README-test.txt"
check "backend answers after the restart" curl -fsS "http://localhost:$PORT/healthz"

echo
echo "$PASS passed, $FAILED failed. Logs: $T/setup1.log, setup2.log, update.log, server.log, system.log"
[ "$FAILED" -eq 0 ]
