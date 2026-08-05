const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
require("dotenv").config();
const { Pool } = require("pg");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const ILLUSTRATION_DIR = path.join(DATA_DIR, "illustration");
const FINAL_ILLUSTRATION_DIR = path.join(DATA_DIR, "illustration_final");
const STORAGE_DIR = path.join(ROOT, "private_storage");
const DB_PATH = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 5173);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
// Only honour X-Forwarded-* headers when the app runs behind a proxy you control.
// Otherwise a client can forge these headers to spoof its IP and defeat rate limiting.
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
// Key used to encrypt stored Google tokens at rest. Defaults to SESSION_SECRET for
// backward compatibility; set ENCRYPTION_KEY to decouple token encryption from the
// session secret so rotating SESSION_SECRET (which signs everyone out) does not make
// previously stored Google tokens undecryptable.
const ENCRYPTION_SECRET = process.env.ENCRYPTION_KEY || SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const EXTRACTION_PROVIDER = String(process.env.EXTRACTION_PROVIDER || "auto").toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const APP_BASE_URL = process.env.APP_BASE_URL || "";
const GOOGLE_AUTH_REDIRECT_URI = process.env.GOOGLE_AUTH_REDIRECT_URI || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "no-reply@easysave.local";
const VOICE_STT_PROVIDER = String(process.env.VOICE_STT_PROVIDER || "auto").toLowerCase();
const GOOGLE_STT_MODEL = process.env.GOOGLE_STT_MODEL || "latest_short";
const GOOGLE_STT_LANGUAGE_CODE = process.env.GOOGLE_STT_LANGUAGE_CODE || "hi-IN";
const GOOGLE_STT_ALTERNATIVE_LANGUAGE_CODES = process.env.GOOGLE_STT_ALTERNATIVE_LANGUAGE_CODES || "en-IN,en-US";
const MAX_BATCH_FILES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_BYTES = 100 * 1024 * 1024;
const EXTRACTION_CONCURRENCY = Math.min(5, Math.max(1, Number(process.env.EXTRACTION_CONCURRENCY || 3)));
const PLAN_LIMITS = Object.freeze({
  trial: 20,
  monthly: 150,
  quarterly: 300,
  annual: 1500,
  // One-time top-up: additional scan credits a user can buy on top of a plan.
  addonCredits: 100,
  // Backward-compatible aliases for accounts created with the earlier pricing.
  starter: 300,
  event: 300
});

// --- Razorpay billing (subscriptions + one-time top-up) ---
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";
const RAZORPAY_PLAN_IDS = {
  monthly: process.env.RAZORPAY_MONTHLY_PLAN_ID || "",
  quarterly: process.env.RAZORPAY_QUARTERLY_PLAN_ID || "",
  annual: process.env.RAZORPAY_ANNUAL_PLAN_ID || ""
};
// Number of billing cycles a subscription runs before completing.
const RAZORPAY_TOTAL_COUNTS = { monthly: 12, quarterly: 8, annual: 5 };
const TOPUP_AMOUNT_PAISE = 49900; // ₹499
const TOPUP_SCANS = 100;

let dbCache = null;
let pgPool = null;
let geminiUnavailableUntil = 0;
const rateLimitBuckets = new Map();
const mobileAuthCodes = new Map();

const EXPORT_COLUMNS = [
  "Name",
  "Mobile Number",
  "Secondary Mobile Number",
  "Company Name",
  "Designation",
  "Office Number",
  "Email Address",
  "Secondary Email",
  "Website",
  "Address",
  "City",
  "State",
  "Postal Code",
  "Country",
  "Exhibition Name",
  "Exhibition Date",
  "Remarks",
  "Tags",
  "Created Timestamp"
];

const OPTIONAL_FIELDS = [
  "companyName",
  "designation",
  "department",
  "secondaryName",
  "secondaryMobileNumber",
  "tertiaryName",
  "tertiaryMobileNumber",
  "officeNumber",
  "emailAddress",
  "secondaryEmail",
  "website",
  "linkedInUrl",
  "address",
  "city",
  "state",
  "postalCode",
  "country",
  "exhibitionName",
  "exhibitionDate",
  "interest",
  "specialRequirement",
  "budget",
  "followUpDate",
  "voiceTranscript",
  "voiceLanguage",
  "notes",
  "tags"
];

const EMPTY_DB = {
  users: [],
  sessions: [],
  organisations: [],
  collections: [],
  uploadBatches: [],
  cards: [],
  contacts: [],
  voiceNotes: [],
  googleConnections: [],
  sheetConfigurations: [],
  syncRecords: [],
  auditLogs: []
};

function validateRuntimeConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  const errors = [];
  if (!DATABASE_URL) errors.push("DATABASE_URL is required in production.");
  if (!APP_BASE_URL.startsWith("https://")) errors.push("APP_BASE_URL must use HTTPS in production.");
  if (SESSION_SECRET === "dev-secret-change-me" || SESSION_SECRET.length < 32) errors.push("SESSION_SECRET must be a unique value of at least 32 characters.");
  if (!emailDeliveryEnabled()) errors.push("Configure RESEND_API_KEY or SENDGRID_API_KEY for verification and password-reset email.");
  if (errors.length) throw new Error(`Production configuration is incomplete: ${errors.join(" ")}`);
}

async function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.mkdirSync(path.join(STORAGE_DIR, "cards"), { recursive: true });
  fs.mkdirSync(path.join(STORAGE_DIR, "voice_notes"), { recursive: true });

  if (DATABASE_URL) {
    try {
      pgPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
      });
      await pgPool.query(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8"));
      dbCache = await loadPostgresDb();
      const retentionChanged = applyCardImageRetention(dbCache);
      const exhibitionAssignmentsChanged = repairCollectionExhibitionAssignments(dbCache);
      const locationsChanged = normalizeContactLocations(dbCache);
      if (retentionChanged || exhibitionAssignmentsChanged || locationsChanged) await saveDb(dbCache);
      console.log("Storage: PostgreSQL");
      return;
    } catch (err) {
      if (process.env.NODE_ENV === "production") throw err;
      pgPool = null;
      console.warn(`PostgreSQL unavailable; using local JSON fallback for development. ${err.message}`);
    }
  }

  if (!fs.existsSync(DB_PATH)) {
    dbCache = normalizeDb(EMPTY_DB);
    await saveDb(dbCache);
  } else {
    dbCache = normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
  }
  const retentionChanged = applyCardImageRetention(dbCache);
  const exhibitionAssignmentsChanged = repairCollectionExhibitionAssignments(dbCache);
  const locationsChanged = normalizeContactLocations(dbCache);
  if (retentionChanged || exhibitionAssignmentsChanged || locationsChanged) await saveDb(dbCache);
  console.log("Storage: local JSON fallback");
}

function readDb() {
  return JSON.parse(JSON.stringify(dbCache));
}

async function saveDb(db) {
  dbCache = normalizeDb(db);
  validateTenantIntegrity(dbCache);
  if (pgPool) {
    await persistPostgresDb(dbCache);
    return;
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(dbCache, null, 2));
}

function validateTenantIntegrity(db) {
  const organisations = new Set(db.organisations.map((item) => item.id));
  const users = new Map(db.users.map((item) => [item.id, item]));
  const collections = new Map(db.collections.map((item) => [item.id, item]));
  const batches = new Map(db.uploadBatches.map((item) => [item.id, item]));
  const cards = new Map(db.cards.map((item) => [item.id, item]));
  const contacts = new Map(db.contacts.map((item) => [item.id, item]));
  const googleConnections = new Map(db.googleConnections.map((item) => [item.id, item]));

  const requireOrganisation = (record, type) => {
    if (!record.organisationId || !organisations.has(record.organisationId)) {
      throw new Error(`Tenant integrity violation: ${type} ${record.id} has no valid organisation.`);
    }
  };
  const requireSameOrganisation = (record, related, type, relation) => {
    if (!related || related.organisationId !== record.organisationId) {
      throw new Error(`Tenant integrity violation: ${type} ${record.id} has an invalid ${relation}.`);
    }
  };

  db.users.forEach((record) => requireOrganisation(record, "user"));
  db.collections.forEach((record) => requireOrganisation(record, "collection"));
  db.uploadBatches.forEach((record) => {
    requireOrganisation(record, "upload batch");
    if (record.collectionId) requireSameOrganisation(record, collections.get(record.collectionId), "upload batch", "collection");
  });
  db.cards.forEach((record) => {
    requireOrganisation(record, "card");
    if (record.collectionId) requireSameOrganisation(record, collections.get(record.collectionId), "card", "collection");
    if (record.batchId) requireSameOrganisation(record, batches.get(record.batchId), "card", "upload batch");
  });
  db.contacts.forEach((record) => {
    requireOrganisation(record, "contact");
    if (record.collectionId) requireSameOrganisation(record, collections.get(record.collectionId), "contact", "collection");
    if (record.sourceCardId) requireSameOrganisation(record, cards.get(record.sourceCardId), "contact", "source card");
    if (record.ownerId) requireSameOrganisation(record, users.get(record.ownerId), "contact", "owner");
  });
  db.voiceNotes.forEach((record) => {
    requireOrganisation(record, "voice note");
    if (record.cardId) requireSameOrganisation(record, cards.get(record.cardId), "voice note", "card");
    if (record.contactId) requireSameOrganisation(record, contacts.get(record.contactId), "voice note", "contact");
    if (record.batchId) requireSameOrganisation(record, batches.get(record.batchId), "voice note", "upload batch");
  });
  db.googleConnections.forEach((record) => requireOrganisation(record, "Google connection"));
  db.sheetConfigurations.forEach((record) => {
    requireOrganisation(record, "sheet configuration");
    if (record.connectionId) requireSameOrganisation(record, googleConnections.get(record.connectionId), "sheet configuration", "Google connection");
  });
  db.syncRecords.forEach((record) => {
    const contact = contacts.get(record.contactId);
    const collection = record.collectionId ? collections.get(record.collectionId) : null;
    if (!contact) throw new Error(`Tenant integrity violation: sync record ${record.id} has an invalid contact.`);
    if (record.collectionId && (!collection || collection.organisationId !== contact.organisationId)) {
      throw new Error(`Tenant integrity violation: sync record ${record.id} crosses organisations.`);
    }
  });
  return true;
}

function normalizeDb(db) {
  return {
    users: Array.isArray(db.users) ? db.users : [],
    sessions: Array.isArray(db.sessions) ? db.sessions : [],
    organisations: Array.isArray(db.organisations) ? db.organisations : [],
    collections: Array.isArray(db.collections) ? db.collections : [],
    uploadBatches: Array.isArray(db.uploadBatches) ? db.uploadBatches : [],
    cards: Array.isArray(db.cards) ? db.cards : [],
    contacts: Array.isArray(db.contacts) ? db.contacts : [],
    voiceNotes: Array.isArray(db.voiceNotes) ? db.voiceNotes : [],
    googleConnections: Array.isArray(db.googleConnections) ? db.googleConnections : [],
    sheetConfigurations: Array.isArray(db.sheetConfigurations) ? db.sheetConfigurations : [],
    syncRecords: Array.isArray(db.syncRecords) ? db.syncRecords : [],
    auditLogs: Array.isArray(db.auditLogs) ? db.auditLogs : []
  };
}

async function loadPostgresDb() {
  const [
    organisations,
    users,
    sessions,
    collections,
    uploadBatches,
    cards,
    contacts,
    voiceNotes,
    googleConnections,
    sheetConfigurations,
    syncRecords,
    auditLogs
  ] = await Promise.all([
    pgPool.query("select * from organisations order by created_at"),
    pgPool.query("select * from users order by created_at"),
    pgPool.query("select * from sessions order by created_at"),
    pgPool.query("select * from collections order by created_at"),
    pgPool.query("select * from upload_batches order by created_at desc"),
    pgPool.query("select * from card_files order by created_at desc"),
    pgPool.query("select * from contacts order by created_at desc"),
    pgPool.query("select * from voice_notes order by created_at desc"),
    pgPool.query("select * from google_connections order by created_at desc"),
    pgPool.query("select * from sheet_configurations order by created_at desc"),
    pgPool.query("select * from sync_records order by created_at desc"),
    pgPool.query("select * from audit_logs order by created_at desc limit 500")
  ]);

  return normalizeDb({
    organisations: organisations.rows.map(rowToOrganisation),
    users: users.rows.map(rowToUser),
    sessions: sessions.rows.map(rowToSession),
    collections: collections.rows.map(rowToCollection),
    uploadBatches: uploadBatches.rows.map(rowToBatch),
    cards: cards.rows.map(rowToCard),
    contacts: contacts.rows.map(rowToContact),
    voiceNotes: voiceNotes.rows.map(rowToVoiceNote),
    googleConnections: googleConnections.rows.map(rowToGoogleConnection),
    sheetConfigurations: sheetConfigurations.rows.map(rowToSheetConfiguration),
    syncRecords: syncRecords.rows.map(rowToSyncRecord),
    auditLogs: auditLogs.rows.map(rowToAuditLog)
  });
}

