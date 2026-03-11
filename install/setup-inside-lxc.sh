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

# Step 4b: Install tsx globally (needed for TypeScript execution)
echo "🔧 Step 4b: Installing tsx (TypeScript executor)..."
npm install -g tsx

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

# Step 8: Setup PostgreSQL database and users
echo "🗄️  Step 8: Setting up PostgreSQL database..."
systemctl start postgresql
sleep 2

# Generate secure passwords
DB_PASSWORD=$(openssl rand -base64 16)
APP_PASSWORD=$(openssl rand -base64 16)
ENCRYPTION_KEY=$(openssl rand -hex 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)

# Create SQL setup file
cat > /tmp/sparkyfitness-db-setup.sql << 'SQL_EOF'
CREATE DATABASE sparkyfitness_db;
CREATE USER sparky WITH ENCRYPTED PASSWORD '%DB_PASSWORD%';
CREATE USER sparky_app WITH ENCRYPTED PASSWORD '%APP_PASSWORD%';
ALTER DATABASE sparkyfitness_db OWNER TO sparky;
GRANT ALL PRIVILEGES ON DATABASE sparkyfitness_db TO sparky;
SQL_EOF

# Replace placeholders
sed -i "s|%DB_PASSWORD%|$DB_PASSWORD|g" /tmp/sparkyfitness-db-setup.sql
sed -i "s|%APP_PASSWORD%|$APP_PASSWORD|g" /tmp/sparkyfitness-db-setup.sql

# Execute as postgres user
su -l postgres -c "psql -f /tmp/sparkyfitness-db-setup.sql" 2>/dev/null

# Cleanup
rm -f /tmp/sparkyfitness-db-setup.sql

echo "   ✅ PostgreSQL configured"

# Step 9: Create .env file
echo "📝 Step 9: Creating .env configuration..."
cat > $APP_PATH/.env << EOF
# SparkyFitness Configuration - Auto-generated $(date +%Y-%m-%d)

# Database Configuration
SPARKY_FITNESS_DB_HOST=localhost
SPARKY_FITNESS_DB_PORT=5432
SPARKY_FITNESS_DB_NAME=sparkyfitness_db
SPARKY_FITNESS_DB_USER=sparky
SPARKY_FITNESS_DB_PASSWORD=$DB_PASSWORD
SPARKY_FITNESS_APP_DB_USER=sparky_app
SPARKY_FITNESS_APP_DB_PASSWORD=$APP_PASSWORD

# Server Configuration
SPARKY_FITNESS_SERVER_HOST=localhost
SPARKY_FITNESS_SERVER_PORT=3010
SPARKY_FITNESS_FRONTEND_URL=http://localhost

# Security Configuration
SPARKY_FITNESS_API_ENCRYPTION_KEY=$ENCRYPTION_KEY
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET

# Environment Settings
NODE_ENV=production
SPARKY_FITNESS_LOG_LEVEL=INFO
TZ=Etc/UTC

# Optional Settings
SPARKY_FITNESS_DISABLE_SIGNUP=false
SPARKY_FITNESS_FORCE_EMAIL_LOGIN=true
EOF

echo "   ✅ .env file created at $APP_PATH/.env"

# Step 10: Deploy frontend to web directory
echo "🚀 Step 10: Deploying frontend to nginx..."
mkdir -p /var/www/sparkyfitness
rm -rf /var/www/sparkyfitness/*
cp -a $APP_PATH/SparkyFitnessFrontend/dist/* /var/www/sparkyfitness/
echo "   ✅ Frontend deployed"

# Step 11: Configure nginx reverse proxy
echo "🌐 Step 11: Configuring nginx..."
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

# Step 12: Create systemd service for backend
echo "⚙️  Step 12: Installing systemd service..."
cat > /etc/systemd/system/sparkyfitness-server.service << 'EOF'
[Unit]
Description=SparkyFitness Backend Server
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sparkyfitness/SparkyFitnessServer
ExecStart=/usr/local/bin/tsx SparkyFitnessServer.js
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

# Step 13: Start all services
echo "▶️  Step 13: Starting services..."
systemctl restart postgresql
systemctl restart nginx
systemctl start sparkyfitness-server
sleep 3

echo ""
echo "███████████████████████████████████████████████████████████"
echo "✨ SparkyFitness Setup Complete!"
echo "███████████████████████████████████████████████████████████"
echo ""
echo "✅ PostgreSQL: Database and users created"
echo "✅ Configuration: .env file created at $APP_PATH/.env"
echo "✅ Frontend: Built and deployed to /var/www/sparkyfitness"
echo "✅ Backend: Systemd service installed (sparkyfitness-server)"
echo "✅ Nginx: Reverse proxy configured on port 80"
echo ""
echo "🌐 Access your application:"
echo "   Web UI: http://<container-ip>"
echo ""
echo "📋 Configuration Details:"
echo "   Database: sparkyfitness_db"
echo "   DB User (admin): sparky"
echo "   App User: sparky_app"
echo "   Config file: $APP_PATH/.env"
echo ""
echo "📝 The .env file has been auto-generated with:"
echo "   • Generated encryption keys (SPARKY_FITNESS_API_ENCRYPTION_KEY)"
echo "   • Generated auth secret (BETTER_AUTH_SECRET)"
echo "   • Database credentials (safe for production)"
echo ""
echo "   If you need to modify CORS or other settings, edit:"
echo "   nano $APP_PATH/.env"
echo ""
echo "📊 View backend logs:"
echo "   journalctl -u sparkyfitness-server -f"
echo ""
echo "🔧 Backend status:"
systemctl status sparkyfitness-server --no-pager | head -5
echo ""
