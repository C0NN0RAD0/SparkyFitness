#!/bin/bash
set -e

echo "███████████████████████████████████████████████████████████"
echo "🎯 SparkyFitness Setup - Inside LXC Container"
echo "███████████████████████████████████████████████████████████"
echo ""

APP_PATH="/opt/sparkyfitness"

# Step 1: Update system
echo "📦 Step 1: Updating system..."
apt-get update
apt-get upgrade -y

# Step 2: Install dependencies
echo "📦 Step 2: Installing dependencies..."
apt-get install -y curl wget git gnupg lsb-release ca-certificates postgresql postgresql-contrib nginx

# Step 3: Install Node.js
echo "🟢 Step 3: Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_25.x | bash -
apt-get install -y nodejs

# Step 4: Install pnpm
echo "⚡ Step 4: Installing pnpm..."
npm install -g pnpm@10.30.3

# Step 5: Clone repository
echo "📥 Step 5: Cloning SparkyFitness..."
if [ -d "$APP_PATH" ]; then
  echo "   Already cloned, skipping..."
else
  git clone https://github.com/C0NN0RAD0/SparkyFitness.git $APP_PATH
fi

# Step 6: CRITICAL - Install monorepo dependencies
echo "📦 Step 6: Installing monorepo dependencies..."
cd $APP_PATH
pnpm install --frozen-lockfile

# Step 7: Build backend
echo "🏗️  Step 7: Building backend..."
cd $APP_PATH/SparkyFitnessServer
pnpm run build

# Step 8: Build frontend
echo "🎨 Step 8: Building frontend..."
cd $APP_PATH/SparkyFitnessFrontend
pnpm run build

# Step 9: Deploy frontend
echo "🚀 Step 9: Deploying frontend..."
mkdir -p /var/www/sparkyfitness
cp -a $APP_PATH/SparkyFitnessFrontend/dist/* /var/www/sparkyfitness/

# Step 10: Setup nginx
echo "🌐 Step 10: Configuring nginx..."
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

# Step 11: Setup systemd service
echo "⚙️  Step 11: Installing systemd service..."
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

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sparkyfitness-server
systemctl restart sparkyfitness-server

# Step 12: Start services
echo "▶️  Step 12: Starting services..."
systemctl restart postgresql
systemctl restart nginx

sleep 3

echo ""
echo "███████████████████████████████████████████████████████████"
echo "✨ SparkyFitness Setup Complete!"
echo "███████████████████████████████████████████████████████████"
echo ""
echo "Access your application:"
echo "  🌐 Web: http://<container-ip>"
echo ""
echo "View backend logs:"
echo "  journalctl -u sparkyfitness-server -f"
echo ""
echo "Next steps:"
echo "  1. Edit /opt/sparkyfitness/.env with your configuration"
echo "  2. Setup PostgreSQL database and users"
echo "  3. Configure AI service settings in the web interface"
echo ""