async function persistPostgresDb(db) {
  const client = await pgPool.connect();
  try {
    await client.query("begin");
    await client.query("delete from contact_emails");
    await client.query("delete from contact_phones");
    await client.query("delete from sync_records");
    await client.query("delete from export_jobs");
    await client.query("delete from audit_logs");
    await client.query("delete from voice_notes");
    await client.query("delete from contacts");
    await client.query("delete from card_files");
    await client.query("delete from upload_batches");
    await client.query("delete from sheet_configurations");
    await client.query("delete from google_connections");
    await client.query("delete from collections");
    await client.query("delete from sessions");
    await client.query("delete from users");
    await client.query("delete from organisations");

    for (const organisation of db.organisations) {
      await client.query(
        `insert into organisations (id, name, plan, retention_policy, status, created_at, updated_at, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          organisation.id,
          organisation.name,
          organisation.plan || "starter",
          organisation.retentionPolicy || "90-days",
          organisation.status || "active",
          organisation.createdAt || now(),
          organisation.updatedAt || organisation.createdAt || now(),
          jsonData(organisation)
        ]
      );
    }

    for (const user of db.users) {
      await client.query(
        `insert into users (id, organisation_id, name, email, password_hash, email_verified, status, created_at, updated_at, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          user.id,
          user.organisationId,
          user.name,
          user.email,
          user.passwordHash,
          Boolean(user.emailVerified),
          user.status || "active",
          user.createdAt || now(),
          user.updatedAt || user.createdAt || now(),
          jsonData(user)
        ]
      );
    }

    for (const session of db.sessions) {
      await client.query(
        `insert into sessions (id, user_id, created_at, expires_at, data)
         values ($1,$2,$3,$4,$5::jsonb)`,
        [session.id, session.userId, session.createdAt || now(), session.expiresAt, jsonData(session)]
      );
    }

    for (const collection of db.collections) {
      await client.query(
        `insert into collections (
          id, organisation_id, name, exhibition_name, exhibition_date, destination_type, destination_name,
          spreadsheet_id, worksheet_id, saved_contact_count, next_sheet_row, status, created_at, updated_at, data
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [
          collection.id,
          collection.organisationId,
          collection.name,
          nullable(collection.exhibitionName),
          nullable(collection.exhibitionDate),
          collection.destinationType || "excel",
          nullable(collection.destinationName),
          nullable(collection.spreadsheetId),
          nullable(collection.worksheetId),
          Number(collection.savedContactCount || 0),
          Number(collection.nextSheetRow || 2),
          collection.status || "active",
          collection.createdAt || now(),
          collection.updatedAt || collection.createdAt || now(),
          jsonData(collection)
        ]
      );
    }

    for (const batch of db.uploadBatches) {
      await client.query(
        `insert into upload_batches (
          id, organisation_id, collection_id, uploaded_by, total_files, completed_files, failed_files,
          review_required_count, duplicate_count, status, created_at, data
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          batch.id,
          batch.organisationId,
          nullable(batch.collectionId),
          nullable(batch.uploadedBy),
          Number(batch.totalFiles || 0),
          Number(batch.completedFiles || 0),
          Number(batch.failedFiles || 0),
          Number(batch.reviewRequiredCount || 0),
          Number(batch.duplicateCount || 0),
          batch.status || "processing",
          batch.createdAt || now(),
          jsonData(batch)
        ]
      );
    }

    for (const card of db.cards) {
      await client.query(
        `insert into card_files (
          id, organisation_id, collection_id, batch_id, original_file_name, storage_path, processed_storage_path,
          checksum, file_type, file_size, status, extraction, duplicate_image_of, created_at, updated_at, deleted_at, data
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17::jsonb)`,
        [
          card.id,
          card.organisationId,
          nullable(card.collectionId),
          nullable(card.batchId),
          card.originalFileName,
          card.storagePath,
          nullable(card.processedStoragePath),
          card.checksum,
          card.fileType,
          Number(card.fileSize || 0),
          card.status,
          JSON.stringify(card.extraction || {}),
          nullable(card.duplicateImageOf),
          card.createdAt || now(),
          card.updatedAt || card.createdAt || now(),
          nullable(card.deletedAt),
          jsonData(card)
        ]
      );
    }

    for (const contact of db.contacts) {
      await client.query(
        `insert into contacts (
          id, organisation_id, owner_id, collection_id, source_card_id, name, mobile_number, normalized_mobile_number,
          company_name, designation, department, secondary_mobile_number, office_number, email_address, secondary_email,
          website, linked_in_url, address, city, state, postal_code, country, exhibition_name, exhibition_date,
          interest, special_requirement, budget, follow_up_date, voice_transcript, voice_language, voice_note_created_at,
          notes, tags,
          source, uploaded_by, review_status, duplicate_status, google_sheets_sync_status, sheet_row, last_synced_at,
          extraction_confidence, card_image_reference, created_by, updated_by, created_at, updated_at, deleted_at, data
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
          $25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48::jsonb
        )`,
        [
          contact.id,
          contact.organisationId,
          nullable(contact.ownerId),
          nullable(contact.collectionId),
          nullable(contact.sourceCardId),
          contact.name,
          contact.mobileNumber,
          contact.normalizedMobileNumber || normalizeMobile(contact.mobileNumber),
          nullable(contact.companyName),
          nullable(contact.designation),
          nullable(contact.department),
          nullable(contact.secondaryMobileNumber),
          nullable(contact.officeNumber),
          nullable(contact.emailAddress),
          nullable(contact.secondaryEmail),
          nullable(contact.website),
          nullable(contact.linkedInUrl),
          nullable(contact.address),
          nullable(contact.city),
          nullable(contact.state),
          nullable(contact.postalCode),
          nullable(contact.country),
          nullable(contact.exhibitionName),
          nullable(contact.exhibitionDate),
          nullable(contact.interest),
          nullable(contact.specialRequirement),
          nullable(contact.budget),
          nullable(contact.followUpDate),
          nullable(contact.voiceTranscript),
          nullable(contact.voiceLanguage),
          nullable(contact.voiceNoteCreatedAt),
          nullable(contact.notes),
          nullable(contact.tags),
          contact.source || "Business Card Upload",
          nullable(contact.uploadedBy),
          contact.reviewStatus || "Reviewed",
          contact.duplicateStatus || "none",
          contact.googleSheetsSyncStatus || "not_configured",
          contact.sheetRow ? Number(contact.sheetRow) : null,
          nullable(contact.lastSyncedAt),
          Number(contact.extractionConfidence || 0),
          nullable(contact.cardImageReference),
          nullable(contact.createdBy),
          nullable(contact.updatedBy),
          contact.createdAt || now(),
          contact.updatedAt || contact.createdAt || now(),
          nullable(contact.deletedAt),
          jsonData(contact)
        ]
      );

      await client.query(
        `insert into contact_phones (id, contact_id, phone_number, raw_number, normalized_number, type, is_primary, confidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id("phn"),
          contact.id,
          contact.mobileNumber,
          contact.mobileNumber,
          contact.normalizedMobileNumber || normalizeMobile(contact.mobileNumber),
          "mobile",
          true,
          contact.extractionConfidence || null
        ]
      );

      if (contact.secondaryMobileNumber) {
        await client.query(
          `insert into contact_phones (id, contact_id, phone_number, raw_number, normalized_number, type, is_primary)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [id("phn"), contact.id, contact.secondaryMobileNumber, contact.secondaryMobileNumber, normalizeMobile(contact.secondaryMobileNumber), "secondary_mobile", false]
        );
      }

      if (contact.emailAddress) {
        await client.query(
          `insert into contact_emails (id, contact_id, email, type, is_primary, confidence)
           values ($1,$2,$3,$4,$5,$6)`,
          [id("eml"), contact.id, contact.emailAddress, "primary", true, contact.extractionConfidence || null]
        );
      }

      if (contact.secondaryEmail) {
        await client.query(
          `insert into contact_emails (id, contact_id, email, type, is_primary)
           values ($1,$2,$3,$4,$5)`,
          [id("eml"), contact.id, contact.secondaryEmail, "secondary", false]
        );
      }
    }

    for (const note of db.voiceNotes) {
      await client.query(
        `insert into voice_notes (
          id, organisation_id, created_by, target_type, target_ids, card_id, contact_id, batch_id,
          audio_path, audio_mime_type, audio_size, transcript, language, interest, special_requirement,
          budget, follow_up_date, summary, status, provider, created_at, applied_at, deleted_at, data
        ) values (
          $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb
        )`,
        [
          note.id,
          note.organisationId,
          nullable(note.createdBy),
          note.targetType || "unknown",
          JSON.stringify(Array.isArray(note.targetIds) ? note.targetIds : []),
          nullable(note.cardId),
          nullable(note.contactId),
          nullable(note.batchId),
          nullable(note.audioPath),
          nullable(note.audioMimeType),
          Number(note.audioSize || 0),
          nullable(note.transcript),
          nullable(note.language),
          nullable(note.interest),
          nullable(note.specialRequirement),
          nullable(note.budget),
          nullable(note.followUpDate),
          nullable(note.summary),
          note.status || "draft",
          nullable(note.provider),
          note.createdAt || now(),
          nullable(note.appliedAt),
          nullable(note.deletedAt),
          jsonData(note)
        ]
      );
    }

    for (const connection of db.googleConnections) {
      await client.query(
        `insert into google_connections (
          id, organisation_id, connected_by, google_email, encrypted_token, encrypted_refresh_token,
          token_expiry, scopes, status, created_at, updated_at, data
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          connection.id,
          connection.organisationId,
          nullable(connection.connectedBy),
          nullable(connection.googleEmail),
          nullable(connection.encryptedToken),
          nullable(connection.encryptedRefreshToken),
          nullable(connection.tokenExpiry),
          nullable(connection.scopes),
          connection.status || "active",
          connection.createdAt || now(),
          connection.updatedAt || connection.createdAt || now(),
          jsonData(connection)
        ]
      );
    }

    for (const sheetConfiguration of db.sheetConfigurations) {
      await client.query(
        `insert into sheet_configurations (
          id, connection_id, organisation_id, spreadsheet_id, worksheet_id, field_mapping,
          sync_mode, status, created_at, updated_at, data
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb)`,
        [
          sheetConfiguration.id,
          nullable(sheetConfiguration.connectionId),
          sheetConfiguration.organisationId,
          nullable(sheetConfiguration.spreadsheetId),
          nullable(sheetConfiguration.worksheetId),
          JSON.stringify(sheetConfiguration.fieldMapping || {}),
          sheetConfiguration.syncMode || "manual",
          sheetConfiguration.status || "active",
          sheetConfiguration.createdAt || now(),
          sheetConfiguration.updatedAt || sheetConfiguration.createdAt || now(),
          jsonData(sheetConfiguration)
        ]
      );
    }

    for (const syncRecord of db.syncRecords) {
      await client.query(
        `insert into sync_records (
          id, contact_id, sheet_configuration_id, collection_id, row_reference, sync_status, error,
          retry_attempts, last_synced_at, created_at, updated_at, data
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          syncRecord.id,
          syncRecord.contactId,
          nullable(syncRecord.sheetConfigurationId),
          nullable(syncRecord.collectionId),
          syncRecord.rowReference ? Number(syncRecord.rowReference) : null,
          syncRecord.syncStatus || "pending",
          nullable(syncRecord.error),
          Number(syncRecord.retryAttempts || 0),
          nullable(syncRecord.lastSyncedAt),
          syncRecord.createdAt || now(),
          syncRecord.updatedAt || syncRecord.createdAt || now(),
          jsonData(syncRecord)
        ]
      );
    }

    for (const auditLog of db.auditLogs) {
      await client.query(
        `insert into audit_logs (id, organisation_id, user_id, action, entity_type, entity_id, metadata, created_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          auditLog.id,
          nullable(auditLog.organisationId),
          nullable(auditLog.userId),
          auditLog.action,
          nullable(auditLog.entityType),
          nullable(auditLog.entityId),
          JSON.stringify(auditLog.metadata || {}),
          auditLog.createdAt || now()
        ]
      );
    }

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

function rowToOrganisation(row) {
  return mergeData(row.data, {
    id: row.id,
    name: row.name,
    plan: row.plan,
    retentionPolicy: row.retention_policy,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function rowToUser(row) {
  return mergeData(row.data, {
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerified: row.email_verified,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function rowToSession(row) {
  return mergeData(row.data, {
    id: row.id,
    userId: row.user_id,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at)
  });
}

function rowToCollection(row) {
  return mergeData(row.data, {
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    exhibitionName: row.exhibition_name || "",
    exhibitionDate: dateOnly(row.exhibition_date),
    destinationType: row.destination_type,
    destinationName: row.destination_name || "",
    spreadsheetId: row.spreadsheet_id || "",
    worksheetId: row.worksheet_id || "",
    savedContactCount: row.saved_contact_count,
    nextSheetRow: row.next_sheet_row,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function rowToBatch(row) {
  return mergeData(row.data, {
    id: row.id,
    organisationId: row.organisation_id,
    collectionId: row.collection_id,
    uploadedBy: row.uploaded_by,
    totalFiles: row.total_files,
    completedFiles: row.completed_files,
    failedFiles: row.failed_files,
    reviewRequiredCount: row.review_required_count,
    duplicateCount: row.duplicate_count,
    status: row.status,
    createdAt: iso(row.created_at)
  });
}

function rowToCard(row) {
  return mergeData(row.data, {
    id: row.id,
    organisationId: row.organisation_id,
    collectionId: row.collection_id,
    batchId: row.batch_id,
    originalFileName: row.original_file_name,
    storagePath: row.storage_path,
    storageUrl: `/api/cards/${row.id}/image`,
    backStorageUrl: row.data?.backStoragePath ? `/api/cards/${row.id}/back-image` : "",
    processedStoragePath: row.processed_storage_path,
    checksum: row.checksum,
    fileType: row.file_type,
    fileSize: Number(row.file_size || 0),
    status: row.status,
    extraction: row.extraction || {},
    duplicateImageOf: row.duplicate_image_of,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at)
  });
}

function rowToContact(row) {
  return mergeData(row.data, {
    id: row.id,
    organisationId: row.organisation_id,
    ownerId: row.owner_id,
    collectionId: row.collection_id,
    sourceCardId: row.source_card_id,
    name: row.name,
    mobileNumber: row.mobile_number,
    normalizedMobileNumber: row.normalized_mobile_number,
    companyName: row.company_name || "",
    designation: row.designation || "",
    department: row.department || "",
    secondaryMobileNumber: row.secondary_mobile_number || "",
    officeNumber: row.office_number || "",
    emailAddress: row.email_address || "",
    secondaryEmail: row.secondary_email || "",
    website: row.website || "",
    linkedInUrl: row.linked_in_url || "",
    address: row.address || "",
    city: row.city || "",
    state: row.state || "",
    postalCode: row.postal_code || "",
    country: row.country || "",
    exhibitionName: row.exhibition_name || "",
    exhibitionDate: dateOnly(row.exhibition_date),
    interest: row.interest || "",
    specialRequirement: row.special_requirement || "",
    budget: row.budget || "",
    followUpDate: row.follow_up_date || "",
    voiceTranscript: row.voice_transcript || "",
    voiceLanguage: row.voice_language || "",
    voiceNoteCreatedAt: iso(row.voice_note_created_at),
    notes: row.notes || "",
    tags: row.tags || "",
    source: row.source,
    uploadedBy: row.uploaded_by,
    reviewStatus: row.review_status,
    duplicateStatus: row.duplicate_status,
    googleSheetsSyncStatus: row.google_sheets_sync_status,
    sheetRow: row.sheet_row,
    lastSyncedAt: iso(row.last_synced_at),
    extractionConfidence: row.extraction_confidence,
    cardImageReference: row.card_image_reference,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at)
  });
}

function rowToVoiceNote(row) {
  return mergeData(row.data, {
    id: row.id,
    organisationId: row.organisation_id,
    createdBy: row.created_by,
    targetType: row.target_type,
    targetIds: Array.isArray(row.target_ids) ? row.target_ids : [],
    cardId: row.card_id,
    contactId: row.contact_id,
    batchId: row.batch_id,
    audioPath: row.audio_path || "",
    audioMimeType: row.audio_mime_type || "",
    audioSize: Number(row.audio_size || 0),
    transcript: row.transcript || "",
    language: row.language || "",
    interest: row.interest || "",
    specialRequirement: row.special_requirement || "",
    budget: row.budget || "",
    followUpDate: row.follow_up_date || "",
    summary: row.summary || "",
    status: row.status,
    provider: row.provider || "",
    createdAt: iso(row.created_at),
    appliedAt: iso(row.applied_at),
    deletedAt: iso(row.deleted_at)
  });
}

function rowToSyncRecord(row) {
  return mergeData(row.data, {
    id: row.id,
    contactId: row.contact_id,
    sheetConfigurationId: row.sheet_configuration_id,
    collectionId: row.collection_id,
    rowReference: row.row_reference,
    syncStatus: row.sync_status,
    error: row.error,
    retryAttempts: row.retry_attempts,
    lastSyncedAt: iso(row.last_synced_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function rowToGoogleConnection(row) {
  return mergeData(row.data, {
    id: row.id,
    organisationId: row.organisation_id,
    connectedBy: row.connected_by,
    googleEmail: row.google_email || "",
    encryptedToken: row.encrypted_token || "",
    encryptedRefreshToken: row.encrypted_refresh_token || "",
    tokenExpiry: iso(row.token_expiry),
    scopes: row.scopes || "",
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function rowToSheetConfiguration(row) {
  return mergeData(row.data, {
    id: row.id,
    connectionId: row.connection_id,
    organisationId: row.organisation_id,
    spreadsheetId: row.spreadsheet_id || "",
    worksheetId: row.worksheet_id || "",
    fieldMapping: row.field_mapping || {},
    syncMode: row.sync_mode,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function rowToAuditLog(row) {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    userId: row.user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata || {},
    createdAt: iso(row.created_at)
  };
}

function mergeData(data, fields) {
  return { ...(data || {}), ...fields };
}

function jsonData(record) {
  return JSON.stringify(record || {});
}

function teamMembers(organisation) {
  return Array.isArray(organisation && organisation.teamMembers) ? organisation.teamMembers : [];
}

function nullable(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function dateOnly(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

function now() {
  return new Date().toISOString();
}

function forwardedProto(req) {
  return TRUST_PROXY ? req.headers["x-forwarded-proto"] : "";
}

function baseUrl(req) {
  if (APP_BASE_URL) return APP_BASE_URL.replace(/\/$/, "");
  const proto = forwardedProto(req) || (req.socket.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}

function isSecureRequest(req) {
  return req.socket.encrypted || forwardedProto(req) === "https" || process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";
}

function sessionCookie(req, value, maxAgeSeconds) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `session=${encodeURIComponent(value)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function tempCookie(req, name, value, maxAgeSeconds) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function securityHeaders(req) {
  const headers = {
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com https://api.razorpay.com; img-src 'self' data: blob: https://*.razorpay.com; media-src 'self' blob:; script-src 'self' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.razorpay.com https://lumberjack.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY"
  };
  if (isSecureRequest(req)) {
    headers["Strict-Transport-Security"] = "max-age=15552000; includeSubDomains";
  }
  return headers;
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) {
    return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  }
  return String(req.socket.remoteAddress || "local").trim();
}

function rateLimit(req, res, key, limit, windowMs) {
  const bucketKey = `${key}:${clientIp(req)}`;
  const current = Date.now();
  const bucket = rateLimitBuckets.get(bucketKey) || { count: 0, resetAt: current + windowMs };
  if (current > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = current + windowMs;
  }
  bucket.count += 1;
  rateLimitBuckets.set(bucketKey, bucket);
  if (bucket.count > limit) {
    error(res, 429, "Too many requests. Please wait a little and try again.");
    return false;
  }
  return true;
}

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
}

function normalizeMobile(value) {
  return String(value || "").replace(/[^\d+]/g, "").replace(/^00/, "+");
}

function splitPhoneValues(value) {
  return String(value || "")
    .split(/\s*(?:\/|\||;|,|\bor\b|\r?\n)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizePhoneFields(fields = {}) {
  const normalized = { ...fields };
  const primaryValues = splitPhoneValues(fields.mobileNumber);
  const secondaryValues = splitPhoneValues(fields.secondaryMobileNumber);
  normalized.mobileNumber = primaryValues.length ? normalizeMobile(primaryValues.shift()) : "";
  normalized.secondaryMobileNumber = [...primaryValues, ...secondaryValues]
    .map(normalizeMobile)
    .filter(Boolean)
    .join(" / ");
  normalized.officeNumber = splitPhoneValues(fields.officeNumber)
    .map(normalizeMobile)
    .filter(Boolean)
    .join(" / ");
  return normalized;
}

function isValidMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function safeSpreadsheetValue(value) {
  const text = value == null ? "" : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function audit(db, user, action, entityType, entityId, metadata = {}) {
  db.auditLogs.unshift({
    id: id("aud"),
    organisationId: user?.organisationId || null,
    userId: user?.id || null,
    action,
    entityType,
    entityId,
    metadata,
    createdAt: now()
  });
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const [key, ...rest] = part.trim().split("=");
    return [key, decodeURIComponent(rest.join("="))];
  }));
}

function signSession(sessionId) {
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(sessionId).digest("hex");
  return `${sessionId}.${sig}`;
}

function verifySessionCookie(value) {
  if (!value || !value.includes(".")) return null;
  const [sessionId, sig] = value.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(sessionId).digest("hex");
  if (!sig || sig.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? sessionId : null;
}

function currentUser(req, db) {
  const sessionId = verifySessionCookie(parseCookies(req).session);
  if (!sessionId) return null;
  const session = db.sessions.find((s) => s.id === sessionId && new Date(s.expiresAt) > new Date());
  if (!session) return null;
  return db.users.find((u) => u.id === session.userId && u.status === "active") || null;
}

function currentSession(req, db) {
  const sessionId = verifySessionCookie(parseCookies(req).session);
  if (!sessionId) return null;
  return db.sessions.find((s) => s.id === sessionId && new Date(s.expiresAt) > new Date()) || null;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, {
    "Content-Length": payload.length,
    "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(payload);
}

function error(res, status, message, details = {}) {
  send(res, status, { error: message, ...details });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 120 * 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
  });
}

function requireUser(req, res, db) {
  const user = currentUser(req, db);
  if (!user) {
    error(res, 401, "Your session has expired. Please log in again to continue.");
    return null;
  }
  return user;
}

function encryptionKey() {
  return crypto.createHash("sha256").update(ENCRYPTION_SECRET).digest();
}

function encryptSecret(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptSecret(value) {
  if (!value) return "";
  const [ivRaw, tagRaw, encryptedRaw] = String(value).split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64")), decipher.final()]).toString("utf8");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = String(stored || "").split(":");
  if (!salt || !digest) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(digest));
}

// Fixed valid hash used to burn equivalent scrypt time when an account is missing
// or has no password (e.g. Google-only), so login timing does not reveal whether an
// email exists.
const DUMMY_PASSWORD_HASH = hashPassword("timing-equalizer-placeholder");

function validatePasswordStrength(password) {
  const value = String(password || "");
  if (value.length < 10) return "Password must be at least 10 characters.";
  if (!/[a-z]/.test(value)) return "Password must include a lowercase letter.";
  if (!/[A-Z]/.test(value)) return "Password must include an uppercase letter.";
  if (!/\d/.test(value)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(value)) return "Password must include a symbol.";
  return "";
}

function ensureSessionCsrf(session) {
  if (!session.csrfToken) session.csrfToken = randomToken("csrf");
  return session.csrfToken;
}

function validateCsrf(req, res, session) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const provided = req.headers["x-csrf-token"] || url.searchParams.get("csrf");
  const expected = ensureSessionCsrf(session);
  if (!provided || provided !== expected) {
    error(res, 403, "Security check failed. Please refresh the page and try again.");
    return false;
  }
  return true;
}

function buildLink(req, pathWithQuery) {
  return `${baseUrl(req)}${pathWithQuery}`;
}

function emailDeliveryEnabled() {
  return Boolean(process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY);
}

async function deliverAccountEmail(type, email, link) {
  const subject = type === "verify-email" ? "Verify your Card2Leads account" : "Reset your Card2Leads password";
  const html = `
    <p>${type === "verify-email" ? "Please verify your Card2Leads account." : "Use this link to reset your Card2Leads password."}</p>
    <p><a href="${link}">${link}</a></p>
    <p>If you did not request this, you can ignore this email.</p>
  `;
  if (process.env.RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: email, subject, html })
    });
    if (!response.ok) throw new Error(`Email delivery failed (${response.status}).`);
    return;
  }
  if (process.env.SENDGRID_API_KEY) {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: EMAIL_FROM },
        subject,
        content: [{ type: "text/html", value: html }]
      })
    });
    if (!response.ok) throw new Error(`Email delivery failed (${response.status}).`);
    return;
  }
  console.log(`[${type}] ${EMAIL_FROM} -> ${email}: ${link}`);
}

function findCollectionForUser(db, user, requestedId) {
  let collection = requestedId && db.collections.find((c) => c.id === requestedId && c.organisationId === user.organisationId && c.status !== "deleted");
  if (!collection) {
    collection = db.collections
      .filter((c) => c.organisationId === user.organisationId && c.status === "active")
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0];
  }
  return collection || null;
}

function collectionForUser(db, user, requestedId) {
  let collection = findCollectionForUser(db, user, requestedId);
  if (!collection) {
    collection = {
      id: id("col"),
      organisationId: user.organisationId,
      name: "Current Sheet",
      exhibitionName: "",
      exhibitionDate: "",
      destinationType: "excel",
      destinationName: "Downloadable Excel/CSV",
      savedContactCount: 0,
      nextSheetRow: 2,
      status: "active",
      createdAt: now(),
      updatedAt: now()
    };
    db.collections.push(collection);
    audit(db, user, "collection.created", "collection", collection.id);
  }
  return collection;
}

function planUsage(organisation) {
  const plan = String(organisation?.plan || "trial").toLowerCase();
  const limit = Number(organisation?.scanLimit || PLAN_LIMITS[plan] || PLAN_LIMITS.trial);
  const used = Math.max(0, Number(organisation?.scansUsed || 0));
  return { plan, limit, used, remaining: Math.max(0, limit - used) };
}

function billingConfigured() {
  return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

function billingSummary(organisation) {
  return {
    configured: billingConfigured(),
    plan: String(organisation?.plan || "trial"),
    status: organisation?.subscriptionStatus || (String(organisation?.plan || "trial") === "trial" ? "trial" : ""),
    currentPeriodEnd: organisation?.currentPeriodEnd || "",
    availablePlans: Object.keys(RAZORPAY_PLAN_IDS).filter((plan) => RAZORPAY_PLAN_IDS[plan]),
    topupScans: TOPUP_SCANS,
    topupAmount: TOPUP_AMOUNT_PAISE / 100
  };
}

async function razorpayApi(path, { method = "GET", body } = {}) {
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = data.error || {};
    // Log the full Razorpay error server-side so we can see exactly what failed.
    console.error(`[razorpay] ${method} ${path} -> ${res.status}: ${JSON.stringify(data.error || data)}`);
    const detail = [e.description, e.field ? `(field: ${e.field})` : ""].filter(Boolean).join(" ");
    throw new Error(detail || `Payment provider error (${res.status}).`);
  }
  return data;
}

