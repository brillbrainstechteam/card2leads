const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXPORT_COLUMNS,
  assertGoogleWritePolicy,
  buildCsv,
  buildVcf,
  buildXlsx,
  canPurchaseTopup,
  createCollectionFromUpload,
  deriveOverallConfidence,
  exportRemarks,
  exportRow,
  findCollectionForUser,
  foldLedgerRows,
  contactToGooglePerson,
  grantOneTimePlan,
  grantTopupEntitlement,
  googleContactDisplayName,
  googleScopes,
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
} = require("../server");

test("usage decisions prefer the ledger snapshot over legacy counters", () => {
  const ledger = foldLedgerRows([
    { transaction_type: "PLAN_ALLOCATION", quantity: 150, balance_effect: 150 },
    { transaction_type: "SCAN_CONSUMED", quantity: 1, balance_effect: -1 },
    { transaction_type: "ADMIN_CREDIT", quantity: 10, balance_effect: 10 },
    { transaction_type: "SCAN_CONSUMED", quantity: 1, balance_effect: -1 }
  ]);
  assert.deepEqual(ledger, { used: 2, remaining: 158, limit: 160, balance: 158 });
  assert.deepEqual(planUsage({ plan: "monthly", billingMode: "subscription", subscriptionStatus: "active", scansUsed: 99, scanLimit: 100 }, ledger), {
    plan: "monthly", used: 2, remaining: 158, limit: 160
  });
});

test("hard deletion removes only the selected tenant graph", () => {
  const db = {
    organisations: [{ id: "org-a" }, { id: "org-b" }],
    users: [{ id: "user-a", organisationId: "org-a" }, { id: "user-b", organisationId: "org-b" }],
    sessions: [{ id: "session-a", userId: "user-a" }, { id: "session-b", userId: "user-b" }],
    collections: [{ id: "collection-a", organisationId: "org-a" }, { id: "collection-b", organisationId: "org-b" }],
    uploadBatches: [{ id: "batch-a", organisationId: "org-a" }],
    cards: [{ id: "card-a", organisationId: "org-a", storagePath: "private_storage/cards/a.jpg" }, { id: "card-b", organisationId: "org-b" }],
    contacts: [{ id: "contact-a", organisationId: "org-a" }, { id: "contact-b", organisationId: "org-b" }],
    voiceNotes: [{ id: "voice-a", organisationId: "org-a", audioPath: "private_storage/voice_notes/a.webm" }],
    googleConnections: [{ id: "google-a", organisationId: "org-a" }],
    sheetConfigurations: [{ id: "sheet-a", organisationId: "org-a" }],
    syncRecords: [{ id: "sync-a", contactId: "contact-a", sheetConfigurationId: "sheet-a" }, { id: "sync-b", contactId: "contact-b" }],
    auditLogs: [{ id: "audit-a", organisationId: "org-a" }, { id: "audit-b", organisationId: "org-b" }]
  };
  const paths = removeOrganisationData(db, "org-a");
  assert.deepEqual(db.organisations.map((item) => item.id), ["org-b"]);
  assert.deepEqual(db.users.map((item) => item.id), ["user-b"]);
  assert.deepEqual(db.sessions.map((item) => item.id), ["session-b"]);
  assert.deepEqual(db.syncRecords.map((item) => item.id), ["sync-b"]);
  assert.equal(paths.length, 2);
});

test("VCF export packages exhibition contacts for phone import", () => {
  const vcf = buildVcf([
    {
      id: "contact-1",
      name: "Riya Shah",
      mobileNumber: "+91 98765 43210",
      secondaryMobileNumber: "+91 99887 65432",
      companyName: "ABC Jewels",
      designation: "Buyer",
      emailAddress: "riya@example.com",
      exhibitionName: "IIJS 2026",
      exhibitionDate: "2026-07-18",
      voiceTranscript: "September mein follow up karna hai."
    }
  ]).toString("utf8");

  assert.match(vcf, /BEGIN:VCARD/);
  // Display name is "[Exhibition Year]. Person Name. City State" (buildContactDisplayName).
  assert.match(vcf, /FN:\[IIJS 2026\]\. Riya Shah/);
  assert.match(vcf, /TEL;TYPE=CELL:\+91 98765 43210/);
  assert.match(vcf, /ORG:ABC Jewels/);
  assert.match(vcf, /September mein follow up karna hai/);
  assert.match(vcf, /Exhibition: IIJS 2026 - 18 Jul 2026/);
  assert.match(vcf, /CATEGORIES:IIJS 2026 - 18 Jul 2026/);
});

test("Google Contacts payload keeps exhibition identity and voice remarks", () => {
  const person = contactToGooglePerson({
    name: "Riya Shah",
    mobileNumber: "+91 98765 43210",
    secondaryMobileNumber: "+91 99887 65432",
    companyName: "ABC Jewels",
    designation: "Buyer",
    emailAddress: "riya@example.com",
    exhibitionName: "IIJS 2026",
    exhibitionDate: "2026-07-18",
    voiceTranscript: "September mein follow up karna hai."
  });
  assert.equal(person.names[0].unstructuredName, "[IIJS 2026]. Riya Shah");
  assert.equal(person.phoneNumbers.length, 2);
  assert.equal(person.organizations[0].name, "ABC Jewels");
  assert.ok(person.biographies[0].value.includes("September"));
  assert.deepEqual(person.userDefined, [
    { key: "Exhibition", value: "IIJS 2026" },
    { key: "Exhibition Date", value: "2026-07-18" },
    { key: "Card2Leads Label", value: "IIJS 2026 - 18 Jul 2026" },
    { key: "Contact Name", value: "Riya Shah" }
  ]);
});

test("Google Contacts names include a searchable exhibition and year suffix", () => {
  assert.equal(
    googleContactDisplayName({
      name: "Naveen Kumar",
      exhibitionName: "GJEPC",
      exhibitionDate: "2026-06-10"
    }),
    "[GJEPC 2026]. Naveen Kumar"
  );
  assert.equal(
    googleContactDisplayName({
      name: "Riya Shah",
      exhibitionName: "IIJS 2026",
      exhibitionDate: "2026-07-18"
    }),
    "[IIJS 2026]. Riya Shah"
  );
});

test("Saved contact name maps state from the city when the card omitted it", () => {
  assert.equal(
    googleContactDisplayName({
      name: "Ashish Dosaya",
      exhibitionName: "GJEPC",
      exhibitionDate: "2026-06-10",
      city: "Jaipur"
    }),
    "[GJEPC 2026]. Ashish Dosaya. Jaipur Rajasthan"
  );
});

