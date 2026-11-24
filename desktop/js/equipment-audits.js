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
      { key: 'hot_sticks', label: 'Hot Sticks', icon: '🔴', sheetName: 'Hot Sticks', isPersonal: false }
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
        jobName: 'Helena Shop — Ready For Delivery',
        location: 'Helena',
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

    this.SHOP_STATUS_POOLS.forEach((pool) => {
      let itemCount = 0;
      this.CATEGORIES.forEach((cat) => {
        const rows = (tables[cat.key] && Array.isArray(tables[cat.key].rows)) ? tables[cat.key].rows : [];
        rows.forEach((r) => {
          if (this.isRowInShopPool(r, pool)) itemCount++;
        });
      });

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
        employees: [pool.canonicalAssignedTo],
        phone: adminPhone,
        email: adminEmail
      });
    });

    return leaders;
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

  normDate(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (!s || s.toUpperCase() === 'N/A') return '';
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

  normPerson(val) {
    const clean = String(val || '').trim().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').toLowerCase();
    if (window.employeeResolver && typeof window.employeeResolver.resolveName === 'function') {
      try {
        const resolved = window.employeeResolver.resolveName(val);
        if (resolved) return String(resolved).trim().replace(/\s*\([^)]*\)/g, '').toLowerCase();
      } catch { /* ignore */ }
    }
    return clean;
  }

  getRowPrimaryId(catKey, row, headers) {
    const firstH = (headers && headers[0]) || '';
    const candidates = [
      firstH ? row[firstH] : '',
      row['Item #'], row['Glove'], row['Sleeve'], row['Blanket'], row['MACK'],
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

  compareItemFields(catKey, reported, appRow, options = {}) {
    const isShopPool = Boolean(options && options.isShopPool);
    const diffs = [];
    const check = (label, colName, repVal, appVal, normalizer, sheetValFormatter) => {
      const rStr = String(repVal || '').trim();
      if (!rStr) return; // Don't flag blank optional fields as discrepancy
      const aStr = String(appVal || '').trim();
      const rn = normalizer ? normalizer(rStr) : rStr.toLowerCase();
      const an = normalizer ? normalizer(aStr) : aStr.toLowerCase();
      if (rn !== an) {
        diffs.push({
          label,
          colName,
          appValue: aStr || '(blank)',
          reportedValue: sheetValFormatter ? sheetValFormatter(rStr) : rStr,
          rawReported: rStr
        });
      }
    };

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
    }
    return diffs;
  }

  reconcileAudit(req, sub) {
    const payload = (sub && (sub.submitted_payload || sub.draft_payload)) || {};
    const itemsByCat = (payload && payload.items) || {};
    const shopPool = this.getShopAuditPoolConfig(req);
    const crewNames = shopPool ? new Set() : this.getCrewMatchNamesSet(req);
    const isRowInScope = (row) => (shopPool ? this.isRowInShopPool(row, shopPool) : this.isRowActiveOnCrew(row, crewNames));
    const snap = this.db ? this.db.getSnapshot() : null;
    const tables = (snap && snap.tables) || {};

    const results = [];
    const counts = { matched: 0, discrepancy: 0, wrong_crew: 0, missing: 0, new_item: 0, totalReported: 0 };

    this.CATEGORIES.forEach((cat) => {
      const table = tables[cat.key] || { headers: [], rows: [], name: cat.sheetName };
      const rows = Array.isArray(table.rows) ? table.rows : [];
      const headers = Array.isArray(table.headers) ? table.headers : [];

      // Index all app rows by primary ID, ESL ID, and Serial #
      const byPrimary = new Map();
      const byAlt = new Map();
      rows.forEach((r, idx) => {
        const pid = this.normId(this.getRowPrimaryId(cat.key, r, headers));
        if (pid && !byPrimary.has(pid)) byPrimary.set(pid, { row: r, idx });
        const esl = this.normId(r['ESL ID']);
        if (esl && !byAlt.has(esl)) byAlt.set(esl, { row: r, idx });
        const ser = this.normId(r['Serial #']);
        if (ser && !byAlt.has(ser)) byAlt.set(ser, { row: r, idx });
      });

      const matchedAppIndices = new Set();
      const reportedList = Array.isArray(itemsByCat[cat.key]) ? itemsByCat[cat.key] : [];

      reportedList.forEach((rep) => {
        counts.totalReported++;
        const repId = this.normId(rep.itemNum);
        const repEsl = this.normId(rep.eslId);
        const repSer = this.normId(rep.serialNum);

        const found = (repId && byPrimary.get(repId)) ||
                      (repEsl && byAlt.get(repEsl)) ||
                      (repId && byAlt.get(repId)) ||
                      (repSer && byAlt.get(repSer)) ||
                      null;

        const keyId = `${cat.key}:${rep.id || repId}`;

        if (!found) {
          counts.new_item++;
          results.push({
            key: keyId,
            bucket: 'new_item',
            catKey: cat.key,
            catLabel: cat.label,
            catIcon: cat.icon,
            itemNum: rep.itemNum,
            reported: rep,
            appRow: null,
            diffs: []
          });
          return;
        }

        matchedAppIndices.add(found.idx);
        const appRow = found.row;
        const inScope = isRowInScope(appRow);
        const diffs = this.compareItemFields(cat.key, rep, appRow, { isShopPool: Boolean(shopPool) });

        if (!inScope) {
          counts.wrong_crew++;
          results.push({
            key: keyId,
            bucket: 'wrong_crew',
            catKey: cat.key,
            catLabel: cat.label,
            catIcon: cat.icon,
            itemNum: this.getRowPrimaryId(cat.key, appRow, headers) || rep.itemNum,
            reported: rep,
            appRow,
            appRowIdx: appRow._rowIdx || (found.idx + 2),
            diffs
          });
        } else if (diffs.length > 0) {
          counts.discrepancy++;
          results.push({
            key: keyId,
            bucket: 'discrepancy',
            catKey: cat.key,
            catLabel: cat.label,
            catIcon: cat.icon,
            itemNum: this.getRowPrimaryId(cat.key, appRow, headers) || rep.itemNum,
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
            itemNum: this.getRowPrimaryId(cat.key, appRow, headers) || rep.itemNum,
            reported: rep,
            appRow,
            appRowIdx: appRow._rowIdx || (found.idx + 2),
            diffs: []
          });
        }
      });

      // Anything currently in this crew / shop status in the App that was NOT reported
      rows.forEach((appRow, idx) => {
        if (matchedAppIndices.has(idx)) return;
        if (!isRowInScope(appRow)) return;
        const pid = this.getRowPrimaryId(cat.key, appRow, headers);
        if (!pid) return;
        counts.missing++;
        results.push({
          key: `${cat.key}:missing:${this.normId(pid)}:${idx}`,
          bucket: 'missing',
          catKey: cat.key,
          catLabel: cat.label,
          catIcon: cat.icon,
          itemNum: pid,
          reported: null,
          appRow,
          appRowIdx: appRow._rowIdx || (idx + 2),
          diffs: []
        });
      });
    });

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
            <option value="all" ${this.reviewCategoryFilter === 'all' ? 'selected' : ''}>All 9 Categories</option>
            ${this.CATEGORIES.map((c) => `<option value="${c.key}" ${this.reviewCategoryFilter === c.key ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('')}
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
    const meta = {
      matched: { border: 'rgba(16,185,129,0.35)', bg: 'rgba(16,185,129,0.08)', badge: '🟢 Matched', color: '#34d399' },
      discrepancy: { border: 'rgba(234,179,8,0.45)', bg: 'rgba(234,179,8,0.09)', badge: '🟡 Field Discrepancy', color: '#fde047' },
      wrong_crew: { border: 'rgba(249,115,22,0.45)', bg: 'rgba(249,115,22,0.09)', badge: shopPool ? '🟠 Wrong Status / Location' : '🟠 Wrong Crew / Status', color: '#fdba74' },
      missing: { border: 'rgba(239,68,68,0.45)', bg: 'rgba(239,68,68,0.09)', badge: shopPool ? `🔴 Missing from ${shopPool.name}` : '🔴 Missing from Field', color: '#fca5a5' },
      new_item: { border: 'rgba(59,130,246,0.45)', bg: 'rgba(59,130,246,0.09)', badge: '🔵 Unlogged / New Item', color: '#93c5fd' }
    }[item.bucket];

    let detailsHtml = '';
    if (item.bucket === 'discrepancy') {
      detailsHtml = `
        <div style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px;">
          ${item.diffs.map((d) => `
            <span style="font-size: 11.5px; padding: 3px 8px; border-radius: 6px; background: rgba(15,23,42,0.75); border: 1px solid rgba(234,179,8,0.35); color: #fef08a;">
              <strong>${this.escapeHtml(d.label)}:</strong> <span style="text-decoration:line-through;color:#94a3b8;">${this.escapeHtml(d.appValue)}</span> → <strong>${this.escapeHtml(d.reportedValue)}</strong>
            </span>
          `).join('')}
        </div>
      `;
    } else if (item.bucket === 'wrong_crew') {
      const curAssigned = item.appRow['Assigned To'] || '(blank)';
      const curStatus = item.appRow['Status'] || '(blank)';
      const curLoc = item.appRow['Location'] || '(blank)';
      const targetLabel = shopPool ? `${shopPool.name} (${shopPool.canonicalStatus})` : `${item.reported.employeeName || req.foreman_name} (${req.location || req.job_number})`;
      detailsHtml = `
        <div style="margin-top: 5px; font-size: 12px; color: #fed7aa;">
          Currently logged in app as: <strong>${this.escapeHtml(curAssigned)}</strong> (${this.escapeHtml(curStatus)} • ${this.escapeHtml(curLoc)}) → Audit found in <strong>${this.escapeHtml(targetLabel)}</strong>.
        </div>
        ${item.diffs.length > 0 ? `<div style="margin-top:4px;font-size:11.5px;color:#fde68a;">Also differs: ${item.diffs.map((d) => `${d.label}: ${d.appValue} → ${d.reportedValue}`).join(' | ')}</div>` : ''}
      `;
    } else if (item.bucket === 'missing') {
      const curAssigned = item.appRow['Assigned To'] || req.foreman_name;
      const curStatus = item.appRow['Status'] || '';
      const curDate = item.appRow['Test Date'] || item.appRow['Calibration Date'] || item.appRow['Pad Expiration'] || '';
      detailsHtml = `
        <div style="margin-top: 5px; font-size: 12px; color: #fecaca;">
          App shows <strong>${this.escapeHtml(curAssigned)}</strong>${curStatus ? ` (${this.escapeHtml(curStatus)})` : ''}${curDate ? ` • Date: ${this.escapeHtml(curDate)}` : ''}, but it was <strong>not reported</strong> on this audit.
        </div>
      `;
    } else if (item.bucket === 'new_item') {
      const r = item.reported;
      const specs = [shopPool ? '' : r.employeeName, r.type, r.model, r.size, r.itemClass ? `Class ${r.itemClass}` : '', r.kv, r.length, r.serialNum ? `S/N ${r.serialNum}` : '', r.eslId ? `ESL ${r.eslId}` : '', r.testDate ? `Tested ${this.toSheetDate(r.testDate)}` : '', r.calibrationDate ? `Cal ${this.toSheetDate(r.calibrationDate)}` : '', r.padExpiration ? `Pads Exp ${this.toSheetDate(r.padExpiration)}` : '', r.batteryExpiration ? `Battery Exp ${this.toSheetDate(r.batteryExpiration)}` : ''].filter(Boolean);
      detailsHtml = `
        <div style="margin-top: 5px; font-size: 12px; color: #bfdbfe;">
          Not found in ${this.escapeHtml(item.catLabel)} inventory. Reported specs: <strong>${this.escapeHtml(specs.join(' • ') || 'Basic entry')}</strong>
        </div>
      `;
    } else {
      const who = shopPool ? shopPool.name : (item.reported?.employeeName || item.appRow?.['Assigned To'] || req.foreman_name);
      detailsHtml = `<div style="margin-top: 3px; font-size: 11.5px; color: #a7f3d0;">Verified in ${this.escapeHtml(who)} — all dates and specs match.</div>`;
    }

    const escKey = this.escapeJs(item.key);
    let actionsHtml = '';
    if (appliedAction) {
      actionsHtml = `<span style="font-size:11.5px;font-weight:700;color:#6ee7b7;background:rgba(16,185,129,0.16);border:1px solid rgba(16,185,129,0.4);padding:4px 10px;border-radius:999px;">✓ ${this.escapeHtml(appliedAction.label || 'Resolved')}</span>`;
    } else if (item.bucket === 'discrepancy') {
      actionsHtml = `
        <button class="btn btn-primary admin-only-control" style="font-size:11.5px;padding:5px 10px;background:#ca8a04;border:none;" onclick="window.equipmentAuditsEngine.applyDiscrepancyUpdate('${escKey}')">✅ Update App Fields</button>
        <button class="btn btn-secondary" style="font-size:11.5px;padding:5px 9px;" onclick="window.equipmentAuditsEngine.dismissItem('${escKey}')">Dismiss</button>
      `;
    } else if (item.bucket === 'wrong_crew') {
      const reassignLabel = shopPool ? `🔄 Move to ${shopPool.name}` : '🔄 Reassign to Crew';
      actionsHtml = `
        <button class="btn btn-primary admin-only-control" style="font-size:11.5px;padding:5px 10px;background:#ea580c;border:none;" onclick="window.equipmentAuditsEngine.applyReassignToCrew('${escKey}')">${this.escapeHtml(reassignLabel)}</button>
        <button class="btn btn-secondary" style="font-size:11.5px;padding:5px 9px;" onclick="window.equipmentAuditsEngine.dismissItem('${escKey}')">Dismiss</button>
      `;
    } else if (item.bucket === 'new_item') {
      const addLabel = shopPool ? `➕ Add to ${shopPool.name}` : '➕ Add to Inventory';
      actionsHtml = `
        <button class="btn btn-primary admin-only-control" style="font-size:11.5px;padding:5px 10px;background:#2563eb;border:none;" onclick="window.equipmentAuditsEngine.applyAddNewItem('${escKey}')">${this.escapeHtml(addLabel)}</button>
        <button class="btn btn-secondary" style="font-size:11.5px;padding:5px 9px;" onclick="window.equipmentAuditsEngine.dismissItem('${escKey}')">Dismiss</button>
      `;
    } else if (item.bucket === 'missing') {
      const showReturnShelf = !shopPool || shopPool.jobNumber !== 'SHOP-ON-SHELF';
      actionsHtml = `
        <button class="btn btn-secondary admin-only-control" style="font-size:11.5px;padding:5px 9px;border-color:#ef4444;color:#fca5a5;" onclick="window.equipmentAuditsEngine.applyMarkMissingLost('${escKey}')">⚠️ Flag Lost / Locate</button>
        ${showReturnShelf ? `<button class="btn btn-secondary admin-only-control" style="font-size:11.5px;padding:5px 9px;color:#93c5fd;" onclick="window.equipmentAuditsEngine.applyReturnToShelf('${escKey}')">📦 Return On Shelf</button>` : ''}
        <button class="btn btn-secondary" style="font-size:11.5px;padding:5px 9px;" onclick="window.equipmentAuditsEngine.dismissItem('${escKey}')">Keep As-Is</button>
      `;
    }

    return `
      <div style="background:${meta.bg};border:1px solid ${meta.border};border-radius:10px;padding:11px 14px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;">
        <div style="flex:1;min-width:260px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:800;color:${meta.color};">${meta.badge}</span>
            <span style="font-size:12px;font-weight:700;color:#cbd5e1;">${item.catIcon} ${this.escapeHtml(item.catLabel)}</span>
            <span style="font-size:14px;font-weight:800;color:#ffffff;">#${this.escapeHtml(item.itemNum)}</span>
          </div>
          ${detailsHtml}
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

  async applyDiscrepancyUpdate(key) {
    const item = this.findReconcileItem(key);
    if (!item || !item.appRow) return;
    const hasAssignedDiff = item.diffs.some((d) => d.colName === 'Assigned To');
    const todayMdy = this.getLocalTodayMdy();
    if (hasAssignedDiff) {
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Date Assigned', todayMdy, { skipHistory: true });
    }
    for (const d of item.diffs) {
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, d.colName, d.reportedValue, { skipHistory: true });
    }
    if (hasAssignedDiff && typeof this.db.recordItemHistoryEvent === 'function') {
      const table = this.db.getTable(item.catKey);
      if (table) {
        await this.db.recordItemHistoryEvent(table.name, item.appRow, 'Reassigned via Equipment Audit');
      }
    }
    this.toast(`✅ Updated ${item.diffs.length} field(s) on ${item.catLabel} #${item.itemNum}`, 'success');
    await this.recordAppliedAction(key, `Updated ${item.diffs.map((d) => d.label).join(', ')}`);
  }

  async applyReassignToCrew(key) {
    const item = this.findReconcileItem(key);
    const req = this._lastReconciliation?.req;
    if (!item || !item.appRow || !req) return;
    const shopPool = this.getShopAuditPoolConfig(req);
    const targetStatus = shopPool ? shopPool.canonicalStatus : 'Assigned';
    const assignee = shopPool ? shopPool.canonicalAssignedTo : (item.reported?.employeeName || req.foreman_name);
    const targetLoc = shopPool ? shopPool.location : (req.location || '');
    const todayMdy = this.getLocalTodayMdy();

    // 1. Update Date Assigned FIRST (with skipHistory: true) so history event gets today's date, never the old date
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Date Assigned', todayMdy, { skipHistory: true });

    // 2. Apply any changed spec/date fields (e.g. Test Date, Calibration Date) with skipHistory: true
    for (const d of item.diffs) {
      if (d.colName !== 'Assigned To') {
        await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, d.colName, d.reportedValue, { skipHistory: true });
      }
    }

    // 3. Apply Location, Status, and Assigned To atomically (skipHistory: true on each intermediate cell)
    if (targetLoc) {
      await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Location', targetLoc, { skipHistory: true });
    }
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Status', targetStatus, { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Assigned To', assignee, { skipHistory: true });

    // 4. Record ONE clean history transition now that Date Assigned, Location, Status, and Assigned To are all final
    if (typeof this.db.recordItemHistoryEvent === 'function') {
      const table = this.db.getTable(item.catKey);
      if (table) {
        const histReason = shopPool
          ? `Found in ${shopPool.name} (Equipment Audit)`
          : `Reassigned via Equipment Audit (${req.foreman_name})`;
        await this.db.recordItemHistoryEvent(table.name, item.appRow, histReason);
      }
    }

    const actionText = shopPool ? `Moved to ${shopPool.name}` : `Reassigned to ${assignee}`;
    this.toast(`🔄 ${actionText} (${item.catLabel} #${item.itemNum})`, 'success');
    await this.recordAppliedAction(key, actionText);
  }

  async applyAddNewItem(key) {
    const item = this.findReconcileItem(key);
    const req = this._lastReconciliation?.req;
    if (!item || !item.reported || !req) return;
    const shopPool = this.getShopAuditPoolConfig(req);
    const r = item.reported;
    const targetStatus = shopPool ? shopPool.canonicalStatus : 'Assigned';
    const assignee = shopPool ? shopPool.canonicalAssignedTo : (r.employeeName || req.foreman_name);
    const loc = shopPool ? shopPool.location : (req.location || 'Helena');
    const todayIso = this.getLocalTodayIso();
    const todayMdy = this.getLocalTodayMdy();

    const testDateMdy = this.toSheetDate(r.testDate);
    const calDateMdy = this.toSheetDate(r.calibrationDate);
    const padExpMdy = this.toSheetDate(r.padExpiration);
    const batExpMdy = this.toSheetDate(r.batteryExpiration);

    const changeOutDate = (window.inventoryManager && typeof window.inventoryManager.calculateChangeOutDate === 'function')
      ? window.inventoryManager.calculateChangeOutDate(todayIso, loc, assignee, item.catKey, {
        testDate: r.testDate,
        calibrationDate: r.calibrationDate,
        padExpiration: r.padExpiration,
        batteryExpiration: r.batteryExpiration
      })
      : '';

    const newRow = {
      'Item #': r.itemNum,
      'Date Assigned': todayMdy,
      'Location': loc,
      'Status': targetStatus,
      'Assigned To': assignee,
      'Change Out Date': changeOutDate,
      'Picked For': '',
      'Notes': r.notes || `Added via Equipment Audit (${req.campaign_name})`
    };

    if (item.catKey === 'gloves' || item.catKey === 'sleeves') {
      newRow[item.catKey === 'gloves' ? 'Glove' : 'Sleeve'] = r.itemNum;
      newRow['ESL ID'] = r.eslId || '';
      newRow['Size'] = r.size || '';
      newRow['Class'] = r.itemClass || '2';
      newRow['Test Date'] = testDateMdy;
    } else if (item.catKey === 'blankets') {
      newRow['Blanket'] = r.itemNum;
      newRow['Type'] = r.type || 'Regular';
      newRow['Class'] = r.itemClass || '4';
      newRow['Test Date'] = testDateMdy;
    } else if (item.catKey === 'macks') {
      newRow['MACK'] = r.itemNum;
      newRow['KV'] = r.kv || '15KV';
      newRow['Size'] = r.size || '';
      newRow['Length'] = r.length || '';
      newRow['Test Date'] = testDateMdy;
    } else if (item.catKey === 'hv_testers' || item.catKey === 'phasing_sets') {
      newRow[item.catKey === 'hv_testers' ? 'HVT #' : 'Phasing Set'] = r.itemNum;
      newRow['Model'] = r.model || '';
      newRow['KV'] = r.kv || '';
      newRow['Serial #'] = r.serialNum || '';
      newRow['Calibration Date'] = calDateMdy;
      if (item.catKey === 'phasing_sets') newRow['Replacement Date'] = changeOutDate;
    } else if (item.catKey === 'aed') {
      newRow['AED'] = r.itemNum;
      newRow['Model'] = r.model || 'ZOLL AED 3';
      newRow['Serial #'] = r.serialNum || '';
      newRow['Pad Expiration'] = padExpMdy;
      newRow['Battery Expiration'] = batExpMdy;
    } else if (item.catKey === 'grounds') {
      newRow['Serial #'] = r.itemNum;
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
    this.toast(`➕ Added ${item.catLabel} #${r.itemNum} to inventory!`, 'success');
    await this.recordAppliedAction(key, `Added to ${item.catLabel} (${assignee})`);
  }

  async applyMarkMissingLost(key) {
    const item = this.findReconcileItem(key);
    const req = this._lastReconciliation?.req;
    if (!item || !item.appRow || !req) return;
    const todayMdy = this.getLocalTodayMdy();
    const noteText = `LOST-LOCATE (Missing on ${req.foreman_name} audit ${todayMdy})`;
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Date Assigned', todayMdy, { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Status', 'Lost', { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Notes', noteText, { skipHistory: true });
    if (typeof this.db.recordItemHistoryEvent === 'function') {
      const table = this.db.getTable(item.catKey);
      if (table) await this.db.recordItemHistoryEvent(table.name, item.appRow, noteText);
    }
    this.toast(`⚠️ Flagged ${item.catLabel} #${item.itemNum} as Lost / Locate`, 'warning');
    await this.recordAppliedAction(key, 'Flagged Lost / Locate');
  }

  async applyReturnToShelf(key) {
    const item = this.findReconcileItem(key);
    if (!item || !item.appRow) return;
    const todayMdy = this.getLocalTodayMdy();
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Date Assigned', todayMdy, { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Location', 'Helena', { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Status', 'On Shelf', { skipHistory: true });
    await this.updateTableCellByColName(item.catKey, item.appRow, item.appRowIdx, 'Assigned To', 'On Shelf', { skipHistory: true });
    if (typeof this.db.recordItemHistoryEvent === 'function') {
      const table = this.db.getTable(item.catKey);
      if (table) await this.db.recordItemHistoryEvent(table.name, item.appRow, 'Returned to On Shelf (Equipment Audit)');
    }
    this.toast(`📦 Returned ${item.catLabel} #${item.itemNum} to On Shelf`, 'success');
    await this.recordAppliedAction(key, 'Returned to On Shelf');
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