function razorpaySignatureValid(payload, signature, secret = RAZORPAY_KEY_SECRET) {
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature || "")));
  } catch {
    return false;
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function planFromRazorpayPlanId(planId) {
  return Object.keys(RAZORPAY_PLAN_IDS).find((plan) => RAZORPAY_PLAN_IDS[plan] === planId) || "";
}

// Apply a subscription's plan/allowance. Called only from verified webhook state.
// scansUsed resets to 0 only when `resetUsage` is set (a new billing period), so
// duplicate/retried webhooks for the same period never wipe a user's usage.
function applySubscriptionPlan(organisation, plan, { subscriptionId, currentPeriodEnd, status, resetUsage } = {}) {
  if (!organisation) return;
  organisation.plan = plan;
  organisation.subscriptionPlan = plan;
  organisation.scanLimit = Number(PLAN_LIMITS[plan] || PLAN_LIMITS.trial);
  if (resetUsage) organisation.scansUsed = 0;
  if (subscriptionId) organisation.subscriptionId = subscriptionId;
  organisation.subscriptionStatus = status || "active";
  if (currentPeriodEnd) organisation.currentPeriodEnd = currentPeriodEnd;
  delete organisation.pendingSubscriptionId;
  organisation.updatedAt = now();
}

function grantTopupEntitlement(organisation, scans = TOPUP_SCANS) {
  if (!organisation) return;
  const base = Number(organisation.scanLimit || PLAN_LIMITS[organisation.plan] || PLAN_LIMITS.trial);
  organisation.scanLimit = base + Number(scans);
  organisation.updatedAt = now();
}

function organisationNeedsOnboarding(db, user) {
  const organisation = db.organisations.find((o) => o.id === user.organisationId);
  return organisation ? organisation.setupComplete === false : false;
}

function retentionDays(policy) {
  const match = String(policy || "90-days").match(/^(\d+)-days$/);
  return match ? Number(match[1]) : 90;
}

function applyCardImageRetention(db) {
  let changed = false;
  const orgs = new Map(db.organisations.map((org) => [org.id, org]));
  for (const card of db.cards) {
    if (card.storagePurgedAt || (!card.storagePath && !card.backStoragePath)) continue;
    const org = orgs.get(card.organisationId);
    const days = retentionDays(org?.retentionPolicy);
    const createdAt = new Date(card.createdAt || 0).getTime();
    const expired = createdAt && Date.now() - createdAt > days * 24 * 60 * 60 * 1000;
    if (expired || card.deletedAt) {
      try {
        if (fs.existsSync(card.storagePath)) fs.unlinkSync(card.storagePath);
        if (card.backStoragePath && fs.existsSync(card.backStoragePath)) fs.unlinkSync(card.backStoragePath);
      } catch (err) {
        console.error("Unable to purge retained card image:", err.message);
      }
      card.storagePurgedAt = now();
      card.storageUrl = "";
      changed = true;
    }
  }
  return changed;
}

function repairCollectionExhibitionAssignments(db) {
  let changed = false;
  const canonicalExhibitions = new Map();
  for (const collection of db.collections) {
    const name = String(collection.name || "").trim();
    const exhibitionName = String(collection.exhibitionName || "").trim();
    if (name && exhibitionName && name.toLowerCase() === exhibitionName.toLowerCase()) {
      canonicalExhibitions.set(`${collection.organisationId}:${name.toLowerCase()}`, {
        exhibitionName,
        exhibitionDate: collection.exhibitionDate || ""
      });
    }
  }
  for (const collection of db.collections) {
    const name = String(collection.name || "").trim();
    const canonical = canonicalExhibitions.get(`${collection.organisationId}:${name.toLowerCase()}`);
    if (!canonical || collection.exhibitionName === canonical.exhibitionName) continue;
    collection.exhibitionName = canonical.exhibitionName;
    collection.exhibitionDate = canonical.exhibitionDate || collection.exhibitionDate || "";
    collection.updatedAt = now();
    changed = true;
  }
  const collections = new Map(db.collections.map((collection) => [collection.id, collection]));
  for (const contact of db.contacts) {
    const collection = collections.get(contact.collectionId);
    if (!collection?.exhibitionName || contact.exhibitionName === collection.exhibitionName) continue;
    contact.exhibitionName = collection.exhibitionName;
    contact.exhibitionDate = collection.exhibitionDate || contact.exhibitionDate || "";
    contact.updatedAt = now();
    changed = true;
  }
  for (const card of db.cards) {
    const collection = collections.get(card.collectionId);
    if (!collection?.exhibitionName || !card.extraction || card.extraction.exhibitionName === collection.exhibitionName) continue;
    card.extraction.exhibitionName = collection.exhibitionName;
    card.extraction.exhibitionDate = collection.exhibitionDate || card.extraction.exhibitionDate || "";
    card.updatedAt = now();
    changed = true;
  }
  return changed;
}

// One-time (idempotent) cleanup for records saved before city/state normalization
// existed: merges casing variants like "SURAT" and "Surat" into one value, and
// backfills a missing state from a recognized city.
function normalizeContactLocations(db) {
  let changed = false;
  for (const contact of db.contacts) {
    const cleanCity = toTitleCase(contact.city);
    const cleanState = toTitleCase(contact.state) || (cleanCity ? inferStateFromCity(cleanCity) : "");
    if (cleanCity !== (contact.city || "") || cleanState !== (contact.state || "")) {
      contact.city = cleanCity;
      contact.state = cleanState;
      contact.updatedAt = now();
      changed = true;
    }
  }
  for (const card of db.cards) {
    if (!card.extraction) continue;
    const cleanCity = toTitleCase(card.extraction.city);
    const cleanState = toTitleCase(card.extraction.state) || (cleanCity ? inferStateFromCity(cleanCity) : "");
    if (cleanCity !== (card.extraction.city || "") || cleanState !== (card.extraction.state || "")) {
      card.extraction.city = cleanCity;
      card.extraction.state = cleanState;
      card.updatedAt = now();
      changed = true;
    }
  }
  return changed;
}

function makeManualReviewExtraction(fileName, collection, reason = "") {
  return {
    name: "",
    mobileNumber: "",
    companyName: "",
    designation: "",
    department: "",
    secondaryName: "",
    secondaryMobileNumber: "",
    tertiaryName: "",
    tertiaryMobileNumber: "",
    officeNumber: "",
    emailAddress: "",
    secondaryEmail: "",
    website: "",
    linkedInUrl: "",
    address: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
    exhibitionName: collection.exhibitionName || "",
    exhibitionDate: collection.exhibitionDate || "",
    interest: "",
    specialRequirement: "",
    budget: "",
    followUpDate: "",
    voiceTranscript: "",
    voiceLanguage: "",
    voiceNoteCreatedAt: "",
    notes: "",
    tags: "",
    rawVisibleText: "",
    confidence: 0,
    fieldConfidence: Object.fromEntries(["name", "mobileNumber", ...OPTIONAL_FIELDS].map((field) => [field, 0])),
    warnings: [
      reason || "AI extraction is not configured or did not complete. Please enter Name and Mobile Number manually before saving.",
      `Original file: ${fileName}`
    ]
  };
}

async function extractBusinessCard(file, collection) {
  const failures = [];
  const order = EXTRACTION_PROVIDER === "openai" ? ["openai", "gemini"] : ["gemini", "openai"];
  for (const provider of order) {
    if (provider === "gemini" && process.env.GEMINI_API_KEY && Date.now() >= geminiUnavailableUntil) {
      try {
        const result = await maybeVerifyExtraction(
          file,
          collection,
          await extractBusinessCardWithGemini(file, collection)
        );
        console.info(`[extraction] provider=gemini model=${GEMINI_MODEL} status=success`);
        return result;
      } catch (err) {
        failures.push(err.message);
        if (/\((400|404)\)|NOT_FOUND|no longer available/i.test(err.message)) geminiUnavailableUntil = Date.now() + 30 * 60 * 1000;
        console.error("Gemini extraction failed, trying fallback:", err.message);
      }
    }
    if (provider === "openai" && process.env.OPENAI_API_KEY) {
      try {
        const result = await maybeVerifyExtraction(
          file,
          collection,
          await extractBusinessCardWithOpenAI(file, collection)
        );
        console.info(`[extraction] provider=openai model=${OPENAI_MODEL} status=success`);
        return result;
      } catch (err) {
        failures.push(err.message);
        console.error("OpenAI extraction failed, trying fallback:", err.message);
      }
    }
  }
  const reason = failures.length
    ? `AI extraction failed after trying configured provider(s). ${failures.join(" ")}`
    : "AI extraction is not configured. Add GEMINI_API_KEY or OPENAI_API_KEY to .env and restart the server.";
  return makeManualReviewExtraction(file.name, collection, reason);
}

async function extractBusinessCardWithOpenAI(file, collection) {
  const imageContent = [
    {
      type: "image_url",
      image_url: { url: file.dataUrl }
    }
  ];
  if (file.backDataUrl) {
    imageContent.push({
      type: "image_url",
      image_url: { url: file.backDataUrl }
    });
  }
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: extractionSystemPrompt()
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${extractionUserPrompt()}${file.backDataUrl ? "\n\nThe first image is the front and the second image is the back of the same card. Merge both sides into one contact." : ""}`
              },
              ...imageContent
            ]
          }
        ]
      })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI extraction failed (${response.status}): ${details.slice(0, 240)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  return normalizeExtraction(JSON.parse(content), collection);
}

async function extractBusinessCardWithGemini(file, collection) {
  const base64 = String(file.dataUrl || "").split(",")[1] || "";
  if (!base64) throw new Error("Image payload was empty.");
  const backBase64 = String(file.backDataUrl || "").split(",")[1] || "";
  const imageParts = [
    {
      inline_data: {
        mime_type: file.type || "image/jpeg",
        data: base64
      }
    }
  ];
  if (backBase64) {
    imageParts.push({
      inline_data: {
        mime_type: file.backType || "image/jpeg",
        data: backBase64
      }
    });
  }
  const model = encodeURIComponent(GEMINI_MODEL);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: `${extractionSystemPrompt()}\n\n${extractionUserPrompt()}${backBase64 ? "\n\nThe first image is the front and the second image is the back of the same card. Merge both sides into one contact." : ""}` },
            ...imageParts
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json"
      }
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gemini extraction failed (${response.status}): ${details.slice(0, 240)}`);
  }
  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim() || "{}";
  return normalizeExtraction(parseJsonContent(content), collection);
}

async function maybeVerifyExtraction(file, collection, extraction) {
  const mode = String(process.env.EXTRACTION_VERIFICATION_MODE || "").toLowerCase();
  if (!["paid", "high", "high_accuracy", "second_pass"].includes(mode)) return extraction;
  if (!process.env.OPENAI_API_KEY) {
    extraction.warnings.push("Second-pass verification is enabled but OPENAI_API_KEY is not configured.");
    return extraction;
  }
  try {
    return await verifyExtractionWithOpenAI(file, collection, extraction);
  } catch (err) {
    extraction.warnings.push(`Second-pass verification could not complete: ${err.message}`);
    return extraction;
  }
}

async function verifyExtractionWithOpenAI(file, collection, extraction) {
  const verificationImages = [{ type: "image_url", image_url: { url: file.dataUrl } }];
  if (file.backDataUrl) verificationImages.push({ type: "image_url", image_url: { url: file.backDataUrl } });
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VERIFICATION_MODEL || OPENAI_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `${extractionSystemPrompt()} You are performing a second-pass quality check. Correct only fields that are clearly visible in the image. Lower field confidence when text is unclear.`
        },
        {
          role: "user",
          content: [
            { type: "text", text: `${extractionUserPrompt()}\n\nFirst-pass extraction:\n${JSON.stringify(extraction)}` },
            ...verificationImages
          ]
        }
      ]
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI verification failed (${response.status}): ${details.slice(0, 180)}`);
  }
  const data = await response.json();
  const verified = normalizeExtraction(JSON.parse(data.choices?.[0]?.message?.content || "{}"), collection);
  verified.verifiedBySecondPass = true;
  return verified;
}

function extractionSystemPrompt() {
  return [
    "You extract contact data from business card images.",
    "Return only valid JSON.",
    "Extract only information visible on the card or strongly supported by visible text.",
    "Do not invent missing emails, surnames, country codes, company names, postal codes, or social links.",
    "Never return sample, placeholder, or example contact data.",
    "If the image is blank, unreadable, too small, a screenshot of an app, or not clearly a business card, leave contact fields blank and add a warning.",
    "If a field is unclear or missing, return an empty string and add a warning.",
    "The business card can be horizontal, vertical, upside down, or rotated; read it in the correct orientation before extracting. Do this silently — never add a warning stating that the card was rotated, upside down, or reoriented.",
    "Name and mobileNumber are critical fields."
  ].join(" ");
}

function extractionUserPrompt() {
  return `Extract this business card into this JSON shape:
{
  "name": "",
  "mobileNumber": "",
  "secondaryName": "",
  "secondaryMobileNumber": "",
  "tertiaryName": "",
  "tertiaryMobileNumber": "",
  "companyName": "",
  "designation": "",
  "officeNumber": "",
  "emailAddress": "",
  "secondaryEmail": "",
  "website": "",
  "address": "",
  "city": "",
  "state": "",
  "postalCode": "",
  "country": "",
  "notes": "",
  "tags": "",
  "rawVisibleText": "",
  "confidence": 0,
  "fieldConfidence": {
    "name": 0,
    "mobileNumber": 0,
    "secondaryName": 0,
    "secondaryMobileNumber": 0,
    "tertiaryName": 0,
    "tertiaryMobileNumber": 0,
    "companyName": 0,
    "designation": 0,
    "officeNumber": 0,
    "emailAddress": 0,
    "secondaryEmail": 0,
    "website": 0,
    "address": 0,
    "city": 0,
    "state": 0,
    "postalCode": 0,
    "country": 0,
    "exhibitionName": 0,
    "exhibitionDate": 0,
    "notes": 0,
    "tags": 0
  },
  "warnings": []
}

