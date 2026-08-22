const state = {
  user: null,
  organisation: null,
  csrfToken: "",
  overview: null,
  cards: [],
  contacts: [],
  teamMembers: [],
  contactFilters: { exhibition: "", assignee: "", city: "", state: "" },
  contactSearchQuery: "",
  // "compact" shows the everyday columns; "extended" adds every extracted field.
  contactsTableView: localStorage.getItem("card2leads.contactsTableView") === "extended" ? "extended" : "compact",
  selectedFiles: [],
  processingCards: new Set(),
  selectedContactIds: new Set(),
  googleContactsSyncing: false,
  googleContactsSyncStatus: null,
  uploadMode: "existing",
  uploadTab: "scan",
  selectedCollectionId: "",
  backSideTargetIndex: -1,
  showUploadSettings: false,
  showUploadOptions: false,
  draftCollectionName: "",
  draftExhibitionName: "",
  draftExhibitionDate: "",
  draftDestinationType: "excel",
  modal: null,
  authOpen: false,
  authMode: "login",
  phoneStep: "",
  phoneNumber: "",
  authError: "",
  authInfo: "",
  authActionLink: "",
  authActionText: "",
  pendingVerificationEmail: "",
  nativeIntroStep: 3,
  resetToken: "",
  onboardingError: "",
  view: "upload",
  contactsTab: "contacts",
  message: ""
};

let messageTimer = null;
let nativeSplashTimer = null;
const authenticatedViews = new Set(["upload", "review", "contacts", "account"]);
const nativeIntroStorageKey = "smartscan.mobileIntroSeen";

function isNativeApp() {
  return Boolean(window.EasySaveNative?.isNative);
}

function routeFromLocation() {
  const route = decodeURIComponent(window.location.hash.replace(/^#/, "")).toLowerCase();
  const [requestedView, requestedTab] = route.split("/");
  if (!authenticatedViews.has(requestedView)) {
    return { view: "upload", contactsTab: "contacts" };
  }
  return {
    view: requestedView,
    contactsTab: requestedView === "contacts" && requestedTab === "sheets" ? "sheets" : "contacts"
  };
}

function routeForView(view = state.view, contactsTab = state.contactsTab) {
  return view === "contacts" && contactsTab === "sheets" ? "#contacts/sheets" : `#${view}`;
}

function applyRouteFromLocation(shouldRender = true) {
  if (!state.user) return;
  const route = routeFromLocation();
  state.view = route.view;
  state.contactsTab = route.contactsTab;
  if (shouldRender) render();
}

function navigateToView(view, options = {}) {
  const nextView = authenticatedViews.has(view) ? view : "upload";
  state.view = nextView;
  if (nextView === "contacts" && options.contactsTab) {
    state.contactsTab = options.contactsTab === "sheets" ? "sheets" : "contacts";
  }
  const nextRoute = routeForView();
  if (window.location.hash !== nextRoute) {
    const method = options.replace ? "replaceState" : "pushState";
    window.history[method]({}, "", `${window.location.pathname}${window.location.search}${nextRoute}`);
  }
  if (options.render !== false) render();
}

const fieldLabels = {
  name: "Name",
  nameNative: "Name (Original Script)",
  mobileNumber: "Mobile Number",
  whatsappNumber: "WhatsApp Number (optional)",
  secondaryName: "Secondary Name (optional)",
  secondaryMobileNumber: "Secondary Mobile Number (optional)",
  tertiaryName: "Tertiary Name (optional)",
  tertiaryMobileNumber: "Tertiary Mobile Number (optional)",
  companyName: "Company Name",
  companyNameNative: "Company Name (Original Script)",
  designation: "Designation",
  officeNumber: "Office Number",
  emailAddress: "Email Address",
  secondaryEmail: "Secondary Email",
  website: "Website",
  address: "Address",
  city: "City",
  state: "State",
  postalCode: "Postal Code",
  country: "Country",
  exhibitionName: "Exhibition Name",
  exhibitionDate: "Exhibition Date",
  notes: "Remarks",
  tags: "Tags"
};

const contactFields = Object.keys(fieldLabels);

// Inline icons for the public "how it works" flow. Kept as crisp SVG (not a
// bitmap illustration) so the step text stays sharp and correctly spelled.
const WORKFLOW_ICONS = {
  capture: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1-1.6h6L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z"/><circle cx="12" cy="12.5" r="3.2"/></svg>`,
  extract: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9h8M8 12.5h8M8 16h5"/></svg>`,
  review: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l4 4 12-11"/></svg>`,
  assign: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M4 19c0-2.8 2.2-5 5-5s5 2.2 5 5"/><path d="M16 8h5M18.5 5.5v5"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/></svg>`,
  export: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8.5 7.5 12 4l3.5 3.5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>`,
  google: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/></svg>`
};

// Icons for the public landing page's feature cards.
const FEATURE_ICONS = {
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1-1.6h6L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z"/><circle cx="12" cy="12.5" r="3.2"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.5c.5 3.6 1.2 5.9 2.2 6.9s3.3 1.7 6.9 2.2c-3.6.5-5.9 1.2-6.9 2.2s-1.7 3.3-2.2 6.9c-.5-3.6-1.2-5.9-2.2-6.9S6.5 12.1 2.9 11.6c3.6-.5 5.9-1.2 6.9-2.2s1.7-3.3 2.2-6.9Z"/></svg>`,
  review: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3.5" width="12" height="17" rx="2"/><path d="M9.5 3.5V3a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 3v.5"/><path d="M9 12l2 2 4-4.5"/></svg>`,
  mic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21M9 21h6"/></svg>`,
  export: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17.5a4 4 0 0 1-.5-7.97 5 5 0 0 1 9.79-1.4A4.5 4.5 0 0 1 17.5 17.5H7Z"/><path d="M12 11v6.5M9.5 14l2.5-2.5 2.5 2.5"/></svg>`
};

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = options.body instanceof FormData ? {} : { "Content-Type": "application/json" };
  if (state.csrfToken && method !== "GET") headers["X-CSRF-Token"] = state.csrfToken;
  const res = await fetch(path, {
    headers,
    credentials: "same-origin",
    ...options,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body
  });
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("json") ? await res.json() : await res.blob();
  if (!res.ok) {
    const err = new Error(data.error || "Request failed.");
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function el(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function setMessage(message, bad = false) {
  if (messageTimer) clearTimeout(messageTimer);
  state.message = message ? { text: message, bad } : "";
  render();
}

function clearMessage(shouldRender = true) {
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = null;
  state.message = "";
  if (shouldRender) render();
}

async function init() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("resetToken")) {
    state.resetToken = url.searchParams.get("resetToken");
    state.authMode = "reset";
    state.authOpen = true;
  }
  const authNotice = url.searchParams.get("auth");
  if (authNotice === "verify_failed" || authNotice === "google_failed") state.authOpen = true;
  if (authNotice === "verified") state.authInfo = "Email verified. You are signed in. Complete the workspace setup to start scanning cards.";
  if (authNotice === "verify_failed") state.authError = "This verification link is invalid or expired. Please create an account again or request support.";
  if (authNotice === "google_failed") state.authError = "Google sign-in could not be completed. Check the Google OAuth redirect URI and try again.";
  if (authNotice === "google_existing") state.authInfo = "Welcome back. Google matched an existing Card2Leads account with this verified email, so its existing workspace was reopened.";
  const me = await api("/api/me");
  state.user = me.user;
  state.organisation = me.organisation;
  state.csrfToken = me.csrfToken || "";
  if (!state.user && isNativeApp()) {
    state.nativeIntroStep = localStorage.getItem(nativeIntroStorageKey) === "1" ? 3 : 0;
  }
  if (state.user) {
    applyRouteFromLocation(false);
    await refreshAll();
    if (url.searchParams.get("google") === "connected") {
      state.message = { text: "Google Sheets connected.", bad: false };
    }
  }
  if (url.search) window.history.replaceState({}, "", `${window.location.pathname}${window.location.hash}`);
  if (state.user && !authenticatedViews.has(window.location.hash.replace(/^#/, "").split("/")[0])) {
    window.history.replaceState({}, "", `${window.location.pathname}${routeForView()}`);
  }
  render();
}

window.addEventListener("popstate", () => applyRouteFromLocation());
window.addEventListener("hashchange", () => applyRouteFromLocation());

let contactSearchDebounce = null;

async function runContactSearch(query, { refocus = false } = {}) {
  state.contactSearchQuery = query;
  const result = await api(`/api/contacts?q=${encodeURIComponent(query)}`);
  state.contacts = result.contacts;
  const availableIds = new Set(state.contacts.map((contact) => contact.id));
  state.selectedContactIds = new Set([...state.selectedContactIds].filter((id) => availableIds.has(id)));
  render();
  if (refocus) {
    const input = document.getElementById("searchBox");
    if (input) {
      input.focus();
      const pos = input.value.length;
      input.setSelectionRange(pos, pos);
    }
  }
}

async function refreshAll() {
  state.overview = await api("/api/overview");
  state.organisation = state.overview.organisation || state.organisation;
  const [cards, contacts, team] = await Promise.all([
    api("/api/cards"),
    api(`/api/contacts?q=${encodeURIComponent(state.contactSearchQuery || "")}`),
    api("/api/team")
  ]);
  state.cards = cards.cards;
  state.contacts = contacts.contacts;
  state.teamMembers = team.members || [];
  // Start with nothing selected — bulk actions are opt-in, safer than pre-selecting all.
  const availableIds = new Set(state.contacts.map((contact) => contact.id));
  state.selectedContactIds = new Set([...state.selectedContactIds].filter((id) => availableIds.has(id)));
}

function render() {
  const app = document.getElementById("app");
  document.body.classList.toggle("app-public", !state.user);
  document.body.classList.toggle("app-onboarding", Boolean(state.user && state.overview?.needsOnboarding));
  document.body.classList.toggle("app-authenticated", Boolean(state.user && !state.overview?.needsOnboarding));
  if (!state.user) {
    app.innerHTML = "";
    app.appendChild(authView());
    return;
  }
  if (state.overview?.needsOnboarding) {
    app.innerHTML = "";
    app.appendChild(onboardingView());
    if (state.modal) app.appendChild(modalView());
    return;
  }
  app.innerHTML = shell();
  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.EasySaveNative?.haptic("light");
      clearMessage(false);
      navigateToView(btn.dataset.view);
    });
  });
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("topbarUpgradeBtn")?.addEventListener("click", () => navigateToView("account"));
  const slot = document.getElementById("viewSlot");
  slot.appendChild(messageView());
  if (state.view === "upload") slot.appendChild(uploadView());
  if (state.view === "review") slot.appendChild(reviewView());
  if (state.view === "contacts") slot.appendChild(contactsWorkspaceView());
  if (state.view === "account") {
    slot.appendChild(accountBillingView());
    // Funnel beacon: an authenticated user looking at plans/billing (best-effort).
    if (state.csrfToken) api("/api/events", { method: "POST", body: { name: "pricing_viewed" } }).catch(() => {});
  }
  if (state.modal) app.appendChild(modalView());
  ensureQueuePolling();
}

// Cards uploaded now sit as "queued" until the server's background processor
// scans them a few at a time (see server.js processQueueCycle). Poll gently
// while any are still queued so Review updates on its own instead of the
// user having to refresh, and stop as soon as none are left.
let queuePollTimer = null;
function ensureQueuePolling() {
  const hasQueued = state.cards.some((card) => card.status === "queued");
  if (!hasQueued) {
    if (queuePollTimer) {
      clearTimeout(queuePollTimer);
      queuePollTimer = null;
    }
    return;
  }
  if (queuePollTimer) return;
  let lastQueuedCount = state.cards.filter((card) => card.status === "queued").length;
  const contactsBeforeBatch = state.contacts.length;
  // A single card is extracted server-side in well under a second, so a fixed
  // 4s poll made a one-card scan at the stall feel slow. Poll quickly for small
  // batches (the stall case) and back off for bulk uploads.
  const pollDelay = () => (state.cards.filter((card) => card.status === "queued").length <= 3 ? 900 : 4000);
  const tick = async () => {
    if (!state.user || !state.cards.some((card) => card.status === "queued")) {
      clearTimeout(queuePollTimer);
      queuePollTimer = null;
      return;
    }
    try {
      const result = await api("/api/cards");
      const queuedNow = result.cards.filter((card) => card.status === "queued").length;
      // A card leaving the queue means it was auto-saved into Contacts (or moved
      // to review). Pull the full state so the Contacts list and the nav counts
      // update on their own — otherwise the user has to refresh to see them.
      if (queuedNow !== lastQueuedCount) {
        await refreshAll();
      } else {
        state.cards = result.cards;
      }
      lastQueuedCount = state.cards.filter((card) => card.status === "queued").length;
      if (queuedNow === 0) {
        clearTimeout(queuePollTimer);
        queuePollTimer = null;
        const added = Math.max(0, state.contacts.length - contactsBeforeBatch);
        const needsReview = state.cards.filter((card) => card.status === "completed" || card.status === "requires_review").length;
        if (!state.modal) {
          state.modal = {
            title: added ? `${added} contact${added === 1 ? "" : "s"} added` : "All cards processed",
            tone: "info",
            body: needsReview
              ? `${needsReview} card${needsReview === 1 ? "" : "s"} still need a quick check in Review.`
              : "Every card was read and saved to Contacts.",
            cancelText: "Stay here",
            confirmText: needsReview ? "Go to Review" : "View contacts",
            confirmClass: "primary",
            onConfirm: () => navigateToView(needsReview ? "review" : "contacts")
          };
        }
        render();
        return;
      }
      const activeTag = document.activeElement?.tagName;
      const isTyping = activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT";
      const isRecording = document.querySelector(".voice-recorder.recording") || document.querySelector(".voice-recorder.recorded");
      const hasModal = !!state.modal;
      // Refresh whichever tab the user is on (Review or Contacts), so processed
      // cards surface without a manual reload — but never yank the page out from
      // under an open form, a recording, or a modal.
      if (!isTyping && !isRecording && !hasModal) render();
    } catch {
      // Transient network hiccup — the next tick will just try again.
    }
    if (queuePollTimer) queuePollTimer = setTimeout(tick, pollDelay());
  };
  queuePollTimer = setTimeout(tick, pollDelay());
}

function authView() {
  if (isNativeApp() && state.nativeIntroStep < 3) return nativeIntroView();
  if (state.authOpen) return authScreen();
  const isSignup = state.authMode === "signup";
  const isForgot = state.authMode === "forgot";
  const isReset = state.authMode === "reset";
  const title = isReset ? "Set a new password" : isForgot ? "Reset your password" : isSignup ? "Create account" : "Log in";
  const node = el(`
    <main class="auth-wrap public-page">
      <nav class="public-nav">
        <a class="public-brand" href="#top" aria-label="Card2Leads home">
          <strong>Card2Leads</strong>
        </a>
        <div class="public-links" aria-label="Product sections">
          <a href="#features">Features</a>
          <a href="#exports">How It Works</a>
          <a href="#pricing">Pricing</a>
        </div>
        <div class="public-actions">
          <button type="button" class="secondary" data-auth-mode="login">Log in</button>
          <button type="button" data-auth-mode="signup">Sign up</button>
        </div>
      </nav>

      <section class="public-hero" id="top">
        <div class="hero-copy">
          <h1 class="hero-brand">Card2Leads</h1>
          <p class="hero-headline">Turn business cards into organised, <em>ready-to-use contacts.</em></p>
          <p class="hero-text">Card2Leads is a business-card scanning and contact-management application that converts individual or bulk card uploads into structured contact records. Review extracted details, add labels and voice notes, then export or sync approved contacts to Google Contacts and Google Sheets. Card2Leads is operated by BrillBrains Consultants Pvt. Ltd.</p>
          <div class="hero-actions">
            <button type="button" data-auth-mode="signup">Get Started</button>
          </div>
        </div>
        <div class="hero-visual" aria-label="Card scanning preview">
          <img class="hero-illustration" src="/illustrations-final/hero_illustration.png?v=final-20260808" alt="Scanning a business card, extracting its details and syncing organised contacts" />
        </div>
      </section>

      <section class="public-section about-section" id="about">
        <p class="section-kicker">What is Card2Leads?</p>
        <h2>A simple way to turn business cards into organised contacts.</h2>
        <p class="about-lead">Card2Leads is a business-card digitisation and contact-management application that helps businesses and professionals convert physical or digital business cards into organised digital contact records.</p>
        <p>Users can scan or upload business cards, extract contact information such as names, mobile numbers, email addresses, companies and designations, review and correct extracted information, add labels and notes, and export their contact records.</p>
        <p>Users may also optionally connect their Google account to save selected contacts to Google Contacts or create and update contact records in Google Sheets. Card2Leads is operated by BrillBrains Consultants Pvt. Ltd.</p>
      </section>

      <section class="public-section features-section" id="features">
        <div class="features-copy">
          <p class="section-kicker">Features</p>
          <h2>Capture, organise and use every business contact in <em>one simple flow.</em></h2>
        </div>
        <div class="features-mid-illustration">
          <img src="/illustrations-final/second-section-middle.png?v=final-20260808" alt="AI reading a scanned business card and syncing the contact" />
        </div>
        <div class="feature-strip" aria-label="Card2Leads highlights">
          <article>
            <span class="feature-icon">${FEATURE_ICONS.camera}</span>
            <strong>Capture cards</strong>
            <p>Scan with your camera or upload single or bulk card images.</p>
          </article>
          <article>
            <span class="feature-icon">${FEATURE_ICONS.sparkle}</span>
            <strong>AI extract</strong>
            <p>AI reads and organises names, phones, emails and companies.</p>
          </article>
          <article>
            <span class="feature-icon">${WORKFLOW_ICONS.search}</span>
            <strong>Search &amp; filter</strong>
            <p>Find any contact by name, company, city or event.</p>
          </article>
          <article>
            <span class="feature-icon">${FEATURE_ICONS.review}</span>
            <strong>Review &amp; clean</strong>
            <p>Verify details, fix errors and remove duplicates before saving.</p>
          </article>
          <article>
            <span class="feature-icon">${WORKFLOW_ICONS.assign}</span>
            <strong>Assign &amp; route</strong>
            <p>Assign owners and route contacts to your team.</p>
          </article>
          <article>
            <span class="feature-icon">${FEATURE_ICONS.export}</span>
            <strong>Export &amp; sync</strong>
            <p>Export as Excel, CSV, VCF or sync with Google Contacts.</p>
          </article>
        </div>
        <div class="workflow-flow" aria-label="How Card2Leads works, step by step">
          <ol class="workflow-timeline">
            <li class="wf-item">
              <div class="wf-node" aria-hidden="true">${WORKFLOW_ICONS.capture}</div>
              <div class="wf-body"><span class="wf-step">Step 01</span><strong>Capture cards</strong></div>
            </li>
            <li class="wf-item">
              <div class="wf-node" aria-hidden="true">${WORKFLOW_ICONS.extract}</div>
              <div class="wf-body"><span class="wf-step">Step 02</span><strong>Extract details</strong></div>
            </li>
            <li class="wf-item">
              <div class="wf-node" aria-hidden="true">${WORKFLOW_ICONS.review}</div>
              <div class="wf-body"><span class="wf-step">Step 03</span><strong>Review &amp; clean</strong></div>
            </li>
            <li class="wf-item">
              <div class="wf-node" aria-hidden="true">${WORKFLOW_ICONS.assign}</div>
              <div class="wf-body"><span class="wf-step">Step 04</span><strong>Assign owner</strong></div>
            </li>
            <li class="wf-item">
              <div class="wf-node" aria-hidden="true">${WORKFLOW_ICONS.search}</div>
              <div class="wf-body"><span class="wf-step">Step 05</span><strong>Search &amp; filter</strong></div>
            </li>
            <li class="wf-item">
              <div class="wf-node" aria-hidden="true">${WORKFLOW_ICONS.export}</div>
              <div class="wf-body"><span class="wf-step">Step 06</span><strong>Export records</strong></div>
            </li>
            <li class="wf-item wf-item-final">
              <div class="wf-node" aria-hidden="true">${WORKFLOW_ICONS.google}</div>
              <div class="wf-body"><span class="wf-step">Step 07</span><strong>Sync with Google</strong></div>
            </li>
          </ol>
        </div>
      </section>

      <section class="public-section public-feature-grid" id="exports">
        <article class="public-panel">
          <img class="panel-illustration" src="/illustrations-final/third-section-exports.png?v=final-20260808" alt="Reviewed contacts in a table, ready to export as Excel, CSV or Google Sheets" />
          <div>
            <p class="section-kicker">Structured exports</p>
            <h2>Clean contact data, ready to use.</h2>
            <p>Turn reviewed contacts into a clean, structured table. Download the records as Excel or CSV, or add approved rows to a Google Sheet selected or created through Card2Leads.</p>
          </div>
        </article>
        <article class="public-panel">
          <img class="panel-illustration" src="/illustrations-final/third-section-voice.png?v=final-20260808" alt="A voice note converted to text and linked to the matching contact" />
          <div>
            <p class="section-kicker">Voice-based context</p>
            <h2>Capture the details that cards cannot.</h2>
            <p>Add spoken notes, interests and follow-up instructions in Hindi, English or Hinglish. Card2Leads converts the input into text and links it to the relevant contact.</p>
          </div>
        </article>
      </section>

      <section class="public-section google-section" id="google-integration">
        <div class="google-section-head">
          <p class="section-kicker">Optional Google integration</p>
          <h2>Connect Google only when you want to.</h2>
          <p class="google-section-lead">Connecting your Google account is optional. Card2Leads requests Google permissions only when you choose to use a feature that requires them, and only after you approve them through Google's own authorisation screen.</p>
        </div>
        <div class="google-integration-grid">
          <article>
            <strong>Google Sign-In</strong>
            <p>If you choose to sign in with Google, Card2Leads uses basic account information authorised by you to authenticate your account.</p>
          </article>
          <article>
            <strong>Google Contacts</strong>
            <p>If you choose to connect Google Contacts, Card2Leads uses the permissions you grant to save or synchronise the business contacts you select with your Google Contacts account.</p>
          </article>
          <article>
            <strong>Google Sheets</strong>
            <p>If you choose to use the Google Sheets integration, Card2Leads uses authorised access to create or update spreadsheets containing the business-card or contact records you choose to sync.</p>
          </article>
        </div>
        <p class="google-section-note">Card2Leads does not require Google integration for business-card scanning features that do not depend on Google services. You can disconnect your Google account or revoke Card2Leads' Google permissions at any time. Card2Leads does not access Gmail, Google Calendar or unrelated Google Drive files.</p>
        <p class="google-section-link"><a href="/privacy-policy" target="_blank" rel="noopener">Learn how we use Google data → Privacy Policy</a></p>
      </section>

      <section class="public-section pricing-section" id="pricing">
        <div class="pricing-heading">
          <div>
            <p class="section-kicker">Pricing</p>
            <h2>Simple plans for every business-card workflow.</h2>
          </div>
        </div>
        <div class="pricing-tabs" role="tablist" aria-label="Pricing options">
          <button type="button" class="pricing-tab active" role="tab" aria-selected="true" data-pricing-tab="one-time">Pay once</button>
          <button type="button" class="pricing-tab" role="tab" aria-selected="false" data-pricing-tab="subscription">Subscribe</button>
        </div>
        <div class="pricing-panel active" data-pricing-panel="one-time">
          <div class="pricing-grid">
          <article class="price-card">
            <span class="price-label">Trial</span>
            <h3>Free</h3>
            <p>20 card scans to try extraction, review, labels, voice input and export features.</p>
            <button type="button" class="secondary" data-auth-mode="signup">Sign up</button>
          </article>
          <article class="price-card">
            <span class="price-label">1 month</span>
            <h3><span>&#8377;499</span> once</h3>
            <p>150 card scans valid for 1 month. Pay once with no recurring charge.</p>
            <span class="plan-cancel">No auto-renewal</span>
            <button type="button" class="secondary" data-auth-mode="signup" data-plan="monthly" data-billing-mode="one_time">Buy 1 month</button>
          </article>
          <article class="price-card featured">
            <span class="popular-badge">Most popular</span>
            <span class="price-label">3 months</span>
            <h3><span>&#8377;799</span> once</h3>
            <p>300 card scans valid for 3 months. Ideal for exhibitions, events and regular lead capture.</p>
            <span class="plan-cancel">No auto-renewal</span>
            <button type="button" data-auth-mode="signup" data-plan="quarterly" data-billing-mode="one_time">Buy 3 months</button>
          </article>
          <article class="price-card">
            <span class="price-label">1 year</span>
            <h3><span>&#8377;2,999</span> once</h3>
            <p>1,500 card scans valid for one year, at the lowest included cost per scan.</p>
            <span class="plan-cancel">No auto-renewal</span>
            <button type="button" class="secondary" data-auth-mode="signup" data-plan="annual" data-billing-mode="one_time">Buy 1 year</button>
          </article>
        </div>
        </div>
        <div class="pricing-panel" data-pricing-panel="subscription" hidden>
          <div class="pricing-subscription-block" aria-label="Recurring subscription plans">
          <div>
            <p class="section-kicker">Subscription option</p>
            <h3>Prefer automatic renewal?</h3>
            <p>Choose the same scan packages as recurring plans. These renew automatically and can be cancelled anytime.</p>
          </div>
          <div class="pricing-grid subscription-grid">
            <article class="price-card compact">
              <span class="price-label">Monthly</span>
              <h3><span>&#8377;499</span> / month</h3>
              <p>150 scans every month.</p>
              <span class="plan-cancel">Cancel anytime</span>
              <button type="button" class="secondary" data-auth-mode="signup" data-plan="monthly" data-billing-mode="subscription">Subscribe monthly</button>
            </article>
            <article class="price-card compact featured">
              <span class="popular-badge">Most popular</span>
              <span class="price-label">Quarterly</span>
              <h3><span>&#8377;799</span> / 3 months</h3>
              <p>300 scans every 3 months.</p>
              <span class="plan-cancel">Cancel anytime</span>
              <button type="button" class="secondary" data-auth-mode="signup" data-plan="quarterly" data-billing-mode="subscription">Subscribe quarterly</button>
            </article>
            <article class="price-card compact">
              <span class="price-label">Annual</span>
              <h3><span>&#8377;2,999</span> / year</h3>
              <p>1,500 scans every year.</p>
              <span class="plan-cancel">Cancel anytime</span>
              <button type="button" class="secondary" data-auth-mode="signup" data-plan="annual" data-billing-mode="subscription">Subscribe yearly</button>
            </article>
          </div>
        </div>
        </div>
        <aside class="pricing-note" aria-label="Additional scan credits">
          <span class="pricing-note-icon" aria-hidden="true">+</span>
          <div class="pricing-note-copy">
            <strong>Need more scans?</strong>
            <span>Add 100 extra card scans for <strong>&#8377;499</strong> with any active paid plan.</span>
          </div>
          <button type="button" class="secondary pricing-note-action" data-topup-entry>Add scan credits</button>
        </aside>
      </section>

      <section class="public-section faq-section" id="faq">
        <div class="faq-head">
          <p class="section-kicker">FAQ</p>
          <h2>Frequently asked questions</h2>
        </div>
        <div class="faq-grid">
          <details>
            <summary>Is my contact data private?</summary>
            <p>Yes. Your business-card images, extracted contact details, labels and voice inputs are processed only to provide the Card2Leads features you request. We do not sell your contact data or use it for third-party advertising. Temporary uploads are handled according to our published Privacy Policy and Data Retention Policy.</p>
          </details>
          <details>
            <summary>Which languages does voice input support?</summary>
            <p>Card2Leads currently supports voice input in Hindi, English and Hinglish. Transcription quality can vary depending on pronunciation, background noise and recording clarity, so users should review the generated text before saving.</p>
          </details>
          <details>
            <summary>Do I need internet to scan?</summary>
            <p>Yes. An internet connection is required to upload card images, extract contact details, process voice inputs and sync records. Camera capture may begin on your device, but processing takes place through the Card2Leads service.</p>
          </details>
          <details>
            <summary>How can I organise my contacts?</summary>
            <p>You can add labels such as exhibition name, event, source, product interest or follow-up status. Labels can be applied while reviewing a contact and are included in supported exports and synchronisation workflows.</p>
          </details>
          <details>
            <summary>What happens when I sync with Google Contacts?</summary>
            <p>Card2Leads syncs a contact only after you review the information and choose the Google Contacts option. Google will ask you to authorise access before the first sync. Card2Leads uses that access to create or update contacts requested by you and does not sell Google user data or use it for advertising.</p>
          </details>
          <details>
            <summary>Can Card2Leads access all my Google Sheets?</summary>
            <p>Card2Leads is designed to work only with spreadsheets created by the app or explicitly selected for use with it. Approved contact records are added only when you initiate the Google Sheets sync.</p>
          </details>
          <details>
            <summary>Are extracted contact details always accurate?</summary>
            <p>Card2Leads uses AI-assisted extraction, but results can vary depending on image clarity, card layout, language and print quality. Every contact should be reviewed before it is exported, downloaded or synced.</p>
          </details>
        </div>
      </section>

      <section class="public-cta">
        <div class="public-cta-copy">
          <h2>Ready to organise your business contacts?</h2>
          <p>Start with 20 free card scans. No payment details required.</p>
        </div>
        <div class="public-cta-actions">
          <button type="button" data-auth-mode="signup">Sign up</button>
          <button type="button" class="secondary" data-auth-mode="login">Log in</button>
        </div>
      </section>

      <footer class="public-footer">
        <div class="public-footer-brand">
          <strong>Card2Leads</strong>
          <span>Business-card digitisation and contact management for businesses and professionals.</span>
          <span>A product of BrillBrains Consultants Pvt. Ltd.</span>
        </div>
        <nav class="public-footer-links" aria-label="Product, legal and contact links">
          <a href="#features">Features</a>
          <a href="#exports">How It Works</a>
          <a href="/privacy-policy" target="_blank" rel="noopener">Privacy Policy</a>
          <a href="/terms" target="_blank" rel="noopener">Terms of Use</a>
          <a href="/retention.html" target="_blank" rel="noopener">Data Retention</a>
          <a href="/contact" target="_blank" rel="noopener">Contact Us</a>
          <a href="#top" data-auth-mode="login">Sign In</a>
        </nav>
        <p class="public-footer-note">&copy; ${new Date().getFullYear()} BrillBrains Consultants Pvt. Ltd. All rights reserved.</p>
      </footer>
    </main>
  `);
  initPublicPricingTabs(node);
  node.querySelectorAll("[data-auth-mode]").forEach((btn) => btn.addEventListener("click", () => openAuth(btn.dataset.authMode, btn.dataset.plan, btn.dataset.billingMode)));
  node.querySelector("[data-topup-entry]")?.addEventListener("click", openTopupFromPricing);
  return node;
}

