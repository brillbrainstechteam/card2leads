# Card2Leads — Deployment Runbook (Hostinger VPS + Cloudflare)

Target: `https://card2leads.brillbrainsconsultants.com` on a Hostinger VPS (Ubuntu),
DNS in Cloudflare, Node app behind Caddy, PostgreSQL local, PM2 for process management.

> The app keeps state **in memory**, so run **one instance only** (no clustering) for now.

---

## 0. Prerequisites
- A Hostinger VPS (Ubuntu 22.04+), root/sudo SSH access, its public IP.
- Cloudflare managing DNS for `brillbrainsconsultants.com`.
- Your `.env` values ready (see `.env.production.example`).

## 1. DNS (Cloudflare)
1. DNS → add **A record**: `card2leads` → `<VPS_IP>`, **Proxied** (orange cloud).
2. SSL/TLS → Overview → set mode to **Full (strict)**.
3. SSL/TLS → Origin Server → **Create Certificate** → save the cert and key (you'll put them on the VPS in step 4).

## 2. Server base
```bash
sudo apt update && sudo apt -y upgrade
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs git
sudo npm i -g pm2
# Caddy (auto HTTPS reverse proxy)
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
```

## 3. PostgreSQL (local, private)
```bash
sudo apt -y install postgresql
sudo -u postgres psql <<'SQL'
CREATE USER card2leads WITH PASSWORD 'STRONG_PASSWORD_HERE';
CREATE DATABASE card2leads OWNER card2leads;
SQL
```
Keep Postgres bound to localhost (default). Do **not** open port 5432 to the internet.
The app creates its own tables on first boot from `db/schema.sql`.

## 4. Deploy the app
```bash
sudo mkdir -p /var/www/card2leads /var/log/card2leads
sudo chown -R $USER:$USER /var/www/card2leads
# copy the project up (from your machine):
#   rsync -av --exclude node_modules --exclude .env --exclude data ./ USER@VPS:/var/www/card2leads/
cd /var/www/card2leads
npm ci --omit=dev            # installs only dotenv + pg (no capacitor/mobile deps)
cp .env.production.example .env   # then edit .env with real secrets
nano .env
```
Put the Cloudflare Origin cert/key on the server:
```bash
sudo nano /etc/caddy/cf-origin.pem   # paste certificate
sudo nano /etc/caddy/cf-origin.key   # paste private key
sudo chmod 600 /etc/caddy/cf-origin.key
```

## 5. Reverse proxy (Caddy)
```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 6. Start the app (PM2)
```bash
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup            # run the command it prints, to start on boot
pm2 logs card2leads    # watch for "Card2Leads running..."
```
Verify: `curl -s https://card2leads.brillbrainsconsultants.com/api/health` → `{"status":"ok",...}`.

## 7. Google OAuth (production)
In Google Cloud Console → your project → **Clients** (OAuth client), add:
- Authorized redirect URIs:
  - `https://card2leads.brillbrainsconsultants.com/api/google/callback`
  - `https://card2leads.brillbrainsconsultants.com/api/auth/google/callback`
- Branding → Authorized domain: `brillbrainsconsultants.com` (already set), and fill Privacy/Terms URLs.
- Publish the app (Audience → In production) when ready; contacts scope may trigger verification.

## 8. Razorpay
1. Enable **Subscriptions** on the account; create **3 Plans** (Monthly ₹499, Quarterly ₹799, Annual ₹2,999) → copy Plan IDs.
2. Put Key ID/Secret + Plan IDs in `.env` (Test first). Restart: `pm2 restart card2leads`.
3. Add a **Webhook**: URL `https://card2leads.brillbrainsconsultants.com/api/webhooks/razorpay`,
   secret = your `RAZORPAY_WEBHOOK_SECRET`, events:
   `subscription.activated, subscription.charged, subscription.halted, subscription.cancelled, subscription.completed, order.paid, payment.captured`.
4. Test a full pay → verify scans update. Then switch Test keys to **Live** and re-add a Live webhook.

## 9. Email
Set `RESEND_API_KEY` (or SendGrid) + `EMAIL_FROM`; verify the sender domain with the provider.

## 10. Backups & updates
- Daily encrypted DB backup: `pg_dump card2leads | gzip > /backups/card2leads_$(date +%F).sql.gz` (cron), test a restore.
- Update flow: `git pull` (or rsync) → `npm ci --omit=dev` → `pm2 restart card2leads`.

---

## Go-live checklist
- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, strong `SESSION_SECRET` + `ENCRYPTION_KEY`
- [ ] HTTPS works (padlock), `/api/health` returns ok
- [ ] Google login + Sheets connect work on the live domain
- [ ] Razorpay test payment updates scans; webhook received
- [ ] Real verification/reset emails deliver
- [ ] DB backup runs and restores
- [ ] Privacy/Terms/Retention pages reviewed
