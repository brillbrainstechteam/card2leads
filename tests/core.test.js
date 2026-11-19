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

test("customer exports use the minimal sales-ready contact format", () => {
  assert.deepEqual(EXPORT_COLUMNS, [
    "Saved Contact Name", "Name", "Name (Original Script)", "Mobile Number", "Country Code",
    "Phone Country", "WhatsApp Number", "Secondary Mobile Number", "Company Name",
    "Company Name (Original Script)", "Designation", "Office Number", "Email Address",
    "Secondary Email", "Website", "Address", "Address (Original Script)", "City", "State",
    "State Code", "Postal Code", "Country", "Card Language", "Exhibition Name",
    "Exhibition Date", "Remarks", "Voice Note", "Tags", "Created Timestamp"
  ]);
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
  assert.match(csv.toString("utf8"), /Saved Contact Name,Name,Name \(Original Script\),Mobile Number/);
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
  bulkUpdateHeaders,
  buildBulkUpdateWorkbook,
  readWorkbookRows,
  planBulkContactUpdate,
  applyBulkContactUpdate
} = require("../server.js");

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

test("the bulk update sheet round-trips through a spreadsheet unchanged", () => {
  const rows = readWorkbookRows(buildBulkUpdateWorkbook(bulkContacts(), bulkChoices));
  assert.deepEqual(rows[0], bulkUpdateHeaders());
  assert.equal(rows[1][0], "con_1");
  assert.equal(rows[2][rows[0].indexOf("Business Type")], "Karigar");
  assert.equal(rows[2][rows[0].indexOf("Customer Rating")], "3");
});

test("a filled-in sheet updates only the classification columns", () => {
  const contacts = bulkContacts();
  const grid = readWorkbookRows(buildBulkUpdateWorkbook(contacts, bulkChoices));
  const header = grid[0];
  const at = (name) => header.indexOf(name);

  grid[1][at("Industry")] = "Jewellery Industry";
  grid[1][at("Business Type")] = "Jewellery Retailer; Karigar";
  grid[1][at("Customer Rating")] = "5";
  // A value the dropdown never offered has to be kept: every one of these
  // fields allows "Other" in the app itself.
  grid[2][at("Industry")] = "Textiles & Apparel";
  // Editing a context column must have no effect at all.
  grid[2][at("Name")] = "SHOULD NOT BE SAVED";
  grid[2][at("Mobile Number")] = "+910000000000";

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
});

test("a bulk update sheet reports rows it cannot safely apply", () => {
  const contacts = bulkContacts();
  const grid = readWorkbookRows(buildBulkUpdateWorkbook(contacts, bulkChoices));
  const header = grid[0];
  const at = (name) => header.indexOf(name);

  // A rating that is not a rating must be called out, not quietly dropped.
  grid[1][at("Customer Rating")] = "ten";
  const ghost = new Array(header.length).fill("");
  ghost[0] = "con_missing";
  grid.push(ghost);
  // A second row for a contact already in the sheet: applying both would make
  // the outcome depend on row order.
  const repeat = new Array(header.length).fill("");
  repeat[0] = "con_2";
  repeat[at("Industry")] = "Other Industry";
  grid.push(repeat);

  const db = { contacts };
  const user = { id: "usr", organisationId: "org" };
  const plan = planBulkContactUpdate(db, user, bulkWorkbookFrom(grid), bulkChoices);
  assert.ok(plan.problems.some((p) => /rating/.test(p.reason)));
  assert.ok(plan.problems.some((p) => /already on row/.test(p.reason)));
  assert.ok(plan.notFound.some((p) => p.key === "con_missing"));
  assert.equal(contacts[0].customerRating, "");

  // A sheet with no key column cannot be matched at all, and says so.
  assert.throws(
    () => planBulkContactUpdate(db, user, bulkWorkbookFrom(grid.map((r) => r.slice(1))), bulkChoices),
    /Contact ID/
  );
  // And something that is not a spreadsheet gets a sentence, not a stack trace.
  assert.throws(
    () => planBulkContactUpdate(db, user, Buffer.from("not a spreadsheet"), bulkChoices),
    /spreadsheet/i
  );
});
