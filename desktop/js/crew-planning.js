/**
 * crew-planning.js - Multi-Week Crew Structure Planning & Historical Roster Archive
 * 
 * Features:
 * - Multi-week lookahead planning (Next Week, +2 Weeks, +3 Weeks)
 * - Collapsible Staging Side Pane (Planning Pool, Scheduled Vacation, Quit/Notice, Weeds, Light Duty, Pending Hires)
 * - Two-way Drag & Drop between Crew Cards and Side Pane sections (with Alt/Ctrl+Drag duplicate support)
 * - Employee duplication (allowing members to exist in multiple locations until planning is finalized)
 * - Dynamic conditional styling:
 *     • Purple: Moved from original crew/position or present in multiple locations
 *     • Reverts to normal if returned to original position (and single location)
 *     • Yellow: Confirmed new position(s) by the planner
 * - Gated Publishing with dedicated Purple Unconfirmed popup blocker
 * - Yellow conditional styling persistence on live crew cards after publish
 * - Historical weekly roster snapshot archive & past week reference view
 * - Automated import of all date tabs from historical Excel workbooks into the archive
 */

class CrewPlanningEngine {
  constructor(db) {
    this._db = db;
    this.selectedWeek = null; // e.g. "11/08/2026"
    this.isSidebarCollapsed = false;
    this.searchTerm = '';
    this.activeSidePaneFilter = 'all';
    this.cachedPlans = null;
    this.cachedHistory = null;
    this.editingNotesJob = null;
    this.editingNotesDraft = '';
    
    try {
      this.isSidebarCollapsed = localStorage.getItem('safety_assistant_planning_sidebar_collapsed') === 'true';
    } catch {
      this.isSidebarCollapsed = false;
    }

    window.crewPlanningEngine = this;
  }

  get db() {
    return this._db || window.localDB || window.db;
  }

  set db(val) {
    this._db = val;
  }

  // ==========================================================================
  // Date Helpers (Sunday Anchor, matching Safety Compliance)
  // ==========================================================================

  getSundayOfDate(d = new Date()) {
    const copy = new Date(d);
    if (isNaN(copy.getTime())) return new Date();
    const day = copy.getDay(); // 0 is Sunday
    copy.setDate(copy.getDate() - day);
    copy.setHours(12, 0, 0, 0);
    return copy;
  }

  formatDate(d) {
    if (!d || isNaN(d.getTime())) return '';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const y = d.getFullYear();
    return `${m}/${day}/${y}`;
  }

  formatIso(d) {
    if (!d || isNaN(d.getTime())) return '';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const y = d.getFullYear();
    return `${y}-${m}-${day}`;
  }

  parseDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    const parts = s.split(/[-/]/);
    if (parts.length === 3) {
      let y, m, d;
      if (parts[0].length === 4) {
        y = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10) - 1;
        d = parseInt(parts[2], 10);
      } else {
        m = parseInt(parts[0], 10) - 1;
        d = parseInt(parts[1], 10);
        y = parseInt(parts[2], 10);
        if (y < 100) y += 2000;
      }
      const dt = new Date(y, m, d, 12, 0, 0);
      return isNaN(dt.getTime()) ? null : dt;
    }
    const parsed = new Date(s);
    if (isNaN(parsed.getTime())) return null;
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12, 0, 0);
  }

  getCurrentWeekSundayStr() {
    return this.formatDate(this.getSundayOfDate(new Date()));
  }

  isWeekPublished(weekStr) {
    if (!weekStr) return false;
    const plans = this.getPlansMap();
    const hist = this.getHistoryMap();
    return Boolean(
      (plans[weekStr] && plans[weekStr].status === 'published') ||
      (hist[weekStr] && hist[weekStr].publishedAt)
    );
  }

  getDefaultPlanningWeekStr() {
    const currentWeekStr = this.getCurrentWeekSundayStr();
    if (!this.isWeekPublished(currentWeekStr)) {
      return currentWeekStr;
    }
    const pWeeks = this.getPlanningWeeks();
    return pWeeks.length > 0 ? pWeeks[0].weekStr : currentWeekStr;
  }

  selectPlanningWeek(weekStr) {
    if (!weekStr) return;
    if (this.selectedWeek !== weekStr) {
      this._lastSavedMainY = 0;
      this._lastSavedMainX = 0;
      this._lastSavedSideY = 0;
    }
    this.selectedWeek = weekStr;
    if (window.sheetNavigator) {
      window.sheetNavigator.selectedEmployeeWeek = weekStr;
      window.sheetNavigator.employeeViewMode = 'planning';
      window.sheetNavigator.updateEmployeeViewToggleUI();
      window.sheetNavigator.updateEmployeeWeekNavUI();
      window.sheetNavigator.renderCurrentSheet();
    } else {
      this.refreshView();
    }
  }

  getPlanningWeeks() {
    const currentSunday = this.getSundayOfDate(new Date());
    const weeks = [];
    for (let i = 1; i <= 3; i++) {
      const dt = new Date(currentSunday.getTime() + (i * 7 * 86400000));
      weeks.push({
        weekStr: this.formatDate(dt),
        label: i === 1 ? 'Planning +1 (Next Week)' : `Planning +${i} (${i} Weeks Out)`,
        dateObj: dt,
        offset: i
      });
    }
    return weeks;
  }

  getAllHistoricalWeeks() {
    const historyMap = this.getHistoryMap();
    const weekSet = new Set();

    const addNormalizedWeek = (raw) => {
      const s = String(raw || '').trim();
      if (!s) return;
      const dt = this.parseDate(s);
      if (dt) {
        weekSet.add(this.formatDate(dt));
      } else {
        weekSet.add(s);
      }
    };

    Object.keys(historyMap).forEach(addNormalizedWeek);

    // Also collect weeks from safety_compliance table
    const scTable = this.db ? this.db.getTable('safety_compliance') : null;
    if (scTable && scTable.rows) {
      scTable.rows.forEach(r => {
        const w = String(r['Week Start'] || r['Week'] || '').trim();
        if (w) addNormalizedWeek(w);
      });
    }

    const currentWeekStr = this.getCurrentWeekSundayStr();
    const currentWeekDt = this.parseDate(currentWeekStr);

    const sorted = Array.from(weekSet).filter(w => {
      const dt = this.parseDate(w);
      // Historical weeks are strictly prior to the current week
      return dt && currentWeekDt && dt.getTime() < currentWeekDt.getTime();
    }).sort((a, b) => {
      const da = this.parseDate(a)?.getTime() || 0;
      const db = this.parseDate(b)?.getTime() || 0;
      return db - da;
    });

    return sorted;
  }

  getAllNavigableWeeks() {
    const planning = this.getPlanningWeeks().map(p => ({
      weekStr: p.weekStr,
      label: p.offset === 1 ? `Week of ${p.weekStr} (Next Wk)` : `Week of ${p.weekStr} (+${p.offset} Wks)`,
      type: 'planning',
      offset: p.offset
    })).reverse(); // Farther out first, Next Week closest to Current

    const currentStr = this.getCurrentWeekSundayStr();
    const isCurPub = this.isWeekPublished(currentStr);
    const current = [{
      weekStr: currentStr,
      label: isCurPub ? `Week of ${currentStr} (Current Wk — Live)` : `Week of ${currentStr} (Current Wk — Unpublished)`,
      type: 'current',
      offset: 0
    }];

    const historical = this.getAllHistoricalWeeks().map(w => ({
      weekStr: w,
      label: `Week of ${w}`,
      type: 'historical',
      offset: -1
    }));

    return [...planning, ...current, ...historical];
  }

  // ==========================================================================
  // Baseline Original Position & Status Tracking (Purple / Yellow / Normal)
  // ==========================================================================

  /**
   * Checks if a string represents an equipment status / non-employee value
   * (e.g. "In Testing", "Packed for Testing", "Not Repairable", "On Shelf", "Failed Rubber", "Lost").
   */
  isNonEmployeeName(name) {
    if (!name) return true;
    const str = String(name).trim().toLowerCase();
    if (!str || str === 'n/a' || str === 'none' || str === 'unknown' || str === 'null' || str === 'undefined' || str === '-' || str === '—') {
      return true;
    }

    const nonEmpList = [
      'lost',
      'on shelf',
      'not repairable',
      'in testing',
      'packed for testing',
      'packed for delivery',
      'ready for test',
      'ready for testing',
      'ready for delivery',
      'destroyed',
      'failed rubber',
      'reclaimed',
      'previous employee',
      'unassigned',
      'blank',
      'spare',
      'storage',
      'shop stock',
      'in stock',
      'damaged',
      'scrapped',
      'retired',
      'missing',
      'out for repair',
      'calibration',
      'sent to lab',
      'lab testing',
      'testing'
    ];

    if (nonEmpList.includes(str)) return true;
    if (nonEmpList.some(item => str === item || str.startsWith(item + ' ') || str.endsWith(' ' + item))) return true;

    return false;
  }

  /**
   * Parses a recorded Last Day / Rehire / Hire date string into a local-noon Date object, or null if invalid.
   */
  parseFlexibleDate(dateStr) {
    if (!dateStr) return null;
    const raw = String(dateStr).trim();
    const tokenMatch = raw.match(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/);
    const dt = this.parseDate(tokenMatch ? tokenMatch[0] : raw);
    if (!dt || isNaN(dt.getTime())) return null;
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 12, 0, 0, 0);
  }

  /**
   * Returns true if the given date string represents a calendar day strictly prior to today.
   */
  isDateStrictlyBeforeToday(dateStr, now = new Date()) {
    const dayNoon = this.parseFlexibleDate(dateStr);
    if (!dayNoon) return false;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    return dayNoon.getTime() < todayStart.getTime();
  }

  /**
   * Returns true if the given hire date string represents a calendar day strictly after today.
   */
  isFutureHireDate(dateStr, now = new Date()) {
    const dayNoon = this.parseFlexibleDate(dateStr);
    if (!dayNoon) return false;
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return dayNoon.getTime() > todayEnd.getTime();
  }

  /**
   * Canonical classification priority (lower = higher rank).
   * Matches SUP(1) > GF(2) > F(3) > GTO F(4) > JL/JRY(5) > ...
   */
  getRolePriority(role) {
    if (typeof window !== 'undefined') {
      if (window.sheetNavigator && typeof window.sheetNavigator.getRolePriority === 'function') {
        return window.sheetNavigator.getRolePriority(role);
      }
      if (window.crewImportEngine && typeof window.crewImportEngine.getRolePriority === 'function') {
        return window.crewImportEngine.getRolePriority(role);
      }
    }
    const r = String(role || '').toUpperCase().trim();
    const map = {
      'SUP': 1, 'SUPERINTENDENT': 1,
      'GF': 2, 'GENERAL FOREMAN': 2,
      'F': 3, 'FOREMAN': 3,
      'GTO F': 4, 'GTO FOREMAN': 4,
      'JL': 5, 'JRY': 5, 'JOURNEYMAN': 5, 'JOURNEYMAN LINEMAN': 5,
      'JRY OP': 6, 'JOURNEYMAN OPERATOR': 6,
      'WT': 7, 'WORKING TECH': 7, 'WORKING TECHNICIAN': 7,
      'GTO': 8, 'GAS TECH OPERATOR': 8,
      'EO 1': 9, 'EO1': 9, 'EQUIPMENT OPERATOR 1': 9,
      'EO 2': 10, 'EO2': 10, 'EQUIPMENT OPERATOR 2': 10,
      'AP 7': 11, 'AP 6': 12, 'AP 5': 13, 'AP 4': 14, 'AP 3': 15, 'AP 2': 16, 'AP 1': 17
    };
    return map[r] !== undefined ? map[r] : 999;
  }

  /**
   * Returns true if a classification/role is a supervisory / foreman rank (SUP, GF, F, GTO F, Lead).
   */
  isLeadClassification(roleOrClass) {
    const pri = this.getRolePriority(roleOrClass);
    if (pri <= 4) return true;
    const raw = String(roleOrClass || '').trim().toUpperCase();
    return /\b(FOREMAN|GENERAL FOREMAN|SUPERINTENDENT|GTO F|SUP|GF|LEAD)\b/.test(raw);
  }

  /**
   * Picks the highest-ranking crew member to act as foreman from a list of members.
   */
  pickBestForeman(members = []) {
    if (!Array.isArray(members) || members.length === 0) return '';
    let best = null;
    let bestPri = Infinity;
    for (const m of members) {
      if (!m || !m.name) continue;
      const p = this.getRolePriority(m.classification || m.role);
      if (p < bestPri) {
        bestPri = p;
        best = m;
      }
    }
    return (best || members[0])?.name || '';
  }

  invalidateEmpLookupCache() {
    this._empLookupTickCache = null;
  }

  _getEmpLookup() {
    if (this._empLookupTickCache) return this._empLookupTickCache;
    const empTable = this.db ? this.db.getTable('employees') : null;
    const empRows = (empTable && Array.isArray(empTable.rows)) ? empTable.rows : [];
    const prevTable = this.db ? this.db.getTable('previous_employees') : null;
    const prevRows = (prevTable && Array.isArray(prevTable.rows)) ? prevTable.rows : [];

    const byName = new Map();
    for (const r of empRows) {
      const n = String(r['Employee Name'] || r['Name'] || Object.values(r)[0] || '').trim().toLowerCase();
      if (n && !byName.has(n)) byName.set(n, r);
    }
    const prevNames = new Set();
    for (const p of prevRows) {
      const pn = String(p['Employee Name'] || p['Name'] || Object.values(p)[0] || '').trim().toLowerCase();
      if (pn) prevNames.add(pn);
    }
    if (typeof window !== 'undefined' && window.sheetNavigator && typeof window.sheetNavigator.getPreviousEmployeeNamesSet === 'function') {
      const navPrev = window.sheetNavigator.getPreviousEmployeeNamesSet();
      if (navPrev) navPrev.forEach(pn => prevNames.add(pn));
    }

    const cache = { byName, prevNames };
    this._empLookupTickCache = cache;
    Promise.resolve().then(() => {
      if (this._empLookupTickCache === cache) {
        this._empLookupTickCache = null;
      }
    });
    return cache;
  }

  /**
   * Returns true if an employee is already marked Previous Employee / Inactive / Terminated
   * or has a recorded Last Day that has strictly passed (accounting for subsequent rehires).
   */
  isEmployeeDepartedOrPrevious(empName, extraLastDayStr = null, empRow = null) {
    const normName = String(empName || '').trim().toLowerCase();
    if (!normName || this.isNonEmployeeName(normName)) return false;

    const lookup = this._getEmpLookup();
    const liveRow = empRow || lookup.byName.get(normName) || null;

    if (liveRow) {
      const locLower = String(liveRow['Location'] || '').trim().toLowerCase();
      const statLower = String(liveRow['Status'] || '').trim().toLowerCase();
      const jobLower = String(liveRow['Job Number'] || liveRow['Job #'] || '').trim().toLowerCase();
      if (locLower.includes('previous') || statLower.includes('previous') || statLower === 'inactive' || statLower.includes('terminated') || jobLower.includes('previous')) {
        return true;
      }

      const rehireDt = this.parseFlexibleDate(liveRow['Rehire Date'] || liveRow['Hire Date']);
      const rowLastDayStr = String(liveRow['Last Day'] || '').trim();
      if (rowLastDayStr && this.isDateStrictlyBeforeToday(rowLastDayStr)) {
        const rowLastDt = this.parseFlexibleDate(rowLastDayStr);
        if (!rehireDt || !rowLastDt || rehireDt.getTime() <= rowLastDt.getTime()) {
          return true;
        }
      }
    }

    if (extraLastDayStr && this.isDateStrictlyBeforeToday(extraLastDayStr)) {
      const extraDt = this.parseFlexibleDate(extraLastDayStr);
      const rehireDt = liveRow ? this.parseFlexibleDate(liveRow['Rehire Date'] || liveRow['Hire Date']) : null;
      if (!rehireDt || !extraDt || rehireDt.getTime() <= extraDt.getTime()) {
        return true;
      }
    }

    // Check previous_employees table directly (and live sheetNavigator helper if loaded)
    if (!liveRow && lookup.prevNames.has(normName)) {
      return true;
    }

    return false;
  }

  /**
   * Removes departed employees (Previous Employee or passed Last Day) from all crews,
   * side pane buckets, and confirmation highlights of a planning draft/week.
   */
  purgeDepartedAndPreviousEmployees(plan) {
    const purgedNames = new Set();
    const passedDatesByNorm = new Map();
    if (!plan) return { changed: false, purgedNames };

    const sideKeys = ['planning', 'vacation', 'quit', 'weeds', 'lightDuty', 'pendingHires'];
    if (plan.sidePane) {
      sideKeys.forEach(cat => {
        (plan.sidePane[cat] || []).forEach(item => {
          if (!item || !item.name) return;
          const dateCandidate = item.departureDate || (cat === 'quit' ? item.dateRange : null);
          if (this.isEmployeeDepartedOrPrevious(item.name, dateCandidate)) {
            const norm = String(item.name).trim().toLowerCase();
            purgedNames.add(norm);
            if (item.departureDate && !passedDatesByNorm.has(norm)) {
              passedDatesByNorm.set(norm, { date: item.departureDate, reason: item.departureReason || 'Quit' });
            }
          }
        });
      });
    }

    (plan.crews || []).forEach(crew => {
      (crew.members || []).forEach(m => {
        if (!m || !m.name) return;
        if (this.isEmployeeDepartedOrPrevious(m.name, m.departureDate)) {
          const norm = String(m.name).trim().toLowerCase();
          purgedNames.add(norm);
          if (m.departureDate && !passedDatesByNorm.has(norm)) {
            passedDatesByNorm.set(norm, { date: m.departureDate, reason: m.departureReason || 'Quit' });
          }
        }
      });
    });

    if (purgedNames.size === 0) {
      return { changed: false, purgedNames };
    }

    // Only stamp passed Last Day in-memory on live employee rows from PUBLISHED plans (never mutate live rows from drafts)
    const empTable = (plan.status === 'published' && this.db) ? this.db.getTable('employees') : null;
    if (empTable && Array.isArray(empTable.rows) && passedDatesByNorm.size > 0) {
      empTable.rows.forEach(r => {
        const rn = String(r['Employee Name'] || r['Name'] || Object.values(r)[0] || '').trim().toLowerCase();
        const passedInfo = passedDatesByNorm.get(rn);
        if (passedInfo && !r['Last Day']) {
          r['Last Day'] = passedInfo.date;
          if (!r['Last Day Reason'] && passedInfo.reason) {
            r['Last Day Reason'] = passedInfo.reason;
          }
        }
      });
    }

    let changed = false;

    if (plan.sidePane) {
      sideKeys.forEach(cat => {
        if (Array.isArray(plan.sidePane[cat])) {
          const before = plan.sidePane[cat].length;
          plan.sidePane[cat] = plan.sidePane[cat].filter(item => {
            const n = String(item?.name || '').trim().toLowerCase();
            return n && !purgedNames.has(n);
          });
          if (plan.sidePane[cat].length !== before) changed = true;
        }
      });
    }

    (plan.crews || []).forEach(crew => {
      if (Array.isArray(crew.members)) {
        const before = crew.members.length;
        crew.members = crew.members.filter(m => {
          const n = String(m?.name || '').trim().toLowerCase();
          return n && !purgedNames.has(n);
        });
        if (crew.members.length !== before) {
          changed = true;
          crew.members.forEach((m, idx) => {
            m.slot = `${crew.jobNumber}.${idx + 1}`;
          });
        }
      }
      if (crew.foreman) {
        const fNorm = String(crew.foreman).trim().toLowerCase();
        const stillInCrew = Array.isArray(crew.members) && crew.members.some(m => String(m?.name || '').trim().toLowerCase() === fNorm);
        if (purgedNames.has(fNorm) && !stillInCrew) {
          crew.foreman = '';
          changed = true;
        }
      }
    });

    if (plan.confirmedPositions && typeof plan.confirmedPositions === 'object') {
      Object.keys(plan.confirmedPositions).forEach(k => {
        const baseKey = k.includes('::') ? k.split('::')[0] : k;
        if (purgedNames.has(baseKey.toLowerCase())) {
          delete plan.confirmedPositions[k];
          changed = true;
        }
      });
    }

    return { changed, purgedNames };
  }

  /**
   * Purges departed and previous employees from all non-published planning drafts in the plan map.
   */
  purgeDepartedAcrossAllDraftPlans() {
    const allPlans = this.getPlansMap();
    let anyChanged = false;
    Object.values(allPlans).forEach(p => {
      if (!p || p.status === 'published') return;
      if (this.purgeDepartedAndPreviousEmployees(p).changed) {
        anyChanged = true;
      }
    });
    if (anyChanged) {
      this.savePlansMap(allPlans);
    }
    return anyChanged;
  }

  /**
   * Resolves the company discipline / crew type for a given job.
   * Standard company disciplines: Electric, Substation, Gas, Office, Mechanic (plus Civil, Telecom).
   */
  detectCrewType(jobNum = '', jobName = '', loc = '', explicitType = '') {
    const t = String(explicitType || '').trim();
    const jn = String(jobNum || '').trim();
    const jnLower = String(jobName || '').toLowerCase();
    const locLower = String(loc || '').toLowerCase();

    // If an explicit type is already provided, ALWAYS respect the explicit choice!
    if (t) {
      return t;
    }

    // 005-XX and office keywords are strictly Office discipline per company standards
    if (jn.startsWith('005') || jnLower.includes('office') || jnLower.includes('management') || jnLower.includes('admin') || locLower === 'office') {
      return 'Office';
    }

    if (jnLower.includes('substation') || jnLower.includes('sub-station') || jnLower.includes('sub station') || jn.startsWith('007')) {
      return 'Substation';
    } else if (jnLower.includes('gas') || jn.startsWith('008')) {
      return 'Gas';
    } else if (jnLower.includes('mechanic') || jnLower.includes('shop') || jnLower.includes('garage') || jnLower.includes('fleet') || jn.startsWith('001')) {
      return 'Mechanic';
    } else if (jnLower.includes('civil')) {
      return 'Civil';
    } else if (jnLower.includes('telecom') || jnLower.includes('ziply')) {
      return 'Telecom';
    }

    return 'Electric';
  }

  /**
   * Returns display info (badge color, icon, styling) for a given crew discipline / crew type.
   */
  getCrewTypeInfo(typeStr) {
    const t = String(typeStr || '').trim();
    if (t === 'Substation') {
      return { icon: '🏗️', name: 'Substation', color: '#c084fc', bg: 'rgba(168, 85, 247, 0.15)', border: 'rgba(168, 85, 247, 0.35)' };
    } else if (t === 'Gas') {
      return { icon: '⛽', name: 'Gas', color: '#fbbf24', bg: 'rgba(245, 158, 11, 0.15)', border: 'rgba(245, 158, 11, 0.35)' };
    } else if (t === 'Office') {
      return { icon: '🏢', name: 'Office', color: '#34d399', bg: 'rgba(16, 185, 129, 0.15)', border: 'rgba(16, 185, 129, 0.35)' };
    } else if (t === 'Mechanic') {
      return { icon: '🔧', name: 'Mechanic', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.2)', border: 'rgba(148, 163, 184, 0.35)' };
    } else if (t === 'Civil') {
      return { icon: '🚧', name: 'Civil', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', border: 'rgba(245, 158, 11, 0.35)' };
    } else if (t === 'Telecom') {
      return { icon: '📡', name: 'Telecom', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: 'rgba(56, 189, 248, 0.35)' };
    }
    return { icon: '⚡', name: 'Electric', color: '#60a5fa', bg: 'rgba(59, 130, 246, 0.15)', border: 'rgba(59, 130, 246, 0.35)' };
  }

  /**
   * Reads current active live employees to build a baseline map of original positions.
   * Returns Map: normName -> { name, originalBaseJob, originalSlot, originalCategory, originalLocation, rawRow }
   */
  getOriginalEmployeeLocations() {
    const empTable = this.db ? this.db.getTable('employees') : null;
    const empRows = (empTable && empTable.rows) || [];
    const map = new Map();

    empRows.forEach(r => {
      const name = String(r['Employee Name'] || r['Name'] || Object.values(r)[0] || '').trim();
      if (!name || this.isNonEmployeeName(name)) return;
      const norm = name.toLowerCase();
      const job = String(r['Job Number'] || r['Job #'] || '').trim();
      const baseJob = job.replace(/\.\d+.*$/, '').trim();
      const secJob = String(r['Secondary Job Number'] || r['Secondary Job #'] || '').trim();
      const rawSecBase = secJob.replace(/\.\d+.*$/, '').trim();
      const secBaseJob = (rawSecBase && !rawSecBase.startsWith('002') && !rawSecBase.startsWith('005')) ? rawSecBase : '';
      const loc = String(r['Location'] || '').trim();
      const locLower = loc.toLowerCase();
      const statLower = String(r['Status'] || '').toLowerCase().trim();
      const hireDate = String(r['Hire Date'] || r['HireDate'] || '').trim();
      const isPending = statLower === 'pending' || (hireDate && this.isFutureHireDate(hireDate));

      const isVacation = statLower === 'vacation' || locLower.includes('(vacation)') || locLower === 'vacation' || job.toLowerCase() === 'vacation';
      const isLeave = !isVacation && (statLower === 'leave' || locLower.includes('(leave)') || locLower === 'leave' || job.toLowerCase() === 'leave');
      const isWeeds = !isVacation && !isLeave && (locLower.includes('(weeds)') || locLower === 'weeds' || statLower === 'weeds' || job.toLowerCase() === 'weeds');
      const isLightDuty = !isVacation && !isLeave && !isWeeds && (locLower.includes('(light duty)') || locLower === 'light duty' || statLower === 'light duty' || job.toLowerCase() === 'light duty');
      const hasFieldJob = Boolean(job && job.toLowerCase() !== 'unassigned');

      let category = null;
      if (isVacation || isLeave) category = 'vacation';
      else if (isWeeds) category = 'weeds';
      else if (isLightDuty) category = 'lightDuty';
      else if (isPending && !hasFieldJob) category = 'pendingHires';
      else if (!hasFieldJob) category = 'planning';

      map.set(norm, {
        name,
        originalBaseJob: category ? null : (baseJob || null),
        originalSlot: job || null,
        secondaryBaseJob: secBaseJob || null,
        secondarySlot: secBaseJob ? (secJob || null) : null,
        originalCategory: category, // 'vacation', 'weeds', 'lightDuty', 'pendingHires', 'planning', or null if in active field crew
        originalLocation: loc,
        rawRow: r
      });
    });

    return map;
  }

  /**
   * Scans a plan to index every place an employee appears across all crews and side pane categories.
   * Returns Map: normName -> Array<{ type: 'crew'|'side', baseJob, slot, sideType, memberObj, location }>
   */
  getEmployeeOccurrencesMap(plan) {
    if (!plan) return new Map();
    const occMap = new Map();

    const registerOcc = (empName, occ) => {
      if (!empName || this.isNonEmployeeName(empName)) return;
      const norm = empName.toLowerCase().trim();
      if (!occMap.has(norm)) occMap.set(norm, []);
      occMap.get(norm).push(occ);
    };

    // 1. Crew members
    (plan.crews || []).forEach(crew => {
      (crew.members || []).forEach(m => {
        registerOcc(m.name, {
          type: 'crew',
          baseJob: crew.jobNumber,
          slot: m.slot || crew.jobNumber,
          memberObj: m,
          location: crew.location || 'Helena'
        });
      });
    });

    // 2. Side pane categories
    const sp = plan.sidePane || {};
    const catKeys = ['planning', 'vacation', 'quit', 'weeds', 'lightDuty', 'pendingHires'];
    catKeys.forEach(catKey => {
      (sp[catKey] || []).forEach(item => {
        // Exclude mirror scheduled departure records from counting as an extra/duplicate working location
        if (catKey === 'quit' && item.isScheduledDeparture) {
          return;
        }
        // Exclude mirror future/partial-week vacation records when the employee remains active on their crew
        if (catKey === 'vacation' && (item.isFutureVacation || item.keepOnCrew)) {
          return;
        }
        registerOcc(item.name, {
          type: 'side',
          sideType: catKey,
          memberObj: item,
          location: item.location || ''
        });
      });
    });

    return occMap;
  }

  /**
   * Helper: checks if an employee name matches a crew's designated foreman.
   * Resolves nicknames and alternate names (e.g. Benjamin Lapka <-> Ben Lapka).
   */
  isCrewForeman(crew, empName) {
    if (!crew || !crew.foreman || !empName) return false;
    const f = String(crew.foreman).trim().toLowerCase();
    const n = String(empName).trim().toLowerCase();
    if (f === n) return true;

    // Check alternate names via cached employee lookup index
    const { byName } = this._getEmpLookup();

    // 1. Direct match on empName row's Alternate Names
    const empRow = byName.get(n);
    if (empRow && empRow['Alternate Names']) {
      const alts = String(empRow['Alternate Names']).split(/[|,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
      if (alts.includes(f)) return true;
    }

    // 2. Direct match on crew.foreman row's Alternate Names
    const fRow = byName.get(f);
    if (fRow) {
      const canonicalF = String(fRow['Employee Name'] || fRow['Name'] || '').trim().toLowerCase();
      if (canonicalF === n) return true;
      if (fRow['Alternate Names']) {
        const alts = String(fRow['Alternate Names']).split(/[|,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
        if (alts.includes(n)) return true;
      }
    }

    // 3. Common nickname patterns (e.g. Benjamin <-> Ben, Matthew <-> Matt)
    const nicknames = [
      ['benjamin', 'ben'],
      ['matthew', 'matt'],
      ['michael', 'mike'],
      ['william', 'bill', 'billy', 'will'],
      ['robert', 'bob', 'bobby', 'rob'],
      ['james', 'jim', 'jimmy'],
      ['joseph', 'joe', 'joey'],
      ['christopher', 'chris'],
      ['daniel', 'dan', 'danny'],
      ['alexander', 'alex'],
      ['anthony', 'tony'],
      ['andrew', 'andy', 'drew'],
      ['nicholas', 'nick'],
      ['joshua', 'josh'],
      ['samuel', 'sam', 'sammy'],
      ['timothy', 'tim'],
      ['thomas', 'tom', 'tommy'],
      ['jonathan', 'jon'],
      ['steven', 'stephen', 'steve'],
      ['charles', 'charlie', 'chuck'],
      ['edward', 'ed', 'eddie'],
      ['richard', 'rick', 'rich', 'dick'],
      ['kenneth', 'ken', 'kenny'],
      ['zachary', 'zach', 'zack'],
      ['nathaniel', 'nathan', 'nate']
    ];
    for (const group of nicknames) {
      const fInGroup = group.some(nick => f.startsWith(nick + ' ') || f === nick);
      const nInGroup = group.some(nick => n.startsWith(nick + ' ') || n === nick);
      if (fInGroup && nInGroup) {
        const fParts = f.split(/\s+/);
        const nParts = n.split(/\s+/);
        if (fParts.length > 1 && nParts.length > 1 && fParts[fParts.length - 1] === nParts[nParts.length - 1]) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Computes the conditional status of an employee in a specific position within the plan:
   * - Purple: Moved from original crew/position or present in multiple locations (unconfirmed)
   * - Yellow: Moved or multi-location AND confirmed by user
   * - Normal: Single location matching their original baseline position (no conditional color)
   */
  getEmployeePlanningStatus(empName, currentBaseJob, currentSideType, plan, baselineMap, occMap) {
    if (!empName || this.isNonEmployeeName(empName)) {
      return {
        statusColor: 'normal',
        isMoved: false,
        isMultiLocation: false,
        isConfirmed: false,
        badgeText: '',
        title: '',
        reason: 'non-employee',
        originalLabel: '',
        currentLabel: '',
        occurrencesCount: 0
      };
    }

    if (!baselineMap) baselineMap = this.getOriginalEmployeeLocations();
    if (!occMap) occMap = this.getEmployeeOccurrencesMap(plan);

    const norm = String(empName || '').toLowerCase().trim();
    const occurrences = occMap.get(norm) || [];
    const occurrencesCount = occurrences.length;
    const isMultiLocation = occurrencesCount > 1;

    const base = baselineMap.get(norm);
    let isMoved = false;
    let originalLabel = '';
    let currentLabel = currentBaseJob ? `Crew ${currentBaseJob}` : (currentSideType ? `Staging (${currentSideType})` : 'Staging');

    if (!base) {
      // New employee / pending hire not yet in live database
      isMoved = true;
      originalLabel = 'New Hire / External';
    } else if (currentSideType) {
      // Placed in side pane category
      const secBaseLower = (base.secondaryBaseJob || '').toLowerCase();
      if (base.originalCategory !== currentSideType) {
        isMoved = true;
        originalLabel = base.originalBaseJob ? `Crew ${base.originalBaseJob}` : (base.originalCategory ? `Staging (${base.originalCategory})` : 'Unassigned');
      } else if (currentSideType === 'lightDuty' && secBaseLower && !occurrences.some(o => o.baseJob && o.baseJob.toLowerCase() === secBaseLower)) {
        isMoved = true;
        originalLabel = `Light Duty & Crew ${base.secondaryBaseJob}`;
      } else {
        originalLabel = secBaseLower && currentSideType === 'lightDuty'
          ? `Light Duty & Crew ${base.secondaryBaseJob}`
          : `Staging (${base.originalCategory})`;
      }
    } else if (currentBaseJob) {
      // Placed in a field crew
      const curBaseLower = currentBaseJob.toLowerCase();
      const origBaseLower = (base.originalBaseJob || '').toLowerCase();
      const secBaseLower = (base.secondaryBaseJob || '').toLowerCase();
      const hasPrimaryInPlan = Boolean(origBaseLower && occurrences.some(o => o.baseJob && o.baseJob.toLowerCase() === origBaseLower));
      const hasSecondaryInPlan = Boolean(secBaseLower && occurrences.some(o => o.baseJob && o.baseJob.toLowerCase() === secBaseLower));
      const hasLightDutyInPlan = occurrences.some(o => o.sideType === 'lightDuty');

      if (base.originalCategory === 'lightDuty' && secBaseLower === curBaseLower && hasLightDutyInPlan) {
        // Light Duty employee maintaining their established live 2nd job assignment
        originalLabel = `Light Duty & Crew ${base.secondaryBaseJob}`;
      } else if (base.originalCategory) {
        isMoved = true;
        originalLabel = `Staging (${base.originalCategory})`;
      } else if (origBaseLower && origBaseLower === curBaseLower) {
        if (secBaseLower && !hasSecondaryInPlan) {
          // Employee previously had a secondary crew assignment on live that has been removed/dropped in this plan
          isMoved = true;
          originalLabel = `Crew ${base.originalBaseJob} & ${base.secondaryBaseJob}`;
        } else {
          originalLabel = secBaseLower ? `Crew ${base.originalBaseJob} & ${base.secondaryBaseJob}` : `Crew ${base.originalBaseJob}`;
        }
      } else if (secBaseLower && secBaseLower === curBaseLower && hasPrimaryInPlan) {
        // Employee is on their established live 2nd job alongside their live 1st job (not a move)
        originalLabel = `Crew ${base.originalBaseJob} & ${base.secondaryBaseJob}`;
      } else {
        isMoved = true;
        originalLabel = base.originalBaseJob ? `Crew ${base.originalBaseJob}` : 'Unassigned';
      }
    }

    // Check confirmation state on the member object or in plan.confirmedPositions
    const currentOcc = occurrences.find(o => {
      if (currentBaseJob && o.baseJob && o.baseJob.toLowerCase() === currentBaseJob.toLowerCase()) return true;
      if (currentSideType && o.sideType && o.sideType.toLowerCase() === currentSideType.toLowerCase()) return true;
      return false;
    });
    let memberObj = currentOcc?.memberObj;
    if (!memberObj && currentSideType && plan.sidePane && Array.isArray(plan.sidePane[currentSideType])) {
      memberObj = plan.sidePane[currentSideType].find(item => String(item?.name || '').toLowerCase().trim() === norm);
    }

    const confirmKey = currentBaseJob ? `${norm}::${currentBaseJob.toLowerCase()}` : `${norm}::${(currentSideType || '').toLowerCase()}`;
    const legacySideKey = currentSideType ? `${norm}::side:${currentSideType.toLowerCase()}` : '';
    let explicitConfirmVal = undefined;
    if (plan.confirmedPositions) {
      if (plan.confirmedPositions[confirmKey] !== undefined) {
        explicitConfirmVal = plan.confirmedPositions[confirmKey];
      } else if (legacySideKey && plan.confirmedPositions[legacySideKey] !== undefined) {
        explicitConfirmVal = plan.confirmedPositions[legacySideKey];
      }
    }

    const crewOccs = occurrences.filter(o => Boolean(o.baseJob));
    const hasMultipleCrews = crewOccs.length > 1;
    const basePrimLower = (base?.originalBaseJob || '').toLowerCase();
    const baseSecLower = (base?.secondaryBaseJob || '').toLowerCase();
    const isUnchangedBaselineMulti = Boolean(
      base &&
      currentBaseJob &&
      hasMultipleCrews &&
      !base.originalCategory &&
      !isMoved &&
      basePrimLower &&
      baseSecLower &&
      crewOccs.length === 2 &&
      crewOccs.every(o => {
        const bj = String(o.baseJob || '').toLowerCase();
        return bj === basePrimLower || bj === baseSecLower;
      }) &&
      crewOccs.some(o => String(o.baseJob || '').toLowerCase() === basePrimLower) &&
      crewOccs.some(o => String(o.baseJob || '').toLowerCase() === baseSecLower)
    );
    const isUnchangedBaselineLightDutySec = Boolean(
      base &&
      base.originalCategory === 'lightDuty' &&
      baseSecLower &&
      !isMoved &&
      occurrences.length === 2 &&
      occurrences.some(o => o.sideType === 'lightDuty') &&
      crewOccs.length === 1 &&
      String(crewOccs[0]?.baseJob || '').toLowerCase() === baseSecLower
    );

    const isConfirmed = (isUnchangedBaselineMulti || isUnchangedBaselineLightDutySec)
      ? true
      : ((isMultiLocation || isMoved)
        ? (explicitConfirmVal !== undefined ? Boolean(explicitConfirmVal) : Boolean(memberObj?.isConfirmed))
        : false);

    // Conditional styling evaluation:
    // 1. If not multi-location and not moved: NORMAL (no conditional highlighting)
    // 2. If moved or multi-location:
    //    - If confirmed: YELLOW
    //    - If unconfirmed: PURPLE
    let statusColor = 'normal';
    let badgeText = '';
    let title = '';

    if (isMultiLocation) {
      if (isUnchangedBaselineLightDutySec) {
        statusColor = 'cyan';
        badgeText = '2nd Job';
        title = `Light Duty with active 2nd job on Crew ${base.secondaryBaseJob}`;
      } else if (hasMultipleCrews && currentBaseJob) {
        if (isConfirmed) {
          statusColor = 'cyan';
          badgeText = isUnchangedBaselineMulti ? '2nd Job' : 'Confirmed 2nd Job';
          title = `Active 2nd job split across ${crewOccs.length} crews: ${crewOccs.map(o => `Crew ${o.baseJob}`).join(', ')}`;
        } else {
          statusColor = 'purple';
          badgeText = `Multi (${occurrencesCount})`;
          title = `Assigned to ${occurrencesCount} locations (${occurrences.map(o => o.baseJob ? `Crew ${o.baseJob}` : o.sideType).join(', ')}). Click to confirm 2nd job position`;
        }
      } else if (isConfirmed) {
        statusColor = 'yellow';
        badgeText = `Multi (${occurrencesCount})`;
        title = `Confirmed in ${occurrencesCount} locations: ${occurrences.map(o => o.baseJob ? `Crew ${o.baseJob}` : o.sideType).join(', ')}`;
      } else {
        statusColor = 'purple';
        badgeText = `Multi (${occurrencesCount})`;
        title = `Assigned to ${occurrencesCount} locations (${occurrences.map(o => o.baseJob ? `Crew ${o.baseJob}` : o.sideType).join(', ')}). Click to confirm position`;
      }
    } else if (isMoved) {
      if (isConfirmed) {
        statusColor = 'yellow';
        badgeText = 'Confirmed Move';
        title = `Confirmed move from ${originalLabel} to ${currentLabel}`;
      } else {
        statusColor = 'purple';
        badgeText = 'Moved';
        title = `Moved from ${originalLabel} to ${currentLabel}. Click to confirm position`;
      }
    }

    return {
      name: empName,
      normName: norm,
      occurrencesCount,
      isMultiLocation,
      isMoved,
      isConfirmed,
      statusColor, // 'normal' | 'purple' | 'yellow'
      badgeText,
      title,
      originalLabel,
      currentLabel,
      occurrences,
      memberObj
    };
  }

  // ==========================================================================
  // Plan Draft Data Storage & Management
  // ==========================================================================

  getPlansMap() {
    if (!this.db || !this.db.snapshot) return {};
    if (!this.db.snapshot.configs) this.db.snapshot.configs = {};
    if (!this.db.snapshot.configs.crew_structure_plans) {
      this.db.snapshot.configs.crew_structure_plans = {};
    }
    return this.db.snapshot.configs.crew_structure_plans;
  }

  savePlansMap(map) {
    if (!this.db || !this.db.snapshot) return;
    if (!this.db.snapshot.configs) this.db.snapshot.configs = {};
    this.db.snapshot.configs.crew_structure_plans = map;
    if (this.db._dirtyTablesForSync && typeof this.db._dirtyTablesForSync.add === 'function') {
      this.db._dirtyTablesForSync.add('__configs__');
    }
    if (typeof this.db.schedulePersistSnapshot === 'function') {
      this.db.schedulePersistSnapshot(this.db.snapshot, 400);
    }
  }

  isCompletedStatus(status) {
    const s = String(status || '').trim().toLowerCase();
    return s === 'completed' || s === 'closed';
  }

  isCompletedCrewHidden(crew, jtRows = null) {
    if (!crew) return true;
    const hasMembers = Array.isArray(crew.members) && crew.members.length > 0;
    if (hasMembers) return false;
    if (this.isCompletedStatus(crew.status)) return true;
    const rows = Array.isArray(jtRows)
      ? jtRows
      : ((this.db ? this.db.getTable('job_tracking') : null)?.rows || null);
    const baseJob = String(crew.jobNumber || '').replace(/\.\d+.*$/, '').trim().toLowerCase();
    if (Array.isArray(rows) && baseJob) {
      const jtRow = rows.find(j => {
        const jn = String(j['Job Number'] || j['Job #'] || '').trim().replace(/\.\d+.*$/, '').toLowerCase();
        return jn === baseJob;
      });
      if (jtRow && !crew._statusEditedLocally && this.isCompletedStatus(jtRow['Status'])) {
        return true;
      }
    }
    return false;
  }

  getPlanForWeek(weekStr) {
    if (!weekStr) weekStr = this.getDefaultPlanningWeekStr();
    const plans = this.getPlansMap();
    if (!plans[weekStr]) {
      const currentWeekStr = this.getCurrentWeekSundayStr();
      const nextWeekStr = this.getPlanningWeeks()[0]?.weekStr;
      // If opening Current Week (e.g. 11/08/2026) before it has been published, and the user already
      // made draft edits on Next Week (e.g. 11/15/2026), carry those draft edits into Current Week automatically!
      if (weekStr === currentWeekStr && nextWeekStr && plans[nextWeekStr] && plans[nextWeekStr].status !== 'published') {
        const cloned = JSON.parse(JSON.stringify(plans[nextWeekStr]));
        cloned.weekDate = weekStr;
        cloned.weekDateFormatted = weekStr;
        plans[weekStr] = cloned;
      } else {
        plans[weekStr] = this.initializePlanFromCurrentRoster(weekStr);
      }
      this.savePlansMap(plans);
    }
    const plan = plans[weekStr];
    if (!plan.confirmedPositions) {
      plan.confirmedPositions = {};
    }
    if (!plan.sidePane) {
      plan.sidePane = { planning: [], vacation: [], quit: [], weeds: [], lightDuty: [], pendingHires: [] };
    }

    if (plan.status !== 'published') {
      // Purge Previous Employees & Quits whose Last Day has already passed BEFORE auto-healing baseline
      const { changed: purgedChanged, purgedNames } = this.purgeDepartedAndPreviousEmployees(plan);

      // Safety auto-repair: Ensure no active baseline employees are completely missing from the plan
      this.healMissingBaselineEmployees(plan, purgedNames);

      // Clear stale confirmations for employees whose positions already match live baseline
      const staleChanged = this.cleanupStaleConfirmations(plan);
      if (purgedChanged || staleChanged) {
        this.savePlan(plan);
      }

      // Sync crew types, statuses & notes with Job Tracking and prune 0-member Completed/Closed crews
      if (plan.crews && Array.isArray(plan.crews)) {
        const jtTable = this.db ? this.db.getTable('job_tracking') : null;
        const jtRows = jtTable?.rows || [];
        const beforeCrewsLen = plan.crews.length;
        plan.crews = plan.crews.filter(c => {
          const baseCrewJob = String(c.jobNumber || '').replace(/\.\d+.*$/, '').trim();
          const matchingJt = jtRows.find(j => {
            const jn = String(j['Job Number'] || j['Job #'] || '').trim();
            return jn === c.jobNumber || jn.replace(/\.\d+.*$/, '').trim() === baseCrewJob;
          });
          if (matchingJt && matchingJt['Crew Type']) {
            c.crewType = matchingJt['Crew Type'];
          } else if (!c.crewType) {
            c.crewType = this.detectCrewType(c.jobNumber, c.jobName, c.location, '');
          }
          if (c.notes === undefined) {
            c.notes = String((matchingJt && matchingJt['Notes']) || '').trim();
          }
          const jtStatus = matchingJt ? String(matchingJt['Status'] || '').trim() : '';
          const jtIsCompleted = this.isCompletedStatus(jtStatus);
          if (jtIsCompleted) {
            c.status = jtStatus;
            delete c._statusEditedLocally;
          } else if (jtStatus && !c._statusEditedLocally) {
            c.status = jtStatus;
          }
          const hasMembers = Array.isArray(c.members) && c.members.length > 0;
          if (!hasMembers && this.isCompletedStatus(c.status) && (!matchingJt || jtIsCompleted)) {
            return false;
          }
          return true;
        });
        if (plan.crews.length !== beforeCrewsLen) {
          this.savePlan(plan);
        }
      }
    }

    return plan;
  }

  /**
   * Clears location-scoped and legacy bare-name confirmation entries for an employee.
   */
  clearMemberConfirmations(plan, empName, locationKeys = []) {
    if (!plan || !plan.confirmedPositions || !empName) return;
    const norm = String(empName).toLowerCase().trim();
    delete plan.confirmedPositions[norm];
    (locationKeys || []).forEach(loc => {
      const k = String(loc || '').toLowerCase().trim();
      if (!k) return;
      delete plan.confirmedPositions[`${norm}::${k}`];
      delete plan.confirmedPositions[`${norm}::side:${k}`];
    });
  }

  /**
   * Removes stale confirmation flags/entries for employees who match their live baseline
   * in a single location (e.g. confirmed moves carried over from a previous week's structure).
   */
  cleanupStaleConfirmations(plan) {
    if (!plan || plan.status === 'published') return false;
    let changed = false;
    if (!plan.confirmedPositions || typeof plan.confirmedPositions !== 'object') {
      plan.confirmedPositions = {};
    }

    const baselineMap = this.getOriginalEmployeeLocations();
    const occMap = this.getEmployeeOccurrencesMap(plan);
    const validMovedKeys = new Set();

    (plan.crews || []).forEach(crew => {
      const baseJobLower = String(crew.jobNumber || '').trim().toLowerCase();
      (crew.members || []).forEach(m => {
        if (!m || !m.name || this.isNonEmployeeName(m.name)) return;
        const norm = String(m.name).toLowerCase().trim();
        const st = this.getEmployeePlanningStatus(m.name, crew.jobNumber, null, plan, baselineMap, occMap);
        if (!st.isMoved && !st.isMultiLocation) {
          if (m.isConfirmed) {
            m.isConfirmed = false;
            changed = true;
          }
        } else {
          validMovedKeys.add(`${norm}::${baseJobLower}`);
        }
      });
    });

    const sp = plan.sidePane || {};
    ['planning', 'vacation', 'quit', 'weeds', 'lightDuty', 'pendingHires'].forEach(cat => {
      const catLower = cat.toLowerCase();
      (sp[cat] || []).forEach(item => {
        if (!item || !item.name || this.isNonEmployeeName(item.name)) return;
        const norm = String(item.name).toLowerCase().trim();
        const st = this.getEmployeePlanningStatus(item.name, null, cat, plan, baselineMap, occMap);
        if (!st.isMoved && !st.isMultiLocation) {
          if (item.isConfirmed) {
            item.isConfirmed = false;
            changed = true;
          }
        } else {
          validMovedKeys.add(`${norm}::${catLower}`);
          validMovedKeys.add(`${norm}::side:${catLower}`);
        }
      });
    });

    Object.keys(plan.confirmedPositions).forEach(key => {
      if (!validMovedKeys.has(key)) {
        delete plan.confirmedPositions[key];
        changed = true;
      }
    });

    return changed;
  }

  /**
   * Safety auto-repair: If any active employee from the live roster was deleted or went missing
   * from both the planned crews and side pane categories, restore them to their original crew/position.
   */
  healMissingBaselineEmployees(plan, extraSkipNames = null) {
    if (!plan) return;

    let purgedCount = 0;

    // 1. Purge non-employee equipment tracking items from sidePane
    if (plan.sidePane) {
      Object.keys(plan.sidePane).forEach(key => {
        if (Array.isArray(plan.sidePane[key])) {
          const beforeLen = plan.sidePane[key].length;
          plan.sidePane[key] = plan.sidePane[key].filter(item => {
            const name = item?.name || '';
            return name && !this.isNonEmployeeName(name);
          });
          if (plan.sidePane[key].length !== beforeLen) {
            purgedCount += (beforeLen - plan.sidePane[key].length);
          }
        }
      });
    }

    // 2. Purge non-employee members from planned crews
    if (Array.isArray(plan.crews)) {
      plan.crews.forEach(c => {
        if (Array.isArray(c.members)) {
          const beforeLen = c.members.length;
          c.members = c.members.filter(m => {
            const name = m?.name || '';
            return name && !this.isNonEmployeeName(name);
          });
          if (c.members.length !== beforeLen) {
            purgedCount += (beforeLen - c.members.length);
            c.members.forEach((m, idx) => {
              m.slot = `${c.jobNumber}.${idx + 1}`;
            });
          }
        }
      });
    }

    const baselineMap = this.getOriginalEmployeeLocations();
    if (!baselineMap || baselineMap.size === 0) {
      if (purgedCount > 0) this.savePlan(plan);
      return;
    }

    // Collect all employee names currently in the plan (crews + all sidePane buckets)
    const activeNamesInPlan = new Set();
    (plan.crews || []).forEach(c => {
      (c.members || []).forEach(m => {
        if (m.name && !this.isNonEmployeeName(m.name)) activeNamesInPlan.add(m.name.trim().toLowerCase());
      });
    });
    const sp = plan.sidePane || {};
    Object.keys(sp).forEach(k => {
      (sp[k] || []).forEach(item => {
        if (item.name && !this.isNonEmployeeName(item.name)) activeNamesInPlan.add(item.name.trim().toLowerCase());
      });
    });

    let healedCount = 0;
    baselineMap.forEach((base, normName) => {
      if (!base.name || this.isNonEmployeeName(base.name)) return;
      if (activeNamesInPlan.has(normName)) return;
      if (extraSkipNames && extraSkipNames.has(normName)) return;

      // Skip inactive / previous employees or employees whose Last Day has strictly passed
      if (this.isEmployeeDepartedOrPrevious(base.name, null, base.rawRow)) return;

      // This employee is active on the live database but completely missing from the plan (e.g. deleted from quit)!
      // Restore them back to their original crew or staging pool!
      if (base.originalBaseJob) {
        const targetCrew = plan.crews.find(c => c.jobNumber.toLowerCase() === base.originalBaseJob.toLowerCase());
        if (targetCrew) {
          targetCrew.members.push({
            name: base.name,
            slot: `${targetCrew.jobNumber}.${targetCrew.members.length + 1}`,
            originalSlot: base.originalSlot || targetCrew.jobNumber,
            originalBaseJob: targetCrew.jobNumber,
            classification: String(base.rawRow?.['Job Classification'] || base.rawRow?.['Classification'] || 'Journeyman').trim(),
            role: String(base.rawRow?.['Role'] || 'JL').trim(),
            location: targetCrew.location || 'Helena',
            isConfirmed: false
          });
          targetCrew.members.forEach((m, idx) => {
            m.slot = `${targetCrew.jobNumber}.${idx + 1}`;
          });
          activeNamesInPlan.add(normName);
          healedCount++;
          return;
        }
      }

      // If no target crew, restore to original category or planning pool
      const cat = (base.originalCategory && plan.sidePane[base.originalCategory]) ? base.originalCategory : 'planning';
      if (!plan.sidePane[cat]) plan.sidePane[cat] = [];
      plan.sidePane[cat].push({
        name: base.name,
        currentJob: base.originalSlot || '',
        isConfirmed: false
      });
      activeNamesInPlan.add(normName);
      healedCount++;
    });

    if (healedCount > 0 || purgedCount > 0) {
      this.savePlan(plan);
    }
  }

  savePlan(plan) {
    if (!plan || !plan.weekDate) return;
    plan.lastModified = new Date().toISOString();
    const plans = this.getPlansMap();
    plans[plan.weekDate] = plan;
    this.savePlansMap(plans);
  }

  /**
   * Initializes a new planned week by deep-cloning the current live employees & job tracking structure.
   */
  initializePlanFromCurrentRoster(targetWeekStr) {
    const empTable = this.db ? this.db.getTable('employees') : null;
    const jtTable = this.db ? this.db.getTable('job_tracking') : null;
    const empRows = (empTable && empTable.rows) || [];
    const jtRows = (jtTable && jtTable.rows) || [];

    const prevEmpNames = (window.sheetNavigator && typeof window.sheetNavigator.getPreviousEmployeeNamesSet === 'function')
      ? window.sheetNavigator.getPreviousEmployeeNamesSet()
      : new Set();

    const isEmpActive = (r) => {
      const name = String(r['Employee Name'] || r['Name'] || Object.values(r)[0] || '').trim();
      if (this.isEmployeeDepartedOrPrevious(name, null, r)) return false;
      if (window.sheetNavigator && typeof window.sheetNavigator.isEmployeeActive === 'function') {
        return window.sheetNavigator.isEmployeeActive(r, prevEmpNames);
      }
      const st = String(r['Status'] || '').toLowerCase().trim();
      return st !== 'previous employee' && st !== 'inactive' && st !== 'terminated';
    };

    const activeRows = empRows.filter(isEmpActive);

    // Group active field members vs status buckets
    const crewsMap = new Map();
    const sidePane = {
      planning: [],
      vacation: [],
      quit: [],
      weeds: [],
      lightDuty: [],
      pendingHires: []
    };

    // Pre-populate crewsMap from active Job Tracking jobs (skip Completed/Closed jobs)
    jtRows.forEach(j => {
      const jn = String(j['Job Number'] || j['Job #'] || '').trim();
      const baseJob = jn.replace(/\.\d+.*$/, '').trim();
      const status = String(j['Status'] || 'Active').trim();
      if (!baseJob || baseJob.toLowerCase() === 'unassigned' || this.isCompletedStatus(status)) return;

      if (!crewsMap.has(baseJob)) {
        crewsMap.set(baseJob, {
          jobNumber: baseJob,
          location: String(j['Location'] || 'Helena').trim(),
          foreman: String(j['Foreman'] || j['Crew Lead'] || '').trim(),
          crewType: this.detectCrewType(baseJob, j['Job Name'], j['Location'], j['Crew Type'] || j['Discipline']),
          status: status,
          schedule: String(j['Work Schedule'] || j['Schedule'] || 'Mon-Thu (4 10s)').trim(),
          isSkipSun: j['Skip Sun'] === true || String(j['Skip Sun']).toLowerCase() === 'true',
          isSkipMon: j['Skip Mon'] === true || String(j['Skip Mon']).toLowerCase() === 'true',
          isSkipTue: j['Skip Tue'] === true || String(j['Skip Tue']).toLowerCase() === 'true',
          isSkipWed: j['Skip Wed'] === true || String(j['Skip Wed']).toLowerCase() === 'true',
          isSkipThu: j['Skip Thu'] === true || String(j['Skip Thu']).toLowerCase() === 'true',
          isSkipFri: j['Skip Fri'] === true || String(j['Skip Fri']).toLowerCase() === 'true',
          isSkipSat: j['Skip Sat'] === true || String(j['Skip Sat']).toLowerCase() === 'true',
          skipMtg: j['Skip Weekly Meeting'] === true || String(j['Skip Weekly Meeting']).toLowerCase() === 'true',
          skipChk: j['Skip Monthly Checklist'] === true || String(j['Skip Monthly Checklist']).toLowerCase() === 'true',
          jobName: String(j['Job Name'] || '').trim(),
          notes: String(j['Notes'] || '').trim(),
          members: []
        });
      } else {
        const existing = crewsMap.get(baseJob);
        const curName = String(j['Job Name'] || '').trim();
        const exName = String(existing.jobName || '').trim();
        if (curName && (!exName || (exName.toLowerCase().includes('dock') && !curName.toLowerCase().includes('dock')))) {
          existing.jobName = curName;
        }
        if (!existing.foreman && j['Foreman']) existing.foreman = String(j['Foreman']).trim();
      }
    });

    activeRows.forEach(r => {
      const name = String(r['Employee Name'] || r['Name'] || Object.values(r)[0] || '').trim();
      if (!name || this.isNonEmployeeName(name)) return;
      const job = String(r['Job Number'] || r['Job #'] || '').trim();
      const loc = String(r['Location'] || '').trim();
      const locLower = loc.toLowerCase();
      const statLower = String(r['Status'] || '').toLowerCase().trim();
      const classification = String(r['Job Classification'] || r['Classification'] || r['Role'] || '').trim();
      const secondaryJob = String(r['Secondary Job Number'] || r['Secondary Job #'] || '').trim();
      const hireDate = String(r['Hire Date'] || r['HireDate'] || '').trim();
      const notes = String(r['Notes'] || '').trim();
      const isPending = statLower === 'pending' || (hireDate && this.isFutureHireDate(hireDate));

      const memberObj = {
        name,
        slot: job,
        originalSlot: job,
        originalBaseJob: job ? job.replace(/\.\d+.*$/, '').trim() : null,
        classification,
        role: classification,
        location: loc,
        secondaryJob,
        hireDate,
        notes,
        isPending,
        isConfirmed: false
      };

      const isVacation = statLower === 'vacation' || locLower.includes('(vacation)') || locLower === 'vacation' || job.toLowerCase() === 'vacation';
      const isLeave = !isVacation && (statLower === 'leave' || locLower.includes('(leave)') || locLower === 'leave' || job.toLowerCase() === 'leave');
      const isWeeds = !isVacation && !isLeave && (locLower.includes('(weeds)') || locLower === 'weeds' || statLower === 'weeds' || job.toLowerCase() === 'weeds');
      const isLightDuty = !isVacation && !isLeave && !isWeeds && (locLower.includes('(light duty)') || locLower === 'light duty' || statLower === 'light duty' || job.toLowerCase() === 'light duty');
      const hasFieldJob = Boolean(job && job.toLowerCase() !== 'unassigned');

      if (isVacation || isLeave) {
        sidePane.vacation.push({ ...memberObj, currentJob: job });
      } else if (isWeeds) {
        sidePane.weeds.push({ ...memberObj, currentJob: job });
      } else if (isLightDuty) {
        sidePane.lightDuty.push({ ...memberObj, currentJob: job });
      } else if (hasFieldJob) {
        const baseJob = job.replace(/\.\d+.*$/, '').trim();
        if (!crewsMap.has(baseJob)) {
          const matchingJt = jtRows.find(j => {
            const jn = String(j['Job Number'] || j['Job #'] || '').trim();
            return jn === baseJob || jn.replace(/\.\d+.*$/, '').trim() === baseJob;
          });
          crewsMap.set(baseJob, {
            jobNumber: baseJob,
            location: loc || (matchingJt && matchingJt['Location']) || 'Helena',
            foreman: (matchingJt && matchingJt['Foreman']) || '',
            crewType: this.detectCrewType(baseJob, matchingJt && matchingJt['Job Name'], loc || (matchingJt && matchingJt['Location']), matchingJt && matchingJt['Crew Type']),
            status: String((matchingJt && matchingJt['Status']) || 'Active').trim(),
            schedule: (matchingJt && (matchingJt['Work Schedule'] || matchingJt['Schedule'])) || 'Mon-Thu (4 10s)',
            isSkipSun: matchingJt ? (matchingJt['Skip Sun'] === true || String(matchingJt['Skip Sun']).toLowerCase() === 'true') : true,
            isSkipMon: matchingJt ? (matchingJt['Skip Mon'] === true || String(matchingJt['Skip Mon']).toLowerCase() === 'true') : false,
            isSkipTue: matchingJt ? (matchingJt['Skip Tue'] === true || String(matchingJt['Skip Tue']).toLowerCase() === 'true') : false,
            isSkipWed: matchingJt ? (matchingJt['Skip Wed'] === true || String(matchingJt['Skip Wed']).toLowerCase() === 'true') : false,
            isSkipThu: matchingJt ? (matchingJt['Skip Thu'] === true || String(matchingJt['Skip Thu']).toLowerCase() === 'true') : false,
            isSkipFri: matchingJt ? (matchingJt['Skip Fri'] === true || String(matchingJt['Skip Fri']).toLowerCase() === 'true') : true,
            isSkipSat: matchingJt ? (matchingJt['Skip Sat'] === true || String(matchingJt['Skip Sat']).toLowerCase() === 'true') : true,
            skipMtg: matchingJt ? (matchingJt['Skip Weekly Meeting'] === true || String(matchingJt['Skip Weekly Meeting']).toLowerCase() === 'true') : false,
            skipChk: matchingJt ? (matchingJt['Skip Monthly Checklist'] === true || String(matchingJt['Skip Monthly Checklist']).toLowerCase() === 'true') : false,
            jobName: (matchingJt && matchingJt['Job Name']) || '',
            notes: String((matchingJt && matchingJt['Notes']) || '').trim(),
            members: []
          });
        }
        crewsMap.get(baseJob).members.push(memberObj);
      } else if (isPending) {
        if (!sidePane.pendingHires.some(p => p.name.toLowerCase() === name.toLowerCase())) {
          sidePane.pendingHires.push({
            ...memberObj,
            classification: classification || 'Apprentice',
            location: loc || 'Helena',
            notes: notes || 'Incoming New Hire',
            currentJob: job,
            isConfirmed: false
          });
        }
      } else {
        sidePane.planning.push({ ...memberObj, currentJob: job });
      }

      // Populate Secondary Crew Member assignment if secondaryJob exists (for active or Light Duty employees)
      if (!isVacation && !isLeave && !isWeeds && secondaryJob && secondaryJob.toLowerCase() !== 'unassigned') {
        const secBase = secondaryJob.replace(/\.\d+.*$/, '').trim();
        if (secBase && !secBase.startsWith('002') && !secBase.startsWith('005')) {
          if (!crewsMap.has(secBase)) {
            const matchingJt = jtRows.find(j => {
              const jn = String(j['Job Number'] || j['Job #'] || '').trim();
              return jn === secBase || jn.replace(/\.\d+.*$/, '').trim() === secBase;
            });
            crewsMap.set(secBase, {
              jobNumber: secBase,
              location: (matchingJt && matchingJt['Location']) || loc || 'Helena',
              foreman: (matchingJt && matchingJt['Foreman']) || '',
              crewType: this.detectCrewType(secBase, matchingJt && matchingJt['Job Name'], (matchingJt && matchingJt['Location']) || loc, matchingJt && matchingJt['Crew Type']),
              status: String((matchingJt && matchingJt['Status']) || 'Active').trim(),
              schedule: (matchingJt && (matchingJt['Work Schedule'] || matchingJt['Schedule'])) || 'Mon-Thu (4 10s)',
              isSkipSun: matchingJt ? (matchingJt['Skip Sun'] === true || String(matchingJt['Skip Sun']).toLowerCase() === 'true') : true,
              isSkipMon: matchingJt ? (matchingJt['Skip Mon'] === true || String(matchingJt['Skip Mon']).toLowerCase() === 'true') : false,
              isSkipTue: matchingJt ? (matchingJt['Skip Tue'] === true || String(matchingJt['Skip Tue']).toLowerCase() === 'true') : false,
              isSkipWed: matchingJt ? (matchingJt['Skip Wed'] === true || String(matchingJt['Skip Wed']).toLowerCase() === 'true') : false,
              isSkipThu: matchingJt ? (matchingJt['Skip Thu'] === true || String(matchingJt['Skip Thu']).toLowerCase() === 'true') : false,
              isSkipFri: matchingJt ? (matchingJt['Skip Fri'] === true || String(matchingJt['Skip Fri']).toLowerCase() === 'true') : true,
              isSkipSat: matchingJt ? (matchingJt['Skip Sat'] === true || String(matchingJt['Skip Sat']).toLowerCase() === 'true') : true,
              skipMtg: matchingJt ? (matchingJt['Skip Weekly Meeting'] === true || String(matchingJt['Skip Weekly Meeting']).toLowerCase() === 'true') : false,
              skipChk: matchingJt ? (matchingJt['Skip Monthly Checklist'] === true || String(matchingJt['Skip Monthly Checklist']).toLowerCase() === 'true') : false,
              jobName: (matchingJt && matchingJt['Job Name']) || '',
              notes: String((matchingJt && matchingJt['Notes']) || '').trim(),
              members: []
            });
          }
          const secCrew = crewsMap.get(secBase);
          if (!secCrew.members.some(m => m.name.toLowerCase() === name.toLowerCase())) {
            secCrew.members.push({
              ...memberObj,
              slot: secondaryJob,
              originalSlot: secondaryJob,
              originalBaseJob: secBase,
              isSecondaryMember: true,
              primaryJobNumber: job
            });
          }
        }
      }
    });

    // Sort crew members by suffix number
    for (const crew of crewsMap.values()) {
      crew.members.sort((a, b) => {
        const ma = String(a.slot || '').match(/\.(\d+)/);
        const mb = String(b.slot || '').match(/\.(\d+)/);
        const na = ma ? parseInt(ma[1], 10) : 999;
        const nb = mb ? parseInt(mb[1], 10) : 999;
        return na - nb;
      });

      // Detect foreman if not explicitly set using canonical classification hierarchy
      if (!crew.foreman && crew.members.length > 0) {
        crew.foreman = this.pickBestForeman(crew.members);
      }
    }

    // Sort crews by saved import order if available (localStorage, window cache, or snapshot configs)
    let orderList = [];
    try {
      const saved = localStorage.getItem('CREW_IMPORT_ORDER');
      if (saved) orderList = JSON.parse(saved) || [];
    } catch { /* ignore */ }
    if (!Array.isArray(orderList) || orderList.length === 0) {
      const fallbackOrder = (typeof window !== 'undefined' && Array.isArray(window._crewImportOrder) && window._crewImportOrder.length > 0)
        ? window._crewImportOrder
        : this.db?.snapshot?.configs?.CREW_IMPORT_ORDER;
      if (Array.isArray(fallbackOrder)) orderList = fallbackOrder;
    }

    const crewsArray = Array.from(crewsMap.values());
    if (orderList.length > 0) {
      crewsArray.sort((a, b) => {
        const ia = orderList.indexOf(a.jobNumber);
        const ib = orderList.indexOf(b.jobNumber);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.jobNumber.localeCompare(b.jobNumber, undefined, { numeric: true });
      });
    } else {
      crewsArray.sort((a, b) => a.jobNumber.localeCompare(b.jobNumber, undefined, { numeric: true }));
    }

    return {
      weekDate: targetWeekStr,
      weekDateFormatted: targetWeekStr,
      status: 'draft',
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      crews: crewsArray,
      sidePane: sidePane,
      confirmedPositions: {}
    };
  }

  // ==========================================================================
  // Historical Roster Archive
  // ==========================================================================

  getHistoryMap() {
    if (!this.db || !this.db.snapshot) return {};
    if (!this.db.snapshot.configs) this.db.snapshot.configs = {};
    if (!this.db.snapshot.configs.crew_roster_history) {
      this.db.snapshot.configs.crew_roster_history = {};
    }
    return this.db.snapshot.configs.crew_roster_history;
  }

  saveHistoryMap(map) {
    if (!this.db || !this.db.snapshot) return;
    if (!this.db.snapshot.configs) this.db.snapshot.configs = {};
    this.db.snapshot.configs.crew_roster_history = map;
    if (this.db._dirtyTablesForSync && typeof this.db._dirtyTablesForSync.add === 'function') {
      this.db._dirtyTablesForSync.add('__configs__');
    }
    if (typeof this.db.schedulePersistSnapshot === 'function') {
      this.db.schedulePersistSnapshot(this.db.snapshot, 400);
    }
  }

  archiveSnapshot(weekStr, rosterSnapshot) {
    if (!weekStr || !rosterSnapshot) return;
    const hist = this.getHistoryMap();
    hist[weekStr] = {
      weekDate: weekStr,
      archivedAt: new Date().toISOString(),
      ...rosterSnapshot
    };
    this.saveHistoryMap(hist);
  }

  getHistoricalRoster(weekStr) {
    const hist = this.getHistoryMap();
    if (hist[weekStr]) {
      return hist[weekStr];
    }
    const targetDt = this.parseDate(weekStr);
    const normWeek = targetDt ? this.formatDate(targetDt) : weekStr;
    if (normWeek && hist[normWeek]) {
      return hist[normWeek];
    }
    if (targetDt) {
      const targetTs = targetDt.getTime();
      const matchedKey = Object.keys(hist).find(k => this.parseDate(k)?.getTime() === targetTs);
      if (matchedKey) return hist[matchedKey];
    }

    // Synthesize reference structure from Safety Compliance
    const scTable = this.db ? this.db.getTable('safety_compliance') : null;
    const jtTable = this.db ? this.db.getTable('job_tracking') : null;

    const weekRows = (scTable && scTable.rows)
      ? scTable.rows.filter(r => {
          const w = String(r['Week Start'] || r['Week'] || '').trim();
          if (!w) return false;
          if (w === weekStr || w === normWeek) return true;
          const wDt = this.parseDate(w);
          return Boolean(targetDt && wDt && wDt.getTime() === targetDt.getTime());
        })
      : [];

    const crews = weekRows.map(r => {
      const jn = String(r['Job Number'] || r['Crew'] || '').trim();
      const baseJn = jn.replace(/\.\d+.*$/, '').trim();
      const canonicalJn = baseJn || jn;
      const foreman = String(r['Foreman'] || '').trim();
      const jt = (jtTable?.rows || []).find(j => {
        const jVal = String(j['Job Number'] || j['Job #'] || '').trim();
        return jVal === jn || jVal.replace(/\.\d+.*$/, '').trim() === canonicalJn;
      });
      return {
        jobNumber: canonicalJn,
        location: jt?.['Location'] || 'Helena',
        foreman: foreman,
        crewType: jt?.['Crew Type'] || 'Electric',
        schedule: jt?.['Work Schedule'] || jt?.['Schedule'] || 'Mon-Thu',
        jobName: jt?.['Job Name'] || '',
        notes: String(jt?.['Notes'] || '').trim(),
        members: foreman ? [{ name: foreman, slot: `${canonicalJn}.1`, classification: 'Foreman', role: 'F' }] : []
      };
    });

    return {
      weekDate: normWeek || weekStr,
      isSynthesized: true,
      crews: crews,
      sidePane: { planning: [], vacation: [], quit: [], weeds: [], lightDuty: [], pendingHires: [] }
    };
  }

  async importHistoricalWorkbookTabs(fileOrBuffer) {
    let wb;
    if (fileOrBuffer && Array.isArray(fileOrBuffer.SheetNames) && fileOrBuffer.Sheets) {
      wb = fileOrBuffer;
    } else if (fileOrBuffer instanceof ArrayBuffer) {
      if (!window.XLSX) throw new Error('SheetJS library (XLSX) is not available.');
      wb = window.XLSX.read(fileOrBuffer, { type: 'array' });
    } else if (fileOrBuffer instanceof File) {
      if (!window.XLSX) throw new Error('SheetJS library (XLSX) is not available.');
      const buffer = await fileOrBuffer.arrayBuffer();
      wb = window.XLSX.read(buffer, { type: 'array' });
    } else {
      throw new Error('Invalid file input.');
    }

    const ImportEngineCtor = (typeof window !== 'undefined' && window.CrewImportEngine)
      ? window.CrewImportEngine
      : null;
    if (!ImportEngineCtor) {
      throw new Error('CrewImportEngine is not available.');
    }

    const hist = this.getHistoryMap();
    let importedCount = 0;
    const importedWeeks = [];

    // Use a dedicated engine instance so we never clobber an active Crew Import preview
    const engine = new ImportEngineCtor(this.db);
    engine.workbook = wb;

    for (const sheetName of wb.SheetNames) {
      const dateStr = engine.parseRosterDate(sheetName);
      if (!dateStr) continue;

      const d = new Date(dateStr + 'T12:00:00');
      if (isNaN(d.getTime())) continue;
      const sundayStr = this.formatDate(this.getSundayOfDate(d));

      try {
        engine.parseSheet(sheetName);
        const parsedCrews = (engine.parsedCrews || []).map(c => ({
          jobNumber: c.jobNumber,
          location: c.location || 'Helena',
          foreman: (c.lead && c.lead.name) || (c.employees && c.employees[0] ? c.employees[0].name : ''),
          crewType: c.crewType || 'Electric',
          schedule: c.schedule || c.scheduleLabel || 'Mon-Thu',
          jobName: c.jobName || c.fullHeaderText || '',
          notes: c.crewNote || c.notes || '',
          members: (c.employees || []).map(e => ({
            name: e.name,
            slot: e.fullJobNumber || e.slotNumber || e.slot || c.jobNumber,
            classification: e.classification || e.role || '',
            role: e.role || e.classification || '',
            isSecondaryMember: Boolean(e.isSecondaryMember || e.isSecondary)
          }))
        }));

        const sc = engine.specialCircumstances;
        const timeOff = Array.isArray(sc)
          ? sc.filter(s => !s.isQuit)
          : [...(sc?.timeOffCurrentWeek || [])];
        const quits = Array.isArray(sc)
          ? sc.filter(s => s.isQuit)
          : [...(sc?.quits || [])];
        const lightDuty = Array.isArray(sc)
          ? []
          : [...(sc?.lightDutyAndOther || [])];

        hist[sundayStr] = {
          weekDate: sundayStr,
          sourceSheetTab: sheetName,
          archivedAt: new Date().toISOString(),
          isExcelImport: true,
          crews: parsedCrews,
          sidePane: {
            vacation: timeOff.map(t => ({ name: t.name, note: t.note || t.rawText || '', rawText: t.rawText || '' })),
            quit: quits.map(q => ({ name: q.name, note: q.note || q.rawText || '', departureDate: q.departureDate || sundayStr })),
            planning: [],
            weeds: [],
            lightDuty: lightDuty.filter(ld => ld.name).map(ld => ({ name: ld.name, note: ld.note || ld.rawText || '' })),
            pendingHires: []
          }
        };

        importedCount++;
        importedWeeks.push(sundayStr);
      } catch (err) {
        console.warn(`Could not parse historical tab "${sheetName}":`, err);
      }
    }

    this.saveHistoryMap(hist);
    return { importedCount, importedWeeks };
  }

  // ==========================================================================
  // Workspace Renderers
  // ==========================================================================

  /**
   * Builds a lowercase employee name -> live Note text lookup map from the Live Employees table.
   */
  buildLiveEmployeeNotesMap() {
    const map = new Map();
    const empTable = this.db ? this.db.getTable('employees') : null;
    const rows = (empTable && Array.isArray(empTable.rows)) ? empTable.rows : [];
    rows.forEach(r => {
      const name = String(r['Employee Name'] || r['Name'] || '').trim();
      if (!name) return;
      const note = String(r['Notes'] || r['Note'] || '').trim();
      map.set(name.toLowerCase(), note);
    });
    return map;
  }

  /**
   * Returns the effective note for an employee in Crew Planning:
   * - If edited/cleared in this plan (`plan.employeeNotes[norm].edited`), uses planned value.
   * - Otherwise falls back to Live `Employees['Notes']`, or memberObj.notes (e.g. staged new hires).
   */
  getEmployeeNote(empName, plan = null, memberObj = null, liveNotesMap = null) {
    const norm = String(empName || '').trim().toLowerCase();
    if (!norm) return '';
    const activePlan = plan || (this.selectedWeek ? this.getPlanForWeek(this.selectedWeek) : null);
    const plannedEntry = activePlan?.employeeNotes?.[norm];
    if (plannedEntry && plannedEntry.edited) {
      return String(plannedEntry.text || '').trim();
    }
    if (memberObj?._clearedNotes) return '';
    if (memberObj?._editedNotes) return String(memberObj.notes || '').trim();
    const lMap = liveNotesMap || this.buildLiveEmployeeNotesMap();
    if (lMap.has(norm)) {
      return lMap.get(norm) || '';
    }
    if (plannedEntry && plannedEntry.text !== undefined) {
      return String(plannedEntry.text || '').trim();
    }
    return String(memberObj?.employeeNotes !== undefined ? memberObj.employeeNotes : (memberObj?.notes || '')).trim();
  }

  getEmployeeNoteTooltipAttrs(empName, noteText, fallbackTitle = '') {
    const cleanNote = String(noteText || '').trim();
    const fallback = String(fallbackTitle || `Click to open Employee Profile for ${empName || ''}`).trim();
    const fullTitle = cleanNote ? `📝 Note: ${cleanNote}\n\n${fallback}` : fallback;
    return `data-emp-name="${this.escapeHtml(empName || '')}"${cleanNote ? ` data-emp-note="${this.escapeHtml(cleanNote)}"` : ''} title="${this.escapeHtml(fullTitle)}"`;
  }

  setPlannedEmployeeNote(empName, nextNote, options = {}) {
    const cleanName = String(empName || '').trim();
    const norm = cleanName.toLowerCase();
    if (!norm) return;
    const plan = options.plan || this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const cleanNote = String(nextNote || '').trim();
    const syncedLive = Boolean(options.syncedLive);
    if (!plan.employeeNotes) plan.employeeNotes = {};
    plan.employeeNotes[norm] = {
      text: cleanNote,
      edited: !syncedLive
    };

    const syncMemberProps = (m) => {
      if (!m || String(m.name || '').trim().toLowerCase() !== norm) return;
      m.notes = cleanNote;
      m._editedNotes = !syncedLive;
      m._clearedNotes = !cleanNote;
    };

    (plan.crews || []).forEach(c => {
      (c.members || []).forEach(syncMemberProps);
    });
    if (plan.sidePane) {
      ['planning', 'weeds', 'lightDuty', 'pendingHires'].forEach(cat => {
        (plan.sidePane[cat] || []).forEach(syncMemberProps);
      });
      ['vacation', 'quit'].forEach(cat => {
        (plan.sidePane[cat] || []).forEach(it => {
          if (it && String(it.name || '').trim().toLowerCase() === norm) {
            it.employeeNotes = cleanNote;
            it._editedNotes = !syncedLive;
            it._clearedNotes = !cleanNote;
          }
        });
      });
    }

    if (options.applyToLiveImmediately && this.db) {
      const empTable = this.db.getTable('employees');
      const liveRow = (empTable?.rows || []).find(r => String(r['Employee Name'] || r['Name'] || '').trim().toLowerCase() === norm);
      if (liveRow) {
        const headers = Array.isArray(empTable.headers) ? empTable.headers : [];
        const noteCol = headers.includes('Notes') ? 'Notes' : (headers.includes('Note') ? 'Note' : 'Notes');
        liveRow[noteCol] = cleanNote;
        liveRow['Notes'] = cleanNote;
        const rIdx = liveRow._rowIdx || (empTable.rows.indexOf(liveRow) + 2);
        if (typeof this.db.syncRowToRawGrid === 'function') {
          this.db.syncRowToRawGrid(empTable, liveRow);
        } else if (empTable.rawGrid && empTable.rawGrid[rIdx - 1] && headers.length > 0) {
          empTable.rawGrid[rIdx - 1] = headers.map(h => (liveRow[h] !== undefined ? liveRow[h] : ''));
        }
        this.db.addMutation({
          action: 'UPDATE_ROW',
          sheetName: empTable.name || 'Employees',
          tableKey: 'employees',
          itemIdentifier: cleanName,
          employeeName: cleanName,
          row: rIdx,
          updatedFields: { [noteCol]: cleanNote }
        });
        if (this.db._dirtyTablesForSync && typeof this.db._dirtyTablesForSync.add === 'function') {
          this.db._dirtyTablesForSync.add('employees');
        }
        plan.employeeNotes[norm].edited = false;
        (plan.crews || []).forEach(c => (c.members || []).forEach(m => {
          if (m && String(m.name || '').trim().toLowerCase() === norm) m._editedNotes = false;
        }));
      }
    }

    this.savePlan(plan);
  }

  promptEditEmployeeNote(empName) {
    if (typeof window !== 'undefined' && window.currentRoleMode === 'view_only') {
      if (typeof window.showToast === 'function') {
        window.showToast('View-Only Mode: Editing employee notes is disabled.', 'warning');
      }
      return;
    }
    const cleanName = String(empName || '').trim();
    const norm = cleanName.toLowerCase();
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!cleanName || !plan) return;

    const existingNote = this.getEmployeeNote(cleanName, plan);
    const empTable = this.db ? this.db.getTable('employees') : null;
    const hasLiveRow = Boolean((empTable?.rows || []).find(r => String(r['Employee Name'] || r['Name'] || '').trim().toLowerCase() === norm));
    const isCurrentWeek = this.selectedWeek === this.getCurrentWeekSundayStr();

    const modalId = 'modal-planning-employee-note';
    const prevModal = document.getElementById(modalId);
    if (prevModal) {
      if (typeof prevModal._cleanup === 'function') prevModal._cleanup();
      prevModal.remove();
    }

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.78) !important; display: flex; align-items: center; justify-content: center; z-index: 16500 !important; padding: 20px;';
    overlay.innerHTML = `
      <div class="modal-box" style="background: var(--bg-secondary, #1e293b); border: 1px solid rgba(245, 158, 11, 0.45); border-radius: 10px; max-width: 490px; width: 100%; box-shadow: 0 20px 45px rgba(0,0,0,0.75); overflow: hidden; color: #f8fafc;">
        <div style="padding: 14px 18px; background: rgba(245, 158, 11, 0.14); border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-size: 15px; font-weight: 800; color: #fbbf24; display: flex; align-items: center; gap: 6px;">
              <span>📝</span> Employee Note — ${this.escapeHtml(cleanName)}
            </div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">
              Week of ${this.escapeHtml(plan.weekDate || this.selectedWeek)} • Displays as a tooltip when hovering over the name
            </div>
          </div>
          <button type="button" id="btn-plan-emp-note-close" style="background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 2px 6px;">✕</button>
        </div>
        <div style="padding: 18px; display: flex; flex-direction: column; gap: 12px;">
          <div>
            <label for="planning-emp-note-textarea" style="font-size: 11.5px; font-weight: 700; color: #cbd5e1; display: block; margin-bottom: 6px;">
              Note:
            </label>
            <textarea id="planning-emp-note-textarea" rows="4" placeholder="Enter employee note (e.g. certs, equipment preference, schedule note, restrictions)..."
                      style="width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 6px; color: #f8fafc; padding: 10px 12px; font-size: 12.5px; line-height: 1.45; resize: vertical; font-family: inherit;">${this.escapeHtml(existingNote)}</textarea>
          </div>
          ${hasLiveRow ? `
            <label style="display: flex; align-items: flex-start; gap: 8px; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 6px; padding: 8px 10px; font-size: 11.5px; color: #cbd5e1; cursor: pointer;">
              <input type="checkbox" id="planning-emp-note-sync-live" ${isCurrentWeek ? 'checked' : ''} style="margin-top: 2px; cursor: pointer;">
              <span>
                <strong style="color: #93c5fd;">Update Live Employees sheet immediately</strong><br>
                <span style="font-size: 10.5px; color: #94a3b8;">If unchecked, this note stays staged in Crew Planning and updates Live when you Publish.</span>
              </span>
            </label>
          ` : ''}
        </div>
        <div style="padding: 12px 18px; border-top: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.22); display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <div>
            ${existingNote ? `<button type="button" id="btn-plan-emp-note-clear" class="btn btn-xs" style="background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.4); color: #fca5a5; padding: 6px 10px; border-radius: 6px; font-size: 11.5px; cursor: pointer; font-weight: 700;">🗑️ Clear Note</button>` : ''}
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" id="btn-plan-emp-note-cancel" class="btn btn-secondary" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">Cancel</button>
            <button type="button" id="btn-plan-emp-note-save" class="btn btn-primary" style="background: #d97706; border: none; color: #fff; font-weight: 700; font-size: 12px; padding: 6px 16px; border-radius: 6px; cursor: pointer;">💾 Save Note</button>
          </div>
        </div>
      </div>
    `;

    const closeModal = () => {
      if (typeof overlay._cleanup === 'function') overlay._cleanup();
      overlay.remove();
    };
    const commitSave = (valOverride) => {
      const taEl = document.getElementById('planning-emp-note-textarea');
      const nextVal = valOverride !== undefined ? valOverride : (taEl ? taEl.value : '');
      const syncLive = Boolean(document.getElementById('planning-emp-note-sync-live')?.checked);
      closeModal();
      this.setPlannedEmployeeNote(cleanName, nextVal, {
        plan,
        applyToLiveImmediately: syncLive,
        syncedLive: syncLive
      });
      this.refreshView();
      if (typeof window.showToast === 'function') {
        const cleanSaved = String(nextVal || '').trim();
        window.showToast(
          cleanSaved
            ? `📝 Saved note for ${cleanName}${syncLive ? ' (Live & Plan updated)' : ' (Staged in Plan)'}`
            : `🗑️ Cleared note for ${cleanName}${syncLive ? ' (Live & Plan updated)' : ''}`,
          'info'
        );
      }
    };
    const onKey = (evt) => {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        closeModal();
      } else if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
        evt.preventDefault();
        commitSave();
      }
    };
    overlay._cleanup = () => {
      window.removeEventListener('keydown', onKey);
    };
    window.addEventListener('keydown', onKey);
    overlay.onclick = (evt) => {
      if (evt.target === overlay) closeModal();
    };

    document.body.appendChild(overlay);
    document.getElementById('btn-plan-emp-note-close').onclick = closeModal;
    document.getElementById('btn-plan-emp-note-cancel').onclick = closeModal;
    document.getElementById('btn-plan-emp-note-save').onclick = () => commitSave();
    const clearBtn = document.getElementById('btn-plan-emp-note-clear');
    if (clearBtn) {
      clearBtn.onclick = () => commitSave('');
    }
    const ta = document.getElementById('planning-emp-note-textarea');
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    }
  }

  isMemberMatchingTerm(m, term, plan = null, liveNotesMap = null) {
    if (!m || !term) return false;
    const t = String(term).toLowerCase().trim();
    if (!t) return false;
    const resolvedEmpNote = this.getEmployeeNote(m.name, plan, m, liveNotesMap).toLowerCase();
    return (
      String(m.name || '').toLowerCase().includes(t) ||
      String(m.classification || '').toLowerCase().includes(t) ||
      String(m.role || '').toLowerCase().includes(t) ||
      String(m.jobNumber || m.slot || '').toLowerCase().includes(t) ||
      String(m.secondaryJob || '').toLowerCase().includes(t) ||
      String(m.location || '').toLowerCase().includes(t) ||
      String(m.notes || '').toLowerCase().includes(t) ||
      resolvedEmpNote.includes(t) ||
      String(m.departureDate || '').toLowerCase().includes(t) ||
      String(m.departureReason || '').toLowerCase().includes(t) ||
      String(m.vacationDateRange || '').toLowerCase().includes(t) ||
      String(m.vacationNotes || '').toLowerCase().includes(t)
    );
  }

  /**
   * Evaluates whether a crew card matches a search query across job#, location, foreman, job name, crew type, or member details.
   */
  isCrewMatchingSearch(crew, sTerm = '', plan = null, liveNotesMap = null) {
    if (!sTerm) return true;
    const term = sTerm.toLowerCase().trim();
    if (!term) return true;
    if (crew.jobNumber && crew.jobNumber.toLowerCase().includes(term)) return true;
    if (crew.location && crew.location.toLowerCase().includes(term)) return true;
    if (crew.foreman && crew.foreman.toLowerCase().includes(term)) return true;
    if (crew.jobName && crew.jobName.toLowerCase().includes(term)) return true;
    if (crew.crewType && crew.crewType.toLowerCase().includes(term)) return true;
    if (String(crew.status || 'Active').toLowerCase().includes(term)) return true;
    if (crew.schedule && crew.schedule.toLowerCase().includes(term)) return true;
    if (crew.notes && crew.notes.toLowerCase().includes(term)) return true;
    if (Array.isArray(crew.members)) {
      return crew.members.some(m => this.isMemberMatchingTerm(m, term, plan, liveNotesMap));
    }
    return false;
  }

  renderPlanningWorkspace(container, countBadge, targetWeekStr, incomingSearchTerm) {
    if (!container) return;
    if (typeof window !== 'undefined' && typeof window.initEmployeeNoteTooltip === 'function') {
      window.initEmployeeNoteTooltip();
    }

    // Run automated check for any employee whose last day has arrived (throttled to avoid per-keystroke scans)
    const nowMs = Date.now();
    if (!this._archivingInFlight && (!this._lastArchiveCheckAt || (nowMs - this._lastArchiveCheckAt) >= 15000)) {
      this._lastArchiveCheckAt = nowMs;
      this.checkAndArchiveDepartedEmployees();
    }

    if (!targetWeekStr) {
      targetWeekStr = this.selectedWeek || this.getDefaultPlanningWeekStr();
    }
    this.selectedWeek = targetWeekStr;

    const currentWeekStr = this.getCurrentWeekSundayStr();
    const planningWeekOptions = [
      {
        weekStr: currentWeekStr,
        label: `Week of ${currentWeekStr} (Current Week${!this.isWeekPublished(currentWeekStr) ? ' — Unpublished' : ''})`
      },
      ...this.getPlanningWeeks().map(p => ({
        weekStr: p.weekStr,
        label: p.offset === 1 ? `Week of ${p.weekStr} (Next Week)` : `Week of ${p.weekStr} (+${p.offset} Weeks Out)`
      }))
    ];
    if (!planningWeekOptions.some(w => w.weekStr === targetWeekStr)) {
      planningWeekOptions.unshift({
        weekStr: targetWeekStr,
        label: `Week of ${targetWeekStr}`
      });
    }

    if (incomingSearchTerm !== undefined) {
      this.searchTerm = incomingSearchTerm;
    } else if (window.sheetNavigator && window.sheetNavigator.searchTerm !== undefined) {
      this.searchTerm = window.sheetNavigator.searchTerm;
    }

    const plan = this.getPlanForWeek(targetWeekStr);

    // Baseline original locations and occurrence indexing for fast O(1) conditional styling
    const baselineMap = this.getOriginalEmployeeLocations();
    const occMap = this.getEmployeeOccurrencesMap(plan);

    // Calculate metrics & purple unconfirmed count
    let totalAssigned = 0;
    let purpleCount = 0;
    let yellowCount = 0;
    let cyanCount = 0;

    plan.crews.forEach(c => {
      totalAssigned += c.members.length;
      c.members.forEach(m => {
        const st = this.getEmployeePlanningStatus(m.name, c.jobNumber, null, plan, baselineMap, occMap);
        if (st.statusColor === 'purple') purpleCount++;
        else if (st.statusColor === 'yellow') yellowCount++;
        else if (st.statusColor === 'cyan') cyanCount++;
      });
    });

    const sp = plan.sidePane;
    ['planning', 'vacation', 'quit', 'weeds', 'lightDuty', 'pendingHires'].forEach(cat => {
      (sp[cat] || []).forEach(item => {
        const st = this.getEmployeePlanningStatus(item.name, null, cat, plan, baselineMap, occMap);
        if (st.statusColor === 'purple') purpleCount++;
        else if (st.statusColor === 'yellow') yellowCount++;
        else if (st.statusColor === 'cyan') cyanCount++;
      });
    });

    // Toolbar count badge hidden to remove redundancy as requested
    if (countBadge) {
      countBadge.style.display = 'none';
    }

    const sTerm = (this.searchTerm || '').toLowerCase().trim();
    const jtRowsForVisibility = (this.db ? this.db.getTable('job_tracking') : null)?.rows || null;
    const visibleCrews = (plan.crews || []).filter(c => !this.isCompletedCrewHidden(c, jtRowsForVisibility));

    // Capture scroll positions before replacing innerHTML so edits don't reset the page to the top
    const prevMain = container.querySelector('.planning-main-panel');
    const savedMainY = (prevMain && prevMain.scrollTop > 0) ? prevMain.scrollTop : (this._lastSavedMainY || 0);
    const savedMainX = (prevMain && prevMain.scrollLeft > 0) ? prevMain.scrollLeft : (this._lastSavedMainX || 0);
    const prevSide = container.querySelector('.side-pane-scroll-body');
    const savedSideY = (prevSide && prevSide.scrollTop > 0) ? prevSide.scrollTop : (this._lastSavedSideY || 0);
    const savedContainerY = container.scrollTop;
    const savedContainerX = container.scrollLeft;
    const savedWinY = window.scrollY || document.documentElement?.scrollTop || 0;
    const savedWinX = window.scrollX || document.documentElement?.scrollLeft || 0;

    container.innerHTML = `
      <div class="crew-planning-wrapper" style="display: flex; height: 100%; width: 100%; overflow: hidden; background: var(--bg-primary, #0f172a); color: var(--text-primary, #f8fafc); box-sizing: border-box;">
        
        <!-- Main Left/Center Planning Area -->
        <div class="planning-main-panel" style="flex: 1; display: flex; flex-direction: column; height: 100%; min-width: 0; overflow-y: auto; padding: 14px 18px; box-sizing: border-box;">
          
          <!-- Planning Header Toolbar -->
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; background: var(--bg-secondary, #1e293b); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); border-radius: 8px; padding: 10px 14px; margin-bottom: 14px;">
            
            <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
              <div style="font-size: 15px; font-weight: 800; color: #60a5fa; display: flex; align-items: center; gap: 6px;">
                <span>🏗️</span>
                <span>Crew Structure Planning</span>
              </div>
              <div style="display: inline-flex; align-items: center; gap: 6px; background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(96, 165, 250, 0.4); border-radius: 6px; padding: 3px 8px;">
                <span style="font-size: 11px; font-weight: 700; color: #93c5fd;">📅 Editing Week:</span>
                <select onchange="window.crewPlanningEngine.selectPlanningWeek(this.value)"
                        style="background: transparent; border: none; color: #f8fafc; font-size: 12px; font-weight: 800; cursor: pointer; outline: none;">
                  ${planningWeekOptions.map(w => `
                    <option value="${this.escapeHtml(w.weekStr)}" ${w.weekStr === targetWeekStr ? 'selected' : ''} style="background: #0f172a; color: #f8fafc;">
                      ${this.escapeHtml(w.label)}
                    </option>
                  `).join('')}
                </select>
              </div>
              <span class="badge" style="background: rgba(245, 158, 11, 0.18); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px;">
                ${plan.status === 'published' ? '🟢 Published Plan' : '🟡 Draft Plan (Pre-Publish)'}
              </span>

              <!-- Status Counter Badges -->
              <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700;">
                ${purpleCount > 0 ? `
                  <span class="badge" style="background: rgba(147, 51, 234, 0.25); color: #d8b4fe; border: 1px solid #a855f7; padding: 2px 8px; border-radius: 4px;" title="Unconfirmed moved or duplicated employees — must be confirmed before publishing">
                    🟣 ${purpleCount} Unconfirmed
                  </span>
                ` : `
                  <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981; padding: 2px 8px; border-radius: 4px;">
                    ✅ 0 Unconfirmed
                  </span>
                `}
                ${yellowCount > 0 ? `
                  <span class="badge" style="background: rgba(234, 179, 8, 0.2); color: #fde047; border: 1px solid #eab308; padding: 2px 8px; border-radius: 4px;" title="Confirmed moved positions (will carry through as yellow once published)">
                    🟡 ${yellowCount} Confirmed
                  </span>
                ` : ''}
                ${cyanCount > 0 ? `
                  <span class="badge" style="background: rgba(6, 182, 212, 0.2); color: #67e8f9; border: 1px solid #06b6d4; padding: 2px 8px; border-radius: 4px;" title="Crew members split across a 1st and 2nd job">
                    💠 ${cyanCount} 2nd Job
                  </span>
                ` : ''}
                ${sTerm ? `
                  <span class="badge" style="background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid #38bdf8; padding: 2px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 5px;" title="Filtered by search query: '${this.escapeHtml(sTerm)}'">
                    🔍 "${this.escapeHtml(sTerm)}" (${visibleCrews.filter(c => this.isCrewMatchingSearch(c, sTerm)).length} of ${visibleCrews.length} crews)
                    <button onclick="const si = document.getElementById('sheet-search-input'); if (si) { si.value = ''; si.dispatchEvent(new Event('input')); }" style="background: transparent; border: none; color: #38bdf8; font-size: 11px; font-weight: 800; cursor: pointer; padding: 0 2px; line-height: 1;" title="Clear search">✕</button>
                  </span>
                ` : ''}
              </div>

              <div style="font-size: 11.5px; color: var(--text-muted, #94a3b8); display: flex; align-items: center; gap: 6px;">
                <span>👥 ${totalAssigned} Assigned</span> •
                <span>🚜 ${visibleCrews.length} Crews</span> •
                <span>🏖️ ${plan.sidePane.vacation.length} Vacation</span>
              </div>
            </div>

            <!-- Action Controls -->
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <button class="btn btn-secondary" onclick="window.crewPlanningEngine.cloneFromCurrentRoster()" style="font-size: 11.5px; font-weight: 600; padding: 5px 10px; display: inline-flex; align-items: center; gap: 5px;" title="Reset / Clone this planned week from the live current roster">
                <span>📋</span> Reset from Live
              </button>
              <button class="btn btn-secondary" onclick="window.crewPlanningEngine.promptAddNewPlannedCrew()" style="font-size: 11.5px; font-weight: 600; padding: 5px 10px; display: inline-flex; align-items: center; gap: 5px;" title="Add a new planned field crew for this week">
                <span>➕</span> Add Crew
              </button>
              ${purpleCount > 0 ? `
                <button class="btn btn-secondary" onclick="window.crewPlanningEngine.confirmAllPurpleMembers()" style="font-size: 11px; font-weight: 700; padding: 5px 9px; color: #fde047; border-color: rgba(234, 179, 8, 0.4); background: rgba(234, 179, 8, 0.1);" title="Confirm all unconfirmed purple employees at once">
                  ✅ Confirm All (${purpleCount})
                </button>
              ` : ''}
              <button class="btn btn-primary" onclick="window.crewPlanningEngine.openPublishModal()" style="font-size: 12px; font-weight: 800; padding: 6px 14px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border: none; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.35); display: inline-flex; align-items: center; gap: 6px; cursor: pointer;" title="Publish this crew structure to live database (all purple must be confirmed first)">
                <span>🚀</span> Publish Crew Structure
              </button>
              <button class="btn btn-secondary" onclick="window.crewPlanningEngine.toggleSidebar()" style="font-size: 11.5px; padding: 5px 10px; display: inline-flex; align-items: center; gap: 5px; border-color: rgba(255,255,255,0.15);" title="Toggle Staging Side Pane">
                <span>${this.isSidebarCollapsed ? '⇤ Show Side Pane' : '⇥ Hide Side Pane'}</span>
              </button>
            </div>
          </div>

          <!-- Planned Crews Grid -->
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
              <div style="font-size: 12px; font-weight: 800; text-transform: uppercase; color: var(--text-muted, #94a3b8); letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
                <span>🚜</span> Planned Field Crews (${visibleCrews.length})
              </div>
              <div style="font-size: 11px; color: var(--text-muted, #94a3b8); font-style: italic; display: flex; align-items: center; gap: 8px;">
                <span>💡 Drag ⠿ to reorder crews • Drag members between crews • Hold Alt/Ctrl+Drag to duplicate • Click 🟣/🟡 to confirm</span>
              </div>
            </div>

            <div class="planned-crews-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px;">
              ${(() => {
                const matchingCrews = visibleCrews.filter(c => this.isCrewMatchingSearch(c, sTerm));
                if (matchingCrews.length === 0 && sTerm) {
                  return `
                    <div style="grid-column: 1 / -1; padding: 36px 20px; text-align: center; color: var(--text-muted, #94a3b8); background: rgba(30, 41, 59, 0.4); border: 1px dashed rgba(255,255,255,0.12); border-radius: 8px;">
                      <div style="font-size: 28px; margin-bottom: 8px;">🔍</div>
                      <div style="font-size: 14px; font-weight: 700; color: #f8fafc; margin-bottom: 4px;">No planned field crews match "${this.escapeHtml(sTerm)}"</div>
                      <div style="font-size: 12px; color: #94a3b8; margin-bottom: 12px;">Check the Staging Side Pane on the right, or clear the search to view all ${visibleCrews.length} crews.</div>
                      <button class="btn btn-secondary" onclick="const si = document.getElementById('sheet-search-input'); if (si) { si.value = ''; si.dispatchEvent(new Event('input')); }" style="font-size: 11.5px; padding: 4px 12px; display: inline-flex; align-items: center; gap: 4px;">
                        <span>✕</span> Clear Search
                      </button>
                    </div>
                  `;
                }
                return matchingCrews.map(crew => this.renderPlannedCrewCard(crew, sTerm, plan, baselineMap, occMap)).join('');
              })()}
            </div>
          </div>
        </div>

        <!-- Collapsible Staging Side Pane -->
        <div class="planning-side-pane" style="width: ${this.isSidebarCollapsed ? '44px' : '360px'}; min-width: ${this.isSidebarCollapsed ? '44px' : '360px'}; background: var(--bg-secondary, #1e293b); border-left: 1px solid var(--border-color, rgba(255,255,255,0.1)); display: flex; flex-direction: column; height: 100%; transition: width 0.2s ease, min-width 0.2s ease; box-sizing: border-box; position: relative;">
          ${this.isSidebarCollapsed ? this.renderCollapsedSidePane() : this.renderExpandedSidePane(plan, baselineMap, occMap, sTerm)}
        </div>

      </div>
    `;

    // Attach interactive drag & drop listeners
    this.attachPlanningDragHandlers(container);

    // Track real-time scroll offsets
    const newMain = container.querySelector('.planning-main-panel');
    if (newMain) {
      newMain.addEventListener('scroll', () => {
        this._lastSavedMainY = newMain.scrollTop;
        this._lastSavedMainX = newMain.scrollLeft;
      }, { passive: true });
    }
    const newSide = container.querySelector('.side-pane-scroll-body');
    if (newSide) {
      newSide.addEventListener('scroll', () => {
        this._lastSavedSideY = newSide.scrollTop;
      }, { passive: true });
    }

    // Restore scroll positions across view refreshes so edits never jump to top
    const restoreScroll = () => {
      const curMain = container.querySelector('.planning-main-panel');
      if (curMain) {
        if (sTerm) {
          curMain.scrollTop = 0;
        } else {
          if (savedMainY > 0) curMain.scrollTop = savedMainY;
          if (savedMainX > 0) curMain.scrollLeft = savedMainX;
        }
      }
      const curSide = container.querySelector('.side-pane-scroll-body');
      if (curSide) {
        if (sTerm) {
          curSide.scrollTop = 0;
        } else if (savedSideY > 0) {
          curSide.scrollTop = savedSideY;
        }
      }
      if (container && !sTerm) {
        if (savedContainerY > 0) container.scrollTop = savedContainerY;
        if (savedContainerX > 0) container.scrollLeft = savedContainerX;
      }
      if (!sTerm && !this.editingNotesJob && (savedWinY > 0 || savedWinX > 0)) {
        window.scrollTo({ top: savedWinY, left: savedWinX, behavior: 'instant' });
      }
    };
    restoreScroll();
    requestAnimationFrame(restoreScroll);
    if (!this.editingNotesJob) {
      setTimeout(restoreScroll, 35);
    }
  }

  /**
   * Renders a single planned crew card with member rows and conditional coloring (Purple / Yellow / Normal).
   */
  getCrewStatusMeta(status) {
    const raw = String(status || 'Active').trim() || 'Active';
    const low = raw.toLowerCase();
    if (low === 'active') {
      return {
        label: 'Active',
        icon: '🟢',
        bg: 'rgba(16, 185, 129, 0.16)',
        color: '#34d399',
        border: 'rgba(16, 185, 129, 0.4)'
      };
    }
    if (low === 'pending start' || low === 'pending') {
      return {
        label: low === 'pending' ? 'Pending Start' : raw,
        icon: '🟡',
        bg: 'rgba(245, 158, 11, 0.16)',
        color: '#fbbf24',
        border: 'rgba(245, 158, 11, 0.42)'
      };
    }
    if (low === 'on hold' || low === 'hold' || low === 'paused') {
      return {
        label: 'On Hold',
        icon: '⏸️',
        bg: 'rgba(100, 116, 139, 0.28)',
        color: '#cbd5e1',
        border: 'rgba(148, 163, 184, 0.5)'
      };
    }
    if (low === 'completed' || low === 'closed') {
      return {
        label: raw,
        icon: '🏁',
        bg: 'rgba(59, 130, 246, 0.16)',
        color: '#93c5fd',
        border: 'rgba(59, 130, 246, 0.4)'
      };
    }
    return {
      label: raw,
      icon: '🏷️',
      bg: 'rgba(168, 85, 247, 0.16)',
      color: '#d8b4fe',
      border: 'rgba(168, 85, 247, 0.38)'
    };
  }

  getCrewStatusBadgeHtml(status, interactiveJobNum = '') {
    const meta = this.getCrewStatusMeta(status);
    const isCompleted = this.isCompletedStatus(meta.label);
    const tooltip = isCompleted
      ? `Job Status: ${meta.label} — Card hides automatically once all members are moved off${interactiveJobNum ? ' (Click to change status)' : ''}`
      : `Job Status: ${meta.label}${interactiveJobNum ? ' — Click to change status' : ''}`;
    const clickAttr = interactiveJobNum
      ? ` onclick="event.stopPropagation(); window.crewPlanningEngine.promptEditPlannedCrew('${this.escapeJs(interactiveJobNum)}')" style="background: ${meta.bg}; color: ${meta.color}; border: 1px solid ${meta.border}; font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;"`
      : ` style="background: ${meta.bg}; color: ${meta.color}; border: 1px solid ${meta.border}; font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 3px;"`;
    return `<span class="badge crew-status-badge"${clickAttr} title="${this.escapeHtml(tooltip)}">${meta.icon} ${this.escapeHtml(meta.label)}</span>`;
  }

  renderPlannedCrewCard(crew, sTerm = '', plan, baselineMap, occMap, liveNotesMap = null) {
    const resolvedNotesMap = liveNotesMap || this.buildLiveEmployeeNotesMap();
    if (this.isCompletedCrewHidden(crew) || !this.isCrewMatchingSearch(crew, sTerm, plan, resolvedNotesMap)) return '';

    const skipDays = this.getCrewSkipDays(crew);
    const dayPillsConfig = [
      { key: 'Mon', label: 'M', isWork: !skipDays.isSkipMon },
      { key: 'Tue', label: 'T', isWork: !skipDays.isSkipTue },
      { key: 'Wed', label: 'W', isWork: !skipDays.isSkipWed },
      { key: 'Thu', label: 'Th', isWork: !skipDays.isSkipThu },
      { key: 'Fri', label: 'F', isWork: !skipDays.isSkipFri },
      { key: 'Sat', label: 'Sa', isWork: !skipDays.isSkipSat },
      { key: 'Sun', label: 'Su', isWork: !skipDays.isSkipSun }
    ];

    const dayPillsHtml = dayPillsConfig.map(d => {
      const bg = d.isWork ? '#10b981' : 'rgba(15, 23, 42, 0.6)';
      const border = d.isWork ? '#059669' : 'rgba(255, 255, 255, 0.12)';
      const color = d.isWork ? '#ffffff' : '#64748b';
      const tooltip = d.isWork
        ? `${d.key}: Working day (Click to set as Off day)`
        : `${d.key}: Off day (Click to set as Working day)`;

      return `
        <div style="width: 22px; height: 20px; font-size: 9.5px; font-weight: 700; border-radius: 4px; border: 1px solid ${border}; background: ${bg}; color: ${color}; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: transform 0.1s ease; user-select: none;"
             onclick="event.stopPropagation(); window.crewPlanningEngine.toggleCrewDayWorking('${this.escapeJs(crew.jobNumber)}', '${d.key}')"
             title="${tooltip}"
             onmouseover="this.style.transform='scale(1.15)';"
             onmouseout="this.style.transform='scale(1)';">
          ${d.label}
        </div>
      `;
    }).join('');

    const term = (sTerm || '').toLowerCase().trim();
    const effectiveStatus = String(crew.status || '').trim() || 'Active';
    const isCrewHeaderMatch = Boolean(term && (
      (crew.jobNumber && crew.jobNumber.toLowerCase().includes(term)) ||
      (crew.location && crew.location.toLowerCase().includes(term)) ||
      (crew.foreman && crew.foreman.toLowerCase().includes(term)) ||
      (crew.jobName && crew.jobName.toLowerCase().includes(term)) ||
      (crew.crewType && crew.crewType.toLowerCase().includes(term)) ||
      effectiveStatus.toLowerCase().includes(term) ||
      (crew.schedule && crew.schedule.toLowerCase().includes(term))
    ));
    const isCrewNotesMatch = Boolean(term && crew.notes && crew.notes.toLowerCase().includes(term));
    const hasMemberMatch = Boolean(term && Array.isArray(crew.members) && crew.members.some(m => this.isMemberMatchingTerm(m, term, plan, resolvedNotesMap)));

    const isOnHold = ['on hold', 'hold', 'paused'].includes(effectiveStatus.toLowerCase());
    let cardBg = isOnHold ? '' : 'background: rgba(30, 41, 59, 0.7);';
    let cardBorder = isOnHold ? '' : 'border: 1px solid rgba(59, 130, 246, 0.35);';
    let cardShadow = 'box-shadow: 0 1px 4px rgba(0,0,0,0.25);';
    if (hasMemberMatch) {
      cardBorder = 'border: 1.5px solid #f59e0b;';
      cardShadow = 'box-shadow: 0 0 12px rgba(245, 158, 11, 0.28);';
    } else if (isCrewHeaderMatch || isCrewNotesMatch) {
      cardBorder = 'border: 1.5px solid #38bdf8;';
      cardShadow = 'box-shadow: 0 0 12px rgba(56, 189, 248, 0.28);';
    }

    return `
      <div class="field-crew-card planned-crew-card${isOnHold ? ' crew-card-on-hold' : ''}"
           data-crew-job="${this.escapeHtml(crew.jobNumber)}"
           style="${cardBg} ${cardBorder} border-radius: 8px; padding: 12px; display: flex; flex-direction: column; ${cardShadow} position: relative; transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease, opacity 0.15s ease, filter 0.15s ease;">
        
        <!-- Crew Header (Draggable to Reorder) -->
        <div class="planned-crew-header"
             draggable="true"
             data-crew-job="${this.escapeHtml(crew.jobNumber)}"
             style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 7px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; cursor: grab; user-select: none;"
             title="Drag to reorder this crew card on the board">
          <div style="display: flex; align-items: flex-start; gap: 6px;">
            <div class="crew-card-drag-handle"
                 style="cursor: grab; display: flex; align-items: center; justify-content: center; width: 18px; height: 22px; border-radius: 3px; color: #94a3b8; font-size: 14px; user-select: none; margin-top: 1px; transition: background 0.15s, color 0.15s;"
                 title="Drag this crew to reorder it on the board"
                 onmouseover="this.style.color='#60a5fa'; this.style.background='rgba(96,165,250,0.15)';"
                 onmouseout="this.style.color='#94a3b8'; this.style.background='transparent';">
              ⠿
            </div>
            <div>
              <div style="display: flex; align-items: center; gap: 6px; font-weight: 800; font-size: 14px; color: #60a5fa;">
                <span>🚜</span>
                <span>${this.escapeHtml(crew.jobNumber)}</span>
                ${isCrewHeaderMatch ? `
                  <span class="badge" style="background: rgba(56, 189, 248, 0.25); color: #7dd3fc; border: 1px solid #38bdf8; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px;">
                    🔍 Match
                  </span>
                ` : ''}
                ${crew.jobName ? `<span style="font-size: 11px; font-weight: 600; color: #94a3b8;">— ${this.escapeHtml(crew.jobName)}</span>` : ''}
              </div>
              <div style="font-size: 11px; color: var(--text-muted, #94a3b8); margin-top: 2px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span>📍 ${this.escapeHtml(crew.location || 'Helena')}</span>
                <span style="color: rgba(255,255,255,0.25);">•</span>
                <span style="color: ${this.getCrewTypeInfo(crew.crewType).color}; font-weight: 700; display: inline-flex; align-items: center; gap: 3px;">
                  <span>${this.getCrewTypeInfo(crew.crewType).icon}</span>
                  <span>${this.escapeHtml(crew.crewType || 'Electric')}</span>
                </span>
                ${this.getCrewStatusBadgeHtml(effectiveStatus, crew.jobNumber)}
              </div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 5px;">
            <!-- Board Order Quick Arrows -->
            <div style="display: flex; align-items: center; gap: 2px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; padding: 1px 3px;">
              <button class="btn btn-xs" onclick="event.stopPropagation(); window.crewPlanningEngine.moveCrewOrder('${this.escapeJs(crew.jobNumber)}', -1)" style="background: transparent; border: none; color: #94a3b8; font-size: 10px; padding: 1px 4px; cursor: pointer; border-radius: 2px;" title="Move crew earlier (left/up) on board" onmouseover="this.style.color='#60a5fa'" onmouseout="this.style.color='#94a3b8'">◀</button>
              <button class="btn btn-xs" onclick="event.stopPropagation(); window.crewPlanningEngine.moveCrewOrder('${this.escapeJs(crew.jobNumber)}', 1)" style="background: transparent; border: none; color: #94a3b8; font-size: 10px; padding: 1px 4px; cursor: pointer; border-radius: 2px;" title="Move crew later (right/down) on board" onmouseover="this.style.color='#60a5fa'" onmouseout="this.style.color='#94a3b8'">▶</button>
            </div>
            <button class="btn btn-xs" onclick="event.stopPropagation(); window.crewPlanningEngine.promptEditPlannedCrew('${this.escapeJs(crew.jobNumber)}')" style="font-size: 10.5px; font-weight: 700; padding: 2px 7px; background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.35); color: #93c5fd; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Edit planned crew metadata (Location, Job Name, Discipline, Status, Schedule)">
              ✏️ Edit
            </button>
            <span class="badge" style="background: rgba(59, 130, 246, 0.18); color: #93c5fd; font-size: 10.5px; font-weight: 700; padding: 2px 6px; border-radius: 4px;">
              ${crew.members.length} Members
            </span>
          </div>
        </div>

        <!-- Schedule & Working Days Bar -->
        <div style="background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 5px; padding: 4px 7px; margin-bottom: 7px; display: flex; align-items: center; justify-content: space-between; gap: 6px;">
          <div style="display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1;">
            <span style="font-size: 11px;">🕒</span>
            <span style="font-size: 10.5px; font-weight: 700; color: #93c5fd; background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.3); padding: 1px 6px; border-radius: 3px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                  onclick="event.stopPropagation(); window.crewPlanningEngine.openScheduleEditModal('${this.escapeJs(crew.jobNumber)}')"
                  title="Click to adjust schedule preset or hours (${this.escapeHtml(crew.schedule || 'Mon-Thu (4 10s)')})">
              ${this.escapeHtml(crew.schedule || 'Mon-Thu (4 10s)')} ✏️
            </span>
          </div>
          <!-- Clickable Day Pills -->
          <div style="display: flex; gap: 2.5px; align-items: center; flex-shrink: 0;">
            ${dayPillsHtml}
          </div>
        </div>

        <!-- Foreman Row -->
        <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.2); padding: 4px 8px; border-radius: 4px; margin-bottom: 8px; font-size: 11.5px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-weight: 700; color: #94a3b8;">Foreman:</span>
            ${crew.foreman ? `
              <span style="color: #f472b6; font-weight: 700; display: inline-flex; align-items: center; gap: 4px; cursor: pointer;"
                    onclick="event.stopPropagation(); if(window.employeeProfileEngine){window.employeeProfileEngine.openProfileModal('${this.escapeJs(crew.foreman)}');}"
                    onmouseover="this.style.color='#60a5fa'; this.style.textDecoration='underline';"
                    onmouseout="this.style.color='#f472b6'; this.style.textDecoration='none';"
                    ${this.getEmployeeNoteTooltipAttrs(crew.foreman, this.getEmployeeNote(crew.foreman, plan, null, resolvedNotesMap), `Click to open Employee Profile for ${crew.foreman}`)}>
                <span>👑</span> ${this.escapeHtml(crew.foreman)}
              </span>
            ` : `<span style="color: #64748b; font-style: italic;">(None designated)</span>`}
          </div>
          <button class="btn btn-xs" onclick="window.crewPlanningEngine.promptChangePlannedForeman('${this.escapeJs(crew.jobNumber)}')" style="font-size: 10px; padding: 1px 6px; background: transparent; border: 1px solid rgba(255,255,255,0.1); color: #94a3b8; border-radius: 3px; cursor: pointer;">
            Change
          </button>
        </div>

        <!-- Member Drop Zone -->
        <div class="crew-drop-zone planned-drop-zone"
             data-crew-job="${this.escapeHtml(crew.jobNumber)}"
             style="min-height: 48px; border-radius: 6px; padding: 2px; display: flex; flex-direction: column; gap: 3px;">
          ${crew.members.length > 0 ? crew.members.map(m => {
            const isForeman = this.isCrewForeman(crew, m.name);
            const statusInfo = this.getEmployeePlanningStatus(m.name, crew.jobNumber, null, plan, baselineMap, occMap);
            const empNote = this.getEmployeeNote(m.name, plan, m, resolvedNotesMap);

            const isMemberMatch = this.isMemberMatchingTerm(m, term, plan, resolvedNotesMap);

            // Conditional Row Styles
            let rowBg = 'transparent';
            let rowBorder = 'border-bottom: 1px dashed rgba(255,255,255,0.06);';
            let statusBadge = '';

            if (isMemberMatch) {
              rowBg = 'background: rgba(245, 158, 11, 0.22);';
              rowBorder = 'border: 1.5px solid #f59e0b; border-left: 4px solid #f59e0b; box-shadow: 0 0 8px rgba(245, 158, 11, 0.3);';
            } else if (statusInfo.statusColor === 'purple') {
              rowBg = 'background: rgba(147, 51, 234, 0.16);';
              rowBorder = 'border: 1px solid rgba(168, 85, 247, 0.45); border-left: 3.5px solid #c084fc;';
              statusBadge = `
                <span class="badge"
                      onclick="event.stopPropagation(); window.crewPlanningEngine.toggleConfirmMemberPosition('${this.escapeJs(m.name)}', '${this.escapeJs(crew.jobNumber)}')"
                      style="background: rgba(147, 51, 234, 0.3); color: #d8b4fe; border: 1px solid #c084fc; font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;"
                      title="${this.escapeHtml(statusInfo.title)}">
                  🟣 ${this.escapeHtml(statusInfo.badgeText)} <span style="font-size: 8.5px; opacity: 0.85;">(Confirm)</span>
                </span>
              `;
            } else if (statusInfo.statusColor === 'yellow') {
              rowBg = 'background: rgba(234, 179, 8, 0.16);';
              rowBorder = 'border: 1px solid rgba(234, 179, 8, 0.45); border-left: 3.5px solid #facc15;';
              statusBadge = `
                <span class="badge"
                      onclick="event.stopPropagation(); window.crewPlanningEngine.toggleConfirmMemberPosition('${this.escapeJs(m.name)}', '${this.escapeJs(crew.jobNumber)}')"
                      style="background: rgba(234, 179, 8, 0.28); color: #fde047; border: 1px solid #facc15; font-size: 9.5px; font-weight: 800; padding: 1px 6px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;"
                      title="${this.escapeHtml(statusInfo.title)} — Click to unconfirm">
                  🟡 ${this.escapeHtml(statusInfo.badgeText || 'Confirmed')}
                </span>
              `;
            } else if (statusInfo.statusColor === 'cyan') {
              rowBg = 'background: rgba(6, 182, 212, 0.12);';
              rowBorder = 'border: 1px solid rgba(34, 211, 238, 0.42); border-left: 3.5px solid #06b6d4;';
              if (statusInfo.badgeText === 'Confirmed 2nd Job') {
                statusBadge = `
                  <span class="badge"
                        onclick="event.stopPropagation(); window.crewPlanningEngine.toggleConfirmMemberPosition('${this.escapeJs(m.name)}', '${this.escapeJs(crew.jobNumber)}')"
                        style="background: rgba(6, 182, 212, 0.24); color: #67e8f9; border: 1px solid #06b6d4; font-size: 9.5px; font-weight: 800; padding: 1px 6px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;"
                        title="${this.escapeHtml(statusInfo.title)} — Click to unconfirm">
                    💠 ${this.escapeHtml(statusInfo.badgeText)}
                  </span>
                `;
              }
            }

            const quitEntry = (plan.sidePane?.quit || []).find(q => q.name.trim().toLowerCase() === m.name.trim().toLowerCase());
            const departureDate = m.departureDate || (quitEntry?.isScheduledDeparture ? quitEntry.departureDate : null);
            const departureReason = m.departureReason || quitEntry?.departureReason || 'Quit';

            const vacEntry = (plan.sidePane?.vacation || []).find(v => v.name.trim().toLowerCase() === m.name.trim().toLowerCase());
            const vacDateRange = m.vacationDateRange || vacEntry?.dateRange || vacEntry?.vacationStartDate || null;
            const isFutureVac = Boolean(m.isFutureVacation || vacEntry?.isFutureVacation);
            const vacNotes = m.vacationNotes || vacEntry?.notes || '';

            let secondJobPill = '';
            if (statusInfo.isMultiLocation) {
              const otherOcc = (statusInfo.occurrences || []).find(o => o.baseJob && o.baseJob.toLowerCase() !== crew.jobNumber.toLowerCase());
              if (otherOcc) {
                const jtTable = this.db ? this.db.getTable('job_tracking') : null;
                const getCrewStatus = (bj) => {
                  if (!bj || !jtTable) return '';
                  const jRow = (jtTable.rows || []).find(j => {
                    const jn = String(j['Job Number'] || j['Job #'] || '').trim().replace(/\.\d+.*$/, '');
                    return jn.toLowerCase() === String(bj).trim().toLowerCase();
                  });
                  return String(jRow?.['Status'] || '').trim();
                };
                const isPendingOrHold = (st) => /pending|hold/i.test(st);

                const currentStatus = getCrewStatus(crew.jobNumber);
                const otherStatus = getCrewStatus(otherOcc.baseJob);

                let pillType = '2nd';
                let pillTitle = `Secondary Crew Assignment: ${otherOcc.slot || otherOcc.baseJob}`;
                if (isPendingOrHold(currentStatus) && !isPendingOrHold(otherStatus)) {
                  pillType = '1st';
                  pillTitle = `Primary (Active) Job: Crew ${otherOcc.slot || otherOcc.baseJob}`;
                } else if (!isPendingOrHold(currentStatus) && isPendingOrHold(otherStatus)) {
                  pillType = '2nd';
                  pillTitle = `Secondary (Pending) Job: Crew ${otherOcc.slot || otherOcc.baseJob}`;
                }

                const otherSlotText = otherOcc.slot || otherOcc.baseJob;
                const otherPlannedCrew = (plan.crews || []).find(c => String(c.jobNumber || '').trim().toLowerCase() === String(otherOcc.baseJob || '').trim().toLowerCase());
                const otherJtRow = (jtTable?.rows || []).find(j => String(j['Job Number'] || j['Job #'] || '').trim().replace(/\.\d+.*$/, '').toLowerCase() === String(otherOcc.baseJob || '').trim().toLowerCase());
                const otherJobName = String(otherPlannedCrew?.jobName || otherJtRow?.['Job Name'] || '').trim();
                const otherLabelText = (otherJobName && otherJobName.toLowerCase() !== String(otherOcc.baseJob || '').trim().toLowerCase())
                  ? `${otherSlotText} (${otherJobName})`
                  : otherSlotText;
                secondJobPill = `
                  <span class="badge second-job-pill"
                        onclick="event.stopPropagation(); window.crewPlanningEngine.promptEditPlannedSecondJob('${this.escapeJs(m.name)}', '${this.escapeJs(crew.jobNumber)}')"
                        style="background: rgba(6, 182, 212, 0.22); color: #67e8f9; border: 1px solid rgba(34, 211, 238, 0.55); font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 3px; cursor: pointer; transition: all 0.15s ease; display: inline-flex; align-items: center; gap: 3px;"
                        onmouseover="this.style.background='rgba(6, 182, 212, 0.38)'; this.style.borderColor='#22d3ee';"
                        onmouseout="this.style.background='rgba(6, 182, 212, 0.22)'; this.style.borderColor='rgba(34, 211, 238, 0.55)';"
                        title="${this.escapeHtml(pillTitle)} — Click to edit, swap, or remove 1st/2nd job">
                    ⚡ ${pillType}: ${this.escapeHtml(otherLabelText)} <span style="font-size: 8.5px; opacity: 0.85;">✏️</span>
                  </span>
                `;
              }
            }

            return `
              <div class="crew-member-row planned-member-row ${statusInfo.statusColor !== 'normal' ? 'member-row-' + statusInfo.statusColor : ''}"
                   draggable="true"
                   data-emp-name="${this.escapeHtml(m.name)}"
                   data-job-number="${this.escapeHtml(m.slot || crew.jobNumber)}"
                   data-base-job="${this.escapeHtml(crew.jobNumber)}"
                   style="display: flex; justify-content: space-between; align-items: center; padding: 4px 6px; ${rowBorder} ${rowBg} font-size: 12px; border-radius: 4px; cursor: grab; transition: all 0.15s ease;">
                <div style="display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; flex-wrap: wrap;">
                  <span class="drag-handle" style="color: #64748b; font-size: 13px; user-select: none;" title="Drag up/down to reorder • Drag to other crew • Alt/Ctrl+Drag to duplicate">⠿</span>
                  <span style="font-family: monospace; font-size: 11px; color: #94a3b8;">${this.escapeHtml(m.slot || '—')}</span>
                  <span style="font-weight: ${isForeman ? '700' : '500'}; color: ${isForeman ? '#f472b6' : 'inherit'}; cursor: pointer;"
                        onclick="event.stopPropagation(); if(window.employeeProfileEngine){window.employeeProfileEngine.openProfileModal('${this.escapeJs(m.name)}');}"
                        onmouseover="this.style.color='#60a5fa'; this.style.textDecoration='underline';"
                        onmouseout="this.style.color='${isForeman ? '#f472b6' : 'inherit'}'; this.style.textDecoration='none';"
                        ${this.getEmployeeNoteTooltipAttrs(m.name, empNote, `Click to open Employee Profile for ${m.name}`)}>
                    ${isForeman ? '👑 ' : ''}${this.escapeHtml(m.name)}
                  </span>
                  ${isMemberMatch ? `
                    <span class="badge" style="background: #f59e0b; color: #000; font-size: 9px; font-weight: 800; padding: 1px 5px; border-radius: 3px; box-shadow: 0 1px 3px rgba(0,0,0,0.3);">
                      🔍 Match
                    </span>
                  ` : ''}
                  ${(m.isPending || (m.hireDate && this.isFutureHireDate(m.hireDate))) ? `
                    <span class="badge" style="background: rgba(245, 158, 11, 0.18); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); font-size: 9.5px; font-weight: 700; padding: 1px 5px; border-radius: 3px;" title="Pending Start${m.hireDate ? ': ' + this.escapeHtml(m.hireDate) : ''}">
                      ⏳ ${m.hireDate ? 'Starts ' + this.escapeHtml(m.hireDate) : 'Pending'}
                    </span>
                  ` : ''}
                  ${secondJobPill}
                  ${departureDate ? `
                    <span class="badge"
                          onclick="event.stopPropagation(); window.crewPlanningEngine.editQuitDeparture('${this.escapeJs(m.name)}')"
                          style="background: rgba(239, 68, 68, 0.22); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4); font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;"
                          title="Scheduled Last Working Day: ${this.escapeHtml(departureDate)} (${this.escapeHtml(departureReason)}) — Click to edit">
                      🚪 Last Day: ${this.escapeHtml(departureDate)}
                    </span>
                  ` : ''}
                  ${(vacDateRange || vacEntry) ? `
                    <span class="badge"
                          onclick="event.stopPropagation(); window.crewPlanningEngine.editVacationSchedule('${this.escapeJs(m.name)}')"
                          style="background: rgba(245, 158, 11, 0.2); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.45); font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;"
                          title="${isFutureVac ? 'Future Scheduled Vacation' : 'Scheduled Vacation'}: ${this.escapeHtml(vacDateRange || 'Dates not set')}${vacNotes ? ' (' + this.escapeHtml(vacNotes) + ')' : ''} — Click to edit dates or week scope">
                      🏖️ ${isFutureVac ? 'Future Vac' : 'Vac'}: ${this.escapeHtml(vacDateRange || 'Add Dates')} ✏️
                    </span>
                  ` : ''}
                  ${statusBadge}
                </div>
                <div style="display: flex; align-items: center; gap: 3px; flex-shrink: 0;">
                  <span class="badge"
                        onclick="event.stopPropagation(); if(window.employeeProfileEngine){window.employeeProfileEngine.openProfileModal('${this.escapeJs(m.name)}', 'details');}"
                        style="background: rgba(255,255,255,0.06); color: #94a3b8; font-size: 9.5px; padding: 1px 5px; border-radius: 3px; cursor: pointer;"
                        title="Click to edit classification & profile details for ${this.escapeHtml(m.name)}">
                    ${this.escapeHtml(m.classification || m.role || '—')}
                  </span>
                  <button class="btn btn-xs"
                          onclick="event.stopPropagation(); window.crewPlanningEngine.moveMemberUpInCrew('${this.escapeJs(m.name)}', '${this.escapeJs(crew.jobNumber)}')"
                          style="background: transparent; border: 1px solid rgba(255,255,255,0.08); color: #94a3b8; font-size: 8.5px; padding: 1px 4px; border-radius: 3px; cursor: pointer; line-height: 1;"
                          title="Move Up in Crew">
                    ▲
                  </button>
                  <button class="btn btn-xs"
                          onclick="event.stopPropagation(); window.crewPlanningEngine.moveMemberDownInCrew('${this.escapeJs(m.name)}', '${this.escapeJs(crew.jobNumber)}')"
                          style="background: transparent; border: 1px solid rgba(255,255,255,0.08); color: #94a3b8; font-size: 8.5px; padding: 1px 4px; border-radius: 3px; cursor: pointer; line-height: 1;"
                          title="Move Down in Crew">
                    ▼
                  </button>
                  <button class="btn btn-xs"
                          onclick="event.stopPropagation(); window.crewPlanningEngine.promptEditEmployeeNote('${this.escapeJs(m.name)}')"
                          style="background: ${empNote ? 'rgba(245, 158, 11, 0.16)' : 'transparent'}; border: 1px solid ${empNote ? 'rgba(245, 158, 11, 0.45)' : 'rgba(255,255,255,0.08)'}; color: ${empNote ? '#fbbf24' : '#94a3b8'}; font-size: 10px; padding: 1px 5px; border-radius: 3px; cursor: pointer;"
                          title="${empNote ? `📝 Note: ${this.escapeHtml(empNote)} — Click to edit` : `Add note for ${this.escapeHtml(m.name)}`}">
                    📝
                  </button>
                  <button class="btn btn-xs"
                          onclick="window.crewPlanningEngine.promptDuplicateMember('${this.escapeJs(m.name)}', '${this.escapeJs(crew.jobNumber)}')"
                          style="background: transparent; border: 1px solid rgba(168, 85, 247, 0.3); color: #c084fc; font-size: 10px; padding: 1px 5px; border-radius: 3px; cursor: pointer;"
                          title="Duplicate this employee to another crew or category">
                    👯
                  </button>
                  <button class="btn btn-xs"
                          onclick="window.crewPlanningEngine.openPlannedMemberActions(event, '${this.escapeJs(m.name)}', '${this.escapeJs(crew.jobNumber)}')"
                          style="background: transparent; border: none; color: #94a3b8; padding: 1px 4px; font-size: 12px; cursor: pointer;"
                          title="Member options">
                    ⋮
                  </button>
                </div>
              </div>
            `;
          }).join('') : `
            <div style="color: #64748b; font-size: 11.5px; font-style: italic; padding: 14px; text-align: center; border: 1px dashed rgba(255,255,255,0.1); border-radius: 4px;">
              Drop employees here to assign
            </div>
          `}
        </div>

        ${this.renderPlannedCrewNotesHtml(crew, isCrewNotesMatch)}

      </div>
    `;
  }

  /**
   * Renders the Crew Notes section (display badge, inline editor, or "+ Add Crew Notes" trigger)
   * directly below the crew employee list inside a Planned Crew Card.
   */
  renderPlannedCrewNotesHtml(crew, isNotesMatch = false) {
    const jobNumber = String(crew?.jobNumber || '').trim();
    const notesText = String(crew?.notes || '').trim();
    const isEditingNotes = this.editingNotesJob === jobNumber;

    if (isEditingNotes) {
      const draftText = this.editingNotesDraft !== undefined ? this.editingNotesDraft : notesText;
      return `
        <div class="crew-notes-footer"
             draggable="false"
             onclick="event.stopPropagation()"
             ondragstart="event.preventDefault(); event.stopPropagation();"
             style="margin-top: 8px; padding: 8px; background: rgba(15, 23, 42, 0.78); border: 1px solid rgba(245, 158, 11, 0.5); border-radius: 6px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; gap: 6px;">
            <span style="font-size: 10.5px; font-weight: 700; color: #fbbf24; display: inline-flex; align-items: center; gap: 4px;">
              📝 Crew Notes
            </span>
            <span style="font-size: 9.5px; color: #64748b;">Ctrl+Enter to save · Esc to cancel</span>
          </div>
          <textarea id="planned-crew-notes-input-${this.escapeHtml(jobNumber)}"
                    rows="3"
                    draggable="false"
                    placeholder="Add crew notes for ${this.escapeHtml(jobNumber)} (equipment, site access, rotation details, reminders)..."
                    oninput="window.crewPlanningEngine.editingNotesDraft = this.value;"
                    onkeydown="if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); window.crewPlanningEngine.saveInlineCrewNotes('${this.escapeJs(jobNumber)}'); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); window.crewPlanningEngine.cancelInlineCrewNotes(); }"
                    style="width: 100%; box-sizing: border-box; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 5px; padding: 6px 8px; color: #f8fafc; font-size: 11.5px; line-height: 1.4; resize: vertical; outline: none; font-family: inherit;">${this.escapeHtml(draftText)}</textarea>
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-top: 6px;">
            ${notesText ? `
              <button type="button"
                      class="btn btn-xs"
                      onclick="event.stopPropagation(); window.crewPlanningEngine.saveInlineCrewNotes('${this.escapeJs(jobNumber)}', '');"
                      style="font-size: 10.5px; padding: 3px 8px; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); color: #fca5a5; border-radius: 4px; cursor: pointer;"
                      title="Clear crew notes">
                🗑️ Clear
              </button>
            ` : '<span></span>'}
            <div style="display: flex; gap: 6px;">
              <button type="button"
                      class="btn btn-xs"
                      onclick="event.stopPropagation(); window.crewPlanningEngine.cancelInlineCrewNotes();"
                      style="font-size: 10.5px; font-weight: 600; padding: 3px 9px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: #cbd5e1; border-radius: 4px; cursor: pointer;">
                Cancel
              </button>
              <button type="button"
                      class="btn btn-xs"
                      onclick="event.stopPropagation(); window.crewPlanningEngine.saveInlineCrewNotes('${this.escapeJs(jobNumber)}');"
                      style="font-size: 10.5px; font-weight: 700; padding: 3px 10px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); border: none; color: #0f172a; border-radius: 4px; cursor: pointer;">
                💾 Save Notes
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (notesText) {
      return `
        <div class="crew-notes-footer"
             draggable="false"
             onclick="event.stopPropagation(); window.crewPlanningEngine.startInlineCrewNotes('${this.escapeJs(jobNumber)}')"
             style="margin-top: 8px; padding: 6px 8px; background: rgba(245, 158, 11, 0.08); border: 1px solid ${isNotesMatch ? '#f59e0b' : 'rgba(245, 158, 11, 0.25)'}; border-left: 3px solid #f59e0b; border-radius: 5px; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease;"
             onmouseover="this.style.background='rgba(245, 158, 11, 0.14)';"
             onmouseout="this.style.background='rgba(245, 158, 11, 0.08)';"
             title="Click to edit crew notes">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; gap: 6px;">
            <span style="font-size: 10px; font-weight: 700; color: #fbbf24; text-transform: uppercase; letter-spacing: 0.4px; display: inline-flex; align-items: center; gap: 4px;">
              📝 Crew Notes
              ${isNotesMatch ? `<span class="badge" style="background: #f59e0b; color: #000; font-size: 9px; font-weight: 800; padding: 0 4px; border-radius: 3px;">🔍 Match</span>` : ''}
            </span>
            <span style="font-size: 10px; color: #94a3b8;">✏️ Edit</span>
          </div>
          <div style="font-size: 11.5px; color: #e2e8f0; line-height: 1.4; white-space: pre-wrap; word-break: break-word;">${this.escapeHtml(notesText)}</div>
        </div>
      `;
    }

    return `
      <div class="crew-notes-footer" style="margin-top: 6px; padding-top: 5px; border-top: 1px dashed rgba(255,255,255,0.07);">
        <button type="button"
                class="btn btn-xs crew-notes-add-btn"
                onclick="event.stopPropagation(); window.crewPlanningEngine.startInlineCrewNotes('${this.escapeJs(jobNumber)}')"
                style="width: 100%; background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.12); color: #94a3b8; font-size: 11px; font-weight: 600; padding: 4px 8px; border-radius: 5px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px; transition: all 0.15s ease;"
                onmouseover="this.style.background='rgba(245, 158, 11, 0.1)'; this.style.borderColor='rgba(245, 158, 11, 0.4)'; this.style.color='#fbbf24';"
                onmouseout="this.style.background='rgba(255,255,255,0.02)'; this.style.borderColor='rgba(255,255,255,0.12)'; this.style.color='#94a3b8';"
                title="Add notes for Crew ${this.escapeHtml(jobNumber)}">
          <span>📝</span> + Add Crew Notes
        </button>
      </div>
    `;
  }

  /**
   * Opens the inline note editor at the bottom of a Planned Crew Card.
   */
  startInlineCrewNotes(jobNumber) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    const crew = plan?.crews?.find(c => c.jobNumber === jobNumber);
    if (!crew) return;

    this.editingNotesJob = jobNumber;
    this.editingNotesDraft = String(crew.notes || '');
    this.refreshView();

    if (typeof document !== 'undefined') {
      const focusEl = () => {
        const el = document.getElementById('planned-crew-notes-input-' + jobNumber);
        if (el) {
          el.focus();
          if (typeof el.setSelectionRange === 'function') {
            const len = el.value.length;
            el.setSelectionRange(len, len);
          }
        }
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(focusEl);
      } else {
        setTimeout(focusEl, 0);
      }
    }
  }

  /**
   * Closes the inline note editor on a Planned Crew Card without saving unsaved changes.
   */
  cancelInlineCrewNotes() {
    this.editingNotesJob = null;
    this.editingNotesDraft = '';
    this.refreshView();
  }

  /**
   * Saves (or clears) Crew Notes on a planned crew and persists the updated draft plan.
   */
  saveInlineCrewNotes(jobNumber, explicitValue) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    const crew = plan?.crews?.find(c => c.jobNumber === jobNumber);
    if (!crew) return;

    let nextNotes = '';
    if (explicitValue !== undefined) {
      nextNotes = String(explicitValue || '').trim();
    } else {
      const inputEl = typeof document !== 'undefined'
        ? document.getElementById('planned-crew-notes-input-' + jobNumber)
        : null;
      nextNotes = String(inputEl ? inputEl.value : (this.editingNotesDraft || '')).trim();
    }

    crew.notes = nextNotes;
    this.editingNotesJob = null;
    this.editingNotesDraft = '';
    this.savePlan(plan);
    this.refreshView();

    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(
        nextNotes ? `📝 Saved notes for Crew ${jobNumber}` : `🗑️ Cleared notes for Crew ${jobNumber}`,
        'info'
      );
    }
  }

  /**
   * Renders the expanded staging side pane with category drop zones.
   */
  renderExpandedSidePane(plan, baselineMap, occMap, sTerm = '') {
    if (typeof window !== 'undefined' && typeof window.initEmployeeNoteTooltip === 'function') {
      window.initEmployeeNoteTooltip();
    }
    if (!baselineMap) baselineMap = this.getOriginalEmployeeLocations();
    if (!occMap) occMap = this.getEmployeeOccurrencesMap(plan);
    const liveNotesMap = this.buildLiveEmployeeNotesMap();

    const sp = plan.sidePane;
    const term = (sTerm || this.searchTerm || '').toLowerCase().trim();

    const renderSideList = (title, icon, color, badgeBg, list, typeKey) => {
      const rawList = list || [];
      const filteredList = term ? rawList.filter(item => {
        if (!item) return false;
        const n = String(item.name || '').toLowerCase();
        const c = String(item.classification || '').toLowerCase();
        const j = String(item.currentJob || '').toLowerCase();
        const ac = String(item.activeCrew || '').toLowerCase();
        const empNt = this.getEmployeeNote(item.name, plan, item, liveNotesMap).toLowerCase();
        const nt = String(item.note || item.notes || item.employeeNotes || item.dateRange || item.departureReason || item.departureDate || '').toLowerCase();
        return n.includes(term) || c.includes(term) || j.includes(term) || ac.includes(term) || nt.includes(term) || empNt.includes(term);
      }) : rawList;

      const badgeText = (term && filteredList.length !== rawList.length)
        ? `${filteredList.length} / ${rawList.length}`
        : `${rawList.length}`;

      return `
        <div class="side-pane-section" data-side-type="${typeKey}" style="margin-bottom: 12px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; overflow: hidden;">
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: rgba(255,255,255,0.03); border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 12px; font-weight: 700; color: ${color};">
            <span style="display: flex; align-items: center; gap: 6px;">
              <span>${icon}</span> ${title}
            </span>
            <span class="badge" style="background: ${badgeBg}; color: ${color}; font-size: 10px; padding: 1px 6px; border-radius: 10px;">
              ${badgeText}
            </span>
          </div>
          <!-- Drop Zone -->
          <div class="side-drop-zone" data-side-type="${typeKey}" style="min-height: 38px; padding: 4px; display: flex; flex-direction: column; gap: 4px;">
            ${filteredList.length > 0 ? filteredList.map(item => {
              const statusInfo = this.getEmployeePlanningStatus(item.name, null, typeKey, plan, baselineMap, occMap);
              const itemEmpNote = this.getEmployeeNote(item.name, plan, item, liveNotesMap);
              const isItemMatch = Boolean(term && (
                (item.name && item.name.toLowerCase().includes(term)) ||
                (item.classification && item.classification.toLowerCase().includes(term)) ||
                (item.currentJob && item.currentJob.toLowerCase().includes(term)) ||
                (item.activeCrew && item.activeCrew.toLowerCase().includes(term)) ||
                (item.note && String(item.note).toLowerCase().includes(term)) ||
                (item.notes && String(item.notes).toLowerCase().includes(term)) ||
                (item.employeeNotes && String(item.employeeNotes).toLowerCase().includes(term)) ||
                (itemEmpNote && itemEmpNote.toLowerCase().includes(term)) ||
                (item.dateRange && String(item.dateRange).toLowerCase().includes(term)) ||
                (item.departureReason && String(item.departureReason).toLowerCase().includes(term)) ||
                (item.departureDate && String(item.departureDate).toLowerCase().includes(term))
              ));

              let itemBg = 'background: rgba(255,255,255,0.04);';
              let itemBorder = '';
              let statusBadge = '';

              if (isItemMatch) {
                itemBg = 'background: rgba(245, 158, 11, 0.22);';
                itemBorder = 'border: 1.5px solid #f59e0b; border-left: 3.5px solid #f59e0b;';
              } else if (statusInfo.statusColor === 'purple') {
                itemBg = 'background: rgba(147, 51, 234, 0.16);';
                itemBorder = 'border-left: 3px solid #c084fc;';
                statusBadge = `
                  <span class="badge"
                        onclick="event.stopPropagation(); window.crewPlanningEngine.toggleConfirmMemberPosition('${this.escapeJs(item.name)}', '${typeKey}')"
                        style="background: rgba(147, 51, 234, 0.3); color: #d8b4fe; border: 1px solid #c084fc; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; cursor: pointer;"
                        title="${this.escapeHtml(statusInfo.title)}">
                    🟣 ${this.escapeHtml(statusInfo.badgeText)}
                  </span>
                `;
              } else if (statusInfo.statusColor === 'yellow') {
                itemBg = 'background: rgba(234, 179, 8, 0.16);';
                itemBorder = 'border-left: 3px solid #facc15;';
                statusBadge = `
                  <span class="badge"
                        onclick="event.stopPropagation(); window.crewPlanningEngine.toggleConfirmMemberPosition('${this.escapeJs(item.name)}', '${typeKey}')"
                        style="background: rgba(234, 179, 8, 0.28); color: #fde047; border: 1px solid #facc15; font-size: 9px; font-weight: 800; padding: 1px 5px; border-radius: 3px; cursor: pointer;"
                        title="${this.escapeHtml(statusInfo.title)} — Click to unconfirm">
                    🟡 Confirmed
                  </span>
                `;
              } else if (statusInfo.statusColor === 'cyan') {
                itemBg = 'background: rgba(6, 182, 212, 0.12);';
                itemBorder = 'border-left: 3px solid #06b6d4;';
                statusBadge = `
                  <span class="badge"
                        onclick="event.stopPropagation(); window.crewPlanningEngine.toggleConfirmMemberPosition('${this.escapeJs(item.name)}', '${typeKey}')"
                        style="background: rgba(6, 182, 212, 0.24); color: #67e8f9; border: 1px solid #06b6d4; font-size: 9px; font-weight: 800; padding: 1px 5px; border-radius: 3px; cursor: pointer;"
                        title="${this.escapeHtml(statusInfo.title)} — Click to unconfirm">
                    💠 2nd Job
                  </span>
                `;
              }

              return `
                <div class="side-member-row side-pane-item"
                     draggable="true"
                     data-emp-name="${this.escapeHtml(item.name)}"
                     data-from-side="${typeKey}"
                     style="display: flex; justify-content: space-between; align-items: center; ${itemBg} ${itemBorder} padding: 4px 6px; border-radius: 4px; font-size: 11.5px; cursor: grab; transition: all 0.15s ease;">
                  <div style="display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0; flex-wrap: wrap;">
                    <span class="drag-handle" style="color: #64748b; font-size: 12px; user-select: none;">⠿</span>
                    <span style="font-weight: 600; cursor: pointer;"
                          onclick="event.stopPropagation(); if(window.employeeProfileEngine){window.employeeProfileEngine.openProfileModal('${this.escapeJs(item.name)}');}"
                          onmouseover="this.style.color='#60a5fa'; this.style.textDecoration='underline';"
                          onmouseout="this.style.color='inherit'; this.style.textDecoration='none';"
                          ${this.getEmployeeNoteTooltipAttrs(item.name, itemEmpNote, `Click to open Employee Profile for ${item.name}`)}>${this.escapeHtml(item.name)}</span>
                    ${isItemMatch ? `
                      <span class="badge" style="background: #f59e0b; color: #000; font-size: 8.5px; font-weight: 800; padding: 1px 4px; border-radius: 2px;">
                        🔍 Match
                      </span>
                    ` : ''}
                    ${typeKey === 'quit' ? `
                      ${item.departureDate ? `
                        <span class="badge" onclick="event.stopPropagation(); window.crewPlanningEngine.editQuitDeparture('${this.escapeJs(item.name)}')" style="background: rgba(239, 68, 68, 0.22); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4); font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Last Day: ${this.escapeHtml(item.departureDate)} (${this.escapeHtml(item.departureReason || 'Quit')}) — Click to edit">
                          📅 Last Day: ${this.escapeHtml(item.departureDate)}
                        </span>
                        <button class="btn btn-xs" onclick="event.stopPropagation(); window.crewPlanningEngine.editQuitDeparture('${this.escapeJs(item.name)}')" style="background: transparent; border: none; color: #94a3b8; font-size: 9.5px; padding: 0 2px; cursor: pointer;" title="Edit Last Day Date / Details">✏️</button>
                      ` : `
                        <span class="badge" onclick="event.stopPropagation(); window.crewPlanningEngine.editQuitDeparture('${this.escapeJs(item.name)}')" style="background: rgba(239, 68, 68, 0.35); color: #fee2e2; border: 1px dashed #ef4444; font-size: 9.5px; font-weight: 800; padding: 1px 6px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Click to add Last Working Day">
                          ⚠️ Add Last Day
                        </span>
                      `}
                      ${item.isScheduledDeparture ? `
                        <span style="color: #60a5fa; font-size: 10px; font-weight: 600;" title="Active on field crew until recorded last day">
                          (Active on Crew ${this.escapeHtml(item.activeCrew || item.currentJob || '—')})
                        </span>
                      ` : ''}
                    ` : typeKey === 'vacation' ? `
                      ${(item.dateRange || item.vacationStartDate) ? `
                        <span class="badge" onclick="event.stopPropagation(); window.crewPlanningEngine.editVacationSchedule('${this.escapeJs(item.name)}')" style="background: rgba(245, 158, 11, 0.22); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.45); font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Vacation Dates: ${this.escapeHtml(item.dateRange || item.vacationStartDate)}${item.notes ? ' — ' + this.escapeHtml(item.notes) : ''} (Click to edit dates or week scope)">
                          📅 ${this.escapeHtml(item.dateRange || item.vacationStartDate)}
                        </span>
                        <button class="btn btn-xs" onclick="event.stopPropagation(); window.crewPlanningEngine.editVacationSchedule('${this.escapeJs(item.name)}')" style="background: transparent; border: none; color: #94a3b8; font-size: 9.5px; padding: 0 2px; cursor: pointer;" title="Edit Vacation Dates & Scope">✏️</button>
                      ` : `
                        <span class="badge" onclick="event.stopPropagation(); window.crewPlanningEngine.editVacationSchedule('${this.escapeJs(item.name)}')" style="background: rgba(245, 158, 11, 0.32); color: #fef3c7; border: 1px dashed #f59e0b; font-size: 9.5px; font-weight: 800; padding: 1px 6px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Click to add Vacation Dates and clarify whether this is for this week or a future week">
                          ⚠️ Add Vacation Dates
                        </span>
                      `}
                      ${item.isFutureVacation ? `
                        <span class="badge" onclick="event.stopPropagation(); window.crewPlanningEngine.editVacationSchedule('${this.escapeJs(item.name)}')" style="background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; cursor: pointer;" title="Future Week Vacation — Employee remains active on Crew ${this.escapeHtml(item.activeCrew || item.priorBaseJob || item.currentJob || 'Field')} this week">
                          ⏭️ Future Wk${(item.activeCrew || item.priorBaseJob) ? ' (Active: ' + this.escapeHtml(item.activeCrew || item.priorBaseJob) + ')' : ''}
                        </span>
                      ` : (item.dateRange || item.vacationStartDate || item.isFutureVacation === false) ? `
                        <span class="badge" onclick="event.stopPropagation(); window.crewPlanningEngine.editVacationSchedule('${this.escapeJs(item.name)}')" style="background: rgba(16, 185, 129, 0.16); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.35); font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; cursor: pointer;" title="${item.keepOnCrew ? 'Partial-week vacation — Kept on Crew ' + this.escapeHtml(item.activeCrew || item.priorBaseJob || '') : 'Off on vacation during this planned week'}">
                          🗓️ This Wk${item.keepOnCrew ? ' (On Crew)' : ''}
                        </span>
                      ` : ''}
                      ${item.notes ? `<span style="color: #94a3b8; font-size: 10px;">(${this.escapeHtml(item.notes)})</span>` : ''}
                    ` : (item.note || item.dateRange ? `<span style="color: #64748b; font-size: 10px;">(${this.escapeHtml(item.note || item.dateRange)})</span>` : '')}
                    ${statusBadge}
                  </div>
                  <div style="display: flex; align-items: center; gap: 3px;">
                    ${item.currentJob ? `<span style="font-size: 9.5px; color: #94a3b8; font-family: monospace;">${this.escapeHtml(item.currentJob)}</span>` : ''}
                    <button class="btn btn-xs"
                            onclick="event.stopPropagation(); window.crewPlanningEngine.promptEditEmployeeNote('${this.escapeJs(item.name)}')"
                            style="background: ${itemEmpNote ? 'rgba(245, 158, 11, 0.16)' : 'transparent'}; border: 1px solid ${itemEmpNote ? 'rgba(245, 158, 11, 0.45)' : 'rgba(255,255,255,0.08)'}; color: ${itemEmpNote ? '#fbbf24' : '#94a3b8'}; font-size: 10px; padding: 0 4px; border-radius: 3px; cursor: pointer;"
                            title="${itemEmpNote ? `📝 Note: ${this.escapeHtml(itemEmpNote)} — Click to edit` : `Add note for ${this.escapeHtml(item.name)}`}">📝</button>
                    <button class="btn btn-xs"
                            onclick="window.crewPlanningEngine.promptDuplicateMember('${this.escapeJs(item.name)}', '', '${typeKey}')"
                            style="background: transparent; border: none; color: #c084fc; font-size: 11px; padding: 0 3px; cursor: pointer;"
                            title="Duplicate">👯</button>
                    <button class="btn btn-xs"
                            onclick="window.crewPlanningEngine.removeMemberFromSideCategory('${this.escapeJs(item.name)}', '${typeKey}')"
                            style="background: transparent; border: none; color: #ef4444; font-size: 11px; padding: 0 3px; cursor: pointer;"
                            title="Remove">✕</button>
                  </div>
                </div>
              `;
            }).join('') : (term && rawList.length > 0 ? `
              <div style="color: #64748b; font-size: 10.5px; font-style: italic; padding: 6px; text-align: center;">
                No matches
              </div>
            ` : `
              <div style="color: #64748b; font-size: 10.5px; font-style: italic; padding: 6px; text-align: center;">
                Drop here to stage
              </div>
            `)}
          </div>
        </div>
      `;
    };

    return `
      <!-- Side Pane Header -->
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.1));">
        <div style="font-weight: 800; font-size: 13px; color: #93c5fd; display: flex; align-items: center; gap: 6px;">
          <span>📋</span> Staging Side Pane
        </div>
        <button class="btn btn-xs" onclick="window.crewPlanningEngine.toggleSidebar()" style="background: transparent; border: none; color: #94a3b8; font-size: 12px; cursor: pointer;" title="Collapse side pane">
          ⇥
        </button>
      </div>

      <!-- Side Pane Category Lists -->
      <div class="side-pane-scroll-body" style="flex: 1; overflow-y: auto; padding: 10px;">
        ${renderSideList('Planning Pool (Floaters)', '📌', '#60a5fa', 'rgba(59, 130, 246, 0.2)', sp.planning, 'planning')}
        ${renderSideList('Scheduled Vacation', '🏖️', '#fbbf24', 'rgba(245, 158, 11, 0.2)', sp.vacation, 'vacation')}
        ${renderSideList('Quit / Notice', '🚪', '#f87171', 'rgba(239, 68, 68, 0.2)', sp.quit, 'quit')}
        ${renderSideList('Weeds (Job-Attached)', '🌾', '#a3e635', 'rgba(163, 230, 53, 0.2)', sp.weeds, 'weeds')}
        ${renderSideList('Light Duty / Medical', '🩺', '#34d399', 'rgba(52, 211, 153, 0.2)', sp.lightDuty, 'lightDuty')}
        ${renderSideList('Pending New Hires', '⏳', '#c084fc', 'rgba(192, 132, 252, 0.2)', sp.pendingHires, 'pendingHires')}
      </div>
    `;
  }

  renderCollapsedSidePane() {
    const plan = this.getPlanForWeek(this.selectedWeek);
    const sp = plan?.sidePane || { planning: [], vacation: [], quit: [], weeds: [], lightDuty: [] };

    return `
      <div style="display: flex; flex-direction: column; align-items: center; padding: 10px 4px; gap: 14px; height: 100%; box-sizing: border-box;">
        <button class="btn btn-xs" onclick="window.crewPlanningEngine.toggleSidebar()" style="background: transparent; border: none; color: #93c5fd; font-size: 14px; cursor: pointer;" title="Expand Staging Side Pane">
          ⇤
        </button>
        <div style="writing-mode: vertical-rl; transform: rotate(180deg); font-size: 11px; font-weight: 700; color: #94a3b8; letter-spacing: 1px;">
          STAGING PANE
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: auto;">
          <span title="Planning Pool: ${sp.planning.length}" style="cursor: pointer;" onclick="window.crewPlanningEngine.toggleSidebar()">📌 ${sp.planning.length}</span>
          <span title="Vacation: ${sp.vacation.length}" style="cursor: pointer;" onclick="window.crewPlanningEngine.toggleSidebar()">🏖️ ${sp.vacation.length}</span>
          <span title="Quit: ${sp.quit.length}" style="cursor: pointer;" onclick="window.crewPlanningEngine.toggleSidebar()">🚪 ${sp.quit.length}</span>
          <span title="Weeds: ${sp.weeds.length}" style="cursor: pointer;" onclick="window.crewPlanningEngine.toggleSidebar()">🌾 ${sp.weeds.length}</span>
        </div>
      </div>
    `;
  }

  filterSideSearch(query) {
    const q = String(query || '').trim();
    this.searchTerm = q;
    if (window.sheetNavigator) {
      window.sheetNavigator.searchTerm = q.toLowerCase();
      const topSearch = document.getElementById('sheet-search-input');
      if (topSearch && topSearch.value !== q) {
        topSearch.value = q;
      }
      window.sheetNavigator.renderCurrentSheet();
    } else {
      const items = document.querySelectorAll('.side-member-row');
      items.forEach(el => {
        if (!q) {
          el.style.display = '';
          return;
        }
        const noteEl = el.querySelector('[data-emp-note]');
        const noteAttr = noteEl ? noteEl.getAttribute('data-emp-note') || '' : '';
        const text = `${el.textContent} ${noteAttr}`.toLowerCase();
        el.style.display = text.includes(q.toLowerCase()) ? '' : 'none';
      });
    }
  }

  /**
   * Renders a read-only historical roster for past reference weeks.
   */
  renderHistoricalWorkspace(container, countBadge, weekStr, incomingSearchTerm) {
    if (!container) return;
    if (typeof window !== 'undefined' && typeof window.initEmployeeNoteTooltip === 'function') {
      window.initEmployeeNoteTooltip();
    }
    const roster = this.getHistoricalRoster(weekStr);
    const liveNotesMap = this.buildLiveEmployeeNotesMap();
    const getHistNote = (empName, obj) => {
      const norm = String(empName || '').trim().toLowerCase();
      const archivedEntry = roster?.employeeNotes?.[norm];
      if (archivedEntry && archivedEntry.text !== undefined) {
        return String(archivedEntry.text || '').trim();
      }
      if (obj?.employeeNotes !== undefined) return String(obj.employeeNotes || '').trim();
      if (obj?.notes !== undefined) return String(obj.notes || '').trim();
      return liveNotesMap.get(norm) || '';
    };

    if (countBadge) {
      countBadge.style.display = 'none';
    }

    if (incomingSearchTerm !== undefined) {
      this.searchTerm = incomingSearchTerm;
    } else if (window.sheetNavigator && window.sheetNavigator.searchTerm !== undefined) {
      this.searchTerm = window.sheetNavigator.searchTerm;
    }
    const sTerm = (this.searchTerm || '').toLowerCase().trim();

    const matchingCrews = (roster.crews || []).filter(crew => this.isCrewMatchingSearch(crew, sTerm));
    const sp = roster.sidePane || {};
    const sideCategories = [
      { key: 'vacation', label: 'Scheduled Vacation / Time Off', icon: '🏖️', color: '#fbbf24' },
      { key: 'quit', label: 'Quits / Departures', icon: '🚪', color: '#f87171' },
      { key: 'lightDuty', label: 'Light Duty / Medical', icon: '🩺', color: '#34d399' },
      { key: 'weeds', label: 'Weeds (Job-Attached)', icon: '🌾', color: '#a3e635' },
      { key: 'planning', label: 'Planning Pool (Floaters)', icon: '📌', color: '#60a5fa' },
      { key: 'pendingHires', label: 'Pending New Hires', icon: '⏳', color: '#c084fc' }
    ];
    const sideSectionsHtml = sideCategories.map(cat => {
      const rawItems = Array.isArray(sp[cat.key]) ? sp[cat.key] : [];
      const items = sTerm
        ? rawItems.filter(it => {
            const text = `${it?.name || ''} ${it?.note || ''} ${it?.notes || ''} ${it?.dateRange || ''} ${it?.departureDate || ''} ${it?.currentJob || ''}`.toLowerCase();
            return text.includes(sTerm);
          })
        : rawItems;
      if (items.length === 0) return '';
      return `
        <div style="background: var(--bg-secondary, #1e293b); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); border-radius: 8px; padding: 10px 12px;">
          <div style="font-size: 12px; font-weight: 800; color: ${cat.color}; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
            <span>${cat.icon} ${cat.label}</span>
            <span class="badge" style="background: rgba(255,255,255,0.08); color: ${cat.color}; font-size: 10px; padding: 1px 6px; border-radius: 10px;">${items.length}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            ${items.map(it => {
              const histNote = getHistNote(it.name, it);
              return `
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 11.5px; padding: 3px 6px; background: rgba(255,255,255,0.03); border-radius: 4px;">
                <span style="font-weight: 600; cursor: pointer;" onclick="event.stopPropagation(); if(window.employeeProfileEngine){window.employeeProfileEngine.openProfileModal('${this.escapeJs(it.name || '')}');}" ${this.getEmployeeNoteTooltipAttrs(it.name || '', histNote, `Click to open Employee Profile for ${it.name || ''}`)}>${this.escapeHtml(it.name || '—')}</span>
                <span style="font-size: 10.5px; color: #94a3b8; text-align: right;">${this.escapeHtml(it.dateRange || it.departureDate || it.note || it.notes || it.currentJob || '')}</span>
              </div>
            `;
            }).join('')}
          </div>
        </div>
      `;
    }).filter(Boolean).join('');

    container.innerHTML = `
      <div class="historical-roster-wrapper" style="height: 100%; overflow-y: auto; padding: 14px 18px; box-sizing: border-box;">
        
        <!-- Historical Reference Banner -->
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 8px; padding: 10px 16px; margin-bottom: 16px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 20px;">📜</span>
            <div>
              <div style="font-size: 14px; font-weight: 800; color: #93c5fd;">
                Historical Crew Structure — Week of ${this.escapeHtml(weekStr)}
              </div>
              <div style="font-size: 11.5px; color: #94a3b8;">
                Viewing frozen historical archive for past reference. This record is read-only.
              </div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button class="btn btn-secondary" onclick="window.crewPlanningEngine.openHistoricalExcelImportModal()" style="font-size: 11.5px; font-weight: 600; padding: 5px 10px; display: inline-flex; align-items: center; gap: 5px;">
              <span>📁</span> Import Historical Excel Tabs
            </button>
            <button class="btn btn-secondary" onclick="window.sheetNavigator.selectEmployeeWeek(window.crewPlanningEngine.getCurrentWeekSundayStr())" style="font-size: 11.5px; font-weight: 600; padding: 5px 10px; color: #60a5fa;">
              ⚡ Return to Current Week
            </button>
          </div>
        </div>

        <!-- Historical Crew Cards Grid -->
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px;">
          ${matchingCrews.length > 0 ? matchingCrews.map(crew => {
            const typeInfo = this.getCrewTypeInfo(crew.crewType);
            return `
            <div style="background: var(--bg-secondary, #1e293b); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); border-radius: 8px; padding: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 6px; margin-bottom: 8px; gap: 6px;">
                <div>
                  <div style="font-weight: 800; font-size: 13.5px; color: #93c5fd; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <span>🚜 ${this.escapeHtml(crew.jobNumber)}</span>
                    ${crew.jobName ? `<span style="font-size: 11px; font-weight: 600; color: #94a3b8;">— ${this.escapeHtml(crew.jobName)}</span>` : ''}
                  </div>
                  <div style="font-size: 10.5px; color: #94a3b8; margin-top: 2px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <span style="color: ${typeInfo.color}; font-weight: 700;">${typeInfo.icon} ${this.escapeHtml(crew.crewType || 'Electric')}</span>
                    ${crew.status ? this.getCrewStatusBadgeHtml(crew.status) : ''}
                    ${crew.schedule ? `<span>• 🕒 ${this.escapeHtml(crew.schedule)}</span>` : ''}
                  </div>
                </div>
                <span class="badge" style="background: rgba(255,255,255,0.06); font-size: 10.5px; color: #94a3b8; white-space: nowrap;">
                  📍 ${this.escapeHtml(crew.location || 'Helena')}
                </span>
              </div>
              <div style="font-size: 11.5px; margin-bottom: 6px; color: #f472b6; font-weight: 700;">
                👑 Foreman: ${crew.foreman ? `<span style="cursor: pointer;" onclick="event.stopPropagation(); if(window.employeeProfileEngine){window.employeeProfileEngine.openProfileModal('${this.escapeJs(crew.foreman)}');}" onmouseover="this.style.color='#60a5fa'; this.style.textDecoration='underline';" onmouseout="this.style.color='#f472b6'; this.style.textDecoration='none';" ${this.getEmployeeNoteTooltipAttrs(crew.foreman, getHistNote(crew.foreman, null), `Click to open Employee Profile for ${crew.foreman}`)}>${this.escapeHtml(crew.foreman)}</span>` : '—'}
              </div>
              <div style="display: flex; flex-direction: column; gap: 4px;">
                ${crew.members && crew.members.length > 0 ? crew.members.map(m => `
                  <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 3px 4px; border-bottom: 1px dashed rgba(255,255,255,0.04);">
                    <span style="font-family: monospace; font-size: 11px; color: #94a3b8; min-width: 45px;">${this.escapeHtml(m.slot || '—')}</span>
                    <span style="flex: 1; margin-left: 6px; font-weight: 500; cursor: pointer;" onclick="event.stopPropagation(); if(window.employeeProfileEngine){window.employeeProfileEngine.openProfileModal('${this.escapeJs(m.name)}');}" onmouseover="this.style.color='#60a5fa'; this.style.textDecoration='underline';" onmouseout="this.style.color='inherit'; this.style.textDecoration='none';" ${this.getEmployeeNoteTooltipAttrs(m.name, getHistNote(m.name, m), `Click to open Employee Profile for ${m.name}`)}>${this.escapeHtml(m.name)}</span>
                    <span style="font-size: 10px; color: #64748b;">${this.escapeHtml(m.classification || m.role || '')}</span>
                  </div>
                `).join('') : '<div style="color: #64748b; font-size: 11px; font-style: italic;">No individual member records archived</div>'}
              </div>
              ${crew.notes ? `
                <div style="margin-top: 8px; padding: 6px 8px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); border-left: 3px solid #f59e0b; border-radius: 5px;">
                  <div style="font-size: 9.5px; font-weight: 700; color: #fbbf24; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 2px;">📝 Crew Notes</div>
                  <div style="font-size: 11.5px; color: #e2e8f0; line-height: 1.4; white-space: pre-wrap; word-break: break-word;">${this.escapeHtml(crew.notes)}</div>
                </div>
              ` : ''}
            </div>
          `; }).join('') : (sTerm ? `
            <div style="grid-column: 1 / -1; padding: 36px 20px; text-align: center; color: #94a3b8; background: rgba(30, 41, 59, 0.4); border: 1px dashed rgba(255,255,255,0.12); border-radius: 8px;">
              <div style="font-size: 28px; margin-bottom: 8px;">🔍</div>
              <div style="font-size: 14px; font-weight: 700; color: #f8fafc; margin-bottom: 4px;">No archived crews match "${this.escapeHtml(sTerm)}"</div>
              <div style="font-size: 12px; color: #94a3b8; margin-bottom: 12px;">Check archived statuses below or clear the search to view all ${(roster.crews || []).length} archived crews.</div>
              <button class="btn btn-secondary" onclick="const si = document.getElementById('sheet-search-input'); if (si) { si.value = ''; si.dispatchEvent(new Event('input')); }" style="font-size: 11.5px; padding: 4px 12px; display: inline-flex; align-items: center; gap: 4px;">
                <span>✕</span> Clear Search
              </button>
            </div>
          ` : `
            <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: #94a3b8;">
              <div style="font-size: 28px; margin-bottom: 8px;">🔍</div>
              <div>No archived roster found for this week. Use "Import Historical Excel Tabs" to populate.</div>
            </div>
          `)}
        </div>

        ${sideSectionsHtml ? `
          <div style="margin-top: 18px;">
            <div style="font-size: 12px; font-weight: 800; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.5px; margin-bottom: 10px;">
              📋 Archived Statuses, Time Off &amp; Departures
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px;">
              ${sideSectionsHtml}
            </div>
          </div>
        ` : ''}

      </div>
    `;
  }

  // ==========================================================================
  // Drag & Drop Handlers for Planning Mode (Move or Alt/Ctrl+Duplicate)
  // ==========================================================================

  attachPlanningDragHandlers(container) {
    if (!container) return;

    // 0. Drag source on Planned Crew Headers / Drag Handles (reordering entire crew cards)
    container.querySelectorAll('.planned-crew-header[draggable="true"]').forEach(header => {
      header.addEventListener('dragstart', (e) => {
        // If user clicked a button or interactive child, don't drag crew card
        if (e.target.closest('button, select, input, a')) {
          e.preventDefault();
          return;
        }

        const crewJob = header.dataset.crewJob;
        if (!crewJob) return;

        const card = header.closest('.planned-crew-card');
        const dragData = {
          type: 'crew',
          jobNumber: crewJob
        };

        e.dataTransfer.setData('application/json', JSON.stringify(dragData));
        e.dataTransfer.effectAllowed = 'move';
        window._activePlanningCrewDrag = crewJob;
        window._activePlanningDragData = null;

        if (card) {
          card.classList.add('is-dragging-crew');
        }
      });

      header.addEventListener('dragend', () => {
        window._activePlanningCrewDrag = null;
        container.querySelectorAll('.planned-crew-card').forEach(c => {
          c.classList.remove('is-dragging-crew', 'crew-drop-before', 'crew-drop-after', 'member-drop-move', 'member-drop-copy');
        });
      });
    });

    // 1. Drag source on member rows
    container.querySelectorAll('.planned-member-row[draggable="true"], .side-member-row[draggable="true"]').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        if (e.target.closest('button, select, input, a')) {
          e.preventDefault();
          return;
        }
        const isCopy = e.altKey || e.ctrlKey;
        const dragData = {
          empName: row.dataset.empName,
          fromJobNumber: row.dataset.jobNumber || '',
          fromBaseJob: row.dataset.baseJob || '',
          fromSideType: row.dataset.fromSide || '',
          isCopy: isCopy
        };
        e.dataTransfer.setData('application/json', JSON.stringify(dragData));
        e.dataTransfer.effectAllowed = isCopy ? 'copy' : 'copyMove';
        row.style.opacity = '0.4';
        window._activePlanningDragData = dragData;
      });

      row.addEventListener('dragend', () => {
        row.style.opacity = '1';
        window._activePlanningDragData = null;
        container.querySelectorAll('.planned-crew-card').forEach(el => {
          el.classList.remove('member-drop-move', 'member-drop-copy', 'crew-drop-before', 'crew-drop-after');
        });
        container.querySelectorAll('.side-pane-section').forEach(el => {
          el.classList.remove('side-drop-move', 'side-drop-copy');
        });
        container.querySelectorAll('.planned-member-row').forEach(el => {
          el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-top-copy', 'drag-over-bottom-copy');
        });
      });
    });

    // 2. Drop target on individual Planned Member Rows (reordering inside crew & targeted insert)
    container.querySelectorAll('.planned-member-row').forEach(targetRow => {
      targetRow.addEventListener('dragover', (e) => {
        // If a whole crew is being dragged, allow the event to bubble up to the crew card!
        if (window._activePlanningCrewDrag) {
          return;
        }

        e.preventDefault();
        e.stopPropagation(); // Prevent bubbling up to the crew card while targeting a row

        const activeData = window._activePlanningDragData;
        const isCopy = Boolean(e.altKey || e.ctrlKey || (activeData && activeData.isCopy));
        e.dataTransfer.dropEffect = isCopy ? 'copy' : 'move';

        // Check if dragging over itself in the same crew
        if (activeData && activeData.empName === targetRow.dataset.empName && activeData.fromBaseJob === targetRow.dataset.baseJob && !isCopy) {
          targetRow.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-top-copy', 'drag-over-bottom-copy');
          return;
        }

        const rect = targetRow.getBoundingClientRect();
        const relY = e.clientY - rect.top;
        const isAbove = relY < rect.height / 2;

        if (isAbove) {
          targetRow.classList.add(isCopy ? 'drag-over-top-copy' : 'drag-over-top');
          targetRow.classList.remove('drag-over-bottom', 'drag-over-bottom-copy', isCopy ? 'drag-over-top' : 'drag-over-top-copy');
        } else {
          targetRow.classList.add(isCopy ? 'drag-over-bottom-copy' : 'drag-over-bottom');
          targetRow.classList.remove('drag-over-top', 'drag-over-top-copy', isCopy ? 'drag-over-bottom' : 'drag-over-bottom-copy');
        }
      });

      targetRow.addEventListener('dragleave', (e) => {
        if (!targetRow.contains(e.relatedTarget)) {
          targetRow.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-top-copy', 'drag-over-bottom-copy');
        }
      });

      targetRow.addEventListener('drop', (e) => {
        // If a whole crew is being dragged, allow bubbling up to the crew card drop handler!
        if (window._activePlanningCrewDrag) {
          return;
        }

        e.preventDefault();
        e.stopPropagation(); // Do not trigger parent card's drop handler
        targetRow.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-top-copy', 'drag-over-bottom-copy');

        let data = null;
        try {
          data = JSON.parse(e.dataTransfer.getData('application/json'));
        } catch { /* ignore */ }
        if (!data && window._activePlanningDragData) data = window._activePlanningDragData;
        if (!data) return;

        const isCopy = Boolean(e.altKey || e.ctrlKey || data.isCopy);
        const destJob = targetRow.dataset.baseJob;
        const targetEmpName = targetRow.dataset.empName;

        // Dropped on self in same crew: no-op
        if (!isCopy && data.empName === targetEmpName && data.fromBaseJob === destJob) return;

        const rect = targetRow.getBoundingClientRect();
        const relY = e.clientY - rect.top;
        const insertPosition = (relY < rect.height / 2) ? 'before' : 'after';

        this.handleReorderOrMoveMember(data, destJob, targetEmpName, insertPosition, isCopy);
      });
    });

    // 3. Drop target on Planned Crew Cards / Drop Zones (crew reordering OR member append)
    container.querySelectorAll('.planned-crew-card').forEach(card => {
      const destJob = card.dataset.crewJob;
      if (!destJob) return;

      card.addEventListener('dragover', (e) => {
        e.preventDefault();

        // CASE A: Whole crew is being dragged to reorder
        if (window._activePlanningCrewDrag) {
          const srcJob = window._activePlanningCrewDrag;
          if (srcJob === destJob) {
            card.classList.remove('crew-drop-before', 'crew-drop-after');
            return;
          }
          e.dataTransfer.dropEffect = 'move';
          const rect = card.getBoundingClientRect();
          const relX = e.clientX - rect.left;
          const isBefore = relX < rect.width / 2;

          if (isBefore) {
            card.classList.add('crew-drop-before');
            card.classList.remove('crew-drop-after');
          } else {
            card.classList.add('crew-drop-after');
            card.classList.remove('crew-drop-before');
          }
          return;
        }

        // CASE B: Member is being dragged
        const isCopy = e.altKey || e.ctrlKey || (window._activePlanningDragData && window._activePlanningDragData.isCopy);
        e.dataTransfer.dropEffect = isCopy ? 'copy' : 'move';
        card.classList.toggle('member-drop-copy', Boolean(isCopy));
        card.classList.toggle('member-drop-move', !isCopy);
      });

      card.addEventListener('dragleave', (e) => {
        if (!card.contains(e.relatedTarget)) {
          card.classList.remove('crew-drop-before', 'crew-drop-after', 'member-drop-move', 'member-drop-copy');
        }
      });

      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('crew-drop-before', 'crew-drop-after', 'member-drop-move', 'member-drop-copy');

        let data = null;
        try {
          data = JSON.parse(e.dataTransfer.getData('application/json'));
        } catch { /* ignore */ }

        // CASE A: Crew Reorder Drop
        if ((data && data.type === 'crew') || window._activePlanningCrewDrag) {
          const srcJob = (data && data.jobNumber) || window._activePlanningCrewDrag;
          window._activePlanningCrewDrag = null;
          if (srcJob && srcJob !== destJob) {
            const rect = card.getBoundingClientRect();
            const relX = e.clientX - rect.left;
            const isBefore = relX < rect.width / 2;
            this.reorderCrew(srcJob, destJob, isBefore ? 'before' : 'after');
          }
          return;
        }

        // CASE B: Member Drop
        if (!data && window._activePlanningDragData) data = window._activePlanningDragData;

        if (data) {
          const isCopy = Boolean(e.altKey || e.ctrlKey || data.isCopy);
          this.handleReorderOrMoveMember(data, destJob, null, 'end', isCopy);
        }
      });
    });

    // 3.5 Drop target on planned crews grid background (to move to end)
    const grid = container.querySelector('.planned-crews-grid');
    if (grid) {
      grid.addEventListener('dragover', (e) => {
        if (window._activePlanningCrewDrag) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      });

      grid.addEventListener('drop', (e) => {
        if (window._activePlanningCrewDrag && (e.target === grid || (e.target.closest('.planned-crews-grid') === grid && !e.target.closest('.planned-crew-card')))) {
          e.preventDefault();
          const srcJob = window._activePlanningCrewDrag;
          window._activePlanningCrewDrag = null;
          this.reorderCrew(srcJob, null, 'end');
        }
      });
    }

    // 4. Drop target on Side Pane Categories
    container.querySelectorAll('.side-pane-section').forEach(sec => {
      const destSideType = sec.dataset.sideType;
      if (!destSideType) return;

      sec.addEventListener('dragover', (e) => {
        if (window._activePlanningCrewDrag) return;
        e.preventDefault();
        const isCopy = e.altKey || e.ctrlKey || (window._activePlanningDragData && window._activePlanningDragData.isCopy);
        e.dataTransfer.dropEffect = isCopy ? 'copy' : 'move';
        sec.classList.toggle('side-drop-copy', Boolean(isCopy));
        sec.classList.toggle('side-drop-move', !isCopy);
      });

      sec.addEventListener('dragleave', (e) => {
        if (!sec.contains(e.relatedTarget)) {
          sec.classList.remove('side-drop-move', 'side-drop-copy');
        }
      });

      sec.addEventListener('drop', (e) => {
        if (window._activePlanningCrewDrag) return;
        e.preventDefault();
        sec.classList.remove('side-drop-move', 'side-drop-copy');

        let data = null;
        try {
          data = JSON.parse(e.dataTransfer.getData('application/json'));
        } catch { /* ignore */ }
        if (!data && window._activePlanningDragData) data = window._activePlanningDragData;

        if (data) {
          const isCopy = Boolean(e.altKey || e.ctrlKey || data.isCopy);
          this.handleMoveToSideCategory(data, destSideType, isCopy);
        }
      });
    });
  }

  /**
   * Reorders a planned crew card to be placed before or after another crew card, or at the end.
   */
  reorderCrew(srcJobNumber, targetJobNumber, position = 'before') {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan || !Array.isArray(plan.crews)) return;

    const fromIdx = plan.crews.findIndex(c => c.jobNumber.toLowerCase() === String(srcJobNumber || '').toLowerCase());
    if (fromIdx === -1) return;

    const [movedCrew] = plan.crews.splice(fromIdx, 1);

    if (position === 'end' || !targetJobNumber) {
      plan.crews.push(movedCrew);
    } else {
      let toIdx = plan.crews.findIndex(c => c.jobNumber.toLowerCase() === String(targetJobNumber || '').toLowerCase());
      if (toIdx === -1) {
        plan.crews.push(movedCrew);
      } else {
        if (position === 'after') {
          toIdx += 1;
        }
        plan.crews.splice(toIdx, 0, movedCrew);
      }
    }

    this.savePlan(plan);
    this.refreshView();

    if (typeof window.showToast === 'function') {
      if (position === 'end' || !targetJobNumber) {
        window.showToast(`🚜 Moved Crew ${srcJobNumber} to the end of the board.`, 'info');
      } else {
        window.showToast(`🚜 Moved Crew ${srcJobNumber} ${position} Crew ${targetJobNumber}.`, 'info');
      }
    }
  }

  /**
   * Moves a planned crew earlier (-1) or later (+1) in the board display order.
   */
  moveCrewOrder(jobNumber, delta) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan || !Array.isArray(plan.crews)) return;

    const idx = plan.crews.findIndex(c => c.jobNumber.toLowerCase() === String(jobNumber || '').toLowerCase());
    if (idx === -1) return;

    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= plan.crews.length) {
      if (typeof window.showToast === 'function') {
        window.showToast(`Crew ${jobNumber} is already at the ${delta < 0 ? 'start' : 'end'} of the board.`, 'info');
      }
      return;
    }

    const [movedCrew] = plan.crews.splice(idx, 1);
    plan.crews.splice(targetIdx, 0, movedCrew);

    this.savePlan(plan);
    this.refreshView();

    if (typeof window.showToast === 'function') {
      window.showToast(`🚜 Moved Crew ${jobNumber} ${delta < 0 ? 'earlier' : 'later'} in board order.`, 'info');
    }
  }

  /**
   * Reorders an employee inside a crew, or moves/copies an employee into a crew at a target position.
   * Always renumbers member slots sequentially (.1, .2, .3, ...) so there are never gaps.
   */
  handleReorderOrMoveMember(dragData, destBaseJob, targetEmpName = null, insertPosition = 'end', isCopy = false) {
    const empName = dragData.empName || dragData.name;
    const { fromBaseJob, fromSideType } = dragData;
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const normName = String(empName || '').trim().toLowerCase();
    const destCrew = plan.crews.find(c => c.jobNumber.toLowerCase() === String(destBaseJob || '').toLowerCase());
    if (!destCrew) return;

    // CASE 1: Reordering within the SAME crew (not a copy)
    if (!isCopy && fromBaseJob && destBaseJob && fromBaseJob.toLowerCase() === destBaseJob.toLowerCase()) {
      const fromIdx = destCrew.members.findIndex(m => m.name.trim().toLowerCase() === normName);
      if (fromIdx === -1) return;

      const [memberObj] = destCrew.members.splice(fromIdx, 1);

      if (!targetEmpName || insertPosition === 'end') {
        destCrew.members.push(memberObj);
      } else {
        const normTarget = String(targetEmpName).trim().toLowerCase();
        let targetIdx = destCrew.members.findIndex(m => m.name.trim().toLowerCase() === normTarget);
        if (targetIdx === -1) {
          destCrew.members.push(memberObj);
        } else {
          if (insertPosition === 'after') {
            targetIdx += 1;
          }
          destCrew.members.splice(targetIdx, 0, memberObj);
        }
      }

      // Renumber slots sequentially (destCrew.jobNumber.1, .2, .3, ...)
      destCrew.members.forEach((m, idx) => {
        m.slot = `${destCrew.jobNumber}.${idx + 1}`;
      });

      this.savePlan(plan);
      this.refreshView();

      if (typeof window.showToast === 'function') {
        window.showToast(`↕️ Reordered ${memberObj.name} in Crew ${destCrew.jobNumber}`, 'info');
      }
      return;
    }

    // CASE 2: Moving or copying from another crew or side category
    const existingDestIdx = destCrew.members.findIndex(m => m.name.trim().toLowerCase() === normName);
    if (isCopy && existingDestIdx !== -1) {
      if (typeof window.showToast === 'function') {
        window.showToast(`${empName} is already assigned to Crew ${destCrew.jobNumber}.`, 'info');
      }
      return;
    }

    let memberObj = null;

    if (fromSideType && plan.sidePane[fromSideType]) {
      const idx = plan.sidePane[fromSideType].findIndex(m => m.name.trim().toLowerCase() === normName);
      if (idx !== -1) {
        if (isCopy) {
          memberObj = { ...plan.sidePane[fromSideType][idx], isConfirmed: false, isDuplicate: true };
        } else {
          memberObj = plan.sidePane[fromSideType].splice(idx, 1)[0];
        }
      }
    } else if (fromBaseJob) {
      const srcCrew = plan.crews.find(c => c.jobNumber.toLowerCase() === fromBaseJob.toLowerCase());
      if (srcCrew) {
        const idx = srcCrew.members.findIndex(m => m.name.trim().toLowerCase() === normName);
        if (idx !== -1) {
          if (isCopy) {
            memberObj = { ...srcCrew.members[idx], isConfirmed: false, isDuplicate: true };
          } else {
            memberObj = srcCrew.members.splice(idx, 1)[0];
            // Renumber remaining members of source crew
            srcCrew.members.forEach((m, i) => {
              m.slot = `${srcCrew.jobNumber}.${i + 1}`;
            });
            // If moved member was the foreman of source crew, update/clear source crew foreman
            if (this.isCrewForeman(srcCrew, memberObj.name)) {
              srcCrew.foreman = this.pickBestForeman(srcCrew.members);
            }
          }
        }
      }
    }

    // Fallback: search anywhere in plan if not found in specified source
    if (!memberObj) {
      for (const c of plan.crews) {
        const found = c.members.find(m => m.name.trim().toLowerCase() === normName);
        if (found) {
          memberObj = { ...found, isConfirmed: false, isDuplicate: true };
          break;
        }
      }
    }
    if (!memberObj && plan.sidePane) {
      for (const cat of ['planning', 'vacation', 'weeds', 'lightDuty', 'quit', 'pendingHires']) {
        const found = (plan.sidePane[cat] || []).find(m => m.name.trim().toLowerCase() === normName);
        if (found) {
          memberObj = { ...found, isConfirmed: false, isDuplicate: true };
          break;
        }
      }
    }

    if (!memberObj) {
      // Lookup from live employees table to preserve role & classification
      const empTable = this.db ? this.db.getTable('employees') : null;
      const liveRow = (empTable?.rows || []).find(r => String(r['Employee Name'] || r['Name'] || '').trim().toLowerCase() === normName);
      memberObj = {
        name: empName,
        classification: liveRow ? String(liveRow['Job Classification'] || liveRow['Classification'] || 'Journeyman').trim() : 'Journeyman',
        role: liveRow ? String(liveRow['Role'] || 'JL').trim() : 'JL',
        isConfirmed: false,
        isDuplicate: true
      };
    }

    // If employee already exists in destination crew during a non-copy move, remove existing entry so we don't duplicate
    if (!isCopy && existingDestIdx !== -1) {
      const idxInDest = destCrew.members.findIndex(m => m.name.trim().toLowerCase() === normName);
      if (idxInDest !== -1) {
        const existingInDest = destCrew.members.splice(idxInDest, 1)[0];
        memberObj = { ...existingInDest, ...memberObj };
      }
    }

    // Mark as unconfirmed on move/copy into different crew so it glows purple
    memberObj.isConfirmed = false;
    if (isCopy) memberObj.isDuplicate = true;
    this.clearMemberConfirmations(
      plan,
      memberObj.name,
      isCopy ? [destBaseJob] : [fromBaseJob, fromSideType, destBaseJob]
    );

    // Insert into destination crew at target position
    if (insertPosition === 'start') {
      destCrew.members.unshift(memberObj);
    } else if (!targetEmpName || insertPosition === 'end') {
      destCrew.members.push(memberObj);
    } else {
      const normTarget = String(targetEmpName).trim().toLowerCase();
      let targetIdx = destCrew.members.findIndex(m => m.name.trim().toLowerCase() === normTarget);
      if (targetIdx === -1) {
        destCrew.members.push(memberObj);
      } else {
        if (insertPosition === 'after') {
          targetIdx += 1;
        }
        destCrew.members.splice(targetIdx, 0, memberObj);
      }
    }

    // Renumber all members in destination crew sequentially (.1, .2, .3, ...)
    destCrew.members.forEach((m, idx) => {
      m.slot = `${destCrew.jobNumber}.${idx + 1}`;
    });

    // If destination crew had no foreman, or if moving member is a lead rank and was placed at start:
    const isLeadRank = this.isLeadClassification(memberObj.classification || memberObj.role);
    if (!destCrew.foreman || (insertPosition === 'start' && isLeadRank)) {
      destCrew.foreman = memberObj.name;
    }

    // If employee has a scheduled departure, keep their active crew updated in Quit / Notice
    if (plan.sidePane && plan.sidePane.quit) {
      const qItem = plan.sidePane.quit.find(q => q.name.trim().toLowerCase() === normName);
      if (qItem && qItem.isScheduledDeparture) {
        qItem.activeCrew = destCrew.jobNumber;
        qItem.currentJob = memberObj.slot;
      }
    }

    this.savePlan(plan);
    this.refreshView();

    if (typeof window.showToast === 'function') {
      const actionVerb = isCopy ? 'Duplicated' : 'Moved';
      window.showToast(`${actionVerb} ${memberObj.name} to Crew ${destCrew.jobNumber}`, 'info');
    }
  }

  handleMoveToCrew(dragData, destBaseJob, isCopy = false) {
    return this.handleReorderOrMoveMember(dragData, destBaseJob, null, 'end', isCopy);
  }

  handleMoveToSideCategory(dragData, destSideType, isCopy = false) {
    const empName = dragData.empName || dragData.name;
    const { fromBaseJob, fromSideType } = dragData;
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan || !plan.sidePane[destSideType]) return;

    if (!isCopy && fromSideType === destSideType) return;

    // RULE: If moving to Quit / Notice, prompt for Last Working Day & departure details first!
    if (destSideType === 'quit') {
      this.promptQuitDeparture(dragData, isCopy);
      return;
    }

    // RULE: If moving to Scheduled Vacation, prompt for Vacation Dates & This Week vs. Future Week scope!
    if (destSideType === 'vacation') {
      this.promptVacationSchedule(dragData, isCopy);
      return;
    }

    const normName = String(empName || '').trim().toLowerCase();
    const existingDestIdx = plan.sidePane[destSideType].findIndex(m => m.name.trim().toLowerCase() === normName);
    if (isCopy && existingDestIdx !== -1) {
      if (typeof window.showToast === 'function') {
        window.showToast(`${empName} is already staged in ${destSideType}.`, 'info');
      }
      return;
    }

    let memberObj = null;

    if (fromSideType && plan.sidePane[fromSideType]) {
      const idx = plan.sidePane[fromSideType].findIndex(m => m.name.trim().toLowerCase() === normName);
      if (idx !== -1) {
        if (isCopy) {
          memberObj = { ...plan.sidePane[fromSideType][idx], isConfirmed: false, isDuplicate: true };
        } else {
          memberObj = plan.sidePane[fromSideType].splice(idx, 1)[0];
        }
      }
    } else if (fromBaseJob) {
      const srcCrew = plan.crews.find(c => c.jobNumber.toLowerCase() === fromBaseJob.toLowerCase());
      if (srcCrew) {
        const idx = srcCrew.members.findIndex(m => m.name.trim().toLowerCase() === normName);
        if (idx !== -1) {
          if (isCopy) {
            memberObj = { ...srcCrew.members[idx], isConfirmed: false, isDuplicate: true };
          } else {
            memberObj = srcCrew.members.splice(idx, 1)[0];
            // Renumber remaining members of source crew sequentially
            srcCrew.members.forEach((m, i) => {
              m.slot = `${srcCrew.jobNumber}.${i + 1}`;
            });
            // If moved member was the foreman of source crew, update/clear source crew foreman
            if (this.isCrewForeman(srcCrew, memberObj.name)) {
              srcCrew.foreman = this.pickBestForeman(srcCrew.members);
            }
          }
        }
      }
    }

    if (!memberObj) {
      for (const c of plan.crews) {
        const found = c.members.find(m => m.name.trim().toLowerCase() === normName);
        if (found) {
          memberObj = { ...found, isConfirmed: false, isDuplicate: true };
          break;
        }
      }
    }

    if (!memberObj) {
      memberObj = { name: empName, isConfirmed: false, isDuplicate: isCopy };
    }

    memberObj.currentJob = fromBaseJob || memberObj.currentJob || '';
    memberObj.priorBaseJob = fromBaseJob || memberObj.priorBaseJob || memberObj.currentJob || memberObj.originalBaseJob || '';
    memberObj.isConfirmed = false;
    if (isCopy) memberObj.isDuplicate = true;
    this.clearMemberConfirmations(
      plan,
      memberObj.name,
      isCopy ? [destSideType] : [fromBaseJob, fromSideType, destSideType]
    );
    if (existingDestIdx !== -1) {
      plan.sidePane[destSideType][existingDestIdx] = { ...plan.sidePane[destSideType][existingDestIdx], ...memberObj };
    } else {
      plan.sidePane[destSideType].push(memberObj);
    }

    this.savePlan(plan);
    this.refreshView();
  }

  /**
   * Prompts the user to enter the Last Working Day, reason, and notes when moving to Quit/Notice.
   */
  promptQuitDeparture(dragData, isCopy = false, existingItem = null) {
    const empName = dragData.empName || dragData.name;
    const { fromBaseJob } = dragData;
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const modalId = 'modal-crew-quit-departure';
    let existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const normName = String(empName || '').trim().toLowerCase();
    let targetCrewNumber = fromBaseJob || existingItem?.activeCrew || existingItem?.currentJob || '';
    if (!targetCrewNumber) {
      const c = plan.crews.find(cr => cr.members.some(m => m.name.trim().toLowerCase() === normName));
      if (c) targetCrewNumber = c.jobNumber;
    }
    const keepOnCrewDefault = Boolean(targetCrewNumber && (!existingItem || existingItem.isScheduledDeparture !== false));

    // Default Last Day calculation
    const computeDefaultDate = () => {
      if (existingItem && existingItem.departureDate) {
        return existingItem.departureDate;
      }
      const sunday = this.parseDate(this.selectedWeek) || this.getSundayOfDate(new Date());
      const friday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 5, 12, 0, 0);
      return this.formatDate(friday);
    };

    const defaultDate = computeDefaultDate();
    const now = new Date();
    const todayFormatted = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
    const todayIso = this.formatIso(now);

    const toIsoDate = (dStr) => {
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(dStr)) {
        const p = dStr.split('/');
        return `${p[2]}-${p[0]}-${p[1]}`;
      }
      return todayIso;
    };

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.8) !important; display: flex; align-items: center; justify-content: center; z-index: 16500 !important; pointer-events: auto !important; padding: 20px;';

    overlay.innerHTML = `
      <div class="modal-box" style="background: #1e293b; border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 10px; max-width: 500px; width: 100%; box-shadow: 0 20px 45px rgba(0,0,0,0.85); overflow: hidden; pointer-events: auto !important; position: relative; z-index: 16501 !important;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%); color: white; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(239, 68, 68, 0.4);">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 20px;">🚪</span>
            <div>
              <div style="font-weight: 800; font-size: 15px;">Employee Departure / Notice</div>
              <div style="font-size: 11px; opacity: 0.85;">Record last working day for employee history & archival</div>
            </div>
          </div>
          <button id="btn-quit-close-x" style="background: rgba(0,0,0,0.25); border: none; color: white; font-size: 14px; width: 28px; height: 28px; border-radius: 4px; cursor: pointer;">✕</button>
        </div>

        <!-- Body -->
        <div style="padding: 20px; display: flex; flex-direction: column; gap: 15px;">
          <!-- Employee Info Banner -->
          <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 11px; color: #f87171; font-weight: 700; text-transform: uppercase;">Employee Departing</div>
              <div style="font-size: 16px; font-weight: 800; color: #ffffff;">${this.escapeHtml(empName)}</div>
            </div>
            <div style="text-align: right; font-size: 12px; color: #94a3b8;">
              <div>Active Crew: <strong style="color: #cbd5e1;">${this.escapeHtml(targetCrewNumber || fromBaseJob || existingItem?.currentJob || 'Staging')}</strong></div>
            </div>
          </div>

          <!-- Date Input -->
          <div>
            <label style="font-size: 12px; font-weight: 700; color: #fca5a5; margin-bottom: 5px; display: flex; align-items: center; justify-content: space-between;">
              <span>📅 Last Working Day <span style="color: #ef4444;">*</span></span>
              <span style="font-size: 11px; font-weight: normal; color: #94a3b8;">(MM/DD/YYYY)</span>
            </label>
            <div style="display: flex; gap: 8px; margin-bottom: 6px;">
              <input type="text" id="quit-depart-date" value="${this.escapeHtml(defaultDate)}" placeholder="MM/DD/YYYY" style="flex: 1; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; padding: 8px 12px; font-size: 13px; font-weight: 600;" />
              <input type="date" id="quit-depart-date-picker" value="${toIsoDate(defaultDate)}" style="background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; padding: 7px 10px; cursor: pointer;" title="Pick from calendar" />
            </div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              <button type="button" id="quit-quick-today" class="btn btn-xs" style="font-size: 11px; padding: 3px 8px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; cursor: pointer;">📅 Today (${todayFormatted})</button>
              <button type="button" id="quit-quick-planned" class="btn btn-xs" style="font-size: 11px; padding: 3px 8px; background: rgba(148, 163, 184, 0.12); border: 1px solid rgba(148, 163, 184, 0.25); color: #cbd5e1; cursor: pointer;">📅 Planned Week Friday (${defaultDate})</button>
            </div>
          </div>

          <!-- Reason -->
          <div>
            <label for="quit-depart-reason" style="font-size: 12px; font-weight: 700; color: #fca5a5; margin-bottom: 5px; display: block;">
              <span>📋 Departure Reason <span style="color: #ef4444;">*</span></span>
            </label>
            <select id="quit-depart-reason" style="width: 100%; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; padding: 8px 12px; font-size: 13px; font-weight: 600;">
              <option value="Quit" ${(existingItem?.departureReason === 'Quit' || !existingItem) ? 'selected' : ''}>Quit (Voluntary)</option>
              <option value="Resigned" ${existingItem?.departureReason === 'Resigned' ? 'selected' : ''}>Resigned (Voluntary)</option>
              <option value="Layoff" ${existingItem?.departureReason === 'Layoff' ? 'selected' : ''}>Layoff (Reduction in Force)</option>
              <option value="Terminated" ${existingItem?.departureReason === 'Terminated' ? 'selected' : ''}>Terminated (Involuntary)</option>
              <option value="Fired" ${existingItem?.departureReason === 'Fired' ? 'selected' : ''}>Fired (Involuntary)</option>
              <option value="Medical" ${existingItem?.departureReason === 'Medical' ? 'selected' : ''}>Medical / Disability Leave</option>
              <option value="Other" ${existingItem?.departureReason === 'Other' ? 'selected' : ''}>Other</option>
            </select>
          </div>

          <!-- Notes -->
          <div>
            <label for="quit-depart-notes" style="font-size: 12px; font-weight: 700; color: #cbd5e1; margin-bottom: 5px; display: block;">
              <span>📝 Departure Notes / Details</span>
            </label>
            <input type="text" id="quit-depart-notes" value="${this.escapeHtml(existingItem?.notes || '')}" placeholder="e.g. 2-week notice given, moving to another company..." style="width: 100%; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; padding: 8px 12px; font-size: 13px;" />
          </div>

          <!-- Keep on crew option -->
          <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 8px; padding: 10px 14px;">
            <label style="display: flex; align-items: flex-start; gap: 9px; cursor: pointer; font-size: 12px; color: #f1f5f9;">
              <input type="checkbox" id="quit-keep-on-crew" ${keepOnCrewDefault ? 'checked' : ''} style="margin-top: 2px; cursor: pointer; accent-color: #3b82f6; width: 16px; height: 16px;">
              <div>
                <div style="font-weight: 700; color: #93c5fd;">Keep employee active on crew (${this.escapeHtml(targetCrewNumber || 'current crew')}) until Last Day</div>
                <div style="font-size: 11px; color: #94a3b8; line-height: 1.4; margin-top: 2px;">
                  Employee remains on the field crew through their last day. A 🚪 notice badge appears on their crew row, and their scheduled departure is tracked in Quit / Notice. Uncheck for immediate departure.
                </div>
              </div>
            </label>
          </div>

          <!-- Notice banner -->
          <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 8px; padding: 10px 14px; font-size: 11.5px; color: #cbd5e1; line-height: 1.5;">
            <div style="font-weight: 700; color: #60a5fa; margin-bottom: 2px;">ℹ️ Milestone & Archival Timing:</div>
            <div>• This last day milestone will be recorded in <strong>Employee History</strong> upon publishing.</div>
            <div>• The employee is automatically moved to <strong>Previous Employees</strong> on their recorded last day.</div>
          </div>
        </div>

        <!-- Footer -->
        <div style="background: rgba(15, 23, 42, 0.6); border-top: 1px solid rgba(255,255,255,0.1); padding: 12px 20px; display: flex; justify-content: space-between; align-items: center;">
          <button id="btn-quit-cancel" class="btn btn-secondary" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">
            Cancel
          </button>
          <button id="btn-quit-confirm" class="btn btn-primary" style="background: #dc2626; border-color: #b91c1c; font-weight: 700; font-size: 12.5px; padding: 7px 18px; cursor: pointer;">
            🚪 Confirm Last Day & Stage
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const dateInput = overlay.querySelector('#quit-depart-date');
    const datePicker = overlay.querySelector('#quit-depart-date-picker');
    const reasonSelect = overlay.querySelector('#quit-depart-reason');
    const notesInput = overlay.querySelector('#quit-depart-notes');

    datePicker?.addEventListener('change', () => {
      if (datePicker.value) {
        const p = datePicker.value.split('-');
        if (p.length === 3) dateInput.value = `${p[1]}/${p[2]}/${p[0]}`;
      }
    });

    dateInput?.addEventListener('input', () => {
      const val = dateInput.value.trim();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(val)) {
        const p = val.split('/');
        datePicker.value = `${p[2]}-${p[0]}-${p[1]}`;
      }
    });

    overlay.querySelector('#quit-quick-today')?.addEventListener('click', () => {
      dateInput.value = todayFormatted;
      datePicker.value = todayIso;
    });

    overlay.querySelector('#quit-quick-planned')?.addEventListener('click', () => {
      dateInput.value = defaultDate;
      datePicker.value = toIsoDate(defaultDate);
    });

    let onKey;
    const closeModal = () => {
      if (onKey) window.removeEventListener('keydown', onKey);
      overlay.remove();
    };

    overlay.querySelector('#btn-quit-close-x')?.addEventListener('click', closeModal);
    overlay.querySelector('#btn-quit-cancel')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    onKey = (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    window.addEventListener('keydown', onKey);

    overlay.querySelector('#btn-quit-confirm')?.addEventListener('click', () => {
      let dVal = (dateInput?.value || '').trim();
      if (!dVal) dVal = defaultDate;
      if (dVal.includes('-')) {
        const p = dVal.split('-');
        if (p.length === 3) dVal = `${p[1]}/${p[2]}/${p[0]}`;
      }

      const reasonVal = reasonSelect?.value || 'Quit';
      const notesVal = (notesInput?.value || '').trim();
      const keepOnCrew = Boolean(overlay.querySelector('#quit-keep-on-crew')?.checked);

      if (existingItem) {
        existingItem.departureDate = dVal;
        existingItem.departureReason = reasonVal;
        existingItem.notes = notesVal;
        existingItem.dateRange = `Last Day: ${dVal}`;
        existingItem.isScheduledDeparture = keepOnCrew;

        if (keepOnCrew && targetCrewNumber) {
          existingItem.activeCrew = targetCrewNumber;
          const c = plan.crews.find(cr => cr.jobNumber.toLowerCase() === targetCrewNumber.toLowerCase());
          if (c) {
            let mem = c.members.find(m => m.name.toLowerCase() === normName);
            if (!mem) {
              mem = {
                name: existingItem.name,
                classification: existingItem.classification || 'Journeyman',
                role: existingItem.role || 'JL',
                isConfirmed: false,
                slot: `${c.jobNumber}.${c.members.length + 1}`
              };
              c.members.push(mem);
            }
            mem.departureDate = dVal;
            mem.departureReason = reasonVal;
            mem.departureNotes = notesVal;
          }
        } else if (!keepOnCrew) {
          plan.crews.forEach(cr => {
            const had = cr.members.some(m => m.name.toLowerCase() === normName);
            if (had) {
              const wasFm = this.isCrewForeman(cr, existingItem.name);
              cr.members = cr.members.filter(m => m.name.toLowerCase() !== normName);
              cr.members.forEach((m, idx) => m.slot = `${cr.jobNumber}.${idx + 1}`);
              if (wasFm) {
                cr.foreman = this.pickBestForeman(cr.members);
              }
            }
          });
          existingItem.activeCrew = '';
          existingItem.isScheduledDeparture = false;
        }

        this.savePlan(plan);
        this.refreshView();
        closeModal();
        if (typeof window.showToast === 'function') {
          window.showToast(`Updated ${empName}'s Last Day to ${dVal}.`, 'success');
        }
      } else {
        closeModal();
        this.finalizeMoveToQuit(dragData, dVal, reasonVal, notesVal, isCopy, keepOnCrew, targetCrewNumber);
      }
    });

    setTimeout(() => {
      dateInput?.focus();
      dateInput?.select();
    }, 50);
  }

  finalizeMoveToQuit(dragData, departureDate, departureReason = 'Quit', notes = '', isCopy = false, keepOnCrew = true, targetCrewNumber = '') {
    const { empName, fromBaseJob, fromSideType } = dragData;
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const normName = String(empName || '').trim().toLowerCase();

    // Check if employee is on an active crew
    const crewNum = fromBaseJob || targetCrewNumber;
    let srcCrew = null;
    let memberObj = null;

    if (crewNum) {
      srcCrew = plan.crews.find(c => c.jobNumber.toLowerCase() === crewNum.toLowerCase());
      if (srcCrew) {
        memberObj = srcCrew.members.find(m => m.name.trim().toLowerCase() === normName);
      }
    }
    if (!memberObj) {
      for (const c of plan.crews) {
        const found = c.members.find(m => m.name.trim().toLowerCase() === normName);
        if (found) {
          srcCrew = c;
          memberObj = found;
          break;
        }
      }
    }

    if (keepOnCrew && srcCrew && memberObj) {
      // 1. Keep employee active on their crew!
      memberObj.departureDate = departureDate;
      memberObj.departureReason = departureReason;
      memberObj.departureNotes = notes;

      // 2. Add or update mirror entry in plan.sidePane.quit
      if (!plan.sidePane.quit) plan.sidePane.quit = [];
      const quitIdx = plan.sidePane.quit.findIndex(q => q.name.trim().toLowerCase() === normName);
      const quitItem = {
        name: memberObj.name,
        classification: memberObj.classification || memberObj.role || 'Journeyman',
        role: memberObj.role || 'JL',
        currentJob: memberObj.slot,
        activeCrew: srcCrew.jobNumber,
        departureDate: departureDate,
        departureReason: departureReason,
        notes: notes,
        dateRange: `Last Day: ${departureDate}`,
        isScheduledDeparture: true,
        isConfirmed: true
      };

      if (quitIdx !== -1) {
        plan.sidePane.quit[quitIdx] = quitItem;
      } else {
        plan.sidePane.quit.push(quitItem);
      }
      if (!plan.confirmedPositions) plan.confirmedPositions = {};
      plan.confirmedPositions[`${normName}::quit`] = true;

      this.savePlan(plan);
      this.refreshView();

      if (typeof window.showToast === 'function') {
        window.showToast(`🚪 Recorded Last Day (${departureDate}) for ${empName}. Active on Crew ${srcCrew.jobNumber} until departure.`, 'info');
      }
      return;
    }

    // Otherwise: Immediate walkout / removal from crew
    if (fromSideType && plan.sidePane[fromSideType]) {
      const idx = plan.sidePane[fromSideType].findIndex(m => m.name.trim().toLowerCase() === normName);
      if (idx !== -1) {
        if (isCopy) {
          memberObj = { ...plan.sidePane[fromSideType][idx], isConfirmed: false, isDuplicate: true };
        } else {
          memberObj = plan.sidePane[fromSideType].splice(idx, 1)[0];
        }
      }
    } else if (fromBaseJob) {
      const sCrew = plan.crews.find(c => c.jobNumber.toLowerCase() === fromBaseJob.toLowerCase());
      if (sCrew) {
        const idx = sCrew.members.findIndex(m => m.name.trim().toLowerCase() === normName);
        if (idx !== -1) {
          if (isCopy) {
            memberObj = { ...sCrew.members[idx], isConfirmed: false, isDuplicate: true };
          } else {
            memberObj = sCrew.members.splice(idx, 1)[0];
            sCrew.members.forEach((m, i) => {
              m.slot = `${sCrew.jobNumber}.${i + 1}`;
            });
            if (this.isCrewForeman(sCrew, memberObj.name)) {
              sCrew.foreman = this.pickBestForeman(sCrew.members);
            }
          }
        }
      }
    }

    if (!memberObj) {
      for (const c of plan.crews) {
        const found = c.members.find(m => m.name.trim().toLowerCase() === normName);
        if (found) {
          memberObj = { ...found, isConfirmed: false, isDuplicate: true };
          break;
        }
      }
    }
    if (!memberObj && plan.sidePane) {
      for (const cat of ['planning', 'vacation', 'weeds', 'lightDuty', 'pendingHires']) {
        const found = (plan.sidePane[cat] || []).find(m => m.name.trim().toLowerCase() === normName);
        if (found) {
          memberObj = { ...found, isConfirmed: false, isDuplicate: true };
          break;
        }
      }
    }

    if (!memberObj) {
      memberObj = { name: empName, isConfirmed: false, isDuplicate: isCopy };
    }

    memberObj.currentJob = fromBaseJob || memberObj.currentJob || '';
    memberObj.priorBaseJob = fromBaseJob || memberObj.priorBaseJob || memberObj.currentJob || memberObj.originalBaseJob || '';
    memberObj.isConfirmed = false;
    if (isCopy) memberObj.isDuplicate = true;
    this.clearMemberConfirmations(
      plan,
      memberObj.name,
      isCopy ? ['quit'] : [fromBaseJob, fromSideType, 'quit']
    );
    memberObj.departureDate = departureDate;
    memberObj.departureReason = departureReason;
    memberObj.notes = notes;
    memberObj.dateRange = `Last Day: ${departureDate}`;
    memberObj.isScheduledDeparture = false;

    if (!plan.sidePane.quit) plan.sidePane.quit = [];
    const existingQuitIdx = plan.sidePane.quit.findIndex(q => q.name.trim().toLowerCase() === normName);
    if (existingQuitIdx !== -1) {
      plan.sidePane.quit[existingQuitIdx] = memberObj;
    } else {
      plan.sidePane.quit.push(memberObj);
    }

    this.savePlan(plan);
    this.refreshView();

    if (typeof window.showToast === 'function') {
      window.showToast(`🚪 Staged ${empName} under Quit/Notice (Last Day: ${departureDate}).`, 'info');
    }
  }

  editQuitDeparture(empName) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan || !plan.sidePane || !plan.sidePane.quit) return;

    const norm = String(empName || '').trim().toLowerCase();
    const item = plan.sidePane.quit.find(q => q.name.trim().toLowerCase() === norm);
    if (!item) return;

    const dragData = {
      empName: item.name,
      fromBaseJob: item.currentJob || '',
      fromSideType: 'quit'
    };
    this.promptQuitDeparture(dragData, false, item);
  }

  /**
   * Prompts the user to enter Vacation Start/End Dates, Notes, and clarify whether the vacation
   * is for This Planned Week or a Future Week when dragging/editing an employee in Scheduled Vacation.
   */
  promptVacationSchedule(dragData, isCopy = false, existingItem = null) {
    const empName = dragData.empName || dragData.name;
    const { fromBaseJob } = dragData;
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const modalId = 'modal-crew-vacation-schedule';
    const existingModal = document.getElementById(modalId);
    if (existingModal) existingModal.remove();

    const normName = String(empName || '').trim().toLowerCase();
    const baselineMap = this.getOriginalEmployeeLocations();
    const baseInfo = baselineMap.get(normName);

    let targetCrewNumber = (
      fromBaseJob ||
      existingItem?.activeCrew ||
      existingItem?.priorBaseJob ||
      (existingItem?.currentJob ? String(existingItem.currentJob).replace(/\.\d+.*$/, '').trim() : '') ||
      baseInfo?.originalBaseJob ||
      ''
    ).replace(/\.\d+.*$/, '').trim();

    if (!targetCrewNumber) {
      const c = plan.crews.find(cr => cr.members.some(m => m.name.trim().toLowerCase() === normName));
      if (c) targetCrewNumber = c.jobNumber;
    }

    // Parse planned week Sunday date
    const weekSun = this.parseDate(this.selectedWeek) || this.getSundayOfDate(new Date());
    const fmtDate = (dt) => this.formatDate(dt);

    const toIsoDate = (dStr) => {
      const parsed = this.parseFlexibleDate(dStr);
      return parsed ? this.formatIso(parsed) : this.formatIso(new Date());
    };

    const parseMmDdYyyy = (dStr) => this.parseFlexibleDate(dStr);
    const weekSat = new Date(weekSun.getFullYear(), weekSun.getMonth(), weekSun.getDate() + 6, 12, 0, 0);

    const addDays = (base, offset) => {
      const d = new Date(base);
      d.setDate(base.getDate() + offset);
      return d;
    };

    // Preset ranges (Mon - Thu)
    const thisMon = fmtDate(addDays(weekSun, 1));
    const thisThu = fmtDate(addDays(weekSun, 4));
    const nextMon = fmtDate(addDays(weekSun, 8));
    const nextThu = fmtDate(addDays(weekSun, 11));
    const wk2Mon = fmtDate(addDays(weekSun, 15));
    const wk2Thu = fmtDate(addDays(weekSun, 18));

    // Existing start/end dates
    let defaultStart = existingItem?.vacationStartDate || '';
    let defaultEnd = existingItem?.vacationEndDate || '';
    if (!defaultStart && existingItem?.dateRange) {
      const parts = String(existingItem.dateRange).split(/\s*-\s*/);
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(parts[0] || '')) {
        defaultStart = parts[0];
        defaultEnd = parts[1] && /^\d{2}\/\d{2}\/\d{4}$/.test(parts[1]) ? parts[1] : parts[0];
      }
    }
    if (!defaultStart) defaultStart = thisMon;
    if (!defaultEnd) defaultEnd = thisThu;

    const initialIsFuture = Boolean(existingItem?.isFutureVacation);
    const initialKeepOnCrew = existingItem
      ? Boolean(existingItem.keepOnCrew || existingItem.isFutureVacation)
      : false;

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.82) !important; display: flex; align-items: center; justify-content: center; z-index: 16500 !important; pointer-events: auto !important; padding: 20px;';

    overlay.innerHTML = `
      <div class="modal-box" style="background: #1e293b; border: 1px solid rgba(245, 158, 11, 0.45); border-radius: 10px; max-width: 540px; width: 100%; box-shadow: 0 20px 45px rgba(0,0,0,0.85); overflow: hidden; pointer-events: auto !important; position: relative; z-index: 16501 !important;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #92400e 0%, #b45309 100%); color: white; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(245, 158, 11, 0.4);">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 21px;">🏖️</span>
            <div>
              <div style="font-weight: 800; font-size: 15px;">Scheduled Vacation — Dates & Week Scope</div>
              <div style="font-size: 11px; opacity: 0.9;">Specify vacation dates and clarify if this is for this week or a future week</div>
            </div>
          </div>
          <button id="btn-vac-close-x" style="background: rgba(0,0,0,0.25); border: none; color: white; font-size: 14px; width: 28px; height: 28px; border-radius: 4px; cursor: pointer;">✕</button>
        </div>

        <!-- Body -->
        <div style="padding: 18px 20px; display: flex; flex-direction: column; gap: 14px;">
          <!-- Employee Info Banner -->
          <div style="background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; padding: 11px 14px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 10.5px; color: #fbbf24; font-weight: 700; text-transform: uppercase;">Employee on Scheduled Vacation</div>
              <div style="font-size: 16px; font-weight: 800; color: #ffffff;">${this.escapeHtml(empName)}</div>
            </div>
            <div style="text-align: right; font-size: 12px; color: #94a3b8;">
              <div>Home / Active Crew: <strong style="color: #fde68a;">${this.escapeHtml(targetCrewNumber || 'Unassigned')}</strong></div>
              <div style="font-size: 10.5px; color: #64748b;">Planned Week: ${this.escapeHtml(this.selectedWeek || '')}</div>
            </div>
          </div>

          <!-- 1. Week Scope Clarification (This Week vs Future Week) -->
          <div>
            <label style="font-size: 12px; font-weight: 700; color: #fde68a; margin-bottom: 6px; display: block;">
              <span>1️⃣ Is this vacation for this planned week or a future week? <span style="color: #f59e0b;">*</span></span>
            </label>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
              <label id="vac-scope-card-this" style="background: ${!initialIsFuture ? 'rgba(16, 185, 129, 0.16)' : 'rgba(15, 23, 42, 0.65)'}; border: 1.5px solid ${!initialIsFuture ? '#10b981' : 'rgba(255,255,255,0.12)'}; border-radius: 8px; padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; transition: all 0.15s ease;">
                <div style="display: flex; align-items: center; gap: 7px;">
                  <input type="radio" name="vacation-week-scope" id="vac-scope-this" value="this_week" ${!initialIsFuture ? 'checked' : ''} style="accent-color: #10b981; cursor: pointer;" />
                  <span style="font-size: 12.5px; font-weight: 800; color: #6ee7b7;">🗓️ This Planned Week</span>
                </div>
                <div style="font-size: 10.5px; color: #cbd5e1; line-height: 1.35; padding-left: 20px;">
                  Off during week of <strong>${this.escapeHtml(this.selectedWeek || '')}</strong>. Removes from field crew for this week (unless partial week).
                </div>
              </label>

              <label id="vac-scope-card-future" style="background: ${initialIsFuture ? 'rgba(59, 130, 246, 0.18)' : 'rgba(15, 23, 42, 0.65)'}; border: 1.5px solid ${initialIsFuture ? '#3b82f6' : 'rgba(255,255,255,0.12)'}; border-radius: 8px; padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; transition: all 0.15s ease;">
                <div style="display: flex; align-items: center; gap: 7px;">
                  <input type="radio" name="vacation-week-scope" id="vac-scope-future" value="future_week" ${initialIsFuture ? 'checked' : ''} style="accent-color: #3b82f6; cursor: pointer;" />
                  <span style="font-size: 12.5px; font-weight: 800; color: #93c5fd;">⏭️ Future Week</span>
                </div>
                <div style="font-size: 10.5px; color: #cbd5e1; line-height: 1.35; padding-left: 20px;">
                  Upcoming vacation for a future week. <strong>Keeps active on Crew ${this.escapeHtml(targetCrewNumber || 'current crew')}</strong> for this week!
                </div>
              </label>
            </div>
          </div>

          <!-- 2. Vacation Start & End Dates -->
          <div>
            <label style="font-size: 12px; font-weight: 700; color: #fde68a; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
              <span>2️⃣ Vacation Dates (Start Date — End Date) <span style="color: #f59e0b;">*</span></span>
              <span style="font-size: 11px; font-weight: normal; color: #94a3b8;">(MM/DD/YYYY)</span>
            </label>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px;">
              <div>
                <div style="font-size: 10.5px; color: #94a3b8; margin-bottom: 3px;">Start Date (First Day Off)</div>
                <div style="display: flex; gap: 5px;">
                  <input type="text" id="vac-start-date" value="${this.escapeHtml(defaultStart)}" placeholder="MM/DD/YYYY" style="flex: 1; min-width: 0; background: #0f172a; border: 1px solid rgba(255,255,255,0.16); border-radius: 6px; color: #ffffff; padding: 7px 10px; font-size: 12.5px; font-weight: 600;" />
                  <input type="date" id="vac-start-picker" value="${toIsoDate(defaultStart)}" style="width: 38px; background: #0f172a; border: 1px solid rgba(255,255,255,0.16); border-radius: 6px; color: #ffffff; padding: 5px; cursor: pointer;" title="Pick Start Date" />
                </div>
              </div>
              <div>
                <div style="font-size: 10.5px; color: #94a3b8; margin-bottom: 3px;">End Date (Last Day Off)</div>
                <div style="display: flex; gap: 5px;">
                  <input type="text" id="vac-end-date" value="${this.escapeHtml(defaultEnd)}" placeholder="MM/DD/YYYY" style="flex: 1; min-width: 0; background: #0f172a; border: 1px solid rgba(255,255,255,0.16); border-radius: 6px; color: #ffffff; padding: 7px 10px; font-size: 12.5px; font-weight: 600;" />
                  <input type="date" id="vac-end-picker" value="${toIsoDate(defaultEnd)}" style="width: 38px; background: #0f172a; border: 1px solid rgba(255,255,255,0.16); border-radius: 6px; color: #ffffff; padding: 5px; cursor: pointer;" title="Pick End Date" />
                </div>
              </div>
            </div>

            <!-- Quick Preset Buttons -->
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              <button type="button" id="vac-preset-this" class="btn btn-xs" style="font-size: 10.5px; padding: 3px 8px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: #6ee7b7; cursor: pointer;">
                📅 This Week (${thisMon} - ${thisThu})
              </button>
              <button type="button" id="vac-preset-next" class="btn btn-xs" style="font-size: 10.5px; padding: 3px 8px; background: rgba(59, 130, 246, 0.16); border: 1px solid rgba(59, 130, 246, 0.35); color: #93c5fd; cursor: pointer;">
                ⏭️ Next Week (${nextMon} - ${nextThu})
              </button>
              <button type="button" id="vac-preset-wk2" class="btn btn-xs" style="font-size: 10.5px; padding: 3px 8px; background: rgba(148, 163, 184, 0.12); border: 1px solid rgba(148, 163, 184, 0.28); color: #cbd5e1; cursor: pointer;">
                ⏭️ +2 Weeks (${wk2Mon} - ${wk2Thu})
              </button>
            </div>
          </div>

          <!-- 3. Keep on Active Crew Option -->
          <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 8px; padding: 10px 14px;">
            <label style="display: flex; align-items: flex-start; gap: 9px; cursor: pointer; font-size: 12px; color: #f1f5f9;">
              <input type="checkbox" id="vac-keep-on-crew" ${initialKeepOnCrew ? 'checked' : ''} style="margin-top: 2px; cursor: pointer; accent-color: #3b82f6; width: 16px; height: 16px;">
              <div>
                <div style="font-weight: 700; color: #93c5fd;">Keep employee active on Crew ${this.escapeHtml(targetCrewNumber || 'current crew')} during this planned week</div>
                <div style="font-size: 11px; color: #94a3b8; line-height: 1.4; margin-top: 2px;">
                  Automatically checked for <strong>Future Week</strong> vacations (and optional for partial-week vacations). A 🏖️ vacation badge will display on their crew row while tracking their dates in Scheduled Vacation.
                </div>
              </div>
            </label>
          </div>

          <!-- 4. Notes -->
          <div>
            <label for="vac-notes-input" style="font-size: 12px; font-weight: 700; color: #cbd5e1; margin-bottom: 5px; display: block;">
              <span>📝 Vacation Notes (Optional)</span>
            </label>
            <input type="text" id="vac-notes-input" value="${this.escapeHtml(existingItem?.notes || '')}" placeholder="e.g. Hunting trip, family vacation, off Thu only..." style="width: 100%; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; padding: 8px 12px; font-size: 13px;" />
          </div>
        </div>

        <!-- Footer -->
        <div style="background: rgba(15, 23, 42, 0.6); border-top: 1px solid rgba(255,255,255,0.1); padding: 12px 20px; display: flex; justify-content: space-between; align-items: center;">
          <button id="btn-vac-cancel" class="btn btn-secondary" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">
            Cancel
          </button>
          <button id="btn-vac-confirm" class="btn btn-primary" style="background: #d97706; border-color: #b45309; font-weight: 700; font-size: 12.5px; padding: 7px 18px; cursor: pointer; color: #fff;">
            🏖️ Save Vacation Schedule
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const startInput = overlay.querySelector('#vac-start-date');
    const startPicker = overlay.querySelector('#vac-start-picker');
    const endInput = overlay.querySelector('#vac-end-date');
    const endPicker = overlay.querySelector('#vac-end-picker');
    const radioThis = overlay.querySelector('#vac-scope-this');
    const radioFuture = overlay.querySelector('#vac-scope-future');
    const cardThis = overlay.querySelector('#vac-scope-card-this');
    const cardFuture = overlay.querySelector('#vac-scope-card-future');
    const keepOnCrewCb = overlay.querySelector('#vac-keep-on-crew');
    const notesInput = overlay.querySelector('#vac-notes-input');

    const updateScopeVisuals = (scopeVal, autoToggleKeep = true) => {
      const isFut = scopeVal === 'future_week';
      if (radioThis) radioThis.checked = !isFut;
      if (radioFuture) radioFuture.checked = isFut;
      if (cardThis) {
        cardThis.style.background = !isFut ? 'rgba(16, 185, 129, 0.16)' : 'rgba(15, 23, 42, 0.65)';
        cardThis.style.borderColor = !isFut ? '#10b981' : 'rgba(255,255,255,0.12)';
      }
      if (cardFuture) {
        cardFuture.style.background = isFut ? 'rgba(59, 130, 246, 0.18)' : 'rgba(15, 23, 42, 0.65)';
        cardFuture.style.borderColor = isFut ? '#3b82f6' : 'rgba(255,255,255,0.12)';
      }
      if (autoToggleKeep && keepOnCrewCb) {
        keepOnCrewCb.checked = isFut;
      }
    };

    const autoDetectScopeFromStart = (startStr) => {
      const dt = parseMmDdYyyy(startStr);
      if (!dt) return;
      if (dt.getTime() > weekSat.getTime()) {
        updateScopeVisuals('future_week', true);
      } else {
        updateScopeVisuals('this_week', true);
      }
    };

    radioThis?.addEventListener('change', () => {
      if (radioThis.checked) updateScopeVisuals('this_week', true);
    });
    radioFuture?.addEventListener('change', () => {
      if (radioFuture.checked) updateScopeVisuals('future_week', true);
    });

    startPicker?.addEventListener('change', () => {
      if (startPicker.value) {
        const p = startPicker.value.split('-');
        if (p.length === 3) {
          startInput.value = `${p[1]}/${p[2]}/${p[0]}`;
          autoDetectScopeFromStart(startInput.value);
          // If end date is before start date, bump end date to match start date
          const sDt = parseMmDdYyyy(startInput.value);
          const eDt = parseMmDdYyyy(endInput.value);
          if (sDt && (!eDt || eDt.getTime() < sDt.getTime())) {
            endInput.value = startInput.value;
            endPicker.value = startPicker.value;
          }
        }
      }
    });

    endPicker?.addEventListener('change', () => {
      if (endPicker.value) {
        const p = endPicker.value.split('-');
        if (p.length === 3) endInput.value = `${p[1]}/${p[2]}/${p[0]}`;
      }
    });

    startInput?.addEventListener('input', () => {
      const val = startInput.value.trim();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(val)) {
        startPicker.value = toIsoDate(val);
        autoDetectScopeFromStart(val);
      }
    });

    endInput?.addEventListener('input', () => {
      const val = endInput.value.trim();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(val)) {
        endPicker.value = toIsoDate(val);
      }
    });

    overlay.querySelector('#vac-preset-this')?.addEventListener('click', () => {
      startInput.value = thisMon;
      startPicker.value = toIsoDate(thisMon);
      endInput.value = thisThu;
      endPicker.value = toIsoDate(thisThu);
      updateScopeVisuals('this_week', true);
    });

    overlay.querySelector('#vac-preset-next')?.addEventListener('click', () => {
      startInput.value = nextMon;
      startPicker.value = toIsoDate(nextMon);
      endInput.value = nextThu;
      endPicker.value = toIsoDate(nextThu);
      updateScopeVisuals('future_week', true);
    });

    overlay.querySelector('#vac-preset-wk2')?.addEventListener('click', () => {
      startInput.value = wk2Mon;
      startPicker.value = toIsoDate(wk2Mon);
      endInput.value = wk2Thu;
      endPicker.value = toIsoDate(wk2Thu);
      updateScopeVisuals('future_week', true);
    });

    let onKey;
    const closeModal = () => {
      if (onKey) window.removeEventListener('keydown', onKey);
      overlay.remove();
    };

    overlay.querySelector('#btn-vac-close-x')?.addEventListener('click', closeModal);
    overlay.querySelector('#btn-vac-cancel')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    onKey = (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    window.addEventListener('keydown', onKey);

    overlay.querySelector('#btn-vac-confirm')?.addEventListener('click', () => {
      let sVal = (startInput?.value || '').trim() || thisMon;
      let eVal = (endInput?.value || '').trim() || sVal;

      if (sVal.includes('-')) {
        const p = sVal.split('-');
        if (p.length === 3) sVal = `${p[1]}/${p[2]}/${p[0]}`;
      }
      if (eVal.includes('-')) {
        const p = eVal.split('-');
        if (p.length === 3) eVal = `${p[1]}/${p[2]}/${p[0]}`;
      }

      const isFutureWeek = Boolean(radioFuture?.checked);
      const keepOnCrew = Boolean(keepOnCrewCb?.checked || isFutureWeek);
      const notesVal = (notesInput?.value || '').trim();
      const dateRange = (sVal === eVal || !eVal) ? sVal : `${sVal} - ${eVal}`;

      closeModal();
      this.finalizeMoveToVacation(dragData, {
        vacationStartDate: sVal,
        vacationEndDate: eVal,
        dateRange,
        isFutureVacation: isFutureWeek,
        keepOnCrew,
        notes: notesVal,
        targetCrewNumber,
        isCopy,
        existingItem
      });
    });

    setTimeout(() => {
      startInput?.focus();
      startInput?.select();
    }, 50);
  }

  /**
   * Applies the vacation dates and this-week vs. future-week scope to the current plan
   * (and stages into the target future planning week(s) if applicable).
   */
  finalizeMoveToVacation(dragData, opts = {}) {
    const empName = dragData.empName || dragData.name;
    const { fromBaseJob, fromSideType } = dragData;
    const {
      vacationStartDate = '',
      vacationEndDate = '',
      dateRange = '',
      isFutureVacation = false,
      keepOnCrew = false,
      notes = '',
      targetCrewNumber = '',
      isCopy = false,
      existingItem = null
    } = opts;

    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;
    if (!plan.sidePane) plan.sidePane = {};
    if (!plan.sidePane.vacation) plan.sidePane.vacation = [];
    if (!plan.confirmedPositions) plan.confirmedPositions = {};

    const normName = String(empName || '').trim().toLowerCase();
    const crewNum = (fromBaseJob || targetCrewNumber || '').replace(/\.\d+.*$/, '').trim();

    let srcCrew = null;
    let memberObj = null;

    if (crewNum) {
      srcCrew = plan.crews.find(c => c.jobNumber.toLowerCase() === crewNum.toLowerCase());
      if (srcCrew) {
        memberObj = srcCrew.members.find(m => m.name.trim().toLowerCase() === normName);
      }
    }
    if (!memberObj) {
      for (const c of plan.crews) {
        const found = c.members.find(m => m.name.trim().toLowerCase() === normName);
        if (found) {
          srcCrew = c;
          memberObj = found;
          break;
        }
      }
    }

    // Lookup employee profile info if needed when restoring to crew
    const empTable = this.db ? this.db.getTable('employees') : null;
    const liveRow = (empTable?.rows || []).find(r => String(r['Employee Name'] || r['Name'] || '').trim().toLowerCase() === normName);
    const resolvedClass = memberObj?.classification || existingItem?.classification || (liveRow ? String(liveRow['Job Classification'] || liveRow['Classification'] || 'Journeyman') : 'Journeyman');
    const resolvedRole = memberObj?.role || existingItem?.role || resolvedClass;

    if ((keepOnCrew || isFutureVacation) && srcCrew) {
      // Remove from non-vacation source side-pane bucket if moved from another staging list
      if (!isCopy && fromSideType && fromSideType !== 'vacation' && plan.sidePane[fromSideType]) {
        const sIdx = plan.sidePane[fromSideType].findIndex(m => m.name.trim().toLowerCase() === normName);
        if (sIdx !== -1) {
          const spliced = plan.sidePane[fromSideType].splice(sIdx, 1)[0];
          if (!memberObj && spliced) memberObj = spliced;
        }
      }

      // Ensure the employee is present on their active field crew for this planned week!
      let crewMember = srcCrew.members.find(m => m.name.trim().toLowerCase() === normName);
      if (!crewMember) {
        crewMember = {
          name: existingItem?.name || memberObj?.name || empName,
          classification: resolvedClass,
          role: resolvedRole,
          isConfirmed: false,
          slot: `${srcCrew.jobNumber}.${srcCrew.members.length + 1}`
        };
        srcCrew.members.push(crewMember);
      }
      crewMember.vacationStartDate = vacationStartDate;
      crewMember.vacationEndDate = vacationEndDate;
      crewMember.vacationDateRange = dateRange;
      crewMember.isFutureVacation = Boolean(isFutureVacation);
      crewMember.vacationNotes = notes;

      // Also update or add entry in plan.sidePane.vacation
      const vacIdx = plan.sidePane.vacation.findIndex(v => v.name.trim().toLowerCase() === normName);
      const vacItem = {
        name: crewMember.name,
        classification: resolvedClass,
        role: resolvedRole,
        currentJob: crewMember.slot || srcCrew.jobNumber,
        priorBaseJob: srcCrew.jobNumber,
        activeCrew: srcCrew.jobNumber,
        vacationStartDate,
        vacationEndDate,
        dateRange,
        isFutureVacation: Boolean(isFutureVacation),
        keepOnCrew: true,
        notes,
        note: `${isFutureVacation ? 'Future: ' : ''}${dateRange}${notes ? ' — ' + notes : ''}`,
        isConfirmed: true
      };

      if (vacIdx !== -1) {
        plan.sidePane.vacation[vacIdx] = vacItem;
      } else {
        plan.sidePane.vacation.push(vacItem);
      }
      plan.confirmedPositions[`${normName}::vacation`] = true;

      // If this is a Future Week vacation, stage it across all matching upcoming planning weeks
      if (isFutureVacation && vacationStartDate) {
        this.stageFutureVacationInTargetWeek(vacItem, vacationStartDate, vacationEndDate);
      }

      this.savePlan(plan);
      this.refreshView();

      if (typeof window.showToast === 'function') {
        const msg = isFutureVacation
          ? `🏖️ Scheduled Future Vacation (${dateRange}) for ${empName}. Kept active on Crew ${srcCrew.jobNumber} this week.`
          : `🏖️ Scheduled Vacation (${dateRange}) for ${empName} (active on Crew ${srcCrew.jobNumber}).`;
        window.showToast(msg, 'success');
      }
      return;
    }

    // Handle future vacation when employee is currently in Planning Pool (keep them in Planning Pool for THIS week)
    if (isFutureVacation && !srcCrew && fromSideType === 'planning') {
      const poolItem = (plan.sidePane.planning || []).find(m => m.name.trim().toLowerCase() === normName);
      if (poolItem) {
        poolItem.vacationStartDate = vacationStartDate;
        poolItem.vacationEndDate = vacationEndDate;
        poolItem.vacationDateRange = dateRange;
        poolItem.isFutureVacation = true;
        poolItem.vacationNotes = notes;
      }
      const vacIdx = plan.sidePane.vacation.findIndex(v => v.name.trim().toLowerCase() === normName);
      const vacItem = {
        name: existingItem?.name || poolItem?.name || empName,
        classification: resolvedClass,
        role: resolvedRole,
        currentJob: poolItem?.currentJob || existingItem?.currentJob || 'Planning Pool',
        priorBaseJob: 'planning',
        activeCrew: 'Planning Pool',
        vacationStartDate,
        vacationEndDate,
        dateRange,
        isFutureVacation: true,
        keepOnCrew: true,
        notes,
        note: `Future: ${dateRange}${notes ? ' — ' + notes : ''}`,
        isConfirmed: true
      };
      if (vacIdx !== -1) {
        plan.sidePane.vacation[vacIdx] = vacItem;
      } else {
        plan.sidePane.vacation.push(vacItem);
      }
      plan.confirmedPositions[`${normName}::vacation`] = true;

      if (vacationStartDate) {
        this.stageFutureVacationInTargetWeek(vacItem, vacationStartDate, vacationEndDate);
      }

      this.savePlan(plan);
      this.refreshView();
      if (typeof window.showToast === 'function') {
        window.showToast(`🏖️ Scheduled Future Vacation (${dateRange}) for ${empName}. Kept in Planning Pool this week.`, 'success');
      }
      return;
    }

    // Otherwise: Employee is OFF on vacation during this planned week (removed from field crew for this week)
    if (fromSideType && fromSideType !== 'vacation' && plan.sidePane[fromSideType]) {
      const idx = plan.sidePane[fromSideType].findIndex(m => m.name.trim().toLowerCase() === normName);
      if (idx !== -1) {
        if (isCopy || isFutureVacation) {
          memberObj = { ...plan.sidePane[fromSideType][idx], isConfirmed: true, isDuplicate: Boolean(isCopy) };
        } else {
          memberObj = plan.sidePane[fromSideType].splice(idx, 1)[0];
        }
      }
    }

    // Remove from any field crew in this week's plan (unless isCopy or future vacation)
    if (!isCopy && !isFutureVacation) {
      plan.crews.forEach(cr => {
        const idx = cr.members.findIndex(m => m.name.trim().toLowerCase() === normName);
        if (idx !== -1) {
          const spliced = cr.members.splice(idx, 1)[0];
          if (!memberObj) memberObj = spliced;
          cr.members.forEach((m, i) => {
            m.slot = `${cr.jobNumber}.${i + 1}`;
          });
          if (this.isCrewForeman(cr, spliced.name)) {
            cr.foreman = this.pickBestForeman(cr.members);
          }
        }
      });
    }

    const vacIdx = plan.sidePane.vacation.findIndex(v => v.name.trim().toLowerCase() === normName);
    const baseObj = (vacIdx !== -1 ? plan.sidePane.vacation[vacIdx] : null) || existingItem || memberObj || { name: empName };

    const updatedVacItem = {
      ...baseObj,
      name: baseObj.name || empName,
      classification: resolvedClass,
      role: resolvedRole,
      currentJob: crewNum || baseObj.currentJob || '',
      priorBaseJob: crewNum || baseObj.priorBaseJob || baseObj.currentJob || '',
      activeCrew: '',
      vacationStartDate,
      vacationEndDate,
      dateRange,
      isFutureVacation: Boolean(isFutureVacation),
      keepOnCrew: false,
      notes,
      note: `${isFutureVacation ? 'Future: ' : ''}${dateRange}${notes ? ' — ' + notes : ''}`,
      isConfirmed: true
    };

    if (vacIdx !== -1) {
      plan.sidePane.vacation[vacIdx] = updatedVacItem;
    } else {
      plan.sidePane.vacation.push(updatedVacItem);
    }
    this.clearMemberConfirmations(plan, empName, isCopy ? [] : [crewNum, fromSideType]);
    plan.confirmedPositions[`${normName}::vacation`] = true;

    if (isFutureVacation && vacationStartDate) {
      this.stageFutureVacationInTargetWeek(updatedVacItem, vacationStartDate, vacationEndDate);
    }

    this.savePlan(plan);
    this.refreshView();

    if (typeof window.showToast === 'function') {
      const msg = isFutureVacation
        ? `🏖️ Scheduled Future Vacation (${dateRange}) for ${empName}.`
        : `🏖️ Scheduled ${empName} for Vacation (${dateRange} — Off This Week).`;
      window.showToast(msg, 'success');
    }
  }

  /**
   * When an employee's vacation is marked as a Future Week, automatically stages them into
   * the corresponding future week plan(s) spanning startDateStr..endDateStr.
   */
  stageFutureVacationInTargetWeek(vacItem, startDateStr, endDateStr = '') {
    try {
      const startDt = this.parseFlexibleDate(startDateStr);
      if (!startDt) return;
      const parsedEnd = endDateStr ? this.parseFlexibleDate(endDateStr) : null;
      const endDt = (parsedEnd && parsedEnd.getTime() >= startDt.getTime()) ? parsedEnd : startDt;

      const startSun = this.getSundayOfDate(startDt);
      const endSun = this.getSundayOfDate(endDt);
      const currentSun = this.getSundayOfDate(new Date());
      const allPlans = this.getPlansMap();
      const norm = vacItem.name.trim().toLowerCase();

      let cursorSun = new Date(startSun);
      let weeksProcessed = 0;
      while (cursorSun.getTime() <= endSun.getTime() && weeksProcessed < 12) {
        const sunStr = this.formatDate(cursorSun);
        if (sunStr !== this.selectedWeek) {
          let futurePlan = allPlans[sunStr];
          const weeksAhead = Math.round((cursorSun.getTime() - currentSun.getTime()) / (7 * 86400000));
          if (!futurePlan && weeksAhead >= 1 && weeksAhead <= 8) {
            futurePlan = this.initializePlanFromCurrentRoster(sunStr);
            allPlans[sunStr] = futurePlan;
          }
          if (futurePlan && futurePlan.status !== 'published') {
            if (!futurePlan.sidePane) futurePlan.sidePane = {};
            if (!futurePlan.sidePane.vacation) futurePlan.sidePane.vacation = [];

            // Remove from field crew in that future week since they are on vacation that week
            (futurePlan.crews || []).forEach(cr => {
              const idx = (cr.members || []).findIndex(m => m.name.trim().toLowerCase() === norm);
              if (idx !== -1) {
                const spliced = cr.members.splice(idx, 1)[0];
                cr.members.forEach((m, i) => { m.slot = `${cr.jobNumber}.${i + 1}`; });
                if (this.isCrewForeman(cr, spliced.name)) {
                  cr.foreman = this.pickBestForeman(cr.members);
                }
              }
            });

            const fIdx = futurePlan.sidePane.vacation.findIndex(v => v.name.trim().toLowerCase() === norm);
            const fItem = {
              ...vacItem,
              isFutureVacation: false,
              keepOnCrew: false,
              activeCrew: '',
              note: `${vacItem.dateRange}${vacItem.notes ? ' — ' + vacItem.notes : ''}`,
              isConfirmed: true
            };
            if (fIdx !== -1) {
              futurePlan.sidePane.vacation[fIdx] = fItem;
            } else {
              futurePlan.sidePane.vacation.push(fItem);
            }
            if (!futurePlan.confirmedPositions) futurePlan.confirmedPositions = {};
            futurePlan.confirmedPositions[`${norm}::vacation`] = true;
            this.savePlan(futurePlan);
          }
        }
        cursorSun = new Date(cursorSun.getTime() + 7 * 86400000);
        weeksProcessed++;
      }
    } catch (err) {
      console.warn('[CrewPlanning] stageFutureVacationInTargetWeek warning:', err);
    }
  }

  editVacationSchedule(empName) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const norm = String(empName || '').trim().toLowerCase();
    let item = (plan.sidePane?.vacation || []).find(v => v.name.trim().toLowerCase() === norm);
    let crewMatch = null;
    let memberMatch = null;

    for (const c of (plan.crews || [])) {
      const m = (c.members || []).find(x => x.name.trim().toLowerCase() === norm);
      if (m) {
        crewMatch = c;
        memberMatch = m;
        break;
      }
    }

    if (!item && memberMatch) {
      item = {
        name: memberMatch.name,
        classification: memberMatch.classification,
        role: memberMatch.role,
        currentJob: memberMatch.slot || crewMatch.jobNumber,
        priorBaseJob: crewMatch.jobNumber,
        activeCrew: crewMatch.jobNumber,
        vacationStartDate: memberMatch.vacationStartDate || '',
        vacationEndDate: memberMatch.vacationEndDate || '',
        dateRange: memberMatch.vacationDateRange || '',
        isFutureVacation: Boolean(memberMatch.isFutureVacation),
        keepOnCrew: true,
        notes: memberMatch.vacationNotes || ''
      };
    }

    const dragData = {
      empName: item?.name || empName,
      fromBaseJob: crewMatch?.jobNumber || item?.priorBaseJob || item?.activeCrew || item?.currentJob || '',
      fromSideType: 'vacation'
    };
    this.promptVacationSchedule(dragData, false, item || null);
  }

  removeMemberFromSideCategory(name, sideType) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan || !plan.sidePane[sideType]) return;

    const norm = String(name || '').trim().toLowerCase();
    const removedItem = plan.sidePane[sideType].find(m => m.name.trim().toLowerCase() === norm);
    plan.sidePane[sideType] = plan.sidePane[sideType].filter(m => m.name.trim().toLowerCase() !== norm);

    // If it's a non-employee item, just remove it cleanly and stop
    if (this.isNonEmployeeName(name)) {
      this.savePlan(plan);
      this.refreshView();
      if (typeof window.showToast === 'function') {
        window.showToast(`Removed ${name}`, 'info');
      }
      return;
    }

    if (sideType === 'quit') {
      // Clear departure info from any crew member in the plan
      plan.crews.forEach(c => {
        c.members.forEach(m => {
          if (m.name.trim().toLowerCase() === norm) {
            delete m.departureDate;
            delete m.departureReason;
            delete m.departureNotes;
          }
        });
      });
    }

    if (sideType === 'vacation') {
      // Clear vacation info from any crew member in the plan
      plan.crews.forEach(c => {
        c.members.forEach(m => {
          if (m.name.trim().toLowerCase() === norm) {
            delete m.vacationStartDate;
            delete m.vacationEndDate;
            delete m.vacationDateRange;
            delete m.isFutureVacation;
            delete m.vacationNotes;
          }
        });
      });
    }

    // CHECK: Is the employee still present on any crew or in another staging bucket?
    const isPresentInCrews = plan.crews.some(c => c.members.some(m => m.name.trim().toLowerCase() === norm));
    const isPresentInOtherSide = Object.keys(plan.sidePane).some(k => k !== sideType && (plan.sidePane[k] || []).some(m => m.name.trim().toLowerCase() === norm));

    if (!isPresentInCrews && !isPresentInOtherSide) {
      // Employee was only in this staging bucket! Return them to their prior / original crew position!
      const baselineMap = this.getOriginalEmployeeLocations();
      const base = baselineMap.get(norm);

      const priorCrewJob = removedItem?.priorBaseJob ||
                           removedItem?.activeCrew ||
                           removedItem?.fromBaseJob ||
                           (removedItem?.currentJob ? String(removedItem.currentJob).replace(/\.\d+.*$/, '').trim() : null) ||
                           removedItem?.originalBaseJob ||
                           base?.originalBaseJob;

      let restored = false;
      if (priorCrewJob) {
        const targetCrew = plan.crews.find(c => c.jobNumber.toLowerCase() === priorCrewJob.toLowerCase());
        if (targetCrew) {
          const empTable = this.db ? this.db.getTable('employees') : null;
          const liveRow = (empTable?.rows || []).find(r => String(r['Employee Name'] || r['Name'] || '').trim().toLowerCase() === norm);

          const memberObj = {
            name: removedItem?.name || name,
            slot: `${targetCrew.jobNumber}.${targetCrew.members.length + 1}`,
            originalSlot: base?.originalSlot || targetCrew.jobNumber,
            originalBaseJob: targetCrew.jobNumber,
            classification: removedItem?.classification || liveRow?.['Job Classification'] || liveRow?.['Classification'] || 'Journeyman',
            role: removedItem?.role || liveRow?.['Role'] || liveRow?.['Job Classification'] || 'JL',
            location: targetCrew.location || 'Helena',
            secondaryJob: removedItem?.secondaryJob || String(liveRow?.['Secondary Job Number'] || liveRow?.['Secondary Job #'] || '').trim(),
            hireDate: removedItem?.hireDate || String(liveRow?.['Hire Date'] || liveRow?.['HireDate'] || '').trim(),
            notes: removedItem?.notes || String(liveRow?.['Notes'] || '').trim(),
            isConfirmed: false
          };
          targetCrew.members.push(memberObj);
          targetCrew.members.forEach((m, idx) => {
            m.slot = `${targetCrew.jobNumber}.${idx + 1}`;
          });
          if (!targetCrew.foreman) {
            targetCrew.foreman = this.pickBestForeman(targetCrew.members);
          }
          this.clearMemberConfirmations(plan, name, [sideType, targetCrew.jobNumber]);
          restored = true;

          if (typeof window.showToast === 'function') {
            window.showToast(`↩️ Restored ${name} back to Crew ${targetCrew.jobNumber}`, 'success');
          }
        }
      }

      if (!restored) {
        // Fallback: Return to Planning Pool so they are never lost
        if (!plan.sidePane.planning) plan.sidePane.planning = [];
        plan.sidePane.planning.push({
          name: removedItem?.name || name,
          classification: removedItem?.classification || '',
          role: removedItem?.role || '',
          currentJob: base?.originalSlot || '',
          isConfirmed: false
        });
        this.clearMemberConfirmations(plan, name, [sideType, 'planning']);
        if (typeof window.showToast === 'function') {
          window.showToast(`↩️ Moved ${name} to Planning Pool`, 'info');
        }
      }
    } else {
      this.clearMemberConfirmations(plan, name, [sideType]);
      if (typeof window.showToast === 'function') {
        window.showToast(`Removed ${name} from ${sideType === 'quit' ? 'Quit / Notice' : sideType}.`, 'info');
      }
    }

    this.savePlan(plan);
    this.refreshView();
  }

  // ==========================================================================
  // Duplication Modal & Execution (Employee in Multiple Locations)
  // ==========================================================================

  promptDuplicateMember(empName, fromBaseJob, fromSideType = '') {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const modalId = 'modal-crew-duplicate-member';
    let existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.75) !important; display: flex; align-items: center; justify-content: center; z-index: 15000 !important; pointer-events: auto !important; padding: 20px;';

    const empTable = this.db ? this.db.getTable('employees') : null;
    const normEmp = String(empName || '').trim().toLowerCase();
    const liveRow = (empTable?.rows || []).find(r => String(r['Employee Name'] || r['Name'] || '').trim().toLowerCase() === normEmp);
    const isForemanRole = this.isLeadClassification(liveRow?.['Job Classification'] || liveRow?.['Classification'] || liveRow?.['Role'] || '');

    const isFromLightDuty = fromSideType === 'lightDuty' || (plan.sidePane?.lightDuty || []).some(m => m.name.toLowerCase() === normEmp);

    let firstDifferentValue = '';
    const crewOptions = plan.crews.map(c => {
      const alreadyInCrew = (fromBaseJob && c.jobNumber.toLowerCase() === fromBaseJob.toLowerCase()) ||
        (c.members || []).some(m => String(m.name || '').trim().toLowerCase() === normEmp);
      const val = `crew::${c.jobNumber}`;
      if (!alreadyInCrew && !firstDifferentValue) firstDifferentValue = val;
      return `
        <option value="${val}" ${alreadyInCrew ? 'disabled style="color: #64748b;"' : ''}>
          🚜 Crew ${this.escapeHtml(c.jobNumber)} (${this.escapeHtml(c.location || 'Helena')}) — ${c.members.length} members ${alreadyInCrew ? '(Already Assigned)' : ''}
        </option>
      `;
    }).join('');

    const isInSide = (key) => fromSideType === key || (plan.sidePane?.[key] || []).some(m => String(m.name || '').trim().toLowerCase() === normEmp);
    const sideCats = [
      { key: 'planning', label: '📌 Planning Pool (Floaters)' },
      { key: 'vacation', label: '🏖️ Scheduled Vacation' },
      { key: 'weeds', label: '🌾 Weeds (Job-Attached)' },
      { key: 'lightDuty', label: '🩺 Light Duty / Medical' }
    ];
    const sideOptionsHtml = sideCats.map(cat => {
      const disabled = isInSide(cat.key);
      const val = `side::${cat.key}`;
      if (!disabled && !firstDifferentValue) firstDifferentValue = val;
      return `<option value="${val}" ${disabled ? 'disabled style="color: #64748b;"' : ''}>${cat.label}${disabled ? ' (Already Staged)' : ''}</option>`;
    }).join('');

    overlay.innerHTML = `
      <div class="modal-box" style="background: var(--bg-secondary, #1e293b); border: 1px solid rgba(168, 85, 247, 0.4); border-radius: 10px; max-width: 480px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.6); overflow: hidden; color: #fff; pointer-events: auto !important;">
        <div style="padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center;">
          <div style="font-size: 15px; font-weight: 800; color: #c084fc; display: flex; align-items: center; gap: 8px;">
            <span>👯</span> Duplicate Employee in Planner
          </div>
          <button id="btn-duplicate-close-x" style="background: transparent; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; padding: 4px 8px;">✕</button>
        </div>
        <div style="padding: 18px; font-size: 12.5px;">
          <p style="margin: 0 0 12px; color: #cbd5e1;">
            Duplicate <strong>${this.escapeHtml(empName)}</strong> into another crew or category so they can exist in multiple locations while planning.
          </p>
          ${isFromLightDuty ? `
            <div style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); border-radius: 6px; padding: 10px; margin-bottom: 14px; color: #6ee7b7; font-size: 11.5px; line-height: 1.4;">
              🩺 <strong>Light Duty Preservation:</strong> ${this.escapeHtml(empName)} will remain on Light Duty while also assigned as a working/foreman member on the destination crew.
            </div>
          ` : ''}
          <div style="background: rgba(147, 51, 234, 0.12); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 6px; padding: 10px; margin-bottom: 14px; color: #d8b4fe; font-size: 11.5px;">
            💡 <strong>Note:</strong> Duplicated employees will be highlighted in <strong>Purple</strong> across all locations until you confirm their assignment (turning them yellow).
          </div>
          <label style="display: block; font-weight: 700; margin-bottom: 6px; color: #94a3b8; font-size: 11.5px;">Select Destination Crew or Staging Category:</label>
          <select id="duplicate-dest-select" style="width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #3b82f6; border-radius: 6px; padding: 8px 10px; color: #fff; font-size: 12.5px; font-weight: 600; cursor: pointer;">
            <optgroup label="Planned Field Crews">
              ${crewOptions}
            </optgroup>
            <optgroup label="Staging Categories">
              ${sideOptionsHtml}
            </optgroup>
          </select>
          <div id="duplicate-as-foreman-wrap" style="margin-top: 12px; background: rgba(244, 114, 182, 0.12); border: 1px solid rgba(244, 114, 182, 0.35); border-radius: 6px; padding: 10px 12px;">
            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 12px; color: #fbcfe8;">
              <input type="checkbox" id="duplicate-as-foreman" ${isForemanRole ? 'checked' : ''} style="margin-top: 2px; cursor: pointer; accent-color: #ec4899; width: 16px; height: 16px;">
              <div>
                <div style="font-weight: 700; color: #f472b6;">👑 Designate as Crew Foreman on Destination Crew</div>
                <div style="font-size: 11px; color: #cbd5e1; margin-top: 2px;">
                  Places ${this.escapeHtml(empName)} at slot .1 and designates them as the crew lead.
                </div>
              </div>
            </label>
          </div>
        </div>
        <div style="padding: 12px 18px; border-top: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25); display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <button class="btn btn-secondary" id="btn-duplicate-cancel" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">Cancel</button>
          <button class="btn btn-primary" id="btn-duplicate-submit" style="background: linear-gradient(135deg, #a855f7 0%, #7e22ce 100%); border: none; font-size: 12px; font-weight: 700; padding: 6px 16px; cursor: pointer;">
            👯 Duplicate
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const select = overlay.querySelector('#duplicate-dest-select');
    const fmWrap = overlay.querySelector('#duplicate-as-foreman-wrap');
    if (select && firstDifferentValue) {
      select.value = firstDifferentValue;
    }

    const updateFmVisibility = () => {
      const isCrew = select && select.value.startsWith('crew::');
      if (fmWrap) fmWrap.style.display = isCrew ? 'block' : 'none';
    };
    select?.addEventListener('change', updateFmVisibility);
    updateFmVisibility();

    let onKey;
    const closeModal = () => {
      if (onKey) window.removeEventListener('keydown', onKey);
      overlay.remove();
    };

    overlay.querySelector('#btn-duplicate-close-x')?.addEventListener('click', closeModal);
    overlay.querySelector('#btn-duplicate-cancel')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    overlay.querySelector('#btn-duplicate-submit')?.addEventListener('click', () => {
      const destVal = select ? select.value : '';
      if (!destVal) {
        alert('Please select a destination crew or category.');
        return;
      }
      const asForeman = overlay.querySelector('#duplicate-as-foreman')?.checked ?? false;
      this.executeDuplicateMember(empName, fromBaseJob, destVal, fromSideType, asForeman);
      closeModal();
    });

    onKey = (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    overlay._onKey = onKey;
    window.addEventListener('keydown', onKey);
  }

  executeDuplicateMember(empName, fromBaseJob, destValue, fromSideType = '', asForeman = false) {
    const modalId = 'modal-crew-duplicate-member';
    const m = document.getElementById(modalId);
    if (m) {
      if (m._onKey) window.removeEventListener('keydown', m._onKey);
      m.remove();
    }

    if (!destValue) return;
    const [destType, destTarget] = destValue.split('::');

    const effectiveFromSide = fromSideType || (fromBaseJob ? '' : 'planning');
    const dragData = {
      empName,
      fromBaseJob: fromBaseJob || '',
      fromSideType: effectiveFromSide,
      isCopy: true
    };

    if (destType === 'crew') {
      const insertPos = asForeman ? 'start' : 'end';
      this.handleReorderOrMoveMember(dragData, destTarget, null, insertPos, true);
      if (asForeman) {
        const plan = this.getPlanForWeek(this.selectedWeek);
        const destCrew = plan?.crews?.find(c => c.jobNumber.toLowerCase() === destTarget.toLowerCase());
        if (destCrew) {
          destCrew.foreman = empName;
          this.savePlan(plan);
          this.refreshView();
        }
      }
    } else if (destType === 'side') {
      this.handleMoveToSideCategory(dragData, destTarget, true);
    }

    if (typeof window.showToast === 'function') {
      window.showToast(`👯 Duplicated ${empName} to ${destTarget}${asForeman ? ' as Foreman' : ''}. Highlighted in purple.`, 'info');
    }
  }

  /**
   * Dialog for viewing, editing slot, swapping, or removing a duplicated employee in the planner
   */
  promptEditPlannedSecondJob(empName, currentBaseJob) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const modalId = 'modal-planned-edit-second-job';
    let existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const norm = String(empName || '').toLowerCase().trim();
    const occMap = this.getEmployeeOccurrencesMap(plan);
    const occurrences = occMap.get(norm) || [];

    const currentCrew = plan.crews.find(c => c.jobNumber.toLowerCase() === currentBaseJob.toLowerCase());
    const currentMember = currentCrew?.members.find(m => m.name.toLowerCase() === norm);

    const otherOcc = occurrences.find(o => o.baseJob && o.baseJob.toLowerCase() !== currentBaseJob.toLowerCase());
    const otherCrew = otherOcc ? plan.crews.find(c => c.jobNumber.toLowerCase() === otherOcc.baseJob.toLowerCase()) : null;
    const otherMember = otherCrew?.members.find(m => m.name.toLowerCase() === norm);

    const jtTable = this.db ? this.db.getTable('job_tracking') : null;
    const getCrewInfo = (bj) => {
      if (!bj || !jtTable) return { status: 'Active', loc: 'Helena' };
      const jRow = (jtTable.rows || []).find(j => {
        const jn = String(j['Job Number'] || j['Job #'] || '').trim().replace(/\.\d+.*$/, '');
        return jn.toLowerCase() === String(bj).trim().toLowerCase();
      });
      return {
        status: String(jRow?.['Status'] || 'Active').trim(),
        loc: String(jRow?.['Location'] || 'Helena').trim()
      };
    };

    const currentInfo = getCrewInfo(currentBaseJob);
    const otherInfo = otherCrew ? getCrewInfo(otherCrew.jobNumber) : { status: '', loc: '' };

    const isPendingOrHold = (st) => /pending|hold/i.test(st);
    let currentIsPrimary = true;
    if (isPendingOrHold(currentInfo.status) && !isPendingOrHold(otherInfo.status)) {
      currentIsPrimary = false;
    }

    const currentSlot = currentMember?.slot || currentBaseJob;
    const otherSlot = otherMember?.slot || otherCrew?.jobNumber || '(None)';

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.78) !important; display: flex; align-items: center; justify-content: center; z-index: 15000 !important; pointer-events: auto !important; padding: 20px;';

    overlay.innerHTML = `
      <div class="modal-box" style="background: var(--bg-secondary, #1e293b); border: 1px solid rgba(245, 158, 11, 0.45); border-radius: 10px; max-width: 520px; width: 100%; box-shadow: 0 16px 40px rgba(0,0,0,0.7); overflow: hidden; color: #fff; pointer-events: auto !important;">
        <div style="padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.25);">
          <div style="font-size: 15px; font-weight: 800; color: #fbbf24; display: flex; align-items: center; gap: 8px;">
            <span>⚡</span> Planned 1st &amp; 2nd Job Assignment for ${this.escapeHtml(empName)}
          </div>
          <button id="btn-edit-plan-sec-close" style="background: transparent; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; padding: 4px 8px;">✕</button>
        </div>

        <div style="padding: 20px; font-size: 12.5px; display: flex; flex-direction: column; gap: 14px;">
          <!-- Dual Job Overview Cards -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <!-- Current Crew Card -->
            <div style="background: ${currentIsPrimary ? 'rgba(59, 130, 246, 0.1)' : 'rgba(245, 158, 11, 0.1)'}; border: 1px solid ${currentIsPrimary ? 'rgba(59, 130, 246, 0.35)' : 'rgba(245, 158, 11, 0.35)'}; border-radius: 8px; padding: 12px;">
              <div style="font-size: 11px; font-weight: 800; color: ${currentIsPrimary ? '#93c5fd' : '#fde047'}; text-transform: uppercase; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                <span>${currentIsPrimary ? '⭐ 1st Job (Active)' : '⚡ 2nd Job (Pending)'}</span>
                <span class="badge" style="background: rgba(255,255,255,0.1); color: inherit; font-size: 9.5px; padding: 1px 5px;">${this.escapeHtml(currentInfo.status)}</span>
              </div>
              <div style="font-family: monospace; font-size: 15px; font-weight: 800; color: #fff; margin-bottom: 2px;">
                ${this.escapeHtml(currentSlot)}
              </div>
              <div style="font-size: 11px; color: var(--text-muted);">
                Crew ${this.escapeHtml(currentBaseJob)} • ${this.escapeHtml(currentInfo.loc)}
              </div>
            </div>

            <!-- Other Crew Card -->
            <div style="background: ${!currentIsPrimary ? 'rgba(59, 130, 246, 0.1)' : 'rgba(245, 158, 11, 0.1)'}; border: 1px solid ${!currentIsPrimary ? 'rgba(59, 130, 246, 0.35)' : 'rgba(245, 158, 11, 0.35)'}; border-radius: 8px; padding: 12px;">
              <div style="font-size: 11px; font-weight: 800; color: ${!currentIsPrimary ? '#93c5fd' : '#fde047'}; text-transform: uppercase; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                <span>${!currentIsPrimary ? '⭐ 1st Job (Active)' : '⚡ 2nd Job (Pending)'}</span>
                <span class="badge" style="background: rgba(255,255,255,0.1); color: inherit; font-size: 9.5px; padding: 1px 5px;">${this.escapeHtml(otherInfo.status || 'Active')}</span>
              </div>
              <div style="font-family: monospace; font-size: 15px; font-weight: 800; color: #fff; margin-bottom: 2px;">
                ${this.escapeHtml(otherSlot)}
              </div>
              <div style="font-size: 11px; color: var(--text-muted);">
                ${otherCrew ? `Crew ${this.escapeHtml(otherCrew.jobNumber)} • ${this.escapeHtml(otherInfo.loc)}` : '(No other crew)'}
              </div>
            </div>
          </div>

          <!-- Edit Slot Input for Current Crew -->
          <div>
            <label style="display: block; font-weight: 700; margin-bottom: 6px; color: #cbd5e1; font-size: 11.5px;">
              Edit Slot on Crew ${this.escapeHtml(currentBaseJob)}:
            </label>
            <input type="text" id="edit-planned-slot-input" value="${this.escapeHtml(currentSlot)}" style="width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: #fff; font-family: monospace; font-size: 13px; font-weight: 700;">
          </div>
        </div>

        <div style="padding: 12px 20px; border-top: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25); display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <button class="btn btn-secondary" id="btn-remove-planned-second" style="color: #ef4444; border-color: rgba(239, 68, 68, 0.4); font-size: 11.5px; padding: 6px 12px; cursor: pointer;">
            🗑️ Remove from Crew ${this.escapeHtml(currentBaseJob)}
          </button>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary" id="btn-edit-plan-sec-cancel" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">Cancel</button>
            <button class="btn btn-primary" id="btn-edit-plan-sec-save" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); border: none; font-size: 12px; font-weight: 700; padding: 6px 16px; cursor: pointer;">
              Save Slot
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    const closeModal = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    window.addEventListener('keydown', onKey);
    overlay.querySelector('#btn-edit-plan-sec-close')?.addEventListener('click', closeModal);
    overlay.querySelector('#btn-edit-plan-sec-cancel')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

    // Save slot
    overlay.querySelector('#btn-edit-plan-sec-save')?.addEventListener('click', () => {
      const newSlot = overlay.querySelector('#edit-planned-slot-input')?.value.trim();
      if (newSlot && currentMember) {
        currentMember.slot = newSlot;
        this.savePlan(plan);
        this.refreshView();
        if (typeof window.showToast === 'function') {
          window.showToast(`Updated ${empName} slot to ${newSlot} on Crew ${currentBaseJob}.`, 'success');
        }
      }
      closeModal();
    });

    // Remove from current crew
    overlay.querySelector('#btn-remove-planned-second')?.addEventListener('click', () => {
      if (!confirm(`Remove ${empName} from Crew ${currentBaseJob}?`)) return;
      if (currentCrew) {
        currentCrew.members = currentCrew.members.filter(m => m.name.toLowerCase() !== norm);
        currentCrew.members.forEach((m, idx) => {
          m.slot = `${currentCrew.jobNumber}.${idx + 1}`;
        });
        if (this.isCrewForeman(currentCrew, empName)) {
          currentCrew.foreman = this.pickBestForeman(currentCrew.members);
        }
        if (plan.confirmedPositions) {
          delete plan.confirmedPositions[`${norm}::${String(currentBaseJob).toLowerCase()}`];
        }
        // Clean up secondaryJob reference on remaining occurrence if only 1 occurrence remains
        const remainingOccs = (plan.crews || []).flatMap(c => (c.members || []).filter(m => m.name && m.name.toLowerCase() === norm));
        if (remainingOccs.length === 1) {
          remainingOccs[0].secondaryJob = '';
          delete remainingOccs[0].isSecondaryMember;
          delete remainingOccs[0].primaryJobNumber;
        }
        const isStillInCrews = (plan.crews || []).some(c => (c.members || []).some(m => m.name && m.name.toLowerCase() === norm));
        const sp = plan.sidePane || {};
        const isStillInSide = Object.keys(sp).some(k => (sp[k] || []).some(m => m.name && m.name.toLowerCase() === norm));
        if (!isStillInCrews && !isStillInSide) {
          if (!plan.sidePane) plan.sidePane = {};
          if (!plan.sidePane.planning) plan.sidePane.planning = [];
          plan.sidePane.planning.push({
            name: empName,
            slot: '',
            currentJob: `${currentBaseJob} (Unassigned)`,
            isConfirmed: false
          });
        }
        this.savePlan(plan);
        this.refreshView();
        if (typeof window.showToast === 'function') {
          window.showToast(`Removed ${empName} from Crew ${currentBaseJob}.`, 'info');
        }
      }
      closeModal();
    });
  }

  // ==========================================================================
  // Confirmation System (Purple -> Yellow)
  // ==========================================================================

  /**
   * Toggles confirmation state for an employee in a crew or side category.
   */
  toggleConfirmMemberPosition(empName, baseJobOrSideType) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const norm = String(empName || '').toLowerCase().trim();
    if (!plan.confirmedPositions) plan.confirmedPositions = {};

    let targetMember = null;
    let matchedCrewJob = null;
    let matchedSideType = null;
    let confirmKey = '';

    const rawLoc = String(baseJobOrSideType || '').trim();
    const locLower = rawLoc.toLowerCase();

    if (rawLoc) {
      const crew = plan.crews.find(c => String(c.jobNumber || '').trim().toLowerCase() === locLower);
      if (crew) {
        targetMember = crew.members.find(m => String(m.name || '').trim().toLowerCase() === norm);
        matchedCrewJob = String(crew.jobNumber || '').trim();
        confirmKey = `${norm}::${matchedCrewJob.toLowerCase()}`;
      } else if (plan.sidePane && plan.sidePane[rawLoc]) {
        targetMember = plan.sidePane[rawLoc].find(m => String(m.name || '').trim().toLowerCase() === norm);
        matchedSideType = rawLoc;
        confirmKey = `${norm}::${locLower}`;
      }
    }

    if (!targetMember) {
      // Find first matching occurrence in plan crews
      for (const crew of plan.crews) {
        const found = crew.members.find(m => String(m.name || '').trim().toLowerCase() === norm);
        if (found) {
          targetMember = found;
          matchedCrewJob = String(crew.jobNumber || '').trim();
          confirmKey = `${norm}::${matchedCrewJob.toLowerCase()}`;
          break;
        }
      }
      // Or in sidePane categories
      if (!targetMember && plan.sidePane) {
        for (const cat of Object.keys(plan.sidePane)) {
          const found = (plan.sidePane[cat] || []).find(m => String(m.name || '').trim().toLowerCase() === norm);
          if (found) {
            targetMember = found;
            matchedSideType = cat;
            confirmKey = `${norm}::${cat.toLowerCase()}`;
            break;
          }
        }
      }
    }

    if (targetMember) {
      const currentSt = this.getEmployeePlanningStatus(empName, matchedCrewJob, matchedSideType, plan);
      if (currentSt.badgeText === '2nd Job') {
        return;
      }
      if (!currentSt.isMoved && !currentSt.isMultiLocation) {
        targetMember.isConfirmed = false;
        this.clearMemberConfirmations(plan, empName, [matchedCrewJob || matchedSideType]);
        this.savePlan(plan);
        this.refreshView();
        return;
      }
      const newState = !currentSt.isConfirmed;
      targetMember.isConfirmed = newState;
      delete plan.confirmedPositions[norm];
      if (matchedSideType) {
        delete plan.confirmedPositions[`${norm}::side:${matchedSideType.toLowerCase()}`];
      }
      if (confirmKey) {
        plan.confirmedPositions[confirmKey] = newState;
      }
      this.savePlan(plan);
      if (typeof window.showToast === 'function') {
        const confirmIcon = (currentSt.isMultiLocation && matchedCrewJob) ? '💠' : '🟡';
        window.showToast(
          newState ? `${confirmIcon} Confirmed ${empName}'s position.` : `🟣 Set ${empName} back to unconfirmed.`,
          newState ? 'success' : 'info'
        );
      }
      this.refreshView();
    }
  }

  confirmAllPurpleMembers() {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const purpleList = this.getPurpleMembers(plan);
    if (purpleList.length === 0) return;

    if (!plan.confirmedPositions) plan.confirmedPositions = {};

    purpleList.forEach(p => {
      if (p.memberObj) p.memberObj.isConfirmed = true;
      const norm = p.name.toLowerCase().trim();
      const locKey = p.baseJob ? p.baseJob.toLowerCase() : (p.sideType ? p.sideType.toLowerCase() : '');
      delete plan.confirmedPositions[norm];
      if (locKey) plan.confirmedPositions[`${norm}::${locKey}`] = true;
    });

    this.savePlan(plan);
    if (typeof window.showToast === 'function') {
      window.showToast(`🟡 Confirmed all ${purpleList.length} employee position(s)! Now ready to publish.`, 'success');
    }
    this.refreshView();
  }

  // ==========================================================================
  // Publish Gating & Purple Unconfirmed Popup Blocker
  // ==========================================================================

  getPurpleMembers(plan) {
    if (!plan) return [];
    const baselineMap = this.getOriginalEmployeeLocations();
    const occMap = this.getEmployeeOccurrencesMap(plan);
    const purpleList = [];

    (plan.crews || []).forEach(crew => {
      (crew.members || []).forEach(m => {
        if (!m.name || this.isNonEmployeeName(m.name)) return;
        const st = this.getEmployeePlanningStatus(m.name, crew.jobNumber, null, plan, baselineMap, occMap);
        if (st.statusColor === 'purple') {
          purpleList.push({
            name: m.name,
            currentLocation: `🚜 Crew ${crew.jobNumber} (${m.slot || crew.jobNumber})`,
            baseJob: crew.jobNumber,
            sideType: null,
            status: st,
            memberObj: m
          });
        }
      });
    });

    const sp = plan.sidePane || {};
    for (const cat of ['planning', 'vacation', 'weeds', 'lightDuty', 'quit', 'pendingHires']) {
      (sp[cat] || []).forEach(item => {
        if (!item.name || this.isNonEmployeeName(item.name)) return;
        const st = this.getEmployeePlanningStatus(item.name, null, cat, plan, baselineMap, occMap);
        if (st.statusColor === 'purple') {
          purpleList.push({
            name: item.name,
            currentLocation: `📋 Staging: ${cat}`,
            baseJob: null,
            sideType: cat,
            status: st,
            memberObj: item
          });
        }
      });
    }

    return purpleList;
  }

  showUnconfirmedPurpleModal(purpleMembers) {
    const modalId = 'modal-crew-unconfirmed-purple';
    let existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.8) !important; display: flex; align-items: center; justify-content: center; z-index: 15000 !important; pointer-events: auto !important; padding: 20px;';

    overlay.innerHTML = `
      <div class="modal-box" style="background: var(--bg-secondary, #1e293b); border: 1px solid rgba(168, 85, 247, 0.5); border-radius: 10px; max-width: 660px; width: 100%; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,0.6); overflow: hidden; color: #fff; pointer-events: auto !important;">
        
        <!-- Modal Header -->
        <div style="padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); background: rgba(147, 51, 234, 0.15); display: flex; justify-content: space-between; align-items: center;">
          <div style="font-size: 16px; font-weight: 800; color: #d8b4fe; display: flex; align-items: center; gap: 8px;">
            <span>⚠️</span> Cannot Publish: Unconfirmed Employee Changes (${purpleMembers.length})
          </div>
          <button id="btn-purple-close-x" style="background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 4px 8px;">✕</button>
        </div>

        <!-- Modal Body -->
        <div style="padding: 20px; overflow-y: auto; flex: 1; font-size: 13px;">
          
          <div style="background: rgba(147, 51, 234, 0.12); border: 1px solid rgba(168, 85, 247, 0.35); border-radius: 6px; padding: 12px; margin-bottom: 16px; color: #cbd5e1; font-size: 12.5px; line-height: 1.5;">
            <strong style="color: #fde047;">Publish is locked until all purple employees are confirmed.</strong><br>
            The employees below were moved between crews or newly assigned to multiple locations. Review each position and click <strong>Confirm Position</strong> to turn them yellow (moved) or cyan (2nd job), or click <strong>Confirm All Remaining</strong> to approve all planned positions at once.
          </div>

          <div style="font-weight: 700; margin-bottom: 10px; color: #93c5fd; font-size: 12.5px;">
            Unconfirmed Employees Requiring Verification:
          </div>

          <div id="unconfirmed-purple-list-container" style="display: flex; flex-direction: column; gap: 8px;">
            ${purpleMembers.map((p, idx) => `
              <div id="purple-item-row-${idx}" style="display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.25); border: 1px solid rgba(168, 85, 247, 0.3); border-left: 4px solid #c084fc; border-radius: 6px; padding: 8px 12px; gap: 10px;">
                <div style="flex: 1; min-width: 0;">
                  <div style="font-weight: 700; font-size: 13px; color: #f8fafc; display: flex; align-items: center; gap: 6px;">
                    <span>🟣</span>
                    <span>${this.escapeHtml(p.name)}</span>
                    ${p.status.isMultiLocation ? `<span class="badge" style="background: rgba(147, 51, 234, 0.3); color: #d8b4fe; font-size: 9.5px; padding: 1px 5px; border-radius: 3px;">In Multiple Locations (${p.status.occurrencesCount})</span>` : ''}
                  </div>
                  <div style="font-size: 11.5px; color: #94a3b8; margin-top: 2px;">
                    <span>Original: <strong style="color: #cbd5e1;">${this.escapeHtml(p.status.originalLabel || 'Unassigned')}</strong></span> →
                    <span>Planned: <strong style="color: #60a5fa;">${this.escapeHtml(p.currentLocation)}</strong></span>
                  </div>
                </div>
                <button class="btn btn-xs"
                        id="btn-confirm-purple-${idx}"
                        onclick="window.crewPlanningEngine.confirmSinglePurpleFromModal('${this.escapeJs(p.name)}', '${this.escapeJs(p.baseJob || '')}', '${this.escapeJs(p.sideType || '')}', ${idx})"
                        style="background: rgba(234, 179, 8, 0.2); color: #fde047; border: 1px solid #eab308; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 4px; cursor: pointer; white-space: nowrap;">
                  ✅ Confirm Position
                </button>
              </div>
            `).join('')}
          </div>

        </div>

        <!-- Modal Footer -->
        <div style="padding: 14px 20px; border-top: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25); display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
          <button class="btn btn-secondary" id="btn-purple-cancel" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">
            ✕ Close & Review Planner
          </button>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-primary" id="btn-purple-confirm-all" style="background: linear-gradient(135deg, #a855f7 0%, #7e22ce 100%); border: none; font-size: 12px; font-weight: 700; padding: 6px 14px; cursor: pointer;">
              ✅ Confirm All (${purpleMembers.length}) & Proceed
            </button>
          </div>
        </div>

      </div>
    `;

    document.body.appendChild(overlay);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    overlay._onKey = onKey;
    const closeModal = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    window.addEventListener('keydown', onKey);

    overlay.querySelector('#btn-purple-close-x')?.addEventListener('click', closeModal);
    overlay.querySelector('#btn-purple-cancel')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    overlay.querySelector('#btn-purple-confirm-all')?.addEventListener('click', () => {
      closeModal();
      this.confirmAllPurpleMembers();
      this.openPublishModal();
    });
  }

  confirmSinglePurpleFromModal(empName, baseJob, sideType, idx) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    this.toggleConfirmMemberPosition(empName, baseJob || sideType);

    const btn = document.getElementById(`btn-confirm-purple-${idx}`);
    if (btn) {
      btn.innerText = '🟡 Confirmed';
      btn.style.background = 'rgba(234, 179, 8, 0.4)';
      btn.style.borderColor = '#fde047';
      btn.disabled = true;
    }

    // Check if any purple remaining
    const remaining = this.getPurpleMembers(plan);
    if (remaining.length === 0) {
      const modal = document.getElementById('modal-crew-unconfirmed-purple');
      if (modal) {
        if (modal._onKey) window.removeEventListener('keydown', modal._onKey);
        modal.remove();
      }
      this.openPublishModal();
    }
  }

  confirmAllPurpleAndProceed() {
    const modal = document.getElementById('modal-crew-unconfirmed-purple');
    if (modal) {
      if (modal._onKey) window.removeEventListener('keydown', modal._onKey);
      modal.remove();
    }

    this.confirmAllPurpleMembers();
    this.openPublishModal();
  }

  // ==========================================================================
  // Pre-flight Delta Validator & One-Click Publish Engine
  // ==========================================================================

  computePublishDeltas(plan) {
    const empTable = this.db ? this.db.getTable('employees') : null;
    const jtTable = this.db ? this.db.getTable('job_tracking') : null;
    const liveEmps = (empTable && empTable.rows) || [];
    const liveJt = (jtTable && jtTable.rows) || [];
    const baselineMap = this.getOriginalEmployeeLocations();
    const liveNotesMap = this.buildLiveEmployeeNotesMap();

    const transfers = [];
    const unassignments = [];
    const vacations = [];
    const quits = [];
    const weeds = [];
    const foremenChanges = [];
    const scheduleChanges = [];
    const crewMetadataChanges = [];
    const employeeNoteChanges = [];
    const newHires = [];
    const departedOnLive = [];

    const normBool = (val) => val === true || String(val || '').toLowerCase() === 'true';

    // Compare planned members and crew metadata
    plan.crews.forEach(crew => {
      // Check foreman change
      const liveJtCrew = liveJt.find(j => {
        const jn = String(j['Job Number'] || j['Job #'] || '').trim();
        return jn === crew.jobNumber || jn.replace(/\.\d+.*$/, '').trim() === crew.jobNumber;
      });
      const currentForeman = liveJtCrew ? String(liveJtCrew['Foreman'] || '').trim() : '';
      const plannedForeman = String(crew.foreman || '').trim();
      const isSameForeman = plannedForeman.toLowerCase() === currentForeman.toLowerCase() ||
        (plannedForeman && currentForeman && this.isCrewForeman({ foreman: plannedForeman }, currentForeman));
      if (!isSameForeman) {
        foremenChanges.push({
          jobNumber: crew.jobNumber,
          oldForeman: currentForeman || 'None',
          newForeman: plannedForeman || 'None'
        });
      }

      // Check schedule, working days & crew metadata changes
      if (liveJtCrew) {
        const liveSched = String(liveJtCrew['Work Schedule'] || liveJtCrew['Schedule'] || 'Mon-Thu (4 10s)').trim();
        const liveSkipMon = normBool(liveJtCrew['Skip Mon']);
        const liveSkipTue = normBool(liveJtCrew['Skip Tue']);
        const liveSkipWed = normBool(liveJtCrew['Skip Wed']);
        const liveSkipThu = normBool(liveJtCrew['Skip Thu']);
        const liveSkipFri = normBool(liveJtCrew['Skip Fri']);
        const liveSkipSat = normBool(liveJtCrew['Skip Sat']);
        const liveSkipSun = normBool(liveJtCrew['Skip Sun']);

        const crewSkips = this.getCrewSkipDays(crew);
        const schedChanged = Boolean(crew.schedule && crew.schedule !== liveSched);
        const daysChanged = (
          Boolean(crewSkips.isSkipMon) !== liveSkipMon ||
          Boolean(crewSkips.isSkipTue) !== liveSkipTue ||
          Boolean(crewSkips.isSkipWed) !== liveSkipWed ||
          Boolean(crewSkips.isSkipThu) !== liveSkipThu ||
          Boolean(crewSkips.isSkipFri) !== liveSkipFri ||
          Boolean(crewSkips.isSkipSat) !== liveSkipSat ||
          Boolean(crewSkips.isSkipSun) !== liveSkipSun
        );

        if (schedChanged || daysChanged) {
          scheduleChanges.push({
            jobNumber: crew.jobNumber,
            oldSchedule: liveSched,
            newSchedule: crew.schedule || liveSched,
            daysChanged
          });
        }

        const metaDiffs = [];
        const liveJobName = String(liveJtCrew['Job Name'] || '').trim();
        const plannedJobName = String(crew.jobName || '').trim();
        if ((crew._clearedJobName && liveJobName) || (plannedJobName && plannedJobName !== liveJobName)) {
          metaDiffs.push(`Job Name: ${liveJobName || 'None'} -> ${plannedJobName || 'None'}`);
        }
        const liveLoc = String(liveJtCrew['Location'] || '').trim();
        const plannedLoc = String(crew.location || '').trim();
        if (plannedLoc && plannedLoc !== liveLoc) {
          metaDiffs.push(`Location: ${liveLoc || 'None'} -> ${plannedLoc}`);
        }
        const liveType = String(liveJtCrew['Crew Type'] || '').trim();
        const plannedType = this.detectCrewType(crew.jobNumber, crew.jobName, crew.location, crew.crewType);
        if (plannedType && plannedType !== liveType) {
          metaDiffs.push(`Type: ${liveType || 'None'} -> ${plannedType}`);
        }
        const liveStat = String(liveJtCrew['Status'] || '').trim();
        const plannedStat = String(crew.status || '').trim();
        if (plannedStat && plannedStat !== liveStat) {
          metaDiffs.push(`Status: ${liveStat || 'None'} -> ${plannedStat}`);
        }
        if (crew.notes !== undefined) {
          const liveNotes = String(liveJtCrew['Notes'] || '').trim();
          const plannedNotes = String(crew.notes || '').trim();
          if (plannedNotes !== liveNotes) {
            metaDiffs.push('Notes updated');
          }
        }
        if (crew.skipMtg !== undefined && normBool(liveJtCrew['Skip Weekly Meeting']) !== Boolean(crew.skipMtg)) {
          metaDiffs.push(`Skip Mtg: ${Boolean(crew.skipMtg)}`);
        }
        if (crew.skipChk !== undefined && normBool(liveJtCrew['Skip Monthly Checklist']) !== Boolean(crew.skipChk)) {
          metaDiffs.push(`Skip Chk: ${Boolean(crew.skipChk)}`);
        }
        if (metaDiffs.length > 0) {
          crewMetadataChanges.push({
            jobNumber: crew.jobNumber,
            isNewCrew: false,
            changes: metaDiffs
          });
        }
      } else {
        crewMetadataChanges.push({
          jobNumber: crew.jobNumber,
          isNewCrew: true,
          changes: [`New crew added to Job Tracking (${crew.location || 'Helena'}, ${crew.status || 'Active'})`]
        });
      }

      crew.members.forEach(m => {
        const live = liveEmps.find(e => String(e['Employee Name'] || e['Name'] || '').trim().toLowerCase() === m.name.toLowerCase());
        if (live) {
          const liveLoc = String(live['Location'] || '').trim().toLowerCase();
          const liveStat = String(live['Status'] || '').trim().toLowerCase();

          // 1. RECOGNITION RULE: If employee was already moved to Previous Employee on live, DO NOT resurrect them!
          if (liveLoc === 'previous employee' || liveLoc.includes('previous') || liveStat === 'previous employee') {
            departedOnLive.push({
              name: m.name,
              plannedCrew: crew.jobNumber,
              liveStatus: 'Previous Employee'
            });
            return;
          }

          const liveJob = String(live['Job Number'] || '').trim();
          const base = baselineMap.get(m.name.toLowerCase());
          const originalJob = base ? (base.originalSlot || base.originalBaseJob) : null;
          // Check if the employee was manually modified on the live sheet mid-week after the plan was drafted
          const wasLiveChanged = Boolean(originalJob && liveJob && originalJob.toLowerCase() !== liveJob.toLowerCase());

          const occMap = this.getEmployeeOccurrencesMap(plan);
          const occurrences = occMap.get(m.name.toLowerCase()) || [];
          const isMulti = occurrences.length > 1;
          const inLightDuty = (plan.sidePane?.lightDuty || []).some(ld => ld.name.toLowerCase() === m.name.toLowerCase());
          const curSecondary = String(live['Secondary Job Number'] || live['Secondary Job #'] || '').trim();
          const liveBaseJob = liveJob.replace(/\.\d+.*$/, '').trim().toLowerCase();
          const origBaseJob = String(base?.originalBaseJob || originalJob || '').replace(/\.\d+.*$/, '').trim().toLowerCase();
          const curCrewBase = String(crew.jobNumber || '').replace(/\.\d+.*$/, '').trim().toLowerCase();

          // Determine if this specific crew occurrence is a Secondary assignment vs Primary assignment
          let isSecondaryOccurrence = false;
          if (inLightDuty) {
            if (curCrewBase.startsWith('005-')) {
              isSecondaryOccurrence = false;
            } else if (isMulti) {
              const non005Occs = occurrences.filter(o => !String(o.baseJob || '').toLowerCase().startsWith('005-'));
              if (non005Occs.length > 1) {
                isSecondaryOccurrence = m.isSecondaryMember === true || String(non005Occs[0]?.baseJob || '').toLowerCase() !== curCrewBase;
              } else {
                isSecondaryOccurrence = true;
              }
            } else {
              isSecondaryOccurrence = true;
            }
          } else if (isMulti) {
            const otherOccs = occurrences.filter(o => String(o.baseJob || '').trim().toLowerCase() !== curCrewBase);
            const curSecBase = curSecondary.replace(/\.\d+.*$/, '').trim().toLowerCase();
            const isWeekendSched = /fri|sat|weekend/i.test(String(crew.schedule || ''));
            const isPendingStatus = /pending|hold/i.test(String(crew.status || ''));

            if (m.isSecondaryMember === true) {
              isSecondaryOccurrence = true;
            } else if (m.primaryJobNumber && String(m.primaryJobNumber).replace(/\.\d+.*$/, '').trim().toLowerCase() !== curCrewBase) {
              isSecondaryOccurrence = true;
            } else if (curSecBase && curSecBase === curCrewBase && curCrewBase !== liveBaseJob) {
              isSecondaryOccurrence = true;
            } else if (liveBaseJob && otherOccs.some(o => String(o.baseJob || '').trim().toLowerCase() === liveBaseJob) && curCrewBase !== liveBaseJob) {
              isSecondaryOccurrence = true;
            } else if (origBaseJob && otherOccs.some(o => String(o.baseJob || '').trim().toLowerCase() === origBaseJob) && curCrewBase !== origBaseJob) {
              isSecondaryOccurrence = true;
            } else if ((isWeekendSched || isPendingStatus) && otherOccs.length > 0) {
              isSecondaryOccurrence = true;
            } else {
              // Fallback: first occurrence in plan is Primary, subsequent occurrences are Secondary
              const firstOccBase = String(occurrences[0]?.baseJob || '').trim().toLowerCase();
              isSecondaryOccurrence = Boolean(firstOccBase && firstOccBase !== curCrewBase);
            }
          }

          if (isSecondaryOccurrence) {
            // Duplicated/Multi-crew secondary assignment: write to Secondary Job Number, preserving primary & Light Duty
            if (m.slot && m.slot !== curSecondary) {
              transfers.push({
                name: m.name,
                fromJob: curSecondary || 'None',
                toJob: m.slot,
                isSecondaryAssignment: true,
                keepLightDuty: inLightDuty,
                destinationCrew: crew.jobNumber,
                destinationLocation: crew.location || 'Helena',
                targetRow: live,
                wasLiveChanged,
                originalJob
              });
            }
          } else {
            if (!isMulti && curSecondary && !transfers.some(tr => tr.name.toLowerCase() === m.name.toLowerCase() && tr.clearSecondary)) {
              // Employee only has 1 crew assignment now: clear previous Secondary Job Number on live
              transfers.push({
                name: m.name,
                fromJob: curSecondary,
                toJob: '',
                isSecondaryAssignment: true,
                clearSecondary: true,
                keepLightDuty: false,
                destinationCrew: '',
                destinationLocation: '',
                targetRow: live,
                wasLiveChanged,
                originalJob
              });
            }
            const liveStatLower = String(live['Status'] || '').toLowerCase().trim();
            const liveLocLower = String(live['Location'] || '').toLowerCase().trim();
            const cleanLiveLocLower = liveLocLower.replace(/\s*\([^)]*\)/g, '').trim();
            const plannedCrewLocClean = String(crew.location || '').replace(/\s*\([^)]*\)/g, '').trim();
            const isCrewLocChanged = Boolean(!inLightDuty && plannedCrewLocClean && cleanLiveLocLower && plannedCrewLocClean.toLowerCase() !== cleanLiveLocLower);
            const hasActiveWeekVacInPlan = (plan.sidePane?.vacation || []).some(v =>
              v.name.toLowerCase() === m.name.toLowerCase() && !v.isFutureVacation && !v.keepOnCrew
            );
            const isReturningFromStatus = !hasActiveWeekVacInPlan && (
              liveStatLower === 'vacation' || liveStatLower === 'weeds' || liveStatLower === 'leave' || liveStatLower === 'medical' || liveStatLower === 'pending' ||
              liveLocLower.includes('(vacation)') || liveLocLower === 'vacation' ||
              liveLocLower.includes('(weeds)') || liveLocLower === 'weeds' ||
              liveLocLower.includes('(leave)') || liveLocLower === 'leave' ||
              liveLocLower.includes('(pending)') || liveLocLower === 'pending' ||
              (!inLightDuty && (liveStatLower === 'light duty' || liveLocLower.includes('(light duty)') || liveLocLower === 'light duty'))
            );

            if (m.slot && (m.slot !== liveJob || isReturningFromStatus || isCrewLocChanged)) {
              const statusLabel = live['Status'] && String(live['Status']).toLowerCase() !== 'active'
                ? String(live['Status']).trim()
                : (liveStatLower === 'pending' ? 'Pending' : 'Vacation');
              transfers.push({
                name: m.name,
                fromJob: (m.slot === liveJob && isReturningFromStatus)
                  ? `${statusLabel} (${liveJob || 'Unassigned'})`
                  : (m.slot === liveJob && isCrewLocChanged)
                    ? `${liveJob} (${live['Location'] || cleanLiveLocLower})`
                    : (liveJob || 'Unassigned'),
                toJob: m.slot,
                isReturningFromStatus,
                keepLightDuty: inLightDuty,
                destinationCrew: crew.jobNumber,
                destinationLocation: crew.location || 'Helena',
                targetRow: live,
                wasLiveChanged,
                originalJob
              });
            }
          }
        } else {
          newHires.push({
            name: m.name,
            assignedJob: m.slot || '',
            destinationCrew: crew.jobNumber,
            destinationLocation: crew.location || m.location || 'Helena',
            classification: m.classification || 'Apprentice',
            hireDate: m.hireDate || '',
            notes: this.getEmployeeNote(m.name, plan, m, liveNotesMap),
            status: 'Active'
          });
        }
      });
    });

    // Side pane: Planning Pool (unassigned from any crew or special status)
    (plan.sidePane?.planning || []).forEach(p => {
      const pNorm = String(p.name || '').toLowerCase().trim();
      if (!pNorm) return;
      const inAnyCrew = (plan.crews || []).some(c => (c.members || []).some(cm => String(cm.name || '').toLowerCase().trim() === pNorm));
      const inOtherSide = ['vacation', 'quit', 'weeds', 'lightDuty'].some(cat =>
        (plan.sidePane?.[cat] || []).some(s => String(s.name || '').toLowerCase().trim() === pNorm)
      );
      if (inAnyCrew || inOtherSide) return;

      const live = liveEmps.find(e => String(e['Employee Name'] || e['Name'] || '').trim().toLowerCase() === pNorm);
      if (live) {
        const liveLoc = String(live['Location'] || '').trim();
        const liveLocLower = liveLoc.toLowerCase();
        const liveStatLower = String(live['Status'] || '').trim().toLowerCase();
        if (liveLocLower === 'previous employee' || liveLocLower.includes('previous') || liveStatLower === 'previous employee') {
          return;
        }
        const liveJob = String(live['Job Number'] || live['Job #'] || '').trim();
        const liveSec = String(live['Secondary Job Number'] || live['Secondary Job #'] || '').trim();
        const hasStatusSuffix = /\((vacation|weeds|leave|light duty|medical)\)/i.test(liveLoc);
        if (liveJob || liveSec || (liveStatLower && liveStatLower !== 'active' && liveStatLower !== 'pending') || hasStatusSuffix) {
          unassignments.push({
            name: p.name,
            fromJob: liveJob || liveSec || live['Status'] || 'Assigned',
            targetRow: live
          });
        }
      } else {
        newHires.push({
          name: p.name,
          assignedJob: '',
          destinationCrew: 'Planning Pool',
          destinationLocation: p.location || 'Helena',
          classification: p.classification || 'Apprentice',
          hireDate: p.hireDate || '',
          notes: this.getEmployeeNote(p.name, plan, p, liveNotesMap),
          status: 'Active'
        });
      }
    });

    // Side pane: Vacation
    plan.sidePane.vacation.forEach(v => {
      const live = liveEmps.find(e => String(e['Employee Name'] || e['Name'] || '').trim().toLowerCase() === v.name.toLowerCase());
      if (live) {
        const liveStat = String(live['Status'] || live['Location'] || '').toLowerCase();
        if (v.isFutureVacation || v.keepOnCrew) {
          vacations.push({
            name: v.name,
            dateRange: v.dateRange || v.vacationStartDate || '',
            notes: v.notes || v.note || '',
            isFutureVacation: Boolean(v.isFutureVacation),
            keepOnCrew: Boolean(v.keepOnCrew),
            activeCrew: v.activeCrew || v.priorBaseJob || '',
            targetRow: live
          });
        } else if (!liveStat.includes('vacation')) {
          vacations.push({
            name: v.name,
            dateRange: v.dateRange || v.vacationStartDate || '',
            notes: v.notes || v.note || '',
            isFutureVacation: false,
            keepOnCrew: false,
            activeCrew: '',
            targetRow: live
          });
        }
      }
    });

    // Side pane: Light Duty
    const lightDuty = [];
    (plan.sidePane?.lightDuty || []).forEach(ld => {
      const live = liveEmps.find(e => String(e['Employee Name'] || e['Name'] || '').trim().toLowerCase() === ld.name.toLowerCase());
      if (live) {
        const liveStat = String(live['Status'] || live['Location'] || '').toLowerCase();
        if (!liveStat.includes('light duty')) {
          lightDuty.push({ name: ld.name, targetRow: live });
        }
      }
    });

    // Side pane: Quits & Scheduled Departures
    plan.sidePane.quit.forEach(q => {
      const live = liveEmps.find(e => String(e['Employee Name'] || e['Name'] || '').trim().toLowerCase() === q.name.toLowerCase());
      const liveLastDay = live ? String(live['Last Day'] || '').trim() : '';
      const alreadyRecorded = Boolean(liveLastDay && q.departureDate && liveLastDay === q.departureDate);

      quits.push({
        name: q.name,
        departureDate: q.departureDate || '',
        reason: q.departureReason || 'Quit',
        notes: q.notes || '',
        isScheduledDeparture: Boolean(q.isScheduledDeparture),
        activeCrew: q.activeCrew || '',
        alreadyRecordedOnLive: alreadyRecorded,
        targetRow: live
      });
    });

    // Side pane: Weeds
    plan.sidePane.weeds.forEach(w => {
      const live = liveEmps.find(e => String(e['Employee Name'] || e['Name'] || '').trim().toLowerCase() === w.name.toLowerCase());
      if (live) {
        const liveStat = String(live['Status'] || '').trim().toLowerCase();
        const liveLoc = String(live['Location'] || '').trim().toLowerCase();
        if (liveStat !== 'weeds' && !liveLoc.includes('(weeds)') && liveLoc !== 'weeds') {
          weeds.push({ name: w.name, targetRow: live });
        }
      }
    });

    // Employee Note updates staged in Crew Planning
    const noteCandidateMap = new Map();
    const recordNoteCandidate = (empName, obj) => {
      const clean = String(empName || '').trim();
      const norm = clean.toLowerCase();
      if (!norm) return;
      if (!noteCandidateMap.has(norm)) {
        noteCandidateMap.set(norm, { name: clean, memberObj: obj || null });
      }
    };
    (plan.crews || []).forEach(c => (c.members || []).forEach(m => recordNoteCandidate(m.name, m)));
    Object.values(plan.sidePane || {}).forEach(arr => {
      if (Array.isArray(arr)) arr.forEach(it => recordNoteCandidate(it.name, it));
    });
    Object.entries(plan.employeeNotes || {}).forEach(([normKey, entry]) => {
      if (entry && entry.edited) {
        const liveRow = liveEmps.find(e => String(e['Employee Name'] || e['Name'] || '').trim().toLowerCase() === normKey);
        const dispName = String(liveRow?.['Employee Name'] || liveRow?.['Name'] || normKey).trim();
        recordNoteCandidate(dispName, null);
      }
    });

    noteCandidateMap.forEach(({ name: dispName, memberObj }, normKey) => {
      const live = liveEmps.find(e => String(e['Employee Name'] || e['Name'] || '').trim().toLowerCase() === normKey);
      if (!live) return;
      const liveLoc = String(live['Location'] || '').trim().toLowerCase();
      const liveStat = String(live['Status'] || '').trim().toLowerCase();
      if (liveLoc === 'previous employee' || liveLoc.includes('previous') || liveStat === 'previous employee') {
        return;
      }
      const planEntry = plan.employeeNotes?.[normKey];
      const hasPlannedEdit = Boolean((planEntry && planEntry.edited) || memberObj?._editedNotes || memberObj?._clearedNotes);
      if (!hasPlannedEdit) return;
      const liveNote = String(live['Notes'] || live['Note'] || '').trim();
      const plannedNote = this.getEmployeeNote(dispName, plan, memberObj, liveNotesMap);
      if (plannedNote !== liveNote) {
        employeeNoteChanges.push({
          name: String(live['Employee Name'] || live['Name'] || dispName).trim(),
          oldNotes: liveNote,
          newNotes: plannedNote,
          targetRow: live
        });
      }
    });

    return { transfers, unassignments, vacations, quits, weeds, lightDuty, foremenChanges, scheduleChanges, crewMetadataChanges, employeeNoteChanges, newHires, departedOnLive };
  }

  openPublishModal() {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    // RULE: Do not allow publish if any unconfirmed purple employees exist
    const purpleMembers = this.getPurpleMembers(plan);
    if (purpleMembers.length > 0) {
      this.showUnconfirmedPurpleModal(purpleMembers);
      return;
    }

    // RULE: Require Last Working Day for all employees in Quit / Notice before publishing
    const missingDateQuit = (plan.sidePane.quit || []).find(q => !q.departureDate);
    if (missingDateQuit) {
      alert(`⚠️ Employee "${missingDateQuit.name}" in Quit/Notice is missing a Last Working Day.\n\nPlease click "Add Last Day" on their card in the Quit/Notice section before publishing.`);
      return;
    }

    const deltas = this.computePublishDeltas(plan);
    const totalChanges = (deltas.transfers.length +
                          (deltas.unassignments ? deltas.unassignments.length : 0) +
                          deltas.vacations.length +
                          deltas.quits.length +
                          deltas.weeds.length +
                          (deltas.lightDuty ? deltas.lightDuty.length : 0) +
                          deltas.newHires.length +
                          deltas.foremenChanges.length +
                          (deltas.scheduleChanges ? deltas.scheduleChanges.length : 0) +
                          (deltas.crewMetadataChanges ? deltas.crewMetadataChanges.length : 0) +
                          (deltas.employeeNoteChanges ? deltas.employeeNoteChanges.length : 0));

    const modalId = 'modal-crew-publish-confirm';
    let modal = document.getElementById(modalId);
    if (modal) modal.remove();

    const currentWeekStr = this.getCurrentWeekSundayStr();
    const isCurrentWeekPublished = this.isWeekPublished(currentWeekStr);
    const defaultPublishWeek = !isCurrentWeekPublished ? currentWeekStr : plan.weekDate;

    const publishWeekOptions = [
      {
        weekStr: currentWeekStr,
        label: `Week of ${currentWeekStr} (Current Week${!isCurrentWeekPublished ? ' — Not Yet Published' : ' — Already Published'})`
      },
      ...this.getPlanningWeeks().map(p => ({
        weekStr: p.weekStr,
        label: p.offset === 1 ? `Week of ${p.weekStr} (Next Week)` : `Week of ${p.weekStr} (+${p.offset} Weeks Out)`
      }))
    ];
    if (!publishWeekOptions.some(w => w.weekStr === plan.weekDate)) {
      publishWeekOptions.unshift({
        weekStr: plan.weekDate,
        label: `Week of ${plan.weekDate}`
      });
    }

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.75) !important; display: flex; align-items: center; justify-content: center; z-index: 15000 !important; pointer-events: auto !important; padding: 20px;';

    overlay.innerHTML = `
      <div class="modal-box" style="background: var(--bg-secondary, #1e293b); border: 1px solid var(--border-color, rgba(255,255,255,0.15)); border-radius: 10px; max-width: 680px; width: 100%; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden; color: #fff; pointer-events: auto !important;">
        
        <!-- Modal Header -->
        <div style="padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center;">
          <div style="font-size: 16px; font-weight: 800; color: #34d399; display: flex; align-items: center; gap: 8px;">
            <span>🚀</span> Publish Crew Structure — Week of <span id="publish-header-week-span">${this.escapeHtml(defaultPublishWeek)}</span>
          </div>
          <button id="btn-publish-close-x" style="background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 4px 8px;">✕</button>
        </div>

        <!-- Modal Body (Delta Review) -->
        <div style="padding: 20px; overflow-y: auto; flex: 1; font-size: 13px;">
          
          <!-- Target Week to Publish To Selector -->
          <div style="background: rgba(59, 130, 246, 0.14); border: 1.5px solid rgba(59, 130, 246, 0.45); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px;">
            <label for="publish-target-week-select" style="font-size: 12px; font-weight: 800; color: #93c5fd; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
              <span>📅 Select Week to Publish This Crew Structure To:</span>
              ${!isCurrentWeekPublished ? `<span class="badge" style="background: rgba(245, 158, 11, 0.25); color: #fcd34d; border: 1px solid #f59e0b; font-size: 10px; padding: 1px 6px; border-radius: 4px;">Current Week (${this.escapeHtml(currentWeekStr)}) Unpublished</span>` : ''}
            </label>
            <select id="publish-target-week-select" style="width: 100%; background: #0f172a; border: 1px solid rgba(96, 165, 250, 0.5); border-radius: 6px; color: #ffffff; padding: 9px 12px; font-size: 13.5px; font-weight: 700; cursor: pointer;">
              ${publishWeekOptions.map(w => `
                <option value="${this.escapeHtml(w.weekStr)}" ${w.weekStr === defaultPublishWeek ? 'selected' : ''}>
                  ${this.escapeHtml(w.label)}
                </option>
              `).join('')}
            </select>
            ${!isCurrentWeekPublished && plan.weekDate !== currentWeekStr ? `
              <div style="font-size: 11px; color: #cbd5e1; margin-top: 6px; line-height: 1.4;">
                💡 <strong>Note:</strong> Week of <strong>${this.escapeHtml(currentWeekStr)}</strong> has not been published yet, so it is pre-selected above. Publishing to <strong>${this.escapeHtml(currentWeekStr)}</strong> will apply all of your current planning changes directly to this week's live roster and archive.
              </div>
            ` : ''}
            <div id="publish-future-week-warning" style="display: ${defaultPublishWeek !== currentWeekStr ? 'block' : 'none'}; font-size: 11px; color: #fcd34d; margin-top: 6px; line-height: 1.4;">
              ⚠️ <strong>Future Week Publish:</strong> Publishing applies roster &amp; crew changes immediately to the live <strong>Employees</strong> and <strong>Job Tracking</strong> tables, while recording confirmed yellow highlights for the selected week.
            </div>
          </div>

          <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 6px; padding: 12px; margin-bottom: 16px;">
            <strong>All changes confirmed! Ready to apply to the live database.</strong><br>
            <span style="color: #94a3b8; font-size: 12px;">This action will atomically update the live <strong>Employees</strong>, <strong>Job Tracking</strong>, and <strong>Employee History</strong> tables, and carry confirmed movements through with yellow highlighting.</span>
          </div>

          <!-- Departed on Live Alert (Recognition protection) -->
          ${deltas.departedOnLive && deltas.departedOnLive.length > 0 ? `
            <div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 6px; padding: 10px; margin-bottom: 14px;">
              <div style="font-weight: 700; color: #fca5a5; margin-bottom: 4px;">⚠️ Departed on Live Database (${deltas.departedOnLive.length} Skipped)</div>
              ${deltas.departedOnLive.map(d => `
                <div style="font-size: 11.5px; color: #e2e8f0; padding: 2px 0;">• <strong>${this.escapeHtml(d.name)}</strong> is already marked as <em>Previous Employee</em> on the live database. Skipped to prevent resurrecting to Crew ${this.escapeHtml(d.plannedCrew)}.</div>
              `).join('')}
            </div>
          ` : ''}

          <div style="font-weight: 700; margin-bottom: 8px; color: #93c5fd;">Summary of Detected Updates (${totalChanges} Changes):</div>
          
          <div style="display: flex; flex-direction: column; gap: 10px;">
            <!-- Transfers -->
            <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
              <div style="font-weight: 700; color: #60a5fa; margin-bottom: 4px;">🔄 Crew Reassignments (${deltas.transfers.length})</div>
              ${deltas.transfers.length > 0 ? deltas.transfers.slice(0, 10).map(t => `
                <div style="font-size: 11.5px; color: #cbd5e1; padding: 2px 0;">
                  • <strong>${this.escapeHtml(t.name)}</strong>: ${this.escapeHtml(t.fromJob)} → <span style="color: #60a5fa; font-weight: 700;">${this.escapeHtml(t.toJob)}</span>
                  ${t.wasLiveChanged ? `<span class="badge" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); font-size: 9.5px; margin-left: 5px;" title="Changed on Live sheet mid-week — will be updated to next week plan">⚠️ Changed on Live</span>` : ''}
                </div>
              `).join('') + (deltas.transfers.length > 10 ? `<div style="font-size: 11px; color: #94a3b8; font-style: italic;">...and ${deltas.transfers.length - 10} more reassignments</div>` : '') : '<span style="font-size: 11.5px; color: #64748b;">Zero crew transfers.</span>'}
            </div>

            <!-- Unassignments (Planning Pool) -->
            ${deltas.unassignments && deltas.unassignments.length > 0 ? `
              <div style="background: rgba(148, 163, 184, 0.1); padding: 10px; border-radius: 6px; border: 1px solid rgba(148, 163, 184, 0.25);">
                <div style="font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">📋 Moved to Planning Pool / Unassigned (${deltas.unassignments.length})</div>
                ${deltas.unassignments.map(u => `
                  <div style="font-size: 11.5px; color: #cbd5e1; padding: 2px 0;">• <strong>${this.escapeHtml(u.name)}</strong>: ${this.escapeHtml(u.fromJob)} → <span style="color: #94a3b8;">Unassigned (Planning Pool)</span></div>
                `).join('')}
              </div>
            ` : ''}

            <!-- New Hires -->
            ${deltas.newHires && deltas.newHires.length > 0 ? `
              <div style="background: rgba(16, 185, 129, 0.1); padding: 10px; border-radius: 6px; border: 1px solid rgba(16, 185, 129, 0.25);">
                <div style="font-weight: 700; color: #34d399; margin-bottom: 4px;">✨ New Hires Added to Live Roster (${deltas.newHires.length})</div>
                ${deltas.newHires.map(nh => `
                  <div style="font-size: 11.5px; color: #cbd5e1; padding: 2px 0;">• <strong>${this.escapeHtml(nh.name)}</strong> (${this.escapeHtml(nh.classification)}) → ${this.escapeHtml(nh.assignedJob || nh.destinationCrew)}</div>
                `).join('')}
              </div>
            ` : ''}

            <!-- Crew Metadata & New Crews -->
            ${deltas.crewMetadataChanges && deltas.crewMetadataChanges.length > 0 ? `
              <div style="background: rgba(99, 102, 241, 0.1); padding: 10px; border-radius: 6px; border: 1px solid rgba(99, 102, 241, 0.25);">
                <div style="font-weight: 700; color: #a5b4fc; margin-bottom: 4px;">🏗️ Crew Metadata &amp; New Crews (${deltas.crewMetadataChanges.length})</div>
                ${deltas.crewMetadataChanges.map(mc => `
                  <div style="font-size: 11.5px; color: #cbd5e1; padding: 2px 0;">• Crew <strong>${this.escapeHtml(mc.jobNumber)}</strong>: ${this.escapeHtml((mc.changes || []).join(', '))}</div>
                `).join('')}
              </div>
            ` : ''}

            <!-- Employee Note Updates -->
            ${deltas.employeeNoteChanges && deltas.employeeNoteChanges.length > 0 ? `
              <div style="background: rgba(245, 158, 11, 0.1); padding: 10px; border-radius: 6px; border: 1px solid rgba(245, 158, 11, 0.3);">
                <div style="font-weight: 700; color: #fbbf24; margin-bottom: 4px;">📝 Employee Note Updates (${deltas.employeeNoteChanges.length})</div>
                ${deltas.employeeNoteChanges.map(nc => `
                  <div style="font-size: 11.5px; color: #cbd5e1; padding: 2px 0;">
                    • <strong>${this.escapeHtml(nc.name)}</strong>: ${nc.oldNotes ? `"${this.escapeHtml(nc.oldNotes)}"` : '<em>None</em>'} → <span style="color: #fde68a;">${nc.newNotes ? `"${this.escapeHtml(nc.newNotes)}"` : '<em>Cleared</em>'}</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}

            <!-- Foremen Changes & Equipment Transfer Toggle -->
            ${deltas.foremenChanges.length > 0 ? `
              <div style="background: rgba(244, 114, 182, 0.1); padding: 10px; border-radius: 6px; border: 1px solid rgba(244, 114, 182, 0.25);">
                <div style="font-weight: 700; color: #f472b6; margin-bottom: 4px;">👑 Foremen Designations (${deltas.foremenChanges.length})</div>
                ${deltas.foremenChanges.map(f => `
                  <div style="font-size: 11.5px; margin-bottom: 4px;">• Crew <strong>${this.escapeHtml(f.jobNumber)}</strong>: ${this.escapeHtml(f.oldForeman)} → <strong>${this.escapeHtml(f.newForeman)}</strong></div>
                `).join('')}
                <label style="display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 11.5px; color: #fbbf24; cursor: pointer;">
                  <input type="checkbox" id="publish-transfer-equipment-checkbox" checked style="cursor: pointer;">
                  <span>⚡ Reassign truck equipment (Blankets, MACKs, HV Testers, Phasing Sets, AED) to incoming Foremen</span>
                </label>
              </div>
            ` : ''}

            <!-- Schedule & Working Day Changes -->
            ${deltas.scheduleChanges && deltas.scheduleChanges.length > 0 ? `
              <div style="background: rgba(59, 130, 246, 0.08); padding: 10px; border-radius: 6px; border: 1px solid rgba(59, 130, 246, 0.25);">
                <div style="font-weight: 700; color: #60a5fa; margin-bottom: 4px;">🕒 Schedule & Working Day Updates (${deltas.scheduleChanges.length})</div>
                ${deltas.scheduleChanges.map(s => `
                  <div style="font-size: 11.5px; color: #cbd5e1; padding: 2px 0;">
                    • Crew <strong>${this.escapeHtml(s.jobNumber)}</strong>: ${this.escapeHtml(s.oldSchedule)} → <strong style="color: #93c5fd;">${this.escapeHtml(s.newSchedule)}</strong>
                  </div>
                `).join('')}
              </div>
            ` : ''}

            <!-- Vacation & Status -->
            <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
              <div style="font-weight: 700; color: #fbbf24; margin-bottom: 4px;">🏖️ Scheduled Vacation / Status (${deltas.vacations.length + deltas.weeds.length + (deltas.lightDuty ? deltas.lightDuty.length : 0)})</div>
              ${deltas.vacations.map(v => `
                <div style="font-size: 11.5px; color: #cbd5e1; padding: 1px 0;">
                  • 🏖️ <strong>${this.escapeHtml(v.name)}</strong>${v.dateRange ? ` (${this.escapeHtml(v.dateRange)})` : ''}:
                  ${v.isFutureVacation
                    ? `<span style="color: #93c5fd;">⏭️ Future Week Vacation — Keep Active on Crew ${this.escapeHtml(v.activeCrew || 'Field')} this week</span>`
                    : v.keepOnCrew
                      ? `<span style="color: #6ee7b7;">🗓️ Partial Week Vacation — Keep Active on Crew ${this.escapeHtml(v.activeCrew || 'Field')}</span>`
                      : `<span style="color: #fcd34d;">Set Status = Vacation (Off This Week)</span>`
                  }
                </div>
              `).join('')}
              ${deltas.weeds.map(w => `<div style="font-size: 11.5px; color: #cbd5e1;">• 🌾 <strong>${this.escapeHtml(w.name)}</strong>: Set Status = Weeds</div>`).join('')}
              ${(deltas.lightDuty || []).map(ld => `<div style="font-size: 11.5px; color: #cbd5e1;">• 🩺 <strong>${this.escapeHtml(ld.name)}</strong>: Set Status = Light Duty</div>`).join('')}
              ${deltas.vacations.length === 0 && deltas.weeds.length === 0 && (!deltas.lightDuty || deltas.lightDuty.length === 0) ? '<span style="font-size: 11.5px; color: #64748b;">Zero status changes.</span>' : ''}
            </div>

            <!-- Quits / Departures -->
            ${deltas.quits.length > 0 ? `
              <div style="background: rgba(239, 68, 68, 0.1); padding: 10px; border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.25);">
                <div style="font-weight: 700; color: #f87171; margin-bottom: 4px;">🚪 Quits / Scheduled Departures (${deltas.quits.length})</div>
                ${deltas.quits.map(q => `
                  <div style="font-size: 11.5px; color: #cbd5e1; padding: 2px 0;">
                    • <strong>${this.escapeHtml(q.name)}</strong> (Last Day: ${this.escapeHtml(q.departureDate)} — ${this.escapeHtml(q.reason)})
                    ${q.isScheduledDeparture ? `➔ <span style="color: #60a5fa;">Active on Crew ${this.escapeHtml(q.activeCrew || 'Field')} until last day</span>` : '➔ Move to Previous Employees'}
                    ${q.alreadyRecordedOnLive ? `<span style="color: #94a3b8; font-size: 10px; margin-left: 4px;">(Already recorded on live database)</span>` : ''}
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>

        </div>

        <!-- Modal Footer -->
        <div style="padding: 14px 20px; border-top: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); display: flex; justify-content: space-between; align-items: center;">
          <div style="font-size: 11px; color: #94a3b8;">Next week structure takes effect on database</div>
          <div style="display: flex; gap: 10px;">
            <button class="btn btn-secondary" id="btn-publish-cancel" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">
              Cancel
            </button>
            <button class="btn btn-primary" id="btn-publish-submit" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); border: none; font-weight: 700; padding: 6px 16px; cursor: pointer;">
              🚀 Confirm & Apply to Database
            </button>
          </div>
        </div>

      </div>
    `;

    document.body.appendChild(overlay);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    overlay._onKey = onKey;
    const closeModal = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    window.addEventListener('keydown', onKey);

    overlay.querySelector('#btn-publish-close-x')?.addEventListener('click', closeModal);
    overlay.querySelector('#btn-publish-cancel')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    const targetWeekSelect = overlay.querySelector('#publish-target-week-select');
    const headerWeekSpan = overlay.querySelector('#publish-header-week-span');
    const futureWarning = overlay.querySelector('#publish-future-week-warning');
    const submitBtn = overlay.querySelector('#btn-publish-submit');
    if (submitBtn) {
      submitBtn.innerHTML = `🚀 Publish to Week of ${this.escapeHtml(defaultPublishWeek)}`;
    }
    targetWeekSelect?.addEventListener('change', () => {
      const val = targetWeekSelect.value;
      if (headerWeekSpan) headerWeekSpan.textContent = val;
      if (submitBtn) submitBtn.innerHTML = `🚀 Publish to Week of ${this.escapeHtml(val)}`;
      if (futureWarning) futureWarning.style.display = (val && val !== currentWeekStr) ? 'block' : 'none';
    });

    overlay.querySelector('#btn-publish-submit')?.addEventListener('click', () => {
      const selectedTargetWeek = targetWeekSelect?.value || defaultPublishWeek;
      this.executePublish(selectedTargetWeek);
    });
  }

  async cleanupDuplicateJobTrackingRows(jtTable, primaryRow, jobNumber) {
    if (!jtTable || !Array.isArray(jtTable.rows) || !this.db) return;
    const rawTarget = String(jobNumber || '').trim();
    const normTarget = rawTarget.replace(/\.\d+.*$/, '').trim();
    if (!normTarget) return;

    const dupJtRows = jtTable.rows
      .map((j, idx) => ({ rowObj: j, rowIdx: j._rowIdx || (idx + 2) }))
      .filter(({ rowObj }) => {
        if (rowObj === primaryRow) return false;
        const jn = String(rowObj['Job Number'] || rowObj['Job #'] || '').trim();
        return jn === rawTarget || jn.replace(/\.\d+.*$/, '').trim() === normTarget;
      })
      .sort((a, b) => b.rowIdx - a.rowIdx);

    for (const { rowIdx } of dupJtRows) {
      await this.db.addMutation({
        action: 'DELETE_ROW',
        sheetName: jtTable.name || 'Job Tracking',
        tableKey: 'job_tracking',
        itemIdentifier: rawTarget || normTarget,
        row: rowIdx
      });
    }
  }

  async executePublish(targetPublishWeek = null) {
    if (window.currentRoleMode === 'view_only') {
      if (typeof window.showToast === 'function') window.showToast('View Only mode — cannot publish.', 'warning');
      return;
    }
    const modalId = 'modal-crew-publish-confirm';
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;
    const publishWeek = targetPublishWeek || document.getElementById('publish-target-week-select')?.value || plan.weekDate;

    // Safety re-check for purple members
    const purpleMembers = this.getPurpleMembers(plan);
    if (purpleMembers.length > 0) {
      const m = document.getElementById(modalId);
      if (m) {
        if (m._onKey) window.removeEventListener('keydown', m._onKey);
        m.remove();
      }
      this.showUnconfirmedPurpleModal(purpleMembers);
      return;
    }

    const deltas = this.computePublishDeltas(plan);
    const transferEquipment = document.getElementById('publish-transfer-equipment-checkbox')?.checked ?? true;

    // Capture confirmed yellow moved employee names BEFORE Steps 1-3 mutate live empTable.rows
    const yellowConfirmedMoves = [];
    const prePublishBaselineMap = this.getOriginalEmployeeLocations();
    const prePublishOccMap = this.getEmployeeOccurrencesMap(plan);
    (plan.crews || []).forEach(crew => {
      (crew.members || []).forEach(m => {
        const st = this.getEmployeePlanningStatus(m.name, crew.jobNumber, null, plan, prePublishBaselineMap, prePublishOccMap);
        if (st.statusColor === 'yellow' || (!st.isMultiLocation && st.isMoved && m.isConfirmed)) {
          if (!yellowConfirmedMoves.includes(m.name)) yellowConfirmedMoves.push(m.name);
        }
      });
    });

    try {
      const empTable = this.db.getTable('employees');
      const jtTable = this.db.getTable('job_tracking');
      const histTable = this.db.getTable('employee_history');
      const todayFormatted = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

      const syncRowToRawGrid = (table, rowObj) => {
        if (!table || !rowObj || !Array.isArray(table.headers) || !Array.isArray(table.rawGrid)) return;
        const rIdx = rowObj._rowIdx || (Array.isArray(table.rows) ? (table.rows.indexOf(rowObj) + 2) : -1);
        if (rIdx >= 2 && table.rawGrid[rIdx - 1]) {
          table.headers.forEach((h, cIdx) => {
            if (h && rowObj[h] !== undefined) {
              table.rawGrid[rIdx - 1][cIdx] = rowObj[h];
            }
          });
        }
      };

      // 1. Process Transfers
      const secCol = (empTable?.headers && empTable.headers.includes('Secondary Job #') && !empTable.headers.includes('Secondary Job Number'))
        ? 'Secondary Job #'
        : 'Secondary Job Number';
      for (const t of deltas.transfers) {
        if (t.targetRow && empTable) {
          const empRowNum = t.targetRow._rowIdx || (empTable.rows ? (empTable.rows.indexOf(t.targetRow) + 2) : undefined);
          if (t.isSecondaryAssignment) {
            t.targetRow[secCol] = t.toJob;
            if (t.keepLightDuty) {
              t.targetRow['Status'] = 'Light Duty';
              const curLoc = String(t.targetRow['Location'] || 'Helena');
              if (!curLoc.toLowerCase().includes('(light duty)')) {
                t.targetRow['Location'] = `${curLoc.replace(/\s*\([^)]*\)/g, '').trim()} (Light Duty)`;
              }
            }
            syncRowToRawGrid(empTable, t.targetRow);
            await this.db.addMutation({
              action: 'UPDATE_ROW',
              sheetName: empTable.name || 'Employees',
              tableKey: 'employees',
              itemIdentifier: t.name,
              employeeName: t.name,
              row: empRowNum,
              updatedFields: {
                [secCol]: t.toJob,
                'Status': t.targetRow['Status'],
                'Location': t.targetRow['Location']
              }
            });
          } else {
            t.targetRow['Job Number'] = t.toJob;
            if (t.keepLightDuty) {
              t.targetRow['Status'] = 'Light Duty';
              const baseLoc = String(t.destinationLocation || t.targetRow['Location'] || 'Helena').replace(/\s*\([^)]*\)/g, '').trim() || 'Helena';
              t.targetRow['Location'] = `${baseLoc} (Light Duty)`;
            } else {
              const cleanDestLoc = String(t.destinationLocation || t.targetRow['Location'] || 'Helena').replace(/\s*\([^)]*\)/g, '').trim() || 'Helena';
              t.targetRow['Location'] = cleanDestLoc;
              const curStatLower = String(t.targetRow['Status'] || '').toLowerCase().trim();
              if (!curStatLower || ['vacation', 'weeds', 'leave', 'medical', 'light duty', 'pending'].includes(curStatLower) || t.isReturningFromStatus) {
                t.targetRow['Status'] = 'Active';
              }
            }
            syncRowToRawGrid(empTable, t.targetRow);
            await this.db.addMutation({
              action: 'UPDATE_ROW',
              sheetName: empTable.name || 'Employees',
              tableKey: 'employees',
              itemIdentifier: t.name,
              employeeName: t.name,
              row: empRowNum,
              updatedFields: {
                'Job Number': t.toJob,
                'Location': t.targetRow['Location'],
                'Status': t.targetRow['Status'] || 'Active'
              }
            });
          }

          // Log in Employee History (do not pre-unshift histTable.rows so addMutation updates rows + rawGrid cleanly)
          if (histTable) {
            const histRow = {
              'Date': todayFormatted,
              'Employee Name': t.name,
              'Event Type': t.isSecondaryAssignment ? 'Secondary Assignment' : 'Transfer',
              'Job Number': t.toJob,
              'Location': t.destinationLocation || t.targetRow['Location'] || 'Helena',
              'Notes': t.isSecondaryAssignment
                ? `Crew Planning Publish: Assigned secondary crew ${t.destinationCrew} (${t.toJob})${t.keepLightDuty ? ' while on Light Duty' : ''}`
                : `Crew Planning Publish: Transferred from ${t.fromJob} to ${t.toJob}`
            };
            await this.db.addMutation({
              action: 'ADD_ROW',
              sheetName: histTable.name || 'Employee History',
              tableKey: 'employee_history',
              itemIdentifier: t.name,
              rowData: histRow
            });
          }
        }
      }

      // 1.5 Process New Hires
      for (const nh of (deltas.newHires || [])) {
        if (empTable) {
          const newEmpRow = {};
          if (Array.isArray(empTable.headers)) {
            empTable.headers.forEach(h => { if (h) newEmpRow[h] = ''; });
          }
          const nameKey = Array.isArray(empTable.headers) && !empTable.headers.includes('Employee Name') && empTable.headers.includes('Name')
            ? 'Name'
            : 'Employee Name';
          const jobKey = Array.isArray(empTable.headers) && !empTable.headers.includes('Job Number') && empTable.headers.includes('Job #')
            ? 'Job #'
            : 'Job Number';
          newEmpRow[nameKey] = nh.name;
          newEmpRow[jobKey] = nh.assignedJob || '';
          newEmpRow['Classification'] = nh.classification || 'Apprentice';
          newEmpRow['Location'] = nh.destinationLocation || 'Helena';
          newEmpRow['Status'] = nh.status || 'Active';
          if (nh.hireDate) {
            newEmpRow['Hire Date'] = nh.hireDate;
          } else if (!Array.isArray(empTable.headers) || empTable.headers.includes('Hire Date')) {
            newEmpRow['Hire Date'] = todayFormatted;
          }
          if (nh.notes) newEmpRow['Notes'] = nh.notes;

          await this.db.addMutation({
            action: 'ADD_ROW',
            sheetName: empTable.name || 'Employees',
            tableKey: 'employees',
            itemIdentifier: nh.name,
            employeeName: nh.name,
            rowData: newEmpRow
          });

          if (histTable) {
            const histRow = {
              'Date': todayFormatted,
              'Employee Name': nh.name,
              'Event Type': 'New Hire',
              'Job Number': nh.assignedJob || '',
              'Location': nh.destinationLocation || 'Helena',
              'Notes': nh.assignedJob
                ? `Crew Planning Publish: Added new hire to Crew ${nh.destinationCrew} (${nh.assignedJob})`
                : 'Crew Planning Publish: Added new hire to Planning Pool'
            };
            await this.db.addMutation({
              action: 'ADD_ROW',
              sheetName: histTable.name || 'Employee History',
              tableKey: 'employee_history',
              itemIdentifier: nh.name,
              rowData: histRow
            });
          }
        }
      }

      // 1.6 Process Unassignments (Moved to Planning Pool)
      for (const u of (deltas.unassignments || [])) {
        if (u.targetRow && empTable) {
          const empRowNum = u.targetRow._rowIdx || (empTable.rows ? (empTable.rows.indexOf(u.targetRow) + 2) : undefined);
          const cleanLoc = String(u.targetRow['Location'] || 'Helena').replace(/\s*\([^)]*\)/g, '').trim() || 'Helena';
          u.targetRow['Job Number'] = '';
          u.targetRow[secCol] = '';
          u.targetRow['Location'] = cleanLoc;
          u.targetRow['Status'] = 'Active';
          syncRowToRawGrid(empTable, u.targetRow);
          await this.db.addMutation({
            action: 'UPDATE_ROW',
            sheetName: empTable.name || 'Employees',
            tableKey: 'employees',
            itemIdentifier: u.name,
            employeeName: u.name,
            row: empRowNum,
            updatedFields: {
              'Job Number': '',
              [secCol]: '',
              'Location': cleanLoc,
              'Status': 'Active'
            }
          });
          if (histTable) {
            const histRow = {
              'Date': todayFormatted,
              'Employee Name': u.name,
              'Event Type': 'Unassigned',
              'Job Number': '',
              'Location': cleanLoc,
              'Notes': `Crew Planning Publish: Moved from ${u.fromJob} to Planning Pool`
            };
            await this.db.addMutation({
              action: 'ADD_ROW',
              sheetName: histTable.name || 'Employee History',
              tableKey: 'employee_history',
              itemIdentifier: u.name,
              rowData: histRow
            });
          }
        }
      }

      // 2. Process Vacations
      for (const v of deltas.vacations) {
        if (v.targetRow) {
          if (!v.isFutureVacation && !v.keepOnCrew) {
            const empRowNum = v.targetRow._rowIdx || (empTable?.rows ? (empTable.rows.indexOf(v.targetRow) + 2) : undefined);
            v.targetRow['Status'] = 'Vacation';
            syncRowToRawGrid(empTable, v.targetRow);
            await this.db.addMutation({
              action: 'UPDATE_ROW',
              sheetName: empTable.name || 'Employees',
              tableKey: 'employees',
              itemIdentifier: v.name,
              employeeName: v.name,
              row: empRowNum,
              updatedFields: { 'Status': 'Vacation' }
            });
          }
        }
      }

      // 3. Process Weeds
      for (const w of deltas.weeds) {
        if (w.targetRow) {
          const empRowNum = w.targetRow._rowIdx || (empTable?.rows ? (empTable.rows.indexOf(w.targetRow) + 2) : undefined);
          w.targetRow['Status'] = 'Weeds';
          syncRowToRawGrid(empTable, w.targetRow);
          await this.db.addMutation({
            action: 'UPDATE_ROW',
            sheetName: empTable.name || 'Employees',
            tableKey: 'employees',
            itemIdentifier: w.name,
            employeeName: w.name,
            row: empRowNum,
            updatedFields: { 'Status': 'Weeds' }
          });
        }
      }

      // 3.5 Process Quits & Scheduled Departures
      for (const q of deltas.quits) {
        if (!q.alreadyRecordedOnLive) {
          await this.applyQuitDeparture(q, todayFormatted);
        }
      }

      // 3.6 Process Light Duty
      for (const ld of (deltas.lightDuty || [])) {
        if (ld.targetRow) {
          const empRowNum = ld.targetRow._rowIdx || (empTable?.rows ? (empTable.rows.indexOf(ld.targetRow) + 2) : undefined);
          ld.targetRow['Status'] = 'Light Duty';
          const curLoc = String(ld.targetRow['Location'] || 'Helena').replace(/\s*\([^)]*\)/g, '').trim();
          ld.targetRow['Location'] = `${curLoc} (Light Duty)`;
          syncRowToRawGrid(empTable, ld.targetRow);
          await this.db.addMutation({
            action: 'UPDATE_ROW',
            sheetName: empTable.name || 'Employees',
            tableKey: 'employees',
            itemIdentifier: ld.name,
            employeeName: ld.name,
            row: empRowNum,
            updatedFields: { 'Status': 'Light Duty', 'Location': ld.targetRow['Location'] }
          });
        }
      }

      // 3.7 Process Employee Note Updates
      const empNoteCol = (empTable?.headers && empTable.headers.includes('Notes'))
        ? 'Notes'
        : ((empTable?.headers && empTable.headers.includes('Note')) ? 'Note' : 'Notes');
      for (const nc of (deltas.employeeNoteChanges || [])) {
        if (nc.targetRow && empTable) {
          const empRowNum = nc.targetRow._rowIdx || (empTable.rows ? (empTable.rows.indexOf(nc.targetRow) + 2) : undefined);
          nc.targetRow[empNoteCol] = nc.newNotes;
          nc.targetRow['Notes'] = nc.newNotes;
          syncRowToRawGrid(empTable, nc.targetRow);
          await this.db.addMutation({
            action: 'UPDATE_ROW',
            sheetName: empTable.name || 'Employees',
            tableKey: 'employees',
            itemIdentifier: nc.name,
            employeeName: nc.name,
            row: empRowNum,
            updatedFields: { [empNoteCol]: nc.newNotes }
          });
          if (this.db._dirtyTablesForSync && typeof this.db._dirtyTablesForSync.add === 'function') {
            this.db._dirtyTablesForSync.add('employees');
          }
        }
        const normKey = String(nc.name || '').trim().toLowerCase();
        if (plan.employeeNotes?.[normKey]) {
          plan.employeeNotes[normKey].edited = false;
        }
        (plan.crews || []).forEach(c => (c.members || []).forEach(m => {
          if (m && String(m.name || '').trim().toLowerCase() === normKey) {
            m.notes = nc.newNotes;
            m._editedNotes = false;
            m._clearedNotes = !nc.newNotes;
          }
        }));
      }

      // 4. Process Job Tracking Foremen, Schedules & Active Crews
      const allPlansForNames = this.getPlansMap();
      const allHistForNames = this.db?.snapshot?.configs?.crew_roster_history || {};
      const normBool = (val) => val === true || String(val || '').toLowerCase() === 'true';
      const schedCol = (jtTable?.headers && jtTable.headers.includes('Work Schedule'))
        ? 'Work Schedule'
        : (jtTable?.headers && jtTable.headers.includes('Schedule') ? 'Schedule' : 'Work Schedule');
      const hasCrewSizeCol = Boolean(jtTable?.headers && jtTable.headers.includes('Crew Size'));

      for (const crew of plan.crews) {
        let jtRow = (jtTable?.rows || []).find(j => {
          const jn = String(j['Job Number'] || j['Job #'] || '').trim();
          return jn === crew.jobNumber || jn.replace(/\.\d+.*$/, '').trim() === crew.jobNumber;
        });

        // If crew.jobName is empty on this week's plan (and wasn't explicitly cleared), check other weeks' plans or roster history
        if (!crew._clearedJobName && (!crew.jobName || crew.jobName === crew.jobNumber) && !jtRow?.['Job Name']) {
          for (const p of Object.values(allPlansForNames)) {
            const matchCrew = (p?.crews || []).find(c => String(c.jobNumber || '').trim() === crew.jobNumber && c.jobName && c.jobName !== crew.jobNumber);
            if (matchCrew) {
              crew.jobName = matchCrew.jobName;
              break;
            }
          }
          if (!crew.jobName || crew.jobName === crew.jobNumber) {
            for (const h of Object.values(allHistForNames)) {
              const matchCrew = (h?.crews || []).find(c => String(c.jobNumber || '').trim() === crew.jobNumber && c.jobName && c.jobName !== crew.jobNumber);
              if (matchCrew) {
                crew.jobName = matchCrew.jobName;
                break;
              }
            }
          }
        }

        const crewSkips = this.getCrewSkipDays(crew);
        if (jtRow) {
          const updated = {};
          if (crew._clearedJobName) {
            if (String(jtRow['Job Name'] || '').trim() !== '') {
              jtRow['Job Name'] = '';
              updated['Job Name'] = '';
            }
          } else if (crew.jobName && String(jtRow['Job Name'] || '').trim() !== String(crew.jobName).trim()) {
            jtRow['Job Name'] = crew.jobName;
            updated['Job Name'] = crew.jobName;
          }
          const finalType = this.detectCrewType(crew.jobNumber, crew.jobName, crew.location, crew.crewType);
          if (finalType && jtRow['Crew Type'] !== finalType) {
            jtRow['Crew Type'] = finalType;
            updated['Crew Type'] = finalType;
          }
          if (crew.status && jtRow['Status'] !== crew.status) {
            jtRow['Status'] = crew.status;
            updated['Status'] = crew.status;
          }
          if (crew.foreman !== undefined && String(jtRow['Foreman'] || '').trim() !== String(crew.foreman || '').trim()) {
            const nextForeman = String(crew.foreman || '').trim();
            jtRow['Foreman'] = nextForeman;
            updated['Foreman'] = nextForeman;
          }
          if (crew.location && jtRow['Location'] !== crew.location) {
            jtRow['Location'] = crew.location;
            updated['Location'] = crew.location;
          }
          const liveSchedVal = String(jtRow[schedCol] || jtRow['Work Schedule'] || jtRow['Schedule'] || '').trim();
          if (crew.schedule && liveSchedVal !== crew.schedule) {
            jtRow[schedCol] = crew.schedule;
            updated[schedCol] = crew.schedule;
          }
          ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => {
            const prop = 'isSkip' + d;
            const col = 'Skip ' + d;
            if (crewSkips[prop] !== undefined && normBool(jtRow[col]) !== Boolean(crewSkips[prop])) {
              jtRow[col] = Boolean(crewSkips[prop]);
              updated[col] = Boolean(crewSkips[prop]);
            }
          });
          if (crew.skipMtg !== undefined && normBool(jtRow['Skip Weekly Meeting']) !== Boolean(crew.skipMtg)) {
            jtRow['Skip Weekly Meeting'] = Boolean(crew.skipMtg);
            updated['Skip Weekly Meeting'] = Boolean(crew.skipMtg);
          }
          if (crew.skipChk !== undefined && normBool(jtRow['Skip Monthly Checklist']) !== Boolean(crew.skipChk)) {
            jtRow['Skip Monthly Checklist'] = Boolean(crew.skipChk);
            updated['Skip Monthly Checklist'] = Boolean(crew.skipChk);
          }
          if (crew.notes !== undefined) {
            const cleanNotes = String(crew.notes || '').trim();
            if (String(jtRow['Notes'] || '').trim() !== cleanNotes) {
              jtRow['Notes'] = cleanNotes;
              updated['Notes'] = cleanNotes;
            }
          }
          if (hasCrewSizeCol) {
            const nextSize = (crew.members || []).length;
            if (Number(jtRow['Crew Size']) !== nextSize) {
              jtRow['Crew Size'] = nextSize;
              updated['Crew Size'] = nextSize;
            }
          }
          if (Object.keys(updated).length > 0) {
            syncRowToRawGrid(jtTable, jtRow);
            await this.db.addMutation({
              action: 'UPDATE_ROW',
              sheetName: jtTable.name || 'Job Tracking',
              tableKey: 'job_tracking',
              itemIdentifier: crew.jobNumber,
              row: jtRow._rowIdx || (jtTable.rows.indexOf(jtRow) + 2),
              updatedFields: updated
            });
          }

          // Clean up any other duplicate rows in job_tracking matching crew.jobNumber (descending _rowIdx, without pre-splicing)
          await this.cleanupDuplicateJobTrackingRows(jtTable, jtRow, crew.jobNumber);
        } else if (jtTable) {
          // New crew created in Crew Planning not yet in Job Tracking: Add it to Job Tracking!
          const newJtRow = {
            'Job Number': crew.jobNumber,
            'Job Name': crew._clearedJobName ? '' : (crew.jobName || crew.jobNumber),
            'Location': crew.location || 'Helena',
            'Foreman': crew.foreman || '',
            'Crew Type': this.detectCrewType(crew.jobNumber, crew.jobName, crew.location, crew.crewType),
            [schedCol]: crew.schedule || 'Mon-Thu (4 10s)',
            'Status': crew.status || 'Active',
            'Skip Sun': crewSkips.isSkipSun !== undefined ? Boolean(crewSkips.isSkipSun) : true,
            'Skip Mon': crewSkips.isSkipMon !== undefined ? Boolean(crewSkips.isSkipMon) : false,
            'Skip Tue': crewSkips.isSkipTue !== undefined ? Boolean(crewSkips.isSkipTue) : false,
            'Skip Wed': crewSkips.isSkipWed !== undefined ? Boolean(crewSkips.isSkipWed) : false,
            'Skip Thu': crewSkips.isSkipThu !== undefined ? Boolean(crewSkips.isSkipThu) : false,
            'Skip Fri': crewSkips.isSkipFri !== undefined ? Boolean(crewSkips.isSkipFri) : true,
            'Skip Sat': crewSkips.isSkipSat !== undefined ? Boolean(crewSkips.isSkipSat) : true,
            'Skip Weekly Meeting': crew.skipMtg !== undefined ? Boolean(crew.skipMtg) : false,
            'Skip Monthly Checklist': crew.skipChk !== undefined ? Boolean(crew.skipChk) : false,
            'Notes': String(crew.notes || '').trim()
          };
          if (hasCrewSizeCol) newJtRow['Crew Size'] = (crew.members || []).length;
          await this.db.addMutation({
            action: 'ADD_ROW',
            sheetName: jtTable.name || 'Job Tracking',
            tableKey: 'job_tracking',
            itemIdentifier: crew.jobNumber,
            rowData: newJtRow
          });
        }
      }

      // 5. Equipment Transfer for Foremen
      if (transferEquipment && deltas.foremenChanges.length > 0 && window.crewImportEngine && typeof window.crewImportEngine.reassignCrewEquipment === 'function') {
        for (const f of deltas.foremenChanges) {
          if (f.oldForeman && f.newForeman && f.oldForeman !== 'None') {
            await window.crewImportEngine.reassignCrewEquipment(f.oldForeman, f.newForeman, f.jobNumber, todayFormatted);
          }
        }
      }

      // 6. Persist confirmed yellow moved employee names onto live crew cards for this published week
      if (!this.db.snapshot.configs) this.db.snapshot.configs = {};
      if (!this.db.snapshot.configs.confirmed_yellow_moves) this.db.snapshot.configs.confirmed_yellow_moves = {};
      this.db.snapshot.configs.confirmed_yellow_moves[publishWeek] = yellowConfirmedMoves;
      this.db.snapshot.configs.latest_published_yellow_moves = yellowConfirmedMoves;
      this.db.snapshot.configs.latest_published_yellow_week = publishWeek;

      // 7. Archive published plan to crew_roster_history under the selected target publish week
      const liveNotesMapForArchive = this.buildLiveEmployeeNotesMap();
      const archivedEmployeeNotes = {};
      (plan.crews || []).forEach(c => {
        (c.members || []).forEach(m => {
          const normKey = String(m.name || '').trim().toLowerCase();
          if (!normKey) return;
          const resolved = this.getEmployeeNote(m.name, plan, m, liveNotesMapForArchive);
          if (resolved) archivedEmployeeNotes[normKey] = { text: resolved };
        });
      });
      Object.values(plan.sidePane || {}).forEach(arr => {
        if (!Array.isArray(arr)) return;
        arr.forEach(it => {
          const normKey = String(it?.name || '').trim().toLowerCase();
          if (!normKey) return;
          const resolved = this.getEmployeeNote(it.name, plan, it, liveNotesMapForArchive);
          if (resolved) archivedEmployeeNotes[normKey] = { text: resolved };
        });
      });
      this.archiveSnapshot(publishWeek, {
        publishedAt: new Date().toISOString(),
        publishedBy: 'Crew Structure Planning',
        crews: plan.crews,
        sidePane: plan.sidePane,
        employeeNotes: archivedEmployeeNotes,
        yellowConfirmedMoves: yellowConfirmedMoves
      });

      const sourceWeek = plan.weekDate;
      const publishedPlanCopy = JSON.parse(JSON.stringify(plan));
      publishedPlanCopy.weekDate = publishWeek;
      publishedPlanCopy.weekDateFormatted = publishWeek;
      publishedPlanCopy.status = 'published';
      if (Array.isArray(publishedPlanCopy.crews)) {
        const jtRowsAfterPublish = jtTable?.rows || null;
        publishedPlanCopy.crews = publishedPlanCopy.crews.filter(c => !this.isCompletedCrewHidden(c, jtRowsAfterPublish));
      }
      this.savePlan(publishedPlanCopy);

      // If the user edited on a future week (e.g. 11/15/2026) and published to Current Week (e.g. 11/08/2026),
      // re-sync the future week draft from the newly updated live roster so it starts clean from the published baseline.
      // Also strip stale confirmations from any other draft weeks whose moves just went live.
      const allPlans = this.getPlansMap();
      if (sourceWeek && sourceWeek !== publishWeek) {
        const prevSourcePlan = allPlans[sourceWeek];
        const futureVacs = (prevSourcePlan?.sidePane?.vacation || []).filter(v => v && v.isFutureVacation);
        const reinitPlan = this.initializePlanFromCurrentRoster(sourceWeek);
        if (futureVacs.length > 0) {
          if (!reinitPlan.sidePane) reinitPlan.sidePane = {};
          if (!reinitPlan.sidePane.vacation) reinitPlan.sidePane.vacation = [];
          futureVacs.forEach(fv => {
            const fvNorm = String(fv.name || '').trim().toLowerCase();
            if (!reinitPlan.sidePane.vacation.some(v => String(v.name || '').trim().toLowerCase() === fvNorm)) {
              reinitPlan.sidePane.vacation.push(fv);
            }
          });
        }
        allPlans[sourceWeek] = reinitPlan;
      }
      Object.keys(allPlans).forEach(wk => {
        if (wk !== publishWeek && allPlans[wk] && allPlans[wk].status !== 'published') {
          this.cleanupStaleConfirmations(allPlans[wk]);
        }
      });
      this.savePlansMap(allPlans);
      if (typeof this.db.persistSnapshot === 'function') {
        await this.db.persistSnapshot(this.db.snapshot);
      }

      this.invalidateEmpLookupCache();
      this.selectedWeek = publishWeek;

      // Dismiss modal
      const m = document.getElementById(modalId);
      if (m) {
        if (m._onKey) window.removeEventListener('keydown', m._onKey);
        m.remove();
      }

      if (typeof window.showToast === 'function') {
        window.showToast(`✅ Week of ${publishWeek} published successfully! Yellow moved highlights carried over.`, 'success');
      }

      // 8. Automatically archive any employees whose last day has arrived to Previous Employees
      this._lastArchiveCheckAt = 0;
      await this.checkAndArchiveDepartedEmployees();
      this.purgeDepartedAcrossAllDraftPlans();

      // Return to live Crew Cards view on the newly published week
      if (window.sheetNavigator) {
        window.sheetNavigator.selectedEmployeeWeek = publishWeek;
        window.sheetNavigator.setEmployeeViewMode('cards');
        window.sheetNavigator.renderCurrentSheet();
      }
    } catch (err) {
      console.error('Error publishing crew structure:', err);
      alert(`Error publishing crew structure: ${err.message}`);
    }
  }

  /**
   * Applies an employee's quit/departure milestone to Employee History and Employees table.
   */
  async applyQuitDeparture(q, todayFormatted) {
    if (!this.db) return;
    if (typeof window !== 'undefined' && window.currentRoleMode === 'view_only') return;
    const empTable = this.db.getTable('employees');
    const histTable = this.db.getTable('employee_history');
    if (!empTable) return;

    const empName = q.name;
    const empNameLower = String(empName || '').trim().toLowerCase();
    const targetEmpRow = (empTable.rows || []).find(e => String(e['Employee Name'] || e['Name'] || '').trim().toLowerCase() === empNameLower);
    const actualRowIdx = targetEmpRow ? (targetEmpRow._rowIdx || (empTable.rows.indexOf(targetEmpRow) + 2)) : 0;
    const priorLoc = (targetEmpRow && targetEmpRow['Location'] && !targetEmpRow['Location'].toLowerCase().includes('previous')) 
      ? targetEmpRow['Location'] : 'Helena';
    const priorJob = (targetEmpRow && targetEmpRow['Job Number']) || 'N/A';
    const hireDate = (targetEmpRow && targetEmpRow['Hire Date']) || '';
    const depDate = q.departureDate || todayFormatted;
    const depReason = q.reason || 'Quit';

    // Parse date (both MM/DD/YYYY and YYYY-MM-DD) to check if already arrived or future
    const now = new Date();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    let isAlreadyDeparted = true;
    const dObj = this.parseFlexibleDate(depDate);
    if (dObj && dObj.getTime() > todayEnd.getTime()) {
      isAlreadyDeparted = false;
    }

    // 1. Employee History record
    const eventType = (depReason === 'Quit' || depReason === 'Resigned') ? 'Quit' : 'Terminated';
    const histNotes = `Departed (${depReason}) · Prior Location: ${priorLoc}, Prior Crew: ${priorJob}.${q.notes ? ' ' + q.notes : ''}`.trim();
    const histRow = {
      'Date': depDate,
      'Employee Name': empName,
      'Name': empName,
      'Event Type': isAlreadyDeparted ? eventType : 'Scheduled Departure',
      'Location': isAlreadyDeparted ? 'Previous Employee' : priorLoc,
      'Job Number': isAlreadyDeparted ? '' : priorJob,
      'Hire Date': hireDate,
      'Last Day': depDate,
      'Last Day Reason': depReason,
      'Rehire Date': '',
      'Notes': isAlreadyDeparted ? histNotes : `Scheduled Departure: Last Day ${depDate} (${depReason}). Active on crew ${priorJob} until last day.${q.notes ? ' ' + q.notes : ''}`,
      'Phone Number': targetEmpRow ? (targetEmpRow['Phone Number'] || '') : '',
      'Email Address': targetEmpRow ? (targetEmpRow['Email Address'] || '') : '',
      'Glove Size': targetEmpRow ? (targetEmpRow['Glove Size'] || '') : '',
      'Sleeve Size': targetEmpRow ? (targetEmpRow['Sleeve Size'] || '') : ''
    };

    if (histTable) {
      await this.db.addMutation({
        action: 'ADD_ROW',
        sheetName: histTable.name || 'Employee History',
        tableKey: 'employee_history',
        itemIdentifier: empName,
        rowData: histRow
      });
    }

    // 2. Employees table update
    if (targetEmpRow) {
      const secCol = (empTable.headers && empTable.headers.includes('Secondary Job #') && !empTable.headers.includes('Secondary Job Number'))
        ? 'Secondary Job #'
        : 'Secondary Job Number';
      const updatedFields = {
        'Last Day': depDate,
        'Last Day Reason': depReason
      };
      targetEmpRow['Last Day'] = depDate;
      targetEmpRow['Last Day Reason'] = depReason;

      if (isAlreadyDeparted) {
        targetEmpRow['Location'] = 'Previous Employee';
        targetEmpRow['Status'] = 'Previous Employee';
        targetEmpRow['Job Number'] = '';
        targetEmpRow[secCol] = '';
        updatedFields['Location'] = 'Previous Employee';
        updatedFields['Status'] = 'Previous Employee';
        updatedFields['Job Number'] = '';
        updatedFields[secCol] = '';
      } else {
        const curNote = String(targetEmpRow['Notes'] || '').trim();
        const schedNote = `Scheduled Last Day: ${depDate} (${depReason})`;
        if (!curNote.includes('Scheduled Last Day')) {
          targetEmpRow['Notes'] = curNote ? `${curNote} | ${schedNote}` : schedNote;
          updatedFields['Notes'] = targetEmpRow['Notes'];
        }
      }

      if (empTable.rawGrid && actualRowIdx > 0 && empTable.rawGrid[actualRowIdx - 1]) {
        const gRow = empTable.rawGrid[actualRowIdx - 1];
        const headers = empTable.headers || [];
        const locIdx = headers.findIndex(h => h.toLowerCase() === 'location');
        const statIdx = headers.findIndex(h => h.toLowerCase() === 'status');
        const ldIdx = headers.findIndex(h => h.toLowerCase() === 'last day');
        const ldrIdx = headers.findIndex(h => h.toLowerCase() === 'last day reason');
        const jobIdx = headers.findIndex(h => h.toLowerCase() === 'job number' || h.toLowerCase() === 'job #');
        const secIdx = headers.findIndex(h => h.toLowerCase() === secCol.toLowerCase());
        const notesIdx = headers.findIndex(h => h.toLowerCase() === 'notes');

        if (isAlreadyDeparted) {
          if (locIdx !== -1) gRow[locIdx] = 'Previous Employee';
          if (statIdx !== -1) gRow[statIdx] = 'Previous Employee';
          if (jobIdx !== -1) gRow[jobIdx] = '';
          if (secIdx !== -1) gRow[secIdx] = '';
        } else if (notesIdx !== -1 && updatedFields['Notes'] !== undefined) {
          gRow[notesIdx] = updatedFields['Notes'];
        }
        if (ldIdx !== -1) gRow[ldIdx] = depDate;
        if (ldrIdx !== -1) gRow[ldrIdx] = depReason;
      }

      await this.db.addMutation({
        action: 'UPDATE_ROW',
        sheetName: empTable.name || 'Employees',
        tableKey: 'employees',
        employeeName: empName,
        row: actualRowIdx,
        itemIdentifier: empName,
        updatedFields: updatedFields
      });
      this.invalidateEmpLookupCache();
    }
  }

  /**
   * Automatically scans active employees whose Last Day date has arrived or passed,
   * moves them to 'Previous Employee', and logs the departure milestone in Employee History.
   */
  async checkAndArchiveDepartedEmployees() {
    if (!this.db || this._archivingInFlight) return;
    if (typeof window !== 'undefined' && window.currentRoleMode === 'view_only') return;
    const empTable = this.db.getTable('employees');
    const histTable = this.db.getTable('employee_history');
    if (!empTable || !empTable.rows) return;

    this._lastArchiveCheckAt = Date.now();
    this._archivingInFlight = true;
    try {
      // Collect passed departure dates ONLY from PUBLISHED plans (never mutate live rows from unpublished drafts)
      const planDepartures = new Map();
      const allPlans = this.getPlansMap();
      Object.values(allPlans).forEach(p => {
        if (!p || p.status !== 'published') return;
        (p.sidePane?.quit || []).forEach(q => {
          const qName = String(q?.name || '').trim().toLowerCase();
          if (qName && q.departureDate && this.isDateStrictlyBeforeToday(q.departureDate)) {
            planDepartures.set(qName, { date: q.departureDate, reason: q.departureReason || 'Quit' });
          }
        });
        (p.crews || []).forEach(c => {
          (c.members || []).forEach(m => {
            const mName = String(m?.name || '').trim().toLowerCase();
            if (mName && m.departureDate && this.isDateStrictlyBeforeToday(m.departureDate)) {
              planDepartures.set(mName, { date: m.departureDate, reason: m.departureReason || 'Quit' });
            }
          });
        });
      });

      const secCol = (empTable.headers && empTable.headers.includes('Secondary Job #') && !empTable.headers.includes('Secondary Job Number'))
        ? 'Secondary Job #'
        : 'Secondary Job Number';
      const now = new Date();
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      let archivedCount = 0;

      for (let i = 0; i < empTable.rows.length; i++) {
        const row = empTable.rows[i];
        const eName = String(row['Employee Name'] || row['Name'] || '').trim();
        const loc = String(row['Location'] || '').trim().toLowerCase();
        const stat = String(row['Status'] || '').trim().toLowerCase();
        const planDep = planDepartures.get(eName.toLowerCase());
        const lastDayStr = String(row['Last Day'] || planDep?.date || '').trim();

        // If already Previous Employee, skip
        if (loc === 'previous employee' || loc.includes('previous') || stat === 'previous employee' || stat.includes('previous')) continue;

        if (lastDayStr) {
          const lastDayDate = this.parseFlexibleDate(lastDayStr);
          const rehireDt = this.parseFlexibleDate(row['Rehire Date'] || row['Hire Date']);
          const wasRehiredLater = Boolean(rehireDt && lastDayDate && rehireDt.getTime() > lastDayDate.getTime());

          // Has the employee's last day arrived or passed?
          if (!wasRehiredLater && lastDayDate && lastDayDate.getTime() <= todayEnd.getTime()) {
            const priorLoc = row['Location'] || 'Helena';
            const priorJob = row['Job Number'] || 'N/A';
            const reason = row['Last Day Reason'] || planDep?.reason || 'Quit';

            row['Location'] = 'Previous Employee';
            row['Status'] = 'Previous Employee';
            row['Job Number'] = '';
            row[secCol] = '';
            row['Last Day'] = lastDayStr;
            row['Last Day Reason'] = reason;

            const actualRowIdx = row._rowIdx || (i + 2);
            if (empTable.rawGrid && empTable.rawGrid[actualRowIdx - 1]) {
              const gRow = empTable.rawGrid[actualRowIdx - 1];
              const headers = empTable.headers || [];
              const locIdx = headers.findIndex(h => h.toLowerCase() === 'location');
              const statIdx = headers.findIndex(h => h.toLowerCase() === 'status');
              const jobIdx = headers.findIndex(h => h.toLowerCase() === 'job number' || h.toLowerCase() === 'job #');
              const secIdx = headers.findIndex(h => h.toLowerCase() === secCol.toLowerCase());
              const ldIdx = headers.findIndex(h => h.toLowerCase() === 'last day');
              const ldrIdx = headers.findIndex(h => h.toLowerCase() === 'last day reason');
              if (locIdx !== -1) gRow[locIdx] = 'Previous Employee';
              if (statIdx !== -1) gRow[statIdx] = 'Previous Employee';
              if (jobIdx !== -1) gRow[jobIdx] = '';
              if (secIdx !== -1) gRow[secIdx] = '';
              if (ldIdx !== -1) gRow[ldIdx] = lastDayStr;
              if (ldrIdx !== -1) gRow[ldrIdx] = reason;
            }

            await this.db.addMutation({
              action: 'UPDATE_ROW',
              sheetName: empTable.name || 'Employees',
              tableKey: 'employees',
              employeeName: eName,
              row: actualRowIdx,
              itemIdentifier: eName,
              updatedFields: {
                'Location': 'Previous Employee',
                'Status': 'Previous Employee',
                'Job Number': '',
                [secCol]: '',
                'Last Day': lastDayStr,
                'Last Day Reason': reason
              }
            });

            // Check if milestone for this departure / employment stint is already logged in history
            const alreadyLogged = (histTable?.rows || []).some(h => {
              const hName = String(h['Employee Name'] || h['Name'] || '').trim().toLowerCase();
              const hEv = String(h['Event Type'] || '').toLowerCase();
              if (hName !== eName.toLowerCase() || (!hEv.includes('quit') && !hEv.includes('terminat'))) return false;
              const hLastDay = String(h['Last Day'] || h['Date'] || '').trim();
              if (hLastDay && hLastDay === lastDayStr) return true;
              if (rehireDt) {
                const hDt = this.parseFlexibleDate(hLastDay);
                return Boolean(hDt && hDt.getTime() >= rehireDt.getTime());
              }
              return true;
            });

            if (!alreadyLogged && histTable) {
              const histRow = {
                'Date': lastDayStr,
                'Employee Name': eName,
                'Name': eName,
                'Event Type': (reason === 'Quit' || reason === 'Resigned') ? 'Quit' : 'Termination',
                'Location': 'Previous Employee',
                'Job Number': '',
                'Last Day': lastDayStr,
                'Last Day Reason': reason,
                'Notes': `Departed (${reason}) · Prior Location: ${priorLoc}, Prior Crew: ${priorJob}. Automatically moved to Previous Employees on last day.`
              };
              await this.db.addMutation({
                action: 'ADD_ROW',
                sheetName: histTable.name || 'Employee History',
                tableKey: 'employee_history',
                itemIdentifier: eName,
                rowData: histRow
              });
            }

            archivedCount++;
          }
        }
      }

      if (archivedCount > 0) {
        this.invalidateEmpLookupCache();
        this.purgeDepartedAcrossAllDraftPlans();
        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
          window.showToast(`🚪 Automatically transitioned ${archivedCount} employee(s) whose last day arrived to Previous Employees.`, 'info');
        }
        if (typeof window !== 'undefined' && window.sheetNavigator?.currentSheetKey === 'employees' && window.sheetNavigator?.employeeViewMode === 'planning') {
          this.refreshView();
        }
      }
    } finally {
      this._archivingInFlight = false;
    }
  }

  // ==========================================================================
  // Member Actions & Prompts
  // ==========================================================================

  toggleSidebar() {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
    try {
      localStorage.setItem('safety_assistant_planning_sidebar_collapsed', String(this.isSidebarCollapsed));
    } catch { /* ignore */ }
    this.refreshView();
  }

  refreshView() {
    const container = document.getElementById('sheet-grid-container');
    const countBadge = document.getElementById('sheet-row-count');
    const isPlanningVisible = Boolean(container && container.querySelector('.crew-planning-wrapper'));
    if (window.sheetNavigator && (window.sheetNavigator.currentSheetKey === 'employees' || isPlanningVisible)) {
      window.sheetNavigator.currentSheetKey = 'employees';
      window.sheetNavigator.activeSheetTabKey = 'employees';
      if (this.selectedWeek && isPlanningVisible) {
        window.sheetNavigator.selectedEmployeeWeek = this.selectedWeek;
      }
      window.sheetNavigator.renderCurrentSheet();
      return;
    }
    if (isPlanningVisible && container) {
      this.renderPlanningWorkspace(container, countBadge, this.selectedWeek, this.searchTerm);
    }
  }

  cloneFromCurrentRoster() {
    if (!confirm(`Are you sure you want to re-clone the live active roster into this planned week (${this.selectedWeek})? Any unsaved staging changes for this week will be reset.`)) {
      return;
    }
    const plans = this.getPlansMap();
    plans[this.selectedWeek] = this.initializePlanFromCurrentRoster(this.selectedWeek);
    this.savePlansMap(plans);
    if (typeof window.showToast === 'function') {
      window.showToast(`Week of ${this.selectedWeek} reset from live roster.`, 'info');
    }
    this.refreshView();
  }

  promptAddNewPlannedCrew() {
    this.openAddCrewModal();
  }

  openAddCrewModal() {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const modalId = 'modal-crew-add-new';
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.8) !important;
      z-index: 15000 !important; display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(5px); padding: 18px; pointer-events: auto !important;
    `;

    // Fetch existing Job Tracking rows to allow quick-picking unassigned/pending jobs
    const jtTable = this.db ? this.db.getTable('job_tracking') : null;
    const jtRows = (jtTable && jtTable.rows) || [];
    const plannedJobNumbers = new Set((plan.crews || []).map(c => c.jobNumber.toLowerCase()));

    // Available jobs in Job Tracking that aren't Completed/Closed and aren't on the planning board yet
    const availableJtJobs = jtRows.filter(j => {
      const jn = String(j['Job Number'] || j['Job #'] || '').trim();
      const baseJob = jn.replace(/\.\d+.*$/, '').trim();
      if (!baseJob || baseJob.toLowerCase() === 'unassigned') return false;
      if (this.isCompletedStatus(j['Status'])) return false;
      return !plannedJobNumbers.has(baseJob.toLowerCase());
    });

    // Available floaters from planning pool
    const floaters = ((plan.sidePane && plan.sidePane.planning) || []).filter(item => {
      return item.name && !this.isNonEmployeeName(item.name);
    });

    // Schedule day flags state
    let isMon = true;
    let isTue = true;
    let isWed = true;
    let isThu = true;
    let isFri = false;
    let isSat = false;
    let isSun = false;
    let activePreset = 'Mon-Thu (4 10s)';

    // Unique standard locations
    const standardLocs = ['Helena', 'Bozeman', 'Belgrade', 'Livingston', 'Great Falls', 'Missoula', 'Ennis', 'Big Sky', 'Lincoln', 'Townsend', 'Whitehall', 'Butte'];
    const existingCrewLocs = Array.from(new Set(
      (plan.crews || []).map(c => String(c.location || '').trim()).filter(Boolean)
    ));
    const allLocations = Array.from(new Set([...standardLocs, ...existingCrewLocs])).sort();

    const presets = [
      { id: '4 10s', label: 'Mon-Thu (4 10s)', days: [true, true, true, true, false, false, false] },
      { id: '5 8s', label: 'Mon-Fri (5 8s)', days: [true, true, true, true, true, false, false] },
      { id: '5 10s', label: 'Mon-Fri (5 10s)', days: [true, true, true, true, true, false, false] },
      { id: '6 10s', label: 'Mon-Sat (6 10s)', days: [true, true, true, true, true, true, false] },
      { id: 'Tue-Fri', label: 'Tue-Fri (4 10s)', days: [false, true, true, true, true, false, false] },
      { id: '7 10s', label: 'Mon-Sun (7 10s)', days: [true, true, true, true, true, true, true] },
      { id: 'Custom', label: 'Custom', days: null },
    ];

    const card = document.createElement('div');
    card.style.cssText = `
      background: #1e293b; border: 1px solid rgba(255,255,255,0.15); border-radius: 12px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6); width: 100%; max-width: 580px; max-height: 90vh;
      display: flex; flex-direction: column; overflow: hidden; color: #f8fafc;
    `;

    card.innerHTML = `
      <!-- Modal Header -->
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; background: rgba(255,255,255,0.03); border-bottom: 1px solid rgba(255,255,255,0.08);">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 22px;">🚜</span>
          <div>
            <div style="font-size: 15px; font-weight: 800; color: #93c5fd;">Add Planned Field Crew</div>
            <div style="font-size: 11.5px; color: #94a3b8;">Week of ${this.escapeHtml(this.selectedWeek)}</div>
          </div>
        </div>
        <button class="btn btn-xs" id="add-crew-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 4px 8px;">✕</button>
      </div>

      <!-- Modal Body -->
      <div style="flex: 1; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 14px;">

        ${availableJtJobs.length > 0 ? `
          <!-- Quick Template / Existing Job Tracking Source -->
          <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 8px; padding: 10px 12px;">
            <label style="display: block; font-size: 11px; font-weight: 700; color: #93c5fd; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
              ⚡ Quick-Select from Inactive / Pending Jobs:
            </label>
            <select id="add-crew-jt-preset" style="width: 100%; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 6px 10px; color: #fff; font-size: 12px; outline: none;">
              <option value="">➕ Create New Custom Crew (Manual Entry)</option>
              ${availableJtJobs.map(j => {
                const jn = String(j['Job Number'] || j['Job #'] || '').trim();
                const baseJob = jn.replace(/\.\d+.*$/, '').trim();
                const jName = String(j['Job Name'] || j['Location'] || '').trim();
                const stat = String(j['Status'] || 'Active').trim();
                const detectedType = this.detectCrewType(baseJob, jName, j['Location'], j['Crew Type']);
                return `<option value="${this.escapeHtml(baseJob)}" data-jobname="${this.escapeHtml(jName)}" data-loc="${this.escapeHtml(j['Location'] || 'Helena')}" data-type="${this.escapeHtml(detectedType)}" data-sched="${this.escapeHtml(j['Work Schedule'] || 'Mon-Thu (4 10s)')}" data-foreman="${this.escapeHtml(j['Foreman'] || '')}" data-notes="${this.escapeHtml(j['Notes'] || '')}" data-skipsun="${j['Skip Sun']}" data-skipmon="${j['Skip Mon']}" data-skiptue="${j['Skip Tue']}" data-skipwed="${j['Skip Wed']}" data-skipthu="${j['Skip Thu']}" data-skipfri="${j['Skip Fri']}" data-skipsat="${j['Skip Sat']}" data-skipmtg="${j['Skip Weekly Meeting']}" data-skipchk="${j['Skip Monthly Checklist']}">📋 ${this.escapeHtml(baseJob)} — ${this.escapeHtml(jName || 'Crew')} (${this.escapeHtml(stat)})</option>`;
              }).join('')}
            </select>
          </div>
        ` : ''}

        <!-- Job Number & Site Name Row -->
        <div style="display: grid; grid-template-columns: 140px 1fr; gap: 10px;">
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">
              Job Number <span style="color: #ef4444;">*</span>
            </label>
            <input type="text" id="add-crew-job-num" placeholder="e.g. 035-27"
                   style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #fff; font-size: 13px; font-weight: 700; font-family: monospace; outline: none;">
            <div id="add-crew-job-num-err" style="display: none; color: #f87171; font-size: 10px; margin-top: 3px; font-weight: 600;"></div>
          </div>
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">
              Job Name / Site Description
            </label>
            <input type="text" id="add-crew-job-name" placeholder="e.g. Lander's Fork (Lincoln), Belgrade Dock"
                   style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #fff; font-size: 12.5px; outline: none;">
          </div>
        </div>

        <!-- Location & Discipline Row -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">
              Location / City <span style="color: #ef4444;">*</span>
            </label>
            <input type="text" id="add-crew-location" list="add-crew-loc-list" value="Helena"
                   style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #fff; font-size: 12.5px; outline: none;">
            <datalist id="add-crew-loc-list">
              ${allLocations.map(loc => `<option value="${this.escapeHtml(loc)}"></option>`).join('')}
            </datalist>
          </div>
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">
              Discipline / Crew Type
            </label>
            <select id="add-crew-type" style="width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #fff; font-size: 12.5px; outline: none;">
              <option value="Electric" selected>⚡ Electric</option>
              <option value="Substation">🏗️ Substation</option>
              <option value="Gas">⛽ Gas</option>
              <option value="Office">🏢 Office</option>
              <option value="Mechanic">🔧 Mechanic</option>
              <option value="Civil">🚧 Civil</option>
              <option value="Telecom">📡 Telecom</option>
            </select>
          </div>
        </div>

        <!-- Foreman / Crew Lead -->
        <div>
          <label style="display: block; font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">
            Foreman / Crew Lead (Optional)
          </label>
          <div style="display: flex; gap: 8px;">
            <input type="text" id="add-crew-foreman" placeholder="Designate crew foreman (e.g. John Doe)"
                   list="add-crew-foreman-list"
                   style="flex: 1; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #fff; font-size: 12.5px; outline: none;">
            <datalist id="add-crew-foreman-list">
              ${floaters.map(f => `<option value="${this.escapeHtml(f.name)}">Floater: ${this.escapeHtml(f.name)}</option>`).join('')}
            </datalist>
          </div>
          <div style="font-size: 10.5px; color: #94a3b8; margin-top: 2px;">Leave blank if you prefer to assign foreman after adding crew members.</div>
        </div>

        <!-- Schedule Section -->
        <div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <label style="font-size: 11px; font-weight: 700; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px;">
              Work Schedule & Working Days
            </label>
            <span id="add-crew-sched-label" style="font-size: 11.5px; font-weight: 700; color: #60a5fa; font-family: monospace;">
              Mon-Thu (4 10s)
            </span>
          </div>

          <!-- Schedule Presets -->
          <div style="display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px;">
            ${presets.map(p => `
              <button type="button" class="add-crew-preset-btn" data-preset="${p.id}" data-days="${p.days ? p.days.join(',') : ''}"
                      style="font-size: 10.5px; font-weight: 600; padding: 3px 8px; border-radius: 4px; cursor: pointer; transition: all 0.15s ease;
                             ${p.id === '4 10s' ? 'background: rgba(59, 130, 246, 0.3); color: #93c5fd; border: 1px solid #3b82f6;' : 'background: rgba(255,255,255,0.05); color: #cbd5e1; border: 1px solid rgba(255,255,255,0.1);'}">
                ${p.label}
              </button>
            `).join('')}
          </div>

          <!-- 7 Clickable Day Pills -->
          <div style="display: flex; gap: 6px; justify-content: center; padding: 4px 0;">
            ${[
              { key: 'Mon', label: 'M', active: isMon },
              { key: 'Tue', label: 'T', active: isTue },
              { key: 'Wed', label: 'W', active: isWed },
              { key: 'Thu', label: 'Th', active: isThu },
              { key: 'Fri', label: 'F', active: isFri },
              { key: 'Sat', label: 'Sa', active: isSat },
              { key: 'Sun', label: 'Su', active: isSun },
            ].map(d => `
              <button type="button" class="add-crew-day-pill" data-day="${d.key}"
                      style="width: 38px; height: 32px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.15s ease; display: inline-flex; align-items: center; justify-content: center;
                             ${d.active ? 'background: #10b981; color: #fff; border: 1px solid #059669; box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);' : 'background: #334155; color: #64748b; border: 1px solid rgba(255,255,255,0.06);'}">
                ${d.label}
              </button>
            `).join('')}
          </div>
          <div style="font-size: 10px; color: #94a3b8; text-align: center; margin-top: 6px;">
            Click any day to toggle Working (Green) or Off (Gray).
          </div>
        </div>

        <!-- Compliance Checkboxes -->
        <div style="display: flex; gap: 16px; padding: 4px 2px;">
          <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: #cbd5e1; cursor: pointer;">
            <input type="checkbox" id="add-crew-skip-mtg" style="accent-color: #3b82f6;">
            Skip Weekly Safety Meeting
          </label>
          <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: #cbd5e1; cursor: pointer;">
            <input type="checkbox" id="add-crew-skip-chk" style="accent-color: #3b82f6;">
            Skip Monthly Checklist
          </label>
        </div>

        <!-- Crew Notes (Optional) -->
        <div>
          <label style="display: block; font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">
            📝 Crew Notes (Optional)
          </label>
          <textarea id="add-crew-notes" rows="2" placeholder="Optional crew notes (equipment needs, site details, rotation reminders)..."
                    style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #fff; font-size: 12px; line-height: 1.4; resize: vertical; outline: none; font-family: inherit;"></textarea>
        </div>

        <!-- Optional: Seed with Floaters from Planning Pool -->
        ${floaters.length > 0 ? `
          <div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px;">
            <div style="font-size: 11px; font-weight: 700; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">
              Assign Initial Members from Planning Pool (${floaters.length} available):
            </div>
            <div style="max-height: 110px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
              ${floaters.map(f => `
                <label style="display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; padding: 4px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; cursor: pointer;">
                  <span style="display: flex; align-items: center; gap: 6px;">
                    <input type="checkbox" class="add-crew-floater-check" data-emp-name="${this.escapeHtml(f.name)}" style="accent-color: #3b82f6;">
                    <span style="font-weight: 600;">${this.escapeHtml(f.name)}</span>
                  </span>
                  <span style="color: #94a3b8; font-size: 10px;">${this.escapeHtml(f.currentJob || f.classification || '')}</span>
                </label>
              `).join('')}
            </div>
          </div>
        ` : ''}

      </div>

      <!-- Modal Footer -->
      <div style="display: flex; justify-content: flex-end; align-items: center; gap: 10px; padding: 12px 18px; background: rgba(0,0,0,0.25); border-top: 1px solid rgba(255,255,255,0.08);">
        <button class="btn btn-secondary" id="add-crew-cancel-btn" style="padding: 7px 14px; font-size: 12px; font-weight: 600;">
          Cancel
        </button>
        <button class="btn btn-primary" id="add-crew-submit-btn" style="padding: 7px 18px; font-size: 12px; font-weight: 800; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border: none; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4); cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
          <span>➕</span> Create Crew
        </button>
      </div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Interactive event bindings
    const closeBtn = card.querySelector('#add-crew-close-btn');
    const cancelBtn = card.querySelector('#add-crew-cancel-btn');
    const submitBtn = card.querySelector('#add-crew-submit-btn');
    const jobNumInput = card.querySelector('#add-crew-job-num');
    const jobNumErr = card.querySelector('#add-crew-job-num-err');
    const jobNameInput = card.querySelector('#add-crew-job-name');
    const locInput = card.querySelector('#add-crew-location');
    const typeSelect = card.querySelector('#add-crew-type');
    const foremanInput = card.querySelector('#add-crew-foreman');
    const schedLabel = card.querySelector('#add-crew-sched-label');
    const skipMtgCheck = card.querySelector('#add-crew-skip-mtg');
    const skipChkCheck = card.querySelector('#add-crew-skip-chk');
    const notesInput = card.querySelector('#add-crew-notes');
    const jtSelect = card.querySelector('#add-crew-jt-preset');

    const onKey = (e) => {
      if (e.key === 'Escape') closeModal();
    };
    const closeModal = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    window.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    const presetBtns = card.querySelectorAll('.add-crew-preset-btn');
    const highlightPresetBtn = (presetId) => {
      presetBtns.forEach(b => {
        const isActive = b.getAttribute('data-preset') === presetId;
        b.style.background = isActive ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255,255,255,0.05)';
        b.style.color = isActive ? '#93c5fd' : '#cbd5e1';
        b.style.borderColor = isActive ? '#3b82f6' : 'rgba(255,255,255,0.1)';
      });
    };

    // Helper: update schedule string & preset pill highlight based on selected days
    const updateScheduleDisplay = () => {
      const resolved = this.resolveScheduleFromDays(
        { isMon, isTue, isWed, isThu, isFri, isSat, isSun },
        activePreset
      );
      activePreset = resolved.scheduleLabel;
      highlightPresetBtn(resolved.presetId);
      if (schedLabel) schedLabel.textContent = activePreset;
    };

    // Day button toggles
    const dayPills = card.querySelectorAll('.add-crew-day-pill');
    dayPills.forEach(btn => {
      btn.addEventListener('click', () => {
        const d = btn.getAttribute('data-day');
        let current = false;
        if (d === 'Mon') { isMon = !isMon; current = isMon; }
        else if (d === 'Tue') { isTue = !isTue; current = isTue; }
        else if (d === 'Wed') { isWed = !isWed; current = isWed; }
        else if (d === 'Thu') { isThu = !isThu; current = isThu; }
        else if (d === 'Fri') { isFri = !isFri; current = isFri; }
        else if (d === 'Sat') { isSat = !isSat; current = isSat; }
        else if (d === 'Sun') { isSun = !isSun; current = isSun; }

        btn.style.background = current ? '#10b981' : '#334155';
        btn.style.color = current ? '#fff' : '#64748b';
        btn.style.borderColor = current ? '#059669' : 'rgba(255,255,255,0.06)';
        btn.style.boxShadow = current ? '0 0 8px rgba(16, 185, 129, 0.4)' : 'none';

        updateScheduleDisplay();
      });
    });

    // Preset button handlers
    presetBtns.forEach(pbtn => {
      pbtn.addEventListener('click', () => {
        const rawDays = pbtn.getAttribute('data-days');
        if (!rawDays) {
          updateScheduleDisplay();
          return;
        }
        const days = rawDays.split(',').map(v => v === 'true');
        isMon = days[0]; isTue = days[1]; isWed = days[2]; isThu = days[3];
        isFri = days[4]; isSat = days[5]; isSun = days[6];
        activePreset = pbtn.textContent.trim();

        highlightPresetBtn(pbtn.getAttribute('data-preset'));

        dayPills.forEach(pill => {
          const d = pill.getAttribute('data-day');
          let act = false;
          if (d === 'Mon') act = isMon;
          else if (d === 'Tue') act = isTue;
          else if (d === 'Wed') act = isWed;
          else if (d === 'Thu') act = isThu;
          else if (d === 'Fri') act = isFri;
          else if (d === 'Sat') act = isSat;
          else if (d === 'Sun') act = isSun;

          pill.style.background = act ? '#10b981' : '#334155';
          pill.style.color = act ? '#fff' : '#64748b';
          pill.style.borderColor = act ? '#059669' : 'rgba(255,255,255,0.06)';
          pill.style.boxShadow = act ? '0 0 8px rgba(16, 185, 129, 0.4)' : 'none';
        });

        if (schedLabel) schedLabel.textContent = activePreset;
      });
    });

    // Job Tracking template selector
    if (jtSelect) {
      const parseAttrBool = (attrVal, fallback) => {
        if (attrVal === null || attrVal === undefined || attrVal === '' || attrVal === 'undefined' || attrVal === 'null') {
          return fallback;
        }
        return String(attrVal).trim().toLowerCase() === 'true';
      };
      const syncDayPillsUI = () => {
        dayPills.forEach(pill => {
          const d = pill.getAttribute('data-day');
          let act = false;
          if (d === 'Mon') act = isMon;
          else if (d === 'Tue') act = isTue;
          else if (d === 'Wed') act = isWed;
          else if (d === 'Thu') act = isThu;
          else if (d === 'Fri') act = isFri;
          else if (d === 'Sat') act = isSat;
          else if (d === 'Sun') act = isSun;

          pill.style.background = act ? '#10b981' : '#334155';
          pill.style.color = act ? '#fff' : '#64748b';
          pill.style.borderColor = act ? '#059669' : 'rgba(255,255,255,0.06)';
          pill.style.boxShadow = act ? '0 0 8px rgba(16, 185, 129, 0.4)' : 'none';
        });
      };

      jtSelect.addEventListener('change', () => {
        const opt = jtSelect.selectedOptions[0];
        if (!opt || !opt.value) {
          jobNumInput.value = '';
          jobNameInput.value = '';
          locInput.value = 'Helena';
          typeSelect.value = 'Electric';
          foremanInput.value = '';
          if (notesInput) notesInput.value = '';
          isMon = true; isTue = true; isWed = true; isThu = true;
          isFri = false; isSat = false; isSun = false;
          syncDayPillsUI();
          skipMtgCheck.checked = false;
          skipChkCheck.checked = false;
          activePreset = 'Mon-Thu (4 10s)';
          highlightPresetBtn('4 10s');
          if (schedLabel) schedLabel.textContent = activePreset;
          return;
        }

        jobNumInput.value = opt.value;
        jobNameInput.value = opt.getAttribute('data-jobname') || '';
        locInput.value = opt.getAttribute('data-loc') || 'Helena';
        const detectedType = opt.getAttribute('data-type') || this.detectCrewType(opt.value, jobNameInput.value, locInput.value, 'Electric');
        typeSelect.value = detectedType;
        foremanInput.value = opt.getAttribute('data-foreman') || '';
        if (notesInput) {
          notesInput.value = opt.getAttribute('data-notes') || '';
        }

        const skipSun = parseAttrBool(opt.getAttribute('data-skipsun'), true);
        const skipMon = parseAttrBool(opt.getAttribute('data-skipmon'), false);
        const skipTue = parseAttrBool(opt.getAttribute('data-skiptue'), false);
        const skipWed = parseAttrBool(opt.getAttribute('data-skipwed'), false);
        const skipThu = parseAttrBool(opt.getAttribute('data-skipthu'), false);
        const skipFri = parseAttrBool(opt.getAttribute('data-skipfri'), true);
        const skipSat = parseAttrBool(opt.getAttribute('data-skipsat'), true);

        isMon = !skipMon; isTue = !skipTue; isWed = !skipWed; isThu = !skipThu;
        isFri = !skipFri; isSat = !skipSat; isSun = !skipSun;
        syncDayPillsUI();

        skipMtgCheck.checked = parseAttrBool(opt.getAttribute('data-skipmtg'), false);
        skipChkCheck.checked = parseAttrBool(opt.getAttribute('data-skipchk'), false);

        const jobSched = opt.getAttribute('data-sched') || '';
        const resolved = this.resolveScheduleFromDays(
          { isMon, isTue, isWed, isThu, isFri, isSat, isSun },
          jobSched
        );
        activePreset = jobSched || resolved.scheduleLabel;
        highlightPresetBtn(resolved.presetId);
        if (schedLabel) schedLabel.textContent = activePreset;
      });
    }

    // Auto-detect discipline if user manually enters 005 or keywords while on default Electric
    const maybeAutoDetectDiscipline = () => {
      const jn = String(jobNumInput.value || '').trim();
      const jName = String(jobNameInput.value || '').trim();
      const loc = String(locInput.value || '').trim();
      if (typeSelect.value === 'Electric' || !typeSelect.value) {
        const detected = this.detectCrewType(jn, jName, loc, '');
        if (detected && detected !== 'Electric') {
          typeSelect.value = detected;
        }
      }
    };
    jobNumInput.addEventListener('input', maybeAutoDetectDiscipline);
    jobNameInput.addEventListener('input', maybeAutoDetectDiscipline);

    // Submit action
    submitBtn.addEventListener('click', () => {
      const cleanJob = String(jobNumInput.value || '').trim();
      if (!cleanJob) {
        jobNumErr.textContent = 'Please enter a Job Number.';
        jobNumErr.style.display = 'block';
        jobNumInput.focus();
        return;
      }

      if (plan.crews.some(c => c.jobNumber.toLowerCase() === cleanJob.toLowerCase())) {
        jobNumErr.textContent = `Crew ${cleanJob} already exists in this plan.`;
        jobNumErr.style.display = 'block';
        jobNumInput.focus();
        return;
      }
      jobNumErr.style.display = 'none';

      const cleanJobName = String(jobNameInput.value || '').trim();
      const cleanLoc = String(locInput.value || 'Helena').trim() || 'Helena';
      const cleanType = String(typeSelect.value || 'Electric').trim();
      const cleanForeman = String(foremanInput.value || '').trim();
      const cleanNotes = String(notesInput?.value || '').trim();

      // Check selected floaters from planning pool
      const checkedFloaters = [];
      const floaterBoxes = card.querySelectorAll('.add-crew-floater-check:checked');
      floaterBoxes.forEach(chk => {
        checkedFloaters.push(chk.getAttribute('data-emp-name'));
      });

      const initialMembers = [];
      if (checkedFloaters.length > 0 && plan.sidePane && plan.sidePane.planning) {
        checkedFloaters.forEach(empName => {
          const norm = empName.toLowerCase().trim();
          const fIdx = plan.sidePane.planning.findIndex(f => f.name.toLowerCase().trim() === norm);
          let fObj = null;
          if (fIdx !== -1) {
            fObj = plan.sidePane.planning.splice(fIdx, 1)[0];
          }
          this.clearMemberConfirmations(plan, empName, ['planning', cleanJob]);
          initialMembers.push({
            name: empName,
            slot: `${cleanJob}.${initialMembers.length + 1}`,
            originalSlot: fObj?.currentJob || fObj?.originalSlot || '',
            originalBaseJob: fObj?.originalBaseJob || (fObj?.currentJob ? String(fObj.currentJob).replace(/\.\d+.*$/, '').trim() : null),
            classification: fObj?.classification || 'Journeyman',
            role: fObj?.role || 'JL',
            location: cleanLoc,
            isConfirmed: false
          });
        });
      }

      // If foreman was specified and matches one of the initial members or an existing floater
      let designatedForeman = cleanForeman;
      if (!designatedForeman && initialMembers.length > 0) {
        designatedForeman = this.pickBestForeman(initialMembers);
      }

      const newCrew = {
        jobNumber: cleanJob,
        location: cleanLoc,
        foreman: designatedForeman,
        crewType: cleanType,
        schedule: activePreset,
        isSkipSun: !isSun,
        isSkipMon: !isMon,
        isSkipTue: !isTue,
        isSkipWed: !isWed,
        isSkipThu: !isThu,
        isSkipFri: !isFri,
        isSkipSat: !isSat,
        skipMtg: Boolean(skipMtgCheck.checked),
        skipChk: Boolean(skipChkCheck.checked),
        jobName: cleanJobName,
        notes: cleanNotes,
        members: initialMembers
      };

      plan.crews.push(newCrew);
      this.savePlan(plan);
      closeModal();
      this.refreshView();

      if (typeof window.showToast === 'function') {
        window.showToast(`🚜 Created Crew ${cleanJob} (${cleanJobName || cleanLoc})!`, 'success');
      }
    });

    jobNumInput.focus();
  }

  promptChangePlannedForeman(jobNumber) {
    this.openChangeForemanModal(jobNumber);
  }

  openChangeForemanModal(jobNumber) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    const crew = plan?.crews?.find(c => c.jobNumber === jobNumber);
    if (!crew) return;

    const modalId = 'modal-crew-change-foreman';
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.75) !important;
      z-index: 15000 !important; display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px); padding: 18px; pointer-events: auto !important;
    `;

    const floaters = ((plan.sidePane && plan.sidePane.planning) || []).filter(item => {
      return item.name && !this.isNonEmployeeName(item.name);
    });

    const lightDutyMembers = ((plan.sidePane && plan.sidePane.lightDuty) || []).filter(item => {
      return item.name && !this.isNonEmployeeName(item.name);
    });

    const card = document.createElement('div');
    card.style.cssText = `
      background: #1e293b; border: 1px solid rgba(255,255,255,0.15); border-radius: 12px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6); width: 100%; max-width: 480px; max-height: 85vh;
      display: flex; flex-direction: column; overflow: hidden; color: #f8fafc;
    `;

    card.innerHTML = `
      <!-- Header -->
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: rgba(255,255,255,0.03); border-bottom: 1px solid rgba(255,255,255,0.08);">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 20px;">👑</span>
          <div>
            <div style="font-size: 14px; font-weight: 800; color: #f472b6;">Designate Foreman for Crew ${this.escapeHtml(crew.jobNumber)}</div>
            <div style="font-size: 11px; color: #94a3b8;">${this.escapeHtml(crew.jobName || crew.location || '')}</div>
          </div>
        </div>
        <button class="btn btn-xs" id="change-fm-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer;">✕</button>
      </div>

      <!-- Body -->
      <div style="flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px;">
        <div style="font-size: 12px; color: #94a3b8;">
          Current Foreman: <strong style="color: #f472b6;">${this.escapeHtml(crew.foreman || 'None')}</strong>
        </div>

        <!-- Custom Input -->
        <div>
          <label style="display: block; font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">
            Type Foreman Name:
          </label>
          <div style="display: flex; gap: 8px;">
            <input type="text" id="change-fm-custom-input" placeholder="Enter employee name..." value="${this.escapeHtml(crew.foreman || '')}"
                   style="flex: 1; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 6px 10px; color: #fff; font-size: 12px; outline: none;">
            <button class="btn btn-primary" id="change-fm-custom-btn" style="padding: 6px 12px; font-size: 11.5px; font-weight: 700; background: #ec4899; border: none; cursor: pointer;">
              Set
            </button>
          </div>
        </div>

        <!-- Crew Members List -->
        ${(crew.members || []).length > 0 ? `
          <div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px;">
            <div style="font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">
              Current Crew Members:
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
              ${crew.members.map(m => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; font-size: 12px;">
                  <span style="font-weight: 600;">${this.escapeHtml(m.name)} <span style="font-size: 10px; color: #94a3b8;">(${this.escapeHtml(m.classification || '')})</span></span>
                  <button class="btn btn-xs change-fm-select-btn" data-name="${this.escapeHtml(m.name)}"
                          style="font-size: 10.5px; font-weight: 700; padding: 2px 8px; background: rgba(244, 114, 182, 0.2); color: #f472b6; border: 1px solid rgba(244, 114, 182, 0.4); border-radius: 4px; cursor: pointer;">
                    👑 Select
                  </button>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Floaters List -->
        ${floaters.length > 0 ? `
          <div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px;">
            <div style="font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">
              Or Select from Planning Pool:
            </div>
            <div style="max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
              ${floaters.map(f => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; font-size: 12px;">
                  <span style="font-weight: 600;">${this.escapeHtml(f.name)} <span style="font-size: 10px; color: #94a3b8;">(${this.escapeHtml(f.classification || 'Floater')})</span></span>
                  <button class="btn btn-xs change-fm-select-btn" data-name="${this.escapeHtml(f.name)}" data-from-pool="true"
                          style="font-size: 10.5px; font-weight: 700; padding: 2px 8px; background: rgba(96, 165, 250, 0.2); color: #93c5fd; border: 1px solid rgba(96, 165, 250, 0.4); border-radius: 4px; cursor: pointer;">
                    👑 Select
                  </button>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Light Duty Employees -->
        ${lightDutyMembers.length > 0 ? `
          <div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px;">
            <div style="font-size: 11px; font-weight: 700; color: #34d399; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">
              🩺 Select from Light Duty (Keeps on Light Duty):
            </div>
            <div style="max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
              ${lightDutyMembers.map(ld => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; font-size: 12px;">
                  <span style="font-weight: 600;">${this.escapeHtml(ld.name)} <span style="font-size: 10px; color: #94a3b8;">(${this.escapeHtml(ld.classification || 'Light Duty')})</span></span>
                  <button class="btn btn-xs change-fm-select-btn" data-name="${this.escapeHtml(ld.name)}" data-from-ld="true"
                          style="font-size: 10.5px; font-weight: 700; padding: 2px 8px; background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); border-radius: 4px; cursor: pointer;">
                    👑 Select & Assign
                  </button>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    const closeModal = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    window.addEventListener('keydown', onKey);
    card.querySelector('#change-fm-close-btn').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    const setForeman = (name, fromLd = false, fromPool = false) => {
      const cleanName = String(name || '').trim();
      if (!cleanName) {
        crew.foreman = '';
        this.savePlan(plan);
        closeModal();
        this.refreshView();
        return;
      }
      crew.foreman = cleanName;
      const norm = cleanName.toLowerCase();
      if (fromLd) {
        if (!crew.members.some(m => m.name.toLowerCase() === norm)) {
          closeModal();
          this.executeDuplicateMember(cleanName, '', `crew::${crew.jobNumber}`, 'lightDuty', true);
          return;
        }
      }
      // Move Planning Pool floater into the crew at slot .1 when selected (or typed)
      const poolList = plan.sidePane?.planning || [];
      const poolIdx = poolList.findIndex(f => String(f.name || '').trim().toLowerCase() === norm);
      if ((fromPool || poolIdx !== -1) && !crew.members.some(m => m.name.trim().toLowerCase() === norm)) {
        const [fObj] = poolIdx !== -1 ? poolList.splice(poolIdx, 1) : [null];
        this.clearMemberConfirmations(plan, cleanName, ['planning', crew.jobNumber]);
        crew.members.unshift({
          name: fObj?.name || cleanName,
          slot: `${crew.jobNumber}.1`,
          originalSlot: fObj?.originalSlot || fObj?.currentJob || '',
          originalBaseJob: fObj?.originalBaseJob || (fObj?.currentJob ? String(fObj.currentJob).replace(/\.\d+.*$/, '').trim() : null),
          classification: fObj?.classification || 'Foreman',
          role: fObj?.role || 'F',
          location: crew.location || fObj?.location || 'Helena',
          hireDate: fObj?.hireDate || '',
          notes: fObj?.notes || '',
          status: fObj?.status || '',
          isConfirmed: false
        });
        crew.members.forEach((m, idx) => {
          m.slot = `${crew.jobNumber}.${idx + 1}`;
        });
      }
      // Reorder designated foreman to index 0 (slot .1) if present in crew
      const fmIdx = crew.members.findIndex(m => m.name.trim().toLowerCase() === norm);
      if (fmIdx > 0) {
        const [fmObj] = crew.members.splice(fmIdx, 1);
        crew.members.unshift(fmObj);
        crew.members.forEach((m, idx) => {
          m.slot = `${crew.jobNumber}.${idx + 1}`;
        });
      }
      this.savePlan(plan);
      closeModal();
      this.refreshView();
      if (typeof window.showToast === 'function') {
        window.showToast(`👑 Crew ${crew.jobNumber} foreman designated as ${crew.foreman || 'None'}.`, 'success');
      }
    };

    card.querySelector('#change-fm-custom-btn').addEventListener('click', () => {
      const customVal = card.querySelector('#change-fm-custom-input').value;
      setForeman(customVal);
    });

    card.querySelectorAll('.change-fm-select-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fromLd = btn.getAttribute('data-from-ld') === 'true';
        const fromPool = btn.getAttribute('data-from-pool') === 'true';
        setForeman(btn.getAttribute('data-name'), fromLd, fromPool);
      });
    });
  }

  // ==========================================================================
  // Crew Schedule & Workdays Management
  // ==========================================================================

  /**
   * Derives preset identifier and canonical schedule label from 7 working-day flags.
   */
  resolveScheduleFromDays({ isMon, isTue, isWed, isThu, isFri, isSat, isSun }, currentLabel = '') {
    const activeDays = [];
    if (isMon) activeDays.push('Mon');
    if (isTue) activeDays.push('Tue');
    if (isWed) activeDays.push('Wed');
    if (isThu) activeDays.push('Thu');
    if (isFri) activeDays.push('Fri');
    if (isSat) activeDays.push('Sat');
    if (isSun) activeDays.push('Sun');

    const labelStr = String(currentLabel || '');
    const hoursMatch = labelStr.match(/(\d+)\s*(10s|8s|12s|9s)/i);
    const matchedDayCount = hoursMatch ? parseInt(hoursMatch[1], 10) : null;
    const validHours = (hoursMatch && matchedDayCount === activeDays.length)
      ? `${matchedDayCount} ${hoursMatch[2].toLowerCase()}`
      : null;

    if (isMon && isTue && isWed && isThu && !isFri && !isSat && !isSun) {
      const h = validHours || '4 10s';
      return { presetId: '4 10s', selectValue: 'Mon-Thu (4 10s)', scheduleLabel: `Mon-Thu (${h})`, activeDays };
    }
    if (isMon && isTue && isWed && isThu && isFri && !isSat && !isSun) {
      const isFiveTen = labelStr.toLowerCase().includes('5 10');
      const h = validHours || (isFiveTen ? '5 10s' : '5 8s');
      return {
        presetId: isFiveTen ? '5 10s' : '5 8s',
        selectValue: isFiveTen ? 'Mon-Fri (5 10s)' : 'Mon-Fri (5 8s)',
        scheduleLabel: `Mon-Fri (${h})`,
        activeDays
      };
    }
    if (isMon && isTue && isWed && isThu && isFri && isSat && !isSun) {
      const h = validHours || '6 10s';
      return { presetId: '6 10s', selectValue: 'Mon-Sat (6 10s)', scheduleLabel: `Mon-Sat (${h})`, activeDays };
    }
    if (isMon && isTue && isWed && isThu && isFri && isSat && isSun) {
      const h = validHours || '7 10s';
      return { presetId: '7 10s', selectValue: 'Mon-Sun (7 10s)', scheduleLabel: `Mon-Sun (${h})`, activeDays };
    }
    if (!isMon && isTue && isWed && isThu && isFri && !isSat && !isSun) {
      const h = validHours || '4 10s';
      return { presetId: 'Tue-Fri', selectValue: 'Tue-Fri (4 10s)', scheduleLabel: `Tue-Fri (${h})`, activeDays };
    }
    if (!isMon && !isTue && !isWed && !isThu && isFri && isSat && !isSun) {
      const h = validHours || '2 10s';
      return {
        presetId: 'Custom',
        selectValue: 'Fri-Sat Weekend (2 10s)',
        scheduleLabel: `Fri-Sat Weekend (${h})`,
        activeDays
      };
    }

    const daySuffix = validHours || `${activeDays.length} ${activeDays.length === 1 ? 'day' : 'days'}`;
    return {
      presetId: 'Custom',
      selectValue: 'Custom',
      scheduleLabel: activeDays.length > 0 ? `${activeDays.join('/')} (${daySuffix})` : 'Off',
      activeDays
    };
  }

  getCrewSkipDays(crew) {
    if (!crew) {
      return { isSkipMon: false, isSkipTue: false, isSkipWed: false, isSkipThu: false, isSkipFri: true, isSkipSat: true, isSkipSun: true };
    }
    // Infer defaults from schedule text for any skip flags not explicitly defined on crew
    const s = String(crew.schedule || '').toLowerCase();
    let inferred;
    if (s.includes('sat & sun') || s.includes('sat-sun')) {
      inferred = { isSkipMon: true, isSkipTue: true, isSkipWed: true, isSkipThu: true, isSkipFri: true, isSkipSat: false, isSkipSun: false };
    } else if (s.includes('fri-sat') || s.includes('fri & sat') || s.includes('weekend')) {
      inferred = { isSkipMon: true, isSkipTue: true, isSkipWed: true, isSkipThu: true, isSkipFri: false, isSkipSat: false, isSkipSun: true };
    } else if (s.includes('tue-fri')) {
      inferred = { isSkipMon: true, isSkipTue: false, isSkipWed: false, isSkipThu: false, isSkipFri: false, isSkipSat: true, isSkipSun: true };
    } else if (s.includes('6 10') || s.includes('mon-sat')) {
      inferred = { isSkipMon: false, isSkipTue: false, isSkipWed: false, isSkipThu: false, isSkipFri: false, isSkipSat: false, isSkipSun: true };
    } else if (s.includes('7 10') || s.includes('mon-sun') || s.includes('7 days')) {
      inferred = { isSkipMon: false, isSkipTue: false, isSkipWed: false, isSkipThu: false, isSkipFri: false, isSkipSat: false, isSkipSun: false };
    } else if (s.includes('5 8') || s.includes('5 10') || s.includes('mon-fri')) {
      inferred = { isSkipMon: false, isSkipTue: false, isSkipWed: false, isSkipThu: false, isSkipFri: false, isSkipSat: true, isSkipSun: true };
    } else {
      // Default Mon-Thu (4 10s)
      inferred = { isSkipMon: false, isSkipTue: false, isSkipWed: false, isSkipThu: false, isSkipFri: true, isSkipSat: true, isSkipSun: true };
    }

    return {
      isSkipMon: crew.isSkipMon !== undefined ? Boolean(crew.isSkipMon) : inferred.isSkipMon,
      isSkipTue: crew.isSkipTue !== undefined ? Boolean(crew.isSkipTue) : inferred.isSkipTue,
      isSkipWed: crew.isSkipWed !== undefined ? Boolean(crew.isSkipWed) : inferred.isSkipWed,
      isSkipThu: crew.isSkipThu !== undefined ? Boolean(crew.isSkipThu) : inferred.isSkipThu,
      isSkipFri: crew.isSkipFri !== undefined ? Boolean(crew.isSkipFri) : inferred.isSkipFri,
      isSkipSat: crew.isSkipSat !== undefined ? Boolean(crew.isSkipSat) : inferred.isSkipSat,
      isSkipSun: crew.isSkipSun !== undefined ? Boolean(crew.isSkipSun) : inferred.isSkipSun
    };
  }

  toggleCrewDayWorking(jobNumber, dayKey) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    const crew = plan?.crews?.find(c => c.jobNumber === jobNumber);
    if (!crew) return;

    const skipProp = 'isSkip' + dayKey;
    const currentSkips = this.getCrewSkipDays(crew);
    crew[skipProp] = !currentSkips[skipProp];

    // Ensure all 7 properties are explicitly set on the crew object
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    days.forEach(d => {
      const p = 'isSkip' + d;
      if (d === dayKey) {
        crew[p] = !currentSkips[p];
      } else if (crew[p] === undefined) {
        crew[p] = currentSkips[p];
      }
    });

    const resolved = this.resolveScheduleFromDays(
      {
        isMon: !crew.isSkipMon,
        isTue: !crew.isSkipTue,
        isWed: !crew.isSkipWed,
        isThu: !crew.isSkipThu,
        isFri: !crew.isSkipFri,
        isSat: !crew.isSkipSat,
        isSun: !crew.isSkipSun
      },
      crew.schedule || ''
    );
    crew.schedule = resolved.scheduleLabel;

    this.savePlan(plan);
    this.refreshView();
    if (typeof window.showToast === 'function') {
      const statusWord = !crew[skipProp] ? 'Working' : 'Off';
      window.showToast(`🕒 Crew ${jobNumber} ${dayKey}: ${statusWord} (${crew.schedule})`, 'info');
    }
  }

  promptEditPlannedCrew(jobNumber) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    const crew = plan?.crews?.find(c => c.jobNumber === jobNumber);
    if (!crew) return;

    const modalId = 'modal-crew-planned-edit';
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();

    // Look up existing Job Tracking row if present
    const jtTable = this.db ? this.db.getTable('job_tracking') : null;
    const jtRow = (jtTable?.rows || []).find(j => {
      const jn = String(j['Job Number'] || j['Job #'] || '').trim();
      return jn === jobNumber || jn.replace(/\.\d+.*$/, '').trim() === jobNumber;
    });

    const isCurrentWeek = this.selectedWeek === this.getCurrentWeekSundayStr();
    const currentJobName = crew._clearedJobName ? '' : (crew.jobName || (jtRow && jtRow['Job Name']) || '');
    const currentLocation = crew.location || (jtRow && jtRow['Location']) || 'Helena';
    const currentCrewType = (jtRow && jtRow['Crew Type']) || crew.crewType || 'Electric';
    const currentStatus = crew.status || (jtRow && jtRow['Status']) || 'Active';
    const currentForeman = crew.foreman !== undefined ? String(crew.foreman || '') : String((jtRow && jtRow['Foreman']) || '');
    const currentSchedule = crew.schedule || (jtRow && (jtRow['Work Schedule'] || jtRow['Schedule'])) || 'Mon-Thu (4 10s)';
    const currentNotes = crew.notes !== undefined ? String(crew.notes || '') : String((jtRow && jtRow['Notes']) || '');

    const sLower = currentSchedule.toLowerCase();
    let initialPreset = 'Custom';
    if (sLower.includes('mon-fri') && sLower.includes('5 10')) initialPreset = 'Mon-Fri (5 10s)';
    else if (sLower.includes('mon-fri')) initialPreset = 'Mon-Fri (5 8s)';
    else if (sLower.includes('6 10') || sLower.includes('mon-sat')) initialPreset = 'Mon-Sat (6 10s)';
    else if (sLower.includes('7 10') || sLower.includes('mon-sun')) initialPreset = 'Mon-Sun (7 10s)';
    else if (sLower.includes('tue-fri')) initialPreset = 'Tue-Fri (4 10s)';
    else if (sLower.includes('fri-sat') || sLower.includes('fri & sat') || sLower.includes('weekend')) initialPreset = 'Fri-Sat Weekend (2 10s)';
    else if (sLower.includes('mon-thu')) initialPreset = 'Mon-Thu (4 10s)';

    const skipDays = this.getCrewSkipDays(crew);
    let isMon = !skipDays.isSkipMon;
    let isTue = !skipDays.isSkipTue;
    let isWed = !skipDays.isSkipWed;
    let isThu = !skipDays.isSkipThu;
    let isFri = !skipDays.isSkipFri;
    let isSat = !skipDays.isSkipSat;
    let isSun = !skipDays.isSkipSun;

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.78) !important;
      z-index: 15000 !important; display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px); padding: 18px; pointer-events: auto !important;
    `;

    overlay.innerHTML = `
      <div class="modal-box" style="background: var(--bg-secondary, #1e293b); border: 1px solid rgba(59, 130, 246, 0.45); border-radius: 10px; width: 540px; max-width: 95vw; box-shadow: 0 16px 40px rgba(0,0,0,0.7); display: flex; flex-direction: column; overflow: hidden; color: #fff; pointer-events: auto !important; max-height: 90vh;">
        
        <!-- Header -->
        <div style="padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.25);">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 16px;">✏️</span>
            <div style="font-weight: 800; font-size: 14px; color: #60a5fa;">
              Edit Planned Crew — ${this.escapeHtml(jobNumber)}
            </div>
          </div>
          <button id="btn-edit-planned-close-x" style="background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 2px 6px;">✕</button>
        </div>

        <!-- Body -->
        <div style="padding: 18px; display: flex; flex-direction: column; gap: 14px; font-size: 12px; overflow-y: auto; color: var(--text-primary, #e2e8f0);">
          
          <!-- Job Name -->
          <div>
            <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
              Job Name / Site Description:
            </label>
            <input type="text" id="planned-edit-job-name" value="${this.escapeHtml(currentJobName)}"
                   placeholder="e.g. G Falls ZIPLY Poles 040-26 Fri &amp; Sat"
                   style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; font-size: 12.5px; font-weight: 600;">
          </div>

          <!-- Location & Foreman Row -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
                Physical City / Location:
              </label>
              <input type="text" id="planned-edit-location" value="${this.escapeHtml(currentLocation)}"
                     placeholder="e.g. Great Falls, Helena, Bozeman"
                     style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; font-size: 12.5px;">
            </div>
            <div>
              <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
                Designated Foreman:
              </label>
              <input type="text" id="planned-edit-foreman" value="${this.escapeHtml(currentForeman)}"
                     placeholder="e.g. Corey Allen"
                     style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; font-size: 12.5px;">
            </div>
          </div>

          <!-- Discipline & Status Row -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
                Discipline / Crew Type:
              </label>
              <select id="planned-edit-crew-type" style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; font-size: 12px; font-weight: 700;">
                <option value="Electric" ${currentCrewType === 'Electric' ? 'selected' : ''}>⚡ Electric</option>
                <option value="Substation" ${currentCrewType === 'Substation' ? 'selected' : ''}>🏗️ Substation</option>
                <option value="Gas" ${currentCrewType === 'Gas' ? 'selected' : ''}>⛽ Gas</option>
                <option value="Office" ${currentCrewType === 'Office' ? 'selected' : ''}>🏢 Office</option>
                <option value="Mechanic" ${currentCrewType === 'Mechanic' ? 'selected' : ''}>🔧 Mechanic</option>
                <option value="Civil" ${currentCrewType === 'Civil' ? 'selected' : ''}>🚧 Civil</option>
                <option value="Telecom" ${currentCrewType === 'Telecom' ? 'selected' : ''}>📡 Telecom</option>
              </select>
            </div>
            <div>
              <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
                Status:
              </label>
              <select id="planned-edit-status" style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; font-size: 12px; font-weight: 700;">
                <option value="Active" ${String(currentStatus).toLowerCase() === 'active' ? 'selected' : ''}>🟢 Active</option>
                <option value="Pending Start" ${['pending start', 'pending'].includes(String(currentStatus).toLowerCase()) ? 'selected' : ''}>🟡 Pending Start</option>
                <option value="On Hold" ${['on hold', 'hold', 'paused'].includes(String(currentStatus).toLowerCase()) ? 'selected' : ''}>⏸️ On Hold</option>
                <option value="Completed" ${String(currentStatus).toLowerCase() === 'completed' ? 'selected' : ''}>🏁 Completed</option>
                ${String(currentStatus).toLowerCase() === 'closed' ? '<option value="Closed" selected>🏁 Closed</option>' : ''}
                ${currentStatus && !['active', 'pending start', 'pending', 'on hold', 'hold', 'paused', 'completed', 'closed'].includes(String(currentStatus).toLowerCase()) ? `<option value="${this.escapeHtml(currentStatus)}" selected>🏷️ ${this.escapeHtml(currentStatus)}</option>` : ''}
              </select>
            </div>
          </div>

          <!-- Schedule Preset & Label -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
                Schedule Preset:
              </label>
              <select id="planned-edit-sched-preset" style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #38bdf8; font-size: 12px; font-weight: 700;">
                <option value="Mon-Thu (4 10s)" ${initialPreset === 'Mon-Thu (4 10s)' ? 'selected' : ''}>Mon-Thu (4 10s)</option>
                <option value="Mon-Fri (5 8s)" ${initialPreset === 'Mon-Fri (5 8s)' ? 'selected' : ''}>Mon-Fri (5 8s)</option>
                <option value="Mon-Fri (5 10s)" ${initialPreset === 'Mon-Fri (5 10s)' ? 'selected' : ''}>Mon-Fri (5 10s)</option>
                <option value="Mon-Sat (6 10s)" ${initialPreset === 'Mon-Sat (6 10s)' ? 'selected' : ''}>Mon-Sat (6 10s)</option>
                <option value="Mon-Sun (7 10s)" ${initialPreset === 'Mon-Sun (7 10s)' ? 'selected' : ''}>Mon-Sun (7 10s)</option>
                <option value="Tue-Fri (4 10s)" ${initialPreset === 'Tue-Fri (4 10s)' ? 'selected' : ''}>Tue-Fri (4 10s)</option>
                <option value="Fri-Sat Weekend (2 10s)" ${initialPreset === 'Fri-Sat Weekend (2 10s)' ? 'selected' : ''}>Fri-Sat Weekend (2 10s)</option>
                <option value="Custom" ${initialPreset === 'Custom' ? 'selected' : ''}>Custom Schedule</option>
              </select>
            </div>
            <div>
              <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
                Schedule Label:
              </label>
              <input type="text" id="planned-edit-sched-label" value="${this.escapeHtml(currentSchedule)}"
                     style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; font-size: 12px;">
            </div>
          </div>

          <!-- Working Days Toggle -->
          <div>
            <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 6px; font-size: 11px;">
              Working Days (Green = Working, Gray = Off):
            </label>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              ${[
                { id: 'planned-day-mon', label: 'Mon', checked: isMon },
                { id: 'planned-day-tue', label: 'Tue', checked: isTue },
                { id: 'planned-day-wed', label: 'Wed', checked: isWed },
                { id: 'planned-day-thu', label: 'Thu', checked: isThu },
                { id: 'planned-day-fri', label: 'Fri', checked: isFri },
                { id: 'planned-day-sat', label: 'Sat', checked: isSat },
                { id: 'planned-day-sun', label: 'Sun', checked: isSun }
              ].map(d => `
                <label style="display: flex; align-items: center; gap: 5px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); padding: 5px 9px; border-radius: 5px; cursor: pointer; font-size: 11.5px; font-weight: 700;">
                  <input type="checkbox" id="${d.id}" ${d.checked ? 'checked' : ''}> ${d.label}
                </label>
              `).join('')}
            </div>
          </div>

          <!-- Crew Notes -->
          <div>
            <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
              📝 Crew Notes:
            </label>
            <textarea id="planned-edit-notes" rows="3" placeholder="Optional notes displayed at the bottom of this crew's card..."
                      style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; font-size: 12px; line-height: 1.4; resize: vertical; font-family: inherit;">${this.escapeHtml(currentNotes)}</textarea>
          </div>

          <!-- Write Back to Job Tracking Checkbox -->
          <div style="background: rgba(37, 99, 235, 0.12); border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 6px; padding: 10px 14px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; font-weight: 700; color: #93c5fd;">
              <input type="checkbox" id="planned-edit-write-jt" ${isCurrentWeek ? 'checked' : ''}>
              <span>Apply changes to Job Tracking page immediately</span>
            </label>
            <div style="font-size: 11px; color: ${isCurrentWeek ? '#94a3b8' : '#fcd34d'}; margin-top: 4px; margin-left: 24px;">
              ${isCurrentWeek
                ? 'Keeps Job Tracking, Training Tracking, and Live Crew Structure in sync with this site info.'
                : 'Future week draft: unchecked by default so live Job Tracking is not overwritten until you Publish.'}
            </div>
          </div>

        </div>

        <!-- Footer -->
        <div style="padding: 12px 18px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: flex-end; gap: 8px; background: rgba(0,0,0,0.25);">
          <button type="button" id="btn-edit-planned-cancel" class="btn btn-secondary" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">
            Cancel
          </button>
          <button type="button" id="btn-edit-planned-save" class="btn btn-primary" style="font-size: 12px; font-weight: 700; padding: 6px 16px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border: none; cursor: pointer;">
            💾 Save Crew Changes
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const presetSelect = overlay.querySelector('#planned-edit-sched-preset');
    const labelInput = overlay.querySelector('#planned-edit-sched-label');
    const chkMon = overlay.querySelector('#planned-day-mon');
    const chkTue = overlay.querySelector('#planned-day-tue');
    const chkWed = overlay.querySelector('#planned-day-wed');
    const chkThu = overlay.querySelector('#planned-day-thu');
    const chkFri = overlay.querySelector('#planned-day-fri');
    const chkSat = overlay.querySelector('#planned-day-sat');
    const chkSun = overlay.querySelector('#planned-day-sun');

    if (presetSelect && labelInput) {
      const syncPresetAndLabelFromCheckboxes = () => {
        const resolved = this.resolveScheduleFromDays(
          {
            isMon: Boolean(chkMon?.checked),
            isTue: Boolean(chkTue?.checked),
            isWed: Boolean(chkWed?.checked),
            isThu: Boolean(chkThu?.checked),
            isFri: Boolean(chkFri?.checked),
            isSat: Boolean(chkSat?.checked),
            isSun: Boolean(chkSun?.checked)
          },
          labelInput.value
        );
        const validPresetVals = [
          'Mon-Thu (4 10s)', 'Mon-Fri (5 8s)', 'Mon-Fri (5 10s)',
          'Mon-Sat (6 10s)', 'Mon-Sun (7 10s)', 'Tue-Fri (4 10s)',
          'Fri-Sat Weekend (2 10s)'
        ];
        presetSelect.value = validPresetVals.includes(resolved.selectValue) ? resolved.selectValue : 'Custom';
        labelInput.value = resolved.scheduleLabel;
      };

      presetSelect.addEventListener('change', () => {
        const val = presetSelect.value;
        if (val !== 'Custom') labelInput.value = val;
        if (val === 'Mon-Thu (4 10s)') {
          chkMon.checked = true; chkTue.checked = true; chkWed.checked = true; chkThu.checked = true;
          chkFri.checked = false; chkSat.checked = false; chkSun.checked = false;
        } else if (val === 'Mon-Fri (5 8s)' || val === 'Mon-Fri (5 10s)') {
          chkMon.checked = true; chkTue.checked = true; chkWed.checked = true; chkThu.checked = true; chkFri.checked = true;
          chkSat.checked = false; chkSun.checked = false;
        } else if (val === 'Mon-Sat (6 10s)') {
          chkMon.checked = true; chkTue.checked = true; chkWed.checked = true; chkThu.checked = true; chkFri.checked = true;
          chkSat.checked = true; chkSun.checked = false;
        } else if (val === 'Mon-Sun (7 10s)') {
          chkMon.checked = true; chkTue.checked = true; chkWed.checked = true; chkThu.checked = true; chkFri.checked = true;
          chkSat.checked = true; chkSun.checked = true;
        } else if (val === 'Tue-Fri (4 10s)') {
          chkMon.checked = false; chkTue.checked = true; chkWed.checked = true; chkThu.checked = true; chkFri.checked = true;
          chkSat.checked = false; chkSun.checked = false;
        } else if (val.toLowerCase().includes('weekend') || val.toLowerCase().includes('fri-sat') || val.toLowerCase().includes('fri & sat')) {
          chkMon.checked = false; chkTue.checked = false; chkWed.checked = false; chkThu.checked = false;
          chkFri.checked = true; chkSat.checked = true; chkSun.checked = false;
        }
      });

      [chkMon, chkTue, chkWed, chkThu, chkFri, chkSat, chkSun].forEach(chk => {
        chk?.addEventListener('change', syncPresetAndLabelFromCheckboxes);
      });
    }

    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    const closeModal = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    window.addEventListener('keydown', onKey);
    overlay.querySelector('#btn-edit-planned-close-x')?.addEventListener('click', closeModal);
    overlay.querySelector('#btn-edit-planned-cancel')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

    overlay.querySelector('#btn-edit-planned-save')?.addEventListener('click', async () => {
      const newJobName = overlay.querySelector('#planned-edit-job-name')?.value?.trim() || '';
      const newLoc = overlay.querySelector('#planned-edit-location')?.value?.trim() || '';
      const newForeman = overlay.querySelector('#planned-edit-foreman')?.value?.trim() || '';
      const newCrewType = overlay.querySelector('#planned-edit-crew-type')?.value || 'Electric';
      const newStatus = overlay.querySelector('#planned-edit-status')?.value || 'Active';
      const newSchedule = overlay.querySelector('#planned-edit-sched-label')?.value?.trim() || 'Mon-Thu (4 10s)';
      const newNotes = overlay.querySelector('#planned-edit-notes')?.value?.trim() || '';
      const writeJt = overlay.querySelector('#planned-edit-write-jt')?.checked;

      if (!newJobName && (crew.jobName || jtRow?.['Job Name'])) {
        crew._clearedJobName = true;
      } else {
        delete crew._clearedJobName;
      }
      crew.jobName = newJobName;
      crew.location = newLoc;
      crew.foreman = newForeman;
      crew.crewType = newCrewType;
      crew.status = newStatus;
      crew.schedule = newSchedule;
      crew.notes = newNotes;
      crew.isSkipMon = !chkMon?.checked;
      crew.isSkipTue = !chkTue?.checked;
      crew.isSkipWed = !chkWed?.checked;
      crew.isSkipThu = !chkThu?.checked;
      crew.isSkipFri = !chkFri?.checked;
      crew.isSkipSat = !chkSat?.checked;
      crew.isSkipSun = !chkSun?.checked;
      if (!writeJt) {
        crew._statusEditedLocally = true;
      } else {
        delete crew._statusEditedLocally;
      }

      const isNowHiddenCompleted = this.isCompletedStatus(newStatus) && (!Array.isArray(crew.members) || crew.members.length === 0);
      if (isNowHiddenCompleted && writeJt && Array.isArray(plan.crews)) {
        plan.crews = plan.crews.filter(c => c !== crew);
      }

      this.savePlan(plan);

      // Also propagate Job Name & metadata to matching crew across all other saved week plans & roster history
      const allPlans = this.getPlansMap();
      let plansUpdated = false;
      Object.values(allPlans).forEach(p => {
        if (!p || p.weekDate === plan.weekDate || !Array.isArray(p.crews)) return;
        const cMatch = p.crews.find(c => String(c.jobNumber || '').trim() === jobNumber);
        if (cMatch && newJobName && cMatch.jobName !== newJobName) {
          cMatch.jobName = newJobName;
          plansUpdated = true;
        }
      });
      if (plansUpdated) {
        this.savePlansMap(allPlans);
      }
      const histMap = this.db?.snapshot?.configs?.crew_roster_history;
      if (histMap && typeof histMap === 'object') {
        Object.values(histMap).forEach(h => {
          const cMatch = (h?.crews || []).find(c => String(c.jobNumber || '').trim() === jobNumber);
          if (cMatch && newJobName) {
            cMatch.jobName = newJobName;
          }
        });
      }

      if (writeJt && window.currentRoleMode !== 'view_only') {
        const jtTbl = this.db ? this.db.getTable('job_tracking') : null;
        if (jtTbl && jtTbl.rows) {
          const schedCol = (jtTbl.headers && jtTbl.headers.includes('Work Schedule'))
            ? 'Work Schedule'
            : (jtTbl.headers && jtTbl.headers.includes('Schedule') ? 'Schedule' : 'Work Schedule');
          let row = jtTbl.rows.find(j => {
            const jn = String(j['Job Number'] || j['Job #'] || '').trim();
            return jn === jobNumber || jn.replace(/\.\d+.*$/, '').trim() === jobNumber;
          });
          const updated = {
            'Job Name': newJobName,
            'Location': newLoc,
            'Foreman': newForeman,
            'Crew Type': newCrewType,
            'Status': newStatus,
            [schedCol]: newSchedule,
            'Skip Mon': crew.isSkipMon,
            'Skip Tue': crew.isSkipTue,
            'Skip Wed': crew.isSkipWed,
            'Skip Thu': crew.isSkipThu,
            'Skip Fri': crew.isSkipFri,
            'Skip Sat': crew.isSkipSat,
            'Skip Sun': crew.isSkipSun,
            'Notes': newNotes
          };
          if (Array.isArray(jtTbl.headers) && jtTbl.headers.includes('Crew Size')) {
            updated['Crew Size'] = (crew.members || []).length;
          }
          if (row) {
            Object.assign(row, updated);
            const rIdx = row._rowIdx || (jtTbl.rows.indexOf(row) + 2);
            if (Array.isArray(jtTbl.headers) && Array.isArray(jtTbl.rawGrid) && rIdx >= 2 && jtTbl.rawGrid[rIdx - 1]) {
              jtTbl.headers.forEach((h, cIdx) => {
                if (h && row[h] !== undefined) jtTbl.rawGrid[rIdx - 1][cIdx] = row[h];
              });
            }
            await this.db.addMutation({
              action: 'UPDATE_ROW',
              sheetName: jtTbl.name || 'Job Tracking',
              tableKey: 'job_tracking',
              itemIdentifier: jobNumber,
              row: rIdx,
              updatedFields: updated
            });

            // Clean up any other duplicate rows in job_tracking matching jobNumber (descending _rowIdx, without pre-splicing)
            await this.cleanupDuplicateJobTrackingRows(jtTbl, row, jobNumber);
          } else {
            const newRow = {
              'Job Number': jobNumber,
              ...updated
            };
            await this.db.addMutation({
              action: 'ADD_ROW',
              sheetName: jtTbl.name || 'Job Tracking',
              tableKey: 'job_tracking',
              itemIdentifier: jobNumber,
              rowData: newRow
            });
          }
          if (typeof this.db.schedulePersistSnapshot === 'function') {
            this.db.schedulePersistSnapshot(this.db.snapshot, 300);
          }
        }
      }

      closeModal();
      this.refreshView();
      if (typeof window.showToast === 'function') {
        window.showToast(`✅ Updated Crew ${jobNumber} properties${writeJt ? ' and saved to Job Tracking' : ''}!`, 'success');
      }
    });
  }

  openScheduleEditModal(jobNumber) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    const crew = plan?.crews?.find(c => c.jobNumber === jobNumber);
    if (!crew) return;

    const modalId = 'modal-crew-schedule-edit';
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'modal-overlay active';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.75) !important;
      z-index: 15000 !important; display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px); padding: 18px; pointer-events: auto !important;
    `;

    const skipDays = this.getCrewSkipDays(crew);
    let isMon = !skipDays.isSkipMon;
    let isTue = !skipDays.isSkipTue;
    let isWed = !skipDays.isSkipWed;
    let isThu = !skipDays.isSkipThu;
    let isFri = !skipDays.isSkipFri;
    let isSat = !skipDays.isSkipSat;
    let isSun = !skipDays.isSkipSun;
    let currentSchedule = crew.schedule || 'Mon-Thu (4 10s)';
    let skipMtg = Boolean(crew.skipMtg);
    let skipChk = Boolean(crew.skipChk);

    overlay.innerHTML = `
      <div class="modal-box" style="background: var(--bg-secondary, #1e293b); border: 1px solid rgba(59, 130, 246, 0.45); border-radius: 10px; width: 460px; max-width: 95vw; box-shadow: 0 16px 36px rgba(0,0,0,0.65); display: flex; flex-direction: column; overflow: hidden; color: #fff; pointer-events: auto !important;">
        
        <!-- Modal Header -->
        <div style="padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.25);">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 16px;">🕒</span>
            <div style="font-weight: 800; font-size: 14px; color: #60a5fa;">
              Adjust Schedule — Crew ${this.escapeHtml(crew.jobNumber)} ${crew.jobName ? `(${this.escapeHtml(crew.jobName)})` : ''}
            </div>
          </div>
          <button id="btn-sched-close-x" style="background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 2px 6px;">✕</button>
        </div>

        <!-- Modal Body -->
        <div style="padding: 18px; display: flex; flex-direction: column; gap: 14px; font-size: 12px; color: var(--text-primary, #e2e8f0);">
          
          <!-- Schedule Preset Selector -->
          <div>
            <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
              Schedule Preset:
            </label>
            <select id="sched-preset-select" style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; font-size: 12.5px; font-weight: 600;">
              <option value="Mon-Thu (4 10s)">Mon-Thu (4 10s)</option>
              <option value="Mon-Fri (5 8s)">Mon-Fri (5 8s)</option>
              <option value="Mon-Fri (5 10s)">Mon-Fri (5 10s)</option>
              <option value="Mon-Sat (6 10s)">Mon-Sat (6 10s)</option>
              <option value="Mon-Sun (7 10s)">Mon-Sun (7 10s)</option>
              <option value="Tue-Fri (4 10s)">Tue-Fri (4 10s)</option>
              <option value="Fri-Sat Weekend (2 10s)">Fri-Sat Weekend (2 10s)</option>
              <option value="Custom">Custom Schedule</option>
            </select>
          </div>

          <!-- Shift Hours Quick Chips -->
          <div>
            <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
              Shift Hours (Click to update description):
            </label>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              ${['4 10s', '5 8s', '5 10s', '6 10s', '4 12s', '7 10s', '2 10s'].map(h => `
                <button type="button" class="sched-hours-chip" data-hours="${h}"
                        style="padding: 4px 9px; font-size: 11px; font-weight: 700; background: rgba(59, 130, 246, 0.14); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 4px; cursor: pointer; transition: all 0.15s ease;">
                  ${h}
                </button>
              `).join('')}
            </div>
          </div>

          <!-- Schedule Description (Editable) -->
          <div>
            <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 5px; font-size: 11px;">
              Schedule Description / Label:
            </label>
            <input type="text" id="sched-label-input" value="${this.escapeHtml(currentSchedule)}"
                   placeholder="e.g. Mon-Fri (5 10s)"
                   style="width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #ffffff; font-size: 12.5px;">
          </div>

          <!-- Working Days Selector -->
          <div>
            <label style="display: block; font-weight: 700; color: #94a3b8; margin-bottom: 6px; font-size: 11px;">
              Working Days (Click to toggle Working 🟢 vs. Off ⚪):
            </label>
            <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px;">
              ${[
                { key: 'Mon', label: 'Mon', work: isMon },
                { key: 'Tue', label: 'Tue', work: isTue },
                { key: 'Wed', label: 'Wed', work: isWed },
                { key: 'Thu', label: 'Thu', work: isThu },
                { key: 'Fri', label: 'Fri', work: isFri },
                { key: 'Sat', label: 'Sat', work: isSat },
                { key: 'Sun', label: 'Sun', work: isSun }
              ].map(d => `
                <button type="button" id="modal-day-${d.key}" data-day="${d.key}" data-working="${d.work ? 'true' : 'false'}"
                        style="padding: 8px 0; font-size: 11px; font-weight: 700; border-radius: 6px; border: 1px solid ${d.work ? '#059669' : 'rgba(255,255,255,0.12)'}; background: ${d.work ? '#10b981' : '#0f172a'}; color: ${d.work ? '#ffffff' : '#64748b'}; cursor: pointer; transition: all 0.15s ease;">
                  ${d.label}
                </button>
              `).join('')}
            </div>
            <div id="sched-days-summary" style="margin-top: 6px; font-size: 11px; color: #34d399; font-weight: 600; text-align: right;"></div>
          </div>

          <!-- Safety Compliance Meeting & Checklist Skips -->
          <div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px; display: flex; gap: 14px; flex-wrap: wrap;">
            <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; cursor: pointer; color: #e2e8f0;">
              <input type="checkbox" id="sched-skip-mtg" ${skipMtg ? 'checked' : ''} style="cursor: pointer;">
              <span>Skip Safety Meeting</span>
            </label>
            <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; cursor: pointer; color: #e2e8f0;">
              <input type="checkbox" id="sched-skip-chk" ${skipChk ? 'checked' : ''} style="cursor: pointer;">
              <span>Skip Monthly Checklist</span>
            </label>
          </div>

        </div>

        <!-- Modal Footer -->
        <div style="padding: 12px 18px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: flex-end; gap: 8px; background: rgba(0,0,0,0.25);">
          <button type="button" id="btn-sched-cancel" class="btn btn-secondary" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">
            Cancel
          </button>
          <button type="button" id="btn-sched-apply" class="btn btn-primary" style="font-size: 12px; font-weight: 700; padding: 6px 16px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border: none; cursor: pointer;">
            Apply Schedule
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const presetSelect = overlay.querySelector('#sched-preset-select');
    const labelInput = overlay.querySelector('#sched-label-input');
    const daysSummary = overlay.querySelector('#sched-days-summary');

    const updateDayButton = (key, work) => {
      const btn = overlay.querySelector(`#modal-day-${key}`);
      if (!btn) return;
      btn.dataset.working = work ? 'true' : 'false';
      btn.style.background = work ? '#10b981' : '#0f172a';
      btn.style.borderColor = work ? '#059669' : 'rgba(255,255,255,0.12)';
      btn.style.color = work ? '#ffffff' : '#64748b';
    };

    const getDayWorking = (key) => {
      return overlay.querySelector(`#modal-day-${key}`)?.dataset.working === 'true';
    };

    const refreshSummary = () => {
      const working = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter(d => getDayWorking(d));
      daysSummary.textContent = `${working.length} working day(s): ${working.join(', ') || 'None'}`;
    };

    // Initialize preset dropdown
    const sLower = currentSchedule.toLowerCase();
    if (sLower.includes('mon-fri') && sLower.includes('5 10')) {
      presetSelect.value = 'Mon-Fri (5 10s)';
    } else if (sLower.includes('mon-fri')) {
      presetSelect.value = 'Mon-Fri (5 8s)';
    } else if (sLower.includes('6 10') || sLower.includes('mon-sat')) {
      presetSelect.value = 'Mon-Sat (6 10s)';
    } else if (sLower.includes('7 10') || sLower.includes('mon-sun')) {
      presetSelect.value = 'Mon-Sun (7 10s)';
    } else if (sLower.includes('tue-fri')) {
      presetSelect.value = 'Tue-Fri (4 10s)';
    } else if (sLower.includes('fri-sat') || sLower.includes('weekend')) {
      presetSelect.value = 'Fri-Sat Weekend (2 10s)';
    } else if (sLower.includes('mon-thu')) {
      presetSelect.value = 'Mon-Thu (4 10s)';
    } else {
      presetSelect.value = 'Custom';
    }
    refreshSummary();

    // Preset selector change handler
    presetSelect.addEventListener('change', () => {
      const p = presetSelect.value;
      if (p === 'Mon-Thu (4 10s)') {
        updateDayButton('Mon', true); updateDayButton('Tue', true); updateDayButton('Wed', true); updateDayButton('Thu', true);
        updateDayButton('Fri', false); updateDayButton('Sat', false); updateDayButton('Sun', false);
        labelInput.value = 'Mon-Thu (4 10s)';
      } else if (p === 'Mon-Fri (5 8s)') {
        updateDayButton('Mon', true); updateDayButton('Tue', true); updateDayButton('Wed', true); updateDayButton('Thu', true);
        updateDayButton('Fri', true); updateDayButton('Sat', false); updateDayButton('Sun', false);
        labelInput.value = 'Mon-Fri (5 8s)';
      } else if (p === 'Mon-Fri (5 10s)') {
        updateDayButton('Mon', true); updateDayButton('Tue', true); updateDayButton('Wed', true); updateDayButton('Thu', true);
        updateDayButton('Fri', true); updateDayButton('Sat', false); updateDayButton('Sun', false);
        labelInput.value = 'Mon-Fri (5 10s)';
      } else if (p === 'Mon-Sat (6 10s)') {
        updateDayButton('Mon', true); updateDayButton('Tue', true); updateDayButton('Wed', true); updateDayButton('Thu', true);
        updateDayButton('Fri', true); updateDayButton('Sat', true); updateDayButton('Sun', false);
        labelInput.value = 'Mon-Sat (6 10s)';
      } else if (p === 'Mon-Sun (7 10s)') {
        ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(d => updateDayButton(d, true));
        labelInput.value = 'Mon-Sun (7 10s)';
      } else if (p === 'Tue-Fri (4 10s)') {
        updateDayButton('Mon', false); updateDayButton('Tue', true); updateDayButton('Wed', true); updateDayButton('Thu', true);
        updateDayButton('Fri', true); updateDayButton('Sat', false); updateDayButton('Sun', false);
        labelInput.value = 'Tue-Fri (4 10s)';
      } else if (p === 'Fri-Sat Weekend (2 10s)') {
        updateDayButton('Mon', false); updateDayButton('Tue', false); updateDayButton('Wed', false); updateDayButton('Thu', false);
        updateDayButton('Fri', true); updateDayButton('Sat', true); updateDayButton('Sun', false);
        labelInput.value = 'Fri-Sat Weekend (2 10s)';
      }
      refreshSummary();
    });

    // Shift Hours quick chips
    overlay.querySelectorAll('.sched-hours-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const h = chip.dataset.hours;
        let cur = labelInput.value.trim();
        if (/\(\s*\d+[^)]*\)/.test(cur)) {
          labelInput.value = cur.replace(/\(\s*\d+[^)]*\)/, `(${h})`);
        } else if (cur) {
          labelInput.value = `${cur} (${h})`;
        } else {
          labelInput.value = h;
        }

        const resolved = this.resolveScheduleFromDays(
          {
            isMon: getDayWorking('Mon'),
            isTue: getDayWorking('Tue'),
            isWed: getDayWorking('Wed'),
            isThu: getDayWorking('Thu'),
            isFri: getDayWorking('Fri'),
            isSat: getDayWorking('Sat'),
            isSun: getDayWorking('Sun')
          },
          labelInput.value
        );
        const exactVal = labelInput.value.trim();
        const optionVals = Array.from(presetSelect.options).map(o => o.value);
        if (optionVals.includes(exactVal)) {
          presetSelect.value = exactVal;
        } else if (optionVals.includes(resolved.selectValue) && resolved.scheduleLabel.toLowerCase().includes(h.toLowerCase())) {
          presetSelect.value = resolved.selectValue;
        } else {
          presetSelect.value = 'Custom';
        }
      });
    });

    // Interactive day button clicks
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(k => {
      const btn = overlay.querySelector(`#modal-day-${k}`);
      btn?.addEventListener('click', () => {
        const next = btn.dataset.working !== 'true';
        updateDayButton(k, next);
        refreshSummary();

        const resolved = this.resolveScheduleFromDays(
          {
            isMon: getDayWorking('Mon'),
            isTue: getDayWorking('Tue'),
            isWed: getDayWorking('Wed'),
            isThu: getDayWorking('Thu'),
            isFri: getDayWorking('Fri'),
            isSat: getDayWorking('Sat'),
            isSun: getDayWorking('Sun')
          },
          labelInput.value
        );
        presetSelect.value = resolved.selectValue;
        labelInput.value = resolved.scheduleLabel;
      });
    });

    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    const closeModal = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    window.addEventListener('keydown', onKey);
    overlay.querySelector('#btn-sched-close-x')?.addEventListener('click', closeModal);
    overlay.querySelector('#btn-sched-cancel')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    // Apply schedule
    overlay.querySelector('#btn-sched-apply')?.addEventListener('click', () => {
      crew.schedule = labelInput.value.trim() || 'Mon-Thu (4 10s)';
      crew.isSkipMon = !getDayWorking('Mon');
      crew.isSkipTue = !getDayWorking('Tue');
      crew.isSkipWed = !getDayWorking('Wed');
      crew.isSkipThu = !getDayWorking('Thu');
      crew.isSkipFri = !getDayWorking('Fri');
      crew.isSkipSat = !getDayWorking('Sat');
      crew.isSkipSun = !getDayWorking('Sun');
      crew.skipMtg = Boolean(overlay.querySelector('#sched-skip-mtg')?.checked);
      crew.skipChk = Boolean(overlay.querySelector('#sched-skip-chk')?.checked);

      this.savePlan(plan);
      closeModal();
      this.refreshView();
      if (typeof window.showToast === 'function') {
        window.showToast(`🕒 Updated schedule for Crew ${jobNumber}: ${crew.schedule}`, 'success');
      }
    });
  }

  moveMemberUpInCrew(empName, baseJob) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;
    const crew = plan.crews.find(c => c.jobNumber.toLowerCase() === String(baseJob || '').toLowerCase());
    if (!crew) return;
    const norm = String(empName || '').trim().toLowerCase();
    const idx = crew.members.findIndex(m => m.name.trim().toLowerCase() === norm);
    if (idx <= 0) {
      if (typeof window.showToast === 'function') {
        window.showToast(`${empName} is already at the top of Crew ${baseJob}.`, 'info');
      }
      return;
    }
    // Swap with member above
    const temp = crew.members[idx];
    crew.members[idx] = crew.members[idx - 1];
    crew.members[idx - 1] = temp;

    // Renumber sequentially (.1, .2, .3, ...)
    crew.members.forEach((m, i) => {
      m.slot = `${crew.jobNumber}.${i + 1}`;
    });

    this.savePlan(plan);
    this.refreshView();
    if (typeof window.showToast === 'function') {
      window.showToast(`⬆️ Moved ${empName} up to slot ${crew.members[idx - 1].slot}.`, 'info');
    }
  }

  moveMemberDownInCrew(empName, baseJob) {
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;
    const crew = plan.crews.find(c => c.jobNumber.toLowerCase() === String(baseJob || '').toLowerCase());
    if (!crew) return;
    const norm = String(empName || '').trim().toLowerCase();
    const idx = crew.members.findIndex(m => m.name.trim().toLowerCase() === norm);
    if (idx === -1 || idx >= crew.members.length - 1) {
      if (typeof window.showToast === 'function') {
        window.showToast(`${empName} is already at the bottom of Crew ${baseJob}.`, 'info');
      }
      return;
    }
    // Swap with member below
    const temp = crew.members[idx];
    crew.members[idx] = crew.members[idx + 1];
    crew.members[idx + 1] = temp;

    // Renumber sequentially (.1, .2, .3, ...)
    crew.members.forEach((m, i) => {
      m.slot = `${crew.jobNumber}.${i + 1}`;
    });

    this.savePlan(plan);
    this.refreshView();
    if (typeof window.showToast === 'function') {
      window.showToast(`⬇️ Moved ${empName} down to slot ${crew.members[idx + 1].slot}.`, 'info');
    }
  }

  openPlannedMemberActions(e, empName, baseJob) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const plan = this.getPlanForWeek(this.selectedWeek);
    if (!plan) return;

    const existing = document.getElementById('planning-member-actions-menu');
    if (existing) {
      if (typeof existing._cleanup === 'function') existing._cleanup();
      existing.remove();
    }

    const st = this.getEmployeePlanningStatus(empName, baseJob, null, plan);
    const crew = plan.crews.find(c => c.jobNumber.toLowerCase() === String(baseJob || '').toLowerCase());
    const isForeman = crew ? this.isCrewForeman(crew, empName) : false;
    const dragData = { empName, name: empName, fromBaseJob: baseJob };

    // Position menu near click cursor or button
    const clientX = e ? e.clientX : window.innerWidth / 2;
    const clientY = e ? e.clientY : window.innerHeight / 2;

    const menu = document.createElement('div');
    menu.id = 'planning-member-actions-menu';
    menu.style.cssText = `
      position: fixed;
      top: ${Math.min(clientY + 4, window.innerHeight - 420)}px;
      left: ${Math.max(10, Math.min(clientX - 160, window.innerWidth - 270))}px;
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
      z-index: 16000;
      min-width: 240px;
      padding: 6px 0;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      animation: fadeIn 0.12s ease;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding: 6px 14px 8px 14px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); font-size: 11px; color: #94a3b8; display: flex; flex-direction: column; gap: 2px;';
    header.innerHTML = `
      <div style="font-weight: 700; color: #f8fafc; font-size: 12px; display: flex; align-items: center; gap: 5px;">
        ${isForeman ? '👑 ' : ''}<span>${this.escapeHtml(empName)}</span>
      </div>
      <div>Crew ${this.escapeHtml(baseJob)}</div>
    `;
    menu.appendChild(header);

    const makeItem = (icon, label, onClick, color = '#e2e8f0', hoverBg = 'rgba(255,255,255,0.08)') => {
      const btn = document.createElement('button');
      btn.style.cssText = `
        background: transparent;
        border: none;
        padding: 7px 14px;
        text-align: left;
        color: ${color};
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 9px;
        font-size: 12px;
        width: 100%;
        transition: background 0.1s ease;
      `;
      btn.innerHTML = `<span style="font-size: 13px; width: 18px; text-align: center;">${icon}</span> <span style="flex: 1;">${this.escapeHtml(label)}</span>`;
      btn.onmouseenter = () => { btn.style.background = hoverBg; };
      btn.onmouseleave = () => { btn.style.background = 'transparent'; };
      btn.onclick = (evt) => {
        evt.stopPropagation();
        menu.remove();
        document.removeEventListener('click', closeMenu);
        onClick();
      };
      return btn;
    };

    const makeDivider = () => {
      const div = document.createElement('div');
      div.style.cssText = 'height: 1px; background: rgba(255, 255, 255, 0.08); margin: 4px 0;';
      return div;
    };

    // 0. Open Employee Profile & Edit Note
    menu.appendChild(makeItem('👤', 'Open Employee Profile & Edit Details', () => {
      if (window.employeeProfileEngine) {
        window.employeeProfileEngine.openProfileModal(empName, 'details');
      }
    }, '#60a5fa', 'rgba(96, 165, 250, 0.12)'));
    const hasPlannedEmpNote = Boolean(this.getEmployeeNote(empName, plan));
    menu.appendChild(makeItem('📝', hasPlannedEmpNote ? 'Edit Employee Note...' : 'Add Employee Note...', () => {
      this.promptEditEmployeeNote(empName);
    }, '#fbbf24', 'rgba(245, 158, 11, 0.12)'));
    menu.appendChild(makeDivider());

    // 1. Move Up / Down
    menu.appendChild(makeItem('⬆️', 'Move Up in Crew', () => this.moveMemberUpInCrew(empName, baseJob)));
    menu.appendChild(makeItem('⬇️', 'Move Down in Crew', () => this.moveMemberDownInCrew(empName, baseJob)));

    // 2. Designate Foreman
    if (!isForeman && crew) {
      menu.appendChild(makeItem('👑', `Make Foreman of Crew ${baseJob}`, () => {
        crew.foreman = empName;
        const fmIdx = (crew.members || []).findIndex(m => String(m.name || '').trim().toLowerCase() === empName.trim().toLowerCase());
        if (fmIdx > 0) {
          const [fmObj] = crew.members.splice(fmIdx, 1);
          crew.members.unshift(fmObj);
          crew.members.forEach((m, idx) => {
            m.slot = `${crew.jobNumber}.${idx + 1}`;
          });
        }
        this.savePlan(plan);
        this.refreshView();
        if (typeof window.showToast === 'function') {
          window.showToast(`👑 Designated ${empName} as Foreman of Crew ${baseJob}.`, 'success');
        }
      }, '#f472b6', 'rgba(244, 114, 182, 0.12)'));
    }

    // 3. Duplicate
    menu.appendChild(makeItem('👯', 'Duplicate to Another Crew/Category...', () => {
      this.promptDuplicateMember(empName, baseJob);
    }, '#c084fc', 'rgba(192, 132, 252, 0.12)'));

    if (st.isMultiLocation) {
      menu.appendChild(makeItem('⚡', 'Edit 1st / 2nd Job Assignment...', () => {
        this.promptEditPlannedSecondJob(empName, baseJob);
      }, '#fbbf24', 'rgba(245, 158, 11, 0.12)'));
    }

    // 4. Confirm / Unconfirm (only applicable for moved or modified multi-location positions)
    if ((st.isMoved || st.isMultiLocation) && st.badgeText !== '2nd Job') {
      if (st.isConfirmed) {
        menu.appendChild(makeItem('🟣', 'Unconfirm Position (Return to Purple)', () => {
          this.toggleConfirmMemberPosition(empName, baseJob);
        }, '#c084fc'));
      } else if (st.isMultiLocation) {
        menu.appendChild(makeItem('💠', 'Confirm 2nd Job Position (Turn Cyan)', () => {
          this.toggleConfirmMemberPosition(empName, baseJob);
        }, '#22d3ee', 'rgba(6, 182, 212, 0.12)'));
      } else {
        menu.appendChild(makeItem('🟡', 'Confirm Position (Turn Yellow)', () => {
          this.toggleConfirmMemberPosition(empName, baseJob);
        }, '#facc15', 'rgba(250, 204, 21, 0.12)'));
      }
    }

    menu.appendChild(makeDivider());

    // 5. Departure / Notice & Vacation Options
    const memberObjOnCrew = crew?.members.find(x => x.name.toLowerCase() === empName.toLowerCase());
    const quitEntry = (plan.sidePane?.quit || []).find(q => q.name.trim().toLowerCase() === empName.toLowerCase());
    const hasDeparture = Boolean(memberObjOnCrew?.departureDate || quitEntry?.departureDate);
    const depDate = memberObjOnCrew?.departureDate || quitEntry?.departureDate;

    if (hasDeparture) {
      menu.appendChild(makeItem('🚪', `Edit Scheduled Departure (${depDate})`, () => this.editQuitDeparture(empName), '#fca5a5', 'rgba(239, 68, 68, 0.15)'));
      menu.appendChild(makeItem('↩️', 'Cancel Scheduled Departure', () => this.removeMemberFromSideCategory(empName, 'quit'), '#cbd5e1'));
    } else {
      menu.appendChild(makeItem('🚪', 'Schedule Departure / Last Working Day...', () => this.promptQuitDeparture(dragData), '#fca5a5', 'rgba(239, 68, 68, 0.12)'));
    }

    const vacEntry = (plan.sidePane?.vacation || []).find(v => v.name.trim().toLowerCase() === empName.toLowerCase());
    const hasVacation = Boolean(memberObjOnCrew?.vacationDateRange || vacEntry);
    const vacRange = memberObjOnCrew?.vacationDateRange || vacEntry?.dateRange || vacEntry?.vacationStartDate || '';

    if (hasVacation) {
      menu.appendChild(makeItem('🏖️', `Edit Scheduled Vacation (${vacRange || 'Set Dates'})`, () => this.editVacationSchedule(empName), '#fcd34d', 'rgba(245, 158, 11, 0.15)'));
      menu.appendChild(makeItem('↩️', 'Cancel Scheduled Vacation', () => this.removeMemberFromSideCategory(empName, 'vacation'), '#cbd5e1'));
    } else {
      menu.appendChild(makeItem('🏖️', 'Schedule Vacation / Dates...', () => this.promptVacationSchedule(dragData), '#fcd34d', 'rgba(245, 158, 11, 0.12)'));
    }

    menu.appendChild(makeDivider());

    // 6. Move to Staging Categories
    menu.appendChild(makeItem('📋', 'Move to Planning Pool', () => this.handleMoveToSideCategory(dragData, 'planning')));
    menu.appendChild(makeItem('🏖️', 'Move to Scheduled Vacation', () => this.handleMoveToSideCategory(dragData, 'vacation')));
    menu.appendChild(makeItem('🌾', 'Move to Weeds', () => this.handleMoveToSideCategory(dragData, 'weeds')));
    menu.appendChild(makeItem('🩺', 'Move to Light Duty', () => this.handleMoveToSideCategory(dragData, 'lightDuty')));

    menu.appendChild(makeDivider());

    // 7. Remove from Crew
    menu.appendChild(makeItem('✕', 'Remove from this Crew', () => {
      if (confirm(`Remove ${empName} from Crew ${baseJob}?`)) {
        if (crew) {
          const wasFm = this.isCrewForeman(crew, empName);
          const removedMember = (crew.members || []).find(m => m.name.toLowerCase() === empName.toLowerCase());
          crew.members = crew.members.filter(m => m.name.toLowerCase() !== empName.toLowerCase());
          crew.members.forEach((m, idx) => {
            m.slot = `${crew.jobNumber}.${idx + 1}`;
          });
          if (wasFm) {
            crew.foreman = this.pickBestForeman(crew.members);
          }
          // Remove confirmation key for this assignment
          const norm = empName.toLowerCase().trim();
          if (plan.confirmedPositions) {
            delete plan.confirmedPositions[`${norm}::${String(baseJob).toLowerCase()}`];
          }
          // Clean up secondaryJob reference on remaining occurrence if only 1 occurrence remains
          const remainingOccs = (plan.crews || []).flatMap(c => (c.members || []).filter(m => m.name && m.name.toLowerCase() === norm));
          if (remainingOccs.length === 1) {
            remainingOccs[0].secondaryJob = '';
            delete remainingOccs[0].isSecondaryMember;
            delete remainingOccs[0].primaryJobNumber;
          }
          // If employee is now in 0 crews and 0 side categories, stage them in Planning Pool
          const isStillInCrews = (plan.crews || []).some(c => (c.members || []).some(m => m.name && m.name.toLowerCase() === norm));
          const sp = plan.sidePane || {};
          const isStillInSide = Object.keys(sp).some(k => (sp[k] || []).some(m => m.name && m.name.toLowerCase() === norm));
          if (!isStillInCrews && !isStillInSide) {
            if (!plan.sidePane) plan.sidePane = {};
            if (!plan.sidePane.planning) plan.sidePane.planning = [];
            plan.sidePane.planning.push({
              name: empName,
              slot: '',
              currentJob: `${baseJob} (Unassigned)`,
              classification: removedMember?.classification || '',
              location: removedMember?.location || crew.location || '',
              notes: removedMember?.notes || '',
              originalSlot: removedMember?.originalSlot || '',
              originalBaseJob: removedMember?.originalBaseJob || null,
              isConfirmed: false
            });
          }
          this.savePlan(plan);
          this.refreshView();
          if (typeof window.showToast === 'function') {
            window.showToast(`Removed ${empName} from Crew ${baseJob}.`, 'info');
          }
        }
      }
    }, '#f87171', 'rgba(248, 113, 113, 0.12)'));

    document.body.appendChild(menu);

    // Auto-close on click outside or Escape key
    let clickTimeout = null;
    const cleanupMenu = () => {
      if (clickTimeout) clearTimeout(clickTimeout);
      document.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', onMenuKey);
    };
    const closeMenu = (evt) => {
      if (!menu.contains(evt.target)) {
        cleanupMenu();
        menu.remove();
      }
    };
    const onMenuKey = (evt) => {
      if (evt.key === 'Escape') {
        cleanupMenu();
        menu.remove();
      }
    };
    menu._cleanup = cleanupMenu;
    // Also override makeItem cleanup so clicking an item removes both listeners
    menu.querySelectorAll('button').forEach(btn => {
      const origOnClick = btn.onclick;
      if (origOnClick) {
        btn.onclick = (evt) => {
          cleanupMenu();
          origOnClick(evt);
        };
      }
    });
    window.addEventListener('keydown', onMenuKey);
    clickTimeout = setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 10);
  }

  openHistoricalExcelImportModal() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx, .xls, .csv';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        if (typeof window.showToast === 'function') {
          window.showToast('Reading historical workbook tabs...', 'info');
        }
        const res = await this.importHistoricalWorkbookTabs(file);
        alert(`✅ Successfully imported ${res.importedCount} historical weekly rosters into the archive:\n\n${res.importedWeeks.join(', ')}`);
        this.refreshView();
      } catch (err) {
        alert(`Error importing historical workbook: ${err.message}`);
      }
    };
    input.click();
  }

  // ==========================================================================
  // Utility String Escapers
  // ==========================================================================

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  escapeJs(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, '\\u0027')
      .replace(/"/g, '\\u0022')
      .replace(/&/g, '\\u0026')
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }
}

if (typeof window !== 'undefined' && typeof window.initEmployeeNoteTooltip !== 'function') {
  window.initEmployeeNoteTooltip = function () {
    if (typeof document === 'undefined' || window.__empNoteTooltipBound) return;
    window.__empNoteTooltipBound = true;

    let tooltipEl = null;
    let activeTarget = null;

    const getTooltipEl = () => {
      if (!tooltipEl || !document.body.contains(tooltipEl)) {
        tooltipEl = document.getElementById('emp-note-hover-tooltip');
        if (!tooltipEl) {
          tooltipEl = document.createElement('div');
          tooltipEl.id = 'emp-note-hover-tooltip';
          tooltipEl.style.cssText = [
            'position: fixed',
            'display: none',
            'z-index: 99999',
            'pointer-events: none',
            'max-width: 320px',
            'background: #0f172a',
            'color: #f8fafc',
            'border: 1px solid rgba(245, 158, 11, 0.55)',
            'border-left: 3px solid #f59e0b',
            'border-radius: 6px',
            'padding: 8px 11px',
            'box-shadow: 0 10px 26px rgba(0, 0, 0, 0.65)',
            'font-size: 11.5px',
            'line-height: 1.45',
            'white-space: pre-wrap',
            'word-break: break-word'
          ].join('; ');
          document.body.appendChild(tooltipEl);
        }
      }
      return tooltipEl;
    };

    const hideTooltip = () => {
      if (activeTarget && activeTarget.dataset && activeTarget.dataset.origTitle !== undefined) {
        activeTarget.setAttribute('title', activeTarget.dataset.origTitle);
        delete activeTarget.dataset.origTitle;
      }
      activeTarget = null;
      if (tooltipEl) tooltipEl.style.display = 'none';
    };

    const positionTooltip = (anchorEl) => {
      if (!tooltipEl || !anchorEl) return;
      const rect = anchorEl.getBoundingClientRect();
      const pad = 8;
      tooltipEl.style.display = 'block';
      tooltipEl.style.visibility = 'hidden';
      const tw = tooltipEl.offsetWidth || 240;
      const th = tooltipEl.offsetHeight || 54;
      let left = rect.left;
      if (left + tw + pad > window.innerWidth) {
        left = Math.max(pad, window.innerWidth - tw - pad);
      }
      if (left < pad) left = pad;
      let top = rect.bottom + 6;
      if (top + th + pad > window.innerHeight && rect.top - th - 6 >= pad) {
        top = rect.top - th - 6;
      }
      if (top < pad) top = pad;
      tooltipEl.style.left = `${Math.round(left)}px`;
      tooltipEl.style.top = `${Math.round(top)}px`;
      tooltipEl.style.visibility = 'visible';
    };

    document.addEventListener('mouseover', (evt) => {
      const target = evt.target && evt.target.closest ? evt.target.closest('[data-emp-note]') : null;
      if (!target) {
        if (activeTarget) hideTooltip();
        return;
      }
      const note = String(target.getAttribute('data-emp-note') || '').trim();
      if (!note) {
        if (activeTarget) hideTooltip();
        return;
      }
      if (activeTarget && activeTarget !== target) {
        hideTooltip();
      }
      activeTarget = target;
      const curTitle = target.getAttribute('title');
      if (curTitle && target.dataset && target.dataset.origTitle === undefined) {
        target.dataset.origTitle = curTitle;
        target.removeAttribute('title');
      }
      const el = getTooltipEl();
      const empName = String(target.getAttribute('data-emp-name') || '').trim();
      const esc = (s) => String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      el.innerHTML = `<div style="font-size: 10px; font-weight: 800; color: #fbbf24; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 3px;">📝 ${empName ? esc(empName) + ' — Note' : 'Employee Note'}</div><div style="color: #e2e8f0;">${esc(note)}</div>`;
      positionTooltip(target);
    });

    document.addEventListener('mouseout', (evt) => {
      if (!activeTarget) return;
      const rel = evt.relatedTarget;
      if (rel && activeTarget.contains && activeTarget.contains(rel)) return;
      if (rel && rel.closest && rel.closest('[data-emp-note]') === activeTarget) return;
      hideTooltip();
    });

    document.addEventListener('scroll', hideTooltip, true);
    document.addEventListener('mousedown', hideTooltip, true);
    document.addEventListener('dragstart', hideTooltip, true);
  };
  if (typeof document !== 'undefined') {
    window.initEmployeeNoteTooltip();
  }
}

// Global instantiation
if (typeof window !== 'undefined') {
  window.CrewPlanningEngine = CrewPlanningEngine;
  if (!window.crewPlanningEngine && window.localDB) {
    window.crewPlanningEngine = new CrewPlanningEngine(window.localDB);
  }
}