Rules:
- Use the person's full visible name for name.
- Use the primary mobile/cell number for mobileNumber.
- When two mobile numbers are separated by a slash or similar divider, put the first in mobileNumber and the second in secondaryMobileNumber. Never combine two mobile numbers in mobileNumber.
- If the card lists more than one person (for example two names, each with their own number), put the most prominent person in name/mobileNumber, the next person in secondaryName/secondaryMobileNumber, and a third person in tertiaryName/tertiaryMobileNumber. Only name is mandatory — leave secondaryName, tertiaryName and their numbers blank when there is only one person. Do not add a warning about multiple people when you have captured them in these fields.
- Keep phone numbers exactly as visible when uncertain.
- Put landline/office numbers in officeNumber.
- If an office number contains a slash-separated alternate number or extension, preserve both in officeNumber separated by " / ".
- confidence must be an integer from 0 to 100.
- fieldConfidence must contain an integer 0 to 100 for every extracted field.
- Use fieldConfidence below 70 when the text is partially cut, blurred, rotated, handwritten, or inferred from context.
- Never add a warning about the card's rotation or orientation.
- If the image does not appear to be a business card, leave contact fields blank and add a warning.
- If you cannot read actual visible card text, leave contact fields blank.
- One image should contain one business card. If multiple cards are visible, extract the most prominent card and add a warning.
- Never return fictional/example people such as generic software engineers or sample companies.
- Do not use the filename as evidence.`;
}

function parseJsonContent(content) {
  const trimmed = String(content || "{}").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(trimmed || "{}");
}

function normalizeExtraction(raw, collection) {
  const extraction = {
    name: cleanText(raw.name),
    mobileNumber: cleanText(raw.mobileNumber),
    companyName: cleanText(raw.companyName),
    designation: cleanText(raw.designation),
    department: cleanText(raw.department),
    secondaryName: cleanText(raw.secondaryName),
    secondaryMobileNumber: cleanText(raw.secondaryMobileNumber),
    tertiaryName: cleanText(raw.tertiaryName),
    tertiaryMobileNumber: cleanText(raw.tertiaryMobileNumber),
    officeNumber: cleanText(raw.officeNumber),
    emailAddress: cleanText(raw.emailAddress),
    secondaryEmail: cleanText(raw.secondaryEmail),
    website: cleanText(raw.website),
    linkedInUrl: cleanText(raw.linkedInUrl),
    address: cleanText(raw.address),
    city: toTitleCase(raw.city),
    state: toTitleCase(raw.state),
    postalCode: cleanText(raw.postalCode),
    country: cleanText(raw.country),
    exhibitionName: collection.exhibitionName || "",
    exhibitionDate: collection.exhibitionDate || "",
    interest: cleanText(raw.interest),
    specialRequirement: cleanText(raw.specialRequirement),
    budget: cleanText(raw.budget),
    followUpDate: cleanText(raw.followUpDate),
    voiceTranscript: cleanText(raw.voiceTranscript),
    voiceLanguage: cleanText(raw.voiceLanguage),
    voiceNoteCreatedAt: cleanText(raw.voiceNoteCreatedAt),
    notes: cleanText(raw.notes),
    tags: cleanText(raw.tags),
    rawVisibleText: cleanText(raw.rawVisibleText),
    confidence: 0,
    fieldConfidence: normalizeFieldConfidence(raw.fieldConfidence, raw.confidence),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.map(cleanText).filter(Boolean).filter((w) => !/rotat|upside.?down|reorient/i.test(w))
      : []
  };

  const normalizedPhones = normalizePhoneFields(extraction);
  extraction.mobileNumber = normalizedPhones.mobileNumber;
  extraction.secondaryMobileNumber = normalizedPhones.secondaryMobileNumber;
  extraction.officeNumber = normalizedPhones.officeNumber;
  if (extraction.secondaryMobileNumber && Number(extraction.fieldConfidence.secondaryMobileNumber || 0) === 0) {
    extraction.fieldConfidence.secondaryMobileNumber = extraction.fieldConfidence.mobileNumber || 0;
  }

  if (extraction.city && !extraction.state) {
    const inferredState = inferStateFromCity(extraction.city);
    if (inferredState) {
      extraction.state = inferredState;
      extraction.fieldConfidence.state = extraction.fieldConfidence.city || 60;
    }
  }

  if (!extraction.name) extraction.warnings.push("Name was not confidently extracted. Please enter it before saving.");
  if (!extraction.mobileNumber) extraction.warnings.push("Mobile Number was not confidently extracted. Please enter it before saving.");
  if (extraction.mobileNumber && !isValidMobile(extraction.mobileNumber)) {
    extraction.warnings.push("Extracted mobile number may be invalid. Please verify before saving.");
  }
  extraction.confidence = deriveOverallConfidence(extraction, raw.confidence);
  extraction.fieldConfidence = normalizeFieldConfidence(extraction.fieldConfidence, extraction.confidence);

  return extraction;
}

function deriveOverallConfidence(extraction, providerConfidence = 0) {
  const coreValues = [extraction.name, extraction.mobileNumber];
  const visibleContactValues = [
    extraction.name,
    extraction.mobileNumber,
    extraction.companyName,
    extraction.emailAddress,
    extraction.website,
    extraction.address,
    extraction.rawVisibleText
  ].filter(Boolean);
  if (!visibleContactValues.length) return 0;

  const scoredFields = Object.entries(extraction.fieldConfidence || {})
    .filter(([field]) => !["exhibitionName", "exhibitionDate"].includes(field))
    .filter(([field]) => Boolean(extraction[field]))
    .map(([, value]) => Math.max(0, Math.min(100, Number(value) || 0)));
  const provider = Math.max(0, Math.min(100, Number.parseInt(providerConfidence, 10) || 0));
  const average = scoredFields.length
    ? Math.round(scoredFields.reduce((sum, value) => sum + value, 0) / scoredFields.length)
    : provider;
  if (!coreValues[0] && !coreValues[1]) return Math.min(average || provider, 35);
  if (!coreValues[0] || !coreValues[1]) return Math.min(average || provider || 50, 65);
  return average || provider || 60;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toTitleCase(value) {
  const trimmed = cleanText(value);
  if (!trimmed) return trimmed;
  return trimmed
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join("");
}

// Common Indian cities mapped to their state, used to fill in a missing state
// when only the city was legible on the card. Not exhaustive — covers major
// metros and trade-show hubs; anything not listed is left for manual entry.
const INDIA_CITY_STATE_MAP = {
  mumbai: "Maharashtra", bombay: "Maharashtra", pune: "Maharashtra", poona: "Maharashtra",
  nagpur: "Maharashtra", nashik: "Maharashtra", thane: "Maharashtra", aurangabad: "Maharashtra",
  navimumbai: "Maharashtra", kolhapur: "Maharashtra", solapur: "Maharashtra",
  surat: "Gujarat", ahmedabad: "Gujarat", vadodara: "Gujarat", baroda: "Gujarat",
  rajkot: "Gujarat", bhavnagar: "Gujarat", jamnagar: "Gujarat", gandhinagar: "Gujarat", anand: "Gujarat",
  delhi: "Delhi", newdelhi: "Delhi",
  gurgaon: "Haryana", gurugram: "Haryana", faridabad: "Haryana", panipat: "Haryana",
  noida: "Uttar Pradesh", ghaziabad: "Uttar Pradesh", lucknow: "Uttar Pradesh", kanpur: "Uttar Pradesh",
  agra: "Uttar Pradesh", varanasi: "Uttar Pradesh", meerut: "Uttar Pradesh", allahabad: "Uttar Pradesh",
  prayagraj: "Uttar Pradesh", moradabad: "Uttar Pradesh",
  jaipur: "Rajasthan", jodhpur: "Rajasthan", udaipur: "Rajasthan", kota: "Rajasthan",
  ajmer: "Rajasthan", bikaner: "Rajasthan",
  kolkata: "West Bengal", calcutta: "West Bengal", howrah: "West Bengal", siliguri: "West Bengal",
  chennai: "Tamil Nadu", madras: "Tamil Nadu", coimbatore: "Tamil Nadu", madurai: "Tamil Nadu",
  tiruppur: "Tamil Nadu", salem: "Tamil Nadu", trichy: "Tamil Nadu", tiruchirappalli: "Tamil Nadu",
  bengaluru: "Karnataka", bangalore: "Karnataka", mysuru: "Karnataka", mysore: "Karnataka",
  hubli: "Karnataka", mangaluru: "Karnataka", mangalore: "Karnataka", belgaum: "Karnataka",
  hyderabad: "Telangana", secunderabad: "Telangana", warangal: "Telangana",
  vijayawada: "Andhra Pradesh", visakhapatnam: "Andhra Pradesh", vizag: "Andhra Pradesh", guntur: "Andhra Pradesh",
  kochi: "Kerala", cochin: "Kerala", thiruvananthapuram: "Kerala", trivandrum: "Kerala",
  kozhikode: "Kerala", calicut: "Kerala", thrissur: "Kerala",
  indore: "Madhya Pradesh", bhopal: "Madhya Pradesh", jabalpur: "Madhya Pradesh", gwalior: "Madhya Pradesh", ujjain: "Madhya Pradesh",
  patna: "Bihar", gaya: "Bihar", muzaffarpur: "Bihar",
  raipur: "Chhattisgarh", bhilai: "Chhattisgarh",
  bhubaneswar: "Odisha", cuttack: "Odisha",
  guwahati: "Assam",
  chandigarh: "Chandigarh",
  ludhiana: "Punjab", amritsar: "Punjab", jalandhar: "Punjab", patiala: "Punjab",
  dehradun: "Uttarakhand", haridwar: "Uttarakhand",
  ranchi: "Jharkhand", jamshedpur: "Jharkhand",
  shimla: "Himachal Pradesh",
  panaji: "Goa", goa: "Goa", margao: "Goa",
  vapi: "Gujarat", ankleshwar: "Gujarat", morbi: "Gujarat"
};

function inferStateFromCity(city) {
  const key = String(city || "").toLowerCase().replace(/[^a-z]/g, "");
  return INDIA_CITY_STATE_MAP[key] || "";
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^,]+),(.*)$/s);
  if (!match) return null;
  const metadata = match[1].split(";").map((value) => value.trim()).filter(Boolean);
  const mimeType = String(metadata[0] || "").toLowerCase();
  const isBase64 = metadata.some((value) => value.toLowerCase() === "base64");
  const payload = match[2] || "";
  return {
    mimeType,
    buffer: isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8")
  };
}

function isSupportedAudioMime(mimeType) {
  return /^audio\/(webm|ogg|mpeg|mp3|mp4|m4a|wav|x-wav|aac)$/i.test(String(mimeType || ""));
}

function audioExtension(mimeType) {
  if (/webm/i.test(mimeType)) return "webm";
  if (/ogg/i.test(mimeType)) return "ogg";
  if (/m4a|mp4/i.test(mimeType)) return "m4a";
  if (/wav/i.test(mimeType)) return "wav";
  if (/aac/i.test(mimeType)) return "aac";
  return "mp3";
}

function googleSttConfigured() {
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT_ID && (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64));
}

function googleServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
    return JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString("utf8"));
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  }
  throw new Error("Google STT service account is not configured.");
}

async function googleServiceAccountAccessToken() {
  const account = googleServiceAccount();
  const iat = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(account.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Google service account token failed.");
  return data.access_token;
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function googleAudioEncoding(mimeType) {
  if (/webm/i.test(mimeType)) return "WEBM_OPUS";
  if (/ogg/i.test(mimeType)) return "OGG_OPUS";
  if (/mp3|mpeg/i.test(mimeType)) return "MP3";
  if (/wav/i.test(mimeType)) return "LINEAR16";
  return "WEBM_OPUS";
}

async function transcribeAudio(buffer, mimeType) {
  const failures = [];
  if ((VOICE_STT_PROVIDER === "google" || VOICE_STT_PROVIDER === "auto") && googleSttConfigured()) {
    try {
      return await transcribeWithGoogleStt(buffer, mimeType);
    } catch (err) {
      failures.push(`Google STT: ${err.message}`);
      if (VOICE_STT_PROVIDER === "google") throw new Error(failures.join(" "));
    }
  }
  if ((VOICE_STT_PROVIDER === "openai" || VOICE_STT_PROVIDER === "auto") && process.env.OPENAI_API_KEY) {
    try {
      return await transcribeWithOpenAI(buffer, mimeType);
    } catch (err) {
      failures.push(`OpenAI STT: ${err.message}`);
    }
  }
  throw new Error(failures.length ? `Voice transcription failed. ${failures.join(" ")}` : "Voice transcription is not configured. Add Google STT service-account credentials or OPENAI_API_KEY.");
}

async function transcribeWithGoogleStt(buffer, mimeType) {
  const accessToken = await googleServiceAccountAccessToken();
  const alternatives = GOOGLE_STT_ALTERNATIVE_LANGUAGE_CODES.split(",").map((v) => v.trim()).filter(Boolean);
  const response = await fetch("https://speech.googleapis.com/v1/speech:recognize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config: {
        encoding: googleAudioEncoding(mimeType),
        languageCode: GOOGLE_STT_LANGUAGE_CODE,
        alternativeLanguageCodes: alternatives,
        enableAutomaticPunctuation: true,
        model: GOOGLE_STT_MODEL
      },
      audio: { content: buffer.toString("base64") }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Google STT request failed.");
  const transcript = (data.results || []).map((result) => result.alternatives?.[0]?.transcript || "").join(" ").trim();
  return {
    transcript,
    language: GOOGLE_STT_LANGUAGE_CODE,
    provider: "google_stt",
    confidence: Math.round(100 * Math.max(0, ...((data.results || []).map((result) => Number(result.alternatives?.[0]?.confidence || 0)))))
  };
}

async function transcribeWithOpenAI(buffer, mimeType) {
  const form = new FormData();
  form.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
  form.append("file", new Blob([buffer], { type: mimeType }), `voice-note.${audioExtension(mimeType)}`);
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "OpenAI transcription failed.");
  return {
    transcript: cleanText(data.text || ""),
    language: data.language || "",
    provider: "openai_transcribe",
    confidence: 0
  };
}

async function structureVoiceTranscript(transcript) {
  const text = cleanText(transcript);
  if (!text) return { interest: "", budget: "", followUpDate: "", specialRequirement: "", summary: "" };
  if (!process.env.OPENAI_API_KEY) return heuristicVoiceStructure(text);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VOICE_NOTE_MODEL || OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Extract sales follow-up information from Hindi, English, or Hinglish exhibition voice notes. Return only JSON. Do not translate the raw transcript. If a field is not present, return an empty string."
          },
          {
            role: "user",
            content: `Transcript: ${text}\n\nReturn JSON with: interest, budget, followUpDate, specialRequirement, summary. Keep followUpDate as spoken when not an exact date.`
          }
        ]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Voice note structuring failed.");
    return normalizeVoiceStructure(parseJsonContent(data.choices?.[0]?.message?.content || "{}"), text);
  } catch {
    return heuristicVoiceStructure(text);
  }
}

function normalizeVoiceStructure(raw, transcript = "") {
  return {
    interest: cleanText(raw.interest),
    budget: cleanText(raw.budget),
    followUpDate: cleanText(raw.followUpDate),
    specialRequirement: cleanText(raw.specialRequirement),
    summary: cleanText(raw.summary) || cleanText([raw.interest, raw.budget, raw.followUpDate, raw.specialRequirement].filter(Boolean).join(" | ")) || transcript
  };
}

function heuristicVoiceStructure(transcript) {
  const budgetMatch = transcript.match(/(?:budget|बजट|tak|तक|under|upto|up to)\s*([^\.,;]+)/i);
  const followMatch = transcript.match(/(?:follow\s*up|फॉलो\s*अप|call|कॉल|baad|बाद)\s*([^\.,;]+)/i);
  return normalizeVoiceStructure({
    interest: transcript,
    budget: budgetMatch?.[1] || "",
    followUpDate: followMatch?.[1] || "",
    specialRequirement: "",
    summary: transcript
  }, transcript);
}

function noteComment(note) {
  return String(note.transcript || note.summary || "").trim();
}

function applyVoiceFields(target, note) {
  const existingNotes = String(target.notes || "").trim();
  const voiceComment = noteComment(note);
  target.interest = note.interest || target.interest || "";
  target.specialRequirement = note.specialRequirement || target.specialRequirement || "";
  target.budget = note.budget || target.budget || "";
  target.followUpDate = note.followUpDate || target.followUpDate || "";
  target.voiceTranscript = note.transcript || target.voiceTranscript || "";
  target.voiceLanguage = note.language || target.voiceLanguage || "";
  target.voiceNoteCreatedAt = note.createdAt || now();
  target.voiceNoteId = note.id;
  target.voiceAudioUrl = `/api/voice-notes/${note.id}/audio`;
  target.notes = [existingNotes, voiceComment].filter(Boolean).join(existingNotes && voiceComment ? "\n\n" : "");
}

function normalizeFieldConfidence(rawConfidence, fallbackConfidence = 0) {
  const source = rawConfidence && typeof rawConfidence === "object" ? rawConfidence : {};
  const fallback = Math.max(0, Math.min(100, Number.parseInt(fallbackConfidence, 10) || 0));
  return Object.fromEntries(["name", "mobileNumber", ...OPTIONAL_FIELDS].map((field) => {
    const rawValue = Number.parseInt(source[field], 10);
    return [field, Math.max(0, Math.min(100, Number.isFinite(rawValue) ? rawValue : fallback))];
  }));
}

function imageDimensions(buffer, type) {
  try {
    if (type === "image/png" && buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    if ((type === "image/jpeg" || type === "image/jpg") && buffer.length > 4) {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }

    if (type === "image/webp" && buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
      const chunk = buffer.toString("ascii", 12, 16);
      if (chunk === "VP8X") {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3)
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    try {
      if (pgPool) await pgPool.query("SELECT 1");
      return send(res, 200, {
        status: "ok",
        database: pgPool ? "postgres" : "local",
        timestamp: now()
      });
    } catch {
      return send(res, 503, {
        status: "error",
        database: "unavailable",
        timestamp: now()
      });
    }
  }

  const db = readDb();
  try {
    if (req.method === "POST" && pathname === "/api/webhooks/razorpay") {
      const raw = await readRawBody(req);
      const signature = req.headers["x-razorpay-signature"];
      if (!RAZORPAY_WEBHOOK_SECRET || !razorpaySignatureValid(raw.toString("utf8"), signature, RAZORPAY_WEBHOOK_SECRET)) {
        return error(res, 400, "Invalid webhook signature.");
      }
      let payload;
      try { payload = JSON.parse(raw.toString("utf8")); } catch { return error(res, 400, "Invalid webhook payload."); }
      const eventId = String(req.headers["x-razorpay-event-id"] || payload.id || "");
      db.webhookEvents = Array.isArray(db.webhookEvents) ? db.webhookEvents : [];
      if (eventId && db.webhookEvents.includes(eventId)) return send(res, 200, { ok: true, duplicate: true });
      const event = String(payload.event || "");
      const subscriptionEntity = payload.payload?.subscription?.entity;
      const paymentEntity = payload.payload?.payment?.entity;
      if (event === "subscription.charged" || event === "subscription.activated") {
        const plan = planFromRazorpayPlanId(subscriptionEntity?.plan_id) || subscriptionEntity?.notes?.plan || "";
        const orgId = subscriptionEntity?.notes?.organisationId || "";
        const organisation = db.organisations.find((o) => o.id === orgId)
          || db.organisations.find((o) => o.subscriptionId === subscriptionEntity?.id || o.pendingSubscriptionId === subscriptionEntity?.id);
        if (organisation && plan) {
          const newPeriodEnd = subscriptionEntity?.current_end ? new Date(subscriptionEntity.current_end * 1000).toISOString() : "";
          const isNewPeriod = organisation.currentPeriodEnd !== newPeriodEnd;
          applySubscriptionPlan(organisation, plan, {
            subscriptionId: subscriptionEntity?.id,
            currentPeriodEnd: newPeriodEnd,
            status: event === "subscription.charged" ? "active" : (subscriptionEntity?.status || "active"),
            resetUsage: event === "subscription.charged" && isNewPeriod
          });
          audit(db, { organisationId: organisation.id }, `billing.${event}`, "organisation", organisation.id, { plan });
        }
      } else if (["subscription.halted", "subscription.cancelled", "subscription.completed", "subscription.paused"].includes(event)) {
        const organisation = db.organisations.find((o) => o.subscriptionId === subscriptionEntity?.id);
        if (organisation) {
          organisation.subscriptionStatus = event.replace("subscription.", "");
          organisation.updatedAt = now();
        }
      } else if (event === "order.paid" || event === "payment.captured") {
        const notes = paymentEntity?.notes || payload.payload?.order?.entity?.notes || {};
        const orderId = paymentEntity?.order_id || payload.payload?.order?.entity?.id || "";
        const organisation = db.organisations.find((o) => o.id === notes.organisationId);
        if (organisation && notes.type === "topup" && orderId) {
          organisation.grantedTopupOrders = Array.isArray(organisation.grantedTopupOrders) ? organisation.grantedTopupOrders : [];
          if (!organisation.grantedTopupOrders.includes(orderId)) {
            grantTopupEntitlement(organisation, Number(notes.scans) || TOPUP_SCANS);
            organisation.grantedTopupOrders.push(orderId);
            audit(db, { organisationId: organisation.id }, "billing.topup_charged", "organisation", organisation.id, { orderId });
          }
        }
      }
      if (eventId) {
        db.webhookEvents.push(eventId);
        if (db.webhookEvents.length > 500) db.webhookEvents = db.webhookEvents.slice(-500);
      }
      await saveDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/api/auth/register") {
      if (!rateLimit(req, res, "auth-register", 8, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      if (!body.name || !email || !body.password) return error(res, 400, "Name, email and password are required.");
      if (!body.acceptTerms) return error(res, 400, "Please accept the terms and privacy policy to create an account.");
      const passwordError = validatePasswordStrength(body.password);
      if (passwordError) return error(res, 400, passwordError);
      if (db.users.some((u) => u.email === email)) return error(res, 409, "An account already exists for this email.");
      const verificationToken = randomToken("verify");
      const org = {
        id: id("org"),
        name: `${body.name}'s Workspace`,
        plan: "trial",
        scanLimit: PLAN_LIMITS.trial,
        scansUsed: 0,
        retentionPolicy: "90-days",
        setupComplete: false,
        createdAt: now(),
        updatedAt: now()
      };
      const user = {
        id: id("usr"),
        organisationId: org.id,
        name: String(body.name).trim(),
        email,
        passwordHash: hashPassword(String(body.password)),
        emailVerified: false,
        emailVerificationToken: verificationToken,
        emailVerificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: "pending_verification",
        createdAt: now(),
        updatedAt: now()
      };
      db.organisations.push(org);
      db.users.push(user);
      audit(db, user, "user.registered", "user", user.id);
      await saveDb(db);
      const verificationLink = buildLink(req, `/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`);
      await deliverAccountEmail("verify-email", email, verificationLink);
      return send(res, 201, {
        verificationRequired: true,
        message: "Account created. Please verify your email before logging in.",
        verificationLink: emailDeliveryEnabled() ? undefined : verificationLink
      });
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      if (!rateLimit(req, res, "auth-login", 12, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const user = db.users.find((u) => u.email === email);
      // Always run a scrypt comparison (against a dummy hash when there is no user or
      // no stored password) so response time does not leak whether the email exists.
      const passwordOk = verifyPassword(
        String(body.password || ""),
        user && user.passwordHash ? user.passwordHash : DUMMY_PASSWORD_HASH
      );
      if (!user || !user.passwordHash || !passwordOk) {
        return error(res, 401, "Incorrect email or password.");
      }
      if (user.status === "pending_verification" && user.emailVerified === false) {
        return error(res, 403, "Please verify your email before logging in.", {
          verificationRequired: true,
          email
        });
      }
      audit(db, user, "user.logged_in", "user", user.id);
      return await createSession(req, res, db, user);
    }

    if (req.method === "POST" && pathname === "/api/auth/resend-verification") {
      if (!rateLimit(req, res, "auth-resend-verification", 5, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const user = db.users.find((u) => u.email === email && u.status !== "deleted");
      let verificationLink = "";
      if (user && user.emailVerified === false) {
        const verificationToken = randomToken("verify");
        user.emailVerificationToken = verificationToken;
        user.emailVerificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        user.updatedAt = now();
        verificationLink = buildLink(req, `/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`);
        await deliverAccountEmail("verify-email", email, verificationLink);
        audit(db, user, "user.verification_resent", "user", user.id);
        await saveDb(db);
      }
      return send(res, 200, {
        message: "If this account still needs verification, a new verification email has been sent.",
        verificationLink: emailDeliveryEnabled() ? undefined : verificationLink
      });
    }

    if (req.method === "GET" && pathname === "/api/auth/verify-email") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get("token");
      const user = db.users.find((u) => u.emailVerificationToken === token && new Date(u.emailVerificationExpiresAt || 0) > new Date());
      if (!user) return redirect(res, "/?auth=verify_failed");
      user.emailVerified = true;
      user.status = "active";
      user.emailVerificationToken = "";
      user.emailVerificationExpiresAt = "";
      user.updatedAt = now();
      audit(db, user, "user.email_verified", "user", user.id);
      return await createSession(req, res, db, user, "/?auth=verified");
    }

    if (req.method === "POST" && pathname === "/api/auth/forgot-password") {
      if (!rateLimit(req, res, "auth-forgot", 6, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const user = db.users.find((u) => u.email === email && u.status !== "deleted");
      let resetLink = "";
      if (user) {
        const token = randomToken("reset");
        user.passwordResetToken = token;
        user.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        user.updatedAt = now();
        resetLink = buildLink(req, `/?resetToken=${encodeURIComponent(token)}`);
        await deliverAccountEmail("password-reset", email, resetLink);
        audit(db, user, "user.password_reset_requested", "user", user.id);
        await saveDb(db);
      }
      return send(res, 200, {
        message: "If an account exists for this email, a password reset link has been sent.",
        resetLink: emailDeliveryEnabled() ? undefined : resetLink
      });
    }

    if (req.method === "POST" && pathname === "/api/auth/reset-password") {
      if (!rateLimit(req, res, "auth-reset", 8, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const token = String(body.token || "");
      const user = db.users.find((u) => u.passwordResetToken === token && new Date(u.passwordResetExpiresAt || 0) > new Date());
      if (!user) return error(res, 400, "This password reset link is invalid or expired.");
      const passwordError = validatePasswordStrength(body.password);
      if (passwordError) return error(res, 400, passwordError);
      user.passwordHash = hashPassword(String(body.password));
      user.passwordResetToken = "";
      user.passwordResetExpiresAt = "";
      user.updatedAt = now();
      db.sessions = db.sessions.filter((s) => s.userId !== user.id);
      audit(db, user, "user.password_reset_completed", "user", user.id);
      await saveDb(db);
      return send(res, 200, { message: "Password updated. Please log in with your new password." });
    }

    if (req.method === "GET" && pathname === "/api/auth/google/start") {
      if (!googleConfigured()) return error(res, 400, "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env before Google login.");
      const oauthState = randomToken("glg");
      const mobileLogin = new URL(req.url, `http://${req.headers.host}`).searchParams.get("mobile") === "1";
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", googleLoginRedirectUri(req));
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("prompt", "select_account");
      authUrl.searchParams.set("state", oauthState);
      res.writeHead(302, {
        Location: authUrl.toString(),
        "Set-Cookie": [
          tempCookie(req, "google_login_state", oauthState, 10 * 60),
          tempCookie(req, "google_login_mobile", mobileLogin ? "1" : "", 10 * 60)
        ]
      });
      return res.end();
    }

    if (req.method === "GET" && pathname === "/api/auth/google/callback") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const expectedState = parseCookies(req).google_login_state;
      const mobileLogin = parseCookies(req).google_login_mobile === "1";
      if (!code || !returnedState || returnedState !== expectedState) {
        return redirect(res, "/?auth=google_failed");
      }
      const tokens = await exchangeGoogleCode(code, googleLoginRedirectUri(req));
      const profile = await fetchGoogleProfile(tokens.access_token);
      if (!profile.email || profile.email_verified !== true || !profile.sub) return redirect(res, "/?auth=google_failed");
      const googleEmail = String(profile.email).trim().toLowerCase();
      let user = db.users.find((u) => u.googleSubject === profile.sub);
      if (!user) user = db.users.find((u) => u.email === googleEmail);
      if (user?.googleSubject && user.googleSubject !== profile.sub) return redirect(res, "/?auth=google_failed");
      const existingAccount = Boolean(user);
      if (!user) {
        const org = {
          id: id("org"),
          name: `${profile.name || profile.email}'s Workspace`,
          plan: "trial",
          scanLimit: PLAN_LIMITS.trial,
          scansUsed: 0,
          retentionPolicy: "90-days",
          setupComplete: false,
          createdAt: now(),
          updatedAt: now()
        };
        user = {
          id: id("usr"),
          organisationId: org.id,
          name: profile.name || profile.email,
          email: googleEmail,
          passwordHash: "",
          emailVerified: true,
          authProvider: "google",
          googleSubject: profile.sub,
          status: "active",
          createdAt: now(),
          updatedAt: now()
        };
        db.organisations.push(org);
        db.users.push(user);
        audit(db, user, "user.google_registered", "user", user.id);
      } else {
        user.googleSubject = profile.sub;
        user.emailVerified = true;
        user.status = "active";
        user.authProvider = user.authProvider || "email";
        user.updatedAt = now();
        audit(db, user, "user.google_logged_in", "user", user.id);
      }
      if (mobileLogin) {
        const mobileCode = randomToken("mob");
        mobileAuthCodes.set(mobileCode, {
          userId: user.id,
          expiresAt: Date.now() + 2 * 60 * 1000
        });
        await saveDb(db);
        res.writeHead(302, {
          Location: `easysave://auth?code=${encodeURIComponent(mobileCode)}`,
          "Set-Cookie": [
            tempCookie(req, "google_login_state", "", 0),
            tempCookie(req, "google_login_mobile", "", 0)
          ]
        });
        return res.end();
      }
      await createSession(req, res, db, user, existingAccount ? "/?auth=google_existing" : "/?auth=google_ok", [
        tempCookie(req, "google_login_state", "", 0),
        tempCookie(req, "google_login_mobile", "", 0)
      ]);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/mobile/exchange") {
      if (!rateLimit(req, res, "auth-mobile-exchange", 12, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const code = String(body.code || "");
      const grant = mobileAuthCodes.get(code);
      mobileAuthCodes.delete(code);
      if (!grant || grant.expiresAt < Date.now()) return error(res, 400, "This mobile sign-in request has expired. Please try again.");
      const user = db.users.find((candidate) => candidate.id === grant.userId && candidate.status === "active");
      if (!user) return error(res, 400, "This account is not available.");
      return await createSession(req, res, db, user);
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      const sessionId = verifySessionCookie(parseCookies(req).session);
      const nextDb = readDb();
      nextDb.sessions = nextDb.sessions.filter((s) => s.id !== sessionId);
      await saveDb(nextDb);
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
    }

    if (req.method === "GET" && pathname === "/api/me") {
      const user = currentUser(req, db);
      if (!user) return send(res, 200, { user: null });
      const session = currentSession(req, db);
      const hadCsrfToken = Boolean(session?.csrfToken);
      const csrfToken = session ? ensureSessionCsrf(session) : "";
      if (session && !hadCsrfToken) await saveDb(db);
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      return send(res, 200, { user: publicUser(user), organisation, csrfToken });
    }

    if (req.method === "GET" && pathname === "/api/google/callback") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const returnedState = url.searchParams.get("state");
      const mobileFlowSession = returnedState
        ? db.sessions.find((candidate) => candidate.googleMobileOAuthState === returnedState)
        : null;
      if (mobileFlowSession) {
        const code = url.searchParams.get("code");
        const createdAt = new Date(mobileFlowSession.googleMobileOAuthCreatedAt || 0).getTime();
        const mobileUser = db.users.find((candidate) => candidate.id === mobileFlowSession.userId && candidate.status === "active");
        const feature = mobileFlowSession.googleMobileOAuthFeature === "contacts" ? "contacts" : "sheets";
        delete mobileFlowSession.googleMobileOAuthState;
        delete mobileFlowSession.googleMobileOAuthCreatedAt;
        delete mobileFlowSession.googleMobileOAuthFeature;
        if (!code || !createdAt || Date.now() - createdAt > 10 * 60 * 1000) {
          await saveDb(db);
          return redirect(res, "easysave://auth?google_sheets=failed");
        }
        if (!mobileUser) {
          await saveDb(db);
          return redirect(res, "easysave://auth?google_sheets=failed");
        }
        try {
          const tokens = await exchangeGoogleCode(code, googleRedirectUri(req));
          const profile = await fetchGoogleProfile(tokens.access_token);
          let connection = activeGoogleConnection(db, mobileUser);
          if (!connection) {
            connection = { id: id("gcn"), organisationId: mobileUser.organisationId, createdAt: now() };
            db.googleConnections.unshift(connection);
          }
          connection.connectedBy = mobileUser.id;
          connection.googleEmail = profile.email || connection.googleEmail || "";
          connection.encryptedToken = encryptSecret(tokens.access_token);
          connection.encryptedRefreshToken = tokens.refresh_token
            ? encryptSecret(tokens.refresh_token)
            : connection.encryptedRefreshToken;
          connection.tokenExpiry = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString();
          connection.scopes = mergeGoogleScopes(
            connection.scopes,
            tokens.scope || googleScopes(feature),
          );
          connection.status = "active";
          connection.updatedAt = now();
          audit(db, mobileUser, "google.connected", "google_connection", connection.id, {
            googleEmail: connection.googleEmail,
            source: "mobile"
          });
          await saveDb(db);
          return redirect(res, feature === "contacts"
            ? "easysave://auth?google_contacts=connected"
            : "easysave://auth?google_sheets=connected");
        } catch (error) {
          console.error("Mobile Google Sheets connection failed:", error.message);
          return redirect(res, "easysave://auth?google_sheets=failed");
        }
      }
    }

    const user = requireUser(req, res, db);
    if (!user) return;
    const session = currentSession(req, db);
    if (!session) return error(res, 401, "Your session has expired. Please log in again to continue.");
    ensureSessionCsrf(session);
    const csrfProtected = ["POST", "PATCH", "DELETE"].includes(req.method) || pathname.startsWith("/api/export.");
    if (csrfProtected && !["/api/auth/logout"].includes(pathname) && !validateCsrf(req, res, session)) return;

    if (req.method === "POST" && pathname === "/api/billing/subscribe") {
      if (!billingConfigured()) return error(res, 400, "Online payments are not set up yet. Please try again later.");
      const body = await readJson(req);
      const plan = String(body.plan || "");
      if (!RAZORPAY_PLAN_IDS[plan]) return error(res, 400, "Choose a valid plan.");
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      const subscription = await razorpayApi("/subscriptions", {
        method: "POST",
        body: {
          plan_id: RAZORPAY_PLAN_IDS[plan],
          total_count: RAZORPAY_TOTAL_COUNTS[plan] || 12,
          customer_notify: 1,
          notes: { organisationId: organisation.id, plan }
        }
      });
      organisation.pendingSubscriptionId = subscription.id;
      organisation.subscriptionPlan = plan;
      organisation.updatedAt = now();
      audit(db, user, "billing.subscription_created", "organisation", organisation.id, { plan });
      await saveDb(db);
      return send(res, 200, { subscriptionId: subscription.id, keyId: RAZORPAY_KEY_ID, plan });
    }

    if (req.method === "POST" && pathname === "/api/billing/topup") {
      if (!billingConfigured()) return error(res, 400, "Online payments are not set up yet. Please try again later.");
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      const order = await razorpayApi("/orders", {
        method: "POST",
        body: {
          amount: TOPUP_AMOUNT_PAISE,
          currency: "INR",
          receipt: `topup_${organisation.id}_${Date.now()}`,
          notes: { organisationId: organisation.id, type: "topup", scans: String(TOPUP_SCANS) }
        }
      });
      audit(db, user, "billing.topup_order_created", "organisation", organisation.id, { orderId: order.id });
      await saveDb(db);
      return send(res, 200, { orderId: order.id, amount: order.amount, currency: order.currency, keyId: RAZORPAY_KEY_ID, scans: TOPUP_SCANS });
    }

    if (req.method === "POST" && pathname === "/api/billing/topup/verify") {
      const body = await readJson(req);
      const orderId = String(body.razorpay_order_id || "");
      const paymentId = String(body.razorpay_payment_id || "");
      const signature = String(body.razorpay_signature || "");
      if (!orderId || !paymentId || !signature) return error(res, 400, "Missing payment details.");
      if (!razorpaySignatureValid(`${orderId}|${paymentId}`, signature)) return error(res, 400, "Payment could not be verified.");
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      organisation.grantedTopupOrders = Array.isArray(organisation.grantedTopupOrders) ? organisation.grantedTopupOrders : [];
      if (!organisation.grantedTopupOrders.includes(orderId)) {
        grantTopupEntitlement(organisation, TOPUP_SCANS);
        organisation.grantedTopupOrders.push(orderId);
        audit(db, user, "billing.topup_verified", "organisation", organisation.id, { orderId, paymentId });
      }
      await saveDb(db);
      return send(res, 200, { ok: true, usage: planUsage(organisation) });
    }

    if (req.method === "GET" && pathname === "/api/google/connect") {
      if (!googleConfigured()) {
        return error(res, 400, "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env before connecting Google Sheets.");
      }
      const session = currentSession(req, db);
      if (!session) return error(res, 401, "Your session has expired. Please log in again to continue.");
      const connectUrl = new URL(req.url, `http://${req.headers.host}`);
      const feature = connectUrl.searchParams.get("feature") === "contacts" ? "contacts" : "sheets";
      const oauthState = id("gst");
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", googleRedirectUri(req));
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", googleScopes(feature));
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("include_granted_scopes", "true");
      authUrl.searchParams.set("state", oauthState);
      const isMobile = connectUrl.searchParams.get("mobile") === "1";
      if (isMobile) {
        session.googleMobileOAuthState = oauthState;
        session.googleMobileOAuthCreatedAt = now();
        session.googleMobileOAuthFeature = feature;
        await saveDb(db);
        return send(res, 200, { authUrl: authUrl.toString() });
      }
      session.googleOAuthState = oauthState;
      session.googleOAuthCreatedAt = now();
      session.googleOAuthFeature = feature;
      await saveDb(db);
      return redirect(res, authUrl.toString());
    }

    if (req.method === "GET" && pathname === "/api/google/callback") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const session = currentSession(req, db);
      if (!session || !returnedState || session.googleOAuthState !== returnedState) {
        return error(res, 400, "Google connection state did not match. Please try connecting again.");
      }
      if (!code) return error(res, 400, "Google did not return an authorization code.");
      const feature = session.googleOAuthFeature === "contacts" ? "contacts" : "sheets";
      const tokens = await exchangeGoogleCode(code, googleRedirectUri(req));
      const profile = await fetchGoogleProfile(tokens.access_token);
      let connection = activeGoogleConnection(db, user);
      if (!connection) {
        connection = {
          id: id("gcn"),
          organisationId: user.organisationId,
          createdAt: now()
        };
        db.googleConnections.unshift(connection);
      }
      connection.connectedBy = user.id;
      connection.googleEmail = profile.email || connection.googleEmail || "";
      connection.encryptedToken = encryptSecret(tokens.access_token);
      connection.encryptedRefreshToken = tokens.refresh_token
        ? encryptSecret(tokens.refresh_token)
        : connection.encryptedRefreshToken;
      connection.tokenExpiry = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString();
      connection.scopes = mergeGoogleScopes(
        connection.scopes,
        tokens.scope || googleScopes(feature),
      );
      connection.status = "active";
      connection.updatedAt = now();
      delete session.googleOAuthState;
      delete session.googleOAuthCreatedAt;
      delete session.googleOAuthFeature;
      audit(db, user, "google.connected", "google_connection", connection.id, { googleEmail: connection.googleEmail });
      await saveDb(db);
      return redirect(res, feature === "contacts" ? "/?google_contacts=connected#contacts" : "/?google=connected#contacts/sheets");
    }

    if (req.method === "GET" && pathname === "/api/overview") {
      const collections = db.collections.filter((c) => c.organisationId === user.organisationId && c.status !== "deleted");
      const active = findCollectionForUser(db, user);
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      const contacts = db.contacts.filter((c) => c.organisationId === user.organisationId && !c.deletedAt);
      const cards = db.cards.filter((c) => c.organisationId === user.organisationId);
      return send(res, 200, {
        activeCollection: active,
        collections,
        organisation,
        needsOnboarding: organisationNeedsOnboarding(db, user),
        usage: planUsage(organisation),
        stats: {
          contacts: contacts.length,
          needsReview: cards.filter((c) => c.status === "requires_review").length,
          synced: contacts.filter((c) => c.googleSheetsSyncStatus === "synced").length,
          pendingSync: contacts.filter((c) => c.googleSheetsSyncStatus === "pending" || c.googleSheetsSyncStatus === "failed").length
        },
        google: googleStatus(db, user),
        billing: billingSummary(organisation)
      });
    }

    if (req.method === "POST" && pathname === "/api/onboarding") {
      const body = await readJson(req);
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      const businessName = String(body.businessName || "").trim();
      if (!businessName) return error(res, 400, "Business name is required.");
      const destinationType = ["excel", "google"].includes(body.destinationType) ? body.destinationType : "excel";
      organisation.name = businessName;
      organisation.setupComplete = true;
      organisation.defaultExhibitionName = String(body.defaultExhibitionName || "").trim();
      organisation.updatedAt = now();
      let collection = findCollectionForUser(db, user);
      if (!body.deferFirstCollection) {
        collection = collection || collectionForUser(db, user);
        collection.name = String(body.collectionName || body.defaultExhibitionName || "Default Contact Sheet").trim();
        collection.exhibitionName = organisation.defaultExhibitionName || collection.exhibitionName || "";
        collection.destinationType = destinationType;
        collection.destinationName = defaultDestinationName(destinationType, collection.name);
        collection.updatedAt = now();
      } else if (collection && ["Current Sheet", "Default Contact Collection"].includes(collection.name)) {
        const hasRecords = db.contacts.some((contact) => contact.collectionId === collection.id && !contact.deletedAt)
          || db.cards.some((card) => card.collectionId === collection.id && !card.deletedAt);
        if (!hasRecords) {
          collection.status = "deleted";
          collection.deletedAt = now();
          collection = null;
        }
      }
      audit(db, user, "workspace.onboarded", "organisation", organisation.id, { destinationType });
      await saveDb(db);
      return send(res, 200, { organisation, collection, google: googleStatus(db, user) });
    }

    if (req.method === "POST" && pathname === "/api/demo/start") {
      const collection = {
        id: id("col"),
        organisationId: user.organisationId,
        name: "IIJS Demo Leads",
        exhibitionName: "IIJS Premiere Demo",
        exhibitionDate: new Date().toISOString().slice(0, 10),
        destinationType: "excel",
        destinationName: "IIJS Demo Leads Excel/CSV",
        savedContactCount: 0,
        nextSheetRow: 2,
        status: "active",
        demo: true,
        createdAt: now(),
        updatedAt: now()
      };
      db.collections.forEach((c) => {
        if (c.organisationId === user.organisationId) c.status = "archived";
      });
      db.collections.push(collection);
      const samples = [
        ["Aarav Mehta", "+91 98765 43120", "Mehta Exports", "Owner", "Mumbai", "Interested in premium catalogues"],
        ["Priya Shah", "+91 98210 44550", "Shah Diamonds", "Procurement Head", "Surat", "Interested in loose diamonds"],
        ["Karan Jain", "+91 90044 78122", "Jain Ornaments", "Partner", "Jaipur", "Follow up after exhibition"],
        ["Neha Doshi", "+91 99876 11220", "Doshi Gems", "Director", "Ahmedabad", "Asked for catalogue"],
        ["Rohan Kapoor", "+91 98111 22009", "Kapoor Retail", "Buyer", "Delhi", "Premium necklace range"]
      ];
      samples.forEach((sample, index) => {
        const contact = {
          id: id("con"),
          organisationId: user.organisationId,
          ownerId: user.id,
          collectionId: collection.id,
          name: sample[0],
          mobileNumber: sample[1],
          normalizedMobileNumber: normalizeMobile(sample[1]),
          companyName: sample[2],
          designation: sample[3],
          city: sample[4],
          exhibitionName: collection.exhibitionName,
          exhibitionDate: collection.exhibitionDate,
          notes: sample[5],
          tags: "demo",
          source: "Demo Mode",
          uploadedBy: user.name,
          reviewStatus: "Reviewed",
          duplicateStatus: "none",
          googleSheetsSyncStatus: "not_configured",
          sheetRow: 2 + index,
          extractionConfidence: 98,
          createdBy: user.id,
          updatedBy: user.id,
          createdAt: now(),
          updatedAt: now()
        };
        db.contacts.unshift(contact);
      });
      collection.savedContactCount = samples.length;
      collection.nextSheetRow = 2 + samples.length;
      audit(db, user, "demo.loaded", "collection", collection.id, { contacts: samples.length });
      await saveDb(db);
      return send(res, 201, { collection, contactsAdded: samples.length });
    }

    if (req.method === "POST" && pathname === "/api/collections") {
      const body = await readJson(req);
      const name = String(body.name || body.exhibitionName || "").trim();
      const exhibitionName = String(body.exhibitionName || body.name || "").trim();
      const destinationType = body.destinationType === "google" ? "google" : "excel";
      if (!name || !exhibitionName) return error(res, 400, "Enter an exhibition name before creating it.");
      db.collections.forEach((c) => {
        if (c.organisationId === user.organisationId) c.status = "archived";
      });
      const collection = {
        id: id("col"),
        organisationId: user.organisationId,
        name,
        exhibitionName,
        exhibitionDate: String(body.exhibitionDate || ""),
        destinationType,
        destinationName: String(body.destinationName || (destinationType === "google" ? `${name} Contacts` : `${name} Excel/CSV`)).trim(),
        savedContactCount: 0,
        nextSheetRow: 2,
        status: "active",
        createdAt: now(),
        updatedAt: now()
      };
      db.collections.push(collection);
      audit(db, user, "collection.created", "collection", collection.id);
      await saveDb(db);
      return send(res, 201, { collection });
    }

    if (req.method === "PATCH" && pathname.startsWith("/api/collections/")) {
      const collection = db.collections.find((c) => c.id === pathname.split("/").pop() && c.organisationId === user.organisationId && c.status !== "deleted");
      if (!collection) return error(res, 404, "Collection not found.");
      const body = await readJson(req);
      ["name", "exhibitionName", "exhibitionDate", "destinationType", "destinationName"].forEach((field) => {
        if (body[field] != null) collection[field] = String(body[field]);
      });
      collection.updatedAt = now();
      audit(db, user, "collection.updated", "collection", collection.id, body);
      await saveDb(db);
      return send(res, 200, { collection });
    }

    if (req.method === "POST" && pathname.startsWith("/api/collections/") && pathname.endsWith("/activate")) {
      const collectionId = pathname.split("/")[3];
      const collection = db.collections.find((c) => c.id === collectionId && c.organisationId === user.organisationId && c.status !== "deleted");
      if (!collection) return error(res, 404, "Collection not found.");
      db.collections.forEach((c) => {
        if (c.organisationId === user.organisationId) {
          c.status = c.id === collection.id ? "active" : "archived";
          c.updatedAt = now();
        }
      });
      audit(db, user, "collection.activated", "collection", collection.id);
      await saveDb(db);
      return send(res, 200, { collection });
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/collections/")) {
      const collectionId = pathname.split("/").pop();
      const collection = db.collections.find((c) => c.id === collectionId && c.organisationId === user.organisationId && c.status !== "deleted");
      if (!collection) return error(res, 404, "Collection not found.");
      const savedContacts = db.contacts.filter((c) => c.collectionId === collection.id && c.organisationId === user.organisationId && !c.deletedAt);
      const activeCards = db.cards.filter((c) => c.collectionId === collection.id && c.organisationId === user.organisationId && !c.deletedAt && c.status !== "deleted");
      if (savedContacts.length || activeCards.length) {
        return error(res, 409, "This collection has saved contacts or scanned cards. Delete those records first, or keep the collection for audit safety.");
      }
      const wasActive = collection.status === "active";
      collection.status = "deleted";
      collection.deletedAt = now();
      collection.updatedAt = now();
      if (wasActive) {
        const replacement = db.collections
          .filter((c) => c.organisationId === user.organisationId && c.status !== "deleted" && c.id !== collection.id)
          .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0];
        if (replacement) {
          replacement.status = "active";
          replacement.updatedAt = now();
        }
      }
      audit(db, user, "collection.deleted", "collection", collection.id);
      await saveDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/api/uploads") {
      if (!rateLimit(req, res, "upload", 40, 60 * 60 * 1000)) return;
      const body = await readJson(req);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) return error(res, 400, "Select at least one card image before uploading.");
      if (files.length > MAX_BATCH_FILES) return error(res, 400, `A batch can contain at most ${MAX_BATCH_FILES} files.`);
      const totalBytes = files.reduce(
        (sum, file) => sum + Math.max(0, Number(file.size || 0)) + Math.max(0, Number(file.backSize || 0)),
        0
      );
      if (totalBytes > MAX_BATCH_BYTES) return error(res, 400, "The combined batch size cannot exceed 100 MB.");
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      const usage = planUsage(organisation);
      if (files.length > usage.remaining) {
        return error(res, 402, `This upload exceeds the ${usage.limit}-scan plan allowance. ${usage.remaining} scan(s) remain.`);
      }

      const collection = body.createNewCollection
        ? createCollectionFromUpload(db, user, body)
        : collectionForUser(db, user, body.collectionId);

      if (!body.createNewCollection) {
        db.collections.forEach((item) => {
          if (item.organisationId === user.organisationId && item.status !== "deleted") {
            item.status = item.id === collection.id ? "active" : "archived";
          }
        });
        collection.updatedAt = now();
      }

      const batch = {
        id: id("bat"),
        organisationId: user.organisationId,
        collectionId: collection.id,
        uploadedBy: user.id,
        totalFiles: files.length,
        completedFiles: 0,
        failedFiles: 0,
        reviewRequiredCount: 0,
        duplicateCount: 0,
        status: "processing",
        createdAt: now()
      };
      db.uploadBatches.unshift(batch);

      const cards = [];
      const batchChecksums = new Map();
      const extractionQueue = [];
      for (const file of files) {
        const type = String(file.type || "");
        const size = Number(file.size || 0);
        const backType = String(file.backType || "");
        const backSize = Number(file.backSize || 0);
        const invalidFront = !/^image\/(jpeg|jpg|png|webp|heic|heif)$/.test(type) || size > MAX_FILE_BYTES;
        const invalidBack = file.backDataUrl && (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/.test(backType) || backSize > MAX_FILE_BYTES);
        if (invalidFront || invalidBack) {
          const failedCard = {
            id: id("crd"),
            organisationId: user.organisationId,
            collectionId: collection.id,
            batchId: batch.id,
            originalFileName: file.name,
            storagePath: "",
            storageUrl: "",
            checksum: hash(file.dataUrl || file.name),
            fileType: type || "unknown",
            fileSize: size,
            status: "failed",
            extraction: makeManualReviewExtraction(file.name, collection, invalidBack
              ? "The back image has an unsupported type or is too large."
              : "Unsupported file type or file too large."),
            createdAt: now(),
            updatedAt: now()
          };
          batch.failedFiles += 1;
          db.cards.unshift(failedCard);
          cards.push(publicCard(failedCard));
          continue;
        }
        const checksum = hash(`${file.dataUrl || file.name}|${file.backDataUrl || ""}`);
        const duplicateInBatchId = batchChecksums.get(checksum);
        const duplicateImage = db.cards.find((c) => c.organisationId === user.organisationId && c.checksum === checksum);
        const duplicateImageId = duplicateInBatchId || duplicateImage?.id || "";
        const cardId = id("crd");
        const ext = type.split("/")[1].replace("jpeg", "jpg");
        const storagePath = path.join(STORAGE_DIR, "cards", `${cardId}.${ext}`);
        const base64 = String(file.dataUrl || "").split(",")[1] || "";
        const imageBuffer = Buffer.from(base64, "base64");
        fs.writeFileSync(storagePath, imageBuffer);
        let backStoragePath = "";
        if (file.backDataUrl) {
          const backExt = backType.split("/")[1].replace("jpeg", "jpg");
          backStoragePath = path.join(STORAGE_DIR, "cards", `${cardId}-back.${backExt}`);
          const backBase64 = String(file.backDataUrl).split(",")[1] || "";
          fs.writeFileSync(backStoragePath, Buffer.from(backBase64, "base64"));
        }
        const dimensions = imageDimensions(imageBuffer, type);
        const imageWarning = dimensions && Math.min(dimensions.width, dimensions.height) < 300
          ? `Image resolution is too low for reliable AI extraction (${dimensions.width}x${dimensions.height}). Please upload a sharper card image or enter details manually.`
          : "";
        extractionQueue.push({
          file,
          cardId,
          type,
          size,
          storagePath,
          backStoragePath,
          dimensions,
          imageWarning,
          checksum,
          duplicateInBatchId,
          duplicateImageId
        });
        batchChecksums.set(checksum, cardId);
      }

      const extractionResults = await mapWithConcurrency(extractionQueue, EXTRACTION_CONCURRENCY, async (task) => {
        const extracted = task.imageWarning
          ? makeManualReviewExtraction(task.file.name, collection, task.imageWarning)
          : await extractBusinessCard(task.file, collection);
        return { task, extracted };
      });

      for (const { task, extracted } of extractionResults) {
        const {
          file, cardId, type, size, storagePath, backStoragePath, dimensions,
          checksum, duplicateInBatchId, duplicateImageId
        } = task;
        if (duplicateInBatchId) {
          extracted.warnings = extracted.warnings || [];
          extracted.warnings.push("Duplicate image detected within this upload batch. Review before saving.");
        } else if (duplicateImageId) {
          extracted.warnings = extracted.warnings || [];
          extracted.warnings.push("This image appears to have been uploaded before. Review before saving.");
        }
        const status = extracted.name && extracted.mobileNumber && isValidMobile(extracted.mobileNumber) && !duplicateImageId ? "completed" : "requires_review";
        const card = {
          id: cardId,
          organisationId: user.organisationId,
          collectionId: collection.id,
          batchId: batch.id,
          originalFileName: file.name,
          storagePath,
          storageUrl: `/api/cards/${cardId}/image`,
          backStoragePath,
          backStorageUrl: backStoragePath ? `/api/cards/${cardId}/back-image` : "",
          checksum,
          fileType: type,
          fileSize: size,
          backFileType: file.backType || "",
          backFileSize: Number(file.backSize || 0),
          width: dimensions?.width || null,
          height: dimensions?.height || null,
          status,
          extraction: extracted,
          duplicateImageOf: duplicateImageId || null,
          pairMode: backStoragePath ? "front-back" : "",
          frontFileName: file.name || "",
          backFileName: file.backName || "",
          preprocessing: file.preprocessing || "",
          createdAt: now(),
          updatedAt: now()
        };
        if (status === "completed") batch.completedFiles += 1;
        if (status === "requires_review") batch.reviewRequiredCount += 1;
        if (duplicateImageId) batch.duplicateCount += 1;
        db.cards.unshift(card);
        cards.push(publicCard(card));
      }
      batch.status = batch.failedFiles === files.length ? "failed" : "completed";
      if (organisation) {
        organisation.scansUsed = usage.used + files.length;
        organisation.scanLimit = usage.limit;
        organisation.updatedAt = now();
      }
      audit(db, user, "cards.uploaded", "batch", batch.id, { files: files.length, collectionId: collection.id });
      await saveDb(db);
      return send(res, 201, { batch, collection, cards });
    }

    if (req.method === "GET" && pathname === "/api/cards") {
      const cards = db.cards.filter((c) => c.organisationId === user.organisationId && !c.deletedAt && !["saved", "deleted", "skipped", "skipped_duplicate"].includes(c.status)).map(publicCard);
      return send(res, 200, { cards });
    }

    if (req.method === "POST" && pathname === "/api/voice-notes/transcribe") {
      if (!rateLimit(req, res, "voice-note", 60, 60 * 60 * 1000)) return;
      const body = await readJson(req);
      const targetType = String(body.targetType || "").trim();
      const targetIds = Array.isArray(body.targetIds) ? body.targetIds.map(String).filter(Boolean).slice(0, 100) : [];
      if (!["card", "contact", "contacts", "batch"].includes(targetType)) return error(res, 400, "Voice note target is invalid.");
      if (!targetIds.length) return error(res, 400, "Select at least one card or contact for this voice note.");
      const parsed = parseDataUrl(body.audioDataUrl);
      if (!parsed || !isSupportedAudioMime(parsed.mimeType)) return error(res, 400, "Record a supported audio note before transcribing.");
      if (parsed.buffer.length > 12 * 1024 * 1024) return error(res, 400, "Voice note is too large. Keep notes under about one minute.");

      if (targetType === "card" || targetType === "batch") {
        const count = db.cards.filter((card) => card.organisationId === user.organisationId && targetIds.includes(card.id) && !card.deletedAt).length;
        if (count !== targetIds.length) return error(res, 404, "One or more selected cards were not found.");
      } else {
        const count = db.contacts.filter((contact) => contact.organisationId === user.organisationId && targetIds.includes(contact.id) && !contact.deletedAt).length;
        if (count !== targetIds.length) return error(res, 404, "One or more selected contacts were not found.");
      }

      const noteId = id("vnt");
      const ext = audioExtension(parsed.mimeType);
      const audioPath = path.join(STORAGE_DIR, "voice_notes", `${noteId}.${ext}`);
      fs.writeFileSync(audioPath, parsed.buffer);
      const transcription = await transcribeAudio(parsed.buffer, parsed.mimeType);
      const structured = await structureVoiceTranscript(transcription.transcript);
      const note = {
        id: noteId,
        organisationId: user.organisationId,
        createdBy: user.id,
        targetType,
        targetIds,
        cardId: targetType === "card" && targetIds.length === 1 ? targetIds[0] : null,
        contactId: targetType === "contact" && targetIds.length === 1 ? targetIds[0] : null,
        batchId: targetType === "batch" ? String(body.batchId || "") : null,
        audioPath,
        audioMimeType: parsed.mimeType,
        audioSize: parsed.buffer.length,
        transcript: transcription.transcript,
        language: transcription.language || GOOGLE_STT_LANGUAGE_CODE,
        interest: structured.interest,
        specialRequirement: structured.specialRequirement,
        budget: structured.budget,
        followUpDate: structured.followUpDate,
        summary: structured.summary,
        status: "draft",
        provider: transcription.provider,
        createdAt: now()
      };
      db.voiceNotes.unshift(note);
      audit(db, user, "voice_note.transcribed", targetType, targetIds.join(","), { provider: note.provider, targetCount: targetIds.length });
      await saveDb(db);
      return send(res, 201, { voiceNote: publicVoiceNote(note) });
    }

    if (req.method === "GET" && pathname.startsWith("/api/voice-notes/") && pathname.endsWith("/audio")) {
      const noteId = pathname.split("/")[3];
      const note = db.voiceNotes.find((item) => item.id === noteId && item.organisationId === user.organisationId && !item.deletedAt);
      if (!note || !note.audioPath || !fs.existsSync(note.audioPath)) return error(res, 404, "Voice note audio not found.");
      return send(res, 200, fs.readFileSync(note.audioPath), { "Content-Type": note.audioMimeType || "audio/webm", "Cache-Control": "private, no-store" });
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/voice-notes/") && !pathname.endsWith("/audio")) {
      const noteId = pathname.split("/")[3];
      const note = db.voiceNotes.find((item) => item.id === noteId && item.organisationId === user.organisationId && !item.deletedAt);
      if (!note) return error(res, 404, "Voice note not found.");
      if (note.status === "applied") return error(res, 409, "An applied voice remark must be removed from the contact instead.");
      if (note.audioPath && fs.existsSync(note.audioPath)) fs.unlinkSync(note.audioPath);
      db.voiceNotes = db.voiceNotes.filter((item) => item.id !== note.id);
      audit(db, user, "voice_note.deleted", note.targetType, note.targetIds.join(","), { voiceNoteId: note.id });
      await saveDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname.startsWith("/api/voice-notes/") && pathname.endsWith("/apply")) {
      const noteId = pathname.split("/")[3];
      const note = db.voiceNotes.find((item) => item.id === noteId && item.organisationId === user.organisationId && !item.deletedAt);
      if (!note) return error(res, 404, "Voice note not found.");
      if (note.status === "applied") return error(res, 409, "This voice note has already been applied.");
      const body = await readJson(req);
      const targetIds = Array.isArray(body.targetIds) && body.targetIds.length ? body.targetIds.map(String) : note.targetIds;
      let applied = 0;
      if (note.targetType === "card" || note.targetType === "batch") {
        const cards = db.cards.filter((card) => card.organisationId === user.organisationId && targetIds.includes(card.id) && !card.deletedAt && !["saved", "deleted", "skipped", "skipped_duplicate"].includes(card.status));
        if (!cards.length) return error(res, 404, "No review cards are available for this voice note.");
        for (const card of cards) {
          card.extraction = card.extraction || {};
          applyVoiceFields(card.extraction, note);
          card.extraction.warnings = Array.isArray(card.extraction.warnings) ? card.extraction.warnings : [];
          card.updatedAt = now();
          applied += 1;
        }
      } else {
        const contacts = db.contacts.filter((contact) => contact.organisationId === user.organisationId && targetIds.includes(contact.id) && !contact.deletedAt);
        if (!contacts.length) return error(res, 404, "No saved contacts are available for this voice note.");
        for (const contact of contacts) {
          applyVoiceFields(contact, note);
          contact.googleSheetsSyncStatus = contact.googleSheetsSyncStatus === "synced" ? "pending" : contact.googleSheetsSyncStatus;
          contact.updatedAt = now();
          contact.updatedBy = user.id;
          applied += 1;
        }
      }
      note.targetIds = targetIds;
      note.status = "applied";
      note.appliedAt = now();
      audit(db, user, "voice_note.applied", note.targetType, targetIds.join(","), { voiceNoteId: note.id, applied });
      await saveDb(db);
      return send(res, 200, { applied, voiceNote: publicVoiceNote(note) });
    }

    if (req.method === "GET" && pathname.startsWith("/api/cards/") && pathname.endsWith("/image")) {
      const cardId = pathname.split("/")[3];
      const card = db.cards.find((c) => c.id === cardId && c.organisationId === user.organisationId);
      if (!card || !fs.existsSync(card.storagePath)) return error(res, 404, "Card image not found.");
      const image = fs.readFileSync(card.storagePath);
      return send(res, 200, image, { "Content-Type": card.fileType, "Cache-Control": "private, no-store" });
    }

    if (req.method === "GET" && pathname.startsWith("/api/cards/") && pathname.endsWith("/back-image")) {
      const cardId = pathname.split("/")[3];
      const card = db.cards.find((c) => c.id === cardId && c.organisationId === user.organisationId);
      if (!card?.backStoragePath || !fs.existsSync(card.backStoragePath)) return error(res, 404, "Back image not found.");
      const image = fs.readFileSync(card.backStoragePath);
      return send(res, 200, image, { "Content-Type": card.backFileType || "image/jpeg", "Cache-Control": "private, no-store" });
    }

    if (req.method === "POST" && pathname.startsWith("/api/cards/") && pathname.endsWith("/save")) {
      const cardId = pathname.split("/")[3];
      const card = db.cards.find((c) => c.id === cardId && c.organisationId === user.organisationId && !c.deletedAt);
      if (!card) return error(res, 404, "Card not found.");
      const body = await readJson(req);
      return await saveContactFromFields(res, db, user, card, body.fields || {});
    }

    if (req.method === "POST" && pathname.startsWith("/api/cards/") && pathname.endsWith("/skip")) {
      const cardId = pathname.split("/")[3];
      const card = db.cards.find((c) => c.id === cardId && c.organisationId === user.organisationId && !c.deletedAt);
      if (!card) return error(res, 404, "Card not found.");
      if (card.status === "saved") return error(res, 409, "Saved cards cannot be skipped. Delete the saved contact from Contacts if needed.");
      card.status = "skipped";
      card.updatedAt = now();
      audit(db, user, "card.skipped", "card", card.id, { originalFileName: card.originalFileName });
      await saveDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/api/cards/save-valid") {
      const candidates = db.cards.filter((card) =>
        card.organisationId === user.organisationId &&
        !card.deletedAt &&
        card.status === "completed" &&
        card.extraction?.name &&
        card.extraction?.mobileNumber
      );
      const result = { saved: 0, keptForReview: 0, duplicates: 0, invalid: 0 };
      for (const card of candidates) {
        const saved = saveContactRecord(db, user, card, card.extraction, { allowDuplicate: false });
        if (saved.ok) {
          result.saved += 1;
        } else {
          card.status = "requires_review";
          card.extraction = card.extraction || {};
          card.extraction.warnings = Array.isArray(card.extraction.warnings) ? card.extraction.warnings : [];
          card.extraction.warnings.push(saved.message);
          card.updatedAt = now();
          result.keptForReview += 1;
          if (saved.code === "duplicate") result.duplicates += 1;
          else result.invalid += 1;
        }
      }
      audit(db, user, "cards.save_all_valid", "card_batch", "", result);
      await saveDb(db);
      return send(res, 200, result);
    }

    if (req.method === "POST" && pathname.startsWith("/api/cards/") && pathname.endsWith("/reprocess")) {
      if (!rateLimit(req, res, "card-reprocess", 40, 60 * 60 * 1000)) return;
      const cardId = pathname.split("/")[3];
      const card = db.cards.find((c) => c.id === cardId && c.organisationId === user.organisationId && !c.deletedAt);
      if (!card) return error(res, 404, "Card not found.");
      if (card.status === "saved") return error(res, 409, "Saved cards cannot be reprocessed. Edit the saved contact instead.");
      if (!card.storagePath || !fs.existsSync(card.storagePath)) return error(res, 400, "The original card image is not available for reprocessing.");
      const collection = collectionForUser(db, user, card.collectionId);
      const imageBuffer = fs.readFileSync(card.storagePath);
      const file = {
        name: card.originalFileName,
        type: card.fileType,
        size: card.fileSize,
        dataUrl: `data:${card.fileType};base64,${imageBuffer.toString("base64")}`
      };
      if (card.backStoragePath && fs.existsSync(card.backStoragePath)) {
        const backBuffer = fs.readFileSync(card.backStoragePath);
        file.backType = card.backFileType || "image/jpeg";
        file.backDataUrl = `data:${file.backType};base64,${backBuffer.toString("base64")}`;
      }
      const extraction = await extractBusinessCard(file, collection);
      const duplicateImage = db.cards.find((c) =>
        c.organisationId === user.organisationId &&
        c.id !== card.id &&
        c.checksum === card.checksum &&
        !c.deletedAt
      );
      if (duplicateImage) {
        extraction.warnings = extraction.warnings || [];
        extraction.warnings.push("This image matches another uploaded card. Review before saving.");
      }
      card.extraction = extraction;
      card.duplicateImageOf = duplicateImage?.id || null;
      card.status = extraction.name && extraction.mobileNumber && isValidMobile(extraction.mobileNumber) && !duplicateImage ? "completed" : "requires_review";
      card.updatedAt = now();
      audit(db, user, "card.reprocessed", "card", card.id, { status: card.status });
      await saveDb(db);
      return send(res, 200, { card: publicCard(card) });
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/cards/")) {
      const cardId = pathname.split("/").pop();
      const card = db.cards.find((c) => c.id === cardId && c.organisationId === user.organisationId && !c.deletedAt);
      if (!card) return error(res, 404, "Card not found.");
      if (card.status === "saved") {
        return error(res, 409, "This card has already been saved as a contact. Delete the saved contact from the Contacts screen.");
      }
      const previousStatus = card.status;
      card.status = "deleted";
      card.deletedAt = now();
      card.updatedAt = now();
      const batch = db.uploadBatches.find((b) => b.id === card.batchId && b.organisationId === user.organisationId);
      if (batch) {
        if (batch.reviewRequiredCount > 0 && previousStatus === "requires_review") batch.reviewRequiredCount -= 1;
        batch.status = "updated";
      }
      audit(db, user, "card.deleted", "card", card.id, { originalFileName: card.originalFileName, batchId: card.batchId });
      await saveDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/contacts") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const query = String(url.searchParams.get("q") || "").toLowerCase();
      let contacts = db.contacts.filter((c) => c.organisationId === user.organisationId && !c.deletedAt);
      if (query) {
        contacts = contacts.filter((c) => [c.name, c.mobileNumber, c.companyName, c.emailAddress, c.city, c.tags, c.notes, c.assignedToName, c.exhibitionName].some((v) => String(v || "").toLowerCase().includes(query)));
      }
      contacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(res, 200, { contacts });
    }

    if (req.method === "GET" && pathname === "/api/team") {
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      return send(res, 200, { members: teamMembers(organisation) });
    }

    if (req.method === "POST" && pathname === "/api/team") {
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      const body = await readJson(req);
      const name = String(body.name || "").trim().replace(/\s+/g, " ");
      if (!name) return error(res, 400, "Enter the team member's full name.");
      if (name.length > 80) return error(res, 400, "Team member name is too long.");
      const members = teamMembers(organisation);
      if (members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
        return error(res, 409, "A team member with this name already exists.");
      }
      const member = { id: id("tm"), name, createdAt: now() };
      members.push(member);
      members.sort((a, b) => a.name.localeCompare(b.name));
      organisation.teamMembers = members;
      organisation.updatedAt = now();
      audit(db, user, "team.member_added", "team_member", member.id, { name });
      await saveDb(db);
      return send(res, 201, { member, members });
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/team/")) {
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      const memberId = pathname.split("/").pop();
      const members = teamMembers(organisation);
      const member = members.find((m) => m.id === memberId);
      if (!member) return error(res, 404, "Team member not found.");
      organisation.teamMembers = members.filter((m) => m.id !== memberId);
      let unassigned = 0;
      db.contacts.forEach((contact) => {
        if (contact.organisationId === user.organisationId && contact.assignedToId === memberId) {
          contact.assignedToId = "";
          contact.assignedToName = "";
          contact.updatedAt = now();
          unassigned += 1;
        }
      });
      organisation.updatedAt = now();
      audit(db, user, "team.member_removed", "team_member", memberId, { name: member.name, unassigned });
      await saveDb(db);
      return send(res, 200, { members: organisation.teamMembers, unassigned });
    }

    if (req.method === "POST" && pathname.startsWith("/api/contacts/") && pathname.endsWith("/assign")) {
      const contactId = pathname.split("/")[3];
      const contact = db.contacts.find((c) => c.id === contactId && c.organisationId === user.organisationId && !c.deletedAt);
      if (!contact) return error(res, 404, "Contact not found.");
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      const body = await readJson(req);
      const memberId = String(body.memberId || "");
      if (!memberId) {
        contact.assignedToId = "";
        contact.assignedToName = "";
      } else {
        const member = teamMembers(organisation).find((m) => m.id === memberId);
        if (!member) return error(res, 400, "Select a valid team member.");
        contact.assignedToId = member.id;
        contact.assignedToName = member.name;
      }
      contact.updatedAt = now();
      contact.updatedBy = user.id;
      audit(db, user, "contact.assigned", "contact", contact.id, {
        assignedToId: contact.assignedToId,
        assignedToName: contact.assignedToName
      });
      await saveDb(db);
      return send(res, 200, { contact });
    }

    if (req.method === "PATCH" && pathname.startsWith("/api/contacts/")) {
      const contactId = pathname.split("/").pop();
      const contact = db.contacts.find((c) => c.id === contactId && c.organisationId === user.organisationId && !c.deletedAt);
      if (!contact) return error(res, 404, "Contact not found.");
      const body = await readJson(req);
      const fields = body.fields || {};
      const validation = validateContact(fields);
      if (!validation.ok) return error(res, 400, validation.message, validation);
      const cleaned = cleanContactFields(fields);
      const duplicate = db.contacts.find((c) =>
        c.organisationId === user.organisationId &&
        c.id !== contact.id &&
        !c.deletedAt &&
        c.normalizedMobileNumber === normalizeMobile(cleaned.mobileNumber)
      );
      if (duplicate) return error(res, 409, "Another saved contact already uses this mobile number.");
      Object.assign(contact, cleaned, { updatedAt: now(), updatedBy: user.id });
      contact.normalizedMobileNumber = normalizeMobile(contact.mobileNumber);
      contact.googleSheetsSyncStatus = contact.googleSheetsSyncStatus === "synced" ? "pending" : contact.googleSheetsSyncStatus;
      audit(db, user, "contact.updated", "contact", contact.id, { fields: Object.keys(fields) });
      await saveDb(db);
      return send(res, 200, { contact });
    }

    if (req.method === "POST" && pathname === "/api/contacts/bulk-delete") {
      const body = await readJson(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
      if (!ids.size) return error(res, 400, "Select at least one contact to delete.");
      let deleted = 0;
      db.contacts.forEach((contact) => {
        if (contact.organisationId === user.organisationId && ids.has(contact.id) && !contact.deletedAt) {
          contact.deletedAt = now();
          deleted += 1;
        }
      });
      audit(db, user, "contacts.bulk_deleted", "contact", "", { count: deleted });
      await saveDb(db);
      return send(res, 200, { deleted });
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/contacts/")) {
      const contactId = pathname.split("/").pop();
      const contact = db.contacts.find((c) => c.id === contactId && c.organisationId === user.organisationId && !c.deletedAt);
      if (!contact) return error(res, 404, "Contact not found.");
      contact.deletedAt = now();
      audit(db, user, "contact.deleted", "contact", contact.id);
      await saveDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/export.xlsx") {
      if (!rateLimit(req, res, "export-xlsx", 60, 60 * 60 * 1000)) return;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const collectionId = url.searchParams.get("collectionId");
      const selectedIds = selectedExportIds(url);
      const exportAll = url.searchParams.get("all") === "true";
      const collection = collectionForUser(db, user, collectionId);
      const contacts = db.contacts.filter((c) =>
        c.organisationId === user.organisationId &&
        !c.deletedAt &&
        (exportAll || (selectedIds.size ? selectedIds.has(c.id) : c.collectionId === collection.id))
      );
      const rows = [EXPORT_COLUMNS, ...contacts.map((c) => exportRow(c, user))];
      const xlsx = buildXlsx(rows);
      const fileName = exportAll
        ? `All_Contacts_${new Date().toISOString().slice(0, 10)}.xlsx`
        : `${slug(collection.name)}_${collection.exhibitionDate || new Date().toISOString().slice(0, 10)}_Contacts.xlsx`;
      audit(db, user, "excel.downloaded", "collection", collection.id, { contacts: contacts.length, all: exportAll });
      await saveDb(db);
      return send(res, 200, xlsx, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`
      });
    }

    if (req.method === "GET" && pathname === "/api/export.csv") {
      if (!rateLimit(req, res, "export-csv", 60, 60 * 60 * 1000)) return;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const collectionId = url.searchParams.get("collectionId");
      const selectedIds = selectedExportIds(url);
      const exportAll = url.searchParams.get("all") === "true";
      const collection = collectionForUser(db, user, collectionId);
      const contacts = db.contacts.filter((c) =>
        c.organisationId === user.organisationId &&
        !c.deletedAt &&
        (exportAll || (selectedIds.size ? selectedIds.has(c.id) : c.collectionId === collection.id))
      );
      const rows = [EXPORT_COLUMNS, ...contacts.map((c) => exportRow(c, user))];
      const csv = buildCsv(rows);
      const fileName = exportAll
        ? `All_Contacts_${new Date().toISOString().slice(0, 10)}.csv`
        : `${slug(collection.name)}_${collection.exhibitionDate || new Date().toISOString().slice(0, 10)}_Contacts.csv`;
      audit(db, user, "csv.downloaded", "collection", collection.id, { contacts: contacts.length, all: exportAll });
      await saveDb(db);
      return send(res, 200, csv, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`
      });
    }

    if (req.method === "GET" && pathname === "/api/export.vcf") {
      if (!rateLimit(req, res, "export-vcf", 60, 60 * 60 * 1000)) return;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const collectionId = url.searchParams.get("collectionId");
      const selectedIds = selectedExportIds(url);
      const exportAll = url.searchParams.get("all") === "true";
      const assigneeId = url.searchParams.get("assigneeId") || "";
      const collection = collectionForUser(db, user, collectionId);
      if (!collection) return error(res, 404, "Collection not found.");
      let contacts = db.contacts.filter((c) =>
        c.organisationId === user.organisationId &&
        !c.deletedAt &&
        (exportAll || (selectedIds.size ? selectedIds.has(c.id) : c.collectionId === collection.id))
      );
      let assigneeLabel = "";
      if (assigneeId === "__unassigned") {
        contacts = contacts.filter((c) => !c.assignedToId);
        assigneeLabel = "Unassigned";
      } else if (assigneeId) {
        contacts = contacts.filter((c) => c.assignedToId === assigneeId);
        assigneeLabel = contacts[0]?.assignedToName || teamMembers(db.organisations.find((o) => o.id === user.organisationId)).find((m) => m.id === assigneeId)?.name || "";
      }
      const vcf = buildVcf(contacts);
      const baseName = exportAll
        ? `All_Contacts_${new Date().toISOString().slice(0, 10)}`
        : `${slug(collection.name)}_${collection.exhibitionDate || new Date().toISOString().slice(0, 10)}_Contacts`;
      const fileName = `${baseName}${assigneeLabel ? `_${slug(assigneeLabel)}` : ""}.vcf`;
      audit(db, user, "vcf.downloaded", "collection", collection.id, { contacts: contacts.length, all: exportAll, assigneeId });
      await saveDb(db);
      return send(res, 200, vcf, {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`
      });
    }

    if (req.method === "GET" && pathname === "/api/audit") {
      const logs = db.auditLogs.filter((a) => a.organisationId === user.organisationId).slice(0, 80);
      return send(res, 200, { logs });
    }

    if (req.method === "POST" && pathname === "/api/google/disconnect") {
      const connection = activeGoogleConnection(db, user);
      if (connection) {
        const refreshToken = decryptSecret(connection.encryptedRefreshToken);
        connection.status = "disconnected";
        connection.encryptedToken = "";
        connection.encryptedRefreshToken = "";
        connection.tokenExpiry = "";
        connection.updatedAt = now();
        if (refreshToken) {
          fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: "POST" }).catch(() => {});
        }
        audit(db, user, "google.disconnected", "google_connection", connection.id);
      }
      await saveDb(db);
      return send(res, 200, { ok: true, google: googleStatus(db, user) });
    }

    if (req.method === "DELETE" && pathname === "/api/account") {
      const organisationId = user.organisationId;
      const organisationUserIds = new Set(db.users.filter((item) => item.organisationId === organisationId).map((item) => item.id));
      const organisationContactIds = new Set(db.contacts.filter((item) => item.organisationId === organisationId).map((item) => item.id));
      const storedFiles = [
        ...db.cards.filter((card) => card.organisationId === organisationId).map((card) => card.storagePath),
        ...db.cards.filter((card) => card.organisationId === organisationId).map((card) => card.backStoragePath),
        ...db.voiceNotes.filter((note) => note.organisationId === organisationId).map((note) => note.audioPath)
      ].filter(Boolean);
      for (const filePath of storedFiles) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {
          console.error("Unable to delete private account file:", err.message);
        }
      }
      db.sessions = db.sessions.filter((session) => !organisationUserIds.has(session.userId));
      db.syncRecords = db.syncRecords.filter((record) => !organisationContactIds.has(record.contactId));
      db.sheetConfigurations = db.sheetConfigurations.filter((item) => item.organisationId !== organisationId);
      db.googleConnections = db.googleConnections.filter((item) => item.organisationId !== organisationId);
      db.voiceNotes = db.voiceNotes.filter((item) => item.organisationId !== organisationId);
      db.contacts = db.contacts.filter((item) => item.organisationId !== organisationId);
      db.cards = db.cards.filter((item) => item.organisationId !== organisationId);
      db.uploadBatches = db.uploadBatches.filter((item) => item.organisationId !== organisationId);
      db.collections = db.collections.filter((item) => item.organisationId !== organisationId);
      db.auditLogs = db.auditLogs.filter((item) => item.organisationId !== organisationId);
      db.users = db.users.filter((item) => item.organisationId !== organisationId);
      db.organisations = db.organisations.filter((item) => item.id !== organisationId);
      await saveDb(db);
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
    }

    if (req.method === "POST" && pathname === "/api/google/create-sheet") {
      const body = await readJson(req);
      const collection = collectionForUser(db, user, body.collectionId);
      if (!googleConfigured()) return error(res, 400, "Add Google OAuth credentials before creating a Google Sheet.");
      const connection = activeGoogleConnection(db, user);
      if (!connection) return error(res, 400, "Connect Google Sheets before creating a sheet.");
      const accessToken = await googleAccessToken(db, user, GOOGLE_SHEETS_SCOPE);
      const title = String(body.sheetName || collection.destinationName || `${collection.name} Contacts`).trim();
      const spreadsheet = await createGoogleSpreadsheet(accessToken, title);
      await writeGoogleHeaders(accessToken, spreadsheet.spreadsheetId);
      collection.destinationType = "google";
      collection.destinationName = title;
      collection.spreadsheetId = spreadsheet.spreadsheetId;
      collection.worksheetId = spreadsheet.worksheetId;
      collection.spreadsheetUrl = spreadsheet.spreadsheetUrl;
      collection.nextSheetRow = 2;
      collection.updatedAt = now();
      let sheetConfiguration = db.sheetConfigurations.find((s) => s.spreadsheetId === collection.spreadsheetId);
      if (!sheetConfiguration) {
        sheetConfiguration = {
          id: id("shc"),
          organisationId: user.organisationId,
          createdAt: now()
        };
        db.sheetConfigurations.unshift(sheetConfiguration);
      }
      Object.assign(sheetConfiguration, {
        connectionId: connection.id,
        spreadsheetId: collection.spreadsheetId,
        worksheetId: collection.worksheetId,
        fieldMapping: Object.fromEntries(EXPORT_COLUMNS.map((column) => [column, column])),
        syncMode: "manual",
        status: "active",
        updatedAt: now()
      });
      audit(db, user, "google.sheet_created", "collection", collection.id, { spreadsheetId: collection.spreadsheetId, title });
      const syncResult = await syncCollectionToGoogle(db, user, collection);
      await saveDb(db);
      return send(res, 201, { collection, sheetConfiguration, sync: syncResult, google: googleStatus(db, user) });
    }

    if (req.method === "POST" && pathname === "/api/google/configure") {
      const body = await readJson(req);
      const collection = collectionForUser(db, user, body.collectionId);
      collection.destinationType = "google";
      collection.destinationName = body.sheetName || "Google Sheet";
      collection.spreadsheetId = body.spreadsheetId || "";
      collection.worksheetId = body.worksheetId || "";
      collection.nextSheetRow = Math.max(2, Number(body.nextSheetRow || collection.nextSheetRow || 2));
      collection.updatedAt = now();
      audit(db, user, "google.destination_configured", "collection", collection.id, { spreadsheetId: collection.spreadsheetId ? "set" : "missing" });
      await saveDb(db);
      return send(res, 200, { collection, google: googleStatus(db, user) });
    }

    if (req.method === "POST" && pathname === "/api/google/sync") {
      const body = await readJson(req);
      const collection = collectionForUser(db, user, body.collectionId);
      const result = await syncCollectionToGoogle(db, user, collection);
      audit(db, user, "google.synced", "collection", collection.id, result);
      await saveDb(db);
      return send(res, 200, {
        status: result.failed ? "partial" : "synced",
        ...result,
        message: result.failed
          ? `${result.synced} contact(s) synced. ${result.failed} contact(s) failed and remain marked for review.`
          : `${result.synced} contact(s) synced to Google Sheets.`
      });
    }

    if (req.method === "POST" && pathname === "/api/google/contacts/sync") {
      const body = await readJson(req);
      const requestedIds = new Set(Array.isArray(body.contactIds) ? body.contactIds.map(String) : []);
      const collectionId = String(body.collectionId || "");
      const collection = collectionId ? collectionForUser(db, user, collectionId) : null;
      const contacts = db.contacts.filter((contact) =>
        contact.organisationId === user.organisationId
        && !contact.deletedAt
        && (!collectionId || contact.collectionId === collectionId)
        && (!requestedIds.size || requestedIds.has(contact.id))
      );
      if (!contacts.length) return error(res, 400, "Choose at least one saved contact to sync.");
      const accessToken = await googleAccessToken(db, user, GOOGLE_CONTACTS_SCOPE);
      const fallbackExhibitionName = String(
        body.exhibitionName || collection?.exhibitionName || collection?.name || ""
      ).trim();
      const fallbackExhibitionDate = String(
        body.exhibitionDate || collection?.exhibitionDate || ""
      ).trim();
      const exhibitionGroups = new Map();
      const labels = new Set();
      let synced = 0;
      const failures = [];
      // Google recommends sequential mutations for one account.
      for (const contact of contacts) {
        try {
          if (!contact.exhibitionName && fallbackExhibitionName) contact.exhibitionName = fallbackExhibitionName;
          if (!contact.exhibitionDate && fallbackExhibitionDate) contact.exhibitionDate = fallbackExhibitionDate;
          if (!contact.exhibitionName || !contact.exhibitionDate) {
            throw new Error("Add the exhibition name and date before importing this contact.");
          }
          const groupName = googleContactGroupLabel(contact.exhibitionName, contact.exhibitionDate);
          labels.add(groupName);
          let groupResourceName = exhibitionGroups.get(groupName);
          if (!groupResourceName) {
            groupResourceName = await ensureGoogleContactGroup(accessToken, groupName);
            exhibitionGroups.set(groupName, groupResourceName);
          }
          const person = await syncContactToGooglePeople(accessToken, contact);
          await addGoogleContactToGroup(accessToken, groupResourceName, person.resourceName);
          contact.googlePeopleResourceName = person.resourceName;
          contact.googlePeopleEtag = person.etag || "";
          contact.googleContactsSyncStatus = "synced";
          contact.googleContactsSyncedAt = now();
          contact.updatedAt = now();
          synced += 1;
        } catch (syncError) {
          contact.googleContactsSyncStatus = "failed";
          contact.googleContactsSyncError = syncError.message;
          failures.push({ contactId: contact.id, contactName: contact.name, message: syncError.message });
        }
      }
      audit(db, user, "google.contacts_synced", "contact", collectionId || "selected", {
        requested: contacts.length,
        synced,
        failed: failures.length
      });
      await saveDb(db);
      return send(res, 200, {
        synced,
        failed: failures.length,
        failures,
        label: labels.size === 1 ? [...labels][0] : "multiple exhibition labels",
        message: failures.length
          ? `${synced} contact(s) synced. ${failures.length} could not be synced.`
          : `${synced} contact(s) added to Google Contacts.`
      });
    }

    return error(res, 404, "Not found.");
  } catch (err) {
    console.error(err);
    return error(res, 500, err.message || "Something went wrong.");
  }
}

async function createSession(req, res, db, user, redirectTo = "", extraCookies = []) {
  const session = {
    id: id("ses"),
    userId: user.id,
    csrfToken: randomToken("csrf"),
    createdAt: now(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };
  db.sessions.push(session);
  await saveDb(db);
  const cookies = [sessionCookie(req, signSession(session.id), 7 * 24 * 60 * 60), ...extraCookies];
  if (redirectTo) {
    res.writeHead(302, { Location: redirectTo, "Set-Cookie": cookies });
    return res.end();
  }
  send(res, 200, { user: publicUser(user), csrfToken: session.csrfToken }, { "Set-Cookie": cookies });
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, organisationId: user.organisationId };
}

function createCollectionFromUpload(db, user, body) {
  db.collections.forEach((c) => {
    if (c.organisationId === user.organisationId) {
      c.status = "archived";
      c.updatedAt = now();
    }
  });
  const destinationType = body.destinationType || "excel";
  const collectionName = String(body.collectionName || body.exhibitionName || "New Sheet").trim();
  const collection = {
    id: id("col"),
    organisationId: user.organisationId,
    name: collectionName,
    exhibitionName: String(body.exhibitionName || collectionName).trim(),
    exhibitionDate: String(body.exhibitionDate || ""),
    destinationType,
    destinationName: body.destinationName || defaultDestinationName(destinationType, collectionName),
    savedContactCount: 0,
    nextSheetRow: 2,
    status: "active",
    createdAt: now(),
    updatedAt: now()
  };
  db.collections.push(collection);
  audit(db, user, "collection.created", "collection", collection.id);
  return collection;
}

function defaultDestinationName(destinationType, collectionName) {
  if (destinationType === "google") return `${collectionName} Contacts`;
  if (destinationType === "worksheet") return `${collectionName} worksheet`;
  return `${collectionName} Excel/CSV`;
}

function publicCard(card) {
  return {
    id: card.id,
    collectionId: card.collectionId,
    batchId: card.batchId,
    originalFileName: card.originalFileName,
    storageUrl: card.storageUrl,
    backStorageUrl: card.backStoragePath ? `/api/cards/${card.id}/back-image` : "",
    fileSize: card.fileSize,
    status: card.status,
    extraction: card.extraction,
    duplicateImageOf: card.duplicateImageOf,
    pairMode: card.pairMode || "",
    frontFileName: card.frontFileName || "",
    backFileName: card.backFileName || "",
    createdAt: card.createdAt
  };
}

function publicVoiceNote(note) {
  return {
    id: note.id,
    targetType: note.targetType,
    targetIds: note.targetIds || [],
    transcript: note.transcript || "",
    language: note.language || "",
    interest: note.interest || "",
    specialRequirement: note.specialRequirement || "",
    budget: note.budget || "",
    followUpDate: note.followUpDate || "",
    summary: note.summary || "",
    status: note.status || "draft",
    provider: note.provider || "",
    audioUrl: `/api/voice-notes/${note.id}/audio`,
    createdAt: note.createdAt,
    appliedAt: note.appliedAt || ""
  };
}

function validateContact(fields) {
  const normalizedFields = normalizePhoneFields(fields);
  const name = String(normalizedFields.name || "").trim();
  const mobileNumber = String(normalizedFields.mobileNumber || "").trim();
  if (!name && !mobileNumber) {
    return { ok: false, code: "missing_name_mobile", message: "Name and mobile number are required before this contact can be saved." };
  }
  if (!name) return { ok: false, code: "missing_name", message: "Name is required. Please enter the contact's name before saving." };
  if (!mobileNumber) return { ok: false, code: "missing_mobile", message: "Mobile number is required. Please enter a valid mobile number before saving." };
  if (!isValidMobile(mobileNumber)) return { ok: false, code: "invalid_mobile", message: "Mobile number is required. Please enter a valid mobile number before saving." };
  if (normalizedFields.secondaryMobileNumber && !splitPhoneValues(normalizedFields.secondaryMobileNumber).every(isValidMobile)) {
    return { ok: false, code: "invalid_secondaryMobileNumber", message: "Secondary mobile number looks invalid. Please correct it or leave it blank." };
  }
  if (normalizedFields.officeNumber && !isValidOfficePhone(normalizedFields.officeNumber)) {
    return { ok: false, code: "invalid_officeNumber", message: "Office number looks invalid. Please correct it or leave it blank." };
  }
  for (const field of ["emailAddress", "secondaryEmail"]) {
    if (normalizedFields[field] && !isValidEmail(normalizedFields[field])) {
      return { ok: false, code: `invalid_${field}`, message: `${fieldLabelsForServer(field)} looks invalid. Please correct it or leave it blank.` };
    }
  }
  if (normalizedFields.website && !isLikelyWebsite(normalizedFields.website)) {
    return { ok: false, code: "invalid_website", message: "Website looks invalid. Use a domain like example.com or a full https URL." };
  }
  if (normalizedFields.linkedInUrl && !isLikelyLinkedIn(normalizedFields.linkedInUrl)) {
    return { ok: false, code: "invalid_linkedin", message: "LinkedIn URL looks invalid. Please correct it or leave it blank." };
  }
  return { ok: true };
}

function cleanContactFields(fields) {
  const normalizedFields = normalizePhoneFields(fields);
  const cleaned = {
    name: String(normalizedFields.name || "").trim(),
    mobileNumber: normalizedFields.mobileNumber
  };
  for (const field of OPTIONAL_FIELDS) cleaned[field] = String(normalizedFields[field] || "").trim();
  if (cleaned.website) cleaned.website = normalizeUrl(cleaned.website);
  if (cleaned.linkedInUrl) cleaned.linkedInUrl = normalizeUrl(cleaned.linkedInUrl);
  cleaned.city = toTitleCase(cleaned.city);
  cleaned.state = toTitleCase(cleaned.state) || (cleaned.city ? inferStateFromCity(cleaned.city) : "");
  return cleaned;
}

function isValidOfficePhone(value) {
  const values = splitPhoneValues(value);
  if (!values.length) return true;
  return values.every((part, index) => {
    const digits = String(part).replace(/\D/g, "");
    return digits.length >= (index === 0 ? 6 : 3) && digits.length <= 16;
  });
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(value || "").trim());
}

function isLikelyWebsite(value) {
  const normalized = normalizeUrl(value);
  try {
    const url = new URL(normalized);
    return ["http:", "https:"].includes(url.protocol) && /\./.test(url.hostname);
  } catch {
    return false;
  }
}

function isLikelyLinkedIn(value) {
  const normalized = normalizeUrl(value);
  try {
    const url = new URL(normalized);
    return /(^|\.)linkedin\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function fieldLabelsForServer(field) {
  return {
    secondaryMobileNumber: "Secondary mobile number",
    officeNumber: "Office number",
    emailAddress: "Email address",
    secondaryEmail: "Secondary email"
  }[field] || field;
}

async function saveContactFromFields(res, db, user, card, fields) {
  const validation = validateContact(fields);
  if (!validation.ok) return error(res, 400, validation.message, validation);

  const cleaned = cleanContactFields(fields);
  const normalizedMobileNumber = normalizeMobile(cleaned.mobileNumber);
  const duplicate = db.contacts.find((c) =>
    c.organisationId === user.organisationId &&
    !c.deletedAt &&
    c.normalizedMobileNumber === normalizedMobileNumber
  );
  if (duplicate && !fields.duplicateAction) {
    return send(res, 409, {
      error: "A contact with this mobile number already exists.",
      duplicate,
      actions: ["skip", "update_existing", "keep_both", "merge_information"]
    });
  }

  if (duplicate && ["update_existing", "merge_information"].includes(fields.duplicateAction)) {
    Object.assign(duplicate, cleaned, {
      updatedAt: now(),
      updatedBy: user.id,
      reviewStatus: "Reviewed",
      googleSheetsSyncStatus: duplicate.googleSheetsSyncStatus === "synced" ? "pending" : duplicate.googleSheetsSyncStatus
    });
    card.status = "saved";
    audit(db, user, "contact.updated_from_duplicate", "contact", duplicate.id, { cardId: card.id });
    await saveDb(db);
    return send(res, 200, { contact: duplicate, updatedExisting: true });
  }

  if (duplicate && fields.duplicateAction === "skip") {
    card.status = "skipped_duplicate";
    audit(db, user, "contact.skipped_duplicate", "card", card.id, { duplicateContactId: duplicate.id });
    await saveDb(db);
    return send(res, 200, { skipped: true, duplicate });
  }

  const saved = saveContactRecord(db, user, card, cleaned, { allowDuplicate: fields.duplicateAction === "keep_both" });
  if (!saved.ok) return error(res, 400, saved.message, { code: saved.code });
  await saveDb(db);
  return send(res, 201, { contact: saved.contact });
}

function saveContactRecord(db, user, card, fields, options = {}) {
  const validation = validateContact(fields);
  if (!validation.ok) return validation;
  const cleaned = cleanContactFields(fields);
  const normalizedMobileNumber = normalizeMobile(cleaned.mobileNumber);
  const duplicate = db.contacts.find((c) =>
    c.organisationId === user.organisationId &&
    !c.deletedAt &&
    c.normalizedMobileNumber === normalizedMobileNumber
  );
  if (duplicate && !options.allowDuplicate) {
    return { ok: false, code: "duplicate", message: "A saved contact already has this mobile number. Review this card manually." };
  }
  const collection = collectionForUser(db, user, card.collectionId);
  const contact = {
    id: id("con"),
    organisationId: user.organisationId,
    ownerId: user.id,
    collectionId: collection.id,
    sourceCardId: card.id,
    source: card.pairMode === "front-back" ? "Business Card Upload - Front/Back" : "Business Card Upload",
    uploadedBy: user.name,
    createdBy: user.id,
    updatedBy: user.id,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
    reviewStatus: "Reviewed",
    duplicateStatus: duplicate ? "kept_both" : "none",
    googleSheetsSyncStatus: collection.destinationType === "google" ? "pending" : "not_configured",
    extractionConfidence: card.extraction?.confidence || 0,
    cardImageReference: card.storageUrl,
    normalizedMobileNumber,
    ...cleaned,
    exhibitionName: collection.exhibitionName || cleaned.exhibitionName || "",
    exhibitionDate: collection.exhibitionDate || cleaned.exhibitionDate || ""
  };
  db.contacts.unshift(contact);
  collection.savedContactCount = db.contacts.filter((c) => c.collectionId === collection.id && !c.deletedAt).length;
  collection.nextSheetRow = 2 + collection.savedContactCount;
  collection.updatedAt = now();
  card.status = "saved";
  card.updatedAt = now();
  audit(db, user, "contact.saved", "contact", contact.id, { collectionId: collection.id, cardId: card.id });
  return { ok: true, contact };
}

function exportRow(contact) {
  return [
    contact.name,
    contact.mobileNumber,
    contact.secondaryMobileNumber,
    contact.companyName,
    contact.designation,
    contact.officeNumber,
    contact.emailAddress,
    contact.secondaryEmail,
    contact.website,
    contact.address,
    contact.city,
    contact.state,
    contact.postalCode,
    contact.country,
    contact.exhibitionName,
    contact.exhibitionDate,
    exportRemarks(contact),
    contact.tags,
    contact.createdAt
  ].map(safeSpreadsheetValue);
}

function exportRemarks(contact) {
  const notes = String(contact.notes || "").trim();
  const transcript = String(contact.voiceTranscript || "").trim();
  if (!transcript || notes.includes(transcript)) return notes || transcript;
  return [notes, transcript].filter(Boolean).join("\n\n");
}

function selectedExportIds(url) {
  return new Set(String(url.searchParams.get("ids") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
}

function googleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `http://${req.headers.host}/api/google/callback`;
}

function googleLoginRedirectUri(req) {
  return GOOGLE_AUTH_REDIRECT_URI || `${baseUrl(req)}/api/auth/google/callback`;
}

function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";

function googleScopes(feature = "sheets") {
  // drive.file limits Card2Leads to files it creates or files explicitly opened with it.
  const scopes = ["openid", "email", "profile"];
  if (feature === "sheets" || feature === "all") scopes.unshift(GOOGLE_SHEETS_SCOPE);
  if (feature === "contacts" || feature === "all") scopes.unshift(GOOGLE_CONTACTS_SCOPE);
  return scopes.join(" ");
}

function mergeGoogleScopes(...scopeValues) {
  return [...new Set(
    scopeValues
      .flatMap((value) => String(value || "").split(/\s+/))
      .filter(Boolean),
  )].join(" ");
}

function activeGoogleConnection(db, user) {
  return db.googleConnections.find((c) => c.organisationId === user.organisationId && c.status === "active") || null;
}

function googleStatus(db, user) {
  const connection = user ? activeGoogleConnection(db, user) : null;
  const scopes = connection?.scopes || "";
  return {
    configured: googleConfigured(),
    connected: Boolean(connection),
    sheetsConnected: Boolean(connection && scopes.includes(GOOGLE_SHEETS_SCOPE)),
    contactsConnected: Boolean(connection && scopes.includes(GOOGLE_CONTACTS_SCOPE)),
    googleEmail: connection?.googleEmail || "",
    needsReconnect: Boolean(connection && !scopes.includes(GOOGLE_SHEETS_SCOPE)),
    openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    extractionProvider: process.env.GEMINI_API_KEY ? "gemini" : process.env.OPENAI_API_KEY ? "openai" : "manual"
  };
}

async function exchangeGoogleCode(code, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "Google OAuth token exchange failed.");
  return data;
}

async function refreshGoogleToken(connection) {
  const refreshToken = decryptSecret(connection.encryptedRefreshToken);
  if (!refreshToken) throw new Error("Google connection has expired. Please connect Google Sheets again.");
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "Google token refresh failed.");
  connection.encryptedToken = encryptSecret(data.access_token);
  connection.tokenExpiry = new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString();
  connection.updatedAt = now();
  return data.access_token;
}

async function googleAccessToken(db, user, requiredScope = "") {
  const connection = activeGoogleConnection(db, user);
  if (!connection) throw new Error("Connect your Google account before using this feature.");
  if (requiredScope && !String(connection.scopes || "").includes(requiredScope)) {
    throw new Error(requiredScope === GOOGLE_CONTACTS_SCOPE
      ? "Connect Google Contacts before syncing contacts."
      : "Connect Google Sheets before creating or syncing a sheet.");
  }
  const expiresAt = connection.tokenExpiry ? new Date(connection.tokenExpiry).getTime() : 0;
  if (expiresAt > Date.now() + 60 * 1000) return decryptSecret(connection.encryptedToken);
  return await refreshGoogleToken(connection);
}

async function googleApi(accessToken, url, options = {}) {
  assertGoogleWritePolicy(url, options);
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error?.message || "Google request failed.");
  return data;
}

function assertGoogleWritePolicy(url, options = {}) {
  // Defense-in-depth: Card2Leads only ever creates and updates in Google. It is
  // hard-blocked from issuing ANY delete/trash call to any Google API (Drive,
  // Sheets, or Contacts), regardless of what the granted OAuth scope permits.
  const target = String(url);
  const method = String(options.method || "GET").toUpperCase();
  const deleteEndpoint = /:batchDeleteContacts|:deleteContact\b|:deleteContactPhoto|:clearValues/i.test(target);
  const trashing = /"trashed"\s*:\s*true/i.test(String(options.body || ""));
  if (method === "DELETE" || deleteEndpoint || trashing) {
    throw new Error("Card2Leads never deletes data in your Google account — it only creates and updates.");
  }
  return true;
}

function contactToGooglePerson(contact) {
  const phoneNumbers = [contact.mobileNumber, contact.secondaryMobileNumber, contact.officeNumber]
    .filter(Boolean)
    .map((value, index) => ({ value: String(value), type: index === 2 ? "work" : "mobile" }));
  const emailAddresses = [contact.emailAddress, contact.secondaryEmail]
    .filter(Boolean)
    .map((value, index) => ({ value: String(value), type: index ? "other" : "work" }));
  const urls = [
    contact.website ? { value: String(contact.website), type: "work" } : null,
    contact.linkedInUrl ? { value: String(contact.linkedInUrl), type: "profile" } : null
  ].filter(Boolean);
  const address = [contact.address, contact.city, contact.state, contact.postalCode, contact.country].filter(Boolean).join(", ");
  const remarks = exportRemarks(contact);
  const exhibitionLabel = googleContactGroupLabel(contact.exhibitionName, contact.exhibitionDate);
  return {
    names: [{ unstructuredName: googleContactDisplayName(contact) }],
    phoneNumbers,
    emailAddresses,
    organizations: [{
      name: String(contact.companyName || ""),
      title: String(contact.designation || ""),
      department: String(contact.department || "")
    }],
    addresses: address ? [{
      formattedValue: address,
      streetAddress: String(contact.address || ""),
      city: String(contact.city || ""),
      region: String(contact.state || ""),
      postalCode: String(contact.postalCode || ""),
      country: String(contact.country || ""),
      type: "work"
    }] : [],
    urls,
    biographies: remarks ? [{ value: remarks, contentType: "TEXT_PLAIN" }] : [],
    userDefined: [
      { key: "Exhibition", value: String(contact.exhibitionName || "") },
      { key: "Exhibition Date", value: String(contact.exhibitionDate || "") },
      { key: "Card2Leads Label", value: exhibitionLabel },
      { key: "Card2Leads Contact ID", value: String(contact.id || "") }
    ]
  };
}

function googleContactDisplayName(contact) {
  const name = String(contact.name || "").trim();
  const exhibitionName = String(contact.exhibitionName || "").trim();
  const dateMatch = String(contact.exhibitionDate || "").match(/^(\d{4})/);
  const year = dateMatch?.[1] || "";
  const code = year && !new RegExp(`\\b${year}\\b`).test(exhibitionName)
    ? `${exhibitionName} ${year}`.trim()
    : exhibitionName;
  if (!code) return name;
  const suffix = `[${code}]`;
  return name.toLowerCase().endsWith(suffix.toLowerCase()) ? name : `${name} ${suffix}`.trim();
}

function googleContactGroupLabel(exhibitionName, exhibitionDate) {
  const name = String(exhibitionName || "Card2Leads contacts").trim();
  const rawDate = String(exhibitionDate || "").trim();
  if (!rawDate) return name;
  const match = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return `${name} - ${rawDate}`;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(match[2]) - 1];
  return `${name} - ${Number(match[3])} ${month} ${match[1]}`;
}

async function ensureGoogleContactGroup(accessToken, groupName) {
  const list = await googleApi(accessToken, "https://people.googleapis.com/v1/contactGroups?pageSize=1000", { method: "GET" });
  const existing = (list.contactGroups || []).find((group) => String(group.name || "").toLowerCase() === groupName.toLowerCase());
  if (existing?.resourceName) return existing.resourceName;
  const created = await googleApi(accessToken, "https://people.googleapis.com/v1/contactGroups", {
    method: "POST",
    body: JSON.stringify({ contactGroup: { name: groupName } })
  });
  if (!created.resourceName) throw new Error("Google Contacts did not return the new exhibition group.");
  return created.resourceName;
}

async function fetchGooglePersonForUpdate(accessToken, resourceName, fields) {
  return googleApi(
    accessToken,
    `https://people.googleapis.com/v1/${encodeURI(resourceName)}?personFields=${encodeURIComponent(fields)}`,
    { method: "GET" }
  );
}

async function syncContactToGooglePeople(accessToken, contact) {
  const fields = "names,phoneNumbers,emailAddresses,organizations,addresses,urls,biographies,userDefined";
  if (!contact.googlePeopleResourceName) {
    return googleApi(accessToken, "https://people.googleapis.com/v1/people:createContact", {
      method: "POST",
      body: JSON.stringify(contactToGooglePerson(contact))
    });
  }

  let latest = await fetchGooglePersonForUpdate(accessToken, contact.googlePeopleResourceName, fields);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const person = contactToGooglePerson(contact);
    person.etag = latest.etag;
    try {
      return await googleApi(
        accessToken,
        `https://people.googleapis.com/v1/${encodeURI(contact.googlePeopleResourceName)}:updateContact?updatePersonFields=${encodeURIComponent(fields)}`,
        { method: "PATCH", body: JSON.stringify(person) }
      );
    } catch (error) {
      if (attempt === 0 && /etag/i.test(String(error.message || ""))) {
        latest = await fetchGooglePersonForUpdate(accessToken, contact.googlePeopleResourceName, fields);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Google Contacts changed during sync. Please retry.");
}

async function addGoogleContactToGroup(accessToken, groupResourceName, contactResourceName) {
  return googleApi(accessToken, `https://people.googleapis.com/v1/${encodeURI(groupResourceName)}/members:modify`, {
    method: "POST",
    body: JSON.stringify({ resourceNamesToAdd: [contactResourceName] })
  });
}

async function fetchGoogleProfile(accessToken) {
  try {
    return await googleApi(accessToken, "https://www.googleapis.com/oauth2/v3/userinfo", { method: "GET" });
  } catch {
    return {};
  }
}

async function createGoogleSpreadsheet(accessToken, title) {
  const spreadsheet = await googleApi(accessToken, "https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: "Contacts" } }]
    })
  });
  return {
    spreadsheetId: spreadsheet.spreadsheetId,
    worksheetId: String(spreadsheet.sheets?.[0]?.properties?.sheetId || 0),
    spreadsheetUrl: spreadsheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheet.spreadsheetId}/edit`
  };
}

async function writeGoogleHeaders(accessToken, spreadsheetId) {
  const lastColumn = columnName(EXPORT_COLUMNS.length);
  await googleApi(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Contacts!A1:${lastColumn}1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [EXPORT_COLUMNS] })
  });
}

async function validateGoogleHeaders(accessToken, spreadsheetId) {
  const data = await googleApi(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Contacts!1:1`, { method: "GET" });
  const headers = data.values?.[0] || [];
  const missing = ["Name", "Mobile Number"].filter((header) => !headers.includes(header));
  if (missing.length) {
    throw new Error(`Google Sheet is missing required header(s): ${missing.join(", ")}.`);
  }
  return headers;
}