test("Excel, CSV and the Google Sheet all render from one column list", () => {
  // These three used to drift: the sheet was built here, the CSV on the
  // phone. Anything that reads a contact out now goes through EXPORT_COLUMNS
  // and exportRow, so a column added for one appears in all three.
  assert.equal(new Set(EXPORT_COLUMNS).size, EXPORT_COLUMNS.length, "a column name is repeated");
  assert.ok(EXPORT_COLUMNS.includes("Event Name"), "Exhibition Name should read Event Name");
  assert.ok(EXPORT_COLUMNS.includes("Event Date"), "Exhibition Date should read Event Date");
  assert.ok(EXPORT_COLUMNS.includes("Scan Date"));
  assert.ok(!EXPORT_COLUMNS.some((c) => /^Exhibition/.test(c)), "an Exhibition column is left over");

  const row = exportRow({
    id: "internal-only",
    name: "Riya Shah",
    mobileNumber: "+91 98765 43210",
    notes: "Asked for a catalogue",
    extractionConfidence: 95,
    createdAt: "2026-07-21T10:00:00.000Z"
  });
  assert.equal(row.length, EXPORT_COLUMNS.length);
  assert.equal(row[0], "Riya Shah");
  assert.equal(row.includes("internal-only"), false);
  assert.equal(row.includes(95), false);
});

test("CSV and Excel export builders create valid downloadable files", () => {
  const rows = [EXPORT_COLUMNS, exportRow({
    name: "Riya Shah",
    mobileNumber: "+91 98765 43210",
    companyName: "ABC Jewels",
    notes: "Catalogue, pricing"
  })];
  const csv = buildCsv(rows);
  assert.ok(Buffer.isBuffer(csv));
  // The header is the column list itself, so this cannot fall behind it the
  // way a copied-out list does.
  assert.ok(csv.toString("utf8").startsWith("﻿" + EXPORT_COLUMNS.join(",")), "the CSV header is not the export column list");
  assert.match(csv.toString("utf8"), /Riya Shah/);
  assert.match(csv.toString("utf8"), /"Catalogue, pricing"/);

  const xlsx = buildXlsx(rows);
  assert.ok(Buffer.isBuffer(xlsx));
  assert.equal(xlsx.subarray(0, 2).toString("utf8"), "PK");
  assert.ok(xlsx.includes(Buffer.from("xl/worksheets/sheet1.xml")));
  assert.ok(xlsx.includes(Buffer.from("Riya Shah")));
});

test("voice transcripts always appear in the exported Remarks column", () => {
  const transcript = "Isko September mein follow up karna hai.";
  assert.equal(exportRemarks({ voiceTranscript: transcript, notes: "" }), transcript);
  assert.equal(
    exportRemarks({ voiceTranscript: transcript, notes: "Interested in bridal sets" }),
    `Interested in bridal sets\n\n${transcript}`
  );
  assert.equal(
    exportRemarks({ voiceTranscript: transcript, notes: `Existing note\n\n${transcript}` }),
    `Existing note\n\n${transcript}`
  );
  const row = exportRow({ name: "Riya", mobileNumber: "+919876543210", voiceTranscript: transcript });
  assert.equal(row[EXPORT_COLUMNS.indexOf("Remarks")], transcript);
});

test("Google Sheets connection uses file-limited OAuth access", () => {
  const scopes = googleScopes();
  assert.match(scopes, /auth\/drive\.file/);
  assert.doesNotMatch(scopes, /auth\/spreadsheets(?:\s|$)/);
});

test("Google requests can create and update but never delete (Contacts, Drive, Sheets)", () => {
  assert.match(googleScopes("contacts"), /auth\/contacts/);
  // Allowed: create/update contacts
  assert.equal(
    assertGoogleWritePolicy(
      "https://people.googleapis.com/v1/people:createContact",
      { method: "POST" }
    ),
    true
  );
  assert.equal(
    assertGoogleWritePolicy(
      "https://people.googleapis.com/v1/people/c123:updateContact",
      { method: "PATCH" }
    ),
    true
  );
  // Blocked: delete a contact
  assert.throws(
    () => assertGoogleWritePolicy(
      "https://people.googleapis.com/v1/people/c123:deleteContact",
      { method: "DELETE" }
    ),
    /never deletes/
  );
  // Blocked: batch delete contacts (POST endpoint)
  assert.throws(
    () => assertGoogleWritePolicy(
      "https://people.googleapis.com/v1/people:batchDeleteContacts",
      { method: "POST" }
    ),
    /never deletes/
  );
  // Blocked: delete a Drive file (drive.file scope)
  assert.throws(
    () => assertGoogleWritePolicy(
      "https://www.googleapis.com/drive/v3/files/abc123",
      { method: "DELETE" }
    ),
    /never deletes/
  );
  // Blocked: trashing a Drive file via update
  assert.throws(
    () => assertGoogleWritePolicy(
      "https://www.googleapis.com/drive/v3/files/abc123",
      { method: "PATCH", body: JSON.stringify({ trashed: true }) }
    ),
    /never deletes/
  );
});

test("voice data URLs accept Chrome codec parameters", () => {
  const parsed = parseDataUrl("data:audio/webm;codecs=opus;base64,SGVsbG8=");
  assert.equal(parsed.mimeType, "audio/webm");
  assert.equal(parsed.buffer.toString("utf8"), "Hello");
});

function tenantDb() {
  return {
    organisations: [{ id: "org_1" }, { id: "org_2" }],
    users: [{ id: "usr_1", organisationId: "org_1" }, { id: "usr_2", organisationId: "org_2" }],
    sessions: [],
    collections: [{ id: "col_1", organisationId: "org_1" }, { id: "col_2", organisationId: "org_2" }],
    uploadBatches: [], cards: [], contacts: [], voiceNotes: [], googleConnections: [],
    sheetConfigurations: [], syncRecords: [], auditLogs: []
  };
}

test("tenant integrity accepts records contained within one organisation", () => {
  const db = tenantDb();
  db.contacts.push({ id: "contact_1", organisationId: "org_1", ownerId: "usr_1", collectionId: "col_1" });
  assert.equal(validateTenantIntegrity(db), true);
});

test("tenant integrity rejects a contact linked to another organisation's collection", () => {
  const db = tenantDb();
  db.contacts.push({ id: "contact_1", organisationId: "org_1", ownerId: "usr_1", collectionId: "col_2" });
  assert.throws(() => validateTenantIntegrity(db), /Tenant integrity violation/);
});

test("blank or non-card extraction cannot report high confidence", () => {
  const extraction = normalizeExtraction({ confidence: 100, fieldConfidence: {} }, {});
  assert.equal(extraction.confidence, 0);
});

