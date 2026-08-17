# Card2Leads Admin Panel — End-to-End Test Plan (Phase 6)

Verifies that real activity in the **customer app** (Card2Leads, `F:\EasySave`) flows into the
**admin panel** (`F:\Card2leadsAdmin`) with no manual syncing, and that admin actions take effect.

## Setup / preconditions

1. `F:\EasySave` backend running on Postgres (port 5173). `npm run dev`.
2. Admin created: `node scripts/create-admin.js <email> <pw> "Name"`.
3. Admin UI running: `node dev-server.js` in `F:\Card2leadsAdmin` (port 4100). Sign in.
4. Have the customer app open in another browser/incognito (http://localhost:5173).

## ⚠️ Read these gotchas first — they explain "why didn't it show up?"

- **Events need Postgres.** In local JSON-fallback mode (no DB) nothing records. You're on Postgres, so fine.
- **Pay-to-start blocks scanning on unpaid accounts.** A brand-new account has **0 scan allowance** and cannot scan until it pays (or is a demo account via `DEMO_ACCOUNT_EMAIL`). So **do scanning tests on a paid or demo account**, otherwise scans are blocked and no `scan_completed` events fire.
- **Scanning is asynchronous.** A card is scanned by a background queue a few seconds after upload, so scan/usage/ledger updates appear after a short delay — refresh the admin client detail.
- **`pricing_viewed` fires from the in-app Account/Billing view** (logged-in), not the public landing-page pricing section (anonymous visitors can't be attributed to a client).
- **`payment_failed` needs a real Razorpay webhook** delivered to `/api/webhooks/razorpay`. It's hard to simulate locally without Razorpay firing it — treat C5 as a staging/production test.
- **Successful payment records via the `/verify` path too**, so C3/C4 (payment success, ledger, plan activation) *can* be tested locally with Razorpay test keys even without webhooks configured.
- **Refresh the client-detail drawer** after an action to see the new state (it re-fetches on open).

---

## A. Account & lifecycle

| # | Do in Card2Leads | Expect in Admin Panel | Backing |
|---|---|---|---|
| A1 | Register a new account | Dashboard: Total Clients +1, New Signups +1. Clients list: new row, lifecycle **REGISTERED**. Client Detail → Journey shows "account created". | `account_created` |
| A2 | Verify email + first login | Client Detail → Journey shows **first login** + **login success**. Lifecycle still REGISTERED (no scans, pay-to-start). | `first_login`, `login_success` |
| A3 | Log out and log in again | Journey gets another **login success**; **first login is NOT duplicated** (idempotent). "Last activity" updates. | idempotency key |

## B. Scanning & usage (use a PAID or DEMO account)

| # | Do in Card2Leads | Expect in Admin Panel | Backing |
|---|---|---|---|
| B1 | Upload a clear business card; wait for it to process | Client Detail → Usage "used" +1; Usage ledger shows **SCAN_CONSUMED −1**; Journey shows a scan event. Dashboard "Scans Today" +1. Lifecycle → **ACTIVATED**. | `scan_completed`, ledger |
| B2 | Upload a blurry / poor-quality image | Usage does **NOT** increment; **no SCAN_CONSUMED** entry (only billable scans count). Card still goes to review. | D1 billable flag |
| B3 | Scan until allowance is used up | Clients list usage shows near/at limit; Dashboard Attention → **Usage exhausted** +1. | derived |

## C. Commercial funnel

| # | Do in Card2Leads | Expect in Admin Panel | Backing |
|---|---|---|---|
| C1 | Open the in-app **Account / plans** view | Analytics → Conversion "Pricing Viewed" +1; Client Detail journey. | `pricing_viewed` (beacon) |
| C2 | Click a plan / start checkout (subscribe, one-time, or top-up) | Analytics "Checkout Started" +1; Journey "checkout started". | `checkout_started` |
| C3 | Complete a subscription / one-time payment (Razorpay test) | Lifecycle → **PAID**. Client Detail: usage allowance set, **Payments** row (paid), ledger **PLAN_ALLOCATION**, journey "plan activated". **Payments screen** shows it. Dashboard Active Paid +1, conversion % updates. | `plan_activated`, `payments`, ledger |
| C4 | Buy a top-up | Usage allowance increases; ledger **TOPUP_PURCHASE**; Payments row (plan = topup). | ledger, `payments` |
| C5 | (Staging) Trigger a failed payment | Payments row **failed**; Journey "payment failed"; recurring sub → PAST_DUE → lifecycle **PAYMENT_FAILED**; Dashboard "Failed Payments" +1 + Attention. | `payment.failed` webhook |

## D. Integrations & exports

| # | Do in Card2Leads | Expect in Admin Panel | Backing |
|---|---|---|---|
| D1 | Connect Google | Client Detail → Google Integration **Connected** + account email; journey "google connected". | `google_connected` |
| D2 | Disconnect Google | Google Integration → **not connected**; journey "google disconnected". | `google_disconnected` |
| D3 | Export contacts (Excel / CSV / VCF) | Analytics → Engagement "Exports" increments; journey shows the export. | `export_excel/csv/vcf` |

## E. Admin operational actions (do in Admin, verify effect + audit)

| # | Do in Admin Panel | Expect | Backing |
|---|---|---|---|
| E1 | Client Detail → Adjust Credits → **Add** N (with reason) | Usage limit +N (also reflected in the customer app's remaining scans); ledger **ADMIN_CREDIT**; Activity/Audit shows **CREDITS_ADDED** + reason. | ledger + audit |
| E2 | Adjust Credits → **Remove** N | Limit reduced (not below used); ledger **ADMIN_DEBIT**; audit **CREDITS_REMOVED**. | ledger + audit |
| E3 | Change Plan | Plan + allowance updated; audit **PLAN_CHANGED** (old→new). | audit |
| E4 | Suspend (with reason) | Customer is **locked out immediately** (verify: the customer app logs them out / blocks access). Audit **ACCOUNT_SUSPENDED**. | `currentUser` enforcement |
| E5 | Reactivate | Customer access restored; audit **ACCOUNT_REACTIVATED**. | |
| E6 | Cancel Subscription | Subscription status → cancelled; audit **SUBSCRIPTION_CANCELLED** (Razorpay cancel attempted). | |
| E7 | ••• → Disconnect Google | Google integration disconnected; audit **INTEGRATION_DISCONNECTED**. | |
| E8 | ••• → Initiate Deletion | Status → **PENDING_DELETION**; customer locked out; audit **ACCOUNT_DELETION_INITIATED**. (Auto-purge after 30 days is not built — it only marks.) | |
| E9 | Add Internal Note | Note appears in Client Detail; **NOT** visible anywhere in the customer app. | `admin_notes` |
| E10 | Try any high-impact action with the reason blank | Blocked with "A reason is required". | validation |

## F. Screens / read models

| # | Check | Expect |
|---|---|---|
| F1 | Dashboard funnel | Registered → Activated → Pricing Viewed → Checkout Started → Paid, counts match reality. |
| F2 | Analytics range filter | Switching Today / 7d / 30d / 90d changes the numbers. |
| F3 | Payments screen | Status filter + pagination work; amounts in ₹. |
| F4 | Activity/Audit | Every admin action from section E is listed, newest first, with admin + reason. |
| F5 | Settings | Plans display correctly; **Add admin** works; disable/reactivate works; you **cannot disable your own** account. |
| F6 | Global search (top bar) | Find a client by company name, user email, mobile, or client ID. |

## G. Security / edge

| # | Check | Expect |
|---|---|---|
| G1 | Hit `/api/admin/dashboard` with no admin login | 401 Unauthorized. |
| G2 | A normal customer session (no admin cookie) hitting an admin API | 401 (route-hiding is not the security — the backend enforces it). |
| G3 | Client Detail → Google | Shows only the connected **email/status** — never tokens/secrets. Passwords never shown anywhere. |
| G4 | Open a Client Detail | An audit entry **CLIENT_VIEWED** is recorded (PII-access logging). |
| G5 | Suspended account (from E4) | That customer cannot log in or call customer APIs until reactivated. |

---

## How to report results
For any row that fails, note: **what you did**, **what you expected**, **what actually happened** (and any error text / server console line). That's enough to pinpoint and fix it.
