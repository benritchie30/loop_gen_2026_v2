#!/usr/bin/env bash
# First-time setup of the public site on a fresh Ubuntu 24.04 server (see DEPLOY.md).
# Run as root from the cloned repository:
#
#   git clone https://github.com/YOU/REPO.git /opt/loop-finder
#   bash /opt/loop-finder/deploy/setup.sh loops.example.com you@example.com
#
# Safe to run again (after a change to the deploy files, or to fix a failed step):
# each step skips what is already done. Settings already in /etc/loop-finder.env
# are kept. Stops at the first error, saying which step failed.
set -euo pipefail

DOMAIN="${1:-}"
CONTACT="${2:-}"
# Where things go. The LOOP_SETUP_* overrides exist only for testing this script
# (deploy/test_setup.sh); on the server keep the defaults, which the service file
# and the Caddyfile use.
APP="${LOOP_SETUP_APP:-/opt/loop-finder}"
DATA="${LOOP_SETUP_DATA:-/var/lib/loop-finder}"
ENV_FILE="${LOOP_SETUP_ENV_FILE:-/etc/loop-finder.env}"
SYSTEMD_DIR="${LOOP_SETUP_SYSTEMD_DIR:-/etc/systemd/system}"
CADDY_DIR="${LOOP_SETUP_CADDY_DIR:-/etc/caddy}"
USER_NAME=loop-finder
SWAP_SIZE=2G

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
trap 'fail "setup stopped at line $LINENO (the step above). Fix it and run setup.sh again."' ERR

[ "$(id -u)" -eq 0 ] || fail "run as root (or with sudo)"
[ -n "$DOMAIN" ] || fail "usage: setup.sh DOMAIN CONTACT   e.g. setup.sh loops.example.com you@example.com"
[ -n "$CONTACT" ] || fail "usage: setup.sh DOMAIN CONTACT   (CONTACT: an email or project URL for the map data servers)"
git -C "$APP" rev-parse --git-dir >/dev/null 2>&1 || fail "clone the repository to $APP first (see DEPLOY.md)"
[ -f "$APP/backend/server.py" ] && [ -d "$APP/route-loop-finder" ] \
    || fail "$APP must be the project folder (backend/ and route-loop-finder/ at its top)"

step "System packages (Python, Node.js, git, firewall)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q python3 python3-venv python3-pip nodejs npm git ufw curl \
    debian-keyring debian-archive-keyring apt-transport-https gnupg

step "Caddy (web server, HTTPS) from its official package repository"
if ! command -v caddy >/dev/null; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -y -q caddy
fi
caddy version

step "Swap file ($SWAP_SIZE): room for a large map build instead of running out of memory"
if [ -z "$(swapon --show --noheadings)" ]; then
    if [ ! -f /swapfile ]; then
        fallocate -l "$SWAP_SIZE" /swapfile
        chmod 600 /swapfile
        mkswap /swapfile
    fi
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon --show

step "Firewall: only SSH, HTTP and HTTPS from outside"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
ufw status

step "Service user '$USER_NAME' and data folder $DATA"
id "$USER_NAME" >/dev/null 2>&1 \
    || useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$DATA/map_data"
chown -R "$USER_NAME:$USER_NAME" "$DATA"

step "Python environment and packages"
[ -x "$APP/venv/bin/python" ] || python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q --upgrade pip
"$APP/venv/bin/pip" install -q -r "$APP/backend/requirements.txt"
"$APP/venv/bin/python" -c 'import websockets, networkx, shapely, pyproj, srtm; print("websockets", websockets.__version__)'

step "Build the UI (npm ci, npm run build)"
cd "$APP/route-loop-finder"
npm ci --no-audit --no-fund
npm run build
[ -f dist/index.html ] || fail "the UI build made no dist/index.html"
chmod -R a+rX "$APP"   # Caddy (its own user) reads dist/

step "Settings file $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
    sed -e "s#https://loops.example.com#https://$DOMAIN#" \
        -e "s#^LOOP_CONTACT=.*#LOOP_CONTACT=$CONTACT#" \
        "$APP/deploy/loop-finder.env.example" > "$ENV_FILE"
    chmod 644 "$ENV_FILE"
    echo "written; edit it to change limits"
else
    echo "kept as it is (delete it and run setup.sh again to start over)"
fi
grep -E '^LOOP_(ALLOWED_ORIGINS|CONTACT)=' "$ENV_FILE"

step "Backend service (systemd)"
install -m 644 "$APP/deploy/loop-finder.service" "$SYSTEMD_DIR/loop-finder.service"
systemctl daemon-reload
systemctl enable loop-finder
systemctl restart loop-finder

step "Caddy site for $DOMAIN"
sed "s#loops.example.com#$DOMAIN#" "$APP/deploy/Caddyfile" > "$CADDY_DIR/Caddyfile"
caddy validate --config "$CADDY_DIR/Caddyfile" --adapter caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

step "Checks"
ok=""
for _ in $(seq 1 30); do
    if curl -fsS http://localhost:8765/healthz >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
done
[ -n "$ok" ] || fail "the backend does not answer on localhost:8765 (see: journalctl -u loop-finder -n 50)"
echo "backend: ok"
journalctl -u loop-finder -n 20 --no-pager | grep -E 'Limits|WARNING|Ready' || true

cat <<EOF

Done. Next:
  - open https://$DOMAIN (the first visit may take a minute while Caddy gets the certificate;
    the domain's DNS must already point at this server)
  - health check from anywhere: curl https://$DOMAIN/healthz
  - backend output: journalctl -u loop-finder -f
  - update later: bash $APP/deploy/update.sh
EOF
