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
  contactToGooglePerson,
  grantOneTimePlan,
  grantTopupEntitlement,
  googleContactDisplayName,
  googleScopes,
  normalizeExtraction,
  normalizePhoneFields,
  parseDataUrl,
  planUsage,
  remainingTopupScans,
  repairCollectionExhibitionAssignments,
  saveContactRecord,
  validateTenantIntegrity,
  validateContact,
  validatePasswordStrength
} = require("../server");

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
  assert.match(vcf, /FN:Riya Shah/);
  assert.match(vcf, /TEL;TYPE=CELL:\+91 98765 43210/);
  assert.match(vcf, /ORG:ABC Jewels/);
  assert.match(vcf, /NOTE:September mein follow up karna hai/);
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
  assert.equal(person.names[0].unstructuredName, "Riya Shah [IIJS 2026]");
  assert.equal(person.phoneNumbers.length, 2);
  assert.equal(person.organizations[0].name, "ABC Jewels");
  assert.ok(person.biographies[0].value.includes("September"));
  assert.deepEqual(person.userDefined, [
    { key: "Exhibition", value: "IIJS 2026" },
    { key: "Exhibition Date", value: "2026-07-18" },
    { key: "Card2Leads Label", value: "IIJS 2026 - 18 Jul 2026" },
    { key: "Card2Leads Contact ID", value: "" }
  ]);
});

test("Google Contacts names include a searchable exhibition and year suffix", () => {
  assert.equal(
    googleContactDisplayName({
      name: "Naveen Kumar",
      exhibitionName: "GJEPC",
      exhibitionDate: "2026-06-10"
    }),
    "Naveen Kumar [GJEPC 2026]"
  );
  assert.equal(
    googleContactDisplayName({
      name: "Riya Shah",
      exhibitionName: "IIJS 2026",
      exhibitionDate: "2026-07-18"
    }),
    "Riya Shah [IIJS 2026]"
  );
});

test("customer exports use the minimal sales-ready contact format", () => {
  assert.deepEqual(EXPORT_COLUMNS, [
    "Name", "Mobile Number", "Secondary Mobile Number", "Company Name", "Designation",
    "Office Number", "Email Address", "Secondary Email", "Website", "Address", "City",
    "State", "Postal Code", "Country", "Exhibition Name", "Exhibition Date", "Remarks",
    "Tags", "Created Timestamp"
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
  assert.match(csv.toString("utf8"), /Name,Mobile Number/);
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

test("plan usage reports remaining scans", () => {
  assert.deepEqual(planUsage({ plan: "event", scansUsed: 125 }), {
    plan: "event",
    limit: 300,
    used: 125,
    remaining: 175
  });
});

test("current subscription plans use their configured scan limits", () => {
  assert.equal(planUsage({ plan: "monthly", scansUsed: 25 }).remaining, 125);
  assert.equal(planUsage({ plan: "quarterly", scansUsed: 100 }).remaining, 200);
  assert.equal(planUsage({ plan: "annual", scansUsed: 1000 }).remaining, 500);
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

test("trial accounts receive a 20-scan demo allowance", () => {
  assert.deepEqual(planUsage({ plan: "trial", scansUsed: 0 }), {
    plan: "trial",
    limit: 20,
    used: 0,
    remaining: 20
  });
});

test("password rules require length and character classes", () => {
  assert.ok(validatePasswordStrength("weakpassword"));
  assert.equal(validatePasswordStrength("StrongPass#10"), "");
});

test("contact validation requires name and a valid mobile number", () => {
  assert.equal(validateContact({ name: "Riya Shah", mobileNumber: "+91 98765 43210" }).ok, true);
  assert.equal(validateContact({ name: "", mobileNumber: "+91 98765 43210" }).code, "missing_name");
  assert.equal(validateContact({ name: "Riya Shah", mobileNumber: "123" }).code, "invalid_mobile");
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
});
