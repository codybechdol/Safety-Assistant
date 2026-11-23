/**
 * Safety Assistant - Equipment History Issues & Discrepancies Engine
 * High-performance, non-blocking scanner for duplicate history records and discrepancies.
 * Uses O(1) cached count lookups, lazy detail loading, chunked card rendering, and surgical DOM updates
 * to ensure 100% smooth, instant tab switching and modal response times.
 */

class HistoryIssuesEngine {
  constructor(db) {
    this.db = db || window.localDB;
    this.cachedCounts = null;
    this.cachedTypeBreakdown = {};
    this.cachedDetails = new Map();
    this.currentModalCategory = 'gloves';
    this.searchTerm = '';
    this.typeFilter = 'all'; // 'all', 'duplicate', 'future', 'consecutive', 'mismatch'
    this.modalPageLimit = 25;
    this._searchDebounceTimer = null;

    this.equipmentList = [
      { key: 'gloves', histKey: 'gloves_history', label: 'Gloves', icon: '🧤', singular: 'Glove' },
      { key: 'sleeves', histKey: 'sleeves_history', label: 'Sleeves', icon: '🦺', singular: 'Sleeve' },
      { key: 'blankets', histKey: 'blankets_history', label: 'Blankets', icon: '🧱', singular: 'Blanket' },
      { key: 'macks', histKey: 'macks_history', label: 'MACKs', icon: '🧱', singular: 'MACK' },
      { key: 'hv_testers', histKey: 'hv_testers_history', label: 'HV Testers', icon: '⚡', singular: 'HV Tester' },
      { key: 'phasing_sets', histKey: 'phasing_sets_history', label: 'Phasing Sets', icon: '⚡', singular: 'Phasing Set' },
      { key: 'aed', histKey: 'aed_history', label: 'AED', icon: '🏥', singular: 'AED' },
      { key: 'grounds', histKey: 'grounds_history', label: 'Grounds', icon: '⚡', singular: 'Ground' },
      { key: 'hot_sticks', histKey: 'hot_sticks_history', label: 'Hot Sticks', icon: '🔴', singular: 'Hot Stick' }
    ];
  }

  init() {
    this.ensureModalInDOM();
    // Non-blocking initial scan via microtask
    setTimeout(() => {
      this.refreshCountsFast();
      this.updateTabBadges();
    }, 10);
  }

  invalidateCache(specificKey = null) {
    this.cachedCounts = null;
    if (specificKey) {
      const norm = specificKey.replace('_history', '');
      this.cachedDetails.delete(norm);
      this.cachedDetails.delete(`${norm}_history`);
    } else {
      this.cachedDetails.clear();
    }
    // Update UI in next animation frame to avoid blocking current action
    requestAnimationFrame(() => {
      this.refreshCountsFast();
      this.updateTabBadges();
      this.updateActiveSheetUI();
    });
  }

  getEquipmentMeta(key) {
    if (!key) return null;
    const cleanKey = String(key).toLowerCase().replace('_history', '');
    return this.equipmentList.find(e => e.key === cleanKey) || null;
  }

  /**
   * Fast integer-based date comparison (zero object allocations)
   */
  toDateNum(s) {
    if (!s) return 0;
    const str = String(s).trim();
    if (str.includes('/')) {
      const p = str.split('/');
      if (p.length === 3) {
        let y = parseInt(p[2], 10);
        if (y > 2100 && y >= 20200 && y <= 20300) y = Math.floor(y / 10);
        else if (y === 2032) y = 2022;
        else if (y < 100) y += 2000;
        return y * 10000 + parseInt(p[0], 10) * 100 + parseInt(p[1], 10);
      }
    } else if (str.includes('-')) {
      const p = str.split('-');
      if (p.length === 3) {
        let y = parseInt(p[0], 10);
        if (y > 2100 && y >= 20200 && y <= 20300) y = Math.floor(y / 10);
        else if (y === 2032) y = 2022;
        return y * 10000 + parseInt(p[1], 10) * 100 + parseInt(p[2], 10);
      }
    }
    return 0;
  }