function initPublicPricingTabs(node) {
  const tabs = Array.from(node.querySelectorAll("[data-pricing-tab]"));
  const panels = Array.from(node.querySelectorAll("[data-pricing-panel]"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const selected = tab.dataset.pricingTab;
      tabs.forEach((candidate) => {
        const active = candidate.dataset.pricingTab === selected;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach((panel) => {
        const active = panel.dataset.pricingPanel === selected;
        panel.classList.toggle("active", active);
        panel.hidden = !active;
      });
    });
  });
}

function authScreen() {
  const isSignup = state.authMode === "signup";
  const isForgot = state.authMode === "forgot";
  const isReset = state.authMode === "reset";
  const node = el(`
    <main class="auth-screen">
      <div class="auth-screen-card">
        <button type="button" class="auth-back" data-auth-close>&larr; Back to site</button>
        <button type="button" class="auth-close" data-auth-close aria-label="Close and return to the Card2Leads home page">&times;</button>
        <a class="auth-screen-brand" href="#top" data-auth-close><strong>Card2Leads</strong><span>A product of BrillBrains Consultants</span></a>
        ${authFormMarkup(isSignup, isForgot, isReset)}
      </div>
    </main>
  `);
  wireAuth(node);
  return node;
}

function authFormMarkup(isSignup, isForgot, isReset) {
  if (state.phoneStep === "phone" || state.phoneStep === "otp") return phoneAuthMarkup();
  const title = isReset ? "Set a new password" : isForgot ? "Reset your password" : isSignup ? "Create account" : "Log in";
  return `
    <form class="auth-form" id="authForm">
      <div class="auth-tabs" role="tablist" aria-label="Authentication mode">
        <button type="button" class="secondary ${state.authMode === "login" ? "active" : ""}" data-auth-mode="login">Log in</button>
        <button type="button" class="secondary ${isSignup ? "active" : ""}" data-auth-mode="signup">Create account</button>
      </div>
      <h1>${title}</h1>
      ${state.authInfo ? `<div class="notice compact">${escapeHtml(state.authInfo)}</div>` : ""}
      ${state.authError ? `<div class="notice bad compact">${escapeHtml(state.authError)}</div>` : ""}
      ${!isForgot && !isReset ? `<a class="google-login" href="/api/auth/google/start">Continue with Google</a><button type="button" class="whatsapp-login" data-phone-start><svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M17.5 14.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.49s1.07 2.89 1.22 3.09c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35zM12.05 21.5h-.01a9.4 9.4 0 0 1-4.79-1.31l-.34-.2-3.56.93.95-3.47-.22-.36a9.38 9.38 0 0 1-1.44-5c0-5.18 4.22-9.4 9.41-9.4 2.51 0 4.87.98 6.64 2.76a9.34 9.34 0 0 1 2.75 6.65c0 5.18-4.22 9.4-9.41 9.4zM20.4 3.6A11.34 11.34 0 0 0 12.04.14C5.8.14.72 5.22.72 11.46c0 2 .52 3.94 1.51 5.66L.63 23l6.02-1.58a11.31 11.31 0 0 0 5.4 1.38h.01c6.24 0 11.32-5.08 11.32-11.32 0-3.03-1.18-5.87-3.32-8.01z"/></svg> Continue with WhatsApp</button><div class="divider"><span>or use email</span></div>` : ""}
      ${isSignup ? `<label>Full name <input name="name" autocomplete="name" required /></label>` : ""}
      ${isReset ? `<input name="token" type="hidden" value="${escapeAttr(state.resetToken)}" />` : `<label>Email <input name="email" type="email" autocomplete="email" required /></label>`}
      ${isForgot ? "" : `<label>Password <input name="password" type="password" autocomplete="${isSignup || isReset ? "new-password" : "current-password"}" required />${isSignup || isReset ? `<span class="field-help">Use at least 10 characters with uppercase, lowercase, number, and symbol.</span>` : ""}</label>`}
      ${isSignup ? `<label class="checkbox-label"><input name="acceptTerms" type="checkbox" required /> <span>I accept the <a href="/terms" target="_blank">terms</a> and <a href="/privacy-policy" target="_blank">privacy policy</a></span></label>` : ""}
      <div class="actions">
        <button type="submit">${isReset ? "Update password" : isForgot ? "Send reset link" : isSignup ? "Create account" : "Log in"}</button>
      </div>
      ${state.authMode === "login" ? `<button type="button" class="link-button" data-auth-mode="forgot">Forgot password?</button>` : ""}
      ${state.authMode === "login" && state.pendingVerificationEmail ? `<button type="button" class="secondary resend-verification" data-resend-verification>Resend verification email</button>` : ""}
      ${isForgot || isReset ? `<button type="button" class="link-button" data-auth-mode="login">Back to login</button>` : ""}
      ${state.authActionLink ? `<a class="notice-action" href="${escapeAttr(state.authActionLink)}">${escapeHtml(state.authActionText || "Open link")}</a>` : ""}
    </form>
  `;
}

function phoneAuthMarkup() {
  const otp = state.phoneStep === "otp";
  return `
    <h1>${otp ? "Enter your code" : "Sign in with WhatsApp"}</h1>
    ${state.authInfo ? `<div class="notice compact">${escapeHtml(state.authInfo)}</div>` : ""}
    ${state.authError ? `<div class="notice bad compact">${escapeHtml(state.authError)}</div>` : ""}
    <form class="auth-form" id="phoneForm">
      ${otp ? `
        <p class="field-help">We sent a 6-digit code to <strong>${escapeHtml(state.phoneNumber || "your number")}</strong> on WhatsApp. It expires in 5 minutes.</p>
        <label>Verification code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="6-digit code" required /></label>
        <div class="actions"><button type="submit">Verify &amp; continue</button></div>
        <button type="button" class="link-button" data-phone-resend>Resend code</button>
        <button type="button" class="link-button" data-phone-back>Use a different number</button>
      ` : `
        <p class="field-help">We'll send a one-time code to your number on WhatsApp.</p>
        <label>Mobile number <input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="e.g. 98765 43210" required /></label>
        <div class="actions"><button type="submit">Send code on WhatsApp</button></div>
        <button type="button" class="link-button" data-phone-back>Back to email login</button>
      `}
    </form>`;
}

async function requestPhoneOtp(phone) {
  const number = String(phone || "").trim();
  if (!number) { state.authError = "Enter your mobile number."; render(); return; }
  try {
    await api("/api/auth/otp/request", { method: "POST", body: { phone: number } });
    state.phoneNumber = number;
    state.phoneStep = "otp";
    state.authError = "";
    state.authInfo = "Code sent on WhatsApp.";
    render();
  } catch (err) {
    state.authError = err.message;
    render();
  }
}

async function verifyPhoneOtp(phone, code) {
  const trimmed = String(code || "").trim();
  if (!trimmed) { state.authError = "Enter the code from WhatsApp."; render(); return; }
  try {
    const result = await api("/api/auth/otp/verify", { method: "POST", body: { phone, code: trimmed } });
    state.user = result.user;
    state.csrfToken = result.csrfToken || "";
    state.phoneStep = "";
    state.phoneNumber = "";
    state.authOpen = false;
    state.authError = "";
    state.authInfo = "";
    await refreshAll();
    navigateToView("upload", { replace: true });
    resumePendingPlanCheckout();
  } catch (err) {
    state.authError = err.message;
    render();
  }
}

function wireAuth(node) {
  node.querySelectorAll("[data-auth-mode]").forEach((btn) => btn.addEventListener("click", () => openAuth(btn.dataset.authMode, btn.dataset.plan, btn.dataset.billingMode)));
  node.querySelectorAll("[data-auth-close]").forEach((btn) => btn.addEventListener("click", (event) => {
    event.preventDefault();
    closeAuth();
  }));
  node.querySelector("[data-resend-verification]")?.addEventListener("click", resendVerificationEmail);
  const form = node.querySelector("#authForm");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.authMode === "forgot") return forgotPassword(form);
    if (state.authMode === "reset") return resetPassword(form);
    await authenticate(state.authMode === "signup" ? "register" : "login", form);
  });
  // Phone / WhatsApp OTP login
  node.querySelector("[data-phone-start]")?.addEventListener("click", () => {
    state.phoneStep = "phone"; state.authError = ""; state.authInfo = ""; render();
  });
  node.querySelector("[data-phone-back]")?.addEventListener("click", () => {
    state.phoneStep = state.phoneStep === "otp" ? "phone" : ""; state.authError = ""; state.authInfo = ""; render();
  });
  node.querySelector("[data-phone-resend]")?.addEventListener("click", () => requestPhoneOtp(state.phoneNumber));
  const phoneForm = node.querySelector("#phoneForm");
  phoneForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.phoneStep === "otp") {
      await verifyPhoneOtp(state.phoneNumber, phoneForm.querySelector("[name=code]").value);
    } else {
      await requestPhoneOtp(phoneForm.querySelector("[name=phone]").value);
    }
  });
}

function openAuth(mode, plan, billingMode = "one_time") {
  state.authMode = mode || "login";
  state.authOpen = true;
  state.authError = "";
  state.authInfo = "";
  state.authActionLink = "";
  state.authActionText = "";
  state.phoneStep = "";
  state.phoneNumber = "";
  state.pendingVerificationEmail = "";
  if (plan) {
    try { localStorage.setItem("c2l_pending_plan", JSON.stringify({ plan, billingMode })); } catch {}
  }
  render();
  window.scrollTo({ top: 0 });
}

// Reads back a plan chosen on the public pricing page before the user signed up
// or logged in, so checkout can resume automatically once they're in the app.
// Stored in localStorage (not just in-memory state) because email verification
// can involve a page reload or a link opened in a new tab.
function consumePendingPlanSelection() {
  let selection = null;
  try {
    const stored = localStorage.getItem("c2l_pending_plan") || "";
    localStorage.removeItem("c2l_pending_plan");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        selection = { plan: parsed.plan || "", billingMode: parsed.billingMode || "one_time" };
      } catch {
        selection = { plan: stored, billingMode: "subscription" };
      }
    }
  } catch {}
  return selection;
}

function openTopupFromPricing() {
  try { localStorage.setItem("c2l_pending_topup", "1"); } catch {}
  openAuth("login");
}

function consumePendingTopupSelection() {
  try {
    const pending = localStorage.getItem("c2l_pending_topup") === "1";
    localStorage.removeItem("c2l_pending_topup");
    return pending;
  } catch {
    return false;
  }
}

// Called once the user has actually landed in the authenticated app (not mid
// email-verification, not mid-onboarding) so a plan chosen on the public
// pricing page opens the exact same checkout used from the Account screen.
function resumePendingPlanCheckout() {
  if (state.overview?.needsOnboarding) return;
  const selection = consumePendingPlanSelection();
  const pendingTopup = consumePendingTopupSelection();
  if (!selection?.plan && !pendingTopup) return;
  navigateToView("account", { replace: true });
  setTimeout(() => {
    if (pendingTopup) {
      requestTopupPurchase();
    } else if (selection.billingMode === "subscription") {
      startSubscription(selection.plan);
    } else {
      startOneTimePlan(selection.plan);
    }
  }, 300);
}

function closeAuth() {
  state.authOpen = false;
  state.authError = "";
  state.authInfo = "";
  render();
}

function nativeIntroView() {
  const step = state.nativeIntroStep;
  const isSplash = step === 0;
  const slides = {
    1: {
      kicker: "Fast card capture",
      title: "Scan cards without slowing down.",
      body: "Photograph one card at a time or choose a complete batch. Card2Leads prepares every contact for a quick review.",
      visual: `
        <div class="native-scan-visual" aria-hidden="true">
          <div class="native-card-stack"><span></span><span></span><span></span></div>
          <div class="native-flow-arrow">→</div>
          <div class="native-contact-preview"><i></i><b></b><b></b><b></b></div>
        </div>`
    },
    2: {
      kicker: "Ready for follow-up",
      title: "Keep the request with the contact.",
      body: "Record a Hindi, English, or Hinglish voice note, then export clean contacts to Excel, CSV, or Google Sheets.",
      visual: `
        <div class="native-note-visual" aria-hidden="true">
          <div class="native-mic-mark">●</div>
          <div class="native-wave-bars">${"<i></i>".repeat(12)}</div>
          <div class="native-sheet-lines"><span></span><span></span><span></span></div>
        </div>`
    }
  };

  const node = isSplash
    ? el(`
      <main class="native-intro native-splash" aria-label="Card2Leads welcome">
        <div class="native-brand-mark" aria-hidden="true"><span></span></div>
        <div class="native-splash-copy">
          <h1>Card2Leads</h1>
          <p>A product of BrillBrains Consultants</p>
          <span>Cards in. Contacts ready.</span>
        </div>
        <div class="native-splash-loader" aria-hidden="true"><i></i></div>
        <button type="button" class="native-splash-skip" data-native-next>Continue</button>
      </main>`)
    : el(`
      <main class="native-intro native-feature-slide" data-native-slide="${step}">
        <header class="native-intro-header">
          <div class="native-wordmark"><strong>Card2Leads</strong><span>A product of BrillBrains</span></div>
          <button type="button" class="link-button" data-native-skip>Skip</button>
        </header>
        <section class="native-slide-visual">${slides[step].visual}</section>
        <section class="native-slide-copy">
          <p class="section-kicker">${slides[step].kicker}</p>
          <h1>${slides[step].title}</h1>
          <p>${slides[step].body}</p>
        </section>
        <div class="native-slide-dots" aria-label="Feature ${step} of 2">
          <i class="${step === 1 ? "active" : ""}"></i>
          <i class="${step === 2 ? "active" : ""}"></i>
        </div>
        <footer class="native-intro-actions">
          ${step === 2 ? `<button type="button" class="secondary" data-native-prev>Back</button>` : ""}
          <button type="button" data-native-next>${step === 2 ? "Continue to login" : "Next"}</button>
        </footer>
      </main>`);

  const showAuth = () => {
    if (nativeSplashTimer) clearTimeout(nativeSplashTimer);
    localStorage.setItem(nativeIntroStorageKey, "1");
    state.nativeIntroStep = 3;
    state.authMode = "login";
    render();
  };
  const next = () => {
    if (state.nativeIntroStep >= 2) return showAuth();
    state.nativeIntroStep += 1;
    render();
  };
  const previous = () => {
    state.nativeIntroStep = Math.max(1, state.nativeIntroStep - 1);
    render();
  };

  node.querySelector("[data-native-next]")?.addEventListener("click", next);
  node.querySelector("[data-native-prev]")?.addEventListener("click", previous);
  node.querySelector("[data-native-skip]")?.addEventListener("click", showAuth);

  let touchStartX = 0;
  node.addEventListener("touchstart", (event) => {
    touchStartX = event.changedTouches[0]?.clientX || 0;
  }, { passive: true });
  node.addEventListener("touchend", (event) => {
    const distance = (event.changedTouches[0]?.clientX || 0) - touchStartX;
    if (distance < -48) next();
    if (distance > 48 && step > 1) previous();
  }, { passive: true });

  if (isSplash) {
    if (nativeSplashTimer) clearTimeout(nativeSplashTimer);
    nativeSplashTimer = setTimeout(() => {
      if (!state.user && state.nativeIntroStep === 0) next();
    }, 1400);
  }
  return node;
}

async function authenticate(mode, form) {
  const body = Object.fromEntries(new FormData(form).entries());
  body.acceptTerms = Boolean(body.acceptTerms);
  try {
    const result = await api(`/api/auth/${mode}`, { method: "POST", body });
    if (result.verificationRequired) {
      state.authInfo = result.verificationLink
        ? "Account created. Local email delivery is not configured, so use the verification button below for testing."
        : result.message;
      state.authActionLink = result.verificationLink || "";
      state.authActionText = "Verify email and continue";
      state.authMode = "login";
      state.authError = "";
      state.pendingVerificationEmail = body.email || "";
      render();
      return;
    }
    state.user = result.user;
    state.csrfToken = result.csrfToken || "";
    state.authError = "";
    state.authInfo = "";
    state.authActionLink = "";
    state.authActionText = "";
    state.pendingVerificationEmail = "";
    await refreshAll();
    navigateToView("upload", { replace: true });
    resumePendingPlanCheckout();
  } catch (err) {
    state.authError = err.message;
    if (err.data?.verificationRequired) {
      state.pendingVerificationEmail = err.data.email || body.email || "";
      state.authInfo = "Your account is ready. Verify your email, then return here to log in.";
    }
    render();
  }
}

async function resendVerificationEmail() {
  if (!state.pendingVerificationEmail) return;
  try {
    const result = await api("/api/auth/resend-verification", {
      method: "POST",
      body: { email: state.pendingVerificationEmail }
    });
    state.authError = "";
    state.authInfo = result.verificationLink
      ? "Email delivery is not configured locally. Use the verification button below to continue testing."
      : "A fresh verification email has been sent. Check your inbox and spam folder.";
    state.authActionLink = result.verificationLink || "";
    state.authActionText = "Verify email now";
    render();
  } catch (err) {
    state.authError = err.message;
    render();
  }
}

async function forgotPassword(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await api("/api/auth/forgot-password", { method: "POST", body });
    state.authInfo = result.resetLink ? "Local email delivery is not configured, so use the reset button below for testing." : result.message;
    state.authActionLink = result.resetLink || "";
    state.authActionText = "Open password reset";
    state.authError = "";
    render();
  } catch (err) {
    state.authError = err.message;
    render();
  }
}

async function resetPassword(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await api("/api/auth/reset-password", { method: "POST", body });
    state.authInfo = result.message;
    state.authError = "";
    state.authActionLink = "";
    state.authActionText = "";
    state.authMode = "login";
    state.resetToken = "";
    render();
  } catch (err) {
    state.authError = err.message;
    render();
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST", body: {} });
  state.user = null;
  state.csrfToken = "";
  state.cards = [];
  state.contacts = [];
  state.selectedFiles = [];
  state.authInfo = "";
  state.pendingVerificationEmail = "";
  state.authError = "";
  state.authActionLink = "";
  window.history.replaceState({}, "", `${window.location.pathname}#top`);
  render();
}

function shell() {
  const title = {
    upload: "Upload Cards",
    review: "Queue & Review",
    contacts: "Contacts & Exports",
    account: "Account"
  }[state.view];
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><strong>Card2Leads</strong><span>${escapeHtml(state.organisation?.name || "Workspace")}</span></div>
        <nav class="nav">
          ${navButton("upload", pendingCards().length ? `Upload (${pendingCards().length} pending)` : "Upload")}
          ${navButton("review", `Review (${reviewCards().length})`)}
          ${navButton("contacts", `Contacts & Exports (${state.contacts.length})`)}
          ${navButton("account", "Account")}
        </nav>
        <small>Signed in as ${escapeHtml(state.user.name)}</small>
      </aside>
      <main class="main">
        <section class="topbar">
          <div>
            <h1>${title}</h1>
            <span class="muted">${state.view === "upload"
              ? "Add as many cards as you like &middot; scanned automatically, a few at a time"
              : state.view === "review"
                ? "Cards are scanned automatically here, then moved to Contacts &amp; Exports once ready."
                : state.view === "contacts"
                  ? "Manage contacts, assign them to your team, sync to Google, and export files easily."
                  : escapeHtml(state.overview?.activeCollection?.name || "")}</span>
            ${state.view === "contacts" && state.overview?.activeCollection?.name
              ? `<span class="topbar-chip">${escapeHtml(state.overview.activeCollection.name)}</span>`
              : ""}
          </div>
          <div class="topbar-actions">
            ${state.view === "account" ? "" : topbarUpgradeButtonHtml()}
            <span class="session-pill"><svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M10 8a3 3 0 100-6 3 3 0 000 6zM3.465 14.493a1.23 1.23 0 00.41 1.412A9.957 9.957 0 0010 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 00-13.074.003z"/></svg> ${escapeHtml(state.user.name)}</span>
            <button id="logoutBtn" class="secondary slim"><svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M3 4.25A2.25 2.25 0 015.25 2h5.5A2.25 2.25 0 0113 4.25v2a.75.75 0 01-1.5 0v-2a.75.75 0 00-.75-.75h-5.5a.75.75 0 00-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 00.75-.75v-2a.75.75 0 011.5 0v2A2.25 2.25 0 0110.75 18h-5.5A2.25 2.25 0 013 15.75V4.25z" clip-rule="evenodd"/><path fill-rule="evenodd" d="M6 10a.75.75 0 01.75-.75h9.546l-1.048-1.047a.75.75 0 111.06-1.06l2.353 2.353a.748.748 0 010 1.06l-2.353 2.354a.75.75 0 11-1.06-1.06l1.048-1.05H6.75A.75.75 0 016 10z" clip-rule="evenodd"/></svg> Log out</button>
          </div>
        </section>
        <div id="viewSlot" class="grid"></div>
      </main>
    </div>
  `;
}

function topbarUpgradeButtonHtml() {
  const billing = state.overview?.billing;
  if (!billing?.configured) return "";
  const plan = String(billing.plan || "trial");
  const isPaid = plan !== "trial";
  const needsAttention = ["halted", "cancelled", "paused"].includes(String(billing.status || ""));
  const label = needsAttention ? "Fix billing" : isPaid ? "Manage plan" : "Upgrade";
  const starIcon = '<svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401z" clip-rule="evenodd"/></svg>';
  return `<button type="button" id="topbarUpgradeBtn" class="topbar-upgrade-btn ${isPaid && !needsAttention ? "secondary" : ""} ${needsAttention ? "danger" : ""}">${starIcon} ${escapeHtml(label)}</button>`;
}

function navButton(view, label) {
  const mobileLabels = { upload: "Scan", review: "Queue", contacts: "Contacts", account: "Account" };
  const svgIcons = {
    upload: '<svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M9.25 13.25a.75.75 0 001.5 0V4.636l2.955 3.129a.75.75 0 001.09-1.03l-4.25-4.5a.75.75 0 00-1.09 0l-4.25 4.5a.75.75 0 101.09 1.03L9.25 4.636v8.614z"/><path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z"/></svg>',
    review: '<svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"/><path fill-rule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd"/></svg>',
    contacts: '<svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M7 8a3 3 0 100-6 3 3 0 000 6zM14.5 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.615 16.428a1.224 1.224 0 01-.569-1.175 6.002 6.002 0 0111.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 017 18a9.953 9.953 0 01-5.385-1.572zM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 00-1.588-3.755 4.502 4.502 0 015.874 2.636.818.818 0 01-.36.98A7.465 7.465 0 0114.5 16z"/></svg>',
    account: '<svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>'
  };
  const count = view === "review" ? reviewCards().length
    : view === "contacts" ? state.contacts.length
    : view === "upload" ? pendingCards().length
    : 0;
  return `<button class="${state.view === view ? "active" : ""}" data-view="${view}" aria-label="${escapeAttr(label)}">
    <span class="nav-icon" aria-hidden="true">${svgIcons[view]}</span>
    <span class="nav-full">${label}</span>
    <span class="nav-mobile-icon" aria-hidden="true">${svgIcons[view]}</span>
    <span class="nav-short">${mobileLabels[view]}</span>
    ${count ? `<span class="nav-count">${count}</span>` : ""}
  </button>`;
}

// Builds an export URL. Pass `useFilters` to make the download match exactly
// what the Contacts screen is currently showing (assignee, exhibition, city,
// state and search); omit it for a deliberate "everything" download.
// BCP-47 tags so browsers pick the right font/shaping for original-script text.
const NATIVE_LANG_TAGS = {
  hindi: "hi", marathi: "mr", gujarati: "gu", telugu: "te", tamil: "ta",
  kannada: "kn", malayalam: "ml", bengali: "bn", punjabi: "pa", odia: "or",
  arabic: "ar", urdu: "ur", chinese: "zh", japanese: "ja", korean: "ko",
  thai: "th", russian: "ru", nepali: "ne", sinhala: "si"
};

// Mirrors the server's whatsappDigits(): prefers a number explicitly marked as
// WhatsApp on the card, else the mobile, normalised to international digits.
const WHATSAPP_TEMPLATE_KEY = "card2leads.whatsappTemplate";
const WHATSAPP_CATALOGUE_KEY = "card2leads.whatsappCatalogue";
const WHATSAPP_LIBRARY_KEY = "card2leads.whatsappTemplateLibrary";
const DEFAULT_WHATSAPP_TEMPLATE =
  "Hi {name}, it was great meeting you at {exhibition}. Sharing our latest catalogue below — do take a look and let me know what interests you.";

// Starter templates. The long one mirrors a real post-exhibition thank-you so
// there is a working example of a multi-line message with a {name} tag.
const WHATSAPP_STARTER_TEMPLATES = [
  { id: "tpl_intro", name: "Catalogue intro", body: DEFAULT_WHATSAPP_TEMPLATE },
  {
    id: "tpl_thankyou",
    name: "Post-exhibition thank you",
    body: [
      "Hi {name},",
      "",
      "Built with passion.",
      "Celebrated with trust.",
      "Made iconic by you.",
      "",
      "To everyone who stopped by our booth—",
      "thank you for your time, your appreciation, and your belief in Maa Silver.",
      "",
      "Your presence made every moment worthwhile.",
      "",
      "{exhibition} may be over...",
      "But the Iconic Journey Continues.",
      "",
      "See you again, with bigger ideas, better collections, and even stronger partnerships.",
      "",
      "Until next time... Thank You! ✨"
    ].join("\n")
  }
];

// Templates and the catalogue link live on the organisation so every user and
// device shares them. Anything previously saved in this browser is migrated up
// the first time the settings are opened.
function whatsappTemplateLibrary() {
  const saved = state.overview?.organisation?.whatsappTemplates;
  if (Array.isArray(saved) && saved.length) return saved.map((t) => ({ ...t }));
  try {
    const legacy = JSON.parse(localStorage.getItem(WHATSAPP_LIBRARY_KEY) || "null");
    if (Array.isArray(legacy) && legacy.length) return legacy;
  } catch { /* fall through to the starters */ }
  return WHATSAPP_STARTER_TEMPLATES.map((t) => ({ ...t }));
}

function whatsappCatalogueUrl() {
  const saved = state.overview?.organisation?.whatsappCatalogueUrl;
  if (typeof saved === "string" && saved) return saved;
  return localStorage.getItem(WHATSAPP_CATALOGUE_KEY) || "";
}

function whatsappDefaultTemplate() {
  const library = whatsappTemplateLibrary();
  const wantedId = state.overview?.organisation?.whatsappDefaultTemplateId;
  return library.find((t) => t.id === wantedId) || library[0];
}

async function saveWhatsappSettings({ templates, catalogueUrl, defaultTemplateId }) {
  const result = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: { templates, catalogueUrl, defaultTemplateId }
  });
  if (state.overview?.organisation) {
    state.overview.organisation.whatsappTemplates = result.templates;
    state.overview.organisation.whatsappCatalogueUrl = result.catalogueUrl;
    state.overview.organisation.whatsappDefaultTemplateId = result.defaultTemplateId;
  }
  return result;
}

// {name} {firstName} {company} {city} {exhibition} are replaced per contact so
// one template produces a personalised message for everybody in the selection.
function fillWhatsappTemplate(template, contact, catalogueUrl) {
  const firstName = String(contact.name || "").trim().split(/\s+/)[0] || "there";
  const text = String(template || "")
    .replace(/\{name\}/gi, String(contact.name || "there").trim())
    .replace(/\{firstname\}/gi, firstName)
    .replace(/\{company\}/gi, String(contact.companyName || "").trim())
    .replace(/\{city\}/gi, String(contact.city || "").trim())
    .replace(/\{exhibition\}/gi, String(contact.exhibitionName || "the exhibition").trim());
  const link = String(catalogueUrl || "").trim();
  return link ? `${text}\n\n${link}` : text;
}

function whatsappLink(number, message) {
  return `https://wa.me/${number}${message ? `?text=${encodeURIComponent(message)}` : ""}`;
}

