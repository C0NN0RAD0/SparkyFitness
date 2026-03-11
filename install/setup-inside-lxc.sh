#!/bin/bash
# SparkyFitness Setup for LXC Container - Updated 2026-03-11 18:53 UTC
# Run this script INSIDE a Debian 13 LXC container as root
set -e

echo "███████████████████████████████████████████████████████████"
echo "🎯 SparkyFitness Setup - Inside LXC Container"
echo "███████████████████████████████████████████████████████████"
echo ""

APP_PATH="/opt/sparkyfitness"

# Step 1: Update system
echo "📦 Step 1: Updating system packages..."
apt-get update
apt-get upgrade -y

# Step 2: Install core dependencies
echo "📦 Step 2: Installing dependencies..."
apt-get install -y curl wget git gnupg lsb-release ca-certificates postgresql postgresql-contrib nginx

# Step 3: Install Node.js
echo "🟢 Step 3: Installing Node.js v25..."
curl -fsSL https://deb.nodesource.com/setup_25.x | bash -
apt-get install -y nodejs

# Step 4: Install pnpm globally
echo "⚡ Step 4: Installing pnpm package manager..."
npm install -g pnpm@10.30.3

# Step 5: Clone SparkyFitness repository
echo "📥 Step 5: Cloning SparkyFitness repository..."
if [ -d "$APP_PATH" ]; then
  echo "   ℹ️  Already cloned, pulling latest..."
  cd $APP_PATH
  git pull origin main
else
  git clone https://github.com/C0NN0RAD0/SparkyFitness.git $APP_PATH
fi

# Step 6: Install ALL monorepo dependencies (CRITICAL)
echo "📦 Step 6: Installing monorepo dependencies (all 5 workspaces)..."
cd $APP_PATH
pnpm install --frozen-lockfile
echo "   ✅ Monorepo dependencies installed"

# Step 7: Build frontend only (backend uses tsx at runtime)
echo "🎨 Step 7: Building frontend application..."
cd $APP_PATH
pnpm --filter sparkyfitnessfrontend run build
echo "   ✅ Frontend built successfully"

# Step 8: Deploy frontend to web directory
echo "🚀 Step 8: Deploying frontend to nginx..."
mkdir -p /var/www/sparkyfitness
rm -rf /var/www/sparkyfitness/*
cp -a $APP_PATH/SparkyFitnessFrontend/dist/* /var/www/sparkyfitness/
echo "   ✅ Frontend deployed"

# Step 9: Configure nginx reverse proxy
echo "🌐 Step 9: Configuring nginx..."
cat > /etc/nginx/sites-available/sparkyfitness << 'EOF'
server {
    listen 80;
    server_name _;
    root /var/www/sparkyfitness;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /api {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

ln -sf /etc/nginx/sites-available/sparkyfitness /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
echo "   ✅ Nginx configured"

# Step 10: Create systemd service for backend
echo "⚙️  Step 10: Installing systemd service..."
cat > /etc/systemd/system/sparkyfitness-server.service << 'EOF'
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
EOF

systemctl daemon-reload
systemctl enable sparkyfitness-server
echo "   ✅ Service created"

# Step 11: Start all services
echo "▶️  Step 11: Starting services..."
systemctl restart postgresql
systemctl restart nginx
systemctl start sparkyfitness-server
sleep 3

echo ""
echo "███████████████████████████████████████████████████████████"
echo "✨ SparkyFitness Setup Complete!"
echo "███████████████████████████████████████████████████████████"
echo ""
echo "✅ Frontend: Built and deployed to /var/www/sparkyfitness"
echo "✅ Backend: Systemd service installed (sparkyfitness-server)"
echo "✅ Nginx: Reverse proxy configured on port 80"
echo ""
echo "🌐 Access your application:"
echo "   Web UI: http://<container-ip>"
echo ""
echo "📝 Next steps:"
echo "   1. Edit /opt/sparkyfitness/.env with configuration"
echo "   2. Setup PostgreSQL database and user"
echo "   3. Configure AI service settings in the web UI"
echo ""
echo "📊 View backend logs:"
echo "   journalctl -u sparkyfitness-server -f"
echo ""
echo "🔧 Backend status:"
systemctl status sparkyfitness-server --no-pager | head -5
echo ""
