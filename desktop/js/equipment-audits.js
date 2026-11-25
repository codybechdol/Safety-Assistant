/**
 * EquipmentAuditsEngine — Foreman Equipment Inventory Audits, Side-by-Side Reconciliation & Archive
 *
 * Connects the Safety Assistant Desktop App to the standalone Cloudflare Pages foreman form
 * via Supabase (`sa_audit_requests` & `sa_audit_submissions`).
 */

class EquipmentAuditsEngine {
  constructor(db) {
    this.db = db;
    this.activeTab = 'manage'; // 'manage' | 'review' | 'archive'
    this.requests = [];
    this.submissionsByReqId = new Map();
    this.selectedRequestIds = new Set();
    this.activeReviewRequestId = null;
    this.reviewBucketFilter = 'actionable'; // 'actionable' | 'all' | 'discrepancy' | 'wrong_crew' | 'missing' | 'new_item' | 'matched'
    this.reviewCategoryFilter = 'all';
    this.searchQuery = '';
    this.campaignFilter = 'all';
    this.statusFilter = 'all';
    this.archiveSearch = '';
    this.archiveViewingId = null;
    this.schemaMissing = false;
    this.isLoading = false;
    this.lastError = null;
    this._pollTimer = null;

    this.CATEGORIES = [
      { key: 'gloves', label: 'Gloves', icon: '🧤', sheetName: 'Gloves', isPersonal: true },
      { key: 'sleeves', label: 'Sleeves', icon: '🦺', sheetName: 'Sleeves', isPersonal: true },
      { key: 'blankets', label: 'Blankets', icon: '🧱', sheetName: 'Blankets', isPersonal: false },
      { key: 'macks', label: 'MACKs', icon: '🔌', sheetName: 'MACKs', isPersonal: false },
      { key: 'hv_testers', label: 'HV Testers', icon: '⚡', sheetName: 'HV Testers', isPersonal: false },
      { key: 'phasing_sets', label: 'Phasing Sets', icon: '⚡', sheetName: 'Phasing Sets', isPersonal: false },
      { key: 'aed', label: 'AED', icon: '🏥', sheetName: 'AED', isPersonal: false },
      { key: 'grounds', label: 'Grounds', icon: '⚡', sheetName: 'Grounds', isPersonal: false },
      { key: 'hot_sticks', label: 'Hot Sticks', icon: '🔴', sheetName: 'Hot Sticks', isPersonal: false },
      { key: 'fire_extinguishers', label: 'Fire Extinguishers', icon: '🧯', sheetName: 'Fire Extinguishers', isPersonal: false, isVehicleBased: true, fieldOnly: true },
      { key: 'first_aid_kits', label: 'First Aid Kits', icon: '🩹', sheetName: 'First Aid Kits', isPersonal: false, isVehicleBased: true, fieldOnly: true }
    ];

    this.SHOP_STATUS_POOLS = [
      {
        jobNumber: 'SHOP-ON-SHELF',
        name: 'On Shelf',
        icon: '📦',
        jobName: 'Helena Shop — Available Stock',
        location: 'Helena',
        canonicalStatus: 'On Shelf',
        canonicalAssignedTo: 'On Shelf',
        matchStatuses: ['on shelf'],
        matchAssignedTo: ['on shelf']
      },
      {
        jobNumber: 'SHOP-IN-TESTING',
        name: 'In Testing',
        icon: '🔬',
        jobName: 'Testing Lab — Out for Dielectric Test',
        location: 'Helena',
        canonicalStatus: 'In Testing',
        canonicalAssignedTo: 'In Testing',
        matchStatuses: ['in testing'],
        matchAssignedTo: ['in testing']
      },
      {
        jobNumber: 'SHOP-PACKED-DELIVERY',
        name: 'Packed For Delivery',
        icon: '🚚',
        jobName: "Cody's Truck / Shop — Ready For Delivery",
        location: "Cody's Truck",
        canonicalStatus: 'Ready For Delivery',
        canonicalAssignedTo: 'Packed For Delivery',
        matchStatuses: ['ready for delivery', 'packed for delivery'],
        matchAssignedTo: ['packed for delivery', 'ready for delivery']
      },
      {
        jobNumber: 'SHOP-PACKED-TESTING',
        name: 'Packed For Testing',
        icon: '🧪',
        jobName: 'Helena Shop — Ready For Test',
        location: 'Helena',
        canonicalStatus: 'Ready For Test',
        canonicalAssignedTo: 'Packed For Testing',
        matchStatuses: ['ready for test', 'packed for testing'],
        matchAssignedTo: ['packed for testing', 'ready for test']
      }
    ];
  }

  getShopAuditPoolConfig(req) {
    if (!req) return null;
    const jn = String(req.job_number || req.jobNumber || '').trim().toUpperCase();
    const fn = String(req.foreman_name || req.foreman || '').trim().toLowerCase();
    return this.SHOP_STATUS_POOLS.find((p) =>
      p.jobNumber === jn || p.name.toLowerCase() === fn
    ) || null;
  }

