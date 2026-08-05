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
  selectedFiles: [],
  processingCards: new Set(),
  selectedContactIds: new Set(),
  googleContactsSyncing: false,
  googleContactsSyncStatus: null,
  uploadMode: "existing",
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
  authError: "",
  authInfo: "",
  authActionLink: "",
  authActionText: "",
  pendingVerificationEmail: "",
  nativeIntroStep: 3,
  guestDemoStep: 0,
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
  mobileNumber: "Mobile Number",
  secondaryName: "Secondary Name (optional)",
  secondaryMobileNumber: "Secondary Mobile Number (optional)",
  tertiaryName: "Tertiary Name (optional)",
  tertiaryMobileNumber: "Tertiary Mobile Number (optional)",
  companyName: "Company Name",
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
  if (state.view === "account") slot.appendChild(accountView());
  if (state.modal) app.appendChild(modalView());
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
          <small>By BrillBrains</small>
        </a>
        <div class="public-links" aria-label="Product sections">
          <a href="#features">Features</a>
          <a href="#exports">Exports</a>
          <a href="#pricing">Pricing</a>
        </div>
        <div class="public-actions">
          <button type="button" class="secondary" data-auth-mode="login">Log in</button>
          <button type="button" data-auth-mode="signup">Start free</button>
        </div>
      </nav>

      <section class="public-hero" id="top">
        <div class="hero-copy">
          <p class="section-kicker">Built for exhibitions</p>
          <h1>Turn exhibition contact cards into clean follow-up sheets.</h1>
          <p class="hero-text">Snap one card or upload a whole batch. Card2Leads pulls out the details, flags anything unclear, then saves each approved contact to Excel, CSV, Google Sheets, or straight to your phone contacts — every one labelled by exhibition.</p>
          <div class="hero-actions">
            <button type="button" data-auth-mode="signup">Create account</button>
            <button type="button" class="secondary" data-auth-mode="login">Log in</button>
          </div>
        </div>
        <div class="hero-visual" aria-label="Card scanning preview">
          <img class="auth-illustration" src="/illustrations-final/main%20page%20illustration_before_login.png?v=final-20260729" alt="Business cards converted into a contact sheet" />
          <div class="mini-sheet" aria-hidden="true">
            <span>Name</span><span>Mobile</span><span>Interest</span>
            <strong>Riya Shah</strong><strong>+91 98765...</strong><strong>Bridal sets</strong>
            <strong>SP Jewellers</strong><strong>+91 99887...</strong><strong>Follow up</strong>
          </div>
        </div>
      </section>

      <section class="public-section features-section" id="features">
        <div class="features-copy">
          <p class="section-kicker">Features</p>
          <h2>Capture cards, voice notes, and exports in one simple flow.</h2>
          <div class="feature-strip" aria-label="Card2Leads highlights">
            <article>
              <span class="feature-icon">01</span>
              <strong>Instant card capture</strong>
              <p>Batch upload on desktop, camera scan on mobile.</p>
            </article>
            <article>
              <span class="feature-icon">02</span>
              <strong>Review before saving</strong>
              <p>Field confidence, duplicate checks, and fast edits.</p>
            </article>
            <article>
              <span class="feature-icon">03</span>
              <strong>Voice notes</strong>
              <p>Save raw interest notes in Hindi or English.</p>
            </article>
            <article>
              <span class="feature-icon">04</span>
              <strong>Save anywhere</strong>
              <p>Excel, CSV, Google Sheets, or straight to phone contacts — labelled by exhibition.</p>
            </article>
          </div>
        </div>
        <img class="features-illustration" src="/illustrations-final/features%20illustration.png?v=final-20260729" alt="Card2Leads feature overview" />
      </section>

      <section class="public-section public-feature-grid" id="exports">
        <article class="public-panel">
          <img class="panel-illustration" src="/illustrations-final/excel_save.png?v=final-20260729" alt="Contacts saved to a spreadsheet" />
          <div>
            <p class="section-kicker">Card export</p>
            <h2>Clean sheets, ready to use.</h2>
            <p>Save every approved contact to the next empty row, then download Excel/CSV or sync Google Sheets.</p>
          </div>
        </article>
        <article class="public-panel">
          <img class="panel-illustration" src="/illustrations-final/voice%20input%20illustration_right_section.png?v=final-20260729" alt="Voice note captured for a contact" />
          <div>
            <p class="section-kicker">Follow-up context</p>
            <h2>Remember every request.</h2>
            <p>Record Hindi or English voice notes and keep the transcript with the saved contact.</p>
          </div>
        </article>
      </section>

      <section class="public-section demo-panel" id="demo">
        <div class="demo-copy">
          <p class="section-kicker">Guided demo</p>
          <h2>See how scanned cards become a ready-to-use contact sheet.</h2>
          <p>Try a sample batch, review extracted details and voice notes, then preview the finished sheet. No account is needed for the demo.</p>
        </div>
        <div class="demo-steps" aria-label="Demo flow">
          <article><strong>1</strong><span>Upload sample cards</span><p>Use demo cards or selected images to show extraction.</p></article>
          <article><strong>2</strong><span>Review and add voice notes</span><p>Keep Hindi, English, or Hinglish context with each contact.</p></article>
          <article><strong>3</strong><span>Export preview</span><p>Preview the sheet. Login is requested before download/sync.</p></article>
        </div>
        <div class="demo-actions">
          <button type="button" data-demo-start>${state.guestDemoStep ? "Restart demo" : "Try the demo"}</button>
          <button type="button" class="secondary" data-auth-mode="login">I already have an account</button>
        </div>
        ${guestDemoMarkup()}
      </section>

      <section class="public-section pricing-section" id="pricing">
        <div class="pricing-heading">
          <div>
            <p class="section-kicker">Pricing</p>
            <h2>AI-powered contact capture for every exhibition.</h2>
          </div>
          <p>Every plan includes AI extraction, review, voice notes, and all exports — Excel, CSV, Google Sheets, Google Contacts, and phone contacts. Plans differ only by how many cards you scan.</p>
        </div>
        <div class="pricing-grid">
          <article class="price-card">
            <span class="price-label">Trial</span>
            <h3>Free</h3>
            <p>20 scans to try extraction, review, and voice notes.</p>
            <button type="button" class="secondary" data-auth-mode="signup">Start free</button>
          </article>
          <article class="price-card">
            <span class="price-label">Monthly</span>
            <h3><span>&#8377;499</span> / month</h3>
            <p>150 scans a month. Everything included.</p>
            <button type="button" class="secondary" data-auth-mode="signup" data-plan="monthly">Choose monthly</button>
          </article>
          <article class="price-card featured">
            <span class="price-label">Quarterly</span>
            <h3><span>&#8377;799</span> / 3 months</h3>
            <p>300 scans over 3 months. Best value for regular exhibitors.</p>
            <button type="button" data-auth-mode="signup" data-plan="quarterly">Choose quarterly</button>
          </article>
          <article class="price-card">
            <span class="price-label">Annual</span>
            <h3><span>&#8377;1,499</span> / year</h3>
            <p>1,500 scans a year at the lowest price per scan.</p>
            <button type="button" class="secondary" data-auth-mode="signup" data-plan="annual">Choose annual</button>
          </article>
        </div>
        <p class="pricing-note">Run out mid-plan? Add 100 scans for &#8377;499, anytime.</p>
      </section>

      <section class="public-section faq-section" id="faq">
        <div class="faq-head">
          <p class="section-kicker">FAQ</p>
          <h2>Questions, answered.</h2>
        </div>
        <div class="faq-grid">
          <details>
            <summary>Is my contact data private?</summary>
            <p>Your contacts stay in your own workspace. Exports and Google sync happen only when you choose them, and Google tokens are stored encrypted.</p>
          </details>
          <details>
            <summary>Which languages do voice notes support?</summary>
            <p>Record interest notes in Hindi, English, or a mix — the transcript is saved with each contact.</p>
          </details>
          <details>
            <summary>Do I need internet to scan?</summary>
            <p>Yes. Card extraction runs on AI in the cloud, so keep the device online while scanning and saving.</p>
          </details>
          <details>
            <summary>How are exhibition labels added?</summary>
            <p>Every contact is tagged with its exhibition name and year, so phone and Google Contacts group them automatically for follow-up.</p>
          </details>
        </div>
      </section>

      <section class="public-cta">
        <div class="public-cta-copy">
          <h2>Ready to turn cards into contacts?</h2>
          <p>Start free with 20 scans. No card details needed.</p>
        </div>
        <div class="public-cta-actions">
          <button type="button" data-auth-mode="signup">Create account</button>
          <button type="button" class="secondary" data-auth-mode="login">Log in</button>
        </div>
      </section>

      <footer class="public-footer">
        <div class="public-footer-brand">
          <strong>Card2Leads</strong>
          <span>By BrillBrains</span>
        </div>
        <nav class="public-footer-links" aria-label="Legal and contact">
          <a href="/privacy.html" target="_blank" rel="noopener">Privacy</a>
          <a href="/terms.html" target="_blank" rel="noopener">Terms</a>
          <a href="/retention.html" target="_blank" rel="noopener">Data retention</a>
          <a href="mailto:tech@brillbrainsconsultants.com">Contact</a>
        </nav>
        <p class="public-footer-note">&copy; ${new Date().getFullYear()} BrillBrains. All rights reserved.</p>
      </footer>
    </main>
  `);
  node.querySelectorAll("[data-auth-mode]").forEach((btn) => btn.addEventListener("click", () => openAuth(btn.dataset.authMode, btn.dataset.plan)));
  node.querySelectorAll("[data-demo-start]").forEach((btn) => btn.addEventListener("click", () => {
    state.guestDemoStep = 1;
    render();
    window.requestAnimationFrame(() => document.getElementById("demo")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }));
  node.querySelector("[data-demo-next]")?.addEventListener("click", () => {
    state.guestDemoStep = Math.min(3, state.guestDemoStep + 1);
    render();
    window.requestAnimationFrame(() => document.getElementById("demo")?.scrollIntoView({ block: "center" }));
  });
  return node;
}

function authScreen() {
  const isSignup = state.authMode === "signup";
  const isForgot = state.authMode === "forgot";
  const isReset = state.authMode === "reset";
  const node = el(`
    <main class="auth-screen">
      <div class="auth-screen-card">
        <button type="button" class="auth-back" data-auth-close>&larr; Back to site</button>
        <a class="auth-screen-brand" href="#top" data-auth-close><strong>Card2Leads</strong><span>By BrillBrains</span></a>
        ${authFormMarkup(isSignup, isForgot, isReset)}
      </div>
    </main>
  `);
  wireAuth(node);
  return node;
}

function authFormMarkup(isSignup, isForgot, isReset) {
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
      ${!isForgot && !isReset ? `<a class="google-login" href="/api/auth/google/start">Continue with Google</a><div class="divider"><span>or use email</span></div>` : ""}
      ${isSignup ? `<label>Full name <input name="name" autocomplete="name" required /></label>` : ""}
      ${isReset ? `<input name="token" type="hidden" value="${escapeAttr(state.resetToken)}" />` : `<label>Email <input name="email" type="email" autocomplete="email" required /></label>`}
      ${isForgot ? "" : `<label>Password <input name="password" type="password" autocomplete="${isSignup || isReset ? "new-password" : "current-password"}" required />${isSignup || isReset ? `<span class="field-help">Use at least 10 characters with uppercase, lowercase, number, and symbol.</span>` : ""}</label>`}
      ${isSignup ? `<label class="checkbox-label"><input name="acceptTerms" type="checkbox" required /> <span>I accept the <a href="/terms.html" target="_blank">terms</a> and <a href="/privacy.html" target="_blank">privacy policy</a></span></label>` : ""}
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

function wireAuth(node) {
  node.querySelectorAll("[data-auth-mode]").forEach((btn) => btn.addEventListener("click", () => openAuth(btn.dataset.authMode, btn.dataset.plan)));
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
}

function openAuth(mode, plan) {
  state.authMode = mode || "login";
  state.authOpen = true;
  state.authError = "";
  state.authInfo = "";
  state.authActionLink = "";
  state.authActionText = "";
  state.pendingVerificationEmail = "";
  if (plan) {
    try { localStorage.setItem("c2l_pending_plan", plan); } catch {}
  }
  render();
  window.scrollTo({ top: 0 });
}

// Reads back a plan chosen on the public pricing page before the user signed up
// or logged in, so checkout can resume automatically once they're in the app.
// Stored in localStorage (not just in-memory state) because email verification
// can involve a page reload or a link opened in a new tab.
function consumePendingPlanSelection() {
  let plan = "";
  try {
    plan = localStorage.getItem("c2l_pending_plan") || "";
    localStorage.removeItem("c2l_pending_plan");
  } catch {}
  return plan;
}

// Called once the user has actually landed in the authenticated app (not mid
// email-verification, not mid-onboarding) so a plan chosen on the public
// pricing page opens the exact same checkout used from the Account screen.
function resumePendingPlanCheckout() {
  if (state.overview?.needsOnboarding) return;
  const plan = consumePendingPlanSelection();
  if (!plan) return;
  navigateToView("account", { replace: true });
  setTimeout(() => startSubscription(plan), 300);
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
          <p>By BrillBrains</p>
          <span>Cards in. Contacts ready.</span>
        </div>
        <div class="native-splash-loader" aria-hidden="true"><i></i></div>
        <button type="button" class="native-splash-skip" data-native-next>Continue</button>
      </main>`)
    : el(`
      <main class="native-intro native-feature-slide" data-native-slide="${step}">
        <header class="native-intro-header">
          <div class="native-wordmark"><strong>Card2Leads</strong><span>By BrillBrains</span></div>
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

function guestDemoMarkup() {
  const step = state.guestDemoStep;
  if (!step) return "";
  const body = step === 1
    ? `<div class="demo-sample-files"><div><strong>Riya_Shah_card.jpg</strong><span>Ready to extract</span></div><div><strong>Sagar_Patel_card.jpg</strong><span>Ready to extract</span></div></div>`
    : step === 2
      ? `<div class="demo-review-grid"><div><span>Name</span><strong>Riya Shah</strong></div><div><span>Mobile</span><strong>+91 98765 43210</strong></div><div><span>Company</span><strong>ABC Exports</strong></div><div><span>Voice note</span><strong>Lightweight range mein interest hai. September mein follow up.</strong></div></div>`
      : `<div class="demo-export-wrap"><table><thead><tr><th>Name</th><th>Mobile</th><th>Company</th><th>Voice Notes</th></tr></thead><tbody><tr><td>Riya Shah</td><td>+91 98765 43210</td><td>ABC Exports</td><td>Lightweight range; follow up in September</td></tr><tr><td>Sagar Patel</td><td>+91 99887 54321</td><td>SP Traders</td><td>Send catalogue</td></tr></tbody></table></div>`;
  return `
    <div class="guest-demo" aria-live="polite">
      <div class="guest-demo-head"><strong>Step ${step} of 3</strong><span>${step === 1 ? "Sample cards selected" : step === 2 ? "Details reviewed" : "Export ready"}</span></div>
      ${body}
      <div class="actions">
        ${step < 3 ? `<button type="button" data-demo-next>${step === 1 ? "Extract sample cards" : "Preview export"}</button>` : `<button type="button" data-auth-mode="signup">Create account to download</button>`}
      </div>
    </div>`;
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
    review: "Review Extractions",
    contacts: "Contacts & Exports",
    account: "Account"
  }[state.view];
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><strong>Card2Leads</strong><span>${escapeHtml(state.organisation?.name || "Workspace")}</span></div>
        <nav class="nav">
          ${navButton("upload", "Upload")}
          ${navButton("review", `Review (${state.cards.length})`)}
          ${navButton("contacts", `Contacts & Exports (${state.contacts.length})`)}
          ${navButton("account", "Account")}
        </nav>
        <small>Signed in as ${escapeHtml(state.user.name)}</small>
      </aside>
      <main class="main">
        <section class="topbar">
          <div>
            <h1>${title}</h1>
            <span class="muted">${state.view === "upload" ? "Up to 20 cards at once &middot; one card per photo" : escapeHtml(state.overview?.activeCollection?.name || "")}</span>
          </div>
          <div class="topbar-actions">
            ${state.view === "account" ? "" : topbarUpgradeButtonHtml()}
            <span class="session-pill">${escapeHtml(state.user.name)}</span>
            <button id="logoutBtn" class="secondary">Log out</button>
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
  return `<button type="button" id="topbarUpgradeBtn" class="topbar-upgrade-btn ${isPaid && !needsAttention ? "secondary" : ""} ${needsAttention ? "danger" : ""}">${escapeHtml(label)}</button>`;
}

function navButton(view, label) {
  const mobileLabels = { upload: "Scan", review: "Review", contacts: "Contacts", account: "Account" };
  const icons = { upload: "&#9635;", review: "&#10003;", contacts: "&#9776;", account: "&#9675;" };
  const count = view === "review" ? state.cards.length : view === "contacts" ? state.contacts.length : 0;
  return `<button class="${state.view === view ? "active" : ""}" data-view="${view}" aria-label="${escapeAttr(label)}">
    <span class="nav-full">${label}</span>
    <span class="nav-mobile-icon" aria-hidden="true">${icons[view]}</span>
    <span class="nav-short">${mobileLabels[view]}</span>
    ${count ? `<span class="nav-count">${count}</span>` : ""}
  </button>`;
}

function exportHref(format, collectionId, ids = [], all = false, assigneeId = "") {
  const params = new URLSearchParams({ collectionId, csrf: state.csrfToken || "" });
  if (ids.length) params.set("ids", ids.join(","));
  if (all) params.set("all", "true");
  if (format === "vcf" && assigneeId) params.set("assigneeId", assigneeId);
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
            <label>Business name <input name="businessName" value="${escapeAttr(workspaceName)}" placeholder="Your business name" autocomplete="organization" required /></label>
            <label>Exhibition or event <span class="optional-label">Optional</span><input name="defaultExhibitionName" placeholder="For example, IIJS Premiere 2026" /></label>
            <div class="setup-reassurance wide">
              <span class="setup-check" aria-hidden="true">&#10003;</span>
              <p><strong>Your first contact sheet is automatic.</strong><br />Upload your cards and Card2Leads will prepare it for you.</p>
            </div>
            <div class="actions wide setup-actions">
              <button type="submit">Start scanning</button>
              <button type="button" class="secondary" id="skipSetup">Skip for now</button>
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
  node.querySelector("#skipSetup").addEventListener("click", async () => {
    await completeSetup({
      businessName: state.organisation?.name || generatedWorkspaceName,
      defaultExhibitionName: ""
    });
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
              : `<button type="button" class="secondary" data-modal-cancel>${escapeHtml(modal.cancelText || "Cancel")}</button><button type="button" class="${modal.confirmClass || "danger"}" data-modal-confirm>${escapeHtml(modal.confirmText || "Confirm")}</button>`
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
          <span class="destination-kicker">Saving cards to</span>
          <select id="existingCollectionSelect" aria-label="Choose the exhibition for this upload">
            ${collections.filter((collection) => collection.status !== "deleted").map((collection) => `<option value="${escapeAttr(collection.id)}" ${collection.id === selectedExistingId ? "selected" : ""}>${escapeHtml(collection.exhibitionName || collection.name)}</option>`).join("")}
          </select>
        </label>
        <button type="button" class="secondary" id="startNewExhibition">New exhibition</button>
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1-1.6h6L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z" />
            <circle cx="12" cy="12.5" r="3.2" />
          </svg>
        </div>
        <strong>${state.selectedFiles.length ? `${state.selectedFiles.length} card${state.selectedFiles.length === 1 ? "" : "s"} added${state.selectedFiles.length < 20 ? " · add more or upload" : ""}` : "Drop card photos here or pick them below"}</strong>
        <p class="muted"><strong>Front side of each card</strong> — one card per photo. Add the back later only if it has extra details.</p>
        ${state.overview.usage ? `<p class="upload-allowance">${Number(state.overview.usage.remaining)} of ${Number(state.overview.usage.limit)} scans left on your plan</p>` : ""}
        <div class="dropzone-actions">
          <label class="upload-picker">
            <span>Choose photos</span>
            <input class="hidden-file" id="fileInput" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*" multiple />
          </label>
          <label class="upload-picker camera">
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
        <button id="uploadBtn" ${state.selectedFiles.length ? "" : "disabled"}>Upload and read cards</button>
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
    addSelectedFiles(cameraInput.files);
    if (cameraInput.files?.length) window.EasySaveNative?.haptic("success");
    render();
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
  return node;
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
    processingTitle.textContent = `Reading ${cardCount} card${cardCount === 1 ? "" : "s"} and extracting details`;
    node.querySelectorAll(".file-status").forEach((status) => {
      status.innerHTML = `<span class="inline-spinner" aria-hidden="true"></span> Reading card details`;
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
    recordExtractionTime(cardCount, Date.now() - startedAt);
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
    state.message = { text: `${result.cards.length} card(s) uploaded. Review and save each contact to add it to the sheet/export.`, bad: false };
    window.EasySaveNative?.haptic("success");
    navigateToView("review");
  } catch (err) {
    setMessage(err.message, true);
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
  if (state.selectedFiles.length > 20) {
    state.selectedFiles.slice(20).forEach((file) => {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    });
    state.selectedFiles = state.selectedFiles.slice(0, 20);
  }
  // Photos are compressed in the browser before upload (see readCardFileData),
  // so the actual request is a fraction of the raw size. Keep a generous ceiling
  // that comfortably fits 20 high-resolution phone photos (~25 MB each).
  let totalBytes = state.selectedFiles.reduce((sum, file) => sum + Number(file.size || 0) + Number(file.backSideFile?.size || 0), 0);
  while (totalBytes > 600 * 1024 * 1024 && state.selectedFiles.length) {
    const removed = state.selectedFiles.pop();
    totalBytes -= Number(removed.size || 0);
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    state.message = { text: "This batch is very large. The last photo was removed — try uploading in two goes.", bad: true };
  }
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

function reviewView() {
  const validCount = state.cards.filter((card) => card.status === "completed" && card.extraction?.name && card.extraction?.mobileNumber).length;
  if (!state.cards.length) {
    const emptyNode = el(`
      <section class="panel review-complete-state">
        <div class="review-complete-icon" aria-hidden="true">&#10003;</div>
        <div>
          <h2>All cards reviewed</h2>
          <p class="muted">Your saved contacts are ready. You can open Contacts or upload another batch.</p>
        </div>
        <div class="actions">
          <button type="button" data-empty-review-view="contacts">Open contacts</button>
          <button type="button" class="secondary" data-empty-review-view="upload">Upload more cards</button>
        </div>
      </section>
    `);
    emptyNode.querySelectorAll("[data-empty-review-view]").forEach((button) => {
      button.addEventListener("click", () => {
        clearMessage(false);
        navigateToView(button.dataset.emptyReviewView);
      });
    });
    return emptyNode;
  }
  const node = el(`
    <section class="panel review-panel">
      <div class="section-heading review-heading">
        <div>
          <h2>Cards awaiting review</h2>
          <p class="muted">Tab through fields, press Ctrl+Enter to save the focused card, or save all valid contacts in one action.</p>
        </div>
        <div class="actions review-heading-actions">
          <button type="button" class="secondary" id="voiceBatch" ${state.cards.length ? "" : "disabled"}><span class="button-mic-icon" aria-hidden="true"></span>Add voice note to batch</button>
          <button id="saveAllValid" ${validCount ? "" : "disabled"}>Save all valid contacts (${validCount})</button>
        </div>
      </div>
      <div class="review-list"></div>
    </section>
  `);
  node.querySelector("#saveAllValid").addEventListener("click", saveAllValidContacts);
  node.querySelector("#voiceBatch").addEventListener("click", () => {
    const ids = state.cards.map((card) => card.id);
    showVoiceNoteModal("batch", ids, `${ids.length} review card(s)`);
  });
  const list = node.querySelector(".review-list");
  state.cards.forEach((card) => list.appendChild(cardReview(card)));
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
  const issues = raw.filter((w) => !isRotationText(w) && !isDuplicateText(w));
  if (card.duplicateImageOf) {
    issues.unshift("This image appears to have been uploaded before. You can still save it if it is a valid separate contact.");
  }
  if (!issues.length) return "";
  if (issues.length === 1) {
    return `<div class="notice bad">${escapeHtml(issues[0])}</div>`;
  }
  return `<div class="notice bad"><ul class="notice-list">${issues.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`;
}

function cardReview(card) {
  const fields = { ...card.extraction };
  const fieldConfidence = { ...(card.extraction?.fieldConfidence || {}) };
  normalizeReviewPhoneFields(fields, fieldConfidence);
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
  const input = multiline
    ? `<textarea name="${field}" rows="3">${escapeHtml(value)}</textarea>`
    : `<input name="${field}" value="${escapeAttr(value)}" ${field === "exhibitionDate" ? 'type="date"' : ""} ${required ? "required" : ""} />`;
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

function voiceSummaryView(source = {}) {
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
          <label>Voice-note transcript <textarea id="voiceTranscript" rows="4" readonly></textarea></label>
          <div class="grid two">
            <label>Interest <input id="voiceInterest" readonly /></label>
            <label>Budget <input id="voiceBudget" readonly /></label>
            <label>Follow-up <input id="voiceFollowUp" readonly /></label>
            <label>Special requirement <input id="voiceRequirement" readonly /></label>
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
      node.querySelector("#voiceTranscript").value = voiceNote.transcript || "";
      node.querySelector("#voiceInterest").value = voiceNote.interest || "";
      node.querySelector("#voiceBudget").value = voiceNote.budget || "";
      node.querySelector("#voiceFollowUp").value = voiceNote.followUpDate || "";
      node.querySelector("#voiceRequirement").value = voiceNote.specialRequirement || "";
      node.querySelector("#voiceAudioLink").innerHTML = voiceNote.audioUrl ? `<audio controls preload="none" src="${escapeAttr(voiceNote.audioUrl)}"></audio>` : "";
      resultBox.classList.remove("hidden");
      applyBtn.disabled = false;
      liveLabel.textContent = "Voice note ready";
      const confirmText = targetIds.length > 1
        ? `Review carefully. Apply only if this note belongs to all ${targetLabel}.`
        : "Transcript ready. Review it, then apply the voice note.";
      setStatus(confirmText);
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
        body: { targetIds }
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
  const exportMenu = activeCollectionId ? `
    <details class="export-sync-menu">
      <summary>Export &amp; sync</summary>
      <div class="export-sync-popover">
        <span class="export-sync-heading">Download</span>
        <a href="${exportHref("xlsx", activeCollectionId, [], true)}">Download Excel</a>
        <a href="${exportHref("csv", activeCollectionId, [], true)}">Download CSV</a>
        <a href="${exportHref("vcf", activeCollectionId, [], false, filters.assignee)}">Download exhibition VCF${assigneeFilterLabel ? ` (${escapeHtml(assigneeFilterLabel)})` : ""}</a>
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
  const node = el(`
    <section class="panel">
      <div class="contacts-toolbar">
        <div class="contacts-toolbar-copy"><h2>Saved contacts</h2><span class="muted">Search, filter, assign, add voice notes, or export.</span></div>
        <div class="actions contacts-toolbar-actions">
          <div class="search-field">
            <input id="searchBox" aria-label="Search contacts" placeholder="Search name, number, or company" value="${escapeAttr(state.contactSearchQuery)}" />
            ${state.contactSearchQuery ? `<button type="button" class="search-clear" id="clearSearchBox" aria-label="Clear search">&times;</button>` : ""}
          </div>
          <button type="button" class="secondary" id="manageTeamButton">${state.teamMembers.length ? `Team members (${state.teamMembers.length})` : "+ Add a team member"}</button>
          ${exportMenu}
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
          <button class="secondary compact-action" id="bulkVoiceContacts"><span class="button-mic-icon" aria-hidden="true"></span>Voice note</button>
          ${activeCollectionId ? `<a href="${exportHref("xlsx", activeCollectionId, selectedIds)}"><button type="button" class="secondary compact-action">Excel</button></a><a href="${exportHref("csv", activeCollectionId, selectedIds)}"><button type="button" class="secondary compact-action">CSV</button></a><a href="${exportHref("vcf", activeCollectionId, selectedIds)}"><button type="button" class="secondary compact-action">VCF</button></a>` : ""}
          <button class="danger compact-action" id="bulkDeleteContacts">Delete</button>
        </div>
      </div>
      <ul class="contact-list"></ul>
      ${visibleContacts.length ? "" : `<p class="contact-empty">No contacts match these filters.</p>`}`}
    </section>
  `);
  const tbody = node.querySelector(".contact-list");
  tbody.innerHTML = visibleContacts.map((contact) => `
    <li class="contact-card">
      <label class="contact-card-check"><input aria-label="Select ${escapeAttr(contact.name)}" type="checkbox" data-select-contact="${contact.id}" ${state.selectedContactIds.has(contact.id) ? "checked" : ""} /></label>
      <div class="contact-card-info">
        <div class="contact-card-head">
          <strong>${escapeHtml(contact.name)}</strong>
          <span class="contact-card-phone phone-value">${escapeHtml(contact.mobileNumber)}</span>
        </div>
        <div class="contact-card-sub">
          ${contact.companyName ? `<span>${escapeHtml(contact.companyName)}${contact.designation ? ` · ${escapeHtml(contact.designation)}` : ""}</span>` : ""}
          ${contact.city || contact.state ? `<span>${[contact.city, contact.state].filter(Boolean).map(escapeHtml).join(", ")}</span>` : ""}
          ${contact.exhibitionName ? `<span class="contact-card-tag">${escapeHtml(contact.exhibitionName)}${contact.exhibitionDate ? ` · ${escapeHtml(displayDate(contact.exhibitionDate))}` : ""}</span>` : ""}
        </div>
      </div>
      <label class="contact-card-assign">
        <span class="contact-card-assign-label">Assigned to</span>
        <select class="assign-select" data-assign="${contact.id}" aria-label="Assign ${escapeAttr(contact.name)} to a team member">
          <option value="">Unassigned</option>
          ${state.teamMembers.map((m) => `<option value="${m.id}"${contact.assignedToId === m.id ? " selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}
          ${contact.assignedToId && !state.teamMembers.some((m) => m.id === contact.assignedToId) ? `<option value="${contact.assignedToId}" selected>${escapeHtml(contact.assignedToName || "Assigned")}</option>` : ""}
          <option value="__add">+ Add a team member…</option>
        </select>
      </label>
      <div class="contact-card-actions">
        <button class="secondary compact-action" data-voice-contact="${contact.id}" data-contact-name="${escapeAttr(contact.name)}" title="Add or replace voice note"><span class="button-mic-icon" aria-hidden="true"></span>Voice note</button>
        <button class="secondary compact-action" data-edit="${contact.id}" title="Edit contact">Edit</button>
        <button class="danger compact-action" data-delete="${contact.id}" data-contact-name="${escapeAttr(contact.name)}" title="Delete contact">Delete</button>
      </div>
    </li>
  `).join("");
  node.querySelector("#selectAllContacts").addEventListener("change", (event) => {
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
  tbody.querySelectorAll("[data-select-contact]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selectedContactIds.add(checkbox.dataset.selectContact);
    else state.selectedContactIds.delete(checkbox.dataset.selectContact);
    render();
  }));
  tbody.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => {
    const contact = state.contacts.find((item) => item.id === btn.dataset.edit);
    if (contact) showEditContactModal(contact);
  }));
  tbody.querySelectorAll("[data-assign]").forEach((select) => select.addEventListener("change", () => {
    if (select.value === "__add") {
      render();
      showManageTeamModal();
      return;
    }
    assignContact(select.dataset.assign, select.value);
  }));
  node.querySelector("#manageTeamButton")?.addEventListener("click", showManageTeamModal);
  node.querySelector("#contactsEmptyUpload")?.addEventListener("click", () => navigateToView("upload"));
  tbody.querySelectorAll("[data-voice-contact]").forEach((btn) => btn.addEventListener("click", () => {
    showVoiceNoteModal("contact", [btn.dataset.voiceContact], btn.dataset.contactName || "this contact");
  }));
  tbody.querySelectorAll("[data-delete]").forEach((btn) => btn.addEventListener("click", () => {
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
  node.querySelector("#bulkVoiceContacts")?.addEventListener("click", () => {
    showVoiceNoteModal("contacts", selectedIds, `${selectedIds.length} selected contact(s)`);
  });
  node.querySelector("#createContactsGoogleSheet")?.addEventListener("click", async (event) => {
    await createContactsGoogleSheet(event.currentTarget, activeCollectionId);
  });
  node.querySelector("#syncContactsGoogleSheet")?.addEventListener("click", async (event) => {
    await syncContactsGoogleSheet(event.currentTarget, activeCollectionId);
  });
  node.querySelector("#syncGoogleContacts")?.addEventListener("click", async (event) => {
    await prepareGoogleContactsSync(event.currentTarget, selectedIds, activeCollectionId, activeCollection);
  });
  node.querySelector('[data-menu-action="create-sheet"]')?.addEventListener("click", async (event) => {
    await createContactsGoogleSheet(event.currentTarget, activeCollectionId);
  });
  node.querySelector('[data-menu-action="sync-sheet"]')?.addEventListener("click", async (event) => {
    await syncContactsGoogleSheet(event.currentTarget, activeCollectionId);
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

async function syncContactsGoogleSheet(button, collectionId) {
  button.disabled = true;
  try {
    const result = await api("/api/google/sync", { method: "POST", body: { collectionId } });
    await refreshAll();
    setMessage(`${result.synced || state.contacts.length} contact(s) synced to Google Sheets.`);
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
          state.message = { text: `${order.scans} scans added to your plan.`, bad: false };
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
  const initials = (state.user?.name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "?";
  const usagePercent = Math.min(100, Math.round((Number(usage.used || 0) / Math.max(1, Number(usage.limit || 1))) * 100));
  const topupBalance = Number(billing.topupBalance || 0);
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
          : `<p class="muted">You are on the <strong>Free</strong> plan. Choose a plan to scan more cards.</p>`}
        ${billing.configured ? `
          <div class="plan-choices">
            <button type="button" class="secondary" data-subscribe="monthly" ${billing.availablePlans.includes("monthly") ? "" : "disabled"}>Monthly · ₹499 / 150 scans</button>
            <button type="button" class="secondary" data-subscribe="quarterly" ${billing.availablePlans.includes("quarterly") ? "" : "disabled"}>Quarterly · ₹799 / 300 scans</button>
            <button type="button" class="secondary" data-subscribe="annual" ${billing.availablePlans.includes("annual") ? "" : "disabled"}>Annual · ₹1,499 / 1,500 scans</button>
          </div>
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
            ${google.sheetsConnected ? `<button id="disconnectGoogle" class="secondary">Disconnect Google</button>` : google.configured ? `<a href="/api/google/connect?feature=sheets"><button class="secondary" type="button">Connect Google Sheets</button></a>` : `<span class="muted">Google OAuth is not configured.</span>`}
          </div>
        </div>
        <div class="account-block">
          <h3>Privacy documents</h3>
          <p class="muted">Use these as starter pages before selling. Replace with lawyer-reviewed terms for production.</p>
          <div class="actions">
            <a href="/privacy.html" target="_blank"><button class="secondary" type="button">Privacy policy</button></a>
            <a href="/terms.html" target="_blank"><button class="secondary" type="button">Terms</button></a>
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
  node.querySelector("#disconnectGoogle")?.addEventListener("click", () => {
    state.modal = {
      title: "Disconnect Google Sheets?",
      body: "Card2Leads will remove the stored Google tokens. Existing Google Sheets stay in your Google Drive.",
      confirmText: "Disconnect",
      onConfirm: async () => {
        await api("/api/google/disconnect", { method: "POST", body: {} });
        await refreshAll();
        setMessage("Google Sheets disconnected.");
      }
    };
    render();
  });
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
  const date = new Date(`${value}T00:00:00`);
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
