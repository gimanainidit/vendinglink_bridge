#!/bin/bash
set -e

# Target directory
APP_DIR="/opt/vendinglink_bridge"

echo "=== [1/4] Pulling latest code from Git ==="
cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main

echo "=== [2/4] Building Docker containers ==="
docker compose build bridge-api bridge-worker

echo "=== [3/4] Starting updated containers ==="
docker compose up -d --remove-orphans

echo "=== [4/4] Pruning dangling Docker images ==="
docker image prune -f

echo "=== ✅ VendingLink Bridge Deployment Completed Successfully! ==="