  init() {
    // Load initial counts quietly so sidebar badge lights up when foremen submit
    setTimeout(() => {
      this.refreshData({ silent: true }).catch(() => {});
    }, 2600);

    // Gentle 90-second background check for new foreman submissions
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        this.refreshData({ silent: true }).catch(() => {});
      }
    }, 90000);
  }

  // ---------------------------------------------------------------------------
  // Configuration & Supabase REST Helpers
  // ---------------------------------------------------------------------------
  getSupabaseConfig() {
    const sb = window.supabaseSync;
    const url = ((sb && sb.url) || localStorage.getItem('sa_supabase_url') || 'https://ixjlynzrqnuynpdtpdzu.supabase.co').trim().replace(/\/+$/, '');
    const key = ((sb && sb.anonKey) || localStorage.getItem('sa_supabase_anon_key') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4amx5bnpycW51eW5wZHRwZHp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2NTE2OTAsImV4cCI6MjEwOTIyNzY5MH0.TjgigNhr-UXvT3IrFzZFOEKz3_3qkk3-F14MEtQc-sQ').trim();
    return { url, key };
  }

  getFormBaseUrl() {
    let url = (localStorage.getItem('sa_audit_form_base_url') || '').trim();
    if (!url && this.db && this.db.snapshot && this.db.snapshot.configs && this.db.snapshot.configs.audit_form_base_url) {
      url = String(this.db.snapshot.configs.audit_form_base_url).trim();
    }
    if (!url) {
      url = 'https://safety-assistant-audit.pages.dev';
    }
    return url.replace(/\/+$/, '');
  }

  setFormBaseUrl(newUrl) {
    const cleaned = String(newUrl || '').trim().replace(/\/+$/, '');
    try { localStorage.setItem('sa_audit_form_base_url', cleaned); } catch { /* ignore */ }
    if (this.db && this.db.snapshot) {
      if (!this.db.snapshot.configs) this.db.snapshot.configs = {};
      this.db.snapshot.configs.audit_form_base_url = cleaned;
      if (typeof this.db.schedulePersistSnapshot === 'function') {
        this.db.schedulePersistSnapshot(this.db.snapshot, 400);
      }
    }
    return cleaned;
  }

  buildAuditLink(token) {
    const base = this.getFormBaseUrl();
    if (!base) return '';
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}t=${encodeURIComponent(token)}`;
  }

  async sbRequest(path, { method = 'GET', body = null, headers = {} } = {}) {
    const { url, key } = this.getSupabaseConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const resp = await fetch(`${url}${path}`, {
        method,
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...headers
        },
        body: body ? JSON.stringify(body) : null,
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await resp.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!resp.ok) {
        const msg = (data && (data.message || data.error || data.hint)) || `HTTP ${resp.status}`;
        const err = new Error(msg);
        err.status = resp.status;
        err.code = data && data.code;
        throw err;
      }
      return data;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  generateSecureToken() {
    const bytes = new Uint8Array(24);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async refreshData(options = { silent: false }) {
    if (this.isLoading) return;
    this.isLoading = true;
    this.lastError = null;
    try {
      const [reqs, subs] = await Promise.all([
        this.sbRequest('/rest/v1/sa_audit_requests?select=*&order=created_at.desc&limit=500'),
        this.sbRequest('/rest/v1/sa_audit_submissions?select=*&order=updated_at.desc&limit=500')
      ]);
      this.schemaMissing = false;
      this.requests = Array.isArray(reqs) ? reqs : [];
      this.submissionsByReqId = new Map();
      (Array.isArray(subs) ? subs : []).forEach((s) => {
        if (s && s.request_id) this.submissionsByReqId.set(s.request_id, s);
      });

      // Auto-backfill active employee roster on any open Packed For Delivery audit link created with placeholder roster
      const allActiveEmps = this.getAllActiveEmployeeNames();
      if (allActiveEmps.length > 0) {
        this.requests.forEach((req) => {
          if (!req || req.status === 'archived' || req.status === 'reconciled') return;
          if (String(req.job_number || '').trim().toUpperCase() !== 'SHOP-PACKED-DELIVERY') return;
          const curEmps = Array.isArray(req.crew_employees) ? req.crew_employees : [];
          const hasRealEmployees = curEmps.length > 1 || (curEmps.length === 1 && !/^(packed|ready)\s+for\s+delivery$/i.test(String(curEmps[0] || '').trim()));
          if (!hasRealEmployees) {
            req.crew_employees = allActiveEmps;
            this.sbRequest(`/rest/v1/sa_audit_requests?id=eq.${encodeURIComponent(req.id)}`, {
              method: 'PATCH',
              body: { crew_employees: allActiveEmps }
            }).catch(() => {});
          }
        });
      }

      this.updateSidebarBadge();
    } catch (err) {
      const msg = String(err.message || '');
      if (err.status === 404 || err.code === '42P01' || err.code === 'PGRST205' || msg.includes('sa_audit_requests') || msg.includes('Could not find the table')) {
        this.schemaMissing = true;
      } else {
        this.lastError = msg || 'Could not reach Supabase.';
      }
      if (!options.silent) {
        console.warn('[EquipmentAudits] refresh error:', err);
      }
    } finally {
      this.isLoading = false;
      const viewEl = document.getElementById('equipment-audits-view');
      if (!options.silent || (viewEl && viewEl.classList.contains('active'))) {
        this.render();
      }
    }
  }

  updateSidebarBadge() {
    const submittedCount = this.requests.filter((r) => r.status === 'submitted').length;
    const badge = document.getElementById('nav-equipment-audits-badge');
    if (badge) {
      if (submittedCount > 0) {
        badge.textContent = String(submittedCount);
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }
    const countPill = document.getElementById('equipment-audits-row-count');
    if (countPill) {
      countPill.textContent = `${this.requests.length} audits${submittedCount > 0 ? ` • ${submittedCount} ready` : ''}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Active Leadership & Crews Discovery (Foremen, GF, SUP only)
  // ---------------------------------------------------------------------------
  getBaseJobNumber(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    // Strip employee slot suffix like "007-27.1" -> "007-27"
    return s.replace(/\.\d+$/, '').trim();
  }

  getActiveCrewsList() {
    const snap = this.db ? this.db.getSnapshot() : null;
    const jtRows = (snap && snap.tables && snap.tables.job_tracking && snap.tables.job_tracking.rows) || [];
    const empRows = (snap && snap.tables && snap.tables.employees && snap.tables.employees.rows) || [];

    const STATUS_LOCS = new Set(['vacation', 'light duty', 'weeds', 'leave', 'previous employee', 'medical', "worker's comp", 'unknown']);
    const LEADER_CLASSES = new Set(['SUP', 'GF', 'F', 'GTO F', 'FOREMAN', 'GENERAL FOREMAN', 'SUPERVISOR', 'GTO FOREMAN']);

    const isActiveEmp = (r) => {
      const st = String(r['Status'] || '').trim().toLowerCase();
      const loc = String(r['Location'] || '').trim().toLowerCase();
      if (st.includes('previous') || st.includes('terminated') || st.includes('inactive') || st === 'pending') return false;
      if (loc.includes('previous employee')) return false;
      return true;
    };

    const getEmpEmail = (emp) => {
      if (!emp) return '';
      return String(emp['Notification Emails'] || emp['MP Email'] || emp['Email Address'] || emp['Email'] || '').split(/[,;]/)[0].trim();
    };

    const getEmpPhone = (emp) => {
      if (!emp) return '';
      return String(emp['Phone Number'] || emp['Phone'] || '').trim();
    };

    const normalizeRole = (rawClass) => {
      const c = String(rawClass || '').trim().toUpperCase();
      if (c === 'SUP' || c === 'SUPERVISOR') return 'SUP';
      if (c === 'GF' || c === 'GENERAL FOREMAN') return 'GF';
      if (c === 'GTO F' || c === 'GTO FOREMAN') return 'GTO F';
      if (c === 'F' || c === 'FOREMAN') return 'F';
      return c;
    };

    // 1. Index Job Tracking active jobs by base job number
    const jtByBaseJob = new Map();
    const jtForemanNames = new Set();
    jtRows.forEach((jt) => {
      const baseJob = this.getBaseJobNumber(jt['Job Number'] || jt['Job #'] || '');
      if (!baseJob) return;
      const status = String(jt['Status'] || 'Active').trim().toLowerCase();
      if (status === 'completed' || status === 'closed' || status === 'cancelled') return;
      const foreman = String(jt['Foreman'] || jt['Foreman / Lead'] || jt['Lead'] || '').trim();
      const loc = String(jt['Location'] || '').trim();
      const jobName = String(jt['Job Name'] || '').trim();
      jtByBaseJob.set(baseJob.toLowerCase(), {
        jobNumber: baseJob,
        jobName,
        location: STATUS_LOCS.has(loc.toLowerCase()) ? '' : loc,
        foreman,
        status: jt['Status'] || 'Active'
      });
      if (foreman) jtForemanNames.add(foreman.toLowerCase().replace(/\s*\([^)]*\)/g, '').trim());
    });

    // 2. Group ALL active employees by base job number so every leader gets their full crew roster
    const employeesByBaseJob = new Map();
    empRows.forEach((emp) => {
      if (!isActiveEmp(emp)) return;
      const empName = String(emp['Employee Name'] || emp['Name'] || '').trim();
      if (!empName) return;
      const primaryBase = this.getBaseJobNumber(emp['Job Number'] || emp['Job #'] || '');
      const secondaryBase = this.getBaseJobNumber(emp['Secondary Job Number'] || '');
      [primaryBase, secondaryBase].forEach((bj) => {
        if (!bj) return;
        const k = bj.toLowerCase();
        if (!employeesByBaseJob.has(k)) employeesByBaseJob.set(k, []);
        const arr = employeesByBaseJob.get(k);
        if (!arr.includes(empName)) arr.push(empName);
      });
    });

    // 3. Collect ONLY Foremen (F / GTO F), General Foremen (GF), Supervisors (SUP),
    //    and any active Job Tracking Foreman / Crew Lead = Yes
    const seenLeaders = new Set();
    const leaders = [];

    empRows.forEach((emp) => {
      if (!isActiveEmp(emp)) return;
      const empName = String(emp['Employee Name'] || emp['Name'] || '').trim();
      if (!empName) return;

      const rawClass = String(emp['Job Classification'] || emp['Class'] || '').trim();
      const normRole = normalizeRole(rawClass);
      const isCrewLeadFlag = /^(yes|true|y|1)$/i.test(String(emp['Crew Lead'] || '').trim());
      const cleanNameKey = empName.toLowerCase().replace(/\s*\([^)]*\)/g, '').trim();
      const isJtForeman = jtForemanNames.has(cleanNameKey);
      const isLeaderClass = LEADER_CLASSES.has(rawClass.toUpperCase()) || ['SUP', 'GF', 'F', 'GTO F'].includes(normRole);

      if (!isLeaderClass && !isCrewLeadFlag && !isJtForeman) return;

      // Skip Light Duty employees on 005- unless they are SUP/GF
      const stLower = String(emp['Status'] || '').trim().toLowerCase();
      if (stLower.includes('light duty') && normRole !== 'SUP' && normRole !== 'GF') return;

      if (seenLeaders.has(cleanNameKey)) return;
      seenLeaders.add(cleanNameKey);

      const baseJob = this.getBaseJobNumber(emp['Job Number'] || emp['Job #'] || '');
      const jtInfo = baseJob ? jtByBaseJob.get(baseJob.toLowerCase()) : null;
      const rawLoc = String(emp['Location'] || '').replace(/\s*\([^)]*\)/g, '').trim();
      const cleanLoc = (jtInfo && jtInfo.location) || (STATUS_LOCS.has(rawLoc.toLowerCase()) ? '' : rawLoc);

      const crewList = baseJob ? [...(employeesByBaseJob.get(baseJob.toLowerCase()) || [])] : [empName];
      if (!crewList.includes(empName)) crewList.unshift(empName);
      crewList.sort((a, b) => a.localeCompare(b));

      leaders.push({
        foreman: empName,
        role: normRole || 'F',
        isPrimaryLead: isCrewLeadFlag || isJtForeman,
        jobNumber: baseJob || String(emp['Job Number'] || '').trim(),
        jobName: (jtInfo && jtInfo.jobName) || '',
        location: cleanLoc,
        status: String(emp['Status'] || 'Active').trim(),
        employees: crewList,
        phone: getEmpPhone(emp),
        email: getEmpEmail(emp)
      });
    });

    // Sort field leaders cleanly by Name
    leaders.sort((a, b) => a.foreman.localeCompare(b.foreman));

    // 4. Append the 4 Helena Shop / Status Audit Pools (On Shelf, In Testing, Packed For Delivery, Packed For Testing)
    const activeUserName = String((window.supabaseSync && window.supabaseSync.userName) || 'Cody Bechdol').trim().toLowerCase();
    const adminEmp = empRows.find((r) => String(r['Employee Name'] || r['Name'] || '').trim().toLowerCase() === activeUserName) || null;
    const adminPhone = getEmpPhone(adminEmp);
    const adminEmail = getEmpEmail(adminEmp);
    const tables = (snap && snap.tables) || {};

    const allActiveEmployees = this.getAllActiveEmployeeNames();

    this.SHOP_STATUS_POOLS.forEach((pool) => {
      let itemCount = 0;
      this.CATEGORIES.forEach((cat) => {
        if (cat.fieldOnly) return;
        const rows = (tables[cat.key] && Array.isArray(tables[cat.key].rows)) ? tables[cat.key].rows : [];
        rows.forEach((r) => {
          if (this.isRowInShopPool(r, pool)) itemCount++;
        });
      });

      const isPackedPool = pool.jobNumber === 'SHOP-PACKED-DELIVERY';
      leaders.push({
        foreman: pool.name,
        role: 'SHOP',
        icon: pool.icon,
        isShopPool: true,
        isPrimaryLead: false,
        jobNumber: pool.jobNumber,
        jobName: pool.jobName,
        location: pool.location,
        status: 'Shop Pool',
        shopItemCount: itemCount,
        employees: (isPackedPool && allActiveEmployees.length > 0) ? allActiveEmployees : [pool.canonicalAssignedTo],
        phone: adminPhone,
        email: adminEmail
      });
    });

    return leaders;
  }

  getAllActiveEmployeeNames() {
    const snap = this.db ? this.db.getSnapshot() : null;
    const empRows = (snap && snap.tables && snap.tables.employees && snap.tables.employees.rows) || [];
    const seen = new Set();
    const out = [];
    empRows.forEach((r) => {
      const st = String(r['Status'] || '').trim().toLowerCase();
      const loc = String(r['Location'] || '').trim().toLowerCase();
      if (st.includes('previous') || st.includes('terminated') || st.includes('inactive')) return;
      if (loc.includes('previous employee')) return;
      const nm = String(r['Employee Name'] || r['Name'] || '').trim();
      if (nm && !seen.has(nm.toLowerCase())) {
        seen.add(nm.toLowerCase());
        out.push(nm);
      }
    });
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  isRowInShopPool(row, pool) {
    if (!row || !pool) return false;
    const st = String(row['Status'] || '').trim().toLowerCase();
    const asg = String(row['Assigned To'] || '').trim().toLowerCase();
    if (['lost', 'destroyed', 'failed', 'failed rubber', 'not repairable', 'retired'].includes(st)) return false;
    return pool.matchStatuses.includes(st) || pool.matchAssignedTo.includes(asg);
  }

  // ---------------------------------------------------------------------------
  // Main Workspace Renderer
  // ---------------------------------------------------------------------------
  render() {
    const container = document.getElementById('equipment-audits-content');
    if (!container) return;

    this.updateSidebarBadge();

    if (this.schemaMissing) {
      container.innerHTML = this.renderSetupCardHtml();
      return;
    }

    const activeReqs = this.requests.filter((r) => r.status !== 'archived');
    const submittedCount = activeReqs.filter((r) => r.status === 'submitted').length;
    const draftCount = activeReqs.filter((r) => r.status === 'in_progress').length;
    const awaitingCount = activeReqs.filter((r) => r.status === 'not_sent' || r.status === 'sent').length;
    const archivedCount = this.requests.filter((r) => r.status === 'archived' || r.status === 'reconciled').length;
    const formUrl = this.getFormBaseUrl();

    const subtabBar = `
      <div style="padding: 14px 18px 0 18px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid var(--border-color); background: rgba(15, 23, 42, 0.45);">
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button class="btn ${this.activeTab === 'manage' ? 'btn-primary' : 'btn-secondary'}" style="border-radius: 8px 8px 0 0; border-bottom: none; font-size: 12.5px; font-weight: 700; padding: 8px 14px;" onclick="window.equipmentAuditsEngine.switchTab('manage')">
            📤 Send &amp; Track (${activeReqs.length})
          </button>
          <button class="btn ${this.activeTab === 'review' ? 'btn-primary' : 'btn-secondary'}" style="border-radius: 8px 8px 0 0; border-bottom: none; font-size: 12.5px; font-weight: 700; padding: 8px 14px;" onclick="window.equipmentAuditsEngine.switchTab('review')">
            🔍 Review &amp; Reconcile ${submittedCount > 0 ? `<span style="background:#10b981;color:#fff;padding:1px 7px;border-radius:999px;font-size:11px;margin-left:4px;">${submittedCount}</span>` : ''}
          </button>
          <button class="btn ${this.activeTab === 'archive' ? 'btn-primary' : 'btn-secondary'}" style="border-radius: 8px 8px 0 0; border-bottom: none; font-size: 12.5px; font-weight: 700; padding: 8px 14px;" onclick="window.equipmentAuditsEngine.switchTab('archive')">
            🗄️ Audit Archive (${archivedCount})
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; padding-bottom: 8px; flex-wrap: wrap;">
          <span style="font-size: 11.5px; color: ${formUrl ? '#6ee7b7' : '#fbbf24'}; font-weight: 600;">
            ${formUrl ? `🌐 Form URL: ${this.escapeHtml(formUrl)}` : '⚠️ Set Cloudflare Pages Form URL before sending links'}
          </span>
          <button class="btn btn-secondary" style="font-size: 11.5px; padding: 4px 10px;" onclick="window.equipmentAuditsEngine.openFormSettingsModal()">
            ⚙️ Form URL &amp; Setup
          </button>
        </div>
      </div>
    `;

    const kpiStrip = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 10px; padding: 14px 18px 6px 18px;">
        <div style="background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(148,163,184,0.2); border-radius: 10px; padding: 11px 14px;">
          <div style="font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Ready for Review</div>
          <div style="font-size: 22px; font-weight: 800; color: #34d399; margin-top: 2px;">${submittedCount}</div>
        </div>
        <div style="background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(148,163,184,0.2); border-radius: 10px; padding: 11px 14px;">
          <div style="font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Drafts In Progress</div>
          <div style="font-size: 22px; font-weight: 800; color: #60a5fa; margin-top: 2px;">${draftCount}</div>
        </div>
        <div style="background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(148,163,184,0.2); border-radius: 10px; padding: 11px 14px;">
          <div style="font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Awaiting Foreman</div>
          <div style="font-size: 22px; font-weight: 800; color: #fbbf24; margin-top: 2px;">${awaitingCount}</div>
        </div>
        <div style="background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(148,163,184,0.2); border-radius: 10px; padding: 11px 14px;">
          <div style="font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Completed &amp; Archived</div>
          <div style="font-size: 22px; font-weight: 800; color: #c084fc; margin-top: 2px;">${archivedCount}</div>
        </div>
      </div>
    `;

    const errBanner = this.lastError ? `
      <div style="margin: 10px 18px 0 18px; padding: 10px 14px; border-radius: 8px; background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.4); color: #fca5a5; font-size: 12.5px;">
        ⚠️ ${this.escapeHtml(this.lastError)}
      </div>
    ` : '';

    let bodyHtml = '';
    if (this.activeTab === 'manage') {
      bodyHtml = kpiStrip + this.renderManageTabHtml(activeReqs);
    } else if (this.activeTab === 'review') {
      bodyHtml = this.renderReviewTabHtml();
    } else {
      bodyHtml = this.renderArchiveTabHtml();
    }

    container.innerHTML = subtabBar + errBanner + bodyHtml;
  }

  switchTab(tabName) {
    this.activeTab = tabName;
    if (tabName === 'review' && !this.activeReviewRequestId) {
      const firstSub = this.requests.find((r) => r.status === 'submitted') || this.requests.find((r) => r.status === 'in_progress');
      if (firstSub) this.activeReviewRequestId = firstSub.id;
    }
    this.render();
  }

  // ---------------------------------------------------------------------------
  // Setup Card (Shown If audit_setup.sql Has Not Been Run Yet in Supabase)
  // ---------------------------------------------------------------------------
  renderSetupCardHtml() {
    return `
      <div style="max-width: 720px; margin: 36px auto; background: rgba(30, 41, 59, 0.88); border: 1px solid rgba(59, 130, 246, 0.4); border-radius: 14px; padding: 28px; color: #f8fafc;">
        <div style="font-size: 36px; margin-bottom: 10px;">📋</div>
        <h2 style="margin: 0 0 8px 0; font-size: 20px;">One-Time Supabase Audit Tables Setup</h2>
        <p style="color: #cbd5e1; font-size: 13.5px; line-height: 1.55; margin-bottom: 18px;">
          To start sending zero-download equipment audit forms to foremen and receiving live submissions here, run the setup SQL script once in your Supabase SQL Editor. This creates <code>sa_audit_requests</code>, <code>sa_audit_submissions</code>, and the 3 token-locked RPC functions.
        </p>
        <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px;">
          <button class="btn btn-primary" style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); border: none; font-weight: 700;" onclick="window.equipmentAuditsEngine.copySetupSql()">
            📋 Copy Audit SQL Script
          </button>
          <button class="btn btn-secondary" onclick="window.open('https://supabase.com/dashboard/project/ixjlynzrqnuynpdtpdzu/sql/new', '_blank')">
            🔗 Open Supabase SQL Editor
          </button>
          <button class="btn btn-secondary" style="border-color: #10b981; color: #6ee7b7;" onclick="window.equipmentAuditsEngine.refreshData()">
            🔄 Verify &amp; Connect
          </button>
        </div>
        <div style="font-size: 12px; color: #94a3b8;">
          The full script is also saved in your project at <code>supabase/audit_setup.sql</code>.
        </div>
      </div>
    `;
  }

  getAuditSetupSqlText() {
    return `-- Safety Assistant — Foreman Equipment Inventory Audits (Supabase Setup)
CREATE TABLE IF NOT EXISTS public.sa_audit_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token          TEXT UNIQUE NOT NULL,
  campaign_name  TEXT NOT NULL DEFAULT 'Crew Equipment Audit',
  foreman_name   TEXT NOT NULL,
  job_number     TEXT NOT NULL DEFAULT '',
  job_name       TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',
  foreman_phone  TEXT NOT NULL DEFAULT '',
  foreman_email  TEXT NOT NULL DEFAULT '',
  crew_employees JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'not_sent',
  sent_via       TEXT NOT NULL DEFAULT '',
  sent_at        TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  reopened_at    TIMESTAMPTZ,
  notes          TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL DEFAULT 'Cody Bechdol',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sa_audit_requests_token ON public.sa_audit_requests (token);
CREATE INDEX IF NOT EXISTS idx_sa_audit_requests_status ON public.sa_audit_requests (status);
CREATE INDEX IF NOT EXISTS idx_sa_audit_requests_created_at ON public.sa_audit_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS public.sa_audit_submissions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id             UUID UNIQUE NOT NULL REFERENCES public.sa_audit_requests(id) ON DELETE CASCADE,
  draft_payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft_item_count       INTEGER NOT NULL DEFAULT 0,
  draft_saved_at         TIMESTAMPTZ,
  submitted_payload      JSONB,
  submitted_item_count   INTEGER NOT NULL DEFAULT 0,
  submitted_at           TIMESTAMPTZ,
  submitted_by_name      TEXT NOT NULL DEFAULT '',
  submitted_by_device    TEXT NOT NULL DEFAULT '',
  reconciliation_summary JSONB,
  applied_actions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  auditor_notes          TEXT NOT NULL DEFAULT '',
  reconciled_at          TIMESTAMPTZ,
  archived_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sa_audit_submissions_request_id ON public.sa_audit_submissions (request_id);

ALTER TABLE public.sa_audit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sa_audit_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow full access to sa_audit_requests" ON public.sa_audit_requests;
CREATE POLICY "Allow full access to sa_audit_requests" ON public.sa_audit_requests FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow full access to sa_audit_submissions" ON public.sa_audit_submissions;
CREATE POLICY "Allow full access to sa_audit_submissions" ON public.sa_audit_submissions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.get_audit_by_token(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req public.sa_audit_requests%ROWTYPE;
  v_sub public.sa_audit_submissions%ROWTYPE;
  v_has_sub BOOLEAN := false;
  v_expired BOOLEAN := false;
  v_locked BOOLEAN := false;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 12 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid audit link.');
  END IF;
  SELECT * INTO v_req FROM public.sa_audit_requests WHERE token = trim(p_token) LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Audit link not found. Please contact Safety for a new link.');
  END IF;
  SELECT * INTO v_sub FROM public.sa_audit_submissions WHERE request_id = v_req.id LIMIT 1;
  v_has_sub := FOUND;
  IF v_req.status IN ('submitted', 'reconciled', 'archived') THEN v_locked := true; END IF;
  IF v_req.status = 'expired' OR (v_req.expires_at IS NOT NULL AND v_req.expires_at < now() AND NOT v_locked) THEN
    v_expired := true; v_locked := true;
  END IF;
  RETURN jsonb_build_object(
    'ok', true, 'expired', v_expired, 'locked', v_locked,
    'request', jsonb_build_object(
      'campaign_name', v_req.campaign_name, 'foreman_name', v_req.foreman_name,
      'job_number', v_req.job_number, 'job_name', v_req.job_name, 'location', v_req.location,
      'crew_employees', COALESCE(v_req.crew_employees, '[]'::jsonb), 'status', v_req.status,
      'expires_at', v_req.expires_at, 'notes', v_req.notes
    ),
    'submission', CASE WHEN v_has_sub THEN jsonb_build_object(
      'draft_payload', COALESCE(v_sub.draft_payload, '{}'::jsonb),
      'draft_item_count', COALESCE(v_sub.draft_item_count, 0), 'draft_saved_at', v_sub.draft_saved_at,
      'submitted_payload', v_sub.submitted_payload, 'submitted_item_count', COALESCE(v_sub.submitted_item_count, 0),
      'submitted_at', v_sub.submitted_at, 'submitted_by_name', COALESCE(v_sub.submitted_by_name, '')
    ) ELSE NULL END
  );
END; $$;

CREATE OR REPLACE FUNCTION public.save_audit_draft(p_token TEXT, p_payload JSONB, p_item_count INTEGER DEFAULT 0, p_device TEXT DEFAULT '')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.sa_audit_requests%ROWTYPE; v_now TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_req FROM public.sa_audit_requests WHERE token = trim(COALESCE(p_token, '')) LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Audit link not found.'); END IF;
  IF v_req.status IN ('submitted', 'reconciled', 'archived') THEN RETURN jsonb_build_object('ok', false, 'locked', true, 'error', 'This audit has already been submitted and locked.'); END IF;
  IF v_req.status = 'expired' OR (v_req.expires_at IS NOT NULL AND v_req.expires_at < v_now) THEN RETURN jsonb_build_object('ok', false, 'expired', true, 'error', 'This audit link has expired.'); END IF;
  INSERT INTO public.sa_audit_submissions (request_id, draft_payload, draft_item_count, draft_saved_at, submitted_by_device, updated_at)
  VALUES (v_req.id, COALESCE(p_payload, '{}'::jsonb), GREATEST(COALESCE(p_item_count, 0), 0), v_now, COALESCE(p_device, ''), v_now)
  ON CONFLICT (request_id) DO UPDATE SET
    draft_payload = EXCLUDED.draft_payload, draft_item_count = EXCLUDED.draft_item_count, draft_saved_at = v_now,
    submitted_by_device = CASE WHEN EXCLUDED.submitted_by_device <> '' THEN EXCLUDED.submitted_by_device ELSE public.sa_audit_submissions.submitted_by_device END,
    updated_at = v_now;
  UPDATE public.sa_audit_requests SET status = CASE WHEN status IN ('not_sent', 'sent') THEN 'in_progress' ELSE status END, updated_at = v_now WHERE id = v_req.id;
  RETURN jsonb_build_object('ok', true, 'saved_at', v_now);
END; $$;

CREATE OR REPLACE FUNCTION public.submit_audit(p_token TEXT, p_payload JSONB, p_item_count INTEGER DEFAULT 0, p_submitted_by TEXT DEFAULT '', p_device TEXT DEFAULT '')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.sa_audit_requests%ROWTYPE; v_now TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_req FROM public.sa_audit_requests WHERE token = trim(COALESCE(p_token, '')) LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Audit link not found.'); END IF;
  IF v_req.status IN ('reconciled', 'archived') THEN RETURN jsonb_build_object('ok', false, 'locked', true, 'error', 'This audit has already been completed and archived.'); END IF;
  IF v_req.status = 'expired' OR (v_req.expires_at IS NOT NULL AND v_req.expires_at < v_now) THEN RETURN jsonb_build_object('ok', false, 'expired', true, 'error', 'This audit link has expired.'); END IF;
  INSERT INTO public.sa_audit_submissions (request_id, draft_payload, draft_item_count, draft_saved_at, submitted_payload, submitted_item_count, submitted_at, submitted_by_name, submitted_by_device, updated_at)
  VALUES (v_req.id, COALESCE(p_payload, '{}'::jsonb), GREATEST(COALESCE(p_item_count, 0), 0), v_now, COALESCE(p_payload, '{}'::jsonb), GREATEST(COALESCE(p_item_count, 0), 0), v_now, COALESCE(NULLIF(trim(p_submitted_by), ''), v_req.foreman_name), COALESCE(p_device, ''), v_now)
  ON CONFLICT (request_id) DO UPDATE SET
    draft_payload = EXCLUDED.draft_payload, draft_item_count = EXCLUDED.draft_item_count, draft_saved_at = v_now,
    submitted_payload = EXCLUDED.submitted_payload, submitted_item_count = EXCLUDED.submitted_item_count, submitted_at = v_now,
    submitted_by_name = EXCLUDED.submitted_by_name, submitted_by_device = EXCLUDED.submitted_by_device, updated_at = v_now;
  UPDATE public.sa_audit_requests SET status = 'submitted', updated_at = v_now WHERE id = v_req.id;
  RETURN jsonb_build_object('ok', true, 'submitted_at', v_now);
END; $$;

GRANT EXECUTE ON FUNCTION public.get_audit_by_token(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_audit_draft(TEXT, JSONB, INTEGER, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_audit(TEXT, JSONB, INTEGER, TEXT, TEXT) TO anon, authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'sa_audit_requests') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sa_audit_requests;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'sa_audit_submissions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sa_audit_submissions;
  END IF;
END $$;`;
  }

  copySetupSql() {
    const sql = this.getAuditSetupSqlText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(sql).then(() => {
        this.toast('📋 Copied Audit SQL setup script! Paste and Run in Supabase SQL Editor.', 'success');
      }).catch(() => {
        alert('Please open supabase/audit_setup.sql and copy its contents into Supabase SQL Editor.');
      });
    }
  }

  // ---------------------------------------------------------------------------
  // TAB 1: Send & Track Audits
  // ---------------------------------------------------------------------------
  renderManageTabHtml(activeReqs) {
    const campaigns = Array.from(new Set(activeReqs.map((r) => r.campaign_name).filter(Boolean)));
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = activeReqs.filter((r) => {
      if (this.campaignFilter !== 'all' && r.campaign_name !== this.campaignFilter) return false;
      if (this.statusFilter !== 'all' && r.status !== this.statusFilter) return false;
      if (q) {
        const blob = `${r.foreman_name} ${r.job_number} ${r.job_name} ${r.location} ${r.campaign_name}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });

    const selectedCount = filtered.filter((r) => this.selectedRequestIds.has(r.id)).length;

    const filterRow = `
      <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding: 12px 18px;">
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
          <select class="sheet-search" style="font-size: 12px;" onchange="window.equipmentAuditsEngine.setCampaignFilter(this.value)">
            <option value="all" ${this.campaignFilter === 'all' ? 'selected' : ''}>All Campaigns</option>
            ${campaigns.map((c) => `<option value="${this.escapeHtml(c)}" ${this.campaignFilter === c ? 'selected' : ''}>${this.escapeHtml(c)}</option>`).join('')}
          </select>
          <select class="sheet-search" style="font-size: 12px;" onchange="window.equipmentAuditsEngine.setStatusFilter(this.value)">
            <option value="all" ${this.statusFilter === 'all' ? 'selected' : ''}>All Statuses</option>
            <option value="submitted" ${this.statusFilter === 'submitted' ? 'selected' : ''}>✅ Submitted (Ready)</option>
            <option value="in_progress" ${this.statusFilter === 'in_progress' ? 'selected' : ''}>📝 Draft In Progress</option>
            <option value="sent" ${this.statusFilter === 'sent' ? 'selected' : ''}>📤 Sent</option>
            <option value="not_sent" ${this.statusFilter === 'not_sent' ? 'selected' : ''}>⏳ Not Sent</option>
          </select>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
          ${selectedCount > 0 ? `
            <button class="btn btn-primary admin-only-control" style="font-size: 12px; font-weight: 700; background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); border: none;" onclick="window.equipmentAuditsEngine.batchSendEmails()">
              📧 Email Selected (${selectedCount})
            </button>
          ` : ''}
        </div>
      </div>
    `;

    if (filtered.length === 0) {
      return `
        ${filterRow}
        <div style="margin: 18px; padding: 36px 20px; text-align: center; background: rgba(30, 41, 59, 0.55); border: 1.5px dashed rgba(148,163,184,0.3); border-radius: 12px;">
          <div style="font-size: 38px; margin-bottom: 10px;">📋</div>
          <h3 style="margin: 0 0 6px 0; color: #f8fafc;">No Active Equipment Audits</h3>
          <p style="margin: 0 0 16px 0; color: #94a3b8; font-size: 13px;">
            Click <strong>+ New Equipment Audit</strong> above to generate private, zero-download audit links for individual foremen or all active crews at once.
          </p>
          <button class="btn btn-primary admin-only-control" onclick="window.equipmentAuditsEngine.openCreateCampaignModal()">
            ➕ New Equipment Audit
          </button>
        </div>
      `;
    }

    const rowsHtml = filtered.map((req) => {
      const sub = this.submissionsByReqId.get(req.id);
      const checked = this.selectedRequestIds.has(req.id);
      const statusBadge = this.renderStatusBadge(req.status, sub);
      const hasReviewable = Boolean(sub && ((sub.submitted_item_count > 0 || req.status === 'submitted') || sub.draft_item_count > 0));
      const sentInfo = req.sent_at
        ? `${(req.sent_via || 'link').toUpperCase()} • ${this.formatShortDateTime(req.sent_at)}`
        : 'Not sent yet';

      return `
        <tr style="border-bottom: 1px solid rgba(148,163,184,0.12);">
          <td style="padding: 10px 10px; text-align: center;">
            <input type="checkbox" ${checked ? 'checked' : ''} onchange="window.equipmentAuditsEngine.toggleSelectRequest('${req.id}', this.checked)">
          </td>
          <td style="padding: 10px 10px;">
            <div style="font-weight: 700; color: #f8fafc; font-size: 13.5px;">${this.escapeHtml(req.foreman_name)}</div>
            <div style="font-size: 11.5px; color: #94a3b8;">${this.escapeHtml(req.campaign_name)}</div>
          </td>
          <td style="padding: 10px 10px;">
            <div style="font-weight: 700; color: #93c5fd; font-size: 12.5px;">${this.escapeHtml(req.job_number || '—')}</div>
            <div style="font-size: 11.5px; color: #cbd5e1;">${this.escapeHtml(req.location || '')}${req.job_name ? ` • ${this.escapeHtml(req.job_name)}` : ''}</div>
          </td>
          <td style="padding: 10px 10px;">${statusBadge}</td>
          <td style="padding: 10px 10px; font-size: 11.5px; color: #cbd5e1;">
            <div>${this.escapeHtml(sentInfo)}</div>
            ${req.expires_at ? `<div style="color:#64748b;">Due ${this.formatDateOnly(req.expires_at)}</div>` : ''}
          </td>
          <td style="padding: 10px 10px;">
            <div style="display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end;">
              ${hasReviewable ? `
                <button class="btn btn-primary" style="font-size: 11.5px; padding: 5px 10px; background: linear-gradient(135deg, #059669 0%, #047857 100%); border: none; font-weight: 700;" onclick="window.equipmentAuditsEngine.openReview('${req.id}')">
                  🔍 ${req.status === 'submitted' ? 'Review Audit' : 'Inspect Draft'}
                </button>
              ` : ''}
              <button class="btn btn-secondary" style="font-size: 11.5px; padding: 5px 9px;" title="Send personalized link via SMS" onclick="window.equipmentAuditsEngine.sendViaSms('${req.id}')">
                📱 SMS
              </button>
              <button class="btn btn-secondary" style="font-size: 11.5px; padding: 5px 9px;" title="Send personalized link via Email" onclick="window.equipmentAuditsEngine.sendViaEmail('${req.id}')">
                📧 Email
              </button>
              <button class="btn btn-secondary" style="font-size: 11.5px; padding: 5px 9px;" title="Copy foreman link" onclick="window.equipmentAuditsEngine.copyRequestLink('${req.id}')">
                📋 Link
              </button>
              ${req.status === 'submitted' ? `
                <button class="btn btn-secondary" style="font-size: 11px; padding: 5px 8px; color: #fbbf24;" title="Unlock so foreman can add or edit items" onclick="window.equipmentAuditsEngine.reopenAudit('${req.id}')">
                  🔓 Reopen
                </button>
              ` : ''}
              <button class="btn btn-secondary" style="font-size: 11px; padding: 5px 7px; color: #f87171;" title="Delete audit request" onclick="window.equipmentAuditsEngine.deleteAuditRequest('${req.id}')">
                🗑️
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    const allChecked = filtered.length > 0 && filtered.every((r) => this.selectedRequestIds.has(r.id));

    return `
      ${filterRow}
      <div style="padding: 0 18px 24px 18px; overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; background: rgba(15, 23, 42, 0.55); border: 1px solid var(--border-color); border-radius: 10px; overflow: hidden;">
          <thead>
            <tr style="background: rgba(30, 41, 59, 0.9); text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8;">
              <th style="padding: 10px; width: 34px; text-align: center;">
                <input type="checkbox" ${allChecked ? 'checked' : ''} onchange="window.equipmentAuditsEngine.toggleSelectAllFiltered(this.checked)">
              </th>
              <th style="padding: 10px;">Foreman &amp; Campaign</th>
              <th style="padding: 10px;">Job # &amp; Location</th>
              <th style="padding: 10px;">Status</th>
              <th style="padding: 10px;">Delivery &amp; Due</th>
              <th style="padding: 10px; text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  renderStatusBadge(status, sub) {
    const cnt = sub ? (status === 'submitted' || status === 'reconciled' || status === 'archived' ? sub.submitted_item_count : sub.draft_item_count) : 0;
    const styles = {
      submitted: { bg: 'rgba(16, 185, 129, 0.18)', border: 'rgba(16, 185, 129, 0.45)', color: '#6ee7b7', label: `✅ Submitted (${cnt} items)` },
      in_progress: { bg: 'rgba(59, 130, 246, 0.18)', border: 'rgba(59, 130, 246, 0.45)', color: '#93c5fd', label: `📝 Draft (${cnt} items)` },
      sent: { bg: 'rgba(245, 158, 11, 0.16)', border: 'rgba(245, 158, 11, 0.4)', color: '#fde68a', label: '📤 Sent — Awaiting' },
      not_sent: { bg: 'rgba(148, 163, 184, 0.15)', border: 'rgba(148, 163, 184, 0.35)', color: '#cbd5e1', label: '⏳ Not Sent' },
      reconciled: { bg: 'rgba(168, 85, 247, 0.18)', border: 'rgba(168, 85, 247, 0.4)', color: '#d8b4fe', label: `✓ Reconciled (${cnt})` },
      archived: { bg: 'rgba(168, 85, 247, 0.18)', border: 'rgba(168, 85, 247, 0.4)', color: '#d8b4fe', label: `🗄️ Archived (${cnt})` },
      expired: { bg: 'rgba(239, 68, 68, 0.16)', border: 'rgba(239, 68, 68, 0.4)', color: '#fca5a5', label: '⌛ Expired' }
    };
    const s = styles[status] || styles.not_sent;
    const subTime = sub && sub.submitted_at ? ` • ${this.formatShortDateTime(sub.submitted_at)}` : (sub && sub.draft_saved_at ? ` • ${this.formatShortDateTime(sub.draft_saved_at)}` : '');
    return `
      <span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:${s.bg};border:1px solid ${s.border};color:${s.color};white-space:nowrap;">
        ${s.label}
      </span>
      ${subTime ? `<div style="font-size:10.5px;color:#94a3b8;margin-top:3px;">${this.escapeHtml(subTime.replace(/^ • /, ''))}</div>` : ''}
    `;
  }

  // ---------------------------------------------------------------------------
  // Create Campaign / Audit Links Modal
  // ---------------------------------------------------------------------------
  openCreateCampaignModal() {
    const existing = document.getElementById('eq-audit-create-modal');
    if (existing) existing.remove();

    const crews = this.getActiveCrewsList();
    this._pendingCrewsForModal = crews;
    this._modalRoleFilter = 'all';
    this._modalSearchText = '';
    // Default field leaders (F, GF, SUP) checked; Shop/Status pools unchecked until picked
    this._modalSelectedIdx = new Set(crews.map((c, idx) => (c.isShopPool ? -1 : idx)).filter((i) => i !== -1));

    const defaultCampaign = `${new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })} Crew Equipment Audit`;

    const fCount = crews.filter((c) => c.role === 'F' || c.role === 'GTO F').length;
    const gfCount = crews.filter((c) => c.role === 'GF').length;
    const supCount = crews.filter((c) => c.role === 'SUP').length;
    const shopCount = crews.filter((c) => c.isShopPool).length;

    const modal = document.createElement('div');
    modal.id = 'eq-audit-create-modal';
    // NOTE: Do NOT use .modal-overlay class here because app.css sets pointer-events: none on .modal-overlay
    modal.style.cssText = 'position:fixed;inset:0;z-index:15000;background:rgba(2,6,23,0.78);display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:auto;';

    modal.innerHTML = `
      <div class="modal-box" style="width:100%;max-width:800px;max-height:90vh;background:#0f172a;border:1px solid rgba(59,130,246,0.45);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.6);pointer-events:auto;">
        <div style="padding:14px 18px;background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
          <h3 style="margin:0;font-size:15.5px;font-weight:800;color:#fff;">📋 Create Equipment Audit Links (Foremen, GF, SUP &amp; Shop Stock)</h3>
          <button style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;" onclick="document.getElementById('eq-audit-create-modal').remove()">&times;</button>
        </div>
        <div style="padding:16px 18px;display:flex;flex-direction:column;gap:11px;flex:1;min-height:0;overflow:hidden;">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;flex-shrink:0;">
            <div>
              <label style="display:block;font-size:11.5px;font-weight:700;color:#94a3b8;margin-bottom:4px;">AUDIT CAMPAIGN NAME</label>
              <input type="text" id="eq-audit-campaign-name" class="sheet-search" style="width:100%;font-size:13px;" value="${this.escapeHtml(defaultCampaign)}">
            </div>
            <div>
              <label style="display:block;font-size:11.5px;font-weight:700;color:#94a3b8;margin-bottom:4px;">LINK EXPIRES IN</label>
              <select id="eq-audit-expire-days" class="sheet-search" style="width:100%;font-size:13px;">
                <option value="7">7 Days</option>
                <option value="14" selected>14 Days (Recommended)</option>
                <option value="21">21 Days</option>
                <option value="30">30 Days</option>
              </select>
            </div>
          </div>
          <div style="flex-shrink:0;">
            <label style="display:block;font-size:11.5px;font-weight:700;color:#94a3b8;margin-bottom:4px;">OPTIONAL INSTRUCTIONS SHOWN AT TOP OF AUDIT FORM</label>
            <input type="text" id="eq-audit-notes" class="sheet-search" style="width:100%;font-size:12.5px;" placeholder="e.g., Please check all trucks and personal bags for rubber, blankets, grounds, sticks, testers, and AEDs.">
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;flex-shrink:0;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <button type="button" class="btn btn-primary eq-role-pill" data-role="all" style="font-size:11px;padding:4px 9px;" onclick="window.equipmentAuditsEngine.setCreateModalRoleFilter('all')">All (${crews.length})</button>
              <button type="button" class="btn btn-secondary eq-role-pill" data-role="foremen" style="font-size:11px;padding:4px 9px;color:#93c5fd;" onclick="window.equipmentAuditsEngine.setCreateModalRoleFilter('foremen')">Foremen (${fCount})</button>
              <button type="button" class="btn btn-secondary eq-role-pill" data-role="GF" style="font-size:11px;padding:4px 9px;color:#fdba74;" onclick="window.equipmentAuditsEngine.setCreateModalRoleFilter('GF')">GF (${gfCount})</button>
              <button type="button" class="btn btn-secondary eq-role-pill" data-role="SUP" style="font-size:11px;padding:4px 9px;color:#d8b4fe;" onclick="window.equipmentAuditsEngine.setCreateModalRoleFilter('SUP')">SUP (${supCount})</button>
              <button type="button" class="btn btn-secondary eq-role-pill" data-role="SHOP" style="font-size:11px;padding:4px 9px;color:#2dd4bf;border-color:rgba(45,212,191,0.4);" onclick="window.equipmentAuditsEngine.setCreateModalRoleFilter('SHOP')">📦 Shop / Stock (${shopCount})</button>
            </div>
            <input type="text" id="eq-audit-modal-search" class="sheet-search" style="width:200px;font-size:12px;padding:4px 8px;" placeholder="Filter name, job #, status..." oninput="window.equipmentAuditsEngine.setCreateModalSearch(this.value)">
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
            <label style="font-size:12px;font-weight:700;color:#e2e8f0;display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="eq-audit-select-all-crews" onchange="window.equipmentAuditsEngine.toggleSelectAllModalLeaders(this.checked)">
              <span id="eq-audit-select-all-label">Select All Shown (${crews.length})</span>
            </label>
            <span style="font-size:11px;color:#94a3b8;">Shop pools (On Shelf, In Testing, Packed) reconcile directly against warehouse status</span>
          </div>
          <div id="eq-audit-modal-list" style="flex:1;min-height:180px;max-height:360px;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--border-color);border-radius:8px;background:rgba(15,23,42,0.85);"></div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;gap:8px;background:rgba(15,23,42,0.95);flex-shrink:0;">
          <span id="eq-audit-selected-summary" style="font-size:12px;color:#93c5fd;font-weight:700;">${this._modalSelectedIdx.size} selected</span>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-secondary" onclick="document.getElementById('eq-audit-create-modal').remove()">Cancel</button>
            <button class="btn btn-primary" id="btn-eq-audit-create-confirm" style="background:linear-gradient(135deg,#059669 0%,#047857 100%);border:none;font-weight:700;" onclick="window.equipmentAuditsEngine.confirmCreateCampaign()">
              ✨ Generate Audit Links (${this._modalSelectedIdx.size})
            </button>
          </div>
        </div>
      </div>
    `;

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    document.body.appendChild(modal);
    this.renderCreateModalList();
  }

  getFilteredModalLeaderIndices() {
    const crews = this._pendingCrewsForModal || [];
    const roleFilter = this._modalRoleFilter || 'all';
    const q = String(this._modalSearchText || '').trim().toLowerCase();
    const out = [];
    crews.forEach((c, idx) => {
      if (roleFilter === 'foremen' && c.role !== 'F' && c.role !== 'GTO F') return;
      if (roleFilter === 'GF' && c.role !== 'GF') return;
      if (roleFilter === 'SUP' && c.role !== 'SUP') return;
      if (roleFilter === 'SHOP' && !c.isShopPool) return;
      if (q) {
        const hay = `${c.foreman} ${c.role} ${c.jobNumber} ${c.jobName} ${c.location}`.toLowerCase();
        if (!hay.includes(q)) return;
      }
      out.push(idx);
    });
    return out;
  }

  renderCreateModalList() {
    const listEl = document.getElementById('eq-audit-modal-list');
    if (!listEl) return;
    const crews = this._pendingCrewsForModal || [];
    const indices = this.getFilteredModalLeaderIndices();
    const sel = this._modalSelectedIdx || new Set();

    const roleBadgeHtml = (role) => {
      if (role === 'SHOP') return '<span style="font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;background:rgba(20,184,166,0.2);border:1px solid rgba(45,212,191,0.5);color:#5eead4;">SHOP STOCK</span>';
      if (role === 'SUP') return '<span style="font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;background:rgba(168,85,247,0.2);border:1px solid rgba(168,85,247,0.45);color:#d8b4fe;">SUP</span>';
      if (role === 'GF') return '<span style="font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;background:rgba(249,115,22,0.2);border:1px solid rgba(249,115,22,0.45);color:#fdba74;">GF</span>';
      return `<span style="font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;background:rgba(59,130,246,0.2);border:1px solid rgba(59,130,246,0.45);color:#93c5fd;">${this.escapeHtml(role || 'F')}</span>`;
    };

    if (indices.length === 0) {
      listEl.innerHTML = `<div style="padding:24px;text-align:center;color:#94a3b8;font-size:13px;">No matching Foremen, GF, SUP, or Shop Stock pools found.</div>`;
    } else {
      listEl.innerHTML = indices.map((idx) => {
        const c = crews[idx];
        const isChecked = sel.has(idx);
        const subtitle = c.isShopPool
          ? `${this.escapeHtml(c.jobName)} • ${c.shopItemCount || 0} items currently logged`
          : `${this.escapeHtml(c.location || 'No Location')}${c.jobName ? ` • ${this.escapeHtml(c.jobName)}` : ''} • ${c.employees.length === 1 ? '1 crew member' : `${c.employees.length} crew members`}`;
        return `
          <label style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid rgba(148,163,184,0.12);cursor:pointer;${c.isShopPool ? 'background:rgba(20,184,166,0.06);' : ''}">
            <input type="checkbox" class="eq-audit-crew-chk" data-crew-idx="${idx}" ${isChecked ? 'checked' : ''} onchange="window.equipmentAuditsEngine.toggleModalLeader(${idx}, this.checked)">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:700;color:#f8fafc;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span>${c.icon ? `${c.icon} ` : ''}${this.escapeHtml(c.foreman)}</span>
                ${roleBadgeHtml(c.role)}
                ${!c.isShopPool && c.jobNumber ? `<span style="color:#60a5fa;font-weight:600;">(${this.escapeHtml(c.jobNumber)})</span>` : ''}
                ${!c.isShopPool && c.status && c.status.toLowerCase() !== 'active' ? `<span style="font-size:10px;color:#fbbf24;">• ${this.escapeHtml(c.status)}</span>` : ''}
              </div>
              <div style="font-size:11.5px;color:#94a3b8;margin-top:1px;">
                ${subtitle}
              </div>
            </div>
            <div style="text-align:right;font-size:11px;color:#94a3b8;flex-shrink:0;">
              <div>${c.phone ? `📱 ${this.escapeHtml(c.phone)}` : '<span style="color:#f87171;">No phone</span>'}</div>
              <div>${c.email ? `📧 ${this.escapeHtml(c.email)}` : '<span style="color:#fbbf24;">No email</span>'}</div>
            </div>
          </label>
        `;
      }).join('');
    }

    const selectAllChk = document.getElementById('eq-audit-select-all-crews');
    const selectAllLabel = document.getElementById('eq-audit-select-all-label');
    if (selectAllChk) {
      selectAllChk.checked = indices.length > 0 && indices.every((i) => sel.has(i));
    }
    if (selectAllLabel) {
      selectAllLabel.textContent = `Select All Shown (${indices.length})`;
    }
    const summaryEl = document.getElementById('eq-audit-selected-summary');
    if (summaryEl) summaryEl.textContent = `${sel.size} selected`;
    const confirmBtn = document.getElementById('btn-eq-audit-create-confirm');
    if (confirmBtn && !confirmBtn.disabled) {
      confirmBtn.textContent = `✨ Generate Audit Links (${sel.size})`;
    }

    document.querySelectorAll('.eq-role-pill').forEach((btn) => {
      const active = btn.dataset.role === (this._modalRoleFilter || 'all');
      btn.classList.toggle('btn-primary', active);
      btn.classList.toggle('btn-secondary', !active);
    });
  }

  setCreateModalRoleFilter(role) {
    this._modalRoleFilter = role || 'all';
    this.renderCreateModalList();
  }

  setCreateModalSearch(val) {
    this._modalSearchText = String(val || '');
    this.renderCreateModalList();
  }

  toggleModalLeader(idx, checked) {
    if (!this._modalSelectedIdx) this._modalSelectedIdx = new Set();
    if (checked) this._modalSelectedIdx.add(idx);
    else this._modalSelectedIdx.delete(idx);
    this.renderCreateModalList();
  }

  toggleSelectAllModalLeaders(checked) {
    if (!this._modalSelectedIdx) this._modalSelectedIdx = new Set();
    const indices = this.getFilteredModalLeaderIndices();
    indices.forEach((i) => {
      if (checked) this._modalSelectedIdx.add(i);
      else this._modalSelectedIdx.delete(i);
    });
    this.renderCreateModalList();
  }

  async confirmCreateCampaign() {
    const crews = this._pendingCrewsForModal || [];
    const checkedIdx = Array.from(this._modalSelectedIdx || []).filter((i) => crews[i]);
    if (checkedIdx.length === 0) {
      this.toast('Select at least one foreman, GF, or SUP.', 'error');
      return;
    }

    const campaignName = (document.getElementById('eq-audit-campaign-name')?.value || 'Crew Equipment Audit').trim();
    const expireDays = parseInt(document.getElementById('eq-audit-expire-days')?.value || '14', 10) || 14;
    const notes = (document.getElementById('eq-audit-notes')?.value || '').trim();
    const expiresAt = new Date(Date.now() + expireDays * 86400000).toISOString();
    const createdBy = (window.supabaseSync && window.supabaseSync.userName) || 'Cody Bechdol';

    const btn = document.getElementById('btn-eq-audit-create-confirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating Links...'; }

    const rows = checkedIdx.map((i) => {
      const c = crews[i];
      return {
        token: this.generateSecureToken(),
        campaign_name: campaignName,
        foreman_name: c.foreman,
        job_number: c.jobNumber,
        job_name: c.jobName || '',
        location: c.location || '',
        foreman_phone: c.phone || '',
        foreman_email: c.email || '',
        crew_employees: c.employees || [],
        status: 'not_sent',
        notes,
        expires_at: expiresAt,
        created_by: createdBy
      };
    });

    try {
      await this.sbRequest('/rest/v1/sa_audit_requests', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: rows
      });
      document.getElementById('eq-audit-create-modal')?.remove();
      this.toast(`✅ Generated ${rows.length} private foreman audit ${rows.length === 1 ? 'link' : 'links'}!`, 'success');
      await this.refreshData();
    } catch (err) {
      console.error('[EquipmentAudits] create failed:', err);
      this.toast(`❌ Failed to create audit links: ${err.message}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '✨ Generate Audit Links'; }
    }
  }

  // ---------------------------------------------------------------------------
  // Form URL Settings & Cloudflare Pages Helper Modal
  // ---------------------------------------------------------------------------
  openFormSettingsModal() {
    const existing = document.getElementById('eq-audit-settings-modal');
    if (existing) existing.remove();
    const curUrl = this.getFormBaseUrl();

    const modal = document.createElement('div');
    modal.id = 'eq-audit-settings-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:15000;background:rgba(2,6,23,0.78);display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:auto;';
    modal.innerHTML = `
      <div style="width:100%;max-width:560px;background:#0f172a;border:1px solid rgba(59,130,246,0.45);border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.6);">
        <div style="padding:14px 18px;background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%);display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-size:15px;font-weight:800;color:#fff;">⚙️ Foreman Audit Form Settings</h3>
          <button style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer;" onclick="document.getElementById('eq-audit-settings-modal').remove()">&times;</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:14px;">
          <div>
            <label style="display:block;font-size:11.5px;font-weight:700;color:#93c5fd;margin-bottom:5px;">HOSTED FORM BASE URL (CLOUDFLARE PAGES)</label>
            <input type="url" id="eq-audit-base-url-input" class="sheet-search" style="width:100%;font-size:13px;" value="${this.escapeHtml(curUrl)}" placeholder="https://crew-equipment-audit.pages.dev">
            <div style="font-size:11.5px;color:#94a3b8;margin-top:5px;">
              Deploy the <code>audit-form</code> folder in your repo to Cloudflare Pages (free, works with private GitHub repos), then paste your <code>https://...pages.dev</code> URL here.
            </div>
          </div>
          <div style="padding:12px;border-radius:8px;background:rgba(30,41,59,0.7);border:1px solid rgba(148,163,184,0.2);font-size:12px;color:#cbd5e1;line-height:1.5;">
            <strong>Cloudflare Pages Setup (2 minutes):</strong><br>
            1. Go to <strong>dash.cloudflare.com → Workers &amp; Pages → Create → Pages → Connect to Git</strong>.<br>
            2. Select your <code>safety-assistant</code> (Safety Assistant) repository.<br>
            3. Leave Build Command blank, set <strong>Build output directory</strong> to <code>audit-form</code>, and click <strong>Save and Deploy</strong>.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-secondary" style="font-size:12px;" onclick="window.equipmentAuditsEngine.copySetupSql()">📋 Copy Supabase Audit SQL</button>
            ${curUrl ? `<button class="btn btn-secondary" style="font-size:12px;color:#6ee7b7;" onclick="window.open('${this.escapeHtml(curUrl)}?demo=1','_blank')">👁️ Open Form Preview</button>` : ''}
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border-color);display:flex;justify-content:flex-end;gap:8px;">
          <button class="btn btn-secondary" onclick="document.getElementById('eq-audit-settings-modal').remove()">Cancel</button>
          <button class="btn btn-primary" onclick="window.equipmentAuditsEngine.saveFormSettings()">💾 Save URL</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  saveFormSettings() {
    const val = (document.getElementById('eq-audit-base-url-input')?.value || '').trim();
    if (val && !/^https?:\/\//i.test(val)) {
      this.toast('Please enter a full URL starting with https://', 'error');
      return;
    }
    this.setFormBaseUrl(val);
    document.getElementById('eq-audit-settings-modal')?.remove();
    this.toast('✅ Saved Foreman Audit Form URL!', 'success');
    this.render();
  }

  // ---------------------------------------------------------------------------
  // Delivery Actions (SMS, Email via Apps Script GmailApp, Copy Link)
  // ---------------------------------------------------------------------------
  ensureFormUrlOrPrompt() {
    const base = this.getFormBaseUrl();
    if (!base) {
      this.toast('⚠️ Set your Cloudflare Pages Form URL first in Form URL & Setup.', 'error');
      this.openFormSettingsModal();
      return false;
    }
    return true;
  }

  async markRequestSent(requestId, channel) {
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) return;
    const prevVia = String(req.sent_via || '');
    const viaSet = new Set(prevVia ? prevVia.split('+').filter(Boolean) : []);
    viaSet.add(channel);
    const nextVia = Array.from(viaSet).join('+');
    const nextStatus = req.status === 'not_sent' ? 'sent' : req.status;
    const nowIso = new Date().toISOString();

    try {
      await this.sbRequest(`/rest/v1/sa_audit_requests?id=eq.${encodeURIComponent(requestId)}`, {
        method: 'PATCH',
        body: { sent_via: nextVia, sent_at: nowIso, status: nextStatus, updated_at: nowIso }
      });
      req.sent_via = nextVia;
      req.sent_at = nowIso;
      req.status = nextStatus;
      this.render();
    } catch (err) {
      console.warn('Could not update sent status:', err);
    }
  }

  sendViaSms(requestId) {
    if (!this.ensureFormUrlOrPrompt()) return;
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) return;
    const url = this.buildAuditLink(req.token);

    if (window.smsDialogEngine && typeof window.smsDialogEngine.openEquipmentAuditSms === 'function') {
      window.smsDialogEngine.openEquipmentAuditSms(req, url, () => {
        this.markRequestSent(requestId, 'sms');
      });
    } else {
      const firstName = String(req.foreman_name || '').split(' ')[0] || 'there';
      const msg = `Hi ${firstName}, please fill out your crew equipment inventory audit using your personal link (saves progress automatically, works on iPad or phone): ${url}`;
      const cleanPhone = String(req.foreman_phone || '').replace(/[^0-9]/g, '');
      window.location.href = `sms:${cleanPhone.length === 10 ? '1' + cleanPhone : cleanPhone}?body=${encodeURIComponent(msg)}`;
      this.markRequestSent(requestId, 'sms');
    }
  }

  async sendViaEmail(requestId, options = { silentSuccess: false }) {
    if (!this.ensureFormUrlOrPrompt()) return { success: false };
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) return { success: false };
    const url = this.buildAuditLink(req.token);

    let email = String(req.foreman_email || '').trim();
    if (!email && !options.silentSuccess) {
      const entered = window.prompt(`No email address on file for ${req.foreman_name}.\nEnter email address to send the audit link to:`, '');
      if (!entered || !entered.trim()) return { success: false };
      email = entered.trim();
      req.foreman_email = email;
      this.sbRequest(`/rest/v1/sa_audit_requests?id=eq.${encodeURIComponent(req.id)}`, {
        method: 'PATCH',
        body: { foreman_email: email }
      }).catch(() => {});
    }
    if (!email) return { success: false, error: 'Missing email' };

    const firstName = String(req.foreman_name || '').split(' ')[0] || 'Foreman';
    const dueStr = req.expires_at ? this.formatDateOnly(req.expires_at) : '';
    const subject = `Equipment Inventory Audit — Job ${req.job_number || req.foreman_name}`;

    // 1. Try Apps Script GmailApp endpoint first (1-click automatic delivery!)
    if (window.syncEngine && typeof window.syncEngine.executeNetworkRequest === 'function') {
      try {
        const res = await window.syncEngine.executeNetworkRequest(window.syncEngine.getSyncUrl(), 'POST', {
          action: 'sendAuditEmail',
          to: email,
          foremanName: req.foreman_name,
          firstName,
          jobNumber: req.job_number || '',
          location: req.location || '',
          campaignName: req.campaign_name || 'Crew Equipment Inventory Audit',
          auditUrl: url,
          dueDate: dueStr,
          notes: req.notes || ''
        }, 25000);

        if (res && (res.success || res.status === 'ok')) {
          await this.markRequestSent(requestId, 'email');
          if (!options.silentSuccess) {
            this.toast(`📧 Sent audit email to ${req.foreman_name} (${email})!`, 'success');
          }
          return { success: true };
        }
      } catch (err) {
        console.warn('[EquipmentAudits] Apps Script email fallback to mailto:', err);
      }
    }

    // 2. Clean mailto: fallback if Apps Script hasn't been pushed yet or offline
    if (!options.silentSuccess) {
      const plainBody = [
        `Hi ${firstName},`,
        '',
        `Please complete your Crew Equipment Inventory Audit for Job ${req.job_number || 'your crew'} using your personal link below:`,
        '',
        url,
        '',
        'You do not need to download any app or log in — it opens right in Safari or Chrome on your iPad or phone. Your progress saves automatically so you can pause and come back to the same link over multiple days, even in areas without reception once opened.',
        dueStr ? `\nPlease submit by ${dueStr}.` : '',
        req.notes ? `\nNote: ${req.notes}` : '',
        '',
        'Thank you!'
      ].join('\n');
      window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plainBody)}`;
      await this.markRequestSent(requestId, 'email');
      this.toast(`📧 Opened email draft for ${req.foreman_name}`, 'success');
      return { success: true, viaMailto: true };
    }
    return { success: false, error: 'Apps Script email failed' };
  }

  async batchSendEmails() {
    if (!this.ensureFormUrlOrPrompt()) return;
    const ids = Array.from(this.selectedRequestIds);
    const targets = ids.map((id) => this.requests.find((r) => r.id === id)).filter((r) => r && r.foreman_email);
    const missingEmail = ids.length - targets.length;
    if (targets.length === 0) {
      this.toast('None of the selected foremen have an email address on file.', 'error');
      return;
    }
    if (!window.confirm(`Send personalized equipment audit emails via Gmail to ${targets.length} foreman(s)?${missingEmail > 0 ? `\n(${missingEmail} selected foreman(s) without an email will be skipped.)` : ''}`)) {
      return;
    }

    let sent = 0;
    let failed = 0;
    this.toast(`📧 Sending ${targets.length} emails...`);
    for (const req of targets) {
      const r = await this.sendViaEmail(req.id, { silentSuccess: true });
      if (r && r.success) sent++;
      else failed++;
    }
    this.selectedRequestIds.clear();
    this.render();
    this.toast(`📧 Batch complete: ${sent} sent${failed > 0 ? `, ${failed} failed (push Apps Script first)` : ''}.`, failed > 0 ? 'warning' : 'success');
  }

  copyRequestLink(requestId) {
    if (!this.ensureFormUrlOrPrompt()) return;
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) return;
    const url = this.buildAuditLink(req.token);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        this.toast(`📋 Copied personal link for ${req.foreman_name}!`, 'success');
        if (req.status === 'not_sent') this.markRequestSent(requestId, 'link');
      });
    }
  }

  async reopenAudit(requestId) {
    if (!window.confirm('Unlock this submitted audit so the foreman can add or edit items using the same link?')) return;
    const nowIso = new Date().toISOString();
    const extendedExp = new Date(Date.now() + 7 * 86400000).toISOString();
    try {
      await this.sbRequest(`/rest/v1/sa_audit_requests?id=eq.${encodeURIComponent(requestId)}`, {
        method: 'PATCH',
        body: { status: 'in_progress', reopened_at: nowIso, expires_at: extendedExp, updated_at: nowIso }
      });
      this.toast('🔓 Audit link unlocked and extended 7 days!', 'success');
      await this.refreshData();
    } catch (err) {
      this.toast(`❌ Could not reopen audit: ${err.message}`, 'error');
    }
  }

  async deleteAuditRequest(requestId) {
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) return;
    if (!window.confirm(`Permanently delete the audit request for ${req.foreman_name} (${req.job_number})?`)) return;
    try {
      await this.sbRequest(`/rest/v1/sa_audit_requests?id=eq.${encodeURIComponent(requestId)}`, { method: 'DELETE' });
      this.selectedRequestIds.delete(requestId);
      if (this.activeReviewRequestId === requestId) this.activeReviewRequestId = null;
      this.toast('🗑️ Deleted audit request.');
      await this.refreshData();
    } catch (err) {
      this.toast(`❌ Delete failed: ${err.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // TAB 2: Automated 5-Bucket Reconciliation Engine
  // ---------------------------------------------------------------------------
  openReview(requestId) {
    this.activeReviewRequestId = requestId;
    this.activeTab = 'review';
    this.reviewBucketFilter = 'actionable';
    this.reviewCategoryFilter = 'all';
    this.render();
  }

  normId(val) {
    return String(val || '').trim().replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
  }

  isMissingDateValue(val) {
    const s = String(val || '').trim().toLowerCase();
    return s === 'none' || s === 'no sticker' || s === 'no date' || s === 'missing' || s === 'unknown';
  }

  isUnnumberedPlaceholderId(val) {
    const s = String(val || '').trim().replace(/^#/, '');
    if (!s) return false;
    return /^n\s*\/?\s*a(?:[-\s#_]*\d*)?$/i.test(s);
  }

  getNextSequentialUnnumberedId(catKey, extraReservedNormIds = null) {
    const table = this.db ? this.db.getTable(catKey) : null;
    const rows = (table && Array.isArray(table.rows)) ? table.rows : [];
    const headers = (table && Array.isArray(table.headers)) ? table.headers : [];
    const usedNorm = new Set(extraReservedNormIds || []);
    let maxNum = 0;

    const inspectId = (rawId) => {
      const s = String(rawId || '').trim().replace(/^#/, '');
      if (!s) return;
      usedNorm.add(this.normId(s));
      const m = s.match(/^n\s*\/?\s*a[-\s#_]*(\d+)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
    };

    rows.forEach((r) => inspectId(this.getRowPrimaryId(catKey, r, headers)));
    if (extraReservedNormIds) {
      extraReservedNormIds.forEach((id) => inspectId(id));
    }

    let next = maxNum + 1;
    let candidate = `NA-${String(next).padStart(3, '0')}`;
    while (usedNorm.has(this.normId(candidate))) {
      next++;
      candidate = `NA-${String(next).padStart(3, '0')}`;
    }
    return candidate;
  }

  matchesUnnumberedPhysicalSpecs(catKey, rep, appRow, isShopPool) {
    const eq = (a, b, norm) => {
      const sa = (a === null || a === undefined) ? '' : String(a).trim();
      const sb = (b === null || b === undefined) ? '' : String(b).trim();
      if (!sa || !sb) return true;
      return norm ? norm(sa) === norm(sb) : sa.toLowerCase() === sb.toLowerCase();
    };
    if (catKey === 'hot_sticks') {
      return eq(rep.type, appRow['Type']) && eq(rep.length, appRow['Length'], (v) => this.normLength(v));
    }
    if (catKey === 'grounds') {
      return eq(rep.type, appRow['Type']) &&
        (rep.type === 'OH' ? eq(rep.size, appRow['Size']) : eq(rep.kv, appRow['KV'], (v) => this.normKv(v))) &&
        eq(rep.length, appRow['Length'], (v) => this.normLength(v));
    }
    if (catKey === 'blankets') {
      return eq(rep.type, appRow['Type']) &&
        eq(rep.itemClass, appRow['Class'], (v) => String(v).replace(/class\s*/i, '').trim());
    }
    if (catKey === 'macks') {
      return eq(rep.kv, appRow['KV'], (v) => this.normKv(v)) &&
        eq(rep.size, appRow['Size']) &&
        eq(rep.length, appRow['Length'], (v) => this.normLength(v));
    }
    if (catKey === 'gloves' || catKey === 'sleeves') {
      const empOk = isShopPool ? true : eq(rep.employeeName, appRow['Assigned To'], (v) => this.normPerson(v));
      return empOk &&
        eq(rep.size, appRow['Size'], catKey === 'sleeves' ? (v) => this.normSleeveSize(v) : (v) => String(parseFloat(v) || v).toLowerCase()) &&
        eq(rep.itemClass, appRow['Class'], (v) => String(v).replace(/class\s*/i, '').trim());
    }
    if (catKey === 'hv_testers' || catKey === 'phasing_sets') {
      return eq(rep.model, appRow['Model']) && eq(rep.kv, appRow['KV'], (v) => this.normKv(v));
    }
    if (catKey === 'aed') {
      return eq(rep.model, appRow['Model']);
    }
    return false;
  }

  normDate(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (!s || s.toUpperCase() === 'N/A') return '';
    if (this.isMissingDateValue(s)) return 'none';
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return s.toLowerCase();
  }

  toSheetDate(isoOrDate) {
    if (this.isMissingDateValue(isoOrDate)) return 'None';
    const iso = this.normDate(isoOrDate);
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
    return String(isoOrDate || '').trim();
  }

  normLength(val) {
    const s = String(val || '').trim().toLowerCase();
    if (!s) return '';
    return s.replace(/\s*(feet|foot|ft\.?|')\s*/g, "'").replace(/\s+/g, '');
  }

  normKv(val) {
    const s = String(val || '').trim().toLowerCase();
    if (!s) return '';
    return s.replace(/\s+/g, '').replace(/kv$/, '');
  }

  normSleeveSize(val) {
    const s = String(val || '').trim().toLowerCase();
    if (['xl', 'x-l', 'xlarge', 'x-large', 'extra large', 'extralarge'].includes(s)) return 'x-large';
    if (['l', 'lg', 'large'].includes(s)) return 'large';
    if (['reg', 'regular', 'm', 'med', 'medium'].includes(s)) return 'regular';
    return s;
  }

  getEmployeeAliasMap() {
    const snap = this.db ? this.db.getSnapshot() : null;
    const emps = (snap && snap.tables && snap.tables.employees && snap.tables.employees.rows) || [];
    const map = new Map();
    const normRaw = (s) => String(s || '').trim().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').toLowerCase();

    emps.forEach((r) => {
      const canonical = String(r['Employee Name'] || r['Name'] || '').trim();
      const canonicalNorm = normRaw(canonical);
      if (!canonicalNorm) return;
      map.set(canonicalNorm, canonicalNorm);

      let altRaw = '';
      for (const [k, v] of Object.entries(r)) {
        if (/^(alt(ernat(e|ive))?(\s*names?)?(\s*\/\s*aliases?)?|also\s*known\s*as|aka|aliases?)$/i.test(String(k || '').trim())) {
          const sv = String(v || '').trim();
          if (sv) {
            altRaw = altRaw ? `${altRaw},${sv}` : sv;
          }
        }
      }
      if (altRaw) {
        altRaw.split(/[;,/]+/).forEach((alt) => {
          const altNorm = normRaw(alt);
          if (altNorm && !map.has(altNorm)) {
            map.set(altNorm, canonicalNorm);
          }
        });
      }
    });
    return map;
  }

  normPerson(val) {
    const raw = String(val || '').trim();
    if (!raw) return '';
    const clean = raw.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    const cleanLower = clean.toLowerCase();

    // 1. Primary: use EmployeeNameResolver (handles Alternate Names / Aliases, nicknames like Chris<->Christian, initials, hyphenated names)
    if (typeof window !== 'undefined' && window.employeeResolver) {
      try {
        if (typeof window.employeeResolver.resolve === 'function') {
          const res = window.employeeResolver.resolve(clean);
          if (res && res.match && !res.isStatus && res.canonicalName) {
            return String(res.canonicalName).trim().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').toLowerCase();
          }
        } else if (typeof window.employeeResolver.getCanonicalName === 'function') {
          const resolved = window.employeeResolver.getCanonicalName(clean);
          if (resolved) return String(resolved).trim().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').toLowerCase();
        }
      } catch { /* ignore */ }
    }

    // 2. Fallback: direct Alternate Names / Aliases lookup from Employees table
    const aliasMap = this._cachedAliasMap || this.getEmployeeAliasMap();
    if (aliasMap && aliasMap.has(cleanLower)) {
      return aliasMap.get(cleanLower);
    }

    return cleanLower;
  }

  normVehicleId(val) {
    const raw = String(val || '').trim();
    if (!raw) return '';
    // Strip leading Unit / Truck / Veh / Rig / Shack / # prefix for unit numbers (e.g., "Unit 2108" -> "2108", "Unit X104" -> "x104")
    const m = raw.match(/^(?:unit|truck|veh(?:icle)?|equip(?:ment)?|rig|shack|job\s*shack|trailer|t-)?\s*#?\s*(x?\d+[a-z]?)$/i);
    if (m) return m[1].toLowerCase();
    return raw.replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
  }

  formatCanonicalVehicleId(rawVal, jobNumber = '') {
    const raw = String(rawVal || '').trim();
    if (!raw || /^job\s*shack$/i.test(raw)) {
      return jobNumber ? `Job Shack (${jobNumber})` : 'Job Shack';
    }
    const m = raw.match(/^(?:unit|truck|veh(?:icle)?|equip(?:ment)?|rig|shack|job\s*shack|trailer|t-)?\s*#?\s*(x?\d+[a-z]?)$/i);
    if (m) return m[1].toUpperCase();
    return raw;
  }

  isVehicleReplacementFlagged(catKey, reported) {
    if (!reported) return false;
    if (catKey === 'fire_extinguishers') {
      const cond = String(reported.condition || 'In Service').trim().toLowerCase();
      return reported.needsReplacement === true || cond !== 'in service' || this.isMissingDateValue(reported.testDate);
    }
    if (catKey === 'first_aid_kits') {
      const cond = String(reported.condition || 'Stocked / OK').trim().toLowerCase();
      return reported.needsReplacement === true || (cond !== 'stocked / ok' && cond !== 'ok' && cond !== 'good');
    }
    return false;
  }

  getRowPrimaryId(catKey, row, headers) {
    const firstH = (headers && headers[0]) || '';
    const candidates = [
      firstH ? row[firstH] : '',
      row['Vehicle / Equipment #'], row['Item #'], row['Glove'], row['Sleeve'], row['Blanket'], row['MACK'],
      row['HVT #'], row['HV Tester'], row['Phasing Set'], row['PS #'],
      row['AED'], row['AED #'], row['Serial #'], row['Ground #'], row['Hot Stick']
    ];
    for (const c of candidates) {
      const s = String(c || '').trim();
      if (s) return s;
    }
    return '';
  }

  isRowActiveOnCrew(row, crewNamesSet) {
    const status = String(row['Status'] || '').trim().toLowerCase();
    const assigned = String(row['Assigned To'] || '').trim();
    const assignedLower = assigned.toLowerCase();
    const inactiveStatuses = ['on shelf', 'in testing', 'lost', 'destroyed', 'failed rubber', 'not repairable', 'reclaimed', 'retired', 'ready for delivery', 'ready for test', 'packed for testing', 'packed for delivery'];
    if (inactiveStatuses.includes(status) || inactiveStatuses.includes(assignedLower)) return false;
    return crewNamesSet.has(this.normPerson(assigned));
  }

  getCrewMatchNamesSet(req) {
    const set = new Set();
    if (req.foreman_name) set.add(this.normPerson(req.foreman_name));
    (Array.isArray(req.crew_employees) ? req.crew_employees : []).forEach((n) => {
      if (n) set.add(this.normPerson(n));
    });
    // Also include current live employees on that job number
    const snap = this.db ? this.db.getSnapshot() : null;
    const emps = (snap && snap.tables && snap.tables.employees && snap.tables.employees.rows) || [];
    const jobBase = this.getBaseJobNumber(req.job_number || '').toLowerCase();
    if (jobBase) {
      emps.forEach((e) => {
        const ejBase = this.getBaseJobNumber(e['Job Number'] || e['Job #'] || '').toLowerCase();
        const secBase = this.getBaseJobNumber(e['Secondary Job Number'] || '').toLowerCase();
        if (ejBase === jobBase || secBase === jobBase) {
          const nm = String(e['Employee Name'] || e['Name'] || '').trim();
          if (nm) set.add(this.normPerson(nm));
        }
      });
    }
    return set;
  }

  isPackedForDeliveryPool(shopPool) {
    return Boolean(shopPool && shopPool.jobNumber === 'SHOP-PACKED-DELIVERY');
  }

  getSwapTableKeyForCategory(catKey) {
    const map = {
      gloves: 'glove_swaps',
      sleeves: 'sleeve_swaps',
      blankets: 'blanket_swaps',
      macks: 'mack_swaps',
      hv_testers: 'hv_tester_swaps',
      phasing_sets: 'phasing_set_swaps',
      aed: 'aed_swaps',
      grounds: 'ground_swaps',
      hot_sticks: 'hot_stick_swaps'
    };
    return map[catKey] || null;
  }

  getSwapSheetLabel(catKey) {
    const map = {
      gloves: 'Glove Swaps',
      sleeves: 'Sleeve Swaps',
      blankets: 'Blanket Swaps',
      macks: 'MACK Swaps',
      hv_testers: 'HV Tester Swaps',
      phasing_sets: 'Phasing Set Swaps',
      aed: 'AED Swaps',
      grounds: 'Ground Swaps',
      hot_sticks: 'Hot Stick Swaps'
    };
    return map[catKey] || 'Swaps';
  }

  extractPickedForName(rawVal) {
    const raw = String(rawVal || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (lower.includes('reclaim') || lower === 'packed for testing' || lower === 'ready for test') return '';
    return raw
      .replace(/\s+picked\s+on\s+.*$/i, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim();
  }

  getReportedPackedFor(catKey, reported) {
    if (!reported) return '';
    const ignore = new Set([
      'packed for delivery', 'ready for delivery', 'on shelf',
      'in testing', 'packed for testing', 'ready for test'
    ]);
    const pf = String(reported.packedFor || '').trim();
    if (pf && !ignore.has(pf.toLowerCase())) return pf;
    if (catKey === 'gloves' || catKey === 'sleeves') {
      const emp = String(reported.employeeName || '').trim();
      if (emp && !ignore.has(emp.toLowerCase())) return emp;
    }
    return '';
  }

  resolveCanonicalEmployeeName(rawName) {
    const clean = String(rawName || '').trim();
    if (!clean) return '';
    if (typeof window !== 'undefined' && window.employeeResolver) {
      try {
        if (typeof window.employeeResolver.resolve === 'function') {
          const res = window.employeeResolver.resolve(clean);
          if (res && res.match && !res.isStatus && res.canonicalName) {
            return String(res.canonicalName).trim();
          }
        }
      } catch { /* ignore */ }
    }
    const targetNorm = this.normPerson(clean);
    const snap = this.db ? this.db.getSnapshot() : null;
    const emps = (snap && snap.tables && snap.tables.employees && snap.tables.employees.rows) || [];
    for (const r of emps) {
      const nm = String(r['Employee Name'] || r['Name'] || '').trim();
      if (nm && this.normPerson(nm) === targetNorm) return nm;
    }
    return clean;
  }

  getSwapRowMeta(swapRow) {
    if (!swapRow || typeof swapRow !== 'object') return null;
    const empName = String(swapRow['Employee'] || swapRow['Crew Lead / Employee'] || '').trim();
    const currentItemNum = String(
      swapRow['Current Glove #'] || swapRow['Current Sleeve #'] || swapRow['Current Blanket #'] ||
      swapRow['Current MACK #'] || swapRow['Current HV Tester #'] || swapRow['Current Phasing Set #'] ||
      swapRow['Current AED #'] || swapRow['Current Item #'] || swapRow['Serial #'] || ''
    ).trim();
    const pickListNum = String(
      swapRow['Pick List Item #'] || swapRow['Pick List Glove #'] || swapRow['Pick List Sleeve #'] ||
      swapRow['Pick List Blanket #'] || swapRow['Pick List MACK #'] || swapRow['Pick List HV Tester #'] ||
      swapRow['Pick List Phasing Set #'] || swapRow['Pick List AED #'] || swapRow['Pick List Serial #'] ||
      swapRow['Pick List'] || ''
    ).trim();
    const status = String(swapRow['Status'] || '').trim();
    const statusLower = status.toLowerCase();
    const picked = swapRow['Picked'] === true || String(swapRow['Picked'] || '').trim().toUpperCase() === 'TRUE';
    const dateChanged = String(swapRow['Date Changed'] || '').trim();
    const daysLeft = String(swapRow['Days Left'] || '').trim().toUpperCase();
    const isDelivered = Boolean(dateChanged) || statusLower.includes('delivered');
    const isReclaimOrRetest = (
      statusLower.includes('return to shelf') ||
      statusLower.includes('needs retest') ||
      statusLower.includes('locate') ||
      daysLeft.includes('PREV EMP') ||
      daysLeft.includes('LOST') ||
      String(swapRow._location || '').toUpperCase() === 'PREVIOUS EMPLOYEE'
    );
    const isReadyForDelivery = !isDelivered && !isReclaimOrRetest && (picked || statusLower.includes('ready for delivery'));
    const hasValidPick = Boolean(pickListNum && pickListNum !== '—' && pickListNum !== '-');
    const itemClassRaw = String(swapRow['Class'] || '').replace(/class\s*/i, '').trim();
    return {
      empName,
      currentItemNum,
      pickListNum: hasValidPick ? pickListNum : '',
      status,
      picked,
      dateChanged,
      isDelivered,
      isReclaimOrRetest,
      isReadyForDelivery,
      hasValidPick,
      itemClass: itemClassRaw
    };
  }

  getSwapTableAndRows(catKey, tables = null) {
    const swapKey = this.getSwapTableKeyForCategory(catKey);
    if (!swapKey) return { swapKey: null, swapTable: null, rows: [] };
    const swapTable = (tables && tables[swapKey]) || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(swapKey) : null) || null;
    if (!swapTable) return { swapKey, swapTable: null, rows: [] };
    if ((!Array.isArray(swapTable.rows) || swapTable.rows.length === 0) && Array.isArray(swapTable.rawGrid) && swapTable.rawGrid.length > 1) {
      if (this.db && typeof this.db.reconstructSwapRowsFromRawGrid === 'function') {
        this.db.reconstructSwapRowsFromRawGrid(swapTable, swapKey);
      }
    }
    const skipNames = new Set([
      'employee', 'crew lead / employee', 'on shelf', 'in testing', 'packed for delivery',
      'packed for testing', 'ready for delivery', 'ready for test', 'lost', 'destroyed', ''
    ]);
    const rows = (Array.isArray(swapTable.rows) ? swapTable.rows : []).filter((r) => {
      const m = this.getSwapRowMeta(r);
      if (!m || !m.empName) return false;
      const lower = m.empName.toLowerCase();
      if (skipNames.has(lower) || lower.includes('class ') || lower.includes('stage ') || m.empName.includes('📍') || m.empName.includes('👤') || m.empName.includes('👷')) {
        return false;
      }
      return true;
    });
    return { swapKey, swapTable, rows };
  }

  checkPackedItemAgainstSwaps(catKey, itemIds, packedFor, swapCtx, invRow = null, reported = null, invRows = []) {
    const swapSheetLabel = this.getSwapSheetLabel(catKey);
    const swapKey = swapCtx ? swapCtx.swapKey : this.getSwapTableKeyForCategory(catKey);
    const rows = (swapCtx && Array.isArray(swapCtx.rows)) ? swapCtx.rows : [];
    const targetIds = new Set((Array.isArray(itemIds) ? itemIds : [itemIds]).map((x) => this.normId(x)).filter(Boolean));
    const targetEmpNorm = this.normPerson(packedFor);

    const parseClassNum = (v) => {
      if (v === undefined || v === null || String(v).trim() === '') return null;
      const m = String(v).match(/\d+/);
      return m ? parseInt(m[0], 10) : null;
    };
    const targetClass = (catKey === 'gloves' || catKey === 'sleeves')
      ? parseClassNum(reported?.itemClass !== undefined && String(reported.itemClass).trim() !== '' ? reported.itemClass : invRow?.['Class'])
      : null;

    const getSwapRowClass = (meta) => {
      if (catKey !== 'gloves' && catKey !== 'sleeves') return null;
      if (meta.itemClass !== '') return parseClassNum(meta.itemClass);
      if (meta.currentItemNum && Array.isArray(invRows)) {
        const curNorm = this.normId(meta.currentItemNum);
        const foundCur = invRows.find((r) => this.normId(r['Item #'] || r['Glove'] || r['Sleeve'] || r['ESL ID']) === curNorm);
        if (foundCur) return parseClassNum(foundCur['Class']);
      }
      return null;
    };

    const activeRows = rows
      .map((sr) => ({ sr, meta: this.getSwapRowMeta(sr) }))
      .filter(({ meta }) => meta && !meta.isDelivered && !meta.isReclaimOrRetest);

    // 1. Check if this exact item # is already in any active Swap row's Pick List
    const byPick = activeRows.filter(({ meta }) => meta.hasValidPick && targetIds.has(this.normId(meta.pickListNum)));
    if (byPick.length > 0) {
      const sameEmp = byPick.find(({ meta }) => targetEmpNorm && this.normPerson(meta.empName) === targetEmpNorm);
      if (sameEmp) {
        if (sameEmp.meta.isReadyForDelivery) {
          return {
            ok: true,
            status: 'confirmed',
            swapKey,
            swapSheetLabel,
            swapRow: sameEmp.sr,
            swapMeta: sameEmp.meta,
            summary: `${swapSheetLabel} confirmed (Ready For Delivery for ${sameEmp.meta.empName})`
          };
        }
        return {
          ok: false,
          status: 'unpicked',
          swapKey,
          swapSheetLabel,
          swapRow: sameEmp.sr,
          swapMeta: sameEmp.meta,
          summary: `Listed on ${swapSheetLabel} for ${sameEmp.meta.empName}, but Picked / Ready For Delivery is NOT checked yet (${sameEmp.meta.status || 'In Stock'})`
        };
      }

      // Item is on the Swaps page, but assigned to a DIFFERENT employee!
      const wrong = byPick[0];
      const targetEmpOpenRow = targetEmpNorm ? activeRows.find(({ meta }) => {
        if (this.normPerson(meta.empName) !== targetEmpNorm) return false;
        if (targetClass !== null) {
          const sc = getSwapRowClass(meta);
          if (sc !== null && sc !== targetClass) return false;
        }
        return !meta.isReadyForDelivery || !meta.hasValidPick;
      }) : null;
      return {
        ok: false,
        status: 'wrong_employee',
        swapKey,
        swapSheetLabel,
        swapRow: wrong.sr,
        swapMeta: wrong.meta,
        targetEmpSwapRow: targetEmpOpenRow ? targetEmpOpenRow.sr : null,
        targetEmpSwapMeta: targetEmpOpenRow ? targetEmpOpenRow.meta : null,
        summary: `${swapSheetLabel} shows #${wrong.meta.pickListNum} ${wrong.meta.isReadyForDelivery ? 'picked' : 'listed'} for ${wrong.meta.empName} instead of ${packedFor}`
      };
    }

    // 2. Check if the packedFor employee has an open compatible Swap row with a different (or blank) Pick List item
    if (targetEmpNorm) {
      const empCandidates = activeRows.filter(({ meta }) => {
        if (this.normPerson(meta.empName) !== targetEmpNorm) return false;
        if (targetClass !== null) {
          const sc = getSwapRowClass(meta);
          if (sc !== null && sc !== targetClass) return false;
        }
        return true;
      });
      // Prefer an unpicked row or row with blank/different pick list
      const openRow = empCandidates.find(({ meta }) => !meta.isReadyForDelivery) || empCandidates[0] || null;
      if (openRow) {
        const pickDisplay = openRow.meta.hasValidPick ? `#${openRow.meta.pickListNum}` : '(none / Need to Purchase)';
        const curDisplay = openRow.meta.currentItemNum ? ` (Current #${openRow.meta.currentItemNum})` : '';
        return {
          ok: false,
          status: 'different_pick_item',
          swapKey,
          swapSheetLabel,
          swapRow: openRow.sr,
          swapMeta: openRow.meta,
          summary: `${openRow.meta.empName} has an open row on ${swapSheetLabel}${curDisplay}, but Pick List shows ${pickDisplay} instead of #${reported?.itemNum || ''}`
        };
      }
    }

    // 3. Not listed on the Swaps page at all
    return {
      ok: false,
      status: 'not_on_swaps',
      swapKey,
      swapSheetLabel,
      swapRow: null,
      swapMeta: null,
      summary: `Not listed on ${swapSheetLabel} for ${packedFor || 'this employee'}`
    };
  }

  compareItemFields(catKey, reported, appRow, options = {}) {
    const isShopPool = Boolean(options && options.isShopPool);
    const isPackedForDelivery = Boolean(options && options.isPackedForDelivery);
    const diffs = [];
    const check = (label, colName, repVal, appVal, normalizer, sheetValFormatter) => {
      const rStr = (repVal === null || repVal === undefined) ? '' : String(repVal).trim();
      if (!rStr) return; // Don't flag blank optional fields as discrepancy
      const aStr = (appVal === null || appVal === undefined) ? '' : String(appVal).trim();
      const rn = normalizer ? normalizer(rStr) : rStr.toLowerCase();
      const an = normalizer ? normalizer(aStr) : aStr.toLowerCase();
      if (rn !== an) {
        diffs.push({
          label,
          colName,
          appValue: aStr !== '' ? aStr : '(blank)',
          reportedValue: sheetValFormatter ? sheetValFormatter(rStr) : rStr,
          rawReported: rStr
        });
      }
    };

    if (isPackedForDelivery) {
      const repPackedFor = this.getReportedPackedFor(catKey, reported);
      if (repPackedFor) {
        const canonicalPacked = this.resolveCanonicalEmployeeName(repPackedFor);
        const appPickedRaw = String(appRow['Picked For'] || '').trim();
        const appPickedName = this.extractPickedForName(appPickedRaw);
        if (this.normPerson(canonicalPacked) !== this.normPerson(appPickedName)) {
          diffs.push({
            label: 'Picked For',
            colName: 'Picked For',
            appValue: appPickedName || (appPickedRaw || '(blank)'),
            reportedValue: `${canonicalPacked} Picked On ${this.getLocalTodayIso()}`,
            displayReportedValue: canonicalPacked,
            rawReported: canonicalPacked
          });
        }
      }
    }

    if (catKey === 'gloves' || catKey === 'sleeves') {
      if (!isShopPool) {
        check('Assigned To', 'Assigned To', reported.employeeName, appRow['Assigned To'], (v) => this.normPerson(v));
      }
      check('ESL ID', 'ESL ID', reported.eslId, appRow['ESL ID'], (v) => this.normId(v));
      check('Size', 'Size', reported.size, appRow['Size'], catKey === 'sleeves' ? (v) => this.normSleeveSize(v) : (v) => String(parseFloat(v) || v).toLowerCase());
      check('Class', 'Class', reported.itemClass, appRow['Class'], (v) => String(v).replace(/class\s*/i, '').trim());
      check('Test Date', 'Test Date', reported.testDate, appRow['Test Date'], (v) => this.normDate(v), (v) => this.toSheetDate(v));
    } else if (catKey === 'blankets') {
      check('Type', 'Type', reported.type, appRow['Type']);
      check('Class', 'Class', reported.itemClass, appRow['Class'], (v) => String(v).replace(/class\s*/i, '').trim());
      check('Test Date', 'Test Date', reported.testDate, appRow['Test Date'], (v) => this.normDate(v), (v) => this.toSheetDate(v));
    } else if (catKey === 'macks') {
      check('KV', 'KV', reported.kv, appRow['KV'], (v) => this.normKv(v));
      check('Size', 'Size', reported.size, appRow['Size']);
      check('Length', 'Length', reported.length, appRow['Length'], (v) => this.normLength(v));
      check('Test Date', 'Test Date', reported.testDate, appRow['Test Date'], (v) => this.normDate(v), (v) => this.toSheetDate(v));
    } else if (catKey === 'hv_testers' || catKey === 'phasing_sets') {
      check('Model', 'Model', reported.model, appRow['Model']);
      check('KV', 'KV', reported.kv, appRow['KV'], (v) => this.normKv(v));
      check('Serial #', 'Serial #', reported.serialNum, appRow['Serial #'], (v) => this.normId(v));
      check('Calibration Date', 'Calibration Date', reported.calibrationDate, appRow['Calibration Date'], (v) => this.normDate(v), (v) => this.toSheetDate(v));
    } else if (catKey === 'aed') {
      check('Model', 'Model', reported.model, appRow['Model']);
      check('Serial #', 'Serial #', reported.serialNum, appRow['Serial #'], (v) => this.normId(v));
      check('Pad Expiration', 'Pad Expiration', reported.padExpiration, appRow['Pad Expiration'], (v) => this.normDate(v), (v) => this.toSheetDate(v));
      check('Battery Expiration', 'Battery Expiration', reported.batteryExpiration, appRow['Battery Expiration'], (v) => this.normDate(v), (v) => this.toSheetDate(v));
    } else if (catKey === 'grounds') {
      check('Type', 'Type', reported.type, appRow['Type']);
      if (reported.type === 'OH') check('Size', 'Size', reported.size, appRow['Size']);
      if (reported.type === 'UG') check('KV', 'KV', reported.kv, appRow['KV'], (v) => this.normKv(v));
      check('Length', 'Length', reported.length, appRow['Length'], (v) => this.normLength(v));
      check('Test Date', 'Test Date', reported.testDate, appRow['Test Date'], (v) => this.normDate(v), (v) => this.toSheetDate(v));
    } else if (catKey === 'hot_sticks') {
      check('Type', 'Type', reported.type, appRow['Type']);
      check('Length', 'Length', reported.length, appRow['Length'], (v) => this.normLength(v));
      check('Test Date', 'Test Date', reported.testDate, appRow['Test Date'], (v) => this.normDate(v), (v) => this.toSheetDate(v));
    } else if (catKey === 'fire_extinguishers') {
      check('Size', 'Size', reported.size, appRow['Size']);
      check('Status', 'Status', reported.condition || 'In Service', appRow['Status']);
      if (reported.condition !== 'Missing') {
        check('Test Date', 'Test Date', reported.testDate, appRow['Test Date'], (v) => this.normDate(v), (v) => this.toSheetDate(v));
      }
    } else if (catKey === 'first_aid_kits') {
      check('Status', 'Status', reported.condition || 'Stocked / OK', appRow['Status']);
    }
    return diffs;
  }

  reconcileAudit(req, sub) {
    this._cachedAliasMap = this.getEmployeeAliasMap();
    const payload = (sub && (sub.submitted_payload || sub.draft_payload)) || {};
    const itemsByCat = (payload && payload.items) || {};
    const shopPool = this.getShopAuditPoolConfig(req);
    const isPackedForDelivery = this.isPackedForDeliveryPool(shopPool);
    const crewNames = shopPool ? new Set() : this.getCrewMatchNamesSet(req);
    const isRowInScope = (row) => (shopPool ? this.isRowInShopPool(row, shopPool) : this.isRowActiveOnCrew(row, crewNames));
    const snap = this.db ? this.db.getSnapshot() : null;
    const tables = (snap && snap.tables) || {};

    const results = [];
    const counts = { matched: 0, discrepancy: 0, wrong_crew: 0, missing: 0, new_item: 0, totalReported: 0 };

    this.CATEGORIES.forEach((cat) => {
      // Field-only categories (Fire Extinguishers, First Aid Kits) are skipped on Shop Stock audits
      if (shopPool && cat.fieldOnly) return;

      const table = tables[cat.key] || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(cat.key) : null) || { headers: [], rows: [], name: cat.sheetName };
      const rows = Array.isArray(table.rows) ? table.rows : [];
      const headers = Array.isArray(table.headers) ? table.headers : [];
      const swapCtx = isPackedForDelivery ? this.getSwapTableAndRows(cat.key, tables) : null;

      // Index regular numbered app rows by primary ID, ESL ID, and Serial #.
      // Vehicle-based categories normalize Unit/Truck/Shack # (e.g. "Unit 2108" -> "2108", "X104").
      // Unnumbered placeholder rows (NA-001, NA1, etc.) are tracked separately ONLY within
      // this crew / shop pool so one crew's NA1 can NEVER cross-match another crew's NA1.
      const byPrimary = new Map();
      const byAlt = new Map();
      const inScopeUnnumbered = [];
      rows.forEach((r, idx) => {
        const rawPid = this.getRowPrimaryId(cat.key, r, headers);
        const pid = cat.isVehicleBased ? this.normVehicleId(rawPid) : this.normId(rawPid);
        if (!cat.isVehicleBased && this.isUnnumberedPlaceholderId(rawPid)) {
          if (isRowInScope(r)) {
            inScopeUnnumbered.push({ row: r, idx, rawPid, normPid: pid });
          }
          return;
        }
        if (pid && !byPrimary.has(pid)) byPrimary.set(pid, { row: r, idx });
        if (!cat.isVehicleBased) {
          const esl = this.normId(r['ESL ID']);
          if (esl && !this.isUnnumberedPlaceholderId(r['ESL ID']) && !byAlt.has(esl)) byAlt.set(esl, { row: r, idx });
          const ser = this.normId(r['Serial #']);
          if (ser && !this.isUnnumberedPlaceholderId(r['Serial #']) && !byAlt.has(ser)) byAlt.set(ser, { row: r, idx });
        }
      });

      const matchedAppIndices = new Set();
      const reservedUnnumbered = new Set();
      const reportedNormIds = new Set();
      const reportedList = Array.isArray(itemsByCat[cat.key]) ? itemsByCat[cat.key] : [];

      reportedList.forEach((rep) => {
        counts.totalReported++;
        const repId = cat.isVehicleBased ? this.normVehicleId(rep.itemNum) : this.normId(rep.itemNum);
        const repEsl = this.normId(rep.eslId);
        const repSer = this.normId(rep.serialNum);
        if (repId) reportedNormIds.add(repId);
        if (repEsl) reportedNormIds.add(repEsl);
        const isUnnumbered = !cat.isVehicleBased && this.isUnnumberedPlaceholderId(rep.itemNum);
        const needsChangeoutNoDate = this.isMissingDateValue(rep.testDate) || this.isMissingDateValue(rep.calibrationDate);
        const needsSafetyNeedPush = Boolean(cat.isVehicleBased && this.isVehicleReplacementFlagged(cat.key, rep));
        const packedFor = isPackedForDelivery ? this.getReportedPackedFor(cat.key, rep) : '';

        let found = null;
        if (isUnnumbered) {
          // Match ONLY against unmatched unnumbered items already on THIS SAME crew / shop pool:
          // 1) Exact same ID on this crew (e.g. NA-001), 2) exact spec + date match, 3) physical spec match.
          const available = inScopeUnnumbered.filter((u) => !matchedAppIndices.has(u.idx));
          found = available.find((u) => repId && u.normPid === repId) ||
                  available.find((u) => this.compareItemFields(cat.key, rep, u.row, { isShopPool: Boolean(shopPool), isPackedForDelivery }).length === 0) ||
                  available.find((u) => this.matchesUnnumberedPhysicalSpecs(cat.key, rep, u.row, Boolean(shopPool))) ||
                  null;
        } else if (cat.isVehicleBased) {
          found = (repId && byPrimary.get(repId)) || null;
        } else {
          found = (repId && byPrimary.get(repId)) ||
                  (repEsl && byAlt.get(repEsl)) ||
                  (repId && byAlt.get(repId)) ||
                  (repSer && byAlt.get(repSer)) ||
                  null;
        }

        const keyId = `${cat.key}:${rep.id || repId}`;
        const foundPid = found ? this.getRowPrimaryId(cat.key, found.row, headers) : '';
        if (foundPid) reportedNormIds.add(this.normId(foundPid));
        if (found && found.row['ESL ID']) reportedNormIds.add(this.normId(found.row['ESL ID']));

        const swapCheck = (isPackedForDelivery && packedFor)
          ? this.checkPackedItemAgainstSwaps(
            cat.key,
            [foundPid, rep.itemNum, rep.eslId, found?.row?.['ESL ID']].filter(Boolean),
            packedFor,
            swapCtx,
            found ? found.row : null,
            rep,
            rows
          )
          : null;

        if (!found) {
          counts.new_item++;
          let suggestedItemNum = '';
          if (isUnnumbered) {
            suggestedItemNum = this.getNextSequentialUnnumberedId(cat.key, reservedUnnumbered);
            reservedUnnumbered.add(suggestedItemNum);
          }
          results.push({
            key: keyId,
            bucket: 'new_item',
            catKey: cat.key,
            catLabel: cat.label,
            catIcon: cat.icon,
            isVehicleBased: Boolean(cat.isVehicleBased),
            itemNum: cat.isVehicleBased ? this.formatCanonicalVehicleId(rep.itemNum, req.job_number) : rep.itemNum,
            isUnnumbered,
            suggestedItemNum,
            needsChangeoutNoDate,
            needsSafetyNeedPush,
            packedFor,
            swapCheck,
            reported: rep,
            appRow: null,
            diffs: []
          });
          return;
        }

        matchedAppIndices.add(found.idx);
        const appRow = found.row;
        const inScope = isRowInScope(appRow);
        const diffs = this.compareItemFields(cat.key, rep, appRow, { isShopPool: Boolean(shopPool), isPackedForDelivery });
        const hasSwapIssue = Boolean(swapCheck && !swapCheck.ok);

        if (!inScope) {
          counts.wrong_crew++;
          results.push({
            key: keyId,
            bucket: 'wrong_crew',
            catKey: cat.key,
            catLabel: cat.label,
            catIcon: cat.icon,
            isVehicleBased: Boolean(cat.isVehicleBased),
            itemNum: foundPid || rep.itemNum,
            isUnnumbered,
            needsChangeoutNoDate,
            needsSafetyNeedPush,
            packedFor,
            swapCheck,
            reported: rep,
            appRow,
            appRowIdx: appRow._rowIdx || (found.idx + 2),
            diffs
          });
        } else if (diffs.length > 0 || needsSafetyNeedPush || hasSwapIssue) {
          counts.discrepancy++;
          results.push({
            key: keyId,
            bucket: 'discrepancy',
            catKey: cat.key,
            catLabel: cat.label,
            catIcon: cat.icon,
            isVehicleBased: Boolean(cat.isVehicleBased),
            itemNum: foundPid || rep.itemNum,
            isUnnumbered,
            needsChangeoutNoDate,
            needsSafetyNeedPush,
            packedFor,
            swapCheck,
            reported: rep,
            appRow,
            appRowIdx: appRow._rowIdx || (found.idx + 2),
            diffs
          });
        } else {
          counts.matched++;
          results.push({
            key: keyId,
            bucket: 'matched',
            catKey: cat.key,
            catLabel: cat.label,
            catIcon: cat.icon,
            isVehicleBased: Boolean(cat.isVehicleBased),
            itemNum: foundPid || rep.itemNum,
            isUnnumbered,
            needsChangeoutNoDate,
            needsSafetyNeedPush: false,
            packedFor,
            swapCheck,
            reported: rep,
            appRow,
            appRowIdx: appRow._rowIdx || (found.idx + 2),
            diffs: []
          });
        }
      });

      // Anything currently in this crew / shop status in the App that was NOT reported.
      // SKIP vehicle-based categories (Fire Extinguishers & First Aid Kits) so rotating trucks
      // or crews whose 1st Aid Kits are all up to date NEVER clutter the Missing bucket!
      if (cat.isVehicleBased) return;

      const missingInvNormIds = new Set();
      rows.forEach((appRow, idx) => {
        if (matchedAppIndices.has(idx)) return;
        if (!isRowInScope(appRow)) return;
        const pid = this.getRowPrimaryId(cat.key, appRow, headers);
        if (!pid) return;
        const pidNorm = this.normId(pid);
        missingInvNormIds.add(pidNorm);
        if (appRow['ESL ID']) missingInvNormIds.add(this.normId(appRow['ESL ID']));

        let swapMissingRow = null;
        let swapMissingMeta = null;
        if (isPackedForDelivery && swapCtx && swapCtx.rows.length > 0) {
          const hit = swapCtx.rows.find((sr) => {
            const m = this.getSwapRowMeta(sr);
            return m && m.isReadyForDelivery && m.hasValidPick && (this.normId(m.pickListNum) === pidNorm || (appRow['ESL ID'] && this.normId(m.pickListNum) === this.normId(appRow['ESL ID'])));
          });
          if (hit) {
            swapMissingRow = hit;
            swapMissingMeta = this.getSwapRowMeta(hit);
          }
        }

        counts.missing++;
        results.push({
          key: `${cat.key}:missing:${pidNorm}:${idx}`,
          bucket: 'missing',
          catKey: cat.key,
          catLabel: cat.label,
          catIcon: cat.icon,
          itemNum: pid,
          packedFor: isPackedForDelivery ? (this.extractPickedForName(appRow['Picked For']) || swapMissingMeta?.empName || '') : '',
          swapMissingRow,
          swapMissingMeta,
          swapSheetLabel: isPackedForDelivery ? this.getSwapSheetLabel(cat.key) : '',
          reported: null,
          appRow,
          appRowIdx: appRow._rowIdx || (idx + 2),
          diffs: []
        });
      });

      // Reverse Swaps Page check for Packed For Delivery:
      // Catch any active "Ready For Delivery / Picked" row on the Swaps page whose item was NOT physically found
      // AND wasn't already caught via Inventory missing rows above.
      if (isPackedForDelivery && swapCtx && swapCtx.rows.length > 0) {
        swapCtx.rows.forEach((sr, sIdx) => {
          const m = this.getSwapRowMeta(sr);
          if (!m || !m.isReadyForDelivery || !m.hasValidPick) return;
          const pickNorm = this.normId(m.pickListNum);
          if (!pickNorm || reportedNormIds.has(pickNorm) || missingInvNormIds.has(pickNorm)) return;
          missingInvNormIds.add(pickNorm);
          counts.missing++;
          results.push({
            key: `${cat.key}:swap_missing:${pickNorm}:${sIdx}`,
            bucket: 'missing',
            catKey: cat.key,
            catLabel: cat.label,
            catIcon: cat.icon,
            itemNum: m.pickListNum,
            packedFor: m.empName,
            swapOnlyMissing: true,
            swapMissingRow: sr,
            swapMissingMeta: m,
            swapSheetLabel: this.getSwapSheetLabel(cat.key),
            reported: null,
            appRow: (byPrimary.get(pickNorm) || byAlt.get(pickNorm) || {}).row || null,
            appRowIdx: (byPrimary.get(pickNorm) || byAlt.get(pickNorm) || {}).row?._rowIdx || null,
            diffs: []
          });
        });
      }
    });

    this._cachedAliasMap = null;
    return { results, counts, shopPool };
  }

  renderReviewTabHtml() {
    const reviewableReqs = this.requests.filter((r) => {
      const s = this.submissionsByReqId.get(r.id);
      return r.status === 'submitted' || r.status === 'in_progress' || (s && (s.submitted_payload || s.draft_item_count > 0));
    });

    if (reviewableReqs.length === 0) {
      return `
        <div style="margin: 24px 18px; padding: 38px 20px; text-align: center; background: rgba(30, 41, 59, 0.55); border: 1.5px dashed rgba(148,163,184,0.3); border-radius: 12px;">
          <div style="font-size: 38px; margin-bottom: 10px;">🔍</div>
          <h3 style="margin: 0 0 6px 0; color: #f8fafc;">No Foreman Submissions Ready Yet</h3>
          <p style="margin: 0; color: #94a3b8; font-size: 13px;">As soon as a foreman submits their form (or saves a draft), it will appear right here for side-by-side reconciliation against your inventory.</p>
        </div>
      `;
    }

    const activeReq = reviewableReqs.find((r) => r.id === this.activeReviewRequestId) || reviewableReqs[0];
    this.activeReviewRequestId = activeReq.id;
    const sub = this.submissionsByReqId.get(activeReq.id);
    const { results, counts } = this.reconcileAudit(activeReq, sub);
    this._lastReconciliation = { req: activeReq, sub, results, counts };

    const appliedList = Array.isArray(sub?.applied_actions) ? sub.applied_actions : [];
    const appliedByKey = new Map();
    appliedList.forEach((a) => { if (a && a.key) appliedByKey.set(a.key, a); });

    const filtered = results.filter((item) => {
      if (this.reviewCategoryFilter !== 'all' && item.catKey !== this.reviewCategoryFilter) return false;
      if (this.reviewBucketFilter === 'actionable') return item.bucket !== 'matched';
      if (this.reviewBucketFilter !== 'all') return item.bucket === this.reviewBucketFilter;
      return true;
    });

    const bucketOrder = { discrepancy: 1, wrong_crew: 2, missing: 3, new_item: 4, matched: 5 };
    filtered.sort((a, b) => (bucketOrder[a.bucket] || 9) - (bucketOrder[b.bucket] || 9));

    const pillBtn = (key, label, count, color) => {
      const active = this.reviewBucketFilter === key;
      return `<button class="btn ${active ? 'btn-primary' : 'btn-secondary'}" style="font-size:11.5px;padding:5px 10px;${active ? '' : `border-color:${color}55;color:${color};`}" onclick="window.equipmentAuditsEngine.setReviewBucket('${key}')">${label} (${count})</button>`;
    };

    const rowsHtml = filtered.length === 0 ? `
      <div style="padding: 28px; text-align: center; color: #94a3b8; font-size: 13px; background: rgba(15,23,42,0.45); border-radius: 10px; border: 1px dashed rgba(148,163,184,0.25);">
        ${this.reviewBucketFilter === 'actionable' ? '🎉 Zero discrepancies, missing items, or unlogged gear! Everything matches your database.' : 'No items match this filter.'}
      </div>
    ` : filtered.map((item) => this.renderReconcileItemCard(item, appliedByKey.get(item.key), activeReq)).join('');

    const actionableCount = counts.discrepancy + counts.wrong_crew + counts.missing + counts.new_item;

    return `
      <div style="padding: 14px 18px 28px 18px; display: flex; flex-direction: column; gap: 14px;">
        <!-- Selector & Audit Meta Header -->
        <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; background: rgba(30,41,59,0.75); border: 1px solid var(--border-color); border-radius: 10px; padding: 12px 14px;">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <label style="font-size: 11.5px; font-weight: 700; color: #94a3b8;">AUDITING:</label>
            <select class="sheet-search" style="font-size: 13px; font-weight: 700;" onchange="window.equipmentAuditsEngine.openReview(this.value)">
              ${reviewableReqs.map((r) => `<option value="${r.id}" ${r.id === activeReq.id ? 'selected' : ''}>${this.escapeHtml(r.foreman_name)} — Job ${this.escapeHtml(r.job_number)} (${r.status === 'submitted' ? 'Submitted' : r.status === 'archived' ? 'Archived' : 'Draft'})</option>`).join('')}
            </select>
            <span style="font-size: 12px; color: #cbd5e1;">
              📍 ${this.escapeHtml(activeReq.location || 'No Location')}
              ${sub?.submitted_at ? ` • Submitted ${this.formatShortDateTime(sub.submitted_at)}` : ' • In Progress Draft'}
              ${sub?.submitted_by_device ? ` (${this.escapeHtml(sub.submitted_by_device)})` : ''}
            </span>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            ${activeReq.status !== 'archived' ? `
              <button class="btn btn-primary admin-only-control" style="background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%); border: none; font-weight: 700; font-size: 12px;" onclick="window.equipmentAuditsEngine.completeAndArchiveAudit('${activeReq.id}')">
                ✅ Complete &amp; Archive Audit
              </button>
            ` : `<span style="color:#d8b4fe;font-weight:700;font-size:12px;">🗄️ Archived</span>`}
          </div>
        </div>

        <!-- 5-Bucket Summary & Filters -->
        <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px;">
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">
            ${pillBtn('actionable', '⚡ Needs Review', actionableCount, '#fbbf24')}
            ${pillBtn('discrepancy', '🟡 Discrepancies', counts.discrepancy, '#facc15')}
            ${pillBtn('wrong_crew', '🟠 Wrong Crew / Status', counts.wrong_crew, '#fb923c')}
            ${pillBtn('missing', '🔴 Missing from Field', counts.missing, '#f87171')}
            ${pillBtn('new_item', '🔵 Unlogged / New', counts.new_item, '#60a5fa')}
            ${pillBtn('matched', '🟢 Matched', counts.matched, '#34d399')}
            ${pillBtn('all', 'All', results.length, '#cbd5e1')}
          </div>
          <select class="sheet-search" style="font-size: 12px;" onchange="window.equipmentAuditsEngine.setReviewCategory(this.value)">
            <option value="all" ${this.reviewCategoryFilter === 'all' ? 'selected' : ''}>All Categories</option>
            ${this.CATEGORIES.filter((c) => !(this.getShopAuditPoolConfig(activeReq) && c.fieldOnly)).map((c) => `<option value="${c.key}" ${this.reviewCategoryFilter === c.key ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('')}
          </select>
        </div>

        <!-- Reconciliation Items -->
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${rowsHtml}
        </div>

        <!-- Auditor Notes -->
        <div style="background: rgba(30,41,59,0.65); border: 1px solid var(--border-color); border-radius: 10px; padding: 12px 14px;">
          <label style="display:block;font-size:11.5px;font-weight:700;color:#94a3b8;margin-bottom:6px;">AUDITOR NOTES (SAVED WITH ARCHIVE)</label>
          <textarea id="eq-audit-auditor-notes" class="sheet-search" style="width:100%;min-height:64px;font-size:12.5px;resize:vertical;" placeholder="Optional follow-up notes (e.g., called foreman about missing blanket B108)...">${this.escapeHtml(sub?.auditor_notes || '')}</textarea>
        </div>
      </div>
    `;
  }

  renderReconcileItemCard(item, appliedAction, req) {
    const shopPool = this.getShopAuditPoolConfig(req);
    const isPackedForDelivery = this.isPackedForDeliveryPool(shopPool);
    const swapCheck = item.swapCheck || null;
    const hasSwapIssue = Boolean(swapCheck && !swapCheck.ok);

    const meta = {
      matched: { border: 'rgba(16,185,129,0.35)', bg: 'rgba(16,185,129,0.08)', badge: isPackedForDelivery && swapCheck?.ok ? '🟢 Inventory & Swaps Confirmed' : '🟢 Matched', color: '#34d399' },
      discrepancy: {
        border: 'rgba(234,179,8,0.45)',
        bg: 'rgba(234,179,8,0.09)',
        badge: item.needsSafetyNeedPush
          ? '🚨 Replacement / Update Needed'
          : (hasSwapIssue && item.diffs.length === 0 ? '🔄 Swaps Page Mismatch' : '🟡 Field Discrepancy'),
        color: item.needsSafetyNeedPush ? '#fca5a5' : '#fde047'
      },
      wrong_crew: { border: 'rgba(249,115,22,0.45)', bg: 'rgba(249,115,22,0.09)', badge: item.isVehicleBased ? '🚚 Vehicle Moved Crews' : (shopPool ? '🟠 Wrong Status / Location' : '🟠 Wrong Crew / Status'), color: '#fdba74' },
      missing: {
        border: 'rgba(239,68,68,0.45)',
        bg: 'rgba(239,68,68,0.09)',
        badge: item.swapOnlyMissing
          ? `🔄 Swaps Page Only (Not in ${shopPool ? shopPool.name : 'Pile'})`
          : (shopPool ? `🔴 Missing from ${shopPool.name}` : '🔴 Missing from Field'),
        color: '#fca5a5'
      },
      new_item: { border: 'rgba(59,130,246,0.45)', bg: 'rgba(59,130,246,0.09)', badge: item.needsSafetyNeedPush ? '🚨 New Vehicle — Replacement Needed' : '🔵 Unlogged / New Item', color: item.needsSafetyNeedPush ? '#fca5a5' : '#93c5fd' }
    }[item.bucket];

    let detailsHtml = '';
    if (item.bucket === 'discrepancy') {
      detailsHtml = `
        <div style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px;">
          ${item.diffs.map((d) => `
            <span style="font-size: 11.5px; padding: 3px 8px; border-radius: 6px; background: rgba(15,23,42,0.75); border: 1px solid rgba(234,179,8,0.35); color: #fef08a;">
              <strong>${this.escapeHtml(d.label)}:</strong> <span style="text-decoration:line-through;color:#94a3b8;">${this.escapeHtml(d.appValue)}</span> → <strong>${this.escapeHtml(d.displayReportedValue || d.reportedValue)}</strong>
            </span>
          `).join('')}
          ${item.needsSafetyNeedPush && item.diffs.length === 0 ? `<span style="font-size:11.5px;padding:3px 8px;border-radius:6px;background:rgba(127,29,29,0.55);border:1px solid rgba(248,113,113,0.45);color:#fecaca;">Foreman requested replacement (${this.escapeHtml(item.reported?.condition || 'Needs Replacement')}${item.reported?.reason ? `: ${this.escapeHtml(item.reported.reason)}` : ''})</span>` : ''}
        </div>
      `;
    } else if (item.bucket === 'wrong_crew') {
      const curAssigned = item.appRow['Assigned To'] || '(blank)';
      const curStatus = item.appRow['Status'] || '(blank)';
      const curLoc = item.appRow['Location'] || '(blank)';
      const targetLabel = shopPool
        ? `${shopPool.name} (${shopPool.canonicalStatus}${item.packedFor ? ` • For: ${item.packedFor}` : ''})`
        : `${item.reported.employeeName || req.foreman_name} (${req.location || req.job_number})`;
      detailsHtml = `
        <div style="margin-top: 5px; font-size: 12px; color: #fed7aa;">
          Currently logged in app as: <strong>${this.escapeHtml(curAssigned)}</strong> (${this.escapeHtml(curStatus)} • ${this.escapeHtml(curLoc)}) → Audit found in <strong>${this.escapeHtml(targetLabel)}</strong>.
        </div>
        ${item.diffs.length > 0 ? `<div style="margin-top:4px;font-size:11.5px;color:#fde68a;">Also differs: ${item.diffs.map((d) => `${d.label}: ${d.appValue} → ${d.displayReportedValue || d.reportedValue}`).join(' | ')}</div>` : ''}
      `;
    } else if (item.bucket === 'missing') {
      if (item.swapOnlyMissing) {
        const sm = item.swapMissingMeta || {};
        const invHint = item.appRow
          ? ` (Inventory currently shows <strong>${this.escapeHtml(item.appRow['Status'] || 'Unknown')}</strong> / ${this.escapeHtml(item.appRow['Assigned To'] || 'Unknown')})`
          : '';
        detailsHtml = `
          <div style="margin-top: 5px; font-size: 12px; color: #fecaca;">
            <strong>${this.escapeHtml(item.swapSheetLabel || 'Swaps Page')}</strong> marks #${this.escapeHtml(item.itemNum)} as <strong>Ready For Delivery / Picked</strong> for <strong>${this.escapeHtml(sm.empName || item.packedFor || 'Unknown')}</strong>${sm.currentItemNum ? ` (replacing #${this.escapeHtml(sm.currentItemNum)})` : ''}, but it was <strong>not found</strong> in the physical Packed For Delivery audit.${invHint}
          </div>
        `;
      } else {
        const curAssigned = item.appRow['Assigned To'] || req.foreman_name;
        const curStatus = item.appRow['Status'] || '';
        const curDate = item.appRow['Test Date'] || item.appRow['Calibration Date'] || item.appRow['Pad Expiration'] || '';
        const pfDisplay = item.packedFor ? ` • Picked For: ${this.escapeHtml(item.packedFor)}` : '';
        const swapAlsoHint = item.swapMissingMeta
          ? `<div style="margin-top:4px;font-size:11.5px;color:#fde68a;">🔄 Also marked Picked / Ready For Delivery on <strong>${this.escapeHtml(item.swapSheetLabel || 'Swaps Page')}</strong> for <strong>${this.escapeHtml(item.swapMissingMeta.empName)}</strong>.</div>`
          : '';
        detailsHtml = `
          <div style="margin-top: 5px; font-size: 12px; color: #fecaca;">
            App shows <strong>${this.escapeHtml(curAssigned)}</strong>${curStatus ? ` (${this.escapeHtml(curStatus)})` : ''}${pfDisplay}${curDate ? ` • Date: ${this.escapeHtml(curDate)}` : ''}, but it was <strong>not reported</strong> on this audit.
          </div>
          ${swapAlsoHint}
        `;
      }
    } else if (item.bucket === 'new_item') {
      const r = item.reported;
      const fmtClass = (r.itemClass !== undefined && r.itemClass !== null && String(r.itemClass).trim() !== '') ? `Class ${r.itemClass}` : '';
      const fmtTest = r.testDate ? (this.isMissingDateValue(r.testDate) ? 'Test Date: None (OVERDUE)' : `Tested ${this.toSheetDate(r.testDate)}`) : '';
      const fmtCal = r.calibrationDate ? (this.isMissingDateValue(r.calibrationDate) ? 'Cal Date: None (OVERDUE)' : `Cal ${this.toSheetDate(r.calibrationDate)}`) : '';
      const specs = [isPackedForDelivery ? (item.packedFor ? `Packed For: ${item.packedFor}` : '') : (shopPool ? '' : r.employeeName), r.type, r.model, r.size, fmtClass, r.kv, r.length, r.condition, r.reason ? `Reason: ${r.reason}` : '', r.serialNum ? `S/N ${r.serialNum}` : '', r.eslId ? `ESL ${r.eslId}` : '', r.condition !== 'Missing' ? fmtTest : '', fmtCal, r.padExpiration ? `Pads Exp ${this.toSheetDate(r.padExpiration)}` : '', r.batteryExpiration ? `Battery Exp ${this.toSheetDate(r.batteryExpiration)}` : ''].filter(Boolean);
      detailsHtml = `
        <div style="margin-top: 5px; font-size: 12px; color: #bfdbfe;">
          Not found in ${this.escapeHtml(item.catLabel)} inventory. Reported specs: <strong>${this.escapeHtml(specs.join(' • ') || 'Basic entry')}</strong>
          ${item.isUnnumbered && item.suggestedItemNum ? `<div style="margin-top:4px;font-size:11.5px;color:#c4b5fd;">🏷️ Unnumbered item — will be added as <strong>#${this.escapeHtml(item.suggestedItemNum)}</strong> (sequential unique ID).</div>` : ''}
        </div>
      `;
    } else {
      const who = isPackedForDelivery && item.packedFor
        ? `Packed For Delivery → ${item.packedFor}`
        : (shopPool ? shopPool.name : (item.reported?.employeeName || item.appRow?.['Assigned To'] || req.foreman_name));
      detailsHtml = `<div style="margin-top: 3px; font-size: 11.5px; color: #a7f3d0;">Verified in ${this.escapeHtml(who)} — ${swapCheck?.ok ? 'Inventory page and Swaps page both confirm this audit.' : 'all dates and specs match.'}</div>`;
    }

    // Swaps Page cross-check banner for Packed For Delivery items
    const swapBannerHtml = (isPackedForDelivery && swapCheck && item.bucket !== 'missing')
      ? (swapCheck.ok
        ? `<div style="margin-top:5px;font-size:11.5px;color:#6ee7b7;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.35);border-radius:6px;padding:4px 8px;display:inline-block;">✅ <strong>Swaps Page:</strong> ${this.escapeHtml(swapCheck.summary)}</div>`
        : `<div style="margin-top:5px;font-size:11.5px;color:#fde68a;background:rgba(217,119,6,0.18);border:1px solid rgba(245,158,11,0.45);border-radius:6px;padding:5px 9px;">🔄 <strong>Swaps Page Check:</strong> ${this.escapeHtml(swapCheck.summary)}</div>`)
      : '';

    const escKey = this.escapeJs(item.key);
    let actionsHtml = '';
    if (appliedAction) {
      actionsHtml = `<span style="font-size:11.5px;font-weight:700;color:#6ee7b7;background:rgba(16,185,129,0.16);border:1px solid rgba(16,185,129,0.4);padding:4px 10px;border-radius:999px;">✓ ${this.escapeHtml(appliedAction.label || 'Resolved')}</span>`;
    } else if (item.bucket === 'discrepancy') {
      let updLabel = '✅ Update App Fields';
      let updBg = '#ca8a04';
      if (item.needsSafetyNeedPush) {
        updLabel = '🚨 Update & Send to Safety Needs';
        updBg = '#dc2626';
      } else if (hasSwapIssue && item.diffs.length === 0) {
        updLabel = '🔄 Confirm on Swaps Page';
        updBg = '#0284c7';
      } else if (hasSwapIssue) {
        updLabel = '✅ Update Inventory & Swaps';
        updBg = '#ca8a04';
      }
      actionsHtml = `
        <button class="btn btn-primary admin-only-control" style="font-size:11.5px;padding:5px 10px;background:${updBg};border:none;" onclick="window.equipmentAuditsEngine.applyDiscrepancyUpdate('${escKey}')">${this.escapeHtml(updLabel)}</button>
        <button class="btn btn-secondary" style="font-size:11.5px;padding:5px 9px;" onclick="window.equipmentAuditsEngine.dismissItem('${escKey}')">Dismiss</button>
      `;
    } else if (item.bucket === 'wrong_crew') {
      const reassignLabel = item.needsSafetyNeedPush
        ? '🚨 Move Vehicle & Send to Safety Needs'
        : (item.isVehicleBased
          ? '🚚 Update Vehicle Crew'
          : (isPackedForDelivery
            ? (hasSwapIssue ? '🚚 Move to Packed & Sync Swaps' : '🚚 Move to Packed For Delivery')
            : (shopPool ? `🔄 Move to ${shopPool.name}` : '🔄 Reassign to Crew')));
      actionsHtml = `
        <button class="btn btn-primary admin-only-control" style="font-size:11.5px;padding:5px 10px;background:${item.needsSafetyNeedPush ? '#dc2626' : '#ea580c'};border:none;" onclick="window.equipmentAuditsEngine.applyReassignToCrew('${escKey}')">${this.escapeHtml(reassignLabel)}</button>
        <button class="btn btn-secondary" style="font-size:11.5px;padding:5px 9px;" onclick="window.equipmentAuditsEngine.dismissItem('${escKey}')">Dismiss</button>
      `;
    } else if (item.bucket === 'new_item') {
      const addLabel = item.needsSafetyNeedPush
        ? '🚨 Add & Send to Safety Needs'
        : (item.isUnnumbered && item.suggestedItemNum
          ? (shopPool ? `➕ Add as #${item.suggestedItemNum} (${shopPool.name})` : `➕ Add as #${item.suggestedItemNum}`)
          : (isPackedForDelivery
            ? '➕ Add to Packed & Sync Swaps'
            : (shopPool ? `➕ Add to ${shopPool.name}` : '➕ Add to Inventory')));
      actionsHtml = `
        <button class="btn btn-primary admin-only-control" style="font-size:11.5px;padding:5px 10px;background:${item.needsSafetyNeedPush ? '#dc2626' : '#2563eb'};border:none;" onclick="window.equipmentAuditsEngine.applyAddNewItem('${escKey}')">${this.escapeHtml(addLabel)}</button>
        <button class="btn btn-secondary" style="font-size:11.5px;padding:5px 9px;" onclick="window.equipmentAuditsEngine.dismissItem('${escKey}')">Dismiss</button>
      `;
    } else if (item.bucket === 'missing') {
      if (item.swapOnlyMissing) {
        actionsHtml = `
          <button class="btn btn-primary admin-only-control" style="font-size:11.5px;padding:5px 10px;background:#d97706;border:none;" onclick="window.equipmentAuditsEngine.applyUnpickFromSwaps('${escKey}')">🔓 Unpick on Swaps Page</button>
          <button class="btn btn-secondary" style="font-size:11.5px;padding:5px 9px;" onclick="window.equipmentAuditsEngine.dismissItem('${escKey}')">Keep As-Is</button>
        `;
      } else {
        const showReturnShelf = !shopPool || shopPool.jobNumber !== 'SHOP-ON-SHELF';
        actionsHtml = `
          <button class="btn btn-secondary admin-only-control" style="font-size:11.5px;padding:5px 9px;border-color:#ef4444;color:#fca5a5;" onclick="window.equipmentAuditsEngine.applyMarkMissingLost('${escKey}')">⚠️ Flag Lost / Locate</button>
          ${showReturnShelf ? `<button class="btn btn-secondary admin-only-control" style="font-size:11.5px;padding:5px 9px;color:#93c5fd;" onclick="window.equipmentAuditsEngine.applyReturnToShelf('${escKey}')">📦 Return On Shelf${item.swapMissingRow ? ' & Unpick Swap' : ''}</button>` : ''}
          <button class="btn btn-secondary" style="font-size:11.5px;padding:5px 9px;" onclick="window.equipmentAuditsEngine.dismissItem('${escKey}')">Keep As-Is</button>
        `;
      }
    }

    const packedForBadgeHtml = (isPackedForDelivery && item.packedFor)
      ? `<span style="font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:999px;background:rgba(56,189,248,0.18);border:1px solid rgba(56,189,248,0.45);color:#bae6fd;">🚚 Packed For: ${this.escapeHtml(item.packedFor)}</span>`
      : '';
    const unnumberedBadgeHtml = item.isUnnumbered
      ? `<span style="font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:999px;background:rgba(139,92,246,0.2);border:1px solid rgba(167,139,250,0.45);color:#ddd6fe;">🏷️ Unnumbered${item.suggestedItemNum && item.bucket === 'new_item' ? ` → #${this.escapeHtml(item.suggestedItemNum)}` : ''}</span>`
      : '';
    const noDateBadgeHtml = item.needsChangeoutNoDate
      ? `<span style="font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:999px;background:rgba(220,38,38,0.22);border:1px solid rgba(248,113,113,0.55);color:#fecaca;">⚠️ No Test/Cal Sticker — Out of Date (Needs Changeout)</span>`
      : '';
    const replacementBadgeHtml = item.needsSafetyNeedPush
      ? `<span style="font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:999px;background:rgba(220,38,38,0.26);border:1px solid rgba(248,113,113,0.6);color:#fecaca;">🚨 Replacement Request → Safety Equipment Needs</span>`
      : '';
    const itemDisplayId = item.isVehicleBased
      ? (/^job\s*shack/i.test(String(item.itemNum || '')) ? `🏠 ${item.itemNum}` : `Unit ${item.itemNum}`)
      : `#${item.itemNum}`;

    return `
      <div style="background:${meta.bg};border:1px solid ${meta.border};border-radius:10px;padding:11px 14px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;">
        <div style="flex:1;min-width:260px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:800;color:${meta.color};">${meta.badge}</span>
            <span style="font-size:12px;font-weight:700;color:#cbd5e1;">${item.catIcon} ${this.escapeHtml(item.catLabel)}</span>
            <span style="font-size:14px;font-weight:800;color:#ffffff;">${this.escapeHtml(itemDisplayId)}</span>
            ${packedForBadgeHtml}
            ${unnumberedBadgeHtml}
            ${noDateBadgeHtml}
            ${replacementBadgeHtml}
          </div>
          ${detailsHtml}
          ${swapBannerHtml}
          ${item.reported?.notes ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8;">Foreman note: ${this.escapeHtml(item.reported.notes)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          ${actionsHtml}
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Human-in-the-Loop Inventory Resolution Actions (Through LocalDatabase)
  // ---------------------------------------------------------------------------
  findReconcileItem(key) {
    if (!this._lastReconciliation) return null;
    return this._lastReconciliation.results.find((r) => r.key === key) || null;
  }

  async recordAppliedAction(key, label) {
    const rec = this._lastReconciliation;
    if (!rec || !rec.sub) return;
    const actions = Array.isArray(rec.sub.applied_actions) ? [...rec.sub.applied_actions] : [];
    const existingIdx = actions.findIndex((a) => a.key === key);
    const entry = { key, label, at: new Date().toISOString(), by: (window.supabaseSync && window.supabaseSync.userName) || 'Cody Bechdol' };
    if (existingIdx !== -1) actions[existingIdx] = entry;
    else actions.push(entry);
    rec.sub.applied_actions = actions;

    try {
      await this.sbRequest(`/rest/v1/sa_audit_submissions?request_id=eq.${encodeURIComponent(rec.req.id)}`, {
        method: 'PATCH',
        body: { applied_actions: actions, updated_at: new Date().toISOString() }
      });
    } catch (err) {
      console.warn('Could not persist applied action log:', err);
    }
    this.render();
  }

  getLocalTodayMdy() {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const yyyy = now.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }

  getLocalTodayIso() {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const yyyy = now.getFullYear();
    return `${yyyy}-${mm}-${dd}`;
  }

  async updateTableCellByColName(catKey, appRow, appRowIdx, colName, newValue, options = {}) {
    const table = this.db.getTable(catKey);
    if (!table || !Array.isArray(table.headers)) return false;
    const colIdx = table.headers.findIndex((h) => String(h || '').trim().toLowerCase() === String(colName).trim().toLowerCase());
    if (colIdx === -1) {
      // Allow adding Battery Expiration or Serial # even if header alias differs
      appRow[colName] = newValue;
      return true;
    }
    const oldVal = appRow[table.headers[colIdx]] ?? '';
    await this.db.addMutation({
      action: 'UPDATE_CELL',
      sheetName: table.name,
      tableKey: catKey,
      row: appRow._rowIdx || appRowIdx,
      col: colIdx + 1,
      colName: table.headers[colIdx],
      oldValue: oldVal,
      value: newValue,
      itemNum: this.getRowPrimaryId(catKey, appRow, table.headers),
      skipHistory: options.skipHistory === true
    });
    return true;
  }

  async recalculateRowChangeOutDate(catKey, appRow, appRowIdx) {
    if (!appRow) return '';
    const testVal = appRow['Test Date'] || '';
    const calVal = appRow['Calibration Date'] || '';
    const padVal = appRow['Pad Expiration'] || '';
    const batVal = appRow['Battery Expiration'] || '';
    const dateAssignedVal = appRow['Date Assigned'] || '';
    const locVal = appRow['Location'] || '';
    const assignedVal = appRow['Assigned To'] || '';

    let newChgOut = '';
    if (window.inventoryManager && typeof window.inventoryManager.calculateChangeOutDate === 'function') {
      newChgOut = window.inventoryManager.calculateChangeOutDate(
        dateAssignedVal || testVal || calVal || padVal,
        locVal,
        assignedVal,
        catKey,
        {
          testDate: testVal,
          calibrationDate: calVal,
          padExpiration: padVal,
          batteryExpiration: batVal
        }
      );
    } else if (this.isMissingDateValue(testVal) || this.isMissingDateValue(calVal)) {
      newChgOut = 'OVERDUE';
    }

    if (newChgOut) {
      const table = this.db ? this.db.getTable(catKey) : null;
      const headers = (table && Array.isArray(table.headers)) ? table.headers : [];
      const chgCol = headers.find((h) => /^change\s*out\s*date$/i.test(String(h || '').trim()))
        || (catKey === 'phasing_sets' ? headers.find((h) => /^replacement\s*date$/i.test(String(h || '').trim())) : null);
      if (chgCol) {
        await this.updateTableCellByColName(catKey, appRow, appRowIdx, chgCol, newChgOut, { skipHistory: true });
      }
    }
    return newChgOut;
  }

  async pushReplacementToSafetyEquipmentNeeds(catKey, req, reported, canonicalVehNum) {
    if (!this.db || !reported) return false;
    const isFireExt = catKey === 'fire_extinguishers';
    const equipType = isFireExt ? 'Fire Extinguisher' : 'First Aid Kit';
    const vehClean = String(canonicalVehNum || reported.itemNum || '').trim();
    const jobNum = String(req.job_number || '').trim();
    const todayMdy = this.getLocalTodayMdy();

    // Avoid inserting a duplicate open Safety Equipment Needs row for the same vehicle + equipment type + job
    const needsTable = this.db.getTable('safety_equipment_needs');
    const existingRows = (needsTable && Array.isArray(needsTable.rows)) ? needsTable.rows : [];
    const vehNorm = this.normVehicleId(vehClean);
    const alreadyOpen = existingRows.some((r) => {
      const st = String(r['Status'] || '').trim().toLowerCase();
      if (st.includes('complete') || st.includes('resolved') || st.includes('closed')) return false;
      const rVeh = this.normVehicleId(r['Vehicle Number'] || r['Vehicle #'] || r['Truck'] || r['Unit'] || '');
      const rType = String(r['Equipment Type'] || r['Item Type'] || '').trim().toLowerCase();
      return vehNorm && rVeh === vehNorm && rType === equipType.toLowerCase();
    });
    if (alreadyOpen) return false;

    const cond = reported.condition || (isFireExt ? 'Needs Replacement' : 'Needs Replacement');
    const sizeTxt = (isFireExt && reported.size) ? ` (${reported.size})` : '';
    const reasonParts = [];
    if (reported.reason) reasonParts.push(reported.reason);
    if (isFireExt && this.isMissingDateValue(reported.testDate) && cond !== 'Missing') {
      reasonParts.push('No Test Sticker (OVERDUE)');
    }
    if (reported.notes) reasonParts.push(reported.notes);
    const detailStr = reasonParts.join(' • ');
    const issueDesc = `${cond}${sizeTxt}${detailStr ? ` — ${detailStr}` : ''}`;

    const needRow = {
      'Report Date': todayMdy,
      'Received Date': todayMdy,
      'Job Number': jobNum,
      'Foreman': req.foreman_name || '',
      'Location': req.location || 'Helena',
      'Vehicle Number': vehClean,
      'Equipment Type': equipType,
      'Issue Description': issueDesc,
      'Notes': `${issueDesc} (Equipment Audit: ${req.campaign_name || 'Crew Audit'})`,
      'Status': 'Needs Attention',
      'Report Type': 'Equipment Audit'
    };

    await this.db.addRow('safety_equipment_needs', needRow, `Equipment Audit (${req.foreman_name})`);
    return true;
  }

  getDefaultSwapHeaders(catKey) {
    const stageCols = [
      'Stage 1 Pick Status', 'Stage 1 Pick Assigned', 'Stage 1 Pick Date',
      'Stage 1 Old Status', 'Stage 1 Old Assigned', 'Stage 1 Old Date',
      'Stage 2 Status', 'Stage 2 Assigned', 'Stage 2 Date', 'Stage 2 Picked For',
      'Stage 3 Assigned', 'Stage 3 Date', 'Stage 3 Change Out Date'
    ];
    if (catKey === 'gloves') {
      return ['Employee', 'Current Glove #', 'Size', 'Date Assigned', 'Change Out Date', 'Days Left', 'Pick List Item #', 'Status', 'Picked', 'Date Changed', ...stageCols];
    }
    if (catKey === 'sleeves') {
      return ['Employee', 'Current Sleeve #', 'Size', 'Date Assigned', 'Change Out Date', 'Days Left', 'Pick List Item #', 'Status', 'Picked', 'Date Changed', ...stageCols];
    }
    if (catKey === 'blankets') {
      return ['Employee', 'Current Blanket #', 'Type', 'Date Assigned', 'Change Out Date', 'Days Left', 'Pick List Item #', 'Status', 'Picked', 'Date Changed', ...stageCols];
    }
    if (catKey === 'macks') {
      return ['Employee', 'Current MACK #', 'KV', 'Size', 'Length', 'Date Assigned', 'Change Out Date', 'Days Left', 'Pick List Item #', 'Status', 'Picked', 'Date Changed', ...stageCols];
    }
    if (catKey === 'hv_testers') {
      return ['Crew Lead / Employee', 'Current HV Tester #', 'Model', 'KV', 'Serial #', 'Date Assigned', 'Change Out Date', 'Days Left', 'Pick List HV Tester #', 'Status', 'Picked', 'Date Changed'];
    }
    if (catKey === 'phasing_sets') {
      return ['Crew Lead / Employee', 'Current Phasing Set #', 'Model', 'KV', 'Serial #', 'Date Assigned', 'Change Out Date', 'Days Left', 'Pick List Phasing Set #', 'Status', 'Picked', 'Date Changed'];
    }
    if (catKey === 'aed') {
      return ['Crew Lead / Employee', 'Current AED #', 'Model', 'Pad Expiration', 'Days Left', 'Pick List AED #', 'Status', 'Picked', 'Date Changed'];
    }
    if (catKey === 'grounds') {
      return ['Crew Lead / Employee', 'Serial #', 'Type', 'Size', 'KV', 'Length', 'Date Assigned', 'Change Out Date', 'Days Left', 'Pick List Serial #', 'Status', 'Picked', 'Date Changed'];
    }
    if (catKey === 'hot_sticks') {
      return ['Crew Lead / Employee', 'Current Item #', 'Type', 'Length', 'Date Assigned', 'Change Out Date', 'Days Left', 'Pick List Item #', 'Status', 'Picked', 'Date Changed'];
    }
    return ['Employee', 'Current Item #', 'Size', 'Date Assigned', 'Change Out Date', 'Days Left', 'Pick List Item #', 'Status', 'Picked', 'Date Changed'];
  }

  _updateSwapRowInPlace(swapTable, swapRow, updates) {
    if (!swapTable || !swapRow || !updates) return;
    const headers = Array.isArray(swapTable.headers) ? swapTable.headers : [];
    const pickHeader = headers.find((h) => /pick\s*list/i.test(String(h || ''))) || 'Pick List Item #';

    if (updates.pickListNum !== undefined) {
      swapRow[pickHeader] = updates.pickListNum;
      if ('Pick List Item #' in swapRow || pickHeader === 'Pick List Item #') swapRow['Pick List Item #'] = updates.pickListNum;
      ['Pick List Glove #', 'Pick List Sleeve #', 'Pick List Blanket #', 'Pick List MACK #', 'Pick List HV Tester #', 'Pick List Phasing Set #', 'Pick List AED #', 'Pick List Serial #'].forEach((k) => {
        if (k in swapRow) swapRow[k] = updates.pickListNum;
      });
    }
    if (updates.status !== undefined) swapRow['Status'] = updates.status;
    if (updates.picked !== undefined) swapRow['Picked'] = updates.picked;
    if (updates.stage2Status !== undefined) swapRow['Stage 2 Status'] = updates.stage2Status;
    if (updates.stage2Assigned !== undefined) swapRow['Stage 2 Assigned'] = updates.stage2Assigned;
    if (updates.stage2Date !== undefined) swapRow['Stage 2 Date'] = updates.stage2Date;
    if (updates.stage2PickedFor !== undefined) swapRow['Stage 2 Picked For'] = updates.stage2PickedFor;
    if (updates.isManualPick !== undefined) {
      swapRow._manualPick = updates.isManualPick;
      swapRow.isManualPick = updates.isManualPick;
    }

    if (Array.isArray(swapTable.rawGrid) && swapTable.rawGrid.length > 0) {
      const grid = swapTable.rawGrid;
      let gRow = (swapRow._rowIdx && grid[swapRow._rowIdx - 1] && Array.isArray(grid[swapRow._rowIdx - 1]))
        ? grid[swapRow._rowIdx - 1]
        : null;
      if (!gRow) {
        const meta = this.getSwapRowMeta(swapRow);
        const targetEmp = (meta?.empName || '').toLowerCase();
        const targetCur = (meta?.currentItemNum || '').toLowerCase();
        gRow = grid.find((r, idx) => idx > 0 && Array.isArray(r) && String(r[0] || '').trim().toLowerCase() === targetEmp && (!targetCur || String(r[1] || '').trim().toLowerCase() === targetCur)) || null;
      }
      if (gRow) {
        const pickIdx = headers.findIndex((h) => /pick\s*list/i.test(String(h || '')));
        const statIdx = headers.findIndex((h) => /^status$/i.test(String(h || '').trim()));
        const pkIdx = headers.findIndex((h) => /^picked$/i.test(String(h || '').trim()));
        const s2StatIdx = headers.findIndex((h) => /stage\s*2\s*status/i.test(String(h || '')));
        const s2AsgIdx = headers.findIndex((h) => /stage\s*2\s*assigned/i.test(String(h || '')));
        const s2DateIdx = headers.findIndex((h) => /stage\s*2\s*date/i.test(String(h || '')));
        const s2PfIdx = headers.findIndex((h) => /stage\s*2\s*picked\s*for/i.test(String(h || '')));
        while (gRow.length < headers.length) gRow.push('');
        if (updates.pickListNum !== undefined && pickIdx !== -1) gRow[pickIdx] = updates.pickListNum;
        if (updates.status !== undefined && statIdx !== -1) gRow[statIdx] = updates.status;
        if (updates.picked !== undefined && pkIdx !== -1) gRow[pkIdx] = updates.picked;
        if (updates.stage2Status !== undefined && s2StatIdx !== -1) gRow[s2StatIdx] = updates.stage2Status;
        if (updates.stage2Assigned !== undefined && s2AsgIdx !== -1) gRow[s2AsgIdx] = updates.stage2Assigned;
        if (updates.stage2Date !== undefined && s2DateIdx !== -1) gRow[s2DateIdx] = updates.stage2Date;
        if (updates.stage2PickedFor !== undefined && s2PfIdx !== -1) gRow[s2PfIdx] = updates.stage2PickedFor;
      }
    }
  }

  async _appendStagedRowToSwapTable(catKey, swapKey, empName, itemNum, invRow = null, reported = null) {
    if (!this.db || !swapKey) return false;
    const canonicalEmp = this.resolveCanonicalEmployeeName(empName);
    const todayIso = this.getLocalTodayIso();
    const todayMdy = this.getLocalTodayMdy();
    const pickedForStamp = `${canonicalEmp} Picked On ${todayIso}`;

    // For gloves & sleeves, prefer swapEngine.upsertNewAssignmentSwapRow when loaded so the row
    // is slotted cleanly under the right Class -> Location -> Foreman section!
    if ((swapKey === 'glove_swaps' || swapKey === 'sleeve_swaps') && typeof window !== 'undefined' && window.swapEngine && typeof window.swapEngine.upsertNewAssignmentSwapRow === 'function') {
      const ok = await window.swapEngine.upsertNewAssignmentSwapRow(swapKey, {
        empName: canonicalEmp,
        itemNum,
        itemClass: (reported && reported.itemClass !== undefined && String(reported.itemClass).trim() !== '') ? reported.itemClass : (invRow ? invRow['Class'] : null),
        size: (reported && reported.size) || (invRow && invRow['Size']) || '',
        invItemData: invRow
      });
      if (ok) return true;
    }

    let swapTable = this.db.getTable(swapKey);
    const defaultHeaders = this.getDefaultSwapHeaders(catKey);
    if (!swapTable) {
      swapTable = {
        name: this.getSwapSheetLabel(catKey),
        headers: [...defaultHeaders],
        rawGrid: [[this.getSwapSheetLabel(catKey), ...new Array(defaultHeaders.length - 1).fill('')], [...defaultHeaders]],
        rows: []
      };
    }
    const headers = (Array.isArray(swapTable.headers) && swapTable.headers.length > 0) ? swapTable.headers : [...defaultHeaders];
    const rawGrid = Array.isArray(swapTable.rawGrid) ? [...swapTable.rawGrid] : [];
    const rows = Array.isArray(swapTable.rows) ? [...swapTable.rows] : [];

    if (rawGrid.length === 0) {
      rawGrid.push([this.getSwapSheetLabel(catKey), ...new Array(headers.length - 1).fill('')]);
      rawGrid.push([...headers]);
    }

    const rowObj = {};
    const gridArr = headers.map((h) => {
      const hl = String(h || '').trim().toLowerCase();
      let v = '';
      if (hl === 'employee' || hl === 'crew lead / employee') v = canonicalEmp;
      else if (hl.includes('pick list')) v = itemNum;
      else if (hl === 'status') v = 'Ready For Delivery 🚚';
      else if (hl === 'picked') v = true;
      else if (hl === 'size') v = String((reported && reported.size) || (invRow && invRow['Size']) || '');
      else if (hl === 'type') v = String((reported && reported.type) || (invRow && invRow['Type']) || '');
      else if (hl === 'kv') v = String((reported && reported.kv) || (invRow && invRow['KV']) || '');
      else if (hl === 'length') v = String((reported && reported.length) || (invRow && invRow['Length']) || '');
      else if (hl === 'model') v = String((reported && reported.model) || (invRow && invRow['Model']) || '');
      else if (hl === 'stage 2 status') v = 'Ready For Delivery';
      else if (hl === 'stage 2 assigned') v = 'Packed For Delivery';
      else if (hl === 'stage 2 date') v = todayMdy;
      else if (hl === 'stage 2 picked for') v = pickedForStamp;
      rowObj[h] = v;
      return v;
    });

    rawGrid.push(gridArr);
    rowObj._rowIdx = rawGrid.length;
    rowObj._manualPick = true;
    rowObj.isManualPick = true;
    if ((catKey === 'gloves' || catKey === 'sleeves') && !rowObj['Class']) {
      rowObj['Class'] = String((reported && reported.itemClass !== undefined && String(reported.itemClass).trim() !== '') ? reported.itemClass : (invRow && invRow['Class']) || '2');
    }
    rows.push(rowObj);

    if (typeof this.db.saveManualPick === 'function') {
      this.db.saveManualPick(swapKey, canonicalEmp, '', itemNum, 'Ready For Delivery 🚚', true);
    }
    if (typeof this.db.replaceSwapTable === 'function') {
      await this.db.replaceSwapTable(swapKey, rawGrid, headers, rows);
    } else {
      swapTable.headers = headers;
      swapTable.rawGrid = rawGrid;
      swapTable.rows = rows;
    }
    return true;
  }

  async syncPackedItemToSwaps(catKey, itemNum, packedFor, invRow = null, swapCheck = null, reported = null) {
    const swapKey = this.getSwapTableKeyForCategory(catKey);
    if (!this.db || !swapKey || !itemNum || !packedFor) return false;
    if (swapCheck && swapCheck.ok) return false;

    const canonicalEmp = this.resolveCanonicalEmployeeName(packedFor);
    const todayIso = this.getLocalTodayIso();
    const todayMdy = this.getLocalTodayMdy();
    const pickedForStamp = `${canonicalEmp} Picked On ${todayIso}`;

    const swapCtx = this.getSwapTableAndRows(catKey);
    const swapTable = swapCtx.swapTable;
    const status = swapCheck ? swapCheck.status : 'not_on_swaps';

    if ((status === 'unpicked' || status === 'different_pick_item') && swapTable && swapCheck.swapRow) {
      const meta = this.getSwapRowMeta(swapCheck.swapRow);
      this._updateSwapRowInPlace(swapTable, swapCheck.swapRow, {
        pickListNum: itemNum,
        status: 'Ready For Delivery 🚚',
        picked: true,
        stage2Status: 'Ready For Delivery',
        stage2Assigned: 'Packed For Delivery',
        stage2Date: todayMdy,
        stage2PickedFor: pickedForStamp,
        isManualPick: true
      });
      if (typeof this.db.saveManualPick === 'function') {
        this.db.saveManualPick(swapKey, meta?.empName || canonicalEmp, meta?.currentItemNum || '', itemNum, 'Ready For Delivery 🚚', true);
      }
      if (typeof this.db.replaceSwapTable === 'function') {
        await this.db.replaceSwapTable(swapKey, swapTable.rawGrid || [], swapTable.headers || this.getDefaultSwapHeaders(catKey), swapTable.rows || []);
      }
      if (typeof window !== 'undefined' && window.tripPlanner && typeof window.tripPlanner.renderPickedSwapsList === 'function') {
        window.tripPlanner.renderPickedSwapsList();
      }
      return true;
    }

    if (status === 'wrong_employee' && swapTable && swapCheck.swapRow) {
      // 1. Clear/unpick the wrong employee's row
      const wrongMeta = this.getSwapRowMeta(swapCheck.swapRow);
      this._updateSwapRowInPlace(swapTable, swapCheck.swapRow, {
        pickListNum: '—',
        status: wrongMeta?.currentItemNum ? 'Need to Purchase ❌' : 'Needs Equipment',
        picked: false,
        stage2Status: '',
        stage2Assigned: '',
        stage2Date: '',
        stage2PickedFor: '',
        isManualPick: false
      });
      if (typeof this.db.clearManualPick === 'function' && wrongMeta?.empName) {
        this.db.clearManualPick(swapKey, wrongMeta.empName, wrongMeta.currentItemNum || '');
      }

      // 2. Attach item to target employee's open swap row if one exists, otherwise append a new staged row
      if (swapCheck.targetEmpSwapRow) {
        const tgtMeta = this.getSwapRowMeta(swapCheck.targetEmpSwapRow);
        this._updateSwapRowInPlace(swapTable, swapCheck.targetEmpSwapRow, {
          pickListNum: itemNum,
          status: 'Ready For Delivery 🚚',
          picked: true,
          stage2Status: 'Ready For Delivery',
          stage2Assigned: 'Packed For Delivery',
          stage2Date: todayMdy,
          stage2PickedFor: pickedForStamp,
          isManualPick: true
        });
        if (typeof this.db.saveManualPick === 'function') {
          this.db.saveManualPick(swapKey, tgtMeta?.empName || canonicalEmp, tgtMeta?.currentItemNum || '', itemNum, 'Ready For Delivery 🚚', true);
        }
        if (typeof this.db.replaceSwapTable === 'function') {
          await this.db.replaceSwapTable(swapKey, swapTable.rawGrid || [], swapTable.headers || this.getDefaultSwapHeaders(catKey), swapTable.rows || []);
        }
      } else {
        if (typeof this.db.replaceSwapTable === 'function') {
          await this.db.replaceSwapTable(swapKey, swapTable.rawGrid || [], swapTable.headers || this.getDefaultSwapHeaders(catKey), swapTable.rows || []);
        }
        await this._appendStagedRowToSwapTable(catKey, swapKey, canonicalEmp, itemNum, invRow, reported);
      }

      if (typeof window !== 'undefined' && window.tripPlanner && typeof window.tripPlanner.renderPickedSwapsList === 'function') {
        window.tripPlanner.renderPickedSwapsList();
      }
      return true;
    }

    // Default / 'not_on_swaps': insert a new staged Ready For Delivery row on the Swaps page
    const appended = await this._appendStagedRowToSwapTable(catKey, swapKey, canonicalEmp, itemNum, invRow, reported);
    if (appended && typeof window !== 'undefined' && window.tripPlanner && typeof window.tripPlanner.renderPickedSwapsList === 'function') {
      window.tripPlanner.renderPickedSwapsList();
    }
    return appended;
  }

  async unpickItemOnSwaps(catKey, itemNum, swapRowOverride = null, options = {}) {
    const swapKey = this.getSwapTableKeyForCategory(catKey);
    if (!this.db || !swapKey || !itemNum) return false;
    const swapCtx = this.getSwapTableAndRows(catKey);
    const swapTable = swapCtx.swapTable;
    if (!swapTable) return false;

    const targetNorm = this.normId(itemNum);
    const targetRows = swapRowOverride
      ? [swapRowOverride]
      : swapCtx.rows.filter((sr) => {
        const m = this.getSwapRowMeta(sr);
        return m && m.isReadyForDelivery && m.hasValidPick && this.normId(m.pickListNum) === targetNorm;
      });

    if (targetRows.length === 0) return false;

    targetRows.forEach((sr) => {
      const m = this.getSwapRowMeta(sr);
      const clearPick = Boolean(options.clearPickNum);
      const nextStatus = clearPick
        ? (m?.currentItemNum ? 'Need to Purchase ❌' : 'Needs Equipment')
        : (m?.currentItemNum ? 'In Stock ✅' : 'Needs Equipment');
      this._updateSwapRowInPlace(swapTable, sr, {
        ...(clearPick ? { pickListNum: '—' } : {}),
        status: nextStatus,
        picked: false,
        stage2Status: '',
        stage2Assigned: '',
        stage2Date: '',
        stage2PickedFor: '',
        isManualPick: false
      });
      if (typeof this.db.clearManualPick === 'function' && m?.empName) {
        this.db.clearManualPick(swapKey, m.empName, m.currentItemNum || '');
      }
    });

    if (typeof this.db.replaceSwapTable === 'function') {
      await this.db.replaceSwapTable(swapKey, swapTable.rawGrid || [], swapTable.headers || this.getDefaultSwapHeaders(catKey), swapTable.rows || []);
    }
    if (typeof window !== 'undefined' && window.tripPlanner && typeof window.tripPlanner.renderPickedSwapsList === 'function') {
      window.tripPlanner.renderPickedSwapsList();
    }
    return true;
  }

  async applyDiscrepancyUpdate(key) {
    const item = this.findReconcileItem(key);
    const req = this._lastReconciliation?.req;
    if (!item || !item.appRow) return;
    const shopPool = this.getShopAuditPoolConfig(req);
    const isPackedForDelivery = this.isPackedForDeliveryPool(shopPool);
    const hasAssignedDiff = item.diffs.some((d) => d.colName === 'Assigned To');
    const hasDateOrLocDiff = hasAssignedDiff || item.diffs.some((d) =>
      ['Test Date', 'Calibration Date', 'Pad Expiration', 'Battery Expiration', 'Location', 'Status'].includes(d.colName)
    );
    const todayMdy = this.getLocalTodayMdy();
    if (hasAssignedDiff) {
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Date Assigned', todayMdy, { skipHistory: true });
    }
    if (item.isVehicleBased) {
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Date Verified', todayMdy, { skipHistory: true });
      if (req && req.job_number) {
        await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Job #', req.job_number, { skipHistory: true });
      }
      if (item.reported && (item.reported.reason || item.reported.notes)) {
        const noteStr = [item.reported.reason, item.reported.notes].filter(Boolean).join(' — ');
        await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Notes', noteStr, { skipHistory: true });
      }
    }
    for (const d of item.diffs) {
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, d.colName, d.reportedValue, { skipHistory: true });
    }
    if (hasDateOrLocDiff && item.catKey !== 'first_aid_kits') {
      await this.recalculateRowChangeOutDate(item.catKey, item.appRow, item.appRowIdx);
    }
    if (hasAssignedDiff && typeof this.db.recordItemHistoryEvent === 'function' && !item.isVehicleBased) {
      const table = this.db.getTable(item.catKey);
      if (table) {
        await this.db.recordItemHistoryEvent(table.name, item.appRow, 'Reassigned via Equipment Audit');
      }
    }
    let syncedSwap = false;
    if (isPackedForDelivery && item.packedFor && item.swapCheck && !item.swapCheck.ok) {
      syncedSwap = await this.syncPackedItemToSwaps(item.catKey, item.itemNum, item.packedFor, item.appRow, item.swapCheck, item.reported);
    }
    let pushedNeed = false;
    if (item.needsSafetyNeedPush && req) {
      pushedNeed = await this.pushReplacementToSafetyEquipmentNeeds(item.catKey, req, item.reported, item.itemNum);
    }
    const labelParts = [];
    if (item.diffs.length > 0) labelParts.push(`Updated ${item.diffs.map((d) => d.label).join(', ')}`);
    if (syncedSwap) labelParts.push('Confirmed on Swaps Page');
    if (pushedNeed) labelParts.push('Sent to Safety Needs');
    const actionLabel = labelParts.join(' + ') || 'Verified';
    this.toast(`✅ ${actionLabel} (${item.catLabel} ${item.isVehicleBased ? `Unit ${item.itemNum}` : `#${item.itemNum}`})`, 'success');
    await this.recordAppliedAction(key, actionLabel);
  }

  async applyReassignToCrew(key) {
    const item = this.findReconcileItem(key);
    const req = this._lastReconciliation?.req;
    if (!item || !item.appRow || !req) return;
    const shopPool = this.getShopAuditPoolConfig(req);
    const isPackedForDelivery = this.isPackedForDeliveryPool(shopPool);
    const targetStatus = item.isVehicleBased
      ? (item.reported?.condition || (item.catKey === 'first_aid_kits' ? 'Stocked / OK' : 'In Service'))
      : (shopPool ? shopPool.canonicalStatus : 'Assigned');
    const assignee = shopPool ? shopPool.canonicalAssignedTo : (item.reported?.employeeName || req.foreman_name);
    const targetLoc = shopPool ? shopPool.location : (req.location || '');
    const todayMdy = this.getLocalTodayMdy();
    const todayIso = this.getLocalTodayIso();

    // 1. Update Date Assigned / Date Verified FIRST (with skipHistory: true)
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, item.isVehicleBased ? 'Date Verified' : 'Date Assigned', todayMdy, { skipHistory: true });
    if (item.isVehicleBased && req.job_number) {
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Job #', req.job_number, { skipHistory: true });
    }

    // 2. Apply any changed spec/date fields (e.g. Test Date, Calibration Date, Size) with skipHistory: true
    for (const d of item.diffs) {
      if (d.colName !== 'Assigned To' && d.colName !== 'Status' && d.colName !== 'Picked For') {
        await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, d.colName, d.reportedValue, { skipHistory: true });
      }
    }

    // 3. Apply Location, Status, Assigned To, and Picked For (for Packed For Delivery) atomically
    if (targetLoc) {
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Location', targetLoc, { skipHistory: true });
    }
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Status', targetStatus, { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Assigned To', assignee, { skipHistory: true });
    if (isPackedForDelivery && item.packedFor) {
      const canonicalPacked = this.resolveCanonicalEmployeeName(item.packedFor);
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Picked For', `${canonicalPacked} Picked On ${todayIso}`, { skipHistory: true });
    }
    if (item.isVehicleBased && item.reported && (item.reported.reason || item.reported.notes)) {
      const noteStr = [item.reported.reason, item.reported.notes].filter(Boolean).join(' — ');
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Notes', noteStr, { skipHistory: true });
    }

    // 4. Recalculate Change Out Date based on updated assignment, location, and test/calibration date (handles None -> OVERDUE)
    if (item.catKey !== 'first_aid_kits') {
      await this.recalculateRowChangeOutDate(item.catKey, item.appRow, item.appRowIdx);
    }

    // 5. Record ONE clean history transition (for tracked serialized PPE/equipment)
    if (!item.isVehicleBased && typeof this.db.recordItemHistoryEvent === 'function') {
      const table = this.db.getTable(item.catKey);
      if (table) {
        const histReason = isPackedForDelivery && item.packedFor
          ? `Packed For Delivery (${this.resolveCanonicalEmployeeName(item.packedFor)} — Equipment Audit)`
          : (shopPool
            ? `Found in ${shopPool.name} (Equipment Audit)`
            : `Reassigned via Equipment Audit (${req.foreman_name})`);
        await this.db.recordItemHistoryEvent(table.name, item.appRow, histReason);
      }
    }

    let syncedSwap = false;
    if (isPackedForDelivery && item.packedFor && (!item.swapCheck || !item.swapCheck.ok)) {
      syncedSwap = await this.syncPackedItemToSwaps(item.catKey, item.itemNum, item.packedFor, item.appRow, item.swapCheck, item.reported);
    }

    let pushedNeed = false;
    if (item.needsSafetyNeedPush) {
      pushedNeed = await this.pushReplacementToSafetyEquipmentNeeds(item.catKey, req, item.reported, item.itemNum);
    }

    const actionText = (shopPool ? `Moved to ${shopPool.name}` : `Reassigned to ${assignee}`)
      + (syncedSwap ? ' + Synced Swaps' : '')
      + (pushedNeed ? ' + Sent to Safety Needs' : '');
    this.toast(`🔄 ${actionText} (${item.catLabel} ${item.isVehicleBased ? `Unit ${item.itemNum}` : `#${item.itemNum}`})`, 'success');
    await this.recordAppliedAction(key, actionText);
  }

  async applyAddNewItem(key) {
    const item = this.findReconcileItem(key);
    const req = this._lastReconciliation?.req;
    if (!item || !item.reported || !req) return;
    const shopPool = this.getShopAuditPoolConfig(req);
    const isPackedForDelivery = this.isPackedForDeliveryPool(shopPool);
    const r = item.reported;
    const isVehicleBased = Boolean(item.isVehicleBased);
    const targetStatus = isVehicleBased
      ? (r.condition || (item.catKey === 'first_aid_kits' ? 'Stocked / OK' : 'In Service'))
      : (shopPool ? shopPool.canonicalStatus : 'Assigned');
    const assignee = shopPool ? shopPool.canonicalAssignedTo : (r.employeeName || req.foreman_name);
    const loc = shopPool ? shopPool.location : (req.location || 'Helena');
    const todayIso = this.getLocalTodayIso();
    const todayMdy = this.getLocalTodayMdy();
    const canonicalPacked = (isPackedForDelivery && item.packedFor) ? this.resolveCanonicalEmployeeName(item.packedFor) : '';

    // Auto-assign sequential NA-001, NA-002, NA-003... for unnumbered placeholders (non-vehicle items)
    const wasUnnumbered = !isVehicleBased && this.isUnnumberedPlaceholderId(r.itemNum);
    const finalItemNum = isVehicleBased
      ? this.formatCanonicalVehicleId(r.itemNum, req.job_number)
      : (wasUnnumbered ? this.getNextSequentialUnnumberedId(item.catKey) : r.itemNum);

    const testDateMdy = this.toSheetDate(r.testDate);
    const calDateMdy = this.toSheetDate(r.calibrationDate);
    const padExpMdy = this.toSheetDate(r.padExpiration);
    const batExpMdy = this.toSheetDate(r.batteryExpiration);
    const isMissingStickerDate = this.isMissingDateValue(r.testDate) || this.isMissingDateValue(r.calibrationDate);

    let changeOutDate = (item.catKey !== 'first_aid_kits' && window.inventoryManager && typeof window.inventoryManager.calculateChangeOutDate === 'function')
      ? window.inventoryManager.calculateChangeOutDate(todayIso, loc, assignee, item.catKey, {
        testDate: r.testDate,
        calibrationDate: r.calibrationDate,
        padExpiration: r.padExpiration,
        batteryExpiration: r.batteryExpiration
      })
      : '';
    if (item.catKey !== 'first_aid_kits' && (isMissingStickerDate || (item.catKey === 'fire_extinguishers' && targetStatus !== 'In Service')) && changeOutDate !== 'N/A') {
      changeOutDate = 'OVERDUE';
    }

    const baseNote = [r.reason, r.notes].filter(Boolean).join(' — ') || `Added via Equipment Audit (${req.campaign_name})`;
    const finalNotes = wasUnnumbered
      ? `${baseNote}${baseNote ? ' | ' : ''}Unnumbered (Audit: ${r.itemNum})`
      : baseNote;

    let newRow = {};
    if (item.catKey === 'fire_extinguishers') {
      newRow = {
        'Vehicle / Equipment #': finalItemNum,
        'Size': r.size || '10 lb ABC',
        'Test Date': r.condition === 'Missing' ? 'None' : testDateMdy,
        'Date Verified': todayMdy,
        'Location': loc,
        'Status': targetStatus,
        'Assigned To': assignee,
        'Job #': req.job_number || '',
        'Change Out Date': changeOutDate,
        'Notes': finalNotes
      };
    } else if (item.catKey === 'first_aid_kits') {
      newRow = {
        'Vehicle / Equipment #': finalItemNum,
        'Status': targetStatus,
        'Date Verified': todayMdy,
        'Location': loc,
        'Assigned To': assignee,
        'Job #': req.job_number || '',
        'Notes': finalNotes
      };
    } else {
      newRow = {
        'Item #': finalItemNum,
        'Date Assigned': todayMdy,
        'Location': loc,
        'Status': targetStatus,
        'Assigned To': assignee,
        'Change Out Date': changeOutDate,
        'Picked For': canonicalPacked ? `${canonicalPacked} Picked On ${todayIso}` : '',
        'Notes': finalNotes
      };
    }

    if (item.catKey === 'gloves' || item.catKey === 'sleeves') {
      newRow[item.catKey === 'gloves' ? 'Glove' : 'Sleeve'] = finalItemNum;
      newRow['ESL ID'] = r.eslId || '';
      newRow['Size'] = r.size || '';
      newRow['Class'] = (r.itemClass !== undefined && r.itemClass !== null && String(r.itemClass).trim() !== '') ? String(r.itemClass).trim() : '2';
      newRow['Test Date'] = testDateMdy;
    } else if (item.catKey === 'blankets') {
      newRow['Blanket'] = finalItemNum;
      newRow['Type'] = r.type || 'Regular';
      newRow['Class'] = r.itemClass || '4';
      newRow['Test Date'] = testDateMdy;
    } else if (item.catKey === 'macks') {
      newRow['MACK'] = finalItemNum;
      newRow['KV'] = r.kv || '15KV';
      newRow['Size'] = r.size || '';
      newRow['Length'] = r.length || '';
      newRow['Test Date'] = testDateMdy;
    } else if (item.catKey === 'hv_testers' || item.catKey === 'phasing_sets') {
      newRow[item.catKey === 'hv_testers' ? 'HVT #' : 'Phasing Set'] = finalItemNum;
      newRow['Model'] = r.model || '';
      newRow['KV'] = r.kv || '';
      newRow['Serial #'] = r.serialNum || '';
      newRow['Calibration Date'] = calDateMdy;
      if (item.catKey === 'phasing_sets') newRow['Replacement Date'] = changeOutDate;
    } else if (item.catKey === 'aed') {
      newRow['AED'] = finalItemNum;
      newRow['Model'] = r.model || 'ZOLL AED 3';
      newRow['Serial #'] = r.serialNum || '';
      newRow['Pad Expiration'] = padExpMdy;
      newRow['Battery Expiration'] = batExpMdy;
    } else if (item.catKey === 'grounds') {
      newRow['Serial #'] = finalItemNum;
      newRow['Type'] = r.type || 'OH';
      newRow['Size'] = r.type === 'OH' ? (r.size || '') : '';
      newRow['KV'] = r.type === 'UG' ? (r.kv || '') : '';
      newRow['Length'] = r.length || '';
      newRow['Test Date'] = testDateMdy;
    } else if (item.catKey === 'hot_sticks') {
      newRow['Type'] = r.type || '';
      newRow['Length'] = r.length || '';
      newRow['Test Date'] = testDateMdy;
    }

    await this.db.addRow(item.catKey, newRow, `Equipment Audit (${req.foreman_name})`);
    let syncedSwap = false;
    if (isPackedForDelivery && canonicalPacked && (!item.swapCheck || !item.swapCheck.ok)) {
      syncedSwap = await this.syncPackedItemToSwaps(item.catKey, finalItemNum, canonicalPacked, newRow, item.swapCheck, r);
    }
    let pushedNeed = false;
    if (item.needsSafetyNeedPush) {
      pushedNeed = await this.pushReplacementToSafetyEquipmentNeeds(item.catKey, req, r, finalItemNum);
    }
    const msgSuffix = `${wasUnnumbered ? ` (from ${r.itemNum})` : ''}${changeOutDate === 'OVERDUE' ? ' — flagged OVERDUE' : ''}${syncedSwap ? ' + synced to Swaps Page!' : ''}${pushedNeed ? ' + sent to Safety Equipment Needs!' : ''}`;
    this.toast(`➕ Added ${item.catLabel} ${isVehicleBased ? `Unit ${finalItemNum}` : `#${finalItemNum}`}${msgSuffix}`, 'success');
    await this.recordAppliedAction(key, `Added ${isVehicleBased ? `Unit ${finalItemNum}` : `#${finalItemNum}`} to ${item.catLabel}${syncedSwap ? ' + Synced Swaps' : (pushedNeed ? ' + Sent to Safety Needs' : ` (${assignee})`)}`);
  }

  async applyMarkMissingLost(key) {
    const item = this.findReconcileItem(key);
    const req = this._lastReconciliation?.req;
    if (!item || !item.appRow || !req) return;
    const shopPool = this.getShopAuditPoolConfig(req);
    const isPackedForDelivery = this.isPackedForDeliveryPool(shopPool);
    const todayMdy = this.getLocalTodayMdy();
    const noteText = `LOST-LOCATE (Missing on ${req.foreman_name} audit ${todayMdy})`;
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Date Assigned', todayMdy, { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Status', 'Lost', { skipHistory: true });
    if (isPackedForDelivery) {
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Picked For', '', { skipHistory: true });
    }
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Notes', noteText, { skipHistory: true });
    if (typeof this.db.recordItemHistoryEvent === 'function') {
      const table = this.db.getTable(item.catKey);
      if (table) await this.db.recordItemHistoryEvent(table.name, item.appRow, noteText);
    }
    let unpicked = false;
    if (isPackedForDelivery) {
      unpicked = await this.unpickItemOnSwaps(item.catKey, item.itemNum, item.swapMissingRow, { clearPickNum: true });
    }
    this.toast(`⚠️ Flagged ${item.catLabel} #${item.itemNum} as Lost / Locate${unpicked ? ' & cleared from Swaps' : ''}`, 'warning');
    await this.recordAppliedAction(key, `Flagged Lost / Locate${unpicked ? ' + Cleared Swaps' : ''}`);
  }

  async applyReturnToShelf(key) {
    const item = this.findReconcileItem(key);
    const req = this._lastReconciliation?.req;
    if (!item || !item.appRow) return;
    const shopPool = this.getShopAuditPoolConfig(req);
    const isPackedForDelivery = this.isPackedForDeliveryPool(shopPool);
    const todayMdy = this.getLocalTodayMdy();
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Date Assigned', todayMdy, { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Location', 'Helena', { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Status', 'On Shelf', { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Assigned To', 'On Shelf', { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Picked For', '', { skipHistory: true });
    if (typeof this.db.recordItemHistoryEvent === 'function') {
      const table = this.db.getTable(item.catKey);
      if (table) await this.db.recordItemHistoryEvent(table.name, item.appRow, 'Returned to On Shelf (Equipment Audit)');
    }
    let unpicked = false;
    if (isPackedForDelivery) {
      unpicked = await this.unpickItemOnSwaps(item.catKey, item.itemNum, item.swapMissingRow, { clearPickNum: false });
    }
    this.toast(`📦 Returned ${item.catLabel} #${item.itemNum} to On Shelf${unpicked ? ' & unpicked on Swaps Page' : ''}`, 'success');
    await this.recordAppliedAction(key, `Returned to On Shelf${unpicked ? ' + Unpicked Swap' : ''}`);
  }

  async applyUnpickFromSwaps(key) {
    const item = this.findReconcileItem(key);
    if (!item) return;
    const unpicked = await this.unpickItemOnSwaps(item.catKey, item.itemNum, item.swapMissingRow, { clearPickNum: false });
    this.toast(`🔓 Unpicked ${item.catLabel} #${item.itemNum} on ${item.swapSheetLabel || 'Swaps Page'}`, 'success');
    await this.recordAppliedAction(key, unpicked ? `Unpicked on ${item.swapSheetLabel || 'Swaps Page'}` : 'Cleared');
  }

  async dismissItem(key) {
    await this.recordAppliedAction(key, 'Dismissed / Kept App Value');
  }

  async completeAndArchiveAudit(requestId) {
    const rec = this._lastReconciliation;
    if (!rec || rec.req.id !== requestId) return;
    const auditorNotes = (document.getElementById('eq-audit-auditor-notes')?.value || '').trim();
    const nowIso = new Date().toISOString();

    const summarySnapshot = {
      counts: rec.counts,
      items: rec.results.map((r) => ({
        key: r.key,
        bucket: r.bucket,
        catKey: r.catKey,
        catLabel: r.catLabel,
        itemNum: r.itemNum,
        packedFor: r.packedFor || '',
        swapStatus: r.swapCheck ? r.swapCheck.status : '',
        diffs: r.diffs,
        reported: r.reported,
        appAssignedTo: r.appRow ? (r.appRow['Assigned To'] || '') : ''
      })),
      completedAt: nowIso
    };

    try {
      await Promise.all([
        this.sbRequest(`/rest/v1/sa_audit_submissions?request_id=eq.${encodeURIComponent(requestId)}`, {
          method: 'PATCH',
          body: {
            reconciliation_summary: summarySnapshot,
            auditor_notes: auditorNotes,
            reconciled_at: nowIso,
            archived_at: nowIso,
            updated_at: nowIso
          }
        }),
        this.sbRequest(`/rest/v1/sa_audit_requests?id=eq.${encodeURIComponent(requestId)}`, {
          method: 'PATCH',
          body: { status: 'archived', updated_at: nowIso }
        })
      ]);
      this.toast('✅ Audit completed and saved to Audit Archive!', 'success');
      this.activeReviewRequestId = null;
      this.archiveViewingId = requestId;
      this.activeTab = 'archive';
      await this.refreshData();
    } catch (err) {
      this.toast(`❌ Could not archive audit: ${err.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // TAB 3: Permanent Audit Archive
  // ---------------------------------------------------------------------------
  renderArchiveTabHtml() {
    const archived = this.requests.filter((r) => r.status === 'archived' || r.status === 'reconciled');
    const q = this.archiveSearch.trim().toLowerCase();
    const filtered = archived.filter((r) => {
      if (!q) return true;
      return `${r.foreman_name} ${r.job_number} ${r.location} ${r.campaign_name}`.toLowerCase().includes(q);
    });

    if (archived.length === 0) {
      return `
        <div style="margin: 24px 18px; padding: 38px 20px; text-align: center; background: rgba(30, 41, 59, 0.55); border: 1.5px dashed rgba(148,163,184,0.3); border-radius: 12px;">
          <div style="font-size: 38px; margin-bottom: 10px;">🗄️</div>
          <h3 style="margin: 0 0 6px 0; color: #f8fafc;">Audit Archive is Empty</h3>
          <p style="margin: 0; color: #94a3b8; font-size: 13px;">Completed audits and their full reconciliation snapshots are permanently stored here for historical review and printing.</p>
        </div>
      `;
    }

    const viewingReq = this.archiveViewingId ? archived.find((r) => r.id === this.archiveViewingId) : null;
    const detailPanel = viewingReq ? this.renderArchiveDetailHtml(viewingReq, this.submissionsByReqId.get(viewingReq.id)) : '';

    return `
      <div style="padding: 14px 18px 28px 18px; display: flex; flex-direction: column; gap: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
          <input type="text" class="sheet-search" style="min-width: 280px;" placeholder="Filter archive by foreman, job #, location, campaign..." value="${this.escapeHtml(this.archiveSearch)}" oninput="window.equipmentAuditsEngine.setArchiveSearch(this.value)">
          <span style="font-size: 12px; color: #94a3b8;">Showing ${filtered.length} of ${archived.length} archived audits</span>
        </div>

        ${detailPanel}

        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px;">
          ${filtered.map((req) => {
            const sub = this.submissionsByReqId.get(req.id);
            const c = sub?.reconciliation_summary?.counts || {};
            const actionsCount = Array.isArray(sub?.applied_actions) ? sub.applied_actions.length : 0;
            const isSelected = this.archiveViewingId === req.id;
            return `
              <div style="background: rgba(15,23,42,0.7); border: 1px solid ${isSelected ? '#a855f7' : 'var(--border-color)'}; border-radius: 10px; padding: 13px; cursor: pointer;" onclick="window.equipmentAuditsEngine.viewArchivedAudit('${req.id}')">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                  <div>
                    <div style="font-size:14px;font-weight:800;color:#f8fafc;">${this.escapeHtml(req.foreman_name)}</div>
                    <div style="font-size:11.5px;color:#93c5fd;">Job ${this.escapeHtml(req.job_number)} • ${this.escapeHtml(req.location || 'N/A')}</div>
                  </div>
                  <span style="font-size:11px;color:#cbd5e1;">${this.formatDateOnly(sub?.archived_at || sub?.submitted_at || req.updated_at)}</span>
                </div>
                <div style="font-size:11.5px;color:#94a3b8;margin-top:4px;">${this.escapeHtml(req.campaign_name)}</div>
                <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;font-size:11px;font-weight:700;">
                  <span style="padding:2px 7px;border-radius:6px;background:rgba(16,185,129,0.15);color:#6ee7b7;">🟢 ${c.matched || 0} Match</span>
                  <span style="padding:2px 7px;border-radius:6px;background:rgba(234,179,8,0.15);color:#fde047;">🟡 ${c.discrepancy || 0} Diff</span>
                  <span style="padding:2px 7px;border-radius:6px;background:rgba(249,115,22,0.15);color:#fdba74;">🟠 ${c.wrong_crew || 0} Crew</span>
                  <span style="padding:2px 7px;border-radius:6px;background:rgba(239,68,68,0.15);color:#fca5a5;">🔴 ${c.missing || 0} Miss</span>
                  <span style="padding:2px 7px;border-radius:6px;background:rgba(59,130,246,0.15);color:#93c5fd;">🔵 ${c.new_item || 0} New</span>
                </div>
                <div style="margin-top:7px;font-size:11px;color:#94a3b8;">${sub?.submitted_item_count || 0} items reported • ${actionsCount} actions recorded</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  renderArchiveDetailHtml(req, sub) {
    const snap = sub?.reconciliation_summary || {};
    const c = snap.counts || {};
    const items = Array.isArray(snap.items) ? snap.items : [];
    const actions = Array.isArray(sub?.applied_actions) ? sub.applied_actions : [];

    return `
      <div style="background: rgba(30,41,59,0.85); border: 1px solid rgba(168,85,247,0.45); border-radius: 12px; padding: 16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
          <div>
            <h3 style="margin:0;font-size:16px;color:#f8fafc;">🗄️ Archived Report: ${this.escapeHtml(req.foreman_name)} (Job ${this.escapeHtml(req.job_number)})</h3>
            <div style="font-size:12px;color:#94a3b8;margin-top:3px;">
              ${this.escapeHtml(req.campaign_name)} • Submitted ${this.formatShortDateTime(sub?.submitted_at)} by ${this.escapeHtml(sub?.submitted_by_name || req.foreman_name)} • Archived ${this.formatShortDateTime(sub?.archived_at)}
            </div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-secondary" style="font-size:12px;" onclick="window.equipmentAuditsEngine.printArchivedAudit('${req.id}')">🖨️ Print Summary</button>
            <button class="btn btn-secondary" style="font-size:12px;" onclick="window.equipmentAuditsEngine.viewArchivedAudit(null)">✕ Close</button>
          </div>
        </div>
        ${sub?.auditor_notes ? `<div style="margin-bottom:10px;padding:9px 12px;border-radius:8px;background:rgba(15,23,42,0.7);font-size:12.5px;color:#e2e8f0;"><strong>Auditor Notes:</strong> ${this.escapeHtml(sub.auditor_notes)}</div>` : ''}
        <div style="font-size:12px;color:#cbd5e1;margin-bottom:10px;">
          Reported: <strong>${c.totalReported || sub?.submitted_item_count || 0}</strong> |
          Matched: <strong>${c.matched || 0}</strong> |
          Discrepancies: <strong>${c.discrepancy || 0}</strong> |
          Wrong Crew: <strong>${c.wrong_crew || 0}</strong> |
          Missing: <strong>${c.missing || 0}</strong> |
          New: <strong>${c.new_item || 0}</strong>
        </div>
        ${actions.length > 0 ? `
          <div style="margin-bottom:10px;">
            <div style="font-size:11.5px;font-weight:700;color:#93c5fd;margin-bottom:4px;">ACTIONS APPLIED (${actions.length})</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${actions.map((a) => `<span style="font-size:11px;padding:3px 8px;border-radius:6px;background:rgba(16,185,129,0.14);color:#6ee7b7;">✓ ${this.escapeHtml(a.key.split(':')[0])}: ${this.escapeHtml(a.label)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border-color);border-radius:8px;background:rgba(15,23,42,0.6);">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="background:rgba(30,41,59,0.9);color:#94a3b8;text-align:left;">
                <th style="padding:7px 10px;">Result</th>
                <th style="padding:7px 10px;">Category</th>
                <th style="padding:7px 10px;">Item #</th>
                <th style="padding:7px 10px;">Details</th>
              </tr>
            </thead>
            <tbody>
              ${items.map((it) => `
                <tr style="border-bottom:1px solid rgba(148,163,184,0.1);">
                  <td style="padding:6px 10px;font-weight:700;">${this.escapeHtml(it.bucket)}</td>
                  <td style="padding:6px 10px;">${this.escapeHtml(it.catLabel)}</td>
                  <td style="padding:6px 10px;font-weight:700;">${this.escapeHtml(it.itemNum)}</td>
                  <td style="padding:6px 10px;color:#cbd5e1;">${it.diffs && it.diffs.length ? this.escapeHtml(it.diffs.map((d) => `${d.label}: ${d.appValue} → ${d.reportedValue}`).join('; ')) : this.escapeHtml(it.reported?.employeeName || it.appAssignedTo || '')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  printArchivedAudit(requestId) {
    const req = this.requests.find((r) => r.id === requestId);
    const sub = this.submissionsByReqId.get(requestId);
    if (!req || !sub) return;
    const snap = sub.reconciliation_summary || {};
    const c = snap.counts || {};
    const items = Array.isArray(snap.items) ? snap.items : [];
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) return;
    win.document.write(`
      <!DOCTYPE html><html><head><title>Equipment Audit — ${this.escapeHtml(req.foreman_name)}</title>
      <style>body{font-family:Arial,sans-serif;padding:24px;color:#111;} h1{font-size:20px;margin:0 0 6px;} table{width:100%;border-collapse:collapse;margin-top:14px;font-size:12px;} th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;} th{background:#f1f5f9;}</style></head><body>
      <h1>Crew Equipment Inventory Audit Report</h1>
      <div><strong>Foreman:</strong> ${this.escapeHtml(req.foreman_name)} | <strong>Job #:</strong> ${this.escapeHtml(req.job_number)} | <strong>Location:</strong> ${this.escapeHtml(req.location)}</div>
      <div><strong>Campaign:</strong> ${this.escapeHtml(req.campaign_name)} | <strong>Submitted:</strong> ${this.formatShortDateTime(sub.submitted_at)} | <strong>Archived:</strong> ${this.formatShortDateTime(sub.archived_at)}</div>
      <div style="margin-top:8px;"><strong>Summary:</strong> ${c.totalReported || 0} Reported • ${c.matched || 0} Matched • ${c.discrepancy || 0} Discrepancies • ${c.wrong_crew || 0} Wrong Crew • ${c.missing || 0} Missing • ${c.new_item || 0} New</div>
      ${sub.auditor_notes ? `<p><strong>Auditor Notes:</strong> ${this.escapeHtml(sub.auditor_notes)}</p>` : ''}
      <table><thead><tr><th>Bucket</th><th>Category</th><th>Item #</th><th>Details</th></tr></thead><tbody>
        ${items.map((it) => `<tr><td>${this.escapeHtml(it.bucket)}</td><td>${this.escapeHtml(it.catLabel)}</td><td>${this.escapeHtml(it.itemNum)}</td><td>${it.diffs && it.diffs.length ? this.escapeHtml(it.diffs.map((d) => `${d.label}: ${d.appValue} -> ${d.reportedValue}`).join('; ')) : this.escapeHtml(it.reported?.employeeName || it.appAssignedTo || '')}</td></tr>`).join('')}
      </tbody></table>
      <script>window.print();</script></body></html>
    `);
    win.document.close();
  }

  // ---------------------------------------------------------------------------
  // Filter & Selection State Setters + Utilities
  // ---------------------------------------------------------------------------
  onSearchInput(val) { this.searchQuery = String(val || ''); this.render(); }
  setCampaignFilter(val) { this.campaignFilter = val; this.render(); }
  setStatusFilter(val) { this.statusFilter = val; this.render(); }
  setReviewBucket(val) { this.reviewBucketFilter = val; this.render(); }
  setReviewCategory(val) { this.reviewCategoryFilter = val; this.render(); }
  setArchiveSearch(val) { this.archiveSearch = String(val || ''); this.render(); }
  viewArchivedAudit(id) { this.archiveViewingId = id; this.render(); }

  toggleSelectRequest(id, checked) {
    if (checked) this.selectedRequestIds.add(id);
    else this.selectedRequestIds.delete(id);
    this.render();
  }

  toggleSelectAllFiltered(checked) {
    const activeReqs = this.requests.filter((r) => r.status !== 'archived');
    activeReqs.forEach((r) => {
      if (checked) this.selectedRequestIds.add(r.id);
      else this.selectedRequestIds.delete(r.id);
    });
    this.render();
  }

  formatDateOnly(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  formatShortDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  toast(msg, type = 'info') {
    if (typeof window.showToast === 'function') window.showToast(msg, type);
    else console.log('[EquipmentAudits]', msg);
  }

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  escapeJs(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
  }
}

window.EquipmentAuditsEngine = EquipmentAuditsEngine;