test("missing mandatory contact fields cap overall confidence", () => {
  const value = deriveOverallConfidence({
    name: "",
    mobileNumber: "",
    companyName: "Example Ltd",
    rawVisibleText: "Example Ltd",
    fieldConfidence: { companyName: 99 }
  }, 99);
  assert.equal(value, 35);
});

test("company and any available phone number fill missing required contact fields without repeated warnings", () => {
  const extraction = normalizeExtraction({
    name: "",
    mobileNumber: "",
    companyName: "DMYANSHI FASHION",
    officeNumber: "+91 70216 67405 / +91 99206 71818",
    fieldConfidence: { companyName: 96, officeNumber: 91 },
    warnings: [
      "No contact person name is printed on the card.",
      "Name was not confidently extracted. Please enter it before saving.",
      "Mobile Number was not confidently extracted. Please enter it before saving.",
      "Name was not confidently extracted. Please enter it before saving.",
      "Mobile Number was not confidently extracted. Please enter it before saving."
    ]
  }, {});

  assert.equal(extraction.name, "DMYANSHI FASHION");
  assert.equal(extraction.companyName, "DMYANSHI FASHION");
  assert.equal(extraction.mobileNumber, "+917021667405");
  assert.equal(extraction.officeNumber, "+919920671818");
  assert.deepEqual(extraction.warnings, []);
});

test("email fields ignore website-like values without an at sign", () => {
  const extraction = normalizeExtraction({
    name: "DIVYANSHI FASHION",
    mobileNumber: "+917021667405",
    companyName: "DIVYANSHI FASHION",
    emailAddress: "sales18fire@gmail.com",
    secondaryEmail: "info18fire.com",
    website: "www.18fire.com",
    fieldConfidence: {
      name: 90,
      mobileNumber: 90,
      companyName: 90,
      emailAddress: 95,
      secondaryEmail: 80,
      website: 90
    }
  }, {});

  assert.equal(extraction.emailAddress, "sales18fire@gmail.com");
  assert.equal(extraction.secondaryEmail, "");
  assert.equal(extraction.website, "www.18fire.com");

  const extractionWithoutWebsite = normalizeExtraction({
    name: "DIVYANSHI FASHION",
    mobileNumber: "+917021667405",
    emailAddress: "sales18fire@gmail.com",
    secondaryEmail: "info18fire.com",
    website: ""
  }, {});
  assert.equal(extractionWithoutWebsite.secondaryEmail, "");
  assert.equal(extractionWithoutWebsite.website, "");
});

test("first-time users do not receive an implicit collection", () => {
  const db = { collections: [] };
  const user = { organisationId: "org_1" };
  assert.equal(findCollectionForUser(db, user), null);
  assert.equal(db.collections.length, 0);
});

