// Mobile-initiated WhatsApp Embedded Signup page logic. Loaded as an external
// script (the app's CSP blocks inline scripts). Config comes from data-* on
// #wa-cfg; the one-time ?state= authorises /api/whatsapp/connect-complete.
(function () {
  var cfg = document.getElementById("wa-cfg").dataset;
  var statusEl = document.getElementById("wa-status");
  var startBtn = document.getElementById("wa-start");
  var returnBtn = document.getElementById("wa-return");
  var params = new URLSearchParams(location.search);
  var state = params.get("state") || "";
  var returnUrl = params.get("return") || "easysave://whatsapp-connected";
  var sessionInfo = null;

  function setStatus(message, bad) {
    statusEl.textContent = message;
    statusEl.className = bad ? "bad" : "";
  }

  function goBackToApp() { window.location.href = returnUrl; }
  returnBtn.addEventListener("click", goBackToApp);

  window.addEventListener("message", function (event) {
    var host = "";
    try { host = new URL(event.origin).hostname; } catch (err) { return; }
    if (!/(^|\.)facebook\.com$/.test(host)) return;
    try {
      var data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      if (data && data.type === "WA_EMBEDDED_SIGNUP") sessionInfo = data.data || null;
    } catch (err) { /* ignore non-JSON messages */ }
  });

  function loadSdk() {
    return new Promise(function (resolve, reject) {
      if (window.FB) return resolve(window.FB);
      window.fbAsyncInit = function () {
        window.FB.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: cfg.graph || "v21.0" });
        resolve(window.FB);
      };
      var script = document.createElement("script");
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true; script.defer = true; script.crossOrigin = "anonymous";
      script.onerror = function () { reject(new Error("Could not load the Facebook SDK. Check your connection.")); };
      document.head.appendChild(script);
    });
  }

  function complete(code) {
    setStatus("Finishing connection…");
    fetch(cfg.completeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: state,
        code: code,
        wabaId: (sessionInfo && (sessionInfo.waba_id || sessionInfo.wabaId)) || "",
        phoneNumberId: (sessionInfo && (sessionInfo.phone_number_id || sessionInfo.phoneNumberId)) || ""
      })
    }).then(function (response) {
      return response.json().then(function (json) { return { ok: response.ok, json: json }; });
    }).then(function (result) {
      if (!result.ok) { setStatus(result.json.error || "Connection failed. Please try again.", true); startBtn.style.display = ""; return; }
      setStatus("Connected! Returning to the app…");
      returnBtn.style.display = "";
      setTimeout(goBackToApp, 700);
    }).catch(function () {
      setStatus("Connection failed. Please try again.", true);
      startBtn.style.display = "";
    });
  }

  function start() {
    if (!state) { setStatus("This link has expired. Start again from the app.", true); return; }
    startBtn.style.display = "none";
    setStatus("Opening WhatsApp signup…");
    loadSdk().then(function (FB) {
      FB.login(function (response) {
        var code = response && response.authResponse && response.authResponse.code;
        if (!code) { setStatus("Signup was cancelled.", true); startBtn.style.display = ""; return; }
        complete(code);
      }, {
        config_id: cfg.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }
      });
    }).catch(function (err) { setStatus(err.message, true); startBtn.style.display = ""; });
  }

  startBtn.addEventListener("click", start);
})();
