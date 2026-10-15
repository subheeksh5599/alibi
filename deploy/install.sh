#!/usr/bin/env bash
# Installs or updates the Alibi verifier on a Linux host (systemd, glibc >= 2.34).
#
# Usage, from an unpacked release directory containing `alibi`, `alibi.service`
# and optionally `alibi.db`:
#
#   sudo ./install.sh            # install or update, then start
#   PORT=8795 sudo ./install.sh  # pick a different local port
#
# Touches only /opt/alibi, /etc/alibi and alibi.service.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8790}"
BIND="${BIND:-127.0.0.1}"
NETWORKS="${NETWORKS:-main}"

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -x "$HERE/alibi" ] || { echo "missing $HERE/alibi" >&2; exit 1; }

if ss -tln | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
  if ! systemctl is-active --quiet alibi.service; then
    echo "port $PORT is taken by something else; rerun with PORT=<free port>" >&2
    exit 1
  fi
fi

mkdir -p /opt/alibi/data /etc/alibi
systemctl stop alibi.service 2>/dev/null || true
install -m 0755 "$HERE/alibi" /opt/alibi/alibi

# Seed the index only on first install; an existing index is kept and resumed.
if [ -f "$HERE/alibi.db" ] && [ ! -f /opt/alibi/data/alibi.db ]; then
  install -m 0644 "$HERE/alibi.db" /opt/alibi/data/alibi.db
fi

cat > /etc/alibi/alibi.env <<EOF
ALIBI_DB=/opt/alibi/data/alibi.db
ALIBI_BIND=$BIND:$PORT
ALIBI_NETWORKS=$NETWORKS
RUST_LOG=info
EOF
chmod 600 /etc/alibi/alibi.env

install -m 0644 "$HERE/alibi.service" /etc/systemd/system/alibi.service
systemctl daemon-reload
systemctl enable --now alibi.service

for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
    echo "alibi is up on $BIND:$PORT"
    curl -fsS "http://127.0.0.1:$PORT/v1/health"; echo
    exit 0
  fi
  sleep 1
done
echo "alibi did not answer on port $PORT; see: journalctl -u alibi -n 50" >&2
exit 1
