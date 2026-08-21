drop table if exists app_state;

create table if not exists organisations (
  id text primary key,
  name text not null,
  plan text not null default 'starter',
  retention_policy text not null default '90-days',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists users (
  id text primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  name text not null,
  email text not null unique,
  password_hash text not null,
  email_verified boolean not null default false,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  data jsonb not null default '{}'::jsonb
);

create table if not exists collections (
  id text primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  name text not null,
  exhibition_name text,
  exhibition_date date,
  destination_type text not null default 'excel',
  destination_name text,
  spreadsheet_id text,
  worksheet_id text,
  saved_contact_count integer not null default 0,
  next_sheet_row integer not null default 2,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists upload_batches (
  id text primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  collection_id text references collections(id) on delete set null,
  uploaded_by text references users(id) on delete set null,
  total_files integer not null default 0,
  completed_files integer not null default 0,
  failed_files integer not null default 0,
  review_required_count integer not null default 0,
  duplicate_count integer not null default 0,
  status text not null default 'processing',
  created_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists card_files (
  id text primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  collection_id text references collections(id) on delete set null,
  batch_id text references upload_batches(id) on delete set null,
  original_file_name text not null,
  storage_path text not null,
  processed_storage_path text,
  checksum text not null,
  file_type text not null,
  file_size bigint not null default 0,
  status text not null,
  extraction jsonb not null default '{}'::jsonb,
  duplicate_image_of text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  data jsonb not null default '{}'::jsonb
);

create table if not exists contacts (
  id text primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  owner_id text references users(id) on delete set null,
  collection_id text references collections(id) on delete set null,
  source_card_id text references card_files(id) on delete set null,
  name text not null,
  mobile_number text not null,
  normalized_mobile_number text not null,
  company_name text,
  designation text,
  department text,
  secondary_mobile_number text,
  office_number text,
  email_address text,
  secondary_email text,
  website text,
  linked_in_url text,
  address text,
  city text,
  state text,
  postal_code text,
  country text,
  exhibition_name text,
  exhibition_date date,
  interest text,
  special_requirement text,
  budget text,
  follow_up_date text,
  voice_transcript text,
  voice_language text,
  voice_note_created_at timestamptz,
  notes text,
  tags text,
  source text not null default 'Business Card Upload',
  uploaded_by text,
  review_status text not null default 'Reviewed',
  duplicate_status text not null default 'none',
  google_sheets_sync_status text not null default 'not_configured',
  sheet_row integer,
  last_synced_at timestamptz,
  extraction_confidence integer not null default 0,
  card_image_reference text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  data jsonb not null default '{}'::jsonb
);

alter table contacts add column if not exists interest text;
alter table contacts add column if not exists special_requirement text;
alter table contacts add column if not exists budget text;
alter table contacts add column if not exists follow_up_date text;
alter table contacts add column if not exists voice_transcript text;
alter table contacts add column if not exists voice_language text;
alter table contacts add column if not exists voice_note_created_at timestamptz;

create table if not exists voice_notes (
  id text primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  created_by text references users(id) on delete set null,
  target_type text not null,
  target_ids jsonb not null default '[]'::jsonb,
  card_id text references card_files(id) on delete set null,
  contact_id text references contacts(id) on delete set null,
  batch_id text references upload_batches(id) on delete set null,
  audio_path text,
  audio_mime_type text,
  audio_size bigint not null default 0,
  transcript text,
  language text,
  interest text,
  special_requirement text,
  budget text,
  follow_up_date text,
  summary text,
  status text not null default 'draft',
  provider text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  deleted_at timestamptz,
  data jsonb not null default '{}'::jsonb
);

create table if not exists contact_phones (
  id text primary key,
  contact_id text not null references contacts(id) on delete cascade,
  phone_number text not null,
  raw_number text,
  normalized_number text not null,
  type text not null default 'mobile',
  extension text,
  is_primary boolean not null default false,
  confidence integer,
  created_at timestamptz not null default now()
);

create table if not exists contact_emails (
  id text primary key,
  contact_id text not null references contacts(id) on delete cascade,
  email text not null,
  type text not null default 'primary',
  is_primary boolean not null default false,
  confidence integer,
  created_at timestamptz not null default now()
);

create table if not exists google_connections (
  id text primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  connected_by text references users(id) on delete set null,
  google_email text,
  encrypted_token text,
  encrypted_refresh_token text,
  token_expiry timestamptz,
  scopes text,
  status text not null default 'not_connected',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists sheet_configurations (
  id text primary key,
  connection_id text references google_connections(id) on delete set null,
  organisation_id text not null references organisations(id) on delete cascade,
  spreadsheet_id text,
  worksheet_id text,
  field_mapping jsonb not null default '{}'::jsonb,
  sync_mode text not null default 'manual',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists sync_records (
  id text primary key,
  contact_id text not null references contacts(id) on delete cascade,
  sheet_configuration_id text references sheet_configurations(id) on delete set null,
  collection_id text references collections(id) on delete set null,
  row_reference integer,
  sync_status text not null default 'pending',
  error text,
  retry_attempts integer not null default 0,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists export_jobs (
  id text primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  requested_by text references users(id) on delete set null,
  collection_id text references collections(id) on delete set null,
  filters jsonb not null default '{}'::jsonb,
  file_path text,
  status text not null default 'completed',
  expiry_time timestamptz,
  created_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists audit_logs (
  id text primary key,
  organisation_id text references organisations(id) on delete cascade,
  user_id text references users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists users_org_idx on users (organisation_id);
create index if not exists sessions_user_expires_idx on sessions (user_id, expires_at);
create index if not exists collections_org_status_idx on collections (organisation_id, status);
create index if not exists upload_batches_org_created_idx on upload_batches (organisation_id, created_at desc);
create index if not exists card_files_org_status_idx on card_files (organisation_id, status);
create index if not exists card_files_checksum_idx on card_files (organisation_id, checksum);
create index if not exists contacts_org_collection_idx on contacts (organisation_id, collection_id);
create index if not exists contacts_mobile_idx on contacts (organisation_id, normalized_mobile_number) where deleted_at is null;
create index if not exists contacts_search_idx on contacts (organisation_id, name, company_name, mobile_number);
create index if not exists voice_notes_org_created_idx on voice_notes (organisation_id, created_at desc);
create index if not exists sync_records_contact_idx on sync_records (contact_id);
create index if not exists audit_logs_org_created_idx on audit_logs (organisation_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Card2Leads Admin Panel — Phase 1 foundation.
-- These tables are INDEPENDENT of the customer app's in-memory persistence
-- (server.js persistPostgresDb never touches them), so admin data is never
-- clobbered by a customer-app save. They are read/written via direct SQL.
-- See F:\Card2leadsAdmin\docs\PHASE-0-TECHNICAL-AUDIT.md.
-- ---------------------------------------------------------------------------

-- Account-holder phone, for admin search (D3). Populated by the main app at signup.
alter table users add column if not exists phone text;

-- Internal administrators (D8). Separate from customer `users`.
create table if not exists admin_users (
  id text primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null default 'super_admin',
  status text not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

-- Admin login sessions (separate cookie from customer sessions).
create table if not exists admin_sessions (
  id text primary key,
  admin_id text not null references admin_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  ip text,
  user_agent text
);

-- Immutable record of every admin action (spec §60-61).
create table if not exists admin_audit_logs (
  id text primary key,
  admin_id text not null,
  admin_email text,
  client_id text,
  action text not null,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Internal notes on a client (spec §35). Never shown in the customer app.
create table if not exists admin_notes (
  id text primary key,
  client_id text not null,
  admin_id text not null,
  admin_email text,
  note text not null,
  created_at timestamptz not null default now()
);

-- Usage ledger (spec §30-31, D1/D2) — the source of truth for scan credits.
create table if not exists usage_ledger (
  id text primary key,
  client_id text not null,
  user_id text,
  transaction_type text not null,   -- PLAN_ALLOCATION | SCAN_CONSUMED | TOPUP_PURCHASE | ADMIN_CREDIT | ADMIN_DEBIT | REFUND_ADJUSTMENT | SYSTEM_CORRECTION
  quantity integer not null,
  balance_effect integer not null,  -- +quantity or -quantity
  source text,                      -- 'plan' | 'scan' | 'topup' | 'admin' | 'system'
  reference_id text,                -- e.g. card_files.id, payment id
  admin_id text,
  reason text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text
);

alter table usage_ledger add column if not exists idempotency_key text;

-- Product / funnel events (spec §37-44). Idempotency key dedupes milestone events.
create table if not exists product_events (
  id text primary key,
  event_name text not null,
  client_id text,
  user_id text,
  session_id text,
  idempotency_key text unique,
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Payment records (spec §54-56), written from the Razorpay webhook/verify paths.
create table if not exists payments (
  id text primary key,               -- internal id
  client_id text not null,
  user_id text,
  amount_paise bigint not null default 0,
  currency text not null default 'INR',
  plan text,
  status text not null,              -- paid | pending | failed | refunded
  provider text not null default 'razorpay',
  provider_payment_id text,
  provider_order_id text,
  provider_reference text,
  subscription_id text,
  failure_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

-- Subscription records (spec §58), derived from billing state.
create table if not exists subscriptions (
  id text primary key,
  client_id text not null,
  plan text,
  status text not null,              -- trial | active | past_due | expired | cancelled
  billing_mode text,                 -- subscription | one_time
  provider text default 'razorpay',
  provider_reference text,
  start_date timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists admin_sessions_admin_idx on admin_sessions (admin_id, expires_at);
create index if not exists admin_audit_client_idx on admin_audit_logs (client_id, created_at desc);
create index if not exists admin_audit_created_idx on admin_audit_logs (created_at desc);
create index if not exists admin_notes_client_idx on admin_notes (client_id, created_at desc);
create index if not exists usage_ledger_client_idx on usage_ledger (client_id, created_at desc);
create unique index if not exists usage_ledger_idempotency_idx on usage_ledger (idempotency_key) where idempotency_key is not null;
create index if not exists product_events_client_idx on product_events (client_id, created_at desc);
create index if not exists product_events_name_idx on product_events (event_name, created_at desc);
create index if not exists payments_client_idx on payments (client_id, created_at desc);
create index if not exists payments_created_idx on payments (created_at desc);
create index if not exists subscriptions_client_idx on subscriptions (client_id, created_at desc);
create unique index if not exists subscriptions_provider_ref_idx on subscriptions (provider, provider_reference) where provider_reference is not null;
create index if not exists users_phone_idx on users (phone);