// Standalone editor reachable from Account, so the messages can be set up
// before any contact exists — the campaign dialog is only reachable once you
// have selected contacts.
function showWhatsappSettingsModal() {
  let library = whatsappTemplateLibrary();
  const sample = { name: "there", companyName: "Their Company", city: "Amravati", exhibitionName: "IIJS 2026" };
  state.modal = {
    title: "WhatsApp messages",
    body: "Write the messages your team sends after scanning a card. Saved for the whole workspace, on every device.",
    className: "wide-dialog",
    contentHtml: `
      <div class="wa-campaign">
        <div class="wa-template-bar">
          <label class="wa-field wa-field-grow">
            <span>Saved message</span>
            <select id="waTemplateSelect">
              ${library.map((t) => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)}</option>`).join("")}
            </select>
          </label>
          <label class="wa-field wa-field-grow">
            <span>Name</span>
            <input id="waTemplateName" type="text" placeholder="e.g. Diwali greeting" />
          </label>
          <div class="wa-template-actions">
            <button type="button" class="secondary compact-action" id="waSaveTemplate">Save</button>
            <button type="button" class="secondary compact-action" id="waSaveAsTemplate">Save as new</button>
            <button type="button" class="danger compact-action" id="waDeleteTemplate">Delete</button>
          </div>
          <span class="wa-template-status" id="waTplStatus" role="status"></span>
        </div>
        <label class="wa-field">
          <span>Message</span>
          <textarea id="waTemplate" rows="9" placeholder="Hi {name}, ..."></textarea>
          <small class="wa-tokens">Tags: <button type="button" class="wa-token" data-token="{name}">{name}</button><button type="button" class="wa-token" data-token="{firstName}">{firstName}</button><button type="button" class="wa-token" data-token="{company}">{company}</button><button type="button" class="wa-token" data-token="{city}">{city}</button><button type="button" class="wa-token" data-token="{exhibition}">{exhibition}</button></small>
        </label>
        <label class="wa-field">
          <span>Catalogue link</span>
          <input id="waCatalogue" type="url" placeholder="https://drive.google.com/..." value="${escapeAttr(whatsappCatalogueUrl())}" />
          <small class="wa-hint">WhatsApp cannot attach a PDF from a link, so paste a link to the catalogue. It is added at the end of every message.</small>
        </label>
        <div class="wa-preview-box">
          <span class="wa-preview-label">Preview</span>
          <div class="wa-preview" id="waPreview"></div>
        </div>
      </div>`,
    cancelText: "Close",
    confirmText: "Save",
    confirmClass: "",
    keepOpenOnConfirm: true,
    onRender: (node) => {
      const templateEl = node.querySelector("#waTemplate");
      const nameEl = node.querySelector("#waTemplateName");
      const catalogueEl = node.querySelector("#waCatalogue");
      const previewEl = node.querySelector("#waPreview");
      const selectEl = node.querySelector("#waTemplateSelect");
      const statusEl = node.querySelector("#waTplStatus");
      const say = (text, bad = false) => {
        statusEl.textContent = text;
        statusEl.classList.toggle("bad", Boolean(bad));
      };
      const refresh = () => {
        previewEl.textContent = fillWhatsappTemplate(templateEl.value, sample, catalogueEl.value);
      };
      const redrawSelect = (selectedId) => {
        selectEl.innerHTML = library.map((t) => `<option value="${escapeAttr(t.id)}"${t.id === selectedId ? " selected" : ""}>${escapeHtml(t.name)}</option>`).join("");
      };
      const load = (id) => {
        const chosen = library.find((t) => t.id === id) || library[0];
        templateEl.value = chosen.body;
        nameEl.value = chosen.name;
        refresh();
      };
      const persist = (defaultId, message) => {
        say("Saving…");
        saveWhatsappSettings({ templates: library, catalogueUrl: catalogueEl.value, defaultTemplateId: defaultId })
          .then(() => say(message))
          .catch((err) => say(err.message, true));
      };

      selectEl.addEventListener("change", () => load(selectEl.value));
      templateEl.addEventListener("input", refresh);
      catalogueEl.addEventListener("input", refresh);

      node.querySelector("#waSaveTemplate").addEventListener("click", () => {
        const chosen = library.find((t) => t.id === selectEl.value);
        if (!chosen) return;
        chosen.body = templateEl.value;
        chosen.name = String(nameEl.value || "").trim() || chosen.name;
        redrawSelect(chosen.id);
        persist(chosen.id, `Saved "${chosen.name}" for the whole workspace.`);
      });
      node.querySelector("#waSaveAsTemplate").addEventListener("click", () => {
        const name = String(nameEl.value || "").trim();
        if (!name) { say("Give the message a name first.", true); nameEl.focus(); return; }
        if (library.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
          say("A saved message already uses that name — change it or press Save to update.", true);
          nameEl.focus();
          return;
        }
        const entry = { id: `tpl_${Date.now()}`, name, body: templateEl.value };
        library = [...library, entry];
        redrawSelect(entry.id);
        persist(entry.id, `Saved "${entry.name}" for the whole workspace.`);
      });
      node.querySelector("#waDeleteTemplate").addEventListener("click", () => {
        if (library.length <= 1) { say("Keep at least one saved message.", true); return; }
        const chosen = library.find((t) => t.id === selectEl.value);
        if (!chosen) return;
        library = library.filter((t) => t.id !== chosen.id);
        redrawSelect(library[0].id);
        load(library[0].id);
        persist(library[0].id, `Deleted "${chosen.name}".`);
      });
      node.querySelectorAll(".wa-token").forEach((btn) => btn.addEventListener("click", () => {
        const start = templateEl.selectionStart ?? templateEl.value.length;
        const end = templateEl.selectionEnd ?? start;
        templateEl.value = `${templateEl.value.slice(0, start)}${btn.dataset.token}${templateEl.value.slice(end)}`;
        templateEl.focus();
        templateEl.setSelectionRange(start + btn.dataset.token.length, start + btn.dataset.token.length);
        refresh();
      }));

      const initial = whatsappDefaultTemplate() || library[0];
      redrawSelect(initial.id);
      load(initial.id);
    },
    onConfirm: () => {
      const catalogueEl = document.querySelector("#waCatalogue");
      const selectEl = document.querySelector("#waTemplateSelect");
      const statusEl = document.querySelector("#waTplStatus");
      const templateEl = document.querySelector("#waTemplate");
      const nameEl = document.querySelector("#waTemplateName");
      const chosen = library.find((t) => t.id === selectEl?.value);
      if (chosen && templateEl) {
        chosen.body = templateEl.value;
        chosen.name = String(nameEl?.value || "").trim() || chosen.name;
      }
      if (statusEl) statusEl.textContent = "Saving…";
      saveWhatsappSettings({ templates: library, catalogueUrl: catalogueEl?.value || "", defaultTemplateId: chosen?.id || "" })
        .then(() => { closeModal(false); setMessage("WhatsApp messages saved for the workspace."); render(); })
        .catch((err) => { if (statusEl) { statusEl.textContent = err.message; statusEl.classList.add("bad"); } });
    }
  };
  render();
}

let waCampaignIndex = 0;

// WhatsApp click-to-chat cannot attach a file, so the catalogue travels as a
// link. Chats open one at a time and the user presses send.
function showWhatsappCampaignModal(targets, skipped) {
  waCampaignIndex = 0;
  let library = whatsappTemplateLibrary();
  const savedCatalogue = whatsappCatalogueUrl();
  const lastBody = (whatsappDefaultTemplate() || library[0]).body;
  const total = targets.length;
  const collectionId = state.overview?.activeCollection?.id || "";
  const vcfHref = collectionId
    ? exportHref("vcf", collectionId, targets.map((t) => t.contact.id))
    : "";

  state.modal = {
    title: `WhatsApp ${total} contact${total === 1 ? "" : "s"}`,
    body: "Pick or write a message — each contact gets their own name filled in. WhatsApp opens with the text ready; you press send.",
    className: "wide-dialog",
    contentHtml: `
      <div class="wa-campaign">
        <div class="wa-template-bar">
          <label class="wa-field wa-field-grow">
            <span>Saved message</span>
            <select id="waTemplateSelect">
              ${library.map((t) => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)}</option>`).join("")}
            </select>
          </label>
          <label class="wa-field wa-field-grow">
            <span>Name</span>
            <input id="waTemplateName" type="text" placeholder="e.g. Diwali greeting" />
          </label>
          <div class="wa-template-actions">
            <button type="button" class="secondary compact-action" id="waSaveTemplate">Save</button>
            <button type="button" class="secondary compact-action" id="waSaveAsTemplate">Save as new</button>
            <button type="button" class="danger compact-action" id="waDeleteTemplate">Delete</button>
          </div>
          <span class="wa-template-status" id="waTplStatus" role="status"></span>
        </div>
        <label class="wa-field">
          <span>Message</span>
          <textarea id="waTemplate" rows="9" placeholder="Hi {name}, ...">${escapeHtml(lastBody)}</textarea>
          <small class="wa-tokens">Tags: <button type="button" class="wa-token" data-token="{name}">{name}</button><button type="button" class="wa-token" data-token="{firstName}">{firstName}</button><button type="button" class="wa-token" data-token="{company}">{company}</button><button type="button" class="wa-token" data-token="{city}">{city}</button><button type="button" class="wa-token" data-token="{exhibition}">{exhibition}</button></small>
        </label>
        <label class="wa-field">
          <span>Catalogue link (optional)</span>
          <input id="waCatalogue" type="url" placeholder="https://drive.google.com/..." value="${escapeAttr(savedCatalogue)}" />
          <small class="wa-hint">WhatsApp cannot attach a PDF from a link, so paste a link to the catalogue (Drive, Dropbox, your website). It is added at the end of every message.</small>
        </label>
        ${vcfHref ? `<div class="wa-vcf-note">
          <span>WhatsApp shows whatever name is in your phone's contacts. Save these first and each chat will show the saved contact name.</span>
          <a class="secondary button-link compact-action" href="${vcfHref}" download>Save ${total} contact${total === 1 ? "" : "s"} to phone (.vcf)</a>
        </div>` : ""}
        <div class="wa-preview-box">
          <span class="wa-preview-label">Preview — ${escapeHtml(targets[0].contact.name || "first contact")}</span>
          <div class="wa-preview" id="waPreview"></div>
        </div>
        ${skipped ? `<p class="wa-skipped">${skipped} selected contact(s) have no usable number and will be skipped.</p>` : ""}
        <div class="wa-progress" id="waProgress">Ready to open ${total} chat${total === 1 ? "" : "s"}, one at a time.</div>
      </div>`,
    cancelText: "Close",
    confirmText: `Open chat 1 of ${total}`,
    confirmClass: "",
    keepOpenOnConfirm: true,
    onRender: (node) => {
      const templateEl = node.querySelector("#waTemplate");
      const catalogueEl = node.querySelector("#waCatalogue");
      const previewEl = node.querySelector("#waPreview");
      const selectEl = node.querySelector("#waTemplateSelect");

      const refresh = () => {
        const contact = targets[Math.min(waCampaignIndex, total - 1)].contact;
        previewEl.textContent = fillWhatsappTemplate(templateEl.value, contact, catalogueEl.value);
        const labelEl = node.querySelector(".wa-preview-label");
        if (labelEl) labelEl.textContent = `Preview — ${contact.name || "contact"}`;
      };
      const redrawSelect = (selectedId) => {
        selectEl.innerHTML = library.map((t) => `<option value="${escapeAttr(t.id)}"${t.id === selectedId ? " selected" : ""}>${escapeHtml(t.name)}</option>`).join("");
      };

      const nameEl = node.querySelector("#waTemplateName");
      const statusEl = node.querySelector("#waTplStatus");
      // setMessage() re-renders the app, which would rebuild this modal from its
      // static contentHtml and discard the edited template list.
      const say = (text, bad = false) => {
        statusEl.textContent = text;
        statusEl.classList.toggle("bad", Boolean(bad));
      };
      const syncName = () => {
        const chosen = library.find((t) => t.id === selectEl.value);
        if (chosen) nameEl.value = chosen.name;
      };

      selectEl.addEventListener("change", () => {
        const chosen = library.find((t) => t.id === selectEl.value);
        if (chosen) { templateEl.value = chosen.body; nameEl.value = chosen.name; refresh(); }
      });
      templateEl.addEventListener("input", refresh);
      catalogueEl.addEventListener("input", refresh);

      node.querySelector("#waSaveTemplate").addEventListener("click", () => {
        const chosen = library.find((t) => t.id === selectEl.value);
        if (!chosen) return;
        chosen.body = templateEl.value;
        chosen.name = String(nameEl.value || "").trim() || chosen.name;
        redrawSelect(chosen.id);
        say("Saving…");
        saveWhatsappSettings({ templates: library, catalogueUrl: catalogueEl.value, defaultTemplateId: chosen.id })
          .then(() => say(`Saved "${chosen.name}" for everyone in the workspace.`))
          .catch((err) => say(err.message, true));
      });
      node.querySelector("#waSaveAsTemplate").addEventListener("click", () => {
        const name = String(nameEl.value || "").trim();
        if (!name) { say("Give the message a name first.", true); nameEl.focus(); return; }
        if (library.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
          say("A saved message already uses that name — change it or press Save to update.", true);
          nameEl.focus();
          return;
        }
        const entry = { id: `tpl_${Date.now()}`, name, body: templateEl.value };
        library = [...library, entry];
        redrawSelect(entry.id);
        say("Saving…");
        saveWhatsappSettings({ templates: library, catalogueUrl: catalogueEl.value, defaultTemplateId: entry.id })
          .then(() => say(`Saved "${entry.name}" for everyone in the workspace.`))
          .catch((err) => say(err.message, true));
      });
      node.querySelector("#waDeleteTemplate").addEventListener("click", () => {
        if (library.length <= 1) { say("Keep at least one saved message.", true); return; }
        const chosen = library.find((t) => t.id === selectEl.value);
        if (!chosen) return;
        library = library.filter((t) => t.id !== chosen.id);
        redrawSelect(library[0].id);
        templateEl.value = library[0].body;
        nameEl.value = library[0].name;
        refresh();
        say("Saving…");
        saveWhatsappSettings({ templates: library, catalogueUrl: catalogueEl.value, defaultTemplateId: library[0].id })
          .then(() => say(`Deleted "${chosen.name}".`))
          .catch((err) => say(err.message, true));
      });

      node.querySelectorAll(".wa-token").forEach((btn) => btn.addEventListener("click", () => {
        const start = templateEl.selectionStart ?? templateEl.value.length;
        const end = templateEl.selectionEnd ?? start;
        templateEl.value = `${templateEl.value.slice(0, start)}${btn.dataset.token}${templateEl.value.slice(end)}`;
        templateEl.focus();
        templateEl.setSelectionRange(start + btn.dataset.token.length, start + btn.dataset.token.length);
        refresh();
      }));

      const match = library.find((t) => t.body === lastBody);
      redrawSelect(match ? match.id : library[0].id);
      syncName();
      refresh();
    },
    onConfirm: () => {
      const templateEl = document.querySelector("#waTemplate");
      const catalogueEl = document.querySelector("#waCatalogue");
      const progressEl = document.querySelector("#waProgress");
      const confirmBtn = document.querySelector("[data-modal-confirm]");
      const entry = targets[waCampaignIndex];
      if (!entry || !templateEl) return;
      localStorage.setItem(WHATSAPP_TEMPLATE_KEY, templateEl.value);
      localStorage.setItem(WHATSAPP_CATALOGUE_KEY, catalogueEl.value);
      if (catalogueEl.value !== savedCatalogue) {
        const currentId = document.querySelector("#waTemplateSelect")?.value || "";
        saveWhatsappSettings({ templates: library, catalogueUrl: catalogueEl.value, defaultTemplateId: currentId }).catch(() => {});
      }
      window.open(
        whatsappLink(entry.number, fillWhatsappTemplate(templateEl.value, entry.contact, catalogueEl.value)),
        "_blank",
        "noopener"
      );
      waCampaignIndex += 1;
      if (waCampaignIndex >= total) {
        if (progressEl) progressEl.textContent = `Opened all ${total} chat(s). Send each one from WhatsApp.`;
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "All chats opened"; }
        return;
      }
      const next = targets[waCampaignIndex];
      if (progressEl) progressEl.textContent = `Opened ${waCampaignIndex} of ${total}. Next: ${next.contact.name || next.number}`;
      if (confirmBtn) confirmBtn.textContent = `Open chat ${waCampaignIndex + 1} of ${total}`;
      const previewEl = document.querySelector("#waPreview");
      const labelEl = document.querySelector(".wa-preview-label");
      if (previewEl) previewEl.textContent = fillWhatsappTemplate(templateEl.value, next.contact, catalogueEl.value);
      if (labelEl) labelEl.textContent = `Preview — ${next.contact.name || "contact"}`;
    }
  };
  render();
}

// Mirrors the server's googleContactDisplayName(): the name that actually gets
// written to Google Contacts, the VCF and the export files. Shown in its own
// column so it is visible before exporting rather than only after.
// For cards where no city was printed (or it could not be read). The server
// derives the state from the city on save, so entering just the city is enough.
function showSetCityModal(contact) {
  state.modal = {
    title: "Add city",
    body: "Type the city and the state fills in automatically for known Indian towns. You can also set the state yourself.",
    detail: contact.name || "",
    contentHtml: `
      <div class="set-city-form">
        <label class="wa-field">
          <span>City</span>
          <input id="setCityInput" type="text" placeholder="e.g. Amravati" value="${escapeAttr(contact.city || "")}" />
        </label>
        <label class="wa-field">
          <span>State (optional)</span>
          <input id="setStateInput" type="text" placeholder="Left blank, we work it out from the city" value="${escapeAttr(contact.state || "")}" />
        </label>
      </div>`,
    cancelText: "Cancel",
    confirmText: "Save city",
    confirmClass: "",
    keepOpenOnConfirm: true,
    onRender: (node) => node.querySelector("#setCityInput")?.focus(),
    onConfirm: async () => {
      const city = String(document.querySelector("#setCityInput")?.value || "").trim();
      const stateValue = String(document.querySelector("#setStateInput")?.value || "").trim();
      if (!city && !stateValue) {
        setMessage("Enter a city (or a state) first.", true);
        return;
      }
      // cleanContactFields() rebuilds the whole record, so send every existing
      // field alongside the change or the untouched ones would be wiped.
      const fields = { ...contact, city, state: stateValue };
      try {
        await api(`/api/contacts/${contact.id}`, { method: "PATCH", body: { fields } });
        closeModal(false);
        await refreshAll();
        setMessage(`City saved for ${contact.name || "contact"}.`);
      } catch (err) {
        setMessage(err.message, true);
      }
    }
  };
  render();
}

// Mirrors the server's buildContactDisplayName():
// "MH. IIJS 2026. Sampatlal Soni. Soni Jewellers. Amgaon".
// Shown in its own table column so the saved name is visible before exporting.
function contactSavedDisplayName(contact) {
  const stored = String(contact.contactDisplayName || "").trim();
  if (stored) return stored;
  const exhibition = String(contact.exhibitionName || "").trim();
  const year = String(contact.exhibitionDate || "").match(/^(\d{4})/)?.[1] || "";
  const label = exhibition && year && !new RegExp(`\\b${year}\\b`).test(exhibition)
    ? `${exhibition} ${year}`
    : exhibition || year;
  const person = String(contact.name || "").trim();
  const company = String(contact.companyName || "").trim();
  const sameAsPerson = company.toLowerCase() === person.toLowerCase();
  return [
    String(contact.stateCode || "").trim(),
    label,
    person,
    sameAsPerson ? "" : company,
    String(contact.city || "").trim()
  ].filter(Boolean).join(". ");
}

// Used by both the contacts table and the Review quick-send strip, so it lives
// at module scope rather than inside contactsView().
function contactInitials(name) {
  // Use the first two word-initials, ignoring punctuation-only tokens like ".SR".
  const words = String(name || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

function contactWhatsappNumber(contact) {
  const explicit = String(contact.whatsappNumber || "").replace(/\D/g, "");
  if (explicit.length >= 8) return explicit;
  const raw = String(contact.mobileNumber || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (/^\+/.test(raw)) return digits;
  if (/^00/.test(digits)) return digits.replace(/^00/, "");
  const cc = String(contact.phoneCountryCode || "").replace(/\D/g, "");
  const national = digits.replace(/^0+/, "");
  if (cc) return national.startsWith(cc) && national.length > cc.length ? national : `${cc}${national}`;
  if (/^[6-9]\d{9}$/.test(national)) return `91${national}`;
  return national.length >= 8 ? national : "";
}

function exportHref(format, collectionId, ids = [], all = false, useFilters = false) {
  const params = new URLSearchParams({ collectionId, csrf: state.csrfToken || "" });
  if (ids.length) params.set("ids", ids.join(","));
  if (all) params.set("all", "true");
  if (useFilters) {
    const f = state.contactFilters || {};
    if (f.assignee) params.set("assigneeId", f.assignee);
    if (f.exhibition) params.set("exhibition", f.exhibition);
    if (f.city) params.set("city", f.city);
    if (f.state) params.set("state", f.state);
    if (state.contactSearchQuery) params.set("q", state.contactSearchQuery);
  }
  return `/api/export.${format}?${params.toString()}`;
}

function contactsWorkspaceView() {
  // Sheets & Sync tab removed: Google connect/disconnect lives in Account, and
  // per-exhibition exports/sync are handled here via the Export menu + filters.
  return contactsView();
}

function onboardingView() {
  const generatedWorkspaceName = `${String(state.user?.name || "").trim()}'s Workspace`;
  const workspaceName = state.organisation?.name === generatedWorkspaceName ? "" : state.organisation?.name || "";
  const rawFirstName = String(state.user?.name || "").trim().split(/\s+/)[0] || "there";
  const firstName = rawFirstName.charAt(0).toUpperCase() + rawFirstName.slice(1);
  const node = el(`
    <main class="auth-wrap setup-wrap">
      <section class="setup-card">
        <div class="setup-hero">
          <div>
            <p class="eyebrow">Welcome to Card2Leads</p>
            <h1>Welcome, ${escapeHtml(firstName)}</h1>
            <p>One quick step, then you can start scanning your cards.</p>
          </div>
          <button type="button" class="secondary slim setup-logout" id="logoutSetupTop">Log out</button>
        </div>
        <div class="setup-body">
          ${state.authInfo ? `<div class="notice compact">${escapeHtml(state.authInfo)}</div>` : ""}
          ${state.onboardingError ? `<div class="notice bad compact">${escapeHtml(state.onboardingError)}</div>` : ""}
          <form id="onboardingForm" class="grid two setup-form">
            <label>Your name <input name="contactName" value="${escapeAttr(state.user?.name || "")}" placeholder="Your full name" autocomplete="name" required /></label>
            <label>Company name <input name="companyName" value="${escapeAttr(workspaceName)}" placeholder="Your company or business name" autocomplete="organization" required /></label>
            <label>Phone number <input name="phone" type="tel" value="${escapeAttr(state.user?.phone || "")}" placeholder="e.g. +91 90000 00000" autocomplete="tel" required /></label>
            <label>Exhibition or event <span class="optional-label">Optional</span><input name="defaultExhibitionName" placeholder="For example, IIJS Premiere 2026" /></label>
            <div class="setup-reassurance wide">
              <span class="setup-check" aria-hidden="true">&#10003;</span>
              <p><strong>Your first contact sheet is automatic.</strong><br />Upload your cards and Card2Leads will prepare it for you.</p>
            </div>
            <div class="actions wide setup-actions">
              <button type="submit">Continue</button>
            </div>
          </form>
        </div>
      </section>
    </main>
  `);
  const form = node.querySelector("#onboardingForm");
  const completeSetup = async (body) => {
    body.deferFirstCollection = true;
    body.destinationType = "excel";
    body.collectionName = "";
    try {
      await api("/api/onboarding", { method: "POST", body });
      state.onboardingError = "";
      await refreshAll();
      navigateToView("upload", { replace: true });
      resumePendingPlanCheckout();
    } catch (err) {
      state.onboardingError = err.message;
      render();
    }
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await completeSetup(Object.fromEntries(new FormData(form).entries()));
  });
  node.querySelector("#logoutSetupTop").addEventListener("click", logout);
  return node;
}

function messageView() {
  if (!state.message) return el(`<div class="hidden"></div>`);
  const currentMessage = state.message;
  const node = el(`
    <div class="notice flash-message ${currentMessage.bad ? "bad" : ""}" role="${currentMessage.bad ? "alert" : "status"}">
      <span>${escapeHtml(currentMessage.text)}</span>
      <button type="button" class="flash-dismiss" aria-label="Dismiss message">&times;</button>
    </div>
  `);
  node.querySelector(".flash-dismiss").addEventListener("click", () => clearMessage());
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    if (state.message === currentMessage) clearMessage();
  }, currentMessage.bad ? 7000 : 4200);
  return node;
}

function modalView() {
  const modal = state.modal;
  const node = el(`
    <div class="modal-backdrop" role="presentation">
      <section class="dialog ${modal.className || ""}" role="dialog" aria-modal="true" aria-labelledby="dialogTitle" aria-describedby="dialogBody">
        <button type="button" class="dialog-close" data-modal-close aria-label="Close dialog">&times;</button>
        <div class="dialog-icon ${modal.tone || "warn"}">${modal.iconHtml || (modal.tone === "danger" ? "!" : "i")}</div>
        <div class="dialog-content">
          <h2 id="dialogTitle">${escapeHtml(modal.title)}</h2>
          ${modal.body ? `<p id="dialogBody">${escapeHtml(modal.body)}</p>` : ""}
          ${modal.detail ? `<div class="dialog-detail">${escapeHtml(modal.detail)}</div>` : ""}
          ${modal.contentHtml || ""}
        </div>
        <div class="dialog-actions">
          ${
            Array.isArray(modal.actions)
              ? modal.actions.map((action, index) => `<button type="button" class="${action.className || "secondary"}" data-modal-action="${index}">${escapeHtml(action.label)}</button>`).join("")
              : `<button type="button" class="secondary" data-modal-cancel>${escapeHtml(modal.cancelText || "Cancel")}</button><button type="button" class="${modal.confirmClass ?? "danger"}" data-modal-confirm>${escapeHtml(modal.confirmText || "Confirm")}</button>`
          }
        </div>
      </section>
    </div>
  `);
  node.addEventListener("click", (event) => {
    if (event.target === node) closeModal();
  });
  node.querySelector("[data-modal-close]")?.addEventListener("click", () => closeModal());
  node.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
  node.querySelector("[data-modal-confirm]")?.addEventListener("click", async () => {
    const onConfirm = modal.onConfirm;
    if (!modal.keepOpenOnConfirm) closeModal(false);
    if (onConfirm) await onConfirm();
  });
  node.querySelectorAll("[data-modal-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = modal.actions[Number(btn.dataset.modalAction)];
      if (action?.onClick) await action.onClick();
      if (state.modal === modal) closeModal();
    });
  });
  document.addEventListener("keydown", modalEscapeHandler, { once: true });
  setTimeout(() => (node.querySelector("[data-modal-cancel]") || node.querySelector("[data-modal-action]"))?.focus(), 0);
  if (modal.onRender) setTimeout(() => modal.onRender(node), 0);
  return node;
}

function closeModal(shouldRender = true) {
  const onClose = state.modal?.onClose;
  if (onClose) onClose();
  state.modal = null;
  if (shouldRender) render();
}

function modalEscapeHandler(event) {
  if (event.key === "Escape" && state.modal) closeModal();
}

