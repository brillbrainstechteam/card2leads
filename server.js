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
const REVIEW_KEEPS_SAVED_CARDS = String(process.env.REVIEW_KEEPS_SAVED_CARDS || "1") !== "0";
const VOICE_STT_PROVIDER = String(process.env.VOICE_STT_PROVIDER || "auto").toLowerCase();
const GOOGLE_STT_MODEL = process.env.GOOGLE_STT_MODEL || "latest_short";
const GOOGLE_STT_LANGUAGE_CODE = process.env.GOOGLE_STT_LANGUAGE_CODE || "hi-IN";
const GOOGLE_STT_ALTERNATIVE_LANGUAGE_CODES = process.env.GOOGLE_STT_ALTERNATIVE_LANGUAGE_CODES || "en-IN,en-US";
// Uploading a card no longer runs AI extraction inline (see the background
// queue processor below), so this cap is just a sane ceiling on one upload
// request, not a limit on how many cards a user can work through in a
// session — they can upload in several batches and everything queues up.
const MAX_BATCH_FILES = 200;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_BYTES = 150 * 1024 * 1024;
const EXTRACTION_CONCURRENCY = Math.min(10, Math.max(1, Number(process.env.EXTRACTION_CONCURRENCY || 6)));
// How many queued cards the background processor pulls per cycle. Kept at 5
// with extraction concurrency capped at 5 too, so at most 5 AI calls are ever
// in flight at once from this loop — comfortably under any reasonable
// provider rate limit even if a request-time extraction is also running.
const QUEUE_BATCH_SIZE = Math.min(24, Math.max(1, Number(process.env.QUEUE_BATCH_SIZE || 12)));
const DELETION_RETENTION_MS = Math.max(1, Number(process.env.DELETION_RETENTION_DAYS || 30)) * 24 * 60 * 60 * 1000;
const DELETION_WORKER_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.DELETION_WORKER_INTERVAL_MS || 6 * 60 * 60 * 1000));
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

// Pay-to-start (D4): new accounts get zero scan access until they subscribe.
// The single demo account is exempt — it scans without paying. Defaults to the
// team's test email so the bypass works out of the box; override with
// DEMO_ACCOUNT_EMAIL in .env (set it empty to disable the demo account).
const DEMO_ACCOUNT_EMAIL = String(process.env.DEMO_ACCOUNT_EMAIL ?? "tech@brillbrainsconsultants.com").trim().toLowerCase();
const DEMO_ACCOUNT_SCANS = Math.max(0, Number(process.env.DEMO_ACCOUNT_SCANS || 500));
// How long a login stays valid before another sign-in (kept long so SMEs — and
// phone-OTP users — aren't re-authenticating constantly).
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 30));

// WhatsApp OTP login via Meta Cloud API (existing WhatsApp Business number).
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const WHATSAPP_OTP_TEMPLATE = process.env.WHATSAPP_OTP_TEMPLATE || "";       // approved Authentication template name
const WHATSAPP_OTP_LANG = process.env.WHATSAPP_OTP_LANG || "en_US";         // template language code
const WHATSAPP_OTP_INCLUDE_BUTTON = String(process.env.WHATSAPP_OTP_INCLUDE_BUTTON ?? "true") === "true"; // standard auth templates carry a copy-code button
const DEFAULT_PHONE_COUNTRY = process.env.DEFAULT_PHONE_COUNTRY || "91";     // India
const OTP_TTL_MS = 10 * 60 * 1000; // matches the approved WhatsApp template copy
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_SENDS_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;
const otpStore = new Map(); // phone(E.164) -> { hash, expiresAt, attempts, lastSentAt, sends: number[] }

function whatsappOtpConfigured() {
  return Boolean(WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_ACCESS_TOKEN && WHATSAPP_OTP_TEMPLATE);
}

// Normalise a user-entered number to E.164 (+<country><number>), defaulting a
// bare 10-digit number to the configured country (India).
function normalizePhoneE164(raw) {
  const trimmed = String(raw || "").trim();
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits ? "+" + digits : "";
  }
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) return `+${DEFAULT_PHONE_COUNTRY}${digits}`;
  return "+" + digits;
}

function isPlausiblePhone(e164) {
  const digits = String(e164 || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function hashOtp(phone, code) {
  return crypto.createHmac("sha256", ENCRYPTION_SECRET).update(`${phone}:${code}`).digest("hex");
}

// Sends a 6-digit code via a Meta Cloud API Authentication-category template.
async function sendWhatsappOtp(phone, code) {
  const to = String(phone).replace(/^\+/, ""); // Meta expects digits only
  const components = [{ type: "body", parameters: [{ type: "text", text: code }] }];
  if (WHATSAPP_OTP_INCLUDE_BUTTON) {
    components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] });
  }
  const res = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: WHATSAPP_OTP_TEMPLATE, language: { code: WHATSAPP_OTP_LANG }, components }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `WhatsApp send failed (${res.status}).`);
  return data;
}
function isDemoEmail(email) {
  return Boolean(DEMO_ACCOUNT_EMAIL) && String(email || "").trim().toLowerCase() === DEMO_ACCOUNT_EMAIL;
}

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
// Public plan names (kept here so web and mobile render the same labels).
// monthly = Starter Pack, quarterly = Exhibition Pass, annual = Pro Annual.
const PLAN_DISPLAY_NAMES = Object.freeze({ monthly: "Starter Pack", quarterly: "Exhibition Pass", annual: "Pro Annual" });
const PLAN_PRICES_PAISE = Object.freeze({ monthly: 49900, quarterly: 89900, annual: 399900 });
const PLAN_DURATIONS_MONTHS = Object.freeze({ monthly: 1, quarterly: 3, annual: 12 });
const TOPUP_AMOUNT_PAISE = 49900; // ₹499
const TOPUP_SCANS = 200;

let dbCache = null;
let pgPool = null;
let geminiUnavailableUntil = 0;
const rateLimitBuckets = new Map();
const mobileAuthCodes = new Map();
// Sign-in hand-offs for mobile. The app generates a token before opening the
// browser and then polls /api/auth/mobile/claim for the finished session, so
// sign-in no longer depends on the easysave:// deep link reaching the app.
const mobileHandoffs = new Map();
// One-time tokens that carry a signed-in mobile user into the web checkout, so
// the browser lands on THEIR account instead of whoever was last signed in
// there. Single-use and short-lived.
const checkoutHandoffs = new Map();
// Short-lived Google OAuth state for the mobile connect flow: state -> { userId,
// feature, createdAt }. Held in memory (like otpStore/mobileAuthCodes) rather
// than on the session, because persisting it would rewrite the whole database
// on both the start and the callback of every Google connection.
const googleMobileOAuthStates = new Map();
// Browser Google-connect states. Kept in memory rather than on the session:
// storing them meant a full saveDb() on every connect, and any other request
// that saved a slightly older snapshot in the meantime wiped the state, so the
// callback failed with "connection state did not match".
const googleWebOAuthStates = new Map();

const EXPORT_COLUMNS = [
  "Saved Contact Name",
  "Name",
  "Name (Original Script)",
  "Mobile Number",
  "Country Code",
  "Phone Country",
  "WhatsApp Number",
  "Secondary Mobile Number",
  "Company Name",
  "Company Name (Original Script)",
  "Designation",
  "Office Number",
  "Email Address",
  "Secondary Email",
  "Website",
  "Address",
  "Address (Original Script)",
  "City",
  "State",
  "State Code",
  "Postal Code",
  "Country",
  "Card Language",
  "Exhibition Name",
  "Exhibition Date",
  "Remarks",
  "Voice Note",
  "Tags",
  "Message Sent",
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
  "tags",
  // Original-script values, kept alongside the Latin/transliterated ones above so
  // a Marathi/Gujarati/Telugu/Arabic card keeps exactly what was printed on it.
  "nameNative",
  "companyNameNative",
  "designationNative",
  "addressNative",
  "cityNative",
  "stateNative",
  "cardLanguage",
  "cardScript",
  // Derived on save (see applyDerivedContactFields).
  "stateCode",
  "phoneCountryCode",
  "phoneCountry",
  "whatsappNumber",
  "contactDisplayName"
];

// Two-letter codes for Indian states/UTs. Used for the "State Code" part of the
// saved-contact display name; non-Indian addresses fall back to the ISO country
// code (see stateCodeFor).
const INDIA_STATE_CODES = {
  "andhra pradesh": "AP", "arunachal pradesh": "AR", "assam": "AS", "bihar": "BR",
  "chhattisgarh": "CG", "chattisgarh": "CG", "goa": "GA", "gujarat": "GJ",
  "haryana": "HR", "himachal pradesh": "HP", "jharkhand": "JH", "karnataka": "KA",
  "kerala": "KL", "madhya pradesh": "MP", "maharashtra": "MH", "manipur": "MN",
  "meghalaya": "ML", "mizoram": "MZ", "nagaland": "NL", "odisha": "OD",
  "orissa": "OD", "punjab": "PB", "rajasthan": "RJ", "sikkim": "SK",
  "tamil nadu": "TN", "tamilnadu": "TN", "telangana": "TS", "tripura": "TR",
  "uttar pradesh": "UP", "uttarakhand": "UK", "uttaranchal": "UK",
  "west bengal": "WB", "delhi": "DL", "new delhi": "DL", "nct of delhi": "DL",
  "jammu and kashmir": "JK", "jammu & kashmir": "JK", "ladakh": "LA",
  "puducherry": "PY", "pondicherry": "PY", "chandigarh": "CH",
  "andaman and nicobar islands": "AN", "lakshadweep": "LD",
  "dadra and nagar haveli and daman and diu": "DN"
};

// Dial code -> { iso, name }. Longest prefix wins, so +971 beats +97.
const DIAL_CODES = {
  "971": { iso: "AE", name: "United Arab Emirates" }, "966": { iso: "SA", name: "Saudi Arabia" },
  "965": { iso: "KW", name: "Kuwait" }, "974": { iso: "QA", name: "Qatar" },
  "973": { iso: "BH", name: "Bahrain" }, "968": { iso: "OM", name: "Oman" },
  "972": { iso: "IL", name: "Israel" }, "962": { iso: "JO", name: "Jordan" },
  "961": { iso: "LB", name: "Lebanon" }, "98": { iso: "IR", name: "Iran" },
  "91": { iso: "IN", name: "India" }, "92": { iso: "PK", name: "Pakistan" },
  "880": { iso: "BD", name: "Bangladesh" }, "94": { iso: "LK", name: "Sri Lanka" },
  "977": { iso: "NP", name: "Nepal" }, "95": { iso: "MM", name: "Myanmar" },
  "86": { iso: "CN", name: "China" }, "852": { iso: "HK", name: "Hong Kong" },
  "886": { iso: "TW", name: "Taiwan" }, "65": { iso: "SG", name: "Singapore" },
  "66": { iso: "TH", name: "Thailand" }, "60": { iso: "MY", name: "Malaysia" },
  "62": { iso: "ID", name: "Indonesia" }, "63": { iso: "PH", name: "Philippines" },
  "84": { iso: "VN", name: "Vietnam" }, "81": { iso: "JP", name: "Japan" },
  "82": { iso: "KR", name: "South Korea" }, "44": { iso: "GB", name: "United Kingdom" },
  "49": { iso: "DE", name: "Germany" }, "33": { iso: "FR", name: "France" },
  "39": { iso: "IT", name: "Italy" }, "34": { iso: "ES", name: "Spain" },
  "31": { iso: "NL", name: "Netherlands" }, "32": { iso: "BE", name: "Belgium" },
  "41": { iso: "CH", name: "Switzerland" }, "43": { iso: "AT", name: "Austria" },
  "46": { iso: "SE", name: "Sweden" }, "47": { iso: "NO", name: "Norway" },
  "45": { iso: "DK", name: "Denmark" }, "358": { iso: "FI", name: "Finland" },
  "351": { iso: "PT", name: "Portugal" }, "30": { iso: "GR", name: "Greece" },
  "90": { iso: "TR", name: "Turkey" }, "7": { iso: "RU", name: "Russia" },
  "380": { iso: "UA", name: "Ukraine" }, "48": { iso: "PL", name: "Poland" },
  "420": { iso: "CZ", name: "Czechia" }, "36": { iso: "HU", name: "Hungary" },
  "40": { iso: "RO", name: "Romania" }, "61": { iso: "AU", name: "Australia" },
  "64": { iso: "NZ", name: "New Zealand" }, "27": { iso: "ZA", name: "South Africa" },
  "234": { iso: "NG", name: "Nigeria" }, "254": { iso: "KE", name: "Kenya" },
  "20": { iso: "EG", name: "Egypt" }, "212": { iso: "MA", name: "Morocco" },
  "216": { iso: "TN", name: "Tunisia" }, "55": { iso: "BR", name: "Brazil" },
  "52": { iso: "MX", name: "Mexico" }, "54": { iso: "AR", name: "Argentina" },
  "56": { iso: "CL", name: "Chile" }, "57": { iso: "CO", name: "Colombia" },
  "51": { iso: "PE", name: "Peru" }, "1": { iso: "US", name: "United States/Canada" }
};

const DIAL_CODE_PREFIXES = Object.keys(DIAL_CODES).sort((a, b) => b.length - a.length);

const COUNTRY_NAME_TO_ISO = {
  "india": "IN", "united arab emirates": "AE", "uae": "AE", "kuwait": "KW",
  "saudi arabia": "SA", "qatar": "QA", "bahrain": "BH", "oman": "OM",
  "singapore": "SG", "united kingdom": "GB", "uk": "GB", "usa": "US",
  "united states": "US", "china": "CN", "hong kong": "HK", "thailand": "TH",
  "malaysia": "MY", "sri lanka": "LK", "bangladesh": "BD", "nepal": "NP",
  "pakistan": "PK", "australia": "AU", "germany": "DE", "france": "FR",
  "italy": "IT", "spain": "ES", "turkey": "TR", "south africa": "ZA"
};

