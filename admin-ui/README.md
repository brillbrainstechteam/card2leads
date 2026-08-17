# Card2Leads Admin Panel

Internal operations & analytics console for Card2Leads. A **zero-build vanilla-JS SPA**
(`public/`) that talks to the shared backend at `/api/admin/*`. Same system-of-record
as the customer app — no separate database, no syncing.

- **Backend:** the admin APIs live inside the customer app's `server.js` (in `F:\EasySave`),
  behind separate admin authentication. Admin tables are created by `EasySave/db/schema.sql`.
- **Frontend:** this repo. Just static files.
- **Design spec / decisions:** [`docs/PHASE-0-TECHNICAL-AUDIT.md`](docs/PHASE-0-TECHNICAL-AUDIT.md).

## Status — Phase 1 (foundation) + start of Phase 3 (UI)

Working now:
- Admin authentication (login / logout / session) — separate cookie, backend-enforced.
- **Dashboard** — KPI cards, conversion funnel, Attention-Required queue.
- **Clients** — server-side search / filter / pagination.
- **Client Detail** drawer — account, usage & billing, journey timeline, payments, users,
  Google integration, internal notes.

Scaffolded, built later:
- Analytics, Payments, Activity/Audit, Settings screens (Phase 5).
- Operational actions — adjust credits, change plan, suspend, delete (Phase 4).
- Product-event instrumentation + usage ledger (Phase 2) — until then, journey/ledger/
  payment panels show "not yet recorded" empty states.

## Run locally

The backend (`F:\EasySave`) must be running with PostgreSQL. Then:

```bash
# 1. Create your admin login (one-time), from the EasySave folder:
node scripts/create-admin.js you@brillbrainsconsultants.com "a-strong-password" "Your Name"

# 2. Start this admin SPA (from F:\Card2leadsAdmin). It proxies /api to the backend:
API_TARGET=http://localhost:5173 PORT=4100 node dev-server.js
```

Open http://localhost:4100 and sign in. The dev server proxies `/api/*` to the backend so
the browser sees one origin and the session cookie is first-party (no CORS).

> Set `API_TARGET` to wherever the backend listens (check `PORT` in `EasySave/.env`).

## First admin (production)

Either run the CLI script above against the production DB, or set these env vars on the
backend and restart — it seeds the admin on boot if that email doesn't exist yet:

```
ADMIN_BOOTSTRAP_EMAIL=you@brillbrainsconsultants.com
ADMIN_BOOTSTRAP_PASSWORD=a-strong-password
ADMIN_BOOTSTRAP_NAME=Your Name
```

Remove the password env var after the first successful boot.

## Deploy (production)

Serve `public/` on `admin.card2leads.brillbrainsconsultants.com` and **proxy `/api/` on that
subdomain to the app backend**, so the browser sees a single origin (first-party cookies,
no CORS). Example nginx:

```nginx
server {
    server_name admin.card2leads.brillbrainsconsultants.com;
    root /var/www/card2leads-admin/public;

    location / {
        try_files $uri $uri/ /index.html;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:3000;   # the Card2Leads app backend
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Only `/api/admin/*` is used by this panel; the proxy simply forwards `/api/`.

## Security notes

- Admin auth is enforced on the backend for every `/api/admin/*` call — hiding routes in the
  frontend is **not** security.
- Admins never see OAuth tokens, passwords, or payment credentials.
- Every admin action (and client-detail view) is written to an immutable admin audit log.
