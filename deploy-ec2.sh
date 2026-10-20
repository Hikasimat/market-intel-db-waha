#!/bin/bash
set -e

# ==============================================================================
# WAHA-NoWeb-Light EC2 Automated Deployment Script
# Supports: Ubuntu 22.04 / 24.04 LTS & Debian 12
# ==============================================================================

echo "=========================================================="
echo "🚀 Starting WAHA-NoWeb-Light Production Deployment on EC2"
echo "=========================================================="

# 1. Update system packages
echo "📦 Updating system packages..."
sudo apt-get update -y
sudo apt-get install -y curl git ufw jq ca-certificates gnupg

# 2. Install Docker if not already installed
if ! command -v docker &> /dev/null; then
    echo "🐳 Installing Docker Engine and Docker Compose..."
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update -y
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    sudo usermod -aG docker $USER
    echo "✅ Docker installed successfully."
fi

# 3. Ensure production environment file exists
if [ ! -f .env.production ]; then
    echo "⚙️ Creating .env.production from template..."
    cp .env.production.example .env.production
    echo "⚠️ NOTE: Please edit .env.production with your domain and production secrets!"
fi

# 4. Configure Firewall (UFW)
echo "🛡️ Configuring firewall rules..."
sudo ufw allow 22/tcp || true
sudo ufw allow 80/tcp || true
sudo ufw allow 443/tcp || true
sudo ufw --force enable || true

# 5. Build and launch WAHA container
echo "🏗️ Building and starting WAHA-NoWeb-Light container..."
docker compose -f docker-compose.prod.yaml up -d --build

# 6. Verify container status
echo "🔍 Checking health status..."
sleep 5
docker ps --filter "name=waha-noweb-light"

echo "=========================================================="
echo "✅ WAHA-NoWeb-Light successfully deployed!"
echo "Local endpoint: http://127.0.0.1:3000"
echo "Check logs: docker logs -f waha-noweb-light"
echo "=========================================================="
