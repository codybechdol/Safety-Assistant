/**
 * Safety Assistant Desktop - Site Audits Engine
 *
 * Manages Project Site Audit Reports received in Gmail (subject: "Project Site Audit Report ...").
 * Extracts Audit Date, Job Number, Crew Location, Foreman, Inspector, Site Inspection notes,
 * and Corrections Needed; prioritizes Job Tracking for Location & Foreman (showing any PDF
 * variation in parentheses); provides Quarter/Location/Foreman filters, Cards & Table views,
 * active-job coverage tracking, inline PDF viewing, and high-res photo lightbox galleries.
 */

class SiteAuditsEngine {
  constructor(db) {
    this.db = db;
    this.selectedYear = new Date().getFullYear().toString();
    this.selectedQuarter = 'all'; // 'all', 'Q1', 'Q2', 'Q3', 'Q4'
    this.selectedLocation = 'all';
    this.selectedForeman = 'all';
    this.selectedInspector = 'all';
    this.selectedCorrectionFilter = 'all'; // 'all', 'corrections', 'clean', 'reviewed'
    this.viewMode = localStorage.getItem('sa_site_audits_view_mode') || 'cards'; // 'cards' | 'table'
    this.showUncoveredDrawer = false;
    this.searchQuery = '';
    this.isScanning = false;
    this.attachmentsCache = new Map(); // emailId -> { pdf, photos }
    this.lightboxState = {
      isOpen: false,
      emailId: '',
      auditId: '',
      photos: [],
      currentIndex: 0
    };

    window.siteAuditsEngine = this;
  }

  init() {
    console.log('SiteAuditsEngine initialized');
  }