// Resolves the dialling country for a printed number. Indian cards very often
// omit +91 and print a bare 10-digit mobile or an 11-digit "0" trunk form, so
// those are inferred rather than left blank.
function phoneCountryInfo(rawNumber, fallbackCountry = "") {
  const raw = String(rawNumber || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { code: "", iso: "", name: "" };
  if (/^\+/.test(raw) || /^00/.test(digits)) {
    const national = digits.replace(/^00/, "");
    for (const prefix of DIAL_CODE_PREFIXES) {
      if (national.startsWith(prefix) && national.length > prefix.length) {
        const entry = DIAL_CODES[prefix];
        return { code: `+${prefix}`, iso: entry.iso, name: entry.name };
      }
    }
    return { code: "", iso: "", name: "" };
  }
  if (/^[6-9]\d{9}$/.test(digits)) return { code: "+91", iso: "IN", name: "India" };
  if (/^0[6-9]\d{9}$/.test(digits)) return { code: "+91", iso: "IN", name: "India" };
  const iso = COUNTRY_NAME_TO_ISO[String(fallbackCountry || "").trim().toLowerCase()];
  if (iso) {
    const prefix = DIAL_CODE_PREFIXES.find((p) => DIAL_CODES[p].iso === iso);
    if (prefix) return { code: `+${prefix}`, iso, name: DIAL_CODES[prefix].name };
  }
  return { code: "", iso: "", name: "" };
}

function stateCodeFor(stateName, countryName, phoneIso, cityName = "") {
  const state = String(stateName || "").trim().toLowerCase();
  if (state && INDIA_STATE_CODES[state]) return INDIA_STATE_CODES[state];
  // The state may be a district/region, or missing with only a city given.
  const resolved = String(normalizeIndianState(stateName) || inferStateFromCity(cityName) || "").toLowerCase();
  if (resolved && INDIA_STATE_CODES[resolved]) return INDIA_STATE_CODES[resolved];
  const country = String(countryName || "").trim().toLowerCase();
  const iso = COUNTRY_NAME_TO_ISO[country];
  // "IN" is never a useful state code on an Indian card — better to leave it
  // out of the saved name than to print the country where a state belongs.
  if (iso && iso !== "IN") return iso;
  if (phoneIso && phoneIso !== "IN") return phoneIso;
  return "";
}

function exhibitionWithYear(exhibitionName, exhibitionDate) {
  const name = String(exhibitionName || "").trim();
  const year = String(exhibitionDate || "").match(/^(\d{4})/)?.[1] || "";
  if (!name) return year;
  return year && !new RegExp(`\\b${year}\\b`).test(name) ? `${name} ${year}` : name;
}

// Full state name for the saved contact label: trust the printed state when it
// is already a real Indian state, otherwise map a district/region, and finally
// fall back to inferring the state from the city when none was printed.
function resolveStateName(stateValue, cityValue) {
  const normalized = normalizeIndianState(stateValue);
  if (normalized && INDIA_STATE_CODES[normalized.toLowerCase()]) return normalized;
  const fromCity = inferStateFromCity(cityValue);
  if (fromCity) return fromCity;
  return normalized || "";
}

// "MH. IIJS 2026. Sampatlal Soni. Soni Jewellers. Amgaon"
// Order is state code, exhibition + year, person, company, city. The state code
// is the two-letter form (Maharashtra -> MH), mapped from the city when the card
// did not print a state, and falling back to the ISO country code outside India.
// The person name is the transliterated English one so it stays readable and
// searchable whatever script the card used. Company is dropped when it merely
// repeats the person name, and any unknown part is dropped rather than leaving
// an empty gap between separators.
function buildContactDisplayName(contact) {
  const person = String(contact.name || "").trim();
  const company = String(contact.companyName || "").trim();
  const sameAsPerson = company.toLowerCase() === person.toLowerCase();
  const stateCode = String(contact.stateCode || "").trim()
    || stateCodeFor(contact.state, contact.country, phoneCountryInfo(contact.mobileNumber, contact.country).iso, contact.city);
  return [
    stateCode,
    exhibitionWithYear(contact.exhibitionName, contact.exhibitionDate),
    person,
    sameAsPerson ? "" : company,
    String(contact.city || "").trim()
    // Joined without a following space so the whole label reads as one token in
    // a phone's contact list, which is where people search for it.
  ].filter(Boolean).join(".");
}

// Digits-only international form for wa.me links.
function whatsappDigits(rawNumber, fallbackCountry = "") {
  const raw = String(rawNumber || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (/^\+/.test(raw)) return digits;
  if (/^00/.test(digits)) return digits.replace(/^00/, "");
  const info = phoneCountryInfo(raw, fallbackCountry);
  if (!info.code) return digits;
  const national = digits.replace(/^0+/, "");
  const cc = info.code.replace("+", "");
  return national.startsWith(cc) && national.length > cc.length ? national : `${cc}${national}`;
}

function applyDerivedContactFields(contact) {
  const info = phoneCountryInfo(contact.mobileNumber, contact.country);
  contact.phoneCountryCode = info.code;
  contact.phoneCountry = info.name;
  contact.stateCode = stateCodeFor(contact.state, contact.country, info.iso, contact.city);
  contact.whatsappNumber = whatsappDigits(contact.whatsappNumber || contact.mobileNumber, contact.country);
  contact.contactDisplayName = buildContactDisplayName(contact);
  return contact;
}

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
      const extractionFallbacksChanged = repairStoredCardExtractionFallbacks(dbCache);
      const displayNamesChanged = repairStoredContactDisplayNames(dbCache);
      if (retentionChanged || exhibitionAssignmentsChanged || locationsChanged || extractionFallbacksChanged || displayNamesChanged) await saveDb(dbCache);
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
  const extractionFallbacksChanged = repairStoredCardExtractionFallbacks(dbCache);
  const displayNamesChanged = repairStoredContactDisplayNames(dbCache);
  if (retentionChanged || exhibitionAssignmentsChanged || locationsChanged || extractionFallbacksChanged || displayNamesChanged) await saveDb(dbCache);
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
          dateColumn(collection.exhibitionDate),
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
          dateColumn(contact.exhibitionDate),
          nullable(contact.interest),
          nullable(contact.specialRequirement),
          nullable(contact.budget),
          dateColumn(contact.followUpDate),
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
          dateColumn(note.followUpDate),
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

// Postgres `date` columns reject partial/legacy values such as "2026",
// "2026-07" or "07/2026". A single such row anywhere in db.collections /
// db.contacts / db.voiceNotes would otherwise crash saveDb — and because
// createSession() flushes the whole db, it would 500 an ordinary login. Coerce
// anything that is not a full, valid YYYY-MM-DD to NULL rather than inventing a
// date (never turn "2026" into 2026-01-01). Full ISO timestamps are accepted by
// keeping only their date part.
function dateColumn(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : iso;
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

// Background queue processor: cards uploaded via /api/uploads are saved with
// status "queued" and no AI call. This loop drains the queue continuously,
// QUEUE_BATCH_SIZE cards at a time (processed with the same extraction
// concurrency cap used everywhere else), so a large upload doesn't block the
// request and doesn't spike AI provider load. Each card only counts against
// its organisation's plan usage once it's actually processed here, and a
// card whose organisation has hit its plan limit is skipped (left queued)
// rather than failed, so it resumes automatically once the plan resets or
// is upgraded.
let queueProcessorTimer = null;
let queueProcessorRunning = false;

function scheduleQueueProcessing(delayMs = 250) {
  // A shorter request (e.g. a fresh upload) should preempt a longer idle
  // backoff that's already pending, so newly queued cards start processing
  // promptly instead of waiting out the current idle interval.
  if (queueProcessorTimer && delayMs >= queueProcessorTimer.delayMs) return;
  if (queueProcessorTimer) clearTimeout(queueProcessorTimer.handle);
  const handle = setTimeout(() => {
    queueProcessorTimer = null;
    processQueueCycle();
  }, delayMs);
  queueProcessorTimer = { handle, delayMs };
}

async function processQueueCycle() {
  if (queueProcessorRunning) return;
  queueProcessorRunning = true;
  let nextDelay = 20000;
  try {
    const snapshot = readDb();
    const queuedCards = snapshot.cards
      .filter((c) => c.status === "queued" && !c.deletedAt)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!queuedCards.length) return;

    const orgUsageClaimed = new Map();
    const toProcess = [];
    for (const card of queuedCards) {
      if (toProcess.length >= QUEUE_BATCH_SIZE) break;
      const organisation = snapshot.organisations.find((o) => o.id === card.organisationId);
      if (!organisation) continue;
      const usage = await authoritativePlanUsage(organisation);
      const claimed = orgUsageClaimed.get(organisation.id) || 0;
      if (claimed >= usage.remaining) continue;
      orgUsageClaimed.set(organisation.id, claimed + 1);
      const collection = snapshot.collections.find((c) => c.id === card.collectionId) || { exhibitionName: "", exhibitionDate: "" };
      toProcess.push({ card, collection });
    }
    if (!toProcess.length) {
      // Everything left in the queue belongs to an organisation that's
      // already at its plan limit. Check back periodically in case a plan
      // resets or a top-up is purchased, without hammering the DB.
      nextDelay = 15000;
      return;
    }

    const results = await mapWithConcurrency(toProcess, EXTRACTION_CONCURRENCY, async ({ card, collection }) => {
      // A poor-quality image never reaches the paid OCR step, so it must not
      // consume a scan credit — mark it non-billable (billable: false).
      if (card.queuedImageWarning) {
        return { cardId: card.id, extracted: makeManualReviewExtraction(card.originalFileName, collection, card.queuedImageWarning), billable: false };
      }
      try {
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
        const extracted = await extractBusinessCard(file, collection);
        // Only a scan the OCR provider actually completed counts as a credit.
        return { cardId: card.id, extracted, billable: true };
      } catch (err) {
        return { cardId: card.id, extracted: makeManualReviewExtraction(card.originalFileName, collection, `Automatic scanning failed: ${err.message}`), billable: false };
      }
    });

    // Re-read the DB right before writing results, so this long-running
    // cycle (AI calls can take several seconds) doesn't clobber changes made
    // by other requests in the meantime — only the specific cards processed
    // here are touched, applied against the freshest state available.
    const db = readDb();
    const cardsById = new Map(db.cards.map((c) => [c.id, c]));
    const orgsById = new Map(db.organisations.map((o) => [o.id, o]));
    const batchesById = new Map(db.uploadBatches.map((b) => [b.id, b]));
    const touchedBatchIds = new Set();
    const scanLogEntries = [];

    for (const { cardId, extracted, billable } of results) {
      const card = cardsById.get(cardId);
      if (!card || card.status !== "queued") continue;

      // A voice note may already have been attached while this card sat in
      // the queue (see applyVoiceFields) — preserve that instead of letting
      // the freshly extracted record wipe it out.
      const preservedFields = ["interest", "specialRequirement", "budget", "followUpDate",
        "voiceTranscript", "voiceLanguage", "voiceNoteCreatedAt", "voiceNoteId", "voiceAudioUrl", "notes"];
      const finalExtraction = { ...extracted };
      if (card.extraction) {
        for (const field of preservedFields) {
          if (card.extraction[field]) finalExtraction[field] = card.extraction[field];
        }
      }

      if (card.queuedDuplicateInBatchId) {
        finalExtraction.warnings = finalExtraction.warnings || [];
        finalExtraction.warnings.push("Duplicate image detected within this upload batch. Review before saving.");
      } else if (card.queuedDuplicateImageId) {
        finalExtraction.warnings = finalExtraction.warnings || [];
        finalExtraction.warnings.push("This image appears to have been uploaded before. Review before saving.");
      }

      // Save readable extractions automatically. Empty or unreadable cards
      // remain in Review so they never become confusing blank contacts.
      let status = "completed";

      card.extraction = finalExtraction;
      card.status = status;
      card.updatedAt = now();
      delete card.queuedImageWarning;
      delete card.queuedDuplicateInBatchId;
      delete card.queuedDuplicateImageId;

      const hasIdentity = REVIEW_KEEPS_SAVED_CARDS
        ? Boolean(isValidMobile(finalExtraction.mobileNumber) || cleanText(finalExtraction.name) || cleanText(finalExtraction.companyName))
        : Boolean(cleanText(finalExtraction.name) || cleanText(finalExtraction.companyName));
      if (!hasIdentity) {
        status = "requires_review";
        card.status = "requires_review";
        finalExtraction.warnings = [...(finalExtraction.warnings || []), REVIEW_KEEPS_SAVED_CARDS ? "Nothing could be read from this card. Retake it in better light, or fill the details in here." : "No name or company could be read. Retake a sharper photo or add the visible details before saving."];
      } else {
        // Contacts are owned by whoever uploaded the batch; the queue runs
        // detached from any request, so there's no session user to fall back on.
        const uploader = db.users.find((u) => u.id === batchesById.get(card.batchId)?.uploadedBy);
        try {
          if (!uploader) {
            status = "requires_review";
            card.status = "requires_review";
            finalExtraction.warnings = [...(finalExtraction.warnings || []), "Could not identify who uploaded this card, so it needs to be saved manually."];
          } else {
            // A card that names more than one person fans out into a contact per
            // person (same business/city/state/exhibition). This must run on the
            // automatic-save path too, otherwise multi-person cards processed via
            // the queue would collapse into a single contact.
            const people = expandCardPeople(finalExtraction);
            let anySaved = false;
            let firstFailure = null;
            for (const person of people) {
              const saved = saveContactRecord(db, uploader, card, person, { mergeDuplicate: true });
              if (saved.ok) anySaved = true;
              else if (!firstFailure) firstFailure = saved;
            }
            if (anySaved) {
              status = "saved";
            } else {
              status = "requires_review";
              card.status = "requires_review";
              finalExtraction.warnings = [...(finalExtraction.warnings || []), firstFailure?.message || "Automatic save failed."];
            }
          }
        } catch (err) {
          status = "requires_review";
          card.status = "requires_review";
          finalExtraction.warnings = [...(finalExtraction.warnings || []), `Automatic save failed: ${err.message}`];
          console.error("[queue] auto-save failed:", err.message);
        }
      }

      // Only count a scan credit when the OCR provider actually processed the
      // card (billable). Poor-quality images and failed scans are routed to
      // review without charging the client (D1: only successful scans count).
      const organisation = orgsById.get(card.organisationId);
      if (organisation && billable) {
        // The ledger is the source of truth. Legacy counters are updated only
        // for the local-JSON development fallback where PostgreSQL is absent.
        if (!pgPool) {
          organisation.scansUsed = Number(organisation.scansUsed || 0) + 1;
          organisation.scanLimit = Number(organisation.scanLimit || PLAN_LIMITS[organisation.plan] || 0);
          organisation.updatedAt = now();
        }
        const uploaderId = batchesById.get(card.batchId)?.uploadedBy || null;
        scanLogEntries.push({
          clientId: organisation.id,
          userId: uploaderId,
          referenceId: card.id,
          demo: Boolean(organisation.isDemoAccount),
          platform: card.uploadPlatform || "",
          name: (finalExtraction?.name || "").trim() || null
        });
      }

      const batch = batchesById.get(card.batchId);
      if (batch) {
        if (status === "completed" || status === "saved") batch.completedFiles += 1;
        if (status === "requires_review") batch.reviewRequiredCount += 1;
        if (card.duplicateImageOf) batch.duplicateCount += 1;
        touchedBatchIds.add(batch.id);
      }
    }

    for (const batchId of touchedBatchIds) {
      const batch = batchesById.get(batchId);
      const stillQueued = db.cards.some((c) => c.batchId === batchId && c.status === "queued" && !c.deletedAt);
      if (!stillQueued) batch.status = batch.failedFiles === batch.totalFiles ? "failed" : "completed";
    }

    // Charge before committing the card result. If the ledger write fails the
    // queue retries the card; idempotency prevents a retry charging twice.
    if (pgPool) {
      const charged = await Promise.all(scanLogEntries.map((s) => consumeUsageCredit({
        clientId: s.clientId, userId: s.userId, referenceId: s.referenceId, demo: s.demo,
        idempotencyKey: `scan:${s.referenceId}`, metadata: { demo: s.demo }
      })));
      if (charged.some((ok) => !ok)) throw new Error("A queued card no longer has an available ledger credit.");
      // Keep legacy fields synchronized for old exports and top-up carryover
      // calculations. Access checks and admin reporting never read this cache.
      scanLogEntries.forEach((scan) => {
        const organisation = orgsById.get(scan.clientId);
        if (organisation) {
          organisation.scansUsed = Number(organisation.scansUsed || 0) + 1;
          organisation.updatedAt = now();
        }
      });
    }
    await saveDb(db);
    await Promise.all(scanLogEntries.map((s) => recordProductEvent({
        name: "scan_completed", clientId: s.clientId, userId: s.userId,
        source: "queue", metadata: { cardId: s.referenceId, demo: s.demo, hasName: Boolean(s.name), platform: s.platform || "" }
      })));
    nextDelay = queuedCards.length > toProcess.length ? 200 : 3000;
  } catch (err) {
    console.error("[queue] processing cycle failed:", err.message);
    nextDelay = 15000;
  } finally {
    queueProcessorRunning = false;
    scheduleQueueProcessing(nextDelay);
  }
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

function uniqueWarnings(warnings = []) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = cleanText(warning).toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyRequiredExtractionFallbacks(extraction = {}) {
  extraction.fieldConfidence = extraction.fieldConfidence || {};
  extraction.warnings = Array.isArray(extraction.warnings) ? extraction.warnings : [];
  normalizeExtractionEmailFields(extraction);
  const normalizedPhones = normalizePhoneFields(extraction);
  extraction.mobileNumber = normalizedPhones.mobileNumber;
  extraction.secondaryMobileNumber = normalizedPhones.secondaryMobileNumber;
  extraction.officeNumber = normalizedPhones.officeNumber;
  if (extraction.secondaryMobileNumber && Number(extraction.fieldConfidence.secondaryMobileNumber || 0) === 0) {
    extraction.fieldConfidence.secondaryMobileNumber = extraction.fieldConfidence.mobileNumber || 0;
  }

  if (!cleanText(extraction.name) && cleanText(extraction.companyName)) {
    extraction.name = cleanText(extraction.companyName);
    extraction.fieldConfidence.name = extraction.fieldConfidence.companyName || 60;
  }

  if (!extraction.mobileNumber && extraction.secondaryMobileNumber) {
    const secondaryNumbers = splitPhoneValues(extraction.secondaryMobileNumber).map(normalizeMobile).filter(Boolean);
    extraction.mobileNumber = secondaryNumbers.shift() || "";
    extraction.secondaryMobileNumber = secondaryNumbers.join(" / ");
    extraction.fieldConfidence.mobileNumber = extraction.fieldConfidence.secondaryMobileNumber || 60;
  }

  if (!extraction.mobileNumber && extraction.officeNumber) {
    const officeNumbers = splitPhoneValues(extraction.officeNumber).map(normalizeMobile).filter(Boolean);
    extraction.mobileNumber = officeNumbers.shift() || "";
    extraction.officeNumber = officeNumbers.join(" / ");
    extraction.fieldConfidence.mobileNumber = extraction.fieldConfidence.officeNumber || 60;
  }

  if (extraction.name) {
    extraction.warnings = extraction.warnings.filter((warning) => !/no contact person name|name was not confidently extracted|contact(?: person)?(?:'s)? name (?:is |was )?(?:not printed|missing)/i.test(warning));
  }
  if (extraction.mobileNumber) {
    extraction.warnings = extraction.warnings.filter((warning) => !/mobile number was not confidently extracted|no (?:mobile|phone|contact) number|(?:mobile|phone|contact) number (?:is |was )?(?:not printed|missing)/i.test(warning));
  }
  extraction.warnings = uniqueWarnings(extraction.warnings);
  return extraction;
}

function normalizeExtractionEmailFields(extraction = {}) {
  const primary = cleanText(extraction.emailAddress);
  const secondary = cleanText(extraction.secondaryEmail);
  const website = cleanText(extraction.website);

  extraction.emailAddress = "";
  extraction.secondaryEmail = "";

  for (const value of [primary, secondary]) {
    if (!value) continue;
    if (isValidEmail(value)) {
      if (!extraction.emailAddress) {
        extraction.emailAddress = value;
      } else if (!extraction.secondaryEmail && value.toLowerCase() !== extraction.emailAddress.toLowerCase()) {
        extraction.secondaryEmail = value;
      }
    }
  }

  extraction.website = website;
  if (extraction.secondaryEmail && Number(extraction.fieldConfidence.secondaryEmail || 0) === 0) {
    extraction.fieldConfidence.secondaryEmail = extraction.fieldConfidence.emailAddress || 0;
  }
  return extraction;
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
  const user = db.users.find((u) => u.id === session.userId && u.status === "active") || null;
  if (!user) return null;
  // Admin enforcement: a suspended / pending-deletion / deleted workspace loses
  // access immediately, regardless of the user's own status (spec §63).
  const org = db.organisations.find((o) => o.id === user.organisationId);
  if (org && ["suspended", "pending_deletion", "deleted"].includes(org.status)) return null;
  return user;
}

function currentSession(req, db) {
  const sessionId = verifySessionCookie(parseCookies(req).session);
  if (!sessionId) return null;
  return db.sessions.find((s) => s.id === sessionId && new Date(s.expiresAt) > new Date()) || null;
}

function redirect(res, location) {
  // Chrome / Android Custom Tabs block a plain 302 to a custom scheme when there
  // was no user gesture, which leaves the in-app browser stuck on a blank page.
  // Hand those off through an HTML bridge instead (auto-attempt + tappable link).
  if (/^easysave:\/\//i.test(String(location))) return sendDeepLinkBridge(res, location);
  res.writeHead(302, { Location: location });
  res.end();
}

// Returns the app deep link as a real HTML page. The script attempts the launch
// immediately, and the button gives the user-gesture fallback that Custom Tabs
// always honours, so sign-in never dead-ends on a blank screen.
function sendDeepLinkBridge(res, deepLink, extraHeaders = {}) {
  const href = String(deepLink)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const js = JSON.stringify(String(deepLink));
  const failed = /=failed\b/i.test(String(deepLink));
  const heading = failed ? "Could not complete" : "You're signed in";
  const detail = failed
    ? "Something went wrong. Tap below to return to Card2Leads and try again."
    : "Your account is ready. Tap below to return to Card2Leads.";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Returning to Card2Leads…</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#1B2942;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
  .box{text-align:center;max-width:340px}
  .tick{width:64px;height:64px;line-height:64px;border-radius:50%;margin:0 auto 18px;
    background:#D6B25E;color:#1B2942;font-size:32px;font-weight:700}
  h1{font-size:19px;margin:0 0 8px}
  p{font-size:14px;line-height:20px;color:#C9D2E0;margin:0 0 22px}
  a{display:inline-block;background:#D6B25E;color:#1B2942;text-decoration:none;
    font-weight:700;font-size:15px;padding:14px 26px;border-radius:10px}
</style></head>
<body><div class="box">
  <div class="tick">${failed ? "!" : "&#10003;"}</div>
  <h1>${heading}</h1>
  <p>${detail}</p>
  <a id="go" href="${href}">Return to Card2Leads</a>
</div>
<script>
  (function () {
    var target = ${js};
    // Attempt the hand-off at most once per code. Without this guard the page
    // re-fires when the browser regains focus after the app opens, which
    // bounces the user between the browser and the app in a loop.
    try {
      if (sessionStorage.getItem('c2l_deeplink') === target) return;
      sessionStorage.setItem('c2l_deeplink', target);
    } catch (e) {}
    if (document.visibilityState !== 'visible') return;
    try { window.location.replace(target); } catch (e) {}
  })();
</script>
</body></html>`;
  const payload = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
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
  const invitation = type === "client-invitation";
  const subject = type === "verify-email"
    ? "Verify your Card2Leads account"
    : invitation ? "You're invited to Card2Leads" : "Reset your Card2Leads password";
  const html = `
    <p>${type === "verify-email"
      ? "Please verify your Card2Leads account."
      : invitation ? "An administrator created your Card2Leads workspace. Use this link to choose a password and accept the invitation."
        : "Use this link to reset your Card2Leads password."}</p>
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

// Generic transactional email. Reuses the same Resend/SendGrid transport as
// account email so support queries land in the same inbox pipeline. Falls back
// to a console log when no provider is configured (local/dev).
async function sendRawEmail({ to, subject, html, replyTo }) {
  if (process.env.RESEND_API_KEY) {
    const payload = { from: EMAIL_FROM, to, subject, html };
    if (replyTo) payload.reply_to = replyTo;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Email delivery failed (${response.status}).`);
    return true;
  }
  if (process.env.SENDGRID_API_KEY) {
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: EMAIL_FROM },
      subject,
      content: [{ type: "text/html", value: html }]
    };
    if (replyTo) payload.reply_to = { email: replyTo };
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Email delivery failed (${response.status}).`);
    return true;
  }
  console.log(`[support] ${EMAIL_FROM} -> ${to}: ${subject}\n${html}`);
  return false;
}

// Inbox that receives in-app support queries. Every message is prefixed with
// "Card2Leads Query" in the subject so it can be filtered in the mailbox.
const SUPPORT_INBOX = process.env.SUPPORT_INBOX || "tech@brillbrainsconsultants.com";

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

function planUsage(organisation, ledgerUsage = null) {
  const plan = String(organisation?.plan || "trial").toLowerCase();
  // PostgreSQL deployments pass a ledger-derived snapshot. The legacy
  // counters remain only as a local-JSON compatibility cache and are never
  // authoritative when the usage ledger is available.
  const used = Math.max(0, Number(ledgerUsage?.used ?? organisation?.scansUsed ?? 0));
  // The demo/test account scans without limit so it's never blocked mid-test.
  if (organisation?.isDemoAccount) {
    return { plan: "demo", limit: Infinity, used, remaining: Number.MAX_SAFE_INTEGER, unlimited: true };
  }
  // Pay-to-start: everyone else needs an active paid plan; no free trial.
  // An admin-granted allowance (goodwill credits / comped plan) also unlocks
  // scanning, without being counted as a paid conversion in the funnel.
  if (!orgIsPaid(organisation) && !organisation.adminGranted) {
    return { plan, limit: 0, used, remaining: 0, requiresPayment: true };
  }
  const limit = Math.max(0, Number(ledgerUsage?.limit ?? organisation?.scanLimit ?? PLAN_LIMITS[plan] ?? 0));
  if (oneTimePlanExpired(organisation)) {
    return { plan, limit, used, remaining: 0, expired: true };
  }
  const remaining = Math.max(0, Number(ledgerUsage?.remaining ?? (limit - used)));
  return { plan, limit, used, remaining };
}

function foldLedgerRows(rows) {
  let balance = 0;
  let used = 0;
  for (const row of rows || []) {
    balance += Number(row.balance_effect || 0);
    if (row.transaction_type === "PLAN_ALLOCATION") used = 0;
    else if (row.transaction_type === "SCAN_CONSUMED") used += Math.max(0, Number(row.quantity || 0));
  }
  const remaining = Math.max(0, balance);
  return { used, remaining, limit: used + remaining, balance };
}

async function ledgerUsageForClient(clientId) {
  if (!pgPool || !clientId) return null;
  const result = await pgPool.query(
    "select transaction_type, quantity, balance_effect, created_at from usage_ledger where client_id = $1 order by created_at, id",
    [clientId]
  );
  return foldLedgerRows(result.rows);
}

async function ledgerUsageMap(clientIds) {
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  if (!pgPool || !ids.length) return new Map();
  const result = await pgPool.query(
    "select client_id, transaction_type, quantity, balance_effect, created_at from usage_ledger where client_id = any($1::text[]) order by created_at, id",
    [ids]
  );
  const rowsByClient = new Map(ids.map((clientId) => [clientId, []]));
  result.rows.forEach((row) => rowsByClient.get(row.client_id)?.push(row));
  return new Map(ids.map((clientId) => [clientId, foldLedgerRows(rowsByClient.get(clientId))]));
}

async function authoritativePlanUsage(organisation) {
  if (!organisation) return planUsage(organisation);
  const ledgerUsage = await ledgerUsageForClient(organisation.id);
  return planUsage(organisation, ledgerUsage);
}

// User-facing reason a scan is blocked, based on a planUsage() result.
function scanBlockedMessage(usage) {
  if (usage?.requiresPayment) return "Activate a plan to start scanning your cards. Head to Account to choose a plan.";
  if (usage?.expired) return "Your plan has expired. Renew it to continue scanning.";
  return "You've used all your scans for this period. Add scan credits or upgrade to continue.";
}

function billingConfigured() {
  return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + Number(months || 0));
  return next;
}

function oneTimePlanExpired(organisation) {
  if (String(organisation?.billingMode || "") !== "one_time") return false;
  const expiresAt = new Date(organisation?.currentPeriodEnd || 0).getTime();
  return Boolean(expiresAt && expiresAt <= Date.now());
}

function remainingTopupScans(organisation) {
  const purchased = Math.max(0, Number(organisation?.topupScans || 0));
  const plan = String(organisation?.plan || "trial").toLowerCase();
  const baseLimit = Number(PLAN_LIMITS[plan] || PLAN_LIMITS.trial);
  const usedBeyondPlan = Math.max(0, Number(organisation?.scansUsed || 0) - baseLimit);
  return Math.max(0, purchased - usedBeyondPlan);
}

function canPurchaseTopup(organisation) {
  const plan = String(organisation?.plan || "trial").toLowerCase();
  if (plan === "trial") return false;
  if (oneTimePlanExpired(organisation)) return false;
  const mode = String(organisation?.billingMode || "");
  const status = String(organisation?.subscriptionStatus || "").toLowerCase();
  if (mode === "one_time") return status === "paid_once";
  if (mode === "subscription" || organisation?.subscriptionId) return status === "active";
  return ["active", "paid_once"].includes(status);
}

function topupUnavailableReason(organisation) {
  if (String(organisation?.plan || "trial").toLowerCase() === "trial") return "Choose and activate a paid plan before adding extra scans.";
  if (oneTimePlanExpired(organisation)) return "Renew your expired plan before adding extra scans.";
  return "Your paid plan must be active before adding extra scans.";
}

function oneTimePlanOptions() {
  return Object.keys(PLAN_DURATIONS_MONTHS).map((plan) => ({
    plan,
    name: PLAN_DISPLAY_NAMES[plan] || plan,
    months: PLAN_DURATIONS_MONTHS[plan],
    scans: PLAN_LIMITS[plan],
    amount: PLAN_PRICES_PAISE[plan] / 100
  }));
}

function billingSummary(organisation) {
  const expired = oneTimePlanExpired(organisation);
  const topupAllowed = canPurchaseTopup(organisation);
  return {
    configured: billingConfigured(),
    plan: String(organisation?.plan || "trial"),
    mode: organisation?.billingMode || (organisation?.subscriptionId || organisation?.pendingSubscriptionId ? "subscription" : "trial"),
    status: expired ? "expired" : (organisation?.subscriptionStatus || (String(organisation?.plan || "trial") === "trial" ? "trial" : "")),
    currentPeriodEnd: organisation?.currentPeriodEnd || "",
    availablePlans: Object.keys(RAZORPAY_PLAN_IDS).filter((plan) => RAZORPAY_PLAN_IDS[plan]),
    oneTimePlans: oneTimePlanOptions(),
    topupScans: TOPUP_SCANS,
    topupAmount: TOPUP_AMOUNT_PAISE / 100,
    topupBalance: expired ? 0 : remainingTopupScans(organisation),
    canTopup: topupAllowed,
    topupUnavailableReason: topupAllowed ? "" : topupUnavailableReason(organisation)
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
// scansUsed resets to 0, and scanLimit resets to the plan's base allowance, only
// when `resetUsage` is set (a genuine new billing period) — so a duplicate or
// retried webhook for the *same* period never wipes usage or a top-up a user
// already bought mid-cycle. Top-up scans (organisation.topupScans) are tracked
// separately and are carried forward into the new period's limit rather than
// being reset, since they were purchased outright and aren't part of the plan's
// recurring allowance.
function applySubscriptionPlan(organisation, plan, { subscriptionId, currentPeriodEnd, status, resetUsage } = {}) {
  if (!organisation) return;
  const unusedTopups = remainingTopupScans(organisation);
  organisation.plan = plan;
  organisation.billingMode = "subscription";
  organisation.subscriptionPlan = plan;
  if (resetUsage || !organisation.scanLimit) {
    organisation.topupScans = unusedTopups;
    organisation.scansUsed = 0;
    organisation.scanLimit = Number(PLAN_LIMITS[plan] || PLAN_LIMITS.trial) + Number(organisation.topupScans || 0);
  }
  if (subscriptionId) organisation.subscriptionId = subscriptionId;
  organisation.subscriptionStatus = status || "active";
  if (currentPeriodEnd) organisation.currentPeriodEnd = currentPeriodEnd;
  delete organisation.pendingSubscriptionId;
  organisation.updatedAt = now();
}

function pendingOneTimeOrder(organisation, orderId) {
  const orders = Array.isArray(organisation?.pendingOneTimeOrders) ? organisation.pendingOneTimeOrders : [];
  return orders.find((order) => order.orderId === orderId) || null;
}

function pendingTopupOrder(organisation, orderId) {
  const orders = Array.isArray(organisation?.pendingTopupOrders) ? organisation.pendingTopupOrders : [];
  return orders.find((order) => order.orderId === orderId) || null;
}

function grantOneTimePlan(organisation, plan, { orderId, paymentId } = {}) {
  if (!organisation || !PLAN_DURATIONS_MONTHS[plan]) return false;
  organisation.grantedOneTimeOrders = Array.isArray(organisation.grantedOneTimeOrders) ? organisation.grantedOneTimeOrders : [];
  if (orderId && organisation.grantedOneTimeOrders.includes(orderId)) return false;
  const unusedTopups = remainingTopupScans(organisation);
  organisation.plan = plan;
  organisation.billingMode = "one_time";
  organisation.subscriptionPlan = "";
  organisation.subscriptionStatus = "paid_once";
  organisation.topupScans = unusedTopups;
  organisation.scansUsed = 0;
  organisation.scanLimit = Number(PLAN_LIMITS[plan] || PLAN_LIMITS.trial) + Number(organisation.topupScans || 0);
  organisation.currentPeriodEnd = addMonths(new Date(), PLAN_DURATIONS_MONTHS[plan]).toISOString();
  organisation.lastOneTimePaymentId = paymentId || organisation.lastOneTimePaymentId || "";
  if (orderId) {
    organisation.grantedOneTimeOrders.push(orderId);
    organisation.pendingOneTimeOrders = (organisation.pendingOneTimeOrders || []).filter((order) => order.orderId !== orderId);
  }
  organisation.updatedAt = now();
  return true;
}

function grantTopupEntitlement(organisation, scans = TOPUP_SCANS) {
  if (!organisation) return;
  organisation.topupScans = Number(organisation.topupScans || 0) + Number(scans);
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
  // Voice notes: the transcript and structured follow-up fields are kept
  // permanently, but the raw audio file is only needed transiently. Purge the
  // audio once it passes the same retention window as card images so voice
  // recordings do not accumulate unbounded storage.
  for (const note of (db.voiceNotes || [])) {
    if (note.audioPurgedAt || !note.audioPath) continue;
    const org = orgs.get(note.organisationId);
    const days = retentionDays(org?.retentionPolicy);
    const createdAt = new Date(note.createdAt || 0).getTime();
    const expired = createdAt && Date.now() - createdAt > days * 24 * 60 * 60 * 1000;
    if (expired) {
      try {
        if (fs.existsSync(note.audioPath)) fs.unlinkSync(note.audioPath);
      } catch (err) {
        console.error("Unable to purge retained voice audio:", err.message);
      }
      note.audioPurgedAt = now();
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

// Idempotently repairs review cards created before required-field fallbacks and
// warning deduplication were applied during extraction.
// The saved-contact label is derived on save, so a change to its format would
// otherwise reach exports and Google immediately (they rebuild it) while the
// stored copy the app lists stayed on the old one. Re-derive any that drifted.
function repairStoredContactDisplayNames(db) {
  let changed = false;
  for (const contact of db.contacts) {
    if (contact.deletedAt) continue;
    const rebuilt = buildContactDisplayName(contact);
    if (rebuilt && rebuilt !== contact.contactDisplayName) {
      contact.contactDisplayName = rebuilt;
      changed = true;
    }
  }
  return changed;
}

function repairStoredCardExtractionFallbacks(db) {
  let changed = false;
  for (const card of db.cards) {
    if (!card.extraction || card.deletedAt || ["saved", "deleted", "skipped", "skipped_duplicate"].includes(card.status)) continue;
    const before = JSON.stringify(card.extraction);
    applyRequiredExtractionFallbacks(card.extraction);
    if (before === JSON.stringify(card.extraction)) continue;
    if (card.extraction.name && isValidMobile(card.extraction.mobileNumber) && !card.duplicateImageOf && card.status === "requires_review") {
      card.status = "completed";
    }
    card.updatedAt = now();
    changed = true;
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
    "Name and mobileNumber are critical fields.",
    // Multilingual handling. Cards are frequently Marathi, Hindi, Gujarati,
    // Telugu, Tamil, Kannada, Bengali, Punjabi or Arabic — often mixed with
    // English on the same card.
    "Cards may be written in any language or script, including Devanagari (Hindi/Marathi), Gujarati, Telugu, Tamil, Kannada, Malayalam, Bengali, Punjabi, Odia, Arabic, Chinese, Japanese, Korean, Thai or Cyrillic.",
    "For every card, fill BOTH sets of fields:",
    "1) name, companyName, designation, address, city and state must ALWAYS be in Latin script (English). If the card prints them in another script, transliterate the sound into Latin letters (for example Devanagari 'रितेश ज्वेलर्स' becomes 'Ritesh Jewellers', Gujarati 'શ્રી આભૂષણ જ્વેલર્સ' becomes 'Shree Aabhushan Jewellers', Arabic 'فيكي بافناني' becomes 'Vicky Bhavnani'). Translate descriptive business words such as 'ज्वेलर्स' to 'Jewellers'. Never leave these fields in a non-Latin script.",
    "2) nameNative, companyNameNative, designationNative, addressNative, cityNative and stateNative must contain the exact original text as printed on the card, in its original script, with no transliteration. Leave them blank when the card is already in Latin script.",
    "If the card shows the same information in two scripts (common on Arabic and Indian cards), use the Latin version for the Latin fields and the non-Latin version for the Native fields — do not treat them as two different people or companies.",
    "Set cardLanguage to the English name of the main non-English language on the card (for example 'Marathi', 'Gujarati', 'Telugu', 'Hindi', 'Arabic'), or 'English' when the card is entirely in English.",
    "Set cardScript to the script name (for example 'Devanagari', 'Gujarati', 'Telugu', 'Arabic', 'Latin').",
    "Write phone numbers, emails and websites using Western digits and Latin letters even when the card prints them in another numeral system.",
    "Keep the country dial code in mobileNumber when the card shows one (for example '+971 555805118'). Do not add a dial code that is not printed on the card.",
    "If the card shows a WhatsApp number or a WhatsApp icon next to a number, put that number in whatsappNumber. Leave it blank if no number is specifically marked as WhatsApp."
  ].join(" ");
}

function extractionUserPrompt() {
  return `Extract this business card into this JSON shape:
{
  "name": "",
  "nameNative": "",
  "mobileNumber": "",
  "whatsappNumber": "",
  "secondaryName": "",
  "secondaryMobileNumber": "",
  "tertiaryName": "",
  "tertiaryMobileNumber": "",
  "companyName": "",
  "companyNameNative": "",
  "designation": "",
  "designationNative": "",
  "officeNumber": "",
  "emailAddress": "",
  "secondaryEmail": "",
  "website": "",
  "address": "",
  "addressNative": "",
  "city": "",
  "cityNative": "",
  "state": "",
  "stateNative": "",
  "postalCode": "",
  "country": "",
  "cardLanguage": "",
  "cardScript": "",
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
- If no contact person's name is printed but a company name is visible, use the company name for both name and companyName. Do not leave name blank in this case.
- Use the primary mobile/cell number for mobileNumber.
- If mobileNumber would otherwise be blank but any valid contact, telephone, office, or secondary number is visible, put the most prominent number in mobileNumber and keep any remaining numbers in their appropriate secondary or office fields.
- When two mobile numbers are separated by a slash or similar divider, put the first in mobileNumber and the second in secondaryMobileNumber. Never combine two mobile numbers in mobileNumber.
- If the card lists more than one person (for example two names, each with their own number), put the most prominent person in name/mobileNumber, the next person in secondaryName/secondaryMobileNumber, and a third person in tertiaryName/tertiaryMobileNumber. Only name is mandatory — leave secondaryName, tertiaryName and their numbers blank when there is only one person. Do not add a warning about multiple people when you have captured them in these fields.
- Keep phone numbers exactly as visible when uncertain.
- Put landline/office numbers in officeNumber.
- If an office number contains a slash-separated alternate number or extension, preserve both in officeNumber separated by " / ".
- Only put values containing "@" in emailAddress or secondaryEmail. Put domains and URLs without "@" in website, not in email fields.
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
    // Original-script values, preserved exactly as printed (no title-casing —
    // it would corrupt Devanagari/Gujarati/Arabic text).
    nameNative: cleanText(raw.nameNative),
    companyNameNative: cleanText(raw.companyNameNative),
    designationNative: cleanText(raw.designationNative),
    addressNative: cleanText(raw.addressNative),
    cityNative: cleanText(raw.cityNative),
    stateNative: cleanText(raw.stateNative),
    cardLanguage: cleanText(raw.cardLanguage),
    cardScript: cleanText(raw.cardScript),
    whatsappNumber: cleanText(raw.whatsappNumber),
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

  applyRequiredExtractionFallbacks(extraction);

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
  extraction.warnings = uniqueWarnings(extraction.warnings);
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
  vapi: "Gujarat", ankleshwar: "Gujarat", morbi: "Gujarat",
  // Smaller trade towns seen on real exhibition cards. The big-city list above
  // misses these, which left the state blank and the state code falling back
  // to the country.
  amravati: "Maharashtra", gondia: "Maharashtra", amgaon: "Maharashtra",
  akola: "Maharashtra", jalgaon: "Maharashtra", latur: "Maharashtra", nanded: "Maharashtra",
  ahmednagar: "Maharashtra", satara: "Maharashtra", sangli: "Maharashtra", chandrapur: "Maharashtra",
  wardha: "Maharashtra", yavatmal: "Maharashtra", beed: "Maharashtra", parbhani: "Maharashtra",
  dhule: "Maharashtra", ratnagiri: "Maharashtra", ichalkaranji: "Maharashtra", bhiwandi: "Maharashtra",
  vasai: "Maharashtra", virar: "Maharashtra", panvel: "Maharashtra", kalyan: "Maharashtra", dombivli: "Maharashtra",
  bhachau: "Gujarat", bhuj: "Gujarat", gandhidham: "Gujarat", adipur: "Gujarat", anjar: "Gujarat",
  mundra: "Gujarat", nadiad: "Gujarat", bharuch: "Gujarat", navsari: "Gujarat", valsad: "Gujarat",
  mehsana: "Gujarat", palanpur: "Gujarat", patan: "Gujarat", junagadh: "Gujarat", porbandar: "Gujarat",
  veraval: "Gujarat", amreli: "Gujarat", botad: "Gujarat", surendranagar: "Gujarat", godhra: "Gujarat",
  himatnagar: "Gujarat", deesa: "Gujarat", jetpur: "Gujarat", gondal: "Gujarat", dhoraji: "Gujarat",
  saraipali: "Chhattisgarh", mahasamund: "Chhattisgarh", bilaspur: "Chhattisgarh",
  korba: "Chhattisgarh", durg: "Chhattisgarh", rajnandgaon: "Chhattisgarh", jagdalpur: "Chhattisgarh",
  ambikapur: "Chhattisgarh", dhamtari: "Chhattisgarh",
  bhilwara: "Rajasthan", alwar: "Rajasthan", sikar: "Rajasthan", pali: "Rajasthan",
  sriganganagar: "Rajasthan", bharatpur: "Rajasthan", chittorgarh: "Rajasthan", nagaur: "Rajasthan",
  banswara: "Rajasthan", jhunjhunu: "Rajasthan", makrana: "Rajasthan",
  ratlam: "Madhya Pradesh", dewas: "Madhya Pradesh", sagar: "Madhya Pradesh", satna: "Madhya Pradesh",
  rewa: "Madhya Pradesh", khandwa: "Madhya Pradesh", burhanpur: "Madhya Pradesh", chhindwara: "Madhya Pradesh",
  mandsaur: "Madhya Pradesh", neemuch: "Madhya Pradesh", katni: "Madhya Pradesh",
  erode: "Tamil Nadu", vellore: "Tamil Nadu", thanjavur: "Tamil Nadu", tirunelveli: "Tamil Nadu",
  thoothukudi: "Tamil Nadu", karur: "Tamil Nadu", namakkal: "Tamil Nadu", dindigul: "Tamil Nadu",
  kumbakonam: "Tamil Nadu", hosur: "Tamil Nadu",
  davangere: "Karnataka", shivamogga: "Karnataka", shimoga: "Karnataka", tumkur: "Karnataka",
  bellary: "Karnataka", gulbarga: "Karnataka", kalaburagi: "Karnataka", udupi: "Karnataka", hassan: "Karnataka",
  nizamabad: "Telangana", karimnagar: "Telangana", khammam: "Telangana", ramagundam: "Telangana",
  rajahmundry: "Andhra Pradesh", tirupati: "Andhra Pradesh", nellore: "Andhra Pradesh",
  kurnool: "Andhra Pradesh", kadapa: "Andhra Pradesh", anantapur: "Andhra Pradesh", eluru: "Andhra Pradesh",
  kollam: "Kerala", alappuzha: "Kerala", palakkad: "Kerala", kannur: "Kerala", kottayam: "Kerala",
  malappuram: "Kerala", pathanamthitta: "Kerala",
  asansol: "West Bengal", durgapur: "West Bengal", bardhaman: "West Bengal", malda: "West Bengal",
  kharagpur: "West Bengal", darjeeling: "West Bengal",
  bhagalpur: "Bihar", darbhanga: "Bihar", purnia: "Bihar", chhapra: "Bihar", bihar: "Bihar",
  rourkela: "Odisha", sambalpur: "Odisha", berhampur: "Odisha", puri: "Odisha", balasore: "Odisha",
  dibrugarh: "Assam", silchar: "Assam", jorhat: "Assam", tezpur: "Assam",
  bathinda: "Punjab", mohali: "Punjab", pathankot: "Punjab", moga: "Punjab", hoshiarpur: "Punjab",
  ambala: "Haryana", hisar: "Haryana", karnal: "Haryana", rohtak: "Haryana", sonipat: "Haryana",
  yamunanagar: "Haryana", sirsa: "Haryana",
  haldwani: "Uttarakhand", rudrapur: "Uttarakhand", roorkee: "Uttarakhand", rishikesh: "Uttarakhand",
  dhanbad: "Jharkhand", bokaro: "Jharkhand", deoghar: "Jharkhand", hazaribagh: "Jharkhand",
  aligarh: "Uttar Pradesh", bareilly: "Uttar Pradesh", gorakhpur: "Uttar Pradesh", jhansi: "Uttar Pradesh",
  saharanpur: "Uttar Pradesh", mathura: "Uttar Pradesh", firozabad: "Uttar Pradesh", muzaffarnagar: "Uttar Pradesh",
  greaternoida: "Uttar Pradesh", ayodhya: "Uttar Pradesh", faizabad: "Uttar Pradesh",
  jammu: "Jammu and Kashmir", srinagar: "Jammu and Kashmir",
  imphal: "Manipur", shillong: "Meghalaya", aizawl: "Mizoram", kohima: "Nagaland",
  agartala: "Tripura", itanagar: "Arunachal Pradesh", gangtok: "Sikkim",
  solan: "Himachal Pradesh", mandi: "Himachal Pradesh", dharamshala: "Himachal Pradesh",
  vasco: "Goa", mapusa: "Goa", ponda: "Goa",
  puducherry: "Puducherry", pondicherry: "Puducherry"
};

// Districts and regions that people print where a state is expected
// ("Bhachau, Kutch"). Mapped so the state code still resolves.
const INDIA_REGION_TO_STATE = {
  kutch: "Gujarat", kachchh: "Gujarat", saurashtra: "Gujarat", kathiawar: "Gujarat",
  vidarbha: "Maharashtra", marathwada: "Maharashtra", konkan: "Maharashtra",
  malwa: "Madhya Pradesh", bundelkhand: "Uttar Pradesh", marwar: "Rajasthan",
  mewar: "Rajasthan", shekhawati: "Rajasthan", telangana: "Telangana",
  ncr: "Delhi", nct: "Delhi"
};

function inferStateFromCity(city) {
  const raw = String(city || "").trim();
  if (!raw) return "";
  const lookup = (value) => INDIA_CITY_STATE_MAP[String(value).toLowerCase().replace(/[^a-z]/g, "")] || "";
  // Cards often print two branches in one line ("Mumbai / Pune", "Jaipur, Delhi").
  // Splitting only on separators keeps two-word cities like Navi Mumbai intact,
  // and the first city listed is the one the card is really from.
  const direct = lookup(raw);
  if (direct) return direct;
  for (const part of raw.split(/\s*(?:[\/,&|]|\band\b)\s*/i)) {
    const match = lookup(part);
    if (match) return match;
  }
  return "";
}

// Turns whatever was printed in the "state" position into a real state name:
// passes real states through, maps districts/regions, and otherwise treats the
// value as a city name (cards often print only a town there).
function normalizeIndianState(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (INDIA_STATE_CODES[raw.toLowerCase()]) return raw;
  const byExactState = Object.keys(INDIA_STATE_CODES).find((s) => s.replace(/[^a-z]/g, "") === key);
  if (byExactState) return byExactState.replace(/\b\w/g, (ch) => ch.toUpperCase());
  if (INDIA_REGION_TO_STATE[key]) return INDIA_REGION_TO_STATE[key];
  if (INDIA_CITY_STATE_MAP[key]) return INDIA_CITY_STATE_MAP[key];
  return raw;
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
  if (/mp3|mpeg|mpga/i.test(mimeType)) return "mp3";
  // AAC is normally delivered inside an MP4 container, and speech APIs reject a
  // bare .aac upload. Anything else unrecognised is far more likely to be the
  // m4a a phone recorded than an mp3, and naming it wrongly makes the provider
  // report the audio as corrupted.
  return "m4a";
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

// ===========================================================================
// Card2Leads Admin Panel — backend (Phase 1).
// Self-contained: admin tables are read/written via direct SQL (pgPool) and
// are never part of the customer app's in-memory persistence, so they cannot
// be clobbered by a customer-app save. Admin reads of CUSTOMER data use
// readDb(); admin writes to customer records go through readDb()->saveDb().
// Requires PostgreSQL (production). See docs/PHASE-0-TECHNICAL-AUDIT.md.
// ===========================================================================

const ADMIN_COOKIE = "admin_session";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 8h absolute (D8)
const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;      // 30m idle (D8)

function adminSetupPolicy() {
  const setupTokenConfigured = Boolean(String(process.env.ADMIN_SETUP_TOKEN || ""));
  const production = process.env.NODE_ENV === "production";
  return {
    tokenRequired: production || setupTokenConfigured,
    available: !production || setupTokenConfigured
  };
}

function constantTimeStringEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function adminSessionCookie(req, value, maxAgeSeconds) {
  const attrs = [
    `${ADMIN_COOKIE}=${value}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isSecureRequest(req)) attrs.push("Secure");
  return attrs.join("; ");
}

// Seed the first Super Admin from env on boot (D8). Idempotent.
async function ensureBootstrapAdmin() {
  if (!pgPool) return;
  const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || "");
  if (!email || !password) return;
  const existing = await pgPool.query("select id from admin_users where email = $1", [email]);
  if (existing.rowCount) return;
  await pgPool.query(
    `insert into admin_users (id, name, email, password_hash, role, status, created_at, updated_at)
     values ($1,$2,$3,$4,'super_admin','active',$5,$5)`,
    [id("adm"), process.env.ADMIN_BOOTSTRAP_NAME || "Super Admin", email, hashPassword(password), now()]
  );
  console.log(`Admin: bootstrapped super admin ${email}`);
}

// Resolve the admin behind the request cookie, enforcing absolute + idle expiry.
async function currentAdmin(req) {
  if (!pgPool) return null;
  const sessionId = verifySessionCookie(parseCookies(req)[ADMIN_COOKIE]);
  if (!sessionId) return null;
  const result = await pgPool.query(
    `select s.id as session_id, s.expires_at, s.last_seen_at,
            a.id, a.name, a.email, a.role, a.status
       from admin_sessions s
       join admin_users a on a.id = s.admin_id
      where s.id = $1`,
    [sessionId]
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") return null;
  const nowMs = Date.now();
  if (new Date(row.expires_at).getTime() <= nowMs) return null;
  if (nowMs - new Date(row.last_seen_at).getTime() > ADMIN_IDLE_TIMEOUT_MS) return null;
  await pgPool.query("update admin_sessions set last_seen_at = $2 where id = $1", [sessionId, now()]);
  return { sessionId, id: row.id, name: row.name, email: row.email, role: row.role };
}

async function requireAdmin(req, res) {
  if (!pgPool) {
    error(res, 503, "Admin panel requires the PostgreSQL database.");
    return null;
  }
  const admin = await currentAdmin(req);
  if (!admin) {
    error(res, 401, "Your admin session has expired. Please sign in again.");
    return null;
  }
  return admin;
}

async function adminAudit(admin, { clientId = null, action, previousValue = null, newValue = null, reason = null, metadata = {} }) {
  await pgPool.query(
    `insert into admin_audit_logs (id, admin_id, admin_email, client_id, action, previous_value, new_value, reason, metadata, created_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10)`,
    [
      id("aud"), admin.id, admin.email, clientId, action,
      previousValue == null ? null : JSON.stringify(previousValue),
      newValue == null ? null : JSON.stringify(newValue),
      reason, JSON.stringify(metadata || {}), now()
    ]
  );
}

// ---- Lifecycle / summary derivation (in-memory, from customer db) ----------

function orgIsPaid(org) {
  const status = String(org.subscriptionStatus || "").toLowerCase();
  const paidModes = ["subscription", "one_time"];
  return paidModes.includes(String(org.billingMode || "")) &&
    !["cancelled", "expired", "halted", "completed"].includes(status) &&
    String(org.plan || "trial").toLowerCase() !== "trial";
}

function deriveLifecycle(org, activity) {
  // Account status overrides lifecycle where relevant.
  if (org.status === "suspended") return "SUSPENDED";
  if (org.status === "pending_deletion") return "PENDING_DELETION";
  if (orgIsPaid(org)) {
    const status = String(org.subscriptionStatus || "").toLowerCase();
    if (status === "past_due") return "PAYMENT_FAILED";
    return activity.renewed ? "RENEWED" : "PAID";
  }
  // Not paid — where are they in the funnel? (pay-to-start model, Q1)
  if (activity.scans >= 10 || activity.sessions >= 2 || activity.exports > 0) return "ENGAGED";
  if (activity.scans > 0) return "ACTIVATED";
  return "REGISTERED";
}

function clientActivity(db, org, ledgerUsage = null) {
  const orgCards = db.cards.filter((c) => c.organisationId === org.id);
  const orgContacts = db.contacts.filter((c) => c.organisationId === org.id && !c.deletedAt);
  const batches = db.uploadBatches.filter((b) => b.organisationId === org.id);
  const scans = Number(ledgerUsage?.used ?? org.scansUsed ?? 0);
  const timestamps = [
    ...orgContacts.map((c) => c.updatedAt || c.createdAt),
    ...orgCards.map((c) => c.updatedAt || c.createdAt)
  ].filter(Boolean).sort();
  return {
    scans,
    sessions: batches.length,
    contacts: orgContacts.length,
    exports: 0, // populated from product_events once instrumented (Phase 2)
    renewed: false,
    lastActivityAt: timestamps.length ? timestamps[timestamps.length - 1] : null
  };
}

function clientSummary(db, org, ledgerUsage = null) {
  const users = db.users.filter((u) => u.organisationId === org.id);
  const primary = users.find((u) => u.status !== "deleted") || users[0] || null;
  const activity = clientActivity(db, org, ledgerUsage);
  // Respect an explicit 0 allowance (pay-to-start) — only fall back to the plan
  // default when scanLimit is genuinely unset, so a new account reads 0, not 20.
  const scanLimit = Number(ledgerUsage?.limit ?? (org.scanLimit != null ? org.scanLimit : PLAN_LIMITS[org.plan] || 0));
  const scansUsed = Number(ledgerUsage?.used ?? org.scansUsed ?? 0);
  const remaining = Math.max(0, Number(ledgerUsage?.remaining ?? (scanLimit - scansUsed)));
  return {
    clientId: org.id,
    clientName: org.name,
    primaryUser: primary ? { id: primary.id, name: primary.name, email: primary.email, phone: primary.phone || null } : null,
    email: primary?.email || null,
    phone: primary?.phone || null,
    lifecycle: deriveLifecycle(org, activity),
    accountStatus: (org.status || "active").toUpperCase(),
    plan: org.plan || "trial",
    billingMode: org.billingMode || "none",
    subscriptionStatus: org.subscriptionStatus || "none",
    usage: { used: scansUsed, limit: scanLimit, remaining },
    userCount: users.length,
    lastActivityAt: activity.lastActivityAt,
    createdAt: org.createdAt
  };
}

function withinDays(iso, days) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() <= days * 24 * 60 * 60 * 1000;
}

// --- Scan / usage records are written directly so the in-memory persistence
// rewrite cannot clobber them. Ledger writes are deliberately fail-closed:
// entitlements must never change without a durable ledger transaction. ---
async function recordUsageLedger(entry) {
  if (!pgPool || !entry?.clientId) return false;
  const result = await pgPool.query(
      `insert into usage_ledger (id, client_id, user_id, transaction_type, quantity, balance_effect, source, reference_id, admin_id, reason, metadata, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (idempotency_key) where idempotency_key is not null do nothing returning id`,
      [id("ledg"), entry.clientId, entry.userId || null, entry.type, Number(entry.quantity || 0),
       Number(entry.balanceEffect || 0), entry.source || null, entry.referenceId || null,
       entry.adminId || null, entry.reason || null, JSON.stringify(entry.metadata || {}),
       entry.idempotencyKey || null]
    );
  return result.rowCount > 0;
}

async function consumeUsageCredit(entry) {
  if (!pgPool || !entry?.clientId || !entry?.idempotencyKey) return false;
  const duplicate = await pgPool.query("select 1 from usage_ledger where idempotency_key = $1", [entry.idempotencyKey]);
  if (duplicate.rowCount) return true;
  const result = await pgPool.query(
    `insert into usage_ledger (id, client_id, user_id, transaction_type, quantity, balance_effect, source, reference_id, metadata, idempotency_key)
     select $1,$2,$3,'SCAN_CONSUMED',1,-1,'scan',$4,$5::jsonb,$6
     where $7::boolean or (select coalesce(sum(balance_effect),0) from usage_ledger where client_id = $2) > 0
     on conflict (idempotency_key) where idempotency_key is not null do nothing returning id`,
    [id("ledg"), entry.clientId, entry.userId || null, entry.referenceId || null, JSON.stringify(entry.metadata || {}), entry.idempotencyKey, Boolean(entry.demo)]
  );
  return result.rowCount > 0;
}

async function setLedgerBalance(entry) {
  if (!pgPool || !entry?.clientId) return false;
  const current = await ledgerUsageForClient(entry.clientId);
  const target = Math.max(0, Number(entry.targetBalance || 0));
  return recordUsageLedger({
    ...entry,
    type: entry.type || "PLAN_ALLOCATION",
    quantity: Number(entry.quantity ?? target),
    balanceEffect: target - Number(current?.balance || 0)
  });
}

// The mobile app identifies itself with X-Card2Leads-Client (e.g. expo-android),
// so activity in the admin panel can distinguish app usage from the web app.
function clientPlatform(req) {
  const header = String(req?.headers?.["x-card2leads-client"] || "");
  if (/expo-android/i.test(header)) return "android";
  if (/expo-ios/i.test(header)) return "ios";
  if (header) return header.slice(0, 40);
  return "web";
}

async function recordProductEvent(event) {
  if (!pgPool || !event?.name) return;
  try {
    await pgPool.query(
      `insert into product_events (id, event_name, client_id, user_id, session_id, idempotency_key, source, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (idempotency_key) do nothing`,
      [id("evt"), event.name, event.clientId || null, event.userId || null, event.sessionId || null,
       event.idempotencyKey || null, event.source || null, JSON.stringify(event.metadata || {})]
    );
  } catch (err) {
    console.error("[event] write failed:", err.message);
  }
}

async function recordPayment(payment) {
  if (!pgPool || !payment?.clientId) return;
  try {
    await pgPool.query(
      `insert into payments (id, client_id, user_id, amount_paise, currency, plan, status, provider, provider_payment_id, provider_order_id, provider_reference, subscription_id, failure_reason, completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id("pay"), payment.clientId, payment.userId || null, Number(payment.amountPaise || 0),
       payment.currency || "INR", payment.plan || null, payment.status || "paid", payment.provider || "razorpay",
       payment.providerPaymentId || null, payment.providerOrderId || null, payment.providerReference || null,
       payment.subscriptionId || null, payment.failureReason || null,
       payment.status === "paid" ? new Date() : null]
    );
  } catch (err) {
    console.error("[payment] write failed:", err.message);
  }
}

async function recordSubscription(subscription) {
  if (!pgPool || !subscription?.clientId || !subscription?.providerReference) return;
  const provider = subscription.provider || "razorpay";
  const existing = (await pgPool.query(
    "select * from subscriptions where provider = $1 and provider_reference = $2 limit 1",
    [provider, subscription.providerReference]
  )).rows[0];
  const metadata = { ...(existing?.metadata || {}), ...(subscription.metadata || {}) };
  const history = Array.isArray(metadata.statusHistory) ? metadata.statusHistory : [];
  const historyKey = subscription.eventId || `${subscription.status}:${subscription.occurredAt || now()}`;
  if (!history.some((item) => item.key === historyKey)) {
    history.push({ key: historyKey, status: subscription.status, at: subscription.occurredAt || now(), source: subscription.source || "system" });
  }
  metadata.statusHistory = history.slice(-100);
  if (existing) {
    await pgPool.query(
      `update subscriptions set plan = $2, status = $3, billing_mode = $4, start_date = coalesce($5,start_date),
       current_period_end = coalesce($6,current_period_end), updated_at = $7, metadata = $8::jsonb where id = $1`,
      [existing.id, subscription.plan || existing.plan, subscription.status || existing.status,
       subscription.billingMode || existing.billing_mode, subscription.startDate || null,
       subscription.currentPeriodEnd || null, now(), JSON.stringify(metadata)]
    );
    return existing.id;
  }
  const subscriptionId = id("sub");
  await pgPool.query(
    `insert into subscriptions (id, client_id, plan, status, billing_mode, provider, provider_reference, start_date, current_period_end, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [subscriptionId, subscription.clientId, subscription.plan || null, subscription.status || "pending",
     subscription.billingMode || "subscription", provider, subscription.providerReference,
     subscription.startDate || null, subscription.currentPeriodEnd || null, JSON.stringify(metadata)]
  );
  return subscriptionId;
}

async function reconcileUsageLedger() {
  if (!pgPool) return;
  const db = readDb();
  for (const org of db.organisations) {
    const marker = `ledger-cutover-v1:${org.id}`;
    const exists = await pgPool.query("select 1 from usage_ledger where idempotency_key = $1", [marker]);
    if (exists.rowCount) continue;
    const current = await ledgerUsageForClient(org.id);
    const legacyRemaining = Math.max(0, Number(org.scanLimit || 0) - Number(org.scansUsed || 0));
    await recordUsageLedger({
      clientId: org.id, type: "SYSTEM_CORRECTION", quantity: Math.abs(legacyRemaining - Number(current?.balance || 0)),
      balanceEffect: legacyRemaining - Number(current?.balance || 0), source: "system",
      referenceId: marker, idempotencyKey: marker, reason: "One-time ledger-authoritative cutover",
      metadata: { legacyScanLimit: Number(org.scanLimit || 0), legacyScansUsed: Number(org.scansUsed || 0) }
    });
  }
}

function removeOrganisationData(db, clientId) {
  const users = new Set(db.users.filter((item) => item.organisationId === clientId).map((item) => item.id));
  const collections = new Set(db.collections.filter((item) => item.organisationId === clientId).map((item) => item.id));
  const cards = db.cards.filter((item) => item.organisationId === clientId);
  const contacts = new Set(db.contacts.filter((item) => item.organisationId === clientId).map((item) => item.id));
  const sheetConfigurations = new Set(db.sheetConfigurations.filter((item) => item.organisationId === clientId).map((item) => item.id));
  const storagePaths = [
    ...cards.flatMap((card) => [card.storagePath, card.backStoragePath, card.processedStoragePath]),
    ...db.voiceNotes.filter((item) => item.organisationId === clientId).map((item) => item.audioPath)
  ].filter(Boolean);
  db.sessions = db.sessions.filter((item) => !users.has(item.userId));
  db.syncRecords = db.syncRecords.filter((item) => !contacts.has(item.contactId) && !collections.has(item.collectionId) && !sheetConfigurations.has(item.sheetConfigurationId));
  db.auditLogs = db.auditLogs.filter((item) => item.organisationId !== clientId);
  for (const key of ["users", "collections", "uploadBatches", "cards", "contacts", "voiceNotes", "googleConnections", "sheetConfigurations"]) {
    db[key] = db[key].filter((item) => item.organisationId !== clientId);
  }
  db.organisations = db.organisations.filter((item) => item.id !== clientId);
  return storagePaths;
}

function removePrivateStorageFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const storageRoot = path.resolve(STORAGE_DIR) + path.sep;
  if (!resolved.startsWith(storageRoot)) {
    console.error("[deletion] refused to remove path outside private storage:", resolved);
    return;
  }
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) fs.unlinkSync(resolved);
  } catch (err) {
    console.error("[deletion] file removal failed:", err.message);
  }
}

async function purgePendingDeletionAccounts(asOf = new Date()) {
  // Product decision: accounts are retained (archived), never hard-deleted, until
  // the archive workflow is built. The permanent purge stays off unless
  // ENABLE_ACCOUNT_PURGE=true is explicitly set, so no tenant data is ever
  // removed by the background job in production.
  if (process.env.ENABLE_ACCOUNT_PURGE !== "true") return 0;
  const db = readDb();
  const cutoff = asOf.getTime() - DELETION_RETENTION_MS;
  const due = db.organisations.filter((org) =>
    org.status === "pending_deletion" && new Date(org.pendingDeletionAt || 0).getTime() > 0 &&
    new Date(org.pendingDeletionAt).getTime() <= cutoff
  );
  if (!due.length) return 0;
  const paths = [];
  due.forEach((org) => paths.push(...removeOrganisationData(db, org.id)));
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("begin");
      for (const org of due) {
        for (const table of ["admin_notes", "usage_ledger", "product_events", "payments", "subscriptions", "admin_audit_logs"]) {
          await client.query(`delete from ${table} where client_id = $1`, [org.id]);
        }
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
  await saveDb(db);
  paths.forEach(removePrivateStorageFile);
  console.log(`[deletion] permanently purged ${due.length} account(s) after the retention window.`);
  return due.length;
}

async function expireOneTimeSubscriptionHistory(asOf = new Date()) {
  if (!pgPool) return;
  const result = await pgPool.query(
    "select * from subscriptions where billing_mode = 'one_time' and status = 'active' and current_period_end <= $1",
    [asOf]
  );
  for (const subscription of result.rows) {
    await recordSubscription({ clientId: subscription.client_id, plan: subscription.plan, status: "expired", billingMode: "one_time", provider: subscription.provider, providerReference: subscription.provider_reference, currentPeriodEnd: subscription.current_period_end, source: "maintenance", eventId: `expired:${subscription.current_period_end}` });
  }
}

async function runMaintenance() {
  await purgePendingDeletionAccounts();
  await expireOneTimeSubscriptionHistory();
}

function scheduleMaintenance() {
  const timer = setInterval(() => runMaintenance().catch((err) => console.error("[maintenance] failed:", err.stack || err)), DELETION_WORKER_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

async function handleAdminApi(req, res, pathname) {
 try {
  // --- One-time first-admin setup. It is permanently disabled as soon as any
  // admin row exists. Production additionally requires ADMIN_SETUP_TOKEN so an
  // unattended new deployment cannot be claimed from the public login page. ---
  if (req.method === "GET" && pathname === "/api/admin/setup/status") {
    if (!pgPool) return error(res, 503, "Admin panel requires the PostgreSQL database.");
    const total = (await pgPool.query("select count(*)::int as n from admin_users")).rows[0].n;
    const policy = adminSetupPolicy();
    return send(res, 200, { setupRequired: total === 0, tokenRequired: policy.tokenRequired, setupAvailable: policy.available });
  }

  if (req.method === "POST" && pathname === "/api/admin/setup") {
    if (!pgPool) return error(res, 503, "Admin panel requires the PostgreSQL database.");
    if (!rateLimit(req, res, "admin-setup", 8, 15 * 60 * 1000)) return;
    const policy = adminSetupPolicy();
    const expectedToken = String(process.env.ADMIN_SETUP_TOKEN || "");
    if (!policy.available) return error(res, 503, "First-admin setup is locked. Set ADMIN_SETUP_TOKEN on the backend and restart it.");
    const body = await readJson(req);
    if (policy.tokenRequired && !constantTimeStringEqual(body.setupToken, expectedToken)) {
      return error(res, 403, "The setup code is incorrect.");
    }
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, "Name and a valid email are required.");
    const passwordError = validatePasswordStrength(password);
    if (passwordError) return error(res, 400, passwordError);

    const adminId = id("adm");
    const sessionId = id("asn");
    const createdAt = now();
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString();
    const client = await pgPool.connect();
    let committed = false;
    try {
      await client.query("begin");
      await client.query("lock table admin_users in exclusive mode");
      const existing = await client.query("select count(*)::int as n from admin_users");
      if (existing.rows[0].n > 0) {
        await client.query("rollback");
        return error(res, 409, "Initial setup is already complete. Ask a super-admin to add you from Settings.");
      }
      await client.query(
        `insert into admin_users (id, name, email, password_hash, role, status, last_login_at, created_at, updated_at)
         values ($1,$2,$3,$4,'super_admin','active',$5,$5,$5)`,
        [adminId, name, email, hashPassword(password), createdAt]
      );
      await client.query(
        `insert into admin_sessions (id, admin_id, created_at, expires_at, last_seen_at, ip, user_agent)
         values ($1,$2,$3,$4,$3,$5,$6)`,
        [sessionId, adminId, createdAt, expiresAt, clientIp(req), String(req.headers["user-agent"] || "").slice(0, 400)]
      );
      await client.query("commit");
      committed = true;
    } catch (err) {
      if (!committed) await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const admin = { id: adminId, name, email, role: "super_admin" };
    await adminAudit(admin, { action: "INITIAL_ADMIN_CREATED" });
    return send(res, 201, { admin }, {
      "Set-Cookie": adminSessionCookie(req, signSession(sessionId), Math.floor(ADMIN_SESSION_TTL_MS / 1000))
    });
  }

  // --- Auth: login / logout / me (no session required for login) ---
  if (req.method === "POST" && pathname === "/api/admin/auth/login") {
    if (!pgPool) return error(res, 503, "Admin panel requires the PostgreSQL database.");
    if (!rateLimit(req, res, "admin-login", 10, 15 * 60 * 1000)) return;
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const result = await pgPool.query("select * from admin_users where email = $1", [email]);
    const admin = result.rows[0];
    const passwordOk = verifyPassword(
      String(body.password || ""),
      admin && admin.password_hash ? admin.password_hash : DUMMY_PASSWORD_HASH
    );
    if (!admin || admin.status !== "active" || !passwordOk) {
      return error(res, 401, "Incorrect email or password.");
    }
    const sessionId = id("asn");
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString();
    await pgPool.query(
      `insert into admin_sessions (id, admin_id, created_at, expires_at, last_seen_at, ip, user_agent)
       values ($1,$2,$3,$4,$3,$5,$6)`,
      [sessionId, admin.id, now(), expiresAt, clientIp(req), String(req.headers["user-agent"] || "").slice(0, 400)]
    );
    await pgPool.query("update admin_users set last_login_at = $2 where id = $1", [admin.id, now()]);
    await adminAudit({ id: admin.id, email: admin.email }, { action: "ADMIN_LOGIN" });
    return send(res, 200, { admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } }, {
      "Set-Cookie": adminSessionCookie(req, signSession(sessionId), Math.floor(ADMIN_SESSION_TTL_MS / 1000))
    });
  }

  if (req.method === "POST" && pathname === "/api/admin/auth/logout") {
    if (pgPool) {
      const sessionId = verifySessionCookie(parseCookies(req)[ADMIN_COOKIE]);
      if (sessionId) await pgPool.query("delete from admin_sessions where id = $1", [sessionId]);
    }
    return send(res, 200, { ok: true }, { "Set-Cookie": adminSessionCookie(req, "", 0) });
  }

  // --- Everything below requires an authenticated admin ---
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET" && pathname === "/api/admin/auth/me") {
    return send(res, 200, { admin });
  }

  // Admin-led customer provisioning. The owner receives a one-time setup
  // link; no temporary password is generated or exposed to the administrator.
  if (req.method === "POST" && pathname === "/api/admin/clients") {
    const body = await readJson(req);
    const clientName = String(body.clientName || "").trim();
    const ownerName = String(body.ownerName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    if (!clientName || !ownerName || !email) return error(res, 400, "Client name, owner name and email are required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, "Enter a valid email address.");
    const db = readDb();
    if (db.users.some((user) => String(user.email || "").toLowerCase() === email && user.status !== "deleted")) {
      return error(res, 409, "A customer account already exists for this email.");
    }
    const createdAt = now();
    const org = {
      id: id("org"), name: clientName, plan: "trial", scanLimit: 0, scansUsed: 0,
      topupScans: 0, billingMode: "none", subscriptionStatus: "none",
      retentionPolicy: "90-days", setupComplete: false, status: "active",
      createdByAdminId: admin.id, createdAt, updatedAt: createdAt
    };
    const invitationToken = randomToken("invite");
    const user = {
      id: id("usr"), organisationId: org.id, name: ownerName, email, phone,
      passwordHash: "", emailVerified: false, role: "owner", status: "pending_invitation",
      passwordResetToken: invitationToken,
      passwordResetExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      invitedByAdminId: admin.id, createdAt, updatedAt: createdAt
    };
    db.organisations.push(org);
    db.users.push(user);
    audit(db, user, "user.invited_by_admin", "user", user.id, { adminId: admin.id });
    await saveDb(db);
    const invitationLink = buildLink(req, `/?resetToken=${encodeURIComponent(invitationToken)}&invited=1`);
    let invitationSent = false;
    let deliveryError = "";
    try {
      await deliverAccountEmail("client-invitation", email, invitationLink);
      invitationSent = emailDeliveryEnabled();
    } catch (err) {
      deliveryError = err.message || "Invitation delivery failed.";
      console.error("[admin] client invitation delivery failed:", deliveryError);
    }
    await recordProductEvent({ name: "account_created", clientId: org.id, userId: user.id, source: "admin_invite", idempotencyKey: `account_created:${org.id}` });
    await adminAudit(admin, { clientId: org.id, action: "CLIENT_CREATED", newValue: { clientName, ownerName, email, phone, invitationSent } });
    return send(res, 201, {
      ok: true, client: clientSummary(db, org, foldLedgerRows([])), invitationSent,
      invitationLink: invitationSent ? undefined : invitationLink,
      warning: deliveryError || (invitationSent ? "" : "Email delivery is not configured; copy the setup link to the client.")
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/dashboard") {
    const db = readDb();
    const orgs = db.organisations;
    const usageByClient = await ledgerUsageMap(orgs.map((o) => o.id));
    const summaries = orgs.map((o) => clientSummary(db, o, usageByClient.get(o.id)));
    const totalClients = orgs.length;
    const newSignups7d = orgs.filter((o) => withinDays(o.createdAt, 7)).length;
    const activated = summaries.filter((s) => s.usage.used > 0).length;
    const activePaid = summaries.filter((s) => ["PAID", "RENEWED"].includes(s.lifecycle)).length;
    const usageExhausted = summaries.filter((s) => s.usage.limit > 0 && s.usage.remaining <= 0).length;
    const [payFail, scansToday, pricingViewed, checkoutStarted] = await Promise.all([
      pgPool.query("select count(*)::int as n from payments where status = 'failed'"),
      pgPool.query("select count(*)::int as n from product_events where event_name = 'scan_completed' and created_at::date = (now() at time zone 'Asia/Kolkata')::date"),
      pgPool.query("select count(distinct client_id)::int as n from product_events where event_name = 'pricing_viewed'"),
      pgPool.query("select count(distinct client_id)::int as n from product_events where event_name = 'checkout_started'")
    ]);
    // Funnel (pay-to-start model): Registered -> Activated -> Pricing Viewed -> Checkout Started -> Paid.
    const paid = activePaid;
    const attention = {
      registeredNotActivated: summaries.filter((s) => s.lifecycle === "REGISTERED").length,
      activatedNotPaid: summaries.filter((s) => ["ACTIVATED", "ENGAGED"].includes(s.lifecycle)).length,
      paymentFailed: summaries.filter((s) => s.lifecycle === "PAYMENT_FAILED").length,
      usageExhausted,
      suspended: summaries.filter((s) => s.accountStatus === "SUSPENDED").length,
      pendingDeletion: summaries.filter((s) => s.accountStatus === "PENDING_DELETION").length
    };
    return send(res, 200, {
      kpis: {
        totalClients, newSignups7d, activatedUsers: activated, activePaidClients: activePaid,
        conversionPct: totalClients ? Math.round((activePaid / totalClients) * 1000) / 10 : 0,
        scansToday: scansToday.rows[0].n, failedPayments: payFail.rows[0].n, usageExhausted
      },
      funnel: [
        { stage: "Registered", count: totalClients },
        { stage: "Activated", count: activated },
        { stage: "Pricing Viewed", count: pricingViewed.rows[0].n },
        { stage: "Checkout Started", count: checkoutStarted.rows[0].n },
        { stage: "Paid", count: paid }
      ],
      attention
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/clients") {
    const db = readDb();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const lifecycleFilter = String(url.searchParams.get("lifecycle") || "").toUpperCase();
    const statusFilter = String(url.searchParams.get("status") || "").toUpperCase();
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") || 25)));

    const usageByClient = await ledgerUsageMap(db.organisations.map((o) => o.id));
    let rows = db.organisations.map((o) => clientSummary(db, o, usageByClient.get(o.id)));
    if (q) {
      rows = rows.filter((s) => {
        const hay = [s.clientName, s.clientId, s.email, s.phone, s.primaryUser?.name].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    if (lifecycleFilter) rows = rows.filter((s) => s.lifecycle === lifecycleFilter);
    if (statusFilter) rows = rows.filter((s) => s.accountStatus === statusFilter);
    rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const total = rows.length;
    const start = (page - 1) * pageSize;
    return send(res, 200, {
      total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)),
      clients: rows.slice(start, start + pageSize)
    });
  }

  if (req.method === "GET" && pathname.startsWith("/api/admin/clients/") && pathname.split("/").length === 5) {
    const clientId = decodeURIComponent(pathname.split("/")[4]);
    const db = readDb();
    const org = db.organisations.find((o) => o.id === clientId);
    if (!org) return error(res, 404, "Client not found.");
    const summary = clientSummary(db, org, await ledgerUsageForClient(org.id));
    const users = db.users
      .filter((u) => u.organisationId === org.id)
      .map((u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone || null, status: u.status, createdAt: u.createdAt }));
    const google = db.googleConnections.find((g) => g.organisationId === org.id);
    const [ledger, notes, payments, subscriptions, events] = await Promise.all([
      pgPool.query("select * from usage_ledger where client_id = $1 order by created_at desc limit 100", [clientId]),
      pgPool.query("select * from admin_notes where client_id = $1 order by created_at desc limit 50", [clientId]),
      pgPool.query("select * from payments where client_id = $1 order by created_at desc limit 50", [clientId]),
      pgPool.query("select * from subscriptions where client_id = $1 order by created_at desc limit 50", [clientId]),
      pgPool.query("select event_name, created_at, metadata from product_events where client_id = $1 order by created_at desc limit 100", [clientId])
    ]);
    await adminAudit(admin, { clientId, action: "CLIENT_VIEWED" }); // D10-lite: log PII access
    return send(res, 200, {
      ...summary,
      users,
      googleIntegration: google
        ? { status: google.status, email: google.googleEmail || null, connectedAt: google.createdAt, lastSyncAt: google.updatedAt || null }
        : { status: "not_connected" },
      usageLedger: ledger.rows,
      notes: notes.rows,
      payments: payments.rows,
      subscriptions: subscriptions.rows,
      timeline: events.rows
    });
  }

  // ---- Operational actions (spec §80): each requires a reason and writes an
  // immutable admin-audit entry. Org mutations go through readDb()->saveDb().
  if (req.method === "POST" && pathname.startsWith("/api/admin/clients/") && pathname.split("/").length === 6) {
    const parts = pathname.split("/");
    const clientId = decodeURIComponent(parts[4]);
    const action = parts[5];
    const db = readDb();
    const org = db.organisations.find((o) => o.id === clientId);
    if (!org) return error(res, 404, "Client not found.");
    const body = await readJson(req);
    const reason = String(body.reason || "").trim();
    const needsReason = ["credits", "change-plan", "suspend", "cancel-subscription", "initiate-deletion"].includes(action);
    if (needsReason && !reason) return error(res, 400, "A reason is required for this action.");

    if (action === "notes") {
      const note = String(body.note || "").trim();
      if (!note) return error(res, 400, "Note cannot be empty.");
      const row = { id: id("note"), clientId, adminId: admin.id, adminEmail: admin.email, note, createdAt: now() };
      await pgPool.query(
        "insert into admin_notes (id, client_id, admin_id, admin_email, note, created_at) values ($1,$2,$3,$4,$5,$6)",
        [row.id, clientId, admin.id, admin.email, note, row.createdAt]
      );
      return send(res, 200, { ok: true, note: row });
    }

    if (action === "resend-invitation") {
      const invitedUser = db.users.find((user) => user.organisationId === clientId && user.status === "pending_invitation" && user.email);
      if (!invitedUser) return error(res, 400, "This client has no pending invitation.");
      const invitationToken = randomToken("invite");
      invitedUser.passwordResetToken = invitationToken;
      invitedUser.passwordResetExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      invitedUser.updatedAt = now();
      await saveDb(db);
      const invitationLink = buildLink(req, `/?resetToken=${encodeURIComponent(invitationToken)}&invited=1`);
      let invitationSent = false;
      try {
        await deliverAccountEmail("client-invitation", invitedUser.email, invitationLink);
        invitationSent = emailDeliveryEnabled();
      } catch (err) {
        console.error("[admin] invitation resend failed:", err.message);
      }
      await adminAudit(admin, { clientId, action: "CLIENT_INVITATION_RESENT", newValue: { email: invitedUser.email, invitationSent } });
      return send(res, 200, { ok: true, invitationSent, invitationLink: invitationSent ? undefined : invitationLink });
    }

    if (action === "credits") {
      const type = body.type === "remove" ? "remove" : "add";
      const qty = Math.floor(Number(body.quantity || 0));
      if (!(qty > 0)) return error(res, 400, "Enter a quantity greater than zero.");
      const previousUsage = await authoritativePlanUsage(org);
      let applied = qty;
      if (type === "add") {
        if (pgPool) await recordUsageLedger({ clientId, type: "ADMIN_CREDIT", quantity: qty, balanceEffect: qty, source: "admin", adminId: admin.id, reason, metadata: { by: admin.email } });
        org.scanLimit = Number(org.scanLimit || previousUsage.limit) + qty;
        org.adminGranted = true; // goodwill credits unlock scanning under pay-to-start
      } else {
        applied = Math.min(qty, previousUsage.remaining);
        if (!(applied > 0)) return error(res, 400, "This client has no remaining credits to remove.");
        if (pgPool) await recordUsageLedger({ clientId, type: "ADMIN_DEBIT", quantity: applied, balanceEffect: -applied, source: "admin", adminId: admin.id, reason, metadata: { by: admin.email } });
        org.scanLimit = Math.max(Number(org.scansUsed || 0), Number(org.scanLimit || previousUsage.limit) - applied);
      }
      org.updatedAt = now();
      await saveDb(db);
      const currentUsage = await authoritativePlanUsage(org);
      await adminAudit(admin, { clientId, action: type === "add" ? "CREDITS_ADDED" : "CREDITS_REMOVED", previousValue: previousUsage, newValue: currentUsage, reason });
      return send(res, 200, { ok: true, usage: currentUsage });
    }

    if (action === "change-plan") {
      const plan = String(body.plan || "").toLowerCase();
      if (!PLAN_LIMITS[plan]) return error(res, 400, "Choose a valid plan.");
      const prev = { plan: org.plan, usage: await authoritativePlanUsage(org) };
      org.plan = plan;
      org.scanLimit = Number(PLAN_LIMITS[plan] || 0) + Number(org.topupScans || 0);
      org.adminGranted = true; // comped plan unlocks scanning under pay-to-start
      org.billingMode = org.billingMode && org.billingMode !== "none" ? org.billingMode : "admin";
      if (!org.subscriptionStatus || org.subscriptionStatus === "none") org.subscriptionStatus = "active";
      org.updatedAt = now();
      if (pgPool) await setLedgerBalance({ clientId, targetBalance: org.scanLimit, type: "PLAN_ALLOCATION", quantity: org.scanLimit, source: "admin", adminId: admin.id, reason, idempotencyKey: `admin-plan:${clientId}:${Date.now()}`, metadata: { plan, adminChange: true } });
      await saveDb(db);
      await recordSubscription({ clientId, plan, status: "active", billingMode: "admin", provider: "admin", providerReference: `admin-plan:${clientId}`, source: "admin", eventId: `admin-plan:${Date.now()}`, metadata: { adminId: admin.id } });
      await adminAudit(admin, { clientId, action: "PLAN_CHANGED", previousValue: prev, newValue: { plan, usage: await authoritativePlanUsage(org) }, reason });
      return send(res, 200, { ok: true });
    }

    if (action === "suspend") {
      const prev = org.status || "active";
      org.status = "suspended"; org.updatedAt = now();
      await saveDb(db);
      await adminAudit(admin, { clientId, action: "ACCOUNT_SUSPENDED", previousValue: { status: prev }, newValue: { status: "suspended" }, reason });
      return send(res, 200, { ok: true });
    }

    if (action === "reactivate") {
      const prev = org.status || "active";
      org.status = "active"; delete org.pendingDeletionAt; org.updatedAt = now();
      await saveDb(db);
      await adminAudit(admin, { clientId, action: "ACCOUNT_REACTIVATED", previousValue: { status: prev }, newValue: { status: "active" }, reason });
      return send(res, 200, { ok: true });
    }

    if (action === "cancel-subscription") {
      const prev = org.subscriptionStatus || "none";
      if (!org.subscriptionId || String(org.billingMode || "") !== "subscription") return error(res, 400, "This client has no recurring subscription to cancel.");
      if (!billingConfigured()) return error(res, 503, "Billing is not configured, so cancellation could not be scheduled.");
      if (prev === "cancel_scheduled") return send(res, 200, { ok: true, status: prev, currentPeriodEnd: org.currentPeriodEnd || null });
      try {
        await razorpayApi(`/subscriptions/${org.subscriptionId}/cancel`, { method: "POST", body: { cancel_at_cycle_end: 1 } });
      } catch (err) {
        return error(res, 502, `Payment provider did not accept the cancellation: ${err.message}`);
      }
      org.subscriptionStatus = "cancel_scheduled"; org.updatedAt = now();
      await saveDb(db);
      await recordSubscription({ clientId, plan: org.plan, status: "cancel_scheduled", billingMode: "subscription", providerReference: org.subscriptionId, currentPeriodEnd: org.currentPeriodEnd || null, source: "admin", eventId: `admin-cancel:${Date.now()}`, metadata: { cancellationReason: reason } });
      await recordProductEvent({ name: "subscription_cancel_scheduled", clientId, source: "admin", metadata: { currentPeriodEnd: org.currentPeriodEnd || null } });
      await adminAudit(admin, { clientId, action: "SUBSCRIPTION_CANCELLATION_SCHEDULED", previousValue: { subscriptionStatus: prev }, newValue: { subscriptionStatus: "cancel_scheduled", currentPeriodEnd: org.currentPeriodEnd || null }, reason });
      return send(res, 200, { ok: true, status: "cancel_scheduled", currentPeriodEnd: org.currentPeriodEnd || null });
    }

    if (action === "disconnect-google") {
      const connection = db.googleConnections.find((g) => g.organisationId === org.id && g.status === "active");
      if (connection) {
        connection.status = "disconnected";
        connection.encryptedToken = "";
        connection.encryptedRefreshToken = "";
        connection.tokenExpiry = "";
        connection.updatedAt = now();
      }
      await saveDb(db);
      await adminAudit(admin, { clientId, action: "INTEGRATION_DISCONNECTED", newValue: { integration: "google" }, reason });
      return send(res, 200, { ok: true });
    }

    if (action === "initiate-deletion") {
      const prev = org.status || "active";
      org.status = "pending_deletion";
      org.pendingDeletionAt = now();
      org.updatedAt = now();
      await saveDb(db);
      await adminAudit(admin, { clientId, action: "ACCOUNT_DELETION_INITIATED", previousValue: { status: prev }, newValue: { status: "pending_deletion", purgeAfterDays: 30 }, reason });
      return send(res, 200, { ok: true });
    }

    return error(res, 400, "Unknown client action.");
  }

  // ---- ADM-05 Analytics ----
  if (req.method === "GET" && pathname === "/api/admin/analytics") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const range = String(url.searchParams.get("range") || "30d");
    const startMs = { today: 0, "7d": 7, "30d": 30, "90d": 90 };
    let startIso = null;
    if (range === "today") {
      const d = new Date(); d.setHours(0, 0, 0, 0); startIso = d.toISOString();
    } else if (startMs[range] != null) {
      startIso = new Date(Date.now() - startMs[range] * 24 * 60 * 60 * 1000).toISOString();
    }
    const db = readDb();
    const orgsInRange = db.organisations.filter((o) => !startIso || String(o.createdAt || "") >= startIso);
    const registered = orgsInRange.length;
    // Registrations-by-date series (IST) from in-memory orgs.
    const seriesMap = {};
    orgsInRange.forEach((o) => {
      if (!o.createdAt) return;
      const d = new Date(o.createdAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      seriesMap[d] = (seriesMap[d] || 0) + 1;
    });
    const series = Object.keys(seriesMap).sort().map((d) => ({ date: d, count: seriesMap[d] }));
    const cond = startIso ? "and created_at >= $1" : "";
    const args = startIso ? [startIso] : [];
    const distinct = (ev) => pgPool.query(`select count(distinct client_id)::int as n from product_events where event_name = '${ev}' ${cond}`, args).then((r) => r.rows[0].n);
    const countEv = (ev) => pgPool.query(`select count(*)::int as n from product_events where event_name = '${ev}' ${cond}`, args).then((r) => r.rows[0].n);
    const [firstLogin, activated, pricingViewed, checkoutStarted, paid, scans, exportsCount, googleConnects] = await Promise.all([
      distinct("first_login"), distinct("scan_completed"), distinct("pricing_viewed"),
      distinct("checkout_started"), distinct("plan_activated"), countEv("scan_completed"),
      pgPool.query(`select count(*)::int as n from product_events where event_name in ('export_excel','export_csv','export_vcf') ${cond}`, args).then((r) => r.rows[0].n),
      distinct("google_connected")
    ]);
    const activeClients = await pgPool.query(`select count(distinct client_id)::int as n from product_events where event_name in ('scan_completed','export_excel','export_csv','export_vcf','google_contacts_sync') ${cond}`, args).then((r) => r.rows[0].n);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    return send(res, 200, {
      range,
      acquisition: { newAccounts: registered, series },
      activation: { registered, firstLogin, firstScan: activated, activated, signupToActivationPct: pct(activated, registered) },
      conversion: {
        pricingViewed, checkoutStarted, paid,
        signupToPaidPct: pct(paid, registered), activationToPaidPct: pct(paid, activated),
        pricingToCheckoutPct: pct(checkoutStarted, pricingViewed), checkoutToPaidPct: pct(paid, checkoutStarted)
      },
      engagement: { activeClients, scans, exports: exportsCount, googleConnects }
    });
  }

  // ---- ADM-06 Payments ----
  if (req.method === "GET" && pathname === "/api/admin/payments") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const statusFilter = String(url.searchParams.get("status") || "").toLowerCase();
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") || 25)));
    const where = statusFilter ? "where status = $1" : "";
    const wargs = statusFilter ? [statusFilter] : [];
    const total = (await pgPool.query(`select count(*)::int as n from payments ${where}`, wargs)).rows[0].n;
    const rows = (await pgPool.query(
      `select * from payments ${where} order by created_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`, wargs
    )).rows;
    const db = readDb();
    const nameById = new Map(db.organisations.map((o) => [o.id, o.name]));
    const payments = rows.map((p) => ({ ...p, clientName: nameById.get(p.client_id) || p.client_id }));
    return send(res, 200, { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), payments });
  }

  // ---- ADM-07 Activity / Audit ----
  // What customers are doing in the product, as opposed to /api/admin/audit
  // which records what admins did. Reads product_events, newest first, with
  // optional filters on time range, event name and client.
  if (req.method === "GET" && pathname === "/api/admin/events") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") || 40)));
    const range = String(url.searchParams.get("range") || "7d");
    const eventName = String(url.searchParams.get("event") || "").trim();
    const clientId = String(url.searchParams.get("clientId") || "").trim();
    const days = { today: 0, "1d": 1, "7d": 7, "30d": 30, "90d": 90 };
    let startIso = null;
    if (range === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); startIso = d.toISOString(); }
    else if (days[range] != null) startIso = new Date(Date.now() - days[range] * 24 * 60 * 60 * 1000).toISOString();

    const where = [];
    const args = [];
    if (startIso) { args.push(startIso); where.push(`created_at >= $${args.length}`); }
    if (eventName) { args.push(eventName); where.push(`event_name = $${args.length}`); }
    if (clientId) { args.push(clientId); where.push(`client_id = $${args.length}`); }
    const clause = where.length ? `where ${where.join(" and ")}` : "";

    const total = (await pgPool.query(`select count(*)::int as n from product_events ${clause}`, args)).rows[0].n;
    const rows = (await pgPool.query(
      `select id, event_name, client_id, user_id, source, metadata, created_at
         from product_events ${clause}
         order by created_at desc
         limit ${pageSize} offset ${(page - 1) * pageSize}`,
      args
    )).rows;
    const names = (await pgPool.query(
      `select event_name, count(*)::int as n from product_events ${clause} group by event_name order by n desc`, args
    )).rows;

    const db = readDb();
    const orgById = new Map(db.organisations.map((o) => [o.id, o.name]));
    const userById = new Map(db.users.map((u) => [u.id, u.email || u.name || u.phone || ""]));
    const logs = rows.map((r) => {
      const meta = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
      return {
        id: r.id,
        event: r.event_name,
        createdAt: r.created_at,
        clientId: r.client_id,
        clientName: r.client_id ? (orgById.get(r.client_id) || r.client_id) : null,
        user: r.user_id ? (userById.get(r.user_id) || r.user_id) : null,
        source: r.source || "",
        platform: String(meta.platform || ""),
        metadata: meta
      };
    });
    return send(res, 200, { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), logs, eventNames: names });
  }

  if (req.method === "GET" && pathname === "/api/admin/audit") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") || 40)));
    const total = (await pgPool.query("select count(*)::int as n from admin_audit_logs")).rows[0].n;
    const rows = (await pgPool.query(
      `select * from admin_audit_logs order by created_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`
    )).rows;
    const db = readDb();
    const nameById = new Map(db.organisations.map((o) => [o.id, o.name]));
    const logs = rows.map((r) => ({ ...r, clientName: r.client_id ? (nameById.get(r.client_id) || r.client_id) : null }));
    return send(res, 200, { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), logs });
  }

  // ---- ADM-08 Settings: plans + admin users ----
  if (req.method === "GET" && pathname === "/api/admin/settings") {
    const plans = ["monthly", "quarterly", "annual"].map((p) => ({
      name: p, scans: PLAN_LIMITS[p], pricePaise: PLAN_PRICES_PAISE[p], months: PLAN_DURATIONS_MONTHS[p], status: "active"
    }));
    const admins = (await pgPool.query("select id, name, email, role, status, last_login_at, created_at from admin_users order by created_at")).rows;
    return send(res, 200, { plans, admins, me: admin });
  }

  if (req.method === "POST" && pathname === "/api/admin/admins") {
    if (admin.role !== "super_admin") return error(res, 403, "Only a super admin can manage administrators.");
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const role = body.role === "super_admin" ? "super_admin" : "admin";
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, "Name and a valid email are required.");
    const passwordError = validatePasswordStrength(password);
    if (passwordError) return error(res, 400, passwordError);
    const existing = await pgPool.query("select id from admin_users where email = $1", [email]);
    if (existing.rowCount) return error(res, 409, "An admin with this email already exists.");
    const newId = id("adm");
    await pgPool.query(
      `insert into admin_users (id, name, email, password_hash, role, status, created_at, updated_at)
       values ($1,$2,$3,$4,$5,'active',$6,$6)`,
      [newId, name, email, hashPassword(password), role, now()]
    );
    await adminAudit(admin, { action: "ADMIN_CREATED", newValue: { email, role } });
    return send(res, 201, { ok: true, admin: { id: newId, name, email, role, status: "active" } });
  }

  if (req.method === "POST" && pathname.startsWith("/api/admin/admins/") && pathname.split("/").length === 6) {
    if (admin.role !== "super_admin") return error(res, 403, "Only a super admin can manage administrators.");
    const parts = pathname.split("/");
    const targetId = decodeURIComponent(parts[4]);
    const op = parts[5];
    if (!["disable", "reactivate"].includes(op)) return error(res, 400, "Unknown admin operation.");
    if (op === "disable" && targetId === admin.id) return error(res, 400, "You cannot disable your own account.");
    const newStatus = op === "disable" ? "disabled" : "active";
    const r = await pgPool.query("update admin_users set status = $2, updated_at = $3 where id = $1 returning email", [targetId, newStatus, now()]);
    if (!r.rowCount) return error(res, 404, "Admin not found.");
    if (op === "disable") await pgPool.query("delete from admin_sessions where admin_id = $1", [targetId]);
    await adminAudit(admin, { action: op === "disable" ? "ADMIN_DISABLED" : "ADMIN_REACTIVATED", newValue: { adminId: targetId, email: r.rows[0].email } });
    return send(res, 200, { ok: true });
  }

  return error(res, 404, "Unknown admin endpoint.");
 } catch (err) {
  console.error("[admin] error:", err && err.stack ? err.stack : err);
  if (!res.headersSent) return error(res, 500, "Something went wrong in the admin panel.");
 }
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
      const orderEntity = payload.payload?.order?.entity;
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
          await recordSubscription({
            clientId: organisation.id, plan, status: organisation.subscriptionStatus,
            billingMode: "subscription", providerReference: subscriptionEntity?.id,
            startDate: subscriptionEntity?.start_at ? new Date(subscriptionEntity.start_at * 1000).toISOString() : null,
            currentPeriodEnd: newPeriodEnd || null, source: "webhook", eventId: eventId || event,
            metadata: { razorpayEvent: event }
          });
          audit(db, { organisationId: organisation.id }, `billing.${event}`, "organisation", organisation.id, { plan });
          // Log the recurring charge (the whole webhook is deduped by eventId, so
          // each subscription.charged for a cycle is recorded exactly once).
          if (event === "subscription.charged") {
            await recordPayment({ clientId: organisation.id, amountPaise: Number(paymentEntity?.amount) || PLAN_PRICES_PAISE[plan] || 0, plan, status: "paid", providerPaymentId: paymentEntity?.id || "", subscriptionId: subscriptionEntity?.id || "" });
            if (isNewPeriod) await setLedgerBalance({ clientId: organisation.id, type: "PLAN_ALLOCATION", quantity: organisation.scanLimit, targetBalance: organisation.scanLimit, source: "plan", referenceId: subscriptionEntity?.id || "", idempotencyKey: `allocation:${eventId || `${subscriptionEntity?.id}:${newPeriodEnd}`}`, metadata: { plan, mode: "subscription", periodEnd: newPeriodEnd } });
          }
          await recordProductEvent({ name: "plan_activated", clientId: organisation.id, source: "webhook", idempotencyKey: `sub:${subscriptionEntity?.id}:${eventId || event}`, metadata: { plan, mode: "subscription", event } });
        }
      } else if (["subscription.halted", "subscription.cancelled", "subscription.completed", "subscription.paused"].includes(event)) {
        const organisation = db.organisations.find((o) => o.subscriptionId === subscriptionEntity?.id);
        if (organisation) {
          organisation.subscriptionStatus = event.replace("subscription.", "");
          organisation.updatedAt = now();
          await recordSubscription({ clientId: organisation.id, plan: organisation.plan, status: organisation.subscriptionStatus, billingMode: "subscription", providerReference: subscriptionEntity?.id, currentPeriodEnd: organisation.currentPeriodEnd || null, source: "webhook", eventId: eventId || event, metadata: { razorpayEvent: event } });
          await recordProductEvent({ name: event.replace(".", "_"), clientId: organisation.id, source: "webhook", idempotencyKey: `subscription:${eventId || `${subscriptionEntity?.id}:${event}`}` });
        }
      } else if (event === "order.paid" || event === "payment.captured") {
        const paymentNotes = paymentEntity?.notes || {};
        const notes = Object.keys(paymentNotes).length ? paymentNotes : (orderEntity?.notes || {});
        const orderId = paymentEntity?.order_id || orderEntity?.id || "";
        const organisation = db.organisations.find((o) => o.id === notes.organisationId)
          || db.organisations.find((o) => pendingOneTimeOrder(o, orderId))
          || db.organisations.find((o) => pendingTopupOrder(o, orderId));
        if (organisation && notes.type === "topup" && orderId) {
          organisation.grantedTopupOrders = Array.isArray(organisation.grantedTopupOrders) ? organisation.grantedTopupOrders : [];
          if (!organisation.grantedTopupOrders.includes(orderId)) {
            const scans = Number(notes.scans) || TOPUP_SCANS;
            grantTopupEntitlement(organisation, scans);
            organisation.grantedTopupOrders.push(orderId);
            organisation.pendingTopupOrders = (organisation.pendingTopupOrders || []).filter((order) => order.orderId !== orderId);
            audit(db, { organisationId: organisation.id }, "billing.topup_charged", "organisation", organisation.id, { orderId });
            await recordPayment({ clientId: organisation.id, amountPaise: Number(paymentEntity?.amount) || TOPUP_AMOUNT_PAISE, plan: "topup", status: "paid", providerPaymentId: paymentEntity?.id || "", providerOrderId: orderId });
            await recordUsageLedger({ clientId: organisation.id, type: "TOPUP_PURCHASE", quantity: scans, balanceEffect: scans, source: "topup", referenceId: orderId, idempotencyKey: `topup:${orderId}`, metadata: { scans } });
          }
        } else if (organisation && (notes.type === "one_time_plan" || pendingOneTimeOrder(organisation, orderId)) && orderId) {
          const pendingOrder = pendingOneTimeOrder(organisation, orderId);
          const plan = notes.plan || pendingOrder?.plan || "";
          if (grantOneTimePlan(organisation, plan, { orderId, paymentId: paymentEntity?.id || "" })) {
            audit(db, { organisationId: organisation.id }, "billing.one_time_charged", "organisation", organisation.id, { orderId, plan });
            await recordPayment({ clientId: organisation.id, amountPaise: PLAN_PRICES_PAISE[plan] || Number(paymentEntity?.amount) || 0, plan, status: "paid", providerPaymentId: paymentEntity?.id || "", providerOrderId: orderId });
            await setLedgerBalance({ clientId: organisation.id, type: "PLAN_ALLOCATION", quantity: organisation.scanLimit, targetBalance: organisation.scanLimit, source: "plan", referenceId: orderId, idempotencyKey: `allocation:${orderId}`, metadata: { plan, mode: "one_time" } });
            await recordSubscription({ clientId: organisation.id, plan, status: "active", billingMode: "one_time", providerReference: orderId, startDate: now(), currentPeriodEnd: organisation.currentPeriodEnd, source: "webhook", eventId: eventId || `order:${orderId}`, metadata: { paymentId: paymentEntity?.id || "" } });
            await recordProductEvent({ name: "plan_activated", clientId: organisation.id, source: "webhook", idempotencyKey: `plan:${orderId}`, metadata: { plan, mode: "one_time" } });
          }
        }
      } else if (event === "payment.failed") {
        const pe = paymentEntity || {};
        const failNotes = pe.notes || {};
        const organisation = db.organisations.find((o) => o.id === failNotes.organisationId)
          || db.organisations.find((o) => o.subscriptionId === pe.subscription_id);
        if (organisation) {
          await recordPayment({ clientId: organisation.id, amountPaise: Number(pe.amount) || 0, plan: failNotes.plan || "", status: "failed", providerPaymentId: pe.id || "", providerOrderId: pe.order_id || "", failureReason: pe.error_description || pe.error_reason || "" });
          await recordProductEvent({ name: "payment_failed", clientId: organisation.id, source: "webhook", metadata: { reason: pe.error_reason || "" } });
          // A failed recurring charge becomes past_due so it surfaces in the admin attention queue.
          if (pe.subscription_id && organisation.subscriptionId === pe.subscription_id) {
            organisation.subscriptionStatus = "past_due";
            organisation.updatedAt = now();
            await recordSubscription({ clientId: organisation.id, plan: organisation.plan, status: "past_due", billingMode: "subscription", providerReference: pe.subscription_id, currentPeriodEnd: organisation.currentPeriodEnd || null, source: "webhook", eventId: eventId || `failed:${pe.id}` });
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
      const demoAccount = isDemoEmail(email);
      const org = {
        id: id("org"),
        name: `${body.name}'s Workspace`,
        plan: demoAccount ? "demo" : "trial",
        scanLimit: demoAccount ? DEMO_ACCOUNT_SCANS : 0,
        scansUsed: 0,
        isDemoAccount: demoAccount,
        topupScans: 0,
        retentionPolicy: "90-days",
        // Signup no longer collects a workspace profile up front. The first
        // contact list is created on demand by collectionForUser, and the
        // exhibition is set from the upload screen, so there is nothing left
        // to block on.
        setupComplete: true,
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
      await recordProductEvent({ name: "account_created", clientId: org.id, userId: user.id, source: "register", idempotencyKey: `account_created:${org.id}`, metadata: { demo: demoAccount } });
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

    // Phone (WhatsApp) OTP — step 1: send a code to the number.
    if (req.method === "POST" && pathname === "/api/auth/otp/request") {
      if (!rateLimit(req, res, "otp-request", 20, 60 * 60 * 1000)) return; // per-IP guard
      const body = await readJson(req);
      const phone = normalizePhoneE164(body.phone);
      if (!isPlausiblePhone(phone)) return error(res, 400, "Enter a valid mobile number with country code.");
      if (!whatsappOtpConfigured()) return error(res, 503, "Phone login isn't available right now. Please sign in with email.");
      const nowMs = Date.now();
      const rec = otpStore.get(phone) || { sends: [] };
      rec.sends = (rec.sends || []).filter((t) => nowMs - t < 60 * 60 * 1000);
      if (rec.lastSentAt && nowMs - rec.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
        return error(res, 429, "Please wait a minute before requesting another code.");
      }
      if (rec.sends.length >= OTP_MAX_SENDS_PER_HOUR) {
        return error(res, 429, "Too many codes requested for this number. Try again later.");
      }
      const code = String(crypto.randomInt(100000, 1000000));
      rec.hash = hashOtp(phone, code);
      rec.expiresAt = nowMs + OTP_TTL_MS;
      rec.attempts = 0;
      rec.lastSentAt = nowMs;
      rec.sends.push(nowMs);
      otpStore.set(phone, rec);
      try {
        await sendWhatsappOtp(phone, code);
      } catch (err) {
        console.error("[otp] send failed:", err.message);
        return error(res, 502, "We couldn't send the code. Check the number and try again.");
      }
      return send(res, 200, { ok: true, cooldownSeconds: OTP_RESEND_COOLDOWN_MS / 1000 });
    }

    // Phone (WhatsApp) OTP — step 2: verify the code, then log in (or sign up).
    if (req.method === "POST" && pathname === "/api/auth/otp/verify") {
      if (!rateLimit(req, res, "otp-verify", 30, 60 * 60 * 1000)) return;
      const body = await readJson(req);
      const phone = normalizePhoneE164(body.phone);
      const code = String(body.code || "").replace(/\D/g, "");
      const rec = otpStore.get(phone);
      if (!rec || !rec.hash) return error(res, 400, "Request a code first.");
      if (Date.now() > rec.expiresAt) { otpStore.delete(phone); return error(res, 400, "That code has expired. Request a new one."); }
      if (rec.attempts >= OTP_MAX_ATTEMPTS) { otpStore.delete(phone); return error(res, 429, "Too many attempts. Request a new code."); }
      rec.attempts += 1;
      if (hashOtp(phone, code) !== rec.hash) return error(res, 401, "Incorrect code. Please try again.");
      otpStore.delete(phone); // one-time use
      // Log in the existing account for this number, or create a new one.
      let user = db.users.find((u) => u.phone && normalizePhoneE164(u.phone) === phone && !u.deletedAt);
      if (!user) {
        const org = {
          id: id("org"),
          name: "My Workspace",
          plan: "trial",
          scanLimit: 0,
          scansUsed: 0,
          isDemoAccount: false,
          topupScans: 0,
          retentionPolicy: "90-days",
          setupComplete: true,
          createdAt: now(),
          updatedAt: now()
        };
        db.organisations.push(org);
        user = {
          id: id("usr"),
          organisationId: org.id,
          name: "",
          email: "",
          phone,
          passwordHash: "",
          authProvider: "phone",
          role: "owner",
          emailVerified: true,
          status: "active",
          createdAt: now(),
          updatedAt: now()
        };
        db.users.push(user);
        audit(db, user, "user.phone_registered", "user", user.id, { phone });
        await recordProductEvent({ name: "registered", clientId: org.id, userId: user.id, source: "otp", idempotencyKey: `registered:${user.id}` });
      } else {
        audit(db, user, "user.phone_logged_in", "user", user.id);
      }
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
      const acceptingInvitation = user.status === "pending_invitation";
      user.passwordHash = hashPassword(String(body.password));
      if (acceptingInvitation) {
        user.status = "active";
        user.emailVerified = true;
      }
      user.passwordResetToken = "";
      user.passwordResetExpiresAt = "";
      user.updatedAt = now();
      db.sessions = db.sessions.filter((s) => s.userId !== user.id);
      audit(db, user, "user.password_reset_completed", "user", user.id);
      await saveDb(db);
      if (acceptingInvitation) {
        await recordProductEvent({ name: "invitation_accepted", clientId: user.organisationId, userId: user.id, source: "invitation", idempotencyKey: `invitation_accepted:${user.id}` });
      }
      return send(res, 200, { message: "Password updated. Please log in with your new password." });
    }

    if (req.method === "GET" && pathname === "/api/auth/google/start") {
      if (!googleConfigured()) return error(res, 400, "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env before Google login.");
      const oauthState = randomToken("glg");
      const mobileLogin = new URL(req.url, `http://${req.headers.host}`).searchParams.get("mobile") === "1";
      const handoff = String(new URL(req.url, `http://${req.headers.host}`).searchParams.get("handoff") || "").slice(0, 80);
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
          tempCookie(req, "google_login_mobile", mobileLogin ? "1" : "", 10 * 60),
          tempCookie(req, "google_login_handoff", handoff, 10 * 60)
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
      console.log("[google-login] callback hit", { hasCode: Boolean(code), returnedState: returnedState ? "yes" : "no", expectedState: expectedState ? "yes" : "no", stateMatch: Boolean(returnedState) && returnedState === expectedState, mobileLogin });
      if (!code || !returnedState || returnedState !== expectedState) {
        console.error("[google-login] state check failed — cookie likely dropped on the cross-site redirect back from Google");
        return redirect(res, "/?auth=google_failed");
      }
      let tokens, profile;
      try {
        tokens = await exchangeGoogleCode(code, googleLoginRedirectUri(req));
        profile = await fetchGoogleProfile(tokens.access_token);
      } catch (err) {
        // Most often a redirect_uri mismatch (http vs https / wrong host) or an
        // expired code. Redirect to a visible error instead of hanging blank.
        console.error("[google-login] token exchange failed:", err.message, "redirect_uri:", googleLoginRedirectUri(req));
        return redirect(res, "/?auth=google_failed");
      }
      if (!profile.email || profile.email_verified !== true || !profile.sub) return redirect(res, "/?auth=google_failed");
      const outcome = findOrCreateGoogleUser(db, profile);
      if (outcome.conflict) return redirect(res, "/?auth=google_failed");
      const user = outcome.user;
      const existingAccount = outcome.existingAccount;
      if (mobileLogin) {
        const mobileCode = randomToken("mob");
        mobileAuthCodes.set(mobileCode, {
          userId: user.id,
          // The deep-link bridge adds a user tap between issuing and redeeming
          // this code, so a 2-minute window was easy to miss. Still single-use.
          expiresAt: Date.now() + 10 * 60 * 1000
        });
        await saveDb(db);
        const handoffToken = parseCookies(req).google_login_handoff || "";
        if (handoffToken) {
          mobileHandoffs.set(handoffToken, { userId: user.id, expiresAt: Date.now() + 10 * 60 * 1000 });
          console.log("[google-login] recorded hand-off for polling claim");
        }
        console.log("[google-login] success — handing off to easysave://auth deep link (mobile)");
        return sendDeepLinkBridge(res, `easysave://auth?code=${encodeURIComponent(mobileCode)}`, {
          "Set-Cookie": [
            tempCookie(req, "google_login_state", "", 0),
            tempCookie(req, "google_login_mobile", "", 0),
            tempCookie(req, "google_login_handoff", "", 0)
          ]
        });
      }
      await createSession(req, res, db, user, existingAccount ? "/?auth=google_existing" : "/?auth=google_ok", [
        tempCookie(req, "google_login_state", "", 0),
        tempCookie(req, "google_login_mobile", "", 0)
      ]);
      return;
    }

    // Diagnostic page: serves the same deep-link bridge with a throwaway code so
    // the app hand-off can be tested on its own, away from the OAuth flow.
    // Chrome will not open a typed custom-scheme URL, so a real tappable link is
    // the only way to exercise it. Safe: the code is never a valid grant.
    if (req.method === "GET" && pathname === "/api/deeplink-test") {
      console.log("[deeplink-test] serving bridge page with a throwaway code");
      return sendDeepLinkBridge(res, "easysave://auth?code=deeplinktest123");
    }

    // Opens web checkout as the mobile user. The app's session cookie lives in
    // its own cookie jar, so without this the browser would show whichever
    // account it happened to be signed into — and payment could land on the
    // wrong workspace.
    if (req.method === "GET" && pathname === "/api/billing/checkout") {
      const token = String(new URL(req.url, `http://${req.headers.host}`).searchParams.get("token") || "");
      const grant = checkoutHandoffs.get(token);
      if (grant) checkoutHandoffs.delete(token);
      if (!grant || grant.expiresAt < Date.now()) return redirect(res, "/#account");
      const checkoutUser = db.users.find((candidate) => candidate.id === grant.userId && candidate.status === "active");
      if (!checkoutUser) return redirect(res, "/#account");
      console.log("[checkout] opening web checkout as", checkoutUser.email, grant.plan || grant.topup ? `(${grant.plan || "top-up"})` : "");
      const target = grant.topup
        ? "/?checkoutTopup=1#account"
        : grant.plan
          ? `/?checkoutPlan=${encodeURIComponent(grant.plan)}#account`
          : "/#account";
      return await createSession(req, res, db, checkoutUser, target);
    }

    // Native Google Sign-In: the app obtains an ID token from Google Play
    // Services directly, with no browser and no redirect, and exchanges it here
    // for a session. The browser flow stays in place as a fallback.
    if (req.method === "POST" && pathname === "/api/auth/google/native") {
      if (!rateLimit(req, res, "auth-google-native", 30, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const idToken = String(body.idToken || "");
      if (!idToken) return error(res, 400, "Missing Google sign-in token.");
      let profile;
      try {
        profile = await verifyGoogleIdToken(idToken);
      } catch (err) {
        console.error("[google-native] verification failed:", err.message);
        return error(res, 401, err.message || "That Google sign-in could not be verified.");
      }
      const outcome = findOrCreateGoogleUser(db, profile);
      if (outcome.conflict) return error(res, 409, "This email already signs in with a different Google account.");
      await saveDb(db);
      console.log("[google-native] success —", outcome.existingAccount ? "signed in" : "registered", profile.email);
      return await createSession(req, res, db, outcome.user);
    }

    // Mints the hand-off reference the app polls with. Server-generated so the
    // token is cryptographically random rather than guessable.
    if (req.method === "POST" && pathname === "/api/auth/mobile/handoff") {
      if (!rateLimit(req, res, "auth-mobile-handoff", 60, 15 * 60 * 1000)) return;
      return send(res, 200, { handoff: randomToken("hof") });
    }

    // The app polls this after opening the sign-in browser. Returns the session
    // as soon as Google's callback has completed, so a failed deep-link
    // hand-off can no longer strand the user on the login screen.
    if (req.method === "POST" && pathname === "/api/auth/mobile/claim") {
      if (!rateLimit(req, res, "auth-mobile-claim", 400, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const handoff = String(body.handoff || "").slice(0, 80);
      if (!handoff) return error(res, 400, "Missing sign-in reference.");
      const grant = mobileHandoffs.get(handoff);
      if (!grant) return send(res, 200, { pending: true });
      if (grant.expiresAt < Date.now()) {
        mobileHandoffs.delete(handoff);
        return error(res, 400, "This sign-in request has expired. Please try again.");
      }
      mobileHandoffs.delete(handoff);
      const claimUser = db.users.find((candidate) => candidate.id === grant.userId && candidate.status === "active");
      if (!claimUser) return error(res, 400, "This account is not available.");
      console.log("[mobile-claim] success — creating session for", claimUser.email);
      return await createSession(req, res, db, claimUser);
    }

    if (req.method === "POST" && pathname === "/api/auth/mobile/exchange") {
      // Raised from 12: a user retrying sign-in a few times (or the bridge page
      // delivering the link twice) could otherwise exhaust the window and get
      // locked out of signing in entirely.
      if (!rateLimit(req, res, "auth-mobile-exchange", 40, 15 * 60 * 1000)) {
        console.error("[mobile-exchange] rate limited — sign-in blocked for this client");
        return;
      }
      const body = await readJson(req);
      const code = String(body.code || "");
      const grant = mobileAuthCodes.get(code);
      mobileAuthCodes.delete(code);
      console.log("[mobile-exchange] attempt", { hasCode: Boolean(code), knownCode: Boolean(grant), expired: grant ? grant.expiresAt < Date.now() : null, codesInStore: mobileAuthCodes.size });
      if (!grant || grant.expiresAt < Date.now()) {
        console.error("[mobile-exchange] rejected:", !grant ? "code not found in this process (already used, or issued by another instance / before a restart)" : "code expired");
        return error(res, 400, "This mobile sign-in request has expired. Please try again.");
      }
      const user = db.users.find((candidate) => candidate.id === grant.userId && candidate.status === "active");
      if (!user) {
        console.error("[mobile-exchange] rejected: user not found or inactive");
        return error(res, 400, "This account is not available.");
      }
      console.log("[mobile-exchange] success — creating session for", user.email);
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
      // Legacy sessions may still carry the state from before it moved in-memory.
      const legacySession = returnedState
        ? db.sessions.find((candidate) => candidate.googleMobileOAuthState === returnedState)
        : null;
      const mobileFlow = (returnedState && googleMobileOAuthStates.get(returnedState))
        || (legacySession ? { userId: legacySession.userId, feature: legacySession.googleMobileOAuthFeature, createdAt: new Date(legacySession.googleMobileOAuthCreatedAt || 0).getTime() } : null);
      if (mobileFlow) {
        const code = url.searchParams.get("code");
        const createdAt = Number(mobileFlow.createdAt || 0);
        const mobileUser = db.users.find((candidate) => candidate.id === mobileFlow.userId && candidate.status === "active");
        const feature = mobileFlow.feature === "contacts" ? "contacts" : "sheets";
        if (returnedState) googleMobileOAuthStates.delete(returnedState);
        if (legacySession) {
          delete legacySession.googleMobileOAuthState;
          delete legacySession.googleMobileOAuthCreatedAt;
          delete legacySession.googleMobileOAuthFeature;
        }
        if (!code || !createdAt || Date.now() - createdAt > 10 * 60 * 1000) {
          return redirect(res, "easysave://auth?google_sheets=failed");
        }
        if (!mobileUser) {
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
          connection.scopes = scopesForNewToken(connection.scopes, tokens.scope, feature);
          connection.status = "active";
          connection.updatedAt = now();
          markGoogleFeatureConnected(db, mobileUser, connection.scopes);
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

    // Client-side funnel beacon. Only a small whitelist of front-end-observable
    // events is accepted; everything else is recorded server-side at its source.
    if (req.method === "POST" && pathname === "/api/events") {
      const body = await readJson(req);
      const ALLOWED_CLIENT_EVENTS = new Set(["pricing_viewed", "plan_selected"]);
      const name = String(body.name || "");
      if (!ALLOWED_CLIENT_EVENTS.has(name)) return error(res, 400, "Unsupported event.");
      const meta = (body.metadata && typeof body.metadata === "object") ? body.metadata : {};
      await recordProductEvent({ name, clientId: user.organisationId, userId: user.id, source: "client", metadata: meta });
      return send(res, 200, { ok: true });
    }

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
      await recordSubscription({ clientId: organisation.id, plan, status: subscription.status || "pending", billingMode: "subscription", providerReference: subscription.id, startDate: subscription.start_at ? new Date(subscription.start_at * 1000).toISOString() : null, currentPeriodEnd: subscription.current_end ? new Date(subscription.current_end * 1000).toISOString() : null, source: "checkout", eventId: `created:${subscription.id}` });
      await recordProductEvent({ name: "checkout_started", clientId: organisation.id, userId: user.id, source: "billing", metadata: { plan, mode: "subscription" } });
      return send(res, 200, { subscriptionId: subscription.id, keyId: RAZORPAY_KEY_ID, plan });
    }

    if (req.method === "POST" && pathname === "/api/billing/one-time") {
      if (!billingConfigured()) return error(res, 400, "Online payments are not set up yet. Please try again later.");
      const body = await readJson(req);
      const plan = String(body.plan || "");
      if (!PLAN_DURATIONS_MONTHS[plan]) return error(res, 400, "Choose a valid one-time plan.");
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      const order = await razorpayApi("/orders", {
        method: "POST",
        body: {
          amount: PLAN_PRICES_PAISE[plan],
          currency: "INR",
          receipt: `once_${organisation.id}_${Date.now()}`,
          notes: {
            organisationId: organisation.id,
            type: "one_time_plan",
            plan,
            months: String(PLAN_DURATIONS_MONTHS[plan]),
            scans: String(PLAN_LIMITS[plan])
          }
        }
      });
      organisation.pendingOneTimeOrders = Array.isArray(organisation.pendingOneTimeOrders) ? organisation.pendingOneTimeOrders : [];
      organisation.pendingOneTimeOrders = organisation.pendingOneTimeOrders
        .filter((item) => new Date(item.createdAt || 0).getTime() > Date.now() - 24 * 60 * 60 * 1000)
        .slice(-20);
      organisation.pendingOneTimeOrders.push({
        orderId: order.id,
        plan,
        amount: order.amount,
        createdAt: now()
      });
      organisation.updatedAt = now();
      audit(db, user, "billing.one_time_order_created", "organisation", organisation.id, { orderId: order.id, plan });
      await saveDb(db);
      await recordProductEvent({ name: "checkout_started", clientId: organisation.id, userId: user.id, source: "billing", metadata: { plan, mode: "one_time" } });
      return send(res, 200, {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: RAZORPAY_KEY_ID,
        plan,
        scans: PLAN_LIMITS[plan],
        months: PLAN_DURATIONS_MONTHS[plan]
      });
    }

    if (req.method === "POST" && pathname === "/api/billing/one-time/verify") {
      const body = await readJson(req);
      const orderId = String(body.razorpay_order_id || "");
      const paymentId = String(body.razorpay_payment_id || "");
      const signature = String(body.razorpay_signature || "");
      if (!orderId || !paymentId || !signature) return error(res, 400, "Missing payment details.");
      if (!razorpaySignatureValid(`${orderId}|${paymentId}`, signature)) return error(res, 400, "Payment could not be verified.");
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      const pendingOrder = pendingOneTimeOrder(organisation, orderId);
      if (!pendingOrder) return error(res, 400, "This payment order was not found for your workspace.");
      if (grantOneTimePlan(organisation, pendingOrder.plan, { orderId, paymentId })) {
        audit(db, user, "billing.one_time_verified", "organisation", organisation.id, { orderId, paymentId, plan: pendingOrder.plan });
        await recordPayment({ clientId: organisation.id, userId: user.id, amountPaise: PLAN_PRICES_PAISE[pendingOrder.plan] || 0, plan: pendingOrder.plan, status: "paid", providerPaymentId: paymentId, providerOrderId: orderId });
        await setLedgerBalance({ clientId: organisation.id, userId: user.id, type: "PLAN_ALLOCATION", quantity: organisation.scanLimit, targetBalance: organisation.scanLimit, source: "plan", referenceId: orderId, idempotencyKey: `allocation:${orderId}`, metadata: { plan: pendingOrder.plan, mode: "one_time" } });
        await recordSubscription({ clientId: organisation.id, plan: pendingOrder.plan, status: "active", billingMode: "one_time", providerReference: orderId, startDate: now(), currentPeriodEnd: organisation.currentPeriodEnd, source: "verify", eventId: `verified:${paymentId}`, metadata: { paymentId } });
        await recordProductEvent({ name: "plan_activated", clientId: organisation.id, userId: user.id, source: "verify", idempotencyKey: `plan:${orderId}`, metadata: { plan: pendingOrder.plan, mode: "one_time", platform: clientPlatform(req) } });
      }
      await saveDb(db);
      return send(res, 200, { ok: true, usage: await authoritativePlanUsage(organisation), billing: billingSummary(organisation) });
    }

    if (req.method === "POST" && pathname === "/api/billing/topup") {
      if (!billingConfigured()) return error(res, 400, "Online payments are not set up yet. Please try again later.");
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      if (!canPurchaseTopup(organisation)) return error(res, 400, topupUnavailableReason(organisation));
      const order = await razorpayApi("/orders", {
        method: "POST",
        body: {
          amount: TOPUP_AMOUNT_PAISE,
          currency: "INR",
          receipt: `topup_${organisation.id}_${Date.now()}`,
          notes: { organisationId: organisation.id, type: "topup", scans: String(TOPUP_SCANS) }
        }
      });
      organisation.pendingTopupOrders = Array.isArray(organisation.pendingTopupOrders) ? organisation.pendingTopupOrders : [];
      organisation.pendingTopupOrders = organisation.pendingTopupOrders
        .filter((item) => new Date(item.createdAt || 0).getTime() > Date.now() - 24 * 60 * 60 * 1000)
        .slice(-20);
      organisation.pendingTopupOrders.push({
        orderId: order.id,
        amount: order.amount,
        scans: TOPUP_SCANS,
        createdAt: now()
      });
      organisation.updatedAt = now();
      audit(db, user, "billing.topup_order_created", "organisation", organisation.id, { orderId: order.id });
      await saveDb(db);
      await recordProductEvent({ name: "checkout_started", clientId: organisation.id, userId: user.id, source: "billing", metadata: { mode: "topup", scans: TOPUP_SCANS } });
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
      if (organisation.grantedTopupOrders.includes(orderId)) {
        return send(res, 200, { ok: true, duplicate: true, usage: await authoritativePlanUsage(organisation), billing: billingSummary(organisation) });
      }
      const pendingOrder = pendingTopupOrder(organisation, orderId);
      if (!pendingOrder) return error(res, 400, "This credit order was not found for your workspace.");
      const topupScans = Number(pendingOrder.scans) || TOPUP_SCANS;
      grantTopupEntitlement(organisation, topupScans);
      organisation.grantedTopupOrders.push(orderId);
      organisation.pendingTopupOrders = organisation.pendingTopupOrders.filter((order) => order.orderId !== orderId);
      audit(db, user, "billing.topup_verified", "organisation", organisation.id, { orderId, paymentId });
      await recordPayment({ clientId: organisation.id, userId: user.id, amountPaise: TOPUP_AMOUNT_PAISE, plan: "topup", status: "paid", providerPaymentId: paymentId, providerOrderId: orderId });
      await recordUsageLedger({ clientId: organisation.id, userId: user.id, type: "TOPUP_PURCHASE", quantity: topupScans, balanceEffect: topupScans, source: "topup", referenceId: orderId, idempotencyKey: `topup:${orderId}`, metadata: { scans: topupScans } });
      await saveDb(db);
      return send(res, 200, { ok: true, usage: await authoritativePlanUsage(organisation), billing: billingSummary(organisation) });
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
        // Kept in memory so starting a Google connection does not trigger a full
        // database write; the callback reads it back by state.
        googleMobileOAuthStates.set(oauthState, { userId: session.userId, feature, createdAt: Date.now() });
        return send(res, 200, { authUrl: authUrl.toString() });
      }
      googleWebOAuthStates.set(oauthState, { userId: session.userId, feature, createdAt: Date.now() });
      return redirect(res, authUrl.toString());
    }

    if (req.method === "GET" && pathname === "/api/google/callback") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const session = currentSession(req, db);
      const webFlow = returnedState ? googleWebOAuthStates.get(returnedState) : null;
      if (webFlow) googleWebOAuthStates.delete(returnedState);
      const stateOk = webFlow
        ? webFlow.userId === user.id && Date.now() - Number(webFlow.createdAt || 0) < 10 * 60 * 1000
        : Boolean(session && returnedState && session.googleOAuthState === returnedState);
      if (!stateOk) {
        return error(res, 400, "Google connection state did not match. Please try connecting again.");
      }
      if (!code) return error(res, 400, "Google did not return an authorization code.");
      const feature = (webFlow ? webFlow.feature : session?.googleOAuthFeature) === "contacts" ? "contacts" : "sheets";
      let tokens, profile;
      try {
        tokens = await exchangeGoogleCode(code, googleRedirectUri(req));
        profile = await fetchGoogleProfile(tokens.access_token);
      } catch (err) {
        console.error("[google-connect] token exchange failed:", err.message, "redirect_uri:", googleRedirectUri(req));
        return redirect(res, "/?google=failed#contacts/sheets");
      }
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
      connection.scopes = scopesForNewToken(connection.scopes, tokens.scope, feature);
      connection.status = "active";
      connection.updatedAt = now();
      markGoogleFeatureConnected(db, user, connection.scopes);
      delete session.googleOAuthState;
      delete session.googleOAuthCreatedAt;
      delete session.googleOAuthFeature;
      audit(db, user, "google.connected", "google_connection", connection.id, { googleEmail: connection.googleEmail });
      await saveDb(db);
      await recordProductEvent({ name: "google_connected", clientId: user.organisationId, userId: user.id, source: "google", metadata: { feature, platform: clientPlatform(req) } });
      return redirect(res, feature === "contacts" ? "/?google_contacts=connected#contacts" : "/?google=connected#contacts/sheets");
    }

    if (req.method === "GET" && pathname === "/api/overview") {
      const collections = db.collections.filter((c) => c.organisationId === user.organisationId && c.status !== "deleted");
      const active = findCollectionForUser(db, user);
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      // Flag the demo/test account on any authenticated load, so an account that
      // already existed before DEMO_ACCOUNT_EMAIL was set still becomes unlimited.
      if (organisation && isDemoEmail(user.email) && !organisation.isDemoAccount) {
        organisation.isDemoAccount = true;
        organisation.plan = "demo";
        organisation.updatedAt = now();
        await saveDb(db);
      }
      const contacts = db.contacts.filter((c) => c.organisationId === user.organisationId && !c.deletedAt);
      const cards = db.cards.filter((c) => c.organisationId === user.organisationId);
      return send(res, 200, {
        activeCollection: active,
        collections,
        organisation,
        needsOnboarding: organisationNeedsOnboarding(db, user),
        usage: await authoritativePlanUsage(organisation),
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
      // Onboarding now captures the client's name, company and phone (mandatory)
      // so the admin panel can identify and search accounts (D3).
      const companyName = String(body.companyName || body.businessName || "").trim();
      if (!companyName) return error(res, 400, "Company name is required.");
      const contactName = String(body.contactName || body.name || user.name || "").trim();
      if (!contactName) return error(res, 400, "Your name is required.");
      const phone = String(body.phone || "").trim();
      if (phone.replace(/\D/g, "").length < 7) return error(res, 400, "A valid phone number is required.");
      const destinationType = ["excel", "google"].includes(body.destinationType) ? body.destinationType : "excel";
      // Someone who signed in with WhatsApp has no email yet, which leaves the
      // account with no recovery address and no way to receive receipts. Let
      // them add one here — optional, and never overwrites an existing email.
      const providedEmail = String(body.email || "").trim().toLowerCase();
      if (providedEmail && !user.email) {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(providedEmail)) return error(res, 400, "Enter a valid email address, or leave it blank.");
        const takenBy = db.users.find((candidate) => candidate.id !== user.id && String(candidate.email || "").toLowerCase() === providedEmail && candidate.status !== "deleted");
        if (takenBy) return error(res, 400, "Another Card2Leads account already uses that email address.");
        user.email = providedEmail;
        user.emailVerified = false; // unconfirmed until they use a reset link
      }
      user.name = contactName;
      user.phone = phone;
      user.updatedAt = now();
      // Reaffirm demo status here in case DEMO_ACCOUNT_EMAIL was set after signup.
      if (isDemoEmail(user.email) && !organisation.isDemoAccount) {
        organisation.isDemoAccount = true;
        organisation.plan = "demo";
        organisation.scanLimit = DEMO_ACCOUNT_SCANS;
      }
      organisation.name = companyName;
      organisation.contactPhone = phone;
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
      const duplicate = findExistingCollection(db, user, exhibitionName);
      if (duplicate) {
        db.collections.forEach((c) => {
          if (c.organisationId === user.organisationId) c.status = c.id === duplicate.id ? "active" : "archived";
        });
        if (!duplicate.exhibitionDate && body.exhibitionDate) duplicate.exhibitionDate = String(body.exhibitionDate);
        duplicate.updatedAt = now();
        await saveDb(db);
        return send(res, 200, {
          collection: duplicate,
          existing: true,
          message: `"${duplicate.exhibitionName || duplicate.name}" already exists, so it has been selected instead of creating a duplicate.`
        });
      }
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
      // When staging, cards are stored but not read: they wait in "staged" until
      // the user taps Start processing (POST /api/uploads/process-pending). This
      // is the exhibition flow — capture fast now, process the batch later.
      const stage = body.stage === true;
      // Pay-to-start: staging (capturing) is always allowed, but actually reading
      // cards needs scan credits. Block the process-now path up front with a clear
      // message rather than letting the cards queue and silently never process.
      if (!stage) {
        const org = db.organisations.find((o) => o.id === user.organisationId);
        const usage = await authoritativePlanUsage(org);
        if (usage.remaining <= 0) {
          return error(res, 402, scanBlockedMessage(usage), { code: "payment_required" });
        }
      }
      const totalBytes = files.reduce(
        (sum, file) => sum + Math.max(0, Number(file.size || 0)) + Math.max(0, Number(file.backSize || 0)),
        0
      );
      if (totalBytes > MAX_BATCH_BYTES) return error(res, 400, "The combined batch size cannot exceed 150 MB.");

      // Uploading only stores the images and creates "queued" cards — no AI
      // call happens here. The background queue processor (see
      // scheduleQueueProcessing/processQueueCycle) picks them up afterwards,
      // 5 at a time, and only then counts each one against the plan's scan
      // allowance. This lets someone upload everything they collected in one
      // go without hitting a synchronous batch-size wall.
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
        status: stage ? "staged" : "processing",
        createdAt: now()
      };
      db.uploadBatches.unshift(batch);

      const cards = [];
      const batchChecksums = new Map();
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
        // Only a still-live, real card blocks a re-upload. Excluded: deleted
        // cards, and marker cards that never held their own extraction (a prior
        // skipped-duplicate or a failed upload). Crucially, a *saved* card only
        // blocks while its contact still exists — so once the contact is deleted
        // the same image can be scanned again. Checking the contact directly
        // (rather than trusting the card to have been freed at delete time) also
        // self-heals cards orphaned by earlier deletes made before this fix.
        const duplicateImage = db.cards.find((c) =>
          c.organisationId === user.organisationId &&
          c.checksum === checksum &&
          !c.deletedAt &&
          !["deleted", "skipped_duplicate", "failed"].includes(c.status) &&
          (c.status !== "saved" || db.contacts.some((ct) => ct.sourceCardId === c.id && !ct.deletedAt))
        );
        const duplicateImageId = duplicateInBatchId || duplicateImage?.id || "";
        // An identical image never needs a second AI extraction call — skip it
        // outright instead of queueing and paying for it, so cost only scales
        // with genuinely new cards.
        if (duplicateImageId) {
          const skippedCard = {
            id: id("crd"),
            organisationId: user.organisationId,
            collectionId: collection.id,
            batchId: batch.id,
            originalFileName: file.name,
            storagePath: "",
            storageUrl: "",
            checksum,
            fileType: type,
            fileSize: size,
            status: "skipped_duplicate",
            extraction: { warnings: ["Skipped: identical image already uploaded."], confidence: 0 },
            duplicateImageOf: duplicateImageId,
            createdAt: now(),
            updatedAt: now()
          };
          batch.duplicateCount += 1;
          batch.completedFiles += 1;
          db.cards.unshift(skippedCard);
          cards.push(publicCard(skippedCard));
          batchChecksums.set(checksum, skippedCard.id);
          continue;
        }
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
          status: stage ? "staged" : "queued",
          extraction: null,
          queuedImageWarning: imageWarning,
          uploadPlatform: clientPlatform(req),
          queuedDuplicateInBatchId: duplicateInBatchId || "",
          queuedDuplicateImageId: duplicateImageId || "",
          duplicateImageOf: duplicateImageId || null,
          pairMode: backStoragePath ? "front-back" : "",
          frontFileName: file.name || "",
          backFileName: file.backName || "",
          preprocessing: file.preprocessing || "",
          createdAt: now(),
          updatedAt: now()
        };
        db.cards.unshift(card);
        cards.push(publicCard(card));
        batchChecksums.set(checksum, cardId);
      }
      // A batch made entirely of duplicate images is never touched by the queue
      // loop (nothing in it ever reaches "queued"), so it must be finalized
      // here or it would otherwise sit at "processing" forever. Staged batches
      // stay "staged" until the user starts processing them.
      if (!stage) {
        batch.status = batch.failedFiles === files.length
          ? "failed"
          : (batch.failedFiles + batch.duplicateCount) === files.length
            ? "completed"
            : "processing";
      }
      audit(db, user, stage ? "cards.staged" : "cards.uploaded", "batch", batch.id, { files: files.length, collectionId: collection.id });
      await saveDb(db);
      if (!stage) scheduleQueueProcessing();
      return send(res, 201, { batch, collection, cards, staged: stage });
    }

    // Promote every staged card to the processing queue. Card ids may be passed
    // to process a subset; otherwise all of the org's staged cards are started.
    if (req.method === "POST" && pathname === "/api/uploads/process-pending") {
      const body = await readJson(req).catch(() => ({}));
      const requestedIds = Array.isArray(body.cardIds) ? new Set(body.cardIds.map(String)) : null;
      const staged = db.cards.filter((c) =>
        c.organisationId === user.organisationId &&
        c.status === "staged" &&
        !c.deletedAt &&
        (!requestedIds || requestedIds.has(c.id))
      );
      if (!staged.length) return error(res, 400, "There are no pending cards to process.");
      // Pay-to-start: reading staged cards needs scan credits.
      const org = db.organisations.find((o) => o.id === user.organisationId);
      const usage = await authoritativePlanUsage(org);
      if (usage.remaining <= 0) return error(res, 402, scanBlockedMessage(usage), { code: "payment_required" });
      const batchIds = new Set();
      for (const card of staged) {
        card.status = "queued";
        card.updatedAt = now();
        if (card.batchId) batchIds.add(card.batchId);
      }
      for (const batchId of batchIds) {
        const batch = db.uploadBatches.find((b) => b.id === batchId);
        if (batch) {
          batch.status = "processing";
          batch.updatedAt = now();
        }
      }
      audit(db, user, "cards.process_pending", "user", user.id, { count: staged.length });
      await saveDb(db);
      scheduleQueueProcessing();
      return send(res, 200, { queued: staged.length });
    }

    if (req.method === "GET" && pathname === "/api/cards") {
      // A saved card stays in Review so the scan can be acted on there — notes,
      // a WhatsApp message — rather than only ever being a row in Contacts. Its
      // contact already exists, so the outreach state travels with it.
      const hidden = REVIEW_KEEPS_SAVED_CARDS
        ? ["deleted", "skipped", "skipped_duplicate"]
        : ["saved", "deleted", "skipped", "skipped_duplicate"];
      const contactByCard = new Map();
      if (REVIEW_KEEPS_SAVED_CARDS) {
        for (const contact of db.contacts) {
          if (contact.organisationId !== user.organisationId || contact.deletedAt || !contact.sourceCardId) continue;
          if (!contactByCard.has(contact.sourceCardId)) contactByCard.set(contact.sourceCardId, contact);
        }
      }
      const cards = db.cards
        .filter((c) => c.organisationId === user.organisationId && !c.deletedAt && !hidden.includes(c.status))
        .map((c) => {
          const card = publicCard(c);
          const contact = contactByCard.get(c.id);
          if (contact) {
            card.contactId = contact.id;
            card.contactSavedName = contact.contactDisplayName || "";
            card.messageSentAt = contact.messageSentAt || "";
          }
          return card;
        });
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
      // The user can correct the transcript or fill in fields the AI left blank
      // before applying. Overrides update the stored note so the saved record and
      // the note itself reflect exactly what the user confirmed.
      if (typeof body.transcript === "string") note.transcript = cleanText(body.transcript);
      if (typeof body.interest === "string") note.interest = cleanText(body.interest);
      if (typeof body.budget === "string") note.budget = cleanText(body.budget);
      if (typeof body.followUpDate === "string") note.followUpDate = cleanText(body.followUpDate);
      if (typeof body.specialRequirement === "string") note.specialRequirement = cleanText(body.specialRequirement);
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
        // One card may hold several named people; save a contact for each. The
        // card counts as saved if at least its primary person saved.
        const people = expandCardPeople(card.extraction);
        let cardSaved = 0;
        let firstFailure = null;
        for (const person of people) {
          const saved = saveContactRecord(db, user, card, person, { allowDuplicate: false });
          if (saved.ok) cardSaved += 1;
          else if (!firstFailure) firstFailure = saved;
        }
        if (cardSaved > 0) {
          result.saved += cardSaved;
        } else {
          card.status = "requires_review";
          card.extraction = card.extraction || {};
          card.extraction.warnings = Array.isArray(card.extraction.warnings) ? card.extraction.warnings : [];
          if (firstFailure) card.extraction.warnings.push(firstFailure.message);
          card.updatedAt = now();
          result.keptForReview += 1;
          if (firstFailure?.code === "duplicate") result.duplicates += 1;
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

    // WhatsApp outreach settings live on the organisation, not in the browser,
    // so a template written on the office laptop is there for every user on the
    // stall — and on every device they pick up.
    if (req.method === "POST" && pathname === "/api/billing/checkout-link") {
      const linkBody = await readJson(req).catch(() => ({}));
      const wantedPlan = Object.keys(PLAN_DURATIONS_MONTHS).includes(String(linkBody.plan || "")) ? String(linkBody.plan) : "";
      const token = randomToken("cko");
      checkoutHandoffs.set(token, { userId: user.id, plan: wantedPlan, topup: Boolean(linkBody.topup), expiresAt: Date.now() + 5 * 60 * 1000 });
      return send(res, 200, { url: `${baseUrl(req)}/api/billing/checkout?token=${encodeURIComponent(token)}` });
    }

    if (req.method === "PUT" && pathname === "/api/settings/whatsapp") {
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      if (!organisation) return error(res, 404, "Workspace not found.");
      const body = await readJson(req);
      const rawTemplates = Array.isArray(body.templates) ? body.templates : [];
      if (rawTemplates.length > 40) return error(res, 400, "You can save up to 40 messages.");
      const templates = [];
      for (const entry of rawTemplates) {
        const name = String(entry?.name || "").trim().slice(0, 80);
        const messageBody = String(entry?.body || "").slice(0, 4000);
        if (!name || !messageBody.trim()) continue;
        templates.push({ id: String(entry?.id || id("tpl")).slice(0, 40), name, body: messageBody });
      }
      const catalogueUrl = String(body.catalogueUrl || "").trim().slice(0, 500);
      if (catalogueUrl && !/^https?:\/\//i.test(catalogueUrl)) {
        return error(res, 400, "The catalogue link must start with http:// or https://");
      }
      organisation.whatsappTemplates = templates;
      organisation.whatsappCatalogueUrl = catalogueUrl;
      organisation.whatsappDefaultTemplateId = templates.some((t) => t.id === body.defaultTemplateId)
        ? body.defaultTemplateId
        : (templates[0]?.id || "");
      organisation.updatedAt = now();
      audit(db, user, "whatsapp.settings_updated", "organisation", organisation.id, { templates: templates.length });
      await saveDb(db);
      return send(res, 200, {
        templates: organisation.whatsappTemplates,
        catalogueUrl: organisation.whatsappCatalogueUrl,
        defaultTemplateId: organisation.whatsappDefaultTemplateId
      });
    }

    if (req.method === "POST" && pathname === "/api/support/query") {
      const body = await readJson(req);
      const contact = String(body.contact || "").trim().slice(0, 200);
      const message = String(body.message || "").trim().slice(0, 4000);
      if (!contact) return error(res, 400, "Add an email or phone number so we can reply.");
      if (!message) return error(res, 400, "Please describe your query.");
      const organisation = db.organisations.find((o) => o.id === user.organisationId);
      const esc = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const preview = message.replace(/\s+/g, " ").slice(0, 60);
      const subject = `Card2Leads Query · ${organisation?.name || "Workspace"} · ${preview}${message.length > 60 ? "…" : ""}`;
      const html = `
        <h3>New Card2Leads support query</h3>
        <p><strong>From:</strong> ${esc(user.name)} (${esc(user.email)})</p>
        <p><strong>Workspace:</strong> ${esc(organisation?.name || "")}${organisation?.plan ? ` &middot; plan ${esc(organisation.plan)}` : ""}</p>
        <p><strong>Reply to:</strong> ${esc(contact)}</p>
        <p><strong>Source:</strong> ${esc(String(body.source || "app").slice(0, 40))}</p>
        <hr />
        <p><strong>Message:</strong></p>
        <div style="white-space:pre-wrap;border-left:3px solid #D6B25E;padding:8px 12px;background:#FAFAFA">${esc(message)}</div>
      `;
      let delivered = false;
      try {
        delivered = await sendRawEmail({ to: SUPPORT_INBOX, subject, html, replyTo: /@/.test(contact) ? contact : undefined });
      } catch (err) {
        console.error("[support] query email failed:", err.message);
      }
      audit(db, user, "support.query_submitted", "organisation", user.organisationId, { delivered, contact });
      await saveDb(db);
      return send(res, 200, { ok: true, delivered });
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

    // Recorded when the user actually opens WhatsApp for a contact, so the
    // outreach state survives closing the app and is visible to the whole team
    // rather than only to the device that sent the message.
    if (req.method === "POST" && pathname === "/api/contacts/mark-messaged") {
      const body = await readJson(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
      if (!ids.size) return error(res, 400, "Select at least one contact.");
      const sent = body.sent === false ? null : now();
      let updated = 0;
      for (const contact of db.contacts) {
        if (contact.organisationId !== user.organisationId || contact.deletedAt || !ids.has(contact.id)) continue;
        contact.messageSentAt = sent;
        contact.messageSentBy = sent ? user.id : "";
        contact.updatedAt = now();
        updated += 1;
      }
      audit(db, user, sent ? "contacts.marked_messaged" : "contacts.unmarked_messaged", "contact", "", { count: updated });
      await saveDb(db);
      return send(res, 200, { updated });
    }

    if (req.method === "POST" && pathname === "/api/contacts/bulk-delete") {
      const body = await readJson(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
      if (!ids.size) return error(res, 400, "Select at least one contact to delete.");
      let deleted = 0;
      db.contacts.forEach((contact) => {
        if (contact.organisationId === user.organisationId && ids.has(contact.id) && !contact.deletedAt) {
          contact.deletedAt = now();
          // Release the originating card so the same image can be scanned again.
          const sourceCard = contact.sourceCardId && db.cards.find((c) => c.id === contact.sourceCardId && c.organisationId === user.organisationId);
          if (sourceCard) { sourceCard.deletedAt = now(); sourceCard.status = "deleted"; }
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
      // Release the originating card so the same image can be scanned again.
      const sourceCard = contact.sourceCardId && db.cards.find((c) => c.id === contact.sourceCardId && c.organisationId === user.organisationId);
      if (sourceCard) { sourceCard.deletedAt = now(); sourceCard.status = "deleted"; }
      audit(db, user, "contact.deleted", "contact", contact.id);
      await saveDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/export.xlsx") {
      if (!rateLimit(req, res, "export-xlsx", 60, 60 * 60 * 1000)) return;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const { collection, contacts, baseName, exportAll } = exportSelection(db, user, url);
      const rows = [EXPORT_COLUMNS, ...contacts.map((c) => exportRow(c, user))];
      const xlsx = buildXlsx(rows);
      const fileName = `${baseName}.xlsx`;
      audit(db, user, "excel.downloaded", "collection", collection?.id || "", { contacts: contacts.length, all: exportAll });
      await saveDb(db);
      await recordProductEvent({ name: "export_excel", clientId: user.organisationId, userId: user.id, source: "export", metadata: { contacts: contacts.length, all: exportAll, platform: clientPlatform(req) } });
      return send(res, 200, xlsx, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`
      });
    }

    if (req.method === "GET" && pathname === "/api/export.csv") {
      if (!rateLimit(req, res, "export-csv", 60, 60 * 60 * 1000)) return;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const { collection, contacts, baseName, exportAll } = exportSelection(db, user, url);
      const rows = [EXPORT_COLUMNS, ...contacts.map((c) => exportRow(c, user))];
      const csv = buildCsv(rows);
      const fileName = `${baseName}.csv`;
      audit(db, user, "csv.downloaded", "collection", collection?.id || "", { contacts: contacts.length, all: exportAll });
      await saveDb(db);
      await recordProductEvent({ name: "export_csv", clientId: user.organisationId, userId: user.id, source: "export", metadata: { contacts: contacts.length, all: exportAll, platform: clientPlatform(req) } });
      return send(res, 200, csv, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`
      });
    }

    if (req.method === "GET" && pathname === "/api/export.vcf") {
      if (!rateLimit(req, res, "export-vcf", 60, 60 * 60 * 1000)) return;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const { collection, contacts, baseName, exportAll, assigneeId } = exportSelection(db, user, url);
      const vcf = buildVcf(contacts);
      const fileName = `${baseName}.vcf`;
      audit(db, user, "vcf.downloaded", "collection", collection?.id || "", { contacts: contacts.length, all: exportAll, assigneeId });
      await saveDb(db);
      await recordProductEvent({ name: "export_vcf", clientId: user.organisationId, userId: user.id, source: "export", metadata: { contacts: contacts.length, all: exportAll, platform: clientPlatform(req) } });
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
      const disconnectBody = await readJson(req).catch(() => ({}));
      const feature = disconnectBody.feature === "sheets" || disconnectBody.feature === "contacts" ? disconnectBody.feature : "";
      const connection = activeGoogleConnection(db, user);
      // Sheets and Contacts share one Google authorisation. Dropping a single
      // feature keeps the other working by removing only its scopes; the grant
      // itself is revoked once nothing is using it any more.
      if (connection && feature) {
        const drop = feature === "contacts" ? GOOGLE_CONTACTS_SCOPE : GOOGLE_SHEETS_SCOPE;
        const kept = String(connection.scopes || "").split(/\s+/).filter((scope) => scope && scope !== drop);
        const stillUsed = kept.some((scope) => scope === GOOGLE_SHEETS_SCOPE || scope === GOOGLE_CONTACTS_SCOPE);
        if (stillUsed) {
          connection.scopes = kept.join(" ");
          connection.updatedAt = now();
          audit(db, user, "google.feature_disconnected", "google_connection", connection.id, { feature });
          await saveDb(db);
          return send(res, 200, { ok: true, google: googleStatus(db, user) });
        }
      }
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
      await recordProductEvent({ name: "google_disconnected", clientId: user.organisationId, userId: user.id, source: "google" });
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
      await recordProductEvent({ name: "account_deletion", clientId: organisationId, userId: user.id, source: "customer", idempotencyKey: `account_deletion:${organisationId}`, metadata: { self_service: true } });
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
      const requestedIds = Array.isArray(body.contactIds) ? body.contactIds.map(String).filter(Boolean) : [];
      // A sheet mirrors one exhibition, so a selection spanning several of them
      // syncs each exhibition's own sheet rather than forcing everything into
      // the active one (which would drop the rest of that sheet's contacts).
      let collections;
      if (requestedIds.length) {
        const selected = new Set(requestedIds);
        const collectionIds = [...new Set(db.contacts
          .filter((contact) => contact.organisationId === user.organisationId && !contact.deletedAt && selected.has(contact.id))
          .map((contact) => contact.collectionId)
          .filter(Boolean))];
        if (!collectionIds.length) return error(res, 400, "The selected contacts are not part of an exhibition yet.");
        collections = collectionIds.map((collectionId) => collectionForUser(db, user, collectionId));
      } else {
        collections = [collectionForUser(db, user, body.collectionId)];
      }

      const accessToken = await googleAccessToken(db, user, GOOGLE_SHEETS_SCOPE);
      const sheets = [];
      let synced = 0;
      let failed = 0;
      for (const collection of collections) {
        // An exhibition picked up through a selection may not have a sheet yet.
        if (!collection.spreadsheetId) {
          const title = String(collection.destinationName || `${collection.exhibitionName || collection.name} Contacts`).trim();
          const spreadsheet = await createGoogleSpreadsheet(accessToken, title);
          await writeGoogleHeaders(accessToken, spreadsheet.spreadsheetId);
          collection.destinationName = title;
          collection.spreadsheetId = spreadsheet.spreadsheetId;
          collection.worksheetId = spreadsheet.worksheetId;
          collection.spreadsheetUrl = spreadsheet.spreadsheetUrl;
          collection.nextSheetRow = 2;
        }
        collection.destinationType = "google";
        collection.updatedAt = now();
        let result;
        try {
          result = await syncCollectionToGoogle(db, user, collection);
        } catch (syncError) {
          // drive.file only grants access to files this app created, and that
          // claim is lost for good once the user revokes access. Reconnecting
          // cannot reopen the old sheet, so replace it with a fresh one rather
          // than failing every future sync for this exhibition.
          if (!syncError?.googleAuthFailed || !collection.spreadsheetId) throw syncError;
          console.error("[google] sheet %s is no longer reachable; creating a replacement", collection.spreadsheetId);
          const title = String(collection.destinationName || `${collection.exhibitionName || collection.name} Contacts`).trim();
          const replacement = await createGoogleSpreadsheet(accessToken, title);
          await writeGoogleHeaders(accessToken, replacement.spreadsheetId);
          collection.spreadsheetId = replacement.spreadsheetId;
          collection.worksheetId = replacement.worksheetId;
          collection.spreadsheetUrl = replacement.spreadsheetUrl;
          collection.nextSheetRow = 2;
          db.syncRecords = db.syncRecords.filter((record) => record.collectionId !== collection.id);
          result = await syncCollectionToGoogle(db, user, collection);
        }
        synced += result.synced || 0;
        failed += result.failed || 0;
        sheets.push({
          collectionId: collection.id,
          name: collection.exhibitionName || collection.name,
          url: collection.spreadsheetUrl || (collection.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${collection.spreadsheetId}/edit` : ""),
          synced: result.synced || 0
        });
        audit(db, user, "google.synced", "collection", collection.id, result);
      }
      await saveDb(db);
      return send(res, 200, {
        status: failed ? "partial" : "synced",
        synced,
        failed,
        sheets,
        message: failed
          ? `${synced} contact(s) synced. ${failed} contact(s) failed and remain marked for review.`
          : `${synced} contact(s) synced across ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}.`
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
        // A deliberate selection is honoured in full: the active exhibition only
        // narrows the set when the caller did not name specific contacts.
        && (!collectionId || requestedIds.size > 0 || contact.collectionId === collectionId)
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
          if (groupResourceName === undefined) {
            try {
              groupResourceName = await ensureGoogleContactGroup(accessToken, groupName);
            } catch (groupError) {
              // A narrower contacts scope cannot manage groups. Saving the contact
              // matters more than filing it, so continue ungrouped rather than
              // failing the whole sync.
              console.error("[google] contact group unavailable:", groupError.message);
              groupResourceName = "";
            }
            exhibitionGroups.set(groupName, groupResourceName);
          }
          const person = await syncContactToGooglePeople(accessToken, contact);
          if (groupResourceName) await addGoogleContactToGroup(accessToken, groupResourceName, person.resourceName);
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
      const groupResourceNames = [...exhibitionGroups.values()].filter(Boolean);
      const singleGroupId = groupResourceNames.length === 1 ? String(groupResourceNames[0]).split("/").pop() : "";
      return send(res, 200, {
        synced,
        failed: failures.length,
        failures,
        label: labels.size === 1 ? [...labels][0] : "multiple exhibition labels",
        labels: [...labels],
        // Deep-link to the single exhibition label when there is one, otherwise
        // to Google Contacts itself.
        groupUrl: singleGroupId ? `https://contacts.google.com/label/${singleGroupId}` : "https://contacts.google.com/",
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
    expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  };
  db.sessions.push(session);
  await saveDb(db);
  // Funnel: every entry into the product, plus a once-per-user first_login milestone.
  const platform = clientPlatform(req);
  await recordProductEvent({ name: "login_success", clientId: user.organisationId, userId: user.id, source: "auth", metadata: { platform } });
  await recordProductEvent({ name: "first_login", clientId: user.organisationId, userId: user.id, source: "auth", idempotencyKey: `first_login:${user.id}`, metadata: { platform } });
  const cookies = [sessionCookie(req, signSession(session.id), SESSION_DAYS * 24 * 60 * 60), ...extraCookies];
  if (redirectTo) {
    res.writeHead(302, { Location: redirectTo, "Set-Cookie": cookies });
    return res.end();
  }
  send(res, 200, { user: publicUser(user), csrfToken: session.csrfToken }, { "Set-Cookie": cookies });
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, organisationId: user.organisationId };
}

function normalizeExhibitionKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// An exhibition already used by this workspace, matched on name regardless of
// case or spacing. Reusing it keeps one event's contacts, sheet and Google label
// together instead of splitting them across near-identical duplicates.
function findExistingCollection(db, user, exhibitionName) {
  const key = normalizeExhibitionKey(exhibitionName);
  if (!key) return null;
  return db.collections.find((collection) =>
    collection.organisationId === user.organisationId
    && collection.status !== "deleted"
    && !collection.deletedAt
    && (normalizeExhibitionKey(collection.exhibitionName) === key || normalizeExhibitionKey(collection.name) === key)
  ) || null;
}

function createCollectionFromUpload(db, user, body) {
  const requestedName = String(body.exhibitionName || body.collectionName || "").trim();
  const existing = findExistingCollection(db, user, requestedName);
  if (existing) {
    db.collections.forEach((c) => {
      if (c.organisationId === user.organisationId) c.status = c.id === existing.id ? "active" : "archived";
    });
    if (!existing.exhibitionDate && body.exhibitionDate) existing.exhibitionDate = String(body.exhibitionDate);
    existing.updatedAt = now();
    return existing;
  }
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

// Every card must be saved no matter how messy the extraction is — validation
// only ever produces a list of reasons for a quiet "needs review" flag, it
// never blocks the save itself. A duplicate-cost, hard-to-review card is far
// worse for this product than a saved row with a blank field.
function validateContact(fields) {
  const normalizedFields = normalizePhoneFields(fields);
  const name = String(normalizedFields.name || "").trim();
  const mobileNumber = String(normalizedFields.mobileNumber || "").trim();
  const reasons = [];
  if (!name) reasons.push("Name is missing.");
  if (!mobileNumber) reasons.push("Mobile number is missing.");
  else if (!isValidMobile(mobileNumber)) reasons.push("Mobile number looks invalid.");
  if (normalizedFields.secondaryMobileNumber && !splitPhoneValues(normalizedFields.secondaryMobileNumber).every(isValidMobile)) {
    reasons.push("Secondary mobile number looks invalid.");
  }
  if (normalizedFields.officeNumber && !isValidOfficePhone(normalizedFields.officeNumber)) {
    reasons.push("Office number looks invalid.");
  }
  for (const field of ["emailAddress", "secondaryEmail"]) {
    if (normalizedFields[field] && !isValidEmail(normalizedFields[field])) {
      reasons.push(`${fieldLabelsForServer(field)} looks invalid.`);
    }
  }
  if (normalizedFields.website && !isLikelyWebsite(normalizedFields.website)) {
    reasons.push("Website looks invalid.");
  }
  if (normalizedFields.linkedInUrl && !isLikelyLinkedIn(normalizedFields.linkedInUrl)) {
    reasons.push("LinkedIn URL looks invalid.");
  }
  return { ok: true, reasons };
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
  // A card may print a district ("Kutch") or nothing at all where the state
  // belongs; normalise it, then fall back to deriving the state from the city.
  cleaned.state = normalizeIndianState(toTitleCase(cleaned.state)) || (cleaned.city ? inferStateFromCity(cleaned.city) : "");
  if (cleaned.state && !INDIA_STATE_CODES[cleaned.state.toLowerCase()] && cleaned.city) {
    cleaned.state = inferStateFromCity(cleaned.city) || cleaned.state;
  }
  // State code, dialling country, WhatsApp number and the saved-contact display
  // name are always recomputed here so they stay correct after a manual edit.
  applyDerivedContactFields(cleaned);
  return cleaned;
}

function isValidOfficePhone(value) {
  const values = splitPhoneValues(value);
  if (!values.length) return true;
  return values.every((part, index) => {
    const digits = String(part).replace(/\D/g, "");
    // Only the first value is a whole number. The rest are printed shorthand for
    // consecutive lines or extensions ("04212485551 / 52 / 53"), so they can be
    // as short as a single digit — requiring at least one still rejects junk.
    return digits.length >= (index === 0 ? 6 : 1) && digits.length <= 16;
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

// A single card can carry more than one person — business partners who share a
// company each print their own name and number. The extractor captures the
// extra people in secondary/tertiary name+number pairs. Each *named* extra
// person becomes their own contact that inherits the business (company, city,
// state, address, exhibition) but carries their own name and mobile — so a card
// with three people's numbers becomes three contact rows under one business.
// A nameless extra number is treated as the same person's second line and stays
// on the primary as secondaryMobileNumber (unchanged behaviour).
function expandCardPeople(fields) {
  const source = fields || {};
  const secondaryName = String(source.secondaryName || "").trim();
  const tertiaryName = String(source.tertiaryName || "").trim();

  const primary = { ...source };
  // A named second/third person owns their number — move it off the primary so
  // it is not duplicated as the primary's secondary line.
  if (secondaryName) { primary.secondaryName = ""; primary.secondaryMobileNumber = ""; }
  if (tertiaryName) { primary.tertiaryName = ""; primary.tertiaryMobileNumber = ""; }

  const extraFor = (name, mobile) => ({
    ...source,
    name: String(name || "").trim(),
    mobileNumber: String(mobile || "").trim(),
    // Single-owner personal fields belong to the primary card holder; an extra
    // person only inherits the shared business and location context.
    designation: "",
    department: "",
    emailAddress: "",
    secondaryEmail: "",
    linkedInUrl: "",
    nameNative: "",
    designationNative: "",
    secondaryName: "",
    secondaryMobileNumber: "",
    tertiaryName: "",
    tertiaryMobileNumber: ""
  });

  const people = [primary];
  if (secondaryName) people.push(extraFor(secondaryName, source.secondaryMobileNumber));
  if (tertiaryName) people.push(extraFor(tertiaryName, source.tertiaryMobileNumber));

  // One person can also print several of their own numbers. Each becomes its own
  // contact so every number is reachable, identical apart from a "no.1"/"no.2"
  // suffix on the name. A person with a single number is left untouched.
  const expanded = [];
  for (const person of people) {
    const numbers = [];
    const seenNumbers = new Set();
    // Both fields can hold several numbers printed with a slash, so split each.
    for (const candidate of [...splitPhoneValues(person.mobileNumber), ...splitPhoneValues(person.secondaryMobileNumber)]) {
      const value = String(candidate || "").trim();
      const key = normalizeMobile(value);
      if (!value || !key || seenNumbers.has(key)) continue;
      seenNumbers.add(key);
      numbers.push(value);
    }
    if (numbers.length <= 1) {
      expanded.push(person);
      continue;
    }
    const personName = String(person.name || "").trim();
    numbers.forEach((number, index) => {
      expanded.push({
        ...person,
        name: personName ? `${personName} no.${index + 1}` : personName,
        mobileNumber: number,
        secondaryMobileNumber: ""
      });
    });
  }

  // Never let two produced contacts collide on the same normalised number.
  const seen = new Set();
  return expanded.filter((person) => {
    const key = normalizeMobile(person.mobileNumber || "");
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  });
}

async function saveContactFromFields(res, db, user, card, fields) {
  // Multiple named people on one card fan out into separate contacts, each
  // merging (fill-blanks) against any existing number instead of blocking, so
  // the save never fails and the same business links every person.
  const people = expandCardPeople(fields);
  if (people.length > 1) {
    const savedContacts = [];
    for (const person of people) {
      const saved = saveContactRecord(db, user, card, person, { allowDuplicate: false, mergeDuplicate: true });
      if (saved.ok) savedContacts.push(saved.contact);
    }
    audit(db, user, "contact.saved_split", "card", card.id, { contacts: savedContacts.length });
    await saveDb(db);
    return send(res, 201, { contact: savedContacts[0], contacts: savedContacts, split: savedContacts.length });
  }

  const cleaned = cleanContactFields(fields);
  const normalizedMobileNumber = normalizeMobile(cleaned.mobileNumber);
  const duplicate = normalizedMobileNumber
    ? db.contacts.find((c) =>
        c.organisationId === user.organisationId &&
        !c.deletedAt &&
        c.normalizedMobileNumber === normalizedMobileNumber
      )
    : null;
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
  const cleaned = cleanContactFields(fields);
  const normalizedMobileNumber = normalizeMobile(cleaned.mobileNumber);
  const duplicate = normalizedMobileNumber
    ? db.contacts.find((c) =>
        c.organisationId === user.organisationId &&
        !c.deletedAt &&
        c.normalizedMobileNumber === normalizedMobileNumber
      )
    : null;
  if (duplicate && options.mergeDuplicate) {
    return mergeContactRecord(db, user, card, duplicate, cleaned);
  }
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
    // Advisory only — nothing above this point ever blocks the save. A quiet
    // flag plus the reasons behind it, so incomplete rows can be found later
    // without hiding them or refusing to save them in the first place.
    needsReview: validation.reasons.length > 0,
    reviewReasons: validation.reasons.join(" "),
    googleSheetsSyncStatus: collection.destinationType === "google" ? "pending" : "not_configured",
    extractionConfidence: card.extraction?.confidence || 0,
    cardImageReference: card.storageUrl,
    normalizedMobileNumber,
    ...cleaned,
    exhibitionName: collection.exhibitionName || cleaned.exhibitionName || "",
    exhibitionDate: collection.exhibitionDate || cleaned.exhibitionDate || ""
  };
  // The exhibition is only known here, so the saved-contact name has to be
  // rebuilt now; deriving it earlier left the exhibition out of the name.
  applyDerivedContactFields(contact);
  db.contacts.unshift(contact);
  collection.savedContactCount = db.contacts.filter((c) => c.collectionId === collection.id && !c.deletedAt).length;
  collection.nextSheetRow = 2 + collection.savedContactCount;
  collection.updatedAt = now();
  card.status = "saved";
  card.updatedAt = now();
  audit(db, user, "contact.saved", "contact", contact.id, { collectionId: collection.id, cardId: card.id });
  return { ok: true, contact };
}

// Fill-blanks-only merge for a card matching an already-saved contact. An
// existing value is never overwritten, so a second (possibly poorer) scan can
// add detail the first one missed but can never degrade or erase what's there.
// Notes are the exception: they're appended, so earlier remarks survive.
function mergeContactRecord(db, user, card, existing, cleaned) {
  const filled = [];
  for (const field of OPTIONAL_FIELDS) {
    if (field === "notes") continue;
    const incoming = String(cleaned[field] ?? "").trim();
    if (!incoming || String(existing[field] ?? "").trim()) continue;
    existing[field] = incoming;
    filled.push(field);
  }
  const incomingNotes = String(cleaned.notes || "").trim();
  const existingNotes = String(existing.notes || "").trim();
  if (incomingNotes && !existingNotes.includes(incomingNotes)) {
    existing.notes = [existingNotes, incomingNotes].filter(Boolean).join("\n\n");
    filled.push("notes");
  }
  if (filled.length) {
    // Filling blanks can supply an exhibition, city or state that the name is
    // built from, so refresh it rather than leaving the older, shorter name.
    applyDerivedContactFields(existing);
    existing.updatedAt = now();
    existing.updatedBy = user.id;
    // Re-queue for Sheets, otherwise the newly filled columns never reach it.
    if (existing.googleSheetsSyncStatus === "synced") existing.googleSheetsSyncStatus = "pending";
  }
  existing.duplicateStatus = "merged";
  card.status = "saved";
  card.updatedAt = now();
  audit(db, user, "contact.merged_duplicate", "contact", existing.id, { cardId: card.id, filledFields: filled });
  return { ok: true, contact: existing, merged: true, filledFields: filled };
}

function exportRow(contact) {
  const phone = phoneCountryInfo(contact.mobileNumber, contact.country);
  const stateCode = String(contact.stateCode || "").trim() || stateCodeFor(contact.state, contact.country, phone.iso, contact.city);
  return [
    googleContactDisplayName(contact),
    contact.name,
    contact.nameNative,
    contact.mobileNumber,
    contact.phoneCountryCode || phone.code,
    contact.phoneCountry || phone.name,
    contact.whatsappNumber || whatsappDigits(contact.mobileNumber, contact.country),
    contact.secondaryMobileNumber,
    contact.companyName,
    contact.companyNameNative,
    contact.designation,
    contact.officeNumber,
    contact.emailAddress,
    contact.secondaryEmail,
    contact.website,
    contact.address,
    contact.addressNative,
    contact.city,
    contact.state,
    stateCode,
    contact.postalCode,
    contact.country,
    contact.cardLanguage,
    contact.exhibitionName,
    contact.exhibitionDate,
    exportRemarks(contact),
    exportVoiceNote(contact),
    contact.tags,
    contact.messageSentAt ? "Yes" : "No",
    contact.createdAt
  ].map(safeSpreadsheetValue);
}

// Remarks normally already includes the voice comment, because applyVoiceFields
// merges it into notes so it stays visible/editable in the app's Notes field.
// Append it here only when that merge hasn't happened, so a contact that picked
// up a transcript by some other path still carries it into VCF and Google
// Contacts (both build their note from this). The dedicated Voice Note column
// additionally surfaces the raw transcript on its own.
function exportRemarks(contact) {
  const notes = String(contact.notes || "").trim();
  const transcript = String(contact.voiceTranscript || "").trim();
  if (!transcript || notes.includes(transcript)) return notes;
  return [notes, transcript].filter(Boolean).join("\n\n");
}

function exportVoiceNote(contact) {
  const transcript = String(contact.voiceTranscript || "").trim();
  if (!transcript) return "";
  const language = String(contact.voiceLanguage || "").trim();
  return language ? `[${language}] ${transcript}` : transcript;
}

// Shared selection logic for every export format, so Excel, CSV and VCF all
// return exactly the same set of contacts for a given set of query params.
// Previously each endpoint filtered differently (Excel/CSV honoured only
// `all`, VCF only `assigneeId`), so a download could silently disagree with
// what the user had filtered on screen.
function exportSelection(db, user, url) {
  const params = url.searchParams;
  const collectionId = params.get("collectionId");
  const selectedIds = selectedExportIds(url);
  const exportAll = params.get("all") === "true";
  const assigneeId = params.get("assigneeId") || "";
  const exhibition = params.get("exhibition") || "";
  const city = params.get("city") || "";
  const stateName = params.get("state") || "";
  const search = String(params.get("q") || "").toLowerCase();
  const collection = collectionForUser(db, user, collectionId);

  let contacts = db.contacts.filter((c) =>
    c.organisationId === user.organisationId &&
    !c.deletedAt &&
    (selectedIds.size
      ? selectedIds.has(c.id)
      : (exportAll || (collection && c.collectionId === collection.id)))
  );

  const nameParts = [];

  let assigneeLabel = "";
  if (assigneeId === "__unassigned") {
    contacts = contacts.filter((c) => !c.assignedToId);
    assigneeLabel = "Unassigned";
  } else if (assigneeId) {
    const organisation = db.organisations.find((o) => o.id === user.organisationId);
    assigneeLabel = teamMembers(organisation).find((m) => m.id === assigneeId)?.name
      || contacts.find((c) => c.assignedToId === assigneeId)?.assignedToName
      || "";
    contacts = contacts.filter((c) => c.assignedToId === assigneeId);
  }
  if (assigneeLabel) nameParts.push(assigneeLabel);

  if (exhibition) {
    contacts = contacts.filter((c) => (c.exhibitionName || "") === exhibition);
    nameParts.push(exhibition);
  } else if (collection && !exportAll && !selectedIds.size) {
    nameParts.push(collection.name);
  }
  if (city) {
    contacts = contacts.filter((c) => (c.city || "") === city);
    nameParts.push(city);
  }
  if (stateName) {
    contacts = contacts.filter((c) => (c.state || "") === stateName);
    nameParts.push(stateName);
  }
  const messaged = params.get("messaged") || "";
  if (messaged === "sent") {
    contacts = contacts.filter((c) => Boolean(c.messageSentAt));
    nameParts.push("Message sent");
  } else if (messaged === "not-sent") {
    contacts = contacts.filter((c) => !c.messageSentAt);
    nameParts.push("Message not sent");
  }

  // The app has always put the date-added filter in the file name. Without it
  // here the spreadsheet claimed a filter it had not applied.
  const addedWithin = Number(params.get("addedWithinDays") || 0);
  if (addedWithin > 0) {
    const cutoff = Date.now() - addedWithin * 24 * 60 * 60 * 1000;
    contacts = contacts.filter((c) => new Date(c.createdAt).getTime() >= cutoff);
    nameParts.push(addedWithin === 1 ? "Today" : `Last ${addedWithin} days`);
  }

  if (search) {
    contacts = contacts.filter((c) =>
      [c.name, c.mobileNumber, c.companyName, c.emailAddress, c.city, c.state, c.tags, c.notes, c.assignedToName, c.exhibitionName]
        .some((v) => String(v || "").toLowerCase().includes(search)));
  }

  if (selectedIds.size) nameParts.unshift("Selected");
  if (!nameParts.length) nameParts.push("All");

  const stamp = new Date().toISOString().slice(0, 10);
  const baseName = `${nameParts.map(slug).filter(Boolean).join("_")}_contacts_${stamp}`;
  return { collection, contacts, baseName, exportAll, assigneeId };
}

function selectedExportIds(url) {
  return new Set(String(url.searchParams.get("ids") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
}

function googleRedirectUri(req) {
  // Mirror googleLoginRedirectUri: fall back to baseUrl(req) (which honors
  // APP_BASE_URL / x-forwarded-proto) instead of a hardcoded http:// origin,
  // so the redirect_uri is https behind a TLS-terminating proxy and matches
  // the URI registered in the Google OAuth client.
  return process.env.GOOGLE_REDIRECT_URI || `${baseUrl(req)}/api/google/callback`;
}

function googleLoginRedirectUri(req) {
  return GOOGLE_AUTH_REDIRECT_URI || `${baseUrl(req)}/api/auth/google/callback`;
}

function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/drive.file";
// Overridable so a narrower scope can be trialled. contacts.app_created limits
// access to contacts this app created, but Google does not allow contact-group
// management under it, so exhibition groups are skipped when it is in use.
const GOOGLE_CONTACTS_SCOPE = process.env.GOOGLE_CONTACTS_SCOPE || "https://www.googleapis.com/auth/contacts";

function googleScopes(feature = "sheets") {
  // drive.file limits Card2Leads to files it creates or files explicitly opened with it.
  const scopes = ["openid", "email", "profile"];
  if (feature === "sheets" || feature === "all") scopes.unshift(GOOGLE_SHEETS_SCOPE);
  if (feature === "contacts" || feature === "all") scopes.unshift(GOOGLE_CONTACTS_SCOPE);
  return scopes.join(" ");
}

// The access token is replaced on every connect, so the scopes we record must
// describe THAT token. Google returns the token's full scope set (the auth
// request asks for include_granted_scopes), so trust it outright — merging with
// what we previously believed meant the record could keep claiming a feature
// the current token could no longer perform, and the sync then failed with a
// bare "caller does not have permission".
function scopesForNewToken(previousScopes, grantedScopes, feature) {
  const granted = String(grantedScopes || "").trim();
  if (granted) return mergeGoogleScopes(granted);
  return mergeGoogleScopes(previousScopes, googleScopes(feature));
}

function mergeGoogleScopes(...scopeValues) {
  return [...new Set(
    scopeValues
      .flatMap((value) => String(value || "").split(/\s+/))
      .filter(Boolean),
  )].join(" ");
}

// Remembering that a feature was connected once lets the UI offer "Reconnect"
// rather than "Connect" after someone disconnects it.
function markGoogleFeatureConnected(db, user, scopes) {
  const organisation = db.organisations.find((o) => o.id === user.organisationId);
  if (!organisation) return;
  const value = String(scopes || "");
  if (value.includes(GOOGLE_SHEETS_SCOPE)) organisation.googleSheetsEverConnected = true;
  if (value.includes(GOOGLE_CONTACTS_SCOPE)) organisation.googleContactsEverConnected = true;
  organisation.updatedAt = now();
}

function activeGoogleConnection(db, user) {
  return db.googleConnections.find((c) => c.organisationId === user.organisationId && c.status === "active") || null;
}

function googleStatus(db, user) {
  const connection = user ? activeGoogleConnection(db, user) : null;
  const organisation = user ? db.organisations.find((o) => o.id === user.organisationId) : null;
  const scopes = connection?.scopes || "";
  return {
    configured: googleConfigured(),
    connected: Boolean(connection),
    sheetsConnected: Boolean(connection && scopes.includes(GOOGLE_SHEETS_SCOPE)),
    contactsConnected: Boolean(connection && scopes.includes(GOOGLE_CONTACTS_SCOPE)),
    googleEmail: connection?.googleEmail || "",
    needsReconnect: Boolean(connection && !scopes.includes(GOOGLE_SHEETS_SCOPE)),
    sheetsEverConnected: Boolean(organisation?.googleSheetsEverConnected),
    contactsEverConnected: Boolean(organisation?.googleContactsEverConnected),
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
  if (!res.ok) {
    const detail = data.error?.message || "Google request failed.";
    // 401/403 here almost always means the user revoked access, or reconnected
    // only one feature so the stored token no longer carries the other's scope.
    // Say that plainly instead of passing Google's wording through.
    if (res.status === 401 || res.status === 403) {
      console.error("[google] %s on %s :: %s", res.status, String(url).split("?")[0], detail);
      const authError = new Error(`Google access is no longer authorised for this action. Reconnect your Google account from Account, then try again. (Google said: ${detail})`);
      authError.googleAuthFailed = true;
      throw authError;
    }
    throw new Error(detail);
  }
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
      { key: "Card2Leads Contact ID", value: String(contact.id || "") },
      { key: "Contact Name", value: String(contact.name || "") },
      { key: "Name (Original Script)", value: String(contact.nameNative || "") },
      { key: "Company (Original Script)", value: String(contact.companyNameNative || "") },
      { key: "Card Language", value: String(contact.cardLanguage || "") },
      { key: "Country Code", value: String(contact.phoneCountryCode || "") },
      { key: "Phone Country", value: String(contact.phoneCountry || "") },
      { key: "State Code", value: String(contact.stateCode || "") }
    ].filter((entry) => entry.value)
  };
}

// The name written into Google Contacts, VCF and the "Saved Contact Name"
// export column: "GJEPC 2026. Ritesh Jewellers. MH. Amravati".
// Recomputed rather than trusted so contacts saved before this format existed
// (and any whose city/state was edited afterwards) still sync correctly.
function googleContactDisplayName(contact) {
  return buildContactDisplayName(contact) || String(contact.name || "").trim();
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

// Verifies an ID token minted by Google Sign-In on the device. The token is
// checked with Google rather than decoded locally, and the audience must be our
// own client, so a token issued to some other app cannot be replayed here.
async function verifyGoogleIdToken(idToken) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) throw new Error("That Google sign-in could not be verified.");
  const data = await res.json().catch(() => ({}));
  const audience = String(data.aud || "");
  const allowed = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_ANDROID_CLIENT_ID, process.env.GOOGLE_IOS_CLIENT_ID]
    .filter(Boolean);
  if (!allowed.includes(audience)) throw new Error("That Google sign-in was issued for a different application.");
  if (String(data.email_verified) !== "true" || !data.email || !data.sub) {
    throw new Error("That Google account does not have a verified email address.");
  }
  return { sub: String(data.sub), email: String(data.email), name: String(data.name || ""), email_verified: true };
}

// Shared by the browser callback and the native sign-in endpoint so both paths
// resolve to exactly the same account.
function findOrCreateGoogleUser(db, profile) {
  const googleEmail = String(profile.email).trim().toLowerCase();
  let user = db.users.find((u) => u.googleSubject === profile.sub);
  if (!user) user = db.users.find((u) => u.email === googleEmail);
  if (user?.googleSubject && user.googleSubject !== profile.sub) return { conflict: true };
  if (!user) {
    const demoAccount = isDemoEmail(googleEmail);
    const org = {
      id: id("org"),
      name: `${profile.name || profile.email}'s Workspace`,
      plan: demoAccount ? "demo" : "trial",
      scanLimit: demoAccount ? DEMO_ACCOUNT_SCANS : 0,
      scansUsed: 0,
      isDemoAccount: demoAccount,
      topupScans: 0,
      retentionPolicy: "90-days",
      setupComplete: true,
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
    return { user, existingAccount: false };
  }
  user.googleSubject = profile.sub;
  user.emailVerified = true;
  user.status = "active";
  user.authProvider = user.authProvider || "email";
  user.updatedAt = now();
  audit(db, user, "user.google_logged_in", "user", user.id);
  return { user, existingAccount: true };
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

// Serve the admin UI (admin-ui/public) at /admin so the panel is reachable on the
// same origin as the API — no separate subdomain/proxy needed. The SPA is static;
// all sensitive data still requires admin auth on the backend.
function serveAdminUi(req, res, pathname) {
  const ADMIN_UI_DIR = path.join(ROOT, "admin-ui", "public");
  // Redirect /admin -> /admin/ so the index.html's relative asset paths
  // (app.js, styles.css) resolve under /admin/ and not the customer app root.
  if (pathname === "/admin") return redirect(res, "/admin/");
  let rel = pathname.replace(/^\/admin\/?/, "");
  if (!rel || rel === "/") rel = "index.html";
  let filePath = path.normalize(path.join(ADMIN_UI_DIR, rel));
  if (!filePath.startsWith(ADMIN_UI_DIR)) return error(res, 403, "Forbidden.");
  // SPA fallback: unknown non-file paths serve index.html.
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (path.extname(rel)) return error(res, 404, "Not found.");
    filePath = path.join(ADMIN_UI_DIR, "index.html");
    if (!fs.existsSync(filePath)) return error(res, 404, "Admin UI is not installed.");
  }
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8"
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
      contact.name ? `Contact: ${contact.name}` : "",
      contact.nameNative ? `Name (original): ${contact.nameNative}` : "",
      contact.companyNameNative ? `Company (original): ${contact.companyNameNative}` : "",
      contact.cardLanguage ? `Card language: ${contact.cardLanguage}` : "",
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
  if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(req, res, url.pathname);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url.pathname);
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return serveAdminUi(req, res, url.pathname);
  if (url.pathname.startsWith("/illustrations-final/")) return serveFinalIllustration(req, res, url.pathname);
  if (url.pathname.startsWith("/illustrations/")) return serveIllustration(req, res, url.pathname);
  // Clean, crawlable URLs for the public legal/contact pages. These return the
  // page HTML directly (HTTP 200, no redirect, no login) so /privacy-policy is a
  // real link Google's OAuth verification can follow and match to Branding.
  const CLEAN_PAGE_ROUTES = { "/privacy-policy": "/privacy.html", "/terms": "/terms.html", "/contact": "/contact.html", "/delete-account": "/delete-account.html" };
  if (CLEAN_PAGE_ROUTES[url.pathname]) return serveStatic(req, res, CLEAN_PAGE_ROUTES[url.pathname]);
  return serveStatic(req, res, url.pathname);
});

if (require.main === module) {
  validateRuntimeConfiguration();
  ensureStorage()
    .then(() => ensureBootstrapAdmin())
    .then(() => reconcileUsageLedger())
    .then(() => runMaintenance())
    .then(() => {
      // Set HOST=127.0.0.1 in production so the app is reachable only via the
      // reverse proxy (CloudPanel/nginx) and never exposed publicly on its port.
      const HOST = process.env.HOST || undefined;
      server.listen(PORT, HOST, () => {
        console.log(`Card2Leads running at http://${HOST || "localhost"}:${PORT}`);
        scheduleQueueProcessing();
        scheduleMaintenance();
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
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": worksheetXml(rows)
  };
  return zipStore(files);
}

function worksheetXml(rows) {
  const body = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${columnName(c + 1)}${r + 1}`;
      const escaped = escapeXml(value);
      const style = r === 0 ? ' s="1"' : ' s="2"';
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escaped}</t></is></c>`;
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
  // Strip control characters XML 1.0 forbids outright (everything except
  // tab/LF/CR) — a stray byte here would otherwise produce a corrupt
  // worksheet that Excel silently repairs by dropping content, making
  // exported fields (like a voice transcript) look like they never made it in.
  const sanitized = String(value ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return sanitized.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]));
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
  applyDerivedContactFields,
  expandCardPeople,
  assertGoogleWritePolicy,
  buildContactDisplayName,
  buildCsv,
  buildVcf,
  buildXlsx,
  phoneCountryInfo,
  stateCodeFor,
  whatsappDigits,
  canPurchaseTopup,
  contactToGooglePerson,
  createCollectionFromUpload,
  deriveOverallConfidence,
  exportRemarks,
  exportRow,
  findCollectionForUser,
  foldLedgerRows,
  googleContactDisplayName,
  googleScopes,
  grantOneTimePlan,
  grantTopupEntitlement,
  normalizeExtraction,
  normalizePhoneFields,
  parseDataUrl,
  planUsage,
  removeOrganisationData,
  remainingTopupScans,
  repairCollectionExhibitionAssignments,
  saveContactRecord,
  validateTenantIntegrity,
  validateContact,
  validatePasswordStrength
};