test("new exhibition uploads cannot inherit the previous exhibition", () => {
  const db = {
    collections: [{ id: "col_iijs", organisationId: "org_1", name: "IIJS 2026", exhibitionName: "IIJS 2026", status: "active" }],
    contacts: [],
    cards: [],
    auditLogs: []
  };
  const user = { id: "usr_1", organisationId: "org_1", name: "Preeti" };
  const collection = createCollectionFromUpload(db, user, {
    collectionName: "GJEPC",
    exhibitionName: "",
    destinationType: "excel"
  });
  assert.equal(collection.exhibitionName, "GJEPC");
  assert.equal(collection.status, "active");
  assert.equal(db.collections[0].status, "archived");

  const card = {
    id: "card_1",
    organisationId: "org_1",
    collectionId: collection.id,
    extraction: { confidence: 90, exhibitionName: "IIJS 2026" },
    storageUrl: "",
    status: "requires_review"
  };
  db.cards.push(card);
  const saved = saveContactRecord(db, user, card, {
    name: "Riya Shah",
    mobileNumber: "+91 98765 43210",
    exhibitionName: "IIJS 2026"
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.contact.collectionId, collection.id);
  assert.equal(saved.contact.exhibitionName, "GJEPC");
});

test("a card with missing or malformed fields is still saved, just flagged for review", () => {
  const db = {
    collections: [{ id: "col_1", organisationId: "org_1", name: "IIJS 2026", exhibitionName: "IIJS 2026", status: "active", destinationType: "excel" }],
    contacts: [],
    cards: [],
    auditLogs: []
  };
  const user = { id: "usr_1", organisationId: "org_1", name: "Preeti" };
  const card = { id: "card_1", organisationId: "org_1", collectionId: "col_1", extraction: { confidence: 40 }, storageUrl: "", status: "queued" };

  const saved = saveContactRecord(db, user, card, {
    name: "",
    mobileNumber: "",
    emailAddress: "not-an-email"
  });

  assert.equal(saved.ok, true, "saving must never be blocked, no matter how incomplete the data is");
  assert.equal(db.contacts.length, 1);
  assert.equal(saved.contact.needsReview, true);
  assert.ok(saved.contact.reviewReasons.includes("Name is missing."));
  assert.ok(saved.contact.reviewReasons.includes("Mobile number is missing."));
  assert.equal(card.status, "saved");
});

test("a re-scanned duplicate fills blanks and appends notes without overwriting", () => {
  const db = {
    collections: [{ id: "col_1", organisationId: "org_1", name: "IIJS 2026", exhibitionName: "IIJS 2026", status: "active", destinationType: "excel" }],
    contacts: [],
    cards: [],
    auditLogs: []
  };
  const user = { id: "usr_1", organisationId: "org_1", name: "Preeti" };
  const firstCard = { id: "card_1", organisationId: "org_1", collectionId: "col_1", extraction: { confidence: 90 }, storageUrl: "", status: "queued" };
  const secondCard = { id: "card_2", organisationId: "org_1", collectionId: "col_1", extraction: { confidence: 70 }, storageUrl: "", status: "queued" };
  db.cards.push(firstCard, secondCard);

  const first = saveContactRecord(db, user, firstCard, {
    name: "Riya Shah",
    mobileNumber: "+91 98765 43210",
    companyName: "ABC Jewels",
    notes: "Met at booth 12"
  });
  assert.equal(first.ok, true);

  const second = saveContactRecord(db, user, secondCard, {
    name: "Riya Shah",
    mobileNumber: "+91 98765 43210",
    companyName: "ABC Jewels Pvt Ltd",
    designation: "Buyer",
    notes: "Wants the bridal catalogue"
  }, { mergeDuplicate: true });

  assert.equal(second.ok, true);
  assert.equal(second.merged, true);
  assert.equal(db.contacts.length, 1, "merging must not create a second contact");
  assert.equal(second.contact.companyName, "ABC Jewels", "an existing value is never overwritten");
  assert.equal(second.contact.designation, "Buyer", "a blank field is filled from the new scan");
  assert.equal(second.contact.notes, "Met at booth 12\n\nWants the bridal catalogue", "notes are appended");
  assert.equal(secondCard.status, "saved");

  // Re-merging identical content must not duplicate the appended note.
  saveContactRecord(db, user, secondCard, {
    name: "Riya Shah",
    mobileNumber: "+91 98765 43210",
    notes: "Wants the bridal catalogue"
  }, { mergeDuplicate: true });
  assert.equal(db.contacts[0].notes, "Met at booth 12\n\nWants the bridal catalogue");
});

test("stored contacts are repaired to their contact-list exhibition", () => {
  const db = {
    collections: [
      { id: "col_gjepc", organisationId: "org_1", name: "GJEPC", exhibitionName: "GJEPC", exhibitionDate: "2026-08-01" },
      { id: "col_gjepc_old", organisationId: "org_1", name: "GJEPC", exhibitionName: "IIJS 2026", exhibitionDate: "" }
    ],
    contacts: [{ id: "con_1", collectionId: "col_gjepc_old", exhibitionName: "IIJS 2026", exhibitionDate: "" }],
    cards: [{ id: "card_1", collectionId: "col_gjepc_old", extraction: { exhibitionName: "IIJS 2026", exhibitionDate: "" } }]
  };
  assert.equal(repairCollectionExhibitionAssignments(db), true);
  assert.equal(db.collections[1].exhibitionName, "GJEPC");
  assert.equal(db.contacts[0].exhibitionName, "GJEPC");
  assert.equal(db.cards[0].extraction.exhibitionName, "GJEPC");
});

test("plan usage reports remaining scans for an active paid plan", () => {
  const usage = planUsage({ plan: "event", scansUsed: 125, billingMode: "one_time", subscriptionStatus: "paid_once", currentPeriodEnd: "2099-01-01T00:00:00.000Z" });
  assert.equal(usage.plan, "event");
  assert.equal(usage.limit, 300);
  assert.equal(usage.used, 125);
  assert.equal(usage.remaining, 175);
});

test("active subscription plans use their configured scan limits", () => {
  const remaining = (plan, used) => planUsage({ plan, scansUsed: used, billingMode: "subscription", subscriptionStatus: "active" }).remaining;
  assert.equal(remaining("monthly", 25), 125);
  assert.equal(remaining("quarterly", 100), 200);
  assert.equal(remaining("annual", 1000), 500);
});

test("extra scans can only be purchased for an active paid plan", () => {
  assert.equal(canPurchaseTopup({ plan: "trial" }), false);
  assert.equal(canPurchaseTopup({ plan: "monthly", billingMode: "subscription", subscriptionStatus: "active" }), true);
  assert.equal(canPurchaseTopup({ plan: "monthly", billingMode: "subscription", subscriptionStatus: "halted" }), false);
  assert.equal(canPurchaseTopup({
    plan: "quarterly",
    billingMode: "one_time",
    subscriptionStatus: "paid_once",
    currentPeriodEnd: "2099-01-01T00:00:00.000Z"
  }), true);
  assert.equal(canPurchaseTopup({
    plan: "quarterly",
    billingMode: "one_time",
    subscriptionStatus: "paid_once",
    currentPeriodEnd: "2020-01-01T00:00:00.000Z"
  }), false);
});

test("top-up balance reflects credits actually remaining", () => {
  const organisation = { plan: "monthly", scanLimit: 250, scansUsed: 170, topupScans: 100 };
  assert.equal(remainingTopupScans(organisation), 80);
  grantTopupEntitlement(organisation, 100);
  assert.equal(organisation.scanLimit, 350);
  assert.equal(remainingTopupScans(organisation), 180);
});

test("one-time plan activation grants a fixed non-recurring allowance", () => {
  const organisation = {
    id: "org_once",
    plan: "trial",
    scanLimit: 20,
    scansUsed: 12,
    topupScans: 0
  };
  assert.equal(grantOneTimePlan(organisation, "quarterly", { orderId: "order_1", paymentId: "pay_1" }), true);
  assert.equal(organisation.billingMode, "one_time");
  assert.equal(organisation.subscriptionStatus, "paid_once");
  assert.equal(organisation.plan, "quarterly");
  assert.equal(organisation.scanLimit, 300);
  assert.equal(organisation.scansUsed, 0);
  assert.ok(new Date(organisation.currentPeriodEnd).getTime() > Date.now());
  assert.equal(grantOneTimePlan(organisation, "quarterly", { orderId: "order_1", paymentId: "pay_1" }), false);
});

test("changing plans carries only unused purchased scans", () => {
  const organisation = {
    plan: "monthly",
    billingMode: "subscription",
    subscriptionStatus: "active",
    scanLimit: 250,
    scansUsed: 170,
    topupScans: 100
  };
  assert.equal(grantOneTimePlan(organisation, "annual", { orderId: "order_carry", paymentId: "pay_carry" }), true);
  assert.equal(organisation.topupScans, 80);
  assert.equal(organisation.scanLimit, 1580);
  assert.equal(organisation.scansUsed, 0);
});

test("expired one-time plans cannot use remaining scans", () => {
  assert.deepEqual(planUsage({
    plan: "monthly",
    billingMode: "one_time",
    currentPeriodEnd: "2020-01-01T00:00:00.000Z",
    scanLimit: 150,
    scansUsed: 25
  }), {
    plan: "monthly",
    limit: 150,
    used: 25,
    remaining: 0,
    expired: true
  });
});

test("pay-to-start: unpaid accounts get no scans; demo accounts do", () => {
  // No free trial — a brand-new/unpaid account cannot scan until it subscribes.
  const trial = planUsage({ plan: "trial", scansUsed: 0 });
  assert.equal(trial.remaining, 0);
  assert.equal(trial.requiresPayment, true);
  // The single demo/test account scans without limit so testing is never blocked.
  const demo = planUsage({ plan: "demo", isDemoAccount: true, scansUsed: 10 });
  assert.equal(demo.unlimited, true);
  assert.ok(demo.remaining > 1e6);
  assert.equal(demo.requiresPayment, undefined);
});

test("password rules require length and character classes", () => {
  assert.ok(validatePasswordStrength("weakpassword"));
  assert.equal(validatePasswordStrength("StrongPass#10"), "");
});

test("contact validation never blocks a save, only flags reasons for review", () => {
  const clean = validateContact({ name: "Riya Shah", mobileNumber: "+91 98765 43210" });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.reasons, []);

  const missingName = validateContact({ name: "", mobileNumber: "+91 98765 43210" });
  assert.equal(missingName.ok, true);
  assert.ok(missingName.reasons.includes("Name is missing."));

  const invalidMobile = validateContact({ name: "Riya Shah", mobileNumber: "123" });
  assert.equal(invalidMobile.ok, true);
  assert.ok(invalidMobile.reasons.includes("Mobile number looks invalid."));
});

