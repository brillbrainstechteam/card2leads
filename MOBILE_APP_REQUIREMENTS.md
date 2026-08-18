# Card2Leads — Mobile App Requirements & Build Strategy

**Owner:** BrillBrains Consultants Pvt. Ltd.
**Source app:** Card2Leads web app (`F:\EasySave` → github.com/brillbrainstechteam/card2leads)
**Live:** https://card2leads.brillbrainsconsultants.com
**Doc purpose:** A single reference a mobile developer can build from — captures every feature, screen, API, data field, and native capability of the existing web app, plus the recommended approach and a phased plan.

---

## 1. Goal

Give users a phone app where they can **scan business cards one at a time**, review/correct the extracted details, add voice notes and labels, and do **everything the web app does** (contacts, exports, Google sync, team, billing) — with a native-feeling capture experience and an app-store presence.

---

## 2. Strategic recommendation

### TL;DR — **Wrap the existing web app with Capacitor. Do not rewrite natively. Do not stop at CSS fixes.**

The web app is already a PWA (installable, standalone, service worker, responsive) and the backend is a clean REST API. A full native rewrite would duplicate all business logic for little gain; CSS-only fixes leave you without an app-store listing, native camera UX, or push. Capacitor reuses ~100% of the existing web code inside a native iOS/Android shell and lets you drop to native plugins exactly where it matters (camera, share, push, biometrics).

### Options considered

| Option | Effort | Reuses web code | App store | Native camera / one-by-one scan | Push | Verdict |
|---|---|---|---|---|---|---|
| **A. Improve PWA only** | Low | 100% | ❌ No | Camera via file-input only (no live preview/auto-capture) | iOS 16.4+ only, fragile | Good v0 / fallback, not the destination |
| **B. Capacitor hybrid** (recommended) | Medium | ~100% | ✅ iOS + Android | ✅ Native camera plugin, live preview, auto-capture | ✅ Full | **Chosen** |
| **C. Full native (React Native / Flutter / native)** | High | 0% (logic re-implemented) | ✅ | ✅ Best-in-class | ✅ | Not justified — backend already does the heavy lifting |

### Why Capacitor specifically
- **Reuse:** The whole `public/` SPA loads inside the Capacitor WebView unchanged. One codebase, one place to fix bugs.
- **Backend untouched:** The Node REST API stays exactly as is; the app is just another API client.
- **Native where it counts:** Swap the file-input capture for a native camera plugin to get the "scan one by one" flow (live preview, edge guidance, auto-capture, instant re-take).
- **Store presence & trust:** Real listings on Play Store / App Store — important for a paid B2B tool and for OAuth/branding credibility.
- **Precedent:** Capacitor was already present in this project's dependencies previously (pruned accidentally), so the direction was already anticipated.

