/* Ingrid SOW — Supabase API layer (password-auth, no Supabase Auth) */
(function (global) {
  'use strict';

  var SUPABASE_URL = global.SUPABASE_URL || '';
  var KEY = global.SUPABASE_ANON_KEY || '';
  var ADMIN_PW = global.INGRID_ADMIN_PASSWORD || '';
  var LS_KEY = 'sow:ingrid';

  /* ---- admin password check ---- */
  function checkPassword(pw) {
    if (pw !== ADMIN_PW) return false;
    try { localStorage.setItem(LS_KEY, '1'); } catch (e) {}
    return true;
  }

  function restoreSession() {
    try { return localStorage.getItem(LS_KEY) === '1'; } catch (e) { return false; }
  }

  function logout() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  function isIngrid() {
    return restoreSession();
  }

  /* ---- low-level fetch ---- */
  function headers(extra) {
    var h = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    return Object.assign(h, extra || {});
  }

  function rest(path, opts) {
    return fetch(SUPABASE_URL + '/rest/v1' + path, Object.assign({ headers: headers() }, opts))
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw e; });
        var ct = r.headers.get('content-type') || '';
        return ct.indexOf('json') !== -1 ? r.json() : null;
      });
  }

  function rpc(fn, body) {
    return fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw e; });
      var ct = r.headers.get('content-type') || '';
      return ct.indexOf('json') !== -1 ? r.json() : null;
    });
  }

  /* ---- SOW CRUD (Ingrid) ---- */
  function listSows() {
    return rest('/sows?order=updated_at.desc&select=id,customer,region,products,status,locked,progress_you,progress_ingrid,updated_at,updated_by,customer_token');
  }

  function getSow(id) {
    return rest('/sows?id=eq.' + encodeURIComponent(id) + '&select=*&limit=1')
      .then(function (rows) { return rows && rows[0]; });
  }

  function createSow(fields) {
    var body = Object.assign({ status: 'draft', locked: false, data: { fields: {}, lists: {} } }, fields);
    return rest('/sows', {
      method: 'POST',
      headers: headers({ 'Prefer': 'return=representation' }),
      body: JSON.stringify(body)
    }).then(function (rows) { return rows && rows[0]; });
  }

  function patchSow(id, body) {
    return rest('/sows?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: headers({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify(body)
    });
  }

  function lockSow(id) {
    return rest('/sows?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: headers({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ locked: true, status: 'complete' })
    });
  }

  function unlockSow(id) {
    return rest('/sows?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: headers({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ locked: false })
    });
  }

  /* ---- customer (token-based, no auth) ---- */
  function getCustomerSow(id, token) {
    return rpc('get_sow_for_customer', { p_id: id, p_token: token })
      .then(function (rows) { return rows && rows[0]; });
  }

  function patchCustomerSow(id, token, data, progressYou) {
    return rpc('customer_patch_sow', { p_id: id, p_token: token, p_data: data, p_progress_you: progressYou });
  }

  /* ---- Realtime presence ---- */
  var ws = null;
  var heartbeatInterval = null;

  function joinPresence(sowId, info, onUpdate) {
    if (ws) { ws.close(); ws = null; }
    var wsUrl = SUPABASE_URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/realtime/v1/websocket?apikey=' + KEY + '&vsn=1.0.0';
    ws = new WebSocket(wsUrl);
    var ref = 0;
    var joined = false;
    var presenceState = {};

    function send(msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

    ws.onopen = function () {
      send({ topic: 'realtime:presence:sow:' + sowId, event: 'phx_join', payload: { config: { presence: { key: info.who + ':' + Date.now() } } }, ref: ++ref });
    };

    ws.onmessage = function (e) {
      var msg = JSON.parse(e.data);
      if (msg.event === 'phx_reply' && !joined) {
        joined = true;
        send({ topic: 'realtime:presence:sow:' + sowId, event: 'presence', payload: { type: 'track', key: info.who + ':' + Date.now(), payload: info }, ref: ++ref });
      }
      if (msg.event === 'presence_state' || msg.event === 'presence_diff') {
        if (msg.event === 'presence_state') presenceState = msg.payload || {};
        if (msg.event === 'presence_diff') {
          var joins = (msg.payload && msg.payload.joins) || {};
          var leaves = (msg.payload && msg.payload.leaves) || {};
          Object.keys(joins).forEach(function (k) { presenceState[k] = joins[k]; });
          Object.keys(leaves).forEach(function (k) { delete presenceState[k]; });
        }
        var users = [];
        Object.keys(presenceState).forEach(function (k) {
          var metas = presenceState[k] && presenceState[k].metas;
          if (metas) metas.forEach(function (m) { users.push(m); });
        });
        if (onUpdate) onUpdate(users);
      }
    };

    heartbeatInterval = setInterval(function () {
      send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: ++ref });
    }, 25000);
  }

  function leavePresence() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (ws) { ws.close(); ws = null; }
  }

  /* ---- generate SOW id ---- */
  function genId() {
    return 'SOW-' + (2042 + Math.floor(Math.random() * 9000));
  }

  /* ---- export ---- */
  global.SowAPI = {
    checkPassword: checkPassword,
    restoreSession: restoreSession,
    logout: logout,
    isIngrid: isIngrid,
    listSows: listSows,
    getSow: getSow,
    createSow: createSow,
    patchSow: patchSow,
    lockSow: lockSow,
    unlockSow: unlockSow,
    getCustomerSow: getCustomerSow,
    patchCustomerSow: patchCustomerSow,
    joinPresence: joinPresence,
    leavePresence: leavePresence,
    genId: genId
  };
})(window);