test("slash-separated mobile numbers are stored in primary and secondary fields", () => {
  assert.deepEqual(normalizePhoneFields({
    mobileNumber: "901-9873731 / 9009302235",
    secondaryMobileNumber: ""
  }), {
    mobileNumber: "9019873731",
    secondaryMobileNumber: "9009302235",
    officeNumber: ""
  });
  const extraction = normalizeExtraction({
    name: "Savan Sadhpara",
    mobileNumber: "901-9873731 / 9009302235",
    confidence: 90,
    fieldConfidence: { name: 95, mobileNumber: 90 }
  }, {});
  assert.equal(extraction.mobileNumber, "9019873731");
  assert.equal(extraction.secondaryMobileNumber, "9009302235");
  assert.equal(extraction.fieldConfidence.secondaryMobileNumber, 90);
});

test("office numbers preserve slash-separated alternatives or extensions", () => {
  const fields = normalizePhoneFields({
    name: "S. Karthikeyan",
    mobileNumber: "+91 93848 60999",
    officeNumber: "04212485515/252653"
  });
  assert.equal(fields.officeNumber, "04212485515 / 252653");
  assert.equal(validateContact(fields).ok, true);

  // Cards commonly print consecutive lines as two-digit shorthand.
  const consecutive = normalizePhoneFields({
    name: "S. Karthikeyan",
    mobileNumber: "+91 99948 60699",
    officeNumber: "04212485551 / 52 / 53"
  });
  assert.equal(consecutive.officeNumber, "04212485551 / 52 / 53");
  assert.equal(validateContact(consecutive).ok, true);
});

// ---- Updating contacts from a spreadsheet ----
// The sheet goes out, someone edits it in Excel, it comes back. The cases worth
// guarding are the ones where a wrong answer would be silent: a row matched to
// the wrong contact, a value written to a column nobody meant to touch, or a
// typo accepted as though it were a real value.
const {
  buildBulkUpdateWorkbook,
  readWorkbookRows,
  planBulkContactUpdate,
  applyBulkContactUpdate
} = require("../server.js");

// The sheet that goes out is the ordinary Excel export with dropdowns added,
// so the tests build it the way the download does.
const bulkSheetFor = (contacts) =>
  buildBulkUpdateWorkbook([EXPORT_COLUMNS.slice(), ...contacts.map((c) => exportRow(c, 0).map((v) => String(v == null ? "" : v)))], bulkChoices);

const bulkChoices = {
  salutation: ["Mr.", "Ms."],
  industry: ["Jewellery Industry", "Other Industry"],
  businessType: ["Jewellery Retailer", "Karigar"],
  customerStatus: ["Existing Customer", "New Customer"],
  leadSource: ["Exhibition", "Magazine"]
};

function bulkContacts() {
  return [
    { id: "con_1", organisationId: "org", name: "Kamlesh Patel", mobileNumber: "+919825011111", normalizedMobileNumber: "+919825011111", companyName: "Dishaa", exhibitionName: "GJEPC", salutation: "Mr.", industry: "", businessType: [], customerStatus: "", customerRating: "", leadSource: "", businessSpecialisation: "" },
    { id: "con_2", organisationId: "org", name: "Nita Shah", mobileNumber: "+919820022222", normalizedMobileNumber: "+919820022222", companyName: "Shah", exhibitionName: "GJEPC", salutation: "", industry: "Jewellery Industry", businessType: ["Karigar"], customerStatus: "New Customer", customerRating: "3", leadSource: "", businessSpecialisation: "" }
  ];
}

// Rebuild a workbook from a grid of strings, deflated the way Excel writes one
// - which exercises the other branch of the reader, since the sheet the server
// sends out is stored uncompressed.
function bulkWorkbookFrom(grid) {
  const zlib = require("zlib");
  const esc = (v) => String(v == null ? "" : v).replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]));
  const col = (i) => { let n = ""; let x = i; while (x > 0) { const r = (x - 1) % 26; n = String.fromCharCode(65 + r) + n; x = Math.floor((x - 1) / 26); } return n; };
  const body = grid.map((row, r) =>
    `<row r="${r + 1}">${row.map((v, c) => `<c r="${col(c + 1)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`).join("")}</row>`
  ).join("");
  const parts = {
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
  };
  const table = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const raw = Buffer.from(content, "utf8");
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8); end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

test("the update sheet is the ordinary export, and round-trips unchanged", () => {
  const rows = readWorkbookRows(bulkSheetFor(bulkContacts()));
  // Every column the export carries, in the same order: this is the file
  // people already know, not a cut-down one.
  assert.deepEqual(rows[0], EXPORT_COLUMNS);
  assert.equal(rows[1][rows[0].indexOf("Name")], "Kamlesh Patel");
  assert.equal(rows[2][rows[0].indexOf("Business Type")], "Karigar");
  assert.equal(rows[2][rows[0].indexOf("Customer Rating")], "3");
});

test("a filled-in sheet updates only the classification columns", () => {
  const contacts = bulkContacts();
  const grid = readWorkbookRows(bulkSheetFor(contacts));
  const header = grid[0];
  const at = (name) => header.indexOf(name);

  grid[1][at("Industry")] = "Jewellery Industry";
  grid[1][at("Business Type")] = "Jewellery Retailer; Karigar";
  grid[1][at("Customer Rating")] = "5";
  // A value the dropdown never offered has to be kept: every one of these
  // fields allows "Other" in the app itself.
  grid[2][at("Industry")] = "Textiles & Apparel";
  // Editing a column this flow does not own must have no effect at all.
  grid[2][at("Name")] = "SHOULD NOT BE SAVED";
  grid[2][at("Company Name")] = "SHOULD NOT BE SAVED EITHER";

  const db = { contacts };
  const user = { id: "usr", organisationId: "org" };
  const plan = planBulkContactUpdate(db, user, bulkWorkbookFrom(grid), bulkChoices);
  assert.equal(plan.updates.length, 2);
  // Planning writes nothing: the preview someone approves must not be the
  // change itself.
  assert.equal(contacts[0].customerRating, "");

  assert.equal(applyBulkContactUpdate(db, user, plan), 2);
  assert.deepEqual(contacts[0].businessType, ["Jewellery Retailer", "Karigar"]);
  assert.equal(contacts[0].customerRating, "5");
  assert.equal(contacts[1].industry, "Textiles & Apparel");
  assert.equal(contacts[1].name, "Nita Shah");
  assert.equal(contacts[1].mobileNumber, "+919820022222");

  // Sending the same sheet again must do nothing.
  assert.equal(planBulkContactUpdate(db, user, bulkWorkbookFrom(grid), bulkChoices).updates.length, 0);

  // Without a contact id column the mobile number is what identifies a row, so
  // changing it in the sheet leaves that row pointing at nobody - and it is
  // reported rather than passed over in silence.
  const renumbered = grid.map((r) => r.slice());
  renumbered[1][at("Mobile Number")] = "+910000000000";
  renumbered[1][at("Customer Rating")] = "4";
  const strayed = planBulkContactUpdate(db, user, bulkWorkbookFrom(renumbered), bulkChoices);
  assert.equal(strayed.updates.length, 0);
  assert.ok(strayed.notFound.some((p) => String(p.key).includes("910000000000")));
});