async function rewriteGoogleContacts(accessToken, collection, contacts) {
  const lastColumn = columnName(EXPORT_COLUMNS.length);
  await googleApi(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${collection.spreadsheetId}/values/Contacts!A:ZZ:clear`, {
    method: "POST",
    body: JSON.stringify({})
  });
  await googleApi(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${collection.spreadsheetId}/values/Contacts!A1:${lastColumn}${contacts.length + 1}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ values: [EXPORT_COLUMNS, ...contacts.map(exportRow)] })
  });
}

function syncedRowFromRange(range) {
  const match = String(range || "").match(/![A-Z]+(\d+):/);
  return match ? Number(match[1]) : null;
}

async function appendGoogleContact(accessToken, collection, contact) {
  const data = await googleApi(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${collection.spreadsheetId}/values/Contacts!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [exportRow(contact)] })
  });
  return syncedRowFromRange(data.updates?.updatedRange) || collection.nextSheetRow || 2;
}

async function updateGoogleContact(accessToken, collection, contact) {
  const row = Number(contact.sheetRow);
  const lastColumn = columnName(EXPORT_COLUMNS.length);
  await googleApi(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${collection.spreadsheetId}/values/Contacts!A${row}:${lastColumn}${row}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ values: [exportRow(contact)] })
  });
  return row;
}

async function syncCollectionToGoogle(db, user, collection) {
  if (!googleConfigured()) throw new Error("Google OAuth credentials are not configured in .env.");
  if (collection.destinationType !== "google") throw new Error("This collection is not configured for Google Sheets.");
  if (!collection.spreadsheetId) throw new Error("Create the Google Sheet for this collection before syncing.");
  const accessToken = await googleAccessToken(db, user, GOOGLE_SHEETS_SCOPE);
  const contacts = db.contacts.filter((c) => c.organisationId === user.organisationId && c.collectionId === collection.id && !c.deletedAt);
  const currentHeaders = await validateGoogleHeaders(accessToken, collection.spreadsheetId);
  const schemaChanged = currentHeaders.length !== EXPORT_COLUMNS.length || EXPORT_COLUMNS.some((header, index) => currentHeaders[index] !== header);
  if (schemaChanged) {
    await rewriteGoogleContacts(accessToken, collection, contacts);
    contacts.forEach((contact, index) => {
      contact.sheetRow = index + 2;
      contact.googleSheetsSyncStatus = "synced";
      contact.lastSyncedAt = now();
      upsertSyncRecord(db, collection, contact, "synced");
    });
    collection.nextSheetRow = contacts.length + 2;
    collection.updatedAt = now();
    return { synced: contacts.length, failed: 0, nextSheetRow: collection.nextSheetRow, schemaUpdated: true };
  }
  let synced = 0;
  let failed = 0;
  for (const contact of contacts) {
    try {
      const shouldUpdate = Boolean(contact.sheetRow);
      const row = shouldUpdate
        ? await updateGoogleContact(accessToken, collection, contact)
        : await appendGoogleContact(accessToken, collection, contact);
      contact.sheetRow = row;
      contact.googleSheetsSyncStatus = "synced";
      contact.lastSyncedAt = now();
      upsertSyncRecord(db, collection, contact, "synced");
      synced += 1;
    } catch (err) {
      contact.googleSheetsSyncStatus = "failed";
      upsertSyncRecord(db, collection, contact, "failed", err.message);
      failed += 1;
    }
  }
  const nextRow = Math.max(2, ...contacts.map((c) => Number(c.sheetRow || 1))) + 1;
  collection.nextSheetRow = nextRow;
  collection.updatedAt = now();
  return { synced, failed, nextSheetRow: nextRow };
}

function upsertSyncRecord(db, collection, contact, status, syncError = "") {
  let record = db.syncRecords.find((r) => r.contactId === contact.id && r.collectionId === collection.id);
  if (!record) {
    record = {
      id: id("syn"),
      contactId: contact.id,
      collectionId: collection.id,
      sheetConfigurationId: db.sheetConfigurations.find((s) => s.spreadsheetId === collection.spreadsheetId)?.id || null,
      retryAttempts: 0,
      createdAt: now()
    };
    db.syncRecords.unshift(record);
  }
  Object.assign(record, {
    rowReference: contact.sheetRow || null,
    syncStatus: status,
    error: syncError,
    retryAttempts: status === "failed" ? Number(record.retryAttempts || 0) + 1 : Number(record.retryAttempts || 0),
    lastSyncedAt: status === "synced" ? now() : record.lastSyncedAt || null,
    updatedAt: now()
  });
}

function slug(value) {
  return String(value || "contacts").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "contacts";
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return error(res, 403, "Forbidden.");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return error(res, 404, "Not found.");
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp"
  }[path.extname(filePath)] || "application/octet-stream";
  send(res, 200, fs.readFileSync(filePath), { "Content-Type": contentType });
}

function serveIllustrationFromDirectory(res, pathname, routePrefix, directory) {
  const name = decodeURIComponent(pathname.replace(routePrefix, ""));
  const filePath = path.normalize(path.join(directory, name));
  const relativePath = path.relative(directory, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return error(res, 403, "Forbidden.");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return error(res, 404, "Illustration not found.");
  const contentType = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  send(res, 200, fs.readFileSync(filePath), { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" });
}

function serveIllustration(req, res, pathname) {
  return serveIllustrationFromDirectory(res, pathname, /^\/illustrations\//, ILLUSTRATION_DIR);
}

function serveFinalIllustration(req, res, pathname) {
  return serveIllustrationFromDirectory(res, pathname, /^\/illustrations-final\//, FINAL_ILLUSTRATION_DIR);
}

function buildCsv(rows) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return Buffer.from(`\ufeff${csv}\r\n`, "utf8");
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function vCardEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function buildVcf(contacts) {
  const cards = contacts.map((contact) => {
    const displayName = googleContactDisplayName(contact);
    const lines = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${vCardEscape(displayName)}`,
      `N:;${vCardEscape(displayName)};;;`
    ];
    if (contact.mobileNumber) lines.push(`TEL;TYPE=CELL:${vCardEscape(contact.mobileNumber)}`);
    if (contact.secondaryMobileNumber) lines.push(`TEL;TYPE=CELL:${vCardEscape(contact.secondaryMobileNumber)}`);
    if (contact.officeNumber) lines.push(`TEL;TYPE=WORK:${vCardEscape(contact.officeNumber)}`);
    if (contact.emailAddress) lines.push(`EMAIL;TYPE=INTERNET,WORK:${vCardEscape(contact.emailAddress)}`);
    if (contact.secondaryEmail) lines.push(`EMAIL;TYPE=INTERNET:${vCardEscape(contact.secondaryEmail)}`);
    if (contact.companyName) lines.push(`ORG:${vCardEscape(contact.companyName)}`);
    if (contact.designation) lines.push(`TITLE:${vCardEscape(contact.designation)}`);
    if (contact.website) lines.push(`URL:${vCardEscape(contact.website)}`);
    if ([contact.address, contact.city, contact.state, contact.postalCode, contact.country].some(Boolean)) {
      lines.push(
        `ADR;TYPE=WORK:;;${vCardEscape(contact.address)};${vCardEscape(contact.city)};${vCardEscape(contact.state)};${vCardEscape(contact.postalCode)};${vCardEscape(contact.country)}`
      );
    }
    const exhibitionLabel = googleContactGroupLabel(contact.exhibitionName, contact.exhibitionDate);
    const noteParts = [
      exportRemarks(contact),
      exhibitionLabel ? `Exhibition: ${exhibitionLabel}` : ""
    ].filter(Boolean);
    if (noteParts.length) lines.push(`NOTE:${vCardEscape(noteParts.join("\n"))}`);
    if (exhibitionLabel) lines.push(`CATEGORIES:${vCardEscape(exhibitionLabel)}`);
    lines.push(`UID:smartscan-${vCardEscape(contact.id)}`);
    lines.push("END:VCARD");
    return lines.join("\r\n");
  });
  return Buffer.from(`${cards.join("\r\n")}\r\n`, "utf8");
}

