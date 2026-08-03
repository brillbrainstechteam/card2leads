# EasySave Production Build Prompt

Build EasySave, a production-ready business card scanner and contact management system, using the two source requirement documents as the authority:

1. `Business Card Scanner and Contact Management System.docx`
2. `Revised Contact Saving Requirements.pdf`

The revised PDF overrides the earlier save and export rules:

- `Name` is mandatory.
- `Mobile Number` is mandatory.
- All other contact fields are optional.
- A contact must not be saved unless `Name` and a valid `Mobile Number` are present.
- Excel and Google Sheets exports must always include `Name` and `Mobile Number`.
- Contacts must belong to a collection.
- Every saved contact, upload batch, card file, sync record, export job, and audit log must preserve created timestamps; editable records must also preserve updated timestamps.
- New uploads should append to the current collection by default.
- Existing Google Sheet rows must never be overwritten.
- Existing contacts should update their original row instead of appending duplicates.

## Product Scope

Implement:

- Secure registration, login, logout, and session cookies.
- PostgreSQL as the primary source of truth.
- A relational PostgreSQL schema for organisations, users, sessions, collections, upload batches, card files, contacts, phones, emails, Google connections, sheet configurations, sync records, export jobs, and audit logs.
- Private storage for original business card images.
- Multiple image upload with per-file status.
- Upload limits, supported file validation, and duplicate image checksum detection.
- AI vision extraction when `OPENAI_API_KEY` is configured.
- Safe fallback/manual review when AI is unavailable.
- Extraction confidence, warnings, raw visible text, and editable review fields.
- Review screen with card image preview, validation warnings, and duplicate warnings.
- Mandatory save validation for `Name` and `Mobile Number`.
- Duplicate detection using normalized mobile number as the strongest identifier.
- Duplicate actions: skip, update existing, keep both, merge information.
- Contact collections with collection name, exhibition name, exhibition date, destination, saved count, and next sheet row.
- Excel export for the complete collection with the revised required column order, plus `Created Timestamp` and `Updated Timestamp` system columns.
- Spreadsheet formula-injection protection for exported values beginning with `=`, `+`, `-`, or `@`.
- Google OAuth readiness with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.
- Google Sheets append/update design that stores row references and avoids duplicate retry rows.
- Audit logs for upload, extraction, edit, save, delete, export, sync, and settings changes.
- Contact search, collection management, soft deletion, and clear user-facing errors.
- Local Docker Compose setup for PostgreSQL.
- A setup guide explaining Google Cloud Console steps and required environment variables.

## Acceptance Criteria

- A user can register and log in.
- Logged-out users cannot access protected data.
- User can upload multiple supported business-card images.
- Invalid files are rejected without blocking valid files.
- Each card has an independent status.
- AI/manual extraction creates editable review records.
- User cannot save without `Name` and `Mobile Number`.
- Valid contacts persist in PostgreSQL after refresh/restart.
- Saved contacts show timestamps in the UI and Excel export.
- PostgreSQL contains real domain tables, not a single application-state blob.
- Duplicate mobile numbers are detected before save.
- Excel download contains the complete collection and preserves phone/postal values as text.
- Google OAuth credentials can be configured.
- Contacts append to Google Sheets without overwriting existing rows.
- Retry does not create duplicate Google Sheet rows.
- Important actions appear in audit logs.

## Current Implementation Notes

- Local PostgreSQL is provided by `docker-compose.yml`.
- The app uses `DATABASE_URL` to switch to PostgreSQL storage.
- Uploaded card images are stored under `private_storage/cards` and served only through authenticated API routes.
- Google Sheets and full AI extraction are still credential-gated integration points.
