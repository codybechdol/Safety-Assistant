/**
 * Crew Equipment Inventory Audit — Standalone Foreman Web Form
 * Zero-download, mobile/iPad-first, offline-capable form backed by token-locked Supabase RPCs.
 */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://ixjlynzrqnuynpdtpdzu.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4amx5bnpycW51eW5wZHRwZHp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2NTE2OTAsImV4cCI6MjEwOTIyNzY5MH0.TjgigNhr-UXvT3IrFzZFOEKz3_3qkk3-F14MEtQc-sQ';

  const CATEGORIES = [
    {
      key: 'gloves',
      label: 'Gloves',
      shortLabel: 'Gloves',
      icon: '🧤',
      subtitle: 'Enter each rubber glove pair assigned to your crew members.',
      hasEmployee: true,
      idLabel: 'Glove / Item #',
      idPlaceholder: 'e.g., 2045'
    },
    {
      key: 'sleeves',
      label: 'Sleeves',
      shortLabel: 'Sleeves',
      icon: '🦺',
      subtitle: 'Enter each rubber sleeve pair assigned to your crew members.',
      hasEmployee: true,
      idLabel: 'Sleeve / Item #',
      idPlaceholder: 'e.g., S-1102'
    },
    {
      key: 'blankets',
      label: 'Blankets',
      shortLabel: 'Blankets',
      icon: '🧱',
      subtitle: 'Enter all regular and split insulating blankets on your trucks.',
      hasEmployee: false,
      idLabel: 'Blanket #',
      idPlaceholder: 'e.g., B104 or S208'
    },
    {
      key: 'macks',
      label: 'MACKs',
      shortLabel: 'MACKs',
      icon: '🔌',
      subtitle: 'Enter all mechanical jumpers (MACKs) on your crew.',
      hasEmployee: false,
      idLabel: 'MACK # (ESL ID)',
      idPlaceholder: 'e.g., 64977789'
    },
    {
      key: 'hv_testers',
      label: 'HV Testers',
      shortLabel: 'HV Testers',
      icon: '⚡',
      subtitle: 'Enter all high-voltage testers and calibration dates.',
      hasEmployee: false,
      idLabel: 'HVT # / Item #',
      idPlaceholder: 'e.g., HVT-04'
    },
    {
      key: 'phasing_sets',
      label: 'Phasing Sets',
      shortLabel: 'Phasing Sets',
      icon: '⚡',
      subtitle: 'Enter all phasing sets and calibration dates.',
      hasEmployee: false,
      idLabel: 'Phasing Set #',
      idPlaceholder: 'e.g., PS-12'
    },
    {
      key: 'aed',
      label: 'AED',
      shortLabel: 'AED',
      icon: '🏥',
      subtitle: 'Enter each AED unit along with pad and battery expiration dates.',
      hasEmployee: false,
      idLabel: 'AED # / Item #',
      idPlaceholder: 'e.g., AED-01'
    },
    {
      key: 'grounds',
      label: 'Grounds',
      shortLabel: 'Grounds',
      icon: '⚡',
      subtitle: 'Enter overhead (OH) and underground (UG) electrical ground sets.',
      hasEmployee: false,
      idLabel: 'Serial # / Ground #',
      idPlaceholder: 'e.g., GND-552'
    },
    {
      key: 'hot_sticks',
      label: 'Hot Sticks',
      shortLabel: 'Hot Sticks',
      icon: '🔴',
      subtitle: 'Enter all live-line tools (extendo, shotgun, universal, cutters, etc.).',
      hasEmployee: false,
      idLabel: 'Stick # / Item #',
      idPlaceholder: 'e.g., HS-10'
    },
    {
      key: 'fire_extinguishers',
      label: 'Fire Extinguishers',
      shortLabel: 'Fire Ext.',
      icon: '🧯',
      subtitle: 'Enter the fire extinguisher for each truck / piece of equipment or job shack (X###), its annual test date, and whether it needs replacement.',
      hasEmployee: false,
      fieldOnly: true,
      idLabel: 'Vehicle / Equipment #',
      idPlaceholder: 'e.g., 2108 or X104'
    },
    {
      key: 'first_aid_kits',
      label: '1st Aid Kits',
      shortLabel: '1st Aid Kits',
      icon: '🩹',
      subtitle: 'Log any truck or job shack (X###) that needs a 1st Aid Kit replacement/restock — or confirm trucks are stocked.',
      hasEmployee: false,
      fieldOnly: true,
      idLabel: 'Vehicle / Equipment #',
      idPlaceholder: 'e.g., 2108 or X104'
    }
  ];

  const CATEGORY_MAP = {};
  CATEGORIES.forEach((c) => { CATEGORY_MAP[c.key] = c; });

  // App state
  const state = {
    token: '',
    isDemo: false,
    request: null,
    submission: null,
    locked: false,
    expired: false,
    activeCategory: 'gloves',
    editingId: null,
    draft: createEmptyDraft(),
    localUpdatedAt: 0,
    cloudSavedAt: null,
    hasUnsyncedChanges: false,
    pendingSubmit: null,
    isSavingCloud: false,
    autoSaveTimer: null,
    toastTimer: null,
    lastKeptSpecs: {}
  };

  function createEmptyDraft() {
    const items = {};
    const noneConfirmed = {};
    CATEGORIES.forEach((c) => {
      items[c.key] = [];
      noneConfirmed[c.key] = false;
    });
    return {
      version: 1,
      items,
      noneConfirmed,
      submittedByName: '',
      updatedAt: null
    };
  }

  function normalizeDraft(raw) {
    const base = createEmptyDraft();
    if (!raw || typeof raw !== 'object') return base;
    CATEGORIES.forEach((c) => {
      if (raw.items && Array.isArray(raw.items[c.key])) {
        base.items[c.key] = raw.items[c.key].map((entry) => ({
          id: entry.id || generateLocalId(),
          ...entry
        }));
      }
      if (raw.noneConfirmed && raw.noneConfirmed[c.key] === true) {
        base.noneConfirmed[c.key] = true;
      }
    });
    if (raw.submittedByName) base.submittedByName = String(raw.submittedByName);
    if (raw.updatedAt) base.updatedAt = raw.updatedAt;
    return base;
  }

  function generateLocalId() {
    return 'itm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isMissingDateValue(val) {
    const s = String(val || '').trim().toLowerCase();
    return s === 'none' || s === 'no sticker' || s === 'no date';
  }

  function isBareUnnumberedNA(val) {
    return /^n\s*\/?\s*a$/i.test(String(val || '').trim());
  }

  function extractUnnumberedNAIndex(val) {
    const m = String(val || '').trim().match(/^n\s*\/?\s*a[-\s#]*(\d+)$/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function getNextAutoNAId(catKey, excludeId = null) {
    const existingList = state.draft.items[catKey] || [];
    const usedIds = new Set();
    let maxIdx = 0;
    existingList.forEach((it) => {
      if (excludeId && it.id === excludeId) return;
      const raw = String(it.itemNum || '').trim();
      usedIds.add(raw.toLowerCase());
      const idx = extractUnnumberedNAIndex(raw);
      if (idx !== null && idx > maxIdx) maxIdx = idx;
    });
    let next = maxIdx + 1;
    while (usedIds.has(`na${next}`)) next++;
    return `NA${next}`;
  }

  function formatDisplayDate(isoStr) {
    if (!isoStr) return '';
    if (isMissingDateValue(isoStr)) return 'None (No Sticker)';
    const s = String(isoStr).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
    return s;
  }

  function renderDateWithNoneField(inputId, labelText, currentVal) {
    const isNone = isMissingDateValue(currentVal);
    const dateVal = isNone ? '' : escapeHtml(currentVal || '');
    return `
      <div class="field-group">
        <label class="field-label" for="${inputId}">
          <span>${escapeHtml(labelText)} <span class="field-req">*</span></span>
        </label>
        <div class="date-input-wrap">
          <input type="date" id="${inputId}" class="field-input ${isNone ? 'date-disabled' : ''}"
            value="${dateVal}" ${isNone ? 'disabled' : ''}>
          <button type="button" class="date-none-btn ${isNone ? 'active' : ''}"
            data-none-target="${inputId}" aria-pressed="${isNone ? 'true' : 'false'}">
            ${isNone ? '⚠️ None — No Sticker (Needs Changeout)' : '🚫 None (No Sticker / Missing Date)'}
          </button>
        </div>
      </div>
    `;
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function getDeviceLabel() {
    const ua = navigator.userAgent || '';
    if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac/i.test(ua)) return 'Mac';
    return 'Web Browser';
  }

  function getTotalItemCount(draftObj = state.draft) {
    let total = 0;
    CATEGORIES.forEach((c) => {
      total += (draftObj.items[c.key] || []).length;
    });
    return total;
  }

  // ---------------------------------------------------------------------------
  // Local Storage + Offline Resilience
  // ---------------------------------------------------------------------------
  function storageKey(prefix) {
    return `crew_audit_${prefix}_${state.token}`;
  }

  function saveLocalCache() {
    try {
      const payload = {
        draft: state.draft,
        localUpdatedAt: state.localUpdatedAt,
        hasUnsyncedChanges: state.hasUnsyncedChanges,
        pendingSubmit: state.pendingSubmit
      };
      localStorage.setItem(storageKey('draft'), JSON.stringify(payload));
      if (state.request) {
        localStorage.setItem(storageKey('meta'), JSON.stringify({
          request: state.request,
          locked: state.locked,
          expired: state.expired,
          submission: state.submission
        }));
      }
    } catch (e) {
      console.warn('Local storage save warning:', e);
    }
  }

  function loadLocalCache() {
    try {
      const rawDraft = localStorage.getItem(storageKey('draft'));
      const rawMeta = localStorage.getItem(storageKey('meta'));
      return {
        draftEnvelope: rawDraft ? JSON.parse(rawDraft) : null,
        metaEnvelope: rawMeta ? JSON.parse(rawMeta) : null
      };
    } catch {
      return { draftEnvelope: null, metaEnvelope: null };
    }
  }

  // ---------------------------------------------------------------------------
  // Supabase Token-Locked RPC Helpers
  // ---------------------------------------------------------------------------
  async function callRpc(fnName, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = (data && (data.message || data.error)) || `Server error (${resp.status})`;
        throw new Error(msg);
      }
      return data;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Toast & Sync Status UI
  // ---------------------------------------------------------------------------
  function showToast(message, variant = '') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = `toast ${variant}`.trim();
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 3200);
  }

  function updateSyncUI() {
    const pill = document.getElementById('sync-status-pill');
    const text = document.getElementById('sync-status-text');
    const savedLabel = document.getElementById('last-saved-label');
    const banner = document.getElementById('notice-banner');

    if (!pill || !text) return;

    const online = navigator.onLine;
    pill.classList.remove('offline', 'saving');

    if (state.isDemo) {
      text.textContent = 'Preview Mode';
    } else if (!online) {
      pill.classList.add('offline');
      text.textContent = 'Offline (Saved)';
    } else if (state.isSavingCloud) {
      pill.classList.add('saving');
      text.textContent = 'Saving...';
    } else if (state.pendingSubmit) {
      pill.classList.add('offline');
      text.textContent = 'Submit Queued';
    } else if (state.hasUnsyncedChanges) {
      pill.classList.add('saving');
      text.textContent = 'Unsaved Draft';
    } else {
      text.textContent = 'Saved Online';
    }

    if (savedLabel) {
      if (state.isDemo) {
        savedLabel.textContent = 'Demo mode — saved on this device only';
      } else if (state.pendingSubmit) {
        savedLabel.textContent = 'Submission queued — will send when back online';
      } else if (!online) {
        savedLabel.textContent = 'Offline — all changes safely stored on device';
      } else if (state.cloudSavedAt) {
        savedLabel.textContent = `Draft saved ${formatTimestamp(state.cloudSavedAt)}`;
      } else {
        savedLabel.textContent = 'Auto-saves on device & cloud';
      }
    }

    if (banner) {
      const messages = [];
      if (state.isDemo) {
        messages.push('Preview Mode: Try adding items across all 9 categories. Nothing is sent to the database in preview mode.');
      }
      if (!online) {
        messages.push('You are currently offline. Keep entering equipment normally — everything is saved on this device and will sync once reception returns.');
      }
      if (state.pendingSubmit) {
        messages.push('Your completed audit is queued on this device and will submit automatically once internet returns.');
      }
      if (state.request && state.request.notes && online && !state.pendingSubmit) {
        messages.push(`Note from Safety: ${state.request.notes}`);
      }

      if (messages.length > 0) {
        banner.textContent = messages.join(' ');
        banner.className = `notice-banner ${(!online || state.pendingSubmit) ? '' : 'info'}`.trim();
      } else {
        banner.classList.add('hidden');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // State Screens (Error, Expired, Submitted Receipt)
  // ---------------------------------------------------------------------------
  function showStateScreen(icon, title, message, extraHtml = '') {
    document.getElementById('audit-shell').classList.add('hidden');
    const screen = document.getElementById('state-screen');
    const card = document.getElementById('state-card');
    screen.classList.remove('hidden');
    card.innerHTML = `
      <div class="state-icon">${icon}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      ${extraHtml}
    `;
  }

  function showSubmittedScreen(submittedAt, submittedBy, payloadObj) {
    const req = state.request || {};
    const parsed = normalizeDraft(payloadObj || state.draft);
    const visibleCats = getVisibleCategories();
    const total = visibleCats.reduce((sum, c) => sum + ((parsed.items[c.key] || []).length), 0);
    const breakdown = visibleCats.map((c) => {
      const cnt = (parsed.items[c.key] || []).length;
      const isNone = parsed.noneConfirmed[c.key];
      const badge = cnt > 0 ? `${cnt}` : (isNone ? (c.key === 'first_aid_kits' ? 'All Stocked ✓' : 'None') : '0');
      return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #e2e8f0;">
        <span>${c.icon} ${c.label}</span>
        <strong>${badge}</strong>
      </div>`;
    }).join('');

    const extraHtml = `
      <div class="state-summary-box">
        <div style="margin-bottom:8px;"><strong>Crew / Job:</strong> ${escapeHtml(req.job_number || 'N/A')} ${req.location ? `(${escapeHtml(req.location)})` : ''}</div>
        <div style="margin-bottom:8px;"><strong>Foreman:</strong> ${escapeHtml(req.foreman_name || '')}</div>
        ${submittedBy ? `<div style="margin-bottom:8px;"><strong>Submitted By:</strong> ${escapeHtml(submittedBy)}</div>` : ''}
        ${submittedAt ? `<div style="margin-bottom:10px;"><strong>Submitted:</strong> ${escapeHtml(formatTimestamp(submittedAt))}</div>` : ''}
        <div style="font-weight:800;margin-bottom:4px;">Total Items Logged: ${total}</div>
        ${breakdown}
      </div>
      <p style="font-size:13px;color:#64748b;">You can safely close this browser tab. If you need to add or fix anything, contact Safety to reopen your link.</p>
    `;

    showStateScreen(
      '✅',
      'Equipment Audit Submitted',
      'Thank you! Your crew equipment inventory has been sent to Safety for review.',
      extraHtml
    );
  }

  // ---------------------------------------------------------------------------
  // Cloud Sync (Auto-Save Draft & Submit)
  // ---------------------------------------------------------------------------
  function markDraftModified() {
    state.localUpdatedAt = Date.now();
    state.draft.updatedAt = new Date(state.localUpdatedAt).toISOString();
    state.hasUnsyncedChanges = true;
    saveLocalCache();
    updateTotalCounter();
    updateSyncUI();

    if (!state.isDemo && navigator.onLine && !state.locked) {
      clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = setTimeout(() => {
        syncDraftToCloud(false);
      }, 2500);
    }
  }

  async function syncDraftToCloud(showFeedback = false) {
    if (state.isDemo) {
      saveLocalCache();
      if (showFeedback) showToast('Draft saved locally (Preview Mode)', 'success');
      return true;
    }
    if (state.locked) return false;
    if (!navigator.onLine) {
      saveLocalCache();
      updateSyncUI();
      if (showFeedback) showToast('Offline — draft safely saved on this device', 'warning');
      return false;
    }
    if (state.isSavingCloud) return false;

    state.isSavingCloud = true;
    updateSyncUI();
    try {
      const res = await callRpc('save_audit_draft', {
        p_token: state.token,
        p_payload: state.draft,
        p_item_count: getTotalItemCount(),
        p_device: getDeviceLabel()
      });
      if (res && res.ok) {
        state.cloudSavedAt = res.saved_at || new Date().toISOString();
        state.hasUnsyncedChanges = false;
        saveLocalCache();
        if (showFeedback) showToast('Draft saved! You can return to this link anytime.', 'success');
        return true;
      } else {
        if (res && res.locked) {
          state.locked = true;
          showStateScreen('🔒', 'Audit Locked', res.error || 'This audit has already been submitted.');
        } else if (showFeedback) {
          showToast((res && res.error) || 'Could not save draft right now.', 'error');
        }
        return false;
      }
    } catch (err) {
      console.warn('Draft cloud sync deferred:', err);
      if (showFeedback) showToast('Connection weak — draft saved safely on this device.', 'warning');
      return false;
    } finally {
      state.isSavingCloud = false;
      updateSyncUI();
    }
  }

  async function flushPendingSubmitIfOnline() {
    if (!state.pendingSubmit || !navigator.onLine || state.isDemo) return;
    try {
      const res = await callRpc('submit_audit', {
        p_token: state.token,
        p_payload: state.draft,
        p_item_count: getTotalItemCount(),
        p_submitted_by: state.pendingSubmit.submittedBy || state.request?.foreman_name || '',
        p_device: getDeviceLabel()
      });
      if (res && res.ok) {
        const subBy = state.pendingSubmit.submittedBy || state.request?.foreman_name || '';
        state.pendingSubmit = null;
        state.locked = true;
        state.hasUnsyncedChanges = false;
        saveLocalCache();
        showSubmittedScreen(res.submitted_at || new Date().toISOString(), subBy, state.draft);
      }
    } catch (err) {
      console.warn('Queued submission still waiting for connection:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Dynamic Category Form Builder (All 9 Categories)
  // ---------------------------------------------------------------------------
  function getCrewEmployees() {
    const list = (state.request && Array.isArray(state.request.crew_employees))
      ? state.request.crew_employees
      : [];
    const seen = new Set();
    const out = [];
    list.forEach((name) => {
      const clean = String(name || '').trim();
      if (clean && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        out.push(clean);
      }
    });
    // Include any custom names already entered in gloves/sleeves so they appear in dropdown
    ['gloves', 'sleeves'].forEach((cat) => {
      (state.draft.items[cat] || []).forEach((item) => {
        const clean = String(item.employeeName || '').trim();
        if (clean && !seen.has(clean.toLowerCase())) {
          seen.add(clean.toLowerCase());
          out.push(clean);
        }
      });
    });
    return out;
  }

  function getVisibleCategories() {
    return isShopStatusAudit() ? CATEGORIES.filter((c) => !c.fieldOnly) : CATEGORIES;
  }

  function getEnteredVehicleChips(currentCatKey) {
    const seen = new Set();
    const out = [];
    // Prefer vehicles entered in the OTHER vehicle-based category first so foremen tap them effortlessly
    const order = currentCatKey === 'first_aid_kits'
      ? ['fire_extinguishers', 'first_aid_kits']
      : ['first_aid_kits', 'fire_extinguishers'];
    order.forEach((ck) => {
      (state.draft.items[ck] || []).forEach((it) => {
        const clean = String(it.itemNum || '').trim();
        if (clean && !seen.has(clean.toLowerCase())) {
          seen.add(clean.toLowerCase());
          out.push(clean);
        }
      });
    });
    return out;
  }

  function normalizeVehicleEntry(rawInput, unitType) {
    const raw = String(rawInput || '').trim();
    const jobNum = String((state.request && state.request.job_number) || '').trim();

    if (unitType === 'job_shack') {
      if (!raw || /^job\s*shack$/i.test(raw)) {
        return jobNum ? `Job Shack (${jobNum})` : 'Job Shack';
      }
      // X### shack numbers (e.g. X9, X104, Unit X104, Shack X104)
      const xm = raw.match(/^(?:unit|shack|job\s*shack|trailer|#)?\s*#?\s*(x\d+[a-z]?)$/i);
      if (xm) return xm[1].toUpperCase();
      // If user typed a custom shack label without job #, attach job # so crews don't collide
      if (jobNum && !raw.includes(jobNum)) return `${raw} (${jobNum})`;
      return raw;
    }

    // Truck / Equipment: strip redundant "Unit" / "Truck" / "#" prefix if followed by unit number (e.g. "Unit 2108" -> "2108", "Unit X104" -> "X104")
    const tm = raw.match(/^(?:unit|truck|veh(?:icle)?|equip(?:ment)?|rig|t-)?\s*#?\s*(x?\d+[a-z]?)$/i);
    if (tm) return tm[1].toUpperCase();
    return raw;
  }

  function renderCategoryTabs() {
    const container = document.getElementById('category-tabs');
    if (!container) return;
    const visibleCats = getVisibleCategories();
    if (!visibleCats.some((c) => c.key === state.activeCategory)) {
      state.activeCategory = visibleCats[0].key;
    }
    container.innerHTML = visibleCats.map((c) => {
      const count = (state.draft.items[c.key] || []).length;
      const isNone = state.draft.noneConfirmed[c.key] && count === 0;
      const isActive = state.activeCategory === c.key;
      const cls = [
        'cat-tab',
        isActive ? 'active' : '',
        count > 0 ? 'has-items' : '',
        isNone ? 'is-none' : ''
      ].filter(Boolean).join(' ');
      const badgeText = count > 0 ? String(count) : (isNone ? (c.key === 'first_aid_kits' ? 'All OK ✓' : 'None ✓') : '0');
      return `<button type="button" class="${cls}" data-cat="${c.key}">
        <span>${c.icon}</span>
        <span>${escapeHtml(c.shortLabel)}</span>
        <span class="cat-badge">${badgeText}</span>
      </button>`;
    }).join('');

    container.querySelectorAll('.cat-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextCat = btn.dataset.cat;
        if (nextCat && nextCat !== state.activeCategory) {
          state.activeCategory = nextCat;
          state.editingId = null;
          renderActiveCategory();
          btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
      });
    });
  }

  function renderActiveCategory(prefill = null) {
    const visibleCats = getVisibleCategories();
    if (!visibleCats.some((c) => c.key === state.activeCategory)) {
      state.activeCategory = visibleCats[0].key;
    }
    const cat = CATEGORY_MAP[state.activeCategory];
    if (!cat) return;

    renderCategoryTabs();

    document.getElementById('cat-title').textContent = `${cat.icon} ${cat.label}`;
    let subtitleText = cat.subtitle;
    if (isPackedForDeliveryAudit()) {
      subtitleText = `Enter each ${cat.label.toLowerCase()} item physically packed for delivery and who it is packed for.`;
    } else if (isShopStatusAudit() && (cat.key === 'gloves' || cat.key === 'sleeves')) {
      subtitleText = `Enter each ${cat.label.toLowerCase()} pair currently in ${(state.request && state.request.foreman_name) || 'this shop pool'}.`;
    }
    document.getElementById('cat-subtitle').textContent = subtitleText;

    const noneCheckbox = document.getElementById('cat-none-checkbox');
    const noneWrap = document.getElementById('none-toggle-wrap');
    const noneLabelSpan = noneWrap ? noneWrap.querySelector('span') : null;
    if (noneLabelSpan) {
      if (cat.key === 'first_aid_kits') {
        noneLabelSpan.textContent = 'All Trucks & Shacks Stocked (None Needed)';
      } else if (isShopStatusAudit()) {
        noneLabelSpan.textContent = 'None in Pool';
      } else {
        noneLabelSpan.textContent = 'None on Crew';
      }
    }
    const items = state.draft.items[cat.key] || [];
    const isNone = Boolean(state.draft.noneConfirmed[cat.key]) && items.length === 0;
    noneCheckbox.checked = isNone;
    noneCheckbox.disabled = items.length > 0;
    noneWrap.classList.toggle('checked', isNone);
    noneWrap.style.opacity = items.length > 0 ? '0.5' : '1';

    const formEl = document.getElementById('item-entry-form');
    const modeBadge = document.getElementById('entry-mode-badge');
    const cancelBtn = document.getElementById('btn-cancel-edit');
    const saveBtn = document.getElementById('btn-save-item');
    const saveSimilarBtn = document.getElementById('btn-save-similar');

    const isEditing = Boolean(state.editingId);
    formEl.classList.toggle('editing', isEditing);
    modeBadge.textContent = isEditing ? `Editing ${cat.shortLabel} Entry` : `Add ${cat.shortLabel} Entry`;
    cancelBtn.classList.toggle('hidden', !isEditing);
    saveBtn.textContent = isEditing ? 'Save Changes' : `+ Add ${cat.shortLabel.replace(/s$/, '')}`;
    saveSimilarBtn.classList.toggle('hidden', isEditing);

    hideValidationMsg();

    const values = prefill || (isEditing ? items.find((i) => i.id === state.editingId) : null) || {};
    buildDynamicFields(cat.key, values);
    renderItemsList();
    updateTotalCounter();
  }

  function isShopStatusAudit() {
    const jn = String((state.request && state.request.job_number) || '').trim().toUpperCase();
    return jn.startsWith('SHOP-');
  }

  function isPackedForDeliveryAudit() {
    const jn = String((state.request && state.request.job_number) || '').trim().toUpperCase();
    const fn = String((state.request && state.request.foreman_name) || '').trim().toLowerCase();
    return jn === 'SHOP-PACKED-DELIVERY' || fn === 'packed for delivery';
  }

  function getPackedForEmployees() {
    const ignore = new Set([
      'packed for delivery', 'ready for delivery', 'on shelf',
      'in testing', 'packed for testing', 'ready for test'
    ]);
    const seen = new Set();
    const out = [];
    const addName = (name) => {
      const clean = String(name || '').trim();
      if (!clean || ignore.has(clean.toLowerCase())) return;
      if (!seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        out.push(clean);
      }
    };
    const reqList = (state.request && Array.isArray(state.request.crew_employees))
      ? state.request.crew_employees
      : [];
    reqList.forEach(addName);
    CATEGORIES.forEach((c) => {
      (state.draft.items[c.key] || []).forEach((it) => {
        if (it.packedFor) addName(it.packedFor);
      });
    });
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  function getRecentPackedForChips() {
    const seen = new Set();
    const out = [];
    // Prioritize current category first, then other categories
    const order = [state.activeCategory, ...CATEGORIES.map((c) => c.key).filter((k) => k !== state.activeCategory)];
    order.forEach((ck) => {
      (state.draft.items[ck] || []).forEach((it) => {
        const clean = String(it.packedFor || '').trim();
        if (clean && !seen.has(clean.toLowerCase()) && out.length < 10) {
          seen.add(clean.toLowerCase());
          out.push(clean);
        }
      });
    });
    return out;
  }

  function renderPackedForField(currentVal) {
    const cleanVal = String(currentVal || '').trim();
    const recentChips = getRecentPackedForChips();
    return `
      <div class="field-group full-width packed-for-group">
        <label class="field-label" for="f-packed-for">
          <span>🚚 Packed For (Employee Name) <span class="field-req">*</span></span>
          <span class="field-opt">Search or type employee</span>
        </label>
        <div class="emp-combobox-wrap">
          <input type="text" id="f-packed-for" class="field-input"
            placeholder="Start typing employee name..."
            value="${escapeHtml(cleanVal)}"
            autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
          <div id="f-packed-for-list" class="emp-suggest-list hidden" role="listbox"></div>
        </div>
        ${recentChips.length > 0 ? `
          <div class="chip-row" data-packed-chips="true" style="margin-top:6px;">
            ${recentChips.map((n) => `<button type="button" class="quick-chip ${cleanVal.toLowerCase() === n.toLowerCase() ? 'selected' : ''}" data-packed-val="${escapeHtml(n)}">👤 ${escapeHtml(n)}</button>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  function buildDynamicFields(catKey, vals = {}) {
    const container = document.getElementById('dynamic-fields');
    if (!container) return;

    const isShop = isShopStatusAudit();
    const isPacked = isPackedForDeliveryAudit();
    let html = '';

    if (catKey === 'gloves' || catKey === 'sleeves') {
      const isGlove = catKey === 'gloves';
      const employees = getCrewEmployees();
      const curEmp = vals.employeeName || '';
      const isKnownEmp = curEmp && employees.some((e) => e.toLowerCase() === curEmp.toLowerCase());
      const useCustomEmp = Boolean(curEmp && !isKnownEmp);

      const empOptions = employees.map((e) =>
        `<option value="${escapeHtml(e)}" ${curEmp.toLowerCase() === e.toLowerCase() ? 'selected' : ''}>${escapeHtml(e)}</option>`
      ).join('');

      const sizeOptions = isGlove
        ? ['8', '8.5', '9', '9.5', '10', '10.5', '11', '12']
        : ['Regular', 'Large', 'X-Large'];
      const curSize = vals.size || '';
      const isCustomSize = Boolean(!isGlove && curSize && !sizeOptions.includes(curSize));

      const notesPlaceholder = 'Optional note';

      html = `
        ${isShop ? '' : `
          <div class="field-group full-width">
            <label class="field-label" for="f-employee-select">
              <span>Assigned Employee <span class="field-req">*</span></span>
            </label>
            <select id="f-employee-select" class="field-select">
              <option value="">-- Select Crew Member --</option>
              ${empOptions}
              <option value="__OTHER__" ${useCustomEmp ? 'selected' : ''}>+ Other / Unlisted Employee...</option>
            </select>
            <input type="text" id="f-employee-custom" class="field-input ${useCustomEmp ? '' : 'hidden'}"
              placeholder="Enter employee full name" value="${useCustomEmp ? escapeHtml(curEmp) : ''}">
          </div>
        `}

        <div class="field-group">
          <label class="field-label" for="f-item-num">
            <span>${isGlove ? 'Glove / Item #' : 'Sleeve / Item #'} <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-item-num" class="field-input" placeholder="${isGlove ? 'e.g., 2045 or NA' : 'e.g., S-1102 or NA'}"
            value="${escapeHtml(vals.itemNum || '')}" autocapitalize="characters">
          <div class="field-hint">Not numbered? Type <strong>NA</strong> (auto-numbers NA1, NA2...)</div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-esl-id">
            <span>ESL ID</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-esl-id" class="field-input" placeholder="e.g., ESL-889421"
            value="${escapeHtml(vals.eslId || '')}" autocapitalize="characters">
        </div>

        <div class="field-group">
          <label class="field-label" for="f-size-select">
            <span>Size <span class="field-req">*</span></span>
          </label>
          <select id="f-size-select" class="field-select">
            <option value="">-- Select Size --</option>
            ${sizeOptions.map((s) => `<option value="${s}" ${curSize === s ? 'selected' : ''}>${s}</option>`).join('')}
            ${!isGlove ? `<option value="__OTHER__" ${isCustomSize ? 'selected' : ''}>Other...</option>` : ''}
          </select>
          ${!isGlove ? `<input type="text" id="f-size-custom" class="field-input ${isCustomSize ? '' : 'hidden'}" placeholder="Enter sleeve size" value="${isCustomSize ? escapeHtml(curSize) : ''}">` : ''}
        </div>

        <div class="field-group">
          <label class="field-label" for="f-class">
            <span>Class <span class="field-req">*</span></span>
          </label>
          <select id="f-class" class="field-select">
            <option value="">-- Select Class --</option>
            ${isGlove ? `<option value="0" ${String(vals.itemClass || '') === '0' ? 'selected' : ''}>Class 0</option>` : ''}
            <option value="2" ${String(vals.itemClass || '2') === '2' ? 'selected' : ''}>Class 2</option>
            <option value="3" ${String(vals.itemClass || '') === '3' ? 'selected' : ''}>Class 3</option>
          </select>
        </div>

        ${renderDateWithNoneField('f-test-date', 'Test Date', vals.testDate)}

        <div class="field-group">
          <label class="field-label" for="f-notes">
            <span>Notes</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-notes" class="field-input" placeholder="${escapeHtml(notesPlaceholder)}" value="${escapeHtml(vals.notes || '')}">
        </div>
      `;
    } else if (catKey === 'blankets') {
      const bType = vals.type || 'Regular';
      html = `
        <div class="field-group">
          <label class="field-label" for="f-item-num">
            <span>Blanket # <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-item-num" class="field-input" placeholder="e.g., B104, S208, or NA"
            value="${escapeHtml(vals.itemNum || '')}" autocapitalize="characters">
          <div class="field-hint">Not numbered? Type <strong>NA</strong> (auto-numbers NA1, NA2...)</div>
        </div>

        <div class="field-group">
          <label class="field-label"><span>Type <span class="field-req">*</span></span></label>
          <input type="hidden" id="f-type" value="${escapeHtml(bType)}">
          <div class="segmented-group" data-seg-target="f-type">
            <button type="button" class="seg-btn ${bType === 'Regular' ? 'active' : ''}" data-seg-val="Regular">Regular</button>
            <button type="button" class="seg-btn ${bType === 'Split' ? 'active' : ''}" data-seg-val="Split">Split</button>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-class">
            <span>Class <span class="field-req">*</span></span>
          </label>
          <select id="f-class" class="field-select">
            <option value="4" ${String(vals.itemClass || '4') === '4' ? 'selected' : ''}>Class 4</option>
            <option value="2" ${String(vals.itemClass || '') === '2' ? 'selected' : ''}>Class 2</option>
          </select>
        </div>

        ${renderDateWithNoneField('f-test-date', 'Test Date', vals.testDate)}

        <div class="field-group full-width">
          <label class="field-label" for="f-notes">
            <span>Notes</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-notes" class="field-input" placeholder="Optional note" value="${escapeHtml(vals.notes || '')}">
        </div>
      `;
    } else if (catKey === 'macks') {
      html = `
        <div class="field-group">
          <label class="field-label" for="f-item-num">
            <span>MACK # (ESL ID) <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-item-num" class="field-input" placeholder="e.g., 64977789 or NA"
            value="${escapeHtml(vals.itemNum || '')}" autocapitalize="characters">
          <div class="field-hint">Not numbered? Type <strong>NA</strong> (auto-numbers NA1, NA2...)</div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-kv">
            <span>kV Rating <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-kv" class="field-input" placeholder="e.g., 15KV" value="${escapeHtml(vals.kv || '15KV')}">
          <div class="chip-row" data-chip-target="f-kv">
            ${['15KV', '25KV', '35KV'].map((v) => `<button type="button" class="quick-chip" data-chip-val="${v}">${v}</button>`).join('')}
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-size">
            <span>Size / Conductor <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-size" class="field-input" placeholder="e.g., 1/0, 2/0, 4/0" value="${escapeHtml(vals.size || '')}">
          <div class="chip-row" data-chip-target="f-size">
            ${['#2', '1/0', '2/0', '4/0'].map((v) => `<button type="button" class="quick-chip" data-chip-val="${v}">${v}</button>`).join('')}
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-length">
            <span>Length <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-length" class="field-input" placeholder="e.g., 12'" value="${escapeHtml(vals.length || '')}">
          <div class="chip-row" data-chip-target="f-length">
            ${["8'", "9'", "10.5'", "12'", "14'", "15'", "20'"].map((v) => `<button type="button" class="quick-chip" data-chip-val="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join('')}
          </div>
        </div>

        ${renderDateWithNoneField('f-test-date', 'Test Date', vals.testDate)}

        <div class="field-group">
          <label class="field-label" for="f-notes">
            <span>Notes</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-notes" class="field-input" placeholder="Optional note" value="${escapeHtml(vals.notes || '')}">
        </div>
      `;
    } else if (catKey === 'hv_testers' || catKey === 'phasing_sets') {
      const isHV = catKey === 'hv_testers';
      const models = ['Bierer', 'Chance', 'HD Electric', 'Megger'];
      const curModel = vals.model || '';
      const isCustomModel = Boolean(curModel && !models.includes(curModel));
      const kvChips = isHV ? ['69', '80', '500', '600'] : ['15KV', '40KV'];

      html = `
        <div class="field-group">
          <label class="field-label" for="f-item-num">
            <span>${isHV ? 'HVT # / Item #' : 'Phasing Set #'} <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-item-num" class="field-input" placeholder="${isHV ? 'e.g., HVT-04 or NA' : 'e.g., PS-12 or NA'}"
            value="${escapeHtml(vals.itemNum || '')}" autocapitalize="characters">
          <div class="field-hint">Not numbered? Type <strong>NA</strong> (auto-numbers NA1, NA2...)</div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-model-select">
            <span>Model</span>
          </label>
          <select id="f-model-select" class="field-select">
            <option value="">-- Select Model --</option>
            ${models.map((m) => `<option value="${m}" ${curModel === m ? 'selected' : ''}>${m}</option>`).join('')}
            <option value="__OTHER__" ${isCustomModel ? 'selected' : ''}>Other...</option>
          </select>
          <input type="text" id="f-model-custom" class="field-input ${isCustomModel ? '' : 'hidden'}"
            placeholder="Enter model name" value="${isCustomModel ? escapeHtml(curModel) : ''}">
        </div>

        <div class="field-group">
          <label class="field-label" for="f-kv">
            <span>kV Rating</span>
          </label>
          <input type="text" id="f-kv" class="field-input" placeholder="${isHV ? 'e.g., 69, 80, 500' : 'e.g., 15KV, 40KV'}"
            value="${escapeHtml(vals.kv || '')}">
          <div class="chip-row" data-chip-target="f-kv">
            ${kvChips.map((v) => `<button type="button" class="quick-chip" data-chip-val="${v}">${v}</button>`).join('')}
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-serial-num">
            <span>Serial #</span>
          </label>
          <input type="text" id="f-serial-num" class="field-input" placeholder="Enter serial number"
            value="${escapeHtml(vals.serialNum || '')}" autocapitalize="characters">
        </div>

        ${renderDateWithNoneField('f-cal-date', 'Calibration Date', vals.calibrationDate)}

        <div class="field-group">
          <label class="field-label" for="f-notes">
            <span>Notes</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-notes" class="field-input" placeholder="Optional note" value="${escapeHtml(vals.notes || '')}">
        </div>
      `;
    } else if (catKey === 'aed') {
      const aedModels = ['ZOLL AED 3', 'ZOLL AED Plus', 'Philips HeartStart', 'Cardiac Science'];
      const curModel = vals.model || 'ZOLL AED 3';
      const isCustomModel = Boolean(curModel && !aedModels.includes(curModel));

      html = `
        <div class="field-group">
          <label class="field-label" for="f-item-num">
            <span>AED # / Item # <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-item-num" class="field-input" placeholder="e.g., AED-01 or NA"
            value="${escapeHtml(vals.itemNum || '')}" autocapitalize="characters">
          <div class="field-hint">Not numbered? Type <strong>NA</strong> (auto-numbers NA1, NA2...)</div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-model-select">
            <span>Model</span>
          </label>
          <select id="f-model-select" class="field-select">
            ${aedModels.map((m) => `<option value="${m}" ${curModel === m ? 'selected' : ''}>${m}</option>`).join('')}
            <option value="__OTHER__" ${isCustomModel ? 'selected' : ''}>Other...</option>
          </select>
          <input type="text" id="f-model-custom" class="field-input ${isCustomModel ? '' : 'hidden'}"
            placeholder="Enter AED model" value="${isCustomModel ? escapeHtml(curModel) : ''}">
        </div>

        <div class="field-group">
          <label class="field-label" for="f-serial-num">
            <span>Serial #</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-serial-num" class="field-input" placeholder="Unit serial number"
            value="${escapeHtml(vals.serialNum || '')}" autocapitalize="characters">
        </div>

        <div class="field-group">
          <label class="field-label" for="f-pad-exp">
            <span>Pad Expiration Date <span class="field-req">*</span></span>
          </label>
          <input type="date" id="f-pad-exp" class="field-input" value="${escapeHtml(vals.padExpiration || '')}">
        </div>

        <div class="field-group">
          <label class="field-label" for="f-bat-exp">
            <span>Battery Expiration Date</span>
            <span class="field-opt">If printed on battery</span>
          </label>
          <input type="date" id="f-bat-exp" class="field-input" value="${escapeHtml(vals.batteryExpiration || '')}">
        </div>

        <div class="field-group">
          <label class="field-label" for="f-notes">
            <span>Notes</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-notes" class="field-input" placeholder="Optional note" value="${escapeHtml(vals.notes || '')}">
        </div>
      `;
    } else if (catKey === 'grounds') {
      const gType = vals.type || 'OH';
      html = `
        <div class="field-group">
          <label class="field-label" for="f-item-num">
            <span>Serial # / Ground # <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-item-num" class="field-input" placeholder="e.g., GND-552 or NA"
            value="${escapeHtml(vals.itemNum || '')}" autocapitalize="characters">
          <div class="field-hint">Not numbered? Type <strong>NA</strong> (auto-numbers NA1, NA2...)</div>
        </div>

        <div class="field-group">
          <label class="field-label"><span>Ground Type <span class="field-req">*</span></span></label>
          <input type="hidden" id="f-type" value="${escapeHtml(gType)}">
          <div class="segmented-group" data-seg-target="f-type">
            <button type="button" class="seg-btn ${gType === 'OH' ? 'active' : ''}" data-seg-val="OH">OH (Overhead)</button>
            <button type="button" class="seg-btn ${gType === 'UG' ? 'active' : ''}" data-seg-val="UG">UG (Underground)</button>
          </div>
        </div>

        <div class="field-group ${gType === 'OH' ? '' : 'hidden'}" id="grp-ground-size">
          <label class="field-label" for="f-size">
            <span>Size / Conductor (OH) <span class="field-req">*</span></span>
          </label>
          <select id="f-size" class="field-select">
            <option value="4/0" ${(vals.size || '4/0') === '4/0' ? 'selected' : ''}>4/0</option>
            <option value="2/0" ${vals.size === '2/0' ? 'selected' : ''}>2/0</option>
          </select>
        </div>

        <div class="field-group ${gType === 'UG' ? '' : 'hidden'}" id="grp-ground-kv">
          <label class="field-label" for="f-kv">
            <span>Voltage Rating (UG) <span class="field-req">*</span></span>
          </label>
          <select id="f-kv" class="field-select">
            <option value="15KV" ${(vals.kv || '15KV') === '15KV' ? 'selected' : ''}>15KV</option>
            <option value="25KV" ${vals.kv === '25KV' ? 'selected' : ''}>25KV</option>
          </select>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-length">
            <span>Length <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-length" class="field-input" placeholder="e.g., 6', 18', 20'"
            value="${escapeHtml(vals.length || (gType === 'UG' ? "6'" : ''))}">
          <div class="chip-row" data-chip-target="f-length">
            ${["6'", "10'", "16'", "18'", "20'", "25'", "30'"].map((v) => `<button type="button" class="quick-chip" data-chip-val="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join('')}
          </div>
        </div>

        ${renderDateWithNoneField('f-test-date', 'Test Date', vals.testDate)}

        <div class="field-group full-width">
          <label class="field-label" for="f-notes">
            <span>Notes</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-notes" class="field-input" placeholder="Optional note" value="${escapeHtml(vals.notes || '')}">
        </div>
      `;
    } else if (catKey === 'hot_sticks') {
      const stickTypes = ['Extendo', 'Telescopic', 'Shotgun', 'Hot Cutters', 'Universal', 'Disconnect Stick'];
      const curType = vals.type || 'Extendo';
      const isCustomType = Boolean(curType && !stickTypes.includes(curType));

      html = `
        <div class="field-group">
          <label class="field-label" for="f-item-num">
            <span>Stick # / Item # <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-item-num" class="field-input" placeholder="e.g., HS-10, TEL-04, or NA"
            value="${escapeHtml(vals.itemNum || '')}" autocapitalize="characters">
          <div class="field-hint">Not numbered? Type <strong>NA</strong> (auto-numbers NA1, NA2...)</div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-type-select">
            <span>Type <span class="field-req">*</span></span>
          </label>
          <select id="f-type-select" class="field-select">
            ${stickTypes.map((t) => `<option value="${t}" ${curType === t ? 'selected' : ''}>${t}</option>`).join('')}
            <option value="__OTHER__" ${isCustomType ? 'selected' : ''}>Other...</option>
          </select>
          <input type="text" id="f-type-custom" class="field-input ${isCustomType ? '' : 'hidden'}"
            placeholder="Enter stick type" value="${isCustomType ? escapeHtml(curType) : ''}">
        </div>

        <div class="field-group">
          <label class="field-label" for="f-length">
            <span>Length <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-length" class="field-input" placeholder="e.g., 8', 35', 40'"
            value="${escapeHtml(vals.length || '')}">
          <div class="chip-row" data-chip-target="f-length">
            ${["6'", "8'", "10'", "35'", "40'"].map((v) => `<button type="button" class="quick-chip" data-chip-val="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join('')}
          </div>
        </div>

        ${renderDateWithNoneField('f-test-date', 'Test Date', vals.testDate)}

        <div class="field-group full-width">
          <label class="field-label" for="f-notes">
            <span>Notes</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-notes" class="field-input" placeholder="Optional note" value="${escapeHtml(vals.notes || '')}">
        </div>
      `;
    } else if (catKey === 'fire_extinguishers') {
      const unitType = vals.unitType || (/^x\d+/i.test(String(vals.itemNum || '')) || /job\s*shack/i.test(String(vals.itemNum || '')) ? 'job_shack' : 'truck');
      const cond = vals.condition || 'In Service';
      const sizes = ['5 lb ABC', '10 lb ABC', '20 lb ABC'];
      const curSize = vals.size || '10 lb ABC';
      const isCustomSize = Boolean(curSize && !sizes.includes(curSize));
      const vehChips = getEnteredVehicleChips('fire_extinguishers');
      const showReason = cond !== 'In Service';
      const isMissing = cond === 'Missing';
      const jobNum = String((state.request && state.request.job_number) || '').trim();

      html = `
        <div class="field-group full-width">
          <label class="field-label"><span>Equipment / Location Type <span class="field-req">*</span></span></label>
          <input type="hidden" id="f-unit-type" value="${escapeHtml(unitType)}">
          <div class="segmented-group" data-seg-target="f-unit-type">
            <button type="button" class="seg-btn ${unitType === 'truck' ? 'active' : ''}" data-seg-val="truck">🚛 Truck / Equipment</button>
            <button type="button" class="seg-btn ${unitType === 'job_shack' ? 'active' : ''}" data-seg-val="job_shack">🏠 Job Shack (X###)</button>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="f-item-num">
            <span id="lbl-veh-num">${unitType === 'job_shack' ? 'Job Shack # (X###)' : 'Vehicle / Equipment #'} <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-item-num" class="field-input"
            placeholder="${unitType === 'job_shack' ? `e.g., X104 (or leave blank for Job Shack${jobNum ? ' ' + jobNum : ''})` : 'e.g., 2108, 1905'}"
            value="${escapeHtml(vals.itemNum || '')}" autocapitalize="characters">
          <div class="field-hint" id="hint-veh-num">${unitType === 'job_shack' ? 'Enter shack # (e.g. X104) or leave blank to tag with your Job #' : '1 fire extinguisher per truck / piece of equipment'}</div>
          ${vehChips.length > 0 ? `
            <div class="chip-row" data-veh-chips="true" style="margin-top:6px;">
              ${vehChips.map((v) => `<button type="button" class="quick-chip" data-veh-val="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join('')}
            </div>
          ` : ''}
        </div>

        <div class="field-group">
          <label class="field-label" for="f-size-select">
            <span>Extinguisher Size <span class="field-req">*</span></span>
          </label>
          <select id="f-size-select" class="field-select">
            ${sizes.map((s) => `<option value="${s}" ${curSize === s ? 'selected' : ''}>${s}</option>`).join('')}
            <option value="__OTHER__" ${isCustomSize ? 'selected' : ''}>Other...</option>
          </select>
          <input type="text" id="f-size-custom" class="field-input ${isCustomSize ? '' : 'hidden'}"
            placeholder="Enter extinguisher size/type" value="${isCustomSize ? escapeHtml(curSize) : ''}">
        </div>

        <div class="field-group full-width">
          <label class="field-label"><span>Condition / Replacement Needed <span class="field-req">*</span></span></label>
          <input type="hidden" id="f-condition" value="${escapeHtml(cond)}">
          <div class="segmented-group" data-seg-target="f-condition">
            <button type="button" class="seg-btn ok-active ${cond === 'In Service' ? 'active' : ''}" data-seg-val="In Service">✅ Good</button>
            <button type="button" class="seg-btn amber-active ${cond === 'Needs Replacement' ? 'active' : ''}" data-seg-val="Needs Replacement">🔄 Needs Replacement</button>
            <button type="button" class="seg-btn warn-active ${cond === 'Missing' ? 'active' : ''}" data-seg-val="Missing">❌ Missing</button>
          </div>
        </div>

        <div class="field-group full-width ${showReason ? '' : 'hidden'}" id="grp-fe-reason">
          <label class="field-label" for="f-reason">
            <span>Reason / Details</span>
            <span class="field-opt">Tap a reason or type below</span>
          </label>
          <input type="text" id="f-reason" class="field-input" placeholder="e.g., Expired, Discharged, Low pressure, Missing from truck"
            value="${escapeHtml(vals.reason || '')}">
          <div class="chip-row" data-chip-target="f-reason">
            ${['Expired / Past Due', 'Discharged / Used', 'Low Pressure (Red)', 'Damaged / Pin Missing', 'No Inspection Tag', 'Missing from Truck'].map((v) => `<button type="button" class="quick-chip" data-chip-val="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join('')}
          </div>
        </div>

        <div class="${isMissing ? 'hidden' : ''}" id="grp-fe-test-date" style="display:contents;">
          ${renderDateWithNoneField('f-test-date', 'Test / Inspection Date (Annual)', vals.testDate)}
        </div>

        <div class="field-group full-width">
          <label class="field-label" for="f-notes">
            <span>Notes</span>
            <span class="field-opt">Optional</span>
          </label>
          <input type="text" id="f-notes" class="field-input" placeholder="Optional note" value="${escapeHtml(vals.notes || '')}">
        </div>
      `;
    } else if (catKey === 'first_aid_kits') {
      const unitType = vals.unitType || (/^x\d+/i.test(String(vals.itemNum || '')) || /job\s*shack/i.test(String(vals.itemNum || '')) ? 'job_shack' : 'truck');
      const kitStatus = vals.condition || 'Needs Replacement';
      const vehChips = getEnteredVehicleChips('first_aid_kits');
      const jobNum = String((state.request && state.request.job_number) || '').trim();

      html = `
        <div class="field-group full-width">
          <label class="field-label"><span>Equipment / Location Type <span class="field-req">*</span></span></label>
          <input type="hidden" id="f-unit-type" value="${escapeHtml(unitType)}">
          <div class="segmented-group" data-seg-target="f-unit-type">
            <button type="button" class="seg-btn ${unitType === 'truck' ? 'active' : ''}" data-seg-val="truck">🚛 Truck / Equipment</button>
            <button type="button" class="seg-btn ${unitType === 'job_shack' ? 'active' : ''}" data-seg-val="job_shack">🏠 Job Shack (X###)</button>
          </div>
        </div>

        <div class="field-group full-width">
          <label class="field-label" for="f-item-num">
            <span id="lbl-veh-num">${unitType === 'job_shack' ? 'Job Shack # (X###)' : 'Vehicle / Equipment #'} <span class="field-req">*</span></span>
          </label>
          <input type="text" id="f-item-num" class="field-input"
            placeholder="${unitType === 'job_shack' ? `e.g., X104 (or leave blank for Job Shack${jobNum ? ' ' + jobNum : ''})` : 'e.g., 2108, 1905'}"
            value="${escapeHtml(vals.itemNum || '')}" autocapitalize="characters">
          <div class="field-hint" id="hint-veh-num">${vehChips.length > 0 ? 'Tap a truck/shack # you already entered below, or type a new one:' : 'Enter the truck # or job shack # (X###) that has or needs a 1st Aid Kit'}</div>
          ${vehChips.length > 0 ? `
            <div class="chip-row" data-veh-chips="true" style="margin-top:6px;">
              ${vehChips.map((v) => `<button type="button" class="quick-chip" data-veh-val="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join('')}
            </div>
          ` : ''}
        </div>

        <div class="field-group full-width">
          <label class="field-label"><span>1st Aid Kit Status <span class="field-req">*</span></span></label>
          <input type="hidden" id="f-condition" value="${escapeHtml(kitStatus)}">
          <div class="segmented-group multi-wrap" data-seg-target="f-condition">
            <button type="button" class="seg-btn ok-active ${kitStatus === 'Stocked / OK' ? 'active' : ''}" data-seg-val="Stocked / OK">✅ Stocked / OK</button>
            <button type="button" class="seg-btn amber-active ${kitStatus === 'Needs Restock' ? 'active' : ''}" data-seg-val="Needs Restock">🩹 Needs Restock</button>
            <button type="button" class="seg-btn warn-active ${kitStatus === 'Needs Replacement' ? 'active' : ''}" data-seg-val="Needs Replacement">🔄 Needs Replacement</button>
            <button type="button" class="seg-btn warn-active ${kitStatus === 'Missing' ? 'active' : ''}" data-seg-val="Missing">❌ Missing Kit</button>
          </div>
        </div>

        <div class="field-group full-width">
          <label class="field-label" for="f-notes">
            <span>Notes</span>
            <span class="field-opt">Optional (e.g., low bandages, broken latch)</span>
          </label>
          <input type="text" id="f-notes" class="field-input" placeholder="Optional details" value="${escapeHtml(vals.notes || '')}">
        </div>
      `;
    }

    if (isPacked) {
      const existingPackedFor = vals.packedFor ||
        (vals.employeeName && !/^(packed|ready)\s+for\s+delivery$/i.test(String(vals.employeeName).trim()) ? vals.employeeName : '');
      html = renderPackedForField(existingPackedFor) + html;
    }

    container.innerHTML = html;
    wireDynamicFieldBehaviors(catKey);
  }

  function wireDynamicFieldBehaviors(catKey) {
    // Searchable "Packed For (Employee Name)" combobox for Packed For Delivery audits
    const packedInput = document.getElementById('f-packed-for');
    const packedList = document.getElementById('f-packed-for-list');
    if (packedInput && packedList) {
      let highlightedIdx = -1;
      let currentMatches = [];

      const closeSuggest = () => {
        packedList.classList.add('hidden');
        packedInput.setAttribute('aria-expanded', 'false');
        highlightedIdx = -1;
      };

      const renderSuggest = (query) => {
        const allEmps = getPackedForEmployees();
        const q = String(query || '').trim().toLowerCase();
        if (allEmps.length === 0) {
          closeSuggest();
          return;
        }
        const starts = [];
        const contains = [];
        allEmps.forEach((name) => {
          const nl = name.toLowerCase();
          if (!q || nl.startsWith(q)) starts.push(name);
          else if (nl.includes(q)) contains.push(name);
        });
        currentMatches = [...starts, ...contains].slice(0, 25);
        highlightedIdx = -1;

        if (currentMatches.length === 0) {
          packedList.innerHTML = `<div class="emp-suggest-empty">No directory match — press Add to use "${escapeHtml(query.trim())}"</div>`;
        } else {
          packedList.innerHTML = currentMatches.map((name, idx) =>
            `<button type="button" class="emp-suggest-item" role="option" data-emp-idx="${idx}" data-emp-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`
          ).join('');
          packedList.querySelectorAll('.emp-suggest-item').forEach((btn) => {
            btn.addEventListener('mousedown', (e) => {
              e.preventDefault();
              packedInput.value = btn.dataset.empName || '';
              closeSuggest();
              document.querySelectorAll('[data-packed-chips="true"] .quick-chip').forEach((c) => {
                c.classList.toggle('selected', (c.dataset.packedVal || '').toLowerCase() === packedInput.value.toLowerCase());
              });
            });
          });
        }
        packedList.classList.remove('hidden');
        packedInput.setAttribute('aria-expanded', 'true');
      };

      packedInput.addEventListener('focus', () => renderSuggest(packedInput.value));
      packedInput.addEventListener('input', () => renderSuggest(packedInput.value));
      packedInput.addEventListener('blur', () => {
        setTimeout(closeSuggest, 140);
      });
      packedInput.addEventListener('keydown', (e) => {
        if (packedList.classList.contains('hidden')) return;
        const btns = packedList.querySelectorAll('.emp-suggest-item');
        if (e.key === 'ArrowDown' && btns.length > 0) {
          e.preventDefault();
          highlightedIdx = (highlightedIdx + 1) % btns.length;
          btns.forEach((b, i) => b.classList.toggle('highlighted', i === highlightedIdx));
          btns[highlightedIdx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp' && btns.length > 0) {
          e.preventDefault();
          highlightedIdx = highlightedIdx <= 0 ? btns.length - 1 : highlightedIdx - 1;
          btns.forEach((b, i) => b.classList.toggle('highlighted', i === highlightedIdx));
          btns[highlightedIdx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && highlightedIdx >= 0 && btns[highlightedIdx]) {
          e.preventDefault();
          packedInput.value = btns[highlightedIdx].dataset.empName || '';
          closeSuggest();
        } else if (e.key === 'Escape') {
          closeSuggest();
        }
      });

      document.querySelectorAll('[data-packed-chips="true"] .quick-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          packedInput.value = chip.dataset.packedVal || '';
          closeSuggest();
          document.querySelectorAll('[data-packed-chips="true"] .quick-chip').forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected');
        });
      });
    }

    // Custom "Other" toggles
    const togglePairs = [
      ['f-employee-select', 'f-employee-custom'],
      ['f-size-select', 'f-size-custom'],
      ['f-model-select', 'f-model-custom'],
      ['f-type-select', 'f-type-custom']
    ];
    togglePairs.forEach(([selId, customId]) => {
      const sel = document.getElementById(selId);
      const custom = document.getElementById(customId);
      if (sel && custom) {
        sel.addEventListener('change', () => {
          const isOther = sel.value === '__OTHER__';
          custom.classList.toggle('hidden', !isOther);
          if (isOther) custom.focus();
        });
      }
    });

    // Quick preset chips
    document.querySelectorAll('.chip-row').forEach((row) => {
      const targetId = row.dataset.chipTarget;
      const targetInput = document.getElementById(targetId);
      if (!targetInput) return;
      row.querySelectorAll('.quick-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          targetInput.value = chip.dataset.chipVal || '';
          row.querySelectorAll('.quick-chip').forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected');
        });
      });
    });

    // Cross-tab Vehicle / Job Shack quick chips
    document.querySelectorAll('[data-veh-chips="true"] .quick-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const vehVal = chip.dataset.vehVal || '';
        const itemInput = document.getElementById('f-item-num');
        if (itemInput) itemInput.value = vehVal;
        const unitTypeHidden = document.getElementById('f-unit-type');
        if (unitTypeHidden) {
          const isShack = /^x\d+/i.test(vehVal) || /job\s*shack/i.test(vehVal);
          const nextType = isShack ? 'job_shack' : 'truck';
          unitTypeHidden.value = nextType;
          document.querySelectorAll('[data-seg-target="f-unit-type"] .seg-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.segVal === nextType);
          });
        }
        document.querySelectorAll('[data-veh-chips="true"] .quick-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
      });
    });

    // Segmented buttons (Blanket Regular/Split, Ground OH/UG, Unit Type, Condition)
    document.querySelectorAll('.segmented-group').forEach((group) => {
      const targetId = group.dataset.segTarget;
      const hiddenInput = document.getElementById(targetId);
      if (!hiddenInput) return;
      group.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const val = btn.dataset.segVal;
          hiddenInput.value = val;
          group.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
          if (catKey === 'grounds' && targetId === 'f-type') {
            const sizeGrp = document.getElementById('grp-ground-size');
            const kvGrp = document.getElementById('grp-ground-kv');
            const lenInput = document.getElementById('f-length');
            if (sizeGrp) sizeGrp.classList.toggle('hidden', val !== 'OH');
            if (kvGrp) kvGrp.classList.toggle('hidden', val !== 'UG');
            if (lenInput && val === 'UG' && !lenInput.value.trim()) {
              lenInput.value = "6'";
            }
          }
          if ((catKey === 'fire_extinguishers' || catKey === 'first_aid_kits') && targetId === 'f-unit-type') {
            const lbl = document.getElementById('lbl-veh-num');
            const inp = document.getElementById('f-item-num');
            const jobNum = String((state.request && state.request.job_number) || '').trim();
            if (lbl) lbl.innerHTML = `${val === 'job_shack' ? 'Job Shack # (X###)' : 'Vehicle / Equipment #'} <span class="field-req">*</span>`;
            if (inp) inp.placeholder = val === 'job_shack' ? `e.g., X104 (or leave blank for Job Shack${jobNum ? ' ' + jobNum : ''})` : 'e.g., 2108, 1905';
          }
          if (catKey === 'fire_extinguishers' && targetId === 'f-condition') {
            const reasonGrp = document.getElementById('grp-fe-reason');
            const testDateGrp = document.getElementById('grp-fe-test-date');
            if (reasonGrp) reasonGrp.classList.toggle('hidden', val === 'In Service');
            if (testDateGrp) {
              testDateGrp.classList.toggle('hidden', val === 'Missing');
              testDateGrp.style.display = val === 'Missing' ? 'none' : 'contents';
            }
          }
        });
      });
    });

    // Auto-switch Unit Type toggle when foreman types X### in Vehicle #
    if (catKey === 'fire_extinguishers' || catKey === 'first_aid_kits') {
      const itemInput = document.getElementById('f-item-num');
      const unitTypeHidden = document.getElementById('f-unit-type');
      if (itemInput && unitTypeHidden) {
        itemInput.addEventListener('input', () => {
          const v = itemInput.value.trim();
          if (/^x\d+/i.test(v) || /^job\s*shack/i.test(v)) {
            unitTypeHidden.value = 'job_shack';
            document.querySelectorAll('[data-seg-target="f-unit-type"] .seg-btn').forEach((b) => {
              b.classList.toggle('active', b.dataset.segVal === 'job_shack');
            });
          }
        });
      }
    }

    // Date "None (No Sticker)" toggles
    document.querySelectorAll('.date-none-btn').forEach((btn) => {
      const targetId = btn.dataset.noneTarget;
      const dateInput = document.getElementById(targetId);
      if (!dateInput) return;
      btn.addEventListener('click', () => {
        const nextActive = !btn.classList.contains('active');
        btn.classList.toggle('active', nextActive);
        btn.setAttribute('aria-pressed', nextActive ? 'true' : 'false');
        btn.textContent = nextActive
          ? '⚠️ None — No Sticker (Needs Changeout)'
          : '🚫 None (No Sticker / Missing Date)';
        if (nextActive) {
          dateInput.value = '';
          dateInput.disabled = true;
          dateInput.classList.add('date-disabled');
        } else {
          dateInput.disabled = false;
          dateInput.classList.remove('date-disabled');
          dateInput.focus();
        }
      });
    });

    // Blanket prefix auto-detect (B -> Regular, S -> Split)
    if (catKey === 'blankets') {
      const itemInput = document.getElementById('f-item-num');
      const typeHidden = document.getElementById('f-type');
      if (itemInput && typeHidden) {
        itemInput.addEventListener('input', () => {
          const v = itemInput.value.trim().toUpperCase();
          let detected = null;
          if (v.startsWith('S')) detected = 'Split';
          else if (v.startsWith('B')) detected = 'Regular';
          if (detected) {
            typeHidden.value = detected;
            document.querySelectorAll('[data-seg-target="f-type"] .seg-btn').forEach((b) => {
              b.classList.toggle('active', b.dataset.segVal === detected);
            });
          }
        });
      }
    }
  }

  function readAndValidateEntry(catKey) {
    const val = (id) => {
      const el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    };
    const readDateOrNone = (id) => {
      const noneBtn = document.querySelector(`.date-none-btn[data-none-target="${id}"]`);
      if (noneBtn && noneBtn.classList.contains('active')) return 'None';
      return val(id);
    };

    const isVehicleBased = (catKey === 'fire_extinguishers' || catKey === 'first_aid_kits');
    let itemNum = val('f-item-num');
    let unitType = isVehicleBased ? (val('f-unit-type') || 'truck') : '';
    if (isVehicleBased) {
      if (!itemNum && unitType === 'job_shack') {
        itemNum = normalizeVehicleEntry('', 'job_shack');
      } else if (!itemNum) {
        return { error: 'Please enter the Truck / Equipment # (or select Job Shack).' };
      } else {
        itemNum = normalizeVehicleEntry(itemNum, unitType);
      }
    } else if (!itemNum) {
      return { error: `Please enter the ${CATEGORY_MAP[catKey].idLabel} (or type NA if unnumbered).` };
    }

    // Auto-number plain NA / N/A / na / n/a into NA1, NA2, NA3... if the foreman didn't add a digit
    let autoNumberedFrom = '';
    if (!isVehicleBased && isBareUnnumberedNA(itemNum)) {
      autoNumberedFrom = itemNum;
      itemNum = getNextAutoNAId(catKey, state.editingId);
    }

    // Check duplicate in current category (unless editing that exact entry)
    const existingList = state.draft.items[catKey] || [];
    const normKey = (s) => String(s || '').trim().replace(/\s+/g, '').toLowerCase();
    const dup = existingList.find((it) =>
      it.id !== state.editingId &&
      normKey(it.itemNum) === normKey(itemNum)
    );
    if (dup) {
      const isNAEntry = !isVehicleBased && extractUnnumberedNAIndex(itemNum) !== null;
      return {
        error: isVehicleBased
          ? `Vehicle / Shack "${itemNum}" is already in your ${CATEGORY_MAP[catKey].label} list. Edit the existing entry instead.`
          : (isNAEntry
            ? `Item "${itemNum}" is already in your ${CATEGORY_MAP[catKey].label} list. Enter the next number or just type NA to auto-number.`
            : `Item "${itemNum}" is already in your ${CATEGORY_MAP[catKey].label} list. Edit the existing entry instead.`)
      };
    }

    const entry = {
      id: state.editingId || generateLocalId(),
      itemNum,
      notes: val('f-notes')
    };

    if (isPackedForDeliveryAudit()) {
      const packedFor = val('f-packed-for');
      if (!packedFor) {
        return { error: 'Please enter who this item is packed for (Employee Name).' };
      }
      entry.packedFor = packedFor;
    }

    if (catKey === 'gloves' || catKey === 'sleeves') {
      let employeeName = '';
      if (isPackedForDeliveryAudit()) {
        employeeName = entry.packedFor;
      } else if (isShopStatusAudit()) {
        employeeName = (state.request && state.request.foreman_name) || 'On Shelf';
      } else {
        const empSel = val('f-employee-select');
        employeeName = empSel === '__OTHER__' ? val('f-employee-custom') : empSel;
        if (!employeeName) return { error: 'Please select or enter the assigned employee name.' };
      }
      const sizeSel = val('f-size-select');
      const size = sizeSel === '__OTHER__' ? val('f-size-custom') : sizeSel;
      if (!size) return { error: 'Please select or enter the size.' };
      const itemClass = val('f-class');
      if (!itemClass) return { error: 'Please select the voltage class.' };
      const testDate = readDateOrNone('f-test-date');
      if (!testDate) return { error: 'Please enter the test date or tap "None (No Sticker)".' };

      entry.employeeName = employeeName;
      entry.eslId = val('f-esl-id');
      entry.size = size;
      entry.itemClass = itemClass;
      entry.testDate = testDate;
    } else if (catKey === 'blankets') {
      const bType = val('f-type') || 'Regular';
      const itemClass = val('f-class') || '4';
      const testDate = readDateOrNone('f-test-date');
      if (!testDate) return { error: 'Please enter the blanket test date or tap "None (No Sticker)".' };
      entry.type = bType;
      entry.itemClass = itemClass;
      entry.testDate = testDate;
    } else if (catKey === 'macks') {
      const kv = val('f-kv');
      const size = val('f-size');
      const length = val('f-length');
      const testDate = readDateOrNone('f-test-date');
      if (!kv) return { error: 'Please enter the kV rating.' };
      if (!size) return { error: 'Please enter the conductor size.' };
      if (!length) return { error: 'Please enter the length.' };
      if (!testDate) return { error: 'Please enter the test date or tap "None (No Sticker)".' };
      entry.kv = kv;
      entry.size = size;
      entry.length = length;
      entry.testDate = testDate;
    } else if (catKey === 'hv_testers' || catKey === 'phasing_sets') {
      const modelSel = val('f-model-select');
      const model = modelSel === '__OTHER__' ? val('f-model-custom') : modelSel;
      const calibrationDate = readDateOrNone('f-cal-date');
      if (!calibrationDate) return { error: 'Please enter the calibration date or tap "None (No Sticker)".' };
      entry.model = model;
      entry.kv = val('f-kv');
      entry.serialNum = val('f-serial-num');
      entry.calibrationDate = calibrationDate;
    } else if (catKey === 'aed') {
      const modelSel = val('f-model-select');
      const model = modelSel === '__OTHER__' ? val('f-model-custom') : modelSel;
      const padExpiration = val('f-pad-exp');
      if (!padExpiration) return { error: 'Please enter the AED pad expiration date.' };
      entry.model = model;
      entry.serialNum = val('f-serial-num');
      entry.padExpiration = padExpiration;
      entry.batteryExpiration = val('f-bat-exp');
    } else if (catKey === 'grounds') {
      const gType = val('f-type') || 'OH';
      const length = val('f-length');
      const testDate = readDateOrNone('f-test-date');
      if (!length) return { error: 'Please enter the ground set length.' };
      if (!testDate) return { error: 'Please enter the test date or tap "None (No Sticker)".' };
      entry.type = gType;
      entry.size = gType === 'OH' ? val('f-size') : '';
      entry.kv = gType === 'UG' ? val('f-kv') : '';
      entry.length = length;
      entry.testDate = testDate;
    } else if (catKey === 'hot_sticks') {
      const typeSel = val('f-type-select');
      const type = typeSel === '__OTHER__' ? val('f-type-custom') : typeSel;
      const length = val('f-length');
      const testDate = readDateOrNone('f-test-date');
      if (!type) return { error: 'Please select or enter the hot stick type.' };
      if (!length) return { error: 'Please enter the hot stick length.' };
      if (!testDate) return { error: 'Please enter the test date or tap "None (No Sticker)".' };
      entry.type = type;
      entry.length = length;
      entry.testDate = testDate;
    } else if (catKey === 'fire_extinguishers') {
      const sizeSel = val('f-size-select');
      const size = sizeSel === '__OTHER__' ? val('f-size-custom') : sizeSel;
      if (!size) return { error: 'Please select or enter the extinguisher size.' };
      const condition = val('f-condition') || 'In Service';
      const reason = val('f-reason');
      let testDate = '';
      if (condition !== 'Missing') {
        testDate = readDateOrNone('f-test-date');
        if (!testDate) return { error: 'Please enter the annual test date or tap "None (No Sticker)".' };
      } else {
        testDate = 'None';
      }
      entry.unitType = unitType;
      entry.size = size;
      entry.condition = condition;
      entry.needsReplacement = (condition !== 'In Service');
      entry.reason = condition !== 'In Service' ? (reason || (condition === 'Missing' ? 'Missing from vehicle' : 'Needs replacement')) : '';
      entry.testDate = testDate;
    } else if (catKey === 'first_aid_kits') {
      const condition = val('f-condition') || 'Needs Replacement';
      entry.unitType = unitType;
      entry.condition = condition;
      entry.needsReplacement = (condition !== 'Stocked / OK');
    }

    return { entry, autoNumberedFrom };
  }

  function showValidationMsg(msg) {
    const el = document.getElementById('form-validation-msg');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function hideValidationMsg() {
    const el = document.getElementById('form-validation-msg');
    if (el) el.classList.add('hidden');
  }

  function handleSaveEntry(keepSpecs = false) {
    const catKey = state.activeCategory;
    const { entry, error, autoNumberedFrom } = readAndValidateEntry(catKey);
    if (error) {
      showValidationMsg(error);
      return;
    }
    hideValidationMsg();

    const list = state.draft.items[catKey];
    if (state.editingId) {
      const idx = list.findIndex((i) => i.id === state.editingId);
      if (idx !== -1) list[idx] = entry;
      state.editingId = null;
      showToast(autoNumberedFrom ? `Auto-numbered as ${entry.itemNum} & updated` : `Updated ${entry.itemNum}`, 'success');
    } else {
      list.unshift(entry);
      state.draft.noneConfirmed[catKey] = false;
      showToast(autoNumberedFrom ? `Auto-numbered as ${entry.itemNum} & added` : `Added ${entry.itemNum}`, 'success');
    }

    markDraftModified();

    let nextPrefill = null;
    if (keepSpecs) {
      nextPrefill = { ...entry };
      delete nextPrefill.id;
      nextPrefill.itemNum = '';
      if (nextPrefill.eslId) nextPrefill.eslId = '';
      if (nextPrefill.serialNum) nextPrefill.serialNum = '';
      if (nextPrefill.reason) nextPrefill.reason = '';
      nextPrefill.notes = '';
    }

    renderActiveCategory(nextPrefill);

    const itemInput = document.getElementById('f-item-num');
    if (itemInput) itemInput.focus();
  }

  // ---------------------------------------------------------------------------
  // Render Logged Items List
  // ---------------------------------------------------------------------------
  function buildItemSpecPills(catKey, it) {
    const pills = [];
    const pushDatePill = (prefix, rawVal) => {
      if (!rawVal) return;
      if (isMissingDateValue(rawVal)) {
        pills.push({ text: `⚠️ ${prefix}: None (Needs Changeout)`, warn: true });
      } else {
        pills.push({ text: `${prefix} ${formatDisplayDate(rawVal)}`, warn: false });
      }
    };
    const pushStd = (text) => pills.push({ text, warn: false });
    const pushWarn = (text) => pills.push({ text, warn: true });
    const pushOk = (text) => pills.push({ text, ok: true });

    if (catKey === 'gloves' || catKey === 'sleeves') {
      if (it.eslId) pushStd(`ESL: ${it.eslId}`);
      if (it.size) pushStd(`Size ${it.size}`);
      if (it.itemClass !== undefined && it.itemClass !== null && String(it.itemClass).trim() !== '') pushStd(`Class ${it.itemClass}`);
      pushDatePill('Tested', it.testDate);
    } else if (catKey === 'blankets') {
      if (it.type) pushStd(it.type);
      if (it.itemClass) pushStd(`Class ${it.itemClass}`);
      pushDatePill('Tested', it.testDate);
    } else if (catKey === 'macks') {
      if (it.kv) pushStd(it.kv);
      if (it.size) pushStd(it.size);
      if (it.length) pushStd(it.length);
      pushDatePill('Tested', it.testDate);
    } else if (catKey === 'hv_testers' || catKey === 'phasing_sets') {
      if (it.model) pushStd(it.model);
      if (it.kv) pushStd(`${it.kv}${String(it.kv).toUpperCase().includes('KV') ? '' : ' kV'}`);
      if (it.serialNum) pushStd(`S/N: ${it.serialNum}`);
      pushDatePill('Cal', it.calibrationDate);
    } else if (catKey === 'aed') {
      if (it.model) pushStd(it.model);
      if (it.serialNum) pushStd(`S/N: ${it.serialNum}`);
      if (it.padExpiration) pushStd(`Pads Exp ${formatDisplayDate(it.padExpiration)}`);
      if (it.batteryExpiration) pushStd(`Battery Exp ${formatDisplayDate(it.batteryExpiration)}`);
    } else if (catKey === 'grounds') {
      if (it.type) pushStd(it.type);
      if (it.type === 'OH' && it.size) pushStd(it.size);
      if (it.type === 'UG' && it.kv) pushStd(it.kv);
      if (it.length) pushStd(it.length);
      pushDatePill('Tested', it.testDate);
    } else if (catKey === 'hot_sticks') {
      if (it.type) pushStd(it.type);
      if (it.length) pushStd(it.length);
      pushDatePill('Tested', it.testDate);
    } else if (catKey === 'fire_extinguishers') {
      if (it.unitType === 'job_shack') pushStd('🏠 Job Shack');
      if (it.size) pushStd(it.size);
      if (it.condition && it.condition !== 'In Service') {
        pushWarn(`🚨 ${it.condition}${it.reason ? `: ${it.reason}` : ''}`);
      } else {
        pushOk('✅ Good');
      }
      if (it.condition !== 'Missing') pushDatePill('Tested', it.testDate);
    } else if (catKey === 'first_aid_kits') {
      if (it.unitType === 'job_shack') pushStd('🏠 Job Shack');
      if (it.condition && it.condition !== 'Stocked / OK') {
        pushWarn(`🚨 ${it.condition}`);
      } else {
        pushOk('✅ Stocked / OK');
      }
    }
    return pills;
  }

  function renderItemCard(catKey, it) {
    const pills = buildItemSpecPills(catKey, it)
      .map((p) => `<span class="spec-pill${p.warn ? ' warn' : (p.ok ? ' ok' : '')}">${escapeHtml(p.text)}</span>`)
      .join('');
    const titlePrefix = (catKey === 'fire_extinguishers' || catKey === 'first_aid_kits')
      ? (/^job\s*shack/i.test(String(it.itemNum || '')) ? '🏠 ' : '🚛 Unit ')
      : '#';
    return `
      <div class="item-card" data-item-id="${escapeHtml(it.id)}">
        <div class="item-card-main">
          <div class="item-card-title">${titlePrefix}${escapeHtml(it.itemNum)}</div>
          <div class="item-card-specs">${pills}</div>
          ${it.notes ? `<div class="item-card-notes">Note: ${escapeHtml(it.notes)}</div>` : ''}
        </div>
        <div class="item-card-actions">
          <button type="button" class="btn btn-outline btn-sm" data-action="edit" data-id="${escapeHtml(it.id)}">Edit</button>
          <button type="button" class="btn btn-danger-outline btn-sm" data-action="delete" data-id="${escapeHtml(it.id)}">Remove</button>
        </div>
      </div>
    `;
  }

  function renderItemsList() {
    const catKey = state.activeCategory;
    const cat = CATEGORY_MAP[catKey];
    const items = state.draft.items[catKey] || [];
    const listEl = document.getElementById('items-list');
    const headEl = document.getElementById('items-list-heading');
    const hintEl = document.getElementById('items-hint');

    headEl.textContent = `Logged ${cat.label} (${items.length})`;
    hintEl.textContent = items.length > 0 ? 'Tap Edit to fix any entry' : '';

    if (items.length === 0) {
      if (state.draft.noneConfirmed[catKey]) {
        const msg = catKey === 'first_aid_kits'
          ? '✓ Marked as "All Trucks & Shacks Stocked (None Needed)".'
          : `✓ Marked as "${isShopStatusAudit() ? 'None in Pool' : 'None on Crew'}" for ${escapeHtml(cat.label)}.`;
        listEl.innerHTML = `<div class="empty-list confirmed-none">${msg}</div>`;
      } else {
        const emptyHint = catKey === 'first_aid_kits'
          ? 'No 1st Aid Kit entries yet. Add any truck/shack needing a kit or check "All Trucks & Shacks Stocked" above.'
          : `No ${escapeHtml(cat.label.toLowerCase())} entered yet. Add items above or check "${isShopStatusAudit() ? 'None in Pool' : 'None on Crew'}".`;
        listEl.innerHTML = `<div class="empty-list">${emptyHint}</div>`;
      }
      return;
    }

    let html = '';
    if (isPackedForDeliveryAudit()) {
      const grouped = new Map();
      items.forEach((it) => {
        const emp = it.packedFor || it.employeeName || 'Unassigned';
        if (!grouped.has(emp)) grouped.set(emp, []);
        grouped.get(emp).push(it);
      });
      grouped.forEach((empItems, empName) => {
        html += `<div class="emp-group-header">🚚 Packed For: ${escapeHtml(empName)} (${empItems.length})</div>`;
        html += empItems.map((it) => renderItemCard(catKey, it)).join('');
      });
    } else if (cat.hasEmployee && !isShopStatusAudit()) {
      const grouped = new Map();
      items.forEach((it) => {
        const emp = it.employeeName || 'Unassigned';
        if (!grouped.has(emp)) grouped.set(emp, []);
        grouped.get(emp).push(it);
      });
      grouped.forEach((empItems, empName) => {
        html += `<div class="emp-group-header">👤 ${escapeHtml(empName)} (${empItems.length})</div>`;
        html += empItems.map((it) => renderItemCard(catKey, it)).join('');
      });
    } else {
      html = items.map((it) => renderItemCard(catKey, it)).join('');
    }

    listEl.innerHTML = html;

    listEl.querySelectorAll('[data-action="edit"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.editingId = btn.dataset.id;
        renderActiveCategory();
        document.getElementById('item-entry-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    listEl.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const target = items.find((i) => i.id === id);
        if (!target) return;
        if (!window.confirm(`Remove ${cat.shortLabel} #${target.itemNum}?`)) return;
        state.draft.items[catKey] = items.filter((i) => i.id !== id);
        if (state.editingId === id) state.editingId = null;
        markDraftModified();
        renderActiveCategory();
        showToast(`Removed ${target.itemNum}`);
      });
    });
  }

  function updateTotalCounter() {
    const total = getTotalItemCount();
    const el = document.getElementById('total-count-label');
    if (el) el.textContent = `${total} ${total === 1 ? 'item' : 'items'} entered`;
  }

  // ---------------------------------------------------------------------------
  // Review & Submit Modal
  // ---------------------------------------------------------------------------
  function openReviewModal() {
    const modal = document.getElementById('review-modal');
    const body = document.getElementById('review-modal-body');
    if (!modal || !body) return;

    const visibleCats = getVisibleCategories();
    const total = visibleCats.reduce((sum, c) => sum + ((state.draft.items[c.key] || []).length), 0);
    const uncheckedEmpty = visibleCats.filter((c) =>
      (state.draft.items[c.key] || []).length === 0 && !state.draft.noneConfirmed[c.key]
    );

    const rowsHtml = visibleCats.map((c) => {
      const cnt = (state.draft.items[c.key] || []).length;
      const isNone = state.draft.noneConfirmed[c.key] && cnt === 0;
      const badgeCls = cnt > 0 ? 'ok' : (isNone ? 'none' : 'empty');
      const badgeTxt = cnt > 0 ? `${cnt} logged` : (isNone ? (c.key === 'first_aid_kits' ? 'All Stocked ✓' : 'None ✓') : '0 logged');
      return `
        <div class="review-row ${cnt === 0 && !isNone ? 'warn' : ''}">
          <span>${c.icon} ${escapeHtml(c.label)}</span>
          <span class="review-badge ${badgeCls}">${badgeTxt}</span>
        </div>
      `;
    }).join('');

    const isShop = isShopStatusAudit();
    const defaultSubmitter = state.draft.submittedByName || (isShop ? '' : (state.request?.foreman_name || ''));

    body.innerHTML = `
      <p style="margin:0 0 10px 0;color:#475569;font-size:14.5px;">
        Confirm your counts below before submitting. Total items entered: <strong>${total}</strong>.
      </p>
      ${uncheckedEmpty.length > 0 ? `
        <div class="review-warning-box">
          <strong>Heads up:</strong> ${uncheckedEmpty.map((c) => c.label).join(', ')} currently show 0 items and aren't marked "${isShop ? 'None in Pool' : 'None on Crew'}". You can still submit if there are none.
        </div>
      ` : ''}
      <div class="review-grid">${rowsHtml}</div>
      <div class="field-group">
        <label class="field-label" for="f-submitted-by">
          <span>Your Name (Submitted By)</span>
        </label>
        <input type="text" id="f-submitted-by" class="field-input" value="${escapeHtml(defaultSubmitter)}" placeholder="${isShop ? 'Auditor Name (e.g., Cody Bechdol)' : 'Foreman / Submitter Name'}">
      </div>
      ${!navigator.onLine ? `
        <div class="review-warning-box" style="margin-top:12px;margin-bottom:0;">
          <strong>Offline Mode:</strong> Tapping Submit will lock and queue your audit on this device and transmit automatically once cell/Wi-Fi reception returns.
        </div>
      ` : ''}
    `;

    modal.classList.remove('hidden');
  }

  function closeReviewModal() {
    const modal = document.getElementById('review-modal');
    if (modal) modal.classList.add('hidden');
  }

  async function confirmSubmitAudit() {
    const submitBtn = document.getElementById('btn-confirm-submit');
    const submittedBy = (document.getElementById('f-submitted-by')?.value || state.request?.foreman_name || '').trim();
    state.draft.submittedByName = submittedBy;
    saveLocalCache();

    if (state.isDemo) {
      closeReviewModal();
      showSubmittedScreen(new Date().toISOString(), submittedBy || 'Demo Foreman', state.draft);
      return;
    }

    if (!navigator.onLine) {
      state.pendingSubmit = { submittedBy, queuedAt: new Date().toISOString() };
      saveLocalCache();
      closeReviewModal();
      updateSyncUI();
      showToast('Audit queued! It will submit automatically once back online.', 'warning');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      const res = await callRpc('submit_audit', {
        p_token: state.token,
        p_payload: state.draft,
        p_item_count: getTotalItemCount(),
        p_submitted_by: submittedBy,
        p_device: getDeviceLabel()
      });

      if (res && res.ok) {
        state.locked = true;
        state.hasUnsyncedChanges = false;
        state.pendingSubmit = null;
        saveLocalCache();
        closeReviewModal();
        showSubmittedScreen(res.submitted_at || new Date().toISOString(), submittedBy, state.draft);
      } else {
        showToast((res && res.error) || 'Could not submit audit. Please try again.', 'error');
      }
    } catch (err) {
      console.error('Submit audit failed:', err);
      state.pendingSubmit = { submittedBy, queuedAt: new Date().toISOString() };
      saveLocalCache();
      closeReviewModal();
      updateSyncUI();
      showToast('Connection lost — submission queued and will retry automatically.', 'warning');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Equipment Audit';
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization & Bootstrapping
  // ---------------------------------------------------------------------------
  function populateHeader() {
    const req = state.request || {};
    const isShop = isShopStatusAudit();
    document.getElementById('hdr-campaign').textContent = (req.campaign_name || (isShop ? 'Shop Equipment Inventory Audit' : 'Crew Equipment Inventory Audit')).toUpperCase();
    if (isShop) {
      document.getElementById('hdr-foreman').textContent = `📦 ${req.foreman_name || 'Shop Stock'} — Inventory Audit`;
    } else {
      document.getElementById('hdr-foreman').textContent = req.foreman_name ? `${req.foreman_name} — Equipment Audit` : 'Crew Equipment Audit';
    }

    const chips = [];
    if (isShop) {
      chips.push('📦 Shop / Warehouse Pool');
    } else if (req.job_number) {
      chips.push(`📋 Job ${req.job_number}`);
    }
    if (req.job_name) chips.push(req.job_name);
    if (req.location) chips.push(`📍 ${req.location}`);
    if (req.expires_at) chips.push(`⏳ Due ${formatDisplayDate(String(req.expires_at).slice(0, 10))}`);

    document.getElementById('hdr-meta').innerHTML = chips
      .map((c) => `<span class="meta-chip">${escapeHtml(c)}</span>`)
      .join('');
  }

  function openAuditWorkspace() {
    document.getElementById('state-screen').classList.add('hidden');
    document.getElementById('audit-shell').classList.remove('hidden');
    populateHeader();
    renderActiveCategory();
    updateSyncUI();
  }

  function wireGlobalEvents() {
    document.getElementById('item-entry-form').addEventListener('submit', (e) => {
      e.preventDefault();
      handleSaveEntry(false);
    });

    document.getElementById('btn-save-similar').addEventListener('click', () => {
      handleSaveEntry(true);
    });

    document.getElementById('btn-cancel-edit').addEventListener('click', () => {
      state.editingId = null;
      renderActiveCategory();
    });

    document.getElementById('cat-none-checkbox').addEventListener('change', (e) => {
      const catKey = state.activeCategory;
      if ((state.draft.items[catKey] || []).length > 0) {
        e.target.checked = false;
        return;
      }
      state.draft.noneConfirmed[catKey] = e.target.checked;
      markDraftModified();
      renderActiveCategory();
    });

    document.getElementById('btn-save-draft').addEventListener('click', () => {
      syncDraftToCloud(true);
    });

    document.getElementById('btn-open-review').addEventListener('click', openReviewModal);
    document.getElementById('btn-close-review').addEventListener('click', closeReviewModal);
    document.getElementById('btn-cancel-review').addEventListener('click', closeReviewModal);
    document.getElementById('btn-confirm-submit').addEventListener('click', confirmSubmitAudit);

    document.getElementById('review-modal').addEventListener('click', (e) => {
      if (e.target && e.target.id === 'review-modal') closeReviewModal();
    });

    window.addEventListener('online', () => {
      updateSyncUI();
      if (state.pendingSubmit) {
        flushPendingSubmitIfOnline();
      } else if (state.hasUnsyncedChanges && !state.locked) {
        syncDraftToCloud(false).then((ok) => {
          if (ok) showToast('Back online — saved draft synced!', 'success');
        });
      }
    });

    window.addEventListener('offline', () => {
      updateSyncUI();
      showToast('Offline mode active — entries save safely on device', 'warning');
    });
  }

  async function init() {
    // Register Service Worker for offline field use
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    wireGlobalEvents();

    const params = new URLSearchParams(window.location.search);
    const token = (params.get('t') || params.get('token') || '').trim();
    const isDemo = params.get('demo') === '1';

    if (isDemo) {
      state.isDemo = true;
      state.token = 'demo_preview';
      state.request = {
        campaign_name: 'Crew Equipment Inventory Audit (Preview)',
        foreman_name: 'Sample Foreman',
        job_number: '123-26',
        job_name: 'Sample Distribution Crew',
        location: 'Helena',
        crew_employees: ['Sample Foreman', 'Alex Miller', 'Jordan Reed', 'Taylor Brooks'],
        status: 'sent',
        expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
        notes: 'Please enter all rubber and line equipment currently on your crew trucks.'
      };
      const cached = loadLocalCache();
      if (cached.draftEnvelope && cached.draftEnvelope.draft) {
        state.draft = normalizeDraft(cached.draftEnvelope.draft);
      }
      openAuditWorkspace();
      return;
    }

    if (!token) {
      showStateScreen(
        '📋',
        'Personal Audit Link Required',
        'Please open the unique equipment audit link sent to you via text message or email from Safety.'
      );
      return;
    }

    state.token = token;
    const { draftEnvelope, metaEnvelope } = loadLocalCache();

    // Try loading live audit request from Supabase via token-locked RPC
    let serverRes = null;
    if (navigator.onLine) {
      try {
        serverRes = await callRpc('get_audit_by_token', { p_token: token });
      } catch (err) {
        console.warn('Could not reach server; checking local offline cache:', err);
      }
    }

    if (!serverRes) {
      // Offline fallback using previously cached session
      if (metaEnvelope && metaEnvelope.request) {
        state.request = metaEnvelope.request;
        state.locked = Boolean(metaEnvelope.locked);
        state.expired = Boolean(metaEnvelope.expired);
        state.submission = metaEnvelope.submission || null;
        if (draftEnvelope && draftEnvelope.draft) {
          state.draft = normalizeDraft(draftEnvelope.draft);
          state.localUpdatedAt = draftEnvelope.localUpdatedAt || 0;
          state.hasUnsyncedChanges = Boolean(draftEnvelope.hasUnsyncedChanges);
          state.pendingSubmit = draftEnvelope.pendingSubmit || null;
        }
        if (state.locked && !state.expired) {
          showSubmittedScreen(state.submission?.submitted_at, state.submission?.submitted_by_name, state.submission?.submitted_payload || state.draft);
        } else if (state.expired) {
          showStateScreen('⏳', 'Audit Link Expired', 'This equipment audit link has expired. Please contact Safety for a fresh link.');
        } else {
          openAuditWorkspace();
        }
        return;
      }

      showStateScreen(
        '📡',
        'No Internet Connection',
        'Please open this link once while connected to cell service or Wi-Fi so the form can load your crew details. After it opens once, you can fill it out offline.'
      );
      return;
    }

    if (!serverRes.ok) {
      showStateScreen('⚠️', 'Unable to Open Audit Link', serverRes.error || 'This link is invalid or no longer active.');
      return;
    }

    state.request = serverRes.request;
    state.submission = serverRes.submission || null;
    state.locked = Boolean(serverRes.locked);
    state.expired = Boolean(serverRes.expired);

    if (state.expired) {
      saveLocalCache();
      showStateScreen('⏳', 'Audit Link Expired', 'This equipment audit link has expired. Please contact Safety if you need it extended.');
      return;
    }

    if (state.locked) {
      saveLocalCache();
      showSubmittedScreen(
        state.submission?.submitted_at,
        state.submission?.submitted_by_name,
        state.submission?.submitted_payload || state.submission?.draft_payload
      );
      return;
    }

    // Merge server draft vs local offline draft (keep whichever is newer!)
    const serverDraftRaw = state.submission?.draft_payload || null;
    const serverSavedMs = state.submission?.draft_saved_at ? new Date(state.submission.draft_saved_at).getTime() : 0;
    const localSavedMs = (draftEnvelope && draftEnvelope.localUpdatedAt) ? Number(draftEnvelope.localUpdatedAt) : 0;

    if (draftEnvelope && draftEnvelope.draft && localSavedMs > serverSavedMs) {
      state.draft = normalizeDraft(draftEnvelope.draft);
      state.localUpdatedAt = localSavedMs;
      state.hasUnsyncedChanges = true;
      state.pendingSubmit = draftEnvelope.pendingSubmit || null;
      state.cloudSavedAt = state.submission?.draft_saved_at || null;
    } else if (serverDraftRaw && Object.keys(serverDraftRaw).length > 0) {
      state.draft = normalizeDraft(serverDraftRaw);
      state.localUpdatedAt = serverSavedMs || Date.now();
      state.cloudSavedAt = state.submission?.draft_saved_at || null;
      state.hasUnsyncedChanges = false;
    } else if (draftEnvelope && draftEnvelope.draft) {
      state.draft = normalizeDraft(draftEnvelope.draft);
      state.localUpdatedAt = localSavedMs || Date.now();
      state.hasUnsyncedChanges = Boolean(draftEnvelope.hasUnsyncedChanges);
      state.pendingSubmit = draftEnvelope.pendingSubmit || null;
    }

    saveLocalCache();
    openAuditWorkspace();

    if (state.pendingSubmit && navigator.onLine) {
      flushPendingSubmitIfOnline();
    } else if (state.hasUnsyncedChanges && navigator.onLine) {
      syncDraftToCloud(false);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
