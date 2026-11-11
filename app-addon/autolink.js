// Signs this browser in to the self-hosted Sync server without a code.
//   1. "#link=lnk_..." in the address (an admin magic link), or
//   2. GET /v1/auth/access: the worker reads the Cloudflare Access identity and returns a one-time token.
// Then it drives the app's own local API (the same calls Settings → Sync makes): setup, signin, verify,
// unlock (the server keeps the key, so no password), mark first-run setup done, sync.
// Loaded as a same-origin script, so the app's CSP (script-src 'self') allows it.
(function () {
  "use strict";
  var KEY = "etude.autolink";
  var server = location.origin;

  // Take a magic-link token out of the address right away, before anything else can read or log it.
  var linkToken = null;
  var m = /(?:^|[#&])link=(lnk_[a-f0-9]+)/.exec(location.hash);
  if (m) {
    linkToken = m[1];
    var rest = location.hash.replace(/(?:^|[#&])link=lnk_[a-f0-9]+/, "").replace(/^#&?/, "");
    history.replaceState(history.state, "", location.pathname + location.search + (rest ? "#" + rest : ""));
  }

  function waitForCore(ms) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        if (typeof window.__etudeTransport === "function") return resolve(window.__etudeTransport);
        if (Date.now() - t0 > ms) return reject(new Error("core not ready"));
        setTimeout(poll, 100);
      })();
    });
  }

  function api(transport, method, path, body) {
    return transport(new URL(path, location.origin).href, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = t ? JSON.parse(t) : null;
        if (!r.ok) throw new Error((d && (d.error && (d.error.message || d.error))) || r.statusText);
        return d;
      });
    });
  }

  function getToken() {
    if (linkToken) return Promise.resolve({ token: linkToken, email: null });
    return fetch("/v1/auth/access", { credentials: "include", cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).catch(function () { return null; });
  }

  function banner(text, ok) {
    try {
      var el = document.getElementById("etude-autolink");
      if (!el) {
        el = document.createElement("div");
        el.id = "etude-autolink";
        el.setAttribute("role", "status");
        el.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:999px;font:13px system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.15);transition:opacity .4s";
        document.body.appendChild(el);
      }
      el.style.background = ok === false ? "#fde8e8" : "#eef6ee";
      el.style.color = ok === false ? "#8a1c1c" : "#1d4d1d";
      el.textContent = text;
      el.style.opacity = "1";
      if (ok !== undefined) setTimeout(function () { el.style.opacity = "0"; setTimeout(function () { el.remove(); }, 500); }, 3500);
    } catch (e) {}
  }

  waitForCore(30000).then(function (transport) {
    return api(transport, "GET", "/api/sync/status").then(function (st) {
      var done = st && st.kind === "cloud" && st.signedIn && st.unlocked;
      if (done && !linkToken) return null; // already linked on this device
      return getToken().then(function (t) {
        if (!t || !t.token) return null; // not behind Access and no magic link: leave the normal flow alone
        // If this device is linked to someone else, don't mix collections: stop and say so.
        if (done && t.email && st.email && st.email.toLowerCase() !== t.email.toLowerCase()) {
          banner("This browser is signed in to Sync as " + st.email + ". Sign out in Settings first.", false);
          return null;
        }
        banner("Signing in to Sync…");
        var email = t.email || (st && st.email) || "";
        var chain = Promise.resolve();
        if (!st || st.kind !== "cloud") chain = chain.then(function () { return api(transport, "POST", "/api/sync/setup", { server: server }); });
        return chain
          .then(function () { return email ? api(transport, "POST", "/api/sync/signin", { email: email }) : null; })
          .then(function () { return api(transport, "POST", "/api/sync/verify", { code: t.token }); })
          .then(function () { return api(transport, "POST", "/api/sync/unlock", {}); })
          .then(function () { return api(transport, "PATCH", "/api/settings", { onboarding: { done: true } }).catch(function () {}); })
          .then(function () { return api(transport, "POST", "/api/sync/now", {}); })
          .then(function () {
            try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
            banner("Synced", true);
            setTimeout(function () { location.reload(); }, 1200);
          });
      });
    });
  }).catch(function (e) {
    banner("Automatic Sync sign-in failed: " + (e && e.message ? e.message : e), false);
  });
})();
