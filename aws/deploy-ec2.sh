#!/bin/bash
set -e
echo "=== Starting Autonomous WAHA EC2 Deployment ==="

# 1. Install Docker if not present
if ! command -v docker > /dev/null 2>&1; then
  echo "Docker not detected. Installing Docker engine..."
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  systemctl enable --now docker
  usermod -aG docker ubuntu || true
fi

# 2. Install Docker Compose plugin if missing
if ! docker compose version > /dev/null 2>&1; then
  echo "Installing Docker Compose plugin..."
  apt-get update -y && apt-get install -y docker-compose-plugin || true
fi

# 3. Create deployment workspace
mkdir -p /home/ubuntu/waha-noweb-light
cd /home/ubuntu/waha-noweb-light

# 4. Authenticate to Amazon ECR
echo "__ECR_PASSWORD__" | docker login --username AWS --password-stdin "__REGISTRY__"

# 5. Pull latest container image
echo "Pulling Docker image: __IMAGE_URI__"
docker pull "__IMAGE_URI__"

# 6. Generate production docker-compose.prod.yaml
cat << 'COMPOSE_EOF' > docker-compose.prod.yaml
services:
  waha-noweb-light:
    image: __IMAGE_URI__
    container_name: waha-noweb-light
    restart: always
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - WAHA_LOG_LEVEL=info
      - WAHA_PRINT_QR=true
      - WAHA_DASHBOARD_USERNAME=__DASHBOARD_USERNAME__
      - WAHA_DASHBOARD_PASSWORD=__DASHBOARD_PASSWORD__
      - WAHA_WEBHOOK_URL=http://localhost:8000/api/whatsapp/webhook/
      - WAHA_WEBHOOK_SECRET=waha_secure_webhook_secret_2026
    volumes:
      - waha_prod_sessions:/app/.sessions
      - waha_prod_media:/app/.media
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "5"

volumes:
  waha_prod_sessions:
    name: waha_prod_sessions
  waha_prod_media:
    name: waha_prod_media
COMPOSE_EOF

# 7. Start/recreate container
echo "Starting WAHA container with docker compose..."
docker compose -f docker-compose.prod.yaml up -d --force-recreate

# 8. Clean up unused images
docker image prune -f

echo "Deployment completed successfully!"
docker ps --filter "name=waha-noweb-light"
