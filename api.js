/* Ingrid SOW — Supabase API layer */
(function (global) {
  'use strict';

  // Config injected by deployer in each HTML file as:
  // window.SUPABASE_URL = 'https://xxx.supabase.co';
  // window.SUPABASE_ANON_KEY = 'eyJ...';
  // Falls back to placeholders so the page renders for setup.

  var URL = global.SUPABASE_URL || '';
  var KEY = global.SUPABASE_ANON_KEY || '';

  var authToken = null; // set after login
  var currentUser = null;

  /* ---- low-level fetch wrappers ---- */
  function headers(extra) {
    var h = { 'apikey': KEY, 'Content-Type': 'application/json' };
    if (authToken) h['Authorization'] = 'Bearer ' + authToken;
    return Object.assign(h, extra || {});
  }

  function rest(path, opts) {
    return fetch(URL + '/rest/v1' + path, Object.assign({ headers: headers() }, opts))
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw e; });
        var ct = r.headers.get('content-type') || '';
        return ct.indexOf('json') !== -1 ? r.json() : null;
      });
  }

  function rpc(fn, body) {
    return fetch(URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw e; });
      var ct = r.headers.get('content-type') || '';
      return ct.indexOf('json') !== -1 ? r.json() : null;
    });
  }

  /* ---- auth ---- */
  function login(email, password) {
    return fetch(URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'apikey': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw d;
        authToken = d.access_token;
        currentUser = d.user;
        try { localStorage.setItem('sow:session', JSON.stringify({ token: authToken, user: currentUser })); } catch (e) {}
        return d;
      });
    });
  }

  function restoreSession() {
    try {
      var s = localStorage.getItem('sow:session');
      if (!s) return false;
      var d = JSON.parse(s);
      authToken = d.token;
      currentUser = d.user;
      return true;
    } catch (e) { return false; }
  }

  function logout() {
    authToken = null; currentUser = null;
    try { localStorage.removeItem('sow:session'); } catch (e) {}
  }

  function getUser() { return currentUser; }
  function isIngrid() { return !!authToken; }

  /* ---- SOW CRUD (Ingrid authenticated) ---- */
  function listSows() {
    return rest('/sows?order=updated_at.desc&select=id,customer,region,products,status,locked,progress_you,progress_ingrid,updated_at,updated_by,customer_token');
  }

  function getSow(id) {
    return rest('/sows?id=eq.' + encodeURIComponent(id) + '&select=*&limit=1')
      .then(function (rows) { return rows && rows[0]; });
  }

  function createSow(fields) {
    // fields: { id, customer, region, products }
    var body = Object.assign({ created_by: currentUser && currentUser.id, status: 'draft', locked: false, data: { fields: {}, lists: {} } }, fields);
    return rest('/sows', { method: 'POST', headers: headers({ 'Prefer': 'return=representation' }), body: JSON.stringify(body) })
      .then(function (rows) { return rows && rows[0]; });
  }

  function patchSow(id, body) {
    // body: { data, updated_by, progress_you, progress_ingrid }
    return rest('/sows?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: headers({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify(body)
    });
  }

  function lockSow(id) { return rpc('lock_sow', { p_id: id }); }
  function unlockSow(id) { return rpc('unlock_sow', { p_id: id }); }

  /* ---- customer (unauthenticated) ---- */
  function getCustomerSow(id, token) {
    return rpc('get_sow_for_customer', { p_id: id, p_token: token })
      .then(function (rows) { return rows && rows[0]; });
  }

  function patchCustomerSow(id, token, data, progressYou) {
    return rpc('customer_patch_sow', { p_id: id, p_token: token, p_data: data, p_progress_you: progressYou });
  }

  /* ---- Realtime presence ---- */
  var ws = null;
  var presenceCallbacks = {};
  var heartbeatInterval = null;

  function joinPresence(sowId, info, onUpdate) {
    // Use Supabase Realtime v2 presence
    if (ws) { ws.close(); ws = null; }
    var wsUrl = URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/realtime/v1/websocket?apikey=' + KEY + '&vsn=1.0.0';
    ws = new WebSocket(wsUrl);
    var ref = 0;
    var joined = false;
    var presenceState = {};

    function send(msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

    ws.onopen = function () {
      // join presence channel
      send({ topic: 'realtime:presence:sow:' + sowId, event: 'phx_join', payload: { config: { presence: { key: info.who + ':' + Date.now() } } }, ref: ++ref });
    };

    ws.onmessage = function (e) {
      var msg = JSON.parse(e.data);
      if (msg.event === 'phx_reply' && !joined) {
        joined = true;
        // track self
        send({ topic: 'realtime:presence:sow:' + sowId, event: 'presence', payload: { type: 'track', key: info.who + ':' + Date.now(), payload: info }, ref: ++ref });
      }
      if (msg.event === 'presence_state' || msg.event === 'presence_diff') {
        // rebuild presenceState from diff
        if (msg.event === 'presence_state') presenceState = msg.payload || {};
        if (msg.event === 'presence_diff') {
          var joins = (msg.payload && msg.payload.joins) || {};
          var leaves = (msg.payload && msg.payload.leaves) || {};
          Object.keys(joins).forEach(function (k) { presenceState[k] = joins[k]; });
          Object.keys(leaves).forEach(function (k) { delete presenceState[k]; });
        }
        // flatten to array of metas
        var users = [];
        Object.keys(presenceState).forEach(function (k) {
          var metas = presenceState[k] && presenceState[k].metas;
          if (metas) metas.forEach(function (m) { users.push(m); });
        });
        if (onUpdate) onUpdate(users);
      }
    };

    // heartbeat every 25s
    heartbeatInterval = setInterval(function () {
      send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: ++ref });
    }, 25000);
  }

  function leavePresence() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (ws) { ws.close(); ws = null; }
  }

  /* ---- DB changes (for dashboard live updates) ---- */
  function subscribeTable(table, onMessage) {
    var wsUrl = URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/realtime/v1/websocket?apikey=' + KEY + '&vsn=1.0.0';
    var dbWs = new WebSocket(wsUrl);
    var ref = 0;
    dbWs.onopen = function () {
      dbWs.send(JSON.stringify({ topic: 'realtime:' + table, event: 'phx_join', payload: { config: { broadcast: {}, presence: {} } }, ref: ++ref }));
    };
    dbWs.onmessage = function (e) {
      var msg = JSON.parse(e.data);
      if (msg.event === 'postgres_changes' || msg.event === 'INSERT' || msg.event === 'UPDATE' || msg.event === 'DELETE') {
        if (onMessage) onMessage(msg);
      }
    };
    return dbWs;
  }

  /* ---- generate SOW id ---- */
  function genId() {
    // SOW-NNNN where NNNN is somewhat unique
    return 'SOW-' + (2042 + Math.floor(Math.random() * 9000));
  }

  /* ---- export ---- */
  global.SowAPI = {
    login: login,
    restoreSession: restoreSession,
    logout: logout,
    getUser: getUser,
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
    subscribeTable: subscribeTable,
    genId: genId
  };
})(window);
