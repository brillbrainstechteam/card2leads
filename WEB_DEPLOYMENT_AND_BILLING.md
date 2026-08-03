# EasySave Web Deployment and Billing Checklist

## Implemented in the application

- PostgreSQL-backed, organisation-scoped users, contacts, cards, exhibitions, voice notes and Google connections.
- Email/password login with strong password validation, email verification, forgot-password and expiring reset tokens.
- Google login and a separate Google Sheets connection flow.
- Signed `HttpOnly`, `SameSite=Lax` sessions with `Secure` cookies in production.
- CSRF validation for state-changing routes and exports.
- Rate limits for authentication, uploads, voice notes, reprocessing and exports.
- AES-256-GCM encryption for Google access and refresh tokens at rest.
- Google Sheets access limited to files EasySave creates or the user explicitly opens (`drive.file`).
- Account deletion and Google disconnect/token revocation.
- Raw voice transcript persistence and export to the Remarks column in Excel, CSV and Google Sheets.
- Card-image retention settings and spreadsheet-formula injection protection.

## Required before production launch

1. Use a private GitHub repository. Never commit `.env`, service-account JSON, uploads, voice recordings, logs or database data.
2. Add CI that runs `npm ci`, `npm run check` and `npm test` for every pull request.
3. Deploy behind Nginx or Caddy on a real domain with HTTPS. Set `NODE_ENV=production`, `APP_BASE_URL=https://your-domain`, and `COOKIE_SECURE=true`.
4. Run PostgreSQL privately with a unique password. Do not expose port 5432 publicly. Automate encrypted daily backups and test restoration.
5. Put `private_storage` on a persistent encrypted volume or move images/audio to private object storage with signed access URLs.
6. Configure Resend or SendGrid for real verification/reset email and verify the sender domain.
7. Publish the Google OAuth consent screen. Register the production login and Sheets callback URLs exactly and complete Google verification if requested.
8. Replace the starter privacy, terms and retention pages with lawyer-reviewed policies, including audio/card-image retention and account deletion.
9. Add production monitoring, structured error logs, uptime alerts and alerting for failed extraction, email and Google sync.
10. Move in-memory rate limits and long extraction work to Redis-backed limits and a job queue before running multiple app instances.
11. Run dependency and host vulnerability scans, an external security review, backup recovery test and a 100-200-card accuracy/load pilot.

## Production secrets

Store these only in the VPS secret environment, never in browser code or GitHub:

- `SESSION_SECRET`
- `DATABASE_URL`
- `GEMINI_API_KEY` and/or `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_AUTH_REDIRECT_URI`
- Google STT service-account credentials when Google STT is used
- `RESEND_API_KEY` or `SENDGRID_API_KEY`, plus `EMAIL_FROM`
- Razorpay key secret and webhook secret after billing is implemented

The Google client ID and Razorpay key ID are public identifiers. Their corresponding secrets are server-only.

## Razorpay subscription implementation

1. Enable Subscriptions in Razorpay and complete KYC/activation on the account.
2. Create monthly, quarterly and annual Plans in Razorpay Test Mode.
3. Add local `billing_customers`, `subscriptions`, `payments` and `webhook_events` tables with organisation ownership and plan entitlements.
4. Create subscriptions only from the EasySave server. Return only the Razorpay key ID and generated subscription ID to Checkout.
5. Verify the Checkout signature on the server before showing immediate success.
6. Add `/api/webhooks/razorpay` and verify its HMAC-SHA256 signature against the untouched raw request body.
7. Deduplicate webhook deliveries with `x-razorpay-event-id` and handle out-of-order events.
8. Grant or remove scan allowance from verified subscription state, not from a browser callback.
9. Handle `authenticated`, `activated`, `charged`, `pending`, `halted`, `cancelled` and `completed` subscription states.
10. Test payment, renewal, failure, retry, cancellation and refund/support flows before replacing Test keys with Live keys.

## Recommended release order

1. GitHub repository and CI.
2. Staging VPS, domain, HTTPS, PostgreSQL, persistent storage and real email.
3. Google OAuth production configuration and end-to-end Sheets testing.
4. Razorpay Test Mode integration and entitlement tests.
5. Security/load/backup pilot.
6. Production VPS and Razorpay Live Mode.