### What "just fix the mobile browser view" gets you (and doesn't)
- ✅ Works today for most Android users as an installable PWA.
- ❌ No App Store listing (iOS users can't find it in the store; PWA install on iOS is clunky).
- ❌ No live camera preview / auto-capture — capture stays a "pick a photo" flow.
- ❌ Push notifications unreliable on iOS; no biometric unlock; no native share sheet.
- **Use it as Phase 0** (ship the PWA now to validate demand) — then wrap with Capacitor.

---

## 3. Architecture

```
┌─────────────────────────────┐        HTTPS / JSON        ┌──────────────────────────┐
│  Mobile app (Capacitor)     │  ───────────────────────►  │  Existing Node server.js  │
│  • Existing web SPA (public)│                            │  • 77 REST routes         │
│  • Native plugins:          │  ◄───────────────────────  │  • Postgres (jsonb cache) │
│    camera, filesystem,      │        Bearer token /       │  • Gemini / OpenAI OCR    │
│    share, push, biometric   │        session cookie       │  • Google, Razorpay, WA   │
└─────────────────────────────┘                            └──────────────────────────┘
```

- **No backend rewrite.** Mobile client consumes the same endpoints as the web app.
- **Auth transport:** Web app uses an HTTP-only session cookie. For native, prefer a **bearer token** issued at login (the `/api/auth/mobile/exchange` route already exists for deep-link token handoff — extend it to return a long-lived token the app stores in secure storage). Keep cookie auth as the fallback inside the WebView.
- **Config:** API base URL configurable per build (staging vs prod).

---

## 4. Complete feature inventory (parity target)

The web app has **four primary screens** plus auth. The mobile app should reach parity, reordering for a capture-first phone experience.

### 4.1 Authentication
- Email + password (register, login, forgot/reset, email verification, resend).
- **Sign in with Google** (OAuth) — needs native deep-link callback handling.
- **Sign in with WhatsApp OTP** (`/api/auth/otp/request` + `/verify`) — good primary method on mobile.
- Mandatory **onboarding** after first login: name, company, phone (`/api/onboarding`).
- 30-day sessions. Demo account bypasses billing.
- **Native additions:** biometric (Face ID / fingerprint) unlock of a stored session; "remember me" via secure storage.

### 4.2 Upload / Scan (the core mobile flow — see §7)
- Single capture, back-of-card capture, and bulk multi-image upload (`accept="image/*" capture="environment"` today).
- Deferred "Pending" upload queue; process pending (`/api/uploads/process-pending`).
- AI extraction (Gemini primary, OpenAI fallback), multilingual (transliterates to English + keeps native script), confidence scoring.
- Exhibition/event tagging per upload batch.

### 4.3 Review
- List of cards awaiting review (`Review (n)` badge).
- Edit every extracted field before saving; low-confidence flagging.
- Duplicate detection → fill-blanks-merge flow (never overwrite/duplicate).
- Save valid cards (`/api/cards/save-valid`).
- **Voice note** attach + transcription (`/api/voice-notes/transcribe`), editable transcript fields.

### 4.4 Contacts & Exports
- Searchable, filterable contact list (by assignee, exhibition, city, state, free text).
- Compact / extended table views.
- Edit contact; set/add city (auto-maps state); bulk delete.
- Assign contacts to team members.
- **Exports:** Excel (`.xlsx`), CSV, VCF — respecting active filters; VCF/file name includes the assignee when filtered, and contains only that member's contacts.
- **Google sync:** save selected to **Google Contacts** (`[Exhibition Year]. Person Name. City State` format), create/update **Google Sheets**.
- Per-contact **WhatsApp** message (configurable templates, multilingual variants) or **Email** fallback (mailto) when no WhatsApp number.
- **Native additions:** native share sheet for exported files; "save to phone contacts" via native contacts plugin; tap-to-call / tap-to-WhatsApp.

### 4.5 Account
- Profile, company, onboarding data.
- **Billing:** pay-to-start plans (₹499 / 1 month / 150 scans; ₹799 / 3 months / 300; ₹1499 / 1 year / 1500), subscriptions, top-ups, Razorpay checkout, usage/quota display.
- **Team management:** invite/list members, assign contacts.
- **Integrations:** connect/disconnect Google; configure Google target (Contacts/Sheets).
- **WhatsApp message settings:** template library editor.
- Legal: Privacy Policy, Terms, Contact.

---

## 5. API reference (existing — reuse as-is)

Grouped from `server.js` (77 routes). All JSON over HTTPS.

**Auth & session**
- `POST /api/auth/register`, `/login`, `/logout`
- `POST /api/auth/forgot-password`, `/reset-password`
- `POST /api/auth/verify-email`, `/resend-verification`
- `GET|POST /api/auth/google/start`, `/api/auth/google/callback`
- `POST /api/auth/otp/request`, `/api/auth/otp/verify` (WhatsApp OTP)
- `POST /api/auth/mobile/exchange` (native token handoff — extend for app)
- `GET /api/me`, `GET /api/account`, `POST /api/onboarding`, `GET /api/overview`
- `POST /api/demo/start`

**Cards & uploads (scan pipeline)**
- `POST /api/uploads`, `POST /api/uploads/process-pending`
- `GET|POST /api/cards`, `GET|PATCH|DELETE /api/cards/:id`, `POST /api/cards/save-valid`
- `POST /api/voice-notes/transcribe`, `GET /api/voice-notes/:id`

**Contacts & collections**
- `GET|POST /api/contacts`, `GET|PATCH|DELETE /api/contacts/:id`, `POST /api/contacts/bulk-delete`
- `GET|POST /api/collections`, `GET|PATCH /api/collections/:id`
- `GET /api/team`, `POST /api/team/:id` (assign / manage)

**Exports & Google**
- `GET /api/export.xlsx`, `/api/export.csv`, `/api/export.vcf` (accept filter params: `assigneeId`, `exhibition`, `city`, `state`, `q`, `collectionId`, `ids`, `all`)
- `POST /api/google/connect`, `/api/google/configure`, `/api/google/disconnect`, `/api/google/callback`
- `POST /api/google/contacts/sync`, `/api/google/sync`, `/api/google/create-sheet`

**Billing**
- `POST /api/billing/one-time`, `/api/billing/one-time/verify`
- `POST /api/billing/subscribe`, `/api/billing/topup`, `/api/billing/topup/verify`
- `POST /api/webhooks/razorpay`

**Settings & misc**
- `POST /api/settings/whatsapp`, `POST /api/events`, `GET /api/audit`, `GET /api/health`

> **Mobile-specific API work needed:** (1) issue a bearer token from `/api/auth/mobile/exchange` (and accept `Authorization: Bearer` on protected routes alongside the cookie); (2) confirm upload endpoints accept multipart or base64 image payloads at the sizes a phone camera produces; (3) CORS/allowed-origin entry for the Capacitor origin (`capacitor://localhost` / `https://localhost`).

---

## 6. Data model (contact record — 29 fields)

Every extracted contact carries these (also the export columns). The mobile edit form must cover them:

`Saved Contact Name, Name, Name (Original Script), Mobile Number, Country Code, Phone Country, WhatsApp Number, Secondary Mobile Number, Company Name, Company Name (Original Script), Designation, Office Number, Email Address, Secondary Email, Website, Address, Address (Original Script), City, State, State Code, Postal Code, Country, Card Language, Exhibition Name, Exhibition Date, Remarks, Voice Note, Tags, Created Timestamp.`

- **Multilingual:** `name/companyName/address/city/state` are stored transliterated to **English**; `*Native` fields hold the original script; `cardLanguage` names the detected language.
- **Collections** group contacts by exhibition/event (name + date).
- **Assignment:** `assignedToId` / `assignedToName` link a contact to a team member.
- Server stores extra fields in a Postgres `data` jsonb column, so adding mobile-only fields needs no migration.

---

## 7. The "scan one by one" flow (the reason for the app)

This is the flagship mobile experience — spec it as native, not a file-picker.

1. **Capture screen** (native camera plugin): live preview, card-edge framing guide, tap or auto-capture when the card is in focus/steady, torch toggle, front-then-back capture option.
2. **Instant feedback:** thumbnail + "Extracting…" while the image is sent to `/api/uploads` → extraction.
3. **Quick review card:** extracted fields shown in an editable card; low-confidence fields highlighted; one-tap correct.
4. **Enrich:** attach a voice note (hold-to-record), add tags, pick/confirm exhibition, set city if missing (auto-maps state).
5. **Save & next:** save (`/api/cards/save-valid`) and immediately re-open the camera for the next card — a tight capture→save→capture loop.
6. **Duplicate handling:** if the number/email matches, show the fill-blanks-merge prompt inline.
7. **Offline:** if no connection, queue the image locally and extract when back online (see §9).

**Native capabilities required:** Camera (live), Filesystem (queue images), Microphone (voice), Share (export files), Push (optional), Biometric (optional), Contacts (optional "save to phone").

---

## 8. Native capability map

| Capability | Web app today | Mobile plugin needed |
|---|---|---|
| Card image capture | `<input capture="environment">` (opens camera, no preview) | `@capacitor/camera` — live preview, auto-capture |
| Bulk image select | file input (multiple) | Camera/Filesystem picker |
| Voice note | `getUserMedia` + `MediaRecorder` (iOS codec quirks) | `@capacitor-community/voice-recorder` (stable AAC on iOS) |
| Export file download | browser download | `@capacitor/filesystem` + `@capacitor/share` (native share sheet) |
| Google OAuth | web redirect | Deep-link callback / in-app browser (`@capacitor/browser`) |
| Push notifications | limited (iOS 16.4+) | `@capacitor/push-notifications` (FCM/APNs) |
| Login persistence | cookie | `@capacitor/preferences` + secure storage + biometrics |
| Save to phone contacts | ❌ | community contacts plugin (optional) |

---

## 9. Offline & sync behaviour
- **Capture offline:** store the raw image + metadata in local filesystem; show a "pending sync" badge; auto-upload + extract when connectivity returns.
- **Read cache:** cache the contact list for offline viewing (read-only).
- **Conflict rule:** reuse the server's existing zero-failure, fill-blanks-merge duplicate policy — the client never decides merges locally.

---

## 10. Non-functional requirements
- **Multi-tenant isolation:** every request already scoped to the user's organisation — the app must never send/accept cross-org IDs.
- **Billing enforcement:** respect `402`/pay-to-start responses; show the plan picker; demo account is unlimited.
- **Security:** tokens in secure storage only; no credentials in URLs; certificate-pinned HTTPS if feasible; biometric gate optional.
- **Performance:** compress card images client-side before upload (phone cameras produce large files); target < 3 s capture→extracted on a normal connection.
- **Accessibility:** large tap targets, one-handed capture, high-contrast review fields.
- **Localisation:** UI primarily English; data extraction already multilingual.

---

## 11. Phased delivery plan

- **Phase 0 — PWA polish (days):** finish mobile CSS, ensure the installable PWA works well on Android; ship as an interim app to validate. (Low cost, immediate.)
- **Phase 1 — Capacitor shell (1–2 wks):** wrap `public/` in Capacitor; Android + iOS builds; bearer-token auth via `/api/auth/mobile/exchange`; app loads and does full parity through the WebView.
- **Phase 2 — Native capture (1–2 wks):** replace file-input capture with the native camera plugin and the §7 one-by-one flow; native voice recorder; native share for exports.
- **Phase 3 — Native niceties (1 wk):** push notifications, biometric unlock, offline capture queue, "save to phone contacts."
- **Phase 4 — Store launch:** Play Store + App Store listings, privacy/data-safety forms (reuse existing Privacy Policy), screenshots, review.

---

## 12. Open questions for the client
1. **Target platforms & priority** — Android first, iOS first, or both together?
2. **App-store accounts** — does BrillBrains have Apple Developer + Google Play developer accounts ready?
3. **Auth on mobile** — is WhatsApp OTP the preferred primary login (fits mobile best), with Google + email as secondary?
4. **Offline** — is offline capture a launch requirement or a later phase?
5. **Push** — any push use cases at launch (e.g. "extraction complete", quota warnings), or defer?
6. **Branding** — reuse the web look inside the shell, or a mobile-tailored visual pass?
```
