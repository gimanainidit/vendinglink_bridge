# 🚀 VendingLink Bridge

A robust bridge service connecting **VendingLink** with multiple digital voucher suppliers (e.g., Rezeki Shop / RZK) featuring an admin **Telegram Bot**, asynchronous **BullMQ** job queuing, automated reconciliation, and webhook dispatching.

---

## ⚡ Quick Start: Local Development

Follow these steps to run the complete environment locally (Windows, Linux, or macOS).

### 1. Prerequisites
- **Node.js**: v18+ (v20+ recommended)
- **Docker**: For running a local Redis container
- **ngrok** or Cloudflare Tunnel (to receive Telegram webhooks)

### 2. Clone & Install Dependencies
```bash
git clone https://github.com/gimanainidit/vendinglink_bridge.git
cd vendinglink_bridge
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Fill in the essential variables:
```env
NODE_ENV=development
PORT=3000
PUBLIC_BASE_URL=https://your-tunnel-subdomain.ngrok-free.dev

# Telegram
BOT_TOKEN=1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ
TELEGRAM_WEBHOOK_SECRET=your_secure_secret_token_here
ADMIN_TELEGRAM_ID=your_telegram_numeric_user_id

# Database (Local SQLite)
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:./dev.db

# Redis
REDIS_URL=redis://localhost:6379

# VendingLink
VENDINGLINK_URL=https://your-vendinglink-domain.com
BRIDGE_SECRET_KEY=shared_secret_with_vendinglink

# Encryption (32-byte Base64 for credential security)
# Generate: node -e "console.log(crypto.randomBytes(32).toString('base64'))"
KEYS_ENCRYPTION_KEY=v9T2H8zK4mQxR5pL1jC7nB3yN6vF0sD9gV4hW8qA2cE=

# Supplier (Rezeki Shop)
SUPPLIER_RZK_BASE_URL=https://api.prastyaaneki.biz.id
SUPPLIER_RZK_API_KEY=sk_live_your_actual_key_here
```

### 4. Start Local Redis
Start the dev Redis service using docker compose:
```bash
docker compose -f docker-compose.dev.yml up -d
```

### 5. Setup Local Database
Generate the SQLite Prisma schema and push it to `dev.db`:
```bash
npm run db:gen
npm run db:push
```

### 6. Start ngrok & Register Telegram Webhook
1. Start your tunnel:
   ```bash
   ngrok http 3000
   ```
2. Copy the HTTPS URL from ngrok (e.g., `https://your-tunnel.ngrok-free.dev`) into `PUBLIC_BASE_URL` in `.env`.
3. Register the webhook to Telegram:
   - **Linux / macOS**:
     ```bash
     curl -F "url=https://your-tunnel.ngrok-free.dev/webhook/telegram" \
          -F "secret_token=your_secure_secret_token_here" \
          https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook
     ```
   - **Windows PowerShell**:
     ```powershell
     curl.exe -F "url=https://your-tunnel.ngrok-free.dev/webhook/telegram" -F "secret_token=your_secure_secret_token_here" https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook
     ```

### 7. Run the Services
Open **two terminal windows**:

- **Terminal 1 (Express API Server):**
  ```bash
  npm run dev
  ```
- **Terminal 2 (BullMQ Background Worker):**
  ```bash
  npm run dev:worker
  ```

Visit `http://localhost:3000/health` (should return `{"status":"ok"}`).

---

## 🌐 Quick Start: Production VPS Deployment (Docker Compose)

The repository includes a ready-to-run production `docker-compose.yml` with:
- **`bridge-api`**: Main Express app (port 3000, bound to `127.0.0.1`)
- **`bridge-worker`**: Queue processor
- **`postgres`**: PostgreSQL 16 database with persistent storage
- **`redis`**: Redis 7 with append-only persistence
- **`db-backup`**: Automated daily database backups (`./backups`)

### 1. Setup on VPS
```bash
# Clone
git clone https://github.com/gimanainidit/vendinglink_bridge.git /opt/vendinglink_bridge
cd /opt/vendinglink_bridge

# Create environment configuration
cp .env.example .env
nano .env
```

Ensure production values in `.env`:
```env
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://bridge.yourdomain.com
DATABASE_PROVIDER=postgres
DATABASE_URL=postgresql://bridge_user:bridge_pass@postgres:5432/bridge?schema=public
REDIS_URL=redis://redis:6379
...
```

### 2. Setup Reverse Proxy with SSL

#### Option A: Caddy (Recommended - Instant Auto-SSL)
In `/etc/caddy/Caddyfile`:
```caddy
bridge.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```
Reload Caddy: `sudo systemctl reload caddy`

#### Option B: Nginx + Certbot
```nginx
server {
    server_name bridge.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
Run `certbot --nginx -d bridge.yourdomain.com`.

### 3. Launch Containers
```bash
docker compose up -d --build
```
*Note: Prisma migrations run automatically on startup.*

### 4. Register Webhook with Telegram
```bash
curl -F "url=https://bridge.yourdomain.com/webhook/telegram" \
     -F "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
```

---

## 🤖 Telegram Bot Commands

Only Telegram User IDs specified in `ADMIN_TELEGRAM_ID` can interact with the bot.

| Command | Description | Example |
| :--- | :--- | :--- |
| `/start` or `/help` | Display list of available commands and format | `/help` |
| `/balance <SUPPLIER>` | Check real-time wallet balance at supplier | `/balance RZK` |
| `/list <SUPPLIER> [search]` | List available products (or search keyword) | `/list RZK canva` |
| `/buy <SUPPLIER> <ID> <QTY> [email]` | Initiate product purchase with pre-check | `/buy RZK loc_test1 1` |
| `/status <TX_ID>` | Check execution status of a transaction | `/status tx_12345` |
| `/pending` | List the last 10 pending/in-progress transactions | `/pending` |
| `/retry <TX_ID>` | Force manual delivery retry to VendingLink | `/retry tx_12345` |
| `/cancel` | Cancel current interactive purchase flow | `/cancel` |

---

## 🛠️ Helpful Commands

```bash
# Run tests
npm run test

# Push database schema changes
npm run db:gen
npm run db:push

# View Docker logs
docker compose logs -f bridge-api
docker compose logs -f bridge-worker

# Stop all containers
docker compose down
```

## 📄 License
ISC