test("a bulk update sheet reports rows it cannot safely apply", () => {
  const contacts = bulkContacts();
  const grid = readWorkbookRows(bulkSheetFor(contacts));
  const header = grid[0];
  const at = (name) => header.indexOf(name);

  // A rating that is not a rating must be called out, not quietly dropped.
  grid[1][at("Customer Rating")] = "ten";
  // The mobile number is what identifies a row in this sheet, so a number
  // nobody has cannot be matched.
  const ghost = new Array(header.length).fill("");
  ghost[at("Mobile Number")] = "+910000009999";
  grid.push(ghost);
  // A second row for a contact already in the sheet: applying both would make
  // the outcome depend on row order.
  const repeat = new Array(header.length).fill("");
  repeat[at("Mobile Number")] = "+919820022222";
  repeat[at("Industry")] = "Other Industry";
  grid.push(repeat);

  const db = { contacts };
  const user = { id: "usr", organisationId: "org" };
  const plan = planBulkContactUpdate(db, user, bulkWorkbookFrom(grid), bulkChoices);
  assert.ok(plan.problems.some((p) => /rating/.test(p.reason)));
  assert.ok(plan.problems.some((p) => /already on row/.test(p.reason)));
  assert.ok(plan.notFound.some((p) => String(p.key).includes("910000009999")));
  assert.equal(contacts[0].customerRating, "");

  // And something that is not a spreadsheet gets a sentence, not a stack trace.
  assert.throws(
    () => planBulkContactUpdate(db, user, Buffer.from("not a spreadsheet"), bulkChoices),
    /spreadsheet/i
  );
});

// ---- Invoice numbering runs oldest first ----
// Numbers used to be handed out when an invoice was first opened, so the order
// they were opened in became the order of the series: a payment from November
// ended up as 0001 with September's payments below it.
const { resequenceInvoices } = require("../server.js");

// The payments on the Dishaa Platinum account, newest last.
function dishaaRows() {
  return [
    { id: "p_sep", client_id: "org_d", provider_payment_id: "pay_sep", amount_paise: 89900, plan: "quarterly", status: "paid", completed_at: "2026-09-29T06:00:00.000Z", created_at: "2026-09-29T06:00:00.000Z" },
    { id: "p_nov14", client_id: "org_d", provider_payment_id: "pay_nov14", amount_paise: 49900, plan: "topup", status: "paid", completed_at: "2026-11-14T06:00:00.000Z", created_at: "2026-11-14T06:00:00.000Z" },
    { id: "p_nov19", client_id: "org_d", provider_payment_id: "pay_nov19", amount_paise: 399900, plan: "annual", status: "paid", completed_at: "2026-11-19T06:00:00.000Z", created_at: "2026-11-19T06:00:00.000Z" }
  ];
}

test("invoice numbers follow the payment date, oldest first", () => {
  // The November payment was opened first, so it had already taken 0001.
  const db = {
    organisations: [{
      id: "org_d",
      invoices: {
        pay_nov19: { number: "75/26-27", fy: "2026-27", seq: 1, scans: 1000, issuedAt: "2026-11-19T07:00:00.000Z", notifiedAt: "2026-11-19T07:01:00.000Z", paymentKey: "pay_nov19" }
      }
    }]
  };

  resequenceInvoices(db, dishaaRows());
  const invoices = db.organisations[0].invoices;
  assert.equal(invoices.pay_sep.number, "75/26-27");
  assert.equal(invoices.pay_nov14.number, "76/26-27");
  assert.equal(invoices.pay_nov19.number, "77/26-27");

  // Renumbering moves the number and nothing else: when it was issued, what it
  // covered and whether it has been sent are facts about that invoice.
  assert.equal(invoices.pay_nov19.issuedAt, "2026-11-19T07:00:00.000Z");
  assert.equal(invoices.pay_nov19.notifiedAt, "2026-11-19T07:01:00.000Z");
  assert.equal(invoices.pay_nov19.scans, 1000);

  // Running it again must not shuffle anything.
  resequenceInvoices(db, dishaaRows());
  assert.equal(db.organisations[0].invoices.pay_sep.number, "75/26-27");
  assert.equal(db.organisations[0].invoices.pay_nov19.number, "77/26-27");
});

test("the invoice series is global and splits on the financial year", () => {
  const db = { organisations: [{ id: "org_a", invoices: {} }, { id: "org_b", invoices: {} }] };
  // Indian financial years start in April, so March and April belong to
  // different series even though they are days apart.
  resequenceInvoices(db, [
    { id: "1", client_id: "org_a", provider_payment_id: "pay_mar", amount_paise: 89900, plan: "quarterly", status: "paid", completed_at: "2026-03-30T06:00:00.000Z", created_at: "2026-03-30T06:00:00.000Z" },
    { id: "2", client_id: "org_b", provider_payment_id: "pay_apr", amount_paise: 89900, plan: "quarterly", status: "paid", completed_at: "2026-04-02T06:00:00.000Z", created_at: "2026-04-02T06:00:00.000Z" },
    { id: "3", client_id: "org_a", provider_payment_id: "pay_may", amount_paise: 89900, plan: "quarterly", status: "paid", completed_at: "2026-05-02T06:00:00.000Z", created_at: "2026-05-02T06:00:00.000Z" }
  ]);
  assert.equal(db.organisations[0].invoices.pay_mar.number, "1/25-26");
  // One series across all customers, so the next April payment is 0001 of the
  // new year and the one after it is 0002 even though it is another company's.
  assert.equal(db.organisations[1].invoices.pay_apr.number, "75/26-27");
  assert.equal(db.organisations[0].invoices.pay_may.number, "76/26-27");
});