function dashboardView() {
  const stats = state.overview?.stats || {};
  const google = state.overview.google || {};
  const providerLabel = google.extractionProvider === "gemini"
    ? "Gemini"
    : google.extractionProvider === "openai"
      ? "OpenAI"
      : "Manual review";
  const node = el(`
    <div class="grid">
      <section class="metrics">
        ${metric("Saved contacts", stats.contacts || 0)}
        ${metric("Needs review", stats.needsReview || 0)}
        ${metric("Synced", stats.synced || 0)}
        ${metric("Pending sync", stats.pendingSync || 0)}
      </section>
      <section class="panel">
        <h2>Current collection</h2>
        <div class="grid three">
          <div><strong>${escapeHtml(state.overview.activeCollection.name)}</strong><p class="muted">Collection</p></div>
          <div><strong>${escapeHtml(displayDate(state.overview.activeCollection.exhibitionDate) || "Not set")}</strong><p class="muted">Exhibition date</p></div>
          <div><strong>${escapeHtml(state.overview.activeCollection.destinationName || "Excel collection")}</strong><p class="muted">Destination</p></div>
        </div>
        <div class="actions">
          <button data-view-jump="upload">Upload more cards</button>
          <button class="secondary" data-view-jump="contacts">Open contacts</button>
          <a class="button-link" href="${exportHref("xlsx", state.overview.activeCollection.id)}"><button class="secondary">Download complete Excel</button></a>
        </div>
      </section>
      <section class="panel">
        <h2>External services</h2>
        <p class="muted">AI extraction: ${escapeHtml(providerLabel)}${providerLabel === "Manual review" ? " - add GEMINI_API_KEY or OPENAI_API_KEY" : " configured"}. Google Sheets: ${google.configured ? google.sheetsConnected ? "Connected" : "Configured, not connected yet" : "Needs Google OAuth credentials"}.</p>
      </section>
    </div>
  `);
  node.querySelectorAll("[data-view-jump]").forEach((btn) => btn.addEventListener("click", () => {
    navigateToView(btn.dataset.viewJump);
  }));
  return node;
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function uploadView() {
  if (state.uploadTab === "pending") return withUploadSubtabs(pendingPanel());
  const c = state.overview.activeCollection || {
    id: "",
    name: "",
    exhibitionName: state.organisation?.defaultExhibitionName || "",
    exhibitionDate: "",
    destinationType: "excel",
    destinationName: "",
    nextSheetRow: 2
  };
  const collections = state.overview.collections || [];
  const hasMeaningfulSheet = collections.some((collection) =>
    collection.status !== "deleted" &&
    collection.name &&
    !["Current Sheet", "Default Contact Collection"].includes(collection.name)
  );
  const needsFirstSheet = !hasMeaningfulSheet;
  const createNewSelected = needsFirstSheet || state.uploadMode === "new";
  const selectedExistingId = state.selectedCollectionId && collections.some((item) => item.id === state.selectedCollectionId)
    ? state.selectedCollectionId
    : c.id;
  const draftExhibitionName = state.draftExhibitionName || (needsFirstSheet ? (c.exhibitionName || state.organisation?.defaultExhibitionName || "") : "");
  const draftExhibitionDate = state.draftExhibitionDate || (needsFirstSheet ? (c.exhibitionDate || "") : "");
  const draftCollectionName = state.draftCollectionName || (needsFirstSheet ? (draftExhibitionName || "Exhibition Leads") : "");
  const node = el(`
    <section class="panel upload-panel">
      ${!createNewSelected ? `<div class="destination-selector">
        <label class="destination-field">
          <span class="destination-kicker">Saving to</span>
          <select id="existingCollectionSelect" aria-label="Choose the exhibition for this upload">
            ${collections.filter((collection) => collection.status !== "deleted").map((collection) => `<option value="${escapeAttr(collection.id)}" ${collection.id === selectedExistingId ? "selected" : ""}>${escapeHtml(collection.exhibitionName || collection.name)}</option>`).join("")}
          </select>
        </label>
        <button type="button" class="secondary slim" id="startNewExhibition">+ New exhibition</button>
      </div>` : `<div id="uploadSettings" class="new-exhibition-settings">
        <div class="new-exhibition-heading">
          <div>
            <span class="destination-kicker">${needsFirstSheet ? "Save these cards to" : "New exhibition"}</span>
            <h3>${needsFirstSheet ? "Name your first list" : "Create a separate contact list"}</h3>
          </div>
          ${needsFirstSheet ? "" : `<button type="button" class="secondary slim" id="cancelNewExhibition">Use current exhibition</button>`}
        </div>
        <div class="grid three new-exhibition-fields">
          <label>Exhibition or event <input id="exhibitionName" value="${escapeAttr(draftExhibitionName)}" placeholder="GJEPC 2026" /></label>
          <label>Contact list name <input id="collectionName" value="${escapeAttr(draftCollectionName)}" placeholder="GJEPC 2026 Leads" /></label>
          <label>Event date <span class="optional-label">Optional</span><input id="exhibitionDate" type="date" value="${escapeAttr(draftExhibitionDate)}" /></label>
        </div>
        <div class="new-exhibition-actions">
          <button type="button" id="createExhibitionBtn">Create &amp; continue</button>
        </div>
        <div id="newExhibitionError" class="inline-form-error hidden" role="alert"></div>
      </div>`}
      <div class="dropzone" id="dropzone">
        <div class="dropzone-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 16V8m0 0l-3 3m3-3l3 3" />
            <path d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
          </svg>
        </div>
        <div class="dropzone-text">
          <strong>${state.selectedFiles.length ? `${state.selectedFiles.length} card${state.selectedFiles.length === 1 ? "" : "s"} ready` : "Upload business cards"}</strong>
          <p>${state.selectedFiles.length ? "Add more cards or hit upload to start processing" : "Drag & drop photos here, or choose from your device"}</p>
        </div>
        <p class="dropzone-hint">One card per photo &bull; Front side first &bull; JPG, PNG or WEBP</p>
        <p class="quality-hint" role="note">
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 011-1h.01a1 1 0 110 2H10a1 1 0 01-1-1zm1-4a.75.75 0 01.75.75v.01a.75.75 0 01-1.5 0V5.75A.75.75 0 0110 5zm-.75 5.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5z" clip-rule="evenodd"/></svg>
          For the best results: fill the frame with the card, use even light, avoid glare and shadows, and hold steady until it's sharp.
        </p>
        ${state.overview.usage ? `<div class="upload-allowance"><svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /></svg> ${state.overview.usage.unlimited ? "Unlimited scans (test account)" : `${Number(state.overview.usage.remaining)} scans remaining this period`}</div>` : ""}
        <div class="dropzone-actions">
          <label class="upload-picker">
            <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18" aria-hidden="true"><path fill-rule="evenodd" d="M10 3a.75.75 0 01.75.75v5.5h5.5a.75.75 0 010 1.5h-5.5v5.5a.75.75 0 01-1.5 0v-5.5h-5.5a.75.75 0 010-1.5h5.5v-5.5A.75.75 0 0110 3z" clip-rule="evenodd" /></svg>
            <span>Choose photos</span>
            <input class="hidden-file" id="fileInput" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*" multiple />
          </label>
          <label class="upload-picker camera">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1-1.6h6L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z" /><circle cx="12" cy="12.5" r="3.2" /></svg>
            <span>Take a photo</span>
            <input class="hidden-file" id="cameraInput" type="file" accept="image/*" capture="environment" />
          </label>
          <input class="hidden-file" id="backSideInput" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*" />
        </div>
        <button type="button" class="link-button upload-options-toggle" id="toggleUploadOptions">${state.showUploadOptions ? "Hide extra options" : "Add the back of a card (optional)"}</button>
        <div class="${state.showUploadOptions ? "upload-options" : "hidden"}">
          <strong>Does the back have more details?</strong>
          <p class="muted">One side is usually enough. Add the back only if it has another phone number, address, or QR code. Both sides are saved as one contact.</p>
        </div>
        <div class="dropzone-footer">
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clip-rule="evenodd" /></svg>
          Images are processed securely and aren't shared.
        </div>
      </div>
      <div id="fileList" class="file-list"></div>
      <div id="uploadProcessing" class="upload-processing hidden" role="status" aria-live="polite">
        <div class="processing-copy">
          <span class="processing-spinner" aria-hidden="true"></span>
          <div>
            <h3 id="processingTitle">Preparing your cards</h3>
            <p id="processingMessage">Please keep this page open. Review will open automatically when your contacts are ready.</p>
          </div>
        </div>
        <div class="processing-track" aria-hidden="true"><span></span></div>
        <div class="processing-meta">
          <strong id="processingEstimate"></strong>
          <span id="processingElapsed">Started just now</span>
        </div>
        <p id="processingTip" class="processing-tip"></p>
      </div>
      <div class="actions upload-submit-actions">
        <button id="stageBtn" ${state.selectedFiles.length ? "" : "disabled"}>Add to Pending</button>
        <button class="secondary" id="uploadBtn" ${state.selectedFiles.length ? "" : "disabled"}>Upload &amp; read now</button>
        ${state.selectedFiles.length ? `<button class="secondary" id="clearFilesBtn" type="button">Clear</button>` : ""}
      </div>
    </section>
  `);
  const fileInput = node.querySelector("#fileInput");
  fileInput.addEventListener("change", async () => {
    syncUploadDraft(node);
    addSelectedFiles(fileInput.files);
    render();
  });
  const cameraInput = node.querySelector("#cameraInput");
  cameraInput.addEventListener("change", async () => {
    syncUploadDraft(node);
    const beforeCount = state.selectedFiles.length;
    addSelectedFiles(cameraInput.files);
    const addedFile = state.selectedFiles.length > beforeCount ? state.selectedFiles[state.selectedFiles.length - 1] : null;
    if (cameraInput.files?.length) window.EasySaveNative?.haptic("success");
    render();
    // Only the live camera capture gets this — a bulk file-picker upload
    // (fileInput above) already lets people attach a back image themselves,
    // and prompting per-file there would be noise, not help.
    if (addedFile) promptForBackSide(addedFile, node.querySelector("#backSideInput"));
  });
  const backSideInput = node.querySelector("#backSideInput");
  backSideInput.addEventListener("change", () => {
    const target = state.selectedFiles[state.backSideTargetIndex];
    const backFile = backSideInput.files?.[0];
    if (target && backFile) {
      if (target.backPreviewUrl) URL.revokeObjectURL(target.backPreviewUrl);
      target.backSideFile = backFile;
      target.backPreviewUrl = URL.createObjectURL(backFile);
    }
    state.backSideTargetIndex = -1;
    render();
  });
  node.querySelector("#collectionName")?.addEventListener("input", () => syncUploadDraft(node));
  node.querySelector("#exhibitionName")?.addEventListener("input", (event) => {
    const previousExhibitionName = state.draftExhibitionName;
    const collectionNameInput = node.querySelector("#collectionName");
    const shouldMirrorName = collectionNameInput && (
      !collectionNameInput.value.trim() || collectionNameInput.value.trim() === previousExhibitionName.trim()
    );
    syncUploadDraft(node);
    if (shouldMirrorName) {
      collectionNameInput.value = event.target.value;
      state.draftCollectionName = event.target.value;
    }
  });
  node.querySelector("#exhibitionDate")?.addEventListener("change", () => syncUploadDraft(node));
  node.querySelector("#existingCollectionSelect")?.addEventListener("change", (event) => {
    state.selectedCollectionId = event.target.value;
    state.uploadMode = "existing";
    render();
  });
  node.querySelector("#startNewExhibition")?.addEventListener("click", () => {
    state.uploadMode = "new";
    state.draftCollectionName = "";
    state.draftExhibitionName = "";
    state.draftExhibitionDate = "";
    render();
  });
  node.querySelector("#cancelNewExhibition")?.addEventListener("click", () => {
    state.uploadMode = "existing";
    state.draftCollectionName = "";
    state.draftExhibitionName = "";
    state.draftExhibitionDate = "";
    render();
  });
  node.querySelector("#createExhibitionBtn")?.addEventListener("click", async () => {
    const button = node.querySelector("#createExhibitionBtn");
    const errorNode = node.querySelector("#newExhibitionError");
    syncUploadDraft(node);
    const exhibitionName = (node.querySelector("#exhibitionName")?.value || "").trim();
    const collectionName = (node.querySelector("#collectionName")?.value || "").trim() || exhibitionName;
    if (!exhibitionName) {
      errorNode.textContent = "Enter the exhibition or event name first.";
      errorNode.classList.remove("hidden");
      node.querySelector("#exhibitionName")?.focus();
      return;
    }
    errorNode.classList.add("hidden");
    button.disabled = true;
    button.textContent = "Creating...";
    try {
      const result = await api("/api/collections", {
        method: "POST",
        body: {
          name: collectionName,
          exhibitionName,
          exhibitionDate: node.querySelector("#exhibitionDate")?.value || "",
          destinationType: "excel",
          destinationName: `${collectionName} contacts`
        }
      });
      await refreshAll();
      state.uploadMode = "existing";
      state.selectedCollectionId = result.collection.id;
      state.draftCollectionName = "";
      state.draftExhibitionName = "";
      state.draftExhibitionDate = "";
      state.message = {
        text: `${exhibitionName} created. New cards will be saved to this exhibition.`,
        bad: false
      };
      render();
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.classList.remove("hidden");
      button.disabled = false;
      button.textContent = "Create exhibition";
    }
  });
  const list = node.querySelector("#fileList");
  list.innerHTML = state.selectedFiles.map((file, index) => `
    <div class="file-item">
      <div class="card-side-previews">
        <figure><img class="file-thumb" src="${escapeAttr(file.previewUrl || "")}" alt="Front of selected card ${index + 1}" /><figcaption>Front</figcaption></figure>
        ${file.backSideFile ? `<figure><img class="file-thumb" src="${escapeAttr(file.backPreviewUrl || "")}" alt="Back of selected card ${index + 1}" /><figcaption>Back</figcaption></figure>` : ""}
      </div>
      <div class="file-info">
        <strong>${escapeHtml(file.name)}</strong>
        <div class="muted file-status">waiting to upload - ${formatBytes(file.size + (file.backSideFile?.size || 0))}</div>
        <div class="file-side-actions">
          <button class="link-button" type="button" data-add-back="${index}">${file.backSideFile ? "Replace back" : "Add back side"}</button>
          ${file.backSideFile ? `<button class="link-button danger-link" type="button" data-remove-back="${index}">Remove back</button>` : ""}
        </div>
      </div>
      <button class="secondary slim" data-remove-file="${index}">Remove card</button>
    </div>
  `).join("");
  list.querySelectorAll("[data-add-back]").forEach((btn) => btn.addEventListener("click", () => {
    syncUploadDraft(node);
    state.backSideTargetIndex = Number(btn.dataset.addBack);
    backSideInput.click();
  }));
  list.querySelectorAll("[data-remove-back]").forEach((btn) => btn.addEventListener("click", () => {
    const file = state.selectedFiles[Number(btn.dataset.removeBack)];
    if (file?.backPreviewUrl) URL.revokeObjectURL(file.backPreviewUrl);
    if (file) {
      delete file.backSideFile;
      delete file.backPreviewUrl;
    }
    render();
  }));
  list.querySelectorAll("[data-remove-file]").forEach((btn) => btn.addEventListener("click", () => {
    syncUploadDraft(node);
    const [removed] = state.selectedFiles.splice(Number(btn.dataset.removeFile), 1);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    if (removed?.backPreviewUrl) URL.revokeObjectURL(removed.backPreviewUrl);
    render();
  }));
  node.querySelector("#clearFilesBtn")?.addEventListener("click", () => {
    state.selectedFiles.forEach((file) => {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      if (file.backPreviewUrl) URL.revokeObjectURL(file.backPreviewUrl);
    });
    state.selectedFiles = [];
    render();
  });
  node.querySelector("#toggleUploadOptions").addEventListener("click", () => {
    syncUploadDraft(node);
    state.showUploadOptions = !state.showUploadOptions;
    render();
  });
  node.querySelector("#uploadBtn").addEventListener("click", () => uploadFiles(node));
  node.querySelector("#stageBtn")?.addEventListener("click", () => stagePendingFiles(node));
  return withUploadSubtabs(node);
}

// Wraps the Upload screen content with the [Scan / Upload] / [Pending] sub-tabs.
function withUploadSubtabs(content) {
  const pendingCount = pendingCards().length;
  const wrap = el(`
    <div class="upload-wrap">
      <div class="upload-subtabs" role="tablist" aria-label="Upload sections">
        <button type="button" role="tab" class="upload-subtab ${state.uploadTab !== "pending" ? "active" : ""}" data-upload-tab="scan" aria-selected="${state.uploadTab !== "pending"}">Scan / Upload</button>
        <button type="button" role="tab" class="upload-subtab ${state.uploadTab === "pending" ? "active" : ""}" data-upload-tab="pending" aria-selected="${state.uploadTab === "pending"}">Pending${pendingCount ? ` (${pendingCount})` : ""}</button>
      </div>
    </div>
  `);
  wrap.querySelectorAll("[data-upload-tab]").forEach((btn) => btn.addEventListener("click", () => {
    state.uploadTab = btn.dataset.uploadTab;
    clearMessage(false);
    render();
  }));
  wrap.appendChild(content);
  return wrap;
}

// The Pending sub-tab: staged cards awaiting a batch "Start processing".
function pendingPanel() {
  const pending = pendingCards();
  const node = el(`
    <section class="panel pending-panel">
      ${pending.length ? `
        <div class="pending-head">
          <div>
            <h2>Pending cards (${pending.length})</h2>
            <p class="muted">Add a voice note or the back of a card to any of these, then process them all together. Nothing is read until you tap Start processing.</p>
            <p class="quality-hint" role="note">
              <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 011-1h.01a1 1 0 110 2H10a1 1 0 01-1-1zm1-4a.75.75 0 01.75.75v.01a.75.75 0 01-1.5 0V5.75A.75.75 0 0110 5zm-.75 5.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5z" clip-rule="evenodd"/></svg>
              Tip: glance over the thumbnails first. Delete and re-take any card that looks blurry, cut off or glared &mdash; a clear photo reads far more accurately.
            </p>
          </div>
          <div class="pending-head-actions">
            <button type="button" id="startProcessing">Start processing (${pending.length})</button>
            <button type="button" class="secondary slim" id="clearPending">Clear all</button>
          </div>
        </div>
        <ul class="pending-list">${pending.map(pendingCardMarkup).join("")}</ul>
      ` : `
        <div class="pending-empty">
          <div class="pending-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="34" height="34"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/></svg>
          </div>
          <h2>No cards waiting</h2>
          <p class="muted">Cards you scan or upload wait here until you start processing them as a batch — ideal for capturing quickly at an event and reading them all later.</p>
          <button type="button" class="secondary" id="goScan">Scan or upload cards</button>
        </div>
      `}
    </section>
  `);
  node.querySelector("#startProcessing")?.addEventListener("click", startPendingProcessing);
  node.querySelector("#clearPending")?.addEventListener("click", clearPendingCards);
  node.querySelector("#goScan")?.addEventListener("click", () => { state.uploadTab = "scan"; render(); });
  node.querySelectorAll("[data-pending-voice]").forEach((btn) => btn.addEventListener("click", () => {
    const card = pending.find((c) => c.id === btn.dataset.pendingVoice);
    showVoiceNoteModal("card", [btn.dataset.pendingVoice], card?.originalFileName || "this card");
  }));
  node.querySelectorAll("[data-pending-delete]").forEach((btn) => btn.addEventListener("click", () => deletePendingCard(btn.dataset.pendingDelete)));
  return node;
}

function pendingCardMarkup(card) {
  const hasVoice = Boolean(card.extraction?.voiceTranscript);
  return `<li class="pending-card">
    <div class="pending-card-media">
      ${card.storageUrl ? `<img src="${escapeAttr(card.storageUrl)}" alt="Card ${escapeAttr(card.originalFileName || "")}" loading="lazy" />` : `<div class="pending-noimg">No preview</div>`}
      ${card.pairMode === "front-back" ? `<span class="pending-tag">Front + back</span>` : ""}
    </div>
    <div class="pending-card-body">
      <strong title="${escapeAttr(card.originalFileName || "Card")}">${escapeHtml(card.originalFileName || "Card")}</strong>
      ${hasVoice ? `<span class="pending-voice-badge"><span class="button-mic-icon" aria-hidden="true"></span>Voice note added</span>` : `<span class="pending-hint">No voice note yet</span>`}
      <div class="pending-card-actions">
        <button type="button" class="secondary slim" data-pending-voice="${escapeAttr(card.id)}"><span class="button-mic-icon" aria-hidden="true"></span>${hasVoice ? "Re-record" : "Add voice note"}</button>
        <button type="button" class="danger slim" data-pending-delete="${escapeAttr(card.id)}">Delete</button>
      </div>
    </div>
  </li>`;
}

async function startPendingProcessing() {
  const pending = pendingCards();
  if (!pending.length) return;
  try {
    const result = await api("/api/uploads/process-pending", { method: "POST", body: {} });
    await refreshAll();
    state.uploadTab = "scan";
    state.message = { text: `Processing ${result.queued} card(s). They move to Contacts automatically as they're read.`, bad: false };
    window.EasySaveNative?.haptic("success");
    navigateToView("review");
    ensureQueuePolling();
  } catch (err) {
    if (!handleScanBlocked(err)) setMessage(err.message, true);
  }
}

// Pay-to-start: on a 402 the account has no scan credits — prompt right there
// with both a one-time pack and a subscription, so they can pay and continue.
function handleScanBlocked(err) {
  if (err?.status === 402 || err?.data?.code === "payment_required") {
    showPaymentPrompt(err.message);
    return true;
  }
  return false;
}

function showPaymentPrompt(message) {
  const billing = state.overview?.billing || {};
  const planLabel = { monthly: "1 month", quarterly: "3 months", annual: "1 year" };
  const scansFor = { monthly: 150, quarterly: 300, annual: 1500 };
  const priceFor = { monthly: 499, quarterly: 799, annual: 2999 };
  const oneTime = (Array.isArray(billing.oneTimePlans) && billing.oneTimePlans.length
    ? billing.oneTimePlans.map((p) => p.plan)
    : ["monthly", "quarterly", "annual"]);
  const subs = (Array.isArray(billing.availablePlans) && billing.availablePlans.length
    ? billing.availablePlans
    : ["monthly", "quarterly", "annual"]);
  const optionBtn = (plan, attr) =>
    `<button type="button" class="pay-option${plan === "quarterly" ? " recommended" : ""}" ${attr}="${escapeAttr(plan)}">
      ${plan === "quarterly" ? `<span class="pay-option-badge">Most popular</span>` : ""}
      <span class="pay-option-name">${planLabel[plan] || plan}</span>
      <strong class="pay-option-price">&#8377;${priceFor[plan]}</strong>
      <span class="pay-option-scans">${scansFor[plan]} scans</span>
    </button>`;
  state.modal = {
    tone: "warn",
    className: "payment-modal",
    title: "Activate a plan to start scanning",
    body: message || "You've used up your free access. Choose a one-time pack or a subscription to keep scanning.",
    contentHtml: `
      <div class="pay-groups">
        <div class="pay-group">
          <div class="pay-group-head"><span class="pay-group-name">Pay once</span><span class="pay-group-tag">no auto-renewal</span></div>
          <div class="pay-options">${oneTime.map((p) => optionBtn(p, "data-pay-once")).join("")}</div>
        </div>
        <div class="pay-group">
          <div class="pay-group-head"><span class="pay-group-name">Subscribe</span><span class="pay-group-tag">auto-renews &middot; cancel anytime</span></div>
          <div class="pay-options">${subs.map((p) => optionBtn(p, "data-subscribe-plan")).join("")}</div>
        </div>
      </div>`,
    actions: [{ label: "See full pricing", className: "secondary", onClick: () => navigateToView("account") }],
    onRender: (node) => {
      node.querySelectorAll("[data-pay-once]").forEach((b) => b.addEventListener("click", () => { closeModal(false); startOneTimePlan(b.dataset.payOnce); }));
      node.querySelectorAll("[data-subscribe-plan]").forEach((b) => b.addEventListener("click", () => { closeModal(false); startSubscription(b.dataset.subscribePlan); }));
    }
  };
  render();
}

function clearPendingCards() {
  const pending = pendingCards();
  if (!pending.length) return;
  state.modal = {
    tone: "danger",
    title: `Delete ${pending.length} pending card(s)?`,
    body: "This removes the uploaded images without processing them. This cannot be undone.",
    cancelText: "Keep them",
    confirmText: "Delete all",
    confirmClass: "danger",
    onConfirm: async () => {
      try {
        await Promise.all(pending.map((card) => api(`/api/cards/${card.id}`, { method: "DELETE" })));
        await refreshAll();
        state.message = { text: "Pending cards cleared.", bad: false };
        render();
      } catch (err) {
        setMessage(err.message, true);
      }
    }
  };
  render();
}

async function deletePendingCard(cardId) {
  try {
    await api(`/api/cards/${cardId}`, { method: "DELETE" });
    await refreshAll();
    render();
  } catch (err) {
    setMessage(err.message, true);
  }
}

// Uploads the selected cards as "staged" (no AI read yet) and jumps to Pending.
async function stagePendingFiles(node) {
  if (!state.selectedFiles.length) return;
  const stageBtn = node.querySelector("#stageBtn");
  const originalText = stageBtn.textContent;
  stageBtn.disabled = true;
  stageBtn.textContent = "Adding…";
  try {
    const files = await Promise.all(state.selectedFiles.map(readCardFileData));
    const createNewCollection = !node.querySelector("#existingCollectionSelect");
    syncUploadDraft(node);
    const requestedCollectionName = (node.querySelector("#collectionName")?.value || "").trim();
    const requestedExhibitionName = (node.querySelector("#exhibitionName")?.value || "").trim() || requestedCollectionName;
    const body = {
      files,
      stage: true,
      createNewCollection,
      collectionId: createNewCollection ? "" : (node.querySelector("#existingCollectionSelect")?.value || state.selectedCollectionId || state.overview.activeCollection?.id || ""),
      collectionName: requestedCollectionName || requestedExhibitionName,
      exhibitionName: requestedExhibitionName,
      exhibitionDate: node.querySelector("#exhibitionDate")?.value || "",
      destinationType: state.overview.activeCollection?.destinationType || "excel",
      destinationName: destinationNameForUpload(node)
    };
    const result = await api("/api/uploads", { method: "POST", body });
    state.selectedFiles.forEach((file) => {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      if (file.backPreviewUrl) URL.revokeObjectURL(file.backPreviewUrl);
    });
    state.selectedFiles = [];
    await refreshAll();
    state.selectedCollectionId = result.collection?.id || "";
    state.uploadMode = "existing";
    state.showUploadSettings = false;
    state.showUploadOptions = false;
    state.draftCollectionName = "";
    state.draftExhibitionName = "";
    state.draftExhibitionDate = "";
    state.uploadTab = "pending";
    state.message = { text: `${result.cards.length} card(s) added to Pending. Add voice notes if you like, then tap Start processing when you're ready.`, bad: false };
    window.EasySaveNative?.haptic("success");
    render();
  } catch (err) {
    setMessage(err.message, true);
    stageBtn.disabled = false;
    stageBtn.textContent = originalText;
  }
}

async function uploadFiles(node) {
  const uploadBtn = node.querySelector("#uploadBtn");
  const processingPanel = node.querySelector("#uploadProcessing");
  const processingTitle = node.querySelector("#processingTitle");
  const processingEstimate = node.querySelector("#processingEstimate");
  const processingElapsed = node.querySelector("#processingElapsed");
  const cardCount = state.selectedFiles.length;
  const startedAt = Date.now();
  const preventExit = (event) => {
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", preventExit);
  window.EasySaveNative?.haptic("strong");
  processingPanel.classList.remove("hidden");
  processingEstimate.textContent = estimatedExtractionTime(cardCount);
  node.classList.add("upload-is-processing");
  window.requestAnimationFrame(() => processingPanel.scrollIntoView({ behavior: "smooth", block: "center" }));
  uploadBtn.disabled = true;
  uploadBtn.textContent = `Processing ${cardCount} card${cardCount === 1 ? "" : "s"}...`;
  node.querySelectorAll("input, select, summary, [data-remove-file], #clearFilesBtn, #toggleUploadOptions, #startNewExhibition, #cancelNewExhibition").forEach((control) => {
    control.disabled = true;
    control.setAttribute?.("aria-disabled", "true");
  });
  node.querySelectorAll(".file-status").forEach((status) => {
    status.innerHTML = `<span class="inline-spinner" aria-hidden="true"></span> Queued for extraction`;
  });
  const processingTip = node.querySelector("#processingTip");
  const processingBar = node.querySelector(".processing-track span");
  const estimateSeconds = estimatedExtractionSeconds(cardCount).expected;
  const tips = [
    "Tip: Add a voice note to a contact to remember what they wanted.",
    "Tip: Assign each contact to a teammate so no follow-up is missed.",
    "Good to know: every contact is auto-labelled with its exhibition and year.",
    "Tip: Export to Google Sheets once — it stays updated as you edit.",
    "Tip: Blurry card? You can re-scan just that one after review.",
    "Tip: Use filters on the Contacts tab to find leads by exhibition or owner.",
    "Almost there — your clean, ready-to-use contacts are being prepared."
  ];
  if (processingBar) {
    processingBar.style.animation = "none";
    processingBar.style.width = "6%";
  }
  if (processingTip) processingTip.textContent = tips[0];
  let tipIndex = 0;
  const timer = window.setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    processingElapsed.textContent = elapsedSeconds < 60
      ? `${elapsedSeconds} seconds elapsed`
      : `${Math.floor(elapsedSeconds / 60)} min ${elapsedSeconds % 60} sec elapsed`;
    const pct = Math.min(94, Math.round((elapsedSeconds / Math.max(1, estimateSeconds)) * 100));
    if (processingBar) processingBar.style.width = `${Math.max(6, pct)}%`;
    const remaining = Math.round(estimateSeconds - elapsedSeconds);
    processingEstimate.textContent = remaining > 5
      ? (remaining < 60 ? `About ${remaining} seconds left` : `About ${Math.ceil(remaining / 60)} min left`)
      : "Finishing up…";
    if (elapsedSeconds % 4 === 0 && processingTip) {
      tipIndex = (tipIndex + 1) % tips.length;
      processingTip.textContent = tips[tipIndex];
    }
  }, 1000);
  try {
    processingTitle.textContent = "Preparing card images";
    const files = await Promise.all(state.selectedFiles.map(readCardFileData));
    processingTitle.textContent = `Uploading ${cardCount} card${cardCount === 1 ? "" : "s"}`;
    node.querySelectorAll(".file-status").forEach((status) => {
      status.innerHTML = `<span class="inline-spinner" aria-hidden="true"></span> Uploading`;
    });
    const createNewCollection = !node.querySelector("#existingCollectionSelect");
    syncUploadDraft(node);
    const requestedCollectionName = (node.querySelector("#collectionName")?.value || "").trim();
    const requestedExhibitionName = (node.querySelector("#exhibitionName")?.value || "").trim() || requestedCollectionName;
    const body = {
      files,
      createNewCollection,
      collectionId: createNewCollection ? "" : (node.querySelector("#existingCollectionSelect")?.value || state.selectedCollectionId || state.overview.activeCollection?.id || ""),
      collectionName: requestedCollectionName || requestedExhibitionName,
      exhibitionName: requestedExhibitionName,
      exhibitionDate: node.querySelector("#exhibitionDate")?.value || "",
      destinationType: state.overview.activeCollection?.destinationType || "excel",
      destinationName: destinationNameForUpload(node)
    };
    const result = await api("/api/uploads", { method: "POST", body });
    // Not calling recordExtractionTime here anymore: uploading no longer runs
    // AI extraction inline (see the background queue processor), so timing
    // this request wouldn't measure extraction time and would corrupt the
    // calibration used for the progress estimate above.
    if (processingBar) processingBar.style.width = "100%";
    state.selectedFiles.forEach((file) => {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      if (file.backPreviewUrl) URL.revokeObjectURL(file.backPreviewUrl);
    });
    state.selectedFiles = [];
    await refreshAll();
    state.uploadMode = "existing";
    state.selectedCollectionId = result.collection?.id || "";
    state.showUploadSettings = false;
    state.showUploadOptions = false;
    state.draftCollectionName = "";
    state.draftExhibitionName = "";
    state.draftExhibitionDate = "";
    state.message = { text: `${result.cards.length} card(s) added. They're scanned automatically, a few at a time — you can add voice notes to any of them right away.`, bad: false };
    window.EasySaveNative?.haptic("success");
    navigateToView("review");
  } catch (err) {
    if (!handleScanBlocked(err)) setMessage(err.message, true);
  } finally {
    window.clearInterval(timer);
    window.removeEventListener("beforeunload", preventExit);
    uploadBtn.disabled = false;
    uploadBtn.textContent = "Upload and read cards";
  }
}

function estimatedExtractionSeconds(cardCount) {
  // Wall-clock seconds per card. Cards are read in parallel on the server, so this is
  // already an effective per-card figure (not the raw single-card latency). It self-
  // calibrates from real runs; the default is tuned for a typical batch.
  let secondsPerCard = 4.5;
  try {
    const saved = Number.parseFloat(localStorage.getItem("easysave.secondsPerCard"));
    if (Number.isFinite(saved) && saved >= 2 && saved <= 30) secondsPerCard = saved;
  } catch {
    // Use the default when browser storage is unavailable.
  }
  const n = Math.max(1, cardCount);
  const expected = 8 + n * secondsPerCard; // ~8s base for upload + save
  return {
    expected,
    lower: Math.max(12, Math.round(expected * 0.7)),
    upper: Math.max(20, Math.round(expected * 1.35))
  };
}

function estimatedExtractionTime(cardCount) {
  const { lower, upper } = estimatedExtractionSeconds(cardCount);
  if (upper < 90) return `About ${lower}-${upper} seconds`;
  const lowerMinutes = Math.max(1, Math.round(lower / 60));
  const upperMinutes = Math.max(lowerMinutes + 1, Math.ceil(upper / 60));
  return `About ${lowerMinutes}-${upperMinutes} minutes`;
}

function recordExtractionTime(cardCount, elapsedMs) {
  if (!cardCount || elapsedMs < 1000) return;
  const measured = Math.min(30, Math.max(2, elapsedMs / 1000 / cardCount));
  try {
    const previous = Number.parseFloat(localStorage.getItem("easysave.secondsPerCard"));
    const next = Number.isFinite(previous) ? previous * 0.6 + measured * 0.4 : measured;
    localStorage.setItem("easysave.secondsPerCard", next.toFixed(2));
  } catch {
    // Timing calibration is optional.
  }
}

function syncUploadDraft(node) {
  const collectionName = node.querySelector("#collectionName");
  const exhibitionName = node.querySelector("#exhibitionName");
  const exhibitionDate = node.querySelector("#exhibitionDate");
  if (collectionName) state.draftCollectionName = collectionName.value;
  if (exhibitionName) state.draftExhibitionName = exhibitionName.value;
  if (exhibitionDate) state.draftExhibitionDate = exhibitionDate.value;
}

function addSelectedFiles(fileList) {
  const incoming = Array.from(fileList || []);
  const seen = new Set(state.selectedFiles.map((file) => `${file.name}-${file.size}-${file.lastModified}`));
  for (const file of incoming) {
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (!seen.has(key)) {
      file.previewUrl = URL.createObjectURL(file);
      state.selectedFiles.push(file);
      seen.add(key);
    }
  }
  if (state.selectedFiles.length > 200) {
    state.selectedFiles.slice(200).forEach((file) => {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    });
    state.selectedFiles = state.selectedFiles.slice(0, 200);
    state.message = { text: "Up to 200 cards can be added at once. Upload this batch, then add more.", bad: true };
  }
  // Photos are compressed in the browser before upload (see readCardFileData),
  // so the actual request is a fraction of the raw size. Keep a generous ceiling
  // that comfortably fits 200 high-resolution phone photos.
  let totalBytes = state.selectedFiles.reduce((sum, file) => sum + Number(file.size || 0) + Number(file.backSideFile?.size || 0), 0);
  while (totalBytes > 600 * 1024 * 1024 && state.selectedFiles.length) {
    const removed = state.selectedFiles.pop();
    totalBytes -= Number(removed.size || 0);
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    state.message = { text: "This batch is very large. The last photo was removed — try uploading in two goes.", bad: true };
  }
}