const server = http.createServer((req, res) => {
  Object.entries(securityHeaders(req)).forEach(([name, value]) => res.setHeader(name, value));
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url.pathname);
  if (url.pathname.startsWith("/illustrations-final/")) return serveFinalIllustration(req, res, url.pathname);
  if (url.pathname.startsWith("/illustrations/")) return serveIllustration(req, res, url.pathname);
  return serveStatic(req, res, url.pathname);
});

if (require.main === module) {
  validateRuntimeConfiguration();
  ensureStorage()
    .then(() => {
      // Set HOST=127.0.0.1 in production so the app is reachable only via the
      // reverse proxy (CloudPanel/nginx) and never exposed publicly on its port.
      const HOST = process.env.HOST || undefined;
      server.listen(PORT, HOST, () => {
        console.log(`Card2Leads running at http://${HOST || "localhost"}:${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Failed to initialize storage:", err);
      process.exit(1);
    });
}

function buildXlsx(rows) {
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": worksheetXml(rows)
  };
  return zipStore(files);
}

function worksheetXml(rows) {
  const body = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${columnName(c + 1)}${r + 1}`;
      const escaped = escapeXml(value);
      return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="1"' : ""}><is><t>${escaped}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="${EXPORT_COLUMNS.length}" width="22" customWidth="1"/></cols><sheetData>${body}</sheetData><autoFilter ref="A1:${columnName(EXPORT_COLUMNS.length)}${Math.max(rows.length, 1)}"/></worksheet>`;
}

function columnName(index) {
  let name = "";
  while (index > 0) {
    const rem = (index - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function escapeXml(value) {
  return String(value ?? "").replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]));
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const nameBuffer = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralParts.length, 8);
  end.writeUInt16LE(centralParts.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, end]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

module.exports = {
  EXPORT_COLUMNS,
  assertGoogleWritePolicy,
  buildCsv,
  buildVcf,
  buildXlsx,
  contactToGooglePerson,
  createCollectionFromUpload,
  deriveOverallConfidence,
  exportRemarks,
  exportRow,
  findCollectionForUser,
  googleContactDisplayName,
  googleScopes,
  normalizeExtraction,
  normalizePhoneFields,
  parseDataUrl,
  planUsage,
  repairCollectionExhibitionAssignments,
  saveContactRecord,
  validateTenantIntegrity,
  validateContact,
  validatePasswordStrength
};