  /**
   * Normalizes date strings (MM/DD/YYYY, YYYY-MM-DD, ISO) to local noon Date object
   */
  parseDate(val) {
    if (!val || val === 'N/A' || val === '—') return null;
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    const s = String(val).trim();
    if (!s) return null;

    if (s.includes('T') && /^\d{4}-\d{2}-\d{2}/.test(s)) {
      const datePart = s.split('T')[0].split('-');
      const dt = new Date(parseInt(datePart[0], 10), parseInt(datePart[1], 10) - 1, parseInt(datePart[2], 10), 12, 0, 0);
      return isNaN(dt.getTime()) ? null : dt;
    }

    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
      const parts = s.split('-');
      const dt = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0);
      return isNaN(dt.getTime()) ? null : dt;
    }

    if (s.includes('/')) {
      const parts = s.split(' ')[0].split('/');
      if (parts.length === 3) {
        const m = parseInt(parts[0], 10) - 1;
        const d = parseInt(parts[1], 10);
        let y = parseInt(parts[2], 10);
        if (y < 100) y += 2000;
        const dt = new Date(y, m, d, 12, 0, 0);
        return isNaN(dt.getTime()) ? null : dt;
      }
    }

    const dashUs = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (dashUs) {
      let y = parseInt(dashUs[3], 10);
      if (y < 100) y += 2000;
      const dt = new Date(y, parseInt(dashUs[1], 10) - 1, parseInt(dashUs[2], 10), 12, 0, 0);
      return isNaN(dt.getTime()) ? null : dt;
    }

    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
  }

  formatDisplayDate(rawDate) {
    if (!rawDate) return '';
    const d = this.parseDate(rawDate);
    if (d && !isNaN(d.getTime())) {
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const yy = d.getFullYear();
      return `${mm}/${dd}/${yy}`;
    }
    return String(rawDate).trim();
  }

  /**
   * Resolves Location or Foreman so Job Tracking always wins, putting any PDF variation in parentheses.
   * Handles values already stored as "JobTrackingVal (PdfVal)" cleanly without double-parenthesizing.
   */
  resolveFieldWithJobTracking(storedVal, jtVal) {
    const raw = String(storedVal || '').trim();
    const jt = String(jtVal || '').trim();

    let storedBase = raw;
    let storedVar = '';
    const parenMatch = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (parenMatch) {
      storedBase = parenMatch[1].trim();
      storedVar = parenMatch[2].trim();
    }

    if (jt) {
      const jtNorm = jt.toLowerCase().replace(/\s+/g, ' ');
      if (storedVar) {
        const varNorm = storedVar.toLowerCase().replace(/\s+/g, ' ');
        if (jtNorm === varNorm) {
          return { primary: jt, variation: '', display: jt };
        }
        return { primary: jt, variation: storedVar, display: `${jt} (${storedVar})` };
      }
      if (storedBase) {
        const baseNorm = storedBase.toLowerCase().replace(/\s+/g, ' ');
        if (jtNorm !== baseNorm) {
          return { primary: jt, variation: storedBase, display: `${jt} (${storedBase})` };
        }
      }
      return { primary: jt, variation: '', display: jt };
    }

    return {
      primary: storedBase,
      variation: storedVar,
      display: raw
    };
  }

  /**
   * Loads all site audits from local snapshot and cross-references Job Tracking
   */
  loadAudits() {
    const snap = this.db?.getSnapshot?.();
    const table = snap?.tables?.['site_audits'] || this.db?.getTable?.('site_audits');
    const rows = table?.rows || [];

    // Build Job Tracking lookup (Job Number -> { foreman, location, jobName, status })
    const jtTable = snap?.tables?.['job_tracking'] || this.db?.getTable?.('job_tracking');
    const jtRows = jtTable?.rows || [];
    const jobInfoMap = new Map();
    const activeJobs = [];

    const STATUS_LOCS = new Set(['vacation', 'light duty', 'weeds', 'leave', 'previous employee', 'medical', "worker's comp", 'unknown']);

    jtRows.forEach(jr => {
      const rawJobNum = String(jr['Job Number'] || jr['Job #'] || '').trim().replace(/^job\s*#?\s*/i, '');
      if (!rawJobNum) return;
      const fMan = String(jr['Foreman'] || jr['Crew Lead'] || jr['Lead'] || '').trim();
      let city = String(jr['Location'] || jr['Job Location'] || '').trim();
      // Strip parenthesized status if ever present in Job Tracking location
      const locParen = city.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (locParen && STATUS_LOCS.has(locParen[2].trim().toLowerCase())) {
        city = locParen[1].trim();
      } else if (STATUS_LOCS.has(city.toLowerCase())) {
        city = '';
      }
      const jName = String(jr['Job Name'] || '').trim();
      const jStatus = String(jr['Status'] || '').trim();

      const info = { foreman: fMan, location: city, jobName: jName, status: jStatus, jobNumber: rawJobNum };
      if (!jobInfoMap.has(rawJobNum)) jobInfoMap.set(rawJobNum, info);
      const noZero = rawJobNum.replace(/^0+/, '');
      if (noZero && !jobInfoMap.has(noZero)) jobInfoMap.set(noZero, info);
      const baseJob = rawJobNum.replace(/\s*\([^)]*\)/g, '').trim();
      if (baseJob && !jobInfoMap.has(baseJob)) jobInfoMap.set(baseJob, info);

      // Track active field crews for coverage metric (exclude 002- lost/destroyed and 005- office/light duty)
      const isExcludedPrefix = /^0*(2|5)-/.test(rawJobNum);
      if (jStatus.toLowerCase() === 'active' && !isExcludedPrefix) {
        activeJobs.push(info);
      }
    });

    this._activeFieldJobs = activeJobs;

    return rows.map((row, idx) => {
      const rawDate = row['Audit Date'] || row['Date'] || row['Date Received'] || '';
      const dObj = this.parseDate(rawDate) || this.parseDate(row['Date Received']) || new Date();
      const year = dObj.getFullYear().toString();
      const qNum = Math.floor(dObj.getMonth() / 3) + 1;
      const quarterKey = `Q${qNum}`;
      const yearQuarter = `${year}-${quarterKey}`;

      const rawJob = String(row['Job #'] || row['Job Number'] || '').trim().replace(/^job\s*#?\s*/i, '');
      const jtMatch = jobInfoMap.get(rawJob)
        || jobInfoMap.get(rawJob.replace(/^0+/, ''))
        || jobInfoMap.get(rawJob.replace(/\s*\([^)]*\)/g, '').trim())
        || {};

      const locResolved = this.resolveFieldWithJobTracking(row['Location'], jtMatch.location);
      const foremanResolved = this.resolveFieldWithJobTracking(row['Foreman'], jtMatch.foreman);

      const corrRaw = String(row['Corrections Needed'] || '').trim();
      const hasCorrections = /^yes\b/i.test(corrRaw);
      const notes = String(row['Notes'] || '').trim();
      const isOcrPending = notes.includes('OCR_PENDING');

      return {
        id: row.id || `sa_${idx}_${row['Email ID'] || idx}`,
        rowIndex: row._rowIdx || idx + 2,
        emailId: String(row['Email ID'] || '').trim(),
        dateReceived: String(row['Date Received'] || '').trim(),
        auditDate: rawDate,
        displayDate: this.formatDisplayDate(rawDate),
        dateObj: dObj,
        year,
        quarter: quarterKey,
        yearQuarter,
        jobNumber: rawJob,
        jobName: jtMatch.jobName || '',
        locationPrimary: locResolved.primary || 'Unassigned',
        locationVariation: locResolved.variation,
        locationDisplay: locResolved.display || 'Unassigned',
        foremanPrimary: foremanResolved.primary || 'Unassigned',
        foremanVariation: foremanResolved.variation,
        foremanDisplay: foremanResolved.display || 'Unassigned',
        inspector: String(row['Inspector'] || '').trim(),
        siteInspection: String(row['Site Inspection'] || '').trim(),
        correctionsNeeded: corrRaw,
        hasCorrections,
        photoCount: parseInt(row['Photo Count'] || 0, 10) || 0,
        pdfFilename: String(row['PDF Filename'] || (rawJob ? `${rawJob}.pdf` : 'Site_Audit.pdf')).trim(),
        status: String(row['Status'] || (hasCorrections ? 'Corrections Needed' : 'Logged')).trim(),
        notes,
        isOcrPending
      };
    });
  }

  canEdit() {
    if (window.currentRoleMode === 'view_only') return false;
    if (window.supabaseSync && typeof window.supabaseSync.canEditCurrentContext === 'function') {
      return window.supabaseSync.canEditCurrentContext('site-audits-view');
    }
    return true;
  }

  /**
   * Main render function for the Site Audits workspace
   */
  render() {
    const container = document.getElementById('site-audits-content');
    if (!container) return;

    const allAudits = this.loadAudits();

    // Auto-fetch from cloud DB on initial load if local snapshot doesn't have rows yet
    if (allAudits.length === 0 && !this._initialFetchAttempted) {
      this._initialFetchAttempted = true;
      setTimeout(() => this.refresh(true), 50);
    }

    // Available Years
    const yearSet = new Set();
    allAudits.forEach(a => {
      if (a.year) yearSet.add(a.year);
    });
    const curYearStr = new Date().getFullYear().toString();
    yearSet.add(curYearStr);
    const availableYears = Array.from(yearSet).sort((a, b) => b.localeCompare(a));
    if (this.selectedYear !== 'all' && !yearSet.has(this.selectedYear)) {
      this.selectedYear = availableYears[0] || curYearStr;
    }

    // Filter by Year
    const yearAudits = (this.selectedYear === 'all')
      ? allAudits
      : allAudits.filter(a => a.year === this.selectedYear);

    // Quarter counts for selected year
    const qCounts = {
      all: yearAudits.length,
      Q1: yearAudits.filter(a => a.quarter === 'Q1').length,
      Q2: yearAudits.filter(a => a.quarter === 'Q2').length,
      Q3: yearAudits.filter(a => a.quarter === 'Q3').length,
      Q4: yearAudits.filter(a => a.quarter === 'Q4').length
    };

    // Collect distinct Locations & Foremen from yearAudits (so dropdowns stay populated)
    const locationSet = new Set();
    const foremanSet = new Set();
    yearAudits.forEach(a => {
      if (a.locationPrimary && a.locationPrimary !== 'Unassigned') locationSet.add(a.locationPrimary);
      if (a.foremanPrimary && a.foremanPrimary !== 'Unassigned') foremanSet.add(a.foremanPrimary);
    });
    const availableLocations = Array.from(locationSet).sort((a, b) => a.localeCompare(b));
    const availableForemen = Array.from(foremanSet).sort((a, b) => a.localeCompare(b));

    if (this.selectedLocation !== 'all' && !locationSet.has(this.selectedLocation)) {
      this.selectedLocation = 'all';
    }
    if (this.selectedForeman !== 'all' && !foremanSet.has(this.selectedForeman)) {
      this.selectedForeman = 'all';
    }

    // Apply filters
    const scopeAudits = (this.selectedQuarter === 'all')
      ? yearAudits
      : yearAudits.filter(a => a.quarter === this.selectedQuarter);

    // Aggregate counts by Inspector (within selected Year + Quarter)
    const inspectorCountsMap = new Map();
    scopeAudits.forEach(a => {
      const rawInsp = String(a.inspector || '').trim();
      const key = rawInsp ? rawInsp.toLowerCase().replace(/\s+/g, ' ') : '__unspecified__';
      const label = rawInsp || 'Unspecified';
      if (!inspectorCountsMap.has(key)) {
        inspectorCountsMap.set(key, { key, name: label, count: 0, isUnspecified: !rawInsp });
      }
      inspectorCountsMap.get(key).count++;
    });
    const inspectorCounts = Array.from(inspectorCountsMap.values()).sort((a, b) => {
      if (a.isUnspecified !== b.isUnspecified) return a.isUnspecified ? 1 : -1;
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });

    if (this.selectedInspector !== 'all' && !inspectorCountsMap.has(this.selectedInspector)) {
      this.selectedInspector = 'all';
    }

    let filtered = scopeAudits;
    if (this.selectedLocation !== 'all') {
      filtered = filtered.filter(a => a.locationPrimary === this.selectedLocation);
    }
    if (this.selectedForeman !== 'all') {
      filtered = filtered.filter(a => a.foremanPrimary === this.selectedForeman);
    }
    if (this.selectedInspector !== 'all') {
      filtered = filtered.filter(a => {
        const rawInsp = String(a.inspector || '').trim();
        const key = rawInsp ? rawInsp.toLowerCase().replace(/\s+/g, ' ') : '__unspecified__';
        return key === this.selectedInspector;
      });
    }
    if (this.selectedCorrectionFilter === 'corrections') {
      filtered = filtered.filter(a => a.hasCorrections);
    } else if (this.selectedCorrectionFilter === 'clean') {
      filtered = filtered.filter(a => !a.hasCorrections);
    } else if (this.selectedCorrectionFilter === 'reviewed') {
      filtered = filtered.filter(a => a.status.toLowerCase() === 'reviewed');
    }

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase().trim();
      filtered = filtered.filter(a => {
        return (
          a.jobNumber.toLowerCase().includes(q) ||
          a.jobName.toLowerCase().includes(q) ||
          a.locationDisplay.toLowerCase().includes(q) ||
          a.foremanDisplay.toLowerCase().includes(q) ||
          a.inspector.toLowerCase().includes(q) ||
          a.siteInspection.toLowerCase().includes(q) ||
          a.correctionsNeeded.toLowerCase().includes(q) ||
          a.displayDate.toLowerCase().includes(q)
        );
      });
    }

    // Sort newest first
    filtered.sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime());

    // Active Field Jobs Coverage (for selected quarter or year)
    const activeJobs = this._activeFieldJobs || [];
    const auditedJobKeys = new Set();
    scopeAudits.forEach(a => {
      if (a.jobNumber) {
        auditedJobKeys.add(a.jobNumber);
        auditedJobKeys.add(a.jobNumber.replace(/^0+/, ''));
        auditedJobKeys.add(a.jobNumber.replace(/\s*\([^)]*\)/g, '').trim());
      }
    });

    const uncoveredJobs = activeJobs.filter(j => {
      const noZ = j.jobNumber.replace(/^0+/, '');
      const base = j.jobNumber.replace(/\s*\([^)]*\)/g, '').trim();
      return !auditedJobKeys.has(j.jobNumber) && !auditedJobKeys.has(noZ) && !auditedJobKeys.has(base);
    });
    const coveredCount = Math.max(0, activeJobs.length - uncoveredJobs.length);
    const correctionsCount = yearAudits.filter(a => a.hasCorrections).length;

    const countBadge = document.getElementById('site-audits-row-count');
    if (countBadge) {
      countBadge.textContent = `${filtered.length} audit${filtered.length === 1 ? '' : 's'}`;
    }

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 16px; padding: 18px 24px; max-width: 1500px; margin: 0 auto; width: 100%;">

        <!-- Top Stats / Metric Header -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px;">
          <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #94a3b8;">📋 Total Audits (${this.selectedYear === 'all' ? 'All' : this.selectedYear})</div>
            <div style="font-size: 24px; font-weight: 800; color: #38bdf8; margin-top: 4px;">${qCounts.all}</div>
            <div style="font-size: 11px; color: #cbd5e1; margin-top: 2px;">${correctionsCount > 0 ? `⚠️ ${correctionsCount} with corrections` : '✅ No corrections flagged'}</div>
          </div>
          <div onclick="window.siteAuditsEngine.toggleUncoveredDrawer()" style="background: var(--bg-primary); border: 1px solid ${this.showUncoveredDrawer ? '#38bdf8' : 'var(--border-color)'}; border-radius: 8px; padding: 12px 16px; cursor: pointer;" title="Click to view active jobs not yet audited in this period">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #94a3b8;">🎯 Active Crew Coverage</div>
            <div style="font-size: 24px; font-weight: 800; color: ${uncoveredJobs.length === 0 && activeJobs.length > 0 ? '#34d399' : '#fbbf24'}; margin-top: 4px;">${coveredCount} / ${activeJobs.length}</div>
            <div style="font-size: 11px; color: #93c5fd; margin-top: 2px;">${uncoveredJobs.length > 0 ? `${uncoveredJobs.length} active job${uncoveredJobs.length === 1 ? '' : 's'} pending audit ▾` : 'All active jobs audited'}</div>
          </div>
          <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #94a3b8;">🌸 Q1 (Jan – Mar)</div>
            <div style="font-size: 24px; font-weight: 800; color: #60a5fa; margin-top: 4px;">${qCounts.Q1}</div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">Winter / Early Spring</div>
          </div>
          <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #94a3b8;">☀️ Q2 (Apr – Jun)</div>
            <div style="font-size: 24px; font-weight: 800; color: #34d399; margin-top: 4px;">${qCounts.Q2}</div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">Spring Construction</div>
          </div>
          <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #94a3b8;">🍂 Q3 (Jul – Sep)</div>
            <div style="font-size: 24px; font-weight: 800; color: #f59e0b; margin-top: 4px;">${qCounts.Q3}</div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">Peak Summer Work</div>
          </div>
          <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #94a3b8;">❄️ Q4 (Oct – Dec)</div>
            <div style="font-size: 24px; font-weight: 800; color: #c084fc; margin-top: 4px;">${qCounts.Q4}</div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">Fall / Early Winter</div>
          </div>
        </div>

        <!-- Audits by Inspector Counts Bar -->
        ${inspectorCounts.length > 0 ? `
          <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-right: 2px;">
              🕵️ Audits by Inspector (${this.selectedQuarter === 'all' ? (this.selectedYear === 'all' ? 'All' : this.selectedYear) : `${this.selectedYear === 'all' ? 'All' : this.selectedYear} ${this.selectedQuarter}`}):
            </span>
            <button class="tag-pill-btn ${this.selectedInspector === 'all' ? 'active' : ''}" onclick="window.siteAuditsEngine.setInspectorFilter('all')" style="${this.selectedInspector === 'all' ? 'background: rgba(56, 189, 248, 0.22); color: #bae6fd; border-color: #38bdf8;' : 'background: rgba(148, 163, 184, 0.12); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.3);'}">
              <span>All Inspectors</span>
              <span style="background: rgba(0, 0, 0, 0.25); padding: 1px 6px; border-radius: 10px; font-size: 11px; font-weight: 800;">${scopeAudits.length}</span>
            </button>
            ${inspectorCounts.map(item => {
              const isSelected = this.selectedInspector === item.key;
              return `
                <button class="tag-pill-btn ${isSelected ? 'active' : ''}" onclick="window.siteAuditsEngine.setInspectorFilter('${this.escapeJs(item.key)}')" style="${isSelected
                  ? 'background: #a855f7; color: #fff; border-color: #c084fc;'
                  : (item.isUnspecified
                      ? 'background: rgba(148, 163, 184, 0.12); color: #94a3b8; border-color: rgba(148, 163, 184, 0.25);'
                      : 'background: rgba(168, 85, 247, 0.14); color: #d8b4fe; border-color: rgba(168, 85, 247, 0.35);')}">
                  <span>${item.isUnspecified ? '❓' : '🕵️'} ${this.escapeHtml(item.name)}</span>
                  <span style="background: ${isSelected ? 'rgba(0, 0, 0, 0.25)' : 'rgba(15, 23, 42, 0.55)'}; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 800;">${item.count}</span>
                </button>
              `;
            }).join('')}
          </div>
        ` : ''}

        ${this.showUncoveredDrawer ? `
          <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 8px; padding: 14px 18px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <div style="font-size: 13px; font-weight: 800; color: #38bdf8;">
                🎯 Active Jobs Not Yet Audited (${this.selectedQuarter === 'all' ? this.selectedYear : `${this.selectedYear} ${this.selectedQuarter}`})
              </div>
              <button class="btn btn-secondary" style="font-size: 11px; padding: 3px 10px;" onclick="window.siteAuditsEngine.toggleUncoveredDrawer()">Hide ✕</button>
            </div>
            ${uncoveredJobs.length === 0 ? `
              <div style="font-size: 12.5px; color: #34d399; font-weight: 600;">✅ All ${activeJobs.length} active field jobs have been audited in this period!</div>
            ` : `
              <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                ${uncoveredJobs.map(j => `
                  <span style="background: rgba(30, 41, 59, 0.9); border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 6px; padding: 5px 10px; font-size: 12px; color: #e2e8f0; display: inline-flex; align-items: center; gap: 6px;">
                    <strong style="color: #60a5fa;">#${this.escapeHtml(j.jobNumber)}</strong>
                    ${j.location ? `<span style="color: #94a3b8;">(${this.escapeHtml(j.location)})</span>` : ''}
                    ${j.foreman ? `<span style="color: #34d399;">• ${this.escapeHtml(j.foreman)}</span>` : ''}
                  </span>
                `).join('')}
              </div>
            `}
          </div>
        ` : ''}

        <!-- Quarter Navigation Tabs & Year / View Selector -->
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 14px;">
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <button class="quarter-tab-btn ${this.selectedQuarter === 'all' ? 'active' : ''}" onclick="window.siteAuditsEngine.setQuarter('all')">
              <span>📅 All Quarters</span>
              <span class="q-badge">${qCounts.all}</span>
            </button>
            <button class="quarter-tab-btn ${this.selectedQuarter === 'Q1' ? 'active' : ''}" onclick="window.siteAuditsEngine.setQuarter('Q1')">
              <span>🌸 Q1</span>
              <span class="q-badge">${qCounts.Q1}</span>
            </button>
            <button class="quarter-tab-btn ${this.selectedQuarter === 'Q2' ? 'active' : ''}" onclick="window.siteAuditsEngine.setQuarter('Q2')">
              <span>☀️ Q2</span>
              <span class="q-badge">${qCounts.Q2}</span>
            </button>
            <button class="quarter-tab-btn ${this.selectedQuarter === 'Q3' ? 'active' : ''}" onclick="window.siteAuditsEngine.setQuarter('Q3')">
              <span>🍂 Q3</span>
              <span class="q-badge">${qCounts.Q3}</span>
            </button>
            <button class="quarter-tab-btn ${this.selectedQuarter === 'Q4' ? 'active' : ''}" onclick="window.siteAuditsEngine.setQuarter('Q4')">
              <span>❄️ Q4</span>
              <span class="q-badge">${qCounts.Q4}</span>
            </button>
          </div>

          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <div style="display: inline-flex; align-items: center; gap: 3px; background: rgba(0,0,0,0.25); border: 1px solid var(--border-color); border-radius: 6px; padding: 2px 4px;">
              <button class="btn btn-secondary ${this.viewMode === 'cards' ? 'active' : ''}" style="font-size: 11px; padding: 4px 10px; border-radius: 4px;" onclick="window.siteAuditsEngine.setViewMode('cards')">
                🗂️ Cards
              </button>
              <button class="btn btn-secondary ${this.viewMode === 'table' ? 'active' : ''}" style="font-size: 11px; padding: 4px 10px; border-radius: 4px;" onclick="window.siteAuditsEngine.setViewMode('table')">
                📊 Table
              </button>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <label for="sa-year-select" style="font-size: 12px; font-weight: 700; color: #94a3b8;">Year:</label>
              <select id="sa-year-select" onchange="window.siteAuditsEngine.setYear(this.value)" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 10px; color: #60a5fa; font-size: 12.5px; font-weight: 700;">
                <option value="all" ${this.selectedYear === 'all' ? 'selected' : ''}>All Years</option>
                ${availableYears.map(yr => `<option value="${yr}" ${this.selectedYear === yr ? 'selected' : ''}>${yr}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>

        <!-- Secondary Filters: Location, Foreman, Corrections Status -->
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: rgba(15, 23, 42, 0.35); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 14px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <label for="sa-loc-filter" style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">📍 Location:</label>
            <select id="sa-loc-filter" onchange="window.siteAuditsEngine.setLocationFilter(this.value)" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 5px 10px; color: #e2e8f0; font-size: 12.5px; font-weight: 600;">
              <option value="all" ${this.selectedLocation === 'all' ? 'selected' : ''}>All Locations (${availableLocations.length})</option>
              ${availableLocations.map(loc => `<option value="${this.escapeHtml(loc)}" ${this.selectedLocation === loc ? 'selected' : ''}>${this.escapeHtml(loc)}</option>`).join('')}
            </select>
          </div>

          <div style="display: flex; align-items: center; gap: 6px;">
            <label for="sa-foreman-filter" style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">👷 Foreman:</label>
            <select id="sa-foreman-filter" onchange="window.siteAuditsEngine.setForemanFilter(this.value)" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 5px 10px; color: #34d399; font-size: 12.5px; font-weight: 600;">
              <option value="all" ${this.selectedForeman === 'all' ? 'selected' : ''}>All Foremen (${availableForemen.length})</option>
              ${availableForemen.map(fm => `<option value="${this.escapeHtml(fm)}" ${this.selectedForeman === fm ? 'selected' : ''}>${this.escapeHtml(fm)}</option>`).join('')}
            </select>
          </div>

          <div style="display: flex; align-items: center; gap: 6px;">
            <label for="sa-corr-filter" style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">🔍 Status:</label>
            <select id="sa-corr-filter" onchange="window.siteAuditsEngine.setCorrectionFilter(this.value)" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 5px 10px; color: #fcd34d; font-size: 12.5px; font-weight: 600;">
              <option value="all" ${this.selectedCorrectionFilter === 'all' ? 'selected' : ''}>All Audits</option>
              <option value="corrections" ${this.selectedCorrectionFilter === 'corrections' ? 'selected' : ''}>⚠️ Corrections Needed</option>
              <option value="clean" ${this.selectedCorrectionFilter === 'clean' ? 'selected' : ''}>✅ No Corrections</option>
              <option value="reviewed" ${this.selectedCorrectionFilter === 'reviewed' ? 'selected' : ''}>👁️ Marked Reviewed</option>
            </select>
          </div>

          ${(this.selectedLocation !== 'all' || this.selectedForeman !== 'all' || this.selectedInspector !== 'all' || this.selectedCorrectionFilter !== 'all' || this.searchQuery) ? `
            <button class="btn btn-secondary" style="font-size: 11px; padding: 4px 10px; margin-left: auto;" onclick="window.siteAuditsEngine.clearFilters()">
              ✕ Clear Filters
            </button>
          ` : ''}
        </div>

        <!-- Audits List / Table -->
        <div id="site-audits-list-container">
          ${this.viewMode === 'table' ? this.renderAuditsTable(filtered) : this.renderAuditsCards(filtered)}
        </div>

      </div>
    `;
  }

  renderEmptyState() {
    const canEdit = this.canEdit();
    return `
      <div style="background: var(--bg-primary); border: 1px dashed var(--border-color); border-radius: 12px; padding: 48px 24px; text-align: center; color: var(--text-muted); margin-top: 12px;">
        <div style="font-size: 42px; margin-bottom: 12px;">📋</div>
        <h3 style="font-size: 16px; font-weight: 700; color: #cbd5e1; margin-bottom: 6px;">No Site Audits Found</h3>
        <p style="font-size: 13px; max-width: 500px; margin: 0 auto 16px auto; color: #94a3b8; line-height: 1.5;">
          ${this.searchQuery ? `No site audits match "${this.escapeHtml(this.searchQuery)}".` : `No site audits logged for this selection yet. Click "Scan Gmail for Audits" to import ${this.selectedYear === 'all' ? new Date().getFullYear() : this.selectedYear} Project Site Audit Reports.`}
        </p>
        ${canEdit ? `
          <div style="display: flex; gap: 10px; justify-content: center; align-items: center; flex-wrap: wrap;">
            <button class="btn btn-primary" onclick="window.siteAuditsEngine.scanEmails()" style="font-weight: 700; background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); border: none; padding: 8px 18px; border-radius: 6px; color: #fff; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <span>📬</span> Scan Gmail for Audits
            </button>
            <button class="btn btn-secondary" onclick="window.siteAuditsEngine.openAddAuditModal()" style="font-weight: 700; border-color: #38bdf8; color: #7dd3fc; background: rgba(56, 189, 248, 0.1); padding: 8px 18px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
              <span>➕</span> Log Site Audit
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  renderAuditsCards(audits) {
    if (!audits || audits.length === 0) return this.renderEmptyState();

    if (this.selectedQuarter === 'all') {
      const quarters = ['Q4', 'Q3', 'Q2', 'Q1'];
      const qLabels = {
        Q1: '🌸 Quarter 1: January – March',
        Q2: '☀️ Quarter 2: April – June',
        Q3: '🍂 Quarter 3: July – September',
        Q4: '❄️ Quarter 4: October – December'
      };
      return quarters.map(qKey => {
        const qItems = audits.filter(a => a.quarter === qKey);
        if (qItems.length === 0) return '';
        return `
          <div style="margin-bottom: 24px;">
            <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid rgba(148, 163, 184, 0.2); padding-bottom: 8px; margin-bottom: 14px;">
              <div style="display: flex; align-items: center; gap: 10px;">
                <h3 style="font-size: 16px; font-weight: 800; color: #f8fafc; margin: 0;">${qLabels[qKey]}</h3>
                <span class="badge" style="background: rgba(56, 189, 248, 0.2); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.4); font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 700;">
                  ${qItems.length} Audit${qItems.length === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr; gap: 14px;">
              ${qItems.map(a => this.renderSingleAuditCard(a)).join('')}
            </div>
          </div>
        `;
      }).join('');
    }

    return `
      <div style="display: grid; grid-template-columns: 1fr; gap: 14px;">
        ${audits.map(a => this.renderSingleAuditCard(a)).join('')}
      </div>
    `;
  }

  renderSingleAuditCard(audit) {
    const borderLeftColor = audit.hasCorrections ? '#f59e0b' : (audit.status.toLowerCase() === 'reviewed' ? '#10b981' : '#38bdf8');
    const isReviewed = audit.status.toLowerCase() === 'reviewed';
    const canEdit = this.canEdit();

    return `
      <div class="incident-card" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-left: 4px solid ${borderLeftColor}; border-radius: 8px; padding: 16px 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.25);">
        <!-- Header: Date, Job #, Location, Foreman, Inspector, Status -->
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <!-- Date Badge -->
            <span style="background: rgba(148, 163, 184, 0.12); color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.25); font-size: 12.5px; font-weight: 800; padding: 3px 10px; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px;">
              <span>🗓️</span> ${this.escapeHtml(audit.displayDate || audit.auditDate)}
            </span>

            <!-- Job Number Badge -->
            <span style="background: rgba(37, 99, 235, 0.15); color: #60a5fa; border: 1px solid rgba(37, 99, 235, 0.35); font-size: 12px; font-weight: 800; padding: 3px 10px; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px;">
              <span>🔢</span> Job #${this.escapeHtml(audit.jobNumber || 'N/A')}
              ${audit.jobName ? `<span style="font-weight: 500; color: #93c5fd;">· ${this.escapeHtml(audit.jobName)}</span>` : ''}
            </span>

            <!-- Location Badge (Job Tracking wins, variation in parens) -->
            <span style="background: rgba(56, 189, 248, 0.14); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.35); font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px;" title="${audit.locationVariation ? `Job Tracking: ${this.escapeHtml(audit.locationPrimary)} | PDF listed: ${this.escapeHtml(audit.locationVariation)}` : ''}">
              <span>📍</span> <strong>${this.escapeHtml(audit.locationPrimary)}</strong>
              ${audit.locationVariation ? `<span style="opacity: 0.85; font-weight: 600; color: #bae6fd;">(${this.escapeHtml(audit.locationVariation)})</span>` : ''}
            </span>

            <!-- Foreman Badge (Job Tracking wins, variation in parens) -->
            <span style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px;" title="${audit.foremanVariation ? `Job Tracking: ${this.escapeHtml(audit.foremanPrimary)} | PDF listed: ${this.escapeHtml(audit.foremanVariation)}` : ''}">
              <span>👷 Foreman:</span> <strong>${this.escapeHtml(audit.foremanPrimary)}</strong>
              ${audit.foremanVariation ? `<span style="opacity: 0.85; font-weight: 600; color: #a7f3d0;">(${this.escapeHtml(audit.foremanVariation)})</span>` : ''}
            </span>

            <!-- Inspector Badge -->
            ${audit.inspector ? `
              <span style="background: rgba(168, 85, 247, 0.14); color: #d8b4fe; border: 1px solid rgba(168, 85, 247, 0.3); font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px;">
                <span>🕵️</span> By: ${this.escapeHtml(audit.inspector)}
              </span>
            ` : ''}
          </div>

          <!-- Corrections / OCR Status Pill -->
          <div style="display: flex; align-items: center; gap: 6px;">
            ${audit.isOcrPending ? `
              <span style="background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.35); font-size: 11.5px; font-weight: 700; padding: 3px 9px; border-radius: 6px;">
                ⏳ PDF Parse Pending
              </span>
            ` : (audit.hasCorrections ? `
              <span style="background: rgba(245, 158, 11, 0.18); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.45); font-size: 11.5px; font-weight: 800; padding: 3px 10px; border-radius: 6px;">
                ⚠️ Corrections Needed
              </span>
            ` : `
              <span style="background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.35); font-size: 11.5px; font-weight: 700; padding: 3px 9px; border-radius: 6px;">
                ✅ No Corrections
              </span>
            `)}
          </div>
        </div>

        <!-- Site Inspection & Work Practices -->
        ${audit.siteInspection ? `
          <div style="margin-bottom: ${audit.hasCorrections ? '10px' : '12px'};">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #94a3b8; margin-bottom: 4px; display: flex; align-items: center; gap: 5px;">
              <span>📝</span> Site Inspection &amp; Work Practices Observed:
            </div>
            <div style="font-size: 13px; color: #f1f5f9; line-height: 1.5; background: rgba(30, 41, 59, 0.4); border-left: 3px solid #38bdf8; padding: 9px 14px; border-radius: 0 6px 6px 0;">
              ${this.escapeHtml(audit.siteInspection)}
            </div>
          </div>
        ` : ''}

        <!-- Corrections Needed Detail -->
        ${audit.hasCorrections ? `
          <div style="margin-bottom: 12px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #fbbf24; margin-bottom: 4px; display: flex; align-items: center; gap: 5px;">
              <span>⚠️</span> Correction(s) Needed:
            </div>
            <div style="font-size: 12.5px; color: #fef3c7; line-height: 1.5; background: rgba(120, 53, 15, 0.25); border-left: 3px solid #f59e0b; padding: 8px 12px; border-radius: 0 6px 6px 0;">
              ${this.escapeHtml(audit.correctionsNeeded)}
            </div>
          </div>
        ` : ''}

        <!-- Footer: Photos, PDF, Status Toggle, Gmail -->
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; border-top: 1px solid rgba(148, 163, 184, 0.15); padding-top: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <button class="btn btn-secondary" onclick="window.siteAuditsEngine.openPhotosLightbox('${this.escapeJs(audit.emailId)}', '${this.escapeJs(audit.id)}')" style="font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; background: rgba(30, 41, 59, 0.6); color: #cbd5e1; border: 1px solid var(--border-color);">
              <span>📷</span> View Attached Photos ${audit.photoCount > 0 ? `<span class="badge" style="background: rgba(56, 189, 248, 0.2); color: #7dd3fc; padding: 1px 6px; border-radius: 4px; font-size: 10.5px; margin-left: 4px;">${audit.photoCount}</span>` : ''}
            </button>

            <button class="btn btn-primary" onclick="window.siteAuditsEngine.openPdfViewer('${this.escapeJs(audit.emailId)}', '${this.escapeJs(audit.pdfFilename)}', '${this.escapeJs(audit.id)}')" style="font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 6px; background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: #fff; border: none; box-shadow: 0 2px 6px rgba(2, 132, 199, 0.3);">
              <span>📄</span> View Audit PDF
            </button>
          </div>

          <div style="display: flex; align-items: center; gap: 10px;">
            ${canEdit ? `
              <button onclick="window.siteAuditsEngine.toggleReviewedStatus('${this.escapeJs(audit.id)}')" class="btn btn-secondary" style="font-size: 11.5px; font-weight: 700; padding: 5px 10px; ${isReviewed ? 'border-color: #10b981; color: #34d399; background: rgba(16, 185, 129, 0.12);' : ''}" title="Toggle Reviewed status">
                ${isReviewed ? '✅ Reviewed' : '☑️ Mark Reviewed'}
              </button>
            ` : `
              <span style="font-size: 11.5px; font-weight: 700; color: #94a3b8;">
                Status: <span style="color: ${isReviewed ? '#34d399' : '#60a5fa'};">${this.escapeHtml(audit.status)}</span>
              </span>
            `}

            ${audit.emailId && !audit.emailId.startsWith('manual_') ? `
              <button onclick="window.siteAuditsEngine.openEmailInGmail('${this.escapeJs(audit.emailId)}')" class="btn btn-secondary" style="font-size: 11.5px; font-weight: 600; padding: 5px 10px; display: inline-flex; align-items: center; gap: 4px;" title="Open original message in Gmail">
                <span>✉️</span> Gmail
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  renderAuditsTable(audits) {
    if (!audits || audits.length === 0) return this.renderEmptyState();

    return `
      <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 12.5px; text-align: left;">
          <thead>
            <tr style="background: rgba(30, 41, 59, 0.85); color: #94a3b8; font-size: 11px; text-transform: uppercase; border-bottom: 1px solid var(--border-color);">
              <th style="padding: 10px 12px;">Date</th>
              <th style="padding: 10px 12px;">Job #</th>
              <th style="padding: 10px 12px;">Location</th>
              <th style="padding: 10px 12px;">Foreman</th>
              <th style="padding: 10px 12px;">Inspector</th>
              <th style="padding: 10px 12px;">Corrections</th>
              <th style="padding: 10px 12px; text-align: center;">Photos</th>
              <th style="padding: 10px 12px; text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${audits.map(a => `
              <tr style="border-bottom: 1px solid rgba(148, 163, 184, 0.12); ${a.hasCorrections ? 'background: rgba(120, 53, 15, 0.14);' : ''}">
                <td style="padding: 10px 12px; font-weight: 700; color: #e2e8f0; white-space: nowrap;">${this.escapeHtml(a.displayDate || a.auditDate)}</td>
                <td style="padding: 10px 12px; font-weight: 700; color: #60a5fa; white-space: nowrap;">
                  #${this.escapeHtml(a.jobNumber || 'N/A')}
                  ${a.jobName ? `<div style="font-size: 10.5px; font-weight: 500; color: #94a3b8;">${this.escapeHtml(a.jobName)}</div>` : ''}
                </td>
                <td style="padding: 10px 12px; color: #7dd3fc; font-weight: 600;">
                  ${this.escapeHtml(a.locationPrimary)}
                  ${a.locationVariation ? `<span style="color: #bae6fd; opacity: 0.8; font-weight: 500;"> (${this.escapeHtml(a.locationVariation)})</span>` : ''}
                </td>
                <td style="padding: 10px 12px; color: #34d399; font-weight: 600;">
                  ${this.escapeHtml(a.foremanPrimary)}
                  ${a.foremanVariation ? `<span style="color: #a7f3d0; opacity: 0.8; font-weight: 500;"> (${this.escapeHtml(a.foremanVariation)})</span>` : ''}
                </td>
                <td style="padding: 10px 12px; color: #cbd5e1;">${this.escapeHtml(a.inspector || '—')}</td>
                <td style="padding: 10px 12px;">
                  ${a.isOcrPending
                    ? '<span style="color: #94a3b8; font-size: 11px;">⏳ Pending</span>'
                    : (a.hasCorrections
                        ? `<span style="color: #fcd34d; font-weight: 700;" title="${this.escapeHtml(a.correctionsNeeded)}">⚠️ Yes</span>`
                        : '<span style="color: #6ee7b7;">✅ No</span>')}
                </td>
                <td style="padding: 10px 12px; text-align: center;">
                  <button class="btn btn-secondary" style="font-size: 11px; padding: 3px 8px;" onclick="window.siteAuditsEngine.openPhotosLightbox('${this.escapeJs(a.emailId)}', '${this.escapeJs(a.id)}')">
                    📷 ${a.photoCount}
                  </button>
                </td>
                <td style="padding: 10px 12px; text-align: right; white-space: nowrap;">
                  <button class="btn btn-primary" style="font-size: 11px; padding: 4px 10px; background: #0284c7; border: none;" onclick="window.siteAuditsEngine.openPdfViewer('${this.escapeJs(a.emailId)}', '${this.escapeJs(a.pdfFilename)}', '${this.escapeJs(a.id)}')">
                    📄 PDF
                  </button>
                  ${a.emailId && !a.emailId.startsWith('manual_') ? `
                    <button class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px; margin-left: 4px;" onclick="window.siteAuditsEngine.openEmailInGmail('${this.escapeJs(a.emailId)}')" title="Open in Gmail">
                      ✉️
                    </button>
                  ` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Filter handlers
   */
  setYear(yr) {
    this.selectedYear = yr;
    this.render();
  }

  setQuarter(q) {
    this.selectedQuarter = q;
    this.render();
  }

  setLocationFilter(loc) {
    this.selectedLocation = loc;
    this.render();
  }

  setForemanFilter(fm) {
    this.selectedForeman = fm;
    this.render();
  }

  setInspectorFilter(key) {
    this.selectedInspector = (key !== 'all' && this.selectedInspector === key) ? 'all' : key;
    this.render();
  }

  setCorrectionFilter(val) {
    this.selectedCorrectionFilter = val;
    this.render();
  }

  setViewMode(mode) {
    this.viewMode = mode === 'table' ? 'table' : 'cards';
    try {
      localStorage.setItem('sa_site_audits_view_mode', this.viewMode);
    } catch (e) {}
    this.render();
  }

  toggleUncoveredDrawer() {
    this.showUncoveredDrawer = !this.showUncoveredDrawer;
    this.render();
  }

  clearFilters() {
    this.selectedLocation = 'all';
    this.selectedForeman = 'all';
    this.selectedInspector = 'all';
    this.selectedCorrectionFilter = 'all';
    this.searchQuery = '';
    const searchEl = document.getElementById('site-audits-search-input');
    if (searchEl) searchEl.value = '';
    this.render();
  }

  onSearchInput(val) {
    this.searchQuery = val;
    this.render();
  }

  /**
   * Toggles Status between Logged/Corrections Needed and Reviewed
   */
  async toggleReviewedStatus(auditId) {
    if (!this.canEdit()) return;
    const snap = this.db?.snapshot;
    const table = snap?.tables?.['site_audits'];
    if (!table || !Array.isArray(table.rows)) return;

    const allAudits = this.loadAudits();
    const targetAudit = allAudits.find(a => a.id === auditId);
    if (!targetAudit) return;

    const rowObj = table.rows.find((r, idx) => {
      const rEid = String(r['Email ID'] || '').trim();
      if (targetAudit.emailId && rEid === targetAudit.emailId) return true;
      return `sa_${idx}_${rEid || idx}` === auditId;
    });
    if (!rowObj) return;

    const curStatus = String(rowObj['Status'] || '').trim();
    const nextStatus = curStatus.toLowerCase() === 'reviewed'
      ? (targetAudit.hasCorrections ? 'Corrections Needed' : 'Logged')
      : 'Reviewed';

    rowObj['Status'] = nextStatus;

    if (typeof this.db.markTableDirty === 'function') {
      this.db.markTableDirty('site_audits');
    }
    if (typeof this.db.addMutation === 'function') {
      await this.db.addMutation({
        action: 'UPDATE_ROW',
        sheetName: 'Site Audits',
        tableKey: 'site_audits',
        row: rowObj._rowIdx || targetAudit.rowIndex,
        itemIdentifier: targetAudit.emailId || '',
        updatedFields: { 'Status': nextStatus }
      });
    }
    if (typeof this.db.persistSnapshot === 'function') {
      await this.db.persistSnapshot(snap);
    }

    if (typeof window.showToast === 'function') {
      window.showToast(`Site audit marked "${nextStatus}".`);
    }
    this.render();
  }

  /**
   * Refreshes the site_audits table from cloud snapshot
   */
  async refresh(silent = false) {
    const btn = document.getElementById('btn-refresh-site-audits');
    if (btn && !silent) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Refreshing...';
    }

    try {
      const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
      if (!syncUrl) throw new Error('Sync URL not configured.');

      let freshSnapshot = null;
      if (window.syncEngine && typeof window.syncEngine.executeNetworkRequest === 'function') {
        freshSnapshot = await window.syncEngine.executeNetworkRequest(`${syncUrl}?action=getSnapshot&tables=site_audits`, 'GET', null, 30000);
      } else {
        const resp = await fetch(`${syncUrl}?action=getSnapshot&tables=site_audits`);
        freshSnapshot = await resp.json();
      }

      if (freshSnapshot && freshSnapshot.tables && freshSnapshot.tables['site_audits']) {
        if (!this.db.snapshot) this.db.snapshot = { tables: {} };
        if (!this.db.snapshot.tables) this.db.snapshot.tables = {};
        this.db.snapshot.tables['site_audits'] = freshSnapshot.tables['site_audits'];
        if (typeof this.db.markTableDirty === 'function') {
          this.db.markTableDirty('site_audits');
        }
        if (typeof this.db.persistSnapshot === 'function') {
          await this.db.persistSnapshot(this.db.snapshot);
        }
        const rowCount = freshSnapshot.tables['site_audits'].rowCount || (freshSnapshot.tables['site_audits'].rows && freshSnapshot.tables['site_audits'].rows.length) || 0;
        if (!silent && typeof window.showToast === 'function') {
          window.showToast(`Loaded ${rowCount} site audit${rowCount === 1 ? '' : 's'} from cloud database.`);
        }
      }
    } catch (err) {
      console.warn('SiteAuditsEngine refresh error:', err);
      if (!silent && typeof window.showToast === 'function') {
        window.showToast(`Refresh error: ${err.message}`, true);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>🔄</span> Refresh';
      }
      this.render();
    }
  }

  /**
   * Scans Gmail for current-year Project Site Audit Report emails
   */
  async scanEmails(forceFullRescan = false, options = {}) {
    const depth = options._followUpDepth || 0;
    if (this.isScanning && depth === 0) {
      if (!options.silent && typeof window.showToast === 'function') {
        window.showToast('Site audits scan is already running in the background.');
      }
      return;
    }
    this.isScanning = true;

    const scanBtn = document.getElementById('btn-scan-site-audit-emails');
    if (scanBtn) {
      scanBtn.disabled = true;
      scanBtn.innerHTML = '<span>⏳</span> Scanning Gmail...';
    }

    const widget = document.getElementById('site-audit-emails-bg-widget');
    if (widget) widget.style.display = 'flex';

    const scanYear = (this.selectedYear && this.selectedYear !== 'all')
      ? parseInt(this.selectedYear, 10)
      : new Date().getFullYear();

    this.updateBackgroundWidget({
      title: depth > 0 ? '📋 Finishing Site Audit PDFs' : '📋 Scanning Site Audits',
      sub: depth > 0 ? 'Parsing remaining PDF reports...' : `Searching Gmail (${scanYear} Project Site Audits)...`,
      pct: depth > 0 ? 55 : 14,
      status: 'scanning'
    });

    let progressPct = depth > 0 ? 55 : 14;
    const progressTimer = setInterval(() => {
      if (!this.isScanning) {
        clearInterval(progressTimer);
        return;
      }
      if (progressPct < 88) {
        progressPct += 14;
        let subText = `Searching ${scanYear} Project Site Audit Reports...`;
        if (progressPct >= 42 && progressPct < 70) {
          subText = 'Cross-referencing Job Tracking & parsing PDFs...';
        } else if (progressPct >= 70) {
          subText = 'Finalizing Site Audits log & snapshot...';
        }
        this.updateBackgroundWidget({ pct: progressPct, sub: subText });
      }
    }, 1300);

    try {
      const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
      if (!syncUrl) throw new Error('Sync URL not configured.');

      const payload = {
        action: 'scanSiteAuditEmails',
        year: scanYear,
        maxThreads: options.maxThreads || 250,
        rescan: !!forceFullRescan && depth === 0
      };

      let result = null;
      if (window.syncEngine && typeof window.syncEngine.executeNetworkRequest === 'function') {
        result = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', payload, 60000);
      } else {
        const resp = await fetch(syncUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        result = await resp.json();
      }

      clearInterval(progressTimer);

      if (result && result.success) {
        const count = result.newCount || 0;
        const ocrUpdated = result.updatedOcrCount || 0;
        const pendingOcr = result.pendingOcrCount || 0;
        const total = result.totalInSheet || 0;

        if (result.table && result.table.rows) {
          if (!this.db.snapshot) this.db.snapshot = { tables: {} };
          if (!this.db.snapshot.tables) this.db.snapshot.tables = {};
          this.db.snapshot.tables['site_audits'] = result.table;
          if (typeof this.db.markTableDirty === 'function') {
            this.db.markTableDirty('site_audits');
          }
          if (typeof this.db.persistSnapshot === 'function') {
            await this.db.persistSnapshot(this.db.snapshot);
          }
        }

        // Auto-continue up to 2 follow-up passes if initial backfill left OCR_PENDING rows and made progress
        if (pendingOcr > 0 && (count > 0 || ocrUpdated > 0) && depth < 2) {
          this.render();
          this.isScanning = false;
          return await this.scanEmails(false, { ...options, _followUpDepth: depth + 1 });
        }

        const parsedMsg = ocrUpdated > 0 ? ` (${ocrUpdated} PDFs parsed)` : '';
        const pendingMsg = pendingOcr > 0 ? ` • ${pendingOcr} PDF${pendingOcr === 1 ? '' : 's'} still pending` : '';

        this.updateBackgroundWidget({
          title: count > 0 ? `📋 ${count} New Site Audit${count === 1 ? '' : 's'} Logged` : '✅ Site Audits Up to Date',
          sub: count > 0
            ? `${count} new audit${count === 1 ? '' : 's'}${parsedMsg} (${total} total)${pendingMsg}`
            : `All ${total} site audits up to date${parsedMsg}${pendingMsg}`,
          pct: 100,
          status: 'completed'
        });

        setTimeout(() => {
          const w = document.getElementById('site-audit-emails-bg-widget');
          if (w && w.classList.contains('completed')) {
            this.dismissBackgroundWidget();
          }
        }, 12000);
      } else {
        throw new Error((result && result.error) || 'Failed to scan site audit emails.');
      }
    } catch (err) {
      clearInterval(progressTimer);
      console.error('SiteAudits scanEmails error:', err);
      const errMsg = err.message || 'Error scanning emails';
      if (!options.silent && typeof window.showToast === 'function') {
        window.showToast(`Site Audits scan error: ${errMsg}`, true);
      }
      this.updateBackgroundWidget({
        title: '❌ Site Audit Scan Error',
        sub: errMsg.length > 50 ? errMsg.substring(0, 47) + '...' : errMsg,
        status: 'error'
      });
    } finally {
      this.isScanning = false;
      if (scanBtn) {
        scanBtn.disabled = false;
        scanBtn.innerHTML = '<span>📬</span> Scan Gmail for Audits';
      }
      this.render();
    }
  }

  dismissBackgroundWidget() {
    const widget = document.getElementById('site-audit-emails-bg-widget');
    if (widget) widget.style.display = 'none';
  }

  updateBackgroundWidget(opts = {}) {
    const widget = document.getElementById('site-audit-emails-bg-widget');
    if (!widget) return;

    if (opts.pct !== undefined) {
      const pctEl = document.getElementById('site-audit-bg-pct');
      if (pctEl) pctEl.textContent = `${opts.pct}%`;
      const barEl = document.getElementById('site-audit-bg-bar');
      if (barEl) barEl.style.width = `${Math.max(5, opts.pct)}%`;
    }
    if (opts.title) {
      const titleEl = document.getElementById('site-audit-bg-title-text');
      if (titleEl) titleEl.textContent = opts.title;
    }
    if (opts.sub) {
      const subEl = document.getElementById('site-audit-bg-sub');
      if (subEl) subEl.textContent = opts.sub;
    }

    const spinner = document.getElementById('site-audit-bg-spinner');
    const dismissBtn = document.getElementById('site-audit-bg-dismiss-btn');

    if (opts.status === 'completed') {
      widget.classList.add('completed');
      widget.classList.remove('error');
      if (spinner) {
        spinner.style.animation = 'none';
        spinner.style.border = 'none';
        spinner.textContent = '✅';
        spinner.style.fontSize = '18px';
      }
      if (dismissBtn) dismissBtn.style.display = 'flex';
    } else if (opts.status === 'error') {
      widget.classList.add('error');
      widget.classList.remove('completed');
      if (spinner) {
        spinner.style.animation = 'none';
        spinner.style.border = 'none';
        spinner.textContent = '❌';
        spinner.style.fontSize = '18px';
      }
      if (dismissBtn) dismissBtn.style.display = 'flex';
    } else {
      widget.classList.remove('completed', 'error');
      if (spinner) {
        spinner.textContent = '';
        spinner.style.fontSize = '';
        spinner.style.border = '2.5px solid rgba(56, 189, 248, 0.25)';
        spinner.style.borderTopColor = '#38bdf8';
        spinner.style.animation = 'spin 0.85s linear infinite';
      }
      if (dismissBtn) dismissBtn.style.display = 'none';
    }
  }

  openSiteAuditsViewFromWidget() {
    if (typeof window.navigateToView === 'function') {
      window.navigateToView('site-audits-view');
    }
  }

  /**
   * Opens the attached Site Audit PDF in the shared Safety PDF viewer modal
   */
  async openPdfViewer(emailId, pdfFilename, auditId = null) {
    if (!emailId || String(emailId).startsWith('manual_')) {
      alert('No Gmail PDF attachment is linked to this manual site audit entry.');
      return;
    }

    const modal = document.getElementById('safety-pdf-modal');
    const titleEl = document.getElementById('safety-pdf-modal-title') || document.getElementById('safety-pdf-title');
    const subtitleEl = document.getElementById('safety-pdf-modal-subtitle') || document.getElementById('safety-pdf-subtitle');
    const body = document.getElementById('safety-pdf-modal-body') || document.getElementById('safety-pdf-body');
    const verSelector = document.getElementById('safety-pdf-version-selector');
    const downloadBtn = document.getElementById('safety-pdf-btn-download') || document.getElementById('safety-pdf-download');
    const popoutBtn = document.getElementById('safety-pdf-btn-newtab') || document.getElementById('safety-pdf-popout');
    const gmailBtn = document.getElementById('safety-pdf-btn-gmail') || document.getElementById('safety-pdf-gmail');

    if (!modal || !body) return;

    if (verSelector) {
      verSelector.style.display = 'none';
      verSelector.innerHTML = '';
    }

    modal.classList.remove('hidden');
    modal.classList.add('active');
    modal.style.display = 'flex';
    if (window.windowManager && typeof window.windowManager.bringToFront === 'function') {
      window.windowManager.bringToFront(modal);
    }

    if (titleEl) titleEl.textContent = 'Project Site Audit Report';
    if (subtitleEl) subtitleEl.textContent = pdfFilename || 'Site_Audit.pdf';

    body.innerHTML = `
      <div style="padding: 40px; text-align: center; color: var(--text-secondary);">
        <div style="font-size: 32px; margin-bottom: 8px;">⏳</div>
        <div style="font-size: 14px; font-weight: 700; color: #f1f5f9;">Loading Site Audit PDF from Gmail...</div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">Contacting Google Apps Script backend</div>
      </div>
    `;

    try {
      const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
      let pdfData = null;

      if (this.attachmentsCache.has(emailId) && this.attachmentsCache.get(emailId).pdf) {
        pdfData = this.attachmentsCache.get(emailId).pdf;
      } else {
        const payload = {
          action: 'getSiteAuditAttachments',
          emailId,
          includePdf: true,
          includePhotos: false
        };

        let resJson = null;
        if (window.syncEngine && typeof window.syncEngine.executeNetworkRequest === 'function') {
          resJson = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', payload, 60000);
        } else {
          const resp = await fetch(`${syncUrl}?action=getSiteAuditAttachments&emailId=${encodeURIComponent(emailId)}`);
          resJson = await resp.json();
        }

        if (resJson && resJson.success && resJson.pdf && resJson.pdf.base64) {
          pdfData = resJson.pdf;
          if (!this.attachmentsCache.has(emailId)) this.attachmentsCache.set(emailId, {});
          this.attachmentsCache.get(emailId).pdf = pdfData;
          if (resJson.photos) this.attachmentsCache.get(emailId).photos = resJson.photos;
        } else {
          throw new Error((resJson && resJson.error) || 'Failed to extract PDF attachment.');
        }
      }

      const byteCharacters = atob(pdfData.base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);

      if (subtitleEl) subtitleEl.textContent = pdfData.filename || pdfFilename || 'Site_Audit.pdf';

      if (downloadBtn) {
        downloadBtn.href = blobUrl;
        downloadBtn.download = pdfData.filename || pdfFilename || 'Site_Audit.pdf';
        downloadBtn.onclick = async (e) => {
          if (window.desktopAPI && typeof window.desktopAPI.savePdfToFile === 'function') {
            e.preventDefault();
            await window.desktopAPI.savePdfToFile(pdfData.base64, pdfData.filename || pdfFilename);
          }
        };
      }

      if (popoutBtn) {
        popoutBtn.href = blobUrl;
        popoutBtn.onclick = async (e) => {
          if (window.desktopAPI && typeof window.desktopAPI.openPdfExternally === 'function') {
            e.preventDefault();
            await window.desktopAPI.openPdfExternally(pdfData.base64, pdfData.filename || pdfFilename);
          }
        };
      }

      if (gmailBtn) {
        const gmailUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(emailId)}`;
        gmailBtn.href = gmailUrl;
        gmailBtn.style.display = 'inline-flex';
        gmailBtn.onclick = (e) => {
          if (window.desktopAPI && typeof window.desktopAPI.openExternal === 'function') {
            e.preventDefault();
            window.desktopAPI.openExternal(gmailUrl);
          }
        };
      }

      body.innerHTML = `
        <object data="${blobUrl}#view=FitH&toolbar=1" type="application/pdf" style="width: 100%; height: 100%; border: none; background: #1e293b;">
          <iframe src="${blobUrl}#view=FitH" style="width: 100%; height: 100%; border: none; background: #1e293b;">
            <div style="padding: 30px; text-align: center; color: var(--text-secondary);">
              <p>Preview cannot be rendered inline in this view.</p>
              <button class="btn btn-primary" onclick="if (window.desktopAPI) window.desktopAPI.openPdfExternally('${pdfData.base64}', '${this.escapeJs(pdfData.filename || 'Site_Audit.pdf')}')">Open in System PDF Viewer</button>
            </div>
          </iframe>
        </object>
      `;
    } catch (err) {
      body.innerHTML = `
        <div style="padding: 30px; text-align: center; max-width: 500px; color: #f87171;">
          <div style="font-size: 32px; margin-bottom: 12px;">⚠️</div>
          <div style="font-size: 14px; font-weight: 700; margin-bottom: 6px;">Could not load Site Audit PDF</div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 20px; line-height: 1.5;">${this.escapeHtml(err.message || 'Unknown error')}</div>
          <button onclick="window.siteAuditsEngine.openEmailInGmail('${this.escapeJs(emailId)}')" class="btn btn-primary" style="font-weight: 700; background: #10b981; border: none; display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px; cursor: pointer; color: white; border-radius: 6px;">
            <span>✉️</span> Open Email in Gmail
          </button>
        </div>
      `;
    }
  }

  /**
   * Opens high-resolution photos lightbox gallery using shared lightbox modal
   */
  async openPhotosLightbox(emailId, auditId) {
    if (!emailId || String(emailId).startsWith('manual_')) {
      alert('No Gmail photo attachments are linked to this audit.');
      return;
    }

    const modal = document.getElementById('incident-photos-lightbox-modal');
    if (!modal) return;

    window._activeLightboxEngine = this;
    modal.style.display = 'flex';
    this.lightboxState = {
      isOpen: true,
      emailId,
      auditId,
      photos: [],
      currentIndex: 0
    };

    if (this._lightboxKeyHandler) {
      document.removeEventListener('keydown', this._lightboxKeyHandler);
    }
    this._lightboxKeyHandler = (e) => {
      if (!this.lightboxState || !this.lightboxState.isOpen) return;
      if (e.key === 'ArrowLeft') this.prevLightboxPhoto();
      else if (e.key === 'ArrowRight') this.nextLightboxPhoto();
      else if (e.key === 'Escape') this.closeLightbox();
    };
    document.addEventListener('keydown', this._lightboxKeyHandler);

    const titleEl = document.getElementById('incident-lightbox-title');
    const counterEl = document.getElementById('incident-lightbox-counter');
    const content = document.getElementById('incident-lightbox-content');
    const strip = document.getElementById('incident-lightbox-thumbnail-strip');

    if (titleEl) titleEl.textContent = 'Site Audit Photos';
    if (counterEl) counterEl.textContent = 'Inspecting email attachments...';
    if (strip) strip.innerHTML = '';
    if (content) {
      content.innerHTML = `
        <div style="padding: 60px; text-align: center; color: #94a3b8;">
          <div style="font-size: 36px; margin-bottom: 12px;">📷</div>
          <div style="font-size: 15px; font-weight: 700; color: #f1f5f9;">Loading site audit photos from Gmail...</div>
          <div style="font-size: 12px; color: #64748b; margin-top: 6px;">Contacting Google Apps Script backend</div>
        </div>
      `;
    }

    try {
      const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
      let photos = [];

      if (this.attachmentsCache.has(emailId) && Array.isArray(this.attachmentsCache.get(emailId).photos)) {
        photos = this.attachmentsCache.get(emailId).photos;
      } else {
        const payload = {
          action: 'getSiteAuditAttachments',
          emailId,
          includePhotos: false,
          includePdf: false
        };

        let resJson = null;
        if (window.syncEngine && typeof window.syncEngine.executeNetworkRequest === 'function') {
          resJson = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', payload, 30000);
        } else {
          const resp = await fetch(`${syncUrl}?action=getSiteAuditAttachments&emailId=${encodeURIComponent(emailId)}&includePhotos=false&includePdf=false`);
          resJson = await resp.json();
        }

        if (resJson && resJson.success && Array.isArray(resJson.photos)) {
          photos = resJson.photos;
          if (!this.attachmentsCache.has(emailId)) this.attachmentsCache.set(emailId, {});
          this.attachmentsCache.get(emailId).photos = photos;
        } else {
          throw new Error((resJson && resJson.error) || 'Failed to inspect email attachments.');
        }
      }

      if (!photos || photos.length === 0) {
        if (counterEl) counterEl.textContent = '0 Photos';
        if (content) {
          content.innerHTML = `
            <div style="padding: 60px; text-align: center; color: #94a3b8;">
              <div style="font-size: 36px; margin-bottom: 10px;">📷</div>
              <div style="font-size: 15px; font-weight: 700; color: #cbd5e1;">No Attached Photos Found</div>
              <p style="font-size: 13px; margin-top: 6px;">This site audit email did not contain any attached photos.</p>
            </div>
          `;
        }
        return;
      }

      this.lightboxState.photos = photos;
      this.renderLightboxThumbnailStrip();
      await this.loadAndDisplayPhoto(0);
    } catch (err) {
      if (counterEl) counterEl.textContent = 'Error';
      if (content) {
        content.innerHTML = `
          <div style="padding: 40px; text-align: center; color: #f87171;">
            <div style="font-size: 32px; margin-bottom: 10px;">⚠️</div>
            <div style="font-size: 15px; font-weight: 700; margin-bottom: 6px;">Could not load photos</div>
            <div style="font-size: 12px; color: #94a3b8; margin-bottom: 16px;">${this.escapeHtml(err.message || 'Unknown error')}</div>
            <button class="btn btn-secondary" onclick="window.siteAuditsEngine.openPhotosLightbox('${this.escapeJs(emailId)}', '${this.escapeJs(auditId || '')}')" style="font-size: 12px; padding: 6px 14px;">🔄 Retry</button>
          </div>
        `;
      }
    }
  }

  renderLightboxThumbnailStrip() {
    const strip = document.getElementById('incident-lightbox-thumbnail-strip');
    if (!strip || !this.lightboxState || !this.lightboxState.photos) return;

    const { photos, currentIndex } = this.lightboxState;
    strip.innerHTML = photos.map((p, idx) => {
      const isCur = idx === currentIndex;
      const hasLoaded = !!p.base64;
      return `
        <div id="lightbox-thumb-${idx}" onclick="window.siteAuditsEngine.setLightboxIndex(${idx})" style="
          width: 52px; height: 52px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center;
          background: ${isCur ? '#1e293b' : '#090d16'};
          border: 2px solid ${isCur ? '#38bdf8' : 'rgba(255,255,255,0.18)'};
          box-shadow: ${isCur ? '0 0 12px rgba(56,189,248,0.5)' : 'none'};
          overflow: hidden; flex-shrink: 0; position: relative; user-select: none; transition: all 0.15s ease;
        " title="${this.escapeHtml(p.filename || ('Photo #' + (idx + 1)))}">
          ${hasLoaded
            ? `<img src="data:${p.contentType || 'image/jpeg'};base64,${p.base64}" style="width: 100%; height: 100%; object-fit: cover;" />`
            : `<span style="font-size: 12px; font-weight: 700; color: ${isCur ? '#38bdf8' : '#64748b'};">#${idx + 1}</span>`
          }
        </div>
      `;
    }).join('');
  }

  updateThumbnail(idx) {
    const thumbEl = document.getElementById(`lightbox-thumb-${idx}`);
    if (!thumbEl || !this.lightboxState || !this.lightboxState.photos) return;
    const p = this.lightboxState.photos[idx];
    if (p && p.base64) {
      thumbEl.innerHTML = `<img src="data:${p.contentType || 'image/jpeg'};base64,${p.base64}" style="width: 100%; height: 100%; object-fit: cover;" />`;
    }
  }

  async loadAndDisplayPhoto(index) {
    if (!this.lightboxState || !this.lightboxState.photos || this.lightboxState.photos.length === 0) return;
    if (index < 0 || index >= this.lightboxState.photos.length) return;

    this.lightboxState.currentIndex = index;
    const { photos, emailId } = this.lightboxState;
    const curPhoto = photos[index];

    const content = document.getElementById('incident-lightbox-content');
    const counterEl = document.getElementById('incident-lightbox-counter');
    const titleEl = document.getElementById('incident-lightbox-title');

    if (counterEl) counterEl.textContent = `Photo ${index + 1} of ${photos.length}`;
    if (titleEl) titleEl.textContent = curPhoto.filename || `Site Audit Photo #${index + 1}`;

    photos.forEach((_, idx) => {
      const tEl = document.getElementById(`lightbox-thumb-${idx}`);
      if (tEl) {
        const isCur = idx === index;
        tEl.style.border = isCur ? '2px solid #38bdf8' : '2px solid rgba(255,255,255,0.18)';
        tEl.style.boxShadow = isCur ? '0 0 12px rgba(56,189,248,0.5)' : 'none';
        tEl.style.background = isCur ? '#1e293b' : '#090d16';
        if (isCur) tEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    });

    if (curPhoto.base64) {
      const srcUrl = `data:${curPhoto.contentType || 'image/jpeg'};base64,${curPhoto.base64}`;
      if (content) {
        content.innerHTML = `
          <div style="position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
            <img src="${srcUrl}" alt="Site Audit Photo" style="max-width: 100%; max-height: 75vh; object-fit: contain; border-radius: 6px; box-shadow: 0 4px 25px rgba(0,0,0,0.6);" />
          </div>
        `;
      }
      this.prefetchPhoto(index + 1);
      return;
    }

    const kbSize = curPhoto.sizeBytes ? Math.round(curPhoto.sizeBytes / 1024) + ' KB' : '';
    if (content) {
      content.innerHTML = `
        <div style="padding: 40px; text-align: center; color: #94a3b8;">
          <div style="width: 42px; height: 42px; border: 3px solid rgba(56,189,248,0.2); border-top-color: #38bdf8; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px;"></div>
          <div style="font-size: 15px; font-weight: 700; color: #f1f5f9;">Loading Photo ${index + 1} of ${photos.length}...</div>
          <div style="font-size: 12px; color: #64748b; margin-top: 6px;">${this.escapeHtml(curPhoto.filename || '')} ${kbSize ? '• ' + kbSize : ''}</div>
        </div>
      `;
    }

    try {
      const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
      const payload = { action: 'getSiteAuditAttachments', emailId, photoIndex: index };

      let resJson = null;
      if (window.syncEngine && typeof window.syncEngine.executeNetworkRequest === 'function') {
        resJson = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', payload, 45000);
      } else {
        const resp = await fetch(`${syncUrl}?action=getSiteAuditAttachments&emailId=${encodeURIComponent(emailId)}&photoIndex=${index}`);
        resJson = await resp.json();
      }

      if (resJson && resJson.success && resJson.photo && resJson.photo.base64) {
        curPhoto.base64 = resJson.photo.base64;
        curPhoto.contentType = resJson.photo.contentType || 'image/jpeg';
        this.updateThumbnail(index);

        if (this.lightboxState && this.lightboxState.isOpen && this.lightboxState.currentIndex === index) {
          const srcUrl = `data:${curPhoto.contentType};base64,${curPhoto.base64}`;
          if (content) {
            content.innerHTML = `
              <div style="position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                <img src="${srcUrl}" alt="Site Audit Photo" style="max-width: 100%; max-height: 75vh; object-fit: contain; border-radius: 6px; box-shadow: 0 4px 25px rgba(0,0,0,0.6);" />
              </div>
            `;
          }
        }
        this.prefetchPhoto(index + 1);
      } else {
        throw new Error((resJson && resJson.error) || 'Failed to download photo from Gmail.');
      }
    } catch (err) {
      if (this.lightboxState && this.lightboxState.isOpen && this.lightboxState.currentIndex === index && content) {
        content.innerHTML = `
          <div style="padding: 30px; text-align: center; color: #f87171;">
            <div style="font-size: 28px; margin-bottom: 8px;">⚠️</div>
            <div style="font-size: 14px; font-weight: 700; margin-bottom: 4px;">Failed to load photo #${index + 1}</div>
            <div style="font-size: 12px; color: #94a3b8; margin-bottom: 14px;">${this.escapeHtml(err.message || 'Unknown error')}</div>
            <button class="btn btn-secondary" onclick="window.siteAuditsEngine.loadAndDisplayPhoto(${index})" style="font-size: 12px; padding: 6px 14px;">🔄 Retry Photo</button>
          </div>
        `;
      }
    }
  }

  prefetchPhoto(index) {
    if (!this.lightboxState || !this.lightboxState.photos) return;
    if (index < 0 || index >= this.lightboxState.photos.length) return;
    const target = this.lightboxState.photos[index];
    if (!target || target.base64 || target._isPrefetching) return;

    target._isPrefetching = true;
    const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
    const payload = {
      action: 'getSiteAuditAttachments',
      emailId: this.lightboxState.emailId,
      photoIndex: index
    };

    const reqPromise = (window.syncEngine && typeof window.syncEngine.executeNetworkRequest === 'function')
      ? window.syncEngine.executeNetworkRequest(syncUrl, 'POST', payload, 45000)
      : fetch(`${syncUrl}?action=getSiteAuditAttachments&emailId=${encodeURIComponent(this.lightboxState.emailId)}&photoIndex=${index}`).then(r => r.json());

    reqPromise.then(res => {
      if (res && res.success && res.photo && res.photo.base64) {
        target.base64 = res.photo.base64;
        target.contentType = res.photo.contentType || 'image/jpeg';
        this.updateThumbnail(index);
      }
    }).catch(() => {}).finally(() => {
      target._isPrefetching = false;
    });
  }

  setLightboxIndex(newIdx) {
    if (!this.lightboxState.photos || this.lightboxState.photos.length === 0) return;
    if (newIdx < 0) newIdx = this.lightboxState.photos.length - 1;
    if (newIdx >= this.lightboxState.photos.length) newIdx = 0;
    this.loadAndDisplayPhoto(newIdx);
  }

  prevLightboxPhoto() {
    if (!this.lightboxState.photos) return;
    this.setLightboxIndex(this.lightboxState.currentIndex - 1);
  }

  nextLightboxPhoto() {
    if (!this.lightboxState.photos) return;
    this.setLightboxIndex(this.lightboxState.currentIndex + 1);
  }

  closeLightbox() {
    const modal = document.getElementById('incident-photos-lightbox-modal');
    if (modal) modal.style.display = 'none';
    if (this.lightboxState) this.lightboxState.isOpen = false;
    if (window._activeLightboxEngine === this) {
      window._activeLightboxEngine = null;
    }
    if (this._lightboxKeyHandler) {
      document.removeEventListener('keydown', this._lightboxKeyHandler);
      this._lightboxKeyHandler = null;
    }
  }

  downloadCurrentPhoto() {
    if (!this.lightboxState || !this.lightboxState.photos) return;
    const cur = this.lightboxState.photos[this.lightboxState.currentIndex];
    if (!cur || !cur.base64) {
      alert('Photo is still downloading or not available.');
      return;
    }
    const a = document.createElement('a');
    a.href = `data:${cur.contentType || 'image/jpeg'};base64,${cur.base64}`;
    a.download = cur.filename || `site_audit_photo_${this.lightboxState.currentIndex + 1}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  popoutCurrentPhoto() {
    if (!this.lightboxState || !this.lightboxState.photos) return;
    const cur = this.lightboxState.photos[this.lightboxState.currentIndex];
    if (!cur || !cur.base64) {
      alert('Photo is still downloading or not available.');
      return;
    }
    const dataUrl = `data:${cur.contentType || 'image/jpeg'};base64,${cur.base64}`;
    const win = window.open('');
    if (win) {
      win.document.write(`
        <!DOCTYPE html>
        <html>
        <head><title>${this.escapeHtml(cur.filename || 'Site Audit Photo')}</title></head>
        <body style="margin: 0; background: #0b0f19; display: flex; align-items: center; justify-content: center; height: 100vh;">
          <img src="${dataUrl}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
        </body>
        </html>
      `);
      win.document.close();
    }
  }

  openCurrentPhotoInGmail() {
    if (!this.lightboxState || !this.lightboxState.emailId) return;
    this.openEmailInGmail(this.lightboxState.emailId);
  }

  openEmailInGmail(emailId) {
    if (!emailId) return;
    const cleanId = String(emailId).trim().split('_')[0];
    const url = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(cleanId)}`;
    if (window.desktopAPI && typeof window.desktopAPI.openExternal === 'function') {
      window.desktopAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }

  /**
   * Manual Site Audit Modal
   */
  openAddAuditModal() {
    let modal = document.getElementById('add-site-audit-modal');
    if (!modal) {
      this.createAddAuditModalDom();
      modal = document.getElementById('add-site-audit-modal');
    }
    if (!modal) return;

    const dateInput = document.getElementById('sa-add-date');
    if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];

    modal.style.display = 'flex';
  }

  closeAddAuditModal() {
    const modal = document.getElementById('add-site-audit-modal');
    if (modal) modal.style.display = 'none';
  }

  onAddModalJobChange(jobVal) {
    if (!jobVal) return;
    const cleanJob = String(jobVal).trim().replace(/^job\s*#?\s*/i, '');
    const jtTable = this.db?.snapshot?.tables?.['job_tracking'] || this.db?.getTable?.('job_tracking');
    if (!jtTable || !jtTable.rows) return;

    const match = jtTable.rows.find(j => {
      const jn = String(j['Job Number'] || j['Job #'] || '').trim().replace(/^job\s*#?\s*/i, '');
      return jn === cleanJob || jn.replace(/^0+/, '') === cleanJob.replace(/^0+/, '');
    });
    if (match) {
      const locEl = document.getElementById('sa-add-location');
      const fmEl = document.getElementById('sa-add-foreman');
      if (locEl && !locEl.value && match['Location']) locEl.value = match['Location'];
      if (fmEl && !fmEl.value && (match['Foreman'] || match['Crew Lead'])) {
        fmEl.value = match['Foreman'] || match['Crew Lead'];
      }
    }
  }

  createAddAuditModalDom() {
    if (document.getElementById('add-site-audit-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'add-site-audit-modal';
    modal.className = 'modal-overlay';
    modal.style.zIndex = '1250';
    modal.style.display = 'none';

    modal.innerHTML = `
      <div class="modal-box" style="max-width: 620px; width: 92%; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7); border: 1px solid rgba(56, 189, 248, 0.4);">
        <div class="modal-header" style="background: linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%); color: white; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(56, 189, 248, 0.3);">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 22px;">📋</span>
            <div>
              <div style="font-weight: 800; font-size: 16px;">Log Project Site Audit</div>
              <div style="font-size: 11.5px; color: #bae6fd; margin-top: 1px;">Manually record a site audit for a crew or job site.</div>
            </div>
          </div>
          <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 12px; background: rgba(0,0,0,0.25); border: none; color: white; cursor: pointer;" onclick="window.siteAuditsEngine.closeAddAuditModal()">✕</button>
        </div>

        <div class="modal-body" style="padding: 20px; overflow-y: auto; max-height: 72vh; background: var(--bg-primary); display: flex; flex-direction: column; gap: 14px;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">Audit Date *</label>
              <input type="date" id="sa-add-date" class="form-control" style="width: 100%; box-sizing: border-box; padding: 7px 10px; margin-top: 4px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: #fff;">
            </div>
            <div>
              <label style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">Job # *</label>
              <input type="text" id="sa-add-job" class="form-control" placeholder="e.g. 034-27" onchange="window.siteAuditsEngine.onAddModalJobChange(this.value)" style="width: 100%; box-sizing: border-box; padding: 7px 10px; margin-top: 4px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: #fff;">
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">Crew Location</label>
              <input type="text" id="sa-add-location" class="form-control" placeholder="e.g. Florence" style="width: 100%; box-sizing: border-box; padding: 7px 10px; margin-top: 4px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: #fff;">
            </div>
            <div>
              <label style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">Foreman</label>
              <input type="text" id="sa-add-foreman" class="form-control" placeholder="e.g. Chad Cliff" style="width: 100%; box-sizing: border-box; padding: 7px 10px; margin-top: 4px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: #fff;">
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">Inspection Completed By</label>
              <input type="text" id="sa-add-inspector" class="form-control" placeholder="e.g. Cody Bechdol" style="width: 100%; box-sizing: border-box; padding: 7px 10px; margin-top: 4px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: #fff;">
            </div>
            <div>
              <label style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">Photo Count</label>
              <input type="number" id="sa-add-photos" class="form-control" value="0" min="0" style="width: 100%; box-sizing: border-box; padding: 7px 10px; margin-top: 4px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: #fff;">
            </div>
          </div>

          <div>
            <label style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">Site Inspection / Work Practices Observed</label>
            <textarea id="sa-add-inspection" rows="3" class="form-control" placeholder="Notes on site inspection and work practices observed..." style="width: 100%; box-sizing: border-box; padding: 8px 10px; margin-top: 4px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: #fff; resize: vertical;"></textarea>
          </div>

          <div>
            <label style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">Correction(s) Needed</label>
            <input type="text" id="sa-add-corrections" class="form-control" placeholder="Leave blank or 'No' if none, or enter details..." style="width: 100%; box-sizing: border-box; padding: 7px 10px; margin-top: 4px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: #fff;">
          </div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 10px; padding: 12px 20px; background: var(--bg-secondary); border-top: 1px solid var(--border-color);">
          <button class="btn btn-secondary" style="padding: 7px 16px; font-size: 13px;" onclick="window.siteAuditsEngine.closeAddAuditModal()">Cancel</button>
          <button class="btn btn-primary" style="padding: 7px 20px; font-size: 13px; font-weight: 700; background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); border: none; color: #fff;" onclick="window.siteAuditsEngine.saveAuditModal()">Save Site Audit</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  async saveAuditModal() {
    const dateVal = document.getElementById('sa-add-date')?.value?.trim();
    const jobVal = document.getElementById('sa-add-job')?.value?.trim() || '';
    const locInput = document.getElementById('sa-add-location')?.value?.trim() || '';
    const foremanInput = document.getElementById('sa-add-foreman')?.value?.trim() || '';
    const inspectorVal = document.getElementById('sa-add-inspector')?.value?.trim() || '';
    const inspectionVal = document.getElementById('sa-add-inspection')?.value?.trim() || '';
    const rawCorr = document.getElementById('sa-add-corrections')?.value?.trim() || '';
    const photosVal = parseInt(document.getElementById('sa-add-photos')?.value || '0', 10);

    if (!dateVal) {
      alert('Please enter a valid Audit Date.');
      return;
    }
    if (!jobVal) {
      alert('Please enter a Job Number.');
      return;
    }

    // Apply Job Tracking precedence rule when saving
    const jtTable = this.db?.snapshot?.tables?.['job_tracking'] || this.db?.getTable?.('job_tracking');
    const jtMatch = jtTable?.rows?.find(j => {
      const jn = String(j['Job Number'] || j['Job #'] || '').trim().replace(/^job\s*#?\s*/i, '');
      return jn === jobVal || jn.replace(/^0+/, '') === jobVal.replace(/^0+/, '');
    }) || {};

    const locVal = this.resolveFieldWithJobTracking(locInput, jtMatch['Location']).display;
    const foremanVal = this.resolveFieldWithJobTracking(foremanInput, jtMatch['Foreman'] || jtMatch['Crew Lead']).display;

    const corrVal = (!rawCorr || /^(no|none|n\/?a)$/i.test(rawCorr))
      ? 'No'
      : (/^yes\b/i.test(rawCorr) ? rawCorr : `Yes — ${rawCorr}`);
    const statusVal = corrVal.startsWith('Yes') ? 'Corrections Needed' : 'Logged';

    const dObj = this.parseDate(dateVal) || new Date();
    const quarterKey = `${dObj.getFullYear()}-Q${Math.floor(dObj.getMonth() / 3) + 1}`;

    const snap = this.db?.snapshot;
    if (!snap) return;
    if (!snap.tables) snap.tables = {};
    if (!snap.tables['site_audits']) {
      snap.tables['site_audits'] = {
        name: 'Site Audits',
        headers: ['Date Received', 'Audit Date', 'Quarter', 'Job #', 'Location', 'Foreman', 'Inspector', 'Site Inspection', 'Corrections Needed', 'Photo Count', 'Email ID', 'PDF Filename', 'Status', 'Notes'],
        rows: []
      };
    }
    const table = snap.tables['site_audits'];
    const newIdx = table.rows.length + 2;
    const emailId = `manual_${Date.now()}`;

    const newRecord = {
      _rowIdx: newIdx,
      'Date Received': new Date().toISOString(),
      'Audit Date': dateVal,
      'Quarter': quarterKey,
      'Job #': jobVal,
      'Location': locVal,
      'Foreman': foremanVal,
      'Inspector': inspectorVal,
      'Site Inspection': inspectionVal,
      'Corrections Needed': corrVal,
      'Photo Count': isNaN(photosVal) ? 0 : photosVal,
      'Email ID': emailId,
      'PDF Filename': '',
      'Status': statusVal,
      'Notes': ''
    };

    table.rows.push(newRecord);
    if (table.rawGrid && table.headers) {
      table.rawGrid.push(table.headers.map(h => newRecord[h] !== undefined ? newRecord[h] : ''));
    }
    table.rowCount = table.rows.length;

    if (typeof this.db.markTableDirty === 'function') {
      this.db.markTableDirty('site_audits');
    }

    await this.db.addMutation({
      action: 'ADD_ROW',
      sheetName: 'Site Audits',
      tableKey: 'site_audits',
      row: newIdx,
      itemIdentifier: emailId,
      data: newRecord
    });

    if (typeof this.db.persistSnapshot === 'function') {
      await this.db.persistSnapshot(snap);
    } else if (window.desktopAPI) {
      await window.desktopAPI.saveLocalSnapshot(snap);
    }

    if (typeof window.showToast === 'function') {
      window.showToast(`✅ Logged Site Audit for Job #${jobVal}`);
    }

    this.closeAddAuditModal();
    this.render();
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  escapeJs(str) {
    if (!str) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
  }
}

window.SiteAuditsEngine = SiteAuditsEngine;