function promptForBackSide(fileEntry, backSideInputEl) {
  state.modal = {
    tone: "info",
    title: "Scan the back too?",
    body: "If this card has extra details on the back — another number, address or QR code — scan it now. Otherwise skip and keep going.",
    actions: [
      {
        label: "Scan back",
        className: "primary",
        onClick: () => {
          const index = state.selectedFiles.indexOf(fileEntry);
          if (index === -1 || !backSideInputEl) return;
          state.backSideTargetIndex = index;
          backSideInputEl.click();
        }
      },
      { label: "Skip", className: "secondary", onClick: () => {} }
    ]
  };
  render();
}

function destinationNameForUpload(node) {
  const name = node.querySelector("#collectionName")?.value || node.querySelector("#exhibitionName")?.value || "New Sheet";
  return `${name} contacts`;
}

async function readFileData(file) {
  const processed = await preprocessImage(file);
  return {
    name: file.name,
    type: processed.type,
    size: processed.size,
    dataUrl: processed.dataUrl,
    originalSize: file.size,
    preprocessing: processed.preprocessing
  };
}

async function readCardFileData(file) {
  const front = await readFileData(file);
  if (!file.backSideFile) return front;
  const back = await readFileData(file.backSideFile);
  return {
    ...front,
    frontFileName: file.name,
    backName: file.backSideFile.name,
    backDataUrl: back.dataUrl,
    backType: back.type,
    backSize: back.size,
    originalSize: file.size + file.backSideFile.size,
    pairMode: "front-back",
    preprocessing: `${front.preprocessing}; back: ${back.preprocessing}`
  };
}

async function preprocessImage(file) {
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.type || "")) {
    return readOriginalFile(file, "Original image used; browser preprocessing is unavailable for this file type.");
  }
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.filter = "contrast(1.14) saturate(1.04)";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    return {
      type: "image/jpeg",
      size: Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75),
      dataUrl,
      preprocessing: "auto-oriented, resized, contrast enhanced"
    };
  } catch {
    return readOriginalFile(file, "Original image used; browser preprocessing failed.");
  }
}

function readOriginalFile(file, preprocessing) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ type: file.type, size: file.size, dataUrl: reader.result, preprocessing });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Staged cards live in the Upload → Pending sub-tab, not in Review.
function reviewCards() {
  return state.cards.filter((card) => card.status !== "staged");
}

function pendingCards() {
  return state.cards.filter((card) => card.status === "staged");
}

// After a card is scanned it is auto-saved and leaves the review queue, so the
// send action has to live here or the user has to go hunting in Contacts.
// One tap opens WhatsApp with the workspace's default message already filled.
function recentScansPanelHtml() {
  const recent = state.contacts
    .filter((c) => contactWhatsappNumber(c))
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 8);
  if (!recent.length) return "";
  const tpl = whatsappDefaultTemplate();
  return `
    <div class="recent-scans">
      <div class="recent-scans-head">
        <div>
          <strong>Just scanned</strong>
          <span class="muted">Tap to open WhatsApp with your message ready${tpl ? ` &middot; "${escapeHtml(tpl.name)}"` : ""}.</span>
        </div>
        <button type="button" class="secondary slim" id="recentScansSettings">Edit message</button>
      </div>
      <ul class="recent-scans-list">
        ${recent.map((c) => `
          <li>
            <span class="recent-scan-avatar" aria-hidden="true">${escapeHtml(contactInitials(c.name))}</span>
            <span class="recent-scan-text">
              <strong title="${escapeAttr(c.name)}">${escapeHtml(c.name)}</strong>
              <span class="muted">${escapeHtml([c.companyName, c.city].filter(Boolean).join(" · "))}</span>
            </span>
            <button type="button" class="row-btn whatsapp" data-quick-wa="${c.id}" title="Message ${escapeAttr(c.name)} on WhatsApp"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.65.08-.3-.15-1.25-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.53.07-.8.38-.28.3-1.05 1.02-1.05 2.5s1.08 2.9 1.23 3.1c.15.2 2.12 3.24 5.14 4.54.72.31 1.28.5 1.71.63.72.23 1.37.2 1.89.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z"/><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.15h-.01a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24a8.2 8.2 0 0 1 5.83 2.42 8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23z"/></svg>WhatsApp</button>
          </li>`).join("")}
      </ul>
    </div>`;
}

function wireRecentScans(node) {
  node.querySelector("#recentScansSettings")?.addEventListener("click", showWhatsappSettingsModal);
  node.querySelectorAll("[data-quick-wa]").forEach((btn) => btn.addEventListener("click", () => {
    const contact = state.contacts.find((c) => c.id === btn.dataset.quickWa);
    if (!contact) return;
    const number = contactWhatsappNumber(contact);
    if (!number) { setMessage("This contact has no usable WhatsApp number.", true); return; }
    const tpl = whatsappDefaultTemplate();
    window.open(whatsappLink(number, fillWhatsappTemplate(tpl ? tpl.body : "", contact, whatsappCatalogueUrl())), "_blank", "noopener");
  }));
}

function reviewView() {
  const cards = reviewCards();
  const validCount = cards.filter((card) => card.status === "completed" && card.extraction?.name && card.extraction?.mobileNumber).length;
  if (!cards.length) {
    const processedCount = Number(state.overview?.usage?.used || 0);
    const contactCount = state.contacts.length || 0;
    const emptyNode = el(`
      <section class="panel review-complete-state">
        <div class="review-complete-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="currentColor" width="36" height="36"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/></svg>
        </div>
        <h2>All cards processed</h2>
        <p class="muted">Great job! All queued cards have been processed and moved to Contacts &amp; Exports.</p>
        <div class="review-complete-stats">
          <div class="review-complete-stat">
            <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/></svg>
            <div><strong>${processedCount}</strong><span>Cards processed</span></div>
          </div>
          <div class="review-complete-stat">
            <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M7 8a3 3 0 100-6 3 3 0 000 6zM14.5 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.615 16.428a1.224 1.224 0 01-.569-1.175 6.002 6.002 0 0111.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 017 18a9.953 9.953 0 01-5.385-1.572zM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 00-1.588-3.755 4.502 4.502 0 015.874 2.636.818.818 0 01-.36.98A7.465 7.465 0 0114.5 16z"/></svg>
            <div><strong>${contactCount}</strong><span>Contacts added</span></div>
          </div>
        </div>
        <div class="review-complete-actions">
          <button type="button" data-empty-review-view="contacts">
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M7 8a3 3 0 100-6 3 3 0 000 6zM14.5 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.615 16.428a1.224 1.224 0 01-.569-1.175 6.002 6.002 0 0111.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 017 18a9.953 9.953 0 01-5.385-1.572zM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 00-1.588-3.755 4.502 4.502 0 015.874 2.636.818.818 0 01-.36.98A7.465 7.465 0 0114.5 16z"/></svg>
            Open Contacts &amp; Exports
          </button>
          <button type="button" class="secondary" data-empty-review-view="upload">
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M9.25 13.25a.75.75 0 001.5 0V4.636l2.955 3.129a.75.75 0 001.09-1.03l-4.25-4.5a.75.75 0 00-1.09 0l-4.25 4.5a.75.75 0 101.09 1.03L9.25 4.636v8.614z"/><path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z"/></svg>
            Upload more cards
          </button>
        </div>
        ${recentScansPanelHtml()}
      </section>
    `);
    wireRecentScans(emptyNode);
    emptyNode.querySelectorAll("[data-empty-review-view]").forEach((button) => {
      button.addEventListener("click", () => {
        clearMessage(false);
        navigateToView(button.dataset.emptyReviewView);
      });
    });
    return emptyNode;
  }
  const queuedCount = cards.filter((card) => card.status === "queued").length;
  const readyCount = cards.filter((card) => card.status === "completed").length;
  const remaining = Number(state.overview?.usage?.remaining ?? Infinity);
  const limitReached = queuedCount > 0 && remaining <= 0;
  const collectionName = escapeHtml(state.overview?.activeCollection?.exhibitionName || state.overview?.activeCollection?.name || "");
  const node = el(`
    <section class="panel review-panel">
      <div class="review-stats-bar">
        <div class="review-stat">
          <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z" clip-rule="evenodd"/></svg>
          <strong>${queuedCount}</strong> <span>In queue</span>
        </div>
        <div class="review-stat ready">
          <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/></svg>
          <strong>${readyCount}</strong> <span>Ready to save</span>
        </div>
        <div class="review-stat-actions">
          <button id="saveAllValid" class="secondary slim" ${validCount ? "" : "disabled"}>
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.949 5.684a1 1 0 00-1.898 0l-.683 2.051a1 1 0 01-.633.633l-2.052.683a1 1 0 000 1.898l2.052.684a1 1 0 01.633.632l.683 2.052a1 1 0 001.898 0l.683-2.052a1 1 0 01.633-.632l2.052-.684a1 1 0 000-1.898l-2.052-.683a1 1 0 01-.633-.633L6.95 5.684zM13.949 13.684a1 1 0 00-1.898 0l-.184.551a1 1 0 01-.632.633l-.551.183a1 1 0 000 1.898l.551.183a1 1 0 01.633.633l.183.551a1 1 0 001.898 0l.184-.551a1 1 0 01.632-.633l.551-.183a1 1 0 000-1.898l-.551-.184a1 1 0 01-.633-.632l-.183-.551z"/></svg>
            Save ready contacts (${validCount})
          </button>
          <button type="button" class="secondary slim" id="voiceBatch" ${cards.length ? "" : "disabled"}>
            <span class="button-mic-icon" aria-hidden="true"></span> Add voice note to batch
          </button>
        </div>
      </div>
      ${limitReached ? `<div class="notice bad review-limit-notice">
        <div>
          <strong>You've reached your plan's scan limit.</strong>
          <p>Queued cards will resume automatically once your plan resets. <button type="button" class="link-button" id="reviewLimitUpgrade">Upgrade or add scans</button> to continue processing now.</p>
        </div>
        <button type="button" class="secondary slim" id="reviewLimitUpgradeBtn">Upgrade now</button>
      </div>` : ""}
      ${recentScansPanelHtml()}
      <div class="review-list"></div>
      <div class="review-footer">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M15.988 3.012A2.25 2.25 0 0018 5.25v6.5A2.25 2.25 0 0015.75 14H13.5l-3.72 3.72a.75.75 0 01-1.28-.53v-3.19H5.25A2.25 2.25 0 013 11.75v-6.5A2.25 2.25 0 015.25 3h10.5c.085 0 .17.004.238.012z" clip-rule="evenodd"/></svg>
        Cards move to <button type="button" class="link-button" id="reviewGoContacts">Contacts &amp; Exports</button> automatically after processing.
      </div>
    </section>
  `);
  node.querySelector("#reviewLimitUpgrade")?.addEventListener("click", () => navigateToView("account"));
  node.querySelector("#reviewLimitUpgradeBtn")?.addEventListener("click", () => navigateToView("account"));
  node.querySelector("#reviewGoContacts")?.addEventListener("click", () => navigateToView("contacts"));
  node.querySelector("#saveAllValid").addEventListener("click", saveAllValidContacts);
  node.querySelector("#voiceBatch").addEventListener("click", () => {
    const ids = cards.map((card) => card.id);
    showVoiceNoteModal("batch", ids, `${ids.length} review card(s)`);
  });
  const list = node.querySelector(".review-list");
  cards.forEach((card, index) => list.appendChild(cardReview(card, index + 1)));
  return node;
}

async function saveAllValidContacts() {
  try {
    const result = await api("/api/cards/save-valid", { method: "POST", body: {} });
    await refreshAll();
    state.message = {
      text: `${result.saved} valid contact(s) saved. ${result.keptForReview} card(s) kept in review.`,
      bad: false
    };
    render();
  } catch (err) {
    setMessage(err.message, true);
  }
}

function reviewIssuesNotice(card) {
  const isDuplicateText = (w) => /uploaded before|matches another uploaded card/i.test(w);
  const isRotationText = (w) => /rotat|upside.?down|reorient/i.test(w);
  const raw = Array.isArray(card.extraction?.warnings) ? card.extraction.warnings : [];
  const seenIssues = new Set();
  const issues = raw.filter((w) => {
    if (isRotationText(w) || isDuplicateText(w)) return false;
    const key = String(w || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!key || seenIssues.has(key)) return false;
    seenIssues.add(key);
    return true;
  });
  if (card.duplicateImageOf) {
    issues.unshift("This image appears to have been uploaded before. You can still save it if it is a valid separate contact.");
  }
  if (!issues.length) return "";
  if (issues.length === 1) {
    return `<div class="notice bad">${escapeHtml(issues[0])}</div>`;
  }
  return `<div class="notice bad"><ul class="notice-list">${issues.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`;
}

function queuedCardReview(card, rowNum) {
  const node = el(`
    <article class="card-row review-card queued-card queued-card-compact">
      <span class="queued-row-num">${rowNum || ""}</span>
      ${card.storageUrl ? `<img class="queued-thumb" src="${card.storageUrl}" alt="Card ${escapeAttr(card.originalFileName)}" />` : `<span class="queued-thumb missing-image"></span>`}
      <div class="queued-card-info">
        <strong>${escapeHtml(card.originalFileName)}</strong>
        <span class="status warn">Waiting to scan</span>
      </div>
      <div class="queued-card-spinner-wrap">
        <div class="queued-card-spinner" aria-hidden="true"></div>
        <p class="muted">This card is in the queue.<br/>It will be scanned automatically.</p>
      </div>
      <div class="queued-card-actions">
        <button type="button" class="secondary slim" data-voice-card><span class="button-mic-icon" aria-hidden="true"></span> Add voice note</button>
        <button type="button" class="danger slim" data-delete-card><svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd"/></svg> Remove</button>
      </div>
    </article>
  `);
  node.querySelector("[data-voice-card]").addEventListener("click", () => {
    showVoiceNoteModal("card", [card.id], card.originalFileName || "this card");
  });
  node.querySelector("[data-delete-card]").addEventListener("click", async () => {
    state.modal = {
      tone: "danger",
      title: "Delete queued card?",
      body: "This removes the card before it's scanned.",
      detail: card.originalFileName,
      cancelText: "Keep card",
      confirmText: "Delete card",
      confirmClass: "danger",
      onConfirm: async () => {
        try {
          await api(`/api/cards/${card.id}`, { method: "DELETE" });
          await refreshAll();
          state.message = { text: "Card deleted.", bad: false };
          render();
        } catch (err) {
          setMessage(err.message, true);
        }
      }
    };
    render();
  });
  wireRecentScans(node);
  return node;
}

function cardReview(card, rowNum) {
  if (card.status === "queued") return queuedCardReview(card, rowNum);
  const fields = { ...card.extraction };
  const fieldConfidence = { ...(card.extraction?.fieldConfidence || {}) };
  normalizeReviewPhoneFields(fields, fieldConfidence);
  normalizeReviewEmailFields(fields, fieldConfidence);
  const busy = state.processingCards.has(card.id);
  const statusClass = card.status === "completed" || card.status === "saved" ? "ok" : card.status === "failed" ? "bad" : "warn";
  const node = el(`
    <article class="card-row review-card">
      <div class="review-card-media">
        ${card.storageUrl ? `<img class="card-image" src="${card.storageUrl}" alt="Uploaded business card ${escapeAttr(card.originalFileName)}" />` : `<div class="card-image missing-image">Image unavailable</div>`}
        <p><strong>${escapeHtml(card.originalFileName)}</strong></p>
        ${card.pairMode === "front-back" ? `<p class="muted">Front and back saved as one contact</p>` : ""}
        <div class="status-stack">
          <span class="status ${statusClass}">${busy ? "processing" : statusLabel(card.status)}</span>
          ${card.extraction?.verifiedBySecondPass ? `<span class="status ok">verified</span>` : ""}
        </div>
        ${voiceSummaryView(card.extraction)}
      </div>
      <form class="grid review-card-form">
        <div class="form-grid">
          ${contactFields.map((field) => inputField(field, fields[field] || "", field === "notes" || field === "address", fieldConfidence[field])).join("")}
        </div>
        ${reviewIssuesNotice(card)}
        <div class="actions review-card-actions">
          <button type="submit" ${busy || card.status === "failed" ? "disabled" : ""}>Save contact</button>
          <button type="button" class="secondary" data-voice-card><span class="button-mic-icon" aria-hidden="true"></span>Add voice note</button>
          <button type="button" class="secondary" data-reprocess-card ${busy || !card.storageUrl ? "disabled" : ""}>${card.status === "failed" ? "Retry failed card" : "Reprocess card"}</button>
          <button type="button" class="secondary" data-skip-card>Skip</button>
          <button type="button" class="danger" data-delete-card>Delete</button>
        </div>
      </form>
    </article>
  `);
  const form = node.querySelector("form");
  const primaryMobileInput = form.elements.namedItem("mobileNumber");
  const officeNumberInput = form.elements.namedItem("officeNumber");
  primaryMobileInput?.addEventListener("blur", () => normalizeReviewPhoneInputs(form));
  officeNumberInput?.addEventListener("blur", () => normalizeReviewPhoneInputs(form));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveCard(card.id, form);
  });
  form.addEventListener("keydown", async (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !busy && card.status !== "failed") {
      event.preventDefault();
      await saveCard(card.id, form);
    }
  });
  node.querySelector("[data-reprocess-card]").addEventListener("click", async () => {
    await reprocessCard(card.id);
  });
  node.querySelector("[data-voice-card]").addEventListener("click", () => {
    showVoiceNoteModal("card", [card.id], card.extraction?.name || card.originalFileName || "this card");
  });
  node.querySelector("[data-skip-card]").addEventListener("click", async () => {
    await api(`/api/cards/${card.id}/skip`, { method: "POST", body: {} });
    await refreshAll();
    state.message = { text: "Card skipped.", bad: false };
    render();
  });
  node.querySelector("[data-delete-card]").addEventListener("click", async () => {
    state.modal = {
      tone: "danger",
      title: "Delete scanned card?",
      body: "This removes the card from the review queue. Saved contacts will not be affected.",
      detail: card.originalFileName,
      cancelText: "Keep card",
      confirmText: "Delete card",
      confirmClass: "danger",
      onConfirm: async () => {
        try {
          await api(`/api/cards/${card.id}`, { method: "DELETE" });
          await refreshAll();
          state.message = { text: "Scanned card deleted from review.", bad: false };
          render();
        } catch (err) {
          setMessage(err.message, true);
        }
      }
    };
    render();
  });
  return node;
}

function normalizeReviewPhoneFields(fields, fieldConfidence = {}) {
  const primaryNumbers = String(fields.mobileNumber || "")
    .split(/\s*(?:\/|\||;|\bor\b|\r?\n)\s*/i)
    .map((value) => value.trim())
    .filter(Boolean);

  if (primaryNumbers.length > 1) {
    fields.mobileNumber = primaryNumbers.shift();
    fields.secondaryMobileNumber = [...primaryNumbers, fields.secondaryMobileNumber]
      .filter(Boolean)
      .join(" / ");
    if (!Number(fieldConfidence.secondaryMobileNumber)) {
      fieldConfidence.secondaryMobileNumber = fieldConfidence.mobileNumber || 0;
    }
  }

  if (String(fields.officeNumber || "").includes("/")) {
    fields.officeNumber = String(fields.officeNumber)
      .split(/\s*\/\s*/)
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" / ");
  }
}

function normalizeReviewEmailFields(fields, fieldConfidence = {}) {
  const emailValues = [fields.emailAddress, fields.secondaryEmail]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const emails = [];

  emailValues.forEach((value) => {
    if (isValidEmail(value)) {
      if (!emails.some((email) => email.toLowerCase() === value.toLowerCase())) emails.push(value);
    }
  });

  fields.emailAddress = emails[0] || "";
  fields.secondaryEmail = emails[1] || "";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(value || "").trim());
}

function inputField(field, value, multiline = false, confidence = undefined) {
  const required = field === "name" || field === "mobileNumber";
  const span = field === "address" || field === "notes" ? "span-3" : "";
  const confidenceValue = Number(confidence);
  const hasValue = Boolean(String(value || "").trim());
  const needsCheck = required
    && hasValue
    && Number.isFinite(confidenceValue)
    && confidenceValue > 0
    && confidenceValue < 70;
  const mobileInputAttributes = {
    mobileNumber: 'type="tel" inputmode="tel" autocomplete="off"',
    secondaryMobileNumber: 'type="tel" inputmode="tel" autocomplete="off"',
    tertiaryMobileNumber: 'type="tel" inputmode="tel" autocomplete="off"',
    officeNumber: 'type="tel" inputmode="tel" autocomplete="off"',
    emailAddress: 'type="email" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false"',
    secondaryEmail: 'type="email" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false"',
    website: 'type="text" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false"',
    exhibitionDate: 'type="date"'
  };
  const input = multiline
    ? `<textarea name="${field}" rows="3">${escapeHtml(value)}</textarea>`
    : `<input name="${field}" value="${escapeAttr(value)}" ${mobileInputAttributes[field] || ""} ${required ? "required" : ""} />`;
  return `
    <label class="${span} ${needsCheck ? "critical-field-warning" : ""}">
      <span class="field-label-row">
        <span>${fieldLabels[field]}${required ? " *" : ""}</span>
        ${needsCheck ? `<span class="field-check">Please check</span>` : ""}
      </span>
      ${input}
    </label>
  `;
}

async function reprocessCard(cardId) {
  state.processingCards.add(cardId);
  render();
  try {
    await api(`/api/cards/${cardId}/reprocess`, { method: "POST", body: {} });
    await refreshAll();
    state.message = { text: "Card reprocessed. Review the updated fields before saving.", bad: false };
  } catch (err) {
    state.message = { text: err.message, bad: true };
  } finally {
    state.processingCards.delete(cardId);
    render();
  }
}

async function saveCard(cardId, form, duplicateAction = "") {
  normalizeReviewPhoneInputs(form);
  normalizeReviewEmailInputs(form);
  const fields = Object.fromEntries(new FormData(form).entries());
  if (duplicateAction) fields.duplicateAction = duplicateAction;
  try {
    await api(`/api/cards/${cardId}/save`, { method: "POST", body: { fields } });
    await refreshAll();
    state.message = { text: "Contact saved to the current sheet/export.", bad: false };
    render();
  } catch (err) {
    if (err.status === 409 && err.data?.duplicate) {
      showDuplicateModal(cardId, form, err.data.duplicate);
      return;
    }
    setMessage(err.message, true);
  }
}

function normalizeReviewPhoneInputs(form) {
  const primaryInput = form.elements.namedItem("mobileNumber");
  const secondaryInput = form.elements.namedItem("secondaryMobileNumber");
  const officeInput = form.elements.namedItem("officeNumber");

  if (primaryInput instanceof HTMLInputElement && secondaryInput instanceof HTMLInputElement) {
    const numbers = primaryInput.value
      .split(/\s*(?:\/|\||;|\bor\b|\r?\n)\s*/i)
      .map((value) => value.trim())
      .filter(Boolean);
    if (numbers.length > 1) {
      primaryInput.value = numbers.shift();
      const existingSecondary = secondaryInput.value.trim();
      secondaryInput.value = [...numbers, existingSecondary]
        .filter(Boolean)
        .join(" / ");
    }
  }

  if (officeInput instanceof HTMLInputElement && officeInput.value.includes("/")) {
    officeInput.value = officeInput.value
      .split(/\s*\/\s*/)
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" / ");
  }
}

function normalizeReviewEmailInputs(form) {
  const primaryInput = form.elements.namedItem("emailAddress");
  const secondaryInput = form.elements.namedItem("secondaryEmail");
  if (!(primaryInput instanceof HTMLInputElement) || !(secondaryInput instanceof HTMLInputElement)) return;

  const values = [primaryInput.value, secondaryInput.value]
    .map((value) => value.trim())
    .filter(Boolean);
  const emails = [];

  values.forEach((value) => {
    if (isValidEmail(value)) {
      if (!emails.some((email) => email.toLowerCase() === value.toLowerCase())) emails.push(value);
    }
  });

  primaryInput.value = emails[0] || "";
  secondaryInput.value = emails[1] || "";
}

function showDuplicateModal(cardId, form, duplicate) {
  const details = [
    duplicate.name,
    duplicate.mobileNumber,
    duplicate.companyName
  ].filter(Boolean).join(" | ");
  state.modal = {
    tone: "warn",
    title: "Duplicate mobile number found",
    body: "A saved contact already uses this mobile number. Choose how you want to handle the scanned card.",
    detail: details || "Existing contact found",
    actions: [
      {
        label: "Update existing",
        className: "warning",
        onClick: () => saveCard(cardId, form, "update_existing")
      },
      {
        label: "Merge information",
        className: "secondary",
        onClick: () => saveCard(cardId, form, "merge_information")
      },
      {
        label: "Keep both",
        className: "secondary",
        onClick: () => saveCard(cardId, form, "keep_both")
      },
      {
        label: "Skip new contact",
        className: "danger",
        onClick: () => saveCard(cardId, form, "skip")
      },
      {
        label: "Cancel",
        className: "secondary",
        onClick: () => {}
      }
    ]
  };
  render();
}

function voiceSummaryView(source) {
  // Queued cards carry extraction: null, and a default parameter only fills in
  // for undefined — so guard explicitly rather than relying on `source = {}`.
  if (!source) return "";
  const hasVoice = source.interest || source.specialRequirement || source.budget || source.followUpDate || source.voiceTranscript || source.voiceAudioUrl;
  if (!hasVoice) return "";
  return `
    <div class="voice-summary">
      <strong>Voice note</strong>
      ${source.voiceTranscript ? `<span>Transcript: ${escapeHtml(source.voiceTranscript)}</span>` : ""}
      ${source.interest ? `<span>Interest: ${escapeHtml(source.interest)}</span>` : ""}
      ${source.budget ? `<span>Budget: ${escapeHtml(source.budget)}</span>` : ""}
      ${source.followUpDate ? `<span>Follow-up: ${escapeHtml(source.followUpDate)}</span>` : ""}
      ${source.specialRequirement ? `<span>Requirement: ${escapeHtml(source.specialRequirement)}</span>` : ""}
      ${source.voiceAudioUrl ? `<audio controls preload="none" src="${escapeAttr(source.voiceAudioUrl)}"></audio>` : ""}
    </div>
  `;
}

function showVoiceNoteModal(targetType, targetIds, targetLabel) {
  const targetCount = targetIds.length;
  state.modal = {
    tone: "voice",
    iconHtml: `<span class="mic-symbol" aria-hidden="true"></span>`,
    title: "Add voice note",
    body: targetCount > 1
      ? `Record one common note. It will not be applied until you confirm it for ${targetLabel}.`
      : `Record a note for ${targetLabel}. You can review the transcript before applying it.`,
    className: "wide-dialog",
    actions: [{ label: "Close", className: "secondary", onClick: () => {} }],
    contentHtml: `
      <div class="voice-note-panel">
        <div class="voice-recorder" id="voiceRecorder">
          <div class="voice-live-header">
            <div class="voice-mic-orb"><span class="mic-symbol" aria-hidden="true"></span></div>
            <div><strong id="voiceLiveLabel">Ready to record</strong><span id="voiceTimer">00:00</span></div>
          </div>
          <canvas id="voiceWaveform" class="voice-waveform" width="960" height="150" aria-label="Live microphone level"></canvas>
          <div class="voice-record-actions" id="voiceInitialActions">
            <button type="button" id="voiceRecordBtn"><span class="button-mic-icon" aria-hidden="true"></span> Start recording</button>
            <button type="button" class="voice-stop" id="voiceStopBtn" disabled><span class="stop-symbol" aria-hidden="true"></span> Stop recording</button>
          </div>
        </div>
        <p class="voice-help">Speak naturally in Hindi, English, or Hinglish. Your exact transcript will be saved with the contact.</p>
        <audio id="voicePreview" class="hidden" controls></audio>
        <div id="voiceRecordedActions" class="voice-note-controls hidden">
          <button type="button" class="secondary" id="voiceRerecordBtn">Re-record</button>
          <button type="button" class="voice-delete" id="voiceDeleteBtn">Delete recording</button>
          <button type="button" class="secondary hidden" id="voiceTranscribeBtn">Retry transcription</button>
        </div>
        <div id="voiceStatus" class="notice compact">Record a short voice note, ideally under 30 seconds.</div>
        <div id="voiceResult" class="voice-result hidden">
          <p class="voice-edit-hint muted">Review the transcript and fields below. You can edit anything or fill in blanks before applying.</p>
          <label>Voice-note transcript <textarea id="voiceTranscript" rows="4" placeholder="What was said (edit if the transcription got anything wrong)"></textarea></label>
          <div class="grid two">
            <label>Interest <input id="voiceInterest" placeholder="e.g. bridal collection" /></label>
            <label>Budget <input id="voiceBudget" placeholder="e.g. 2 lakh" /></label>
            <label>Follow-up <input id="voiceFollowUp" placeholder="e.g. next week" /></label>
            <label>Special requirement <input id="voiceRequirement" placeholder="e.g. custom sizing" /></label>
          </div>
          <div id="voiceAudioLink"></div>
        </div>
        <div class="voice-apply-row"><button type="button" id="voiceApplyBtn" disabled>Apply voice note</button></div>
      </div>
    `,
    onRender: (node) => setupVoiceRecorder(node, targetType, targetIds, targetLabel)
  };
  render();
}

