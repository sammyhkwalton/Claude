/* ============================================================
   Ingrid SOW — app logic (hosted, multi-party)
   ============================================================ */
(function () {
  'use strict';

  /* ---- repeatable list schemas ---- */
  var LISTS = {
    sales: { min: 1, cols: [
      { k: 'website', type: 'text', ph: 'www.example.com' },
      { k: 'type', type: 'select', opts: ['B2C', 'B2B', 'B2B2C'] },
      { k: 'region', type: 'text', ph: 'e.g. UK' },
      { k: 'vol', type: 'text', ph: 'e.g. 100,000' } ] },
    integrations: { min: 2, cols: [
      { k: 'platform', type: 'text', ph: 'e.g. Shopify Plus' },
      { k: 'owner', type: 'select', opts: ['Ingrid — build & enable', 'Customer — install & operate', 'Shared — Ingrid enables · Customer installs'] },
      { k: 'notes', type: 'text', ph: 'e.g. Checkout plugin · link to docs' } ] },
    outbound: { min: 1, cols: [
      { k: 'origin', type: 'text', ph: 'e.g. SE' },
      { k: 'dest', type: 'text', ph: 'e.g. SE, DK, NO' },
      { k: 'carrier', type: 'text', ph: 'e.g. PostNord' },
      { k: 'code', type: 'text', ph: 'e.g. 17, A2' } ] },
    returns: { min: 1, cols: [
      { k: 'origin', type: 'text', ph: 'e.g. SE' },
      { k: 'dest', type: 'text', ph: 'e.g. SE' },
      { k: 'carrier', type: 'text', ph: 'e.g. Budbee' },
      { k: 'code', type: 'text', ph: 'e.g. R-STD' } ] },
    devreq: { min: 1, cols: [
      { k: 'feature', type: 'text', ph: 'Describe the feature…' },
      { k: 'status', type: 'select', opts: ['In scope for go-live', 'Out of scope for go-live', 'Estimating'] },
      { k: 'eta', type: 'text', ph: 'e.g. Q4 2026' } ] }
  };

  var state = { fields: {}, lists: {} };
  var sowId = null;
  var customerToken = null;
  var isCustomer = false;
  var isLocked = false;
  var persistTimer = null;

  /* ---- helpers ---- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function blankRow(id) { var o = {}; LISTS[id].cols.forEach(function (c) { o[c.k] = ''; }); return o; }

  function ensureLists() {
    Object.keys(LISTS).forEach(function (id) {
      if (!Array.isArray(state.lists[id])) state.lists[id] = [];
      while (state.lists[id].length < LISTS[id].min) state.lists[id].push(blankRow(id));
    });
  }

  /* ---- URL params ---- */
  function getParam(name) {
    var p = new URLSearchParams(location.search);
    return p.get(name);
  }

  /* ---- persist (debounced, 500ms) ---- */
  function persist() {
    flashSaved();
    clearTimeout(persistTimer);
    persistTimer = setTimeout(doSave, 500);
  }

  function computeProgress() {
    var you = { total: 0, done: 0 }, ing = { total: 0, done: 0 };
    function bump(isIngrid, filled) { var b = isIngrid ? ing : you; b.total++; if (filled) b.done++; }
    function ownerIsIngrid(el) {
      var o = el.closest('[data-owner]');
      return !!(o && o.getAttribute('data-owner') === 'ingrid');
    }
    $$('.ctl-text[data-key], .ctl-area[data-key], .ctl-select[data-key]').forEach(function (el) {
      if (el.hasAttribute('data-optional')) return;
      bump(ownerIsIngrid(el), el.value.trim() !== '');
    });
    $$('.seg[data-key]').forEach(function (g) {
      if (g.hasAttribute('data-optional')) return;
      bump(ownerIsIngrid(g), !!$('button.is-on', g));
    });
    return {
      you: you.total ? Math.round(you.done / you.total * 100) : 0,
      ingrid: ing.total ? Math.round(ing.done / ing.total * 100) : 0
    };
  }

  function doSave() {
    if (!sowId || isLocked) return;
    var prog = computeProgress();
    if (isCustomer) {
      SowAPI.patchCustomerSow(sowId, customerToken, state, prog.you).catch(function (e) {
        if (e && e.message === 'locked') { enterReadOnly(); toast('This SOW has been locked by Ingrid'); }
      });
    } else {
      var user = SowAPI.getUser();
      var name = (user && (user.user_metadata && user.user_metadata.name)) || (user && user.email) || 'Ingrid';
      SowAPI.patchSow(sowId, {
        data: state,
        updated_by: 'ingrid:' + name,
        progress_you: prog.you,
        progress_ingrid: prog.ingrid
      }).catch(function () {});
    }
  }

  /* ---- list rendering ---- */
  function cellControl(id, idx, col) {
    var val = (state.lists[id][idx] && state.lists[id][idx][col.k]) || '';
    if (col.type === 'select') {
      var sel = document.createElement('select');
      sel.className = 'ctl-select';
      var ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Select…'; sel.appendChild(ph);
      col.opts.forEach(function (o) { var op = document.createElement('option'); op.textContent = o; op.value = o; sel.appendChild(op); });
      sel.value = val;
      markFilled(sel);
      attachRowMeta(sel, id, idx, col.k);
      return sel;
    }
    var inp = document.createElement('input');
    inp.className = 'ctl-text'; inp.type = 'text'; inp.placeholder = col.ph || '';
    inp.value = val; markFilled(inp);
    attachRowMeta(inp, id, idx, col.k);
    return inp;
  }

  function attachRowMeta(el, id, idx, k) {
    el.setAttribute('data-list', id); el.setAttribute('data-idx', idx); el.setAttribute('data-col', k);
  }

  function renderList(id) {
    var tb = $('tbody[data-list="' + id + '"]'); if (!tb) return;
    tb.innerHTML = '';
    state.lists[id].forEach(function (row, idx) {
      var tr = document.createElement('tr');
      LISTS[id].cols.forEach(function (col) {
        var td = document.createElement('td');
        td.appendChild(cellControl(id, idx, col));
        tr.appendChild(td);
      });
      var del = document.createElement('td'); del.className = 'cell-del';
      var btn = document.createElement('button');
      btn.className = 'rowdel'; btn.title = 'Remove row'; btn.setAttribute('data-del', id); btn.setAttribute('data-idx', idx);
      btn.innerHTML = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>';
      if (state.lists[id].length <= LISTS[id].min) btn.style.visibility = 'hidden';
      del.appendChild(btn); tr.appendChild(del);
      tb.appendChild(tr);
    });
  }
  function renderAllLists() { Object.keys(LISTS).forEach(renderList); }

  /* ---- filled state styling ---- */
  function markFilled(el) {
    var v = (el.value || '').trim();
    el.classList.toggle('is-filled', v !== '');
    if (el.tagName === 'SELECT') el.classList.toggle('placeholder', v === '');
  }

  /* ---- apply scalar + seg state to DOM ---- */
  function applyScalars() {
    $$('.ctl-text[data-key], .ctl-area[data-key], .ctl-select[data-key]').forEach(function (el) {
      var k = el.getAttribute('data-key');
      if (state.fields[k] != null) el.value = state.fields[k];
      markFilled(el);
    });
    $$('.seg[data-key]').forEach(function (grp) {
      var k = grp.getAttribute('data-key');
      var v = state.fields[k];
      var btns = $$('button', grp);
      btns.forEach(function (b, i) { b.classList.toggle('is-on', (v === 'yes' && i === 0) || (v === 'no' && i === 1)); });
    });
  }

  /* ---- progress ---- */
  function updateProgress() {
    var you = { total: 0, done: 0 }, ing = { total: 0, done: 0 };
    function bump(isIngrid, filled) { var b = isIngrid ? ing : you; b.total++; if (filled) b.done++; }
    function ownerIsIngrid(el) {
      var o = el.closest('[data-owner]');
      return !!(o && o.getAttribute('data-owner') === 'ingrid');
    }
    $$('.ctl-text[data-key], .ctl-area[data-key], .ctl-select[data-key]').forEach(function (el) {
      if (el.hasAttribute('data-optional')) return;
      bump(ownerIsIngrid(el), el.value.trim() !== '');
    });
    $$('.seg[data-key]').forEach(function (g) {
      if (g.hasAttribute('data-optional')) return;
      bump(ownerIsIngrid(g), !!$('button.is-on', g));
    });
    apply('you', you); apply('ingrid', ing);
    function apply(role, b) {
      var pct = b.total ? Math.round(b.done / b.total * 100) : 0;
      $$('[data-progress-bar="' + role + '"]').forEach(function (x) { x.style.width = pct + '%'; });
      $$('[data-progress-pct="' + role + '"]').forEach(function (x) { x.textContent = pct + '%'; });
      $$('[data-progress-count="' + role + '"]').forEach(function (x) { x.textContent = b.done + ' of ' + b.total; });
    }
  }

  function updateCustomer() {
    var v = (state.fields['customer-name'] || '').trim();
    var el = $('#tbCustomer');
    el.innerHTML = '<span>Customer:</span> ' + (v ? escapeHtml(v) : '—');
  }
  function escapeHtml(s) { return s.replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  /* ---- saved indicator + toast ---- */
  var savedTimer;
  function flashSaved() {
    var n = $('#savedNote'); if (!n) return;
    n.classList.add('flash');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { n.classList.remove('flash'); }, 240);
  }
  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---- read-only mode (locked SOW) ---- */
  function enterReadOnly() {
    isLocked = true;
    $$('.ctl-text, .ctl-area, .ctl-select').forEach(function (el) { el.disabled = true; });
    $$('.seg button').forEach(function (b) { b.style.pointerEvents = 'none'; });
    $$('.btn-add, .rowdel').forEach(function (b) { b.style.display = 'none'; });
    var banner = $('#lockedBanner'); if (banner) banner.hidden = false;
    var share = $('#btnShare'); if (share) share.style.display = 'none';
    var imp = $('#btnImport'); if (imp) imp.style.display = 'none';
  }

  /* ---- customer: disable ingrid-owned controls ---- */
  function restrictCustomer() {
    $$('[data-owner="ingrid"] .ctl-text, [data-owner="ingrid"] .ctl-area, [data-owner="ingrid"] .ctl-select').forEach(function (el) {
      el.disabled = true;
    });
    $$('[data-owner="ingrid"] .seg button').forEach(function (b) { b.style.pointerEvents = 'none'; });
    $$('[data-owner="ingrid"] .btn-add, [data-owner="ingrid"] .rowdel').forEach(function (b) { b.style.display = 'none'; });
    // Hide import/export (customer doesn't need these)
    var imp = $('#btnImport'); if (imp) imp.style.display = 'none';
    var exp = $('#btnExport'); if (exp) exp.style.display = 'none';
    // Hide share (customer already has the link)
    var shr = $('#btnShare'); if (shr) shr.style.display = 'none';
  }

  /* ---- wiring ---- */
  function wire() {
    $$('.ctl-text[data-key], .ctl-area[data-key], .ctl-select[data-key]').forEach(function (el) {
      var k = el.getAttribute('data-key');
      var ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, function () {
        state.fields[k] = el.value; markFilled(el);
        if (k === 'customer-name') updateCustomer();
        updateProgress(); persist();
      });
    });

    $$('.seg[data-key]').forEach(function (grp) {
      var k = grp.getAttribute('data-key');
      var btns = $$('button', grp);
      btns.forEach(function (b, i) {
        b.addEventListener('click', function () {
          btns.forEach(function (x, j) { x.classList.toggle('is-on', i === j); });
          state.fields[k] = i === 0 ? 'yes' : 'no';
          updateProgress(); persist();
        });
      });
    });

    document.addEventListener('input', listInput, true);
    document.addEventListener('change', listInput, true);

    document.addEventListener('click', function (e) {
      var add = e.target.closest('[data-add]');
      if (add) { var id = add.getAttribute('data-add'); state.lists[id].push(blankRow(id)); renderList(id); persist(); return; }
      var del = e.target.closest('[data-del]');
      if (del) {
        var lid = del.getAttribute('data-del'); var idx = +del.getAttribute('data-idx');
        state.lists[lid].splice(idx, 1); ensureLists(); renderList(lid); updateProgress(); persist();
      }
    });

    var btnPdf = $('#btnPdf'); if (btnPdf) btnPdf.addEventListener('click', function () { window.print(); });
    var btnExport = $('#btnExport'); if (btnExport) btnExport.addEventListener('click', exportJson);
    var btnImport = $('#btnImport'); if (btnImport) btnImport.addEventListener('click', function () { $('#fileInput').click(); });
    var fileInput = $('#fileInput'); if (fileInput) fileInput.addEventListener('change', importJson);
    var btnShare = $('#btnShare'); if (btnShare) btnShare.addEventListener('click', shareLink);
  }

  function listInput(e) {
    var el = e.target;
    if (!el.hasAttribute || !el.hasAttribute('data-list') || !el.hasAttribute('data-col')) return;
    var id = el.getAttribute('data-list'), idx = +el.getAttribute('data-idx'), col = el.getAttribute('data-col');
    if (!state.lists[id][idx]) state.lists[id][idx] = blankRow(id);
    state.lists[id][idx][col] = el.value;
    markFilled(el); persist();
  }

  /* ---- actions ---- */
  function customerSlug() {
    var v = (state.fields['customer-name'] || 'customer').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'customer';
    return v;
  }
  function download(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportJson() {
    var payload = JSON.stringify({ _type: 'ingrid-sow', _v: 2, savedAt: new Date().toISOString(), state: state }, null, 2);
    download(new Blob([payload], { type: 'application/json' }), 'SOW-' + customerSlug() + '.json');
    toast('Answers exported');
  }
  function importJson(e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var data = JSON.parse(r.result);
        var s = data && data.state ? data.state : data;
        if (!s || typeof s !== 'object') throw 0;
        state = { fields: s.fields || {}, lists: s.lists || {} };
        ensureLists(); renderAllLists(); applyScalars(); updateCustomer(); updateProgress(); persist();
        toast('Answers imported');
      } catch (err) { toast('Could not read that file'); }
      e.target.value = '';
    };
    r.readAsText(f);
  }
  function shareLink() {
    var url = location.origin + '/sow.html?id=' + encodeURIComponent(sowId) + '&t=' + encodeURIComponent(customerToken);
    var ok = function () { toast('Customer link copied to clipboard'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(ok, function () { prompt('Copy this link:', url); });
    } else { prompt('Copy this link:', url); }
  }

  /* ---- presence ---- */
  function startPresence(sowRow) {
    var user = SowAPI.getUser();
    var name = (user && user.user_metadata && user.user_metadata.name) || (user && user.email && user.email.split('@')[0]) || 'Ingrid';
    var info = isCustomer
      ? { who: 'customer', side: 'you', name: 'Customer' }
      : { who: 'ingrid', side: 'ingrid', name: name };
    SowAPI.joinPresence(sowId, info, function (users) {
      // Presence update — could update a UI indicator if we want, for now just log
    });
  }

  /* ---- init ---- */
  function init() {
    sowId = getParam('id');
    customerToken = getParam('t');
    isCustomer = !SowAPI.isIngrid() && !!customerToken;

    if (!sowId) {
      // No id param — if Ingrid, redirect to dashboard
      if (!SowAPI.isIngrid()) { window.location.href = 'login.html'; return; }
      // If we're Ingrid and came from dashboard with a new SOW, id must be in URL
      toast('No SOW id — go back to the dashboard');
      return;
    }

    var fetch = isCustomer
      ? SowAPI.getCustomerSow(sowId, customerToken)
      : SowAPI.getSow(sowId);

    fetch.then(function (sow) {
      if (!sow) { document.body.innerHTML = '<p style="font:16px sans-serif;padding:40px">SOW not found or link expired.</p>'; return; }
      state = { fields: (sow.data && sow.data.fields) || {}, lists: (sow.data && sow.data.lists) || {} };
      customerToken = customerToken || sow.customer_token;
      ensureLists();
      renderAllLists();
      applyScalars();
      updateCustomer();
      wire();
      updateProgress();
      if (sow.locked) {
        enterReadOnly();
      } else if (isCustomer) {
        restrictCustomer();
      }
      startPresence(sow);
      // Show back link for Ingrid
      if (SowAPI.isIngrid()) {
        var backBtn = $('#btnBack');
        if (backBtn) { backBtn.style.display = ''; }
      }
    }).catch(function (err) {
      document.body.innerHTML = '<p style="font:16px sans-serif;padding:40px">Could not load SOW. Check your link or try again.</p>';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
