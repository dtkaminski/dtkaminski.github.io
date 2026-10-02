/* greta-settings.js — brand settings on the server (brand_settings, migration 0224).
 *
 * Supplier terms, reorder rules, lead times, the demand plan, packaging, PO status, delist marks,
 * the weekly board's own actions and notes, snoozes and "done" marks lived only in localStorage,
 * under keys that did not name the brand: a teammate or a second device saw none of it, and two
 * brands on one laptop shared one supplier list.
 *
 * The screens still read and write those localStorage keys. This file keeps them in step with the
 * server: when the brand is known it loads that brand's rows into localStorage (server wins) and
 * tells the screens to re-read; every later write to a listed key is sent to the server too.
 *
 * Switching brand clears the listed keys before loading the new brand's rows. The first time a
 * browser meets an empty server store it offers up what it already holds (once, for that brand),
 * so nobody loses the settings they typed before this existed.
 *
 * Signed out (the public demo), or before 0224 is applied, nothing here does anything: the keys
 * stay browser-only, exactly as before. Never throws.
 */
(function () {
  'use strict';
  var KEYS = ['oi_supplier_v1', 'oi_suppliers_v1', 'oi_supplier_sku_v1', 'oi_reorder_v1', 'oi_lead_times',
    'oi_demandplan_v1', 'oi_packaging_v1', 'oi_po_status_v1', 'oi_delist_v1', 'frkl-board-actions',
    'frkl-board-notes', 'oi_snoozed', 'frkl-action-local-done', 'oi_clarity_manual', 'oi_insight_feedback'];
  var SYNC = {}; KEYS.forEach(function (k) { SYNC[k] = true; });
  var OWNER = 'oi-settings-brand';            // which brand the listed keys in this browser belong to
  var EVENTS = ['oi-supplier-updated', 'oi-leadtimes-updated', 'oi-costs-updated', 'oi-forecast-updated', 'oi-po-updated', 'oi-settings-loaded'];

  var ls; try { ls = window.localStorage; } catch (e) { return; }
  if (!ls || typeof Storage === 'undefined') return;
  var rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;
  var state = { brand: null, ready: false, off: false, pending: {}, timer: null };

  function sb() { return window.FRKL_LIVE && window.FRKL_LIVE.sb; }
  function parse(v) { try { return JSON.parse(v); } catch (e) { return v; } }
  function text(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
  function tell() { EVENTS.forEach(function (ev) { try { window.dispatchEvent(new Event(ev)); } catch (e) {} }); }

  function flush() {
    state.timer = null;
    var s = sb(), b = state.brand; if (!s || !b || state.off) return;
    var rows = Object.keys(state.pending).map(function (k) {
      var v = state.pending[k]; return v === null ? null : { brand_id: b, key: k, value: parse(v) };
    }).filter(Boolean);
    var gone = Object.keys(state.pending).filter(function (k) { return state.pending[k] === null; });
    state.pending = {};
    if (rows.length) s.from('brand_settings').upsert(rows, { onConflict: 'brand_id,key' }).then(function (r) {
      if (r && r.error && window.console) console.warn('[settings] save failed', r.error.message || r.error);
    });
    if (gone.length) s.from('brand_settings').delete().eq('brand_id', b).in('key', gone).then(function () {});
  }
  function queue(k, v) {
    if (!state.ready || state.off) return;
    state.pending[k] = v;
    if (!state.timer) state.timer = setTimeout(flush, 800);
  }

  // Writes to a listed key also go to the server. Only localStorage, only the listed keys.
  Storage.prototype.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (this === ls && SYNC[k]) queue(k, String(v));
  };
  Storage.prototype.removeItem = function (k) {
    rawRemove.call(this, k);
    if (this === ls && SYNC[k]) queue(k, null);
  };

  async function load(b) {
    var s = sb(); if (!s || !b || state.brand === b) return;
    state.ready = false; state.brand = b;
    var r = await s.from('brand_settings').select('key,value').eq('brand_id', b);
    if (state.brand !== b) return;                           // switched again while loading
    if (r.error) { state.off = true; return; }               // table not there yet (0224 not applied)
    state.off = false;
    var owner = ls.getItem(OWNER), rows = r.data || [];
    if (!rows.length && (owner === null || owner === b)) {
      // First meeting: this browser's existing settings become this brand's.
      var up = KEYS.filter(function (k) { return ls.getItem(k) != null; })
        .map(function (k) { return { brand_id: b, key: k, value: parse(ls.getItem(k)) }; });
      if (up.length) await s.from('brand_settings').upsert(up, { onConflict: 'brand_id,key' });
    } else {
      KEYS.forEach(function (k) { rawRemove.call(ls, k); });
      rows.forEach(function (row) { if (SYNC[row.key]) rawSet.call(ls, row.key, text(row.value)); });
    }
    rawSet.call(ls, OWNER, b);
    state.ready = true;
    tell();
  }

  function tryLoad() { var b = window.FRKL_LIVE && window.FRKL_LIVE.brandId; if (b && sb()) load(b).catch(function () { state.off = true; }); }
  window.addEventListener('frkl-brand-ready', tryLoad);
  window.addEventListener('frkl-data-updated', tryLoad);
  tryLoad();
  window.OI_SETTINGS = { keys: KEYS.slice(), status: function () { return { brand: state.brand, ready: state.ready, off: state.off }; } };
})();