function setupVoiceRecorder(node, targetType, targetIds, targetLabel) {
  const recorderPanel = node.querySelector("#voiceRecorder");
  const liveLabel = node.querySelector("#voiceLiveLabel");
  const timerLabel = node.querySelector("#voiceTimer");
  const canvas = node.querySelector("#voiceWaveform");
  const initialActions = node.querySelector("#voiceInitialActions");
  const recordedActions = node.querySelector("#voiceRecordedActions");
  const recordBtn = node.querySelector("#voiceRecordBtn");
  const stopBtn = node.querySelector("#voiceStopBtn");
  const rerecordBtn = node.querySelector("#voiceRerecordBtn");
  const deleteBtn = node.querySelector("#voiceDeleteBtn");
  const transcribeBtn = node.querySelector("#voiceTranscribeBtn");
  const applyBtn = node.querySelector("#voiceApplyBtn");
  const status = node.querySelector("#voiceStatus");
  const preview = node.querySelector("#voicePreview");
  const pauseForNativeLifecycle = () => {
    if (recorder && recorder.state !== "inactive") stopActiveRecording();
  };
  document.addEventListener("easysave:native-pause", pauseForNativeLifecycle);
  const resultBox = node.querySelector("#voiceResult");
  let recorder = null;
  let chunks = [];
  let audioBlob = null;
  let audioDataUrl = "";
  let voiceNote = null;
  let stream = null;
  let audioContext = null;
  let analyser = null;
  let animationFrame = null;
  let timerInterval = null;
  let recordingStartedAt = 0;
  let previewUrl = "";
  let disposed = false;
  const canvasContext = canvas.getContext("2d");

  const setStatus = (message, bad = false) => {
    status.className = `notice compact ${bad ? "bad" : ""}`;
    status.textContent = message;
  };

  const formatElapsed = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };

  const resizeCanvas = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.floor(rect.width * ratio));
    const height = Math.max(90, Math.floor(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width, height, ratio };
  };

  const drawWaveform = (levels = null) => {
    const { width, height, ratio } = resizeCanvas();
    canvasContext.clearRect(0, 0, width, height);
    const barCount = 52;
    const gap = 4 * ratio;
    const barWidth = Math.max(2 * ratio, (width - gap * (barCount - 1)) / barCount);
    const center = height / 2;
    for (let index = 0; index < barCount; index += 1) {
      const sourceIndex = levels ? Math.floor((index / barCount) * levels.length) : index;
      const strength = levels ? levels[sourceIndex] / 255 : 0.07 + 0.035 * Math.sin(index * 0.7);
      const barHeight = Math.max(4 * ratio, strength * height * 0.82);
      canvasContext.fillStyle = levels ? "#8f63aa" : "#c9d8d7";
      canvasContext.fillRect(index * (barWidth + gap), center - barHeight / 2, barWidth, barHeight);
    }
  };

  const drawLiveWaveform = () => {
    if (!analyser || disposed) return;
    const levels = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(levels);
    drawWaveform(levels);
    animationFrame = requestAnimationFrame(drawLiveWaveform);
  };

  const stopVisualization = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
  };

  const releaseMicrophone = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (audioContext) audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
    stopVisualization();
  };

  const revokePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    preview.pause();
    preview.removeAttribute("src");
    preview.load();
  };

  const deleteDraftNote = async () => {
    if (!voiceNote || voiceNote.status === "applied") return;
    const noteId = voiceNote.id;
    voiceNote = null;
    await api(`/api/voice-notes/${noteId}`, { method: "DELETE" });
  };

  const resetRecording = () => {
    releaseMicrophone();
    revokePreview();
    chunks = [];
    audioBlob = null;
    audioDataUrl = "";
    voiceNote = null;
    recorder = null;
    recorderPanel.classList.remove("recording", "recorded");
    liveLabel.textContent = "Ready to record";
    timerLabel.textContent = "00:00";
    preview.classList.add("hidden");
    recordedActions.classList.add("hidden");
    initialActions.classList.remove("hidden");
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    transcribeBtn.disabled = false;
    transcribeBtn.classList.add("hidden");
    applyBtn.disabled = true;
    applyBtn.dataset.confirmed = "";
    applyBtn.textContent = "Apply voice note";
    resultBox.classList.add("hidden");
    node.querySelector("#voiceAudioLink").innerHTML = "";
    drawWaveform();
  };

  const stopActiveRecording = () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  const transcribeRecording = async () => {
    if (!audioDataUrl || !audioBlob) return;
    transcribeBtn.disabled = true;
    transcribeBtn.classList.add("hidden");
    applyBtn.disabled = true;
    liveLabel.textContent = "Transcribing voice note";
    setStatus("Creating the transcript automatically...");
    try {
      const response = await api("/api/voice-notes/transcribe", {
        method: "POST",
        body: {
          targetType,
          targetIds,
          audioDataUrl,
          mimeType: audioBlob.type
        }
      });
      voiceNote = response.voiceNote;
      const heardSpeech = Boolean(String(voiceNote.transcript || "").trim());
      node.querySelector("#voiceTranscript").value = voiceNote.transcript || "";
      node.querySelector("#voiceInterest").value = voiceNote.interest || "";
      node.querySelector("#voiceBudget").value = voiceNote.budget || "";
      node.querySelector("#voiceFollowUp").value = voiceNote.followUpDate || "";
      node.querySelector("#voiceRequirement").value = voiceNote.specialRequirement || "";
      node.querySelector("#voiceAudioLink").innerHTML = voiceNote.audioUrl ? `<audio controls preload="none" src="${escapeAttr(voiceNote.audioUrl)}"></audio>` : "";
      resultBox.classList.remove("hidden");
      applyBtn.disabled = false;
      if (!heardSpeech) {
        // The recording produced audio but no words came back — almost always a
        // muted/blocked mic or a silent room. Say so plainly instead of the
        // misleading "Transcript ready", and let them re-record or type it in.
        liveLabel.textContent = "No speech detected";
        transcribeBtn.disabled = false;
        transcribeBtn.classList.remove("hidden");
        setStatus("We couldn't hear any speech in that recording. Check that your microphone is on and not muted, then tap Re-record — or type the note below.", true);
      } else {
        liveLabel.textContent = "Voice note ready";
        const confirmText = targetIds.length > 1
          ? `Review carefully. Apply only if this note belongs to all ${targetLabel}.`
          : "Transcript ready. Review it, then apply the voice note.";
        setStatus(confirmText);
      }
      window.requestAnimationFrame(() => resultBox.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    } catch (err) {
      transcribeBtn.disabled = false;
      transcribeBtn.classList.remove("hidden");
      liveLabel.textContent = "Transcription needs attention";
      setStatus(`${err.message} You can retry without recording again.`, true);
    }
  };

  const startRecording = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      const preferredMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      recorder = MediaRecorder.isTypeSupported(preferredMime)
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);
      const actualMime = recorder.mimeType || preferredMime;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) chunks.push(event.data);
      });
      recorder.addEventListener("stop", async () => {
        releaseMicrophone();
        if (disposed) return;
        audioBlob = new Blob(chunks, { type: actualMime });
        if (!audioBlob.size) {
          resetRecording();
          setStatus("No audio was captured. Please check the microphone and try again.", true);
          return;
        }
        audioDataUrl = await blobToDataUrl(audioBlob);
        revokePreview();
        previewUrl = URL.createObjectURL(audioBlob);
        preview.src = previewUrl;
        preview.classList.remove("hidden");
        initialActions.classList.add("hidden");
        recordedActions.classList.remove("hidden");
        recorderPanel.classList.remove("recording");
        recorderPanel.classList.add("recorded");
        liveLabel.textContent = "Recording complete";
        transcribeBtn.disabled = true;
        transcribeBtn.classList.add("hidden");
        setStatus("Recording complete. Card2Leads is preparing the transcript...");
        drawWaveform();
        await transcribeRecording();
      }, { once: true });

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioContext = new AudioContextClass();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
      }

      recorder.start(250);
      window.EasySaveNative?.haptic("light");
      recordingStartedAt = Date.now();
      recorderPanel.classList.add("recording");
      recorderPanel.classList.remove("recorded");
      liveLabel.textContent = "Recording your voice note";
      recordBtn.disabled = true;
      stopBtn.disabled = false;
      applyBtn.disabled = true;
    setStatus("Recording is live. The moving waveform confirms your microphone is active.");
      drawLiveWaveform();
      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
        timerLabel.textContent = formatElapsed(elapsed);
        if (elapsed >= 60) stopActiveRecording();
      }, 250);
    } catch (err) {
      releaseMicrophone();
      recordBtn.disabled = false;
      stopBtn.disabled = true;
      recorderPanel.classList.remove("recording");
      setStatus(err.message || "Microphone permission was blocked.", true);
      drawWaveform();
    }
  };

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    recordBtn.disabled = true;
    setStatus("This browser does not support microphone recording. Try Chrome on desktop/mobile.", true);
    return;
  }

  recordBtn.addEventListener("click", startRecording);
  stopBtn.addEventListener("click", () => {
    stopActiveRecording();
    stopBtn.disabled = true;
    liveLabel.textContent = "Preparing playback";
  });

  rerecordBtn.addEventListener("click", async () => {
    rerecordBtn.disabled = true;
    try {
      await deleteDraftNote();
      resetRecording();
      await startRecording();
    } catch (err) {
      rerecordBtn.disabled = false;
      setStatus(err.message || "The previous recording could not be removed.", true);
    }
  });

  deleteBtn.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    try {
      await deleteDraftNote();
      resetRecording();
      setStatus("Recording deleted. You can record a new voice note when ready.");
    } catch (err) {
      deleteBtn.disabled = false;
      setStatus(err.message || "The recording could not be deleted.", true);
    }
  });

  transcribeBtn.addEventListener("click", transcribeRecording);

  applyBtn.addEventListener("click", async () => {
    if (!voiceNote) return;
    if (targetIds.length > 1 && applyBtn.dataset.confirmed !== "true") {
      applyBtn.dataset.confirmed = "true";
      applyBtn.textContent = `Confirm apply to ${targetIds.length}`;
      setStatus(`Confirm only if this note belongs to all ${targetLabel}. Click the button again to apply.`);
      return;
    }
    applyBtn.disabled = true;
    setStatus("Applying voice note...");
    try {
      const result = await api(`/api/voice-notes/${voiceNote.id}/apply`, {
        method: "POST",
        body: {
          targetIds,
          transcript: node.querySelector("#voiceTranscript").value,
          interest: node.querySelector("#voiceInterest").value,
          budget: node.querySelector("#voiceBudget").value,
          followUpDate: node.querySelector("#voiceFollowUp").value,
          specialRequirement: node.querySelector("#voiceRequirement").value
        }
      });
      await refreshAll();
      closeModal(false);
      state.message = { text: `Voice note applied to ${result.applied} record(s).`, bad: false };
      render();
    } catch (err) {
      applyBtn.disabled = false;
      setStatus(err.message, true);
    }
  });

  if (!state.modal) {
    // The modal was dismissed before this deferred onRender ran; clean up now.
    stopActiveRecording();
    releaseMicrophone();
    revokePreview();
    return;
  }
  state.modal.onClose = () => {
    disposed = true;
    document.removeEventListener("easysave:native-pause", pauseForNativeLifecycle);
    stopActiveRecording();
    releaseMicrophone();
    revokePreview();
  };
  drawWaveform();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function contactsView() {
  const filters = state.contactFilters || { exhibition: "", assignee: "", city: "", state: "" };
  const visibleContacts = state.contacts.filter((contact) => {
    if (filters.exhibition && (contact.exhibitionName || "") !== filters.exhibition) return false;
    if (filters.assignee === "__unassigned" && contact.assignedToId) return false;
    if (filters.assignee && filters.assignee !== "__unassigned" && contact.assignedToId !== filters.assignee) return false;
    if (filters.city && (contact.city || "") !== filters.city) return false;
    if (filters.state && (contact.state || "") !== filters.state) return false;
    return true;
  });
  const exhibitionNames = [...new Set(state.contacts.map((contact) => contact.exhibitionName).filter(Boolean))].sort();
  const cityNames = [...new Set(state.contacts.map((contact) => contact.city).filter(Boolean))].sort();
  const stateNames = [...new Set(state.contacts.map((contact) => contact.state).filter(Boolean))].sort();
  const filtersActive = Boolean(filters.exhibition || filters.assignee || filters.city || filters.state);
  const selectedIds = visibleContacts.filter((contact) => state.selectedContactIds.has(contact.id)).map((contact) => contact.id);
  const allVisibleSelected = visibleContacts.length > 0 && selectedIds.length === visibleContacts.length;
  const activeCollectionId = state.overview.activeCollection?.id || state.overview.collections?.find((collection) => collection.status !== "deleted")?.id || "";
  const activeCollection = state.overview.collections?.find((collection) => collection.id === activeCollectionId) || state.overview.activeCollection;
  const google = state.overview.google || {};
  const hasGoogleSheet = Boolean(activeCollection?.spreadsheetId);
  const peopleButtonLabel = state.googleContactsSyncing
    ? `Saving ${selectedIds.length} contact(s)...`
    : !selectedIds.length
      ? "Select contacts to save"
      : allVisibleSelected
        ? `Save all ${selectedIds.length} contacts to Google Contacts`
        : `Save ${selectedIds.length} selected contact(s) to Google Contacts`;
  const sheetsAction = !google.configured
    ? `<span class="muted">Google OAuth credentials are not configured.</span>`
    : !google.sheetsConnected
      ? `<a class="primary button-link" href="/api/google/connect?feature=sheets">Connect Google Sheets</a>`
      : hasGoogleSheet
        ? `<button type="button" id="syncContactsGoogleSheet">Sync current exhibition</button>${activeCollection?.spreadsheetUrl ? `<a class="secondary button-link" href="${escapeAttr(activeCollection.spreadsheetUrl)}" target="_blank" rel="noreferrer">Open sheet</a>` : ""}`
        : `<button type="button" id="createContactsGoogleSheet">Create Google Sheet</button>`;
  const peopleAction = !google.configured
    ? `<span class="muted">Google OAuth credentials are not configured.</span>`
    : !google.contactsConnected
      ? `<a class="secondary button-link" href="/api/google/connect?feature=contacts">Connect Google Contacts</a>`
      : `<button type="button" class="secondary" id="syncGoogleContacts" ${!selectedIds.length || state.googleContactsSyncing ? "disabled" : ""}>${escapeHtml(peopleButtonLabel)}</button>`;
  const assigneeFilterLabel = filters.assignee === "__unassigned"
    ? "Unassigned"
    : filters.assignee
      ? (state.teamMembers.find((m) => m.id === filters.assignee)?.name || "")
      : "";
  // Downloads follow the on-screen filters when any are set, and the menu then
  // also offers an explicit unfiltered option so both flows are reachable.
  const downloadFilterActive = filtersActive || Boolean(state.contactSearchQuery);
  const exportMenu = activeCollectionId ? `
    <details class="export-sync-menu">
      <summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download files</summary>
      <div class="export-sync-popover">
        <span class="export-sync-heading">Download</span>
        <select class="export-member-select" id="exportScopeSelect" aria-label="Choose which contacts to download">
          ${downloadFilterActive ? `<option value="filters" selected>Matching current filters (${visibleContacts.length})</option>` : ""}
          <option value="all"${downloadFilterActive ? "" : " selected"}>All contacts (${state.contacts.length})</option>
          ${state.teamMembers.map((m) => {
            const count = state.contacts.filter((c) => c.assignedToId === m.id).length;
            return `<option value="member:${m.id}">${escapeHtml(m.name)} (${count})</option>`;
          }).join("")}
          ${state.contacts.some((c) => !c.assignedToId) ? `<option value="unassigned">Unassigned (${state.contacts.filter((c) => !c.assignedToId).length})</option>` : ""}
        </select>
        <span class="export-member-hint" id="exportScopeHint"></span>
        <a data-scope-export="xlsx" href="${exportHref("xlsx", activeCollectionId, [], true, downloadFilterActive)}">Excel spreadsheet</a>
        <a data-scope-export="csv" href="${exportHref("csv", activeCollectionId, [], true, downloadFilterActive)}">CSV file</a>
        <a data-scope-export="vcf" href="${exportHref("vcf", activeCollectionId, [], true, downloadFilterActive)}">VCF (phone contacts)</a>
        <span class="export-sync-heading">Google</span>
        ${!google.configured
          ? `<span class="export-sync-note">Google integration is not configured.</span>`
          : !google.sheetsConnected
            ? `<a href="/api/google/connect?feature=sheets">Connect Google Sheets</a>`
            : hasGoogleSheet
              ? `<button type="button" data-menu-action="sync-sheet">Sync Google Sheet</button>`
              : `<button type="button" data-menu-action="create-sheet">Create Google Sheet</button>`}
        ${!google.configured
          ? ""
          : !google.contactsConnected
            ? `<a href="/api/google/connect?feature=contacts">Connect Google Contacts</a>`
            : `<button type="button" data-menu-action="sync-contacts">Import into Google Contacts</button>`}
      </div>
    </details>
  ` : "";
  const assignedCount = state.contacts.filter((c) => c.assignedToId).length;
  const extendedView = state.contactsTableView === "extended";
  const syncedCount = state.contacts.filter((c) => c.googleContactsSyncStatus === "synced").length;
  const exhibitionLabel = activeCollection?.exhibitionName || activeCollection?.name || exhibitionNames[0] || "";
  const googleGlyph = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M23 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.16a5.27 5.27 0 0 1-2.28 3.46v2.88h3.7C21.7 18.89 23 15.9 23 12.27z"/><path fill="#34A853" d="M12 23.5c3.08 0 5.66-1.02 7.55-2.77l-3.7-2.87c-1.02.69-2.33 1.1-3.85 1.1-2.96 0-5.47-2-6.37-4.69H1.8v2.95A11.42 11.42 0 0 0 12 23.5z"/><path fill="#FBBC05" d="M5.63 14.27a6.85 6.85 0 0 1 0-4.38V6.94H1.8a11.44 11.44 0 0 0 0 10.28l3.83-2.95z"/><path fill="#EA4335" d="M12 5.32c1.67 0 3.17.58 4.35 1.71l3.26-3.26C17.65 1.9 15.07.8 12 .8A11.42 11.42 0 0 0 1.8 6.94l3.83 2.95c.9-2.69 3.41-4.57 6.37-4.57z"/></svg>`;
  const node = el(`
    <section class="panel contacts-panel">
      <div class="contacts-layout">
        <div class="contacts-primary">
      <div class="contacts-workflow-cards">
        <div class="workflow-card">
          <div class="workflow-card-top"><span class="workflow-step">1</span><strong>Sync to Google</strong></div>
          <div class="workflow-card-body">
            <span class="workflow-icon icon-blue" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
            <div class="workflow-desc">
              <span>Contacts saved in Google with label:</span>
              ${exhibitionLabel ? `<span class="workflow-chip">${escapeHtml(exhibitionLabel)}</span>` : ""}
            </div>
          </div>
          ${!google.configured
            ? `<span class="workflow-note">Google is not configured yet.</span>`
            : !google.contactsConnected
              ? `<a class="workflow-btn primary" href="/api/google/connect?feature=contacts">${googleGlyph} Connect Google</a>`
              : `<button type="button" class="workflow-btn primary" id="workflowSyncContacts" ${state.googleContactsSyncing ? "disabled" : ""}>${googleGlyph} ${state.googleContactsSyncing ? "Syncing…" : selectedIds.length ? `Sync ${selectedIds.length} contact${selectedIds.length === 1 ? "" : "s"}` : "Sync contacts"}</button>`}
          ${!google.configured
            ? ""
            : !google.sheetsConnected
              ? `<a class="workflow-btn ghost" href="/api/google/connect?feature=sheets">${googleGlyph} Connect Google Sheets</a>`
              : !activeCollectionId
                ? `<span class="workflow-note">Choose an exhibition to sync its sheet.</span>`
                : hasGoogleSheet
                  ? `<button type="button" class="workflow-btn ghost" id="workflowSyncSheet">${googleGlyph} Sync Google Sheet</button>`
                  : `<button type="button" class="workflow-btn ghost" id="workflowCreateSheet">${googleGlyph} Create Google Sheet</button>`}
        </div>
        <div class="workflow-card">
          <div class="workflow-card-top"><span class="workflow-step">2</span><strong>Assign to Team</strong></div>
          <div class="workflow-card-body">
            <span class="workflow-icon icon-violet" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
            <div class="workflow-desc"><span>Give contacts to your team members.</span></div>
          </div>
          <div class="workflow-assign-wrap">
            <select class="workflow-btn ghost" id="workflowAssignSelect" ${!selectedIds.length || !state.teamMembers.length ? "disabled" : ""} aria-label="Assign selected contacts to a team member">
              <option value="">${!state.teamMembers.length ? "Add a team member first" : !selectedIds.length ? "Select contacts first" : `Assign ${selectedIds.length} selected`}</option>
              ${state.teamMembers.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="workflow-card">
          <div class="workflow-card-top"><span class="workflow-step">3</span><strong>Download by Team Member</strong></div>
          <div class="workflow-card-body">
            <span class="workflow-icon icon-violet" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>
            <div class="workflow-desc">
              <span>Downloads follow your filters. File name shows the filter used.</span>
            </div>
          </div>
          ${exportMenu ? `<span class="workflow-action-slot" id="workflowExportSlot"></span>` : `<span class="workflow-note">Create an exhibition to enable exports.</span>`}
        </div>
        <div class="workflow-card">
          <div class="workflow-card-top"><span class="workflow-step">4</span><strong>Add Team Member</strong></div>
          <div class="workflow-card-body">
            <span class="workflow-icon icon-violet" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></span>
            <div class="workflow-desc"><span>Create team list for assignment.</span></div>
          </div>
          <button type="button" class="workflow-btn ghost" id="workflowAddTeam">Add team member</button>
        </div>
      </div>
      <div class="contacts-stats-bar">
        <div class="contacts-stat">
          <span class="contacts-stat-icon icon-blue" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg></span>
          <div class="contacts-stat-text"><span class="contacts-stat-num">${state.contacts.length}</span><span class="contacts-stat-label">Saved contacts</span></div>
        </div>
        <div class="contacts-stat">
          <span class="contacts-stat-icon icon-plain" aria-hidden="true">${googleGlyph}</span>
          <div class="contacts-stat-text"><span class="contacts-stat-num">${syncedCount}</span><span class="contacts-stat-label">Synced to Google</span></div>
        </div>
        <div class="contacts-stat">
          <span class="contacts-stat-icon icon-green" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
          <div class="contacts-stat-text"><span class="contacts-stat-num">${assignedCount}</span><span class="contacts-stat-label">Assigned</span></div>
        </div>
        <div class="contacts-stat">
          <span class="contacts-stat-icon icon-violet" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg></span>
          <div class="contacts-stat-text"><span class="contacts-stat-num">${state.teamMembers.length}</span><span class="contacts-stat-label">Team members</span></div>
        </div>
      </div>
      <div class="contacts-main-area">
        <div class="contacts-toolbar">
          <h2>Saved contacts</h2>
          <div class="contacts-toolbar-actions">
            <div class="search-field">
              <svg class="search-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
              <input id="searchBox" aria-label="Search contacts" placeholder="Search name, number, or company" value="${escapeAttr(state.contactSearchQuery)}" />
              ${state.contactSearchQuery ? `<button type="button" class="search-clear" id="clearSearchBox" aria-label="Clear search">&times;</button>` : ""}
            </div>
            <button type="button" class="secondary slim editWhatsappSettings" id="contactsEditMessages" title="Edit the WhatsApp / email messages sent to contacts"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Edit messages</button>
          </div>
        </div>
        ${state.contactSearchQuery ? `<p class="search-active-note">Showing results for "${escapeHtml(state.contactSearchQuery)}" &middot; <button type="button" class="link-button" id="clearSearchLink">Clear search</button></p>` : ""}
        ${!state.contacts.length && !state.contactSearchQuery ? `
        <div class="contacts-empty">
          <div class="contacts-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2.5" />
              <circle cx="9" cy="11" r="2.2" />
              <path d="M5.5 16c.6-1.7 2-2.6 3.5-2.6s2.9.9 3.5 2.6M15 9.5h3.5M15 13h3" />
            </svg>
          </div>
          <h3>No contacts yet</h3>
          <p>Upload your business cards and Card2Leads turns them into saved contacts here.</p>
          <button type="button" id="contactsEmptyUpload">Upload cards</button>
        </div>` : !state.contacts.length ? `
        <div class="contacts-empty">
          <div class="contacts-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          </div>
          <h3>No matches for "${escapeHtml(state.contactSearchQuery)}"</h3>
          <p>Try a different name, number, company, or team member — or clear the search to see all contacts.</p>
          <button type="button" id="contactsEmptyClearSearch">Clear search</button>
        </div>` : `
        <div class="contacts-filters">
          <label class="filter-field">
            <span>Exhibition</span>
            <select id="filterExhibition">
              <option value="">All exhibitions</option>
              ${exhibitionNames.map((name) => `<option value="${escapeAttr(name)}"${filters.exhibition === name ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}
            </select>
          </label>
          <label class="filter-field">
            <span>Assigned to</span>
            <select id="filterAssignee">
              <option value="">Everyone</option>
              <option value="__unassigned"${filters.assignee === "__unassigned" ? " selected" : ""}>Unassigned</option>
              ${state.teamMembers.map((m) => `<option value="${m.id}"${filters.assignee === m.id ? " selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}
            </select>
          </label>
          <label class="filter-field">
            <span>City</span>
            <select id="filterCity">
              <option value="">All cities</option>
              ${cityNames.map((name) => `<option value="${escapeAttr(name)}"${filters.city === name ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}
            </select>
          </label>
          <label class="filter-field">
            <span>State</span>
            <select id="filterState">
              <option value="">All states</option>
              ${stateNames.map((name) => `<option value="${escapeAttr(name)}"${filters.state === name ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}
            </select>
          </label>
          ${filtersActive ? `<button type="button" class="link-button" id="clearContactFilters">Clear filters</button>` : ""}
        </div>
        <div class="contacts-selectbar">
          <label class="selectall-label"><input id="selectAllContacts" type="checkbox" ${allVisibleSelected ? "checked" : ""} /> <span>${selectedIds.length ? `${selectedIds.length} selected` : "Select all"}</span></label>
          <span class="muted contacts-count">${visibleContacts.length} contact${visibleContacts.length === 1 ? "" : "s"}${filtersActive ? ` of ${state.contacts.length}` : ""}</span>
          <div class="selectbar-actions ${selectedIds.length ? "" : "hidden"}">
            <button class="secondary compact-action" id="bulkWhatsappContacts">WhatsApp</button>
            <button class="secondary compact-action" id="bulkVoiceContacts"><span class="button-mic-icon" aria-hidden="true"></span>Voice note</button>
            ${activeCollectionId ? `<a href="${exportHref("xlsx", activeCollectionId, selectedIds)}"><button type="button" class="secondary compact-action">Excel</button></a><a href="${exportHref("csv", activeCollectionId, selectedIds)}"><button type="button" class="secondary compact-action">CSV</button></a><a href="${exportHref("vcf", activeCollectionId, selectedIds)}"><button type="button" class="secondary compact-action">VCF</button></a>` : ""}
            <button class="danger compact-action" id="bulkDeleteContacts">Delete</button>
          </div>
          <div class="view-toggle" role="group" aria-label="Table columns">
            <button type="button" class="view-toggle-btn ${extendedView ? "" : "active"}" data-table-view="compact">Compact</button>
            <button type="button" class="view-toggle-btn ${extendedView ? "active" : ""}" data-table-view="extended">Extended</button>
          </div>
        </div>
        <div class="c2l-table-wrap">
          <table class="c2l-table ${extendedView ? "is-extended" : ""}">
            <thead><tr>
              <th class="col-check sticky-l1"><span class="sr-only">Select</span></th>
              <th class="col-name sticky-l2">Contact</th>
              <th class="col-saved">Saved contact name</th>
              <th class="col-mobile">Mobile</th>
              ${extendedView ? `
              <th>Country code</th>
              <th>WhatsApp no.</th>
              <th>Designation</th>
              <th>Email</th>
              <th>Website</th>
              <th>Address</th>
              <th>State code</th>
              <th>Country</th>
              <th>Card language</th>
              <th>Tags</th>
              <th>Remarks</th>` : ""}
              <th class="col-place">City / State</th>
              <th class="col-exhibition">Exhibition</th>
              <th class="col-voice">Voice note</th>
              <th class="col-sync">Google sync</th>
              <th class="col-team">Team member</th>
              <th class="col-actions">Actions</th>
              <th class="col-reach sticky-r"><span class="sr-only">Message</span></th>
            </tr></thead>
            <tbody class="c2l-tbody"></tbody>
          </table>
        </div>
        ${visibleContacts.length ? "" : `<p class="contact-empty">No contacts match these filters.</p>`}`}
      </div>
        </div>
      </div>
    </section>
  `);
  const exportSlot = node.querySelector("#workflowExportSlot");
  if (exportSlot && exportMenu) {
    const wrapper = document.createElement("span");
    wrapper.innerHTML = exportMenu;
    // Append into the slot rather than replacing it: the slot element is the
    // styling hook (.workflow-action-slot ...) that lays this button out to
    // match the other workflow cards. Replacing it dropped that wrapper, so
    // the menu fell back to the generic export-menu styling instead.
    exportSlot.appendChild(wrapper.firstElementChild);
  }
  const tbody = node.querySelector(".c2l-tbody");
  if (tbody) tbody.innerHTML = visibleContacts.map((contact) => {
    const initials = contactInitials(contact.name);
    const synced = contact.googleContactsSyncStatus === "synced";
    const syncFailed = contact.googleContactsSyncStatus === "failed";
    // Primary line shows the name exactly as extracted from the card — in its
    // original script when the card was not in Latin — so the user can match a
    // row back to the physical card. The English transliteration sits below it.
    const originalName = String(contact.nameNative || "").trim() || String(contact.name || "").trim();
    const originalCompany = String(contact.companyNameNative || "").trim() || String(contact.companyName || "").trim();
    const companySameAsName = originalCompany.toLowerCase() === originalName.toLowerCase();
    const companyLine = [companySameAsName ? "" : originalCompany, contact.designation].filter(Boolean).join(" · ");
    // English (transliterated) name, shown only when the card's original name
    // was in another script and so differs from the English version.
    const englishName = String(contact.name || "").trim();
    const englishLine = englishName && englishName !== originalName ? englishName : "";
    const nativeLang = NATIVE_LANG_TAGS[String(contact.cardLanguage || "").toLowerCase()] || "";
    const voiceText = String(contact.voiceTranscript || "").trim();
    const hasVoice = Boolean(voiceText);
    const waNumber = contactWhatsappNumber(contact);
    const place = [contact.city, contact.state].filter(Boolean).join(", ");
    const savedName = contactSavedDisplayName(contact);
    const cell = (value) => `<td class="cell-text" title="${escapeAttr(value || "")}">${escapeHtml(value || "")}</td>`;
    return `
    <tr class="c2l-row">
      <td class="col-check sticky-l1"><input aria-label="Select ${escapeAttr(contact.name)}" type="checkbox" data-select-contact="${contact.id}" ${state.selectedContactIds.has(contact.id) ? "checked" : ""} /></td>
      <td class="col-name sticky-l2">
        <div class="cell-contact">
          <span class="contact-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
          <span class="cell-contact-text">
            <span class="cell-contact-head">
              <strong lang="${escapeAttr(nativeLang)}" title="${escapeAttr(originalName)}">${escapeHtml(originalName)}</strong>
              ${contact.needsReview ? `<span class="review-dot" title="${escapeAttr(contact.reviewReasons || "Needs a quick review")}" aria-label="Needs review"></span>` : ""}
            </span>
            ${companyLine ? `<span class="cell-sub" lang="${escapeAttr(nativeLang)}" title="${escapeAttr(companyLine)}">${escapeHtml(companyLine)}</span>` : ""}
            ${englishLine ? `<span class="cell-native" lang="en" title="${escapeAttr(englishLine)}">${escapeHtml(englishLine)}</span>` : ""}
          </span>
        </div>
      </td>
      <td class="col-saved"><span class="saved-name" title="${escapeAttr(savedName)}">${escapeHtml(savedName)}</span></td>
      <td class="col-mobile cell-text">${escapeHtml(contact.mobileNumber || "")}</td>
      ${extendedView ? `
      ${cell(contact.phoneCountryCode)}
      ${cell(contact.whatsappNumber || waNumber)}
      ${cell(contact.designation)}
      ${cell(contact.emailAddress)}
      ${cell(contact.website)}
      ${cell(contact.address)}
      ${cell(contact.stateCode)}
      ${cell(contact.country)}
      ${cell(contact.cardLanguage)}
      ${cell(contact.tags)}
      ${cell(contact.notes)}` : ""}
      <td class="col-place">${place
        ? `<span class="cell-text" title="${escapeAttr(place)}">${escapeHtml(place)}</span>`
        : `<button type="button" class="add-city-btn" data-set-city="${contact.id}" title="No city was found on this card — add it and the state is filled in automatically">+ Add city</button>`}</td>
      <td class="col-exhibition">${contact.exhibitionName ? `<span class="contact-card-tag">${escapeHtml(contact.exhibitionName)}</span>` : ""}</td>
      <td class="col-voice">
        ${hasVoice
          ? `<button type="button" class="voice-badge has-note" data-voice-view="${contact.id}" title="${escapeAttr(voiceText)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>Added</button>`
          : `<span class="voice-badge none">Not added</span>`}
      </td>
      <td class="col-sync">
        <span class="sync-badge ${synced ? "ok" : syncFailed ? "bad" : "idle"}">
          ${synced
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>Synced`
            : syncFailed
              ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Failed`
              : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>Not synced`}
        </span>
      </td>
      <td class="col-team">
        <select class="assign-select" data-assign="${contact.id}" aria-label="Assign ${escapeAttr(contact.name)} to a team member">
          <option value="">Unassigned</option>
          ${state.teamMembers.map((m) => `<option value="${m.id}"${contact.assignedToId === m.id ? " selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}
          ${contact.assignedToId && !state.teamMembers.some((m) => m.id === contact.assignedToId) ? `<option value="${contact.assignedToId}" selected>${escapeHtml(contact.assignedToName || "Assigned")}</option>` : ""}
          <option value="__add">+ Add a team member…</option>
        </select>
      </td>
      <td class="col-actions">
        <div class="row-actions">
          <button class="row-btn icon-only" data-voice-contact="${contact.id}" data-contact-name="${escapeAttr(contact.name)}" title="Add or replace voice note" aria-label="Voice note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
          <button class="row-btn icon-only" data-edit="${contact.id}" title="Edit contact" aria-label="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="row-btn icon-only danger" data-delete="${contact.id}" data-contact-name="${escapeAttr(contact.name)}" title="Delete contact" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>
      </td>
      <td class="col-reach sticky-r">
          <button class="row-btn icon-only save-contact" data-save-contact="${contact.id}" data-contact-name="${escapeAttr(contact.name)}" title="Save ${escapeAttr(contact.name)} to Google Contacts or download a VCF" aria-label="Save contact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></button>
          ${waNumber
            ? `<a class="row-btn whatsapp icon-only" href="https://wa.me/${escapeAttr(waNumber)}" target="_blank" rel="noopener noreferrer" data-wa-contact="${contact.id}" title="Message ${escapeAttr(contact.name)} on WhatsApp" aria-label="WhatsApp"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.65.08-.3-.15-1.25-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.53.07-.8.38-.28.3-1.05 1.02-1.05 2.5s1.08 2.9 1.23 3.1c.15.2 2.12 3.24 5.14 4.54.72.31 1.28.5 1.71.63.72.23 1.37.2 1.89.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z"/><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.15h-.01a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24a8.2 8.2 0 0 1 5.83 2.42 8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23z"/></svg></a>`
            : contact.emailAddress
              ? `<a class="row-btn email icon-only" href="mailto:${escapeAttr(contact.emailAddress)}" data-email-contact="${contact.id}" title="Email ${escapeAttr(contact.name)} (not on WhatsApp)" aria-label="Email"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></a>`
              : ""}
      </td>
    </tr>`;
  }).join("");
  node.querySelector("#selectAllContacts")?.addEventListener("change", (event) => {
    if (event.target.checked) visibleContacts.forEach((contact) => state.selectedContactIds.add(contact.id));
    else visibleContacts.forEach((contact) => state.selectedContactIds.delete(contact.id));
    render();
  });
  node.querySelector("#filterExhibition")?.addEventListener("change", (event) => {
    state.contactFilters = { ...state.contactFilters, exhibition: event.target.value };
    render();
  });
  node.querySelector("#filterAssignee")?.addEventListener("change", (event) => {
    state.contactFilters = { ...state.contactFilters, assignee: event.target.value };
    render();
  });
  node.querySelector("#filterCity")?.addEventListener("change", (event) => {
    state.contactFilters = { ...state.contactFilters, city: event.target.value };
    render();
  });
  node.querySelector("#filterState")?.addEventListener("change", (event) => {
    state.contactFilters = { ...state.contactFilters, state: event.target.value };
    render();
  });
  node.querySelector("#clearContactFilters")?.addEventListener("click", () => {
    state.contactFilters = { exhibition: "", assignee: "", city: "", state: "" };
    render();
  });
  tbody && tbody.querySelectorAll("[data-select-contact]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selectedContactIds.add(checkbox.dataset.selectContact);
    else state.selectedContactIds.delete(checkbox.dataset.selectContact);
    render();
  }));
  tbody && tbody.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => {
    const contact = state.contacts.find((item) => item.id === btn.dataset.edit);
    if (contact) showEditContactModal(contact);
  }));
  tbody && tbody.querySelectorAll("[data-assign]").forEach((select) => select.addEventListener("change", () => {
    if (select.value === "__add") {
      render();
      showManageTeamModal();
      return;
    }
    assignContact(select.dataset.assign, select.value);
  }));
  node.querySelector("#manageTeamButton")?.addEventListener("click", showManageTeamModal);
  // One set of download links; the scope picker re-points them. The server
  // builds the file name from whichever scope is applied.
  const scopeSelect = node.querySelector("#exportScopeSelect");
  const applyExportScope = () => {
    if (!scopeSelect) return;
    const value = scopeSelect.value;
    const params = new URLSearchParams({ collectionId: activeCollectionId, csrf: state.csrfToken || "", all: "true" });
    let count = state.contacts.length;
    let label = "All contacts";
    if (value === "filters") {
      const f = state.contactFilters || {};
      if (f.assignee) params.set("assigneeId", f.assignee);
      if (f.exhibition) params.set("exhibition", f.exhibition);
      if (f.city) params.set("city", f.city);
      if (f.state) params.set("state", f.state);
      if (state.contactSearchQuery) params.set("q", state.contactSearchQuery);
      count = visibleContacts.length;
      label = "Current filters";
    } else if (value === "unassigned") {
      params.set("assigneeId", "__unassigned");
      count = state.contacts.filter((c) => !c.assignedToId).length;
      label = "Unassigned";
    } else if (value.startsWith("member:")) {
      const memberId = value.slice("member:".length);
      params.set("assigneeId", memberId);
      count = state.contacts.filter((c) => c.assignedToId === memberId).length;
      label = state.teamMembers.find((m) => m.id === memberId)?.name || "Team member";
    }
    node.querySelectorAll("[data-scope-export]").forEach((link) => {
      link.href = `/api/export.${link.dataset.scopeExport}?${params.toString()}`;
    });
    const hint = node.querySelector("#exportScopeHint");
    if (hint) hint.textContent = `${count} contact(s) · file name starts with ${label.replace(/\s+/g, "_")}`;
  };
  scopeSelect?.addEventListener("change", applyExportScope);
  applyExportScope();
  node.querySelectorAll("[data-table-view]").forEach((btn) => btn.addEventListener("click", () => {
    state.contactsTableView = btn.dataset.tableView;
    localStorage.setItem("card2leads.contactsTableView", state.contactsTableView);
    render();
  }));
  node.querySelector("#workflowAddTeam")?.addEventListener("click", showManageTeamModal);
  node.querySelector("#contactsEditMessages")?.addEventListener("click", showWhatsappSettingsModal);
  node.querySelector("#workflowSyncContacts")?.addEventListener("click", async (event) => {
    await prepareGoogleContactsSync(event.currentTarget, selectedIds, activeCollectionId, activeCollection);
  });
  node.querySelector("#workflowAssignSelect")?.addEventListener("change", async (event) => {
    const memberId = event.target.value;
    if (!memberId || !selectedIds.length) return;
    event.target.disabled = true;
    try {
      for (const id of selectedIds) {
        const result = await api(`/api/contacts/${id}/assign`, { method: "POST", body: { memberId } });
        const index = state.contacts.findIndex((item) => item.id === id);
        if (index >= 0 && result.contact) state.contacts[index] = result.contact;
      }
      const memberName = state.teamMembers.find((m) => m.id === memberId)?.name || "team member";
      state.message = { text: `${selectedIds.length} contact(s) assigned to ${memberName}.`, bad: false };
    } catch (err) {
      state.message = { text: err.message, bad: true };
      await refreshAll();
    }
    render();
  });
  node.querySelector("#contactsEmptyUpload")?.addEventListener("click", () => navigateToView("upload"));
  tbody && tbody.querySelectorAll("[data-voice-contact]").forEach((btn) => btn.addEventListener("click", () => {
    showVoiceNoteModal("contact", [btn.dataset.voiceContact], btn.dataset.contactName || "this contact");
  }));
  // Single-row WhatsApp: reuse the saved campaign template so the message is
  // already personalised rather than opening an empty chat.
  tbody && tbody.querySelectorAll("[data-wa-contact]").forEach((link) => link.addEventListener("click", (event) => {
    const contact = state.contacts.find((item) => item.id === link.dataset.waContact);
    if (!contact) return;
    const number = contactWhatsappNumber(contact);
    if (!number) return;
    // Use the workspace's configured default message (falls back to the legacy
    // local template only if none is set), so edits in Account actually apply.
    const tpl = whatsappDefaultTemplate();
    const body = tpl?.body || localStorage.getItem(WHATSAPP_TEMPLATE_KEY) || "";
    event.preventDefault();
    window.open(whatsappLink(number, fillWhatsappTemplate(body, contact, whatsappCatalogueUrl())), "_blank", "noopener");
  }));
  // Save one lead before messaging: either into Google Contacts (same naming
  // format as a bulk sync) or as a VCF for the phone's own address book.
  tbody && tbody.querySelectorAll("[data-save-contact]").forEach((button) => button.addEventListener("click", (event) => {
    const contactId = button.dataset.saveContact;
    const contact = state.contacts.find((item) => item.id === contactId);
    if (!contact) return;
    event.preventDefault();
    const savedAs = contact.contactDisplayName || contact.name || "this contact";
    state.modal = {
      title: `Save ${contact.name || "contact"}`,
      tone: "info",
      body: `Saved as "${savedAs}".`,
      actions: [
        { label: "Cancel", className: "secondary" },
        {
          label: "Download VCF",
          className: "secondary",
          onClick: () => {
            window.location.href = exportHref("vcf", contact.collectionId || activeCollectionId, [contactId], false, false);
          }
        },
        {
          label: "Save to Google",
          className: "primary",
          onClick: async () => {
            if (!state.overview?.google?.contactsConnected) {
              window.location.href = "/api/google/connect?feature=contacts";
              return;
            }
            await prepareGoogleContactsSync(button, [contactId], activeCollectionId, activeCollection);
          }
        }
      ]
    };
    render();
  }));
  // Non-WhatsApp contacts with an email: open the mail client with the same
  // configured message pre-filled, addressed to the contact.
  tbody && tbody.querySelectorAll("[data-email-contact]").forEach((link) => link.addEventListener("click", (event) => {
    const contact = state.contacts.find((item) => item.id === link.dataset.emailContact);
    if (!contact || !contact.emailAddress) return;
    event.preventDefault();
    const tpl = whatsappDefaultTemplate();
    const body = fillWhatsappTemplate(tpl?.body || "", contact, whatsappCatalogueUrl());
    const subject = contact.exhibitionName ? `Great connecting at ${contact.exhibitionName}` : "Great connecting with you";
    window.location.href = `mailto:${encodeURIComponent(contact.emailAddress)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }));
  tbody && tbody.querySelectorAll("[data-set-city]").forEach((btn) => btn.addEventListener("click", () => {
    const contact = state.contacts.find((item) => item.id === btn.dataset.setCity);
    if (contact) showSetCityModal(contact);
  }));
  tbody && tbody.querySelectorAll("[data-voice-view]").forEach((btn) => btn.addEventListener("click", () => {
    const contact = state.contacts.find((item) => item.id === btn.dataset.voiceView);
    if (!contact) return;
    state.modal = {
      title: "Voice note",
      body: contact.voiceTranscript || "",
      detail: [contact.name, contact.voiceLanguage ? `Language: ${contact.voiceLanguage}` : ""].filter(Boolean).join(" · "),
      cancelText: "Close",
      confirmText: "Replace note",
      onConfirm: () => showVoiceNoteModal("contact", [contact.id], contact.name || "this contact")
    };
    render();
  }));
  tbody && tbody.querySelectorAll("[data-delete]").forEach((btn) => btn.addEventListener("click", () => {
    state.modal = {
      tone: "danger",
      title: "Delete contact?",
      body: "This contact will be removed from normal views and future exports.",
      detail: btn.dataset.contactName || "Saved contact",
      cancelText: "Keep contact",
      confirmText: "Delete",
      confirmClass: "danger",
      onConfirm: async () => {
        await api(`/api/contacts/${btn.dataset.delete}`, { method: "DELETE" });
        state.selectedContactIds.delete(btn.dataset.delete);
        await refreshAll();
        state.message = { text: "Contact deleted.", bad: false };
        render();
      }
    };
    render();
  }));
  node.querySelector("#searchBox").addEventListener("input", (event) => {
    state.contactSearchQuery = event.target.value;
    clearTimeout(contactSearchDebounce);
    contactSearchDebounce = setTimeout(() => runContactSearch(state.contactSearchQuery, { refocus: true }), 300);
  });
  node.querySelector("#clearSearchBox")?.addEventListener("click", () => {
    clearTimeout(contactSearchDebounce);
    runContactSearch("", { refocus: true });
  });
  node.querySelector("#clearSearchLink")?.addEventListener("click", () => {
    clearTimeout(contactSearchDebounce);
    runContactSearch("");
  });
  node.querySelector("#contactsEmptyClearSearch")?.addEventListener("click", () => {
    clearTimeout(contactSearchDebounce);
    runContactSearch("");
  });
  node.querySelector("#bulkDeleteContacts")?.addEventListener("click", () => {
    const ids = state.contacts.filter((contact) => state.selectedContactIds.has(contact.id)).map((contact) => contact.id);
    state.modal = {
      tone: "danger",
      title: "Delete selected contacts?",
      body: `${ids.length} contact(s) will be removed from normal views and future exports.`,
      confirmText: "Delete selected",
      confirmClass: "danger",
      onConfirm: async () => {
        const result = await api("/api/contacts/bulk-delete", { method: "POST", body: { ids } });
        ids.forEach((id) => state.selectedContactIds.delete(id));
        await refreshAll();
        state.message = { text: `${result.deleted} contact(s) deleted.`, bad: false };
        render();
      }
    };
    render();
  });
  node.querySelector("#bulkWhatsappContacts")?.addEventListener("click", () => {
    const targets = state.contacts
      .filter((contact) => selectedIds.includes(contact.id))
      .map((contact) => ({ contact, number: contactWhatsappNumber(contact) }))
      .filter((entry) => entry.number);
    const skipped = selectedIds.length - targets.length;
    if (!targets.length) {
      setMessage("None of the selected contacts have a usable WhatsApp number.", true);
      return;
    }
    showWhatsappCampaignModal(targets, skipped);
  });
  node.querySelector("#bulkVoiceContacts")?.addEventListener("click", () => {
    showVoiceNoteModal("contacts", selectedIds, `${selectedIds.length} selected contact(s)`);
  });
  node.querySelector("#createContactsGoogleSheet")?.addEventListener("click", async (event) => {
    await createContactsGoogleSheet(event.currentTarget, activeCollectionId);
  });
  node.querySelector("#syncContactsGoogleSheet")?.addEventListener("click", async (event) => {
    await syncContactsGoogleSheet(event.currentTarget, activeCollectionId, [...state.selectedContactIds]);
  });
  node.querySelector("#syncGoogleContacts")?.addEventListener("click", async (event) => {
    await prepareGoogleContactsSync(event.currentTarget, selectedIds, activeCollectionId, activeCollection);
  });
  node.querySelector("#workflowCreateSheet")?.addEventListener("click", async (event) => {
    await createContactsGoogleSheet(event.currentTarget, activeCollectionId);
  });
  node.querySelector("#workflowSyncSheet")?.addEventListener("click", async (event) => {
    await syncContactsGoogleSheet(event.currentTarget, activeCollectionId, [...state.selectedContactIds]);
  });
  node.querySelector('[data-menu-action="create-sheet"]')?.addEventListener("click", async (event) => {
    await createContactsGoogleSheet(event.currentTarget, activeCollectionId);
  });
  node.querySelector('[data-menu-action="sync-sheet"]')?.addEventListener("click", async (event) => {
    await syncContactsGoogleSheet(event.currentTarget, activeCollectionId, [...state.selectedContactIds]);
  });
  node.querySelector('[data-menu-action="sync-contacts"]')?.addEventListener("click", async (event) => {
    await prepareGoogleContactsSync(event.currentTarget, selectedIds, activeCollectionId, activeCollection);
  });
  return node;
}

async function createContactsGoogleSheet(button, collectionId) {
  button.disabled = true;
  try {
    await api("/api/google/create-sheet", { method: "POST", body: { collectionId } });
    await refreshAll();
    setMessage("Google Sheet created and linked to this exhibition.");
  } catch (err) {
    button.disabled = false;
    setMessage(err.message, true);
  }
}

async function syncContactsGoogleSheet(button, collectionId, selectedIds = []) {
  button.disabled = true;
  try {
    // Pass the selection so contacts from other exhibitions reach their own
    // sheet instead of being skipped.
    const result = await api("/api/google/sync", { method: "POST", body: { collectionId, contactIds: selectedIds } });
    await refreshAll();
    const synced = result.synced || 0;
    const sheets = Array.isArray(result.sheets) ? result.sheets.filter((sheet) => sheet.url) : [];
    setMessage(result.message || `${synced} contact(s) synced to Google Sheets.`);
    state.modal = {
      title: `${synced} contact${synced === 1 ? "" : "s"} synced to Google Sheets`,
      tone: "info",
      body: sheets.length > 1
        ? `Your selection spans ${sheets.length} exhibitions, so each one's sheet was updated.`
        : sheets.length === 1
          ? `The sheet for "${sheets[0].name}" is up to date.`
          : "The exhibition sheet is up to date.",
      contentHtml: sheets.length > 1
        ? `<ul class="dialog-list">${sheets.map((sheet) => `<li><a href="${escapeAttr(sheet.url)}" target="_blank" rel="noopener">${escapeHtml(sheet.name)}</a> — ${sheet.synced} contact(s)</li>`).join("")}</ul>`
        : "",
      cancelText: "Close",
      confirmText: sheets.length === 1 ? "Open sheet" : "Done",
      confirmClass: "primary",
      onConfirm: () => { if (sheets.length === 1) window.open(sheets[0].url, "_blank", "noopener"); }
    };
    render();
  } catch (err) {
    button.disabled = false;
    setMessage(err.message, true);
  }
}

async function prepareGoogleContactsSync(button, selectedIds, collectionId, activeCollection) {
  if (!selectedIds.length) {
    state.googleContactsSyncStatus = { text: "Select at least one contact to save.", bad: true };
    render();
    return;
  }
  const targetContacts = state.contacts.filter((contact) => selectedIds.includes(contact.id));
  const defaultName = activeCollection?.exhibitionName || activeCollection?.name || targetContacts.find((contact) => contact.exhibitionName)?.exhibitionName || "";
  const defaultDate = activeCollection?.exhibitionDate || targetContacts.find((contact) => contact.exhibitionDate)?.exhibitionDate || "";
  const needsContext = targetContacts.some((contact) => !contact.exhibitionName || !contact.exhibitionDate);
  if (!needsContext) {
    await syncGoogleContacts(button, selectedIds, collectionId, {});
    return;
  }

  state.modal = {
    title: "Label these Google Contacts",
    body: "Add the exhibition name and date so these contacts are easy to filter on your phone.",
    contentHtml: `
      <form id="googleContactsContextForm" class="google-contacts-context-form">
        <label>Exhibition or event
          <input name="exhibitionName" required value="${escapeAttr(defaultName)}" placeholder="For example, IIJS 2026" />
        </label>
        <label>Event date
          <input name="exhibitionDate" type="date" required value="${escapeAttr(defaultDate)}" />
        </label>
        <p class="muted">Google Contacts label preview: <strong id="googleLabelPreview"></strong></p>
      </form>
    `,
    cancelText: "Cancel",
    confirmText: "Import contacts",
    confirmClass: "",
    keepOpenOnConfirm: true,
    onRender: (modalNode) => {
      const form = modalNode.querySelector("#googleContactsContextForm");
      const preview = modalNode.querySelector("#googleLabelPreview");
      const updatePreview = () => {
        const data = new FormData(form);
        const name = String(data.get("exhibitionName") || "").trim() || "Exhibition";
        const date = String(data.get("exhibitionDate") || "");
        preview.textContent = date ? `${name} - ${displayDate(date)}` : name;
      };
      form.addEventListener("input", updatePreview);
      updatePreview();
    },
    onConfirm: async () => {
      const form = document.querySelector("#googleContactsContextForm");
      if (!form?.reportValidity()) return;
      const data = new FormData(form);
      closeModal(false);
      await syncGoogleContacts(button, selectedIds, collectionId, {
        exhibitionName: String(data.get("exhibitionName") || "").trim(),
        exhibitionDate: String(data.get("exhibitionDate") || "")
      });
    }
  };
  render();
}

async function syncGoogleContacts(_button, selectedIds, _collectionId, context) {
  if (!selectedIds.length) {
    state.googleContactsSyncStatus = { text: "Select at least one contact to save.", bad: true };
    render();
    return;
  }
  state.googleContactsSyncing = true;
  state.googleContactsSyncStatus = {
    text: `Saving ${selectedIds.length} contact(s) to Google Contacts...`,
    bad: false
  };
  render();
  try {
    const result = await api("/api/google/contacts/sync", {
      method: "POST",
      body: {
        contactIds: selectedIds,
        ...context
      }
    });
    await refreshAll();
    const firstFailure = result.failures?.[0]?.message;
    const resultText = result.failed
      ? `${result.synced} contact(s) saved; ${result.failed} failed.${firstFailure ? ` ${firstFailure}` : ""}`
      : `${result.synced} contact(s) saved to Google Contacts under "${result.label || "Card2Leads contacts"}".`;
    state.googleContactsSyncStatus = { text: resultText, bad: Boolean(result.failed) };
    if (result.failed) {
      setMessage(resultText, true);
    } else {
      // Offer the destination, so the user can confirm where the contacts landed
      // instead of having to hunt for the label in Google Contacts.
      state.modal = {
        title: `${result.synced} contact${result.synced === 1 ? "" : "s"} saved to Google`,
        tone: "info",
        body: (result.labels && result.labels.length > 1)
          ? `Saved under ${result.labels.length} exhibition labels: ${result.labels.join(", ")}.`
          : `Saved under "${result.label || "Card2Leads contacts"}".`,
        cancelText: "Close",
        confirmText: "Open Google Contacts",
        confirmClass: "primary",
        onConfirm: () => window.open(result.groupUrl || "https://contacts.google.com/", "_blank", "noopener")
      };
      setMessage(resultText);
    }
  } catch (err) {
    state.googleContactsSyncStatus = { text: err.message, bad: true };
    setMessage(err.message, true);
  } finally {
    state.googleContactsSyncing = false;
    render();
  }
}

function showEditContactModal(contact) {
  const formHtml = `
    <form id="editContactForm" class="grid edit-contact-form">
      <div class="form-grid">
        ${contactFields.map((field) => inputField(field, contact[field] || "", field === "notes" || field === "address")).join("")}
      </div>
    </form>
  `;
  state.modal = {
    title: "Edit contact",
    body: "Update the fields, then save. Name and Mobile Number are required.",
    contentHtml: formHtml,
    className: "wide-dialog",
    cancelText: "Cancel",
    confirmText: "Save changes",
    confirmClass: "",
    keepOpenOnConfirm: true,
    onRender: (node) => {
      const form = node.querySelector("#editContactForm");
      form.querySelector("input, textarea, select")?.focus();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        await updateContact(contact.id, form);
      });
      form.addEventListener("keydown", async (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          await updateContact(contact.id, form);
        }
      });
    },
    onConfirm: async () => {
      const form = document.querySelector("#editContactForm");
      if (form) await updateContact(contact.id, form);
    }
  };
  render();
}

async function updateContact(contactId, form) {
  try {
    const fields = Object.fromEntries(new FormData(form).entries());
    await api(`/api/contacts/${contactId}`, { method: "PATCH", body: { fields } });
    closeModal(false);
    await refreshAll();
    state.message = { text: "Contact updated.", bad: false };
    render();
  } catch (err) {
    state.message = { text: err.message, bad: true };
    render();
  }
}

async function assignContact(contactId, memberId) {
  try {
    const result = await api(`/api/contacts/${contactId}/assign`, { method: "POST", body: { memberId } });
    const index = state.contacts.findIndex((item) => item.id === contactId);
    if (index >= 0 && result.contact) state.contacts[index] = result.contact;
    const assignedName = result.contact && result.contact.assignedToName;
    state.message = { text: assignedName ? `Assigned to ${assignedName}.` : "Contact unassigned.", bad: false };
    render();
  } catch (err) {
    state.message = { text: err.message, bad: true };
    await refreshAll();
    render();
  }
}

function teamMemberListHtml() {
  if (!state.teamMembers.length) {
    return `<p class="team-empty">No team members yet. Add names below to start assigning contacts.</p>`;
  }
  return `<ul class="team-member-list">${state.teamMembers.map((member) => `
    <li>
      <span>${escapeHtml(member.name)}</span>
      <button type="button" class="link-danger" data-remove-member="${member.id}" data-member-name="${escapeAttr(member.name)}">Remove</button>
    </li>`).join("")}</ul>`;
}

function showManageTeamModal() {
  const contentHtml = `
    <div class="team-manager">
      <div id="teamMemberList">${teamMemberListHtml()}</div>
      <form id="addTeamMemberForm" class="team-add-form" autocomplete="off">
        <input type="text" id="teamMemberName" name="name" placeholder="Full name, e.g. Priya Shah" maxlength="80" />
        <button type="submit">Add a team member</button>
      </form>
      <p class="team-manager-hint">Team members are the people who follow up with contacts. Their names appear in the Assigned to menu on every contact. Removing a member unassigns their contacts.</p>
    </div>
  `;
  state.modal = {
    title: "Team members",
    body: "Add the people who follow up with contacts, then assign contacts to them.",
    tone: "info",
    contentHtml,
    className: "wide-dialog",
    actions: [{ label: "Done", className: "secondary" }],
    onRender: (node) => {
      const form = node.querySelector("#addTeamMemberForm");
      const input = node.querySelector("#teamMemberName");
      input?.focus();
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = (input.value || "").trim();
        if (!name) return;
        await addTeamMember(name);
      });
      node.querySelectorAll("[data-remove-member]").forEach((btn) => btn.addEventListener("click", () => {
        removeTeamMember(btn.dataset.removeMember, btn.dataset.memberName || "this member");
      }));
    }
  };
  render();
}

async function addTeamMember(name) {
  try {
    const result = await api("/api/team", { method: "POST", body: { name } });
    state.teamMembers = result.members || state.teamMembers;
    state.message = { text: `${name} added to the team.`, bad: false };
    showManageTeamModal();
  } catch (err) {
    state.message = { text: err.message, bad: true };
    showManageTeamModal();
  }
}

async function removeTeamMember(memberId, memberName) {
  try {
    const result = await api(`/api/team/${memberId}`, { method: "DELETE" });
    state.teamMembers = result.members || [];
    if (result.unassigned) {
      state.contacts.forEach((contact) => {
        if (contact.assignedToId === memberId) {
          contact.assignedToId = "";
          contact.assignedToName = "";
        }
      });
    }
    state.message = { text: `${memberName} removed${result.unassigned ? ` · ${result.unassigned} contact(s) unassigned` : ""}.`, bad: false };
    showManageTeamModal();
  } catch (err) {
    state.message = { text: err.message, bad: true };
    showManageTeamModal();
  }
}

function collectionView() {
  const c = state.overview.activeCollection;
  const collections = state.overview.collections || [];
  const google = state.overview.google || {};
  if (!c) {
    const node = el(`<section class="panel empty-state"><h2>No sheet/export yet</h2><p class="muted">Your first sheet will be created when you upload your first card batch.</p><button type="button" id="goToFirstUpload">Upload cards</button></section>`);
    node.querySelector("#goToFirstUpload").addEventListener("click", () => {
      navigateToView("upload");
    });
    return node;
  }
  const googleHeading = !google.configured
    ? "Google Sheets is not configured"
    : google.sheetsConnected
      ? "Google Sheets connected"
      : "Connect Google Sheets";
  const googleDetail = !google.configured
    ? "Add the Google OAuth credentials to enable Google Sheet creation and sync. Excel and CSV downloads still work."
    : google.sheetsConnected
      ? `${google.googleEmail ? `Connected as ${google.googleEmail}. ` : ""}Google sync is optional for each exhibition.`
      : "Connect once, then create or sync a separate Google Sheet for any exhibition.";
  const node = el(`
    <div class="grid">
      <section class="panel google-connection-panel">
        <div>
          <p class="eyebrow">Google Sheets</p>
          <h2>${escapeHtml(googleHeading)}</h2>
          <p class="muted">${escapeHtml(googleDetail)}</p>
        </div>
        <div class="actions">
          ${google.configured && (!google.sheetsConnected || google.needsReconnect) ? `<a class="sheet-link ${google.sheetsConnected ? "secondary" : "primary"}" href="/api/google/connect?feature=sheets">${google.sheetsConnected ? "Update Google access" : "Connect Google Sheets"}</a>` : ""}
          ${google.sheetsConnected ? `<button type="button" class="secondary slim" id="disconnectGoogleSheetsSettings">Disconnect</button>` : ""}
        </div>
      </section>
      <section class="panel">
        <div class="sheets-heading">
          <div>
            <h2>Exhibition contact lists</h2>
            <p class="muted">Download an Excel/CSV file, or keep that exhibition synced to its own Google Sheet.</p>
          </div>
          <button type="button" class="secondary" id="goToNewExhibition">New exhibition</button>
        </div>
        <div class="table-wrap">
          <table class="sheets-table">
            <thead><tr><th>Exhibition</th><th>Contacts</th><th>Google sync</th><th>Actions</th></tr></thead>
            <tbody>
              ${collections.map((collection) => {
                const collectionSheetUrl = collection.spreadsheetUrl || (collection.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(collection.spreadsheetId)}/edit` : "");
                return `
                <tr>
                  <td data-label="Exhibition"><strong>${escapeHtml(collection.exhibitionName || collection.name)}</strong><br><span class="muted">${escapeHtml(displayDate(collection.exhibitionDate) || displayDateTime(collection.createdAt))}</span></td>
                  <td data-label="Contacts" class="numeric-cell">${Number(collection.savedContactCount || 0)}</td>
                  <td data-label="Google sync"><span class="storage-type ${collection.spreadsheetId ? "google" : "file"}">${collection.spreadsheetId ? "Connected" : "Not connected"}</span></td>
                  <td data-label="Actions" class="row-actions">
                    <a class="sheet-link secondary" href="${exportHref("xlsx", collection.id)}">Excel</a>
                    <a class="sheet-link secondary" href="${exportHref("csv", collection.id)}">CSV</a>
                    ${collection.spreadsheetId
                      ? `<button class="secondary slim" data-sync-google="${collection.id}">Sync now</button>${collectionSheetUrl ? `<a class="sheet-link secondary" href="${collectionSheetUrl}" target="_blank" rel="noreferrer">Open Sheet</a>` : ""}`
                      : google.sheetsConnected
                        ? `<button class="secondary slim" data-create-google="${collection.id}" data-sheet-name="${escapeAttr(`${collection.name} Contacts`)}">Create Google Sheet</button>`
                        : ""}
                    ${Number(collection.savedContactCount || 0) === 0 ? `<button class="link-button danger-text" data-delete-collection="${collection.id}" data-collection-name="${escapeAttr(collection.name)}">Delete empty list</button>` : ""}
                  </td>
                </tr>
              `;}).join("")}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `);
  node.querySelector("#goToNewExhibition").addEventListener("click", () => {
    state.uploadMode = "new";
    state.showUploadSettings = true;
    state.draftCollectionName = "";
    state.draftExhibitionName = "";
    state.draftExhibitionDate = "";
    state.draftDestinationType = "excel";
    navigateToView("upload");
  });
  node.querySelector("#disconnectGoogleSheetsSettings")?.addEventListener("click", () => {
    state.modal = {
      title: "Disconnect Google Sheets?",
      body: "Card2Leads will remove its stored Google tokens. Existing Google Sheets stay in your Google Drive.",
      confirmText: "Disconnect",
      onConfirm: async () => {
        await api("/api/google/disconnect", { method: "POST", body: {} });
        await refreshAll();
        setMessage("Google Sheets disconnected. Connect again to use file-limited access.");
      }
    };
    render();
  });
  node.querySelectorAll("[data-create-google]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        btn.disabled = true;
        btn.textContent = "Creating...";
        const result = await api("/api/google/create-sheet", {
          method: "POST",
          body: { collectionId: btn.dataset.createGoogle, sheetName: btn.dataset.sheetName }
        });
        await refreshAll();
        setMessage(result.sync?.synced ? `Google Sheet created and ${result.sync.synced} contact(s) synced.` : "Google Sheet created.");
      } catch (err) {
        setMessage(err.message, true);
      }
    });
  });
  node.querySelectorAll("[data-sync-google]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        btn.disabled = true;
        btn.textContent = "Syncing...";
        const result = await api("/api/google/sync", { method: "POST", body: { collectionId: btn.dataset.syncGoogle } });
        await refreshAll();
        setMessage(result.message || "Google Sheet synced.");
      } catch (err) {
        setMessage(err.message, true);
      }
    });
  });
  node.querySelectorAll("[data-delete-collection]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const collectionId = btn.dataset.deleteCollection;
      const collectionName = btn.dataset.collectionName || "this collection";
      state.modal = {
        tone: "danger",
        title: "Delete sheet/export?",
        body: "This removes an empty sheet/export from the list. Sheets/exports with saved contacts are protected.",
        detail: collectionName,
        confirmText: "Delete",
        confirmClass: "danger",
        onConfirm: async () => {
          try {
            await api(`/api/collections/${collectionId}`, { method: "DELETE" });
            await refreshAll();
            setMessage("Sheet/export deleted.");
          } catch (err) {
            setMessage(err.message, true);
          }
        }
      };
      render();
    });
  });
  return node;
}

function auditView() {
  const node = el(`<section class="panel"><h2>Audit log</h2><div class="audit-list"><p class="muted">Loading...</p></div></section>`);
  api("/api/audit").then((result) => {
    node.querySelector(".audit-list").innerHTML = result.logs.map((log) => `
      <div class="audit-row">
        <div><strong>${escapeHtml(log.action)}</strong><div class="muted">${escapeHtml(log.entityType)} ${escapeHtml(log.entityId || "")}</div></div>
        <span class="muted">${new Date(log.createdAt).toLocaleString()}</span>
      </div>
    `).join("") || `<p class="muted">No audit entries yet.</p>`;
  });
  return node;
}

function loadRazorpay() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve(window.Razorpay);
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(window.Razorpay);
    script.onerror = () => reject(new Error("Could not load the payment window. Check your connection and try again."));
    document.head.appendChild(script);
  });
}

async function startSubscription(plan) {
  try {
    const Razorpay = await loadRazorpay();
    const result = await api("/api/billing/subscribe", { method: "POST", body: { plan } });
    const rzp = new Razorpay({
      key: result.keyId,
      subscription_id: result.subscriptionId,
      name: "Card2Leads",
      description: `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan`,
      prefill: { name: state.user?.name || "", email: state.user?.email || "" },
      theme: { color: "#223558" },
      handler: () => {
        state.message = { text: "Payment received. Your plan will activate in a moment.", bad: false };
        render();
        setTimeout(() => refreshAll().then(render).catch(() => {}), 4000);
      },
      modal: { ondismiss: () => { state.message = { text: "Payment cancelled.", bad: false }; render(); } }
    });
    rzp.on("payment.failed", () => { state.message = { text: "Payment failed. Please try again.", bad: true }; render(); });
    rzp.open();
  } catch (err) {
    state.message = { text: err.message, bad: true };
    render();
  }
}

async function startOneTimePlan(plan) {
  try {
    const Razorpay = await loadRazorpay();
    const order = await api("/api/billing/one-time", { method: "POST", body: { plan } });
    const rzp = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: "Card2Leads",
      description: `${order.months === 12 ? "1 year" : `${order.months} month${order.months > 1 ? "s" : ""}`} · ${order.scans} scans`,
      prefill: { name: state.user?.name || "", email: state.user?.email || "" },
      theme: { color: "#223558" },
      handler: async (response) => {
        try {
          await api("/api/billing/one-time/verify", { method: "POST", body: response });
          await refreshAll();
          state.message = { text: `One-time ${statusLabel(order.plan)} plan activated.`, bad: false };
          render();
        } catch (err) {
          state.message = { text: err.message, bad: true };
          render();
        }
      },
      modal: { ondismiss: () => { state.message = { text: "Payment cancelled.", bad: false }; render(); } }
    });
    rzp.on("payment.failed", () => { state.message = { text: "Payment failed. Please try again.", bad: true }; render(); });
    rzp.open();
  } catch (err) {
    state.message = { text: err.message, bad: true };
    render();
  }
}

function requestTopupPurchase() {
  const billing = state.overview?.billing || {};
  if (!billing.configured) {
    state.message = { text: "Online payments are not available yet.", bad: true };
    render();
    return;
  }
  if (!billing.canTopup) {
    const scans = Number(billing.topupScans || 100);
    const amount = Number(billing.topupAmount || 499).toLocaleString("en-IN");
    state.modal = {
      className: "plan-required-dialog",
      tone: "credit",
      iconHtml: "+",
      title: "Your workspace is ready",
      body: "To add extra scan credits, first activate a Pay once or Subscribe plan.",
      contentHtml: `
        <div class="plan-credit-preview">
          <span class="plan-credit-preview-icon">+</span>
          <div><strong>${scans} extra scans</strong><small>&#8377;${amount} one-time payment</small></div>
        </div>
        <div class="plan-required-steps" aria-label="How to add scan credits">
          <div><span>1</span><strong>Choose a plan</strong><small>Pay once or Subscribe</small></div>
          <div><span>2</span><strong>Activate it</strong><small>Complete secure payment</small></div>
          <div><span>3</span><strong>Add credits</strong><small>Use them immediately</small></div>
        </div>
      `,
      actions: [
        { label: "Maybe later", className: "secondary", onClick: () => {} },
        {
          label: "Choose a plan",
          className: "primary",
          onClick: () => setTimeout(() => document.querySelector(".billing-mode-tabs")?.scrollIntoView({ behavior: "smooth", block: "center" }), 120)
        }
      ]
    };
    render();
    return;
  }
  state.modal = {
    title: `Add ${Number(billing.topupScans || 100)} scan credits?`,
    body: `These credits are added immediately to your active plan after payment is verified.`,
    detail: `One-time payment: ₹${Number(billing.topupAmount || 499).toLocaleString("en-IN")}. This does not start or change a subscription.`,
    cancelText: "Not now",
    confirmText: "Continue to payment",
    confirmClass: "primary",
    onConfirm: startTopup
  };
  render();
}

async function startTopup() {
  try {
    const Razorpay = await loadRazorpay();
    const order = await api("/api/billing/topup", { method: "POST", body: {} });
    const rzp = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: "Card2Leads",
      description: `${order.scans} extra scans`,
      prefill: { name: state.user?.name || "", email: state.user?.email || "" },
      theme: { color: "#223558" },
      handler: async (response) => {
        try {
          await api("/api/billing/topup/verify", { method: "POST", body: response });
          await refreshAll();
          state.message = { text: `${order.scans} extra scans are ready to use.`, bad: false };
          render();
        } catch (err) {
          state.message = { text: err.message, bad: true };
          render();
        }
      },
      modal: { ondismiss: () => { state.message = { text: "Top-up cancelled.", bad: false }; render(); } }
    });
    rzp.on("payment.failed", () => { state.message = { text: "Payment failed. Please try again.", bad: true }; render(); });
    rzp.open();
  } catch (err) {
    state.message = { text: err.message, bad: true };
    render();
  }
}

function accountView() {
  const google = state.overview?.google || {};
  const usage = state.overview?.usage || {};
  const billing = state.overview?.billing || { availablePlans: [] };
  billing.availablePlans = billing.availablePlans || [];
  const oneTimePlans = Array.isArray(billing.oneTimePlans) ? billing.oneTimePlans : [];
  const initials = (state.user?.name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "?";
  const usagePercent = Math.min(100, Math.round((Number(usage.used || 0) / Math.max(1, Number(usage.limit || 1))) * 100));
  const topupBalance = Number(billing.topupBalance || 0);
  const periodVerb = billing.mode === "one_time" ? "expires" : "renews";
  const planStatusText = billing.status && billing.status !== "trial"
    ? `Your <strong>${escapeHtml(statusLabel(billing.plan || "trial"))}</strong> plan is <strong>${escapeHtml(statusLabel(billing.status))}</strong>${billing.currentPeriodEnd ? ` &middot; ${periodVerb} ${escapeHtml(displayDate(billing.currentPeriodEnd))}` : ""}.`
    : "You are on the <strong>Free</strong> plan with 20 scans. Choose a paid plan when you need more.";
  const node = el(`
    <section class="panel account-panel">
      <div class="account-profile-header">
        <div class="account-profile-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
        <div class="account-profile-info">
          <strong>${escapeHtml(state.user?.name || "")}</strong>
          <span class="muted">${escapeHtml(state.user?.email || "")}</span>
          <span class="muted">${escapeHtml(state.organisation?.name || "Workspace")}</span>
        </div>
        <div class="account-profile-plan">
          <span class="plan-badge">${escapeHtml(statusLabel(usage.plan || "trial"))} plan</span>
        </div>
      </div>
      <div class="account-block billing-block billing-block-primary">
        <h3>Plan &amp; billing</h3>
        <p class="muted"><strong>${escapeHtml(statusLabel(usage.plan || "trial"))}</strong> plan · ${Number(usage.used || 0)} of ${Number(usage.limit || 0)} scans used${topupBalance ? ` (includes ${topupBalance} top-up scans)` : ""}.</p>
        <div class="usage-meter"><span style="width:${usagePercent}%"></span></div>
        ${billing.status && billing.status !== "trial"
          ? `<p class="muted">Your <strong>${escapeHtml(statusLabel(billing.plan || "trial"))}</strong> plan is <strong>${escapeHtml(billing.status)}</strong>${billing.currentPeriodEnd ? ` · renews ${escapeHtml(displayDate(billing.currentPeriodEnd))}` : ""}.</p>`
          : `<p class="muted">You are on the <strong>Free</strong> plan with 20 scans. Choose a paid plan when you need more.</p>`}
        ${billing.configured ? `
          <div class="plan-choices">
            <button type="button" class="secondary" data-subscribe="monthly" ${billing.availablePlans.includes("monthly") ? "" : "disabled"}>Monthly · ₹499 / 150 scans</button>
            <button type="button" class="secondary" data-subscribe="quarterly" ${billing.availablePlans.includes("quarterly") ? "" : "disabled"}>Quarterly · ₹799 / 300 scans</button>
            <button type="button" class="secondary" data-subscribe="annual" ${billing.availablePlans.includes("annual") ? "" : "disabled"}>Annual · ₹2,999 / 1,500 scans</button>
          </div>
          <p class="muted">Cancel anytime.</p>
          <div class="actions">
            <button type="button" id="buyTopup">Add ${Number(billing.topupScans)} scans · ₹${Number(billing.topupAmount)}</button>
          </div>
        ` : `<p class="muted">Online payments will be enabled shortly.</p>`}
      </div>
      <div class="section-heading account-secondary-heading">
        <div>
          <h2>Account and security</h2>
          <p class="muted">Manage connected accounts and data controls for this workspace.</p>
        </div>
      </div>
      <div class="account-grid">
        <div class="account-block">
          <h3>Google Sheets</h3>
          <p class="muted">${google.sheetsConnected ? `${google.needsReconnect ? "This older connection has broad access. Disconnect and reconnect it below to switch to file-limited access." : `Connected${google.googleEmail ? ` as ${escapeHtml(google.googleEmail)}` : ""} with file-limited access.`} Tokens are encrypted on the server.` : "Not connected. You can still download Excel/CSV files."}</p>
          <div class="actions">
            ${!google.configured ? `<span class="muted">Google OAuth is not configured.</span>` : google.sheetsConnected ? `<button type="button" class="secondary disconnectGoogleAccount">Disconnect</button>` : `<a href="/api/google/connect?feature=sheets"><button class="secondary" type="button">Connect Google Sheets</button></a>`}
          </div>
        </div>
        <div class="account-block">
          <h3>Google Contacts</h3>
          <p class="muted">${google.contactsConnected ? `Connected${google.googleEmail ? ` as ${escapeHtml(google.googleEmail)}` : ""}. Selected contacts are saved to your Google account using the workspace naming format.` : "Not connected. Connect to save selected contacts straight into Google Contacts."}</p>
          <div class="actions">
            ${!google.configured ? `<span class="muted">Google OAuth is not configured.</span>` : google.contactsConnected ? `<button type="button" class="secondary disconnectGoogleAccount">Disconnect</button>` : `<a href="/api/google/connect?feature=contacts"><button class="secondary" type="button">Connect Google Contacts</button></a>`}
          </div>
        </div>
        <div class="account-block">
          <h3>WhatsApp messages</h3>
          <p class="muted">${(() => {
            const count = whatsappTemplateLibrary().length;
            return `${count} saved message${count === 1 ? "" : "s"}${whatsappCatalogueUrl() ? " · catalogue link set" : " · no catalogue link yet"}. Shared with everyone in this workspace, on every device.`;
          })()}</p>
          <div class="actions">
            <button class="secondary editWhatsappSettings" type="button">Edit messages &amp; catalogue</button>
          </div>
        </div>
        <div class="account-block">
          <h3>Privacy documents</h3>
          <p class="muted">Use these as starter pages before selling. Replace with lawyer-reviewed terms for production.</p>
          <div class="actions">
            <a href="/privacy-policy" target="_blank"><button class="secondary" type="button">Privacy policy</button></a>
            <a href="/terms" target="_blank"><button class="secondary" type="button">Terms</button></a>
            <a href="/retention.html" target="_blank"><button class="secondary" type="button">Data retention</button></a>
          </div>
        </div>
        <div class="account-block danger-zone">
          <h3>Delete account</h3>
          <p class="muted">This permanently removes the workspace, contacts, card images, voice recordings and stored Google tokens.</p>
          <button id="deleteAccount" class="danger">Delete account</button>
        </div>
      </div>
    </section>
  `);
  node.querySelectorAll("[data-subscribe]").forEach((btn) => btn.addEventListener("click", () => startSubscription(btn.dataset.subscribe)));
  node.querySelector("#buyTopup")?.addEventListener("click", () => startTopup());
  node.querySelectorAll(".disconnectGoogleAccount").forEach((btn) => btn.addEventListener("click", () => {
    state.modal = {
      title: "Disconnect Google?",
      body: "Sheets and Contacts share one Google account, so both will be disconnected. Card2Leads removes its stored tokens; sheets and contacts already in your Google account are left untouched. You can reconnect at any time.",
      confirmText: "Disconnect",
      onConfirm: async () => {
        await api("/api/google/disconnect", { method: "POST", body: {} });
        await refreshAll();
        setMessage("Google disconnected. Reconnect from Account whenever you need it.");
      }
    };
    render();
  }));
  node.querySelectorAll(".editWhatsappSettings").forEach((btn) => btn.addEventListener("click", showWhatsappSettingsModal));
  node.querySelector("#deleteAccount").addEventListener("click", () => {
    state.modal = {
      tone: "danger",
      title: "Delete this account?",
      body: "This cannot be undone from the app. Export your contacts first if you need a copy.",
      detail: state.organisation?.name || state.user.email,
      confirmText: "Delete account",
      confirmClass: "danger",
      onConfirm: async () => {
        await api("/api/account", { method: "DELETE", body: {} });
        state.user = null;
        state.organisation = null;
        state.csrfToken = "";
        state.overview = null;
        state.authInfo = "";
        state.authError = "";
        state.authActionLink = "";
        render();
      }
    };
    render();
  });
  return node;
}

function initAccountBillingTabs(node) {
  const tabs = Array.from(node.querySelectorAll("[data-account-billing-tab]"));
  const panels = Array.from(node.querySelectorAll("[data-account-billing-panel]"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const selected = tab.dataset.accountBillingTab;
      tabs.forEach((candidate) => {
        const active = candidate.dataset.accountBillingTab === selected;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.accountBillingPanel !== selected;
      });
    });
  });
}

function accountBillingView() {
  const google = state.overview?.google || {};
  const usage = state.overview?.usage || {};
  const billing = state.overview?.billing || { availablePlans: [], oneTimePlans: [] };
  billing.availablePlans = billing.availablePlans || [];
  const oneTimePlans = Array.isArray(billing.oneTimePlans) ? billing.oneTimePlans : [];
  const initials = (state.user?.name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "?";
  const usagePercent = Math.min(100, Math.round((Number(usage.used || 0) / Math.max(1, Number(usage.limit || 1))) * 100));
  const topupBalance = Number(billing.topupBalance || 0);
  const periodVerb = billing.mode === "one_time" ? "expires" : "renews";
  const planStatusText = billing.status && billing.status !== "trial"
    ? `Your <strong>${escapeHtml(statusLabel(billing.plan || "trial"))}</strong> plan is <strong>${escapeHtml(statusLabel(billing.status))}</strong>${billing.currentPeriodEnd ? ` &middot; ${periodVerb} ${escapeHtml(displayDate(billing.currentPeriodEnd))}` : ""}.`
    : "You are on the <strong>Free</strong> plan with 20 scans. Choose a paid plan when you need more.";
  const oneTimeButtons = oneTimePlans.map((item) => `
    <button type="button" class="billing-plan-option ${item.plan === "quarterly" ? "recommended" : ""}" data-one-time-plan="${escapeAttr(item.plan)}">
      ${item.plan === "quarterly" ? `<span class="billing-recommended-label">Most popular</span>` : ""}
      <span class="billing-plan-name">${escapeHtml(item.months === 12 ? "1 year" : `${item.months} month${item.months > 1 ? "s" : ""}`)}</span>
      <strong>&#8377;${Number(item.amount).toLocaleString("en-IN")}</strong>
      <small>${Number(item.scans).toLocaleString("en-IN")} scans &middot; no renewal</small>
    </button>
  `).join("");
  const node = el(`
    <section class="panel account-panel">
      <div class="account-profile-header">
        <div class="account-profile-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
        <div class="account-profile-info">
          <strong>${escapeHtml(state.user?.name || "")}</strong>
          <span class="muted">${escapeHtml(state.user?.email || "")}</span>
          <span class="muted">${escapeHtml(state.organisation?.name || "Workspace")}</span>
        </div>
        <div class="account-profile-plan">
          <span class="plan-badge">${escapeHtml(statusLabel(usage.plan || "trial"))} plan</span>
        </div>
      </div>
      <div class="account-block billing-block billing-block-primary">
        <h3>Plan &amp; billing</h3>
        <p class="muted"><strong>${escapeHtml(usage.unlimited ? "Test" : statusLabel(usage.plan || "trial"))}</strong> plan &middot; ${usage.unlimited ? `${Number(usage.used || 0)} scans used (unlimited test account)` : `${Number(usage.used || 0)} of ${Number(usage.limit || 0)} scans used${topupBalance ? ` &middot; ${topupBalance} extra scans remaining` : ""}`}.</p>
        <div class="usage-meter"><span style="width:${usagePercent}%"></span></div>
        <p class="muted">${planStatusText}</p>
        ${billing.configured ? `
          <div class="billing-mode-tabs" role="tablist" aria-label="Billing options">
            <button type="button" class="active" role="tab" aria-selected="true" data-account-billing-tab="one-time">Pay once</button>
            <button type="button" role="tab" aria-selected="false" data-account-billing-tab="subscription">Subscribe</button>
          </div>
          <div class="billing-choice-group" data-account-billing-panel="one-time">
            <div>
              <h4>Choose a one-time plan</h4>
              <p class="muted">Pay once and use the scans during the selected validity period.</p>
            </div>
            <div class="plan-choices billing-plan-grid">${oneTimeButtons}</div>
          </div>
          <div class="billing-choice-group" data-account-billing-panel="subscription" hidden>
            <div>
              <h4>Choose a subscription</h4>
              <p class="muted">Scans renew automatically. Cancel anytime.</p>
            </div>
            <div class="plan-choices billing-plan-grid">
              <button type="button" class="billing-plan-option" data-subscribe="monthly" ${billing.availablePlans.includes("monthly") ? "" : "disabled"}><span class="billing-plan-name">Monthly</span><strong>&#8377;499</strong><small>150 scans every month</small></button>
              <button type="button" class="billing-plan-option recommended" data-subscribe="quarterly" ${billing.availablePlans.includes("quarterly") ? "" : "disabled"}><span class="billing-recommended-label">Most popular</span><span class="billing-plan-name">Quarterly</span><strong>&#8377;799</strong><small>300 scans every 3 months</small></button>
              <button type="button" class="billing-plan-option" data-subscribe="annual" ${billing.availablePlans.includes("annual") ? "" : "disabled"}><span class="billing-plan-name">Annual</span><strong>&#8377;2,999</strong><small>1,500 scans every year</small></button>
            </div>
          </div>
          <div class="credit-pack-card ${billing.canTopup ? "available" : "locked"}">
            <div class="credit-pack-icon" aria-hidden="true">+</div>
            <div class="credit-pack-copy">
              <span class="eyebrow">Extra scan pack</span>
              <h4>${Number(billing.topupScans)} additional scans</h4>
              <p>${billing.canTopup ? "Add more scans without changing your current plan." : escapeHtml(billing.topupUnavailableReason || "Activate a paid plan to add extra scans.")}</p>
              ${topupBalance ? `<span class="credit-balance">${topupBalance} purchased scans remaining</span>` : ""}
            </div>
            <div class="credit-pack-buy">
              <strong>&#8377;${Number(billing.topupAmount).toLocaleString("en-IN")}</strong>
              <span>one-time</span>
              <button type="button" id="buyTopup">${billing.canTopup ? "Add scan credits" : "Choose a plan first"}</button>
            </div>
          </div>
        ` : `<p class="muted">Online payments will be enabled shortly.</p>`}
      </div>
      <div class="section-heading account-secondary-heading">
        <div>
          <h2>Account and security</h2>
          <p class="muted">Manage connected accounts and data controls for this workspace.</p>
        </div>
      </div>
      <div class="account-grid">
        <div class="account-block">
          <h3>Google Sheets</h3>
          <p class="muted">${google.sheetsConnected ? `${google.needsReconnect ? "This older connection has broad access. Disconnect and reconnect it below to switch to file-limited access." : `Connected${google.googleEmail ? ` as ${escapeHtml(google.googleEmail)}` : ""} with file-limited access.`} Tokens are encrypted on the server.` : "Not connected. You can still download Excel/CSV files."}</p>
          <div class="actions">
            ${!google.configured ? `<span class="muted">Google OAuth is not configured.</span>` : google.sheetsConnected ? `<button type="button" class="secondary disconnectGoogleAccount">Disconnect</button>` : `<a href="/api/google/connect?feature=sheets"><button class="secondary" type="button">Connect Google Sheets</button></a>`}
          </div>
        </div>
        <div class="account-block">
          <h3>Google Contacts</h3>
          <p class="muted">${google.contactsConnected ? `Connected${google.googleEmail ? ` as ${escapeHtml(google.googleEmail)}` : ""}. Selected contacts are saved to your Google account using the workspace naming format.` : "Not connected. Connect to save selected contacts straight into Google Contacts."}</p>
          <div class="actions">
            ${!google.configured ? `<span class="muted">Google OAuth is not configured.</span>` : google.contactsConnected ? `<button type="button" class="secondary disconnectGoogleAccount">Disconnect</button>` : `<a href="/api/google/connect?feature=contacts"><button class="secondary" type="button">Connect Google Contacts</button></a>`}
          </div>
        </div>
        <div class="account-block">
          <h3>WhatsApp messages</h3>
          <p class="muted">${(() => {
            const count = whatsappTemplateLibrary().length;
            return `${count} saved message${count === 1 ? "" : "s"}${whatsappCatalogueUrl() ? " · catalogue link set" : " · no catalogue link yet"}. Shared with everyone in this workspace, on every device.`;
          })()}</p>
          <div class="actions">
            <button class="secondary editWhatsappSettings" type="button">Edit messages &amp; catalogue</button>
          </div>
        </div>
        <div class="account-block">
          <h3>Privacy documents</h3>
          <p class="muted">Use these as starter pages before selling. Replace with lawyer-reviewed terms for production.</p>
          <div class="actions">
            <a href="/privacy-policy" target="_blank"><button class="secondary" type="button">Privacy policy</button></a>
            <a href="/terms" target="_blank"><button class="secondary" type="button">Terms</button></a>
            <a href="/retention.html" target="_blank"><button class="secondary" type="button">Data retention</button></a>
          </div>
        </div>
        <div class="account-block danger-zone">
          <h3>Delete account</h3>
          <p class="muted">This permanently removes the workspace, contacts, card images, voice recordings and stored Google tokens.</p>
          <button id="deleteAccount" class="danger">Delete account</button>
        </div>
      </div>
    </section>
  `);
  initAccountBillingTabs(node);
  node.querySelectorAll("[data-one-time-plan]").forEach((btn) => btn.addEventListener("click", () => startOneTimePlan(btn.dataset.oneTimePlan)));
  node.querySelectorAll("[data-subscribe]").forEach((btn) => btn.addEventListener("click", () => startSubscription(btn.dataset.subscribe)));
  node.querySelector("#buyTopup")?.addEventListener("click", requestTopupPurchase);
  node.querySelectorAll(".disconnectGoogleAccount").forEach((btn) => btn.addEventListener("click", () => {
    state.modal = {
      title: "Disconnect Google?",
      body: "Sheets and Contacts share one Google account, so both will be disconnected. Card2Leads removes its stored tokens; sheets and contacts already in your Google account are left untouched. You can reconnect at any time.",
      confirmText: "Disconnect",
      onConfirm: async () => {
        await api("/api/google/disconnect", { method: "POST", body: {} });
        await refreshAll();
        setMessage("Google disconnected. Reconnect from Account whenever you need it.");
      }
    };
    render();
  }));
  node.querySelectorAll(".editWhatsappSettings").forEach((btn) => btn.addEventListener("click", showWhatsappSettingsModal));
  node.querySelector("#deleteAccount").addEventListener("click", () => {
    state.modal = {
      tone: "danger",
      title: "Delete this account?",
      body: "This cannot be undone from the app. Export your contacts first if you need a copy.",
      detail: state.organisation?.name || state.user.email,
      confirmText: "Delete account",
      confirmClass: "danger",
      onConfirm: async () => {
        await api("/api/account", { method: "DELETE", body: {} });
        state.user = null;
        state.organisation = null;
        state.csrfToken = "";
        state.overview = null;
        state.authInfo = "";
        state.authError = "";
        state.authActionLink = "";
        render();
      }
    };
    render();
  });
  return node;
}

function statusLabel(status) {
  return String(status || "").replace(/_/g, " ");
}

function syncStatusLabel(status) {
  const labels = {
    synced: "Synced",
    pending: "Pending",
    failed: "Sync failed",
    not_configured: "Not synced"
  };
  return labels[status] || statusLabel(status || "Not synced");
}

function displayDate(value) {
  if (!value) return "";
  const text = String(value);
  const date = new Date(text.includes("T") ? text : `${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { day: "2-digit", month: "long", year: "numeric" });
}

function displayDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB"];
  let value = bytes;
  let i = 0;
  while (value > 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

init().catch((err) => {
  document.getElementById("app").innerHTML = `<main class="auth-wrap"><div class="notice bad">${escapeHtml(err.message)}</div></main>`;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}
