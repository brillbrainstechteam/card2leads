# Card2Leads Admin Panel — Phase 0: Technical Audit & Data-Model Decisions

**Status:** Draft for sign-off
**Author:** Engineering
**Date:** 13 Aug 2026
**Customer app audited:** `F:\EasySave` (production: https://card2leads.brillbrainsconsultants.com/)
**Admin app target:** `F:\Card2leadsAdmin` (currently empty)
**Spec:** *Card2Leads Admin Panel — Complete Product & System Requirement* (§ references below point to that document)

> This is the mandatory pre-build gate required by spec §93–§94. **No migrations or tables should be created until the "Decisions Needed" section is signed off**, because four of those decisions change the schema.

---

## 0. TL;DR

- The customer backend is a **single 5,469-line `server.js`** (raw Node `http` + `pg`), a vanilla-JS `public/` frontend, and a Postgres schema in `db/schema.sql`. There is no framework, no ORM, no separate API layer.
- The **tenant model already matches the spec**: `organisations` (client/tenant) → `users`. No restructuring needed.
- **Billing is real and non-trivial**: Razorpay subscriptions + one-time purchase + top-ups, webhook-driven, with trial/one-time/subscription modes. But **subscription & payment state live as loose fields on the organisation object** (persisted into the `data` jsonb column) — there are **no `payments` or `subscriptions` tables**.
- **Usage is a single counter** (`organisation.scansUsed`), incremented at `server.js:1149`. There is **no ledger**.
- **There is no product-event/analytics system at all.** The funnel, activation, and journey timeline the admin panel is built around have **zero backing data today** and must be (a) instrumented going forward and (b) backfilled for existing customers.
- **Recommended approach:** add admin APIs *into the existing `server.js`* behind a separate admin-auth guard (same system-of-record, no sync — spec §4, §93), build the admin UI as a separate app in `F:\Card2leadsAdmin`.

---

## 1. Decisions — LOCKED (signed off 13 Aug 2026)

| # | Decision | Final answer |
|---|---|---|
| **D1** | When is a scan consumed? | **Every successful scan counts.** PLUS a new **pre-scan image-quality gate** in the customer app: poor-clarity images are flagged/rejected *before* OCR is attempted, so bad images don't burn cost or credits. *(New customer-app work — see §5.1.)* |
| **D2** | Ledger vs counter | **Ledger is the source of truth.** Running balance is derived from it. Better for support/refunds. |
| **D3** | Account phone for search | **Yes — the main app will collect the client's phone number at signup.** Admin search uses it. |
| **D4** | Free trial | **Removed entirely.** The 20 free scans were demo-only. No trial plan, no `TRIAL_EXPIRED` lifecycle. New accounts must be on a paid plan to scan. *(See open question Q1.)* |
| **D5** | Historical backfill | **Not required — product is not launched yet, no existing customer data.** The entire backfill workstream is dropped. |
| **D6** | Analytics timezone | **Asia/Kolkata (IST).** |
| **D7** | "Engaged" definition | **Accepted:** ≥ 2 scan sessions, or ≥ 10 lifetime scans, or any export/Google sync. |
| **D8** | Admin bootstrap & sessions | **Accepted:** env-driven setup for the first admin; session TTL 8h, idle timeout 30m. |
| **D9** | Deletion SLA | **30 days** after `PENDING_DELETION`, then hard purge. |
| **D10** | Admins & PII logging | **Single admin (the owner) for V1.** Multi-admin management deprioritised. Admin *actions* are audited; per-view PII logging skipped for V1 (single trusted admin). |

### Impact of these answers on the plan
- **Backfill workstream removed** (D5) → Phase 1 shrinks.
- **Trial lifecycle removed** (D4) → simpler lifecycle: `REGISTERED → PAID → RENEWED/CHURNED` (+ `PAYMENT_FAILED`, `SUSPENDED`, `CANCELLED`, `PENDING_DELETION`). No `TRIAL` / `TRIAL_EXPIRED`.
- **`PLAN_LIMITS.trial` (20) must be removed/repurposed** in `server.js:50` and the new-account seed at `:2769`/`:2946` — see Q1.
- **Two new customer-app tasks** land on the backlog: the pre-scan quality gate (D1) and phone capture at signup (D3).
- **Admin-user management is minimal** for V1 (one owner admin).

### Open questions still needed before Phase 1 (see §16)
- **Q1:** With free scans gone, what does a brand-new signup get *before* paying — zero scans / locked until they subscribe?
- **Q2:** Is the pre-scan image-quality gate (D1) in scope for *this* project now, or tracked as a separate customer-app task?

---

## 2. Existing Architecture

### 2.1 Frontend
- `public/` — static, server-rendered-free vanilla JS. Single `app.js`, `index.html`, plus static legal pages (`privacy.html`, `terms.html`, `retention.html`), `service-worker.js`, PWA `manifest.webmanifest`.
- No build step, no framework. Served directly by `server.js` static handler (`server.js:5204`).

### 2.2 Backend
- **`server.js` — 5,469 lines, raw `node:http`.** One big `handleApi()` dispatcher (`if (method && pathname === …)` chain starting `server.js:2668`).
- Data access: an **in-memory `db` object** (`readDb()` `server.js:204`) that is **loaded from / persisted to Postgres** (`loadPostgresDb()` `:294`, `persistPostgresDb()` `:339`). Row↔object mappers at `:718–:951`.
- Extra/ad-hoc fields are stored in each table's `data jsonb` column via `mergeData()`/`jsonData()` (`:951`). *This is why billing state can live on the org without schema columns.*
- Async work (OCR extraction, sync) runs through a queue: `scheduleQueueProcessing()` `:1008`, `processQueueCycle()` `:1021`.
- Existing helpers we will reuse: `audit(db, user, action, entityType, entityId, metadata)` `:1364`, `id(prefix)` `:975`, `hash(value)` `:979`, session signing `:1384`.

### 2.3 Database
- Postgres, schema in `db/schema.sql`. Tables: `organisations`, `users`, `sessions`, `collections`, `upload_batches`, `card_files`, `contacts`, `voice_notes`, `contact_phones`, `contact_emails`, `google_connections`, `sheet_configurations`, `sync_records`, `export_jobs`, `audit_logs`.
- Every table carries `created_at`, `updated_at` (most) and a `data jsonb` catch-all.

### 2.4 Deployment
- VPS + pm2, Postgres via `docker-compose.yml`. Deploy notes in `DEPLOY.md`. (Per project memory: watch for hand-copied file drift blocking `git pull`.)

---

## 3. Current Customer / Tenant Model

- **`organisations`** = the client/tenant (spec §8). Columns: `id, name, plan, retention_policy, status, created_at, updated_at, data`.
- **`users`** = people under the org. Columns: `id, organisation_id, name, email, password_hash, email_verified, status, …, data`. **No phone column** (see D3).
- **`sessions`** = signed cookie sessions (`sessions` table + `signSession()` `:1384`).
- Multi-user orgs are supported (`teamMembers()` `:959`, `/api/team` `:3984`), though most accounts are effectively single-user.

**Verdict:** matches the spec's Client→Users requirement. The admin panel's `client_id` = `organisations.id`, `user_id` = `users.id`. No migration needed here.

---

## 4. Current Billing Model

Defined at `server.js:50–75`:

- **Plans & allowances** (`PLAN_LIMITS`): `trial: 20`, `monthly: 150`, `quarterly: 300`, `annual: 1500`, plus `addonCredits: 100` and legacy aliases `starter/event: 300`.
- **Prices (paise):** monthly ₹499, quarterly ₹799, annual ₹1499; top-up ₹499 (`TOPUP_AMOUNT_PAISE`).
- **Razorpay:** subscriptions (`RAZORPAY_PLAN_IDS`, cycle counts in `RAZORPAY_TOTAL_COUNTS`), one-time purchase, and top-ups.
- **Billing modes:** `subscription`, `one_time`, plus `trial`. State applied only from verified webhook/verify flows (`applyPlan…` `:1733–:1780`).

**Where state lives:** on the `organisation` object as `plan`, `billingMode`, `subscriptionPlan`, `subscriptionId`, `subscriptionStatus`, `scanLimit`, `scansUsed`, `topupScans`, `pendingSubscriptionId` — **persisted in `organisations.data` jsonb, not dedicated columns.**

**Endpoints:** `/api/billing/subscribe` `:3098`, `/api/billing/one-time` `:3122`, `/api/billing/one-time/verify` `:3168`, `/api/billing/topup` `:3186`, `/api/billing/topup/verify` `:3216`; webhook `/api/webhooks/razorpay` `:2687`.

**Gap for admin:** the admin Payments screen (§54–56) and Subscription view (§28, §58) need **records**, not derived org fields. We will introduce `payments` and `subscriptions` tables written from the same webhook/verify code paths (backend remains source of truth — no admin-only state, per §55).

---

## 5. Current Usage Model

- **Single counter.** `organisation.scansUsed` incremented by 1 at **`server.js:1149`**, inside `processQueueCycle()` — i.e. **when a card's OCR extraction completes**, whether it auto-saved or fell to *requires-review*.
- Limit/derivation logic: `:1604–1639` (`scanLimit`, top-up remaining), reset on new billing period at `:1749`, `:1779`.
- New orgs seed `scansUsed: 0, scanLimit: PLAN_LIMITS.trial, topupScans: 0` (`:2769`, `:2946`).

**Gap for admin:** spec §30–§31 mandates a **ledger** (`usage_ledger`) so credits are auditable and correctable. This is net-new (see D1/D2). No backfill needed (D5 — pre-launch).

### 5.1 New customer-app work implied by D1 (pre-scan image-quality gate)
Per D1, before OCR is attempted the customer app must **check image clarity and reject/flag poor images up front**, so a bad photo never reaches the paid OCR step and never consumes a credit. This is a **customer-app change** (frontend capture + a backend pre-flight check ahead of the queue at `server.js:1149`), tracked separately from the admin panel. Net effect on billing: only good-clarity, successfully-processed cards produce a `SCAN_CONSUMED` ledger entry. *(Scope confirmation pending — Q2.)*

---

## 6. Current Analytics / Event Tracking

- **None of the product-event kind.** No `product_events`, no funnel, no activation milestones, no first-login/first-scan/pricing-viewed tracking. Grep confirms zero occurrences of `product_event`, `activation`, `funnel`.
- The existing `audit_logs` table + `audit()` helper (`:1364`) records **user/product actions** (not admin actions, not funnel analytics). We will reuse the *pattern* but add a distinct **admin** audit trail.

**Consequence:** the entire ADM-02 Dashboard funnel, ADM-05 Analytics, and Client-Detail Journey timeline have **no data until we instrument** (Phase 2) and **backfill** (D5).

---

## 7. Integration Model (Google)

- **`google_connections`** (schema `:197`): `organisation_id, connected_by, google_email, encrypted_token, encrypted_refresh_token, token_expiry, scopes, status, data`. Tokens are encrypted at rest.
- Related: `sheet_configurations`, `sync_records`.
- Flows: connect `/api/google/connect` `:3239` + callback `:3272`; disconnect `/api/google/disconnect` `:4158`; sync `/api/google/sync` `:4263`, contacts sync `:4278`.

**Admin rule (§33, §79):** admin surfaces only `google_email`, `status`, connection/sync timestamps, last error. **Never** the encrypted tokens/scopes secrets. The read query must explicitly project safe columns.

---

## 8. Recommended Admin Folder Location & Backend Approach

- **Frontend:** new standalone app in **`F:\Card2leadsAdmin`** (separate deploy, e.g. `admin.card2leads.brillbrainsconsultants.com`), per spec §2–§3, §37. Stack recommendation: keep it lightweight (Vite + a component lib) — it's an operations console (tables/filters/drawers), not a marketing SaaS UI (§81).
- **Backend:** **extend the existing `server.js`** with an `/api/admin/*` route group dispatched *before* the customer chain and guarded by admin auth. Rationale: same Postgres, same system-of-record, zero sync (§4, §93), least disruption. A future extraction into a separate admin service stays possible because the routes are namespaced.
- **Admin auth:** separate `admin_users` table + separate signed admin session cookie; **backend-enforced on every `/api/admin/*` call** (not route-hiding — §12, §79).

---

## 9. Required Schema Changes (migrations)

New tables (net-new):

1. **`usage_ledger`** — `usage_transaction_id, client_id, user_id, transaction_type (PLAN_ALLOCATION|SCAN_CONSUMED|TOPUP_PURCHASE|ADMIN_CREDIT|ADMIN_DEBIT|REFUND_ADJUSTMENT|SYSTEM_CORRECTION), quantity, balance_effect, source, reference_id, created_at, metadata` (§31).
2. **`product_events`** — `event_id, event_name, client_id, user_id, session_id, timestamp, source, metadata jsonb` (§38), with a unique key for idempotent milestone events (§44).
3. **`payments`** — persisted from Razorpay webhook/verify: `payment_id, client_id, user_id, amount, currency, plan, status, provider, provider_reference, created_at, completed_at, subscription_ref, failure_reason` (§56).
4. **`subscriptions`** — `subscription_id, client_id, plan, status, billing_mode, start_date, current_period_end, provider, provider_reference` (§58).
5. **`admin_users`** — `id, name, email, password_hash, role, status, last_login_at` (§69).
6. **`admin_notes`** — `id, client_id, admin_id, note, created_at` (§35).
7. **`admin_audit_logs`** — `audit_id, admin_id, client_id, action, previous_value, new_value, reason, created_at` (immutable — §60–§61).

Column additions:
8. **`users.phone`** (nullable) — see D3.
9. Optional: promote hot billing fields (`plan`, `subscription_status`) from `organisations.data` to real columns for indexable filtering (§86) — *deferred unless filtering perf requires it.*

Indexes: `product_events(client_id, timestamp)`, `product_events(event_name, timestamp)`, `usage_ledger(client_id, created_at)`, `payments(client_id, created_at)`, `admin_audit_logs(client_id, created_at)`.

---

## 10. Required Backend Changes (APIs)

New `/api/admin/*` group (naming follows spec §77, adapt to existing conventions):

- `GET /api/admin/dashboard` — KPIs, funnel, attention queue
- `GET /api/admin/clients` — list (server-side search/filter/pagination — §86)
- `GET /api/admin/clients/:id` — detail (overview, subscription, usage, integrations)
- `GET /api/admin/clients/:id/activity` — journey timeline (product_events + admin actions)
- `GET /api/admin/clients/:id/usage` — ledger
- `POST /api/admin/clients/:id/credits` — adjust (ledger entry + audit; §32)
- `POST /api/admin/clients/:id/change-plan` — (§59)
- `POST /api/admin/clients/:id/suspend` · `/reactivate` — (§63–§64)
- `POST /api/admin/clients/:id/cancel-subscription` · `/disconnect-google` · `/initiate-deletion`
- `GET /api/admin/payments` · `GET /api/admin/analytics` · `GET /api/admin/audit`
- `POST /api/admin/auth/login` · `/logout`; admin-user management under `/api/admin/settings/admins`

Cross-cutting: admin-auth middleware, IDOR-safe queries (admin can cross tenants **only** after auth check — §78), confirmation+reason enforcement server-side for destructive actions (§80).

---

## 11. Product-Event Instrumentation Map (Phase 2)

Exact insertion points in `server.js` (this is the real work — the UI is mostly read views over this):

| Event (§39–§43) | Route / location | File:line |
|---|---|---|
| `account_created` | `POST /api/auth/register` | `server.js:2755` |
| `login_success` / `first_login` | `POST /api/auth/login`; Google login callback | `:2803`, `:2924` |
| `card_scan_success` / `first_scan_completed` + `SCAN_CONSUMED` ledger | queue processing (consumption point) | `:1149` |
| `card_scan_failed` | queue `requires_review`/error branch | `:1135–1143` |
| `contact_saved` | `saveContactRecord` / card save | `:3863`, `:3883` |
| `pricing_viewed` | **frontend only — no backend route today** → add a client beacon `POST /api/events` or infer from `/api/overview` billing view | `public/app.js` (needs new endpoint) |
| `checkout_started` | `/api/billing/subscribe`, `/one-time`, `/topup` | `:3098`, `:3122`, `:3186` |
| `payment_success` / `payment_failed` / `subscription_*` | `/api/webhooks/razorpay` + verify endpoints (idempotent — §44) | `:2687`, `:3168`, `:3216` |
| `google_connected` / `google_disconnected` | Google callback / disconnect | `:3272`, `:4158` |
| `google_contacts_sync` / `sheets_sync` | sync endpoints | `:4263`, `:4278` |
| `export_excel/csv/vcf` | export endpoints | `:4109`, `:4124`, `:4139` |
| `topup_purchased` | topup verify | `:3216` |
| `account_deletion` | `DELETE /api/account` | `:4176` |

**Note the `pricing_viewed` gap:** it's a frontend-only interaction with no server endpoint. It needs a small `POST /api/events` beacon in `public/app.js`, otherwise the Pricing-Viewed funnel stage (§15) stays empty. Flagged as its own Phase-2 task.

---

## 12. Backfill Plan — NOT REQUIRED (D5)

The product is **not launched** and has **no existing customer data**, so there is no history to reconstruct. All events and ledger entries accrue natively from launch. This entire workstream is **dropped** — Phase 1 is smaller as a result.

---

## 13. Security Model (spec §79)

Separate admin auth · backend authorisation on every admin call · HTTPS · signed admin sessions w/ TTL (D8) · admin permission check per route · immutable admin audit log · never expose OAuth tokens/passwords/payment credentials · confirmation + reason for destructive ops (enforced server-side) · tenant-safe, IDOR-protected queries · admin-PII access logging (D10).

---

## 14. Revised Phase Roadmap (recap)

- **Phase 0 (this doc)** — audit + decisions. *Gate.*
- **Phase 1** — migrations (§9), admin auth + first-admin bootstrap, lifecycle derivation. *(No backfill — D5.)*
- **Phase 2** — event instrumentation (§11) + usage-ledger cutover (D1/D2) + `pricing_viewed` beacon. Remove trial tier (D4).
- **Phase 3** — admin UI core: Login, Dashboard, Clients list, Client Detail (read-only).
- **Phase 4** — operational actions (credits, plan change, suspend/reactivate, cancel, disconnect, deletion) — each with confirm+reason+audit.
- **Phase 5** — Analytics screens, Payments, Activity/Audit, Settings (minimal — single admin).
- **Phase 6** — validation: prove customer-app actions reach admin with no manual sync (§92).

**Separate customer-app backlog (not admin panel):** pre-scan image-quality gate (D1), phone capture at signup (D3), remove free-trial tier (D4).

---

## 16. Open Questions Before Phase 1 — RESOLVED

- **Q1 — New-user default (D4): RESOLVED — pay-to-start.** A brand-new signup gets **zero scan access until they subscribe**. Funnel is `REGISTERED → PAID` (with `ACTIVATED`/`ENGAGED` only meaningful once a paid client starts scanning). The `trial` seed at `server.js:2769`/`:2946` and `PLAN_LIMITS.trial` are to be removed in Phase 2's trial-removal task.
- **Q2 — Pre-scan quality gate (D1): tracked as a separate customer-app task**, so the admin panel is not blocked on it. Listed on the customer-app backlog (§14).

---

## 17. Build Progress

**Phase 1 delivered (backend in `F:\EasySave`, frontend in `F:\Card2leadsAdmin`):**
- Schema: admin + analytics tables appended to `db/schema.sql` (independent of the customer app's in-memory persistence, so never clobbered), plus `users.phone`.
- Admin backend in `server.js`: separate admin auth (login/logout/me, signed `admin_session` cookie, 8h TTL / 30m idle), first-admin env bootstrap, immutable admin audit log, lifecycle derivation, and read endpoints — `/api/admin/dashboard`, `/api/admin/clients`, `/api/admin/clients/:id`. Dispatched before the customer API; wrapped in try/catch. `node --check` clean.
- `scripts/create-admin.js` for manual admin creation/reset.
- Admin SPA (`public/`): login, Dashboard (KPIs + funnel + attention queue), Clients (server-side search/filter/pagination), Client Detail drawer (account, usage & billing, journey, payments, users, Google, notes). Login screen verified rendering in-browser.

**Next — Phase 2:** event instrumentation at the `server.js` points mapped in §11, usage-ledger cutover at `:1149` (D1/D2), `pricing_viewed` beacon, and remove the trial tier (D4).

**Phase 2 delivered:**
- Ledger + payment records + `scan_completed`/`plan_activated` events (done earlier customer-side): `SCAN_CONSUMED` on billable scans only, `PLAN_ALLOCATION`/`TOPUP_PURCHASE` on billing, `payments` rows on every paid path.
- Funnel events added this pass: `account_created`, `login_success` + `first_login` (via `createSession`), `checkout_started` (×3 billing endpoints), `google_connected`/`google_disconnected`, `export_excel`/`csv`/`vcf`, `account_deletion`.
- `payment.failed` webhook branch → failed `payments` row + `payment_failed` event + recurring sub flipped to `past_due` (feeds the attention queue).
- Whitelisted `POST /api/events` beacon (`pricing_viewed`/`plan_selected`), fired from the customer SPA's account/billing view.
- Fixed a Phase-1 dashboard bug (scans-today used `card_scan_success`; the emitted name is `scan_completed`); admin funnel is now **Registered → Activated → Pricing Viewed → Checkout Started → Paid** from distinct-client event counts.
- All `node --check` clean. Pay-to-start gate (`planUsage` → `orgIsPaid`) shipped customer-side; the trial tier is now inert (new orgs get 0 allowance unless demo/paid).

**Phase 2 still open (minor):** no `subscriptions`-table writes (admin derives sub status from org fields); no product events for subscription cancel/expire; usage remains the `scansUsed` counter with the ledger as an audit mirror — strict "ledger-authoritative" cutover deferred until the mirror is trusted.

**Then — Phases 3–4:** client-detail polish, then operational actions (adjust credits, change plan, suspend/reactivate, cancel, disconnect, initiate deletion) — each with confirmation + reason + admin audit.

---

## 15. Top Risks

1. **Instrumentation is the critical path**, not the UI. If Phase 2 slips, the whole analytics half of the panel is empty.
2. **Ledger/counter dual-write** (D2) — must be a clean cutover at `:1149` or billing will disagree with itself.
3. **`server.js` is a 5,469-line monolith with an in-memory `db` mirrored to Postgres.** Admin read queries at scale should hit Postgres directly (server-side pagination §86), *not* the in-memory object, to avoid loading everything into process memory.
4. **Trial-removal cleanup** (D4) — the `trial` plan is threaded through `PLAN_LIMITS`, new-account seeding, and lifecycle logic; removing it must be done carefully so new signups land in the correct "must subscribe" state (Q1).

---

*Awaiting sign-off on D1–D10 before Phase 1.*
