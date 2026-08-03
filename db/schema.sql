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