test("a payment that is no longer paid loses its invoice number", () => {
  // Otherwise the refunded invoice keeps a number that resequencing has since
  // handed to a real one, and two invoices carry the same number.
  const db = {
    organisations: [{
      id: "org_d",
      invoices: {
        pay_refunded: { number: "75/26-27", fy: "2026-27", seq: 1, paymentKey: "pay_refunded" },
        pay_sep: { number: "76/26-27", fy: "2026-27", seq: 2, paymentKey: "pay_sep" }
      }
    }]
  };
  resequenceInvoices(db, dishaaRows());
  assert.equal(db.organisations[0].invoices.pay_refunded, undefined);
  assert.equal(db.organisations[0].invoices.pay_sep.number, "75/26-27");
  const numbers = Object.values(db.organisations[0].invoices).map((i) => i.number);
  assert.equal(new Set(numbers).size, numbers.length, "no two invoices share a number");
});

// ---- The ordinary Excel export can be sent back ----
// The app downloads /api/export.xlsx from the Contacts tab, so that is the file
// people already have in hand. It carries no contact id, so the rows are
// matched on the mobile number instead - and the columns it does carry have to
// line up with the ones read back, or editing it would silently do nothing.
const { EXPORT_COLUMNS: BULK_EXPORT_COLUMNS, exportRow: bulkExportRow } = require("../server.js");

test("every column the bulk update reads exists in the ordinary export", () => {
  for (const spec of ["Salutation", "Industry", "Business Type", "Business Specialisation", "Customer Status", "Customer Rating", "Lead Source", "Mobile Number"]) {
    assert.ok(BULK_EXPORT_COLUMNS.includes(spec), `the export is missing "${spec}"`);
  }
});

test("an edited copy of the ordinary export updates the right contacts", () => {
  const contacts = [
    { id: "con_1", organisationId: "org", name: "Kamlesh Patel", mobileNumber: "+919825011111", normalizedMobileNumber: "+919825011111", companyName: "Dishaa", salutation: "Mr.", industry: "", businessType: [], customerStatus: "", customerRating: "", leadSource: "", businessSpecialisation: "" },
    { id: "con_2", organisationId: "org", name: "Nita Shah", mobileNumber: "+919820022222", normalizedMobileNumber: "+919820022222", companyName: "Shah", salutation: "", industry: "Jewellery Industry", businessType: ["Karigar"], customerStatus: "New Customer", customerRating: "3", leadSource: "", businessSpecialisation: "" }
  ];

  // Built with the real export writer, so this test fails if the export's
  // columns and the reader's ever drift apart.
  const grid = [BULK_EXPORT_COLUMNS.slice(), ...contacts.map((c) => bulkExportRow(c, 0).map((cell) => String(cell == null ? "" : cell)))];
  const header = grid[0];
  const at = (name) => header.indexOf(name);
  // The export guards against spreadsheet formula injection by prefixing any
  // cell that starts with = + - or @, so a phone number comes back as
  // "'+9198...". Matching strips everything that is not a digit, so the row
  // still finds its contact.
  assert.equal(grid[1][at("Mobile Number")], "'+919825011111");

  grid[1][at("Industry")] = "Jewellery Industry";
  grid[1][at("Business Type")] = "Jewellery Retailer; Karigar";
  grid[1][at("Customer Rating")] = "5";
  // Typed back in another shape, the way someone would retype a number.
  grid[2][at("Mobile Number")] = "98200 22222";
  grid[2][at("Customer Status")] = "Existing Customer";
  // An edit to a column this flow does not own must still be ignored.
  grid[2][at("Name")] = "SHOULD NOT BE SAVED";

  const db = { contacts };
  const user = { id: "usr", organisationId: "org" };
  const plan = planBulkContactUpdate(db, user, bulkWorkbookFrom(grid), bulkChoices);
  assert.equal(plan.updates.length, 2, "both rows matched on their number");
  assert.equal(applyBulkContactUpdate(db, user, plan), 2);

  assert.deepEqual(contacts[0].businessType, ["Jewellery Retailer", "Karigar"]);
  assert.equal(contacts[0].customerRating, "5");
  assert.equal(contacts[1].customerStatus, "Existing Customer");
  assert.equal(contacts[1].name, "Nita Shah");
  assert.equal(contacts[1].mobileNumber, "+919820022222");
});

test("a sheet with nothing to identify a contact by is refused", () => {
  const db = { contacts: [] };
  const user = { id: "usr", organisationId: "org" };
  const grid = [["Name", "Industry"], ["Kamlesh Patel", "Jewellery Industry"]];
  assert.throws(
    () => planBulkContactUpdate(db, user, bulkWorkbookFrom(grid), bulkChoices),
    /Mobile Number/
  );
});

const { buildInvoiceHtml, pendingAccountsCopies } = require("../server.js");

// ---- The invoice follows the company's own format ----
// Built from the blank template the company uses for every other invoice, so
// one issued here and one written by hand sit on the same stationery.
test("the invoice carries the particulars the company's format calls for", () => {
  const org = { billingProfile: { legalName: "Dishaa Gold and Platinum", gstin: "27AAMFD5405C1ZQ", address: "Kalbadevi Road, Mumbai - 400002, Maharashtra", city: "Mumbai", stateName: "Maharashtra", stateCode: "27" } };
  const payment = { id: "pay_1", provider_payment_id: "pay_U20XGeFFMg9RH8", amount_paise: 399900, plan: "annual", status: "paid", completed_at: "2026-11-19T06:00:00.000Z", created_at: "2026-11-19T06:00:00.000Z" };
  const html = buildInvoiceHtml(org, payment, { number: "77/26-27", fy: "2026-27", seq: 67, scans: 1500 });

  for (const field of ["INVOICE", "Invoice No.", "Dated", "Delivery Note", "Mode/Terms of Payment", "Reference No. &amp; Date.", "Other References", "Consignee (Ship to)", "Buyer (Bill to)", "Terms of Delivery", "HSN/SAC", "Particulars", "Amount Chargeable (in words)", "E. &amp; O.E", "Company&rsquo;s PAN", "This is a Computer Generated Invoice"]) {
    assert.ok(html.includes(field), `the format is missing "${field}"`);
  }

  // The line has to say what was sold, not just that something was.
  assert.ok(html.includes("Technology Consulting Services"));
  assert.ok(html.includes("Pro Annual"), "the product name the customer bought");
  assert.ok(html.includes("1,500 scan credits"), "how many scans it allows");
  assert.ok(html.includes("997331"), "the SAC code");

  // Both parties, with the state code and place of supply rule 46 asks for.
  assert.ok(html.includes("27AALCB6043Q1Z2"), "the seller's GSTIN");
  assert.ok(html.includes("27AAMFD5405C1ZQ"), "the buyer's GSTIN");
  assert.ok(html.includes("Place of Supply"));
  assert.ok(html.includes("Code : 27"));

  // Signed, and dated the way the rest of the book is dated.
  assert.ok(/sign-img/.test(html), "the signature");
  assert.ok(html.includes("19-Nov-2026"), "the date");

  // Intra-state, so it splits into CGST and SGST rather than charging IGST.
  assert.ok(html.includes("CGST @ 9%") && html.includes("SGST @ 9%"));
  assert.ok(!html.includes("IGST"));
  assert.ok(html.includes("3,999.00"), "the total");
  // "INR" comes from the words helper; printing it again would double it.
  assert.ok(!/INR INR/.test(html));
});

