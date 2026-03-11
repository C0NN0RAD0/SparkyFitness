#!/usr/bin/env bash
set -e

echo "███████████████████████████████████████████████████████████"
echo "🎯 SparkyFitness v2.0 - STANDALONE Proxmox Installation"
echo "✨ Custom installation script - NO community-scripts framework"
echo "✨ Updated: 2026-03-11 - Direct control over build process"
echo "███████████████████████████████████████████████████████████"

# Configuration
# Use next available VM ID (find highest existing and add 1)
CONTAINER_ID=$(pvesh get /cluster/resources | grep -oP '"vmid":\K[0-9]+' | sort -n | tail -1)
CONTAINER_ID=$((CONTAINER_ID + 1))
echo "Using Container ID: $CONTAINER_ID"

CONTAINER_NAME="SparkyFitness"
CONTAINER_HOSTNAME="sparkyfitness"
CONTAINER_CORES=${CONTAINER_CORES:-2}
CONTAINER_RAM=${CONTAINER_RAM:-2048}
CONTAINER_DISK=${CONTAINER_DISK:-4}
APP_PATH="/opt/sparkyfitness"
DATASTORE=${DATASTORE:-local-lvm}

echo ""
echo "📋 Installation Configuration:"
echo "  Cores: $CONTAINER_CORES"
echo "  RAM: ${CONTAINER_RAM}MB"
echo "  Disk: ${CONTAINER_DISK}GB"
echo "  Storage: $DATASTORE"
echo ""

# Step 1: Create LXC container
echo "🔧 Step 1: Creating LXC Container..."
# Find a suitable Debian template
TEMPLATE=$(pveam list local | grep -i "debian-13" | head -1 | awk '{print $1}')

if [ -z "$TEMPLATE" ]; then
  echo "❌ No Debian 13 template found. Available templates:"
  pveam list local
  exit 1
fi

echo "   Using template: $TEMPLATE"
pct create $CONTAINER_ID local:vztmpl/$TEMPLATE \
  -cores $CONTAINER_CORES \
  -memory $CONTAINER_RAM \
  -swap 512 \
  -hostname $CONTAINER_HOSTNAME \
  -net0 name=eth0,bridge=vmbr0,gw=192.168.1.1,ip=dhcp \
  -rootfs $DATASTORE:$CONTAINER_DISK \
  -unprivileged 1

echo "✅ Container created (ID: $CONTAINER_ID)"

# Step 2: Start container
echo ""
echo "🚀 Step 2: Starting Container..."
pct start $CONTAINER_ID
sleep 5
echo "✅ Container started"

