/* ============================================================
   Ingrid SOW — Manager dashboard logic (live, Supabase-backed)
   ============================================================ */
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* Auth guard — show password dialog if not authenticated */
  var _authed = SowAPI.restoreSession();
  if (!_authed) {
    document.addEventListener('DOMContentLoaded', function () {
      var pwScrim = document.getElementById('pwScrim');
      var pwInput = document.getElementById('pwInput');
      var pwSubmit = document.getElementById('pwSubmit');
      var pwError = document.getElementById('pwError');
      if (pwScrim) pwScrim.classList.add('show');
      if (pwInput) setTimeout(function () { pwInput.focus(); }, 60);
      function tryPassword() {
        if (SowAPI.checkPassword(pwInput.value)) {
          pwScrim.classList.remove('show');
          loadSows();
        } else {
          pwError.style.display = 'block';
          pwInput.value = '';
          pwInput.focus();
        }
      }
      if (pwSubmit) pwSubmit.addEventListener('click', tryPassword);
      if (pwInput) pwInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryPassword(); });
    });
  }

  var SOWS = [];
  var STATUS_LABEL = { draft: 'Draft', customer: 'With customer', review: 'In review', complete: 'Complete' };
  var activeFilter = 'all';
  var query = '';

  var ICON = {
    lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.4"/><path d="M5 7V4.6a3 3 0 016 0V7"/></svg>',
    lockOpen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.4"/><path d="M5 7V4.6a3 3 0 015.6-1.5"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>',
    check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 5"/></svg>'
  };

  function initials(name) {
    return name.split(/[\s.@]+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  /* Set avatar */
  var user = SowAPI.getUser();
  var userName = (user && user.user_metadata && user.user_metadata.name) || (user && user.email) || 'Ingrid';
  var avatarEl = $('.ab-avatar');
  if (avatarEl) { avatarEl.textContent = initials(userName); avatarEl.title = userName + ' · Ingrid'; }

  /* ---- render ---- */
  function matches(s) {
    if (activeFilter !== 'all' && s.status !== activeFilter) return false;
    if (query) {
      var hay = (s.customer + ' ' + s.id + ' ' + (s.products || []).join(' ')).toLowerCase();
      if (hay.indexOf(query) === -1) return false;
    }
    return true;
  }

  function rowHTML(s) {
    var prods = (s.products || []).map(function (p) { return '<span class="ptag">' + p + '</span>'; }).join('');
    var you = s.progress_you || 0;
    var ing = s.progress_ingrid || 0;
    var editing = s._editing || null;

    var act;
    if (s.locked) {
      var lockedBy = s.updated_by ? s.updated_by.replace('ingrid:', '') : '';
      act = '<div class="idle"><b>Locked</b>' + (lockedBy ? '<br>by ' + lockedBy : '') + '</div>';
    } else if (editing) {
      var side = editing.side;
      act = '<div class="editing">' +
        '<div class="av av--' + side + '">' + initials(editing.name) + '<span class="live"></span></div>' +
        '<div class="etxt"><div class="ewho">' + editing.name + (side === 'ingrid' ? ' · Ingrid' : ' · Customer') + '</div>' +
        '<div class="enow">Editing now</div></div></div>';
    } else {
      var ago = s.updated_at ? relativeTime(s.updated_at) : '';
      var by = s.updated_by ? ' · by ' + s.updated_by.replace('ingrid:', '') : '';
      act = '<div class="idle">' + (ago ? 'Edited ' + ago + by : 'No edits yet') + '</div>';
    }

    var lockBtn = s.locked
      ? '<button class="iconbtn is-locked" data-lock="' + s.id + '" title="Locked — click to unlock (Ingrid only)">' + ICON.lock + '</button>'
      : '<button class="iconbtn" data-lock="' + s.id + '" title="Lock this SOW (Ingrid only)">' + ICON.lockOpen + '</button>';

    return '<a class="row' + (s.locked ? ' is-locked' : '') + '" href="sow.html?id=' + s.id + '" data-id="' + s.id + '">' +
      '<div class="c-cust">' +
        '<div class="c-name">' + s.customer + (s.locked ? '<span class="lock">' + ICON.lock + '</span>' : '') + '</div>' +
        '<div class="c-meta"><span class="c-ref">' + s.id + '</span><span class="c-dot"></span><span>' + (s.region || '—') + '</span>' +
          '<span class="c-dot"></span><span class="c-prods">' + prods + '</span></div>' +
      '</div>' +
      '<div><span class="status status--' + s.status + '"><span class="sdot"></span>' + STATUS_LABEL[s.status] + '</span></div>' +
      '<div class="c-prog">' +
        progRow('you', 'C', you) +
        progRow('ingrid', 'I', ing) +
      '</div>' +
      '<div class="c-act">' + act + '</div>' +
      '<div class="c-actions">' + lockBtn +
        '<span class="iconbtn open-arrow" title="Open">' + ICON.arrow + '</span>' +
      '</div>' +
    '</a>';
  }

  function progRow(side, label, pct) {
    return '<div class="pgrow">' +
      '<span class="pglabel pglabel--' + side + '">' + label + '</span>' +
      '<div class="pgtrack"><div class="pgfill pgfill--' + side + '" style="width:' + pct + '%"></div></div>' +
      '<span class="pgpct">' + pct + '%</span></div>';
  }

  function relativeTime(isoStr) {
    var diff = Date.now() - new Date(isoStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days === 1) return 'yesterday';
    return days + 'd ago';
  }

  function render() {
    var list = $('#list');
    var shown = SOWS.filter(matches);
    if (!shown.length) {
      list.innerHTML = '<div class="empty"><h3>No statements of work here</h3><p>Try a different filter, or create a new SOW.</p></div>';
    } else {
      list.innerHTML = '<div class="list-head">' +
        '<div>Customer</div><div>Status</div><div>Completion</div><div>Activity</div><div class="col-r">&nbsp;</div>' +
      '</div>' + shown.map(rowHTML).join('');
    }
    $$('.chip').forEach(function (c) {
      var f = c.getAttribute('data-filter');
      var n = f === 'all' ? SOWS.length : SOWS.filter(function (s) { return s.status === f; }).length;
      var nEl = $('.n', c); if (nEl) nEl.textContent = n;
    });
  }

  /* ---- load data ---- */
  function loadSows() {
    SowAPI.listSows().then(function (rows) {
      SOWS = rows || [];
      render();
    }).catch(function (err) {
      if (err && (err.code === 'PGRST301' || err.message === 'JWT expired')) {
        SowAPI.logout(); window.location.href = 'login.html'; return;
      }
      $('#list').innerHTML = '<div class="empty"><p>Could not load SOWs. Check your connection.</p></div>';
    });
  }

  /* ---- toast ---- */
  var toastTimer;
  function toast(msg, ok) {
    var t = $('#toast');
    t.innerHTML = (ok ? ICON.check : '') + '<span>' + msg + '</span>';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  /* ---- lock dialog ---- */
  var pendingLockId = null;
  function openLock(s) {
    if (s.locked) {
      SowAPI.unlockSow(s.id).then(function () {
        s.locked = false; render();
        toast('"' + s.customer + '" unlocked — editing re-enabled', true);
      }).catch(function () { toast('Could not unlock — try again'); });
      return;
    }
    pendingLockId = s.id;
    $('#lockCust').textContent = s.customer;
    $('#lockScrim').classList.add('show');
  }
  function confirmLock() {
    if (!pendingLockId) return;
    var id = pendingLockId;
    SowAPI.lockSow(id).then(function () {
      var s = SOWS.filter(function (x) { return x.id === id; })[0];
      if (s) { s.locked = true; s.status = 'complete'; }
      render();
      toast('"' + (s ? s.customer : id) + '" locked — read-only for all parties', true);
    }).catch(function () { toast('Could not lock — try again'); });
    $('#lockScrim').classList.remove('show');
    pendingLockId = null;
  }

  /* ---- new SOW dialog ---- */
  var newProds = [];
  function openNew() {
    newProds = [];
    $('#newCust').value = '';
    $('#newRegion').value = '';
    $$('.pp').forEach(function (p) { p.classList.remove('on'); });
    validateNew();
    $('#newScrim').classList.add('show');
    setTimeout(function () { $('#newCust').focus(); }, 60);
  }
  function validateNew() {
    $('#newCreate').disabled = $('#newCust').value.trim() === '';
  }
  function createSOW() {
    var name = $('#newCust').value.trim();
    if (!name) return;
    var id = SowAPI.genId();
    var region = $('#newRegion').value.trim() || '';
    SowAPI.createSow({ id: id, customer: name, region: region, products: newProds.slice() })
      .then(function (row) {
        $('#newScrim').classList.remove('show');
        toast('"' + name + '" created — opening…', true);
        setTimeout(function () { window.location.href = 'sow.html?id=' + encodeURIComponent(id); }, 600);
      })
      .catch(function (err) {
        toast('Could not create SOW — try again');
      });
  }

  /* ---- wire ---- */
  function wire() {
    $$('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        $$('.chip').forEach(function (x) { x.classList.remove('is-active'); });
        c.classList.add('is-active');
        activeFilter = c.getAttribute('data-filter');
        render();
      });
    });
    $('#search').addEventListener('input', function (e) { query = e.target.value.trim().toLowerCase(); render(); });

    $('#list').addEventListener('click', function (e) {
      var lockEl = e.target.closest('[data-lock]');
      if (lockEl) {
        e.preventDefault(); e.stopPropagation();
        var s = SOWS.filter(function (x) { return x.id === lockEl.getAttribute('data-lock'); })[0];
        if (s) openLock(s);
        return;
      }
      var row = e.target.closest('.row');
      if (row && row.classList.contains('is-locked')) {
        toast('This SOW is locked — opening read-only');
      }
    });

    $('#btnNew').addEventListener('click', openNew);
    $('#newCancel').addEventListener('click', function () { $('#newScrim').classList.remove('show'); });
    $('#newCreate').addEventListener('click', createSOW);
    $('#newCust').addEventListener('input', validateNew);
    $$('.pp').forEach(function (p) {
      p.addEventListener('click', function () {
        p.classList.toggle('on');
        var name = p.getAttribute('data-prod');
        var i = newProds.indexOf(name);
        if (i === -1) newProds.push(name); else newProds.splice(i, 1);
      });
    });

    $('#lockCancel').addEventListener('click', function () { $('#lockScrim').classList.remove('show'); pendingLockId = null; });
    $('#lockConfirm').addEventListener('click', confirmLock);

    $$('.scrim').forEach(function (sc) {
      sc.addEventListener('click', function (e) { if (e.target === sc) sc.classList.remove('show'); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') $$('.scrim').forEach(function (sc) { sc.classList.remove('show'); });
    });

    // Logout — clears session and reloads to show password dialog
    var logoutBtn = $('#btnLogout');
    if (logoutBtn) logoutBtn.addEventListener('click', function () {
      SowAPI.logout(); window.location.reload();
    });
  }

  wire();
  if (_authed) loadSows();
})();