test("a buyer in another state is charged IGST", () => {
  const org = { billingProfile: { legalName: "Shah Jewels", gstin: "24AAMFD5405C1ZQ", address: "12 Ratnakar Nine Square, Ahmedabad", stateName: "Gujarat", stateCode: "24" } };
  const payment = { id: "pay_2", provider_payment_id: "pay_y", amount_paise: 89900, plan: "quarterly", status: "paid", completed_at: "2026-09-29T06:00:00.000Z", created_at: "2026-09-29T06:00:00.000Z" };
  const html = buildInvoiceHtml(org, payment, { number: "75/26-27", fy: "2026-27", seq: 65, scans: 300 });
  assert.ok(html.includes("IGST @ 18%"));
  assert.ok(!html.includes("CGST"));
  assert.ok(html.includes("Place of Supply</span>: Gujarat"));
});

test("the number continues the hand-written book and shows the short year", () => {
  const db = { organisations: [{ id: "org_a", invoices: {} }] };
  resequenceInvoices(db, [
    { id: "1", client_id: "org_a", provider_payment_id: "pay_a", amount_paise: 89900, plan: "quarterly", status: "paid", completed_at: "2026-09-29T06:00:00.000Z", created_at: "2026-09-29T06:00:00.000Z" },
    { id: "2", client_id: "org_a", provider_payment_id: "pay_b", amount_paise: 49900, plan: "topup", status: "paid", completed_at: "2026-11-14T06:00:00.000Z", created_at: "2026-11-14T06:00:00.000Z" },
    { id: "3", client_id: "org_a", provider_payment_id: "pay_c", amount_paise: 399900, plan: "annual", status: "paid", completed_at: "2026-11-19T06:00:00.000Z", created_at: "2026-11-19T06:00:00.000Z" }
  ]);
  const invoices = db.organisations[0].invoices;
  assert.equal(invoices.pay_a.number, "75/26-27");
  assert.equal(invoices.pay_b.number, "76/26-27");
  assert.equal(invoices.pay_c.number, "77/26-27");
});

test("an admin running a client's sheet cannot reach another client's contacts", () => {
  // The admin acts as the client's workspace, so the tenant check is the only
  // thing standing between one client's spreadsheet and another's records.
  const contacts = [
    { id: "con_a", organisationId: "org_a", name: "Kamlesh Patel", mobileNumber: "+919825011111", normalizedMobileNumber: "+919825011111", industry: "", businessType: [], customerStatus: "", customerRating: "", leadSource: "", businessSpecialisation: "", salutation: "" },
    { id: "con_b", organisationId: "org_b", name: "Someone Else", mobileNumber: "+919820022222", normalizedMobileNumber: "+919820022222", industry: "", businessType: [], customerStatus: "", customerRating: "", leadSource: "", businessSpecialisation: "", salutation: "" }
  ];
  const db = { contacts };
  // A sheet naming both — the second row belongs to a different client.
  const grid = [
    ["Contact ID", "Name", "Mobile Number", "Company Name", "Event", "Salutation", "Industry", "Business Type", "Business Specialisation", "Customer Status", "Customer Rating", "Lead Source"],
    ["con_a", "Kamlesh Patel", "+919825011111", "", "", "", "Jewellery Industry", "", "", "", "", ""],
    ["con_b", "Someone Else", "+919820022222", "", "", "", "Jewellery Industry", "", "", "", "", ""]
  ];
  const adminActor = { id: "admin:ops@example.com", organisationId: "org_a" };
  const plan = planBulkContactUpdate(db, adminActor, bulkWorkbookFrom(grid), bulkChoices);

  assert.equal(plan.updates.length, 1, "only the client being worked on");
  assert.equal(plan.updates[0].contactId, "con_a");
  assert.ok(plan.notFound.some((p) => p.key === "con_b"), "the other client's row is not found, not applied");

  assert.equal(applyBulkContactUpdate(db, adminActor, plan), 1);
  assert.equal(contacts[0].industry, "Jewellery Industry");
  assert.equal(contacts[1].industry, "", "the other client's contact is untouched");
  // The admin is recorded as the one who changed it.
  assert.equal(contacts[0].updatedBy, "admin:ops@example.com");
});

test("accounts are owed every issued invoice they have not had", () => {
  // Tracked apart from the customer's copy: an invoice sent to the customer
  // months ago must still reach the books the first time this runs, and one
  // already filed must never be sent twice.
  const rows = [
    { id: "1", client_id: "org_a", provider_payment_id: "pay_a", amount_paise: 89900, plan: "quarterly", status: "paid", completed_at: "2026-09-29T06:00:00.000Z", created_at: "2026-09-29T06:00:00.000Z" },
    { id: "2", client_id: "org_a", provider_payment_id: "pay_b", amount_paise: 399900, plan: "annual", status: "paid", completed_at: "2026-11-19T06:00:00.000Z", created_at: "2026-11-19T06:00:00.000Z" },
    { id: "3", client_id: "org_gone", provider_payment_id: "pay_c", amount_paise: 49900, plan: "topup", status: "paid", completed_at: "2026-11-20T06:00:00.000Z", created_at: "2026-11-20T06:00:00.000Z" }
  ];
  const db = {
    organisations: [{
      id: "org_a",
      name: "Dishaa Gold and Platinum",
      invoices: {
        // Sent to the customer long ago, never to accounts.
        pay_a: { number: "75/26-27", fy: "2026-27", seq: 75, notifiedAt: "2026-09-29T07:00:00.000Z", paymentKey: "pay_a" },
        // Already with accounts.
        pay_b: { number: "76/26-27", fy: "2026-27", seq: 76, notifiedAt: "2026-11-19T07:00:00.000Z", accountsNotifiedAt: "2026-11-19T07:00:05.000Z", paymentKey: "pay_b" }
      }
    }]
  };

  const pending = pendingAccountsCopies(db, rows);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].record.number, "75/26-27");
  // A payment whose workspace has gone is skipped rather than throwing.
  assert.ok(!pending.some((x) => x.payment.provider_payment_id === "pay_c"));
});
