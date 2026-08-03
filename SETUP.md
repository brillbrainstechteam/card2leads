# EasySave Setup

The production build prompt is in `PROMPT.md`.

## Local PostgreSQL

1. Start Docker Desktop.
2. From `F:\EasySave`, run:

   ```powershell
   npm.cmd run db:up
   ```

3. Copy `.env.example` to `.env` and keep this value:

   ```env
   DATABASE_URL=postgres://easysave:easysave_dev_password@localhost:55432/easysave
   DATABASE_SSL=false
   ```

4. Start the app:

   ```powershell
   npm.cmd run dev
   ```

When `DATABASE_URL` is present, the app stores data in relational PostgreSQL tables. If it is absent, it falls back to `data/db.json` for quick testing.

Useful database checks:

```powershell
docker exec easysave-postgres psql -U easysave -d easysave -c "\dt"
docker exec easysave-postgres psql -U easysave -d easysave -c "select count(*) from users;"
docker exec easysave-postgres psql -U easysave -d easysave -c "select count(*) from contacts;"
```

## Google OAuth Client ID and Secret

Use Google Cloud Console:

1. Open https://console.cloud.google.com/
2. Create or select a project, for example `EasySave`.
3. Go to **APIs & Services > Library**.
4. Enable **Google Sheets API** and **Google People API**.
5. Go to **APIs & Services > OAuth consent screen**.
6. Choose **External** for normal Gmail accounts or **Internal** for a Google Workspace-only app.
7. Fill app name, support email, developer contact email.
8. Add this scope when asked:

   ```text
   https://www.googleapis.com/auth/spreadsheets
   ```

9. While testing, add your Gmail address under **Test users**.
10. Go to **APIs & Services > Credentials**.
11. Click **Create Credentials > OAuth client ID**.
12. Application type: **Web application**.
13. Authorized JavaScript origins:

   ```text
   http://localhost:5173
   ```

14. Authorized redirect URIs:

   ```text
   http://localhost:5173/api/google/callback
   http://localhost:5173/api/auth/google/callback
   ```

15. Copy the generated client ID and client secret into `.env`:

   ```env
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:5173/api/google/callback
   GOOGLE_AUTH_REDIRECT_URI=http://localhost:5173/api/auth/google/callback
   ```

For production, add the production origin and production callback URL as additional authorized entries.
Publish the OAuth app or complete Google verification before selling publicly; otherwise Google may show a test-user access block.

Google Sheets and Google Contacts are connected separately in SmartScan so users
only grant the feature they choose. Add the `drive.file` scope for file-limited
Sheets access and the `contacts` scope for writing Google Contacts. The Contacts
scope may require Google verification before public production use.

## Login, Email, and Production Security

- Set `APP_BASE_URL` to the production HTTPS domain, for example `https://app.yourdomain.com`.
- Run behind HTTPS and set `NODE_ENV=production` or `COOKIE_SECURE=true` so session cookies use `HttpOnly`, `Secure`, and `SameSite=Lax`.
- Add `RESEND_API_KEY` or `SENDGRID_API_KEY` before public launch. The app already creates verification and reset tokens; local development prints links, but production must send them by email.
- Use `GEMINI_MODEL=gemini-3.5-flash-lite`. If Gemini rejects a retired or unavailable model, SmartScan temporarily skips it and falls back to OpenAI instead of repeating the failed request for every card.
- `EXTRACTION_CONCURRENCY=3` processes a small batch in parallel. Increase it only when the AI provider quota supports more simultaneous requests.
- Use a long random `SESSION_SECRET`; changing it signs everyone out and protects encrypted Google refresh tokens.
- Keep `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_CLIENT_SECRET`, and database credentials only in `.env` or server environment variables.
- For paid/high-accuracy extraction, set `EXTRACTION_VERIFICATION_MODE=paid` and keep `OPENAI_API_KEY` configured. This runs a second OpenAI verification pass and costs more per card.
- Starter pages exist at `/privacy.html`, `/terms.html`, and `/retention.html`; replace them with lawyer-reviewed documents before selling.

## Collection Workflow

- **Continue existing collection** keeps saving new reviewed contacts into the current collection.
- **Start a new collection** archives the previous current collection and makes the new one current.
- **Excel collection** stores contacts in PostgreSQL and downloads the complete selected collection as `.xlsx`.
- **Google Sheet collection** stores contacts in PostgreSQL first, then creates a separate Google Sheet for that collection after Google is connected.
- Excel, CSV, and Google Sheets share one minimal sales-ready format: Name, phone numbers, company, designation, office number, emails, website, address/location, exhibition details, remarks, tags, and created timestamp.
- The first row of every Google Sheet is written with these export headers. New contacts append below it, and edited contacts update their existing row when synced. Older EasySave sheets are migrated to the current format on the next sync.
- PostgreSQL remains the source of truth. Google Sheets is the export/sync destination, not the primary database.
