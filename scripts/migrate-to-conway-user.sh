#!/usr/bin/env bash
# ============================================================
# Migrate Conway from root to dedicated conway system user
# Run ONCE on the VPS as root: bash migrate-to-conway-user.sh
# ============================================================
set -euo pipefail

APP_DIR="/opt/conway-agent"
OLD_DIR="/root/conway-agent"

echo "============================================"
echo "  Migrating Conway to non-root user"
echo "============================================"
echo ""

# -----------------------------------------------------------
# 1. Stop services
# -----------------------------------------------------------
echo "==> [1/7] Stopping services..."
systemctl stop api-dashboard api-web-checker 2>/dev/null || true
echo "  Services stopped."

# -----------------------------------------------------------
# 2. Create conway system user
# -----------------------------------------------------------
echo ""
echo "==> [2/7] Creating conway system user..."
if id conway &>/dev/null; then
  echo "  User 'conway' already exists, skipping."
else
  useradd --system --create-home --home-dir /home/conway --shell /usr/sbin/nologin conway
  echo "  User 'conway' created."
fi

# -----------------------------------------------------------
# 3. Install Bun for conway user
# -----------------------------------------------------------
echo ""
echo "==> [3/7] Installing Bun for conway user..."
if [ -f /home/conway/.bun/bin/bun ]; then
  echo "  Bun already installed for conway."
else
  # Install bun as conway user
  su -s /bin/bash conway -c 'curl -fsSL https://bun.sh/install | bash' 2>&1 | tail -3
  echo "  Bun installed at /home/conway/.bun/bin/bun"
fi

# Verify
BUN_PATH="/home/conway/.bun/bin/bun"
if [ ! -f "$BUN_PATH" ]; then
  echo "  ERROR: Bun not found at $BUN_PATH"
  exit 1
fi
echo "  Bun version: $($BUN_PATH --version)"

# -----------------------------------------------------------
# 4. Create app directory and copy files
# -----------------------------------------------------------
echo ""
echo "==> [4/7] Moving application to ${APP_DIR}..."
mkdir -p "${APP_DIR}"

# Copy app files (not node_modules — we'll reinstall)
rsync -a --exclude node_modules --exclude data "${OLD_DIR}/" "${APP_DIR}/"

# Copy data directory separately to preserve db
if [ -d "${OLD_DIR}/data" ]; then
  rsync -a "${OLD_DIR}/data/" "${APP_DIR}/data/"
fi

echo "  Files copied."

# -----------------------------------------------------------
# 5. Set ownership and permissions
# -----------------------------------------------------------
echo ""
echo "==> [5/7] Setting ownership and permissions..."
chown -R conway:conway "${APP_DIR}"

# Restrict secrets
chmod 600 "${APP_DIR}/.env"
chmod 700 "${APP_DIR}/data"

# Restrict database files
if [ -f "${APP_DIR}/data/agent.db" ]; then
  chmod 600 "${APP_DIR}/data/agent.db"
  chmod 600 "${APP_DIR}/data/agent.db-wal" 2>/dev/null || true
  chmod 600 "${APP_DIR}/data/agent.db-shm" 2>/dev/null || true
fi

# Backup directory
mkdir -p "${APP_DIR}/data/backups"
chown conway:conway "${APP_DIR}/data/backups"

echo "  Ownership: conway:conway"
echo "  .env: 600, data/: 700"

# -----------------------------------------------------------
# 6. Install dependencies as conway user
# -----------------------------------------------------------
echo ""
echo "==> [6/7] Installing dependencies as conway..."
su -s /bin/bash conway -c "cd ${APP_DIR} && /home/conway/.bun/bin/bun install" 2>&1 | tail -3
echo "  Dependencies installed."

# -----------------------------------------------------------
# 7. Set up SSH key for deployment
# -----------------------------------------------------------
echo ""
echo "==> [7/7] Setting up SSH access for conway user..."
mkdir -p /home/conway/.ssh
chmod 700 /home/conway/.ssh

# Copy root's authorized_keys so the same SSH key works
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys /home/conway/.ssh/authorized_keys
  chown conway:conway /home/conway/.ssh/authorized_keys
  chmod 600 /home/conway/.ssh/authorized_keys
  echo "  SSH keys copied from root."
fi

# Give conway sudo access for systemctl only (needed for deploys)
cat > /etc/sudoers.d/conway << 'SUDOEOF'
conway ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload
conway ALL=(root) NOPASSWD: /usr/bin/systemctl restart api-dashboard
conway ALL=(root) NOPASSWD: /usr/bin/systemctl restart api-web-checker
conway ALL=(root) NOPASSWD: /usr/bin/systemctl restart caddy
conway ALL=(root) NOPASSWD: /usr/bin/systemctl enable api-dashboard
conway ALL=(root) NOPASSWD: /usr/bin/systemctl enable api-web-checker
conway ALL=(root) NOPASSWD: /usr/bin/systemctl enable api-dashboard api-web-checker
conway ALL=(root) NOPASSWD: /usr/bin/systemctl is-active *
conway ALL=(root) NOPASSWD: /usr/bin/systemctl status *
conway ALL=(root) NOPASSWD: /usr/bin/tee /etc/systemd/system/api-dashboard.service
conway ALL=(root) NOPASSWD: /usr/bin/tee /etc/systemd/system/api-web-checker.service
conway ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/Caddyfile
conway ALL=(root) NOPASSWD: /usr/bin/journalctl *
SUDOEOF
chmod 440 /etc/sudoers.d/conway
echo "  Sudo rules configured (systemctl + service file writes only)."

# -----------------------------------------------------------
# Update backup timer to use new path
# -----------------------------------------------------------
echo ""
echo "==> Updating backup timer for new path..."
cat > /etc/systemd/system/conway-db-backup.service << EOF
[Unit]
Description=Conway SQLite Backup

[Service]
Type=oneshot
User=conway
ExecStart=/bin/bash -c 'sqlite3 ${APP_DIR}/data/agent.db ".backup ${APP_DIR}/data/backups/agent-\$(date +%%Y%%m%%d).db"'
ExecStartPost=/bin/bash -c 'find ${APP_DIR}/data/backups -name "*.db" -mtime +30 -delete'
EOF
systemctl daemon-reload

echo ""
echo "============================================"
echo "  Migration complete!"
echo "============================================"
echo ""
echo "  App directory: ${APP_DIR}"
echo "  User: conway"
echo "  Bun: /home/conway/.bun/bin/bun"
echo ""
echo "  Old directory ${OLD_DIR} is still intact."
echo "  Delete it after verifying everything works:"
echo "    rm -rf ${OLD_DIR}"
echo ""
echo "  Next: update deploy.sh and systemd services,"
echo "  then redeploy to start services as conway user."
