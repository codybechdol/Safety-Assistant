/**
 * foreman-report-card.js - Foreman Safety Report Card & Dossier Book Engine
 *
 * Replaces the legacy single-week Foreman Tailgate sheet with a Foreman-first
 * Report Card Book supporting:
 * - Fiscal Year (Oct 1 – Sep 30, default) and Calendar Year (Jan 1 – Dec 31) views
 * - Accurate workday-weighted JHA, Weekly Safety, and Monthly Inspection percentages
 *   (mutually exclusive % On-Time / % Late / % Missing summing to 100%, plus % Submitted)
 * - Monthly Inspection 4-consecutive-weeks qualification threshold and 1st-week-of-next-month
 *   (through the 7th) on-time grace window calculated against Monthly Checklist Log
 * - Split-shift sub-crew roll-up (e.g., "040-26 (Fri-Sat)" -> "040-26") and canonical foreman
 *   name normalization via EmployeeNameResolver
 * - Page 1: Foreman Cover Page (YTD totals, weighted report card, YTD Site Audits & Incidents,
 *   clickable Job Index)
 * - Page 2: Deduplicated Current State Page for active foremen (all 9 equipment tables +
 *   60-day expiring certifications across all active crew members, deduplicated across multi-job foremen)
 * - Pages 3..N: Individual Job Report Cards (Active -> On Hold -> Completed) with inline
 *   Job Tracking status management (Active / On Hold / Completed)
 * - Dossier-style book paging (floating chevrons, header/footer nav, page jump menu, keyboard
 *   arrows, touch swipe, 3D page-turn animations)
 * - Multi-scope Print & Electron printToPDF export (Current Page, Full Foreman Packet, All Foremen)
 */

class ForemanReportCardEngine {
  constructor(db) {
    this._db = db;
    this.periodMode = 'fiscal'; // 'fiscal' | 'calendar'
    this.selectedYear = null;   // numeric FY (e.g. 2027) or CY (e.g. 2026)
    this.selectedForeman = '';  // canonical foreman name
    this.currentPageIndex = 0;
    this.statusFilters = {
      Active: true,
      'On Hold': true,
      Completed: true
    };
    this.includeExcludedJobs = false;
    this.cachedModel = null;
    this._listenersInitialized = false;
    this._isAnimatingTurn = false;

    if (typeof window !== 'undefined') {
      window.foremanReportCardEngine = this;
    }
  }

  get db() {
    return this._db || (typeof window !== 'undefined' ? window.localDB : null);
  }

  set db(val) {
    this._db = val;
  }

  init() {
    this.initBookNavigationListeners();
    if (this.db && typeof this.db.subscribe === 'function') {
      this.db.subscribe(() => {
        this.cachedModel = null;
        if (this.isWorkspaceVisible()) {
          this.renderWorkspace({ preservePage: true });
        }
      });
    }
  }

  isWorkspaceVisible() {
    if (typeof document === 'undefined') return false;
    const view = document.getElementById('tailgate-generator-view');
    return Boolean(view && view.classList.contains('active'));
  }

  // =========================================================================
  // Date, String, Name & Normalization Helpers
  // =========================================================================

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  escapeJs(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"');
  }

  parseDate(val) {
    if (!val || val === 'N/A' || val === '—' || val === '-') return null;
    if (val instanceof Date) {
      return isNaN(val.getTime()) ? null : new Date(val.getFullYear(), val.getMonth(), val.getDate(), 12, 0, 0);
    }
    const s = String(val).trim();
    if (!s) return null;

    // ISO YYYY-MM-DD or YYYY-MM-DDTHH:mm...
    const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) {
      const y = parseInt(isoMatch[1], 10);
      const m = parseInt(isoMatch[2], 10) - 1;
      const d = parseInt(isoMatch[3], 10);
      const dt = new Date(y, m, d, 12, 0, 0);
      return isNaN(dt.getTime()) ? null : dt;
    }

    // US MM/DD/YYYY (with optional timestamp)
    const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (usMatch) {
      const m = parseInt(usMatch[1], 10) - 1;
      const d = parseInt(usMatch[2], 10);
      let y = parseInt(usMatch[3], 10);
      if (y < 100) y += 2000;
      const dt = new Date(y, m, d, 12, 0, 0);
      return isNaN(dt.getTime()) ? null : dt;
    }

    // Dash US MM-DD-YYYY
    const dashUs = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (dashUs) {
      const m = parseInt(dashUs[1], 10) - 1;
      const d = parseInt(dashUs[2], 10);
      let y = parseInt(dashUs[3], 10);
      if (y < 100) y += 2000;
      const dt = new Date(y, m, d, 12, 0, 0);
      return isNaN(dt.getTime()) ? null : dt;
    }

