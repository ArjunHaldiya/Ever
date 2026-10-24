#!/bin/bash
# Startup script for the gateway EC2 instance (runs once, as root, at first boot).
# Template: render the @@PLACEHOLDERS@@ with sed first, see docs in the setup guide.
# Mirrors the user data in infra/lib/app-stack.ts. Non-secret values only; Photon
# credentials are read from Secrets Manager by the gateway at startup.
set -euxo pipefail

NODE_VERSION=22.11.0

dnf install -y tar xz
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node

id ever >/dev/null 2>&1 || useradd --system --home-dir /opt/ever ever
mkdir -p /opt/ever /etc/ever && chown ever:ever /opt/ever

cat > /etc/ever/gateway.env <<'ENVEOF'
AWS_REGION=@@REGION@@
QUEUE_URL=@@QUEUE_URL@@
OUTBOUND_QUEUE_URL=@@OUTBOUND_QUEUE_URL@@
TABLE_PREFIX=app-
PHOTON_SECRET=app/photon
PHONE_HASH_SALT_SECRET=app/phone-hash-salt
ENVEOF

cat > /etc/systemd/system/ever-gateway.service <<'UNITEOF'
[Unit]
Description=Gateway (message ingest and send)
After=network-online.target
Wants=network-online.target
ConditionPathExists=/opt/ever/gateway.mjs
[Service]
User=ever
EnvironmentFile=/etc/ever/gateway.env
ExecStart=/usr/local/bin/node /opt/ever/gateway.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNITEOF

# Run later (via SSM) after uploading gateway.mjs to the artifacts bucket.
cat > /usr/local/bin/ever-gateway-update <<'UPDEOF'
#!/bin/bash
set -euo pipefail
aws s3 cp s3://@@BUCKET@@/gateway.mjs /opt/ever/gateway.mjs.new
mv /opt/ever/gateway.mjs.new /opt/ever/gateway.mjs
systemctl daemon-reload
systemctl enable ever-gateway
systemctl restart ever-gateway
UPDEOF
chmod +x /usr/local/bin/ever-gateway-update
systemctl daemon-reload