  normalizeDateStr(dStr) {
    if (!dStr) return '';
    const s = String(dStr).trim();
    if (s.includes('/')) {
      const parts = s.split('/');
      if (parts.length === 3) {
        const m = parts[0].padStart(2, '0');
        const d = parts[1].padStart(2, '0');
        let y = parts[2];
        const yNum = parseInt(y, 10);
        if (yNum > 2100 && yNum >= 20200 && yNum <= 20300) y = String(Math.floor(yNum / 10));
        else if (yNum === 2032) y = '2022';
        else if (y.length === 2) y = '20' + y;
        return `${y}-${m}-${d}`;
      }
    } else if (s.includes('-')) {
      const parts = s.split('-');
      if (parts.length === 3) {
        let y = parts[0];
        const yNum = parseInt(y, 10);
        if (yNum > 2100 && yNum >= 20200 && yNum <= 20300) y = String(Math.floor(yNum / 10));
        else if (yNum === 2032) y = '2022';
        return `${y}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      }
    }
    return s;
  }

  normalizeItemStr(val) {
    const s = String(val || '').trim();
    if (/^\d+$/.test(s)) return String(parseInt(s, 10));
    return s.toLowerCase();
  }

  cleanHolderName(raw) {
    if (!raw) return '';
    let s = String(raw).trim().toLowerCase();
    s = s.replace(/\s*\([^)]*\)/g, '').trim();
    s = s.replace(/^assigned\s+to\s+/i, '').trim();
    return s;
  }

  /**
   * Extracts clean raw item identifier from an active or history row across all 9 equipment types.
   */
  extractItemKey(row, headers = [], eqKey = '') {
    if (!row) return '';
    const isDateLike = (v) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v);
    const keyLower = String(eqKey || '').toLowerCase();
    const priorityKeys = [];
    if (keyLower.includes('ground')) {
      priorityKeys.push('Serial #', 'Serial#', 'Serial', 'Ground #', 'Ground', 'Item #', 'Item#');
    } else if (keyLower.includes('hv') || keyLower.includes('tester')) {
      priorityKeys.push('HVT #', 'HVT#', 'HVT', 'HV Tester #', 'HV Tester', 'Item #', 'Item#');
    } else if (keyLower.includes('phasing')) {
      priorityKeys.push('Phasing Set', 'Phasing Set #', 'PS #', 'PS#', 'PS', 'Item #', 'Item#');
    } else if (keyLower.includes('aed')) {
      priorityKeys.push('AED #', 'AED#', 'AED', 'Serial #', 'Item #', 'Item#');
    } else if (keyLower.includes('hot_stick') || keyLower.includes('stick')) {
      priorityKeys.push('Hot Stick #', 'Hot Stick', 'Hot Sticks', 'Item #', 'Item#');
    } else {
      priorityKeys.push('Item #', 'Item#', 'Glove', 'Glove #', 'Sleeve', 'Sleeve #', 'Blanket', 'Blanket #', 'MACK', 'MACK #', 'Serial #');
    }

    for (const k of priorityKeys) {
      if (row[k] !== undefined && row[k] !== null) {
        const v = String(row[k]).trim();
        if (v && v !== 'N/A' && !isDateLike(v)) return v;
      }
    }

    if (headers && headers.length > 0) {
      for (const h of headers) {
        if (/^(item|serial|glove|sleeve|blanket|mack|hvt|hv\s*tester|phasing|ps|aed|hot\s*stick)/i.test(h)) {
          const v = String(row[h] || '').trim();
          if (v && v !== 'N/A' && !isDateLike(v)) return v;
        }
      }
    }

    for (const [k, raw] of Object.entries(row)) {
      if (k.startsWith('_')) continue;
      if (/date|status|location|assign|note|size|class|kv|model|length|picked/i.test(k)) continue;
      const v = String(raw || '').trim();
      if (v && v !== 'N/A' && !isDateLike(v)) return v;
    }
    return '';
  }

  areSameEmployeeName(a, b) {
    const cleanA = String(a || '').replace(/\s*\([^)]*\)/g, '').trim();
    const cleanB = String(b || '').replace(/\s*\([^)]*\)/g, '').trim();
    if (!cleanA || !cleanB) return false;
    if (cleanA.toLowerCase() === cleanB.toLowerCase()) return true;
    if (this.db && typeof this.db.areSameEmployee === 'function' && this.db.areSameEmployee(cleanA, cleanB)) {
      return true;
    }
    const flip = (name) => {
      if (!name.includes(',')) return name.toLowerCase();
      const parts = name.split(',').map(p => p.trim()).filter(Boolean);
      return parts.length >= 2 ? `${parts[1]} ${parts[0]}`.toLowerCase() : name.toLowerCase();
    };
    return flip(cleanA) === flip(cleanB);
  }

  /**
   * Normalizes an active or history row into a canonical lifecycle state + holder for mismatch detection.
   */
  classifyStateForCompare(row, isActive = false) {
    if (!row) return { key: 'SHELF', compatKey: 'SHELF', rank: 2, holder: 'On Shelf', displayLabel: 'On Shelf' };

    const rawAssigned = String(row['Assigned To'] || row['Employee Name'] || row['Employee'] || '').trim();
    const rawStatus = String(row['Status'] || '').trim();
    const rawLoc = String(row['Location'] || '').trim();
    const rawNotes = String(row['Notes'] || row['Note'] || '').trim();

    const sAssigned = rawAssigned.toLowerCase();
    const sStatus = rawStatus.toLowerCase();
    const sLoc = rawLoc.toLowerCase();
    const sNotes = isActive ? '' : rawNotes.toLowerCase();

    // 1. Retired / Failed / Condemned / Destroyed
    if (
      sStatus.includes('failed') || sStatus.includes('condemned') || sStatus.includes('destroyed') || sStatus.includes('retired') || sStatus.includes('expired') ||
      sAssigned === 'failed' || sAssigned === 'failed rubber' || sAssigned === 'condemned' || sAssigned === 'destroyed' || sAssigned === 'retired' || sAssigned.includes('failed rubber') || sAssigned.includes('condemned') ||
      sLoc === 'destroyed' || sLoc === 'retired' ||
      (!isActive && !rawAssigned && (sNotes.includes('failed rubber') || sNotes.includes('condemned') || sNotes.includes('destroyed')))
    ) {
      return { key: 'RETIRED', compatKey: 'RETIRED', rank: 8, holder: rawStatus || rawAssigned || 'Failed Rubber', displayLabel: rawStatus || 'Retired / Failed' };
    }

    // 2. Lost / Missing
    if (sAssigned === 'lost' || sLoc === 'lost' || sStatus === 'lost' || sAssigned.includes('lost') || sStatus.includes('lost') || sLoc.includes('lost')) {
      return { key: 'LOST', compatKey: 'LOST', rank: 7, holder: 'Lost', displayLabel: 'Lost (Missing)' };
    }

    // 3. Packed For Testing
    if (sAssigned === 'packed for testing' || sStatus === 'packed for testing' || (sStatus === 'ready for test' && sLoc === "cody's truck")) {
      return { key: 'PACKED_TESTING', compatKey: 'PACKED_TESTING', rank: 5, holder: 'Packed For Testing', displayLabel: 'Packed For Testing' };
    }

    // 4. Packed For Delivery / Ready For Delivery
    if (sAssigned === 'packed for delivery' || sStatus === 'packed for delivery' || sStatus === 'ready for delivery' || (sLoc === "cody's truck" && !sAssigned.includes('testing') && !sStatus.includes('testing'))) {
      return { key: 'PACKED_DELIVERY', compatKey: 'PACKED_DELIVERY', rank: 3, holder: 'Packed For Delivery', displayLabel: 'Packed For Delivery' };
    }

    // 5. In Testing / Lab
    if (
      sAssigned === 'in testing' || sAssigned === 'testing' || sAssigned === 'arnett' || sAssigned === 'jm test' || sAssigned === 'arnett / jm test' || sAssigned === 'lab' ||
      sStatus === 'in testing' || sStatus === 'ready for test' ||
      sLoc === 'arnett / jm test' || sLoc === 'arnett' || sLoc === 'jm test'
    ) {
      return { key: 'TESTING', compatKey: 'TESTING', rank: 6, holder: 'In Testing', displayLabel: 'In Testing' };
    }

    // 6. On Shelf / Brand New Purchase / Stock
    const isBrandNewAssigned = (
      sAssigned === 'on shelf (new purchase)' || sAssigned === 'brand new (on shelf)' ||
      sAssigned === 'brand new' || sAssigned === 'new purchase' || sAssigned === 'new' ||
      sAssigned === 'newly purchased' || sAssigned === 'new item' ||
      sAssigned.startsWith('new (') || sAssigned.startsWith('brand new') || sAssigned.startsWith('new purchase') ||
      sAssigned.includes('brand new') || sAssigned.includes('new purchase')
    ) && !sAssigned.includes('newman') && !sAssigned.includes('new assignment');

    const isShelfHolder = (
      !sAssigned || sAssigned === 'on shelf' || sAssigned === 'in stock' || sAssigned === 'shelf' ||
      sAssigned === 'storage' || sAssigned === 'available' || sAssigned === 'unassigned' ||
      sAssigned === 'previous employee' || sAssigned === 'n/a' || sAssigned === 'none' || sAssigned === 'unknown' ||
      sAssigned.includes('shelf') || sAssigned.includes('storage') ||
      sStatus === 'on shelf' || sStatus === 'in stock' ||
      (sLoc === 'helena' && (!sAssigned || sAssigned === 'n/a' || sAssigned === 'helena'))
    );

    if (isBrandNewAssigned || isShelfHolder) {
      return {
        key: isBrandNewAssigned ? 'NEW_PURCHASE' : 'SHELF',
        compatKey: 'SHELF',
        rank: isBrandNewAssigned ? 1 : 2,
        holder: rawAssigned || 'On Shelf',
        displayLabel: isBrandNewAssigned ? 'On Shelf (New Purchase)' : 'On Shelf'
      };
    }

    // 7. Default: Field Service (Assigned to Employee / Entity)
    const fieldHolder = rawAssigned || rawStatus;
    return { key: 'FIELD', compatKey: 'FIELD', rank: 4, holder: fieldHolder, displayLabel: `Assigned → ${fieldHolder}` };
  }

  /**
   * Selects the chronologically latest valid history row (preferring non-future/pending-new-hire rows;
   * ties broken by canonical lifecycle precedence).
   */
  getLatestHistoryRowForCompare(rows, pendingEmpMap, dateH = 'Date Assigned', assignedH = 'Assigned To') {
    if (!rows || rows.length === 0) return null;
    const today = new Date();
    const todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate() + 1;

    let best = null;
    let bestDNum = -Infinity;
    let bestRank = -1;

    for (const r of rows) {
      const dNum = this.toDateNum(r[dateH] || r['Date Assigned'] || r['Date']);
      const rawHolder = String(r[assignedH] || r['Assigned To'] || '').trim();
      const cleanHolder = this.cleanHolderName(rawHolder);
      if (dNum > todayNum && !pendingEmpMap.has(cleanHolder)) {
        continue;
      }
      const st = this.classifyStateForCompare(r, false);
      if (!best || dNum > bestDNum || (dNum === bestDNum && st.rank > bestRank)) {
        best = r;
        bestDNum = dNum;
        bestRank = st.rank;
      }
    }
    return best;
  }

  /**
   * Returns mismatch descriptor object if activeRecord disagrees with latestHistRow, or null when in sync.
   */
  detectActiveHistoryMismatch(activeRecord, latestHistRow, activeDateH = 'Date Assigned', histDateH = 'Date Assigned') {
    if (!activeRecord || !latestHistRow) return null;
    const activeState = this.classifyStateForCompare(activeRecord, true);
    const histState = this.classifyStateForCompare(latestHistRow, false);

    let mismatched = false;
    if (activeState.compatKey !== histState.compatKey) {
      mismatched = true;
    } else if (activeState.compatKey === 'FIELD') {
      if (!this.areSameEmployeeName(activeState.holder, histState.holder)) {
        mismatched = true;
      }
    }

    if (!mismatched) return null;

    return {
      activeState,
      histState,
      activeDate: String(activeRecord[activeDateH] || activeRecord['Date Assigned'] || activeRecord['Date'] || '').trim(),
      histDate: String(latestHistRow[histDateH] || latestHistRow['Date Assigned'] || latestHistRow['Date'] || '').trim(),
      histRow: latestHistRow
    };
  }

  getPendingEmployeesMap() {
    const empTable = this.db ? this.db.getTable('employees') : null;
    const pendingMap = new Map();
    if (!empTable || !empTable.rows) return pendingMap;

    const today = new Date();
    const todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    empTable.rows.forEach(r => {
      const name = String(r['Employee Name'] || r['Name'] || Object.values(r)[0] || '').trim().toLowerCase();
      if (!name) return;
      const stat = String(r['Status'] || '').trim().toLowerCase();
      const hireDateStr = String(r['Hire Date'] || r['Hire'] || '').trim();
      const hireDateNum = this.toDateNum(hireDateStr);

      const isPending = stat === 'pending' || (hireDateNum > todayNum);
      if (isPending) {
        pendingMap.set(name, { hireDateNum, status: stat });
        const altNames = String(r['Alternate Names'] || '').trim();
        if (altNames) {
          altNames.split(/[;,/|]+/).forEach(alt => {
            const cleanAlt = alt.trim().toLowerCase();
            if (cleanAlt) pendingMap.set(cleanAlt, { hireDateNum, status: stat });
          });
        }
      }
    });

    return pendingMap;
  }

  /**
   * Ultra-fast single-pass calculation of discrepancy counts across all equipment tables (~3-5ms total)
   */
  refreshCountsFast() {
    const today = new Date();
    const todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate() + 1;
    const pendingEmpMap = this.getPendingEmployeesMap();

    const counts = {};
    const breakdown = {};
    for (const eq of this.equipmentList) {
      const table = this.db ? this.db.getTable(eq.histKey) : null;
      if (!table || !table.rows || table.rows.length === 0) {
        counts[eq.key] = 0;
        breakdown[eq.key] = { dupeItems: 0, futureItems: 0, mismatchItems: 0 };
        continue;
      }

      const activeTable = this.db ? this.db.getTable(eq.key) : null;
      const activeMap = new Map();
      if (activeTable && activeTable.rows && activeTable.rows.length > 0) {
        const actHeaders = activeTable.headers || [];
        for (let i = 0; i < activeTable.rows.length; i++) {
          const ar = activeTable.rows[i];
          const rawId = this.extractItemKey(ar, actHeaders, eq.key);
          if (rawId) activeMap.set(this.normalizeItemStr(rawId), ar);
        }
      }

      const headers = table.headers || [];
      let dateH = headers.find(h => /^(date|action)/i.test(h)) || 'Date Assigned';
      let assignedH = headers.find(h => /^(assigned|employee|holder)/i.test(h)) || 'Assigned To';

      const itemIssues = new Set();
      const dupeItems = new Set();
      const futureItems = new Set();
      const mismatchItems = new Set();
      const seenExact = new Set();
      const latestByItem = new Map();

      for (let i = 0; i < table.rows.length; i++) {
        const r = table.rows[i];
        const rawItem = this.extractItemKey(r, headers, eq.key);
        if (!rawItem) continue;
        const normItem = this.normalizeItemStr(rawItem);

        const dRaw = String(r[dateH] || r['Date Assigned'] || r['Date'] || '').trim();
        const dNum = this.toDateNum(dRaw);
        const aRaw = String(r[assignedH] || r['Assigned To'] || '').trim().toLowerCase();
        const cleanHolder = this.cleanHolderName(aRaw);

        if (dNum > todayNum && !pendingEmpMap.has(cleanHolder)) {
          itemIssues.add(normItem);
          futureItems.add(normItem);
        } else if (activeMap.has(normItem)) {
          const st = this.classifyStateForCompare(r, false);
          const prevLatest = latestByItem.get(normItem);
          if (!prevLatest || dNum > prevLatest.dNum || (dNum === prevLatest.dNum && st.rank > prevLatest.rank)) {
            latestByItem.set(normItem, { dNum, rank: st.rank, row: r });
          }
        }

        const dNorm = this.normalizeDateStr(dRaw);
        const k = `${normItem}::${dNorm}::${aRaw}`;
        if (seenExact.has(k)) {
          itemIssues.add(normItem);
          dupeItems.add(normItem);
        } else {
          seenExact.add(k);
        }
      }

      if (activeMap.size > 0 && latestByItem.size > 0) {
        const actHeaders = (activeTable && activeTable.headers) || [];
        const actDateH = actHeaders.find(h => /date\s*assigned|^date$/i.test(h)) || 'Date Assigned';
        latestByItem.forEach((latestEntry, normItem) => {
          const activeRecord = activeMap.get(normItem);
          if (!activeRecord) return;
          if (this.detectActiveHistoryMismatch(activeRecord, latestEntry.row, actDateH, dateH)) {
            itemIssues.add(normItem);
            mismatchItems.add(normItem);
          }
        });
      }

      counts[eq.key] = itemIssues.size;
      breakdown[eq.key] = {
        dupeItems: dupeItems.size,
        futureItems: futureItems.size,
        mismatchItems: mismatchItems.size
      };
    }

    this.cachedCounts = counts;
    this.cachedTypeBreakdown = breakdown;
    return counts;
  }

  /**
   * O(1) Instant lookup of item count for tab badges and toolbar buttons
   */
  getEquipmentItemCount(key) {
    const meta = this.getEquipmentMeta(key);
    if (!meta) return 0;
    if (!this.cachedCounts) {
      this.refreshCountsFast();
    }
    return this.cachedCounts[meta.key] || 0;
  }

  /**
   * Lazily loads full discrepancy details for a specific equipment tab only when the user opens the modal
   */
  getEquipmentDetails(key) {
    const meta = this.getEquipmentMeta(key);
    if (!meta) return { equipment: null, itemCount: 0, totalIssues: 0, items: [] };

    if (this.cachedDetails.has(meta.key)) {
      return this.cachedDetails.get(meta.key);
    }

    const histTable = this.db ? this.db.getTable(meta.histKey) : null;
    const activeTable = this.db ? this.db.getTable(meta.key) : null;

    if (!histTable || !histTable.rows || histTable.rows.length === 0) {
      const emptyResult = { equipment: meta, itemCount: 0, totalIssues: 0, items: [] };
      this.cachedDetails.set(meta.key, emptyResult);
      return emptyResult;
    }

    const headers = histTable.headers || [];
    let dateH = headers.find(h => /^(date|action)/i.test(h)) || 'Date Assigned';
    let assignedH = headers.find(h => /^(assigned|employee|holder)/i.test(h)) || 'Assigned To';
    let locH = headers.find(h => /^location$/i.test(h)) || 'Location';
    let notesH = headers.find(h => /^(notes|comment)/i.test(h)) || 'Notes';

    // Fast active table index
    const activeMap = new Map();
    let actDateH = 'Date Assigned';
    if (activeTable && activeTable.rows) {
      const actHeaders = activeTable.headers || [];
      actDateH = actHeaders.find(h => /date\s*assigned|^date$/i.test(h)) || 'Date Assigned';
      activeTable.rows.forEach(r => {
        const val = this.extractItemKey(r, actHeaders, meta.key);
        if (val) activeMap.set(this.normalizeItemStr(val), r);
      });
    }

    // Group history rows by item
    const itemGroups = new Map();
    for (let i = 0; i < histTable.rows.length; i++) {
      const r = histTable.rows[i];
      const rawItem = this.extractItemKey(r, headers, meta.key);
      if (!rawItem) continue;
      const normItem = this.normalizeItemStr(rawItem);
      if (!itemGroups.has(normItem)) {
        itemGroups.set(normItem, { displayItem: rawItem, rows: [] });
      }
      itemGroups.get(normItem).rows.push(r);
    }

    const today = new Date();
    const todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate() + 1;
    const pendingEmpMap = this.getPendingEmployeesMap();
    const itemsWithIssues = [];
    let totalIssuesAcrossTable = 0;

    itemGroups.forEach(({ displayItem, rows }) => {
      const normItem = this.normalizeItemStr(displayItem);
      const activeRecord = activeMap.get(normItem) || null;
      const discrepancies = [];
      let dupeCount = 0;
      let futureCount = 0;
      let consecCount = 0;
      let mismatchCount = 0;

      // 1. Future dates (excluding intentional pre-assignments for pending new hires)
      const futureRows = [];
      for (const r of rows) {
        const dNum = this.toDateNum(r[dateH] || r['Date Assigned']);
        if (dNum > todayNum) {
          const rawHolder = String(r[assignedH] || r['Assigned To'] || '');
          const cleanHolder = this.cleanHolderName(rawHolder);
          if (!pendingEmpMap.has(cleanHolder)) {
            futureRows.push(r);
          }
        }
      }
      if (futureRows.length > 0) {
        futureCount = futureRows.length;
        discrepancies.push({
          type: 'FUTURE_DATE',
          severity: 'danger',
          label: 'Future Date Anomaly',
          count: futureCount,
          summary: `${futureCount} history ${futureCount === 1 ? 'record is' : 'records are'} dated in the future`,
          details: futureRows.map(r => ({
            date: r[dateH] || r['Date Assigned'] || 'Unknown Date',
            holder: r[assignedH] || r['Assigned To'] || 'Unknown',
            location: r[locH] || r['Location'] || '',
            notes: r[notesH] || r['Notes'] || ''
          }))
        });
      }

      // 2. Exact duplicates
      const seenExact = new Map();
      for (const r of rows) {
        const dNorm = this.normalizeDateStr(r[dateH] || r['Date Assigned'] || r['Date']);
        const aNorm = String(r[assignedH] || r['Assigned To'] || '').trim().toLowerCase();
        const k = `${dNorm}::${aNorm}`;
        if (!seenExact.has(k)) seenExact.set(k, []);
        seenExact.get(k).push(r);
      }

      seenExact.forEach((dupeRows) => {
        if (dupeRows.length > 1) {
          const redundant = dupeRows.length - 1;
          dupeCount += redundant;
          const holderName = dupeRows[0][assignedH] || dupeRows[0]['Assigned To'] || 'Unknown';
          const dateVal = dupeRows[0][dateH] || dupeRows[0]['Date Assigned'] || 'Unknown Date';
          discrepancies.push({
            type: 'DUPLICATE_RECORDS',
            severity: 'warning',
            label: 'Duplicate History Records',
            count: redundant,
            summary: `${redundant} redundant ${redundant === 1 ? 'entry' : 'entries'} for same holder "${holderName}" on ${dateVal} (logging 0 days)`,
            date: dateVal,
            holder: holderName,
            details: dupeRows.map(r => ({
              date: r[dateH] || r['Date Assigned'] || dateVal,
              holder: r[assignedH] || r['Assigned To'] || holderName,
              location: r[locH] || r['Location'] || '',
              notes: r[notesH] || r['Notes'] || ''
            }))
          });
        }
      });

      // 3. Consecutive back-to-back entries
      if (rows.length > 1) {
        const sorted = [...rows].sort((a, b) => this.toDateNum(a[dateH] || a['Date Assigned']) - this.toDateNum(b[dateH] || b['Date Assigned']));
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1];
          const cur = sorted[i];
          const prevA = String(prev[assignedH] || prev['Assigned To'] || '').trim().toLowerCase();
          const curA = String(cur[assignedH] || cur['Assigned To'] || '').trim().toLowerCase();
          const prevD = this.normalizeDateStr(prev[dateH] || prev['Date Assigned']);
          const curD = this.normalizeDateStr(cur[dateH] || cur['Date Assigned']);

          if (prevA === curA && prevD !== curD && prevA) {
            consecCount++;
            const holderName = cur[assignedH] || cur['Assigned To'] || curA;
            discrepancies.push({
              type: 'CONSECUTIVE_DUPLICATES',
              severity: 'info',
              label: 'Consecutive Duplicate Assignments',
              count: 1,
              summary: `Consecutive back-to-back entries for "${holderName}" (${prevD} and ${curD}) without intervening status change`,
              details: [
                { date: prevD, holder: holderName, location: prev[locH] || '', notes: prev[notesH] || '' },
                { date: curD, holder: holderName, location: cur[locH] || '', notes: cur[notesH] || '' }
              ]
            });
          }
        }
      }

      // 4. Active Inventory vs. Latest History mismatch
      if (activeRecord) {
        const latestHist = this.getLatestHistoryRowForCompare(rows, pendingEmpMap, dateH, assignedH);
        const mismatch = this.detectActiveHistoryMismatch(activeRecord, latestHist, actDateH, dateH);
        if (mismatch) {
          mismatchCount = 1;
          discrepancies.push({
            type: 'ACTIVE_MISMATCH',
            severity: 'danger',
            label: 'Active vs. History Mismatch',
            count: 1,
            summary: `History shows "${mismatch.histState.displayLabel}"${mismatch.histDate ? ` (${mismatch.histDate})` : ''}, but Active ${meta.label} sheet shows "${mismatch.activeState.displayLabel}"${mismatch.activeDate ? ` (${mismatch.activeDate})` : ''}`,
            details: [
              {
                date: mismatch.activeDate || 'Current',
                holder: `Active Sheet: ${mismatch.activeState.displayLabel}`,
                location: activeRecord['Location'] || '',
                notes: activeRecord['Notes'] || ''
              },
              {
                date: mismatch.histDate || 'Unknown Date',
                holder: `Latest History: ${mismatch.histState.displayLabel}`,
                location: latestHist[locH] || latestHist['Location'] || '',
                notes: latestHist[notesH] || latestHist['Notes'] || ''
              }
            ]
          });
        }
      }

      if (discrepancies.length > 0) {
        const totalItemDiscrepancies = dupeCount + futureCount + consecCount + mismatchCount;
        totalIssuesAcrossTable += totalItemDiscrepancies;

        const firstHist = rows[0] || {};
        const metaValues = {};
        ['size', 'class', 'type', 'kv', 'model', 'length'].forEach(f => {
          let val = '';
          if (activeRecord) {
            for (const k of Object.keys(activeRecord)) {
              if (k.toLowerCase() === f && activeRecord[k]) {
                val = String(activeRecord[k]).trim();
                break;
              }
            }
          }
          if (!val && firstHist) {
            for (const k of Object.keys(firstHist)) {
              if (k.toLowerCase() === f && firstHist[k]) {
                val = String(firstHist[k]).trim();
                break;
              }
            }
          }
          if (val) metaValues[f] = val;
        });

        itemsWithIssues.push({
          itemKey: displayItem,
          cleanItemKey: displayItem,
          equipmentKey: meta.key,
          equipmentLabel: meta.label,
          equipmentIcon: meta.icon,
          histKey: meta.histKey,
          totalDiscrepancyCount: totalItemDiscrepancies,
          dupeCount,
          futureCount,
          consecCount,
          mismatchCount,
          metaValues,
          activeInfo: activeRecord ? {
            status: activeRecord['Status'] || 'On Shelf',
            assignedTo: activeRecord['Assigned To'] || 'On Shelf',
            location: activeRecord['Location'] || 'Helena',
            testDate: activeRecord['Test Date'] || activeRecord['Calibration Date'] || ''
          } : null,
          discrepancies
        });
      }
    });

    itemsWithIssues.sort((a, b) => {
      const numA = parseInt(a.itemKey, 10);
      const numB = parseInt(b.itemKey, 10);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.itemKey.localeCompare(b.itemKey);
    });

    const result = {
      equipment: meta,
      itemCount: itemsWithIssues.length,
      totalIssues: totalIssuesAcrossTable,
      items: itemsWithIssues
    };

    this.cachedDetails.set(meta.key, result);
    return result;
  }

  /**
   * Surgically updates badge elements on existing tab buttons without recreating the DOM
   */
  updateTabBadges() {
    if (!this.cachedCounts) {
      this.refreshCountsFast();
    }

    const updateBar = (barId, isHistory) => {
      const bar = document.getElementById(barId);
      if (!bar) return;

      this.equipmentList.forEach(eq => {
        const targetKey = isHistory ? eq.histKey : eq.key;
        const count = this.cachedCounts[eq.key] || 0;
        const btn = bar.querySelector(`button.sheet-tab-btn[data-sheet-key="${targetKey}"]`);

        if (btn) {
          let badge = btn.querySelector('.tab-history-issues-badge');
          if (count > 0) {
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'tab-history-issues-badge';
              badge.onclick = (e) => {
                e.stopPropagation();
                this.openHistoryIssuesModal(eq.key);
              };
              btn.appendChild(badge);
            }
            badge.innerHTML = `⚠️ ${count}`;
            badge.title = `${count} ${eq.label} items with history discrepancies (Click to inspect)`;
            badge.style.display = 'inline-flex';
          } else if (badge) {
            badge.style.display = 'none';
          }
        }
      });
    };

    updateBar('sheet-tabs-bar', false);
    updateBar('history-tabs-bar', true);
  }

  /**
   * Fast toolbar & banner update on active sheet (O(1) lookups)
   */
  updateActiveSheetUI(currentKey = null) {
    const curSheet = currentKey || (window.sheetNavigator ? window.sheetNavigator.currentSheetKey : null);
    const meta = this.getEquipmentMeta(curSheet);

    const btnToolbar = document.getElementById('btn-history-issues');
    const bannerContainer = document.getElementById('history-issues-banner-container');

    if (!meta || !curSheet) {
      if (btnToolbar) btnToolbar.style.display = 'none';
      if (bannerContainer) bannerContainer.style.display = 'none';
      return;
    }

    const count = this.getEquipmentItemCount(meta.key);

    if (btnToolbar) {
      if (count > 0) {
        btnToolbar.style.display = 'inline-flex';
        btnToolbar.innerHTML = `<span>⚠️</span> ${count} History ${count === 1 ? 'Issue' : 'Issues'}`;
        btnToolbar.title = `View ${count} items in ${meta.label} with duplicate history records or discrepancies`;
        btnToolbar.onclick = () => this.openHistoryIssuesModal(meta.key);
      } else {
        btnToolbar.style.display = 'none';
      }
    }

    if (bannerContainer) {
      if (count > 0) {
        const bd = (this.cachedTypeBreakdown && this.cachedTypeBreakdown[meta.key]) || { dupeItems: 0, futureItems: 0, mismatchItems: 0 };
        const parts = [];
        if (bd.dupeItems > 0) parts.push(`${bd.dupeItems} duplicate`);
        if (bd.mismatchItems > 0) parts.push(`${bd.mismatchItems} active vs. history ${bd.mismatchItems === 1 ? 'mismatch' : 'mismatches'}`);
        if (bd.futureItems > 0) parts.push(`${bd.futureItems} future date`);
        const summaryText = parts.length > 0
          ? `Found ${parts.join(', ')} in ${meta.label} History.`
          : `Found duplicate history records or discrepancies in ${meta.label} History.`;

        bannerContainer.style.display = 'block';
        bannerContainer.innerHTML = `
          <div class="history-issues-sheet-banner">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <span style="font-size: 18px;">⚠️</span>
              <div>
                <strong>${meta.icon} ${meta.label} History Issues Detected (${count} ${count === 1 ? 'item' : 'items'}):</strong>
                <span style="opacity: 0.9; margin-left: 4px;">${this.escapeHtml(summaryText)}</span>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto;">
              <button class="btn btn-sm" style="font-size: 11px; font-weight: 700; background: rgba(245, 158, 11, 0.25); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.5); padding: 5px 12px; border-radius: 6px; cursor: pointer;" onclick="window.historyIssuesEngine.openHistoryIssuesModal('${meta.key}')">
                🔍 View ${count} Affected ${count === 1 ? 'Item' : 'Items'} & Discrepancies
              </button>
              ${bd.mismatchItems > 0 ? `
                <button class="btn btn-sm" style="font-size: 11px; font-weight: 700; background: #3b82f6; color: #ffffff; border: none; padding: 5px 12px; border-radius: 6px; cursor: pointer;" onclick="window.historyIssuesEngine.resolveEquipmentMismatches('${meta.key}')">
                  🔄 Sync ${bd.mismatchItems} ${bd.mismatchItems === 1 ? 'Mismatch' : 'Mismatches'} in ${meta.label}
                </button>
              ` : ''}
              ${(bd.dupeItems > 0 || bd.mismatchItems === 0) ? `
                <button class="btn btn-sm" style="font-size: 11px; font-weight: 700; background: #f59e0b; color: #1e293b; border: none; padding: 5px 12px; border-radius: 6px; cursor: pointer;" onclick="window.historyIssuesEngine.cleanEquipmentDuplicates('${meta.key}')">
                  🧹 Clean All Duplicates in ${meta.label}
                </button>
              ` : ''}
            </div>
          </div>
        `;
      } else {
        bannerContainer.style.display = 'none';
        bannerContainer.innerHTML = '';
      }
    }

    const btnHistToolbar = document.getElementById('btn-history-issues-hist');
    if (btnHistToolbar) {
      const curHistSheet = window.historyNavigator ? window.historyNavigator.currentSheetKey : null;
      const histMeta = this.getEquipmentMeta(curHistSheet);
      if (histMeta) {
        const histCount = this.getEquipmentItemCount(histMeta.key);
        if (histCount > 0) {
          btnHistToolbar.style.display = 'inline-flex';
          btnHistToolbar.innerHTML = `<span>⚠️</span> View ${histCount} Issues`;
          btnHistToolbar.title = `View items with discrepancies in ${histMeta.label} History`;
          btnHistToolbar.onclick = () => this.openHistoryIssuesModal(histMeta.key);
        } else {
          btnHistToolbar.style.display = 'none';
        }
      } else {
        btnHistToolbar.style.display = 'none';
      }
    }
  }

  /**
   * Opens the Equipment History Issues & Discrepancies Modal
   */
  openHistoryIssuesModal(initialEquipmentKey = 'gloves') {
    const meta = this.getEquipmentMeta(initialEquipmentKey);
    this.currentModalCategory = meta ? meta.key : 'all';
    this.searchTerm = '';
    this.typeFilter = 'all';
    this.modalPageLimit = 25; // Reset page limit for instant rendering

    const modal = document.getElementById('history-issues-modal');
    if (!modal) {
      this.ensureModalInDOM();
    }

    this.renderModalContent();

    const m = document.getElementById('history-issues-modal');
    if (m) {
      m.classList.add('active');
    }
  }

  closeHistoryIssuesModal() {
    const m = document.getElementById('history-issues-modal');
    if (m) m.classList.remove('active');
  }

  setModalCategory(categoryKey) {
    this.currentModalCategory = categoryKey;
    this.modalPageLimit = 25;

    const modalBody = document.getElementById('history-issues-modal-content');
    if (!modalBody || !modalBody.querySelector('.history-issues-cat-tabs')) {
      this.renderModalContent();
      return;
    }

    // Fast-path: Just toggle active classes on the category pills
    const pills = modalBody.querySelectorAll('.history-issues-cat-pill');
    pills.forEach(pill => {
      const isPillAll = pill.getAttribute('onclick')?.includes("'all'");
      if (this.currentModalCategory === 'all') {
        pill.classList.toggle('active', Boolean(isPillAll));
      } else {
        pill.classList.toggle('active', !isPillAll && Boolean(pill.getAttribute('onclick')?.includes(`'${this.currentModalCategory}'`)));
      }
    });

    // Update single-table clean & sync buttons
    const isAll = this.currentModalCategory === 'all';
    const activeMeta = isAll ? null : this.getEquipmentMeta(this.currentModalCategory);
    const singleCleanBtn = document.getElementById('btn-clean-single-category');
    if (singleCleanBtn) {
      if (!isAll && activeMeta) {
        singleCleanBtn.style.display = 'inline-flex';
        singleCleanBtn.innerHTML = `🧹 Clean All in ${activeMeta.label}`;
        singleCleanBtn.onclick = () => this.cleanEquipmentDuplicates(activeMeta.key);
      } else {
        singleCleanBtn.style.display = 'none';
      }
    }
    const singleSyncBtn = document.getElementById('btn-sync-mismatches-single-category');
    if (singleSyncBtn) {
      const bd = (!isAll && activeMeta && this.cachedTypeBreakdown) ? this.cachedTypeBreakdown[activeMeta.key] : null;
      if (!isAll && activeMeta && bd && bd.mismatchItems > 0) {
        singleSyncBtn.style.display = 'inline-flex';
        singleSyncBtn.innerHTML = `🔄 Sync ${bd.mismatchItems} ${bd.mismatchItems === 1 ? 'Mismatch' : 'Mismatches'} in ${activeMeta.label}`;
        singleSyncBtn.onclick = () => this.resolveEquipmentMismatches(activeMeta.key);
      } else {
        singleSyncBtn.style.display = 'none';
      }
    }

    this.renderItemsListOnly();
  }

  setModalTypeFilter(filterType) {
    this.typeFilter = filterType;
    this.modalPageLimit = 25;

    const modalBody = document.getElementById('history-issues-modal-content');
    if (!modalBody) return;

    // Fast-path: Just toggle active classes on filter pills
    const pills = modalBody.querySelectorAll('.history-issues-summary-bar .filter-pill');
    pills.forEach(pill => {
      pill.classList.toggle('active', Boolean(pill.getAttribute('onclick')?.includes(`'${this.typeFilter}'`)));
    });

    this.renderItemsListOnly();
  }

  handleSearchInput(val) {
    clearTimeout(this._searchDebounceTimer);
    this._searchDebounceTimer = setTimeout(() => {
      this.searchTerm = String(val || '').toLowerCase().trim();
      this.modalPageLimit = 25;
      this.renderItemsListOnly();
    }, 120);
  }

  renderModalContent() {
    const modalBody = document.getElementById('history-issues-modal-content');
    if (!modalBody) return;

    if (!this.cachedCounts) this.refreshCountsFast();

    const isAll = this.currentModalCategory === 'all';
    const activeMeta = isAll ? null : this.getEquipmentMeta(this.currentModalCategory);

    // Build category tabs HTML
    let tabsHtml = `<div class="history-issues-cat-tabs">`;
    let totalAll = 0;
    this.equipmentList.forEach(eq => {
      const count = this.cachedCounts[eq.key] || 0;
      totalAll += count;
      const isActive = !isAll && eq.key === this.currentModalCategory;
      tabsHtml += `
        <button class="history-issues-cat-pill ${isActive ? 'active' : ''}" onclick="window.historyIssuesEngine.setModalCategory('${eq.key}')">
          <span>${eq.icon}</span> ${eq.label}
          <span class="cat-count-badge ${count > 0 ? 'has-issues' : 'clean'}">${count}</span>
        </button>
      `;
    });

    tabsHtml += `
      <button class="history-issues-cat-pill ${isAll ? 'active' : ''}" style="margin-left: auto;" onclick="window.historyIssuesEngine.setModalCategory('all')">
        <span>🌐</span> All Equipment
        <span class="cat-count-badge ${totalAll > 0 ? 'has-issues' : 'clean'}">${totalAll}</span>
      </button>
    </div>`;

    modalBody.innerHTML = `
      <!-- Category Switcher Tabs -->
      ${tabsHtml}

      <!-- Top Summary & Batch Controls Bar -->
      <div class="history-issues-summary-bar">
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <input type="text" id="history-issues-search-input" class="form-control" style="max-width: 280px; padding: 6px 12px; font-size: 12px;" placeholder="🔍 Filter by Item # or Holder..." value="${this.escapeHtml(this.searchTerm)}" oninput="window.historyIssuesEngine.handleSearchInput(this.value)">

          <!-- Type filter buttons -->
          <div class="filter-pills" style="margin-bottom: 0;">
            <button class="filter-pill ${this.typeFilter === 'all' ? 'active' : ''}" onclick="window.historyIssuesEngine.setModalTypeFilter('all')">All</button>
            <button class="filter-pill ${this.typeFilter === 'mismatch' ? 'active' : ''}" onclick="window.historyIssuesEngine.setModalTypeFilter('mismatch')">⚡ Active Mismatches</button>
            <button class="filter-pill ${this.typeFilter === 'duplicate' ? 'active' : ''}" onclick="window.historyIssuesEngine.setModalTypeFilter('duplicate')">🧹 Duplicates</button>
            <button class="filter-pill ${this.typeFilter === 'future' ? 'active' : ''}" onclick="window.historyIssuesEngine.setModalTypeFilter('future')">📅 Future Dates</button>
            <button class="filter-pill ${this.typeFilter === 'consecutive' ? 'active' : ''}" onclick="window.historyIssuesEngine.setModalTypeFilter('consecutive')">🔄 Consecutive</button>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap;">
          ${(() => {
            const bd = (!isAll && activeMeta && this.cachedTypeBreakdown) ? this.cachedTypeBreakdown[activeMeta.key] : null;
            const hasMismatches = Boolean(!isAll && activeMeta && bd && bd.mismatchItems > 0);
            const mCount = hasMismatches ? bd.mismatchItems : 0;
            return `<button id="btn-sync-mismatches-single-category" class="btn btn-secondary" style="font-size: 11.5px; font-weight: 700; color: #93c5fd; border-color: rgba(59, 130, 246, 0.55); background: rgba(59, 130, 246, 0.16); ${hasMismatches ? 'display: inline-flex;' : 'display: none;'}" onclick="${activeMeta ? `window.historyIssuesEngine.resolveEquipmentMismatches('${activeMeta.key}')` : ''}">🔄 Sync ${mCount} ${mCount === 1 ? 'Mismatch' : 'Mismatches'} in ${activeMeta ? activeMeta.label : ''}</button>`;
          })()}
          <button id="btn-clean-single-category" class="btn btn-secondary" style="font-size: 11.5px; font-weight: 700; color: #fbbf24; border-color: rgba(245, 158, 11, 0.5); background: rgba(245, 158, 11, 0.12); ${(!isAll && activeMeta) ? 'display: inline-flex;' : 'display: none;'}" onclick="${activeMeta ? `window.historyIssuesEngine.cleanEquipmentDuplicates('${activeMeta.key}')` : ''}">
            🧹 Clean All in ${activeMeta ? activeMeta.label : ''}
          </button>
          <button class="btn btn-secondary" style="font-size: 11.5px; font-weight: 700; color: #38bdf8; border-color: rgba(56, 189, 248, 0.4);" onclick="window.historyIssuesEngine.cleanAllEquipmentDuplicates()">
            ⚡ Clean All Tables
          </button>
          <button class="btn btn-secondary" style="font-size: 11.5px; padding: 6px 10px;" onclick="window.historyIssuesEngine.invalidateCache(); window.historyIssuesEngine.renderModalContent();" title="Re-scan database">
            🔄 Refresh
          </button>
        </div>
      </div>

      <!-- Items List Container -->
      <div id="history-issues-items-container" class="history-issues-items-list"></div>
    `;

    this.renderItemsListOnly();
  }

  /**
   * Fast chunked rendering of items with pagination to ensure 0ms render lag
   */
  renderItemsListOnly() {
    const container = document.getElementById('history-issues-items-container');
    if (!container) return;

    const isAll = this.currentModalCategory === 'all';
    let itemsToDisplay = [];

    if (isAll) {
      this.equipmentList.forEach(eq => {
        const scan = this.getEquipmentDetails(eq.key);
        itemsToDisplay.push(...scan.items);
      });
    } else {
      const scan = this.getEquipmentDetails(this.currentModalCategory);
      itemsToDisplay = [...scan.items];
    }

    // Apply type filter
    if (this.typeFilter === 'mismatch') {
      itemsToDisplay = itemsToDisplay.filter(i => i.mismatchCount > 0);
    } else if (this.typeFilter === 'duplicate') {
      itemsToDisplay = itemsToDisplay.filter(i => i.dupeCount > 0);
    } else if (this.typeFilter === 'future') {
      itemsToDisplay = itemsToDisplay.filter(i => i.futureCount > 0);
    } else if (this.typeFilter === 'consecutive') {
      itemsToDisplay = itemsToDisplay.filter(i => i.consecCount > 0);
    }

    // Apply search filter
    if (this.searchTerm) {
      itemsToDisplay = itemsToDisplay.filter(i => {
        if (i.itemKey.toLowerCase().includes(this.searchTerm)) return true;
        if (i.equipmentLabel.toLowerCase().includes(this.searchTerm)) return true;
        for (const d of i.discrepancies) {
          if (d.summary.toLowerCase().includes(this.searchTerm)) return true;
          for (const det of (d.details || [])) {
            if (String(det.holder || '').toLowerCase().includes(this.searchTerm)) return true;
            if (String(det.notes || '').toLowerCase().includes(this.searchTerm)) return true;
          }
        }
        return false;
      });
    }

    if (itemsToDisplay.length === 0) {
      const eqMeta = isAll ? null : this.getEquipmentMeta(this.currentModalCategory);
      container.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
          <div style="font-size: 32px; margin-bottom: 8px;">✨</div>
          <h4 style="color: #34d399; font-size: 15px; font-weight: 700; margin-bottom: 4px;">
            ${this.searchTerm ? 'No matching items found' : `No history discrepancies in ${eqMeta ? eqMeta.label : 'Equipment'}`}
          </h4>
          <p style="font-size: 12.5px; max-width: 480px; margin: 0 auto; line-height: 1.4;">
            ${this.searchTerm ? 'Try adjusting your search filter or discrepancy type filter above.' : 'All history records for this equipment category are cleanly tracked without duplicate or conflicting entries.'}
          </p>
        </div>
      `;
      return;
    }

    const totalCount = itemsToDisplay.length;
    const paginatedItems = itemsToDisplay.slice(0, this.modalPageLimit);

    let listHtml = '';
    paginatedItems.forEach(item => {
      const metaChips = [];
      if (item.metaValues) {
        Object.entries(item.metaValues).forEach(([k, v]) => {
          metaChips.push(`<span class="brand-badge" style="font-size: 11px;">${k.toUpperCase()}: ${this.escapeHtml(v)}</span>`);
        });
      }

      let activeChip = '';
      if (item.activeInfo) {
        activeChip = `
          <span class="brand-badge" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35); font-size: 11px;" title="Current active inventory assignment">
            <span>📦</span> Active: ${this.escapeHtml(item.activeInfo.assignedTo)} (${this.escapeHtml(item.activeInfo.status)})
          </span>
        `;
      }

      let discHtml = '';
      item.discrepancies.forEach(d => {
        let icon = '⚠️';
        let bg = 'rgba(245, 158, 11, 0.12)';
        let border = 'rgba(245, 158, 11, 0.35)';
        let textColor = '#fcd34d';

        if (d.type === 'DUPLICATE_RECORDS') {
          icon = '🧹';
          bg = 'rgba(245, 158, 11, 0.14)';
          border = 'rgba(245, 158, 11, 0.45)';
          textColor = '#fcd34d';
        } else if (d.type === 'FUTURE_DATE') {
          icon = '📅';
          bg = 'rgba(239, 68, 68, 0.14)';
          border = 'rgba(239, 68, 68, 0.45)';
          textColor = '#fca5a5';
        } else if (d.type === 'ACTIVE_MISMATCH') {
          icon = '⚡';
          bg = 'rgba(239, 68, 68, 0.14)';
          border = 'rgba(239, 68, 68, 0.45)';
          textColor = '#fca5a5';
        } else if (d.type === 'CONSECUTIVE_DUPLICATES') {
          icon = '🔄';
          bg = 'rgba(56, 189, 248, 0.1)';
          border = 'rgba(56, 189, 248, 0.35)';
          textColor = '#7dd3fc';
        }

        let detailsLines = '';
        if (d.details && d.details.length > 0) {
          detailsLines = d.details.map((det, idx) => `
            <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 3px; padding-left: 10px; border-left: 2px solid ${border}; line-height: 1.35;">
              <strong style="color: var(--text-primary);">Entry ${idx + 1} (${this.escapeHtml(det.date)}):</strong> Holder: <strong>${this.escapeHtml(det.holder)}</strong> ${det.location ? `(${this.escapeHtml(det.location)})` : ''}
              ${det.notes ? `<div style="font-style: italic; color: #94a3b8;">Notes: "${this.escapeHtml(det.notes)}"</div>` : ''}
            </div>
          `).join('');
        }

        discHtml += `
          <div style="background: ${bg}; border: 1px solid ${border}; border-radius: 6px; padding: 8px 12px; margin-top: 6px;">
            <div style="display: flex; align-items: flex-start; gap: 8px;">
              <span style="font-size: 15px; line-height: 1.2;">${icon}</span>
              <div style="flex: 1;">
                <div style="font-size: 12px; font-weight: 700; color: ${textColor}; line-height: 1.35;">
                  ${this.escapeHtml(d.summary)}
                </div>
                ${detailsLines}
              </div>
            </div>
          </div>
        `;
      });

      listHtml += `
        <div class="history-issue-card" id="history-issue-item-${this.escapeHtml(item.equipmentKey)}-${this.escapeHtml(item.cleanItemKey)}">
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 6px;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="font-size: 16px;">${item.equipmentIcon}</span>
              <span style="font-size: 14.5px; font-weight: 800; color: var(--text-primary); cursor: pointer; text-decoration: underline dotted;" onclick="if(window.itemStatsEngine){window.itemStatsEngine.openDossierModal('${this.escapeJs(item.cleanItemKey)}', '${this.escapeJs(item.histKey)}');}" title="Click to view lifecycle dossier">
                ${item.equipmentLabel} #${item.itemKey}
              </span>
              <span class="cat-count-badge has-issues" style="font-size: 10px;">⚠️ ${item.totalDiscrepancyCount} ${item.totalDiscrepancyCount === 1 ? 'discrepancy' : 'discrepancies'}</span>
              ${metaChips.join('')}
              ${activeChip}
            </div>

            <div style="display: flex; align-items: center; gap: 8px; margin-left: auto;">
              ${item.mismatchCount > 0 ? `
                <button class="btn btn-sm" style="font-size: 11px; font-weight: 700; background: rgba(59, 130, 246, 0.22); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.55); padding: 4px 10px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="window.historyIssuesEngine.resolveItemMismatch('${this.escapeJs(item.equipmentKey)}', '${this.escapeJs(item.cleanItemKey)}')">
                  <span>🔄</span> Sync History to Active
                </button>
              ` : ''}
              ${(item.dupeCount > 0 || item.mismatchCount === 0) ? `
                <button class="btn btn-sm" style="font-size: 11px; font-weight: 700; background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.5); padding: 4px 10px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="window.historyIssuesEngine.cleanItemDuplicates('${this.escapeJs(item.equipmentKey)}', '${this.escapeJs(item.cleanItemKey)}')">
                  <span>🧹</span> Clean Duplicates
                </button>
              ` : ''}
              <button class="btn btn-sm btn-secondary" style="font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="if(window.itemStatsEngine){window.itemStatsEngine.openDossierModal('${this.escapeJs(item.cleanItemKey)}', '${this.escapeJs(item.histKey)}');}">
                <span>📖</span> Open Dossier
              </button>
            </div>
          </div>

          <!-- Discrepancy Breakdown -->
          ${discHtml}
        </div>
      `;
    });

    if (totalCount > this.modalPageLimit) {
      listHtml += `
        <div style="text-align: center; padding: 14px; margin-top: 6px;">
          <button class="btn btn-secondary" style="font-size: 12px; font-weight: 700; padding: 8px 20px;" onclick="window.historyIssuesEngine.loadMoreModalItems()">
            ⬇️ Show More Items (Showing ${paginatedItems.length} of ${totalCount})
          </button>
        </div>
      `;
    }

    container.innerHTML = listHtml;
  }

  loadMoreModalItems() {
    this.modalPageLimit += 25;
    this.renderItemsListOnly();
  }

  /**
   * Syncs a single item's history record to match its current Active Inventory state/holder.
   */
  async _syncSingleItemHistoryToActive(meta, activeRecord, itemKey) {
    if (!meta || !activeRecord || !this.db || typeof this.db.recordItemHistoryEvent !== 'function') return false;
    const histTable = this.db.getTable(meta.histKey);
    const activeTable = this.db.getTable(meta.key);
    const sheetName = (activeTable && activeTable.name) || meta.label;
    const headers = (histTable && histTable.headers) || [];
    const dateH = headers.find(h => /^(date|action)/i.test(h)) || 'Date Assigned';
    const assignedH = headers.find(h => /^(assigned|employee|holder)/i.test(h)) || 'Assigned To';
    const locH = headers.find(h => /^location$/i.test(h)) || 'Location';
    const notesH = headers.find(h => /^(notes|comment)/i.test(h)) || 'Notes';

    const pendingEmpMap = this.getPendingEmployeesMap();
    const normTarget = this.normalizeItemStr(itemKey);
    const itemRows = (histTable && histTable.rows)
      ? histTable.rows.filter(r => this.normalizeItemStr(this.extractItemKey(r, headers, meta.key)) === normTarget)
      : [];
    const latestHist = this.getLatestHistoryRowForCompare(itemRows, pendingEmpMap, dateH, assignedH);
    const mismatch = this.detectActiveHistoryMismatch(activeRecord, latestHist, 'Date Assigned', dateH);
    if (!mismatch) return false;

    const aState = mismatch.activeState;
    let targetHolder = 'On Shelf';
    let syncNote = 'Returned to Shelf';
    if (aState.key === 'FIELD') {
      targetHolder = aState.holder;
      syncNote = `Assigned to ${targetHolder}`;
    } else if (aState.key === 'PACKED_DELIVERY') {
      targetHolder = 'Packed For Delivery';
      syncNote = 'Packed For Delivery';
    } else if (aState.key === 'PACKED_TESTING') {
      targetHolder = 'Packed For Testing';
      syncNote = 'Packed For Testing';
    } else if (aState.key === 'TESTING') {
      targetHolder = 'In Testing';
      syncNote = 'In Testing';
    } else if (aState.key === 'LOST') {
      targetHolder = 'Lost';
      syncNote = 'Marked Lost / Missing';
    } else if (aState.key === 'RETIRED') {
      targetHolder = activeRecord['Status'] || 'Failed Rubber';
      syncNote = activeRecord['Status'] || 'Failed Rubber';
    }

    const activeDate = String(activeRecord['Date Assigned'] || activeRecord['Date'] || '').trim();
    const activeDNum = this.toDateNum(activeDate);
    const latestDNum = latestHist ? this.toDateNum(latestHist[dateH] || latestHist['Date Assigned']) : 0;
    const todayStr = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const todayDNum = this.toDateNum(todayStr);

    let syncDate = todayStr;
    if (activeDate && activeDNum > 0 && activeDNum <= todayDNum && activeDNum >= latestDNum) {
      syncDate = activeDate;
    } else if (latestDNum > todayDNum && pendingEmpMap.has(this.cleanHolderName(targetHolder)) && activeDate) {
      syncDate = activeDate;
    }
    const syncDNum = this.toDateNum(syncDate);
    const loc = String(activeRecord['Location'] || 'Helena').trim();

    // If the latest history entry shares the exact same date AND has an equal/higher lifecycle rank
    // (or was an initial shelf placeholder corrupted while recording an active assignment), update it in place
    // so the corrected state becomes unambiguous without same-day rank inversion.
    const canFixInPlace = Boolean(
      latestHist &&
      syncDNum === latestDNum &&
      (mismatch.histState.rank >= aState.rank || (itemRows.length === 1 && mismatch.histState.key === 'NEW_PURCHASE'))
    );

    if (canFixInPlace) {
      latestHist[assignedH] = targetHolder;
      if (assignedH !== 'Assigned To') latestHist['Assigned To'] = targetHolder;
      latestHist[locH] = loc;
      if (locH !== 'Location') latestHist['Location'] = loc;
      latestHist[notesH] = syncNote;
      if (notesH !== 'Notes') latestHist['Notes'] = syncNote;

      if (histTable.rawGrid && headers.length > 0) {
        let rIdx = latestHist._rowIdx;
        if (!rIdx || rIdx < 2 || rIdx > histTable.rawGrid.length) {
          const histIdx = histTable.rows.indexOf(latestHist);
          rIdx = histIdx !== -1 ? histIdx + 2 : null;
        }
        if (rIdx && histTable.rawGrid[rIdx - 1]) {
          const updates = [
            { colH: assignedH, val: targetHolder },
            { colH: locH, val: loc },
            { colH: notesH, val: syncNote }
          ];
          for (const u of updates) {
            const cIdx = headers.indexOf(u.colH);
            if (cIdx !== -1) {
              const prevVal = String(histTable.rawGrid[rIdx - 1][cIdx] || '');
              histTable.rawGrid[rIdx - 1][cIdx] = u.val;
              await this.db.addMutation({
                action: 'UPDATE_CELL',
                sheetName: histTable.name,
                row: rIdx,
                col: cIdx + 1,
                header: headers[cIdx],
                itemIdentifier: itemKey,
                oldValue: prevVal,
                value: u.val
              });
            }
          }
        }
      }
      if (typeof this.db.schedulePersistSnapshot === 'function') this.db.schedulePersistSnapshot(this.db.snapshot, 400);
      if (typeof this.db.notify === 'function') this.db.notify();
      return true;
    }

    const rowPayload = {
      ...activeRecord,
      'Date Assigned': syncDate,
      'Location': loc,
      'Assigned To': targetHolder
    };
    await this.db.recordItemHistoryEvent(sheetName, rowPayload, syncNote);
    return true;
  }

  /**
   * Resolves Active vs. History mismatch for a single item.
   */
  async resolveItemMismatch(equipmentKey, itemKey) {
    const meta = this.getEquipmentMeta(equipmentKey);
    if (!meta || !itemKey || !this.db) return;

    const activeTable = this.db.getTable(meta.key);
    const actHeaders = (activeTable && activeTable.headers) || [];
    const normTarget = this.normalizeItemStr(itemKey);
    const activeRecord = activeTable && activeTable.rows
      ? activeTable.rows.find(r => this.normalizeItemStr(this.extractItemKey(r, actHeaders, meta.key)) === normTarget)
      : null;

    if (!activeRecord) {
      if (window.showToast) window.showToast(`⚠️ Could not find active record for ${meta.singular} #${itemKey}.`);
      return;
    }

    const fixed = await this._syncSingleItemHistoryToActive(meta, activeRecord, itemKey);
    if (fixed) {
      if (window.showToast) {
        window.showToast(`✅ Synced ${meta.singular} #${itemKey} history to match Active Inventory!`);
      }
      this.invalidateCache(meta.key);
      this.renderModalContent();
      if (window.sheetNavigator) window.sheetNavigator.renderCurrentSheet();
      if (window.historyNavigator) window.historyNavigator.renderCurrentHistory();
    } else if (window.showToast) {
      window.showToast(`ℹ️ ${meta.singular} #${itemKey} history is already in sync with Active Inventory.`);
    }
  }

  /**
   * Batch resolves all Active vs. History mismatches in a given equipment category.
   */
  async resolveEquipmentMismatches(equipmentKey) {
    const meta = this.getEquipmentMeta(equipmentKey);
    if (!meta || !this.db) return;

    this.invalidateCache(meta.key);
    const details = this.getEquipmentDetails(meta.key);
    const mismatchItems = (details.items || []).filter(it => it.mismatchCount > 0);
    if (mismatchItems.length === 0) {
      if (window.showToast) window.showToast(`ℹ️ No Active vs. History mismatches found in ${meta.label}.`);
      return;
    }

    if (typeof confirm === 'function' && !confirm(`🔄 Sync ${mismatchItems.length} ${mismatchItems.length === 1 ? 'Item' : 'Items'} in ${meta.label} History?\n\nThis will update ${meta.label} History to match current Active ${meta.label} assignments and statuses.\n\nProceed?`)) {
      return;
    }

    const activeTable = this.db.getTable(meta.key);
    const actHeaders = (activeTable && activeTable.headers) || [];
    let syncedCount = 0;
    for (const item of mismatchItems) {
      const normTarget = this.normalizeItemStr(item.cleanItemKey);
      const activeRecord = activeTable && activeTable.rows
        ? activeTable.rows.find(r => this.normalizeItemStr(this.extractItemKey(r, actHeaders, meta.key)) === normTarget)
        : null;
      if (activeRecord && await this._syncSingleItemHistoryToActive(meta, activeRecord, item.cleanItemKey)) {
        syncedCount++;
      }
    }

    if (window.showToast) {
      window.showToast(`✅ Synced ${syncedCount} ${meta.label} history ${syncedCount === 1 ? 'record' : 'records'} to match Active Inventory!`);
    }
    this.invalidateCache(meta.key);
    this.renderModalContent();
    if (window.sheetNavigator) window.sheetNavigator.renderCurrentSheet();
    if (window.historyNavigator) window.historyNavigator.renderCurrentHistory();
  }

  /**
   * Cleans duplicate history records for a single item
   */
  async cleanItemDuplicates(equipmentKey, itemKey) {
    const meta = this.getEquipmentMeta(equipmentKey);
    if (!meta || !itemKey || !this.db) return;

    const res = await this.db.cleanDuplicateHistoryRows(meta.histKey, itemKey);

    if (res.removedCount > 0) {
      if (window.showToast) {
        window.showToast(`✅ Cleaned ${res.removedCount} duplicate history ${res.removedCount === 1 ? 'record' : 'records'} for ${meta.singular} #${itemKey}!`);
      }

      this.invalidateCache(meta.key);

      // Re-render modal items
      this.renderModalContent();

      if (window.sheetNavigator) window.sheetNavigator.renderCurrentSheet();
      if (window.historyNavigator) window.historyNavigator.renderCurrentHistory();
    } else {
      if (window.showToast) {
        window.showToast(`ℹ️ No duplicate history records found for #${itemKey}.`);
      }
    }
  }

  /**
   * Batch cleans duplicate records for an entire equipment category
   */
  async cleanEquipmentDuplicates(equipmentKey) {
    const meta = this.getEquipmentMeta(equipmentKey);
    if (!meta || !this.db) return;

    const count = this.getEquipmentItemCount(meta.key);
    if (!confirm(`🧹 Clean All Duplicates in ${meta.label} History?\n\nThis will scan ${meta.label} History and remove duplicate entries for ${count} items, merging notes and location details.\n\nProceed?`)) {
      return;
    }

    const res = await this.db.cleanDuplicateHistoryRows(meta.histKey);
    if (res.removedCount > 0) {
      if (window.showToast) {
        window.showToast(`✅ Cleaned ${res.removedCount} duplicate history records from ${meta.label}!`);
      }

      this.invalidateCache(meta.key);
      this.renderModalContent();

      if (window.sheetNavigator) window.sheetNavigator.renderCurrentSheet();
      if (window.historyNavigator) window.historyNavigator.renderCurrentHistory();
    } else {
      if (window.showToast) {
        window.showToast(`ℹ️ No duplicate history records were found in ${meta.label}.`);
      }
    }
  }

  /**
   * Batch cleans duplicate records across ALL equipment history tables
   */
  async cleanAllEquipmentDuplicates() {
    if (!confirm(`⚡ Clean All Equipment History Tables?\n\nThis will scan ALL 9 equipment history tables and remove duplicate records, merging notes and re-indexing the database.\n\nProceed?`)) {
      return;
    }

    const res = await this.db.cleanAllHistoryDuplicates();
    if (res.totalRemoved > 0) {
      const breakdownText = Object.entries(res.tableBreakdown)
        .map(([k, c]) => `• ${k.replace('_history', '').toUpperCase()}: ${c}`)
        .join('\n');

      alert(`✅ Duplicate Cleanup Complete!\n\nRemoved ${res.totalRemoved} duplicate records across ${Object.keys(res.tableBreakdown).length} history tables:\n\n${breakdownText}`);
      if (window.showToast) {
        window.showToast(`✅ Cleaned ${res.totalRemoved} duplicate history records!`);
      }

      this.invalidateCache();
      this.renderModalContent();

      if (window.sheetNavigator) window.sheetNavigator.renderCurrentSheet();
      if (window.historyNavigator) window.historyNavigator.renderCurrentHistory();
    } else {
      alert(`ℹ️ All equipment history tables are already clean.`);
    }
  }

  ensureModalInDOM() {
    if (document.getElementById('history-issues-modal')) return;

    const modalHtml = `
      <div id="history-issues-modal" class="modal-overlay">
        <div class="modal-box history-issues-modal-box">
          <div class="modal-header" style="background: var(--bg-primary); border-bottom: 1px solid var(--border-color); padding: 12px 18px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 18px;">⚠️</span>
              <span style="font-size: 15px; font-weight: 700; color: var(--text-primary);">Equipment History Discrepancies & Duplicate Records</span>
            </div>
            <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 14px; border: none; background: transparent; cursor: pointer; color: var(--text-muted);" onclick="window.historyIssuesEngine.closeHistoryIssuesModal()">✕</button>
          </div>
          <div class="modal-body" id="history-issues-modal-content" style="padding: 14px; overflow-y: auto; max-height: calc(88vh - 110px);"></div>
          <div class="modal-footer" style="background: var(--bg-secondary); border-top: 1px solid var(--border-color); padding: 10px 18px; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 11.5px; color: var(--text-muted);">
              💡 Click <strong>"Sync History to Active"</strong> to fix mismatches or <strong>"Clean Duplicates"</strong> to remove redundant entries.
            </span>
            <button class="btn btn-secondary" onclick="window.historyIssuesEngine.closeHistoryIssuesModal()" style="font-size: 12px; font-weight: 600;">Close</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  escapeJs(text) {
    if (!text) return '';
    return String(text).replace(/'/g, "\\'").replace(/"/g, '\\"');
  }
}

// Global instance
window.historyIssuesEngine = new HistoryIssuesEngine(window.localDB);
