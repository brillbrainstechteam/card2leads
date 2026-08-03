# EasySave Sellability Checklist

This checklist tracks what EasySave needs before it can be sold to jewellers exhibiting at or visiting trade shows.

## Must Be Clear

- [ ] First screen should explain: scan cards, review extraction, save to next row, download Excel/CSV or sync Google Sheet.
- [x] Avoid internal words like `collection`; use `Sheet / Export`, `Current sheet`, `New sheet`.
- [x] Add visible upload limits: `20 cards per batch`, `10 MB each`, supported formats.
- [x] Show the workflow clearly: `Upload/Scan -> Review -> Save -> Export/Sync`.
- [x] Add a short "Getting started" panel for first-time users.

## Login & Onboarding

- [ ] Google login should work smoothly in production without test-user setup.
- [ ] Email signup must include email verification.
- [ ] Add password reset.
- [ ] Add forgot password.
- [x] Add clear logout.
- [ ] Add first-run setup for workspace, default exhibition name, export type, and optional Google Sheets connection.
- [ ] Add sample/demo mode with fake cards for sales demos.

## Security

- [ ] Use HTTPS in production.
- [ ] Session cookie must be `HttpOnly`, `Secure`, `SameSite`.
- [ ] Add CSRF protection for save/delete/export actions.
- [ ] Add rate limits for login, upload, extraction, export.
- [ ] Add stronger password rules and password reset tokens.
- [x] Never expose OpenAI/Gemini/Google keys in browser.
- [x] Encrypt Google refresh tokens at rest.
- [ ] Add account deletion and Google disconnect.
- [ ] Add privacy policy and terms before selling.
- [ ] Add data-retention policy for card images.

## Accuracy

- [x] Make `Name` and `Mobile Number` mandatory.
- [ ] Add field-level confidence, not only overall confidence.
- [ ] Highlight low-confidence fields.
- [ ] Improve image preprocessing: rotate, crop, sharpen, contrast.
- [ ] Support rotated/vertical cards better.
- [ ] Add reprocess card button.
- [ ] Add second-pass verification for paid/high-accuracy mode.
- [ ] Add duplicate detection within the same upload batch.
- [ ] Add QR/vCard extraction later.

## Upload/Scan Flow

- [x] Multiple image upload should remain primary.
- [x] Mobile camera one-by-one scanning should be prominent.
- [ ] Show thumbnails before upload.
- [ ] Show selected file count.
- [ ] Show per-card status: processing, needs review, saved, failed.
- [ ] Add retry for failed cards.
- [ ] Add clear message: one image should contain one card.
- [ ] Add front/back pairing later.

## Review & Saving

- [ ] Review screen should support fast keyboard/tab flow.
- [ ] Add Save all valid contacts for batches.
- [x] Keep invalid cards in review.
- [x] Add skip/delete per card.
- [x] Add duplicate modal.
- [ ] Add edit contact from contact list.
- [ ] Add bulk delete/export.
- [ ] Add better validation for email, website, phone formatting.

## Sheets / Exports

- [x] Current default should append to next empty row.
- [ ] Google Sheet sync should show exact status: connected, pending, failed, synced.
- [ ] Add Google reconnect flow.
- [x] Add Open Google Sheet.
- [x] Add Create new Google Sheet.
- [ ] Add Use existing Google Sheet selection, not only create new.
- [x] Validate sheet headers before syncing.
- [x] Never append duplicate row for same Contact ID when row reference exists.
- [x] Excel and CSV download should include complete current sheet/export.
- [ ] Add export filters: current exhibition, date range, selected contacts, unsynced contacts.

## Jeweller-Specific Sellability

- [ ] Add industry-specific fields only when needed: buyer type, product interest, follow-up priority.
- [ ] Add quick tags: `Hot lead`, `Follow up`, `Buyer`, `Supplier`, `Existing customer`.
- [ ] Add WhatsApp-ready export column or WhatsApp link.
- [ ] Add post-exhibition follow-up list.
- [ ] Add export for sales team format.
- [ ] Add exhibition templates: `IIJS`, `JJS`, `GJEPC`, custom event.

## Reliability

- [ ] Move extraction to background jobs before selling seriously.
- [ ] Add progress updates instead of waiting on one request.
- [ ] Add retry queue for AI and Google failures.
- [ ] Add database backups.
- [ ] Add object storage instead of local disk for card images.
- [ ] Add monitoring/logging for failed uploads and syncs.
- [ ] Add audit log viewer only for useful actions, not too noisy.

## Admin / Business

- [ ] Add pricing plan limits: cards/month, users/workspace, Google sync, high-accuracy extraction.
- [ ] Add billing or manual subscription control.
- [ ] Add admin panel for users, usage, failed jobs.
- [ ] Add support/contact link.
- [ ] Add import/export backup.
- [ ] Add terms around personal data from business cards.

## Before Selling

- [ ] Prepare a hosted production deployment.
- [ ] Use real domain and HTTPS.
- [ ] Verify Google OAuth app for production or keep it internal/test-only for pilots.
- [ ] Prepare privacy policy and terms.
- [ ] Test with 100-200 real exhibition contact cards.
- [ ] Measure extraction accuracy by field.
- [ ] Create a 2-minute demo video.
- [ ] Create a simple landing page: "Scan exhibition visiting cards into Excel/Google Sheets."
- [ ] Offer pilot onboarding: "We set up your event sheet before the exhibition."