# Step 3: Get container IP
echo ""
echo "📡 Step 3: Waiting for network..."
CONTAINER_IP=""
for i in {1..30}; do
  sleep 2
  CONTAINER_IP=$(pct exec $CONTAINER_ID ip addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+\.\d+\.\d+\.\d+' | head -1)
  if [ ! -z "$CONTAINER_IP" ]; then
    break
  fi
  echo "   Attempt $i/30 - waiting for IP..."
done

if [ -z "$CONTAINER_IP" ]; then
  echo "⚠️  Could not determine container IP automatically"
  CONTAINER_IP="<container-ip>"
else
  echo "✅ Container IP: $CONTAINER_IP"
fi

# Step 4: Update and install dependencies
echo ""
echo "📦 Step 4: Installing system dependencies..."
pct exec $CONTAINER_ID apt-get update
pct exec $CONTAINER_ID apt-get install -y curl wget git gnupg lsb-release ca-certificates

# Step 5: Install Node.js
echo ""
echo "🟢 Step 5: Installing Node.js..."
pct exec $CONTAINER_ID bash -c "curl -fsSL https://deb.nodesource.com/setup_25.x | bash -"
pct exec $CONTAINER_ID apt-get install -y nodejs

# Step 6: Install pnpm
echo ""
echo "⚡ Step 6: Installing pnpm..."
pct exec $CONTAINER_ID npm install -g pnpm@10.30.3

# Step 7: Install PostgreSQL
echo ""
echo "🐘 Step 7: Installing PostgreSQL..."
pct exec $CONTAINER_ID apt-get install -y postgresql postgresql-contrib

# Step 8: Clone repository
echo ""
echo "📥 Step 8: Cloning SparkyFitness repository..."
for attempt in {1..3}; do
  if pct exec $CONTAINER_ID git clone https://github.com/C0NN0RAD0/SparkyFitness.git $APP_PATH 2>&1; then
    break
  else
    if [ $attempt -lt 3 ]; then
      echo "⚠️  Attempt $attempt failed, retrying..."
      sleep 10
    else
      echo "❌ Failed to clone repository after 3 attempts"
      exit 1
    fi
  fi
done

# Step 9: **CRITICAL** Install monorepo dependencies BEFORE anything else
echo ""
echo "📦 Step 9: Installing monorepo dependencies (CRITICAL)..."
if ! pct exec $CONTAINER_ID bash -c "cd $APP_PATH && pnpm install --frozen-lockfile"; then
  echo "❌ Failed to install monorepo dependencies"
  exit 1
fi
echo "✅ Monorepo dependencies installed - shared/ package ready"

# Step 10: Build backend
echo ""
echo "🏗️  Step 10: Building SparkyFitness Backend..."
if ! pct exec $CONTAINER_ID bash -c "cd $APP_PATH/SparkyFitnessServer && pnpm run build"; then
  echo "❌ Failed to build backend"
  exit 1
fi
echo "✅ Backend built successfully"

# Step 11: Build frontend
echo ""
echo "🎨 Step 11: Building SparkyFitness Frontend..."
if ! pct exec $CONTAINER_ID bash -c "cd $APP_PATH/SparkyFitnessFrontend && pnpm run build"; then
  echo "❌ Failed to build frontend"
  exit 1
fi
echo "✅ Frontend built successfully"

# Step 12: Setup systemd service
echo ""
echo "⚙️  Step 12: Installing systemd service..."
pct exec $CONTAINER_ID bash -c "cat > /etc/systemd/system/sparkyfitness-server.service << 'EOF'
[Unit]
Description=SparkyFitness Backend Server
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sparkyfitness/SparkyFitnessServer
ExecStart=/usr/bin/node SparkyFitnessServer.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF"

pct exec $CONTAINER_ID systemctl daemon-reload
pct exec $CONTAINER_ID systemctl enable sparkyfitness-server

# Step 13: Setup nginx
echo ""
echo "🌐 Step 13: Installing nginx..."
pct exec $CONTAINER_ID apt-get install -y nginx
pct exec $CONTAINER_ID bash -c "cat > /etc/nginx/sites-available/sparkyfitness << 'EOF'
server {
    listen 80;
    server_name _;
    root /var/www/sparkyfitness;
    index index.html;

    # Rate limiting for auth
    limit_req_zone \$binary_remote_addr zone=auth_limit:10m rate=5r/s;

    location / {
        try_files \$uri /index.html;
    }

    location /api {
        limit_req zone=auth_limit burst=10 nodelay;
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF"

pct exec $CONTAINER_ID ln -sf /etc/nginx/sites-available/sparkyfitness /etc/nginx/sites-enabled/
pct exec $CONTAINER_ID rm -f /etc/nginx/sites-enabled/default
pct exec $CONTAINER_ID nginx -t
pct exec $CONTAINER_ID systemctl enable nginx

# Step 14: Deploy frontend
echo ""
echo "🚀 Step 14: Deploying frontend..."
pct exec $CONTAINER_ID mkdir -p /var/www/sparkyfitness
pct exec $CONTAINER_ID bash -c "cp -a $APP_PATH/SparkyFitnessFrontend/dist/* /var/www/sparkyfitness/"
pct exec $CONTAINER_ID chown -R www-data:www-data /var/www/sparkyfitness
echo "✅ Frontend deployed"

# Step 15: Start services
echo ""
echo "▶️  Step 15: Starting services..."
pct exec $CONTAINER_ID systemctl restart postgresql
pct exec $CONTAINER_ID systemctl restart nginx
pct exec $CONTAINER_ID systemctl restart sparkyfitness-server
sleep 3
echo "✅ All services started"

# Final message
echo ""
echo "███████████████████████████████████████████████████████████"
echo "✨ SparkyFitness v2.0 Installation Complete!"
echo "███████████████████████████████████████████████████████████"
echo ""
echo "📍 Access your application:"
echo "   🌐 Web: http://$CONTAINER_IP"
echo "   🖤 Container ID: $CONTAINER_ID"
echo ""
echo "Next steps:"
echo "  1. Configure .env variables in /opt/sparkyfitness"
echo "  2. Setup PostgreSQL database and users"
echo "  3. Configure AI service settings"
echo ""
echo "View logs:"
echo "  pct exec $CONTAINER_ID journalctl -u sparkyfitness-server -f"
echo ""
