/* Card2Leads Admin — SPA (zero-build vanilla JS).
 * Talks to the shared backend at /api/admin/* (same origin in production via
 * the admin subdomain's nginx proxy). Override for local dev with:
 *   <script>window.ADMIN_API_BASE = "http://localhost:3000"</script>
 */
(function () {
  "use strict";

  var API = (window.ADMIN_API_BASE || "").replace(/\/$/, "");
  var app = document.getElementById("app");
  var state = { admin: null, route: "dashboard", client: null };

  // ---------- API helper ----------
  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(API + path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "include"
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((data && data.error) || "Request failed");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtDate(iso) { if (!iso) return "—"; var d = new Date(iso); return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
  function fmtDateTime(iso) { if (!iso) return "—"; var d = new Date(iso); return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  function fmtRel(iso) {
    if (!iso) return "Never";
    var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 2592000) return Math.floor(s / 86400) + "d ago";
    return fmtDate(iso);
  }
  function money(paise, currency) { return (currency || "INR") === "INR" ? "₹" + (Number(paise || 0) / 100).toLocaleString("en-IN") : (Number(paise || 0) / 100).toFixed(2); }

  var LIFECYCLE_BADGE = {
    REGISTERED: "b-reg", ACTIVATED: "b-act", ENGAGED: "b-eng", PAID: "b-paid", RENEWED: "b-paid",
    PAYMENT_FAILED: "b-danger", SUSPENDED: "b-warn", PENDING_DELETION: "b-danger", CHURNED: "b-warn"
  };
  function lifecycleBadge(l) { return '<span class="badge ' + (LIFECYCLE_BADGE[l] || "b-reg") + '">' + esc((l || "").replace(/_/g, " ")) + "</span>"; }
  function statusBadge(s) {
    var map = { ACTIVE: "b-paid", SUSPENDED: "b-warn", PENDING_DELETION: "b-danger", DELETED: "b-reg" };
    return '<span class="badge ' + (map[s] || "b-reg") + '">' + esc((s || "").replace(/_/g, " ")) + "</span>";
  }

  var ICONS = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
    clients: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>',
    analytics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    payments: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
  };
  var LOGO = '<span class="brand-mark"><span class="dot">C2</span> Card2Leads Admin</span>';

  // ================= LOGIN =================
  function renderLogin(errMsg) {
    app.innerHTML =
      '<div class="login-wrap"><div class="login-card">' +
      LOGO +
      "<h1>Sign in</h1><p class=\"sub\">Internal operations console. Authorised administrators only.</p>" +
      (errMsg ? '<div class="form-error">' + esc(errMsg) + "</div>" : "") +
      '<form id="loginForm">' +
      '<div class="field"><label>Email</label><input type="email" name="email" autocomplete="username" required></div>' +
      '<div class="field"><label>Password</label><input type="password" name="password" autocomplete="current-password" required></div>' +
      '<button class="btn btn-primary" type="submit" id="loginBtn">Sign in</button>' +
      '</form><p class="form-help">Need another login? A super-admin can add administrators from Settings after signing in.</p></div></div>';
    document.getElementById("loginForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = document.getElementById("loginBtn");
      btn.disabled = true; btn.textContent = "Signing in…";
      try {
        var body = { email: e.target.email.value, password: e.target.password.value };
        var out = await api("/api/admin/auth/login", { method: "POST", body: body });
        state.admin = out.admin;
        location.hash = "#/dashboard";
        renderShell();
      } catch (err) {
        renderLogin(err.status === 401 ? "Incorrect email or password." : (err.message || "Could not sign in."));
      }
    });
  }

  function renderFirstAdminSetup(status, errMsg) {
    var unavailable = status && status.setupAvailable === false;
    app.innerHTML =
      '<div class="login-wrap"><div class="login-card setup-card">' + LOGO +
      '<h1>Create the first administrator</h1>' +
      '<p class="sub">No admin login exists yet. This one-time setup creates the first super-admin and then disables itself.</p>' +
      (errMsg ? '<div class="form-error">' + esc(errMsg) + '</div>' : '') +
      (unavailable
        ? '<div class="setup-note">For production safety, set <code>ADMIN_SETUP_TOKEN</code> on the backend and restart it, then reload this page.</div>'
        : '<form id="setupForm">' +
          '<div class="field"><label>Full name</label><input name="name" autocomplete="name" required></div>' +
          '<div class="field"><label>Email</label><input type="email" name="email" autocomplete="username" required></div>' +
          (status && status.tokenRequired ? '<div class="field"><label>Setup code</label><input type="password" name="setupToken" autocomplete="one-time-code" required></div>' : '') +
          '<div class="field"><label>Password</label><input type="password" name="password" autocomplete="new-password" required></div>' +
          '<div class="field"><label>Confirm password</label><input type="password" name="confirmPassword" autocomplete="new-password" required></div>' +
          '<p class="password-hint">Use at least 10 characters with uppercase, lowercase, a number and a symbol.</p>' +
          '<button class="btn btn-primary" type="submit" id="setupBtn">Create super-admin</button></form>') +
      '</div></div>';
    if (unavailable) return;
    document.getElementById("setupForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var fields = e.target.elements;
      if (fields.password.value !== fields.confirmPassword.value) {
        renderFirstAdminSetup(status, "Passwords do not match."); return;
      }
      var btn = document.getElementById("setupBtn");
      btn.disabled = true; btn.textContent = "Creating…";
      try {
        var out = await api("/api/admin/setup", { method: "POST", body: {
          name: fields.name.value.trim(), email: fields.email.value.trim(),
          password: fields.password.value, setupToken: fields.setupToken ? fields.setupToken.value : ""
        } });
        state.admin = out.admin;
        location.hash = "#/dashboard";
        renderShell();
      } catch (err) {
        if (err.status === 409) return renderLogin(err.message);
        renderFirstAdminSetup(status, err.message || "Could not create the first administrator.");
      }
    });
  }

  // ================= SHELL =================
  var NAV = [
    { key: "dashboard", label: "Dashboard", icon: "dashboard" },
    { key: "clients", label: "Clients", icon: "clients" },
    { key: "analytics", label: "Analytics", icon: "analytics" },
    { key: "payments", label: "Payments", icon: "payments" },
    { key: "appactivity", label: "App activity", icon: "activity" },
    { key: "activity", label: "Admin audit", icon: "activity" },
    { key: "settings", label: "Settings", icon: "settings" }
  ];
  var TITLES = { dashboard: "Dashboard", clients: "Clients", analytics: "Analytics", payments: "Payments", appactivity: "App activity", activity: "Admin audit", settings: "Settings" };

  function renderShell() {
    var nav = NAV.map(function (n) {
      return '<a class="nav-item' + (state.route === n.key ? " active" : "") + '" href="#/' + n.key + '">' + ICONS[n.icon] + "<span>" + n.label + "</span></a>";
    }).join("");
    app.innerHTML =
      '<div class="shell">' +
      '<aside class="sidebar">' + LOGO + nav +
      '<div class="spacer"></div>' +
      '<div class="who"><strong>' + esc(state.admin ? state.admin.name : "") + "</strong>" + esc(state.admin ? state.admin.email : "") +
      '<div><button class="link-btn" id="logoutBtn">Sign out</button></div></div>' +
      "</aside>" +
      '<div class="main">' +
      '<div class="topbar"><h2>' + esc(TITLES[state.route] || "") + "</h2>" +
      '<div class="search">' + ICONS.search + '<input id="globalSearch" placeholder="Search clients, users, email, mobile, client ID…"></div>' +
      "</div>" +
      '<div class="content" id="view"></div>' +
      "</div></div>";

    document.getElementById("logoutBtn").addEventListener("click", async function () {
      try { await api("/api/admin/auth/logout", { method: "POST" }); } catch (e) {}
      state.admin = null; location.hash = ""; renderLogin();
    });
    var gs = document.getElementById("globalSearch");
    gs.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { location.hash = "#/clients?q=" + encodeURIComponent(gs.value.trim()); }
    });
    routeView();
  }

  function routeView() {
    var view = document.getElementById("view");
    if (!view) return;
    if (state.route === "dashboard") return renderDashboard(view);
    if (state.route === "clients") return renderClients(view);
    if (state.route === "analytics") return renderAnalytics(view);
    if (state.route === "payments") return renderPayments(view);
    if (state.route === "appactivity") return renderAppActivity(view);
    if (state.route === "activity") return renderActivity(view);
    if (state.route === "settings") return renderSettings(view);
    return renderPlaceholder(view, TITLES[state.route]);
  }

  function renderPlaceholder(view, title) {
    view.innerHTML = '<div class="panel placeholder"><div class="tag">Coming soon</div><div>' + esc(title) + "</div></div>";
  }

  function loading(view) { view.innerHTML = '<div class="state"><div class="spinner"></div>Loading…</div>'; }
  function errorState(view, msg) { view.innerHTML = '<div class="state"><div class="big">Something went wrong</div>' + esc(msg || "") + "</div>"; }

  // ================= DASHBOARD =================
  async function renderDashboard(view) {
    loading(view);
    var d;
    try { d = await api("/api/admin/dashboard"); }
    catch (err) { if (err.status === 401) return forceLogin(); return errorState(view, err.message); }
    var k = d.kpis;
    var kpis = [
      { label: "Total Clients", value: k.totalClients },
      { label: "New Signups (7d)", value: k.newSignups7d },
      { label: "Activated", value: k.activatedUsers },
      { label: "Active Paid", value: k.activePaidClients },
      { label: "Signup → Paid", value: k.conversionPct + "%", small: true },
      { label: "Scans Today", value: k.scansToday },
      { label: "Failed Payments", value: k.failedPayments },
      { label: "Usage Exhausted", value: k.usageExhausted }
    ];
    var maxF = Math.max.apply(null, d.funnel.map(function (f) { return f.count; }).concat([1]));
    var base = d.funnel[0] ? d.funnel[0].count : 0;
    var funnelRows = d.funnel.map(function (f) {
      var pct = base ? Math.round((f.count / base) * 1000) / 10 : 0;
      var w = Math.max(2, Math.round((f.count / maxF) * 100));
      return '<div class="funnel-row"><div class="fname">' + esc(f.stage) + "</div>" +
        '<div class="funnel-bar"><span style="width:' + w + '%"></span></div>' +
        '<div class="fmeta"><b>' + f.count + "</b> · " + pct + "%</div></div>";
    }).join("");

    var a = d.attention;
    var queue = [
      { label: "Registered but not activated", n: a.registeredNotActivated, link: "REGISTERED" },
      { label: "Activated but not paid", n: a.activatedNotPaid, link: "ACTIVATED" },
      { label: "Payment failed", n: a.paymentFailed, hot: true, link: "PAYMENT_FAILED" },
      { label: "Usage exhausted", n: a.usageExhausted, hot: true },
      { label: "Suspended", n: a.suspended },
      { label: "Pending deletion", n: a.pendingDeletion, hot: true }
    ];
    var queueHtml = queue.map(function (q) {
      var href = q.link ? ' data-life="' + q.link + '"' : "";
      return '<div class="queue-item' + (q.hot && q.n > 0 ? " hot" : "") + '"' + href + (q.link ? ' style="cursor:pointer"' : "") + ">" +
        '<span class="qlabel">' + esc(q.label) + '</span><span class="qcount">' + q.n + "</span></div>";
    }).join("");

    view.innerHTML =
      '<div class="kpi-grid">' + kpis.map(function (c) {
        return '<div class="kpi"><div class="label">' + esc(c.label) + '</div><div class="value' + (c.small ? " small" : "") + '">' + esc(c.value) + "</div></div>";
      }).join("") + "</div>" +
      '<div class="two-col">' +
      '<div><div class="section-title">Conversion Funnel</div><div class="panel panel-pad">' + funnelRows + "</div></div>" +
      '<div><div class="section-title">Attention Required</div><div class="panel panel-pad">' + queueHtml + "</div></div>" +
      "</div>";

    Array.prototype.forEach.call(view.querySelectorAll(".queue-item[data-life]"), function (el) {
      el.addEventListener("click", function () { location.hash = "#/clients?lifecycle=" + el.getAttribute("data-life"); });
    });
  }

  // ================= CLIENTS =================
  function parseQuery() {
    var h = location.hash.split("?")[1] || "";
    var p = {};
    h.split("&").forEach(function (kv) { if (!kv) return; var x = kv.split("="); p[decodeURIComponent(x[0])] = decodeURIComponent(x[1] || ""); });
    return p;
  }

  async function renderClients(view) {
    var q = parseQuery();
    view.innerHTML =
      '<div class="toolbar">' +
      '<input id="cq" placeholder="Search name, email, mobile, client ID…" value="' + esc(q.q || "") + '" style="min-width:260px">' +
      '<select id="clife"><option value="">All lifecycles</option>' +
      ["REGISTERED", "ACTIVATED", "ENGAGED", "PAID", "RENEWED", "PAYMENT_FAILED", "SUSPENDED", "PENDING_DELETION"].map(function (l) {
        return '<option' + (q.lifecycle === l ? " selected" : "") + ">" + l + "</option>";
      }).join("") + "</select>" +
      '<select id="cstatus"><option value="">All statuses</option>' +
      ["ACTIVE", "SUSPENDED", "PENDING_DELETION"].map(function (s) {
        return '<option' + (q.status === s ? " selected" : "") + ">" + s + "</option>";
      }).join("") + "</select>" +
      '<button class="btn-sm btn-brand" id="createClientBtn" style="margin-left:auto">Create & invite client</button>' +
      "</div>" +
      '<div id="clientsTable"></div>';

    var tableEl = document.getElementById("clientsTable");
    var page = Number(q.page || 1);

    async function load() {
      loading(tableEl);
      var qs = "?q=" + encodeURIComponent(document.getElementById("cq").value.trim()) +
        "&lifecycle=" + encodeURIComponent(document.getElementById("clife").value) +
        "&status=" + encodeURIComponent(document.getElementById("cstatus").value) +
        "&page=" + page + "&pageSize=25";
      var d;
      try { d = await api("/api/admin/clients" + qs); }
      catch (err) { if (err.status === 401) return forceLogin(); return errorState(tableEl, err.message); }
      if (!d.clients.length) {
        tableEl.innerHTML = '<div class="state"><div class="big">No clients found</div>Try adjusting your search or filters.</div>';
        return;
      }
      var rows = d.clients.map(function (c) {
        var u = c.usage;
        return '<tr data-id="' + esc(c.clientId) + '">' +
          '<td><div class="cell-strong">' + esc(c.clientName) + '</div><div class="cell-sub">' + esc(c.clientId) + "</div></td>" +
          "<td>" + (c.primaryUser ? '<div>' + esc(c.primaryUser.name || "—") + '</div><div class="cell-sub">' + esc(c.email || "") + "</div>" : "—") + "</td>" +
          "<td>" + lifecycleBadge(c.lifecycle) + "</td>" +
          "<td>" + esc(c.plan) + "</td>" +
          "<td>" + esc(c.subscriptionStatus) + "</td>" +
          '<td>' + u.used + " / " + (u.limit || "—") + "</td>" +
          "<td>" + fmtRel(c.lastActivityAt) + "</td>" +
          "<td>" + fmtDate(c.createdAt) + "</td></tr>";
      }).join("");
      tableEl.innerHTML =
        '<div class="table-wrap"><table><thead><tr>' +
        "<th>Client</th><th>Primary User</th><th>Lifecycle</th><th>Plan</th><th>Subscription</th><th>Usage</th><th>Last Active</th><th>Joined</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
        '<div class="pager"><span>' + d.total + " client" + (d.total === 1 ? "" : "s") + " · page " + d.page + " of " + d.totalPages + "</span>" +
        '<span class="btns"><button id="prev"' + (d.page <= 1 ? " disabled" : "") + ">Previous</button>" +
        '<button id="next"' + (d.page >= d.totalPages ? " disabled" : "") + ">Next</button></span></div>";

      Array.prototype.forEach.call(tableEl.querySelectorAll("tbody tr"), function (tr) {
        tr.addEventListener("click", function () { openClient(tr.getAttribute("data-id")); });
      });
      var prev = document.getElementById("prev"), next = document.getElementById("next");
      if (prev) prev.addEventListener("click", function () { page = Math.max(1, page - 1); load(); });
      if (next) next.addEventListener("click", function () { page = page + 1; load(); });
    }

    var deb;
    document.getElementById("cq").addEventListener("input", function () { clearTimeout(deb); deb = setTimeout(function () { page = 1; load(); }, 250); });
    document.getElementById("clife").addEventListener("change", function () { page = 1; load(); });
    document.getElementById("cstatus").addEventListener("change", function () { page = 1; load(); });
    document.getElementById("createClientBtn").addEventListener("click", function () { openCreateClientModal(load); });
    load();
  }

  function openCreateClientModal(refresh) {
    var scrim = document.createElement("div");
    scrim.className = "modal-scrim";
    scrim.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true"><h3>Create & invite client</h3>' +
      '<p class="modal-sub">Creates a zero-credit workspace and emails the owner a secure password-setup link.</p>' +
      '<div class="modal-error" hidden></div><div class="modal-body">' +
      '<div><label>Client / company name</label><input data-f="clientName" autocomplete="organization"></div>' +
      '<div><label>Owner name</label><input data-f="ownerName" autocomplete="name"></div>' +
      '<div><label>Owner email</label><input data-f="email" type="email" autocomplete="email"></div>' +
      '<div><label>Phone (optional)</label><input data-f="phone" autocomplete="tel"></div>' +
      '</div><div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" style="width:auto" data-submit>Create & send invite</button></div></div>';
    document.body.appendChild(scrim);
    function close() { scrim.remove(); }
    scrim.addEventListener("click", function (e) { if (e.target === scrim) close(); });
    scrim.querySelector("[data-cancel]").addEventListener("click", close);
    var errBox = scrim.querySelector(".modal-error");
    var btn = scrim.querySelector("[data-submit]");
    var done = false;
    btn.addEventListener("click", async function () {
      if (done) { close(); return; }
      var payload = {};
      Array.prototype.forEach.call(scrim.querySelectorAll("[data-f]"), function (input) { payload[input.getAttribute("data-f")] = input.value.trim(); });
      if (!payload.clientName || !payload.ownerName || !payload.email) {
        errBox.hidden = false; errBox.textContent = "Client name, owner name and email are required."; return;
      }
      btn.disabled = true; btn.textContent = "Creating…";
      try {
        var result = await api("/api/admin/clients", { method: "POST", body: payload });
        if (refresh) refresh();
        if (result.invitationLink) {
          scrim.querySelector(".modal-sub").textContent = result.warning || "Client created. Share this setup link securely.";
          scrim.querySelector(".modal-body").innerHTML = '<div><label>One-time setup link</label><input value="' + esc(result.invitationLink) + '" readonly></div>';
          btn.textContent = "Done"; btn.disabled = false;
          done = true;
          scrim.querySelector("[data-cancel]").hidden = true;
        } else {
          close();
        }
      } catch (err) {
        errBox.hidden = false; errBox.textContent = err.message || "Client creation failed.";
        btn.disabled = false; btn.textContent = "Create & send invite";
      }
    });
  }

  // ================= CLIENT DETAIL DRAWER =================
  async function openClient(clientId) {
    var scrim = document.createElement("div");
    scrim.className = "drawer-scrim";
    var drawer = document.createElement("div");
    drawer.className = "drawer";
    drawer.innerHTML = '<div class="state" style="padding-top:120px"><div class="spinner"></div>Loading client…</div>';
    document.body.appendChild(scrim);
    document.body.appendChild(drawer);
    function close() { scrim.remove(); drawer.remove(); }
    scrim.addEventListener("click", close);

    var c;
    try { c = await api("/api/admin/clients/" + encodeURIComponent(clientId)); }
    catch (err) { drawer.innerHTML = '<div class="state" style="padding-top:120px"><div class="big">Could not load client</div>' + esc(err.message) + "</div>"; return; }

    var u = c.usage;
    var pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 0;
    var meterClass = pct >= 100 ? "danger" : pct >= 80 ? "warn" : "";

    var usersHtml = c.users.length ? '<table class="mini-table"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Status</th></tr></thead><tbody>' +
      c.users.map(function (x) { return "<tr><td>" + esc(x.name) + "</td><td>" + esc(x.email) + "</td><td>" + esc(x.phone || "—") + "</td><td>" + esc(x.status) + "</td></tr>"; }).join("") +
      "</tbody></table>" : '<div class="empty-mini">No users.</div>';

    var timeline = (c.timeline && c.timeline.length) ?
      '<ul class="timeline">' + c.timeline.map(function (e) {
        return "<li><span class=\"t-when\">" + fmtDateTime(e.created_at) + "</span><span>" + esc((e.event_name || "").replace(/_/g, " ")) + "</span></li>";
      }).join("") + "</ul>" :
      '<div class="empty-mini">No product events yet. Journey events start recording once the customer app is instrumented (Phase 2).</div>';

    var ledger = (c.usageLedger && c.usageLedger.length) ?
      '<table class="mini-table"><thead><tr><th>When</th><th>Type</th><th>Qty</th><th>Reason</th></tr></thead><tbody>' +
      c.usageLedger.map(function (l) { return "<tr><td>" + fmtDateTime(l.created_at) + "</td><td>" + esc(l.transaction_type) + "</td><td>" + (l.balance_effect > 0 ? "+" : "") + l.balance_effect + "</td><td>" + esc(l.reason || "—") + "</td></tr>"; }).join("") +
      "</tbody></table>" :
      '<div class="empty-mini">No ledger entries yet. Populated once the usage ledger goes live (Phase 2).</div>';

    var payments = (c.payments && c.payments.length) ?
      '<table class="mini-table"><thead><tr><th>Date</th><th>Amount</th><th>Plan</th><th>Status</th></tr></thead><tbody>' +
      c.payments.map(function (p) { return "<tr><td>" + fmtDate(p.created_at) + "</td><td>" + money(p.amount_paise, p.currency) + "</td><td>" + esc(p.plan || "—") + "</td><td>" + esc(p.status) + "</td></tr>"; }).join("") +
      "</tbody></table>" :
      '<div class="empty-mini">No payment records yet.</div>';

    var subscriptions = (c.subscriptions && c.subscriptions.length) ?
      '<table class="mini-table"><thead><tr><th>Started</th><th>Plan</th><th>Mode</th><th>Status</th><th>Period end</th></tr></thead><tbody>' +
      c.subscriptions.map(function (s) { return "<tr><td>" + fmtDate(s.start_date || s.created_at) + "</td><td>" + esc(s.plan || "—") + "</td><td>" + esc(s.billing_mode || "—") + "</td><td>" + esc(s.status || "—") + "</td><td>" + fmtDate(s.current_period_end) + "</td></tr>"; }).join("") +
      "</tbody></table>" +
      '<ul class="timeline" style="margin-top:12px">' + c.subscriptions.reduce(function (all, s) {
        var history = s.metadata && Array.isArray(s.metadata.statusHistory) ? s.metadata.statusHistory : [];
        return all.concat(history.map(function (h) { return { at: h.at, status: h.status, source: h.source }; }));
      }, []).sort(function (a, b) { return String(b.at || "").localeCompare(String(a.at || "")); }).slice(0, 20).map(function (h) {
        return '<li><span class="t-when">' + fmtDateTime(h.at) + '</span><span>' + esc((h.status || "").replace(/_/g, " ")) + ' · ' + esc(h.source || "system") + '</span></li>';
      }).join("") + "</ul>" : '<div class="empty-mini">No subscription history yet.</div>';

    var g = c.googleIntegration || { status: "not_connected" };

    drawer.innerHTML =
      '<div class="drawer-head"><div class="row1"><div><h2>' + esc(c.clientName) + '</h2><div class="cid">Client ID: ' + esc(c.clientId) + "</div></div>" +
      '<button class="x-btn" id="closeDrawer">✕</button></div>' +
      '<div class="badges">' + statusBadge(c.accountStatus) + lifecycleBadge(c.lifecycle) +
      '<span class="badge b-reg">PLAN: ' + esc((c.plan || "").toUpperCase()) + "</span></div>" +
      actionsBar(c) + "</div>" +
      '<div class="drawer-body">' +

      '<div class="dcard"><h3>Account</h3><div class="body"><dl class="kv">' +
      "<dt>Primary contact</dt><dd>" + esc(c.primaryUser ? c.primaryUser.name : "—") + "</dd>" +
      "<dt>Email</dt><dd>" + esc(c.email || "—") + "</dd>" +
      "<dt>Phone</dt><dd>" + esc(c.phone || "—") + "</dd>" +
      "<dt>Users</dt><dd>" + c.userCount + "</dd>" +
      "<dt>Registered</dt><dd>" + fmtDate(c.createdAt) + "</dd>" +
      "<dt>Last activity</dt><dd>" + fmtRel(c.lastActivityAt) + "</dd>" +
      "</dl></div></div>" +

      '<div class="dcard"><h3>Usage & Billing</h3><div class="body">' +
      '<div style="font-size:22px;font-weight:700">' + u.used + " / " + (u.limit || "—") + ' <span style="font-size:13px;color:var(--text-soft);font-weight:500">scans used</span></div>' +
      '<div class="usage-meter"><span class="' + meterClass + '" style="width:' + pct + '%"></span></div>' +
      '<div class="cell-sub">' + u.remaining + " remaining · billing mode: " + esc(c.billingMode) + " · subscription: " + esc(c.subscriptionStatus) + "</div>" +
      '<div style="margin-top:14px"><div class="section-title" style="margin:0 0 8px">Usage ledger</div>' + ledger + "</div>" +
      "</div></div>" +

      '<div class="dcard"><h3>Journey & Activity</h3><div class="body">' + timeline + "</div></div>" +

      '<div class="dcard"><h3>Payments</h3><div class="body">' + payments + "</div></div>" +

      '<div class="dcard"><h3>Subscription history</h3><div class="body">' + subscriptions + "</div></div>" +

      '<div class="dcard"><h3>Users</h3><div class="body">' + usersHtml + "</div></div>" +

      '<div class="dcard"><h3>Google Integration</h3><div class="body"><dl class="kv">' +
      "<dt>Status</dt><dd>" + esc((g.status || "not_connected").replace(/_/g, " ")) + "</dd>" +
      (g.email ? "<dt>Account</dt><dd>" + esc(g.email) + "</dd>" : "") +
      (g.connectedAt ? "<dt>Connected</dt><dd>" + fmtDate(g.connectedAt) + "</dd>" : "") +
      "</dl></div></div>" +

      '<div class="dcard"><h3>Internal Notes</h3><div class="body">' +
      ((c.notes && c.notes.length) ? c.notes.map(function (n) {
        return '<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div>' + esc(n.note) + '</div><div class="cell-sub">' + esc(n.admin_email || "") + " · " + fmtDateTime(n.created_at) + "</div></div>";
      }).join("") : '<div class="empty-mini">No notes yet. Add-note and actions arrive in Phase 4.</div>') +
      "</div></div>" +

      "</div>";

    document.getElementById("closeDrawer").addEventListener("click", close);
    wireClientActions(drawer, c, function () { close(); openClient(clientId); });
  }

  // ---------- Client operational actions (Phase 4) ----------
  function actionsBar(c) {
    var locked = c.accountStatus === "SUSPENDED" || c.accountStatus === "PENDING_DELETION";
    var pendingInvitation = (c.users || []).some(function (u) { return u.status === "pending_invitation"; });
    var canCancel = c.billingMode === "subscription" && c.subscriptionStatus !== "cancelled" && c.subscriptionStatus !== "cancel_scheduled";
    return '<div class="drawer-actions">' +
      (pendingInvitation ? '<button class="btn-sm btn-brand" data-act="resend-invitation">Resend invite</button>' : "") +
      '<button class="btn-sm btn-brand" data-act="credits">Adjust Credits</button>' +
      '<button class="btn-sm" data-act="change-plan">Change Plan</button>' +
      (locked
        ? '<button class="btn-sm" data-act="reactivate">Reactivate</button>'
        : '<button class="btn-sm btn-warn" data-act="suspend">Suspend</button>') +
      '<button class="btn-sm" data-act="note">Add Note</button>' +
      '<div class="overflow"><button class="btn-sm" data-act="more" aria-haspopup="true">•••</button>' +
        '<div class="overflow-menu" hidden>' +
          (canCancel ? '<button data-act="cancel-subscription">Schedule cancellation</button>' : "") +
          '<button data-act="disconnect-google">Disconnect Google</button>' +
          '<button data-act="initiate-deletion" class="danger">Initiate Deletion</button>' +
        '</div></div>' +
      '</div>';
  }

  function wireClientActions(root, c, refresh) {
    var menu = root.querySelector(".overflow-menu");
    Array.prototype.forEach.call(root.querySelectorAll("[data-act]"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var act = btn.getAttribute("data-act");
        if (act === "more") { if (menu) menu.hidden = !menu.hidden; return; }
        if (menu) menu.hidden = true;
        openClientActionModal(c, act, refresh);
      });
    });
    root.addEventListener("click", function () { if (menu) menu.hidden = true; });
  }

  // Per-action modal config. `endpoint` is the URL segment on the backend.
  function actionSpec(c, act) {
    var plan = (c.plan || "").toUpperCase();
    switch (act) {
      case "credits": return {
        endpoint: "credits", title: "Adjust Credits", submitLabel: "Apply", brand: true,
        fields: [
          { key: "type", type: "segment", label: "Adjustment", options: [["add", "Add"], ["remove", "Remove"]], value: "add" },
          { key: "quantity", type: "number", label: "Quantity (scans)", required: true, placeholder: "e.g. 25", min: 1 },
          { key: "reason", type: "select", label: "Reason", required: true, options: [
            ["Promotional credit", "Promotional credit"], ["Customer support goodwill", "Customer support goodwill"],
            ["Billing adjustment", "Billing adjustment"], ["Product issue", "Product issue"],
            ["Manual correction", "Manual correction"], ["Other", "Other"] ] },
          { key: "note", type: "text", label: "Internal note (optional)", placeholder: "" }
        ]
      };
      case "change-plan": return {
        endpoint: "change-plan", title: "Change Plan", submitLabel: "Change plan", brand: true,
        sub: "Current plan: " + plan,
        fields: [
          { key: "plan", type: "select", label: "New plan", required: true, options: [
            ["monthly", "Monthly (150 scans)"], ["quarterly", "Quarterly (300 scans)"], ["annual", "Annual (1500 scans)"] ] },
          { key: "reason", type: "text", label: "Reason", required: true, placeholder: "Why is the plan changing?" }
        ]
      };
      case "suspend": return {
        endpoint: "suspend", title: "Suspend Account", submitLabel: "Suspend", warn: true,
        note: { kind: "warn", text: "The customer will lose access immediately. Their data is kept. You can reactivate later." },
        fields: [{ key: "reason", type: "text", label: "Reason", required: true, placeholder: "Why suspend this account?" }]
      };
      case "reactivate": return {
        endpoint: "reactivate", title: "Reactivate Account", submitLabel: "Reactivate", brand: true,
        fields: [{ key: "reason", type: "text", label: "Reason (optional)", placeholder: "" }]
      };
      case "note": return {
        endpoint: "notes", title: "Add Internal Note", submitLabel: "Save note", brand: true,
        sub: "Internal only — never shown to the customer.",
        fields: [{ key: "note", type: "textarea", label: "Note", required: true, placeholder: "e.g. Customer reported 20 failed scans at exhibition; added 25 goodwill credits." }]
      };
      case "cancel-subscription": return {
        endpoint: "cancel-subscription", title: "Schedule Subscription Cancellation", submitLabel: "Schedule cancellation", danger: true,
        note: { kind: "warn", text: "The payment provider will stop renewal at the end of the current billing period. Access and credits remain active until then." },
        fields: [{ key: "reason", type: "text", label: "Reason", required: true, placeholder: "Why cancel?" }]
      };
      case "resend-invitation": return {
        endpoint: "resend-invitation", title: "Resend Client Invitation", submitLabel: "Send invitation", brand: true,
        sub: "Generates a new seven-day setup link; the previous link stops working.", fields: []
      };
      case "disconnect-google": return {
        endpoint: "disconnect-google", title: "Disconnect Google", submitLabel: "Disconnect", warn: true,
        note: { kind: "warn", text: "Removes the stored Google connection and revokes tokens. The customer can reconnect anytime." },
        fields: [{ key: "reason", type: "text", label: "Reason (optional)", placeholder: "" }]
      };
      case "initiate-deletion": return {
        endpoint: "initiate-deletion", title: "Initiate Account Deletion", submitLabel: "Mark for deletion", danger: true,
        note: { kind: "danger", text: "The account is marked PENDING_DELETION and permanently purged after 30 days. High-impact — proceed carefully." },
        fields: [{ key: "reason", type: "text", label: "Reason", required: true, placeholder: "Why delete this account?" }]
      };
      default: return null;
    }
  }

  function openClientActionModal(c, act, refresh) {
    var spec = actionSpec(c, act);
    if (!spec) return;
    var values = {};
    spec.fields.forEach(function (f) { values[f.key] = f.value || ""; });

    var fieldsHtml = spec.fields.map(function (f) {
      if (f.type === "segment") {
        return '<div><label>' + esc(f.label) + '</label><div class="seg" data-seg="' + f.key + '">' +
          f.options.map(function (o) { return '<button type="button" data-val="' + o[0] + '"' + (values[f.key] === o[0] ? ' class="active"' : "") + ">" + esc(o[1]) + "</button>"; }).join("") +
          "</div></div>";
      }
      if (f.type === "select") {
        return '<div><label>' + esc(f.label) + '</label><select data-field="' + f.key + '">' +
          '<option value="">Choose…</option>' +
          f.options.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + "</option>"; }).join("") +
          "</select></div>";
      }
      if (f.type === "textarea") {
        return '<div><label>' + esc(f.label) + '</label><textarea data-field="' + f.key + '" placeholder="' + esc(f.placeholder || "") + '"></textarea></div>';
      }
      return '<div><label>' + esc(f.label) + '</label><input data-field="' + f.key + '" type="' + (f.type === "number" ? "number" : "text") + '"' +
        (f.min != null ? ' min="' + f.min + '"' : "") + ' placeholder="' + esc(f.placeholder || "") + '"></div>';
    }).join("");

    var noteHtml = spec.note ? '<div class="' + (spec.note.kind === "danger" ? "danger-note" : "warn-note") + '">' + esc(spec.note.text) + "</div>" : "";
    var submitClass = spec.danger ? "btn btn-primary" : (spec.brand || spec.warn ? "btn btn-primary" : "btn btn-primary");

    var scrim = document.createElement("div");
    scrim.className = "modal-scrim";
    scrim.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
      "<h3>" + esc(spec.title) + "</h3>" +
      (spec.sub ? '<p class="modal-sub">' + esc(spec.sub) + "</p>" : '<div style="height:12px"></div>') +
      '<div class="modal-error" hidden></div>' +
      '<div class="modal-body">' + noteHtml + fieldsHtml + "</div>" +
      '<div class="modal-foot"><button class="btn" data-cancel>Cancel</button>' +
      '<button class="' + submitClass + '" style="width:auto" data-submit>' + esc(spec.submitLabel) + "</button></div>" +
      "</div>";
    document.body.appendChild(scrim);
    function close() { scrim.remove(); }
    scrim.addEventListener("click", function (e) { if (e.target === scrim) close(); });
    scrim.querySelector("[data-cancel]").addEventListener("click", close);
    var errBox = scrim.querySelector(".modal-error");

    // Segment buttons
    Array.prototype.forEach.call(scrim.querySelectorAll(".seg"), function (seg) {
      var key = seg.getAttribute("data-seg");
      Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) {
        b.addEventListener("click", function () {
          values[key] = b.getAttribute("data-val");
          Array.prototype.forEach.call(seg.querySelectorAll("button"), function (x) { x.classList.remove("active"); });
          b.classList.add("active");
        });
      });
    });

    var submitBtn = scrim.querySelector("[data-submit]");
    submitBtn.addEventListener("click", async function () {
      spec.fields.forEach(function (f) {
        if (f.type === "segment") return;
        var elx = scrim.querySelector('[data-field="' + f.key + '"]');
        if (elx) values[f.key] = elx.value.trim();
      });
      // client-side required check
      var missing = spec.fields.filter(function (f) { return f.required && !values[f.key]; });
      if (missing.length) { errBox.hidden = false; errBox.textContent = "Please fill in: " + missing.map(function (f) { return f.label; }).join(", "); return; }

      var payload = {};
      spec.fields.forEach(function (f) { if (values[f.key] !== "" && values[f.key] != null) payload[f.key] = f.type === "number" ? Number(values[f.key]) : values[f.key]; });

      submitBtn.disabled = true; submitBtn.textContent = "Working…";
      try {
        var result = await api("/api/admin/clients/" + encodeURIComponent(c.clientId) + "/" + spec.endpoint, { method: "POST", body: payload });
        close();
        if (result.invitationLink) window.prompt("Email delivery is not configured. Copy this setup link:", result.invitationLink);
        if (refresh) refresh();
      } catch (err) {
        errBox.hidden = false; errBox.textContent = err.message || "Action failed.";
        submitBtn.disabled = false; submitBtn.textContent = spec.submitLabel;
      }
    });
  }

  // ================= ANALYTICS =================
  var RANGES = [["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"]];
  function renderAnalytics(view) {
    var range = "30d";
    view.innerHTML =
      '<div class="toolbar"><select id="anaRange">' +
      RANGES.map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === range ? " selected" : "") + ">" + r[1] + "</option>"; }).join("") +
      "</select></div><div id=\"anaBody\"></div>";
    var bodyEl = document.getElementById("anaBody");
    async function load() {
      loading(bodyEl);
      var d;
      try { d = await api("/api/admin/analytics?range=" + range); }
      catch (err) { if (err.status === 401) return forceLogin(); return errorState(bodyEl, err.message); }
      var a = d.activation, cv = d.conversion, eng = d.engagement;
      function kpi(label, val) { return '<div class="kpi"><div class="label">' + esc(label) + '</div><div class="value small">' + esc(val) + "</div></div>"; }
      var maxS = Math.max.apply(null, d.acquisition.series.map(function (s) { return s.count; }).concat([1]));
      var seriesBars = d.acquisition.series.length
        ? '<div style="display:flex;align-items:flex-end;gap:4px;height:120px;padding-top:8px">' +
          d.acquisition.series.map(function (s) {
            var h = Math.max(3, Math.round((s.count / maxS) * 100));
            return '<div title="' + esc(s.date) + ": " + s.count + '" style="flex:1;min-width:6px;background:var(--brand);height:' + h + '%;border-radius:3px 3px 0 0"></div>';
          }).join("") + "</div>"
        : '<div class="empty-mini">No signups in this range.</div>';
      bodyEl.innerHTML =
        '<div class="section-title">Acquisition</div>' +
        '<div class="kpi-grid">' + kpi("New Accounts", d.acquisition.newAccounts) + "</div>" +
        '<div class="panel panel-pad">' + seriesBars + "</div>" +
        '<div class="section-title">Activation</div>' +
        '<div class="kpi-grid">' + kpi("Registered", a.registered) + kpi("First Login", a.firstLogin) + kpi("First Scan", a.firstScan) + kpi("Signup → Activation", a.signupToActivationPct + "%") + "</div>" +
        '<div class="section-title">Conversion</div>' +
        '<div class="kpi-grid">' + kpi("Pricing Viewed", cv.pricingViewed) + kpi("Checkout Started", cv.checkoutStarted) + kpi("Paid", cv.paid) +
        kpi("Signup → Paid", cv.signupToPaidPct + "%") + kpi("Activation → Paid", cv.activationToPaidPct + "%") +
        kpi("Pricing → Checkout", cv.pricingToCheckoutPct + "%") + kpi("Checkout → Paid", cv.checkoutToPaidPct + "%") + "</div>" +
        '<div class="section-title">Engagement</div>' +
        '<div class="kpi-grid">' + kpi("Active Clients", eng.activeClients) + kpi("Cards Scanned", eng.scans) + kpi("Exports", eng.exports) + kpi("Google Connects", eng.googleConnects) + "</div>";
    }
    document.getElementById("anaRange").addEventListener("change", function (e) { range = e.target.value; load(); });
    load();
  }

  // ================= PAYMENTS =================
  function payStatusBadge(s) {
    var map = { paid: "b-paid", failed: "b-danger", pending: "b-warn", refunded: "b-reg" };
    return '<span class="badge ' + (map[String(s).toLowerCase()] || "b-reg") + '">' + esc(s) + "</span>";
  }
  function renderPayments(view) {
    var page = 1, status = "";
    view.innerHTML =
      '<div class="toolbar"><select id="payStatus"><option value="">All statuses</option>' +
      ["paid", "failed", "pending", "refunded"].map(function (s) { return "<option>" + s + "</option>"; }).join("") +
      '</select></div><div id="payBody"></div>';
    var bodyEl = document.getElementById("payBody");
    async function load() {
      loading(bodyEl);
      var d;
      try { d = await api("/api/admin/payments?status=" + encodeURIComponent(status) + "&page=" + page + "&pageSize=25"); }
      catch (err) { if (err.status === 401) return forceLogin(); return errorState(bodyEl, err.message); }
      if (!d.payments.length) { bodyEl.innerHTML = '<div class="state"><div class="big">No payments</div>Payments appear here once customers pay.</div>'; return; }
      var rows = d.payments.map(function (p) {
        return "<tr>" +
          '<td><div class="cell-strong">' + esc(p.clientName) + '</div><div class="cell-sub">' + esc(p.client_id) + "</div></td>" +
          '<td class="cell-sub">' + esc(p.provider_payment_id || p.id) + "</td>" +
          "<td>" + money(p.amount_paise, p.currency) + "</td>" +
          "<td>" + esc(p.plan || "—") + "</td>" +
          "<td>" + fmtDate(p.created_at) + "</td>" +
          "<td>" + payStatusBadge(p.status) + "</td>" +
          '<td class="cell-sub">' + esc(p.provider || "—") + "</td></tr>";
      }).join("");
      bodyEl.innerHTML =
        '<div class="table-wrap"><table><thead><tr><th>Client</th><th>Payment ID</th><th>Amount</th><th>Plan</th><th>Date</th><th>Status</th><th>Provider</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        pagerHtml(d);
      wirePager(bodyEl, d, function (p) { page = p; load(); });
    }
    document.getElementById("payStatus").addEventListener("change", function (e) { status = e.target.value; page = 1; load(); });
    load();
  }

  // ================= APP ACTIVITY (what customers do) =================
  function renderAppActivity(view) {
    var page = 1;
    var range = "7d";
    var eventName = "";
    view.innerHTML =
      '<div class="toolbar" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">' +
        '<select id="actRange">' +
          '<option value="today">Today</option>' +
          '<option value="1d">Last 24 hours</option>' +
          '<option value="7d" selected>Last 7 days</option>' +
          '<option value="30d">Last 30 days</option>' +
          '<option value="90d">Last 90 days</option>' +
          '<option value="all">All time</option>' +
        '</select>' +
        '<select id="actEvent"><option value="">All events</option></select>' +
        '<button class="btn" id="actRefresh">Refresh</button>' +
      '</div><div id="actBody"></div>';
    var bodyEl = document.getElementById("actBody");
    var rangeEl = document.getElementById("actRange");
    var eventEl = document.getElementById("actEvent");

    function label(name) { return String(name || "").replace(/_/g, " "); }
    function platformBadge(row) {
      if (row.platform === "android") return '<span class="badge b-ok">Android app</span>';
      if (row.platform === "ios") return '<span class="badge b-ok">iOS app</span>';
      if (row.platform === "web") return '<span class="badge b-reg">Web</span>';
      return '<span class="cell-sub">' + esc(row.source || "—") + "</span>";
    }
    function detail(row) {
      var m = row.metadata || {};
      var bits = [];
      if (m.plan) bits.push("plan " + m.plan);
      if (m.mode) bits.push(m.mode.replace(/_/g, " "));
      if (m.feature) bits.push("Google " + m.feature);
      if (typeof m.contacts === "number") bits.push(m.contacts + (m.all ? " contacts (all)" : " contacts"));
      if (m.hasName === false) bits.push("no name read");
      if (m.demo) bits.push("demo account");
      if (m.self_service) bits.push("self-service");
      return bits.join(" · ");
    }

    async function load() {
      loading(bodyEl);
      var query = "/api/admin/events?page=" + page + "&pageSize=40&range=" + encodeURIComponent(range);
      if (eventName) query += "&event=" + encodeURIComponent(eventName);
      var d;
      try { d = await api(query); }
      catch (err) { if (err.status === 401) return forceLogin(); return errorState(bodyEl, err.message); }

      if (eventEl.options.length <= 1 && d.eventNames) {
        d.eventNames.forEach(function (e) {
          var opt = document.createElement("option");
          opt.value = e.event_name;
          opt.textContent = label(e.event_name) + " (" + e.n + ")";
          eventEl.appendChild(opt);
        });
      }
      if (!d.logs.length) {
        bodyEl.innerHTML = '<div class="state"><div class="big">No activity in this period</div>Customer actions in the app and web appear here.</div>';
        return;
      }
      var rows = d.logs.map(function (l) {
        return '<tr style="cursor:default">' +
          '<td class="cell-sub">' + fmtDateTime(l.createdAt) + "</td>" +
          '<td><span class="badge b-reg">' + esc(label(l.event)) + "</span></td>" +
          "<td>" + (l.clientName ? esc(l.clientName) : '<span class="cell-sub">—</span>') + "</td>" +
          "<td>" + (l.user ? esc(l.user) : '<span class="cell-sub">—</span>') + "</td>" +
          "<td>" + platformBadge(l) + "</td>" +
          '<td class="cell-sub">' + esc(detail(l)) + "</td></tr>";
      }).join("");
      bodyEl.innerHTML =
        '<div class="card"><table class="tbl"><thead><tr>' +
        "<th>When</th><th>Event</th><th>Client</th><th>User</th><th>Source</th><th>Detail</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
        '<div class="pager" style="display:flex;gap:10px;align-items:center;margin-top:12px">' +
          '<button class="btn" id="actPrev"' + (page <= 1 ? " disabled" : "") + ">Previous</button>" +
          '<span class="cell-sub">Page ' + d.page + " of " + d.totalPages + " · " + d.total + " events</span>" +
          '<button class="btn" id="actNext"' + (page >= d.totalPages ? " disabled" : "") + ">Next</button>" +
        "</div>";
      var prev = document.getElementById("actPrev");
      var next = document.getElementById("actNext");
      if (prev) prev.onclick = function () { if (page > 1) { page -= 1; load(); } };
      if (next) next.onclick = function () { if (page < d.totalPages) { page += 1; load(); } };
    }

    rangeEl.onchange = function () { range = rangeEl.value; page = 1; load(); };
    eventEl.onchange = function () { eventName = eventEl.value; page = 1; load(); };
    document.getElementById("actRefresh").onclick = function () { load(); };
    load();
  }

  // ================= ACTIVITY / AUDIT =================
  function renderActivity(view) {
    var page = 1;
    view.innerHTML = '<div id="audBody"></div>';
    var bodyEl = document.getElementById("audBody");
    async function load() {
      loading(bodyEl);
      var d;
      try { d = await api("/api/admin/audit?page=" + page + "&pageSize=40"); }
      catch (err) { if (err.status === 401) return forceLogin(); return errorState(bodyEl, err.message); }
      if (!d.logs.length) { bodyEl.innerHTML = '<div class="state"><div class="big">No activity yet</div>Admin actions are recorded here.</div>'; return; }
      var rows = d.logs.map(function (l) {
        return "<tr style=\"cursor:default\">" +
          '<td class="cell-sub">' + fmtDateTime(l.created_at) + "</td>" +
          "<td>" + esc(l.admin_email || "—") + "</td>" +
          "<td>" + (l.clientName ? esc(l.clientName) : '<span class="cell-sub">—</span>') + "</td>" +
          '<td><span class="badge b-reg">' + esc((l.action || "").replace(/_/g, " ")) + "</span></td>" +
          '<td class="cell-sub">' + esc(l.reason || "") + "</td></tr>";
      }).join("");
      bodyEl.innerHTML =
        '<div class="table-wrap"><table><thead><tr><th>When</th><th>Admin</th><th>Client</th><th>Action</th><th>Reason</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        pagerHtml(d);
      wirePager(bodyEl, d, function (p) { page = p; load(); });
    }
    load();
  }

  // ================= SETTINGS =================
  async function renderSettings(view) {
    loading(view);
    var d;
    try { d = await api("/api/admin/settings"); }
    catch (err) { if (err.status === 401) return forceLogin(); return errorState(view, err.message); }
    var isSuper = d.me && d.me.role === "super_admin";
    var planRows = d.plans.map(function (p) {
      return "<tr style=\"cursor:default\"><td class=\"cell-strong\">" + esc(p.name) + "</td><td>" + money(p.pricePaise) + "</td><td>" + p.months + " mo</td><td>" + p.scans + " scans</td><td>" + statusBadge((p.status || "").toUpperCase()) + "</td></tr>";
    }).join("");
    var adminRows = d.admins.map(function (a) {
      var canToggle = isSuper && a.id !== d.me.id;
      var action = a.status === "active"
        ? (canToggle ? '<button class="btn-sm btn-warn" data-admin-disable="' + esc(a.id) + '">Disable</button>' : "")
        : (canToggle ? '<button class="btn-sm" data-admin-reactivate="' + esc(a.id) + '">Reactivate</button>' : "");
      return "<tr style=\"cursor:default\"><td class=\"cell-strong\">" + esc(a.name) + "</td><td>" + esc(a.email) + "</td><td>" + esc(a.role) + "</td><td>" +
        statusBadge((a.status || "").toUpperCase()) + "</td><td>" + fmtRel(a.last_login_at) + "</td><td>" + action + "</td></tr>";
    }).join("");
    view.innerHTML =
      '<div class="section-title">Plans</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Plan</th><th>Price</th><th>Duration</th><th>Included</th><th>Status</th></tr></thead><tbody>' + planRows + "</tbody></table></div>" +
      '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center">Administrators' +
      (isSuper ? '<button class="btn-sm btn-brand" id="addAdminBtn" style="text-transform:none;letter-spacing:0">Add admin</button>' : "") + "</div>" +
      '<div class="cell-sub" style="margin:-8px 0 12px">Each administrator gets a separate email and password. Only super-admins can add, disable or reactivate admin logins.</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>' + adminRows + "</tbody></table></div>";

    Array.prototype.forEach.call(view.querySelectorAll("[data-admin-disable]"), function (b) {
      b.addEventListener("click", async function () {
        if (!confirm("Disable this admin? Their sessions end immediately.")) return;
        try { await api("/api/admin/admins/" + encodeURIComponent(b.getAttribute("data-admin-disable")) + "/disable", { method: "POST" }); renderSettings(view); }
        catch (err) { alert(err.message); }
      });
    });
    Array.prototype.forEach.call(view.querySelectorAll("[data-admin-reactivate]"), function (b) {
      b.addEventListener("click", async function () {
        try { await api("/api/admin/admins/" + encodeURIComponent(b.getAttribute("data-admin-reactivate")) + "/reactivate", { method: "POST" }); renderSettings(view); }
        catch (err) { alert(err.message); }
      });
    });
    var addBtn = document.getElementById("addAdminBtn");
    if (addBtn) addBtn.addEventListener("click", function () { openAddAdminModal(function () { renderSettings(view); }); });
  }

  function openAddAdminModal(refresh) {
    var scrim = document.createElement("div");
    scrim.className = "modal-scrim";
    scrim.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true"><h3>Add Administrator</h3>' +
      '<p class="modal-sub">They will have full super-admin access.</p>' +
      '<div class="modal-error" hidden></div>' +
      '<div class="modal-body">' +
      '<div><label>Name</label><input data-f="name"></div>' +
      '<div><label>Email</label><input data-f="email" type="email"></div>' +
      '<div><label>Role</label><select data-f="role"><option value="admin">Administrator</option><option value="super_admin">Super admin</option></select></div>' +
      '<div><label>Temporary password</label><input data-f="password" type="password"></div>' +
      '<div class="cell-sub">At least 10 characters with uppercase, lowercase, a number and a symbol. Share it securely.</div>' +
      '</div><div class="modal-foot"><button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" style="width:auto" data-submit>Create admin</button></div></div>';
    document.body.appendChild(scrim);
    function close() { scrim.remove(); }
    scrim.addEventListener("click", function (e) { if (e.target === scrim) close(); });
    scrim.querySelector("[data-cancel]").addEventListener("click", close);
    var errBox = scrim.querySelector(".modal-error");
    var btn = scrim.querySelector("[data-submit]");
    btn.addEventListener("click", async function () {
      var payload = {};
      Array.prototype.forEach.call(scrim.querySelectorAll("[data-f]"), function (i) { payload[i.getAttribute("data-f")] = i.value.trim(); });
      btn.disabled = true; btn.textContent = "Creating…";
      try { await api("/api/admin/admins", { method: "POST", body: payload }); close(); if (refresh) refresh(); }
      catch (err) { errBox.hidden = false; errBox.textContent = err.message; btn.disabled = false; btn.textContent = "Create admin"; }
    });
  }

  // Shared pager
  function pagerHtml(d) {
    return '<div class="pager"><span>' + d.total + " total · page " + d.page + " of " + d.totalPages + "</span>" +
      '<span class="btns"><button data-pg="prev"' + (d.page <= 1 ? " disabled" : "") + ">Previous</button>" +
      '<button data-pg="next"' + (d.page >= d.totalPages ? " disabled" : "") + ">Next</button></span></div>";
  }
  function wirePager(root, d, go) {
    var prev = root.querySelector('[data-pg="prev"]'), next = root.querySelector('[data-pg="next"]');
    if (prev) prev.addEventListener("click", function () { if (d.page > 1) go(d.page - 1); });
    if (next) next.addEventListener("click", function () { if (d.page < d.totalPages) go(d.page + 1); });
  }

  // ================= ROUTER / BOOT =================
  function forceLogin() { state.admin = null; renderLogin("Your session has expired. Please sign in again."); }

  function handleHash() {
    var path = (location.hash || "#/dashboard").replace(/^#\//, "").split("?")[0];
    state.route = NAV.some(function (n) { return n.key === path; }) ? path : "dashboard";
    if (state.admin) renderShell();
  }
  window.addEventListener("hashchange", handleHash);

  async function boot() {
    app.innerHTML = '<div class="state" style="padding-top:120px"><div class="spinner"></div>Loading…</div>';
    try {
      var setup = await api("/api/admin/setup/status");
      if (setup.setupRequired) return renderFirstAdminSetup(setup);
    } catch (setupErr) {
      if (setupErr.status !== 404) return renderLogin(setupErr.message || "Could not check admin setup status.");
    }
    try {
      var me = await api("/api/admin/auth/me");
      state.admin = me.admin;
      handleHash();
      renderShell();
    } catch (err) {
      renderLogin();
    }
  }
  boot();
})();