    const parsed = new Date(s);
    if (isNaN(parsed.getTime())) return null;
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12, 0, 0);
  }

  formatDateUs(dt) {
    if (!dt || !(dt instanceof Date) || isNaN(dt.getTime())) return '—';
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const yyyy = dt.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }

  formatShortDate(dt) {
    if (!dt || !(dt instanceof Date) || isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  formatIsoDate(dt) {
    if (!dt || !(dt instanceof Date) || isNaN(dt.getTime())) return '';
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  dateKey(dt) {
    return this.formatIsoDate(dt);
  }

  monthKey(dt) {
    if (!dt || !(dt instanceof Date) || isNaN(dt.getTime())) return '';
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    return `${yyyy}-${mm}`;
  }

  formatMonthShort(mKey) {
    const [y, m] = String(mKey || '').split('-').map(Number);
    if (!y || !m) return mKey;
    const dt = new Date(y, m - 1, 15, 12, 0, 0);
    return dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  }

  getBaseJobNumber(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    if (!s) return '';
    // Strip leading "Job #" / "Crew "
    s = s.replace(/^(?:job\s*#?\s*|crew\s+)/i, '').trim();
    // Strip split-shift parenthetical or dash sub-crew suffix: "040-26 (Fri-Sat)" -> "040-26"
    s = s.replace(/\s*\([^)]*\)\s*$/g, '').trim();
    s = s.replace(/\s+-\s+.*$/g, '').trim();
    // Strip employee rank suffix: "022-27.1" -> "022-27"
    s = s.replace(/\.\d+.*$/, '').trim();
    return s;
  }

  isExcludedJob(baseJob) {
    if (!baseJob) return true;
    const lower = baseJob.toLowerCase();
    if (lower === 'job number' || lower === 'job #' || lower === 'crew' || lower === 'status') return true;
    if (this.includeExcludedJobs) return false;
    return /^(002|005)-/i.test(baseJob) || lower === '002' || lower === '005';
  }

  normalizeJobStatus(rawStatus) {
    const s = String(rawStatus || '').trim().toLowerCase();
    if (!s || s === 'active' || s === 'open' || s === 'in progress') return 'Active';
    if (s === 'on hold' || s === 'hold' || s === 'paused') return 'On Hold';
    if (s === 'completed' || s === 'complete' || s === 'closed' || s === 'finished') return 'Completed';
    if (s === 'pending start' || s === 'pending' || s === 'scheduled') return 'Pending Start';
    return String(rawStatus).trim();
  }

  buildEmployeeAliasLookup() {
    const aliasMap = new Map(); // normalized -> canonicalName
    const empTable = this.db ? this.db.getTable('employees') : null;
    if (!empTable || !Array.isArray(empTable.rows)) return aliasMap;

    const register = (key, canonical) => {
      const k = String(key || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (k && !aliasMap.has(k)) aliasMap.set(k, canonical);
    };

    empTable.rows.forEach(r => {
      const canonical = String(r['Employee Name'] || r['Name'] || '').trim();
      if (!canonical) return;
      register(canonical, canonical);
      const noHyphen = canonical.replace(/[-_]+/g, ' ');
      register(noHyphen, canonical);

      // Register alternate names column variations
      const altRaw = String(
        r['Alternate Names'] || r['Alternative Names'] || r['Alt Names'] || r['AKA'] || ''
      ).trim();
      if (altRaw) {
        altRaw.split(/[;,/]+/).forEach(a => register(a, canonical));
      }

      // Common short first-name aliases (Matthew -> Matt, Benjamin -> Ben, Christian -> Chris, etc.)
      const parts = canonical.split(/\s+/);
      if (parts.length >= 2) {
        const first = parts[0].toLowerCase();
        const rest = parts.slice(1).join(' ');
        const commonNicknames = {
          matthew: ['matt'],
          benjamin: ['ben'],
          christian: ['chris'],
          christopher: ['chris'],
          james: ['jim', 'jimmy'],
          jimmy: ['jim', 'james'],
          joshua: ['josh'],
          nicholas: ['nick'],
          michael: ['mike'],
          robert: ['rob', 'bob', 'bobby'],
          william: ['will', 'bill', 'billy'],
          joseph: ['joe'],
          anthony: ['tony'],
          daniel: ['dan', 'danny'],
          jonathan: ['jon'],
          timothy: ['tim'],
          thomas: ['tom', 'tommy'],
          david: ['dave'],
          zachary: ['zach', 'zack'],
          andrew: ['andy', 'drew']
        };
        if (commonNicknames[first]) {
          commonNicknames[first].forEach(nick => register(`${nick} ${rest}`, canonical));
        }
        // Also handle 3-part names like "Jimmy James Bailey" -> "Jimmy Bailey" / "James Bailey"
        if (parts.length === 3) {
          register(`${parts[0]} ${parts[2]}`, canonical);
          register(`${parts[1]} ${parts[2]}`, canonical);
        }
      }
    });

    return aliasMap;
  }

  resolveCanonicalName(rawName, fallbackAliasMap = null) {
    if (!rawName) return '';
    const cleaned = String(rawName)
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned === '—' || cleaned === '-' || cleaned.toLowerCase() === 'unknown' || cleaned.toLowerCase() === 'unassigned') {
      return '';
    }

    if (typeof window !== 'undefined' && window.employeeResolver && typeof window.employeeResolver.getCanonicalName === 'function') {
      const resolved = window.employeeResolver.getCanonicalName(cleaned);
      if (resolved && resolved !== cleaned) return resolved;
      // Still check fallback map for common nickname variants if resolver returned raw
      if (fallbackAliasMap) {
        const hit = fallbackAliasMap.get(resolved.toLowerCase());
        if (hit) return hit;
      }
      return resolved || cleaned;
    }

    if (fallbackAliasMap) {
      const hit = fallbackAliasMap.get(cleaned.toLowerCase());
      if (hit) return hit;
    }

    return cleaned;
  }

  getFyAliasMap() {
    let aliasMap = {};
    try {
      const snap = this.db?.snapshot;
      if (snap?.configs?.FY_TRANSITION_ALIAS_MAP && typeof snap.configs.FY_TRANSITION_ALIAS_MAP === 'object') {
        Object.assign(aliasMap, snap.configs.FY_TRANSITION_ALIAS_MAP);
      }
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('FY_TRANSITION_ALIAS_MAP');
        if (raw) Object.assign(aliasMap, JSON.parse(raw));
      }
    } catch (e) {}
    return aliasMap;
  }

  // =========================================================================
  // Period Calculation (Fiscal Year Oct 1–Sep 30 Default, Calendar Year Option)
  // =========================================================================

  getCurrentFiscalYear(refDate = new Date()) {
    const m = refDate.getMonth(); // 0=Jan .. 9=Oct
    const y = refDate.getFullYear();
    return m >= 9 ? y + 1 : y;
  }

  getPeriodBounds(periodMode = this.periodMode, yearNum = this.selectedYear, refDate = new Date()) {
    const today = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), 12, 0, 0);
    const mode = periodMode === 'calendar' ? 'calendar' : 'fiscal';
    const yr = yearNum || (mode === 'fiscal' ? this.getCurrentFiscalYear(today) : today.getFullYear());

    let start, end, shortLabel, fullLabel, rangeStr;
    if (mode === 'fiscal') {
      start = new Date(yr - 1, 9, 1, 0, 0, 0, 0);        // Oct 1 of yr-1
      end = new Date(yr, 8, 30, 23, 59, 59, 999);       // Sep 30 of yr
      shortLabel = `FY${String(yr).slice(-2)}`;
      fullLabel = `Fiscal Year ${shortLabel}`;
      rangeStr = `Oct 1, ${yr - 1} – Sep 30, ${yr}`;
    } else {
      start = new Date(yr, 0, 1, 0, 0, 0, 0);           // Jan 1 of yr
      end = new Date(yr, 11, 31, 23, 59, 59, 999);      // Dec 31 of yr
      shortLabel = `CY ${yr}`;
      fullLabel = `Calendar Year ${yr}`;
      rangeStr = `Jan 1, ${yr} – Dec 31, ${yr}`;
    }

    const isYtd = today >= start && today <= end;
    const effectiveEnd = today < end ? today : end;
    const displayRangeStr = isYtd
      ? `${this.formatShortDate(start)} – ${this.formatShortDate(today)} (YTD)`
      : rangeStr;

    return {
      mode,
      year: yr,
      start,
      end,
      effectiveEnd,
      today,
      isYtd,
      shortLabel,
      fullLabel,
      rangeStr,
      displayRangeStr
    };
  }

  getAvailableYears(periodMode = this.periodMode, refDate = new Date()) {
    const mode = periodMode === 'calendar' ? 'calendar' : 'fiscal';
    const years = new Set();
    const curYr = mode === 'fiscal' ? this.getCurrentFiscalYear(refDate) : refDate.getFullYear();
    years.add(curYr);

    const addDate = (dt) => {
      if (!dt) return;
      if (mode === 'fiscal') {
        years.add(dt.getMonth() >= 9 ? dt.getFullYear() + 1 : dt.getFullYear());
      } else {
        years.add(dt.getFullYear());
      }
    };

    const scTable = this.db ? this.db.getTable('safety_compliance') : null;
    if (scTable && Array.isArray(scTable.rows)) {
      scTable.rows.forEach(r => {
        const ws = this.parseDate(r['Week Start'] || r['Week']);
        if (ws) {
          addDate(ws);
          // Also check Thursday of the week for boundary weeks (e.g. Sep 27 -> Oct 1)
          const mid = new Date(ws.getTime() + 4 * 86400000);
          addDate(mid);
        }
      });
    }

    const jtTable = this.db ? this.db.getTable('job_tracking') : null;
    if (jtTable && Array.isArray(jtTable.rows)) {
      jtTable.rows.forEach(r => {
        const st = this.parseDate(r['Start Date']);
        const en = this.parseDate(r['Actual End Date']);
        if (st) addDate(st);
        if (en) addDate(en);
      });
    }

    return Array.from(years)
      .filter(y => y >= 2022 && y <= curYr + 1)
      .sort((a, b) => b - a);
  }

  // =========================================================================
  // Compliance Cell Classification & Largest-Remainder Percentages
  // =========================================================================

  classifyDayCell(val) {
    const s = String(val || '').trim();
    if (!s || s === 'N/A' || s === '—' || s === '-') return 'na';
    const upper = s.toUpperCase();
    if (upper === 'DNW' || upper === '❌W' || s.includes('❌W')) return 'dnw';
    if (s.includes('🏖') || upper.includes('HOLIDAY')) return 'holiday';
    if (s.includes('✅L') || /✅\s*L/i.test(s) || (s.includes('✅') && upper.includes('LATE'))) return 'late';
    if (s.includes('✅')) return 'onTime';
    if (s.includes('❌') && !s.includes('⏳')) return 'missing';
    if (s.includes('⏳')) return 'pending';
    return 'na';
  }

  classifyWeeklyCell(val) {
    const s = String(val || '').trim();
    if (!s || s === 'N/A' || s === '—' || s === '-') return 'na';
    const upper = s.toUpperCase();
    if (s.includes('✅L') || /✅\s*L/i.test(s) || (s.includes('✅') && upper.includes('LATE'))) return 'late';
    if (s.includes('✅')) return 'onTime';
    if (s.includes('❌') && !s.includes('⏳')) return 'missing';
    if (s.includes('⏳')) return 'pending';
    return 'na';
  }

  mergeCellState(a, b) {
    const rank = { onTime: 6, late: 5, missing: 4, pending: 3, holiday: 2, dnw: 1, na: 0 };
    const ra = rank[a] ?? 0;
    const rb = rank[b] ?? 0;
    return ra >= rb ? a : b;
  }

  stateToIcon(state) {
    switch (state) {
      case 'onTime': return '✅';
      case 'late': return '✅L';
      case 'missing': return '❌';
      case 'pending': return '⏳';
      case 'holiday': return '🏖️';
      case 'dnw': return 'DNW';
      default: return '—';
    }
  }

  /**
   * Computes mutually exclusive On-Time / Late / Missing percentages summing to 100%,
   * plus headline Submitted % (On-Time + Late).
   */
  computeMetricStats(onTime, late, missing, pending = 0, exempt = 0) {
    const expected = onTime + late + missing;
    if (expected <= 0) {
      return {
        onTime,
        late,
        missing,
        pending,
        exempt,
        expected: 0,
        submitted: 0,
        onTimePct: null,
        latePct: null,
        missingPct: null,
        submittedPct: null
      };
    }

    const exacts = [
      { key: 'onTimePct', exact: (onTime / expected) * 100 },
      { key: 'latePct', exact: (late / expected) * 100 },
      { key: 'missingPct', exact: (missing / expected) * 100 }
    ];
    const items = exacts.map(x => ({
      key: x.key,
      val: Math.floor(x.exact),
      rem: x.exact - Math.floor(x.exact)
    }));
    let diff = 100 - items.reduce((sum, x) => sum + x.val, 0);
    const sorted = [...items].sort((a, b) => b.rem - a.rem);
    for (let i = 0; i < diff; i++) {
      sorted[i].val += 1;
    }
    const map = {};
    items.forEach(x => { map[x.key] = x.val; });

    return {
      onTime,
      late,
      missing,
      pending,
      exempt,
      expected,
      submitted: onTime + late,
      onTimePct: map.onTimePct,
      latePct: map.latePct,
      missingPct: map.missingPct,
      submittedPct: map.onTimePct + map.latePct
    };
  }

  // =========================================================================
  // Core Data Model Builder (Foreman -> Cover + Current State + Job Cards)
  // =========================================================================

  buildDataModel(options = {}) {
    const refDate = options.refDate ? new Date(options.refDate) : new Date();
    const periodMode = options.periodMode || this.periodMode || 'fiscal';
    const availableYears = this.getAvailableYears(periodMode, refDate);
    const yearNum = options.selectedYear || this.selectedYear || availableYears[0];
    const period = this.getPeriodBounds(periodMode, yearNum, refDate);

    const aliasMap = this.buildEmployeeAliasLookup();
    const fyAliasMap = this.getFyAliasMap(); // oldJob -> newJob
    const fyReverseAlias = new Map();        // newJob -> Set(oldJobs)
    Object.entries(fyAliasMap).forEach(([oldJ, newJ]) => {
      const ob = this.getBaseJobNumber(oldJ);
      const nb = this.getBaseJobNumber(newJ);
      if (ob && nb && ob !== nb) {
        if (!fyReverseAlias.has(nb)) fyReverseAlias.set(nb, new Set());
        fyReverseAlias.get(nb).add(ob);
      }
    });

    // -----------------------------------------------------------------------
    // 1. Index Employees & Classification Ranks
    // -----------------------------------------------------------------------
    const CLASS_RANK = {
      'SUP': 1, 'GF': 2, 'F': 3, 'GTO F': 4, 'JRY': 5, 'JRY OP': 6,
      'WT': 7, 'GTO': 8, 'EO 1': 9, 'EO 2': 10,
      'AP 7': 11, 'AP 6': 12, 'AP 5': 13, 'AP 4': 14, 'AP 3': 15, 'AP 2': 16, 'AP 1': 17,
      'GM': 18
    };
    const STATUS_LOCS = new Set(['vacation', 'light duty', 'weeds', 'leave', 'previous employee', 'medical', "worker's comp", 'unknown']);

    const empTable = this.db ? this.db.getTable('employees') : null;
    const empByCanonical = new Map(); // canonical -> emp info
    const activeEmployeesByJob = new Map(); // baseJob -> Set(canonicalName)

    if (empTable && Array.isArray(empTable.rows)) {
      empTable.rows.forEach(r => {
        const rawName = String(r['Employee Name'] || r['Name'] || '').trim();
        if (!rawName) return;
        const canonical = this.resolveCanonicalName(rawName, aliasMap) || rawName;
        const rawLoc = String(r['Location'] || '').trim();
        const cleanLoc = rawLoc.replace(/\s*\([^)]*\)\s*/g, '').trim();
        const empStatus = String(r['Status'] || 'Active').trim();
        const isPrev = empStatus.toLowerCase().includes('previous') ||
          empStatus.toLowerCase().includes('terminated') ||
          empStatus.toLowerCase().includes('inactive') ||
          rawLoc.toLowerCase().includes('previous employee');

        const primaryJob = this.getBaseJobNumber(r['Job Number'] || r['Job #'] || '');
        const secondaryJob = this.getBaseJobNumber(r['Secondary Job Number'] || r['Secondary Job #'] || '');
        const classification = String(r['Job Classification'] || r['Classification'] || r['Role'] || '').trim();
        const isCrewLead = /^(yes|true|y|1)$/i.test(String(r['Crew Lead'] || '').trim());

        const info = {
          name: canonical,
          location: STATUS_LOCS.has(cleanLoc.toLowerCase()) ? '' : cleanLoc,
          rawLocation: rawLoc,
          status: empStatus,
          isActive: !isPrev,
          primaryJob,
          secondaryJob,
          classification,
          classRank: CLASS_RANK[classification.toUpperCase()] || 50,
          isCrewLead
        };
        empByCanonical.set(canonical, info);

        if (info.isActive) {
          [primaryJob, secondaryJob].forEach(bj => {
            if (bj && !this.isExcludedJob(bj)) {
              if (!activeEmployeesByJob.has(bj)) activeEmployeesByJob.set(bj, new Set());
              activeEmployeesByJob.get(bj).add(canonical);
            }
          });
        }
      });
    }

    // -----------------------------------------------------------------------
    // 2. Index Job Tracking (deduplicated by Base Job Number)
    // -----------------------------------------------------------------------
    const jtTable = this.db ? this.db.getTable('job_tracking') : null;
    const jtByBaseJob = new Map(); // baseJob -> normalized JT record

    if (jtTable && Array.isArray(jtTable.rows)) {
      jtTable.rows.forEach(r => {
        const baseJob = this.getBaseJobNumber(r['Job Number'] || r['Job #'] || '');
        if (!baseJob || this.isExcludedJob(baseJob)) return;
        const status = this.normalizeJobStatus(r['Status']);
        const foremanRaw = String(r['Foreman'] || r['Crew Lead'] || '').trim();
        const foreman = this.resolveCanonicalName(foremanRaw, aliasMap);
        const rawLoc = String(r['Location'] || '').trim();
        const cleanLoc = rawLoc.replace(/\s*\([^)]*\)\s*/g, '').trim();
        const loc = STATUS_LOCS.has(cleanLoc.toLowerCase()) ? '' : cleanLoc;

        const record = {
          jobNumber: baseJob,
          jobName: String(r['Job Name'] || '').trim(),
          location: loc,
          foreman,
          status,
          startDate: this.parseDate(r['Start Date']),
          startDateStr: String(r['Start Date'] || '').trim(),
          putOnHoldDate: this.parseDate(r['Put On Hold Date']),
          putOnHoldDateStr: String(r['Put On Hold Date'] || '').trim(),
          estimatedReturn: this.parseDate(r['Estimated Return']),
          estimatedReturnStr: String(r['Estimated Return'] || '').trim(),
          estEndDate: this.parseDate(r['Est. End Date']),
          actualEndDate: this.parseDate(r['Actual End Date']),
          actualEndDateStr: String(r['Actual End Date'] || '').trim(),
          workSchedule: String(r['Work Schedule'] || r['Schedule'] || '').trim(),
          crewType: String(r['Crew Type'] || '').trim(),
          skipMonthlyChecklist: r['Skip Monthly Checklist'] === true || String(r['Skip Monthly Checklist'] || '').toLowerCase() === 'true',
          skipWeeklyMeeting: r['Skip Weekly Meeting'] === true || String(r['Skip Weekly Meeting'] || '').toLowerCase() === 'true',
          _rawRow: r
        };

        // Keep Active over Completed if duplicate row exists in raw snapshot
        const prev = jtByBaseJob.get(baseJob);
        if (!prev || (prev.status !== 'Active' && record.status === 'Active')) {
          jtByBaseJob.set(baseJob, record);
        }
      });
    }

    // -----------------------------------------------------------------------
    // 3. Index Monthly Checklist Log (for exact On-Time vs Late evaluation)
    // -----------------------------------------------------------------------
    const monthlyLogTable = this.db ? this.db.getTable('monthly_checklist_log') : null;
    const monthlyLogByJobMonth = new Map(); // `${baseJob}|${YYYY-MM}` -> Array of submissions

    if (monthlyLogTable && Array.isArray(monthlyLogTable.rows)) {
      monthlyLogTable.rows.forEach(r => {
        const status = String(r['Status'] || '').trim().toLowerCase();
        if (status === 'duplicate' || status === 'error') return;

        const reportDt = this.parseDate(r['Report Date'] || r['Date Created'] || r['Date Received'] || r['Date Recieved']);
        if (!reportDt) return;
        const receivedDt = this.parseDate(r['Date Received'] || r['Date Recieved']);
        const mKey = this.monthKey(reportDt);
        if (!mKey) return;

        const credJob = this.getBaseJobNumber(r['Credited To'] || '');
        const origJob = this.getBaseJobNumber(r['Job Number'] || '');
        if (status && status !== 'credited' && !credJob) return;

        const targetJobs = new Set();
        if (credJob) targetJobs.add(credJob);
        if (origJob && (!credJob || origJob === credJob)) targetJobs.add(origJob);
        // Also propagate alias mapping (e.g. 022-26 -> 022-27)
        Array.from(targetJobs).forEach(j => {
          const mapped = fyAliasMap[j] ? this.getBaseJobNumber(fyAliasMap[j]) : '';
          if (mapped) targetJobs.add(mapped);
        });

        const entry = {
          reportDate: reportDt,
          dateReceived: receivedDt,
          foreman: this.resolveCanonicalName(r['Foreman'] || '', aliasMap),
          vehicleNumber: String(r['Vehicle Number'] || r['Equipment Number'] || '').trim(),
          emailSubject: String(r['Email Subject'] || '').trim(),
          status: String(r['Status'] || '').trim()
        };

        targetJobs.forEach(bj => {
          if (!bj || this.isExcludedJob(bj)) return;
          const k = `${bj}|${mKey}`;
          if (!monthlyLogByJobMonth.has(k)) monthlyLogByJobMonth.set(k, []);
          monthlyLogByJobMonth.get(k).push(entry);
        });
      });
    }

    // -----------------------------------------------------------------------
    // 3b. Index JHA Log & Weekly Safety Log for Foreman Attribution Cross-Check
    // -----------------------------------------------------------------------
    // Build set of legitimate leaders/foremen so random crew members or malformed
    // values (e.g. a job number parsed into Foreman column) never override SC.
    const LEADER_CLASSES = new Set(['SUP', 'GF', 'F', 'GTO F']);
    const knownLeaders = new Set();
    empByCanonical.forEach((info, name) => {
      if (LEADER_CLASSES.has(info.classification.toUpperCase()) || info.isCrewLead) {
        knownLeaders.add(name);
      }
    });
    jtByBaseJob.forEach(jt => {
      if (jt.foreman) knownLeaders.add(jt.foreman);
    });

    const scTable = this.db ? this.db.getTable('safety_compliance') : null;
    if (scTable && Array.isArray(scTable.rows)) {
      scTable.rows.forEach(r => {
        const fm = this.resolveCanonicalName(r['Foreman'] || r['Crew Lead'] || r['Lead'] || '', aliasMap);
        if (fm && empByCanonical.has(fm)) knownLeaders.add(fm);
      });
    }

    // jhaForemanByJobWeek: `${baseJob}|${weekStartKey}` -> Map(canonicalForeman -> Set(uniqueDateKeys))
    const jhaForemanByJobWeek = new Map();
    const jhaLogTable = this.db ? this.db.getTable('jha_log') : null;
    if (jhaLogTable && Array.isArray(jhaLogTable.rows)) {
      jhaLogTable.rows.forEach(r => {
        const st = String(r['Status'] || '').trim().toLowerCase();
        if (st === 'duplicate' || st === 'error') return;
        const dt = this.parseDate(r['Date Created'] || r['Date Received'] || r['Date Recieved']);
        if (!dt) return;
        const sun = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - dt.getDay(), 12, 0, 0);
        const wsKey = this.dateKey(sun);
        const bj = this.getBaseJobNumber(r['Credited To'] || r['Job Number'] || '');
        if (!bj || this.isExcludedJob(bj)) return;
        const fm = this.resolveCanonicalName(r['Foreman'] || '', aliasMap);
        if (!fm || !empByCanonical.has(fm) || !knownLeaders.has(fm)) return;

        const key = `${bj}|${wsKey}`;
        if (!jhaForemanByJobWeek.has(key)) jhaForemanByJobWeek.set(key, new Map());
        const fmMap = jhaForemanByJobWeek.get(key);
        if (!fmMap.has(fm)) fmMap.set(fm, new Set());
        fmMap.get(fm).add(this.dateKey(dt));
      });
    }

    // weeklyForemanByJobWeek: `${baseJob}|${weekStartKey}` -> Set(canonicalForeman)
    const weeklyForemanByJobWeek = new Map();
    const weeklyLogTable = this.db ? this.db.getTable('weekly_safety_log') : null;
    if (weeklyLogTable && Array.isArray(weeklyLogTable.rows)) {
      weeklyLogTable.rows.forEach(r => {
        const st = String(r['Status'] || '').trim().toLowerCase();
        if (st === 'duplicate' || st === 'error') return;
        const dt = this.parseDate(r['Week Of'] || r['Date Received'] || r['Date Recieved']);
        if (!dt) return;
        const sun = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - dt.getDay(), 12, 0, 0);
        const wsKey = this.dateKey(sun);
        const bj = this.getBaseJobNumber(r['Credited To'] || r['Job Number'] || '');
        if (!bj || this.isExcludedJob(bj)) return;
        const fm = this.resolveCanonicalName(r['Foreman'] || '', aliasMap);
        if (!fm || !empByCanonical.has(fm) || !knownLeaders.has(fm)) return;

        const key = `${bj}|${wsKey}`;
        if (!weeklyForemanByJobWeek.has(key)) weeklyForemanByJobWeek.set(key, new Set());
        weeklyForemanByJobWeek.get(key).add(fm);
      });
    }

    // -----------------------------------------------------------------------
    // 4. Parse ALL Safety Compliance Rows (full history for 4-week streaks + period filtering)
    // -----------------------------------------------------------------------
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // 4a. Per-job complete weekly timeline (for consecutive-week streak across job lifetime)
    // baseJob -> Map(weekStartKey -> { weekStart, mondayDate, monthKey, isActiveWeek, monthlyRawStates: Set, foremenCount: Map })
    const jobFullWeeks = new Map();

    // 4b. Merged split-shift rows keyed by `${foreman}|${baseJob}|${weekStartKey}`
    const mergedForemanJobWeeks = new Map();

    if (scTable && Array.isArray(scTable.rows)) {
      scTable.rows.forEach(r => {
        const ws = this.parseDate(r['Week Start'] || r['Week']);
        if (!ws) return;
        const baseJob = this.getBaseJobNumber(r['Job Number'] || r['Crew'] || r['Job #'] || '');
        if (!baseJob || this.isExcludedJob(baseJob)) return;

        const jt = jtByBaseJob.get(baseJob);
        const rawForeman = String(r['Foreman'] || r['Crew Lead'] || r['Lead'] || '').trim();
        let foreman = this.resolveCanonicalName(rawForeman, aliasMap);
        if (!foreman && jt && jt.foreman) foreman = jt.foreman;
        if (!foreman) foreman = 'Unassigned';

        const wsKey = this.dateKey(ws);

        // JHA Log Foreman Cross-Check:
        // If Safety Compliance stamped an outdated foreman (0 JHA days submitted by them)
        // while a known leader submitted >=2 unique JHA days (or >=1 JHA day + Weekly Mtg)
        // for this exact (baseJob, week), credit the week to the actual submitting foreman.
        let reattributedFrom = '';
        const jwKey = `${baseJob}|${wsKey}`;
        const jhaFmMap = jhaForemanByJobWeek.get(jwKey);
        const wmFmSet = weeklyForemanByJobWeek.get(jwKey);
        if (jhaFmMap && jhaFmMap.size > 0) {
          const scDays = jhaFmMap.has(foreman) ? jhaFmMap.get(foreman).size : 0;
          if (scDays === 0) {
            let bestFm = '';
            let bestDays = 0;
            jhaFmMap.forEach((dateSet, candFm) => {
              if (dateSet.size > bestDays || (dateSet.size === bestDays && wmFmSet && wmFmSet.has(candFm))) {
                bestDays = dateSet.size;
                bestFm = candFm;
              }
            });
            const corroboratedByWeekly = Boolean(wmFmSet && wmFmSet.has(bestFm));
            if (bestFm && bestFm !== foreman && (bestDays >= 2 || (bestDays >= 1 && corroboratedByWeekly))) {
              reattributedFrom = foreman;
              foreman = bestFm;
            }
          }
        }

        const monDt = new Date(ws.getTime() + 86400000);
        const wkMonthKey = this.monthKey(monDt);

        const dayStates = {};
        let hasActiveWorkday = false;
        DAYS.forEach(d => {
          const st = this.classifyDayCell(r[d]);
          dayStates[d] = st;
          if (st === 'onTime' || st === 'late' || st === 'missing' || st === 'pending' || st === 'holiday') {
            hasActiveWorkday = true;
          }
        });
        const weeklyState = this.classifyWeeklyCell(r['Weekly Meeting']);
        const monthlyRaw = String(r['Monthly Checklist'] || '').trim();
        const isActiveWeek = hasActiveWorkday || (weeklyState !== 'na');

        // Record in full job timeline (used for 4 consecutive weeks calculation)
        if (!jobFullWeeks.has(baseJob)) jobFullWeeks.set(baseJob, new Map());
        const jMap = jobFullWeeks.get(baseJob);
        if (!jMap.has(wsKey)) {
          jMap.set(wsKey, {
            weekStart: ws,
            weekStartKey: wsKey,
            mondayDate: monDt,
            monthKey: wkMonthKey,
            isActiveWeek: false,
            monthlyCells: [],
            foremenInWeek: new Set()
          });
        }
        const jWk = jMap.get(wsKey);
        if (isActiveWeek) jWk.isActiveWeek = true;
        if (monthlyRaw) jWk.monthlyCells.push(monthlyRaw);
        if (foreman && foreman !== 'Unassigned') jWk.foremenInWeek.add(foreman);

        // Merge split-shift rows for `(foreman, baseJob, wsKey)`
        const fjKey = `${foreman}|${baseJob}|${wsKey}`;
        if (!mergedForemanJobWeeks.has(fjKey)) {
          mergedForemanJobWeeks.set(fjKey, {
            foreman,
            baseJob,
            weekStart: ws,
            weekStartKey: wsKey,
            mondayDate: monDt,
            monthKey: wkMonthKey,
            days: { ...dayStates },
            weekly: weeklyState,
            monthlyCells: monthlyRaw ? [monthlyRaw] : [],
            status: String(r['Status'] || '').trim(),
            reattributedFrom
          });
        } else {
          const existing = mergedForemanJobWeeks.get(fjKey);
          DAYS.forEach(d => {
            existing.days[d] = this.mergeCellState(existing.days[d], dayStates[d]);
          });
          existing.weekly = this.mergeCellState(existing.weekly, weeklyState);
          if (monthlyRaw) existing.monthlyCells.push(monthlyRaw);
          if (reattributedFrom && !existing.reattributedFrom) existing.reattributedFrom = reattributedFrom;
        }
      });
    }

    // -----------------------------------------------------------------------
    // 5. Compute Consecutive Active-Week Streaks per Job (for 4-Week Monthly Rule)
    // -----------------------------------------------------------------------
    // jobMonthEval: Map(`${baseJob}|${monthKey}` -> { qualified, maxStreak, weeksInMonth, attributedForeman, monthlyResult })
    const jobMonthEval = new Map();

    jobFullWeeks.forEach((weekMap, baseJob) => {
      // Include contiguous predecessor weeks if job rolled over via FY_TRANSITION_ALIAS_MAP
      const combinedWeeks = new Map(weekMap);
      const predecessors = fyReverseAlias.get(baseJob);
      if (predecessors) {
        predecessors.forEach(oldJob => {
          const oldMap = jobFullWeeks.get(oldJob);
          if (!oldMap) return;
          oldMap.forEach((wkObj, wkKey) => {
            if (!combinedWeeks.has(wkKey) && wkObj.isActiveWeek) {
              combinedWeeks.set(wkKey, { ...wkObj, _fromPredecessor: true });
            }
          });
        });
      }

      const sortedActiveWeeks = Array.from(combinedWeeks.values())
        .filter(w => w.isActiveWeek)
        .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());

      let streak = 0;
      let prevTime = null;
      const monthStats = new Map(); // monthKey -> { maxStreak, ownWeeks: [], foremanWeeks: Map, latestForeman, monthlyCells: [] }

      sortedActiveWeeks.forEach(wk => {
        if (prevTime !== null) {
          const diffDays = Math.round((wk.weekStart.getTime() - prevTime) / 86400000);
          streak = (diffDays >= 6 && diffDays <= 8) ? (streak + 1) : 1;
        } else {
          streak = 1;
        }
        prevTime = wk.weekStart.getTime();

        // Only evaluate months belonging to THIS baseJob (not predecessor-only historical months)
        if (wk._fromPredecessor) return;

        const mKey = wk.monthKey;
        if (!monthStats.has(mKey)) {
          monthStats.set(mKey, {
            monthKey: mKey,
            maxStreak: 0,
            weeksCount: 0,
            foremanWeeks: new Map(),
            latestForeman: '',
            monthlyCells: []
          });
        }
        const ms = monthStats.get(mKey);
        if (streak > ms.maxStreak) ms.maxStreak = streak;
        ms.weeksCount += 1;
        ms.monthlyCells.push(...wk.monthlyCells);
        wk.foremenInWeek.forEach(fm => {
          ms.foremanWeeks.set(fm, (ms.foremanWeeks.get(fm) || 0) + 1);
          ms.latestForeman = fm;
        });
      });

      const jt = jtByBaseJob.get(baseJob);

      monthStats.forEach((ms, mKey) => {
        const [yNum, mNum] = mKey.split('-').map(Number);
        const monthFirst = new Date(yNum, mNum - 1, 1, 12, 0, 0);
        // Only include months falling inside the selected period
        if (monthFirst < period.start || monthFirst > period.end) return;

        // Attribute month to the foreman who led the most weeks in that month (tie-breaker: latest)
        let attributedForeman = ms.latestForeman || (jt && jt.foreman) || 'Unassigned';
        let bestCount = -1;
        ms.foremanWeeks.forEach((cnt, fm) => {
          if (cnt > bestCount || (cnt === bestCount && fm === ms.latestForeman)) {
            bestCount = cnt;
            attributedForeman = fm;
          }
        });

        // Grace deadline: 1st week of following month (through the 7th at 23:59:59)
        const graceDeadline = new Date(yNum, mNum, 7, 23, 59, 59, 999);
        const allCellsNa = ms.monthlyCells.length > 0 && ms.monthlyCells.every(c => {
          const t = String(c || '').trim().toUpperCase();
          return !t || t === 'N/A' || t === '—' || t === '-';
        });
        const anyCellCheckmark = ms.monthlyCells.some(c => String(c || '').includes('✅'));
        const logEntries = monthlyLogByJobMonth.get(`${baseJob}|${mKey}`) || [];

        // Check earliest submission in Monthly Checklist Log
        let earliestLog = null;
        if (logEntries.length > 0) {
          const sortedLogs = [...logEntries].sort((a, b) => {
            const ta = a.dateReceived ? a.dateReceived.getTime() : Number.MAX_SAFE_INTEGER;
            const tb = b.dateReceived ? b.dateReceived.getTime() : Number.MAX_SAFE_INTEGER;
            return ta - tb;
          });
          earliestLog = sortedLogs[0];
        }

        // Evaluate status
        let outcome = 'missing'; // 'onTime' | 'late' | 'missing' | 'pending' | 'exempt_short' | 'skipped'
        let receivedDate = earliestLog ? earliestLog.dateReceived : null;
        let daysPastGrace = 0;

        const isSkipped = (allCellsNa || (jt && jt.skipMonthlyChecklist)) && !earliestLog && !anyCellCheckmark;
        const meetsFourWeekRule = ms.maxStreak >= 4;

        if (isSkipped) {
          outcome = 'skipped';
        } else if (!meetsFourWeekRule) {
          outcome = 'exempt_short';
        } else if (earliestLog) {
          if (receivedDate) {
            if (receivedDate.getTime() <= graceDeadline.getTime()) {
              outcome = 'onTime';
            } else {
              outcome = 'late';
              daysPastGrace = Math.max(1, Math.ceil((receivedDate.getTime() - graceDeadline.getTime()) / 86400000));
            }
          } else {
            outcome = 'onTime';
          }
        } else if (anyCellCheckmark) {
          outcome = 'onTime';
        } else if (period.today.getTime() <= graceDeadline.getTime()) {
          outcome = 'pending';
        } else {
          outcome = 'missing';
        }

        jobMonthEval.set(`${baseJob}|${mKey}`, {
          baseJob,
          monthKey: mKey,
          monthLabel: this.formatMonthShort(mKey),
          maxStreak: ms.maxStreak,
          weeksInMonth: ms.weeksCount,
          attributedForeman,
          outcome,
          graceDeadline,
          receivedDate,
          daysPastGrace,
          submittedAnyway: !meetsFourWeekRule && Boolean(earliestLog || anyCellCheckmark)
        });
      });
    });

    // -----------------------------------------------------------------------
    // 6. Index Site Audits & Incident Reports in Period
    // -----------------------------------------------------------------------
    const auditsByJob = new Map();      // baseJob -> Array
    const auditsByForeman = new Map();  // canonicalForeman -> Array (deduped)
    let rawAudits = [];
    if (typeof window !== 'undefined' && window.siteAuditsEngine && typeof window.siteAuditsEngine.loadAudits === 'function') {
      try { rawAudits = window.siteAuditsEngine.loadAudits() || []; } catch (e) { rawAudits = []; }
    } else {
      const saTable = this.db ? this.db.getTable('site_audits') : null;
      if (saTable && Array.isArray(saTable.rows)) {
        rawAudits = saTable.rows.map(r => ({
          dateObj: this.parseDate(r['Audit Date'] || r['Date Received'] || r['Date']),
          jobNumber: r['Job #'] || r['Job Number'] || '',
          foremanPrimary: r['Foreman'] || '',
          foremanDisplay: r['Foreman'] || '',
          inspector: r['Inspector'] || '',
          siteInspection: r['Site Inspection'] || '',
          correctionsNeeded: r['Corrections Needed'] || '',
          hasCorrections: /^yes\b/i.test(String(r['Corrections Needed'] || '').trim())
        }));
      }
    }

    rawAudits.forEach(sa => {
      const dt = sa.dateObj instanceof Date ? sa.dateObj : this.parseDate(sa.auditDate || sa.dateReceived || sa['Audit Date']);
      if (!dt || dt < period.start || dt > period.end) return;
      const baseJob = this.getBaseJobNumber(sa.jobNumber || sa['Job #'] || sa['Job Number'] || '');
      const jt = baseJob ? jtByBaseJob.get(baseJob) : null;
      const fmRaw = sa.foremanPrimary || sa.foremanDisplay || sa['Foreman'] || (jt ? jt.foreman : '');
      const foreman = this.resolveCanonicalName(fmRaw, aliasMap);

      const item = {
        date: dt,
        dateStr: this.formatDateUs(dt),
        jobNumber: baseJob,
        foreman,
        inspector: String(sa.inspector || sa['Inspector'] || '').trim(),
        summary: String(sa.siteInspection || sa['Site Inspection'] || '').trim(),
        correctionsNeeded: String(sa.correctionsNeeded || sa['Corrections Needed'] || 'No').trim(),
        hasCorrections: Boolean(sa.hasCorrections || /^yes\b/i.test(String(sa.correctionsNeeded || sa['Corrections Needed'] || '').trim()))
      };

      if (baseJob) {
        if (!auditsByJob.has(baseJob)) auditsByJob.set(baseJob, []);
        auditsByJob.get(baseJob).push(item);
      }
      if (foreman) {
        if (!auditsByForeman.has(foreman)) auditsByForeman.set(foreman, []);
        auditsByForeman.get(foreman).push(item);
      }
    });

    const incidentsByJob = new Map();
    const incidentsByForeman = new Map();
    const incTable = this.db ? this.db.getTable('incident_reports') : null;
    let rawIncidents = (incTable && Array.isArray(incTable.rows)) ? incTable.rows : [];
    if (rawIncidents.length === 0 && typeof window !== 'undefined' && window.incidentReportsEngine && typeof window.incidentReportsEngine.loadIncidents === 'function') {
      try { rawIncidents = window.incidentReportsEngine.loadIncidents() || []; } catch (e) { rawIncidents = []; }
    }

    rawIncidents.forEach(inc => {
      const dt = this.parseDate(inc['Date of Incident'] || inc['Date Received'] || inc['Date'] || inc.incidentDate || inc.date);
      if (!dt || dt < period.start || dt > period.end) return;
      const baseJob = this.getBaseJobNumber(inc['Job #'] || inc['Job Number'] || inc.jobNumber || inc.job || '');
      const jt = baseJob ? jtByBaseJob.get(baseJob) : null;
      const fmRaw = inc['Foreman'] || inc.foreman || (jt ? jt.foreman : '');
      const foreman = this.resolveCanonicalName(fmRaw, aliasMap);

      const item = {
        date: dt,
        dateStr: this.formatDateUs(dt),
        jobNumber: baseJob,
        foreman,
        type: String(inc['Incident Type'] || inc.incidentType || 'Incident').trim(),
        description: String(inc['Brief Explanation'] || inc['Explanation'] || inc.description || '').trim(),
        status: String(inc['Status'] || inc.status || '').trim()
      };

      if (baseJob) {
        if (!incidentsByJob.has(baseJob)) incidentsByJob.set(baseJob, []);
        incidentsByJob.get(baseJob).push(item);
      }
      if (foreman) {
        if (!incidentsByForeman.has(foreman)) incidentsByForeman.set(foreman, []);
        incidentsByForeman.get(foreman).push(item);
      }
    });

    // -----------------------------------------------------------------------
    // 7. Assemble Per-Foreman, Per-Job Report Cards inside Selected Period
    // -----------------------------------------------------------------------
    // foremanMap: canonicalForeman -> Map(baseJob -> jobAccumulator)
    const foremanJobsMap = new Map();

    const ensureForemanJob = (foreman, baseJob) => {
      if (!foreman || foreman === 'Unassigned' || !baseJob || this.isExcludedJob(baseJob)) return null;
      if (!foremanJobsMap.has(foreman)) foremanJobsMap.set(foreman, new Map());
      const jMap = foremanJobsMap.get(foreman);
      if (!jMap.has(baseJob)) {
        const jt = jtByBaseJob.get(baseJob);
        const isHandedOff = Boolean(
          jt && jt.foreman && jt.foreman !== foreman &&
          (jt.status === 'Active' || jt.status === 'On Hold')
        );
        const effectiveStatus = isHandedOff ? 'Handed Off' : (jt ? jt.status : 'Completed');
        jMap.set(baseJob, {
          foreman,
          jobNumber: baseJob,
          jobName: jt ? jt.jobName : '',
          location: jt ? jt.location : '',
          status: effectiveStatus,
          isHandedOff,
          currentOwnerForeman: jt ? jt.foreman : '',
          globalJobStatus: jt ? jt.status : 'Completed',
          startDate: jt ? jt.startDate : null,
          putOnHoldDate: jt ? jt.putOnHoldDate : null,
          estimatedReturn: jt ? jt.estimatedReturn : null,
          actualEndDate: jt ? jt.actualEndDate : null,
          workSchedule: jt ? jt.workSchedule : '',
          crewType: jt ? jt.crewType : '',
          inJobTracking: Boolean(jt),
          jhaOnTime: 0,
          jhaLate: 0,
          jhaMissing: 0,
          jhaPending: 0,
          weeklyOnTime: 0,
          weeklyLate: 0,
          weeklyMissing: 0,
          weeklyPending: 0,
          monthlyOnTime: 0,
          monthlyLate: 0,
          monthlyMissing: 0,
          monthlyPending: 0,
          monthlyExempt: 0,
          monthlyDetails: [],
          weeks: [],
          firstWorkDate: null,
          lastWorkDate: null
        });
      }
      return jMap.get(baseJob);
    };

    // 7a. Populate from merged Safety Compliance weeks inside period
    mergedForemanJobWeeks.forEach(wk => {
      // Check if any day in this week OR Monday of this week falls inside period
      const weekEnd = new Date(wk.weekStart.getTime() + 6 * 86400000);
      if (weekEnd < period.start || wk.weekStart > period.end) return;

      const dayCellsInPeriod = {};
      let anyInPeriod = false;
      let jhaOnTimeW = 0, jhaLateW = 0, jhaMissingW = 0, jhaPendingW = 0;
      let firstD = null, lastD = null;

      DAYS.forEach((d, idx) => {
        const dDt = new Date(wk.weekStart.getTime() + idx * 86400000);
        const st = wk.days[d];
        if (dDt < period.start || dDt > period.end) {
          dayCellsInPeriod[d] = 'out';
          return;
        }
        dayCellsInPeriod[d] = st;
        if (st === 'onTime') { jhaOnTimeW++; anyInPeriod = true; }
        else if (st === 'late') { jhaLateW++; anyInPeriod = true; }
        else if (st === 'missing') { jhaMissingW++; anyInPeriod = true; }
        else if (st === 'pending') { jhaPendingW++; anyInPeriod = true; }
        else if (st === 'holiday') { anyInPeriod = true; }

        if (st === 'onTime' || st === 'late' || st === 'missing' || st === 'pending') {
          if (!firstD || dDt < firstD) firstD = dDt;
          if (!lastD || dDt > lastD) lastD = dDt;
        }
      });

      const monInPeriod = wk.mondayDate >= period.start && wk.mondayDate <= period.end;
      const weeklyStateInPeriod = monInPeriod ? wk.weekly : 'out';
      if (monInPeriod && wk.weekly !== 'na') anyInPeriod = true;

      if (!anyInPeriod) return;

      const acc = ensureForemanJob(wk.foreman, wk.baseJob);
      if (!acc) return;

      acc.jhaOnTime += jhaOnTimeW;
      acc.jhaLate += jhaLateW;
      acc.jhaMissing += jhaMissingW;
      acc.jhaPending += jhaPendingW;

      if (weeklyStateInPeriod === 'onTime') acc.weeklyOnTime++;
      else if (weeklyStateInPeriod === 'late') acc.weeklyLate++;
      else if (weeklyStateInPeriod === 'missing') acc.weeklyMissing++;
      else if (weeklyStateInPeriod === 'pending') acc.weeklyPending++;

      if (firstD && (!acc.firstWorkDate || firstD < acc.firstWorkDate)) acc.firstWorkDate = firstD;
      if (lastD && (!acc.lastWorkDate || lastD > acc.lastWorkDate)) acc.lastWorkDate = lastD;

      acc.weeks.push({
        weekStart: wk.weekStart,
        weekStartStr: this.formatDateUs(wk.weekStart),
        days: dayCellsInPeriod,
        weekly: weeklyStateInPeriod,
        status: wk.status,
        reattributedFrom: wk.reattributedFrom || '',
        jhaSummary: `${jhaOnTimeW + jhaLateW}/${jhaOnTimeW + jhaLateW + jhaMissingW}`
      });
    });

    // 7b. Ensure Active & On Hold (and overlapping Completed) Job Tracking rows appear even before first compliance week
    jtByBaseJob.forEach(jt => {
      if (!jt.foreman || jt.status === 'Pending Start') return;
      const overlapsPeriod = (() => {
        if (jt.status === 'Active' || jt.status === 'On Hold') {
          // Always show currently Active or On Hold jobs when viewing current YTD period
          if (period.isYtd) return true;
          const st = jt.startDate;
          return !st || st <= period.end;
        }
        if (jt.status === 'Completed') {
          const st = jt.startDate;
          const en = jt.actualEndDate;
          if (en && en >= period.start && en <= period.end) return true;
          if (st && st >= period.start && st <= period.end) return true;
          if (st && en && st <= period.end && en >= period.start) return true;
        }
        return false;
      })();

      if (overlapsPeriod) {
        ensureForemanJob(jt.foreman, jt.jobNumber);
      }
    });

    // 7c. Attach Monthly Inspection results to attributed foreman/job
    jobMonthEval.forEach(ev => {
      const fm = ev.attributedForeman;
      if (!fm || fm === 'Unassigned') return;
      const acc = ensureForemanJob(fm, ev.baseJob);
      if (!acc) return;

      acc.monthlyDetails.push(ev);
      if (ev.outcome === 'onTime') acc.monthlyOnTime++;
      else if (ev.outcome === 'late') acc.monthlyLate++;
      else if (ev.outcome === 'missing') acc.monthlyMissing++;
      else if (ev.outcome === 'pending') acc.monthlyPending++;
      else if (ev.outcome === 'exempt_short') acc.monthlyExempt++;
    });

    // -----------------------------------------------------------------------
    // 8. Index All 9 Equipment Tables & Swap Pick Lists + 60-Day Expiring Certs
    // -----------------------------------------------------------------------
    const EQUIPMENT_SPECS = [
      { key: 'gloves', swapKey: 'glove_swaps', label: 'Rubber Gloves', shortLabel: 'Gloves', icon: '🧤', idCols: ['Glove', 'Glove #', 'Item #'], specCols: ['Size', 'Class'], dateCols: ['Change Out Date'] },
      { key: 'sleeves', swapKey: 'sleeve_swaps', label: 'Rubber Sleeves', shortLabel: 'Sleeves', icon: '🦾', idCols: ['Sleeve', 'Sleeve #', 'Item #'], specCols: ['Size', 'Class'], dateCols: ['Change Out Date'] },
      { key: 'blankets', swapKey: 'blanket_swaps', label: 'Rubber Blankets', shortLabel: 'Blankets', icon: '🔲', idCols: ['Blanket', 'Blanket #', 'Item #'], specCols: ['Type', 'Class'], dateCols: ['Change Out Date'] },
      { key: 'macks', swapKey: 'mack_swaps', label: 'MACKs', shortLabel: 'MACKs', icon: '🧱', idCols: ['MACK', 'MACK #', 'Item #'], specCols: ['KV', 'Size', 'Length'], dateCols: ['Change Out Date'] },
      { key: 'hv_testers', swapKey: 'hv_tester_swaps', label: 'HV Testers', shortLabel: 'HV Tester', icon: '⚡', idCols: ['HVT #', 'Item #', 'Serial #'], specCols: ['Model', 'KV'], dateCols: ['Change Out Date'] },
      { key: 'phasing_sets', swapKey: 'phasing_set_swaps', label: 'Phasing Sets', shortLabel: 'Phasing Set', icon: '⚡', idCols: ['Phasing Set', 'Phasing Set #', 'Item #'], specCols: ['Model', 'KV'], dateCols: ['Replacement Date', 'Change Out Date'] },
      { key: 'grounds', swapKey: 'ground_swaps', label: 'Grounds', shortLabel: 'Grounds', icon: '🔌', idCols: ['Serial #', 'Ground #', 'Item #'], specCols: ['Type', 'Size', 'Length'], dateCols: ['Change Out Date'] },
      { key: 'hot_sticks', swapKey: 'hot_stick_swaps', label: 'Hot Sticks', shortLabel: 'Hot Stick', icon: '🔴', idCols: ['Item #', 'Serial #'], specCols: ['Type', 'Length'], dateCols: ['Change Out Date'] },
      { key: 'aed', swapKey: 'aed_swaps', label: 'AED Units', shortLabel: 'AED', icon: '🏥', idCols: ['AED', 'AED #', 'Item #', 'Serial #'], specCols: ['Model'], dateCols: ['Pad Expiration', 'Change Out Date'] }
    ];

    const NON_PERSON_HOLDERS = new Set([
      '', 'on shelf', 'in stock', 'shelf', 'storage', 'available', 'unassigned',
      'in testing', 'arnett', 'jm test', 'arnett / jm test', 'lab', 'testing',
      'packed for testing', 'packed for delivery', 'failed rubber', 'failed',
      'not repairable', 'destroyed', 'lost', 'previous employee', 'new',
      'brand new', 'brand new (on shelf)', 'on shelf (new purchase)', 'n/a', 'none', 'unknown'
    ]);

    // Pick-list map: `${equipKey}|${itemNumLower}` -> pickItemNum
    const swapPickMap = new Map();
    EQUIPMENT_SPECS.forEach(spec => {
      const swTbl = this.db ? this.db.getTable(spec.swapKey) : null;
      if (!swTbl || !Array.isArray(swTbl.rows)) return;
      swTbl.rows.forEach(r => {
        const stg = String(r['Status'] || r['Stage'] || '').toLowerCase();
        if (stg.includes('complete') || stg.includes('archived') || stg.includes('swapped')) return;
        const curItem = String(
          r['Current Glove #'] || r['Current Sleeve #'] || r['Current Blanket #'] ||
          r['Current MACK #'] || r['Current HV Tester #'] || r['Current Phasing Set #'] ||
          r['Current AED #'] || r['Current Hot Stick #'] || r['Current Item #'] ||
          r['Serial #'] || r['Item #'] || ''
        ).trim();
        const pickItem = String(
          r['Pick List Glove #'] || r['Pick List Sleeve #'] || r['Pick List Blanket #'] ||
          r['Pick List MACK #'] || r['Pick List HV Tester #'] || r['Pick List Phasing Set #'] ||
          r['Pick List AED #'] || r['Pick List Serial #'] || r['Pick List Item #'] ||
          r['Pick List'] || ''
        ).trim();
        if (curItem && pickItem && pickItem !== '—' && pickItem !== '-') {
          swapPickMap.set(`${spec.key}|${curItem.toLowerCase()}`, pickItem);
        }
      });
    });

    // Equipment map: canonicalEmployeeName -> Array of assigned items
    const equipmentByEmployee = new Map();
    const todayNoon = period.today;

    EQUIPMENT_SPECS.forEach(spec => {
      const tbl = this.db ? this.db.getTable(spec.key) : null;
      if (!tbl || !Array.isArray(tbl.rows)) return;
      tbl.rows.forEach(r => {
        const rawAssigned = String(r['Assigned To'] || '').trim();
        const rawStatus = String(r['Status'] || '').trim().toLowerCase();
        if (!rawAssigned || NON_PERSON_HOLDERS.has(rawAssigned.toLowerCase())) return;
        if (['lost', 'failed rubber', 'failed', 'destroyed', 'on shelf', 'in stock', 'in testing', 'retired'].includes(rawStatus)) return;

        const canonical = this.resolveCanonicalName(rawAssigned, aliasMap);
        if (!canonical || NON_PERSON_HOLDERS.has(canonical.toLowerCase())) return;

        let itemNum = '';
        for (const col of spec.idCols) {
          if (r[col] !== undefined && String(r[col]).trim() !== '') {
            itemNum = String(r[col]).trim();
            break;
          }
        }
        if (!itemNum) return;

        const specParts = [];
        spec.specCols.forEach(col => {
          const val = String(r[col] || '').trim();
          if (val && val !== '—' && val !== 'N/A') {
            if (col === 'Class') specParts.push(`Cl ${val}`);
            else if (col === 'Size') specParts.push(`Sz ${val}`);
            else specParts.push(val);
          }
        });

        let changeOutRaw = '';
        for (const col of spec.dateCols) {
          if (r[col] !== undefined && String(r[col]).trim() !== '') {
            changeOutRaw = r[col];
            break;
          }
        }
        const changeOutDt = this.parseDate(changeOutRaw);
        const diffDays = changeOutDt
          ? Math.round((changeOutDt.getTime() - todayNoon.getTime()) / 86400000)
          : null;

        let urgency = 'current';
        if (diffDays === null) urgency = 'unknown';
        else if (diffDays < 0) urgency = 'overdue';
        else if (diffDays <= 30) urgency = 'due_soon';
        else if (diffDays <= 60) urgency = 'upcoming';

        const pickItem = swapPickMap.get(`${spec.key}|${itemNum.toLowerCase()}`) || null;

        if (!equipmentByEmployee.has(canonical)) equipmentByEmployee.set(canonical, []);
        equipmentByEmployee.get(canonical).push({
          categoryKey: spec.key,
          categoryLabel: spec.label,
          shortLabel: spec.shortLabel,
          icon: spec.icon,
          itemNum,
          specText: specParts.join(' · ') || '—',
          changeOutDate: changeOutDt,
          changeOutStr: changeOutDt ? this.formatDateUs(changeOutDt) : '—',
          diffDays,
          urgency,
          pickItem
        });
      });
    });

    // Expiring Certs (<= 60 days, including expired) by canonical employee
    const certsByEmployee = new Map();
    const certTable = this.db ? this.db.getTable('expiring_certs') : null;
    if (certTable && Array.isArray(certTable.rows)) {
      certTable.rows.forEach(r => {
        const rawEmp = String(r['Employee Name'] || r['Name'] || '').trim();
        const certName = String(r['Item Type'] || r['Cert Type'] || '').trim();
        const expRaw = r['Expiration Date'] || r['Expires'];
        if (!rawEmp || !certName || !expRaw || expRaw === 'N/A' || expRaw === 'No Date Set') return;
        const expDt = this.parseDate(expRaw);
        if (!expDt) return;
        const diffDays = Math.round((expDt.getTime() - todayNoon.getTime()) / 86400000);
        if (diffDays > 60) return;

        const canonical = this.resolveCanonicalName(rawEmp, aliasMap);
        if (!canonical) return;

        if (!certsByEmployee.has(canonical)) certsByEmployee.set(canonical, []);
        certsByEmployee.get(canonical).push({
          employee: canonical,
          cert: certName,
          expirationDate: expDt,
          expirationStr: this.formatDateUs(expDt),
          diffDays,
          isExpired: diffDays < 0,
          isUrgent: diffDays <= 30
        });
      });
    }

    // -----------------------------------------------------------------------
    // 9. Build Final Foreman Packets (Cover + Current State + Sorted Job Cards)
    // -----------------------------------------------------------------------
    const STATUS_SORT = { 'Active': 1, 'On Hold': 2, 'Handed Off': 3, 'Completed': 4, 'Pending Start': 5 };
    const foremen = [];

    foremanJobsMap.forEach((jMap, foremanName) => {
      const empInfo = empByCanonical.get(foremanName);
      const jobs = [];

      jMap.forEach(acc => {
        acc.weeks.sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime()); // newest week first
        acc.monthlyDetails.sort((a, b) => a.monthKey.localeCompare(b.monthKey));

        const jha = this.computeMetricStats(acc.jhaOnTime, acc.jhaLate, acc.jhaMissing, acc.jhaPending);
        const weekly = this.computeMetricStats(acc.weeklyOnTime, acc.weeklyLate, acc.weeklyMissing, acc.weeklyPending);
        const monthly = this.computeMetricStats(acc.monthlyOnTime, acc.monthlyLate, acc.monthlyMissing, acc.monthlyPending, acc.monthlyExempt);

        // Site audits & incidents on this job in period (attributed to this foreman or job when foreman ran it)
        const jobAudits = (auditsByJob.get(acc.jobNumber) || []).filter(a => !a.foreman || a.foreman === foremanName);
        const jobIncidents = (incidentsByJob.get(acc.jobNumber) || []).filter(i => !i.foreman || i.foreman === foremanName);
        jobAudits.sort((a, b) => b.date.getTime() - a.date.getTime());
        jobIncidents.sort((a, b) => b.date.getTime() - a.date.getTime());

        jobs.push({
          ...acc,
          daysWorked: jha.expected, // finalized scheduled workdays (onTime + late + missing)
          weeksWorked: acc.weeks.length,
          jha,
          weekly,
          monthly,
          siteAudits: jobAudits,
          siteAuditCorrections: jobAudits.filter(a => a.hasCorrections).length,
          incidents: jobIncidents
        });
      });

      // Sort jobs: Active -> On Hold -> Handed Off -> Completed (newest work date first within status)
      jobs.sort((a, b) => {
        const sa = STATUS_SORT[a.status] || 9;
        const sb = STATUS_SORT[b.status] || 9;
        if (sa !== sb) return sa - sb;
        const ta = (a.lastWorkDate || a.actualEndDate || a.startDate || new Date(0)).getTime();
        const tb = (b.lastWorkDate || b.actualEndDate || b.startDate || new Date(0)).getTime();
        if (tb !== ta) return tb - ta;
        return a.jobNumber.localeCompare(b.jobNumber, undefined, { numeric: true });
      });

      // Weighted YTD Cover Page Totals across ALL jobs in period
      const totals = {
        daysWorked: 0,
        totalJobs: jobs.length,
        activeJobsCount: 0,
        onHoldJobsCount: 0,
        handedOffJobsCount: 0,
        completedJobsCount: 0,
        jhaOnTime: 0, jhaLate: 0, jhaMissing: 0, jhaPending: 0,
        weeklyOnTime: 0, weeklyLate: 0, weeklyMissing: 0, weeklyPending: 0,
        monthlyOnTime: 0, monthlyLate: 0, monthlyMissing: 0, monthlyPending: 0, monthlyExempt: 0,
        siteAuditsCount: 0,
        siteAuditCorrectionsCount: 0,
        incidentsCount: 0
      };

      jobs.forEach(j => {
        totals.daysWorked += j.daysWorked;
        if (j.status === 'Active') totals.activeJobsCount++;
        else if (j.status === 'On Hold') totals.onHoldJobsCount++;
        else if (j.status === 'Handed Off') totals.handedOffJobsCount++;
        else if (j.status === 'Completed') totals.completedJobsCount++;

        totals.jhaOnTime += j.jha.onTime;
        totals.jhaLate += j.jha.late;
        totals.jhaMissing += j.jha.missing;
        totals.jhaPending += j.jha.pending;

        totals.weeklyOnTime += j.weekly.onTime;
        totals.weeklyLate += j.weekly.late;
        totals.weeklyMissing += j.weekly.missing;
        totals.weeklyPending += j.weekly.pending;

        totals.monthlyOnTime += j.monthly.onTime;
        totals.monthlyLate += j.monthly.late;
        totals.monthlyMissing += j.monthly.missing;
        totals.monthlyPending += j.monthly.pending;
        totals.monthlyExempt += j.monthly.exempt;
      });

      // Deduplicated YTD audits & incidents for Cover Page across this foreman's jobs + direct foreman matches
      const seenAuditKeys = new Set();
      const foremanAudits = [];
      const addAudit = (a) => {
        const k = `${a.dateStr}|${a.jobNumber}|${a.inspector}|${a.summary.slice(0, 40)}`;
        if (!seenAuditKeys.has(k)) {
          seenAuditKeys.add(k);
          foremanAudits.push(a);
        }
      };
      jobs.forEach(j => j.siteAudits.forEach(addAudit));
      (auditsByForeman.get(foremanName) || []).forEach(addAudit);
      totals.siteAuditsCount = foremanAudits.length;
      totals.siteAuditCorrectionsCount = foremanAudits.filter(a => a.hasCorrections).length;

      const seenIncKeys = new Set();
      const foremanIncidents = [];
      const addInc = (inc) => {
        const k = `${inc.dateStr}|${inc.jobNumber}|${inc.type}|${inc.description.slice(0, 40)}`;
        if (!seenIncKeys.has(k)) {
          seenIncKeys.add(k);
          foremanIncidents.push(inc);
        }
      };
      jobs.forEach(j => j.incidents.forEach(addInc));
      (incidentsByForeman.get(foremanName) || []).forEach(addInc);
      totals.incidentsCount = foremanIncidents.length;

      const ytdJha = this.computeMetricStats(totals.jhaOnTime, totals.jhaLate, totals.jhaMissing, totals.jhaPending);
      const ytdWeekly = this.computeMetricStats(totals.weeklyOnTime, totals.weeklyLate, totals.weeklyMissing, totals.weeklyPending);
      const ytdMonthly = this.computeMetricStats(totals.monthlyOnTime, totals.monthlyLate, totals.monthlyMissing, totals.monthlyPending, totals.monthlyExempt);

      // Build Current State (ONLY if foreman currently has >= 1 Active job in Job Tracking)
      const activeJobs = [];
      jtByBaseJob.forEach(jt => {
        if (jt.status === 'Active' && jt.foreman === foremanName) {
          activeJobs.push(jt);
        }
      });
      // Sort active jobs: primary job (from Employees.Job Number) first
      const empPrimaryJob = empInfo ? empInfo.primaryJob : '';
      activeJobs.sort((a, b) => {
        if (a.jobNumber === empPrimaryJob && b.jobNumber !== empPrimaryJob) return -1;
        if (b.jobNumber === empPrimaryJob && a.jobNumber !== empPrimaryJob) return 1;
        return a.jobNumber.localeCompare(b.jobNumber, undefined, { numeric: true });
      });

      let currentState = null;
      if (activeJobs.length > 0) {
        const activeJobSet = new Set(activeJobs.map(a => a.jobNumber));
        const memberJobsMap = new Map(); // canonicalEmpName -> Set(activeJobNumbers)

        // Ensure foreman is included and linked to all their active jobs
        memberJobsMap.set(foremanName, new Set(activeJobs.map(a => a.jobNumber)));

        activeJobs.forEach(aj => {
          const crewSet = activeEmployeesByJob.get(aj.jobNumber);
          if (crewSet) {
            crewSet.forEach(mName => {
              if (!memberJobsMap.has(mName)) memberJobsMap.set(mName, new Set());
              memberJobsMap.get(mName).add(aj.jobNumber);
            });
          }
        });

        const members = [];
        let totalItems = 0, overdueItems = 0, dueSoonItems = 0, currentItems = 0;
        const expiringCerts = [];

        memberJobsMap.forEach((jobSet, mName) => {
          const mEmp = empByCanonical.get(mName);
          const rawItems = equipmentByEmployee.get(mName) || [];
          const sortedItems = [...rawItems].sort((a, b) => {
            const urgOrder = { overdue: 0, due_soon: 1, upcoming: 2, current: 3, unknown: 4 };
            const ua = urgOrder[a.urgency] ?? 9;
            const ub = urgOrder[b.urgency] ?? 9;
            if (ua !== ub) return ua - ub;
            if (a.diffDays !== null && b.diffDays !== null && a.diffDays !== b.diffDays) {
              return a.diffDays - b.diffDays;
            }
            return a.categoryLabel.localeCompare(b.categoryLabel);
          });

          sortedItems.forEach(it => {
            totalItems++;
            if (it.urgency === 'overdue') overdueItems++;
            else if (it.urgency === 'due_soon') dueSoonItems++;
            else currentItems++;
          });

          const mCerts = certsByEmployee.get(mName) || [];
          mCerts.forEach(c => expiringCerts.push({ ...c, jobs: Array.from(jobSet) }));

          members.push({
            name: mName,
            isForeman: mName === foremanName,
            classification: mEmp ? mEmp.classification : (mName === foremanName ? 'F' : ''),
            classRank: mName === foremanName ? 0 : (mEmp ? mEmp.classRank : 50),
            location: mEmp ? mEmp.location : '',
            activeJobs: Array.from(jobSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
            equipment: sortedItems,
            overdueCount: sortedItems.filter(i => i.urgency === 'overdue').length,
            dueSoonCount: sortedItems.filter(i => i.urgency === 'due_soon').length
          });
        });

        members.sort((a, b) => {
          if (a.isForeman !== b.isForeman) return a.isForeman ? -1 : 1;
          if (a.classRank !== b.classRank) return a.classRank - b.classRank;
          return a.name.localeCompare(b.name);
        });

        expiringCerts.sort((a, b) => a.diffDays - b.diffDays || a.employee.localeCompare(b.employee));

        currentState = {
          activeJobs,
          activeJobCount: activeJobs.length,
          members,
          memberCount: members.length,
          equipmentSummary: {
            total: totalItems,
            overdue: overdueItems,
            dueSoon: dueSoonItems,
            current: currentItems
          },
          expiringCerts,
          expiredCertsCount: expiringCerts.filter(c => c.isExpired).length,
          urgentCertsCount: expiringCerts.filter(c => !c.isExpired && c.isUrgent).length
        };
      }

      const onHoldJobNumbers = [];
      jtByBaseJob.forEach(jt => {
        if (jt.status === 'On Hold' && jt.foreman === foremanName) {
          onHoldJobNumbers.push(jt.jobNumber);
        }
      });
      onHoldJobNumbers.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      const homeLocation = (activeJobs[0] && activeJobs[0].location) ||
        (jobs.find(j => j.status === 'On Hold' && j.location)?.location) ||
        (empInfo && empInfo.location) ||
        (jobs.find(j => j.location)?.location) || '—';

      foremen.push({
        name: foremanName,
        location: homeLocation,
        classification: empInfo ? empInfo.classification : 'F',
        hasActiveJob: activeJobs.length > 0,
        activeJobNumbers: activeJobs.map(a => a.jobNumber),
        onHoldJobNumbers,
        jobs,
        totals,
        ytdJha,
        ytdWeekly,
        ytdMonthly,
        currentState
      });
    });

    // Sort Foremen: Active foremen first, then On Hold foremen, then alphabetically
    foremen.sort((a, b) => {
      if (a.hasActiveJob !== b.hasActiveJob) return a.hasActiveJob ? -1 : 1;
      const aHold = a.onHoldJobNumbers.length > 0;
      const bHold = b.onHoldJobNumbers.length > 0;
      if (aHold !== bHold) return aHold ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const model = {
      period,
      availableYears,
      foremen,
      foremenMap: new Map(foremen.map(f => [f.name, f])),
      generatedAt: refDate
    };
    this.cachedModel = model;
    return model;
  }

  // =========================================================================
  // Page List Builder (for Selected Foreman)
  // =========================================================================

  getFilteredJobsForForeman(foremanPacket) {
    if (!foremanPacket) return [];
    return foremanPacket.jobs.filter(j => {
      if (j.status === 'Active') return this.statusFilters['Active'] !== false;
      if (j.status === 'On Hold') return this.statusFilters['On Hold'] !== false;
      if (j.status === 'Completed' || j.status === 'Handed Off') return this.statusFilters['Completed'] !== false;
      return true;
    });
  }

  buildPagesForForeman(foremanPacket) {
    if (!foremanPacket) return [];
    const filteredJobs = this.getFilteredJobsForForeman(foremanPacket);
    const pages = [];

    // Page 1: Foreman Cover Page
    pages.push({
      id: 'cover',
      type: 'cover',
      title: 'Cover Page — YTD Summary',
      shortLabel: 'Cover Page',
      badge: 'YTD Summary'
    });

    // Page 2: Current State (only when foreman has >= 1 Active job AND Active filter is on)
    if (foremanPacket.currentState && this.statusFilters['Active'] !== false) {
      pages.push({
        id: 'current_state',
        type: 'current_state',
        title: `Current State — Active Crew, Equipment & Certs`,
        shortLabel: 'Current State',
        badge: `${foremanPacket.currentState.activeJobCount} Active`
      });
    }

    // Pages 3..N: Individual Job Report Cards
    filteredJobs.forEach(job => {
      pages.push({
        id: `job:${job.jobNumber}`,
        type: 'job',
        jobNumber: job.jobNumber,
        job,
        title: `Job ${job.jobNumber}${job.jobName ? ` — ${job.jobName}` : ''} (${job.status})`,
        shortLabel: `Job ${job.jobNumber}`,
        badge: job.status
      });
    });

    return pages;
  }

  // =========================================================================
  // Permission Helper (Job Tracking Status Editing)
  // =========================================================================

  canEditJobStatus() {
    if (typeof window === 'undefined') return false;
    if (window.currentRoleMode === 'view_only') return false;
    if (window.supabaseSync) {
      if (typeof window.supabaseSync.isAdmin === 'function' && window.supabaseSync.isAdmin()) return true;
      if (typeof window.supabaseSync.canEdit === 'function') {
        return window.supabaseSync.canEdit('sheets-view', 'job_tracking');
      }
    }
    return true;
  }

  // =========================================================================
  // Workspace Rendering & Interactive Toolbar Controls
  // =========================================================================

  renderWorkspace(opts = {}) {
    if (typeof document === 'undefined') return;
    const container = document.getElementById('tailgate-workspace-content');
    if (!container) return;

    const model = opts.reuseCache && this.cachedModel ? this.cachedModel : this.buildDataModel();
    this.periodMode = model.period.mode;
    this.selectedYear = model.period.year;

    // Ensure a valid foreman is selected
    if (!this.selectedForeman || !model.foremenMap.has(this.selectedForeman)) {
      this.selectedForeman = model.foremen.length > 0 ? model.foremen[0].name : '';
      this.currentPageIndex = 0;
    }

    this.syncToolbarControls(model);

    if (model.foremen.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 70px 20px; color: #94a3b8;">
          <div style="font-size: 44px; margin-bottom: 12px;">📋</div>
          <h3 style="font-size: 16px; color: #f8fafc; margin-bottom: 8px;">No Foreman Compliance Data for ${this.escapeHtml(model.period.shortLabel)}</h3>
          <p style="font-size: 13px; max-width: 480px; margin: 0 auto 16px auto;">
            No jobs or safety compliance entries were found for <strong>${this.escapeHtml(model.period.rangeStr)}</strong>.
            Try switching between <strong>Fiscal Year</strong> and <strong>Calendar Year</strong>, or picking another year above.
          </p>
          <button class="btn btn-secondary" onclick="window.foremanReportCardEngine.setPeriodMode('${model.period.mode === 'fiscal' ? 'calendar' : 'fiscal'}')">
            Switch to ${model.period.mode === 'fiscal' ? 'Calendar Year' : 'Fiscal Year'}
          </button>
        </div>
      `;
      return;
    }

    const foreman = model.foremenMap.get(this.selectedForeman);
    const pages = this.buildPagesForForeman(foreman);

    if (!opts.preservePage) {
      if (this.currentPageIndex >= pages.length) this.currentPageIndex = 0;
    } else if (opts.targetPageId) {
      const idx = pages.findIndex(p => p.id === opts.targetPageId);
      this.currentPageIndex = idx >= 0 ? idx : Math.min(this.currentPageIndex, Math.max(0, pages.length - 1));
    } else {
      this.currentPageIndex = Math.max(0, Math.min(this.currentPageIndex, pages.length - 1));
    }

    const activePage = pages[this.currentPageIndex] || pages[0];
    const prevPage = this.currentPageIndex > 0 ? pages[this.currentPageIndex - 1] : null;
    const nextPage = this.currentPageIndex < pages.length - 1 ? pages[this.currentPageIndex + 1] : null;

    // Status filter chips bar + book navigation bar + white-paper page with floating dossier chevrons
    const activeCount = foreman.jobs.filter(j => j.status === 'Active').length;
    const holdCount = foreman.jobs.filter(j => j.status === 'On Hold').length;
    const compCount = foreman.jobs.filter(j => j.status === 'Completed' || j.status === 'Handed Off').length;

    let pageBodyHtml = '';
    if (activePage.type === 'cover') {
      pageBodyHtml = this.renderCoverPageHtml(foreman, model.period, pages, { isPrint: false });
    } else if (activePage.type === 'current_state') {
      pageBodyHtml = this.renderCurrentStatePageHtml(foreman, model.period, { isPrint: false });
    } else {
      pageBodyHtml = this.renderJobReportCardHtml(foreman, activePage.job, model.period, { isPrint: false });
    }

    container.innerHTML = `
      <div class="frc-workspace-shell">
        <!-- Top Book Control Strip (Status Filters + Dossier Paging Bar) -->
        <div class="frc-top-bar">
          <div class="frc-status-chips">
            <span class="frc-bar-label">Jobs:</span>
            <button type="button" class="frc-chip frc-chip-active ${this.statusFilters['Active'] ? 'is-on' : ''}" onclick="window.foremanReportCardEngine.toggleStatusFilter('Active')">
              <span class="frc-dot frc-dot-active"></span> Active (${activeCount})
            </button>
            <button type="button" class="frc-chip frc-chip-hold ${this.statusFilters['On Hold'] ? 'is-on' : ''}" onclick="window.foremanReportCardEngine.toggleStatusFilter('On Hold')">
              <span class="frc-dot frc-dot-hold"></span> On Hold (${holdCount})
            </button>
            <button type="button" class="frc-chip frc-chip-completed ${this.statusFilters['Completed'] ? 'is-on' : ''}" onclick="window.foremanReportCardEngine.toggleStatusFilter('Completed')">
              <span class="frc-dot frc-dot-completed"></span> Completed / Past (${compCount})
            </button>
          </div>

          <div class="dossier-book-nav-container frc-book-nav">
            <button type="button" class="dossier-nav-btn" ${!prevPage ? 'disabled' : ''} onclick="window.foremanReportCardEngine.turnPage(-1)" title="${prevPage ? `Previous: ${this.escapeHtml(prevPage.shortLabel)} (← Arrow)` : 'First page'}">
              <span>◀</span> <span>${prevPage ? this.escapeHtml(prevPage.shortLabel) : 'Prev'}</span>
            </button>

            <div class="frc-page-jump-wrap">
              <select class="frc-page-jump-select" aria-label="Jump to report card page" onchange="window.foremanReportCardEngine.goToPage(parseInt(this.value, 10))">
                ${pages.map((p, idx) => `
                  <option value="${idx}" ${idx === this.currentPageIndex ? 'selected' : ''}>
                    Page ${idx + 1} of ${pages.length} · ${this.escapeHtml(p.shortLabel)}${p.badge ? ` (${this.escapeHtml(p.badge)})` : ''}
                  </option>
                `).join('')}
              </select>
            </div>

            <button type="button" class="dossier-nav-btn" ${!nextPage ? 'disabled' : ''} onclick="window.foremanReportCardEngine.turnPage(1)" title="${nextPage ? `Next: ${this.escapeHtml(nextPage.shortLabel)} (→ Arrow)` : 'Last page'}">
              <span>${nextPage ? this.escapeHtml(nextPage.shortLabel) : 'Next'}</span> <span>▶</span>
            </button>
            <span class="dossier-desktop-hint" style="font-size: 11px; color: #64748b; margin-left: 4px;">
              <span class="dossier-kbd">←</span> <span class="dossier-kbd">→</span>
            </span>
          </div>
        </div>

        <!-- Book Stage with Floating Dossier Chevrons + White Paper Sheet -->
        <div class="frc-book-stage" id="frc-book-stage">
          <button type="button" class="dossier-floating-nav-btn frc-floating-prev" ${!prevPage ? 'disabled' : ''} onclick="window.foremanReportCardEngine.turnPage(-1)" aria-label="Previous page">
            <span class="dossier-chevron">‹</span>
            <span class="dossier-nav-tooltip">${prevPage ? `Prev: ${this.escapeHtml(prevPage.shortLabel)}` : 'Start'}</span>
          </button>

          <div class="frc-paper-sheet" id="frc-paper-sheet">
            <div class="frc-paper-inner">
              ${pageBodyHtml}
            </div>
          </div>

          <button type="button" class="dossier-floating-nav-btn frc-floating-next" ${!nextPage ? 'disabled' : ''} onclick="window.foremanReportCardEngine.turnPage(1)" aria-label="Next page">
            <span class="dossier-chevron">›</span>
            <span class="dossier-nav-tooltip">${nextPage ? `Next: ${this.escapeHtml(nextPage.shortLabel)}` : 'End'}</span>
          </button>
        </div>

        <!-- Bottom Footer Navigation Bar -->
        <div class="frc-bottom-bar">
          <button type="button" class="dossier-nav-btn" ${!prevPage ? 'disabled' : ''} onclick="window.foremanReportCardEngine.turnPage(-1)">
            ◀ Previous${prevPage ? ` (${this.escapeHtml(prevPage.shortLabel)})` : ''}
          </button>
          <div class="frc-bottom-dots">
            ${pages.map((p, idx) => `
              <button type="button" class="frc-page-pill-dot ${idx === this.currentPageIndex ? 'is-current' : ''}" onclick="window.foremanReportCardEngine.goToPage(${idx})" title="${this.escapeHtml(p.title)}">
                ${p.type === 'cover' ? '🏠 Cover' : (p.type === 'current_state' ? '⚡ Current State' : this.escapeHtml(p.jobNumber))}
              </button>
            `).join('')}
          </div>
          <button type="button" class="dossier-nav-btn" ${!nextPage ? 'disabled' : ''} onclick="window.foremanReportCardEngine.turnPage(1)">
            Next${nextPage ? ` (${this.escapeHtml(nextPage.shortLabel)})` : ''} ▶
          </button>
        </div>
      </div>
    `;

    this.bindTouchSwipe();
  }

  syncToolbarControls(model) {
    if (typeof document === 'undefined') return;

    // Foreman select
    const fmSelect = document.getElementById('frc-foreman-select');
    if (fmSelect) {
      fmSelect.innerHTML = model.foremen.map(f => {
        const tag = f.hasActiveJob
          ? `🟢 ${f.activeJobNumbers.join(', ')}`
          : (f.onHoldJobNumbers && f.onHoldJobNumbers.length > 0
              ? `⏸️ ${f.onHoldJobNumbers.join(', ')} (On Hold)`
              : `${f.totals.totalJobs} job${f.totals.totalJobs === 1 ? '' : 's'}`);
        return `<option value="${this.escapeHtml(f.name)}" ${f.name === this.selectedForeman ? 'selected' : ''}>${this.escapeHtml(f.name)} — ${this.escapeHtml(tag)}</option>`;
      }).join('');
    }

    // Period mode buttons
    const btnFiscal = document.getElementById('frc-mode-fiscal');
    const btnCal = document.getElementById('frc-mode-calendar');
    if (btnFiscal) btnFiscal.classList.toggle('is-active', this.periodMode === 'fiscal');
    if (btnCal) btnCal.classList.toggle('is-active', this.periodMode === 'calendar');

    // Year select
    const yrSelect = document.getElementById('frc-year-select');
    if (yrSelect) {
      yrSelect.innerHTML = model.availableYears.map(y => {
        const lbl = this.periodMode === 'fiscal'
          ? `FY${String(y).slice(-2)} (Oct ${y - 1}–Sep ${y})`
          : `CY ${y} (Jan–Dec ${y})`;
        return `<option value="${y}" ${y === this.selectedYear ? 'selected' : ''}>${lbl}</option>`;
      }).join('');
    }

    // Badge
    const badge = document.getElementById('tailgate-badge');
    if (badge) {
      const fm = model.foremenMap.get(this.selectedForeman);
      badge.textContent = fm
        ? `${model.period.shortLabel} · ${fm.totals.totalJobs} Job${fm.totals.totalJobs === 1 ? '' : 's'}`
        : model.period.shortLabel;
    }
  }

  onForemanChange(foremanName) {
    this.selectedForeman = foremanName;
    this.currentPageIndex = 0;
    this.renderWorkspace({ reuseCache: true });
  }

  setPeriodMode(mode) {
    const nextMode = mode === 'calendar' ? 'calendar' : 'fiscal';
    if (nextMode === this.periodMode) return;
    this.periodMode = nextMode;
    const years = this.getAvailableYears(nextMode);
    this.selectedYear = years[0];
    this.currentPageIndex = 0;
    this.cachedModel = null;
    this.renderWorkspace();
  }

  onYearChange(yearVal) {
    const num = parseInt(yearVal, 10);
    if (isNaN(num)) return;
    this.selectedYear = num;
    this.currentPageIndex = 0;
    this.cachedModel = null;
    this.renderWorkspace();
  }

  toggleStatusFilter(statusKey) {
    this.statusFilters[statusKey] = !this.statusFilters[statusKey];
    // Prevent all 3 from being unchecked at once
    if (!this.statusFilters['Active'] && !this.statusFilters['On Hold'] && !this.statusFilters['Completed']) {
      this.statusFilters[statusKey] = true;
      return;
    }
    this.currentPageIndex = 0;
    this.renderWorkspace({ reuseCache: true });
  }

  refresh() {
    this.cachedModel = null;
    this.renderWorkspace({ preservePage: true });
  }

  // =========================================================================
  // Dossier-Style Page Turning, Keyboard & Touch Listeners
  // =========================================================================

  initBookNavigationListeners() {
    if (this._listenersInitialized || typeof window === 'undefined') return;
    this._listenersInitialized = true;

    window.addEventListener('keydown', (e) => {
      if (!this.isWorkspaceVisible()) return;
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
        return;
      }
      // Don't hijack arrows when any modal overlay is open
      if (document.querySelector('#frc-job-status-modal, #job-lifecycle-sheet-modal, .modal-overlay.active')) {
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        this.turnPage(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        this.turnPage(1);
      }
    });
  }

  bindTouchSwipe() {
    const sheet = document.getElementById('frc-paper-sheet');
    if (!sheet || sheet._frcSwipeBound) return;
    sheet._frcSwipeBound = true;

    let startX = 0, startY = 0, startTime = 0, tracking = false;
    sheet.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      if (e.target && e.target.closest('button, input, select, textarea, a')) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Date.now();
      tracking = true;
    }, { passive: true });

    sheet.addEventListener('touchend', (e) => {
      if (!tracking || !e.changedTouches || e.changedTouches.length === 0) return;
      tracking = false;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      const elapsed = Date.now() - startTime;
      if (elapsed < 800 && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        this.turnPage(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
  }

  turnPage(direction) {
    if (this._isAnimatingTurn) return;
    const model = this.cachedModel || this.buildDataModel();
    const foreman = model.foremenMap.get(this.selectedForeman);
    if (!foreman) return;
    const pages = this.buildPagesForForeman(foreman);
    const nextIdx = this.currentPageIndex + direction;

    if (nextIdx < 0) {
      this.showPageToast('Reached Cover Page');
      return;
    }
    if (nextIdx >= pages.length) {
      this.showPageToast('Reached last job report card');
      return;
    }

    this.goToPage(nextIdx, direction);
  }

  goToPage(targetIndex, forcedDirection = null) {
    if (this._isAnimatingTurn) return;
    const model = this.cachedModel || this.buildDataModel();
    const foreman = model.foremenMap.get(this.selectedForeman);
    if (!foreman) return;
    const pages = this.buildPagesForForeman(foreman);
    if (targetIndex < 0 || targetIndex >= pages.length || targetIndex === this.currentPageIndex) return;

    const dir = forcedDirection !== null ? forcedDirection : (targetIndex > this.currentPageIndex ? 1 : -1);
    const sheet = document.getElementById('frc-paper-sheet');
    if (!sheet) {
      this.currentPageIndex = targetIndex;
      this.renderWorkspace({ reuseCache: true, preservePage: true });
      return;
    }

    this._isAnimatingTurn = true;
    const turnClass = dir > 0 ? 'dossier-turn-forward' : 'dossier-turn-backward';
    const enterClass = dir > 0 ? 'dossier-enter-forward' : 'dossier-enter-backward';

    sheet.classList.remove('dossier-turn-forward', 'dossier-turn-backward', 'dossier-enter-forward', 'dossier-enter-backward');
    sheet.classList.add(turnClass);

    setTimeout(() => {
      this.currentPageIndex = targetIndex;
      this.renderWorkspace({ reuseCache: true, preservePage: true });
      const wsContent = document.getElementById('tailgate-workspace-content');
      if (wsContent) wsContent.scrollTop = 0;

      const newSheet = document.getElementById('frc-paper-sheet');
      if (newSheet) {
        newSheet.classList.add(enterClass);
        setTimeout(() => {
          newSheet.classList.remove(enterClass);
          this._isAnimatingTurn = false;
        }, 230);
      } else {
        this._isAnimatingTurn = false;
      }
    }, 125);
  }

  jumpToJobPage(jobNumber) {
    const model = this.cachedModel || this.buildDataModel();
    const foreman = model.foremenMap.get(this.selectedForeman);
    if (!foreman) return;
    const pages = this.buildPagesForForeman(foreman);
    const idx = pages.findIndex(p => p.type === 'job' && p.jobNumber === jobNumber);
    if (idx >= 0) this.goToPage(idx, 1);
  }

  showPageToast(message) {
    const stage = document.getElementById('frc-book-stage');
    if (!stage) return;
    const old = stage.querySelector('.dossier-turn-toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.className = 'dossier-turn-toast';
    toast.textContent = message;
    stage.appendChild(toast);
    setTimeout(() => toast.remove(), 950);
  }

  // =========================================================================
  // Shared HTML Render Helpers (Report Card Metric Cards & Badges)
  // =========================================================================

  renderStatusBadgeHtml(status, currentOwnerForeman = '') {
    const map = {
      'Active': { bg: '#dcfce7', color: '#166534', border: '#86efac', icon: '●' },
      'On Hold': { bg: '#fef3c7', color: '#92400e', border: '#fcd34d', icon: '⏸' },
      'Handed Off': { bg: '#e0e7ff', color: '#3730a3', border: '#a5b4fc', icon: '↪' },
      'Completed': { bg: '#e2e8f0', color: '#334155', border: '#cbd5e1', icon: '✓' },
      'Pending Start': { bg: '#dbeafe', color: '#1e40af', border: '#93c5fd', icon: '◷' }
    };
    const st = map[status] || map['Completed'];
    const label = (status === 'Handed Off' && currentOwnerForeman)
      ? `Handed Off → ${currentOwnerForeman}`
      : status;
    return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;font-size:10.5px;font-weight:800;background:${st.bg};color:${st.color};border:1px solid ${st.border};white-space:nowrap;">${st.icon} ${this.escapeHtml(label)}</span>`;
  }

  renderMetricCardHtml(title, unitSingular, unitPlural, stats, subtitleNote = '') {
    const hasData = stats && stats.expected > 0;
    const unitLabel = stats && stats.expected === 1 ? unitSingular : unitPlural;

    if (!hasData) {
      let emptyReason = `No finalized ${unitPlural} in period`;
      if (stats && stats.exempt > 0 && stats.pending === 0) {
        emptyReason = `Exempt (< 4 consecutive wks)`;
      } else if (stats && stats.pending > 0) {
        emptyReason = `${stats.pending} ${stats.pending === 1 ? unitSingular : unitPlural} in progress (Pending)`;
      }
      return `
        <div style="border:1.5px solid #cbd5e1;border-radius:6px;padding:12px 14px;background:#f8fafc;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
            <div style="font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.4px;color:#0f172a;">${this.escapeHtml(title)}</div>
            <div style="font-size:14px;font-weight:800;color:#64748b;">N/A</div>
          </div>
          <div style="height:10px;border-radius:5px;background:#e2e8f0;margin-bottom:8px;"></div>
          <div style="font-size:11px;color:#475569;font-weight:600;">${this.escapeHtml(emptyReason)}</div>
          ${subtitleNote ? `<div style="font-size:10px;color:#64748b;margin-top:3px;">${this.escapeHtml(subtitleNote)}</div>` : ''}
        </div>
      `;
    }

    const subColor = stats.submittedPct >= 95 ? '#15803d' : (stats.submittedPct >= 80 ? '#b45309' : '#b91c1c');
    const pendingTag = stats.pending > 0 ? ` · ⏳ ${stats.pending} pending` : '';
    const exemptTag = stats.exempt > 0 ? ` · ${stats.exempt} exempt (<4w)` : '';

    return `
      <div style="border:1.5px solid #1e293b;border-radius:6px;padding:12px 14px;background:#ffffff;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
          <div style="font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.4px;color:#0f172a;">${this.escapeHtml(title)}</div>
          <div style="text-align:right;">
            <span style="font-size:17px;font-weight:900;color:${subColor};">${stats.submittedPct}%</span>
            <span style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;margin-left:3px;">Submitted</span>
          </div>
        </div>

        <!-- Mutually Exclusive Stacked Bar (Green / Amber / Red = 100%) -->
        <div style="display:flex;height:11px;border-radius:5px;overflow:hidden;background:#e2e8f0;border:1px solid #94a3b8;margin-bottom:9px;">
          ${stats.onTimePct > 0 ? `<div style="width:${stats.onTimePct}%;background:#16a34a;" title="On-Time: ${stats.onTimePct}%"></div>` : ''}
          ${stats.latePct > 0 ? `<div style="width:${stats.latePct}%;background:#f59e0b;" title="Late: ${stats.latePct}%"></div>` : ''}
          ${stats.missingPct > 0 ? `<div style="width:${stats.missingPct}%;background:#dc2626;" title="Missing: ${stats.missingPct}%"></div>` : ''}
        </div>

        <!-- Mutually Exclusive Percentages Grid -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;text-align:center;margin-bottom:7px;">
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;padding:4px 3px;">
            <div style="font-size:13px;font-weight:900;color:#15803d;">${stats.onTimePct}%</div>
            <div style="font-size:9.5px;font-weight:700;color:#166534;">On-Time (${stats.onTime})</div>
          </div>
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:4px 3px;">
            <div style="font-size:13px;font-weight:900;color:#b45309;">${stats.latePct}%</div>
            <div style="font-size:9.5px;font-weight:700;color:#92400e;">Late (${stats.late})</div>
          </div>
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:4px;padding:4px 3px;">
            <div style="font-size:13px;font-weight:900;color:#b91c1c;">${stats.missingPct}%</div>
            <div style="font-size:9.5px;font-weight:700;color:#991b1b;">Missing (${stats.missing})</div>
          </div>
        </div>

        <div style="font-size:10px;color:#475569;display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;">
          <span><strong>${stats.submitted}/${stats.expected}</strong> ${unitLabel} submitted</span>
          <span>${this.escapeHtml((pendingTag + exemptTag).replace(/^\s*·\s*/, ''))}</span>
        </div>
        ${subtitleNote ? `<div style="font-size:9.5px;color:#64748b;margin-top:3px;">${this.escapeHtml(subtitleNote)}</div>` : ''}
      </div>
    `;
  }

  renderCompactPctCell(stats) {
    if (!stats || stats.expected === 0) {
      if (stats && stats.exempt > 0) return '<span style="color:#64748b;font-size:10px;font-weight:600;">Exempt (&lt;4w)</span>';
      if (stats && stats.pending > 0) return '<span style="color:#64748b;font-size:10px;font-weight:600;">⏳ Pending</span>';
      return '<span style="color:#94a3b8;font-size:10.5px;">—</span>';
    }
    const c = stats.submittedPct >= 95 ? '#15803d' : (stats.submittedPct >= 80 ? '#b45309' : '#b91c1c');
    return `
      <div style="font-weight:800;color:${c};font-size:11.5px;">${stats.onTimePct}% <span style="font-size:9.5px;font-weight:600;color:#64748b;">OT</span></div>
      <div style="font-size:9.5px;color:#475569;">${stats.latePct}%L · ${stats.missingPct}%M</div>
    `;
  }

  // =========================================================================
  // PAGE 1: Foreman Cover Page HTML
  // =========================================================================

  renderCoverPageHtml(foreman, period, pages, { isPrint = false } = {}) {
    const canEdit = !isPrint && this.canEditJobStatus();
    const filteredJobs = this.getFilteredJobsForForeman(foreman);

    // Recompute displayed YTD totals respecting status filters only if subset? No — Cover Page shows true YTD totals for the foreman across the period!
    const t = foreman.totals;
    const hasOnHold = foreman.onHoldJobNumbers && foreman.onHoldJobNumbers.length > 0;
    const activeBadgeStr = foreman.activeJobNumbers.length > 0
      ? `ACTIVE JOB${foreman.activeJobNumbers.length > 1 ? 'S' : ''}: ${foreman.activeJobNumbers.join(', ')}`
      : (hasOnHold
          ? `ON HOLD JOB${foreman.onHoldJobNumbers.length > 1 ? 'S' : ''}: ${foreman.onHoldJobNumbers.join(', ')}`
          : 'NO ACTIVE JOBS');
    const activeBadgeColor = foreman.hasActiveJob ? '#15803d' : (hasOnHold ? '#b45309' : '#64748b');

    const statusMix = [
      t.activeJobsCount > 0 ? `${t.activeJobsCount} Active` : '',
      t.onHoldJobsCount > 0 ? `${t.onHoldJobsCount} On Hold` : '',
      t.handedOffJobsCount > 0 ? `${t.handedOffJobsCount} Handed Off` : '',
      t.completedJobsCount > 0 ? `${t.completedJobsCount} Completed` : ''
    ].filter(Boolean).join(' · ') || '0 Jobs';

    return `
      <!-- Cover Page Header -->
      <div style="border:2px solid #0f172a;padding:14px 18px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:12px;background:#f8fafc;border-radius:4px;">
        <div>
          <div style="font-size:10.5px;font-weight:800;letter-spacing:1.1px;color:#475569;text-transform:uppercase;">
            MOUNTAIN POWER · FOREMAN SAFETY REPORT CARD
          </div>
          <div style="font-size:21px;font-weight:900;color:#0f172a;letter-spacing:-0.4px;margin-top:2px;">
            ${this.escapeHtml(foreman.name)}
          </div>
          <div style="font-size:11.5px;font-weight:700;color:#334155;margin-top:3px;">
            📍 ${this.escapeHtml(foreman.location)} &nbsp;·&nbsp; <span style="color:${activeBadgeColor};">${this.escapeHtml(activeBadgeStr)}</span>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="display:inline-block;background:#0f172a;color:#ffffff;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:800;letter-spacing:0.3px;">
            ${this.escapeHtml(period.shortLabel)} REPORT CARD
          </div>
          <div style="font-size:11px;font-weight:700;color:#334155;margin-top:4px;">
            ${this.escapeHtml(period.displayRangeStr)}
          </div>
          <div style="font-size:9.5px;color:#64748b;margin-top:2px;">
            Generated ${this.escapeHtml(this.formatDateUs(period.today))} · Page 1 (Cover)
          </div>
        </div>
      </div>

      <!-- YTD KPI Summary Strip -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">
        <div style="border:1.5px solid #cbd5e1;border-radius:6px;padding:10px 12px;background:#ffffff;text-align:center;">
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#64748b;">Total Days Worked</div>
          <div style="font-size:22px;font-weight:900;color:#0f172a;margin:2px 0;">${t.daysWorked}</div>
          <div style="font-size:10px;color:#475569;font-weight:600;">Scheduled workdays (${this.escapeHtml(period.shortLabel)})</div>
        </div>
        <div style="border:1.5px solid #cbd5e1;border-radius:6px;padding:10px 12px;background:#ffffff;text-align:center;">
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#64748b;">Jobs Worked</div>
          <div style="font-size:22px;font-weight:900;color:#1d4ed8;margin:2px 0;">${t.totalJobs}</div>
          <div style="font-size:10px;color:#475569;font-weight:600;">${this.escapeHtml(statusMix)}</div>
        </div>
        <div style="border:1.5px solid #cbd5e1;border-radius:6px;padding:10px 12px;background:#ffffff;text-align:center;">
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#64748b;">Site Audits (${this.escapeHtml(period.shortLabel)})</div>
          <div style="font-size:22px;font-weight:900;color:#0369a1;margin:2px 0;">${t.siteAuditsCount}</div>
          <div style="font-size:10px;color:${t.siteAuditCorrectionsCount > 0 ? '#b45309' : '#15803d'};font-weight:700;">
            ${t.siteAuditsCount === 0 ? 'None logged' : (t.siteAuditCorrectionsCount > 0 ? `${t.siteAuditCorrectionsCount} w/ corrections` : 'All clean ✓')}
          </div>
        </div>
        <div style="border:1.5px solid #cbd5e1;border-radius:6px;padding:10px 12px;background:#ffffff;text-align:center;">
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#64748b;">Incident Reports</div>
          <div style="font-size:22px;font-weight:900;color:${t.incidentsCount > 0 ? '#b91c1c' : '#15803d'};margin:2px 0;">${t.incidentsCount}</div>
          <div style="font-size:10px;color:${t.incidentsCount > 0 ? '#b91c1c' : '#15803d'};font-weight:700;">
            ${t.incidentsCount === 0 ? 'Clean record ✓' : `Logged in ${this.escapeHtml(period.shortLabel)}`}
          </div>
        </div>
      </div>

      <!-- Foreman YTD Overall Compliance Report Card -->
      <div style="font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #0f172a;padding-bottom:4px;margin-bottom:10px;color:#0f172a;display:flex;justify-content:space-between;align-items:baseline;">
        <span>1. Foreman Overall Compliance Report Card (${this.escapeHtml(period.shortLabel)} Weighted Totals)</span>
        <span style="font-size:10px;font-weight:600;color:#64748b;text-transform:none;">On-Time % + Late % + Missing % = 100%</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px;">
        ${this.renderMetricCardHtml('Daily JHA Compliance', 'day', 'days', foreman.ytdJha, 'Weighted by scheduled days worked')}
        ${this.renderMetricCardHtml('Weekly Safety Meeting', 'week', 'weeks', foreman.ytdWeekly, 'Weighted by active crew weeks')}
        ${this.renderMetricCardHtml('Monthly Inspection', 'month', 'months', foreman.ytdMonthly, '≥4 consec. wks · On-time thru 7th of next mo')}
      </div>

      <!-- Quick Callout to Page 2 Current State if Active -->
      ${foreman.currentState && !isPrint ? `
        <div style="border:1.5px solid #2563eb;background:#eff6ff;border-radius:6px;padding:9px 14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="font-size:11.5px;color:#1e3a8a;">
            <strong>⚡ Current State Ready (Page 2):</strong>
            ${foreman.currentState.memberCount} crew member${foreman.currentState.memberCount === 1 ? '' : 's'} ·
            ${foreman.currentState.equipmentSummary.total} assigned items
            ${foreman.currentState.equipmentSummary.overdue > 0 ? `(<strong style="color:#b91c1c;">${foreman.currentState.equipmentSummary.overdue} overdue</strong>)` : '(all current)'} ·
            ${foreman.currentState.expiringCerts.length} cert${foreman.currentState.expiringCerts.length === 1 ? '' : 's'} expiring ≤60d
          </div>
          <button type="button" class="frc-inline-btn" onclick="window.foremanReportCardEngine.goToPage(1, 1)">
            Open Current State →
          </button>
        </div>
      ` : ''}

      <!-- Job Report Cards Directory -->
      <div style="font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #0f172a;padding-bottom:4px;margin-bottom:10px;color:#0f172a;display:flex;justify-content:space-between;align-items:baseline;">
        <span>2. Individual Job Report Cards (${filteredJobs.length} Job${filteredJobs.length === 1 ? '' : 's'})</span>
        ${!isPrint ? '<span style="font-size:10px;font-weight:600;color:#2563eb;text-transform:none;">Click any job row to flip to its report card →</span>' : ''}
      </div>

      ${filteredJobs.length === 0 ? `
        <div style="border:1px solid #cbd5e1;border-radius:5px;padding:14px;text-align:center;color:#64748b;font-size:11.5px;background:#f8fafc;">
          No jobs match the selected status filters.
        </div>
      ` : `
        <table style="width:100%;border-collapse:collapse;font-size:11px;color:#0f172a;">
          <thead>
            <tr style="background:#f1f5f9;">
              <th style="border:1px solid #0f172a;padding:6px 7px;text-align:left;font-weight:800;">Job # & Name</th>
              <th style="border:1px solid #0f172a;padding:6px 7px;text-align:center;font-weight:800;">Status</th>
              <th style="border:1px solid #0f172a;padding:6px 7px;text-align:center;font-weight:800;">Days</th>
              <th style="border:1px solid #0f172a;padding:6px 7px;text-align:center;font-weight:800;">JHA</th>
              <th style="border:1px solid #0f172a;padding:6px 7px;text-align:center;font-weight:800;">Weekly</th>
              <th style="border:1px solid #0f172a;padding:6px 7px;text-align:center;font-weight:800;">Monthly</th>
              <th style="border:1px solid #0f172a;padding:6px 7px;text-align:center;font-weight:800;">Audits / Inc</th>
              ${canEdit ? '<th style="border:1px solid #0f172a;padding:6px 7px;text-align:center;font-weight:800;" class="frc-no-print">Manage</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${filteredJobs.map(j => {
              const spanStart = j.firstWorkDate || j.startDate;
              const spanEnd = j.status === 'Active'
                ? null
                : (j.isHandedOff
                    ? j.lastWorkDate
                    : (j.status === 'On Hold' ? (j.lastWorkDate || j.putOnHoldDate) : (j.actualEndDate || j.lastWorkDate)));
              const spanStr = spanStart
                ? `${this.formatDateUs(spanStart)} – ${j.status === 'Active' ? 'Present' : (spanEnd ? this.formatDateUs(spanEnd) : '—')}`
                : '';
              const rowClick = !isPrint ? `onclick="window.foremanReportCardEngine.jumpToJobPage('${this.escapeJs(j.jobNumber)}')"` : '';
              return `
                <tr class="${!isPrint ? 'frc-clickable-row' : ''}" ${rowClick}>
                  <td style="border:1px solid #cbd5e1;padding:6px 8px;">
                    <div style="font-weight:800;color:#1d4ed8;font-size:12px;">${this.escapeHtml(j.jobNumber)}</div>
                    <div style="font-size:10px;color:#334155;font-weight:600;">${this.escapeHtml(j.jobName || j.location || '—')}</div>
                    ${spanStr ? `<div style="font-size:9.5px;color:#64748b;">${this.escapeHtml(spanStr)}</div>` : ''}
                  </td>
                  <td style="border:1px solid #cbd5e1;padding:6px 6px;text-align:center;">
                    ${this.renderStatusBadgeHtml(j.status, j.currentOwnerForeman)}
                  </td>
                  <td style="border:1px solid #cbd5e1;padding:6px 6px;text-align:center;font-weight:800;font-size:12px;">
                    ${j.daysWorked}
                    <div style="font-size:9.5px;font-weight:600;color:#64748b;">${j.weeksWorked} wk${j.weeksWorked === 1 ? '' : 's'}</div>
                  </td>
                  <td style="border:1px solid #cbd5e1;padding:6px 6px;text-align:center;">
                    ${this.renderCompactPctCell(j.jha)}
                  </td>
                  <td style="border:1px solid #cbd5e1;padding:6px 6px;text-align:center;">
                    ${this.renderCompactPctCell(j.weekly)}
                  </td>
                  <td style="border:1px solid #cbd5e1;padding:6px 6px;text-align:center;">
                    ${this.renderCompactPctCell(j.monthly)}
                  </td>
                  <td style="border:1px solid #cbd5e1;padding:6px 6px;text-align:center;font-size:10.5px;font-weight:700;">
                    <span title="Site Audits" style="color:#0369a1;">📋 ${j.siteAudits.length}</span>
                    &nbsp;/&nbsp;
                    <span title="Incident Reports" style="color:${j.incidents.length > 0 ? '#b91c1c' : '#64748b'};">⚠️ ${j.incidents.length}</span>
                  </td>
                  ${canEdit ? `
                    <td style="border:1px solid #cbd5e1;padding:6px 6px;text-align:center;" class="frc-no-print" onclick="event.stopPropagation();">
                      ${j.isHandedOff ? `
                        <span style="font-size:9.5px;font-weight:700;color:#4338ca;" title="Currently owned by ${this.escapeHtml(j.currentOwnerForeman)} (${this.escapeHtml(j.globalJobStatus)})">Owned by ${this.escapeHtml(j.currentOwnerForeman)}</span>
                      ` : `
                        <button type="button" class="frc-edit-status-btn" onclick="window.foremanReportCardEngine.openJobStatusModal('${this.escapeJs(j.jobNumber)}')" title="Change job status (Active / On Hold / Completed)">
                          ✏️ Status
                        </button>
                      `}
                    </td>
                  ` : ''}
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `}

      <div style="margin-top:16px;padding-top:8px;border-top:1px solid #cbd5e1;font-size:9.5px;color:#64748b;display:flex;justify-content:space-between;">
        <span>Mountain Power Safety & Compliance · Foreman Report Card</span>
        <span>${this.escapeHtml(foreman.name)} · ${this.escapeHtml(period.shortLabel)} Cover Page</span>
      </div>
    `;
  }

  // =========================================================================
  // PAGE 2: Current State Page HTML (Active Foremen Only — Deduplicated)
  // =========================================================================

  renderCurrentStatePageHtml(foreman, period, { isPrint = false } = {}) {
    const cs = foreman.currentState;
    if (!cs) {
      return `<div style="padding:24px;text-align:center;color:#64748b;">No active jobs for ${this.escapeHtml(foreman.name)}.</div>`;
    }

    const eqSum = cs.equipmentSummary;
    const renderUrgencyPill = (it) => {
      if (it.urgency === 'overdue') {
        const d = Math.abs(it.diffDays);
        return `<span style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;padding:1px 6px;border-radius:10px;font-size:9.5px;font-weight:800;white-space:nowrap;">OVERDUE (${d}d)</span>`;
      }
      if (it.urgency === 'due_soon') {
        return `<span style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:1px 6px;border-radius:10px;font-size:9.5px;font-weight:800;white-space:nowrap;">Due ${it.diffDays}d</span>`;
      }
      if (it.urgency === 'upcoming') {
        return `<span style="background:#e0f2fe;color:#075985;border:1px solid #7dd3fc;padding:1px 6px;border-radius:10px;font-size:9.5px;font-weight:700;white-space:nowrap;">Due ${it.diffDays}d</span>`;
      }
      if (it.urgency === 'current') {
        return `<span style="background:#dcfce7;color:#166534;border:1px solid #86efac;padding:1px 6px;border-radius:10px;font-size:9.5px;font-weight:700;white-space:nowrap;">Current ✓</span>`;
      }
      return `<span style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:1px 6px;border-radius:10px;font-size:9.5px;font-weight:600;white-space:nowrap;">No Date</span>`;
    };

    return `
      <!-- Header -->
      <div style="border:2px solid #0f172a;padding:12px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;background:#f8fafc;border-radius:4px;">
        <div>
          <div style="font-size:10px;font-weight:800;letter-spacing:1px;color:#15803d;text-transform:uppercase;">
            ⚡ CURRENT STATE · ACTIVE CREW, EQUIPMENT & CERTIFICATIONS
          </div>
          <div style="font-size:18px;font-weight:900;color:#0f172a;margin-top:2px;">
            FOREMAN: ${this.escapeHtml(foreman.name)}
          </div>
          <div style="font-size:11px;font-weight:700;color:#334155;margin-top:3px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <span>Active Job${cs.activeJobs.length > 1 ? 's' : ''}:</span>
            ${cs.activeJobs.map((aj, i) => `
              <span style="background:#dcfce7;color:#166534;border:1px solid #86efac;padding:1px 7px;border-radius:10px;font-size:10.5px;font-weight:800;">
                ${this.escapeHtml(aj.jobNumber)}${aj.jobName ? ` · ${this.escapeHtml(aj.jobName)}` : ''}${cs.activeJobs.length > 1 && i === 0 ? ' (Primary)' : ''}
              </span>
            `).join('')}
          </div>
        </div>
        <div style="text-align:right;font-size:11px;color:#334155;">
          <div style="font-weight:800;color:#0f172a;">As of ${this.escapeHtml(this.formatDateUs(period.today))}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">
            ${cs.memberCount} Crew · ${eqSum.total} Items · ${cs.expiringCerts.length} Certs ≤60d
          </div>
        </div>
      </div>

      ${cs.activeJobs.length > 1 ? `
        <div style="font-size:10.5px;background:#eff6ff;border:1px solid #93c5fd;color:#1e3a8a;border-radius:4px;padding:6px 10px;margin-bottom:12px;">
          <strong>Deduplicated Multi-Job View:</strong> ${this.escapeHtml(foreman.name)} currently leads <strong>${cs.activeJobs.length} active jobs</strong> (${cs.activeJobs.map(a => this.escapeHtml(a.jobNumber)).join(', ')}). Crew members and assigned gear are listed once below with job badges so nothing is duplicated.
        </div>
      ` : ''}

      <!-- Quick Status Strip -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px;">
        <div style="border:1px solid #cbd5e1;border-radius:5px;padding:7px 10px;text-align:center;background:#fff;">
          <div style="font-size:9.5px;font-weight:800;text-transform:uppercase;color:#64748b;">Assigned Equipment</div>
          <div style="font-size:17px;font-weight:900;color:#0f172a;">${eqSum.total}</div>
        </div>
        <div style="border:1px solid ${eqSum.overdue > 0 ? '#fca5a5' : '#86efac'};border-radius:5px;padding:7px 10px;text-align:center;background:${eqSum.overdue > 0 ? '#fef2f2' : '#f0fdf4'};">
          <div style="font-size:9.5px;font-weight:800;text-transform:uppercase;color:${eqSum.overdue > 0 ? '#991b1b' : '#166534'};">Overdue Swaps</div>
          <div style="font-size:17px;font-weight:900;color:${eqSum.overdue > 0 ? '#b91c1c' : '#15803d'};">${eqSum.overdue}</div>
        </div>
        <div style="border:1px solid ${eqSum.dueSoon > 0 ? '#fcd34d' : '#cbd5e1'};border-radius:5px;padding:7px 10px;text-align:center;background:${eqSum.dueSoon > 0 ? '#fffbeb' : '#fff'};">
          <div style="font-size:9.5px;font-weight:800;text-transform:uppercase;color:#92400e;">Due ≤ 30 Days</div>
          <div style="font-size:17px;font-weight:900;color:${eqSum.dueSoon > 0 ? '#b45309' : '#0f172a'};">${eqSum.dueSoon}</div>
        </div>
        <div style="border:1px solid ${cs.expiringCerts.length > 0 ? '#fca5a5' : '#86efac'};border-radius:5px;padding:7px 10px;text-align:center;background:${cs.expiringCerts.length > 0 ? '#fef2f2' : '#f0fdf4'};">
          <div style="font-size:9.5px;font-weight:800;text-transform:uppercase;color:${cs.expiringCerts.length > 0 ? '#991b1b' : '#166534'};">Certs Expiring ≤ 60d</div>
          <div style="font-size:17px;font-weight:900;color:${cs.expiringCerts.length > 0 ? '#b91c1c' : '#15803d'};">${cs.expiringCerts.length}</div>
        </div>
      </div>

      <!-- Section 1: Expiring Certifications (<= 60 Days) -->
      <div style="font-size:11.5px;font-weight:900;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #0f172a;padding-bottom:3px;margin-bottom:8px;color:#0f172a;">
        1. Expiring &amp; Expired Certifications — Next 60 Days (${cs.expiringCerts.length})
      </div>
      ${cs.expiringCerts.length === 0 ? `
        <div style="font-size:11px;padding:7px 10px;border:1px solid #86efac;border-radius:4px;background:#f0fdf4;color:#166534;font-weight:700;margin-bottom:14px;">
          ✓ All active crew certifications are current (> 60 days remaining).
        </div>
      ` : `
        <table style="width:100%;border-collapse:collapse;font-size:10.5px;margin-bottom:14px;color:#0f172a;">
          <thead>
            <tr style="background:#f1f5f9;">
              <th style="border:1px solid #0f172a;padding:5px 7px;text-align:left;font-weight:800;">Crew Member</th>
              <th style="border:1px solid #0f172a;padding:5px 7px;text-align:left;font-weight:800;">Certification</th>
              <th style="border:1px solid #0f172a;padding:5px 7px;text-align:center;font-weight:800;">Expiration</th>
              <th style="border:1px solid #0f172a;padding:5px 7px;text-align:right;font-weight:800;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${cs.expiringCerts.map(c => `
              <tr style="background:${c.isExpired ? '#fef2f2' : (c.isUrgent ? '#fffbeb' : '#ffffff')};">
                <td style="border:1px solid #cbd5e1;padding:4px 7px;font-weight:800;">${this.escapeHtml(c.employee)}</td>
                <td style="border:1px solid #cbd5e1;padding:4px 7px;font-weight:600;">${this.escapeHtml(c.cert)}</td>
                <td style="border:1px solid #cbd5e1;padding:4px 7px;text-align:center;font-weight:700;">${this.escapeHtml(c.expirationStr)}</td>
                <td style="border:1px solid #cbd5e1;padding:4px 7px;text-align:right;font-weight:800;color:${c.isExpired || c.isUrgent ? '#b91c1c' : '#92400e'};">
                  ${c.isExpired ? `EXPIRED (${Math.abs(c.diffDays)}d ago)` : `${c.diffDays} days left`}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}

      <!-- Section 2: Full Assigned Equipment by Crew Member (All 9 Categories) -->
      <div style="font-size:11.5px;font-weight:900;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #0f172a;padding-bottom:3px;margin-bottom:10px;color:#0f172a;">
        2. Assigned PPE &amp; Equipment Inventory — Foreman &amp; Current Crew (${cs.memberCount} Members · ${eqSum.total} Items)
      </div>

      ${cs.members.map(m => `
        <div class="frc-member-block" style="border:1px solid #94a3b8;border-radius:5px;margin-bottom:10px;overflow:hidden;break-inside:avoid;">
          <div style="background:${m.isForeman ? '#0f172a' : '#f1f5f9'};color:${m.isForeman ? '#ffffff' : '#0f172a'};padding:6px 10px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
              <span style="font-weight:900;font-size:11.5px;">${m.isForeman ? '👷 ' : ''}${this.escapeHtml(m.name)}</span>
              ${m.classification ? `<span style="font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:4px;background:${m.isForeman ? 'rgba(255,255,255,0.18)' : '#e2e8f0'};color:${m.isForeman ? '#f8fafc' : '#334155'};">${this.escapeHtml(m.classification)}</span>` : ''}
              ${m.activeJobs.map(jn => `<span style="font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:4px;background:${m.isForeman ? 'rgba(34,197,94,0.28)' : '#dcfce7'};color:${m.isForeman ? '#bbf7d0' : '#166534'};">${this.escapeHtml(jn)}</span>`).join('')}
            </div>
            <div style="font-size:10px;font-weight:700;color:${m.isForeman ? '#cbd5e1' : '#475569'};">
              ${m.equipment.length} item${m.equipment.length === 1 ? '' : 's'}
              ${m.overdueCount > 0 ? ` · <span style="color:${m.isForeman ? '#fca5a5' : '#b91c1c'};font-weight:800;">${m.overdueCount} overdue</span>` : ''}
              ${m.dueSoonCount > 0 ? ` · <span style="color:${m.isForeman ? '#fde68a' : '#b45309'};font-weight:800;">${m.dueSoonCount} due ≤30d</span>` : ''}
            </div>
          </div>

          ${m.equipment.length === 0 ? `
            <div style="padding:6px 10px;font-size:10.5px;color:#64748b;font-style:italic;background:#ffffff;">
              No tracked rubber PPE or test equipment currently assigned.
            </div>
          ` : `
            <table style="width:100%;border-collapse:collapse;font-size:10.5px;color:#0f172a;background:#ffffff;">
              <thead>
                <tr style="background:#f8fafc;">
                  <th style="border-bottom:1px solid #cbd5e1;padding:4px 8px;text-align:left;font-weight:700;color:#475569;width:22%;">Category</th>
                  <th style="border-bottom:1px solid #cbd5e1;padding:4px 8px;text-align:left;font-weight:700;color:#475569;width:16%;">Item #</th>
                  <th style="border-bottom:1px solid #cbd5e1;padding:4px 8px;text-align:left;font-weight:700;color:#475569;width:22%;">Spec / Size</th>
                  <th style="border-bottom:1px solid #cbd5e1;padding:4px 8px;text-align:center;font-weight:700;color:#475569;width:15%;">Change-Out</th>
                  <th style="border-bottom:1px solid #cbd5e1;padding:4px 8px;text-align:right;font-weight:700;color:#475569;width:25%;">Status / Swap Pick</th>
                </tr>
              </thead>
              <tbody>
                ${m.equipment.map(it => `
                  <tr style="background:${it.urgency === 'overdue' ? '#fef2f2' : (it.urgency === 'due_soon' ? '#fffbeb' : '#ffffff')};">
                    <td style="border-top:1px solid #e2e8f0;padding:4px 8px;font-weight:700;">${it.icon} ${this.escapeHtml(it.shortLabel)}</td>
                    <td style="border-top:1px solid #e2e8f0;padding:4px 8px;font-family:monospace;font-weight:800;">${this.escapeHtml(it.itemNum)}</td>
                    <td style="border-top:1px solid #e2e8f0;padding:4px 8px;color:#334155;">${this.escapeHtml(it.specText)}</td>
                    <td style="border-top:1px solid #e2e8f0;padding:4px 8px;text-align:center;font-weight:700;color:${it.urgency === 'overdue' ? '#b91c1c' : '#0f172a'};">${this.escapeHtml(it.changeOutStr)}</td>
                    <td style="border-top:1px solid #e2e8f0;padding:4px 8px;text-align:right;">
                      ${renderUrgencyPill(it)}
                      ${it.pickItem ? `<span style="margin-left:4px;font-size:9.5px;font-weight:700;color:#1d4ed8;">Picked: #${this.escapeHtml(it.pickItem)}</span>` : ''}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
        </div>
      `).join('')}

      <div style="margin-top:14px;padding-top:8px;border-top:1px solid #cbd5e1;font-size:9.5px;color:#64748b;display:flex;justify-content:space-between;">
        <span>Mountain Power Safety &amp; Compliance · Current State (All 9 Equipment Categories + 60-Day Certs)</span>
        <span>${this.escapeHtml(foreman.name)} · As of ${this.escapeHtml(this.formatDateUs(period.today))}</span>
      </div>
    `;
  }

  // =========================================================================
  // PAGES 3..N: Individual Job Report Card HTML
  // =========================================================================

  renderJobReportCardHtml(foreman, job, period, { isPrint = false } = {}) {
    const canEdit = !isPrint && this.canEditJobStatus();
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const dateBadges = [];
    if (job.startDate) dateBadges.push(`Start: ${this.formatDateUs(job.startDate)}`);
    if (job.status === 'On Hold' && job.putOnHoldDate) dateBadges.push(`On Hold: ${this.formatDateUs(job.putOnHoldDate)}`);
    if (job.status === 'On Hold' && job.estimatedReturn) dateBadges.push(`Est. Return: ${this.formatDateUs(job.estimatedReturn)}`);
    if (job.status === 'Completed' && job.actualEndDate) dateBadges.push(`Completed: ${this.formatDateUs(job.actualEndDate)}`);
    if (job.workSchedule) dateBadges.push(`Schedule: ${job.workSchedule}`);

    const renderMonthBadge = (md) => {
      let bg = '#f1f5f9', border = '#cbd5e1', color = '#475569', icon = '—', detail = '';
      if (md.outcome === 'onTime') {
        bg = '#dcfce7'; border = '#86efac'; color = '#166534'; icon = '✅';
        detail = md.receivedDate ? `Rcvd ${this.formatDateUs(md.receivedDate)}` : 'On-Time';
      } else if (md.outcome === 'late') {
        bg = '#fef3c7'; border = '#fcd34d'; color = '#92400e'; icon = '✅L';
        detail = md.receivedDate ? `Late: ${this.formatDateUs(md.receivedDate)} (+${md.daysPastGrace}d)` : 'Late';
      } else if (md.outcome === 'missing') {
        bg = '#fee2e2'; border = '#fca5a5'; color = '#991b1b'; icon = '❌';
        detail = 'Missing';
      } else if (md.outcome === 'pending') {
        bg = '#e0f2fe'; border = '#7dd3fc'; color = '#075985'; icon = '⏳';
        detail = `Due ${this.formatDateUs(md.graceDeadline)}`;
      } else if (md.outcome === 'exempt_short') {
        if (md.submittedAnyway) {
          bg = '#f0fdf4'; border = '#bbf7d0'; color = '#166534'; icon = '✅';
          detail = md.receivedDate
            ? `Rcvd ${this.formatDateUs(md.receivedDate)} (Exempt <4w)`
            : `Submitted (Exempt <4w)`;
        } else {
          bg = '#f8fafc'; border = '#cbd5e1'; color = '#64748b'; icon = '—';
          detail = `Exempt (${md.maxStreak} wk${md.maxStreak === 1 ? '' : 's'} < 4)`;
        }
      } else if (md.outcome === 'skipped') {
        bg = '#f8fafc'; border = '#e2e8f0'; color = '#94a3b8'; icon = 'N/A';
        detail = 'Skipped';
      }
      return `
        <div style="border:1px solid ${border};background:${bg};color:${color};border-radius:5px;padding:5px 8px;min-width:105px;">
          <div style="font-size:11px;font-weight:800;display:flex;justify-content:space-between;gap:6px;">
            <span>${this.escapeHtml(md.monthLabel)}</span>
            <span>${icon}</span>
          </div>
          <div style="font-size:9.5px;font-weight:600;margin-top:2px;">${this.escapeHtml(detail)}</div>
        </div>
      `;
    };

    const renderDayIconCell = (st) => {
      if (st === 'out') return '<span style="color:#cbd5e1;font-size:9px;">·</span>';
      if (st === 'onTime') return '<span style="color:#15803d;font-weight:800;">✅</span>';
      if (st === 'late') return '<span style="color:#b45309;font-weight:900;">✅L</span>';
      if (st === 'missing') return '<span style="color:#b91c1c;font-weight:900;">❌</span>';
      if (st === 'pending') return '<span style="color:#0369a1;">⏳</span>';
      if (st === 'holiday') return '<span title="Holiday">🏖️</span>';
      if (st === 'dnw') return '<span style="color:#64748b;font-size:9px;font-weight:700;">DNW</span>';
      return '<span style="color:#94a3b8;">—</span>';
    };

    return `
      <!-- Job Report Card Header -->
      <div style="border:2px solid #0f172a;padding:12px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;background:#f8fafc;border-radius:4px;">
        <div>
          <div style="font-size:10px;font-weight:800;letter-spacing:1px;color:#475569;text-transform:uppercase;">
            JOB COMPLIANCE REPORT CARD · ${this.escapeHtml(period.shortLabel)}
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:3px;">
            <span style="font-size:20px;font-weight:900;color:#1d4ed8;">JOB ${this.escapeHtml(job.jobNumber)}</span>
            ${this.renderStatusBadgeHtml(job.status, job.currentOwnerForeman)}
            ${canEdit && !job.isHandedOff ? `
              <button type="button" class="frc-edit-status-btn frc-no-print" onclick="window.foremanReportCardEngine.openJobStatusModal('${this.escapeJs(job.jobNumber)}')" title="Update Active / On Hold / Completed status">
                ✏️ Change Status
              </button>
            ` : ''}
          </div>
          <div style="font-size:11.5px;font-weight:700;color:#0f172a;margin-top:3px;">
            ${job.jobName ? `${this.escapeHtml(job.jobName)} · ` : ''}📍 ${this.escapeHtml(job.location || foreman.location)} · Foreman: ${this.escapeHtml(foreman.name)}
          </div>
          ${job.isHandedOff ? `
            <div style="font-size:10px;color:#3730a3;background:#eef2ff;border:1px solid #c7d2fe;border-radius:4px;padding:3px 7px;margin-top:5px;font-weight:700;display:inline-block;">
              ↪ Reassigned to ${this.escapeHtml(job.currentOwnerForeman)} (${this.escapeHtml(job.globalJobStatus)}) · Scored only on ${this.escapeHtml(foreman.name)}'s weeks${job.firstWorkDate && job.lastWorkDate ? ` (${this.formatDateUs(job.firstWorkDate)} – ${this.formatDateUs(job.lastWorkDate)})` : ''}
            </div>
          ` : ''}
          ${dateBadges.length > 0 ? `
            <div style="font-size:10px;color:#475569;margin-top:4px;font-weight:600;">
              ${dateBadges.map(b => this.escapeHtml(b)).join(' &nbsp;|&nbsp; ')}
            </div>
          ` : ''}
        </div>

        <div style="text-align:right;min-width:130px;">
          <div style="background:#0f172a;color:#ffffff;padding:5px 10px;border-radius:5px;display:inline-block;">
            <div style="font-size:18px;font-weight:900;line-height:1.1;">${job.daysWorked}</div>
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#cbd5e1;">Days Worked</div>
          </div>
          <div style="font-size:10px;font-weight:700;color:#475569;margin-top:4px;">
            ${job.weeksWorked} Active Week${job.weeksWorked === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <!-- 3-Column Job Compliance Percentages -->
      <div style="font-size:11.5px;font-weight:900;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #0f172a;padding-bottom:3px;margin-bottom:10px;color:#0f172a;display:flex;justify-content:space-between;">
        <span>1. Compliance Breakdown — Job ${this.escapeHtml(job.jobNumber)}</span>
        <span style="font-size:10px;font-weight:600;color:#64748b;text-transform:none;">On-Time % + Late % + Missing % = 100%</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px;">
        ${this.renderMetricCardHtml('Daily JHA', 'day', 'days', job.jha, `${job.daysWorked} scheduled workday${job.daysWorked === 1 ? '' : 's'}`)}
        ${this.renderMetricCardHtml('Weekly Safety', 'week', 'weeks', job.weekly, `${job.weekly.expected} finalized week${job.weekly.expected === 1 ? '' : 's'}`)}
        ${this.renderMetricCardHtml('Monthly Inspection', 'month', 'months', job.monthly, '≥4 consec. wks · Due by 7th of next mo')}
      </div>

      <!-- Job Site Audits & Incident Reports Strip -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        <div style="border:1px solid #cbd5e1;border-radius:5px;padding:8px 11px;background:#f8fafc;">
          <div style="font-size:10.5px;font-weight:800;color:#0369a1;text-transform:uppercase;display:flex;justify-content:space-between;">
            <span>📋 Site Audits (${this.escapeHtml(period.shortLabel)})</span>
            <span>${job.siteAudits.length}</span>
          </div>
          ${job.siteAudits.length === 0 ? `
            <div style="font-size:10.5px;color:#64748b;margin-top:4px;">No site audits logged on this job in ${this.escapeHtml(period.shortLabel)}.</div>
          ` : `
            <div style="margin-top:5px;display:flex;flex-direction:column;gap:3px;">
              ${job.siteAudits.slice(0, 4).map(a => `
                <div style="font-size:10px;color:#334155;">
                  <strong>${this.escapeHtml(a.dateStr)}</strong>${a.inspector ? ` (${this.escapeHtml(a.inspector)})` : ''} —
                  <span style="font-weight:700;color:${a.hasCorrections ? '#b45309' : '#15803d'};">${a.hasCorrections ? 'Corrections Needed' : 'Clean ✓'}</span>
                </div>
              `).join('')}
              ${job.siteAudits.length > 4 ? `<div style="font-size:9.5px;color:#64748b;">+ ${job.siteAudits.length - 4} more</div>` : ''}
            </div>
          `}
        </div>

        <div style="border:1px solid ${job.incidents.length > 0 ? '#fca5a5' : '#cbd5e1'};border-radius:5px;padding:8px 11px;background:${job.incidents.length > 0 ? '#fef2f2' : '#f8fafc'};">
          <div style="font-size:10.5px;font-weight:800;color:${job.incidents.length > 0 ? '#b91c1c' : '#15803d'};text-transform:uppercase;display:flex;justify-content:space-between;">
            <span>⚠️ Incident Reports (${this.escapeHtml(period.shortLabel)})</span>
            <span>${job.incidents.length}</span>
          </div>
          ${job.incidents.length === 0 ? `
            <div style="font-size:10.5px;color:#166534;font-weight:600;margin-top:4px;">✓ Zero incidents reported on this job.</div>
          ` : `
            <div style="margin-top:5px;display:flex;flex-direction:column;gap:3px;">
              ${job.incidents.slice(0, 4).map(inc => `
                <div style="font-size:10px;color:#7f1d1d;">
                  <strong>${this.escapeHtml(inc.dateStr)}</strong> · <strong>${this.escapeHtml(inc.type)}</strong>${inc.description ? `: ${this.escapeHtml(inc.description.slice(0, 80))}${inc.description.length > 80 ? '…' : ''}` : ''}
                </div>
              `).join('')}
              ${job.incidents.length > 4 ? `<div style="font-size:9.5px;color:#991b1b;">+ ${job.incidents.length - 4} more</div>` : ''}
            </div>
          `}
        </div>
      </div>

      <!-- Monthly Inspection Breakdown Strip -->
      ${job.monthlyDetails.length > 0 ? `
        <div style="font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1.5px solid #0f172a;padding-bottom:3px;margin-bottom:8px;color:#0f172a;">
          2. Monthly Inspection Qualification &amp; Receipt Log
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px;">
          ${job.monthlyDetails.map(md => renderMonthBadge(md)).join('')}
        </div>
      ` : ''}

      <!-- Week-by-Week Compliance History Table -->
      <div style="font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1.5px solid #0f172a;padding-bottom:3px;margin-bottom:8px;color:#0f172a;display:flex;justify-content:space-between;">
        <span>${job.monthlyDetails.length > 0 ? '3' : '2'}. Weekly Compliance Detail (${job.weeks.length} Week${job.weeks.length === 1 ? '' : 's'} in ${this.escapeHtml(period.shortLabel)})</span>
        <span style="font-size:9.5px;font-weight:600;color:#64748b;text-transform:none;">✅ On-Time · ✅L Late · ❌ Missing · ⏳ Pending · 🏖️ Holiday</span>
      </div>

      ${job.weeks.length === 0 ? `
        <div style="border:1px solid #cbd5e1;border-radius:4px;padding:10px;font-size:11px;color:#64748b;background:#f8fafc;">
          No weekly Safety Compliance rows recorded for Job ${this.escapeHtml(job.jobNumber)} in ${this.escapeHtml(period.shortLabel)} yet.
        </div>
      ` : `
        <table style="width:100%;border-collapse:collapse;font-size:10.5px;color:#0f172a;">
          <thead>
            <tr style="background:#f1f5f9;">
              <th style="border:1px solid #0f172a;padding:4px 7px;text-align:left;font-weight:800;">Week Of</th>
              ${DAYS.map(d => `<th style="border:1px solid #0f172a;padding:4px 4px;text-align:center;font-weight:800;width:8%;">${d}</th>`).join('')}
              <th style="border:1px solid #0f172a;padding:4px 6px;text-align:center;font-weight:800;">Weekly Mtg</th>
              <th style="border:1px solid #0f172a;padding:4px 7px;text-align:right;font-weight:800;">JHA Score</th>
            </tr>
          </thead>
          <tbody>
            ${job.weeks.map(w => {
              const hasMiss = DAYS.some(d => w.days[d] === 'missing') || w.weekly === 'missing';
              const hasLate = DAYS.some(d => w.days[d] === 'late') || w.weekly === 'late';
              const rowBg = hasMiss ? '#fef2f2' : (hasLate ? '#fffbeb' : '#ffffff');
              return `
                <tr style="background:${rowBg};">
                  <td style="border:1px solid #cbd5e1;padding:4px 7px;font-weight:700;white-space:nowrap;">
                    ${this.escapeHtml(w.weekStartStr)}
                    ${w.reattributedFrom ? `<span title="Foreman verified via JHA Log (Safety Compliance listed ${this.escapeHtml(w.reattributedFrom)})" style="margin-left:4px;font-size:9px;font-weight:700;background:#e0e7ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:4px;padding:0 4px;">JHA Log</span>` : ''}
                  </td>
                  ${DAYS.map(d => `<td style="border:1px solid #cbd5e1;padding:4px 4px;text-align:center;">${renderDayIconCell(w.days[d])}</td>`).join('')}
                  <td style="border:1px solid #cbd5e1;padding:4px 6px;text-align:center;">${renderDayIconCell(w.weekly)}</td>
                  <td style="border:1px solid #cbd5e1;padding:4px 7px;text-align:right;font-weight:700;color:#334155;">${this.escapeHtml(w.jhaSummary)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `}

      <div style="margin-top:14px;padding-top:8px;border-top:1px solid #cbd5e1;font-size:9.5px;color:#64748b;display:flex;justify-content:space-between;">
        <span>Mountain Power Safety &amp; Compliance · Job ${this.escapeHtml(job.jobNumber)} Report Card</span>
        <span>${this.escapeHtml(foreman.name)} · ${this.escapeHtml(period.shortLabel)}</span>
      </div>
    `;
  }

  // =========================================================================
  // Inline Job Status Editor Modal (Active / On Hold / Completed)
  // =========================================================================

  openJobStatusModal(jobNumber) {
    if (!this.canEditJobStatus()) {
      alert('🔒 You have view-only access to Job Tracking statuses.');
      return;
    }

    const existing = document.getElementById('frc-job-status-modal');
    if (existing) existing.remove();

    const jtTable = this.db ? this.db.getTable('job_tracking') : null;
    const baseJob = this.getBaseJobNumber(jobNumber);
    const jtRow = jtTable && Array.isArray(jtTable.rows)
      ? jtTable.rows.find(r => this.getBaseJobNumber(r['Job Number'] || r['Job #'] || '') === baseJob)
      : null;

    const currentStatus = jtRow ? this.normalizeJobStatus(jtRow['Status']) : 'Completed';
    const jobName = jtRow ? String(jtRow['Job Name'] || '').trim() : '';
    const todayIso = this.formatIsoDate(new Date());
    const holdIso = this.formatIsoDate(this.parseDate(jtRow?.['Put On Hold Date'])) || todayIso;
    const returnIso = this.formatIsoDate(this.parseDate(jtRow?.['Estimated Return'])) || '';
    const endIso = this.formatIsoDate(this.parseDate(jtRow?.['Actual End Date'])) || todayIso;

    const modal = document.createElement('div');
    modal.id = 'frc-job-status-modal';
    modal.className = 'modal-overlay active';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);z-index:10050;display:flex;align-items:center;justify-content:center;padding:20px;';

    modal.innerHTML = `
      <div style="background:var(--bg-card,#1e293b);border:1px solid var(--border-color,#334155);border-radius:10px;width:100%;max-width:480px;box-shadow:0 16px 40px rgba(0,0,0,0.6);overflow:hidden;color:#f8fafc;">
        <div style="padding:14px 18px;background:rgba(15,23,42,0.9);border-bottom:1px solid var(--border-color,#334155);display:flex;justify-content:space-between;align-items:center;">
          <div>
            <h3 style="margin:0;font-size:15px;font-weight:800;">⚙️ Manage Job Status — ${this.escapeHtml(baseJob)}</h3>
            ${jobName ? `<div style="font-size:11.5px;color:#94a3b8;margin-top:2px;">${this.escapeHtml(jobName)}</div>` : ''}
          </div>
          <button type="button" onclick="document.getElementById('frc-job-status-modal').remove()" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;">✕</button>
        </div>

        <div style="padding:18px;display:flex;flex-direction:column;gap:14px;">
          ${!jtRow ? `
            <div style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.4);color:#fde68a;border-radius:6px;padding:10px 12px;font-size:12px;">
              ⚠️ Job <strong>${this.escapeHtml(baseJob)}</strong> exists in historical compliance logs but does not have a row in <strong>Job Tracking</strong>. Saving will create a Job Tracking row for this job.
            </div>
          ` : ''}

          <div>
            <label style="display:block;font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;margin-bottom:8px;">Job Status</label>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
              ${['Active', 'On Hold', 'Completed'].map(st => `
                <label style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 8px;border-radius:6px;border:1.5px solid ${currentStatus === st ? '#3b82f6' : '#334155'};background:${currentStatus === st ? 'rgba(59,130,246,0.18)' : 'rgba(15,23,42,0.5)'};cursor:pointer;font-size:12.5px;font-weight:700;">
                  <input type="radio" name="frc-job-status-radio" value="${st}" ${currentStatus === st ? 'checked' : ''} onchange="window.foremanReportCardEngine.onStatusRadioChange(this.value)">
                  <span>${st === 'Active' ? '🟢' : (st === 'On Hold' ? '⏸️' : '✅')} ${st}</span>
                </label>
              `).join('')}
            </div>
          </div>

          <div id="frc-status-fields-hold" style="display:${currentStatus === 'On Hold' ? 'grid' : 'none'};grid-template-columns:1fr 1fr;gap:10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:6px;padding:12px;">
            <div>
              <label style="display:block;font-size:11px;font-weight:700;color:#fcd34d;margin-bottom:4px;">Put On Hold Date</label>
              <input type="date" id="frc-hold-date" value="${this.escapeHtml(holdIso)}" style="width:100%;padding:6px 8px;border-radius:5px;border:1px solid #475569;background:#0f172a;color:#f8fafc;font-size:12px;">
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;color:#cbd5e1;margin-bottom:4px;">Estimated Return (Optional)</label>
              <input type="date" id="frc-return-date" value="${this.escapeHtml(returnIso)}" style="width:100%;padding:6px 8px;border-radius:5px;border:1px solid #475569;background:#0f172a;color:#f8fafc;font-size:12px;">
            </div>
          </div>

          <div id="frc-status-fields-completed" style="display:${currentStatus === 'Completed' ? 'block' : 'none'};background:rgba(148,163,184,0.1);border:1px solid rgba(148,163,184,0.3);border-radius:6px;padding:12px;">
            <label style="display:block;font-size:11px;font-weight:700;color:#cbd5e1;margin-bottom:4px;">Actual End Date (Completion Date)</label>
            <input type="date" id="frc-end-date" value="${this.escapeHtml(endIso)}" style="width:100%;padding:6px 8px;border-radius:5px;border:1px solid #475569;background:#0f172a;color:#f8fafc;font-size:12px;">
            <div style="font-size:10.5px;color:#94a3b8;margin-top:6px;">
              Post-completion empty compliance rows after this date will automatically be pruned.
            </div>
          </div>

          <div id="frc-status-fields-active" style="display:${currentStatus === 'Active' ? 'block' : 'none'};background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:6px;padding:10px 12px;font-size:11.5px;color:#86efac;">
            Marking as <strong>Active</strong> includes this job in the Foreman's <strong>Current State</strong> page and clears any hold/completion dates.
          </div>

          ${jtRow && typeof window.sheetNavigator?.openJobLifecycleModal === 'function' ? `
            <div style="text-align:left;">
              <button type="button" class="btn btn-secondary" style="font-size:11px;padding:5px 10px;" onclick="document.getElementById('frc-job-status-modal').remove(); window.sheetNavigator.openJobLifecycleModal('${this.escapeJs(baseJob)}');">
                🔧 Full Job Schedule &amp; Skip-Day Settings…
              </button>
            </div>
          ` : ''}
        </div>

        <div style="padding:12px 18px;background:rgba(15,23,42,0.6);border-top:1px solid var(--border-color,#334155);display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" class="btn btn-secondary" onclick="document.getElementById('frc-job-status-modal').remove()">Cancel</button>
          <button type="button" class="btn btn-primary" style="font-weight:700;" onclick="window.foremanReportCardEngine.saveJobStatusModal('${this.escapeJs(baseJob)}')">💾 Save Status</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  onStatusRadioChange(status) {
    const holdEl = document.getElementById('frc-status-fields-hold');
    const compEl = document.getElementById('frc-status-fields-completed');
    const actEl = document.getElementById('frc-status-fields-active');
    if (holdEl) holdEl.style.display = status === 'On Hold' ? 'grid' : 'none';
    if (compEl) compEl.style.display = status === 'Completed' ? 'block' : 'none';
    if (actEl) actEl.style.display = status === 'Active' ? 'block' : 'none';
  }

  async saveJobStatusModal(jobNumber) {
    if (!this.canEditJobStatus()) return;
    const baseJob = this.getBaseJobNumber(jobNumber);
    const selectedRadio = document.querySelector('input[name="frc-job-status-radio"]:checked');
    const targetStatus = selectedRadio ? selectedRadio.value : 'Active';

    const jtTable = this.db ? this.db.getTable('job_tracking') : null;
    if (!jtTable || !Array.isArray(jtTable.rows)) {
      alert('⚠️ Job Tracking table is not loaded.');
      return;
    }

    const todayUs = this.formatDateUs(new Date());
    const toUs = (isoVal) => {
      const dt = this.parseDate(isoVal);
      return dt ? this.formatDateUs(dt) : '';
    };

    const holdUs = targetStatus === 'On Hold' ? (toUs(document.getElementById('frc-hold-date')?.value) || todayUs) : '';
    const returnUs = targetStatus === 'On Hold' ? toUs(document.getElementById('frc-return-date')?.value) : '';
    const endUs = targetStatus === 'Completed' ? (toUs(document.getElementById('frc-end-date')?.value) || todayUs) : '';

    let row = jtTable.rows.find(r => this.getBaseJobNumber(r['Job Number'] || r['Job #'] || '') === baseJob);

    if (row) {
      const updatedFields = {
        'Status': targetStatus,
        'Put On Hold Date': holdUs,
        'Estimated Return': returnUs,
        'Actual End Date': endUs,
        'Last Updated': todayUs
      };
      if (targetStatus === 'Active' && !row['Start Date']) {
        updatedFields['Start Date'] = todayUs;
      }

      Object.assign(row, updatedFields);

      // Sync rawGrid
      if (Array.isArray(jtTable.rawGrid) && Array.isArray(jtTable.headers)) {
        const gIdx = jtTable.rawGrid.findIndex((gr, idx) => idx > 0 && this.getBaseJobNumber(gr[0] || '') === baseJob);
        if (gIdx > 0) {
          jtTable.rawGrid[gIdx] = jtTable.headers.map(h => (row[h] !== undefined ? row[h] : ''));
        }
      }

      if (typeof this.db.addMutation === 'function') {
        await this.db.addMutation({
          action: 'UPDATE_ROW',
          sheetName: jtTable.name || 'Job Tracking',
          tableKey: 'job_tracking',
          itemIdentifier: baseJob,
          row: row._rowIdx || (jtTable.rows.indexOf(row) + 2),
          updatedFields
        });
      }
    } else {
      // Create a new Job Tracking row for historical job
      const newRow = {
        'Job Number': baseJob,
        'Location': '',
        'Foreman': this.selectedForeman || '',
        'Start Date': todayUs,
        'Put On Hold Date': holdUs,
        'Estimated Return': returnUs,
        'Actual End Date': endUs,
        'Status': targetStatus,
        'Last Updated': todayUs
      };
      newRow._rowIdx = (Array.isArray(jtTable.rawGrid) && jtTable.rawGrid.length > 0)
        ? jtTable.rawGrid.length + 1
        : jtTable.rows.length + 2;
      jtTable.rows.push(newRow);
      if (Array.isArray(jtTable.rawGrid) && Array.isArray(jtTable.headers)) {
        jtTable.rawGrid.push(jtTable.headers.map(h => (newRow[h] !== undefined ? newRow[h] : '')));
      }
      if (typeof this.db.addMutation === 'function') {
        await this.db.addMutation({
          action: 'ADD_ROW',
          sheetName: jtTable.name || 'Job Tracking',
          tableKey: 'job_tracking',
          itemIdentifier: baseJob,
          rowData: newRow
        });
      }
    }

    if (targetStatus === 'Completed' && endUs && typeof window !== 'undefined' && window.sheetNavigator && typeof window.sheetNavigator.prunePostCompletionComplianceRows === 'function') {
      try {
        await window.sheetNavigator.prunePostCompletionComplianceRows(baseJob, endUs);
      } catch (e) {
        console.warn('prunePostCompletionComplianceRows warning:', e);
      }
    }

    if (typeof this.db.setSnapshot === 'function') {
      await this.db.setSnapshot(this.db.snapshot);
    }

    const modal = document.getElementById('frc-job-status-modal');
    if (modal) modal.remove();

    this.cachedModel = null;
    this.renderWorkspace({ preservePage: true, targetPageId: `job:${baseJob}` });
    this.showPageToast(`✅ Job ${baseJob} marked ${targetStatus}`);
  }

  // =========================================================================
  // Print & Electron PDF Archival (Current Page | Selected Foreman | All Foremen)
  // =========================================================================

  buildPrintHtml(scope = 'foreman', isPrintAutoTrigger = false) {
    const model = this.cachedModel || this.buildDataModel();
    const pagesHtml = [];

    const appendForemanPages = (fm, onlyPageIndex = null) => {
      const pages = this.buildPagesForForeman(fm);
      const subset = (onlyPageIndex !== null && pages[onlyPageIndex]) ? [pages[onlyPageIndex]] : pages;
      subset.forEach(p => {
        let body = '';
        if (p.type === 'cover') {
          body = this.renderCoverPageHtml(fm, model.period, pages, { isPrint: true });
        } else if (p.type === 'current_state') {
          body = this.renderCurrentStatePageHtml(fm, model.period, { isPrint: true });
        } else {
          body = this.renderJobReportCardHtml(fm, p.job, model.period, { isPrint: true });
        }
        pagesHtml.push(`<div class="frc-print-page">${body}</div>`);
      });
    };

    if (scope === 'all') {
      model.foremen.forEach(fm => appendForemanPages(fm, null));
    } else if (scope === 'current') {
      const fm = model.foremenMap.get(this.selectedForeman);
      if (fm) appendForemanPages(fm, this.currentPageIndex);
    } else {
      const fm = model.foremenMap.get(this.selectedForeman);
      if (fm) appendForemanPages(fm, null);
    }

    const docTitle = scope === 'all'
      ? `Mountain Power — All Foreman Report Cards (${model.period.shortLabel})`
      : `Mountain Power — Foreman Report Card: ${this.selectedForeman} (${model.period.shortLabel})`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${this.escapeHtml(docTitle)}</title>
  <style>
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    @page { size: letter; margin: 0.4in; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 16px;
      color: #0f172a;
      background: #ffffff;
    }
    .frc-print-page {
      page-break-after: always;
      break-after: page;
      padding: 4px 0;
    }
    .frc-print-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .frc-member-block, tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .frc-no-print { display: none !important; }
    @media print {
      body { padding: 0 !important; }
      .frc-print-page { page-break-after: always !important; break-after: page !important; }
      .frc-print-page:last-child { page-break-after: auto !important; break-after: auto !important; }
    }
  </style>
</head>
<body>
  ${pagesHtml.join('\n')}
  ${isPrintAutoTrigger ? '<script>window.onload = function() { window.print(); };</script>' : ''}
</body>
</html>`;
  }

  printPackets(scope = null) {
    const resolvedScope = scope || document.getElementById('frc-print-scope-select')?.value || 'foreman';
    const html = this.buildPrintHtml(resolvedScope, true);
    if (!html.includes('frc-print-page')) {
      alert('⚠️ No pages available to print.');
      return;
    }
    const printWin = window.open('', '_blank', 'width=960,height=840');
    if (!printWin) {
      alert('⚠️ Popup blocked. Please allow popups to print report cards.');
      return;
    }
    printWin.document.open();
    printWin.document.write(html);
    printWin.document.close();
  }

  async savePdfPackets(scope = null) {
    const resolvedScope = scope || document.getElementById('frc-print-scope-select')?.value || 'foreman';
    const model = this.cachedModel || this.buildDataModel();
    const html = this.buildPrintHtml(resolvedScope, false);
    if (!html.includes('frc-print-page')) {
      alert('⚠️ No pages available to archive.');
      return;
    }

    const dateStr = this.formatIsoDate(model.period.today);
    const periodSlug = model.period.shortLabel.replace(/\s+/g, '');
    const fmSlug = (this.selectedForeman || 'Foreman').replace(/[^a-zA-Z0-9_-]+/g, '_');

    let defaultFilename = `Foreman_Report_Card_${fmSlug}_${periodSlug}_${dateStr}.pdf`;
    if (resolvedScope === 'all') {
      defaultFilename = `Foreman_Report_Cards_All_${periodSlug}_${dateStr}.pdf`;
    } else if (resolvedScope === 'current') {
      const fm = model.foremenMap.get(this.selectedForeman);
      const pages = fm ? this.buildPagesForForeman(fm) : [];
      const curPage = pages[this.currentPageIndex];
      const pSlug = (curPage ? curPage.shortLabel : 'Page').replace(/[^a-zA-Z0-9_-]+/g, '_');
      defaultFilename = `Foreman_Report_Card_${fmSlug}_${pSlug}_${periodSlug}_${dateStr}.pdf`;
    }

    if (typeof window !== 'undefined' && window.desktopAPI && typeof window.desktopAPI.saveHtmlToPdf === 'function') {
      try {
        const res = await window.desktopAPI.saveHtmlToPdf(html, defaultFilename);
        if (res.canceled) return;
        if (res.success) {
          alert(`✅ Foreman Report Card PDF saved successfully!\n\nSaved to: ${res.filePath}`);
        } else {
          alert(`⚠️ PDF Save failed: ${res.error || 'Unknown error'}`);
        }
      } catch (err) {
        alert('⚠️ PDF Save error: ' + err.message);
      }
    } else {
      this.printPackets(resolvedScope);
    }
  }
}

if (typeof window !== 'undefined') {
  window.ForemanReportCardEngine = ForemanReportCardEngine;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ForemanReportCardEngine };
}
