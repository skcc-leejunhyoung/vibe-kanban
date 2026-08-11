// Auth bridge for cookie-blocked preview iframes.
//
// Safari treats `<port>.vibe-kanban.localhost` as a different *site* than the
// parent `vibe-kanban.localhost`, so it silently drops all cookies inside the
// preview iframe (unconditional third-party cookie blocking — no setting can
// re-enable it). Cookie-session dev apps then loop forever on 401 after a
// successful login.
//
// This shim converts OAuth-style cookie sessions to header auth, client-side,
// without touching the previewed app's source:
//   1. watch same-origin login/refresh/token responses for a JSON body with
//      `access_token` (OAuth password-grant convention),
//   2. replay it as `Authorization: Bearer` on subsequent same-origin requests,
//   3. drop it on logout or when the server rejects it with 401.
//
// Storage is sessionStorage (partitioned but usable in third-party iframes) so
// the session survives in-iframe navigation. Token refresh via httpOnly cookie
// still fails (cookie never stored) — when the access token expires the app
// falls back to its normal logged-out flow and the user logs in again.
(function () {
  'use strict';
  // Only needed when embedded; top-level previews get first-party cookies.
  if (window.top === window.self) return;

  var KEY = 'vk_auth_bridge_token';
  var mem = null;
  function getTok() {
    if (mem) return mem;
    try {
      return sessionStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }
  function setTok(t) {
    mem = t;
    try {
      if (t === null) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, t);
    } catch (e) {}
  }
  function pathOf(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin ? u.pathname : null;
    } catch (e) {
      return null;
    }
  }
  var AUTHISH = /\/(login|refresh|token)\b/i;
  function sniff(text) {
    try {
      var j = JSON.parse(text);
      if (j && typeof j.access_token === 'string' && j.access_token)
        setTok(j.access_token);
    } catch (e) {}
  }

  var origFetch = window.fetch;
  if (origFetch)
    window.fetch = function (input, init) {
      var url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input && input.url) || '';
      var path = pathOf(url);
      var tok = getTok();
      var added = false;
      if (tok && path) {
        var h = new Headers(
          (init && init.headers) ||
            (typeof input === 'object' && input && input.headers) ||
            undefined
        );
        if (!h.has('authorization')) {
          h.set('authorization', 'Bearer ' + tok);
          init = Object.assign({}, init, { headers: h });
          added = true;
        }
      }
      var p = origFetch.call(this, input, init);
      return p.then(function (res) {
        try {
          if (path && /\/logout\b/i.test(path)) setTok(null);
          else if (path && AUTHISH.test(path))
            res
              .clone()
              .text()
              .then(sniff)
              .catch(function () {});
          if (added && res.status === 401) setTok(null);
        } catch (e) {}
        return res;
      });
    };

  // Axios and friends go through XHR, not fetch.
  var xhrOpen = XMLHttpRequest.prototype.open;
  var xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__vkAuthPath = pathOf(url);
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var path = this.__vkAuthPath;
    var tok = getTok();
    var added = false;
    var xhr = this;
    if (tok && path) {
      // No way to read already-set XHR headers; cookie-session apps don't set
      // Authorization themselves, so appending here is safe for the target case.
      try {
        this.setRequestHeader('Authorization', 'Bearer ' + tok);
        added = true;
      } catch (e) {}
    }
    this.addEventListener('load', function () {
      try {
        if (path && /\/logout\b/i.test(path)) setTok(null);
        else if (path && AUTHISH.test(path)) sniff(xhr.responseText);
        if (added && xhr.status === 401) setTok(null);
      } catch (e) {}
    });
    return xhrSend.apply(this, arguments);
  };
})();
