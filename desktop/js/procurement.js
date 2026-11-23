/**
 * procurement.js - Unified Procurement & Purchase Needs Engine (Phase 3)
 */

class ProcurementEngine {
  constructor(db) {
    this.db = db;
    this.items = [];
    this.selectedVendor = null;
    this.vendors = [];
    this.previousEmployeesSet = new Set();
    this.currentSectionFilter = 'all'; // 'all' | 'swaps_need' | 'swaps_size_up' | 'assigned_size_up' | 'compliance_missing'
    this.currentPOFormat = 'clean';
    this.generatedPOTexts = { clean: '', detailed: '' };
    this.expandedOrders = new Set();
    this.expandedItemSubrows = new Set();
    this.expandedSections = new Set();
    this.collapsedSections = new Set();
    this.orderGroupsMap = new Map();
    this.historySortCol = 'date';
    this.historySortDir = 'desc';
    this.activeCatalogCategoryTab = 'all';
    this.catalogSearchQuery = '';
    this.CATALOG_CATEGORIES = [
      { key: 'all', label: 'All Items', icon: '📋', color: '#38bdf8', placeholder: 'e.g. Class 2 Glove, Ferrule 2/0' },
      { key: 'Gloves', label: 'Gloves', icon: '🧤', color: '#60a5fa', placeholder: 'e.g. Class 2 Glove, Leather Protector' },
      { key: 'Sleeves', label: 'Sleeves', icon: '🦺', color: '#818cf8', placeholder: 'e.g. Class 2 Sleeve, Sleeve Straps' },
      { key: 'Blankets', label: 'Blankets', icon: '🧱', color: '#fbbf24', placeholder: 'e.g. Class 4 Blanket, Blanket Pin' },
      { key: 'Testing', label: 'Testing & Labor', icon: '🧪', color: '#10b981', placeholder: 'e.g. Glove Testing, Sleeve Testing, Dielectric Testing, Labor' },
      { key: 'MACKs', label: 'MACKs / Cover-Up', icon: '🔶', color: '#fb923c', placeholder: 'e.g. Line Hose CL2, MACK, Insulator Hood' },
      { key: 'Grounds', label: 'Grounds', icon: '⚡', color: '#34d399', placeholder: 'e.g. Ferrule 2/0 Cu Plug, Ground Clamp' },
      { key: 'Hot Sticks', label: 'Hot Sticks', icon: '🔴', color: '#f87171', placeholder: 'e.g. Hot Stick Soap, Gloss Refinish Kit, Shotgun Stick' },
      { key: 'Testers', label: 'Testers / Phasing', icon: '🔬', color: '#c084fc', placeholder: 'e.g. HV Voltage Detector, Phasing Set' },
      { key: 'AED', label: 'AED / First Aid', icon: '🏥', color: '#f472b6', placeholder: 'e.g. Adult AED Pads, First Aid Refill' },
      { key: 'Other', label: 'Other / Hardware', icon: '📦', color: '#94a3b8', placeholder: 'e.g. Utility Tool, Hardware Item' }
    ];
    this.SECTIONS = {
      swaps_need: {
        key: 'swaps_need',
        title: 'Swaps Page — Need to Purchase',
        shortTitle: 'Swaps: Need to Purchase',
        icon: '🛒',
        badgeColor: 'rgba(59, 130, 246, 0.2)',
        badgeBorder: 'rgba(59, 130, 246, 0.4)',
        badgeText: '#93c5fd',
        headerBg: 'rgba(30, 41, 59, 0.95)',
        accentBorder: '#3b82f6',
        desc: 'Unassigned swap items & safety stock replenishment needing procurement'
      },
      swaps_size_up: {
        key: 'swaps_size_up',
        title: 'Swaps Page — Size Up Replacements',
        shortTitle: 'Swaps: Size Up',
        icon: '🔄',
        badgeColor: 'rgba(168, 85, 247, 0.2)',
        badgeBorder: 'rgba(168, 85, 247, 0.4)',
        badgeText: '#d8b4fe',
        headerBg: 'rgba(45, 30, 60, 0.95)',
        accentBorder: '#a855f7',
        desc: 'Temporary size-up replacements picked on swap pages (order proper size)'
      },
      assigned_size_up: {
        key: 'assigned_size_up',
        title: 'Currently Assigned — Size Up in Field',
        shortTitle: 'Assigned: Size Up',
        icon: '⚠️',
        badgeColor: 'rgba(245, 158, 11, 0.2)',
        badgeBorder: 'rgba(245, 158, 11, 0.4)',
        badgeText: '#fcd34d',
        headerBg: 'rgba(55, 35, 20, 0.95)',
        accentBorder: '#f59e0b',
        desc: 'Active personnel currently wearing oversized equipment (order preferred size)'
      },
      compliance_missing: {
        key: 'compliance_missing',
        title: 'PPE Compliance — Missing Equipment',
        shortTitle: 'PPE Compliance: Missing',
        icon: '🛡️',
        badgeColor: 'rgba(239, 68, 68, 0.2)',
        badgeBorder: 'rgba(239, 68, 68, 0.4)',
        badgeText: '#fca5a5',
        headerBg: 'rgba(45, 20, 30, 0.95)',
        accentBorder: '#ef4444',
        desc: 'Active mandated personnel (SUP, GF, F, JRY, AP 1-7) missing rubber gloves or sleeves'
      },
      ordered_pending: {
        key: 'ordered_pending',
        title: 'Ordered — Awaiting Delivery',
        shortTitle: 'Ordered (Pending)',
        icon: '📦',
        badgeColor: 'rgba(16, 185, 129, 0.2)',
        badgeBorder: 'rgba(16, 185, 129, 0.4)',
        badgeText: '#34d399',
        headerBg: 'rgba(6, 78, 59, 0.95)',
        accentBorder: '#10b981',
        desc: 'Items placed on order with suppliers awaiting arrival, inspection & inventory assignment'
      }
    };
  }

  init() {
    const vendorSelect = document.getElementById('procurement-vendor-select');
    if (vendorSelect) {
      vendorSelect.addEventListener('change', (e) => this.onVendorChange(e.target.value));
    }

    const btnRefresh = document.getElementById('btn-procurement-refresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => this.refreshPurchaseNeeds());
    }

    const btnGenPO = document.getElementById('btn-procurement-gen-po');
    if (btnGenPO) {
      btnGenPO.addEventListener('click', () => this.generatePOText());
    }

    const btnCopy = document.getElementById('btn-procurement-copy-po');
    if (btnCopy) {
      btnCopy.addEventListener('click', () => {
        const textarea = document.getElementById('procurement-po-textarea');
        if (textarea) {
          navigator.clipboard.writeText(textarea.value).then(() => {
            btnCopy.textContent = '📋 Copied!';
            setTimeout(() => { btnCopy.textContent = '📋 Copy to Clipboard'; }, 2000);
          });
        }
      });
    }
  }

  loadData() {
    this.buildPurchaseNeeds();
    this.render();
  }

  /**
   * Rebuilds procurement items and pricing from the local snapshot without forcing a full view render.
   */
  buildPurchaseNeeds() {
    this.loadVendors();
    this.loadPreviousEmployees();
    this.scanPurchaseNeeds();
    this.updatePricing();
  }

  loadVendors() {
    const vTable = this.db.getTable('vendors');
    const rawRows = vTable ? (vTable.rawGrid || vTable.rows || []) : [];

    const vendorMap = {};
    rawRows.forEach(r => {
      let vName = '';
      let contact = '';
      let email = '';
      let phone = '';
      let notes = '';
      let item = '';
      let itemNumber = '';
      let price = 0;
      let category = '';

      if (Array.isArray(r)) {
        if (String(r[0] || '').toLowerCase() === 'vendor name') return; // skip header
        vName = String(r[0] || '').trim();
        contact = String(r[1] || '').trim();
        email = String(r[2] || '').trim();
        phone = String(r[3] || '').trim();
        notes = String(r[4] || '').trim();
        item = String(r[5] || '').trim();
        itemNumber = String(r[6] || '').trim();
        price = parseFloat(String(r[7] || '0').replace(/[$,]/g, '')) || 0;
        category = String(r[8] || '').trim();
      } else if (typeof r === 'object' && r !== null) {
        vName = String(r['Vendor Name'] || r['Vendor'] || r['name'] || '').trim();
        contact = String(r['Contact Name'] || r['Contact'] || '').trim();
        email = String(r['Email'] || '').trim();
        phone = String(r['Phone'] || '').trim();
        notes = String(r['Notes'] || '').trim();
        item = String(r['Item'] || '').trim();
        itemNumber = String(r['Item Number'] || r['Part Number'] || '').trim();
        price = parseFloat(String(r['Price'] || '0').replace(/[$,]/g, '')) || 0;
        category = String(r['Category'] || r['category'] || '').trim();
      }

      if (!vName) return;

      if (!vendorMap[vName]) {
        vendorMap[vName] = {
          name: vName,
          contact: contact,
          email: email,
          phone: phone,
          notes: notes,
          items: []
        };
      }

      if (item) {
        // Sanity check: Rubber PPE gloves/sleeves never cost > $350 each.
        // If a vendor catalog item was contaminated with an order total (e.g. $2000.42), sanitize it back to 0.
        const isRubberPpe = /glove|sleeve/i.test(item);
        const cleanPrice = (isRubberPpe && price > 350) ? 0 : price;
        const resolvedCat = category || this.inferCatalogItemCategory(item, itemNumber);
        vendorMap[vName].items.push({
          item: item,
          itemNumber: itemNumber,
          price: cleanPrice,
          category: resolvedCat,
          _manualCategory: !!category
        });
      }
    });

    this.vendors = Object.values(vendorMap);
  }

  /**
   * Automatically classifies a vendor catalog item into an equipment category tab
   * based on its item description and part number.
   */
  inferCatalogItemCategory(itemDesc, itemNumber = '') {
    const s = `${String(itemDesc || '')} ${String(itemNumber || '')}`.toLowerCase();
    const pNum = String(itemNumber || '').trim();
    if (!s.trim()) return 'Other';

    // 0. Testing & Labor (Glove Testing, Sleeve Testing, Blanket Testing, Labor Testing, Dielectric Testing, Recertification, Retest)
    // Note: Do not confuse with Testers / Phasing physical instruments (voltmeter, phasing set, hi-pot detector)
    if (/\b(?:testing|retest|recertification|dielectric|labor|wash\s*&\s*test|clean\s*&\s*test)\b/i.test(s) && !/\b(?:voltmeter|phasing|hi-pot|hipot|bierer|detector)\b/i.test(s)) {
      return 'Testing';
    }

    // 1. Gloves (Rubber gloves, leather protectors, glove liners, bags, dust/talc, inflators)
    if (/\b(?:glove|gloves|protector|liner|glove\s*bag|talc|powder|inflator)\b/i.test(s) || /^ws-glv/i.test(pNum)) {
      return 'Gloves';
    }
    // 2. Sleeves (Rubber sleeves, straps, buttons, harness)
    if (/\b(?:sleeve|sleeves|sleeve\s*strap|sleeve\s*button|harness|strap\s*&\s*button)\b/i.test(s) || /^ws-slv/i.test(pNum)) {
      return 'Sleeves';
    }
    // 3. Blankets (Rubber blankets, canisters, blanket pins/clamps)
    if (/\b(?:blanket|blankets|canister|cannister|clamp\s*pin|blanket\s*pin|blanket\s*roll)\b/i.test(s)) {
      return 'Blankets';
    }
    // 4. MACKs & Cover-Up (MACKs, Line Hose, Couplers, Insulator/Deadend/Cutout/Pole Covers & Hoods)
    if (/\b(?:mack|macks|line\s*hose|hose|coupler|hood|insulator\s*cover|deadend\s*cover|pole\s*cover|crossarm\s*cover|cutout\s*cover|cover\s*up)\b/i.test(s) || /^or\d+/i.test(pNum)) {
      return 'MACKs';
    }
    // 5. Grounds (Grounds, Ferrules, Cluster, Ball Studs, Clamps, Grounding Cable/Rods, Shrink Tube)
    if (/\b(?:ground|grounds|grounding|ferrule|cluster|ball\s*stud|stud|ground\s*clamp|ground\s*rod|ground\s*cable|shrink\s*tube)\b/i.test(s) || /^c?600-/i.test(pNum)) {
      return 'Grounds';
    }
    // 6. Hot Sticks (Hot Sticks, Shotgun, Extendo, Switch Stick, Cleaning Kits, Hot Stick Soap, Gloss Refinish, Silicone Wipes)
    if (/\b(?:hot\s*stick|stick|shotgun|extendo|tel-o-pole|switch\s*stick|disconnect\s*stick|measuring\s*stick|refinish|soap|cleaning\s*kit|silicone\s*wipe|wax|epoxiglas|fiberglass)\b/i.test(s) || /^10-19/i.test(pNum)) {
      return 'Hot Sticks';
    }
    // 7. Testers / Phasing (HV Testers, Phasing Sets, Voltmeters, Hi-Pot, Detectors)
    if (/\b(?:tester|phasing|voltmeter|hi-pot|hipot|detector|ammeter|ohmmeter|bierer|hd\s*electric)\b/i.test(s)) {
      return 'Testers';
    }
    // 8. AED / First Aid (AED units, pads, batteries, CPR, First Aid, Trauma)
    if (/\b(?:aed|defibrillator|pad|pads|cpr|first\s*aid|trauma|tourniquet|eye\s*wash|burn)\b/i.test(s)) {
      return 'AED';
    }
    return 'Other';
  }

  /**
   * Retrieves all testing & labor catalog items for a given vendor.
   */
  getVendorTestingItems(vendorName) {
    if (!vendorName || vendorName === '__custom__') return [];
    if (!this.vendors || !this.vendors.length) this.loadVendors();
    const v = (this.vendors || []).find(vend => vend.name.toLowerCase() === vendorName.toLowerCase());
    if (!v || !v.items) return [];
    return v.items.filter(it => {
      const cat = (it.category || '').toLowerCase();
      const name = (it.item || '').toLowerCase();
      const pNum = (it.itemNumber || '').toLowerCase();
      return cat === 'testing' ||
        /\b(?:testing|labor|dielectric|service|calib|recert)\b/i.test(name) ||
        /\b(?:testing|labor|dielectric|service|calib|recert)\b/i.test(pNum);
    });
  }

  /**
   * Canonical metadata for all 9 equipment swap tables.
   */
  _getAllSwapTableConfigs() {
    return [
      { swapKey: 'glove_swaps', invKey: 'gloves', cat: 'glove', type: 'Gloves', sheetName: 'Glove Swaps', isRubber: true },
      { swapKey: 'sleeve_swaps', invKey: 'sleeves', cat: 'sleeve', type: 'Sleeves', sheetName: 'Sleeve Swaps', isRubber: true },
      { swapKey: 'blanket_swaps', invKey: 'blankets', cat: 'blanket', type: 'Blankets', sheetName: 'Blanket Swaps', isRubber: false },
      { swapKey: 'mack_swaps', invKey: 'macks', cat: 'mack', type: 'MACKs', sheetName: 'MACK Swaps', isRubber: false },
      { swapKey: 'hv_tester_swaps', invKey: 'hv_testers', cat: 'hv tester', type: 'HV Testers', sheetName: 'HV Tester Swaps', isRubber: false },
      { swapKey: 'phasing_set_swaps', invKey: 'phasing_sets', cat: 'phasing', type: 'Phasing Sets', sheetName: 'Phasing Set Swaps', isRubber: false },
      { swapKey: 'aed_swaps', invKey: 'aed', cat: 'aed', type: 'AED', sheetName: 'AED Swaps', isRubber: false },
      { swapKey: 'ground_swaps', invKey: 'grounds', cat: 'ground', type: 'Grounds', sheetName: 'Ground Swaps', isRubber: false },
      { swapKey: 'hot_stick_swaps', invKey: 'hot_sticks', cat: 'hot stick', type: 'Hot Sticks', sheetName: 'Hot Stick Swaps', isRubber: false }
    ];
  }

  _getAllSwapKeys() {
    return this._getAllSwapTableConfigs().map(c => c.swapKey);
  }

  _getSwapTableKeyForCategory(catOrType) {
    const c = String(catOrType || '').toLowerCase().trim();
    if (!c) return '';
    if (c === 'glove_swaps' || c.includes('glove')) return 'glove_swaps';
    if (c === 'sleeve_swaps' || c.includes('sleeve')) return 'sleeve_swaps';
    if (c === 'blanket_swaps' || c.includes('blanket')) return 'blanket_swaps';
    if (c === 'mack_swaps' || c.includes('mack')) return 'mack_swaps';
    if (c === 'hv_tester_swaps' || c.includes('hv_tester') || c.includes('hv tester') || c === 'hvt') return 'hv_tester_swaps';
    if (c === 'phasing_set_swaps' || c.includes('phasing')) return 'phasing_set_swaps';
    if (c === 'aed_swaps' || c === 'aed' || c.includes('aed')) return 'aed_swaps';
    if (c === 'ground_swaps' || c.includes('ground')) return 'ground_swaps';
    if (c === 'hot_stick_swaps' || c.includes('hot_stick') || c.includes('hot stick') || c.includes('stick')) return 'hot_stick_swaps';
    return '';
  }

  _getTableSheetName(table, tableKey, fallbackName = '') {
    if (table && table.name) return table.name;
    if (this.db && typeof this.db.getSheetNameForTableKey === 'function' && tableKey) {
      return this.db.getSheetNameForTableKey(tableKey);
    }
    const cfg = this._getAllSwapTableConfigs().find(c => c.swapKey === tableKey || c.invKey === tableKey);
    if (cfg) return cfg.swapKey === tableKey ? cfg.sheetName : cfg.type;
    return fallbackName || tableKey || '';
  }

  /**
   * Resolves the 1-based and 0-based column index for a logical role on a swap/data table.
   * Returns null if a column (e.g. 'notes') does not exist in table headers — never guesses hidden cols.
   */
  _findTableCol(table, tableKey, fieldRole) {
    if (!table) return null;
    let headers = Array.isArray(table.headers) ? table.headers : [];
    if ((!headers.length || headers.length === 1) && Array.isArray(table.rawGrid)) {
      for (let r = 0; r < Math.min(table.rawGrid.length, 4); r++) {
        const cand = table.rawGrid[r];
        if (Array.isArray(cand) && cand.some(h => /^status$/i.test(String(h || '').trim()))) {
          headers = cand;
          break;
        }
      }
    }

    const matchers = {
      employee: [/^(?:crew\s*lead\s*\/\s*employee|employee(?:\s*name)?|assigned\s*to)$/i],
      status: [/^status$/i],
      pickList: [/^pick\s*list/i],
      picked: [/^picked$/i],
      notes: [/^notes?$/i],
      size: [/^(?:size|type|model)$/i],
      class: [/^(?:class|kv)$/i],
      urgency: [/^urgency$/i],
      dateChanged: [/^date\s*changed$/i]
    };

    const patterns = matchers[fieldRole] || [];
    for (const re of patterns) {
      const idx = headers.findIndex(h => re.test(String(h || '').trim()));
      if (idx !== -1) {
        return { col0Based: idx, col1Based: idx + 1, headerName: String(headers[idx]).trim() };
      }
    }

    // Never fabricate a fallback for optional columns like Notes, Urgency, or Class
    if (fieldRole === 'notes' || fieldRole === 'urgency' || fieldRole === 'class') {
      return null;
    }

    // Known fallbacks ONLY when headers are missing
    const tk = String(tableKey || '').toLowerCase();
    const fallbacks = {
      mack_swaps: { employee: 1, size: 4, pickList: 9, status: 10, picked: 11, dateChanged: 12 },
      hv_tester_swaps: { employee: 1, size: 3, pickList: 9, status: 10, picked: 11, dateChanged: 12 },
      phasing_set_swaps: { employee: 1, size: 3, pickList: 9, status: 10, picked: 11, dateChanged: 12 },
      ground_swaps: { employee: 1, size: 4, pickList: 10, status: 11, picked: 12, dateChanged: 13 },
      hot_stick_swaps: { employee: 1, size: 3, pickList: 8, status: 9, picked: 10, dateChanged: 11 },
      aed_swaps: { employee: 1, size: 3, pickList: 6, status: 7, picked: 8, dateChanged: 9 },
      default: { employee: 1, size: 3, pickList: 7, status: 8, picked: 9, dateChanged: 10 }
    };
    const fbMap = fallbacks[tk] || fallbacks.default;
    const col1 = fbMap[fieldRole];
    if (!col1) return null;
    const defaultHeaders = {
      employee: 'Employee',
      size: 'Size',
      pickList: 'Pick List Item #',
      status: 'Status',
      picked: 'Picked',
      dateChanged: 'Date Changed'
    };
    return { col0Based: col1 - 1, col1Based: col1, headerName: defaultHeaders[fieldRole] || fieldRole };
  }

  /**
   * Queues an UPDATE_CELL mutation with explicit oldValue captured BEFORE mutating rawGrid,
   * so db.addMutation() never drops the mutation as unchanged, and avoids writing non-existent columns.
   */
  async _queueCellMutation(table, tableKey, rowObjOrGridIdx, fieldRole, newValue, extraMutOpts = {}) {
    if (!table) return false;
    const colInfo = this._findTableCol(table, tableKey, fieldRole);
    if (!colInfo) return false;

    const isObj = rowObjOrGridIdx && typeof rowObjOrGridIdx === 'object';
    const rowObj = isObj ? rowObjOrGridIdx : null;
    const actualRowIdx = isObj
      ? (rowObj._rowIdx || (Array.isArray(table.rows) ? table.rows.indexOf(rowObj) + 2 : 2))
      : (Number(rowObjOrGridIdx) + 1);
    if (!actualRowIdx || actualRowIdx < 2) return false;

    const gridIdx = actualRowIdx - 1;
    let oldVal = '';
    if (Array.isArray(table.rawGrid) && Array.isArray(table.rawGrid[gridIdx]) && table.rawGrid[gridIdx][colInfo.col0Based] !== undefined) {
      oldVal = table.rawGrid[gridIdx][colInfo.col0Based];
    } else if (rowObj && rowObj[colInfo.headerName] !== undefined) {
      oldVal = rowObj[colInfo.headerName];
    }

    const normOld = (oldVal === undefined || oldVal === null) ? '' : String(oldVal).trim();
    const normNew = (newValue === undefined || newValue === null) ? '' : String(newValue).trim();

    if (this.db && typeof this.db.addMutation === 'function' && normOld !== normNew) {
      await this.db.addMutation({
        action: 'UPDATE_CELL',
        sheetName: this._getTableSheetName(table, tableKey),
        tableKey: tableKey,
        row: actualRowIdx,
        col: colInfo.col1Based,
        header: colInfo.headerName,
        oldValue: oldVal,
        value: newValue,
        ...extraMutOpts
      });
    }

    // Ensure local rowObj and rawGrid reflect the new value even if addMutation was skipped/mocked
    if (rowObj) {
      rowObj[colInfo.headerName] = newValue;
    }
    if (Array.isArray(table.rawGrid) && Array.isArray(table.rawGrid[gridIdx])) {
      table.rawGrid[gridIdx][colInfo.col0Based] = newValue;
    }
    return true;
  }

  /**
   * Queues an UPDATE_ROW mutation with updatedFields, updates, rowData, and itemIdentifier
   * so both LocalDatabase and 89-SyncAPI.gs apply it reliably.
   */
  async _queueRowUpdate(table, tableKey, defaultSheetName, rowObj, changedFields = null, itemIdentifier = '') {
    if (!table || !rowObj) return false;
    const rIdx = rowObj._rowIdx || (Array.isArray(table.rows) ? table.rows.indexOf(rowObj) + 2 : 2);
    const updatesObj = changedFields ? { ...changedFields } : { ...rowObj };
    delete updatesObj._rowIdx;

    if (changedFields) {
      Object.assign(rowObj, changedFields);
    }
    if (this.db && typeof this.db.syncRowToRawGrid === 'function') {
      this.db.syncRowToRawGrid(table, rowObj);
    }

    const rowDataCopy = { ...rowObj };
    delete rowDataCopy._rowIdx;

    if (this.db && typeof this.db.addMutation === 'function') {
      await this.db.addMutation({
        action: 'UPDATE_ROW',
        sheetName: this._getTableSheetName(table, tableKey, defaultSheetName),
        tableKey: tableKey,
        row: rIdx,
        itemIdentifier: itemIdentifier || '',
        updates: updatesObj,
        updatedFields: updatesObj,
        rowData: rowDataCopy
      });
    }
    return true;
  }

  /**
   * Deletes a Purchase Orders row via DELETE_ROW mutation with rowData + itemIdentifier
   * without pre-splicing poTable.rows so applyLocalMutation keeps rows, rawGrid, and _rowIdx aligned.
   */
  async _queueDeletePoRow(poTable, poRow) {
    if (!poTable || !poRow) return false;
    const idx = Array.isArray(poTable.rows) ? poTable.rows.indexOf(poRow) : -1;
    const targetRowIdx = poRow._rowIdx || (idx !== -1 ? idx + 2 : null);
    if (!targetRowIdx) return false;

    const rawPoNum = String(poRow['PO Number'] || poRow['PO #'] || '').trim();
    const safeId = (rawPoNum && rawPoNum !== '—' && rawPoNum.toLowerCase() !== 'pending' && rawPoNum.toLowerCase() !== 'ed') ? rawPoNum : '';
    const rowSnapshot = { ...poRow };
    delete rowSnapshot._rowIdx;

    if (this.db && typeof this.db.addMutation === 'function') {
      await this.db.addMutation({
        action: 'DELETE_ROW',
        sheetName: this._getTableSheetName(poTable, 'purchase_orders', 'Purchase Orders'),
        tableKey: 'purchase_orders',
        row: targetRowIdx,
        itemIdentifier: safeId,
        rowData: rowSnapshot
      });
    } else if (idx !== -1) {
      poTable.rows.splice(idx, 1);
      if (Array.isArray(poTable.rawGrid) && targetRowIdx <= poTable.rawGrid.length) {
        poTable.rawGrid.splice(targetRowIdx - 1, 1);
      }
    }
    return true;
  }

  /**
   * Extracts normalized PPE procurement metadata from a safety_equipment_needs row,
   * supporting both Desktop keys and Google Sheets canonical headers without confusing
   * vehicle/field safety reports for PPE orders.
   */
  _getSafetyNeedMeta(nr) {
    if (!nr || typeof nr !== 'object') return null;
    const reportType = String(nr['Report Type'] || '').trim().toLowerCase();
    const isPpeSheetRow = Boolean(nr['Employee'] || nr['Item Type'] || reportType.includes('ppe') || reportType.includes('purchase'));
    if (!isPpeSheetRow) return null;

    const employee = String(nr['Employee'] || nr['Foreman'] || '').trim();
    const itemType = String(nr['Item Type'] || nr['Equipment Type'] || '').trim();
    const issueDesc = String(nr['Issue Description'] || '');

    let size = String(nr['Size'] || '').trim();
    if (!size && issueDesc) {
      const mSize = issueDesc.match(/Size:\s*([^|;]+)/i);
      if (mSize) size = mSize[1].trim();
    }
    let classVal = String(nr['Class'] || '').trim();
    if (!classVal && issueDesc) {
      const mClass = issueDesc.match(/Class:\s*([^|;]+)/i);
      if (mClass) classVal = mClass[1].trim();
    }
    let urgency = String(nr['Urgency'] || '').trim();
    if (!urgency && issueDesc) {
      const mUrg = issueDesc.match(/Urgency:\s*([^|;]+)/i);
      if (mUrg) urgency = mUrg[1].trim();
    }

    return {
      employee,
      itemType,
      size: size || '—',
      classVal: classVal || 'Class 2',
      urgency: urgency || 'Immediate',
      status: String(nr['Status'] || '').trim(),
      notes: String(nr['Notes'] || '').trim(),
      dateRequested: String(nr['Date Requested'] || nr['Report Date'] || '').trim()
    };
  }

  _buildSafetyNeedRow({ employee, itemType, size, classVal, urgency = 'Immediate', status = 'Ordered', dateRequested = '', notes = '' }) {
    const dt = dateRequested || new Date().toLocaleDateString();
    const cls = classVal || 'Class 2';
    const sz = size || 'Standard';
    return {
      'Report Date': dt,
      'Report Type': 'PPE Purchase Order',
      'Foreman': employee,
      'Equipment Type': itemType,
      'Issue Description': `Size: ${sz} | Class: ${cls} | Urgency: ${urgency}`,
      'Employee': employee,
      'Item Type': itemType,
      'Size': sz,
      'Class': cls,
      'Urgency': urgency,
      'Status': status,
      'Date Requested': dt,
      'Notes': notes
    };
  }

  cleanEmployeeName(name) {
    if (!name) return '';
    let str = String(name).trim();
    str = str.replace(/^active\s*\|\s*/i, '').trim();
    str = str.replace(/\s+(?:st|step)\s*\d+\s*(?:new\s*hire)?.*$/i, '').trim();
    str = str.replace(/\s+new\s*hire.*$/i, '').trim();
    return str;
  }

  normalizeName(name) {
    if (!name) return '';
    const cleaned = this.cleanEmployeeName(name);
    return cleaned.toLowerCase()
      .replace(/\(.*?\)/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  isNameMatch(nameA, nameB) {
    if (!nameA || !nameB) return false;
    if (window.employeeProfileEngine && typeof window.employeeProfileEngine.isNameMatch === 'function') {
      return window.employeeProfileEngine.isNameMatch(nameA, nameB);
    }
    const nA = this.normalizeName(nameA);
    const nB = this.normalizeName(nameB);
    if (!nA || !nB) return false;
    if (nA === nB) return true;
    if (nA.includes(nB) || nB.includes(nA)) return true;
    return false;
  }

  /**
   * Pre-loads the set of former / departed personnel across employee tables, history, and archive
   */
  loadPreviousEmployees() {
    this.previousEmployeesSet = new Set();
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    if (!snap || !snap.tables) return this.previousEmployeesSet;

    // 1. Check window.previousEmployeesEngine if available
    if (window.previousEmployeesEngine && typeof window.previousEmployeesEngine.getPreviousEmployees === 'function') {
      try {
        const prevList = window.previousEmployeesEngine.getPreviousEmployees();
        prevList.forEach(p => {
          if (!p.isActive && p.name) {
            this.previousEmployeesSet.add(this.normalizeName(p.name));
          }
        });
      } catch (err) {
        console.warn('Error reading from previousEmployeesEngine:', err);
      }
    }

    // 2. Check dedicated previous_employees / past_employees table
    const prevTable = (this.db && typeof this.db.getTable === 'function' ? (this.db.getTable('previous_employees') || this.db.getTable('Previous Employees')) : null)
      || snap.tables['previous_employees'] || snap.tables['previous_employee'] || snap.tables['past_employees'] || snap.tables['Previous Employees'];
    if (prevTable) {
      const rows = prevTable.rows || prevTable.rawGrid || [];
      rows.forEach(r => {
        let name = '';
        if (Array.isArray(r)) {
          if (String(r[0] || '').toLowerCase().includes('employee')) return;
          name = String(r[0] || '').trim();
        } else if (r && typeof r === 'object') {
          name = String(r['Employee Name'] || r['Name'] || r['Worker'] || r['Employee'] || '').trim();
        }
        if (name) this.previousEmployeesSet.add(this.normalizeName(name));
      });
    }

    // 3. Check employees table for departed/inactive markers
    const empTable = snap.tables['employees'] || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employees') : null);
    if (empTable) {
      const rows = empTable.rows || empTable.rawGrid || [];
      rows.forEach((r, idx) => {
        let name = '';
        let loc = '';
        let status = '';
        let lastDay = '';

        if (Array.isArray(r)) {
          if (idx === 0) return; // skip header row
          name = String(r[0] || '').trim();
          loc = String(r[1] || '').trim();
          // Column 2 is Job Number on Employees sheet, not Status; check Last Day (col 10) if present
          lastDay = String(r[10] || '').trim();
        } else if (r && typeof r === 'object') {
          name = String(r['Employee Name'] || r['Name'] || r['Worker'] || '').trim();
          loc = String(r['Location'] || r['City'] || '').trim();
          status = String(r['Status'] || r['Employee Status'] || '').trim();
          lastDay = String(r['Last Day'] || r['Term Date'] || r['Termination Date'] || '').trim();
        }

        if (!name) return;
        const locLower = loc.toLowerCase();
        const statLower = status.toLowerCase();

        const isDeparted = locLower === 'previous employee' || locLower.includes('previous') ||
                           statLower === 'previous employee' || statLower.includes('inactive') ||
                           statLower.includes('terminated') || statLower.includes('departed') ||
                           statLower.includes('former') || statLower.includes('quit') ||
                           statLower.includes('resigned') || statLower.includes('reclaim');

        let isPastLastDay = false;
        if (lastDay) {
          const ld = new Date(lastDay);
          if (!isNaN(ld.getTime()) && ld < new Date()) {
            isPastLastDay = true;
          }
        }

        if (isDeparted || isPastLastDay) {
          this.previousEmployeesSet.add(this.normalizeName(name));
        }
      });
    }

    // 4. Check employee_history table for departure events
    const histTable = snap.tables['employee_history'] || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employee_history') : null);
    if (histTable && histTable.rows) {
      histTable.rows.forEach(r => {
        const name = String(r['Employee Name'] || r['Name'] || r['Worker'] || '').trim();
        const eventType = String(r['Event Type'] || r['Event'] || r['Action'] || '').toLowerCase();
        if (name && (eventType.includes('term') || eventType.includes('quit') || eventType.includes('depart') || eventType.includes('last day') || eventType.includes('previous'))) {
          this.previousEmployeesSet.add(this.normalizeName(name));
        }
      });
    }

    // 5. Scan active inventory tables for items assigned to Previous Employees
    const invKeys = ['gloves', 'sleeves', 'blankets', 'macks'];
    invKeys.forEach(iKey => {
      const iTable = snap.tables[iKey] || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(iKey) : null);
      if (iTable && iTable.rows) {
        iTable.rows.forEach(r => {
          const asg = String(r['Assigned To'] || r['Assigned'] || '').trim();
          if (!asg) return;
          const loc = String(r['Location'] || '').toLowerCase();
          const st = String(r['Status'] || '').toLowerCase();
          if (loc.includes('previous') || st.includes('previous') || st.includes('reclaim')) {
            this.previousEmployeesSet.add(this.normalizeName(asg));
          }
        });
      }
    });

    // 6. Scan swap sheets for explicit PREV EMP reclaim rows
    const swapKeys = ['glove_swaps', 'sleeve_swaps', 'blanket_swaps', 'mack_swaps'];
    swapKeys.forEach(sKey => {
      const sTable = snap.tables[sKey] || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(sKey) : null);
      if (sTable) {
        const rows = sTable.rows || [];
        rows.forEach(r => {
          const emp = String(r['Employee'] || r['Employee Name'] || r['Assigned To'] || '').trim();
          if (!emp) return;
          const dl = String(r['Days Left'] || r['Days Remaining'] || '').toUpperCase();
          const st = String(r['Status'] || '').toLowerCase();
          if (dl.includes('PREV') || st.includes('return to shelf') || st.includes('reclaim')) {
            this.previousEmployeesSet.add(this.normalizeName(emp));
          }
        });

        const rawGrid = sTable.rawGrid || [];
        rawGrid.forEach(gRow => {
          if (!Array.isArray(gRow) || !gRow.length) return;
          const first = String(gRow[0] || '').trim();
          if (!first || first.includes('📍') || first.includes('👤') || first.includes('Foreman:') || first === 'Employee') return;
          const daysCell = String(gRow[5] || '').toUpperCase();
          const statCell = String(gRow[7] || '').toLowerCase();
          if (daysCell.includes('PREV') || statCell.includes('return to shelf') || statCell.includes('reclaim')) {
            this.previousEmployeesSet.add(this.normalizeName(first));
          }
        });
      }
    });

    return this.previousEmployeesSet;
  }

  /**
   * Returns true if an employee is a former / departed employee
   */
  isDepartedOrPreviousEmployee(empName) {
    if (!empName) return false;
    const clean = String(empName).trim();
    const cleanLower = clean.toLowerCase();

    // On Shelf items are safety stock, not employees
    if (cleanLower === 'on shelf' || cleanLower === 'shelf' || cleanLower.startsWith('on shelf')) {
      return false;
    }

    // Explicit previous employee or reclaim tags in name
    if (cleanLower.includes('previous employee') || cleanLower.includes('(previous)') || cleanLower.includes('reclaim') || cleanLower.includes('departed')) {
      return true;
    }

    const norm = this.normalizeName(clean);
    if (!norm) return false;

    // Direct check in pre-built set
    if (this.previousEmployeesSet && this.previousEmployeesSet.has(norm)) {
      return true;
    }

    // Fuzzy check against previous employees set
    if (this.previousEmployeesSet) {
      for (const prevNorm of this.previousEmployeesSet) {
        if (this.isNameMatch(norm, prevNorm)) {
          return true;
        }
      }
    }

    // Fallback 1: check employees table directly
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    const empTable = snap?.tables?.employees || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employees') : null);
    if (empTable && empTable.rows) {
      const empRow = empTable.rows.find(r => this.isNameMatch(r['Employee Name'] || r['Name'] || r[0] || '', clean));
      if (empRow) {
        const loc = String(empRow['Location'] || empRow['City'] || empRow[1] || '').toLowerCase();
        const stat = String(empRow['Status'] || empRow['Employee Status'] || empRow[2] || '').toLowerCase();
        const lastDay = String(empRow['Last Day'] || empRow['Term Date'] || '').trim();

        if (loc === 'previous employee' || loc.includes('previous') ||
            stat === 'previous employee' || stat.includes('inactive') ||
            stat.includes('terminated') || stat.includes('departed') ||
            stat.includes('former') || stat.includes('quit') || stat.includes('resigned') ||
            stat.includes('reclaim')) {
          this.previousEmployeesSet?.add(norm);
          return true;
        }
        if (lastDay) {
          const ld = new Date(lastDay);
          if (!isNaN(ld.getTime()) && ld < new Date()) {
            this.previousEmployeesSet?.add(norm);
            return true;
          }
        }
      }
    }

    // Fallback 2: Check if employee is in PPE inventory with Location: 'Previous Employee'
    const invKeys = ['gloves', 'sleeves', 'blankets', 'macks'];
    for (const iKey of invKeys) {
      const iTable = snap?.tables?.[iKey] || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(iKey) : null);
      if (iTable && iTable.rows) {
        const found = iTable.rows.some(r => {
          const asg = String(r['Assigned To'] || r['Assigned'] || '').trim();
          if (!this.isNameMatch(asg, clean)) return false;
          const loc = String(r['Location'] || '').toLowerCase();
          const st = String(r['Status'] || '').toLowerCase();
          return loc.includes('previous') || st.includes('previous') || st.includes('reclaim');
        });
        if (found) {
          this.previousEmployeesSet?.add(norm);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Cleans up lingering 'Need to Purchase' flags on swap sheets for confirmed former staff.
   */
  async cleanupDepartedEmployeeSwapNeeds() {
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    if (!snap || !snap.tables) return;

    let modified = false;
    const swapKeys = this._getAllSwapKeys();

    for (const sKey of swapKeys) {
      const table = snap.tables[sKey];
      if (!table) continue;

      // 1. Clean table.rows
      if (table.rows && Array.isArray(table.rows)) {
        for (let rIdx = 0; rIdx < table.rows.length; rIdx++) {
          const row = table.rows[rIdx];
          const emp = String(row['Employee'] || row['Employee Name'] || row['Crew Lead / Employee'] || row['Assigned To'] || '').trim();
          if (!emp) continue;

          if (this.isDepartedOrPreviousEmployee(emp)) {
            const status = String(row['Status'] || '').trim().toLowerCase();
            const pickItem = String(row['Pick List Item #'] || row['Pick List'] || '').trim();

            // If this row has a purchase need status, clear it or convert to Reclaim / Departed
            if (status.includes('purchase') || pickItem === '—') {
              const currentItem = row['Current Item'] || row['Current Glove #'] || row['Current Sleeve #'] || row['Current Blanket #'] || row['Current MACK #'] || row['Current Item #'] || row['Serial #'];
              const hasExistingItem = currentItem && currentItem !== '—' && currentItem !== 'N/A';
              const newStatus = hasExistingItem ? 'Reclaim (Departed)' : 'Departed — Inactive';
              try {
                await this._queueCellMutation(table, sKey, row, 'status', newStatus);
                await this._queueCellMutation(table, sKey, row, 'pickList', '');
                await this._queueCellMutation(table, sKey, row, 'urgency', 'None');
              } catch (e) {
                console.warn('Could not queue cleanup mutation for', emp, e);
              }
              row['Status'] = newStatus;
              if (row['Pick List Item #'] !== undefined) row['Pick List Item #'] = '';
              if (row['Urgency'] !== undefined) row['Urgency'] = 'None';
              modified = true;
            }
          }
        }
      }

      // 2. Clean table.rawGrid if present (only rows not already cleaned)
      if (table.rawGrid && Array.isArray(table.rawGrid)) {
        const empCol = this._findTableCol(table, sKey, 'employee');
        const pickCol = this._findTableCol(table, sKey, 'pickList');
        const statCol = this._findTableCol(table, sKey, 'status');
        if (empCol && statCol) {
          for (let gIdx = 1; gIdx < table.rawGrid.length; gIdx++) {
            const gRow = table.rawGrid[gIdx];
            if (!Array.isArray(gRow) || !gRow.length) continue;
            const emp = String(gRow[empCol.col0Based] || '').trim();
            if (!emp || emp.includes('📍') || emp.includes('👤') || emp.includes('Foreman:') || emp === 'Employee' || emp === 'Crew Lead / Employee') continue;

            if (this.isDepartedOrPreviousEmployee(emp)) {
              const st = String(gRow[statCol.col0Based] || '').toLowerCase();
              const pi = pickCol ? String(gRow[pickCol.col0Based] || '').trim() : '';
              if (st.includes('purchase') || pi === '—') {
                try {
                  await this._queueCellMutation(table, sKey, gIdx, 'status', 'Reclaim (Departed)');
                  if (pickCol) await this._queueCellMutation(table, sKey, gIdx, 'pickList', '');
                } catch (e) {
                  console.warn('Could not queue rawGrid cleanup mutation for', emp, e);
                }
                modified = true;
              }
            }
          }
        }
      }
    }

    if (modified && this.db && typeof this.db.persistSnapshot === 'function') {
      await this.db.persistSnapshot(snap);
    }
  }

  /**
   * Refreshes the purchase needs from inventory & swap sheets, cleans up departed employee flags,
   * updates pricing, and re-renders the workspace.
   */
  async refreshPurchaseNeeds() {
    const btn = document.getElementById('btn-procurement-refresh');
    if (btn) {
      btn.innerHTML = '<span>⏳</span> Refreshing...';
      btn.disabled = true;
    }

    try {
      this.loadVendors();
      this.loadPreviousEmployees();
      await this.cleanupDepartedEmployeeSwapNeeds();
      this.scanPurchaseNeeds();
      this.updatePricing();
      this.render();

      if (typeof window.showToast === 'function') {
        window.showToast('🔄 Purchase Needs refreshed! Former employees excluded.', 'success');
      }
    } catch (err) {
      console.error('Error refreshing purchase needs:', err);
      if (typeof window.showToast === 'function') {
        window.showToast('⚠️ Error refreshing Purchase Needs: ' + err.message, 'error');
      }
    } finally {
      if (btn) {
        btn.innerHTML = '<span>🔄</span> Refresh';
        btn.disabled = false;
      }
    }
  }

  /**
   * Sets the active section filter tab ('all' or specific section key)
   */
  setSectionFilter(filterKey) {
    this.currentSectionFilter = filterKey || 'all';
    this.render();
  }

  /**
   * Toggles selection for all items in a specific section
   */
  toggleSectionSelected(sectionKey, isChecked) {
    this.items.forEach(item => {
      if (item.section === sectionKey) {
        item.selected = isChecked;
        if (item.employees && item.employees.length > 0) {
          item.employees.forEach(emp => {
            emp.checked = isChecked;
          });
          item.quantity = isChecked ? item.employees.length : 0;
        }
      }
    });
    this.render();
  }

  /**
   * Evaluates if classification is one of SUP, GF, F, JRY, or AP 1-7.
   * Matches standard Rubber PPE Compliance rules.
   */
  parseTrackedClassification(rawCls) {
    if (!rawCls) return null;
    const s = String(rawCls).trim();
    const up = s.toUpperCase();

    // 1. Apprentices & Sub Techs (AP 1-7, ST 1-7, etc.)
    const apMatch = up.match(/^(?:AP|ST|APP|APPRENTICE|SUB TECH)[\s\-_.]*([1-7])(?:\b|\s|$)/i) ||
                    up.match(/^([1-7])[\s\-_.]*(?:AP|ST|APP|APPRENTICE)\b/i) ||
                    up.match(/^(?:AP|ST)\s*([1-7])$/i);

    if (apMatch) {
      const level = parseInt(apMatch[1], 10);
      return {
        code: `AP ${level}`,
        level: level,
        tier: level <= 3 ? 'ap1_3' : 'ap4_7',
        needsGloves: true,
        needsSleeves: level >= 4
      };
    }

    // 2. Supervisor / Superintendent (SUP)
    if (/^(SUP|SUPERVISOR|SUPERINTENDENT|SUPV|SUP\.)(\s|$)/i.test(up)) {
      return { code: 'SUP', level: 0, tier: 'sup', needsGloves: true, needsSleeves: true };
    }

    // 3. General Foreman (GF)
    if (/^(GF|GENERAL\s*FOREMAN|GEN\s*FOREMAN|GEN\.\s*FOREMAN|GF\.)(\s|$)/i.test(up)) {
      return { code: 'GF', level: 0, tier: 'gf', needsGloves: true, needsSleeves: true };
    }

    // 4. Foreman (F, GTO F, Foreman, Crew Lead)
    if (/^(F|FOREMAN|GTO\s*F|GTO\s*FOREMAN|F\.)(\s|$)/i.test(up)) {
      return { code: up.includes('GTO') ? 'GTO F' : 'F', level: 0, tier: 'f', needsGloves: true, needsSleeves: true };
    }

    // 5. Journeyman Lineman (JRY, JL, Journeyman - but NOT JRY OP)
    if (/^(JRY|JL|JOURNEYMAN|JOURNEYMAN\s*LINEMAN)$/i.test(up) ||
        (/^(JRY|JL|JOURNEYMAN|JOURNEYMAN\s*LINEMAN)\b/i.test(up) && !/\b(OP|OPERATOR)\b/i.test(up))) {
      return { code: 'JRY', level: 0, tier: 'jry', needsGloves: true, needsSleeves: true };
    }

    return null;
  }

  /**
   * Checks whether an employee is excluded from PPE tracking or procurement
   * (checks crew-locked manual swaps/procurement exclusions and crew discipline exclusions)
   */
  isEmployeePpeExcluded(empName) {
    if (!empName) return false;
    if (this.isManualPpeExcluded(empName)) return true;
    if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.isEmployeeExcluded === 'function') {
      return window.ppeTrackingEngine.isEmployeeExcluded(empName);
    }
    // Fallback: check crew discipline from db
    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);
      const empTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employees') : null) || snap?.tables?.['employees'];
      const jtTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('job_tracking') : null) || snap?.tables?.['job_tracking'];

      if (empTable && empTable.rows) {
        const norm = this.normalizeName(empName);
        const emp = empTable.rows.find(e => this.isNameMatch(this.normalizeName(e['Employee Name'] || e['Name'] || ''), norm));
        if (emp) {
          const jn = String(emp['Job Number'] || emp['Job #'] || '').replace(/\.\d+.*$/, '').trim();
          if (jn) {
            let crewType = '';
            if (jtTable && jtTable.rows) {
              const jt = jtTable.rows.find(j => {
                const jNum = String(j['Job Number'] || j['Job #'] || Object.values(j)[0] || '').replace(/\.\d+.*$/, '').trim();
                return jNum === jn;
              });
              if (jt && jt['Crew Type']) crewType = String(jt['Crew Type']).trim();
            }
            if (!crewType) {
              if (jn.startsWith('005')) crewType = 'Office';
              else crewType = 'Electric';
            }
            // Only Electric and Office require rubber PPE
            if (crewType !== 'Electric' && crewType !== 'Office') return true;
          }
        }
      }
    } catch { /* ignore */ }

    return false;
  }

  /**
   * Checks whether an employee is excluded from Swaps & Purchase Needs on their current crew
   */
  isManualPpeExcluded(empName) {
    if (!empName) return false;
    if (typeof window !== 'undefined' && window.ppeTrackingEngine && typeof window.ppeTrackingEngine.isEmployeeSwapsExcluded === 'function') {
      return window.ppeTrackingEngine.isEmployeeSwapsExcluded(empName);
    }
    try {
      const raw = localStorage.getItem('sa_ppe_excluded_employees');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const norm = this.normalizeName(empName);
          return arr.some(x => {
            const xName = typeof x === 'object' ? (x.name || '') : String(x || '');
            return this.isNameMatch(this.normalizeName(xName), norm);
          });
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  /**
   * Gets the crew discipline/type for an employee
   */
  getEmployeeCrewType(empName) {
    if (!empName) return 'Electric';
    if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.isEmployeeCrewDisciplineExcluded === 'function') {
      const check = window.ppeTrackingEngine.isEmployeeCrewDisciplineExcluded(empName);
      if (check && check.crewType) return check.crewType;
    }
    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);
      const empTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employees') : null) || snap?.tables?.['employees'];
      const jtTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('job_tracking') : null) || snap?.tables?.['job_tracking'];

      if (empTable && empTable.rows) {
        const norm = this.normalizeName(empName);
        const emp = empTable.rows.find(e => this.isNameMatch(this.normalizeName(e['Employee Name'] || e['Name'] || ''), norm));
        if (emp) {
          const rawJob = String(emp['Job Number'] || emp['Job #'] || '').trim();
          const jn = rawJob.replace(/\.\d+.*$/, '').trim();
          if (jtTable && jtTable.rows) {
            const jt = jtTable.rows.find(j => {
              const jNum = String(j['Job Number'] || j['Job #'] || Object.values(j)[0] || '').replace(/\.\d+.*$/, '').trim();
              return jNum === jn;
            });
            if (jt && jt['Crew Type']) return String(jt['Crew Type']).trim();
          }
          if (jn.startsWith('005')) return 'Office';
          const lower = (rawJob + ' ' + (emp['Location'] || '')).toLowerCase();
          if (lower.includes('sub') || lower.includes('substation')) return 'Substation';
          if (lower.includes('gas')) return 'Gas';
          if (lower.includes('mechanic') || lower.includes('shop')) return 'Mechanic';
          return 'Electric';
        }
      }
    } catch { /* ignore */ }
    return 'Electric';
  }

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
    if (!str) return '';
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  cleanSize(val) {
    if (val === null || val === undefined) return '';
    const s = String(val).trim();
    const lower = s.toLowerCase();
    if (!s || s === '—' || s === '-' || lower === 'n/a' || lower === 'none' || lower === 'unknown' || lower === 'null') {
      return '';
    }
    return s;
  }

  cleanItemType(typeVal) {
    if (!typeVal) return 'Equipment';
    let t = String(typeVal).replace(/^[^\w]+/g, '').trim();
    const lower = t.toLowerCase();
    if (lower.includes('glove')) return 'Gloves';
    if (lower.includes('sleeve')) return 'Sleeves';
    if (lower.includes('blanket')) return 'Blankets';
    if (lower.includes('mack')) return 'MACKs';
    if (lower.includes('tester')) return 'HV Testers';
    if (lower.includes('phasing')) return 'Phasing Sets';
    if (lower.includes('ground')) return 'Grounds';
    if (lower.includes('stick')) return 'Hot Sticks';
    if (lower.includes('aed')) return 'AED';
    return t || 'Equipment';
  }

  isNeedToOrderStat(stat) {
    if (!stat) return false;
    const s = String(stat).toLowerCase().trim();
    if (s.includes('ordered')) return false;
    return s.includes('purchase') || s.includes('need to order') || s.includes('need to purchase') || s.includes('size up') || s === 'unassigned';
  }

  getActiveEmployeeNames() {
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    const empTable = snap?.tables?.employees || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employees') : null);
    const empRows = empTable ? (empTable.rows || empTable.rawGrid || []) : [];
    const names = new Set();
    empRows.forEach(r => {
      let name = '';
      let loc = '';
      if (Array.isArray(r)) {
        if (String(r[0] || '').toLowerCase().includes('employee')) return;
        name = String(r[0] || '').trim();
        loc = String(r[1] || '').trim();
      } else if (r && typeof r === 'object') {
        name = String(r['Employee Name'] || r['Name'] || r['Worker'] || '').trim();
        loc = String(r['Location'] || r['City'] || '').trim();
      }
      if (!name || name.toLowerCase().includes('previous') || loc.toLowerCase().includes('previous')) return;
      names.add(name);
    });
    return Array.from(names).sort();
  }

  formatToMdY(dStr) {
    if (!dStr) return '';
    if (dStr.includes('/')) return dStr;
    const parts = dStr.split('-');
    if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`;
    return dStr;
  }

  parseOrderInfoFromNotes(notesStr) {
    if (!notesStr) return null;
    const s = String(notesStr).trim();
    let orderNumber = '';
    let vendor = '';
    let orderDate = '';
    let price = 0;

    // Extract Order # / Vendor Order # / Invoice # / Request # (e.g. "Order #: 0819764", "Vendor Order #: WS-123", "Request #: REQ-20261030-01")
    // Use word boundaries \b to prevent matching the start of "Ordered" or "Ordering"!
    const voMatch = s.match(/\b(?:vendor\s*order|sales\s*order|order\s*request|request|req|invoice|inv|order)\b\s*(?:#|num(?:ber)?|:)\s*[:#-]?\s*([A-Za-z0-9\-_.]+)/i)
      || s.match(/\b(?:vendor\s*order|sales\s*order|order\s*request|request|req|invoice|inv|order)\b\s*(?:#|num(?:ber)?|:)?\s*[:#-]?\s*([A-Za-z0-9\-_.]+)/i);
    if (voMatch && !/^(?:on|by|at|for|to|ed|ing|request|req|order|details|information|complete|completed|pending|placed)$/i.test(voMatch[1])) {
      orderNumber = voMatch[1].trim();
    }

    // Secondary fallback: PO / Job Number (e.g. "PO: 0819764", "Job #: 002-27")
    if (!orderNumber) {
      const poMatch = s.match(/(?:\bpo\b|job(?:\s*#|\s*num)?)\s*(?:#|num|number)?\s*[:#-]?\s*([A-Za-z0-9\-_.]+)/i);
      if (poMatch && !/^(?:on|by|at|for|to|ed|ing)$/i.test(poMatch[1])) {
        orderNumber = poMatch[1].trim();
      }
    }

    // Tertiary fallback: "Ordered (Order #: 0819764)" or "Ordered: 0819764" or "Ordered - 0819764"
    if (!orderNumber) {
      const orderedMatch = s.match(/\bordered\b\s*(?:#|[:\-(])\s*(?:order\s*(?:#|num(?:ber)?)?\s*[:#-]?\s*)?([A-Za-z0-9\-_.]+)/i);
      if (orderedMatch && !/^(?:on|by|at|for|to|ed|ing)$/i.test(orderedMatch[1])) {
        orderNumber = orderedMatch[1].replace(/\)$/, '').trim();
      }
    }

    // Discard false positive tokens like "ed" or "ing"
    if (/^(?:ed|ing)$/i.test(orderNumber)) {
      orderNumber = '';
    }

    // Extract Vendor
    const vMatch = s.match(/(?:vendor|from|supplier)\s*[:=]\s*([^,;·\n]+)/i);
    if (vMatch) vendor = vMatch[1].trim();

    // Extract Date (e.g. 10/12/2026 or 2026-10-12)
    const dMatch = s.match(/(?:date|ordered(?:\s*on)?)\s*[:=]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/i);
    if (dMatch) orderDate = dMatch[1].trim();

    // Extract Price
    const pMatch = s.match(/(?:price|cost|unit)\s*[:=]?\s*\$?\s*([\d,]+\.?\d{0,2})|\$\s*([\d,]+\.?\d{0,2})/i);
    if (pMatch) {
      const val = pMatch[1] || pMatch[2];
      price = parseFloat(val.replace(/,/g, '')) || 0;
    }

    // Extract Expected Delivery
    let expectedDelivery = '';
    const delivMatch = s.match(/(?:expected(?:\s*delivery)?|deliv(?:ery)?(?:\s*date)?|eta)\s*[:=]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/i);
    if (delivMatch) expectedDelivery = delivMatch[1].trim();

    return (orderNumber || vendor || orderDate || price || expectedDelivery) ? {
      orderNumber,
      poNumber: orderNumber,
      vendorOrderNumber: orderNumber,
      vendor,
      orderDate,
      price,
      expectedDelivery
    } : null;
  }

  findActiveOpenPo(empName = null, itemType = null, size = null, classVal = null) {
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
    if (!poTable || !poTable.rows) return null;

    const openRows = [];
    for (const r of poTable.rows) {
      const stat = String(r['Status'] || '').toLowerCase();
      if (stat.includes('received') || stat.includes('fulfill') || stat.includes('cancel')) continue;
      const rawPo = String(r['PO Number'] || r['PO #'] || '').trim();
      const notes = String(r['Notes'] || '');
      const parsedNotes = this.parseOrderInfoFromNotes(notes);
      let orderNum = (parsedNotes?.orderNumber && parsedNotes.orderNumber.toLowerCase() !== 'ed')
        ? parsedNotes.orderNumber
        : (rawPo.toLowerCase() !== 'ed' ? rawPo : '');
      if (orderNum) {
        const uPrice = this.getItemUnitPriceFromPoRecord(r, empName, itemType, size, classVal);
        openRows.push({
          row: r,
          orderNumber: orderNum,
          vendorOrderNumber: parsedNotes?.vendorOrderNumber || orderNum,
          vendor: String(r['Vendor'] || ''),
          orderDate: String(r['Date'] || ''),
          expectedDelivery: String(r['Expected Delivery'] || ''),
          unitPrice: uPrice,
          price: uPrice,
          totalOrderPrice: parseFloat(r['Total Price'] || r['Price'] || 0) || 0,
          items: String(r['Items'] || ''),
          notes: notes
        });
      }
    }

    if (!openRows.length) return null;

    if (empName) {
      const empMatch = openRows.find(o => this.isNameMatch(o.notes, empName) || this.isNameMatch(o.items, empName));
      if (empMatch) return empMatch;
    }

    return openRows[openRows.length - 1];
  }

  getItemUnitPriceFromPoRecord(poRecord, empName = null, itemType = null, size = null, classVal = null) {
    if (!poRecord) return 0;
    const itemsStr = String(poRecord['Items'] || poRecord.items || '');
    if (itemsStr) {
      const parsedItems = this.parsePoItemsString(itemsStr);
      // 1. Match by employee name if provided
      if (empName) {
        const empItem = parsedItems.find(it => this.isNameMatch(it.employeeName, empName));
        if (empItem && empItem.unitPrice > 0) return empItem.unitPrice;
      }
      // 2. Match by category, size, and class
      if (itemType || size || classVal) {
        const normCat = itemType ? this.cleanItemType(itemType) : '';
        const normSize = size ? String(size).trim() : '';
        const normClass = classVal ? String(classVal).trim() : '';

        const exactMatch = parsedItems.find(it => {
          const catMatch = !normCat || this.cleanItemType(it.category || it.itemType) === normCat;
          const sizeMatch = !normSize || String(it.size).trim() === normSize;
          const classMatch = !normClass || String(it.classVal).trim() === normClass;
          return catMatch && sizeMatch && classMatch;
        });
        if (exactMatch && exactMatch.unitPrice > 0) return exactMatch.unitPrice;

        // Fallback: match category and size
        const sizeCatMatch = parsedItems.find(it => {
          const catMatch = !normCat || this.cleanItemType(it.category || it.itemType) === normCat;
          const sizeMatch = !normSize || String(it.size).trim() === normSize;
          return catMatch && sizeMatch;
        });
        if (sizeCatMatch && sizeCatMatch.unitPrice > 0) return sizeCatMatch.unitPrice;
      }
      // 3. If only 1 item type exists in order and unitPrice > 0
      if (parsedItems.length === 1 && parsedItems[0].unitPrice > 0) {
        return parsedItems[0].unitPrice;
      }
    }

    // 4. Fallback to vendor catalog price
    const vendor = String(poRecord['Vendor'] || poRecord.vendor || '');
    if (vendor && itemType && size) {
      const catPrice = this.getVendorPrice(vendor, itemType, size, classVal || 'Class 2');
      if (catPrice > 0) return catPrice;
    }

    return 0;
  }

  lookupOrderByPoNumber(orderNumberToFind, empName = null, itemType = null, size = null, classVal = null) {
    if (!orderNumberToFind) return null;
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);

    const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
    if (!poTable || !poTable.rows) return null;

    const rows = poTable.rows || [];
    const matching = [];
    const target = String(orderNumberToFind).trim().toLowerCase();

    for (const po of rows) {
      const pNum = String(po['PO Number'] || po['PO #'] || '').trim();
      const notes = String(po['Notes'] || '');
      const parsedNotes = this.parseOrderInfoFromNotes(notes);
      const vNum = parsedNotes?.vendorOrderNumber || '';

      const isMatch = (pNum && pNum.toLowerCase() === target) ||
                      (vNum && vNum.toLowerCase() === target) ||
                      notes.toLowerCase().includes(target);

      if (isMatch) {
        const stat = String(po['Status'] || po['status'] || '').toLowerCase();
        const isClosed = stat.includes('received') || stat.includes('fulfilled') || stat.includes('cancel');
        const items = String(po['Items'] || '');
        const resolvedNum = (vNum && !/^\d{3}-\d{2}/.test(vNum)) ? vNum : (pNum || vNum);

        const parsedItems = this.parsePoItemsString(items);
        let matchedItem = null;
        if (empName) {
          matchedItem = parsedItems.find(it => this.isNameMatch(it.employeeName, empName));
        }
        if (!matchedItem && (size || itemType)) {
          matchedItem = parsedItems.find(it => {
            const catMatch = !itemType || this.cleanItemType(it.category || it.itemType) === this.cleanItemType(itemType);
            const sizeMatch = !size || String(it.size).trim() === String(size).trim();
            const clMatch = !classVal || String(it.classVal).trim() === String(classVal).trim();
            return catMatch && sizeMatch && clMatch;
          }) || parsedItems.find(it => {
            const catMatch = !itemType || this.cleanItemType(it.category || it.itemType) === this.cleanItemType(itemType);
            const sizeMatch = !size || String(it.size).trim() === String(size).trim();
            return catMatch && sizeMatch;
          });
        }

        const uPrice = (matchedItem && matchedItem.unitPrice > 0)
          ? matchedItem.unitPrice
          : this.getItemUnitPriceFromPoRecord(po, empName, itemType, size, classVal);

        matching.push({
          orderNumber: resolvedNum,
          poNumber: resolvedNum,
          vendorOrderNumber: resolvedNum,
          vendor: String(po['Vendor'] || ''),
          orderDate: String(po['Date'] || ''),
          expectedDelivery: String(po['Expected Delivery'] || po['Delivery Date'] || ''),
          unitPrice: uPrice,
          price: uPrice,
          totalOrderPrice: parseFloat(po['Total Price'] || po['Price'] || 0) || 0,
          matchedClass: matchedItem ? matchedItem.classVal : null,
          status: String(po['Status'] || ''),
          isClosed,
          notes,
          items,
          rawRow: po
        });
      }
    }

    if (!matching.length) return null;

    // 1. If empName is given, prioritize an OPEN order that mentions this employee
    if (empName) {
      const empOpenMatch = matching.find(m => !m.isClosed && (this.isNameMatch(m.notes, empName) || this.isNameMatch(m.items, empName)));
      if (empOpenMatch) return empOpenMatch;
    }

    // 2. Prioritize ANY open (awaiting delivery) order with this Order number (newest first)
    const openOrders = matching.filter(m => !m.isClosed);
    if (openOrders.length > 0) {
      return openOrders[openOrders.length - 1];
    }

    // 3. Fallback: if all orders with this Order # are closed, return matching by employee or newest closed
    if (empName) {
      const empClosedMatch = matching.find(m => this.isNameMatch(m.notes, empName) || this.isNameMatch(m.items, empName));
      if (empClosedMatch) return empClosedMatch;
    }
    return matching[matching.length - 1];
  }

  lookupOrderForEmployee(empName, itemType, size = null, classVal = null) {
    if (!empName) return null;
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);

    // 1. Check purchase_orders table for open orders
    const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
    if (poTable && poTable.rows) {
      for (const po of poTable.rows) {
        const stat = String(po['Status'] || po['status'] || '').toLowerCase();
        if (stat.includes('received') || stat.includes('fulfilled') || stat.includes('cancel')) continue;
        const notes = String(po['Notes'] || '');
        const items = String(po['Items'] || '');
        if (this.isNameMatch(notes, empName) || this.isNameMatch(items, empName)) {
          const parsedNotes = this.parseOrderInfoFromNotes(notes);
          const pNum = String(po['PO Number'] || po['PO #'] || '');
          const uPrice = this.getItemUnitPriceFromPoRecord(po, empName, itemType, size, classVal);
          return {
            orderNumber: pNum,
            poNumber: pNum,
            vendorOrderNumber: parsedNotes?.vendorOrderNumber || '',
            vendor: String(po['Vendor'] || ''),
            orderDate: String(po['Date'] || ''),
            expectedDelivery: String(po['Expected Delivery'] || po['Delivery Date'] || ''),
            unitPrice: uPrice,
            price: uPrice,
            totalOrderPrice: parseFloat(po['Total Price'] || po['Price'] || 0) || 0
          };
        }
      }
    }

    // 2. Check safety_equipment_needs table
    const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
    if (needsTable && needsTable.rows) {
      const match = needsTable.rows.find(r => {
        const meta = this._getSafetyNeedMeta(r);
        if (!meta) return false;
        const isTypeMatch = !itemType || meta.itemType.toLowerCase().includes(itemType.toLowerCase().slice(0, 4));
        return this.isNameMatch(meta.employee, empName) && meta.status.toLowerCase().includes('ordered') && isTypeMatch;
      });
      if (match) {
        const meta = this._getSafetyNeedMeta(match);
        const parsed = this.parseOrderInfoFromNotes(meta?.notes || match['Notes']);
        if (parsed) return parsed;
        return {
          orderNumber: '',
          vendor: '',
          orderDate: String(meta?.dateRequested || match['Date Requested'] || ''),
          expectedDelivery: '',
          price: 0
        };
      }
    }

    return null;
  }

  parsePoItemsString(itemsStr) {
    if (!itemsStr) return [];
    const result = [];
    const chunks = itemsStr.split(';').map(c => c.trim()).filter(Boolean);
    chunks.forEach(chunk => {
      let qty = 1;
      const qtyMatch = chunk.match(/^\((\d+)\)/) || chunk.match(/^(\d+)\s+x/i) || chunk.match(/^(\d+)\s+/);
      if (qtyMatch) {
        qty = parseInt(qtyMatch[1], 10) || 1;
      }

      let category = 'Gloves';
      const lower = chunk.toLowerCase();
      const isTesting = lower.includes('testing') || lower.includes('labor') || lower.includes('dielectric') || lower.includes('calibration');

      if (isTesting) category = 'Testing';
      else if (lower.includes('sleeve')) category = 'Sleeves';
      else if (lower.includes('blanket')) category = 'Blankets';
      else if (lower.includes('mack')) category = 'MACKs';
      else if (lower.includes('glove')) category = 'Gloves';
      else if (lower.includes('tester')) category = 'HV Testers';
      else if (lower.includes('phasing')) category = 'Phasing Sets';
      else if (lower.includes('ground')) category = 'Grounds';
      else if (lower.includes('stick')) category = 'Hot Sticks';
      else if (lower.includes('aed')) category = 'AED';
      else if (lower.includes('other')) category = 'Other';

      let classVal = 'Class 2';
      const classMatch = chunk.match(/(?:class|cl)\s*([0-4])/i);
      if (classMatch) {
        classVal = `Class ${classMatch[1]}`;
      } else if (category === 'Blankets' || category === 'MACKs') {
        classVal = 'Class 4';
      } else if (isTesting || category === 'Other' || category === 'HV Testers' || category === 'Phasing Sets' || category === 'Grounds' || category === 'Hot Sticks' || category === 'AED') {
        classVal = 'N/A';
      }

      let size = 'Standard';
      if (isTesting) {
        // Extract the testing item description from the chunk
        // e.g. "(5) Sleeve Testing @ $15.00" -> "Sleeve Testing"
        let rawItem = chunk
          .replace(/^\(\d+\)\s*/, '')
          .replace(/^(\d+)\s*x\s*/i, '')
          .replace(/^(\d+)\s+/, '')
          .replace(/@.*$/, '')
          .replace(/\[.*\]/, '')
          .replace(/\(part\s*#.*?\)/i, '')
          .trim();
        rawItem = rawItem.replace(/^(?:size|item)[:\s]*/i, '').trim();
        if (/sleeve/i.test(rawItem)) size = 'Sleeve Testing';
        else if (/glove/i.test(rawItem)) size = 'Glove Testing';
        else if (/blanket/i.test(rawItem)) size = 'Blanket Testing';
        else if (/mack/i.test(rawItem)) size = 'MACK Testing';
        else size = rawItem || 'Testing & Labor';
      } else {
        // Match explicit "Size <value>" first (preserving Canister, Eyelet, Cluster, 8ft, 15kV, Adult Pads, 2/0, etc.)
        const explicitSizeMatch = chunk.match(/\bsize\s*[:\s]+\s*([^,;[\]@()]+)/i);
        const namedSpecMatch = chunk.match(/\b(canister|cannister|eyelet|cluster|adult\s*pads?|pediatric\s*pads?|split|regular|small|large|x-large|2x-large|extra\s*large|2xl|xxl|\d+\/0|\d+\s*(?:ft|kv))\b/i);
        const numSizeMatch = chunk.match(/\b(8\.5|9\.5|10\.5|11\.5|[89]|10|11|12)\b(?!\s*(?:in\b|"|''|ft\b|kv\b))/i);
        if (explicitSizeMatch && explicitSizeMatch[1].trim()) {
          size = explicitSizeMatch[1].trim();
        } else if (namedSpecMatch) {
          size = namedSpecMatch[1].trim();
        } else if (numSizeMatch) {
          size = numSizeMatch[1].trim();
        }
      }

      let unitPrice = 0;
      const priceMatch = chunk.match(/@\s*\$?\s*([\d,]+\.?\d{0,2})/);
      if (priceMatch) {
        unitPrice = parseFloat(priceMatch[1].replace(/,/g, '')) || 0;
      }

      let employeeName = '';
      const forMatch = chunk.match(/(?:\[|\()?\bfor\s*[:=]?\s*([A-Za-z0-9\s.',&-]+?)(?:\]|\)|;|$)/i);
      if (forMatch && !/^(?:mountain|power|stock|operations|replenishment)$/i.test(forMatch[1].trim())) {
        employeeName = forMatch[1].trim();
      }

      let partNumber = '';
      const partMatch = chunk.match(/(?:\bpart\s*(?:#|num(?:ber)?)?\s*[:#-]\s*|\bitem\s*(?:#|num(?:ber)?)\s*[:#-]?\s*)([A-Za-z0-9\-_.]+)/i);
      if (partMatch && !/^(?:size|class|for|on)$/i.test(partMatch[1].trim())) {
        partNumber = partMatch[1].trim();
      }

      result.push({
        quantity: qty,
        category: category,
        itemType: category,
        classVal: classVal,
        size: size,
        unitPrice: unitPrice,
        partNumber: partNumber,
        employeeName: employeeName
      });
    });
    return result;
  }

  suggestNextItemNumber(category, sizeOrSpec = '') {
    const cat = String(category || '').toLowerCase();
    const spec = String(sizeOrSpec || '').toLowerCase();
    let tableKey = 'gloves';
    let prefix = '';
    let defaultStart = 1001;

    if (cat.includes('glove')) {
      tableKey = 'gloves';
      defaultStart = 2000;
    } else if (cat.includes('sleeve')) {
      tableKey = 'sleeves';
      defaultStart = 3000;
    } else if (cat.includes('blanket')) {
      tableKey = 'blankets';
      const isSplit = spec.includes('split');
      prefix = isSplit ? 'S' : 'B';
      defaultStart = 100;
    } else if (cat.includes('mack')) {
      tableKey = 'macks';
      prefix = 'M';
      defaultStart = 1;
    } else if (cat.includes('hv') || cat.includes('tester')) {
      tableKey = 'hv_testers';
      prefix = 'HV';
      defaultStart = 1;
    } else if (cat.includes('phasing')) {
      tableKey = 'phasing_sets';
      prefix = 'PS';
      defaultStart = 1;
    } else if (cat.includes('ground')) {
      tableKey = 'grounds';
      prefix = 'GR';
      defaultStart = 1;
    } else if (cat.includes('hot') || cat.includes('stick')) {
      tableKey = 'hot_sticks';
      prefix = 'HS';
      defaultStart = 1;
    } else if (cat.includes('aed')) {
      tableKey = 'aed';
      prefix = 'AED';
      defaultStart = 1;
    }

    const table = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(tableKey) : null) || (window.localDB ? window.localDB.getTable(tableKey) : null);
    if (!table) return prefix ? `${prefix}${defaultStart}` : String(defaultStart);

    const rows = table.rows || table.rawGrid || [];
    let matchedMax = -1;
    let padWidth = 0;
    const prefixRegex = prefix ? new RegExp(`^${prefix}[\\s\\-_#]*?(\\d+)$`, 'i') : null;

    rows.forEach((r, idx) => {
      let numStr = '';
      if (Array.isArray(r)) {
        if (idx === 0) return; // skip header row
        numStr = String(r[0] || '').trim();
      } else if (r && typeof r === 'object') {
        numStr = String(
          r['Item #'] || r['Item Number'] || r['Serial #'] ||
          r['Glove'] || r['Sleeve'] || r['Blanket'] || r['MACK'] ||
          r['HVT #'] || r['HV Tester'] || r['Phasing Set #'] || r['Phasing Set'] || r['PS #'] ||
          r['AED #'] || r['AED'] || r['Ground #'] || r['Hot Stick #'] || r['Hot Stick'] ||
          Object.values(r)[0] || ''
        ).trim();
      }
      if (!numStr) return;

      let digits = '';
      if (prefixRegex) {
        const m = numStr.match(prefixRegex);
        if (!m) return;
        digits = m[1];
      } else {
        digits = numStr.replace(/^[A-Za-z#\s\-_]+/, '').trim();
      }

      const parsed = parseInt(digits, 10);
      if (!isNaN(parsed) && parsed > matchedMax) {
        matchedMax = parsed;
      }
      if (/^0\d+/.test(digits) && digits.length > padWidth) {
        padWidth = digits.length;
      }
    });

    const nextVal = matchedMax >= 0 ? (matchedMax + 1) : defaultStart;
    const formatted = (padWidth > 0 && String(nextVal).length < padWidth)
      ? String(nextVal).padStart(padWidth, '0')
      : String(nextVal);
    return prefix ? `${prefix}${formatted}` : formatted;
  }

  async syncVendorPrice(vendorName, itemCategory, size, classVal, newPrice) {
    if (!vendorName || !newPrice || isNaN(newPrice) || newPrice <= 0) return false;
    const vNorm = String(vendorName).trim().toLowerCase();
    const tType = (itemCategory || '').toLowerCase();

    // Sanity check: individual PPE gloves and sleeves never cost > $350 each.
    // If an entire order total (e.g. $2000.42) is passed, refuse to pollute the vendor catalog!
    if ((tType.includes('glove') || tType.includes('sleeve')) && newPrice > 350) {
      console.warn(`[Procurement] syncVendorPrice: Rejected unrealistic unit price ($${newPrice}) for ${itemCategory} ${size} from ${vendorName}. Looks like an order total.`);
      return false;
    }

    let vendor = this.vendors.find(v => (v.name || '').trim().toLowerCase() === vNorm);
    if (!vendor) {
      vendor = {
        name: vendorName.trim(),
        contact: '',
        email: '',
        phone: '',
        notes: '',
        items: []
      };
      this.vendors.push(vendor);
    }
    if (!vendor.items) vendor.items = [];

    const tSize = (size || '').toLowerCase().trim();

    let matchedItem = null;
    if (tSize && tSize !== '—' && !tSize.includes('needs size')) {
      matchedItem = vendor.items.find(ci => this.doesCatalogItemMatch(ci.item, itemCategory, classVal, size, true));
    }
    if (!matchedItem) {
      matchedItem = vendor.items.find(ci => {
        if (!this.doesCatalogItemMatch(ci.item, itemCategory, classVal, size, false)) return false;
        const itemStr = String(ci.item || '').toLowerCase();
        const hasAnyNumericSize = /\b(?:8|8\.5|9|9\.5|10|10\.5|11|11\.5|12)\b/.test(itemStr);
        const hasAnySleeveSize = /\b(?:regular|large|extra\s*large|x-large|small)\b/i.test(itemStr);
        return !hasAnyNumericSize && !hasAnySleeveSize;
      });
    }

    let updated = false;
    if (matchedItem) {
      if (Math.abs(matchedItem.price - newPrice) > 0.009) {
        matchedItem.price = newPrice;
        updated = true;
      }
    } else {
      const existingPartNum = this.getVendorPartNumber(vendorName, itemCategory, size, classVal) || '';
      const itemName = `${classVal ? classVal + ' ' : ''}${itemCategory}${size && size !== '—' && !size.includes('Needs') ? ' Size ' + size : ''}`.trim();
      vendor.items.push({
        item: itemName,
        itemNumber: existingPartNum,
        price: newPrice,
        category: this.inferCatalogItemCategory(itemName, existingPartNum)
      });
      updated = true;
    }

    if (updated) {
      console.log(`[Procurement] Auto-synced vendor price for ${vendorName} - ${itemCategory} ${classVal} ${size}: $${newPrice}`);
      await this.saveVendorsToDB(true);
      if (this.selectedVendor && this.selectedVendor.name.toLowerCase() === vNorm) {
        this.updatePricing();
      }
    }
    return updated;
  }

  scanPurchaseNeeds() {
    this.loadPreviousEmployees();

    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);

    const NON_ASSIGNED_STATUSES = new Set([
      'on shelf', 'shelf', 'lost', 'destroyed', 'failed rubber', 'failed',
      'retired', 'in testing', 'packed for testing', 'not repairable', 'reclaimed'
    ]);

    const cleanSize = (val, hasNoSize) => {
      if (hasNoSize) return '⚠️ Needs Size';
      if (val === null || val === undefined) return '';
      let s = String(val).trim();
      const lower = s.toLowerCase();
      if (!s || s === '—' || s === '-' || lower === 'n/a' || lower === 'none' || lower === 'unknown' || lower === 'null') {
        return '';
      }
      // Strip parenthetical class or notes, e.g. "8 (Class 0)" -> "8", "12 (Class 2)" -> "12"
      s = s.replace(/\s*\([^)]*\)/g, '').trim();
      return s;
    };

    // Tracks employees who already have purchase demands queued to avoid duplicate demands
    const coveredMap = {
      Gloves: new Set(),
      Sleeves: new Set(),
      Blankets: new Set(),
      MACKs: new Set()
    };

    const markCovered = (type, empName) => {
      if (!empName) return;
      if (empName.toLowerCase().includes('shelf') || empName.toLowerCase().includes('stock')) return;
      const clean = this.cleanEmployeeName(empName);
      if (clean && coveredMap[type]) {
        coveredMap[type].add(this.normalizeName(clean));
      }
    };

    const isCovered = (type, empName) => {
      if (!empName) return false;
      if (empName.toLowerCase().includes('shelf') || empName.toLowerCase().includes('stock')) return false;
      const norm = this.normalizeName(empName);
      if (!norm || !coveredMap[type]) return false;
      if (coveredMap[type].has(norm)) return true;
      for (const k of coveredMap[type]) {
        if (this.isNameMatch(k, norm)) return true;
      }
      return false;
    };

    // Build active employees directory
    const empTable = snap?.tables?.employees || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employees') : null);
    const empRows = empTable ? (empTable.rows || empTable.rawGrid || []) : [];
    const empDirectory = new Map();

    empRows.forEach(r => {
      let name = '';
      let gloveSize = '';
      let sleeveSize = '';
      let classification = '';
      let loc = '';
      let jobNumber = '';
      let lastDay = '';

      if (Array.isArray(r)) {
        name = String(r[0] || '').trim();
        loc = String(r[1] || '').trim();
        jobNumber = String(r[2] || '').trim();
        classification = String(r[3] || '').trim();
        gloveSize = String(r[4] || '').trim();
        sleeveSize = String(r[5] || '').trim();
        lastDay = String(r[13] || '').trim();
      } else if (r && typeof r === 'object') {
        name = String(r['Employee Name'] || r['Name'] || r['Worker'] || '').trim();
        loc = String(r['Location'] || r['City'] || '').trim();
        jobNumber = String(r['Job Number'] || r['Job #'] || r['Crew'] || '').trim();
        classification = String(r['Job Classification'] || r['Classification'] || r['Class'] || '').trim();
        gloveSize = String(r['Glove Size'] || r['Glove'] || '').trim();
        sleeveSize = String(r['Sleeve Size'] || r['Sleeve'] || '').trim();
        lastDay = String(r['Last Day'] || r['Term Date'] || '').trim();
      }

      if (!name) return;
      const normName = this.normalizeName(name);
      empDirectory.set(normName, {
        raw: r,
        name: name,
        location: loc,
        jobNumber: jobNumber,
        classification: classification,
        gloveSize: gloveSize,
        sleeveSize: sleeveSize,
        lastDay: lastDay
      });
    });

    const getEmpRecord = (empName) => {
      if (!empName) return null;
      const norm = this.normalizeName(empName);
      if (empDirectory.has(norm)) return empDirectory.get(norm);
      for (const [k, v] of empDirectory.entries()) {
        if (this.isNameMatch(k, norm)) return v;
      }
      return null;
    };

    const aggregated = {};

    // Tables & helper lookups for inventory presence and location voltage approval
    const glovesTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('gloves') : null) || snap?.tables?.['gloves'];
    const sleevesTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('sleeves') : null) || snap?.tables?.['sleeves'];
    const blanketsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('blankets') : null) || snap?.tables?.['blankets'];
    const macksTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('macks') : null) || snap?.tables?.['macks'];

    const getInventoryItemSize = (type, itemNum) => {
      if (!itemNum || itemNum === '—' || itemNum === '-') return '';
      const cleanNum = String(itemNum).trim().replace(/^[#]/, '');
      if (!cleanNum || cleanNum.toLowerCase() === 'none') return '';

      let table = null;
      if (type === 'Gloves') table = glovesTable;
      else if (type === 'Sleeves') table = sleevesTable;
      else if (type === 'Blankets') table = blanketsTable;
      else if (type === 'MACKs') table = macksTable;

      if (!table) return '';
      const rows = table.rows || table.rawGrid || [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        let num = '';
        let itemSz = '';
        if (Array.isArray(r)) {
          num = String(r[0] || '').trim();
          if (type === 'Blankets') {
            itemSz = String(r[1] || '').trim();
          } else {
            itemSz = String(r[2] || '').trim();
          }
        } else if (r && typeof r === 'object') {
          num = String(r['Item #'] || r['Item'] || r['Glove'] || r['Sleeve'] || r['Blanket'] || r['MACK'] || r['Serial #'] || r['ESL ID'] || Object.values(r)[0] || '').trim();
          itemSz = String(r['Size'] || r['Type'] || '').trim();
        }
        if (num) {
          const cleanRNum = num.replace(/^[#]/, '').trim();
          if (cleanRNum.toLowerCase() === cleanNum.toLowerCase()) {
            return cleanSize(itemSz);
          }
          const pNum = parseInt(cleanRNum, 10);
          const pClean = parseInt(cleanNum, 10);
          if (!isNaN(pNum) && !isNaN(pClean) && pNum === pClean && String(pNum) === cleanRNum && String(pClean) === cleanNum) {
            return cleanSize(itemSz);
          }
        }
      }
      return '';
    };

    const hasInventoryItem = (table, empName) => {
      if (!table || !empName) return false;
      const rows = table.rows || table.rawGrid || [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        let asg = '';
        let st = '';
        if (Array.isArray(r)) {
          if (i === 0) continue; // skip header row
          asg = String(r[8] || '').trim();
          st = String(r[7] || '').trim().toLowerCase();
        } else if (r && typeof r === 'object') {
          asg = String(r['Assigned To'] || r['Assigned'] || '').trim();
          st = String(r['Status'] || '').trim().toLowerCase();
        }
        if (!asg || NON_ASSIGNED_STATUSES.has(st) || asg.toLowerCase().includes('shelf')) continue;
        if (this.isNameMatch(asg, empName)) return true;
      }
      return false;
    };

    const locTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('locations') : null) || snap?.tables?.['locations'];
    const locApprovals = {};
    if (locTable && locTable.rows) {
      locTable.rows.forEach(r => {
        const loc = String(r['Location'] || Object.values(r)[0] || '').trim().toLowerCase();
        const app = String(r['Rubber Class Approval'] || r['Approval'] || Object.values(r)[6] || '').trim();
        if (loc && app) locApprovals[loc] = app;
      });
    }

    const getLocationApprovalClass = (empRec) => {
      if (!empRec || !empRec.location) return 'Class 2';
      const cleanEmpLoc = String(empRec.location).replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
      const app = locApprovals[cleanEmpLoc] ? locApprovals[cleanEmpLoc].toUpperCase() : '';
      if (app === 'CL3') return 'Class 3';
      if (app.includes('CL3') && (app.includes('&') || app.includes('BOTH'))) {
        if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.getPreferredPpeClass === 'function' && empRec.name) {
          const pref = window.ppeTrackingEngine.getPreferredPpeClass(empRec.name, 'gloves');
          if (pref && String(pref).includes('3')) return 'Class 3';
        }
        return 'Class 2';
      }
      if (app === 'CL2') return 'Class 2';
      return 'Class 2';
    };

    const cleanItemType = (typeVal) => {
      if (!typeVal) return 'Equipment';
      let t = String(typeVal).replace(/^[^\w]+/g, '').trim();
      return t || 'Equipment';
    };

    const cleanClass = (classVal) => {
      if (!classVal) return 'Class 2';
      let c = String(classVal).trim();
      return /^class\b/i.test(c) ? c : `Class ${c}`;
    };

    const normalizeTestingSubtype = (rawType, rawSize, typeLabel, partNumber) => {
      const s = `${rawType || ''} ${rawSize || ''} ${typeLabel || ''} ${partNumber || ''}`.toLowerCase();
      if (s.includes('sleeve')) return 'Sleeve Testing';
      if (s.includes('glove')) return 'Glove Testing';
      if (s.includes('blanket')) return 'Blanket Testing';
      if (s.includes('mack')) return 'MACK Testing';
      if (s.includes('tester') || s.includes('phasing')) return 'Tester Calibration';
      if (s.includes('stick')) return 'Hot Stick Testing';
      if (s.includes('ground')) return 'Ground Testing';
      return (rawSize && !rawSize.toLowerCase().includes('standard') && !rawSize.toLowerCase().includes('needs size') && !rawSize.toLowerCase().includes('labor & testing'))
        ? rawSize
        : 'Testing / Labor';
    };

    const addItem = (section, rawItemType, typeLabel, rawSize, hasNoSize, rawClassVal, empLabel, minDaysLeft, isImmediate, orderInfo = null) => {
      const itemType = cleanItemType(rawItemType);
      const size = cleanSize(rawSize, hasNoSize) || (hasNoSize ? '⚠️ Needs Size' : 'Standard');
      const classVal = cleanClass(rawClassVal);
      const isTesting = itemType === 'Testing' || rawItemType === 'Testing' ||
        /\b(?:testing|labor)\b/i.test(itemType) ||
        /\b(?:testing|labor)\b/i.test(rawItemType) ||
        /\b(?:testing|labor)\b/i.test(rawSize || '') ||
        /\b(?:testing|labor)\b/i.test(typeLabel || '') ||
        /\b(?:testing|labor)\b/i.test(orderInfo?.partNumber || '');
      const testingSubtype = isTesting
        ? normalizeTestingSubtype(rawItemType, rawSize, typeLabel, orderInfo?.partNumber)
        : '';
      const orderNumTag = (orderInfo?.vendorOrderNumber || orderInfo?.orderNumber || orderInfo?.poNumber || '');
      const aggKey = isTesting
        ? `${section}|Testing|${testingSubtype}|Class N/A|${orderNumTag}`
        : (section === 'ordered_pending'
          ? `${section}|${itemType}|${size}|${classVal}|${orderNumTag || 'PENDING'}`
          : `${section}|${itemType}|${size}|${classVal}`);

      if (!aggregated[aggKey]) {
        aggregated[aggKey] = {
          section: section,
          sectionTitle: this.SECTIONS[section] ? this.SECTIONS[section].title : section,
          itemType: isTesting ? 'Testing' : itemType,
          typeLabel: isTesting ? `🧪 ${testingSubtype}` : (typeLabel || (itemType === 'Gloves' ? '🧤 Gloves' : (itemType === 'Sleeves' ? '🦺 Sleeves' : (itemType === 'Blankets' ? '🧱 Blankets' : (itemType === 'MACKs' ? '🧱 MACKs' : `📦 ${itemType}`))))),
          size: isTesting ? testingSubtype : size,
          hasNoSize: isTesting ? false : !!hasNoSize,
          classVal: isTesting ? 'Class N/A' : classVal,
          quantity: 0,
          employees: [],
          sizeUpCount: 0,
          minDaysLeft: minDaysLeft !== undefined ? minDaysLeft : 30,
          isImmediate: !!isImmediate,
          selected: true,
          price: (orderInfo && orderInfo.price !== undefined && parseFloat(orderInfo.price) >= 0) ? parseFloat(orderInfo.price) : (isTesting ? 15 : 0),
          partNumber: isTesting ? (orderInfo?.partNumber || 'Labor Testing') : ((orderInfo && orderInfo.partNumber) ? String(orderInfo.partNumber).trim() : ''),
          orderInfo: orderInfo || null
        };
      }

      if (isTesting) {
        // One entry per testing category (e.g. Sleeve Testing, Glove Testing, Blanket Testing); no individual sub-entries
        const addQty = (orderInfo && orderInfo.quantity !== undefined) ? (parseInt(orderInfo.quantity, 10) || 0) : 1;
        const unitP = (orderInfo && orderInfo.price !== undefined && parseFloat(orderInfo.price) >= 0) ? parseFloat(orderInfo.price) : (aggregated[aggKey].price || 15);
        const prevUnits = aggregated[aggKey].quantity || 0;
        const prevTotal = (aggregated[aggKey].price || 0) * prevUnits;
        const newUnits = prevUnits + addQty;
        aggregated[aggKey].quantity = newUnits;
        aggregated[aggKey].price = newUnits > 0 ? (prevTotal + (unitP * addQty)) / newUnits : unitP;
        aggregated[aggKey].employees = [];
        return;
      }

      if (orderInfo) {
        if (!aggregated[aggKey].orderInfo) aggregated[aggKey].orderInfo = orderInfo;
        const op = parseFloat(orderInfo.price) || 0;
        if (op > 0 && !aggregated[aggKey].price) {
          aggregated[aggKey].price = op;
        }
      }
      if (!aggregated[aggKey].price || !aggregated[aggKey].partNumber) {
        const catMatch = this.matchVendorItem(itemType, size, classVal, orderInfo?.vendor || null);
        if (catMatch) {
          if (catMatch.price > 0 && !aggregated[aggKey].price) {
            aggregated[aggKey].price = catMatch.price;
          }
          if (catMatch.partNumber && !aggregated[aggKey].partNumber) {
            aggregated[aggKey].partNumber = catMatch.partNumber;
          }
        }
      }

      if (empLabel) {
        let empName = empLabel;
        let empDetail = '';
        const match = empLabel.match(/^([^(]+?)\s*\((.+)\)$/);
        if (match) {
          empName = match[1].trim();
          empDetail = match[2].trim();
        } else {
          empName = empLabel.trim();
        }

        const isStock = empName.toLowerCase().includes('stock') || empName.toLowerCase().includes('shelf');
        const existing = isStock ? null : aggregated[aggKey].employees.find(e => this.isNameMatch(e.name, empName));
        if (!existing) {
          aggregated[aggKey].employees.push({
            name: empName,
            label: empLabel,
            detail: empDetail,
            checked: true,
            orderInfo: orderInfo || null
          });
          aggregated[aggKey].quantity += 1;
        } else {
          if (orderInfo && !existing.orderInfo) {
            existing.orderInfo = orderInfo;
          }
        }
      } else {
        aggregated[aggKey].quantity += 1;
      }

      if (isImmediate) aggregated[aggKey].isImmediate = true;
      if (minDaysLeft !== undefined && minDaysLeft < aggregated[aggKey].minDaysLeft) {
        aggregated[aggKey].minDaysLeft = minDaysLeft;
      }
    };

    // =========================================================================
    // SECTION 1 & 2: SWAPS PAGES (Need to Purchase & Size Up Replacements)
    // =========================================================================
    const swapSheets = [
      { key: 'glove_swaps', type: 'Gloves', label: '🧤 Gloves' },
      { key: 'sleeve_swaps', type: 'Sleeves', label: '🦺 Sleeves' },
      { key: 'blanket_swaps', type: 'Blankets', label: '🧱 Blankets' },
      { key: 'mack_swaps', type: 'MACKs', label: '🧱 MACKs' },
      { key: 'hv_tester_swaps', type: 'HV Testers', label: '⚡ HV Testers' },
      { key: 'phasing_set_swaps', type: 'Phasing Sets', label: '⚡ Phasing Sets' },
      { key: 'ground_swaps', type: 'Grounds', label: '⚡ Grounds' },
      { key: 'hot_stick_swaps', type: 'Hot Sticks', label: '🔴 Hot Sticks' },
      { key: 'aed_swaps', type: 'AED', label: '🏥 AED Units' }
    ];

    swapSheets.forEach(s => {
      const table = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(s.key) : null) || snap?.tables?.[s.key];
      if (!table) return;

      const rawRows = table.rawGrid || table.rows || [];
      if (!rawRows.length) return;

      let defaultClass = 'Class 2';
      if (s.type === 'Gloves') defaultClass = 'Class 2';
      else if (s.type === 'Sleeves') defaultClass = 'Class 2';
      else if (s.type === 'Blankets') defaultClass = 'Class 4';
      else if (s.type === 'MACKs') defaultClass = 'Class 4';
      let currentClass = defaultClass;

      rawRows.forEach((row) => {
        let emp = '';
        let size = '—';
        let pickItem = '';
        let status = '';
        let daysLeft = 30;
        let daysRaw = '';
        let rowClass = currentClass;
        let isImmediateRow = false;

        if (Array.isArray(row)) {
          const firstCell = String(row[0] || '').trim();
          if (firstCell.toUpperCase().includes('CLASS 0')) currentClass = 'Class 0';
          else if (firstCell.toUpperCase().includes('CLASS 2')) currentClass = 'Class 2';
          else if (firstCell.toUpperCase().includes('CLASS 3')) currentClass = 'Class 3';
          else if (firstCell.toUpperCase().includes('CLASS 4')) currentClass = 'Class 4';

          // Skip section headers or subheaders
          if (firstCell.includes('📍') || firstCell.includes('👤') || firstCell.includes('👷') ||
              firstCell.includes('Foreman:') || firstCell.includes('Swaps') ||
              firstCell === 'Employee' || firstCell === 'Crew Lead / Employee' || firstCell === 'Item #' || firstCell === 'Serial #') {
            return;
          }

          emp = firstCell;
          if (s.type === 'MACKs') {
            size = String(row[3] || '—').trim();
            daysRaw = String(row[7] || '').trim();
            pickItem = String(row[8] || '').trim();
            status = String(row[9] || '').trim();
            rowClass = String(row[2] || '').trim() || currentClass;
          } else {
            size = String(row[2] || '—').trim();
            daysRaw = String(row[5] || '').trim();
            pickItem = String(row[6] || '').trim();
            status = String(row[7] || '').trim();
            rowClass = currentClass;
          }
          const daysVal = parseInt(daysRaw, 10);
          if (!isNaN(daysVal)) daysLeft = daysVal;

          if (daysVal <= 0) {
            isImmediateRow = true;
          }
        } else if (typeof row === 'object' && row !== null) {
          emp = String(row['Employee'] || row['Employee Name'] || row['Assigned To'] || '').trim();
          size = String(row['Size'] || '—').trim();
          daysRaw = String(row['Days Left'] || row['Days Remaining'] || '').trim();
          const daysVal = parseInt(daysRaw, 10);
          if (!isNaN(daysVal)) daysLeft = daysVal;
          pickItem = String(row['Pick List Item #'] || row['Pick Item #'] || row['Pick Item'] || row['Pick List'] || row['Picked For'] || '').trim();
          status = String(row['Status'] || row['Pick List Status'] || '').trim();
          if (row['Class'] || row['KV']) {
            const cStr = String(row['Class'] || row['KV']).trim();
            rowClass = cStr.toLowerCase().startsWith('class') ? cStr : `Class ${cStr}`;
          } else {
            rowClass = currentClass;
          }
          if (String(row['Urgency'] || '').toLowerCase() === 'immediate' || daysLeft <= 0) {
            isImmediateRow = true;
          }
        }

        const statLower = status.toLowerCase();
        const isSizeUp = statLower.includes('size up');
        const isShelfStock = emp.toLowerCase().includes('on shelf') || emp.toLowerCase() === 'shelf';

        // Check if item is already ordered (awaiting delivery)
        if (statLower.includes('ordered')) {
          if (this.isDepartedOrPreviousEmployee(emp)) return;
          const notesText = Array.isArray(row) ? String(row[11] || '') : String(row['Notes'] || '');
          let orderInfo = this.lookupOrderForEmployee(emp, s.type, size, rowClass) ||
                          this.parseOrderInfoFromNotes(notesText) ||
                          this.parseOrderInfoFromNotes(status) ||
                          { orderNumber: '', vendor: '', orderDate: '', price: 0 };

          if (orderInfo && orderInfo.orderNumber && orderInfo.orderNumber.toLowerCase() === 'ed') {
            orderInfo.orderNumber = '';
            orderInfo.vendorOrderNumber = '';
            orderInfo.poNumber = '';
          }

          if (orderInfo && !orderInfo.orderNumber) {
            const activePo = this.findActiveOpenPo(emp, s.type, size, rowClass);
            if (activePo) {
              orderInfo.orderNumber = activePo.orderNumber;
              orderInfo.vendorOrderNumber = activePo.vendorOrderNumber || activePo.orderNumber;
              orderInfo.poNumber = activePo.orderNumber;
              if (!orderInfo.vendor && activePo.vendor) orderInfo.vendor = activePo.vendor;
              if (!orderInfo.orderDate && activePo.orderDate) orderInfo.orderDate = activePo.orderDate;
              if ((!orderInfo.price || orderInfo.price <= 0 || (orderInfo.price > 1200 && /glove|sleeve|blanket/i.test(s.type))) && activePo.unitPrice > 0) {
                orderInfo.price = activePo.unitPrice;
              }
              if (!orderInfo.expectedDelivery && activePo.expectedDelivery) orderInfo.expectedDelivery = activePo.expectedDelivery;
            }
          }

          if (orderInfo && orderInfo.orderNumber) {
            const enriched = this.lookupOrderByPoNumber(orderInfo.orderNumber, emp, s.type, size, rowClass);
            if (enriched) {
              if (!orderInfo.vendor && enriched.vendor) orderInfo.vendor = enriched.vendor;
              if ((!orderInfo.price || orderInfo.price <= 0 || (orderInfo.price > 1200 && /glove|sleeve|blanket/i.test(s.type))) && enriched.unitPrice > 0) {
                orderInfo.price = enriched.unitPrice;
              }
              if (!orderInfo.orderDate && enriched.orderDate) orderInfo.orderDate = enriched.orderDate;
              if (!orderInfo.expectedDelivery && enriched.expectedDelivery) orderInfo.expectedDelivery = enriched.expectedDelivery;
              if (!orderInfo.vendorOrderNumber && enriched.vendorOrderNumber) orderInfo.vendorOrderNumber = enriched.vendorOrderNumber;
              if (enriched.matchedClass) rowClass = enriched.matchedClass;
            }
          }
          const validRowSize = cleanSize(size);
          const empRec = getEmpRecord(emp);
          const meta = empRec ? this.parseTrackedClassification(empRec.classification) : null;
          if (meta && !rowClass && (/glove/i.test(s.type))) {
            rowClass = getLocationApprovalClass(empRec);
          }
          let neededSize = validRowSize;
          if (!neededSize && !isShelfStock) {
            const prefSize = s.type === 'Gloves' ? cleanSize(empRec?.gloveSize) : (s.type === 'Sleeves' ? cleanSize(empRec?.sleeveSize) : '');
            neededSize = prefSize || 'Standard';
          }
          if (!neededSize && isShelfStock) neededSize = 'Standard';

          const displayOrderNum = orderInfo.vendorOrderNumber || orderInfo.orderNumber || '';
          let poLabel = displayOrderNum ? `Order #: ${displayOrderNum}` : 'Ordered';
          if (orderInfo.vendor) poLabel += ` · ${orderInfo.vendor}`;
          const empLabel = `${emp} (📦 ${poLabel})`;

          addItem('ordered_pending', s.type, s.label, neededSize, false, rowClass, empLabel, daysLeft, isImmediateRow, orderInfo);
          markCovered(s.type, emp);
          return;
        }

        // Filter out return/reclaim/former employee indicators
        const isPrevEmpIndicator = daysRaw.toUpperCase().includes('PREV') ||
                                   statLower.includes('return to shelf') ||
                                   statLower.includes('reclaim') ||
                                   statLower.includes('previous') ||
                                   statLower.includes('departed') ||
                                   statLower.includes('inactive') ||
                                   (statLower.includes('return') && !isShelfStock) ||
                                   (statLower.includes('shelf') && !isShelfStock);

        if (isPrevEmpIndicator) return;

        // If swap row represents a new assignment satisfied by shelf stock or picked for delivery, do not purchase!
        const isNeedsEquipment = statLower.includes('needs equipment') || statLower.includes('needs size');
        if (isNeedsEquipment) {
          const hasPickedItem = pickItem && pickItem !== '—' && pickItem !== '-' && !pickItem.includes('Needs Size');
          if (hasPickedItem || statLower.includes('ready for delivery')) {
            markCovered(s.type, emp);
            return;
          }
        }

        const isNonPurchaseTerminalStat =
          statLower.includes('return') ||
          statLower.includes('reclaim') ||
          statLower.includes('complete') ||
          statLower.includes('ready for delivery') ||
          statLower.includes('delivered') ||
          statLower.includes('in stock') ||
          statLower.includes('excluded') ||
          statLower.includes('skipped') ||
          statLower.includes('cancel') ||
          statLower.includes('picked');

        const isNeedToPurchase = statLower.includes('need to purchase') ||
                                 statLower.includes('purchase') ||
                                 isSizeUp ||
                                 (pickItem === '—' && !isNonPurchaseTerminalStat) ||
                                 (pickItem === '' && statLower.includes('unassigned'));

        if (!isNeedToPurchase || !emp) return;

        // Filter out former / previous employees
        if (this.isDepartedOrPreviousEmployee(emp)) return;
        if (statLower.includes('reclaim') || statLower.includes('previous') || statLower.includes('departed')) return;

        // Exclude personnel on Gas and Mechanic crews from generating glove and sleeve purchase needs.
        // Electric, Office, AND Substation employees assigned an item that is out of stock or size up are included!
        if ((s.type === 'Gloves' || s.type === 'Sleeves') && !isShelfStock) {
          const crewType = this.getEmployeeCrewType(emp);
          if (crewType === 'Gas' || crewType === 'Mechanic') {
            return;
          }
          if (this.isManualPpeExcluded(emp)) {
            return;
          }
        }

        const empRec = getEmpRecord(emp);

        if (isSizeUp) {
          // Requirement 2: Swaps Page Size Up Replacements
          const prefSize = s.type === 'Gloves' ? cleanSize(empRec?.gloveSize) : (s.type === 'Sleeves' ? cleanSize(empRec?.sleeveSize) : '');
          const validRowSize = cleanSize(size);
          const neededSize = prefSize || validRowSize || '⚠️ Needs Size';
          const hasNoSize = (neededSize === '⚠️ Needs Size');

          // Resolve actual size of the picked item from inventory
          let pickedSize = getInventoryItemSize(s.type, pickItem);
          if (!pickedSize) {
            if (s.type === 'Gloves') {
              const n = parseFloat(neededSize);
              if (!isNaN(n)) pickedSize = String(n + 0.5);
            } else if (s.type === 'Sleeves') {
              const sleeveNext = {
                'small': 'Regular', 'sm': 'Regular',
                'regular': 'Large', 'reg': 'Large',
                'large': 'X-Large', 'lg': 'X-Large',
                'extra large': '2X-Large', 'xl': '2X-Large'
              };
              pickedSize = sleeveNext[neededSize.toLowerCase()] || '';
            }
          }
          if (!pickedSize || pickedSize === neededSize) {
            if (s.type === 'Gloves') {
              const n = parseFloat(neededSize);
              if (!isNaN(n)) pickedSize = String(n + 0.5);
            }
            if (!pickedSize) pickedSize = 'Size Up';
          }

          const cleanPickNum = String(pickItem || '').trim().replace(/^[#]/, '');
          const hasValidPickNum = cleanPickNum && cleanPickNum !== '—' && cleanPickNum !== '-' && cleanPickNum.toLowerCase() !== 'none';
          const itemTag = hasValidPickNum ? ` (#${cleanPickNum})` : '';

          const empLabel = hasNoSize
            ? `${emp} (Size Up Picked: ${pickedSize}${itemTag} ⚠️ Needs Size)`
            : `${emp} (Size Up Picked: ${pickedSize}${itemTag} → Needed: ${neededSize})`;

          addItem('swaps_size_up', s.type, s.label, neededSize, hasNoSize, rowClass, empLabel, daysLeft, isImmediateRow);
          markCovered(s.type, emp);
        } else {
          // Requirement 1: Swaps Page Need To Purchase
          const validRowSize = cleanSize(size);
          let neededSize = validRowSize;
          let hasNoSize = false;

          if (!neededSize && !isShelfStock) {
            const prefSize = s.type === 'Gloves' ? cleanSize(empRec?.gloveSize) : (s.type === 'Sleeves' ? cleanSize(empRec?.sleeveSize) : '');
            neededSize = prefSize || '⚠️ Needs Size';
            hasNoSize = (neededSize === '⚠️ Needs Size');
          }
          if (!neededSize && isShelfStock) {
            neededSize = 'Standard';
          }

          const empLabel = hasNoSize ? `${emp} (⚠️ No preferred size listed in Employees)` : emp;
          addItem('swaps_need', s.type, s.label, neededSize, hasNoSize, rowClass, empLabel, daysLeft, isImmediateRow);
          markCovered(s.type, emp);
        }
      });
    });

    // Scan safety_equipment_needs table
    const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
    if (needsTable) {
      const nRows = needsTable.rows || needsTable.rawGrid || [];
      nRows.forEach(row => {
        let emp = '';
        let itemType = 'Gloves';
        let typeLabel = '🧤 Gloves';
        let size = '—';
        let rowClass = 'Class 2';
        let urgency = 'Immediate';
        let status = '';

        if (row && typeof row === 'object' && !Array.isArray(row)) {
          const meta = this._getSafetyNeedMeta(row);
          if (!meta) return;
          emp = meta.employee;
          const rawType = meta.itemType;
          if (rawType.toLowerCase().includes('sleeve')) {
            itemType = 'Sleeves';
            typeLabel = '🦺 Sleeves';
          } else if (rawType.toLowerCase().includes('glove')) {
            itemType = 'Gloves';
            typeLabel = '🧤 Gloves';
          } else if (rawType.toLowerCase().includes('blanket')) {
            itemType = 'Blankets';
            typeLabel = '🧱 Blankets';
          } else if (rawType.toLowerCase().includes('mack')) {
            itemType = 'MACKs';
            typeLabel = '🧱 MACKs';
          } else {
            itemType = rawType || 'Other';
            typeLabel = `📦 ${itemType}`;
          }
          size = meta.size || '—';
          rowClass = meta.classVal || 'Class 2';
          urgency = meta.urgency || 'Immediate';
          status = meta.status.toLowerCase();
        }

        if (!emp || status.includes('received') || status.includes('fulfilled')) return;

        if (status.includes('ordered')) {
          if (this.isDepartedOrPreviousEmployee(emp)) return;
          let orderInfo = this.lookupOrderForEmployee(emp, itemType, size, rowClass) ||
                          this.parseOrderInfoFromNotes(row['Notes']) ||
                          { orderNumber: '', vendor: '', orderDate: '', price: 0 };

          if (orderInfo && orderInfo.orderNumber && orderInfo.orderNumber.toLowerCase() === 'ed') {
            orderInfo.orderNumber = '';
            orderInfo.vendorOrderNumber = '';
            orderInfo.poNumber = '';
          }

          if (orderInfo && !orderInfo.orderNumber) {
            const activePo = this.findActiveOpenPo(emp, itemType, size, rowClass);
            if (activePo) {
              orderInfo.orderNumber = activePo.orderNumber;
              orderInfo.vendorOrderNumber = activePo.vendorOrderNumber || activePo.orderNumber;
              orderInfo.poNumber = activePo.orderNumber;
              if (!orderInfo.vendor && activePo.vendor) orderInfo.vendor = activePo.vendor;
              if (!orderInfo.orderDate && activePo.orderDate) orderInfo.orderDate = activePo.orderDate;
              if ((!orderInfo.price || orderInfo.price <= 0 || (orderInfo.price > 1200 && /glove|sleeve|blanket/i.test(itemType))) && activePo.unitPrice > 0) {
                orderInfo.price = activePo.unitPrice;
              }
              if (!orderInfo.expectedDelivery && activePo.expectedDelivery) orderInfo.expectedDelivery = activePo.expectedDelivery;
            }
          }

          if (orderInfo && orderInfo.orderNumber) {
            const enriched = this.lookupOrderByPoNumber(orderInfo.orderNumber, emp, itemType, size, rowClass);
            if (enriched) {
              if (!orderInfo.vendor && enriched.vendor) orderInfo.vendor = enriched.vendor;
              if ((!orderInfo.price || orderInfo.price <= 0 || (orderInfo.price > 1200 && /glove|sleeve|blanket/i.test(itemType))) && enriched.unitPrice > 0) {
                orderInfo.price = enriched.unitPrice;
              }
              if (!orderInfo.orderDate && enriched.orderDate) orderInfo.orderDate = enriched.orderDate;
              if (!orderInfo.expectedDelivery && enriched.expectedDelivery) orderInfo.expectedDelivery = enriched.expectedDelivery;
              if (!orderInfo.vendorOrderNumber && enriched.vendorOrderNumber) orderInfo.vendorOrderNumber = enriched.vendorOrderNumber;
              if (enriched.matchedClass) rowClass = enriched.matchedClass;
            }
          }

          const empRec = getEmpRecord(emp);
          const meta = empRec ? this.parseTrackedClassification(empRec.classification) : null;
          if (meta && !rowClass && (/glove/i.test(itemType))) {
            rowClass = getLocationApprovalClass(empRec);
          }

          const displayOrderNum = orderInfo.vendorOrderNumber || orderInfo.orderNumber || '';
          let poLabel = displayOrderNum ? `Order #: ${displayOrderNum}` : 'Ordered';
          if (orderInfo.vendor) poLabel += ` · ${orderInfo.vendor}`;
          const empLabel = `${emp} (📦 ${poLabel})`;
          addItem('ordered_pending', itemType, typeLabel, cleanSize(size) || 'Standard', false, rowClass, empLabel, 15, false, orderInfo);
          markCovered(itemType, emp);
          return;
        }

        if (this.isDepartedOrPreviousEmployee(emp)) return;

        // If the employee already holds active inventory for this item type, their need is already met
        if (itemType === 'Gloves' && hasInventoryItem(glovesTable, emp)) return;
        if (itemType === 'Sleeves' && hasInventoryItem(sleevesTable, emp)) return;

        const empRec = getEmpRecord(emp);
        const meta = empRec ? this.parseTrackedClassification(empRec.classification) : null;
        // For electrical lineworkers, sanitize Class 0 default to location approval or Class 2
        if (meta && (rowClass === 'Class 0' || !rowClass)) {
          rowClass = getLocationApprovalClass(empRec);
        }

        const isImmediate = urgency.toLowerCase() === 'immediate';
        const isSizeUp = status.includes('size up');
        // Non-swap missing PPE belongs under PPE Compliance — Missing Equipment, not Swaps
        const section = isSizeUp ? 'swaps_size_up' : 'compliance_missing';
        const cleanS = cleanSize(size) || '⚠️ Needs Size';
        const hasNoSize = (cleanS === '⚠️ Needs Size');
        const empDetail = isSizeUp ? 'Size Up' : (meta ? `${meta.code} - Missing ${itemType}` : `Missing ${itemType}`);
        const empLabel = `${emp} (${empDetail})`;

        addItem(section, itemType, typeLabel, cleanS, hasNoSize, rowClass, empLabel, isImmediate ? 0 : 15, isImmediate);
        markCovered(itemType, emp);
      });
    }

    // =========================================================================
    // SECTION: ACTIVE PURCHASE ORDERS (Open POs Awaiting Delivery)
    // =========================================================================
    const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
    if (poTable) {
      const poRows = poTable.rows || poTable.rawGrid || [];
      poRows.forEach(poRow => {
        let poNum = '';
        let vendor = '';
        let dateStr = '';
        let itemsStr = '';
        let totalPrice = 0;
        let expDeliv = '';
        let status = '';
        let notes = '';

        if (Array.isArray(poRow)) {
          if (String(poRow[0] || '').toLowerCase() === 'date') return;
          dateStr = String(poRow[0] || '').trim();
          poNum = String(poRow[1] || '').trim();
          vendor = String(poRow[2] || '').trim();
          itemsStr = String(poRow[3] || '').trim();
          totalPrice = parseFloat(poRow[4]) || 0;
          expDeliv = String(poRow[5] || '').trim();
          status = String(poRow[6] || '').trim().toLowerCase();
          notes = String(poRow[7] || '').trim();
        } else if (poRow && typeof poRow === 'object') {
          dateStr = String(poRow['Date'] || '').trim();
          poNum = String(poRow['PO Number'] || poRow['PO #'] || '').trim();
          vendor = String(poRow['Vendor'] || '').trim();
          itemsStr = String(poRow['Items'] || '').trim();
          totalPrice = parseFloat(poRow['Total Price'] || poRow['Price'] || 0) || 0;
          expDeliv = String(poRow['Expected Delivery'] || '').trim();
          status = String(poRow['Status'] || '').trim().toLowerCase();
          notes = String(poRow['Notes'] || '').trim();
        }

        if (!status || status.includes('received') || status.includes('fulfilled') || status.includes('cancel')) {
          return;
        }

        const parsedItems = this.parsePoItemsString(itemsStr);
        const totalPoUnits = parsedItems.reduce((sum, item) => sum + (parseInt(item.quantity, 10) || 1), 0) || 1;

        parsedItems.forEach(pi => {
          const normCat = cleanItemType(pi.category);
          const normSize = cleanSize(pi.size) || 'Standard';
          const normClass = cleanClass(pi.classVal);

          const isTestingItem = normCat === 'Testing' || /\b(?:testing|labor)\b/i.test(normCat) || /\b(?:testing|labor)\b/i.test(normSize) || /\b(?:testing|labor)\b/i.test(pi.item || '') || /\b(?:testing|labor)\b/i.test(pi.partNumber || '');
          if (isTestingItem) {
            const testSubtype = normalizeTestingSubtype(normCat, pi.size || normSize, pi.item || '', pi.partNumber || '');
            const parsedNotes = this.parseOrderInfoFromNotes(notes);
            const orderInfoForTesting = {
              orderNumber: poNum,
              poNumber: poNum,
              vendorOrderNumber: parsedNotes?.vendorOrderNumber || '',
              vendor: vendor,
              orderDate: dateStr,
              expectedDelivery: expDeliv || '',
              quantity: (pi.quantity !== undefined ? parseInt(pi.quantity, 10) : 1),
              price: (pi.unitPrice !== undefined && pi.unitPrice !== null) ? (parseFloat(pi.unitPrice) || 0) : 15,
              partNumber: pi.partNumber || 'Labor Testing'
            };
            addItem('ordered_pending', 'Testing', `🧪 ${testSubtype}`, testSubtype, false, 'Class N/A', null, 15, false, orderInfoForTesting);
            return;
          }

          const parsedNotes = this.parseOrderInfoFromNotes(notes);
          const cleanPo = (poNum || '').toLowerCase();
          const cleanVendorOrder = (parsedNotes?.vendorOrderNumber || '').toLowerCase();
          const candidateOrderTag = parsedNotes?.vendorOrderNumber || poNum || 'PENDING';
          const candidateKeys = Array.from(new Set([
            `ordered_pending|${normCat}|${normSize}|${normClass}|${candidateOrderTag}`,
            `ordered_pending|${normCat}|${normSize}|${normClass}|${poNum || 'PENDING'}`,
            `ordered_pending|${normCat}|${normSize}|${normClass}|PENDING`
          ]));

          let currentOrderQty = 0;
          candidateKeys.forEach(k => {
            const existingItem = aggregated[k];
            if (!existingItem) return;
            currentOrderQty += (existingItem.employees || []).filter(e => {
              const oNum = (e.orderInfo?.orderNumber || '').toLowerCase();
              const vNum = (e.orderInfo?.vendorOrderNumber || '').toLowerCase();
              const lbl = (e.label || '').toLowerCase();
              return (cleanPo && (oNum === cleanPo || lbl.includes(cleanPo))) ||
                     (cleanVendorOrder && (vNum === cleanVendorOrder || lbl.includes(cleanVendorOrder)));
            }).length;
          });

          // Subtract units already partially received and persisted in the batch delivery draft store
          let alreadyReceivedDraftQty = 0;
          try {
            const batchDrafts = this._getBatchDraftStore ? this._getBatchDraftStore() : {};
            const bucketCandidates = [cleanVendorOrder, cleanPo].filter(Boolean);
            for (const bk of Object.keys(batchDrafts || {})) {
              const bkLower = bk.toLowerCase();
              if (!bucketCandidates.some(c => bkLower === c || bkLower.includes(c))) continue;
              const unitMap = batchDrafts[bk]?.units || {};
              for (const uDraft of Object.values(unitMap)) {
                if (!uDraft || !uDraft.received) continue;
                const dCat = cleanItemType(uDraft.category || '').toLowerCase();
                const dSz = cleanSize(uDraft.size || '').toLowerCase();
                const dCls = cleanClass(uDraft.classVal || '').toLowerCase();
                if (dCat === normCat.toLowerCase() && dSz === normSize.toLowerCase() && dCls === normClass.toLowerCase()) {
                  alreadyReceivedDraftQty++;
                }
              }
            }
          } catch { /* ignore draft parse issues */ }

          const remainingPoQty = Math.max(0, pi.quantity - alreadyReceivedDraftQty);
          if (currentOrderQty < remainingPoQty) {
            const neededQty = remainingPoQty - currentOrderQty;
            const typeLabel = normCat === 'Gloves' ? '🧤 Gloves' : (normCat === 'Sleeves' ? '🦺 Sleeves' : (normCat === 'Blankets' ? '🧱 Blankets' : (normCat === 'MACKs' ? '🧱 MACKs' : `📦 ${normCat}`)));

            let calculatedPrice = pi.unitPrice || 0;
            if (!calculatedPrice && totalPrice > 0) {
              const avg = totalPrice / totalPoUnits;
              if (!/glove|sleeve/i.test(normCat) || avg <= 350) {
                calculatedPrice = avg;
              }
            }

            const orderInfo = {
              orderNumber: poNum,
              poNumber: poNum,
              vendorOrderNumber: parsedNotes?.vendorOrderNumber || '',
              vendor: vendor,
              orderDate: dateStr,
              expectedDelivery: expDeliv || '',
              price: calculatedPrice || 0,
              partNumber: pi.partNumber || ''
            };

            let empForPo = pi.employeeName || '';
            if (!empForPo && notes) {
              const notesEmpMatch = notes.match(/(?:for|assign(?:ed)?\s*to)\s*[:=]?\s*([A-Za-z0-9\s.',&-]+?)(?:;|\)|$)/i);
              if (notesEmpMatch && !/^(?:mountain|power|stock|operations|replenishment)$/i.test(notesEmpMatch[1].trim())) {
                empForPo = notesEmpMatch[1].trim();
              }
            }

            const empNamesList = empForPo
              ? empForPo.split(',').map(n => n.trim()).filter(Boolean)
              : [];

            // Match employees by their required size/classification
            const matchingEmps = empNamesList.filter(name => {
              if (isCovered(normCat, name)) return false;
              if (name.toLowerCase().includes('shelf') || name.toLowerCase().includes('stock')) return false;
              const rec = getEmpRecord(name);
              if (!rec) return true;
              const eSize = normCat === 'Gloves' ? cleanSize(rec.gloveSize) : cleanSize(rec.sleeveSize);
              return !eSize || eSize === normSize;
            });

            for (let q = 0; q < neededQty; q++) {
              let assignedName = matchingEmps[q] || (pi.employeeName && !pi.employeeName.toLowerCase().includes('shelf') ? pi.employeeName : '');
              if (assignedName && isCovered(normCat, assignedName)) {
                // If employee is already covered by an earlier unit, do not drop the unit! Revert to On Shelf
                assignedName = '';
              }
              const displayOrderNum = (orderInfo.vendorOrderNumber || poNum || 'Pending');
              const isShelf = !assignedName || assignedName.toLowerCase().includes('shelf') || assignedName.toLowerCase().includes('stock');
              const label = !isShelf
                ? `${assignedName} (📦 Order #: ${displayOrderNum})`
                : (vendor ? `On Shelf (📦 Order #: ${displayOrderNum} · ${vendor})` : `On Shelf (📦 Order #: ${displayOrderNum})`);

              addItem('ordered_pending', normCat, typeLabel, normSize, false, normClass, label, 15, false, orderInfo);
              if (assignedName && !isShelf) {
                markCovered(normCat, assignedName);
              }
            }
          }
        });
      });
    }

    // =========================================================================
    // SECTION 3: CURRENTLY ASSIGNED — SIZE UP IN FIELD
    // =========================================================================
    // Active personnel in the field currently wearing an oversized glove or sleeve
    if (glovesTable) {
      const gRows = glovesTable.rows || glovesTable.rawGrid || [];
      gRows.forEach((g, idx) => {
        let asg = '';
        let assignedSize = '';
        let classVal = 'Class 2';
        let status = '';
        let notes = '';

        if (Array.isArray(g)) {
          if (idx === 0) return; // skip header row
          asg = String(g[8] || '').trim();
          assignedSize = String(g[2] || '').trim();
          const rawClass = (g[3] !== undefined && g[3] !== null && String(g[3]).trim() !== '') ? g[3] : 'Class 2';
          classVal = String(rawClass).trim();
          status = String(g[7] || '').trim();
          notes = String(g[11] || '').trim();
        } else if (g && typeof g === 'object') {
          asg = String(g['Assigned To'] || g['Assigned'] || '').trim();
          assignedSize = String(g['Size'] || '').trim();
          const rawClass = (g['Class'] !== undefined && g['Class'] !== null && String(g['Class']).trim() !== '') ? g['Class'] : 'Class 2';
          classVal = String(rawClass).trim();
          status = String(g['Status'] || '').trim();
          notes = String(g['Notes'] || '').trim();
        }

        if (!asg) return;
        const asgLower = asg.toLowerCase();
        if (asgLower.includes('shelf') || asgLower === 'unassigned' || asgLower === 'lost' || asgLower === 'in testing') return;
        if (this.isDepartedOrPreviousEmployee(asg)) return;

        const statLower = status.toLowerCase();
        if (NON_ASSIGNED_STATUSES.has(statLower)) return;

        // Skip if already queued under Swaps for Gloves
        if (isCovered('Gloves', asg)) return;

        const empRec = getEmpRecord(asg);
        if (!empRec) return;
        if (empRec.location && empRec.location.toLowerCase().includes('previous')) return;

        const prefGlove = cleanSize(empRec.gloveSize);
        const notesLower = notes.toLowerCase();

        const hasMarker = statLower.includes('size up') || notesLower.includes('size up');
        const numAssigned = parseFloat(assignedSize);
        const numPref = parseFloat(prefGlove);
        const isMismatch = !isNaN(numAssigned) && !isNaN(numPref) && (numAssigned > numPref);

        if (hasMarker || isMismatch) {
          const neededSize = prefGlove || '⚠️ Needs Size';
          const hasNoSize = !prefGlove;
          const finalClass = classVal.toLowerCase().startsWith('class') ? classVal : `Class ${classVal}`;
          const empLabel = hasNoSize
            ? `${asg} (Wearing Size ${assignedSize} ⚠️ Needs Preferred Size)`
            : `${asg} (Wearing Size ${assignedSize} → Needed: ${neededSize})`;

          addItem('assigned_size_up', 'Gloves', '🧤 Gloves', neededSize, hasNoSize, finalClass, empLabel, 10, true);
          markCovered('Gloves', asg);
        }
      });
    }

    if (sleevesTable) {
      const sRows = sleevesTable.rows || sleevesTable.rawGrid || [];
      const sleeveRanks = { 'small': 1, 'sm': 1, 'regular': 2, 'reg': 2, 'large': 3, 'lg': 3, 'extra large': 4, 'xl': 4, '2xl': 5, 'xxl': 5 };

      sRows.forEach((s, idx) => {
        let asg = '';
        let assignedSize = '';
        let classVal = 'Class 2';
        let status = '';
        let notes = '';

        if (Array.isArray(s)) {
          if (idx === 0) return; // skip header row
          asg = String(s[8] || '').trim();
          assignedSize = String(s[2] || '').trim();
          const rawClass = (s[3] !== undefined && s[3] !== null && String(s[3]).trim() !== '') ? s[3] : 'Class 2';
          classVal = String(rawClass).trim();
          status = String(s[7] || '').trim();
          notes = String(s[11] || '').trim();
        } else if (s && typeof s === 'object') {
          asg = String(s['Assigned To'] || s['Assigned'] || '').trim();
          assignedSize = String(s['Size'] || '').trim();
          const rawClass = (s['Class'] !== undefined && s['Class'] !== null && String(s['Class']).trim() !== '') ? s['Class'] : 'Class 2';
          classVal = String(rawClass).trim();
          status = String(s['Status'] || '').trim();
          notes = String(s['Notes'] || '').trim();
        }

        if (!asg) return;
        const asgLower = asg.toLowerCase();
        if (asgLower.includes('shelf') || asgLower === 'unassigned' || asgLower === 'lost' || asgLower === 'in testing') return;
        if (this.isDepartedOrPreviousEmployee(asg)) return;

        const statLower = status.toLowerCase();
        if (NON_ASSIGNED_STATUSES.has(statLower)) return;

        // Skip if already queued under Swaps for Sleeves
        if (isCovered('Sleeves', asg)) return;

        const empRec = getEmpRecord(asg);
        if (!empRec) return;
        if (empRec.location && empRec.location.toLowerCase().includes('previous')) return;

        const prefSleeve = cleanSize(empRec.sleeveSize);
        const notesLower = notes.toLowerCase();

        const hasMarker = statLower.includes('size up') || notesLower.includes('size up');
        const rankAssigned = sleeveRanks[assignedSize.toLowerCase()] || 0;
        const rankPref = sleeveRanks[prefSleeve.toLowerCase()] || 0;
        const isMismatch = rankAssigned > 0 && rankPref > 0 && (rankAssigned > rankPref);

        if (hasMarker || isMismatch) {
          const neededSize = prefSleeve || '⚠️ Needs Size';
          const hasNoSize = !prefSleeve;
          const finalClass = classVal.toLowerCase().startsWith('class') ? classVal : `Class ${classVal}`;
          const empLabel = hasNoSize
            ? `${asg} (Wearing Size ${assignedSize} ⚠️ Needs Preferred Size)`
            : `${asg} (Wearing Size ${assignedSize} → Needed: ${neededSize})`;

          addItem('assigned_size_up', 'Sleeves', '🦺 Sleeves', neededSize, hasNoSize, finalClass, empLabel, 10, true);
          markCovered('Sleeves', asg);
        }
      });
    }

    // =========================================================================
    // SECTION 4: PPE COMPLIANCE — MISSING EQUIPMENT
    // =========================================================================
    // Helper to check if available shelf stock satisfies an employee need (reserves 1 unit per covered employee)
    const allocatedShelfUnits = new WeakMap();
    const hasShelfStockAvailable = (invTable, reqClass, reqSize, empName) => {
      if (!invTable || !invTable.rows) return false;
      const normReqSize = cleanSize(reqSize);
      if (!normReqSize) return false; // Missing size cannot match shelf item
      const normReqClass = parseInt(String(reqClass || '').replace(/\D/g, '') || '2', 10);
      let usedSet = allocatedShelfUnits.get(invTable);
      if (!usedSet) {
        usedSet = new Set();
        allocatedShelfUnits.set(invTable, usedSet);
      }

      const matchIdx = invTable.rows.findIndex((item, idx) => {
        if (usedSet.has(idx)) return false;
        const stat = String(item['Status'] || '').trim().toLowerCase();
        const isOnShelf = stat === 'on shelf' || stat === 'in stock' || stat === 'available';
        if (!isOnShelf) return false;
        const iClass = parseInt(String(item['Class'] || '').replace(/\D/g, '') || '0', 10);
        if (iClass !== normReqClass) return false;
        const iSize = cleanSize(item['Size']);
        const isSizeMatch = iSize === normReqSize || (!isNaN(parseFloat(iSize)) && parseFloat(iSize) === parseFloat(normReqSize));
        const pf = String(item['Picked For'] || '').trim();
        const notReservedOther = !pf || pf.toLowerCase().includes((empName || '').toLowerCase());
        return isSizeMatch && notReservedOther;
      });
      if (matchIdx !== -1) {
        usedSet.add(matchIdx);
        return true;
      }
      return false;
    };

    const isSatisfiedOnSwapSheet = (swapKey, empName) => {
      const swTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(swapKey) : null) || snap?.tables?.[swapKey];
      if (!swTable) return false;
      const rows = swTable.rows || swTable.rawGrid || [];
      return rows.some((r, idx) => {
        let rowEmp = '';
        let rowPick = '';
        let rowStat = '';
        if (Array.isArray(r)) {
          if (idx === 0) return false;
          rowEmp = String(r[0] || '').trim();
          rowPick = String(r[6] || '').trim();
          rowStat = String(r[7] || '').trim();
        } else if (r && typeof r === 'object') {
          rowEmp = String(r['Employee'] || r['Assigned To'] || '').trim();
          rowPick = String(r['Pick List Item #'] || r['Pick List Glove #'] || r['Pick List Sleeve #'] || r['Pick List'] || '').trim();
          rowStat = String(r['Status'] || '').trim();
        }
        if (!rowEmp || !this.isNameMatch(rowEmp, empName)) return false;
        const statLower = rowStat.toLowerCase();
        const hasPick = rowPick && rowPick !== '—' && rowPick !== '-' && !rowPick.includes('Needs Size');
        const isSatisfiedStatus = statLower.includes('in stock') || statLower.includes('ready for delivery') || statLower.includes('delivered');
        return hasPick || isSatisfiedStatus;
      });
    };

    // Active personnel in tracked classifications (SUP, GF, F, JRY, AP 1-7) missing rubber equipment
    empDirectory.forEach(empRec => {
      if (this.isDepartedOrPreviousEmployee(empRec.name)) return;
      if (empRec.location && empRec.location.toLowerCase().includes('previous')) return;
      if (empRec.lastDay) {
        const ld = new Date(empRec.lastDay);
        if (!isNaN(ld.getTime()) && ld < new Date()) return;
      }

      const meta = this.parseTrackedClassification(empRec.classification);
      if (!meta) return;

      if (this.isEmployeePpeExcluded(empRec.name)) return;

      // Determine appropriate rubber class approval for employee location
      const locationApprovalClass = getLocationApprovalClass(empRec);

      // 4A. Missing Rubber Gloves
      if (meta.needsGloves && !isCovered('Gloves', empRec.name) && !hasInventoryItem(glovesTable, empRec.name)) {
        const validPref = cleanSize(empRec.gloveSize);
        const neededSize = validPref || '⚠️ Needs Size';
        const hasNoSize = !validPref;
        const empLabel = hasNoSize
          ? `${empRec.name} (⚠️ No preferred size listed in Employees)`
          : `${empRec.name} (${meta.code} - Missing Gloves)`;

        const isCoveredOnSwap = isSatisfiedOnSwapSheet('glove_swaps', empRec.name);
        const hasShelf = validPref && hasShelfStockAvailable(glovesTable, locationApprovalClass, validPref, empRec.name);

        if (isCoveredOnSwap || hasShelf) {
          markCovered('Gloves', empRec.name);
        } else {
          addItem('compliance_missing', 'Gloves', '🧤 Gloves', neededSize, hasNoSize, locationApprovalClass, empLabel, 0, true);
          markCovered('Gloves', empRec.name);
        }
      }

      // 4B. Missing Rubber Sleeves (AP 4-7, JRY, SUP, GF, F)
      if (meta.needsSleeves && !isCovered('Sleeves', empRec.name) && !hasInventoryItem(sleevesTable, empRec.name)) {
        const validPref = cleanSize(empRec.sleeveSize);
        const neededSize = validPref || '⚠️ Needs Size';
        const hasNoSize = !validPref;
        const empLabel = hasNoSize
          ? `${empRec.name} (⚠️ No preferred size listed in Employees)`
          : `${empRec.name} (${meta.code} - Missing Sleeves)`;

        const isCoveredOnSwap = isSatisfiedOnSwapSheet('sleeve_swaps', empRec.name);
        const hasShelf = validPref && hasShelfStockAvailable(sleevesTable, locationApprovalClass, validPref, empRec.name);

        if (isCoveredOnSwap || hasShelf) {
          markCovered('Sleeves', empRec.name);
        } else {
          addItem('compliance_missing', 'Sleeves', '🦺 Sleeves', neededSize, hasNoSize, locationApprovalClass, empLabel, 0, true);
          markCovered('Sleeves', empRec.name);
        }
      }
    });

    // =========================================================================
    // COMPILE & PRIORITIZE ITEMS
    // =========================================================================
    // Strictly consolidate items by like size and class across every section (especially ordered_pending)
    const normalizedAggregated = {};
    Object.values(aggregated).forEach(item => {
      const type = cleanItemType(item.itemType);
      const size = cleanSize(item.size, item.hasNoSize) || (item.hasNoSize ? '⚠️ Needs Size' : 'Standard');
      const classVal = cleanClass(item.classVal);
      const orderKeyPart = (item.section === 'ordered_pending')
        ? (item.orderInfo?.vendorOrderNumber || item.orderInfo?.orderNumber || item.orderInfo?.poNumber || 'PENDING')
        : '';
      const key = `${item.section}|${type}|${size}|${classVal}|${orderKeyPart}`;

      if (normalizedAggregated[key]) {
        const existing = normalizedAggregated[key];
        if (item.employees && item.employees.length > 0) {
          let addedCount = 0;
          item.employees.forEach(emp => {
            const isStock = emp.name.toLowerCase().includes('stock') || emp.name.toLowerCase().includes('shelf');
            if (isStock || !existing.employees.some(e => this.isNameMatch(e.name, emp.name))) {
              existing.employees.push(emp);
              addedCount++;
            }
          });
          existing.quantity += addedCount;
        } else {
          existing.quantity += item.quantity;
        }
        if (item.price > existing.price) existing.price = item.price;
        if (item.orderInfo) {
          if (!existing.orderInfo) {
            existing.orderInfo = item.orderInfo;
          } else {
            if (!existing.orderInfo.vendorOrderNumber && item.orderInfo.vendorOrderNumber) {
              existing.orderInfo.vendorOrderNumber = item.orderInfo.vendorOrderNumber;
            }
            if (!existing.orderInfo.orderNumber && item.orderInfo.orderNumber) {
              existing.orderInfo.orderNumber = item.orderInfo.orderNumber;
            }
          }
        }
      } else {
        normalizedAggregated[key] = {
          ...item,
          itemType: type,
          size: size,
          classVal: classVal
        };
      }
    });

    this.items = Object.values(normalizedAggregated).map(item => {
      let priority = 'LOW';
      let priorityEmoji = '🟢';
      let timeframe = 'Consider / Future';

      if (item.hasNoSize) {
        priority = 'HIGH';
        priorityEmoji = '🔴';
        timeframe = 'Immediate (Needs Size)';
      } else if (item.isImmediate || item.minDaysLeft <= 0) {
        priority = 'HIGH';
        priorityEmoji = '🔴';
        timeframe = 'Immediate';
      } else if (item.minDaysLeft <= 14) {
        priority = 'HIGH';
        priorityEmoji = '🔴';
        timeframe = 'Immediate (< 14d)';
      } else if (item.minDaysLeft <= 30) {
        priority = 'MEDIUM';
        priorityEmoji = '🟠';
        timeframe = 'Soon (15-30d)';
      }

      return {
        ...item,
        priority,
        priorityEmoji,
        timeframe
      };
    });

    // Sort order: Group by Section first, then by Urgency, then Quantity
    const sectionOrder = {
      'ordered_pending': 1,
      'swaps_need': 2,
      'swaps_size_up': 3,
      'assigned_size_up': 4,
      'compliance_missing': 5
    };
    const priorityOrder = { 'HIGH': 1, 'MEDIUM': 2, 'LOW': 3 };

    this.items.sort((a, b) => {
      const sA = sectionOrder[a.section] || 9;
      const sB = sectionOrder[b.section] || 9;
      if (sA !== sB) return sA - sB;

      const pA = priorityOrder[a.priority] || 4;
      const pB = priorityOrder[b.priority] || 4;
      if (pA !== pB) return pA - pB;

      return b.quantity - a.quantity;
    });

    this.items.forEach((item, idx) => {
      item._id = idx;
    });
  }

  onVendorChange(vendorName) {
    this.selectedVendor = this.vendors.find(v => v.name === vendorName) || null;
    this.updatePricing();
    this.render();
  }

  doesCatalogItemMatch(catalogItemName, itemType, classVal, size, requireSize = true, catalogPartNumber = '') {
    const name = String(catalogItemName || '').toLowerCase().trim();
    const partNum = String(catalogPartNumber || '').toLowerCase().trim();
    if (!name) return false;

    const cleanType = this.cleanItemType(itemType).toLowerCase();
    let tSize = String(size || '').toLowerCase().trim();
    tSize = tSize.replace(/^size\s*[:\s]*/i, '').replace(/\s*\(\s*class\s*[^)]*\)/i, '').trim();

    // Prevent cross-contamination between testing services and physical equipment
    const isCatalogTesting = /\b(?:testing|retest|recertification|dielectric|labor)\b/i.test(name) || /\b(?:testing|labor)\b/i.test(partNum);
    const isReqTesting = cleanType === 'testing' || /\b(?:testing|retest|recertification|dielectric|labor)\b/i.test(cleanType) || /\b(?:testing|labor)\b/i.test(tSize);

    if (isCatalogTesting !== isReqTesting) {
      return false;
    }

    if (isCatalogTesting && isReqTesting) {
      // Testing & Labor matching logic
      if (tSize && tSize !== 'standard' && tSize !== '—') {
        if (name === tSize || partNum === tSize || name.includes(tSize) || tSize.includes(name)) return true;
      }
      if (cleanType.includes('glove') && name.includes('glove')) return true;
      if (cleanType.includes('sleeve') && name.includes('sleeve')) return true;
      if (cleanType.includes('blanket') && name.includes('blanket')) return true;
      if (cleanType === 'testing') return true;
      return false;
    }

    let typeMatch = false;
    if (cleanType.includes('glove')) typeMatch = name.includes('glove') || name.includes('glv');
    else if (cleanType.includes('sleeve')) typeMatch = name.includes('sleeve') || name.includes('slv');
    else if (cleanType.includes('blanket')) typeMatch = name.includes('blanket') || name.includes('blk');
    else if (cleanType.includes('mack')) typeMatch = name.includes('mack');
    else typeMatch = name.includes(cleanType.slice(0, 4));

    if (!typeMatch) return false;

    // Prevent Blanket Canister from matching normal blanket orders unless Canister is explicitly requested
    if (cleanType.includes('blanket')) {
      const isCanisterCatalog = /\b(?:canister|cannister)\b/i.test(name);
      const isCanisterRequested = /\b(?:canister|cannister)\b/i.test(tSize) || /\b(?:canister|cannister)\b/i.test(String(itemType || ''));
      if (isCanisterCatalog !== isCanisterRequested) return false;

      // Also strictly separate Split vs non-Split (Regular / Eyelet / Solid / 36x36) blankets even when requireSize is false
      const isSplitCatalog = /\bsplit\b/i.test(name);
      const isSplitRequested = /\bsplit\b/i.test(tSize) || /\bsplit\b/i.test(String(itemType || ''));
      if (tSize && tSize !== '—' && !tSize.includes('needs size')) {
        if (isSplitCatalog !== isSplitRequested) return false;
      }
    }

    const tClassNum = String(classVal || '').replace(/[^0-9]/g, '').trim();
    if (tClassNum) {
      // Check if catalog item explicitly specifies any class number (0-4) in description or Salisbury part number
      const anyClassMatch = name.match(/(?:class|cl|c)\s*[-:#]?\s*([0-4])\b|\bclass\s*([0-4])\b/i);
      const partClassMatch = partNum.match(/^(?:psc|e|g)?([0-4])(?:14|16|18)/i);
      const catalogClassNum = anyClassMatch ? (anyClassMatch[1] || anyClassMatch[2]) : (partClassMatch ? partClassMatch[1] : null);

      if (catalogClassNum !== null) {
        if (String(catalogClassNum) !== String(tClassNum)) return false;
      } else {
        // Catalog item does NOT mention a class number in its name or part number
        // Gloves and Sleeves must always specify their class; Blankets/MACKs/etc. (e.g. "Blanket Split") are implicitly Class 4
        if (cleanType.includes('glove') || cleanType.includes('sleeve')) {
          return false;
        }
      }
    }

    if (!requireSize) return true;

    if (!tSize || tSize === '—' || tSize.includes('needs size') || tSize === 'standard') {
      if (cleanType.includes('blanket')) {
        // Default/Standard blanket matches non-split, non-canister blanket
        return !/\b(?:split|canister|cannister)\b/i.test(name);
      }
      return false;
    }

    // Blankets size / style matching (Split vs Regular / Eyelet / Solid / 36x36 vs Canister)
    if (cleanType.includes('blanket')) {
      if (/\b(?:canister|cannister)\b/i.test(tSize)) {
        return /\b(?:canister|cannister)\b/i.test(name);
      }
      if (/\bsplit\b/i.test(tSize)) {
        return /\bsplit\b/i.test(name);
      }
      if (/^(?:regular|reg|eyelet|eye|solid|36x36)$/i.test(tSize)) {
        return !/\b(?:split|canister|cannister)\b/i.test(name) &&
          (/\b(?:regular|reg|eye|eyelet|solid|36x36)\b/i.test(name) || /\b(?:blanket|blk)\b/i.test(name));
      }
    }

    // Numeric glove size (e.g. 9 vs 9.5, 10 vs 10.5) — do NOT match cuff lengths like 11" or 14in
    if (/^\d+(\.\d+)?$/.test(tSize)) {
      if (tSize.endsWith('.5')) {
        const baseInt = tSize.split('.')[0];
        const esc = tSize.replace(/\./g, '\\.');
        const decRegex = new RegExp(`(?:^|[^0-9.])${esc}(?:\\b|$)(?!\\.\\d|\\s*(?:in\\b|"|''|ft\\b))`, 'i');
        const hNameRegex = new RegExp(`(?:^|[^0-9.])${baseInt}h(?:\\b|$)`, 'i');
        const hPartRegex = new RegExp(`${baseInt}h(?:[a-z]*)$`, 'i');
        return decRegex.test(name) || hNameRegex.test(name) || hPartRegex.test(partNum);
      } else {
        const esc = tSize.replace(/\./g, '\\.');
        // Whole size: must NOT be followed by .5, 'H' (Salisbury half-size suffix), or cuff length units (in / " / ft)
        const numRegex = new RegExp(`(?:^|[^0-9.])${esc}(?:\\b|$)(?!\\.\\d|h|\\s*(?:in\\b|"|''|ft\\b))`, 'i');
        const conflictHRegex = new RegExp(`(?:^|[^0-9.])${esc}h(?:\\b|$)`, 'i');
        const conflictPartH = new RegExp(`${esc}h(?:[a-z]*)$`, 'i');
        if (conflictHRegex.test(name) || conflictPartH.test(partNum)) return false;
        return numRegex.test(name);
      }
    }

    if (tSize === 'regular' || tSize === 'reg') {
      return /\b(?:regular|reg)\b/i.test(name);
    }
    if (tSize === 'large' || tSize === 'lg') {
      return /\b(?:large|lg)\b/i.test(name) && !/\b(?:extra|x|2x|xx)[\s-]*(?:large|lg)\b/i.test(name);
    }
    if (tSize === 'extra large' || tSize === 'x-large' || tSize === 'xl') {
      return /\b(?:extra[\s-]*large|x[\s-]*large|xl)\b/i.test(name) && !/\b(?:2x|xx)/i.test(name);
    }
    if (tSize === '2x-large' || tSize === '2x large' || tSize === 'xxl' || tSize === '2xl') {
      return /\b(?:2x[\s-]*large|xx[\s-]*large|2xl|xxl)\b/i.test(name);
    }

    return name.includes(tSize);
  }

  updatePricing() {
    if (!this.selectedVendor || !this.selectedVendor.items) {
      this.items.forEach(i => {
        const fallbackMatch = this.matchVendorItem(i.itemType, i.size, i.classVal, i.orderInfo?.vendor || null);
        if (i.section !== 'ordered_pending') {
          i.price = 0;
        }
        i.partNumber = (fallbackMatch && fallbackMatch.partNumber) ? fallbackMatch.partNumber : (i.partNumber || '');
      });
      return;
    }

    this.items.forEach(item => {
      const match = this.matchVendorItem(item.itemType, item.size, item.classVal, this.selectedVendor.name);
      if (match) {
        if (match.price > 0 && (item.section !== 'ordered_pending' || !item.price || item.price <= 0)) {
          item.price = match.price;
        }
        if (item.section !== 'ordered_pending' || !item.partNumber) {
          item.partNumber = match.partNumber || '';
        }
      } else {
        if (item.section !== 'ordered_pending') {
          item.price = 0;
          item.partNumber = '';
        }
      }
    });
  }

  matchVendorItem(itemType, size, classVal, specificVendorName = null) {
    if (!this.vendors || !this.vendors.length) {
      this.loadVendors();
    }
    if (!this.vendors || !this.vendors.length) return null;

    let vendorList = this.vendors;
    if (specificVendorName && typeof specificVendorName === 'string') {
      const v = this.vendors.find(vend => vend.name.toLowerCase() === specificVendorName.toLowerCase());
      if (v) {
        vendorList = [v, ...this.vendors.filter(vend => vend.name !== v.name)];
      }
    } else if (this.selectedVendor) {
      vendorList = [this.selectedVendor, ...this.vendors.filter(v => v.name !== this.selectedVendor.name)];
    }

    const cleanType = this.cleanItemType(itemType).toLowerCase();
    const tSize = String(size || '').toLowerCase().trim();

    let bestPrice = 0;
    let bestPartNumber = '';
    let bestVendor = '';

    for (const v of vendorList) {
      if (!v.items || !v.items.length) continue;
      const catalog = v.items;
      const isPrimaryVendor = !specificVendorName || typeof specificVendorName !== 'string' || v.name.toLowerCase() === specificVendorName.toLowerCase();

      // 0. Direct match against catalog item description or part number (handles Testing, Labor, Services, and specific custom items)
      const cleanSizeStr = String(size || '').trim().toLowerCase();
      const cleanTypeStr = String(itemType || '').trim().toLowerCase();
      const isTestingReq = cleanTypeStr === 'testing' || /\b(?:testing|labor|service|dielectric)\b/i.test(cleanTypeStr) || /\b(?:testing|labor|service|dielectric)\b/i.test(cleanSizeStr);

      const directMatch = catalog.find(ci => {
        const ciName = String(ci.item || '').trim().toLowerCase();
        const ciPart = String(ci.itemNumber || '').trim().toLowerCase();
        if (!ciName && !ciPart) return false;

        // Exact match with size / item name
        if (cleanSizeStr && cleanSizeStr !== 'standard' && cleanSizeStr !== '—') {
          if (ciName === cleanSizeStr || ciPart === cleanSizeStr) return true;
          if (isTestingReq && (ciName.includes(cleanSizeStr) || cleanSizeStr.includes(ciName))) return true;
        }

        // Direct match with itemType if specific (e.g. "Glove Testing")
        if (ciName === cleanTypeStr || ciPart === cleanTypeStr) return true;

        return false;
      });

      if (directMatch) {
        if (isPrimaryVendor && !bestPrice && (directMatch.price || 0) > 0) {
          bestPrice = directMatch.price;
          bestVendor = v.name;
        }
        if (!bestPartNumber && directMatch.itemNumber) {
          bestPartNumber = String(directMatch.itemNumber).trim();
          if (!bestVendor) bestVendor = v.name;
        }
        if (bestPrice > 0 && bestPartNumber) {
          return { price: bestPrice, partNumber: bestPartNumber, vendor: bestVendor || v.name };
        }
      }

      // 1. Exact match (Type + Class + Size)
      if (tSize && tSize !== '—' && !tSize.includes('needs size')) {
        const exactMatches = catalog.filter(ci => {
          const priceOk = !/glove|sleeve/i.test(ci.item || '') || (ci.price || 0) <= 350;
          return priceOk && this.doesCatalogItemMatch(ci.item, itemType, classVal, size, true, ci.itemNumber);
        });
        if (exactMatches.length > 0) {
          const withPart = exactMatches.find(ci => ci.itemNumber && String(ci.itemNumber).trim() !== '');
          const withPrice = exactMatches.find(ci => (ci.price || 0) > 0);
          if (isPrimaryVendor && !bestPrice && withPrice) {
            bestPrice = withPrice.price || 0;
            bestVendor = v.name;
          }
          if (!bestPartNumber && withPart) {
            bestPartNumber = String(withPart.itemNumber).trim();
            if (!bestVendor) bestVendor = v.name;
          }
          if (bestPrice > 0 && bestPartNumber) {
            return { price: bestPrice, partNumber: bestPartNumber, vendor: bestVendor || v.name };
          }
        }
      }

      // 2. Type + Class match (generic class-level item without conflicting size)
      const classMatches = catalog.filter(ci => {
        const priceOk = !/glove|sleeve/i.test(ci.item || '') || (ci.price || 0) <= 350;
        return priceOk && this.doesCatalogItemMatch(ci.item, itemType, classVal, size, false, ci.itemNumber);
      });
      if (classMatches.length > 0) {
        // Only fall back to class-level partNumber if the class match doesn't specify a different conflicting size
        const genericClassWithPart = classMatches.find(ci => {
          if (!ci.itemNumber || String(ci.itemNumber).trim() === '') return false;
          const itemStr = String(ci.item || '').toLowerCase();
          const hasAnyNumericSize = /\b(?:8|8\.5|9|9\.5|10|10\.5|11|11\.5|12)\b/.test(itemStr);
          const hasAnySleeveSize = /\b(?:regular|large|extra\s*large|x-large|small)\b/i.test(itemStr);
          return !hasAnyNumericSize && !hasAnySleeveSize;
        });
        const withPrice = classMatches.find(ci => (ci.price || 0) > 0);
        if (isPrimaryVendor && !bestPrice && withPrice) {
          bestPrice = withPrice.price || 0;
          if (!bestVendor) bestVendor = v.name;
        }
        if (!bestPartNumber && genericClassWithPart) {
          bestPartNumber = String(genericClassWithPart.itemNumber).trim();
          if (!bestVendor) bestVendor = v.name;
        }
        if (bestPrice > 0 && bestPartNumber) {
          return { price: bestPrice, partNumber: bestPartNumber, vendor: bestVendor || v.name };
        }
      }

      // 3. Fallback Type match - only for non-glove/sleeve/blanket categories
      if (!/glove|sleeve|blanket/i.test(cleanType)) {
        const typeMatchItem = catalog.find(ci => {
          const name = (ci.item || '').toLowerCase();
          return name.includes(cleanType.slice(0, 4));
        });
        if (typeMatchItem) {
          if (isPrimaryVendor && !bestPrice && typeMatchItem.price > 0) bestPrice = typeMatchItem.price;
          if (!bestPartNumber && typeMatchItem.itemNumber) bestPartNumber = String(typeMatchItem.itemNumber).trim();
          if (!bestVendor) bestVendor = v.name;
        }
      }
    }

    if (bestPrice > 0 || bestPartNumber) {
      return { price: bestPrice, partNumber: bestPartNumber, vendor: bestVendor };
    }
    return null;
  }

  getVendorPrice(vendorName, itemType, size, classVal) {
    const match = this.matchVendorItem(itemType, size, classVal, vendorName);
    return match ? (match.price || 0) : 0;
  }

  getVendorPartNumber(vendorName, itemType, size, classVal) {
    const match = this.matchVendorItem(itemType, size, classVal, vendorName);
    return match ? (match.partNumber || '') : '';
  }

  summarizeOrderItems(items = []) {
    let equipmentUnits = 0;
    let equipmentLineCount = 0;
    let testingUnits = 0;
    let testingLineCount = 0;
    const orderKeys = new Set();

    (items || []).forEach(it => {
      const qty = Number(it.quantity) || 0;
      if (this.isTestingServiceItem(it)) {
        testingLineCount += 1;
        testingUnits += qty;
      } else {
        equipmentLineCount += 1;
        equipmentUnits += qty;
      }
      if (it.section === 'ordered_pending') {
        orderKeys.add(this.getOrderKeyForPendingItem(it).orderKey);
      }
    });

    return {
      orderCount: orderKeys.size,
      equipmentUnits,
      equipmentLineCount,
      testingUnits,
      testingLineCount
    };
  }

  formatOrderItemsCountText(summary, includeOrderCount = false) {
    const { orderCount, equipmentUnits, testingUnits } = summary || {};
    const parts = [];
    if (includeOrderCount) {
      const ord = orderCount || 0;
      parts.push(`${ord} ${ord === 1 ? 'order' : 'orders'}`);
    }
    if (equipmentUnits > 0) {
      const testSuffix = testingUnits > 0 ? ` (+${testingUnits} testing)` : '';
      parts.push(`${equipmentUnits} ${equipmentUnits === 1 ? 'item' : 'items'}${testSuffix}`);
    } else if (testingUnits > 0) {
      parts.push(`${testingUnits} testing/labor`);
    } else {
      parts.push('0 items');
    }
    return parts.join(' · ');
  }

  getSectionCounts() {
    const items = this.items || [];
    const needsItems = items.filter(i => i.section !== 'ordered_pending');
    const orderedItems = items.filter(i => i.section === 'ordered_pending');
    const orderedOrderCount = this.summarizeOrderItems(orderedItems).orderCount;
    const needsCount = needsItems.length;
    return {
      all: needsCount + orderedOrderCount,
      needs: needsCount,
      ordered_pending: orderedOrderCount,
      swaps_need: needsItems.filter(i => i.section === 'swaps_need').length,
      swaps_size_up: needsItems.filter(i => i.section === 'swaps_size_up').length,
      assigned_size_up: needsItems.filter(i => i.section === 'assigned_size_up').length,
      compliance_missing: needsItems.filter(i => i.section === 'compliance_missing').length
    };
  }

  getSectionTabsHtml(activeFilter = 'all', counts = null) {
    const c = counts || this.getSectionCounts();

    return `
      <!-- Section Filter Tabs Bar -->
      <div class="procurement-section-tabs" style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; padding-bottom: 10px; border-bottom: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 700; margin-right: 4px;">VIEW SECTION:</span>
        <button type="button" class="btn ${activeFilter === 'all' ? 'btn-primary' : 'btn-secondary'}" style="font-size: 11.5px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;" onclick="window.procurementEngine.setSectionFilter('all')">
          <span>📋 All Needs & Orders</span>
          <span style="background: rgba(255,255,255,0.15); padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">${c.all}</span>
        </button>
        <button type="button" class="btn ${activeFilter === 'needs' ? 'btn-primary' : 'btn-secondary'}" style="font-size: 11.5px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;" onclick="window.procurementEngine.setSectionFilter('needs')">
          <span>🛒 Needs to Order</span>
          <span style="background: rgba(255,255,255,0.15); padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">${c.needs}</span>
        </button>
        <button type="button" class="btn ${activeFilter === 'ordered_pending' ? 'btn-primary' : 'btn-secondary'}" style="font-size: 11.5px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px; border-color: #10b981; color: ${activeFilter === 'ordered_pending' ? '#fff' : '#6ee7b7'};" onclick="window.procurementEngine.setSectionFilter('ordered_pending')" title="Open purchase orders awaiting delivery">
          <span>📦 Ordered (Awaiting Delivery)</span>
          <span style="background: rgba(16,185,129,0.25); padding: 1px 6px; border-radius: 10px; font-size: 10.5px; color: #34d399; font-weight: 700;">${c.ordered_pending}</span>
        </button>
        <button type="button" class="btn ${activeFilter === 'history' ? 'btn-primary' : 'btn-secondary'}" style="font-size: 11.5px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px; ${activeFilter === 'history' ? 'border-color: #38bdf8; color: #fff;' : ''}" onclick="window.procurementEngine.setSectionFilter('history')">
          <span>📜 Orders Tracking & History</span>
        </button>
        <button type="button" class="btn ${activeFilter === 'swaps_need' ? 'btn-primary' : 'btn-secondary'}" style="font-size: 11.5px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;" onclick="window.procurementEngine.setSectionFilter('swaps_need')">
          <span>🛒 Swaps: Need</span>
          <span style="background: rgba(255,255,255,0.15); padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">${c.swaps_need}</span>
        </button>
        <button type="button" class="btn ${activeFilter === 'swaps_size_up' ? 'btn-primary' : 'btn-secondary'}" style="font-size: 11.5px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;" onclick="window.procurementEngine.setSectionFilter('swaps_size_up')">
          <span>🔄 Swaps: Size Up</span>
          <span style="background: rgba(255,255,255,0.15); padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">${c.swaps_size_up}</span>
        </button>
        <button type="button" class="btn ${activeFilter === 'assigned_size_up' ? 'btn-primary' : 'btn-secondary'}" style="font-size: 11.5px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;" onclick="window.procurementEngine.setSectionFilter('assigned_size_up')">
          <span>⚠️ Assigned: Size Up</span>
          <span style="background: rgba(255,255,255,0.15); padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">${c.assigned_size_up}</span>
        </button>
        <button type="button" class="btn ${activeFilter === 'compliance_missing' ? 'btn-primary' : 'btn-secondary'}" style="font-size: 11.5px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;" onclick="window.procurementEngine.setSectionFilter('compliance_missing')">
          <span>🛡️ Missing Equipment</span>
          <span style="background: rgba(255,255,255,0.15); padding: 1px 6px; border-radius: 10px; font-size: 10.5px;">${c.compliance_missing}</span>
        </button>
      </div>
    `;
  }

  getOrderKeyForPendingItem(item) {
    let orderNumber = '';
    let vendor = '';
    let orderDate = '';
    let expectedDelivery = '';

    if (item.orderInfo) {
      orderNumber = item.orderInfo.vendorOrderNumber || item.orderInfo.orderNumber || item.orderInfo.poNumber || '';
      vendor = item.orderInfo.vendor || '';
      orderDate = item.orderInfo.orderDate || '';
      expectedDelivery = item.orderInfo.expectedDelivery || '';
    }

    if (orderNumber && orderNumber.toLowerCase() === 'ed') {
      orderNumber = '';
    }

    if (!orderNumber && item.employees && item.employees.length) {
      for (const e of item.employees) {
        let ordNum = e.orderInfo?.vendorOrderNumber || e.orderInfo?.orderNumber;
        if (ordNum && ordNum.toLowerCase() === 'ed') ordNum = '';
        if (ordNum) {
          orderNumber = ordNum;
          if (!vendor && e.orderInfo.vendor) vendor = e.orderInfo.vendor;
          if (!orderDate && e.orderInfo.orderDate) orderDate = e.orderInfo.orderDate;
          if (!expectedDelivery && e.orderInfo.expectedDelivery) expectedDelivery = e.orderInfo.expectedDelivery;
          break;
        }
        const m = (e.label || '').match(/(?:Order(?:\s*#)?|PO):\s*([^·)\s]+)/i);
        if (m && m[1].toLowerCase() !== 'ed') {
          orderNumber = m[1];
          break;
        }
      }
    }

    // Secondary fallback: lookup active open order from purchase_orders table
    if (!orderNumber) {
      const firstEmp = item.employees?.[0]?.name || '';
      const activePo = this.findActiveOpenPo(firstEmp, item.itemType);
      if (activePo) {
        orderNumber = activePo.orderNumber;
        if (!vendor && activePo.vendor) vendor = activePo.vendor;
        if (!orderDate && activePo.orderDate) orderDate = activePo.orderDate;
        if (!expectedDelivery && activePo.expectedDelivery) expectedDelivery = activePo.expectedDelivery;
      }
    }

    let orderKey = '';
    if (orderNumber) {
      orderKey = `ORDER_${orderNumber.trim().toUpperCase()}`;
    } else if (orderDate) {
      orderKey = `DATE_${orderDate.trim()}_${(vendor || 'UNKNOWN').toUpperCase()}`;
    } else {
      orderKey = `UNTRACKED_${item.itemType || 'ITEM'}`;
    }

    return {
      orderKey,
      orderNumber,
      poNumber: orderNumber,
      vendorOrderNumber: orderNumber,
      vendor,
      orderDate,
      expectedDelivery
    };
  }

  toggleOrderCollapse(orderKey, event) {
    if (event) event.stopPropagation();
    if (!this.expandedOrders) this.expandedOrders = new Set();
    if (this.expandedOrders.has(orderKey)) {
      this.expandedOrders.delete(orderKey);
    } else {
      this.expandedOrders.add(orderKey);
    }
    this.render();
  }

  toggleSectionCollapse(secKey, event) {
    if (event) event.stopPropagation();
    if (!this.expandedSections) this.expandedSections = new Set();
    if (!this.collapsedSections) this.collapsedSections = new Set();
    const currentlyCollapsed = this.isSectionCollapsed(secKey);
    if (currentlyCollapsed) {
      this.collapsedSections.delete(secKey);
      this.expandedSections.add(secKey);
    } else {
      this.expandedSections.delete(secKey);
      this.collapsedSections.add(secKey);
    }
    this.render();
  }

  isSectionCollapsed(secKey) {
    if (this.expandedSections && this.expandedSections.has(secKey)) return false;
    if (this.collapsedSections && this.collapsedSections.has(secKey)) return true;
    if (this.currentSectionFilter && this.currentSectionFilter !== 'all' && this.currentSectionFilter !== 'history') {
      return false; // Specific single-section view defaults to open
    }
    return true; // Main 'all' view defaults to collapsed
  }

  toggleItemSubrows(globalIdx, event) {
    if (event) event.stopPropagation();
    if (!this.expandedItemSubrows) this.expandedItemSubrows = new Set();
    if (this.expandedItemSubrows.has(globalIdx)) {
      this.expandedItemSubrows.delete(globalIdx);
    } else {
      this.expandedItemSubrows.add(globalIdx);
    }
    this.render();
  }

  toggleOrderGroupSelected(orderKey, isSelected) {
    const grp = this.orderGroupsMap ? this.orderGroupsMap.get(orderKey) : null;
    if (!grp) return;
    grp.items.forEach(item => {
      const realItem = (item._globalIdx !== undefined && this.items[item._globalIdx]) ? this.items[item._globalIdx] : item;
      realItem.selected = isSelected;
      if (realItem.employees && realItem.employees.length) {
        realItem.employees.forEach(e => { e.checked = isSelected; });
        realItem.quantity = isSelected ? Math.max(realItem.quantity || 0, realItem.employees.length) : 0;
      }
    });
    this.render();
  }

  getOrderItems(orderKey) {
    const grp = this.orderGroupsMap ? this.orderGroupsMap.get(orderKey) : null;
    if (grp) return grp.items;
    return [];
  }

  openEditOrderFromKey(orderKey) {
    const grp = this.orderGroupsMap ? this.orderGroupsMap.get(orderKey) : null;
    if (!grp) return;

    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);

    const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
    const poRows = poTable ? (poTable.rows || []) : [];
    let matchedPo = null;

    let targetOrderNum = String(grp.vendorOrderNumber || grp.orderNumber || grp.poNumber || '').trim();
    if (targetOrderNum.toLowerCase() === 'ed') targetOrderNum = '';

    if (targetOrderNum) {
      const targetLower = targetOrderNum.toLowerCase();
      // 1. Search for active open order matching target order number
      matchedPo = poRows.find(r => {
        const pNum = String(r['PO Number'] || r['PO #'] || '').trim().toLowerCase();
        const stat = String(r['Status'] || '').toLowerCase();
        const notes = String(r['Notes'] || '');
        const parsed = this.parseOrderInfoFromNotes(notes);
        const vNum = (parsed?.vendorOrderNumber || '').toLowerCase();
        const isMatch = (pNum === targetLower || vNum === targetLower || notes.toLowerCase().includes(targetLower));
        return isMatch && !stat.includes('received') && !stat.includes('fulfilled');
      });

      // 2. Fallback to any order matching target
      if (!matchedPo) {
        matchedPo = poRows.find(r => {
          const pNum = String(r['PO Number'] || r['PO #'] || '').trim().toLowerCase();
          const notes = String(r['Notes'] || '');
          const parsed = this.parseOrderInfoFromNotes(notes);
          const vNum = (parsed?.vendorOrderNumber || '').toLowerCase();
          return pNum === targetLower || vNum === targetLower || notes.toLowerCase().includes(targetLower);
        });
      }
    }

    // 3. Fallback: if no order number or targetOrderNum was 'ed', search for open PO containing items or employees in this group
    if (!matchedPo && grp.items && grp.items.length) {
      const grpEmps = [];
      grp.items.forEach(it => {
        (it.employees || []).forEach(e => { if (e.name) grpEmps.push(e.name); });
      });
      matchedPo = poRows.find(r => {
        const stat = String(r['Status'] || '').toLowerCase();
        if (stat.includes('received') || stat.includes('fulfilled') || stat.includes('cancel')) return false;
        const notes = String(r['Notes'] || '');
        const items = String(r['Items'] || '');
        const pNum = String(r['PO Number'] || r['PO #'] || '').trim().toLowerCase();
        return pNum === 'ed' || grpEmps.some(en => this.isNameMatch(notes, en) || this.isNameMatch(items, en));
      });
      if (matchedPo) {
        const foundNum = String(matchedPo['PO Number'] || matchedPo['PO #'] || '').trim();
        if (foundNum && foundNum.toLowerCase() !== 'ed') {
          targetOrderNum = foundNum;
        }
      }
    }

    if (matchedPo) {
      const notes = String(matchedPo['Notes'] || '');
      const parsedNotes = this.parseOrderInfoFromNotes(notes);
      const rawPo = String(matchedPo['PO Number'] || matchedPo['PO #'] || targetOrderNum);
      const resolvedOrderNum = (parsedNotes?.vendorOrderNumber && parsedNotes.vendorOrderNumber.toLowerCase() !== 'ed' && !/^\d{3}-\d{2}/.test(parsedNotes.vendorOrderNumber))
        ? parsedNotes.vendorOrderNumber
        : (rawPo.toLowerCase() !== 'ed' ? rawPo : (targetOrderNum || '0819764'));

      this.openEditOrderModal({
        rowIdx: matchedPo._rowIdx || (poRows.indexOf(matchedPo) + 2),
        poNum: resolvedOrderNum,
        orderNum: resolvedOrderNum,
        vendor: String(matchedPo['Vendor'] || grp.vendor || ''),
        date: String(matchedPo['Date'] || grp.orderDate || ''),
        expDeliv: String(matchedPo['Expected Delivery'] || grp.expectedDelivery || ''),
        status: String(matchedPo['Status'] || 'Ordered'),
        price: parseFloat(matchedPo['Total Price'] || matchedPo['Price'] || grp.totalCost || 0) || 0,
        items: String(matchedPo['Items'] || grp.items.map(it => `${it.quantity}x ${it.itemType} Size ${it.size} Class ${it.classVal}`).join(', ')),
        notes: notes
      });
    } else {
      // Create an order object to edit (will auto-link/insert into purchase_orders on save)
      const fallbackNum = targetOrderNum || this.generateNextRequestPoNumber();
      this.openEditOrderModal({
        rowIdx: null,
        poNum: fallbackNum,
        orderNum: fallbackNum,
        vendor: grp.vendor || '',
        date: grp.orderDate || '',
        expDeliv: (grp.expectedDelivery && grp.expectedDelivery !== 'Pending') ? grp.expectedDelivery : '',
        status: 'Ordered',
        price: grp.totalCost || 0,
        items: grp.items.map(it => `${it.quantity}x ${it.itemType} Size ${it.size} Class ${it.classVal}`).join(', '),
        notes: `Order #: ${fallbackNum}`
      });
    }
  }

  async cancelOrderGroup(orderKey) {
    const grp = this.orderGroupsMap ? this.orderGroupsMap.get(orderKey) : null;
    if (!grp) return;

    const targetOrderNum = String(grp.vendorOrderNumber || grp.orderNumber || grp.poNumber || '').trim();
    const count = grp.totalUnits || grp.items.length || 0;
    const confirmMsg = targetOrderNum
      ? `Are you sure you want to cancel the entire Order #${targetOrderNum} (${count} items)?\n\nThis will revert all items in this order back to "Needs to Order" on Glove Swaps and remove this order from tracking.`
      : `Are you sure you want to cancel this entire order (${count} items)?\n\nThis will revert all items back to "Needs to Order".`;

    if (!confirm(confirmMsg)) return;

    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);

      // Collect target order identifiers
      const targetNums = [targetOrderNum, grp.orderNumber, grp.poNumber, grp.vendorOrderNumber].filter(Boolean);

      // Collect target employees & categories
      const targetItems = grp.items || [];
      const targetEmps = [];
      targetItems.forEach(it => {
        if (it.employees && it.employees.length) {
          it.employees.forEach(e => {
            if (e.name) targetEmps.push({ name: e.name, cat: (it.itemType || '').toLowerCase() });
          });
        }
      });

      const swapKeys = this._getAllSwapKeys();
      for (const sk of swapKeys) {
        const sTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(sk) : null) || snap?.tables?.[sk];
        if (sTable && sTable.rows) {
          for (const sr of sTable.rows) {
            const stat = String(sr['Status'] || '');
            const notes = String(sr['Notes'] || '');
            const empName = String(sr['Employee'] || sr['Employee Name'] || sr['Crew Lead / Employee'] || sr['Assigned To'] || Object.values(sr)[0] || '').trim();

            const isNumMatch = targetNums.some(num => num && (stat.includes(num) || notes.includes(num)));
            const isEmpMatch = targetEmps.some(te => this.isNameMatch(empName, te.name) && this._getSwapTableKeyForCategory(te.cat) === sk);

            if ((isNumMatch || isEmpMatch) && stat.toLowerCase().includes('order')) {
              const cleanedNotes = notes ? notes.replace(/Ordered on [^;]+;?/gi, '').trim() : '';
              await this._queueCellMutation(sTable, sk, sr, 'status', 'Need To Purchase');
              await this._queueCellMutation(sTable, sk, sr, 'notes', cleanedNotes);
              sr['Status'] = 'Need To Purchase';
              if (sr['Notes'] !== undefined) sr['Notes'] = cleanedNotes;
            }
          }
        }
      }

      // Also revert matching rows in safety_equipment_needs
      const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
      if (needsTable && needsTable.rows) {
        for (const nr of needsTable.rows) {
          const meta = this._getSafetyNeedMeta(nr);
          if (!meta) continue;
          const isNumMatch = targetNums.some(num => num && (meta.status.includes(num) || meta.notes.includes(num)));
          const isEmpMatch = targetEmps.some(te => this.isNameMatch(meta.employee, te.name) && (!te.cat || meta.itemType.toLowerCase().includes(te.cat.slice(0, 4))));
          if ((isNumMatch || isEmpMatch) && meta.status.toLowerCase().includes('order')) {
            const cleanedNotes = meta.notes ? meta.notes.replace(/Ordered on [^;]+;?/gi, '').trim() : '';
            await this._queueRowUpdate(needsTable, 'safety_equipment_needs', 'Safety Equipment Needs', nr, {
              'Status': 'Pending',
              'Notes': cleanedNotes
            });
          }
        }
      }

      // Also delete matching row in purchase_orders if still present
      const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
      if (poTable && poTable.rows && targetNums.length) {
        const poRow = poTable.rows.find(r => {
          const pNum = String(r['PO Number'] || r['PO #'] || '').trim().toLowerCase();
          const pNotes = String(r['Notes'] || '').toLowerCase();
          return targetNums.some(tn => pNum === tn.toLowerCase() || pNotes.includes(tn.toLowerCase()));
        });
        if (poRow) {
          await this._queueDeletePoRow(poTable, poRow);
        }
      }

      await this.loadData();
      this.render();

      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }

      alert(`✅ Order #${targetOrderNum || ''} cancelled successfully. All items reverted back to "Needs to Order".`);
    } catch (err) {
      console.error('Error cancelling order group:', err);
      alert('❌ Failed to cancel order: ' + (err.message || err));
    }
  }

  parseDateForSort(dVal) {
    if (!dVal) return 0;
    if (dVal instanceof Date) return isNaN(dVal.getTime()) ? 0 : dVal.getTime();
    if (typeof dVal === 'number') return isNaN(dVal) ? 0 : dVal;
    const dStr = String(dVal).trim();
    if (!dStr || dStr.toLowerCase() === 'pending' || dStr === '—' || dStr === '-') return 0;

    // Handle MM/DD/YYYY or M/D/YYYY or M/D/YY
    if (dStr.includes('/')) {
      const parts = dStr.split('/');
      if (parts.length === 3) {
        const m = parseInt(parts[0], 10);
        const d = parseInt(parts[1], 10);
        let y = parseInt(parts[2], 10);
        if (y < 100) y += 2000;
        const dt = new Date(y, m - 1, d, 12, 0, 0);
        if (!isNaN(dt.getTime())) return dt.getTime();
      }
    }

    // Handle YYYY-MM-DD
    if (dStr.includes('-')) {
      const cleanStr = dStr.split('T')[0];
      const parts = cleanStr.split('-');
      if (parts.length === 3) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        const dt = new Date(y, m - 1, d, 12, 0, 0);
        if (!isNaN(dt.getTime())) return dt.getTime();
      }
    }

    const t = Date.parse(dStr);
    return isNaN(t) ? 0 : t;
  }

  render() {
    const vSelect = document.getElementById('procurement-vendor-select');
    if (vSelect) {
      const currentVal = this.selectedVendor ? this.selectedVendor.name : '';
      vSelect.innerHTML = '<option value="">Select a vendor...</option>' +
        this.vendors.map(v => `<option value="${this.escapeHtml(v.name)}" ${v.name === currentVal ? 'selected' : ''}>${this.escapeHtml(v.name)} (${(v.items || []).length} items)</option>`).join('');
    }

    const vInfo = document.getElementById('procurement-vendor-info');
    if (vInfo) {
      if (this.selectedVendor) {
        vInfo.innerHTML = `<strong>${this.escapeHtml(this.selectedVendor.name)}</strong> • Contact: ${this.escapeHtml(this.selectedVendor.contact || 'N/A')} • Email: ${this.escapeHtml(this.selectedVendor.email || 'N/A')} • Phone: ${this.escapeHtml(this.selectedVendor.phone || 'N/A')}`;
      } else {
        vInfo.innerHTML = '<span style="color: var(--text-muted);">Select a vendor to auto-match catalog pricing and part numbers.</span>';
      }
    }

    const container = document.getElementById('procurement-items-table');
    if (!container) return;

    // Filter items based on active section filter
    const activeFilter = this.currentSectionFilter || 'all';

    // Calculate section counts
    const counts = this.getSectionCounts();

    const tabsHtml = this.getSectionTabsHtml(activeFilter, counts);

    // If History tab is selected, render dedicated purchase orders history view with tabs preserved
    if (activeFilter === 'history') {
      this.renderOrdersHistory(container, tabsHtml);
      return;
    }

    if (this.items.length === 0) {
      container.innerHTML = tabsHtml + `
        <div style="padding: 40px; text-align: center; color: var(--text-muted);">
          <div style="font-size: 32px; margin-bottom: 8px;">✅</div>
          <h3 style="color: var(--text-primary); font-size: 16px;">All Equipment In Stock</h3>
          <p style="margin-top: 6px; font-size: 13px;">No items currently require purchase across swap sheets, assignments, or compliance.</p>
        </div>
      `;
      this.updateTotals();
      return;
    }

    let displayItems = this.items;
    if (activeFilter === 'needs') {
      displayItems = this.items.filter(i => i.section !== 'ordered_pending');
    } else if (activeFilter !== 'all') {
      displayItems = this.items.filter(i => i.section === activeFilter);
    }

    // Group display items by section
    const grouped = {};
    Object.keys(this.SECTIONS).forEach(secKey => {
      grouped[secKey] = [];
    });
    displayItems.forEach((item) => {
      const sKey = item.section || 'swaps_need';
      if (!grouped[sKey]) grouped[sKey] = [];
      const globalIdx = (item._id !== undefined) ? item._id : this.items.indexOf(item);
      grouped[sKey].push({ ...item, _globalIdx: globalIdx });
    });

    let html = tabsHtml + `
      <table class="table" style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: rgba(255,255,255,0.05); border-bottom: 2px solid var(--border-color);">
            <th style="padding: 10px; width: 40px; text-align: center;"><input type="checkbox" id="procurement-select-all" checked title="Select or deselect all items"></th>
            <th style="padding: 10px; text-align: left;">Category & Item</th>
            <th style="padding: 10px; text-align: center; width: 95px;">Size</th>
            <th style="padding: 10px; text-align: center; width: 90px;">Class / KV</th>
            <th style="padding: 10px; text-align: center; width: 80px;">Qty</th>
            <th style="padding: 10px; text-align: center; width: 145px;">Urgency / Status</th>
            <th style="padding: 10px; text-align: right; width: 95px;">Unit Price</th>
            <th style="padding: 10px; text-align: right; width: 105px;">Est. Total</th>
            <th style="padding: 10px; text-align: center; width: 90px;">Action</th>
          </tr>
        </thead>
        <tbody>
    `;

    // Helper to render individual item row & its lineman sub-rows
    const renderSingleItemHtml = (item, isUnderOrderGroup = false, secConfig = null) => {
      const isChecked = item.selected ? 'checked' : '';
      const totalCost = (item.price || 0) * item.quantity;
      const isTestingItem = item.itemType === 'Testing' || item.category === 'Testing' ||
        /\b(?:testing|labor)\b/i.test(item.itemType || '') ||
        /\b(?:testing|labor)\b/i.test(item.typeLabel || '') ||
        /\b(?:testing|labor)\b/i.test(item.size || '') ||
        /\b(?:testing|labor)\b/i.test(item.partNumber || '');
      const hasEmployees = !isTestingItem && item.employees && item.employees.length > 0;
      const checkedEmpCount = hasEmployees ? item.employees.filter(e => e.checked).length : 0;
      const secCfg = secConfig || this.SECTIONS[item.section] || this.SECTIONS.swaps_need;
      const isSubrowsExpanded = this.expandedItemSubrows && this.expandedItemSubrows.has(item._globalIdx);

      let empRowsHtml = '';
      if (hasEmployees) {
        empRowsHtml = item.employees.map((emp, empIdx) => {
          const isEmpChecked = emp.checked ? 'checked' : '';
          const empTotal = (emp.checked && item.price > 0) ? `$${item.price.toFixed(2)}` : '—';
          return `
            <tr class="procurement-emp-row" data-item-idx="${item._globalIdx}" data-emp-idx="${empIdx}" style="background: rgba(15, 23, 42, 0.45); border-bottom: 1px solid rgba(255, 255, 255, 0.05); ${emp.checked ? '' : 'opacity: 0.55;'}">
              <td style="padding: 6px 8px; text-align: right; color: #64748b; font-size: 13px; border-right: 1px solid rgba(255,255,255,0.04);">
                ↳
              </td>
              <td style="padding: 6px 12px;">
                <label style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; margin: 0;">
                  <input type="checkbox" class="procurement-emp-check" data-item-idx="${item._globalIdx}" data-emp-idx="${empIdx}" ${isEmpChecked} style="cursor: pointer; accent-color: #2563eb; width: 15px; height: 15px; margin: 0;">
                  <span style="font-weight: 600; font-size: 12.5px; color: ${emp.checked ? '#f8fafc' : '#94a3b8'};">
                    ${item.section === 'ordered_pending'
                      ? (emp.name.toLowerCase().includes('stock')
                          ? '📦 Stock Order (Replenishment)'
                          : (emp.name.toLowerCase().includes('shelf')
                              ? '📦 On Shelf (Safety Stock)'
                              : `👤 Ordered for: <strong style="color: #60a5fa;">${emp.name}</strong>`))
                      : `👤 ${emp.name}`}
                  </span>
                  ${(!isUnderOrderGroup && item.section === 'ordered_pending' && emp.orderInfo?.orderNumber) ? `
                    <span class="badge" style="font-size: 10px; padding: 1px 5px; background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 3px;" title="Order Number">
                      Order #: ${this.escapeHtml(emp.orderInfo.orderNumber)}${emp.orderInfo.vendor ? ' · ' + this.escapeHtml(emp.orderInfo.vendor) : ''}
                    </span>
                  ` : ''}
                  ${emp.detail && !isUnderOrderGroup ? `
                    <span style="font-size: 11px; padding: 2px 7px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); color: var(--text-secondary); border: 1px solid rgba(255, 255, 255, 0.08); font-weight: 500;">
                      ${emp.detail}
                    </span>
                  ` : ''}
                </label>
              </td>
              <td style="padding: 6px 8px; text-align: center; color: var(--text-muted); font-size: 12px;">
                ${item.size}
              </td>
              <td style="padding: 6px 8px; text-align: center; color: var(--text-muted); font-size: 12px;">
                ${item.classVal}
              </td>
              <td style="padding: 6px 8px; text-align: center; font-size: 12px; font-weight: 600; color: ${emp.checked ? '#4ade80' : '#64748b'};">
                ${emp.checked ? '1' : '0'}
              </td>
              <td style="padding: 6px 8px; text-align: center; font-size: 11px; color: var(--text-muted);">
                ${item.section === 'ordered_pending' ? '📦 Ordered' : item.timeframe}
              </td>
              <td style="padding: 6px 8px; text-align: right; font-family: monospace; font-size: 11.5px; color: var(--text-muted);">
                ${item.price > 0 ? `$${item.price.toFixed(2)}` : '—'}
              </td>
              <td style="padding: 6px 8px; text-align: right; font-family: monospace; font-size: 11.5px; color: ${emp.checked && item.price > 0 ? '#4ade80' : 'var(--text-muted)'}; font-weight: ${emp.checked ? '600' : 'normal'};">
                ${empTotal}
              </td>
              <td style="padding: 6px 8px; text-align: center;">
                ${item.section === 'ordered_pending' ? `
                  <div style="display: flex; align-items: center; justify-content: center; gap: 3px; flex-wrap: wrap;">
                    <button type="button" class="btn btn-xs" onclick="window.procurementEngine.quickMarkEmployeeItemReceived('${this.escapeJs(emp.name)}', '${this.escapeJs(item.itemType)}', '${this.escapeJs(item.size)}', '${this.escapeJs(item.classVal || '')}', ${item._globalIdx})" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: #6ee7b7; padding: 2px 5px; font-size: 10.5px; border-radius: 3px; cursor: pointer;" title="Mark received for this employee (already added to inventory)">
                      <span>✅</span> Rec'd
                    </button>
                    <button type="button" class="btn btn-xs" onclick="window.procurementEngine.openDeliverForEmployee('${this.escapeJs(emp.name)}', '${this.escapeJs(item.itemType)}', '${this.escapeJs(item.size)}')" style="background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.35); color: #93c5fd; padding: 2px 6px; font-size: 10.5px; border-radius: 3px; cursor: pointer;">
                      <span>🚚</span> Deliver
                    </button>
                    <button type="button" class="btn btn-xs" onclick="window.procurementEngine.openEditPendingOrderItem(${item._globalIdx}, ${empIdx})" style="background: rgba(148, 163, 184, 0.15); border: 1px solid rgba(148, 163, 184, 0.35); color: #cbd5e1; padding: 2px 5px; font-size: 10.5px; border-radius: 3px; cursor: pointer;" title="Edit who this is ordered for, Order #, Vendor, Price">
                      <span>✏️</span> Edit
                    </button>
                    <button type="button" class="btn btn-xs" onclick="window.procurementEngine.cancelPendingOrderItem(${item._globalIdx}, ${empIdx})" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #f87171; padding: 2px 5px; font-size: 10.5px; border-radius: 3px; cursor: pointer;" title="Cancel this order and revert back to Needs to Order">
                      <span>🗑️</span> Cancel
                    </button>
                  </div>
                ` : `
                  <button type="button" class="btn btn-xs" onclick="window.procurementEngine.openMarkOrderedModal([{ ...window.procurementEngine.items[${item._globalIdx}], quantity: 1, employees: [{ name: '${this.escapeJs(emp.name)}', label: '${this.escapeJs(emp.label)}', checked: true }] }])" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: #6ee7b7; padding: 2px 6px; font-size: 10.5px; border-radius: 3px; cursor: pointer;">
                      <span>📦</span> Order
                  </button>
                `}
              </td>
            </tr>
          `;
        }).join('');
      }

      let itemBadgesHtml = '';
      if (!isUnderOrderGroup && item.section === 'ordered_pending') {
        const orderNumSet = new Set();
        const vendorSet = new Set();
        const orderDatesSet = new Set();
        const delivDatesSet = new Set();
        if (item.orderInfo) {
          const ord = item.orderInfo.vendorOrderNumber || item.orderInfo.orderNumber || item.orderInfo.poNumber;
          if (ord) orderNumSet.add(ord);
          if (item.orderInfo.vendor) vendorSet.add(item.orderInfo.vendor);
          if (item.orderInfo.orderDate) orderDatesSet.add(item.orderInfo.orderDate);
          if (item.orderInfo.expectedDelivery && item.orderInfo.expectedDelivery !== 'Pending') delivDatesSet.add(item.orderInfo.expectedDelivery);
        }
        (item.employees || []).forEach(e => {
          const ord = e.orderInfo?.vendorOrderNumber || e.orderInfo?.orderNumber || e.orderInfo?.poNumber;
          if (ord) orderNumSet.add(ord);
          if (e.orderInfo?.vendor) vendorSet.add(e.orderInfo.vendor);
          if (e.orderInfo?.orderDate) orderDatesSet.add(e.orderInfo.orderDate);
          if (e.orderInfo?.expectedDelivery && e.orderInfo.expectedDelivery !== 'Pending') delivDatesSet.add(e.orderInfo.expectedDelivery);
          const ordM = (e.label || '').match(/(?:Order(?:\s*#)?|PO):\s*([^·)\s]+)/i);
          if (ordM) orderNumSet.add(ordM[1]);
        });
        const orderNumList = Array.from(orderNumSet).filter(Boolean);
        const vendorList = Array.from(vendorSet).filter(Boolean);
        const orderDateList = Array.from(orderDatesSet).filter(Boolean);
        const delivList = Array.from(delivDatesSet).filter(Boolean);

        itemBadgesHtml = `
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; font-size: 11px;">
            <span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); font-weight: 700; padding: 2px 6px; border-radius: 4px;" title="Order Number">
              ${orderNumList.length > 1 ? 'Order #s: ' + this.escapeHtml(orderNumList.join(', ')) : 'Order #: ' + this.escapeHtml(orderNumList[0] || 'Pending')}
            </span>
            ${vendorList.length > 0 ? `<span style="color: #cbd5e1; font-weight: 600;">🏢 ${this.escapeHtml(vendorList.join(' · '))}</span>` : ''}
            ${orderDateList.length > 0 ? `<span style="color: #94a3b8;">📅 Ordered: <strong>${this.escapeHtml(orderDateList[0])}</strong></span>` : ''}
            ${delivList.length > 0 ? `<span style="color: #38bdf8;">🚚 Est. Delivery: <strong>${this.escapeHtml(delivList[0])}</strong></span>` : ''}
          </div>
        `;
      } else if (item.partNumber) {
        itemBadgesHtml = `<div style="font-size: 11px; color: #3b82f6; margin-top: 1px;">PN: ${item.partNumber}</div>`;
      } else if (item.orderInfo?.orderNumber && !isUnderOrderGroup) {
        const ord = item.orderInfo.vendorOrderNumber || item.orderInfo.orderNumber;
        itemBadgesHtml = `<div style="font-size: 11px; color: #60a5fa; margin-top: 1px; font-weight: 600;">Order #: ${this.escapeHtml(ord)}${item.orderInfo.vendor ? ' · ' + this.escapeHtml(item.orderInfo.vendor) : ''}</div>`;
      }

      return `
        <tr style="border-bottom: 1px solid var(--border-color); ${item.selected ? 'background: rgba(37, 99, 235, 0.07);' : ''}">
          <td style="padding: 8px; text-align: center;">
            <input type="checkbox" class="procurement-item-check" data-idx="${item._globalIdx}" ${isChecked} title="Select/Deselect line item">
          </td>
          <td style="padding: 8px;">
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span style="font-weight: 600; color: var(--text-primary); font-size: 13.5px;">${item.typeLabel}</span>
              <span class="badge" style="font-size: 10px; padding: 1px 5px; background: ${secCfg.badgeColor}; color: ${secCfg.badgeText}; border: 1px solid ${secCfg.badgeBorder};">
                ${secCfg.shortTitle}
              </span>
              ${hasEmployees ? `
                <span class="badge" style="font-size: 10.5px; padding: 2px 7px; background: rgba(59, 130, 246, 0.15); color: #93c5fd; border-radius: 10px; border: 1px solid rgba(59, 130, 246, 0.35); cursor: pointer; user-select: none;" onclick="window.procurementEngine.toggleItemSubrows(${item._globalIdx}, event)" title="Click to expand/collapse individual lineman assignments">
                  ${isSubrowsExpanded ? '▼' : '▶'} 👥 ${checkedEmpCount}/${item.employees.length} assigned
                </span>
              ` : ''}
            </div>
            ${itemBadgesHtml}
          </td>
          <td style="padding: 8px; text-align: center;">
            ${item.hasNoSize ? `
              <span class="badge" style="background: rgba(245, 158, 11, 0.25); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.5); font-weight: 700; padding: 3px 8px; border-radius: 4px; font-size: 11px; display: inline-block;">
                ⚠️ Needs Size
              </span>
            ` : `
              <span style="font-weight: 600; color: var(--text-primary); font-size: 13px;">${item.size}</span>
            `}
          </td>
          <td style="padding: 8px; text-align: center; color: var(--text-secondary); font-weight: 500;">${item.classVal}</td>
          <td style="padding: 8px; text-align: center;">
            <input type="number" min="0" value="${item.quantity}" data-idx="${item._globalIdx}" class="procurement-qty-input" style="width: 55px; padding: 4px 6px; text-align: center; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); font-weight: 600;">
          </td>
          <td style="padding: 8px; text-align: center;">
            ${item.section === 'ordered_pending' ? `
              <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px;">
                📦 Ordered
              </span>
            ` : `
              <span class="badge ${item.priority === 'HIGH' ? 'badge-danger' : (item.priority === 'MEDIUM' ? 'badge-warning' : 'badge-success')}">
                ${item.priorityEmoji} ${item.timeframe}
              </span>
            `}
          </td>
          <td style="padding: 8px; text-align: right; font-family: monospace;">
            ${item.price > 0 ? `$${item.price.toFixed(2)}` : '—'}
          </td>
          <td style="padding: 8px; text-align: right; font-weight: 600; font-family: monospace;">
            ${totalCost > 0 ? `$${totalCost.toFixed(2)}` : '—'}
          </td>
          <td style="padding: 8px; text-align: center;">
            ${item.section === 'ordered_pending' ? `
              <div style="display: flex; align-items: center; justify-content: center; gap: 4px; flex-wrap: wrap;">
                <button type="button" class="btn btn-xs" onclick="window.procurementEngine.quickMarkItemReceived(${item._globalIdx})" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #6ee7b7; padding: 3px 7px; font-size: 11px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Mark this line item as Received and clear it from Awaiting Delivery (already added to inventory)">
                  <span>✅</span> Mark Rec'd
                </button>
                ${!this.isTestingServiceItem(item) ? `
                  <button type="button" class="btn btn-xs" onclick="window.procurementEngine.openBatchDeliveryModal([window.procurementEngine.items[${item._globalIdx}]])" style="background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.4); color: #93c5fd; padding: 3px 7px; font-size: 11px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Receive this delivered item into inventory and assign new item numbers">
                    <span>🚚</span> Deliver
                  </button>
                ` : ''}
                <button type="button" class="btn btn-xs" onclick="window.procurementEngine.openEditPendingOrderItem(${item._globalIdx})" style="background: rgba(148, 163, 184, 0.15); border: 1px solid rgba(148, 163, 184, 0.35); color: #cbd5e1; padding: 3px 7px; font-size: 11px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Edit Order #, Price, and Assigned Lineman">
                  <span>✏️</span> Edit
                </button>
                <button type="button" class="btn btn-xs" onclick="window.procurementEngine.cancelPendingOrderItem(${item._globalIdx})" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #f87171; padding: 3px 7px; font-size: 11px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Cancel this order and revert back to Needs to Order">
                  <span>🗑️</span> Cancel
                </button>
              </div>
            ` : `
              <button type="button" class="btn btn-xs" onclick="window.procurementEngine.openMarkOrderedModal([window.procurementEngine.items[${item._globalIdx}]])" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #6ee7b7; padding: 3px 8px; font-size: 11px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Mark this item as Ordered">
                <span>📦</span> Order
              </button>
            `}
          </td>
        </tr>
        ${isSubrowsExpanded ? empRowsHtml : ''}
      `;
    };

    // Render grouped sections
    Object.keys(this.SECTIONS).forEach(secKey => {
      const secConfig = this.SECTIONS[secKey];
      const secItems = grouped[secKey] || [];
      if (secItems.length === 0) return;

      const secUnits = secItems.reduce((acc, it) => acc + it.quantity, 0);
      const secAllChecked = secItems.every(it => it.selected);
      const secBadgeText = secKey === 'ordered_pending'
        ? this.formatOrderItemsCountText(this.summarizeOrderItems(secItems), true)
        : `${secItems.length} line ${secItems.length === 1 ? 'item' : 'items'} (${secUnits} units)`;

      const isSecCollapsed = this.isSectionCollapsed(secKey);

      html += `
        <!-- Section Header Row -->
        <tr class="procurement-section-header-row" data-section="${secKey}" style="background: ${secConfig.headerBg}; border-top: 2px solid ${secConfig.accentBorder}; border-bottom: 1px solid var(--border-color); cursor: pointer;" onclick="window.procurementEngine.toggleSectionCollapse('${secKey}', event)">
          <td style="padding: 8px; text-align: center;" onclick="event.stopPropagation()">
            <input type="checkbox" class="procurement-section-check" data-section="${secKey}" ${secAllChecked ? 'checked' : ''} title="Select/Deselect all in ${secConfig.title}">
          </td>
          <td colspan="8" style="padding: 10px 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="section-collapse-icon" style="font-size: 13px; color: ${secConfig.badgeText}; user-select: none;">${isSecCollapsed ? '▶' : '▼'}</span>
                <span style="font-size: 16px;">${secConfig.icon}</span>
                <span style="font-weight: 800; font-size: 13.5px; color: ${secConfig.badgeText};">${secConfig.title.toUpperCase()}</span>
                <span class="brand-badge" style="background: ${secConfig.badgeColor}; color: ${secConfig.badgeText}; border: 1px solid ${secConfig.badgeBorder}; font-size: 11px; font-weight: 700;">
                  ${secBadgeText}
                </span>
              </div>
              <div style="display: flex; align-items: center; gap: 12px;">
                <div style="font-size: 11.5px; color: var(--text-muted); font-style: italic;">
                  ${secConfig.desc}
                </div>
                <span style="font-size: 11px; color: var(--text-muted); user-select: none;">${isSecCollapsed ? '▶ Expand' : '▼ Collapse'}</span>
              </div>
            </div>
          </td>
        </tr>
      `;

      if (!isSecCollapsed) {
        if (secKey === 'ordered_pending') {
        // Group ordered items by Order Number / PO Number 1st
        const orderGroupsMap = new Map();
        secItems.forEach(item => {
          const meta = this.getOrderKeyForPendingItem(item);
          if (!orderGroupsMap.has(meta.orderKey)) {
            orderGroupsMap.set(meta.orderKey, {
              ...meta,
              items: [],
              totalUnits: 0,
              totalCost: 0
            });
          }
          const grp = orderGroupsMap.get(meta.orderKey);
          grp.items.push(item);
          grp.totalUnits += (item.quantity || 0);
          grp.totalCost += ((item.price || 0) * (item.quantity || 0));
        });

        // Reconcile group totalCost with purchase_orders canonical Total Price if available
        const snap = (this.db && typeof this.db.getSnapshot === 'function')
          ? this.db.getSnapshot()
          : (window.localDB ? window.localDB.getSnapshot() : null);
        const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
        const poRows = poTable ? (poTable.rows || []) : [];
        if (poRows.length > 0) {
          orderGroupsMap.forEach(grp => {
            const targetNum = String(grp.vendorOrderNumber || grp.orderNumber || grp.poNumber || '').trim().toLowerCase();
            if (targetNum && targetNum !== 'ed') {
              const matchedPo = poRows.find(r => {
                const pNum = String(r['PO Number'] || r['PO #'] || '').trim().toLowerCase();
                const notes = String(r['Notes'] || '');
                const parsed = this.parseOrderInfoFromNotes(notes);
                const vNum = (parsed?.vendorOrderNumber || '').toLowerCase();
                return pNum === targetNum || vNum === targetNum;
              });
              if (matchedPo) {
                const poTotal = parseFloat(matchedPo['Total Price'] || matchedPo['Price'] || 0) || 0;
                // Only fall back to poTotal from purchase_orders if grp.totalCost is 0 (items had no individual prices)
                if (grp.totalCost === 0 && poTotal > 0) {
                  grp.totalCost = poTotal;
                }
              }
            }
          });
        }

        this.orderGroupsMap = orderGroupsMap;

        // Render each Order as a primary collapsible line (sorted by order date descending)
        const sortedOrderGroups = Array.from(orderGroupsMap.entries()).sort((a, b) => {
          const dateA = this.parseDateForSort(a[1].orderDate);
          const dateB = this.parseDateForSort(b[1].orderDate);
          return dateB - dateA;
        });

        sortedOrderGroups.forEach(([orderKey, grp]) => {
          const isOrderCollapsed = !this.expandedOrders || !this.expandedOrders.has(orderKey);
          const allGroupChecked = grp.items.every(it => it.selected);
          const safeKeyAttr = this.escapeHtml(orderKey);
          const safeKeyJs = this.escapeHtml(String(orderKey).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));

          html += `
            <!-- Collapsible Order Group Header Row -->
            <tr class="procurement-order-group-header-row" data-order-key="${safeKeyAttr}" style="background: rgba(30, 41, 59, 0.95); border-top: 2px solid #3b82f6; border-bottom: 1px solid rgba(59, 130, 246, 0.4); cursor: pointer;" onclick="window.procurementEngine.toggleOrderCollapse('${safeKeyJs}', event)">
              <td style="padding: 10px 8px; text-align: center;" onclick="event.stopPropagation()">
                <input type="checkbox" class="procurement-order-group-check" data-order-key="${safeKeyAttr}" ${allGroupChecked ? 'checked' : ''} onchange="window.procurementEngine.toggleOrderGroupSelected('${safeKeyJs}', this.checked)" title="Select/Deselect all items in this order">
              </td>
              <td colspan="7" style="padding: 10px 14px;">
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                  <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <span class="order-collapse-icon" style="font-size: 13px; color: #93c5fd; user-select: none;">${isOrderCollapsed ? '▶' : '▼'}</span>
                    ${(() => {
                      const displayNum = grp.vendorOrderNumber || grp.poNumber || 'Pending Order';
                      const isRequestOnly = /^REQ-/i.test(displayNum) || /pending/i.test(displayNum);
                      if (isRequestOnly) {
                        return `
                          <span style="font-weight: 800; font-size: 14px; color: #f8fafc; letter-spacing: 0.3px; display: inline-flex; align-items: center; gap: 6px;">
                            📋 Request #: <span style="color: #fbbf24;">${this.escapeHtml(displayNum)}</span>
                            <span class="badge" style="background: rgba(245, 158, 11, 0.2); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.45); font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 4px;">⏳ Awaiting Vendor Order #</span>
                          </span>
                        `;
                      }
                      return `
                        <span style="font-weight: 800; font-size: 14px; color: #f8fafc; letter-spacing: 0.3px;">
                          📦 Order #: <span style="color: #60a5fa;">${this.escapeHtml(displayNum)}</span>
                        </span>
                      `;
                    })()}
                    ${grp.vendor ? `
                      <span style="font-weight: 600; color: #cbd5e1; font-size: 12.5px;">🏢 ${this.escapeHtml(grp.vendor)}</span>
                    ` : ''}
                    ${grp.orderDate ? `
                      <span style="color: #94a3b8; font-size: 12px;">📅 Ordered: <strong style="color: #f1f5f9;">${this.escapeHtml(grp.orderDate)}</strong></span>
                    ` : ''}
                    ${grp.expectedDelivery && grp.expectedDelivery !== 'Pending' ? `
                      <span style="color: #38bdf8; font-size: 12px;">🚚 Est. Delivery: <strong style="color: #67e8f9;">${this.escapeHtml(grp.expectedDelivery)}</strong></span>
                    ` : ''}
                    <span class="brand-badge" style="background: rgba(16, 185, 129, 0.18); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.35); font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px;">
                      ${this.formatOrderItemsCountText(this.summarizeOrderItems(grp.items), false)}
                    </span>
                    ${(() => {
                      const dSum = this._getPoOrderDraftSummary(grp.vendorOrderNumber || grp.poNumber || grp.orderNumber);
                      if (!dSum.hasDraft) return '';
                      const label = dSum.receivedCount > 0
                        ? `💾 In Progress (${dSum.receivedCount} received)`
                        : '💾 Draft Saved';
                      return `<span class="brand-badge" style="background: rgba(245, 158, 11, 0.2); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.45); font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px;" title="Saved edits / partial receiving progress stored">${label}</span>`;
                    })()}
                  </div>
                  <div style="display: flex; align-items: center; gap: 8px;" onclick="event.stopPropagation()">
                    ${grp.totalCost > 0 ? `
                      <span style="font-weight: 700; font-family: monospace; font-size: 13px; color: #34d399; margin-right: 6px;">
                        $${grp.totalCost.toFixed(2)}
                      </span>
                    ` : ''}
                    ${(/^REQ-/i.test(grp.vendorOrderNumber || grp.poNumber || '') || /pending/i.test(grp.vendorOrderNumber || grp.poNumber || '')) ? `
                      <button type="button" class="btn btn-xs" onclick="window.procurementEngine.promptUpdateVendorOrderNum('${safeKeyJs}')" style="background: rgba(245, 158, 11, 0.22); border: 1px solid rgba(245, 158, 11, 0.55); color: #fcd34d; padding: 4px 9px; font-size: 11px; border-radius: 4px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Update this Request with official Vendor Order # once received">
                        <span>🏷️</span> Enter Vendor Order #
                      </button>
                    ` : ''}
                    <button type="button" class="btn btn-xs" onclick="window.procurementEngine.emailOrderFromKey('${safeKeyJs}')" style="background: rgba(16, 185, 129, 0.22); border: 1px solid rgba(16, 185, 129, 0.55); color: #6ee7b7; padding: 4px 9px; font-size: 11px; border-radius: 4px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Email this purchase order/request to ${this.escapeHtml(grp.vendor || 'vendor')}">
                      <span>✉️</span> ${(/^REQ-/i.test(grp.vendorOrderNumber || grp.poNumber || '') || /pending/i.test(grp.vendorOrderNumber || grp.poNumber || '')) ? 'Email Request' : 'Email Order'}
                    </button>
                    <button type="button" class="btn btn-xs" onclick="window.procurementEngine.quickMarkOrderReceivedFromKey('${safeKeyJs}')" style="background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(16, 185, 129, 0.5); color: #6ee7b7; padding: 4px 9px; font-size: 11px; border-radius: 4px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Mark this entire order as Received and clear it from Awaiting Delivery (items already added to inventory)">
                      <span>✅</span> Mark Received
                    </button>
                    <button type="button" class="btn btn-xs" onclick="window.procurementEngine.openBatchDeliveryModal(window.procurementEngine.getOrderItems('${safeKeyJs}'))" style="background: rgba(59, 130, 246, 0.2); border: 1px solid rgba(59, 130, 246, 0.5); color: #93c5fd; padding: 4px 9px; font-size: 11px; border-radius: 4px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Receive all delivered items in this order into inventory and assign new item numbers">
                      <span>🚚</span> Receive Order
                    </button>
                    <button type="button" class="btn btn-xs" onclick="window.procurementEngine.openEditOrderFromKey('${safeKeyJs}')" style="background: rgba(148, 163, 184, 0.18); border: 1px solid rgba(148, 163, 184, 0.4); color: #e2e8f0; padding: 4px 8px; font-size: 11px; border-radius: 4px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Edit Order #, Vendor, Dates, or Details">
                      <span>✏️</span> Edit Order
                    </button>
                    <button type="button" class="btn btn-xs" onclick="window.procurementEngine.cancelOrderGroup('${safeKeyJs}')" style="background: rgba(239, 68, 68, 0.18); border: 1px solid rgba(239, 68, 68, 0.45); color: #f87171; padding: 4px 8px; font-size: 11px; border-radius: 4px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Cancel this entire order and revert all items back to Needs to Order">
                      <span>🗑️</span> Cancel Order
                    </button>
                  </div>
                </div>
              </td>
              <td style="padding: 10px 8px; text-align: center; color: var(--text-muted); font-size: 11px; user-select: none;">
                ${isOrderCollapsed ? '▶ Expand' : '▼ Collapse'}
              </td>
            </tr>
          `;

          if (!isOrderCollapsed) {
            grp.items.forEach(item => {
              html += renderSingleItemHtml(item, true, secConfig);
            });
          }
        });
      } else {
        secItems.forEach(item => {
          html += renderSingleItemHtml(item, false, secConfig);
        });
      }
    }
  });

    html += '</tbody></table>';
    container.innerHTML = html;

    // Master Select All Event
    const selectAll = document.getElementById('procurement-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', (e) => {
        const val = e.target.checked;
        displayItems.forEach(i => {
          i.selected = val;
          if (i.employees && i.employees.length > 0) {
            const prevChecked = i.employees.filter(emp => emp.checked).length;
            const extraSpare = Math.max(0, (i.quantity || 0) - prevChecked);
            i.employees.forEach(emp => {
              emp.checked = val;
            });
            i.quantity = val ? (i.employees.length + extraSpare) : 0;
          }
        });
        this.render();
      });
    }

    // Section Select All Checkboxes
    container.querySelectorAll('.procurement-section-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const sKey = e.target.dataset.section;
        this.toggleSectionSelected(sKey, e.target.checked);
      });
    });

    // Individual Item Checkboxes
    container.querySelectorAll('.procurement-item-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        const item = this.items[idx];
        if (!item) return;

        item.selected = e.target.checked;
        if (item.employees && item.employees.length > 0) {
          const prevChecked = item.employees.filter(emp => emp.checked).length;
          const extraSpare = Math.max(0, (item.quantity || 0) - prevChecked);
          item.employees.forEach(emp => {
            emp.checked = item.selected;
          });
          item.quantity = item.selected ? (item.employees.length + extraSpare) : 0;
        }
        this.render();
      });
    });

    // Individual Employee Checkboxes
    container.querySelectorAll('.procurement-emp-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const itemIdx = parseInt(e.target.dataset.itemIdx, 10);
        const empIdx = parseInt(e.target.dataset.empIdx, 10);
        const item = this.items[itemIdx];
        if (!item || !item.employees || !item.employees[empIdx]) return;

        const prevChecked = item.employees.filter(emp => emp.checked).length;
        const extraSpare = Math.max(0, (item.quantity || 0) - prevChecked);
        item.employees[empIdx].checked = e.target.checked;
        const checkedCount = item.employees.filter(emp => emp.checked).length;
        item.quantity = checkedCount > 0 ? (checkedCount + extraSpare) : 0;
        item.selected = checkedCount > 0;
        this.render();
      });
    });

    // Quantity Input Handlers
    container.querySelectorAll('.procurement-qty-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        const qty = parseInt(e.target.value, 10);
        const item = this.items[idx];
        if (item) {
          item.quantity = isNaN(qty) ? 0 : Math.max(0, qty);
          item.selected = item.quantity > 0;
          this.render();
        }
      });
    });

    this.updateTotals();
  }

  updateTotals() {
    const activeFilter = this.currentSectionFilter || 'all';
    let targetItems = this.items || [];
    if (activeFilter === 'needs') {
      targetItems = targetItems.filter(i => i.section !== 'ordered_pending');
    } else if (activeFilter !== 'all' && activeFilter !== 'history') {
      targetItems = targetItems.filter(i => i.section === activeFilter);
    }

    const selectedTargetItems = targetItems.filter(i => i.selected);
    let totalCost = 0;

    selectedTargetItems.forEach(i => {
      totalCost += ((i.price || 0) * (i.quantity || 0));
    });

    const badge = document.getElementById('procurement-selected-badge');
    if (badge) {
      if (activeFilter === 'ordered_pending') {
        const sum = this.summarizeOrderItems(selectedTargetItems);
        badge.textContent = this.formatOrderItemsCountText(sum, true);
      } else {
        const selectedCount = selectedTargetItems.length;
        const totalQty = selectedTargetItems.reduce((acc, i) => acc + (i.quantity || 0), 0);
        badge.textContent = `${selectedCount} items selected (${totalQty} units)`;
      }
    }

    const totalEl = document.getElementById('procurement-total-cost');
    if (totalEl) totalEl.textContent = `$${totalCost.toFixed(2)}`;
  }

  /**
   * Calculates the current fiscal year PO number prefix (002-XX).
   * Fiscal year runs October 1 to September 30 (e.g., Oct 2026 starts FY27 -> 002-27).
   */
  getPurchaseOrderNumber() {
    // 1. Check window.fiscalYearManager if initialized
    if (window.fiscalYearManager && window.fiscalYearManager.currentFY) {
      return `002-${window.fiscalYearManager.currentFY}`;
    }
    // 2. Check snapshot system config or metadata
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    if (snap?.metadata?.CURRENT_FISCAL_YEAR) {
      return `002-${snap.metadata.CURRENT_FISCAL_YEAR}`;
    }
    // 3. Fiscal Year starts Oct 1: Month >= 9 (October) transitions to next calendar year suffix (e.g. Oct 2026 -> FY27 -> 002-27)
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed: 9 = October
    const fyYear = month >= 9 ? year + 1 : year;
    return `002-${String(fyYear).slice(-2)}`;
  }

  /**
   * Returns the primary shop & warehouse delivery shipping address.
   */
  getShippingAddress() {
    return '606 West Custer Ave, Helena, MT, 59602';
  }

  /**
   * Formats a list of order items into the clean, concise supplier PO email text:
   * PO #: 002-27
   * Ship To: 606 West Custer Ave, Helena, MT, 59602
   * ----------------------------------------------------
   * Please process the following purchase order request:
   * (2) Sleeves, Size: Regular (Class 3) - Part #: <PartNumber>
   * ...
   * ----------------------------------------------------
   */
  formatCleanPOEmailText(itemsList, vendorName = null, preserveOrder = false) {
    const poNum = this.getPurchaseOrderNumber();
    const shipTo = this.getShippingAddress();
    const effVendor = vendorName || (this.selectedVendor ? this.selectedVendor.name : '');

    const formatClassStr = (classVal) => {
      if (!classVal) return '';
      const s = String(classVal).trim();
      if (!s || s.toLowerCase() === 'n/a') return '';
      return /^class\b/i.test(s) ? s : `Class ${s}`;
    };

    const cleanSizeStr = (sizeVal, hasNoSize) => {
      if (hasNoSize) return '⚠️ NEEDS SIZE (VERIFY WITH WORKER)';
      if (!sizeVal) return 'Standard';
      let s = String(sizeVal).trim();
      s = s.replace(/^size\s*[:\s]*/i, '').replace(/\s*\(\s*Class\s*[^)]*\)/i, '').trim();
      return s || 'Standard';
    };

    const consolidatedMap = new Map();
    (itemsList || []).forEach(item => {
      const rawType = item.itemType || item.category || item.typeLabel || 'Equipment';
      const cleanType = this.cleanItemType(rawType);
      const sizeStr = cleanSizeStr(item.size, item.hasNoSize);
      const classStr = formatClassStr(item.classVal);
      const liveCatalogPart = this.getVendorPartNumber(effVendor, cleanType, sizeStr, classStr);
      const resolvedPart = (liveCatalogPart && String(liveCatalogPart).trim())
        || (item.partNumber && String(item.partNumber).trim())
        || '';
      const qty = parseInt(item.quantity, 10) || 1;
      if (qty <= 0) return;

      const key = `${cleanType}__${sizeStr}__${classStr}__${resolvedPart}`.toLowerCase();
      if (consolidatedMap.has(key)) {
        const existing = consolidatedMap.get(key);
        existing.quantity += qty;
      } else {
        consolidatedMap.set(key, {
          itemType: cleanType,
          sizeDisplay: sizeStr,
          classDisplay: classStr,
          partNumber: resolvedPart,
          quantity: qty
        });
      }
    });

    const consolidatedItems = Array.from(consolidatedMap.values());

    if (!preserveOrder) {
      const categoryRank = (type) => {
        const t = String(type).toLowerCase();
        if (t.includes('sleeve')) return 1;
        if (t.includes('glove')) return 2;
        if (t.includes('blanket')) return 3;
        if (t.includes('mack')) return 4;
        return 5;
      };

      const extractClassNum = (classStr) => {
        const m = String(classStr).match(/\d+/);
        return m ? parseInt(m[0], 10) : 99;
      };

      const extractSizeNum = (sizeStr) => {
        const m = String(sizeStr).match(/\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : 999;
      };

      consolidatedItems.sort((a, b) => {
        const rA = categoryRank(a.itemType);
        const rB = categoryRank(b.itemType);
        if (rA !== rB) return rA - rB;

        const cA = extractClassNum(a.classDisplay);
        const cB = extractClassNum(b.classDisplay);
        if (cA !== cB) return cA - cB;

        const sA = extractSizeNum(a.sizeDisplay);
        const sB = extractSizeNum(b.sizeDisplay);
        if (sA !== sB) return sA - sB;

        return a.sizeDisplay.localeCompare(b.sizeDisplay, undefined, { numeric: true });
      });
    }

    const lines = [
      `PO #: ${poNum}`,
      `Ship To: ${shipTo}`,
      '----------------------------------------------------',
      'Please process the following purchase order request:'
    ];

    consolidatedItems.forEach(item => {
      const classPart = item.classDisplay ? ` (${item.classDisplay})` : '';
      const partSuffix = item.partNumber ? ` - Part #: ${item.partNumber}` : '';
      lines.push(`(${item.quantity}) ${item.itemType}, Size: ${item.sizeDisplay}${classPart}${partSuffix}`);
    });

    lines.push('----------------------------------------------------');
    return lines.join('\n');
  }

  /**
  * Builds clean, consolidated purchase order text formatted specifically for sending to suppliers.
  * Consolidates identical items by type, size, class, and part number, omitting internal section names and worker names.
  */
  buildCleanPOText(selected) {
    const vendorName = this.selectedVendor ? this.selectedVendor.name : '';
    return this.formatCleanPOEmailText(selected, vendorName, false);
  }

  /**
  * Builds detailed internal purchase order summary for safety department audit records.
  * Preserves section categories and individual employee assignments.
  */
  buildDetailedPOText(selected) {
    const poNum = this.getPurchaseOrderNumber();
    const vendorName = this.selectedVendor ? this.selectedVendor.name : '[Vendor Name]';
    const dateStr = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const shipTo = this.getShippingAddress();

    let lines = [];
    lines.push(`PURCHASE ORDER: ${poNum} (INTERNAL SUMMARY WITH WORKER BREAKDOWN)`);
    lines.push(`Date: ${dateStr}`);
    lines.push(`Vendor: ${vendorName}`);
    if (this.selectedVendor && this.selectedVendor.email) {
      const contactPart = this.selectedVendor.contact ? `${this.selectedVendor.contact} ` : '';
      lines.push(`Attn: ${contactPart}(${this.selectedVendor.email})`);
    }
    lines.push(`Ship To: ${shipTo}`);
    lines.push('----------------------------------------------------');
    lines.push('Internal Breakdown by Needs Category & Personnel:\n');

    let grandTotal = 0;

    const secKeys = ['swaps_need', 'swaps_size_up', 'assigned_size_up', 'compliance_missing'];
    secKeys.forEach(sKey => {
      const secItems = selected.filter(i => i.section === sKey);
      if (secItems.length === 0) return;

      const secTitle = this.SECTIONS[sKey]?.title || sKey;
      lines.push(`--- ${secTitle.toUpperCase()} ---`);

      secItems.forEach(item => {
        const sizeDisplay = item.hasNoSize ? '⚠️ NEEDS SIZE (VERIFY WITH WORKER)' : `Size ${item.size}`;
        let line = `• (${item.quantity}) ${item.itemType} - ${sizeDisplay} - Class/Rating: ${item.classVal}`;
        if (item.partNumber) line += ` [Part #: ${item.partNumber}]`;
        if (item.price > 0) {
          const itemTotal = item.price * item.quantity;
          grandTotal += itemTotal;
          line += ` @ $${item.price.toFixed(2)} ea = $${itemTotal.toFixed(2)}`;
        }
        if (item.employees && item.employees.length > 0) {
          const checkedEmps = item.employees.filter(e => e.checked).map(e => e.label || e.name);
          if (checkedEmps.length > 0) {
            line += `\n    └ ${checkedEmps.join(', ')}`;
          }
        }
        lines.push(line);
      });
      lines.push('');
    });

    lines.push('----------------------------------------------------');
    if (grandTotal > 0) {
      lines.push(`Estimated Total: $${grandTotal.toFixed(2)}`);
    }
    lines.push('Generated for internal safety department records.\n');
    lines.push('Safety Department');

    return lines.join('\n');
  }

  /**
  * Switches between clean vendor order text and detailed internal summary text in the PO modal.
  */
  setPOFormat(format = 'clean') {
    this.currentPOFormat = format;
    const textarea = document.getElementById('procurement-po-textarea');
    const tabClean = document.getElementById('po-tab-clean');
    const tabDetailed = document.getElementById('po-tab-detailed');
    const hintEl = document.getElementById('po-format-hint');

    if (textarea && this.generatedPOTexts) {
      textarea.value = this.generatedPOTexts[format] || '';
    }

    if (tabClean && tabDetailed) {
      if (format === 'clean') {
        tabClean.style.background = '#2563eb';
        tabClean.style.color = '#ffffff';
        tabClean.style.boxShadow = '0 1px 3px rgba(0,0,0,0.3)';
        tabDetailed.style.background = 'transparent';
        tabDetailed.style.color = 'var(--text-secondary)';
        tabDetailed.style.boxShadow = 'none';
        if (hintEl) hintEl.textContent = 'Consolidated order ready to email to supplier (no worker names or internal section tags)';
      } else {
        tabDetailed.style.background = '#2563eb';
        tabDetailed.style.color = '#ffffff';
        tabDetailed.style.boxShadow = '0 1px 3px rgba(0,0,0,0.3)';
        tabClean.style.background = 'transparent';
        tabClean.style.color = 'var(--text-secondary)';
        tabClean.style.boxShadow = 'none';
        if (hintEl) hintEl.textContent = 'Internal department audit summary with worker assignments and swap reasons';
      }
    }
  }

  /**
  * Opens default email client (mailto:) with current PO text pre-filled.
  */
  openInEmailClient() {
    const toInput = document.getElementById('procurement-po-email-to');
    const subjInput = document.getElementById('procurement-po-subject');
    const textarea = document.getElementById('procurement-po-textarea');
    const to = toInput ? toInput.value.trim() : (this.selectedVendor?.email || '');
    const subject = subjInput ? subjInput.value.trim() : `Purchase Order Request - ${this.selectedVendor?.name || 'Vendor'}`;
    const bodyText = textarea ? textarea.value : (this.generatedPOTexts?.clean || '');

    if (!to) {
      if (textarea) {
        navigator.clipboard.writeText(bodyText).then(() => {
          alert('Copied Purchase Order / Request to clipboard!\n\nNote: No vendor email address was specified. You can paste this directly into your email.');
        });
      }
      return;
    }

    const mailtoUrl = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
    if (window.desktopAPI && typeof window.desktopAPI.openExternal === 'function') {
      window.desktopAPI.openExternal(mailtoUrl);
    } else {
      window.location.href = mailtoUrl;
    }
  }

  openInGmail() {
    const toInput = document.getElementById('procurement-po-email-to');
    const subjInput = document.getElementById('procurement-po-subject');
    const textarea = document.getElementById('procurement-po-textarea');
    const to = toInput ? toInput.value.trim() : (this.selectedVendor?.email || '');
    const subject = subjInput ? subjInput.value.trim() : `Purchase Order Request - ${this.selectedVendor?.name || 'Vendor'}`;
    const bodyText = textarea ? textarea.value : (this.generatedPOTexts?.clean || '');

    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
    if (window.desktopAPI && typeof window.desktopAPI.openExternal === 'function') {
      window.desktopAPI.openExternal(gmailUrl);
    } else {
      window.open(gmailUrl, '_blank');
    }
  }

  emailOrderFromKey(orderKey) {
    const grp = this.orderGroupsMap ? this.orderGroupsMap.get(orderKey) : null;
    if (!grp) return;

    const rawOrderNum = String(grp.vendorOrderNumber || grp.orderNumber || grp.poNumber || '').trim();
    const targetOrderNum = rawOrderNum || 'Request';
    const hasRealOrderNum = Boolean(rawOrderNum && rawOrderNum.toLowerCase() !== 'request' && rawOrderNum.toLowerCase() !== 'pending');
    const isReq = !hasRealOrderNum || /^REQ-/i.test(targetOrderNum);
    const vendorName = grp.vendor || (this.selectedVendor?.name || 'Vendor');
    const vendorObj = this.vendors.find(v => v.name.toLowerCase() === vendorName.toLowerCase())
      || (this.selectedVendor?.name?.toLowerCase() === vendorName.toLowerCase() ? this.selectedVendor : null)
      || (this.vendors.length ? this.vendors[0] : null);

    const vendorEmail = vendorObj?.email || '';

    // Check if there is an explicit PO row in purchase_orders to preserve exact line items
    const snap = (this.db && typeof this.db.getSnapshot === 'function') ? this.db.getSnapshot() : null;
    const poTable = snap?.tables?.['purchase_orders'];
    const pRow = (hasRealOrderNum && poTable?.rows) ? poTable.rows.find(r => {
      const p = String(r['PO Number'] || r['PO #'] || '').trim();
      const n = String(r['Notes'] || '');
      return p.toLowerCase() === rawOrderNum.toLowerCase() || n.toLowerCase().includes(rawOrderNum.toLowerCase());
    }) : null;

    let itemsForEmail = [];
    const loadedFromPoRecord = Boolean(pRow && pRow['Items']);
    if (loadedFromPoRecord) {
      itemsForEmail = this.parsePoItemsString(pRow['Items']);
    }

    // Consolidate items in this group for fallback or internal breakdown
    const itemsMap = new Map();
    (grp.items || []).forEach(it => {
      const cleanType = this.cleanItemType(it.itemType || it.typeLabel || 'Equipment');
      const k = `${cleanType}|${it.size}|${it.classVal}`;
      if (!itemsMap.has(k)) {
        itemsMap.set(k, {
          itemType: cleanType,
          size: it.size || 'Standard',
          classVal: it.classVal || '',
          price: it.price || 0,
          partNumber: it.partNumber || this.getVendorPartNumber(vendorName, cleanType, it.size, it.classVal) || '',
          quantity: 0,
          employees: []
        });
      }
      const entry = itemsMap.get(k);
      entry.quantity += (it.quantity || 1);
      if (it.employees && it.employees.length) {
        entry.employees.push(...it.employees.map(e => e.name || e.label || e));
      }
    });

    if (!itemsForEmail.length) {
      itemsForEmail = Array.from(itemsMap.values());
    }

    // 1. Build clean vendor email text
    const cleanText = this.formatCleanPOEmailText(itemsForEmail, vendorName, false);

    // 2. Build detailed internal breakdown text (keep in sync with PO line items when loaded from PO record)
    let detailedLines = [cleanText, '\n====================================================', 'INTERNAL ASSIGNMENT BREAKDOWN:'];
    if (loadedFromPoRecord && itemsForEmail.length > 0) {
      itemsForEmail.forEach(it => {
        const cleanType = this.cleanItemType(it.itemType || it.category || 'Equipment');
        const mapEntry = itemsMap.get(`${cleanType}|${it.size}|${it.classVal}`);
        const emps = it.employeeName || (mapEntry && mapEntry.employees.length ? mapEntry.employees.join(', ') : 'Shelf Stock');
        const partNum = it.partNumber || this.getVendorPartNumber(vendorName, cleanType, it.size, it.classVal) || '';
        const partDisplay = partNum ? ` [Part #: ${partNum}]` : '';
        detailedLines.push(`- ${it.quantity}x ${cleanType} (${it.size}, ${it.classVal})${partDisplay} -> For: ${emps}`);
      });
    } else if (itemsMap.size > 0) {
      itemsMap.forEach(it => {
        const emps = it.employees.length ? it.employees.join(', ') : 'Shelf Stock';
        const partDisplay = it.partNumber ? ` [Part #: ${it.partNumber}]` : '';
        detailedLines.push(`- ${it.quantity}x ${it.itemType} (${it.size}, ${it.classVal})${partDisplay} -> For: ${emps}`);
      });
    } else {
      itemsForEmail.forEach(it => {
        const emps = it.employeeName || 'Shelf Stock';
        const partNum = it.partNumber || this.getVendorPartNumber(vendorName, it.itemType || it.category, it.size, it.classVal) || '';
        const partDisplay = partNum ? ` [Part #: ${partNum}]` : '';
        detailedLines.push(`- ${it.quantity}x ${it.itemType || it.category} (${it.size}, ${it.classVal})${partDisplay} -> For: ${emps}`);
      });
    }
    const detailedText = detailedLines.join('\n');

    this.generatedPOTexts = {
      clean: cleanText,
      detailed: detailedText
    };

    const modal = document.getElementById('procurement-po-modal');
    if (modal) {
      const toInput = document.getElementById('procurement-po-email-to');
      if (toInput) toInput.value = vendorEmail;
      const subjInput = document.getElementById('procurement-po-subject');
      if (subjInput) {
        subjInput.value = `Purchase Order ${this.getPurchaseOrderNumber()} - Mountain Power (${vendorName})`;
      }
      const titleEl = document.getElementById('procurement-po-modal-title');
      if (titleEl) {
        titleEl.textContent = isReq ? `Email Order Request #${targetOrderNum} to Vendor` : `Email Order #${targetOrderNum} to Vendor`;
      }
      const textarea = document.getElementById('procurement-po-textarea');
      if (textarea) textarea.value = cleanText;

      const banner = document.getElementById('po-swaps-ordered-banner');
      if (banner) banner.style.display = 'none';

      this.setPOFormat('clean');
      modal.style.display = 'flex';
      modal.classList.add('active');
    }
  }

  emailOrderFromHistory(poIndex) {
    const po = this.poHistoryList ? this.poHistoryList[poIndex] : null;
    if (!po) return;

    const targetOrderNum = String(po.vendorOrderNum || po.poNum || 'Request').trim();
    const isReq = /^REQ-/i.test(targetOrderNum);
    const vendorName = po.vendor || (this.selectedVendor?.name || 'Vendor');
    const vendorObj = this.vendors.find(v => v.name.toLowerCase() === vendorName.toLowerCase())
      || (this.selectedVendor?.name?.toLowerCase() === vendorName.toLowerCase() ? this.selectedVendor : null)
      || (this.vendors.length ? this.vendors[0] : null);

    const vendorEmail = vendorObj?.email || '';
    const parsedItems = this.parsePoItemsString(po.items || '');

    const cleanText = this.formatCleanPOEmailText(parsedItems, vendorName, false);

    let detailedLines = [cleanText, '\n====================================================', 'INTERNAL ASSIGNMENT BREAKDOWN:'];
    parsedItems.forEach(it => {
      const emps = it.employeeName || 'Shelf Stock';
      const partNum = it.partNumber || this.getVendorPartNumber(vendorName, it.itemType || it.category, it.size, it.classVal) || '';
      const partDisplay = partNum ? ` [Part #: ${partNum}]` : '';
      detailedLines.push(`- ${it.quantity}x ${it.itemType || it.category} (${it.size}, ${it.classVal})${partDisplay} -> For: ${emps}`);
    });
    const detailedText = detailedLines.join('\n');

    this.generatedPOTexts = { clean: cleanText, detailed: detailedText };

    const modal = document.getElementById('procurement-po-modal');
    if (modal) {
      const toInput = document.getElementById('procurement-po-email-to');
      if (toInput) toInput.value = vendorEmail;
      const subjInput = document.getElementById('procurement-po-subject');
      if (subjInput) {
        subjInput.value = `Purchase Order ${this.getPurchaseOrderNumber()} - Mountain Power (${vendorName})`;
      }
      const titleEl = document.getElementById('procurement-po-modal-title');
      if (titleEl) {
        titleEl.textContent = isReq ? `Email Order Request #${targetOrderNum} to Vendor` : `Email Order #${targetOrderNum} to Vendor`;
      }
      const textarea = document.getElementById('procurement-po-textarea');
      if (textarea) textarea.value = cleanText;

      const banner = document.getElementById('po-swaps-ordered-banner');
      if (banner) banner.style.display = 'none';

      this.setPOFormat('clean');
      modal.style.display = 'flex';
      modal.classList.add('active');
    }
  }

  /**
   * Marks corresponding swap sheet rows as 'Ordered 📦' instead of 'Need to Purchase ❌' / 'Need To Order'
   * for items selected when the PO is generated. Updates in-memory rows & rawGrid, saves snapshot,
   * and queues UPDATE_CELL mutations for cloud sync.
   * @param {Array} selectedItems - Selected procurement items
   * @returns {Promise<number>} Number of swap rows updated
   */
  async markSwapsAsOrdered(selectedItems) {
    if (!selectedItems || !Array.isArray(selectedItems) || selectedItems.length === 0) {
      return 0;
    }

    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);

    const SWAP_MAP = {
      'gloves': 'glove_swaps',
      'sleeves': 'sleeve_swaps',
      'blankets': 'blanket_swaps',
      'macks': 'mack_swaps',
      'hv testers': 'hv_tester_swaps',
      'phasing sets': 'phasing_set_swaps',
      'grounds': 'ground_swaps',
      'hot sticks': 'hot_stick_swaps',
      'aed': 'aed_swaps'
    };

    const SHEET_NAME_MAP = {
      'glove_swaps': 'Glove Swaps',
      'sleeve_swaps': 'Sleeve Swaps',
      'blanket_swaps': 'Blanket Swaps',
      'mack_swaps': 'MACK Swaps',
      'hv_tester_swaps': 'HV Tester Swaps',
      'phasing_set_swaps': 'Phasing Set Swaps',
      'ground_swaps': 'Ground Swaps',
      'hot_stick_swaps': 'Hot Stick Swaps',
      'aed_swaps': 'AED Swaps'
    };

    let totalUpdated = 0;
    const modifiedTables = new Set();
    const updatedRows = new Set();

    for (const item of selectedItems) {
      // Only process items that correspond to swap sheets
      if (item.section !== 'swaps_need' && item.section !== 'swaps_size_up') {
        continue;
      }

      const itemTypeLower = String(item.itemType || '').trim().toLowerCase();
      const swapKey = SWAP_MAP[itemTypeLower];
      if (!swapKey) continue;

      const table = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(swapKey) : null) ||
                    snap?.tables?.[swapKey];
      if (!table) continue;

      const sheetName = (this.db && typeof this.db.getSheetNameForTableKey === 'function')
        ? this.db.getSheetNameForTableKey(swapKey)
        : (SHEET_NAME_MAP[swapKey] || table.name || swapKey);

      // Determine column indices
      let statCol = -1;
      let sizeCol = -1;
      if (table.headers && Array.isArray(table.headers)) {
        statCol = table.headers.findIndex(h => /^status$/i.test(String(h || '').trim()));
        sizeCol = table.headers.findIndex(h => /^size$/i.test(String(h || '').trim()));
      }
      if (statCol === -1) {
        statCol = swapKey.includes('mack') ? 9 : 7;
      }
      if (sizeCol === -1) {
        sizeCol = swapKey.includes('mack') ? 3 : 2;
      }

      // Collect target employee names that were selected
      let targetEmployees = [];
      if (item.employees && Array.isArray(item.employees) && item.employees.length > 0) {
        targetEmployees = item.employees.filter(e => e.checked !== false).map(e => e.name);
      }
      if (targetEmployees.length === 0 && item.quantity > 0) {
        for (let q = 0; q < item.quantity; q++) {
          targetEmployees.push('On Shelf');
        }
      }

      for (const targetName of targetEmployees) {
        const isTargetShelf = targetName.toLowerCase().includes('on shelf') || targetName.toLowerCase() === 'shelf';

        let matchedRowObj = null;
        let matchedGridIdx = -1;
        let oldStatusVal = '';

        // 1. Search table.rows if available
        if (table.rows && Array.isArray(table.rows)) {
          for (const r of table.rows) {
            const rowEmp = String(r['Employee'] || r['Employee Name'] || r['Assigned To'] || '').trim();
            const rowIdx = r._rowIdx || (table.rows.indexOf(r) + 2);
            const rowKey = `${swapKey}:${rowIdx}`;
            if (updatedRows.has(rowKey)) continue;

            const curStat = String(r['Status'] || '').trim();
            if (!this.isNeedToOrderStat(curStat)) continue;

            if (isTargetShelf) {
              const isRowShelf = rowEmp.toLowerCase().includes('on shelf') || rowEmp.toLowerCase() === 'shelf';
              if (isRowShelf) {
                const rSize = this.cleanSize(r['Size']);
                const itemSize = this.cleanSize(item.size);
                if (!itemSize || !rSize || itemSize.includes(rSize) || rSize.includes(itemSize)) {
                  matchedRowObj = r;
                  matchedGridIdx = rowIdx - 1;
                  oldStatusVal = curStat;
                  break;
                }
              }
            } else {
              if (this.isNameMatch(rowEmp, targetName)) {
                const rSize = this.cleanSize(r['Size'] || r['Type'] || r['Model']);
                const itemSize = this.cleanSize(item.size);
                const sizeOk = !itemSize || !rSize || itemSize === 'standard' || itemSize.includes(rSize) || rSize.includes(itemSize);
                const rCls = String(r['Class'] || r['KV'] || '').replace(/[^0-9]/g, '');
                const iCls = String(item.classVal || '').replace(/[^0-9]/g, '');
                const clsOk = !rCls || !iCls || rCls === iCls;
                if (sizeOk && clsOk) {
                  matchedRowObj = r;
                  matchedGridIdx = rowIdx - 1;
                  oldStatusVal = curStat;
                  break;
                }
              }
            }
          }
        }

        // 2. Search table.rawGrid if not matched in rows
        if (!matchedRowObj && table.rawGrid && Array.isArray(table.rawGrid)) {
          for (let gIdx = 1; gIdx < table.rawGrid.length; gIdx++) {
            const gr = table.rawGrid[gIdx];
            if (!Array.isArray(gr)) continue;
            const rowKey = `${swapKey}:${gIdx + 1}`;
            if (updatedRows.has(rowKey)) continue;

            const rowEmp = String(gr[0] || '').trim();
            if (rowEmp.includes('📍') || rowEmp.includes('👤') || rowEmp.includes('👷') ||
                rowEmp.includes('Foreman:') || rowEmp.includes('Swaps') || rowEmp === 'Employee' || rowEmp === 'Item #') {
              continue;
            }

            const curStat = String(gr[statCol] || '').trim();
            if (!this.isNeedToOrderStat(curStat)) continue;

            if (isTargetShelf) {
              const isRowShelf = rowEmp.toLowerCase().includes('on shelf') || rowEmp.toLowerCase() === 'shelf';
              if (isRowShelf) {
                const rSize = this.cleanSize(gr[sizeCol]);
                const itemSize = this.cleanSize(item.size);
                if (!itemSize || !rSize || itemSize.includes(rSize) || rSize.includes(itemSize)) {
                  matchedGridIdx = gIdx;
                  oldStatusVal = curStat;
                  break;
                }
              }
            } else {
              if (this.isNameMatch(rowEmp, targetName)) {
                const rSize = this.cleanSize(gr[sizeCol]);
                const itemSize = this.cleanSize(item.size);
                if (!itemSize || !rSize || itemSize === 'standard' || itemSize.includes(rSize) || rSize.includes(itemSize)) {
                  matchedGridIdx = gIdx;
                  oldStatusVal = curStat;
                  break;
                }
              }
            }
          }
        }

        // Apply status transition to 'Ordered 📦'
        if (matchedGridIdx !== -1 || matchedRowObj) {
          const actualRowIdx = matchedRowObj ? (matchedRowObj._rowIdx || (matchedGridIdx + 1)) : (matchedGridIdx + 1);
          const rowKey = `${swapKey}:${actualRowIdx}`;
          updatedRows.add(rowKey);

          // Update in-memory rowObj
          if (matchedRowObj) {
            matchedRowObj['Status'] = 'Ordered 📦';
          }

          // Update in-memory rawGrid
          if (table.rawGrid && Array.isArray(table.rawGrid) && table.rawGrid[actualRowIdx - 1]) {
            table.rawGrid[actualRowIdx - 1][statCol] = 'Ordered 📦';
          }

          // Queue UPDATE_CELL mutation for cloud repository sync
          if (this.db && typeof this.db.addMutation === 'function') {
            await this.db.addMutation({
              action: 'UPDATE_CELL',
              sheetName: sheetName,
              tableKey: swapKey,
              row: actualRowIdx,
              col: statCol + 1,
              header: 'Status',
              oldValue: oldStatusVal || 'Need to Purchase ❌',
              value: 'Ordered 📦'
            });
          }

          modifiedTables.add(swapKey);
          totalUpdated++;
        }
      }
    }

    if (totalUpdated > 0) {
      // Save local database snapshot
      if (this.db && typeof this.db.persistSnapshot === 'function') {
        await this.db.persistSnapshot(snap);
      } else if (window.desktopAPI && typeof window.desktopAPI.saveLocalSnapshot === 'function' && snap) {
        await window.desktopAPI.saveLocalSnapshot(snap);
      }

      // Re-scan purchase needs so ordered items are excluded from demand
      this.scanPurchaseNeeds();
      this.render();

      // If active sheet matches a modified swap table, re-render it
      if (window.sheetNavigator && modifiedTables.has(window.sheetNavigator.currentSheetKey) && typeof window.sheetNavigator.renderCurrentSheet === 'function') {
        window.sheetNavigator.renderCurrentSheet();
      }
    }

    return totalUpdated;
  }

  async generatePOText() {
    const selected = this.items.filter(i => i.selected && i.quantity > 0 && i.section !== 'ordered_pending');
    if (selected.length === 0) {
      alert('Please select at least one item needing purchase to generate a purchase order.');
      return;
    }

    // Previewing PO text must NOT mutate swap sheets to Ordered (use "Create Order / Mark Ordered" to commit an order)
    this.generatedPOTexts = {
      clean: this.buildCleanPOText(selected),
      detailed: this.buildDetailedPOText(selected)
    };

    const modal = document.getElementById('procurement-po-modal');
    if (modal) {
      const toInput = document.getElementById('procurement-po-email-to');
      if (toInput) toInput.value = this.selectedVendor?.email || '';
      const subjInput = document.getElementById('procurement-po-subject');
      if (subjInput) subjInput.value = `Purchase Order ${this.getPurchaseOrderNumber()} - ${this.selectedVendor?.name || 'Vendor'}`;
      const titleEl = document.getElementById('procurement-po-modal-title');
      if (titleEl) titleEl.textContent = 'Email Purchase Order to Vendor';

      const banner = document.getElementById('po-swaps-ordered-banner');
      if (banner) {
        banner.style.display = 'none';
      }
      this.setPOFormat('clean');
      modal.style.display = 'flex';
      modal.classList.add('active');
    }
  }

  openManageVendorsModal() {
    this._vendorsBackupBeforeEdit = JSON.parse(JSON.stringify(this.vendors || []));
    this.activeModalVendorIdx = (this.activeModalVendorIdx !== undefined && this.activeModalVendorIdx < this.vendors.length) ? this.activeModalVendorIdx : 0;
    this.activeCatalogCategoryTab = this.activeCatalogCategoryTab || 'all';
    this.catalogSearchQuery = '';
    this.renderVendorModal();
    const modal = document.getElementById('manage-vendors-modal');
    if (modal) {
      modal.style.display = 'flex';
      modal.classList.add('active');
    }
  }

  closeManageVendorsModal(saved = false) {
    if (!saved && this._vendorsBackupBeforeEdit) {
      this.vendors = this._vendorsBackupBeforeEdit;
      if (this.selectedVendor) {
        this.selectedVendor = this.vendors.find(v => v.name === this.selectedVendor.name) || null;
      }
    }
    this._vendorsBackupBeforeEdit = null;
    const modal = document.getElementById('manage-vendors-modal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.remove('active');
    }
  }

  renderVendorModal() {
    const body = document.getElementById('manage-vendors-modal-body');
    if (!body) return;

    if (!this.vendors || this.vendors.length === 0) {
      body.innerHTML = `
        <div style="padding: 50px 20px; text-align: center; color: var(--text-muted);">
          <div style="font-size: 36px; margin-bottom: 10px;">🏢</div>
          <h3 style="color: var(--text-primary); font-size: 16px; margin-bottom: 6px;">No Vendors Configured</h3>
          <p style="font-size: 13px; max-width: 440px; margin: 0 auto 16px;">
            Click <strong>"➕ Add Vendor"</strong> to create a vendor, or click <strong>"Download Snapshot"</strong> to sync with Google Sheets.
          </p>
          <button class="btn btn-primary" style="font-size: 12px; padding: 6px 16px;" onclick="window.procurementEngine.addVendor()">➕ Add Vendor</button>
        </div>
      `;
      return;
    }

    const currentV = this.vendors[this.activeModalVendorIdx] || this.vendors[0];

    let html = `
      <div style="display: grid; grid-template-columns: 230px 1fr; gap: 18px; min-height: 560px;">
        <!-- Left Column: Vendors List -->
        <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-weight: 700; font-size: 13px; color: #93c5fd;">🏢 Vendors (${this.vendors.length})</div>
            <button class="btn btn-primary" style="font-size: 11px; padding: 4px 8px;" onclick="window.procurementEngine.addVendor()">➕ Add</button>
          </div>
          <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; max-height: 500px;">
    `;

    this.vendors.forEach((v, idx) => {
      const isSelected = idx === this.activeModalVendorIdx;
      html += `
        <div style="padding: 10px; border-radius: 6px; cursor: pointer; border: 1px solid ${isSelected ? '#3b82f6' : 'var(--border-color)'}; background: ${isSelected ? 'rgba(59, 130, 246, 0.15)' : 'rgba(30, 41, 59, 0.4)'}; display: flex; justify-content: space-between; align-items: center;" onclick="window.procurementEngine.selectModalVendor(${idx})">
          <div>
            <div style="font-weight: ${isSelected ? '700' : '500'}; color: ${isSelected ? '#fff' : 'var(--text-primary)'}; font-size: 12.5px;">${this.escapeHtml(v.name || 'Unnamed Vendor')}</div>
            <div style="font-size: 11px; color: var(--text-muted);" id="vendor-card-count-${idx}">${(v.items || []).length} catalog items</div>
          </div>
          <button class="btn btn-secondary" style="padding: 2px 6px; font-size: 11px; color: #f87171;" title="Delete Vendor" onclick="event.stopPropagation(); window.procurementEngine.deleteVendor(${idx})">🗑️</button>
        </div>
      `;
    });

    html += `
          </div>
        </div>

        <!-- Right Column: Vendor Details & Product Catalog -->
        <div style="display: flex; flex-direction: column; gap: 14px; overflow: hidden;">
          <!-- Vendor Contact Info (Compact 4-Column Row) -->
          <div style="background: rgba(30, 41, 59, 0.5); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 14px;">
            <div style="font-weight: 700; font-size: 12.5px; color: #93c5fd; margin-bottom: 8px;">👤 Vendor Contact Details</div>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;">
              <div>
                <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 3px;">Vendor Name</label>
                <input type="text" value="${this.escapeHtml(currentV.name || '')}" class="form-input" style="width: 100%; font-size: 12px; padding: 6px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;" onchange="window.procurementEngine.updateCurrentVendorField('name', this.value)">
              </div>
              <div>
                <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 3px;">Contact Person</label>
                <input type="text" value="${this.escapeHtml(currentV.contact || '')}" class="form-input" style="width: 100%; font-size: 12px; padding: 6px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;" onchange="window.procurementEngine.updateCurrentVendorField('contact', this.value)">
              </div>
              <div>
                <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 3px;">Email Address</label>
                <input type="email" value="${this.escapeHtml(currentV.email || '')}" class="form-input" style="width: 100%; font-size: 12px; padding: 6px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;" onchange="window.procurementEngine.updateCurrentVendorField('email', this.value)">
              </div>
              <div>
                <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 3px;">Phone Number</label>
                <input type="text" value="${this.escapeHtml(currentV.phone || '')}" class="form-input" style="width: 100%; font-size: 12px; padding: 6px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;" onchange="window.procurementEngine.updateCurrentVendorField('phone', this.value)">
              </div>
            </div>
          </div>

          <!-- Product Catalog Section -->
          <div style="background: rgba(30, 41, 59, 0.5); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px; flex: 1; display: flex; flex-direction: column; overflow: hidden;">
            <!-- Header & Search Row -->
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <div style="font-weight: 700; font-size: 13.5px; color: #93c5fd;">📦 Product Catalog & Pricing</div>
                <span id="vendor-catalog-total-badge" class="badge" style="background: rgba(59, 130, 246, 0.18); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35); font-size: 11px; padding: 2px 8px; border-radius: 10px;">${(currentV.items || []).length} items</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <div style="position: relative;">
                  <input type="text" id="vendor-catalog-search-input" value="${this.escapeHtml(this.catalogSearchQuery || '')}" placeholder="🔍 Search item or part #..." style="width: 210px; font-size: 12px; padding: 5px 24px 5px 10px; background: rgba(15, 23, 42, 0.75); border: 1px solid var(--border-color); border-radius: 6px; color: #fff;" oninput="window.procurementEngine.onCatalogSearchInput(this.value)">
                  ${this.catalogSearchQuery ? `<span style="position: absolute; right: 7px; top: 50%; transform: translateY(-50%); cursor: pointer; font-size: 11px; color: #94a3b8;" onclick="window.procurementEngine.onCatalogSearchInput('', true)" title="Clear search">✕</span>` : ''}
                </div>
                <button id="btn-add-catalog-item" class="btn btn-primary" style="font-size: 11.5px; font-weight: 700; padding: 5px 12px; display: inline-flex; align-items: center; gap: 5px;" onclick="window.procurementEngine.addCatalogItem()">➕ Add Item</button>
              </div>
            </div>

            <!-- Category Tabs Bar -->
            <div id="vendor-catalog-tabs-bar" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-bottom: 10px; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.08);">
              <!-- Populated by renderVendorCatalogSection() -->
            </div>

            <!-- Scrollable Catalog Table Container -->
            <div id="vendor-catalog-table-container" style="flex: 1; max-height: 410px; min-height: 300px; overflow-y: auto; padding-right: 2px;">
              <!-- Populated by renderVendorCatalogSection() -->
            </div>
          </div>
        </div>
      </div>
    `;

    body.innerHTML = html;
    this.renderVendorCatalogSection();
  }

  renderVendorCatalogSection() {
    const currentV = this.vendors[this.activeModalVendorIdx] || this.vendors[0];
    if (!currentV) return;
    if (!currentV.items) currentV.items = [];

    // Ensure every item has a resolved category
    currentV.items.forEach(it => {
      if (!it.category) {
        it.category = this.inferCatalogItemCategory(it.item, it.itemNumber);
      }
    });

    // Update vendor sidebar count & header badge
    const totalBadge = document.getElementById('vendor-catalog-total-badge');
    if (totalBadge) totalBadge.textContent = `${currentV.items.length} item${currentV.items.length === 1 ? '' : 's'}`;
    const cardCount = document.getElementById(`vendor-card-count-${this.activeModalVendorIdx}`);
    if (cardCount) cardCount.textContent = `${currentV.items.length} catalog items`;

    // Update Add Item button text based on active tab
    const addBtn = document.getElementById('btn-add-catalog-item');
    if (addBtn) {
      const activeCatMeta = this.CATALOG_CATEGORIES.find(c => c.key === this.activeCatalogCategoryTab);
      if (activeCatMeta && activeCatMeta.key !== 'all') {
        addBtn.innerHTML = `➕ Add ${this.escapeHtml(activeCatMeta.label)} Item`;
      } else {
        addBtn.innerHTML = `➕ Add Item`;
      }
    }

    // Compute counts per category
    const counts = { all: currentV.items.length };
    this.CATALOG_CATEGORIES.forEach(c => {
      if (c.key !== 'all') counts[c.key] = 0;
    });
    currentV.items.forEach(it => {
      const cat = it.category || 'Other';
      counts[cat] = (counts[cat] || 0) + 1;
      const isTestingItem = cat === 'Testing' || /\b(?:testing|retest|recertification|dielectric|labor)\b/i.test(it.item || '') || /\b(?:testing|labor)\b/i.test(it.itemNumber || '');
      if (isTestingItem && cat !== 'Testing') {
        counts['Testing'] = (counts['Testing'] || 0) + 1;
      }
    });

    // Render Category Tabs Bar
    const tabsBar = document.getElementById('vendor-catalog-tabs-bar');
    if (tabsBar) {
      tabsBar.innerHTML = this.CATALOG_CATEGORIES.map(cat => {
        const count = counts[cat.key] || 0;
        const isActive = this.activeCatalogCategoryTab === cat.key;
        const hasItems = count > 0 || cat.key === 'all';
        const bg = isActive
          ? 'rgba(59, 130, 246, 0.25)'
          : (hasItems ? 'rgba(15, 23, 42, 0.65)' : 'rgba(15, 23, 42, 0.35)');
        const border = isActive
          ? `1px solid ${cat.color || '#3b82f6'}`
          : '1px solid rgba(148, 163, 184, 0.2)';
        const textColor = isActive
          ? '#ffffff'
          : (hasItems ? '#cbd5e1' : '#64748b');
        const badgeBg = isActive
          ? 'rgba(255, 255, 255, 0.2)'
          : (count > 0 ? 'rgba(59, 130, 246, 0.18)' : 'rgba(148, 163, 184, 0.1)');
        const badgeColor = isActive
          ? '#ffffff'
          : (count > 0 ? '#93c5fd' : '#64748b');

        return `
          <button type="button"
                  onclick="window.procurementEngine.setCatalogCategoryTab('${cat.key}')"
                  style="display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 6px; font-size: 11.5px; font-weight: ${isActive ? '700' : '600'}; background: ${bg}; border: ${border}; color: ${textColor}; cursor: pointer; transition: all 0.15s ease;">
            <span>${cat.icon}</span>
            <span>${this.escapeHtml(cat.label)}</span>
            <span style="background: ${badgeBg}; color: ${badgeColor}; font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 999px; margin-left: 2px;">${count}</span>
          </button>
        `;
      }).join('');
    }

    // Filter items by active tab and search query
    const query = (this.catalogSearchQuery || '').trim().toLowerCase();
    const indexedItems = currentV.items.map((it, iIdx) => ({ it, iIdx })).filter(({ it }) => {
      if (this.activeCatalogCategoryTab !== 'all') {
        const cat = it.category || 'Other';
        if (this.activeCatalogCategoryTab === 'Testing') {
          const isTestingItem = cat === 'Testing' || /\b(?:testing|retest|recertification|dielectric|labor)\b/i.test(it.item || '') || /\b(?:testing|labor)\b/i.test(it.itemNumber || '');
          if (!isTestingItem) return false;
        } else if (cat !== this.activeCatalogCategoryTab) {
          return false;
        }
      }
      if (query) {
        const hay = `${it.item || ''} ${it.itemNumber || ''} ${it.category || ''}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    const tableContainer = document.getElementById('vendor-catalog-table-container');
    if (!tableContainer) return;

    const categorySelectOptions = (selectedCat) => {
      return this.CATALOG_CATEGORIES.filter(c => c.key !== 'all').map(c => `
        <option value="${c.key}" ${selectedCat === c.key ? 'selected' : ''}>${c.icon} ${this.escapeHtml(c.label)}</option>
      `).join('');
    };

    const renderItemRow = ({ it, iIdx }) => {
      const catMeta = this.CATALOG_CATEGORIES.find(c => c.key === (it.category || 'Other')) || this.CATALOG_CATEGORIES[this.CATALOG_CATEGORIES.length - 1];
      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 5px 6px;">
            <input type="text" id="catalog-item-desc-${iIdx}" value="${this.escapeHtml(it.item || '')}" placeholder="${this.escapeHtml(catMeta.placeholder || 'e.g. Class 2 Glove')}" style="width: 100%; font-size: 12px; padding: 5px 8px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;" onchange="window.procurementEngine.updateCatalogItem(${iIdx}, 'item', this.value)">
          </td>
          <td style="padding: 5px 6px;">
            <select style="width: 100%; font-size: 11.5px; padding: 5px 6px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; color: #cbd5e1;" onchange="window.procurementEngine.updateCatalogItemCategory(${iIdx}, this.value)" title="Item Type / Category Tab">
              ${categorySelectOptions(it.category || 'Other')}
            </select>
          </td>
          <td style="padding: 5px 6px;">
            <input type="text" value="${this.escapeHtml(it.itemNumber || '')}" placeholder="e.g. C600-2616" style="width: 100%; font-size: 12px; font-family: monospace; padding: 5px 8px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; color: #fcd34d;" onchange="window.procurementEngine.updateCatalogItem(${iIdx}, 'itemNumber', this.value)">
          </td>
          <td style="padding: 5px 6px; text-align: right;">
            <input type="number" step="0.01" min="0" value="${it.price || 0}" style="width: 95px; text-align: right; font-size: 12px; font-weight: 600; padding: 5px 8px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; color: #4ade80;" onchange="window.procurementEngine.updateCatalogItem(${iIdx}, 'price', parseFloat(this.value)||0)">
          </td>
          <td style="padding: 5px 6px; text-align: center;">
            <button class="btn btn-secondary" style="padding: 3px 6px; font-size: 11px; color: #f87171;" title="Delete Item" onclick="window.procurementEngine.deleteCatalogItem(${iIdx})">✕</button>
          </td>
        </tr>
      `;
    };

    let tbodyHtml = '';
    if (indexedItems.length === 0) {
      const activeCatMeta = this.CATALOG_CATEGORIES.find(c => c.key === this.activeCatalogCategoryTab);
      const emptyMsg = query
        ? `No catalog items matching "${this.escapeHtml(this.catalogSearchQuery)}".`
        : (activeCatMeta && activeCatMeta.key !== 'all'
            ? `No items in <strong>${activeCatMeta.icon} ${this.escapeHtml(activeCatMeta.label)}</strong> yet. Click <strong>"➕ Add ${this.escapeHtml(activeCatMeta.label)} Item"</strong> above to add one.`
            : `No catalog items. Click "➕ Add Item" to add pricing.`);
      tbodyHtml = `<tr><td colspan="5" style="text-align: center; padding: 28px 16px; color: var(--text-muted); font-size: 12.5px;">${emptyMsg}</td></tr>`;
    } else if (this.activeCatalogCategoryTab === 'all' && !query) {
      // Group by category in All Items view so the catalog is cleanly organized by equipment type
      this.CATALOG_CATEGORIES.filter(c => c.key !== 'all').forEach(catMeta => {
        const group = indexedItems.filter(entry => (entry.it.category || 'Other') === catMeta.key);
        if (group.length === 0) return;
        tbodyHtml += `
          <tr style="background: rgba(15, 23, 42, 0.85); border-top: 1px solid rgba(255,255,255,0.08); border-bottom: 1px solid rgba(255,255,255,0.08);">
            <td colspan="5" style="padding: 6px 10px;">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <span style="font-weight: 700; font-size: 11.5px; color: ${catMeta.color}; letter-spacing: 0.3px;">
                  ${catMeta.icon} ${this.escapeHtml(catMeta.label)} <span style="opacity: 0.75; font-weight: 600; margin-left: 4px;">(${group.length})</span>
                </span>
                <button type="button" class="btn btn-xs" style="padding: 1px 8px; font-size: 10.5px; background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.3); color: #93c5fd; cursor: pointer; border-radius: 4px;" onclick="window.procurementEngine.addCatalogItem('${catMeta.key}')">+ Add ${this.escapeHtml(catMeta.label)}</button>
              </div>
            </td>
          </tr>
        `;
        tbodyHtml += group.map(renderItemRow).join('');
      });
    } else {
      tbodyHtml = indexedItems.map(renderItemRow).join('');
    }

    tableContainer.innerHTML = `
      <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead style="position: sticky; top: 0; background: #1e293b; z-index: 2;">
          <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-muted); text-align: left;">
            <th style="padding: 6px 8px;">Item Description</th>
            <th style="padding: 6px 8px; width: 155px;">Type / Category</th>
            <th style="padding: 6px 8px; width: 150px;">Part / Item #</th>
            <th style="padding: 6px 8px; width: 105px; text-align: right;">Unit Price ($)</th>
            <th style="padding: 6px; width: 38px;"></th>
          </tr>
        </thead>
        <tbody>
          ${tbodyHtml}
        </tbody>
      </table>
    `;
  }

  setCatalogCategoryTab(tabKey) {
    this.activeCatalogCategoryTab = tabKey || 'all';
    this.renderVendorCatalogSection();
  }

  onCatalogSearchInput(val, clearInput = false) {
    this.catalogSearchQuery = val || '';
    if (clearInput) {
      const inp = document.getElementById('vendor-catalog-search-input');
      if (inp) {
        inp.value = '';
        inp.focus();
      }
    }
    this.renderVendorCatalogSection();
  }

  selectModalVendor(idx) {
    this.activeModalVendorIdx = idx;
    this.activeCatalogCategoryTab = 'all';
    this.catalogSearchQuery = '';
    this.renderVendorModal();
  }

  addVendor() {
    const newName = prompt('Enter new vendor name:');
    if (!newName || !newName.trim()) return;
    this.vendors.push({
      name: newName.trim(),
      contact: '',
      email: '',
      phone: '',
      notes: '',
      items: [
        { item: 'Class 0 Glove', itemNumber: '', price: 0, category: 'Gloves' },
        { item: 'Class 2 Glove', itemNumber: '', price: 0, category: 'Gloves' },
        { item: 'Class 2 Sleeve', itemNumber: '', price: 0, category: 'Sleeves' },
        { item: 'Class 4 Blanket', itemNumber: '', price: 0, category: 'Blankets' }
      ]
    });
    this.activeModalVendorIdx = this.vendors.length - 1;
    this.activeCatalogCategoryTab = 'all';
    this.renderVendorModal();
  }

  deleteVendor(idx) {
    const v = this.vendors[idx];
    if (!v) return;
    if (confirm(`Are you sure you want to delete vendor "${v.name}"?`)) {
      this.vendors.splice(idx, 1);
      if (this.selectedVendor && this.selectedVendor.name === v.name) {
        this.selectedVendor = null;
      }
      if (this.activeModalVendorIdx >= this.vendors.length) {
        this.activeModalVendorIdx = Math.max(0, this.vendors.length - 1);
      }
      this.renderVendorModal();
    }
  }

  updateCurrentVendorField(field, val) {
    const currentV = this.vendors[this.activeModalVendorIdx];
    if (currentV) {
      currentV[field] = val;
    }
  }

  addCatalogItem(targetCategory = null) {
    const currentV = this.vendors[this.activeModalVendorIdx];
    if (!currentV) return;
    if (!currentV.items) currentV.items = [];

    // Clear active search filter so the newly added blank item row is visible in the DOM
    if (this.catalogSearchQuery) {
      this.catalogSearchQuery = '';
      const searchInp = document.getElementById('vendor-catalog-search-input');
      if (searchInp) searchInp.value = '';
    }

    const catToUse = targetCategory || ((this.activeCatalogCategoryTab && this.activeCatalogCategoryTab !== 'all') ? this.activeCatalogCategoryTab : 'Other');
    const newIdx = currentV.items.length;
    currentV.items.push({
      item: '',
      itemNumber: '',
      price: 0,
      category: catToUse,
      _manualCategory: catToUse !== 'Other'
    });

    if (targetCategory && this.activeCatalogCategoryTab !== 'all' && this.activeCatalogCategoryTab !== targetCategory) {
      this.activeCatalogCategoryTab = targetCategory;
    }

    this.renderVendorCatalogSection();

    setTimeout(() => {
      const descInput = document.getElementById(`catalog-item-desc-${newIdx}`);
      if (descInput) {
        descInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        descInput.focus();
      }
    }, 30);
  }

  deleteCatalogItem(iIdx) {
    const currentV = this.vendors[this.activeModalVendorIdx];
    if (!currentV || !currentV.items) return;
    currentV.items.splice(iIdx, 1);
    this.renderVendorCatalogSection();
  }

  updateCatalogItem(iIdx, field, val) {
    const currentV = this.vendors[this.activeModalVendorIdx];
    if (currentV && currentV.items && currentV.items[iIdx]) {
      const itemObj = currentV.items[iIdx];
      itemObj[field] = val;
      // If category wasn't manually locked, update inferred category silently without tearing down DOM focus mid-typing
      if ((field === 'item' || field === 'itemNumber') && !itemObj._manualCategory) {
        const inferred = this.inferCatalogItemCategory(itemObj.item, itemObj.itemNumber);
        if (inferred !== itemObj.category) {
          itemObj.category = inferred;
        }
      }
    }
  }

  updateCatalogItemCategory(iIdx, newCategory) {
    const currentV = this.vendors[this.activeModalVendorIdx];
    if (currentV && currentV.items && currentV.items[iIdx]) {
      currentV.items[iIdx].category = newCategory;
      currentV.items[iIdx]._manualCategory = true;
      this.renderVendorCatalogSection();
    }
  }

  async saveVendorsToDB(silent = false) {
    const blankVendor = (this.vendors || []).find(v => !String(v.name || '').trim());
    if (blankVendor) {
      if (!silent) alert('⚠️ Vendor Name cannot be empty. Please enter a name for all vendors before saving.');
      return;
    }
    const saveBtn = document.getElementById('btn-save-vendors');
    if (saveBtn && !silent) saveBtn.textContent = '⏳ Saving...';

    try {
      const headers = ['Vendor Name', 'Contact Name', 'Email', 'Phone', 'Notes', 'Item', 'Item Number', 'Price', 'Category'];
      const rows = [];
      const rawGrid = [headers];

      this.vendors.forEach(v => {
        const validItems = (v.items || []).filter(it => (it.item && it.item.trim()) || (it.itemNumber && it.itemNumber.trim()) || (it.price > 0));
        if (validItems.length > 0) {
          validItems.forEach(it => {
            const itemDesc = (it.item || '').trim() || 'Catalog Item';
            const cat = it.category || this.inferCatalogItemCategory(itemDesc, it.itemNumber);
            const rowObj = {
              'Vendor Name': v.name,
              'Contact Name': v.contact,
              'Email': v.email,
              'Phone': v.phone,
              'Notes': v.notes,
              'Item': itemDesc,
              'Item Number': it.itemNumber || '',
              'Price': it.price || 0,
              'Category': cat
            };
            rows.push(rowObj);
            rawGrid.push([v.name, v.contact, v.email, v.phone, v.notes, itemDesc, it.itemNumber || '', it.price || 0, cat]);
          });
        } else {
          const rowObj = {
            'Vendor Name': v.name,
            'Contact Name': v.contact,
            'Email': v.email,
            'Phone': v.phone,
            'Notes': v.notes,
            'Item': '',
            'Item Number': '',
            'Price': 0,
            'Category': ''
          };
          rows.push(rowObj);
          rawGrid.push([v.name, v.contact, v.email, v.phone, v.notes, '', '', 0, '']);
        }
      });

      const vTable = {
        name: 'Vendors',
        headers: headers,
        rows: rows,
        rawGrid: rawGrid,
        rowCount: rows.length,
        maxRows: rows.length + 1,
        maxCols: 9
      };

      await this.db.saveTable('vendors', vTable);

      this.updatePricing();
      this.render();
      if (!silent) {
        this.closeManageVendorsModal(true);
        alert('✅ Vendor catalog saved successfully! Click "Sync & Save" at the top whenever you wish to sync changes to the cloud.');
      }
    } catch (err) {
      console.error('Error saving vendor catalog:', err);
      if (!silent) {
        alert('❌ Failed to save vendor changes: ' + (err.message || err));
      }
    } finally {
      if (saveBtn && !silent) saveBtn.innerHTML = '<span>💾</span> Save Vendor Changes';
    }
  }

  // =========================================================================
  // MARK AS ORDERED MODAL & WORKFLOW
  // =========================================================================

  /**
   * Consolidates items by itemType, normalized size, and class.
   * Groups duplicate requirements across sections into a single line item with combined quantity.
   */
  consolidateItemsBySizeAndClass(itemsList) {
    if (!itemsList || !itemsList.length) return [];

    const cleanSize = (sizeVal, hasNoSize) => {
      if (hasNoSize) return '⚠️ Needs Size';
      if (!sizeVal) return 'Standard';
      let s = String(sizeVal).trim();
      s = s.replace(/\s*\(\s*Class\s*[^)]*\)/i, '').trim();
      return s || 'Standard';
    };

    const cleanClass = (classVal) => {
      if (!classVal) return 'Class 2';
      let c = String(classVal).trim();
      return /^class\b/i.test(c) ? c : `Class ${c}`;
    };

    const consolidatedMap = new Map();
    itemsList.forEach(item => {
      // Skip if item is explicitly unselected or quantity is 0
      if (item.selected === false || item.quantity === 0) return;

      const type = (item.itemType || 'Equipment').trim();
      const normSize = cleanSize(item.size, item.hasNoSize);
      const normClass = cleanClass(item.classVal);
      const groupKey = `${type.toLowerCase()}|${normSize.toLowerCase()}|${normClass.toLowerCase()}`;

      let itemEmps = [];
      if (item.employees && item.employees.length > 0) {
        // Only include employees who are explicitly checked!
        itemEmps = item.employees.filter(e => e.checked === true);
        if (itemEmps.length === 0) {
          // User unchecked all employees for this item - skip completely!
          return;
        }
      }

      const manualQty = parseInt(item.quantity, 10) || 0;
      const qty = itemEmps.length > 0 ? Math.max(itemEmps.length, manualQty) : manualQty;
      if (qty <= 0) return;

      const rawPrice = parseFloat(item.price) || 0;
      const safePrice = (/glove|sleeve/i.test(type) && rawPrice > 350) ? 0 : rawPrice;

      if (consolidatedMap.has(groupKey)) {
        const existing = consolidatedMap.get(groupKey);
        existing.quantity += qty;

        itemEmps.forEach(emp => {
          if (!existing.employees.some(e => this.isNameMatch(e.name, emp.name))) {
            existing.employees.push({ ...emp, checked: true });
          }
        });

        if (safePrice > existing.price) {
          existing.price = safePrice;
        }
        if (item.partNumber && !existing.partNumber) {
          existing.partNumber = item.partNumber;
        }
      } else {
        consolidatedMap.set(groupKey, {
          ...item,
          size: normSize,
          classVal: normClass,
          quantity: qty,
          price: safePrice,
          employees: itemEmps.map(e => ({ ...e, checked: true }))
        });
      }
    });

    return Array.from(consolidatedMap.values());
  }

  openMarkOrderedModal(itemsToOrder = null) {
    if (!this.vendors || !this.vendors.length) this.loadVendors();
    let items = itemsToOrder;
    if (items === null) {
      items = (this.items || []).filter(i => i.selected && i.quantity > 0 && i.section !== 'ordered_pending');
    }
    if (!items) items = [];

    const consolidatedItems = items.length ? this.consolidateItemsBySizeAndClass(items) : [];
    this.pendingMarkOrderedItems = consolidatedItems;
    const modal = document.getElementById('mark-ordered-modal');
    const body = document.getElementById('mark-ordered-modal-body');
    if (!modal || !body) return;

    const today = new Date();
    const todayYmd = today.toISOString().split('T')[0];
    const defaultDelivery = new Date(today.getTime() + 14 * 86400000).toISOString().split('T')[0];

    const currentVendorName = this.selectedVendor ? this.selectedVendor.name : (this.vendors[0]?.name || '');

    let vendorOptions = this.vendors.map(v => `<option value="${this.escapeHtml(v.name)}" ${v.name === currentVendorName ? 'selected' : ''}>${this.escapeHtml(v.name)}</option>`).join('');
    vendorOptions += '<option value="__custom__">➕ New / Custom Vendor...</option>';

    // Build active employees list for line item assignment dropdown
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    const empTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employees') : null) || snap?.tables?.['employees'];
    const activeEmployees = [];
    if (empTable && empTable.rows) {
      for (const er of empTable.rows) {
        const name = String(er['Name'] || er['Employee'] || Object.values(er)[0] || '').trim();
        const stat = String(er['Status'] || er['Employment Status'] || '').toLowerCase();
        if (name && !stat.includes('inactive') && !stat.includes('term') && !stat.includes('prev')) {
          activeEmployees.push(name);
        }
      }
    }
    activeEmployees.sort();

    let empOptions = `<option value="On Shelf" selected>📦 On Shelf (Stock / Spare)</option>`;
    for (const name of activeEmployees) {
      empOptions += `<option value="${this.escapeHtml(name)}">👤 ${this.escapeHtml(name)}</option>`;
    }

    body.innerHTML = `
      <div style="margin-bottom: 18px; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 8px; padding: 14px 18px;">
        <div style="font-weight: 700; font-size: 14px; color: #34d399; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
          <span>📦</span> Order Information
        </div>
        <div style="font-size: 12px; color: #cbd5e1;">
          Items marked as Ordered will remain on the Purchase Needs page under <strong>"Ordered — Awaiting Delivery"</strong> and will display an <strong>"Ordered"</strong> status badge on the PPE Tracker until delivered into inventory.
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
            <label style="font-size: 12px; font-weight: 600; color: #94a3b8;">Order # / PO Request #</label>
            <button type="button" class="btn btn-xs" onclick="window.procurementEngine.fillNextMarkOrderPoNumber()" style="padding: 1px 6px; font-size: 10px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: #6ee7b7; cursor: pointer;" title="Auto-generate new Request #">
              ⚡ Generate Request #
            </button>
          </div>
          <input type="text" id="mark-order-po-num" class="batch-delivery-input" value="${this.escapeHtml(this.generateNextRequestPoNumber())}" placeholder="e.g. 0819764 or REQ-..." style="font-weight: 700; color: #38bdf8; pointer-events: auto !important; user-select: text !important; -webkit-user-select: text !important; cursor: text; width: 100%;">
          <div style="font-size: 11px; color: #64748b; margin-top: 2px;">Pre-filled with Request #. Update with vendor's Order # now or anytime later.</div>
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Vendor *</label>
          <select id="mark-order-vendor-select" class="batch-delivery-input" onchange="window.procurementEngine.onMarkOrderVendorChange(this.value)">
            ${vendorOptions}
          </select>
          <input type="text" id="mark-order-custom-vendor" class="batch-delivery-input" placeholder="Enter vendor name..." style="display: none; margin-top: 6px;">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Order Date *</label>
          <input type="date" id="mark-order-date" class="batch-delivery-input" value="${todayYmd}">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Expected Delivery Date</label>
          <input type="date" id="mark-order-delivery-date" class="batch-delivery-input" value="${defaultDelivery}">
        </div>
      </div>

      <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
        <span id="mark-order-items-count-heading" style="font-size: 12.5px; font-weight: 700; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px;">Items in this Order</span>
        <span style="font-size: 11.5px; color: #64748b;">Prices entered will auto-update vendor catalog</span>
      </div>

      <div style="overflow-x: auto; border: 1px solid var(--border-color); border-radius: 6px; margin-bottom: 14px;">
        <table id="mark-ordered-items-table" style="width: 100%; border-collapse: collapse; font-size: 12.5px;">
          <thead>
            <tr style="background: rgba(30, 41, 59, 0.85); border-bottom: 2px solid var(--border-color); text-align: left; color: #94a3b8; font-size: 11px; text-transform: uppercase;">
              <th style="padding: 8px 10px;">Item / Equipment</th>
              <th style="padding: 8px 10px; text-align: center; width: 90px;">Size</th>
              <th style="padding: 8px 10px; text-align: center; width: 85px;">Class</th>
              <th style="padding: 8px 10px; text-align: center; width: 70px;">Qty</th>
              <th style="padding: 8px 10px; text-align: right; width: 105px;">Unit Price</th>
              <th style="padding: 8px 10px; text-align: right; width: 95px;">Subtotal</th>
              <th style="padding: 8px 10px;">Assigned Linemen</th>
              <th style="padding: 8px 6px; text-align: center; width: 45px;"></th>
            </tr>
          </thead>
          <tbody id="mark-ordered-tbody">
          </tbody>
        </table>
      </div>

      <!-- Add Line Item Builder Section -->
      <div style="background: rgba(30, 41, 59, 0.7); border: 1px dashed rgba(16, 185, 129, 0.45); border-radius: 6px; padding: 12px 14px; margin-bottom: 16px;">
        <div style="font-weight: 700; font-size: 12.5px; color: #34d399; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
          <span>➕</span> Add Item to this Order
        </div>
        <div style="display: grid; grid-template-columns: 1.3fr 1fr 1fr 0.8fr 1fr; gap: 10px; margin-bottom: 8px;">
          <div>
            <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Item Type</label>
            <select id="mo-add-item-cat" class="batch-delivery-input" onchange="window.procurementEngine.onMoAddItemCatChange(this.value)">
              <option value="Gloves" selected>🧤 Rubber Gloves</option>
              <option value="Sleeves">🦺 Rubber Sleeves</option>
              <option value="Blankets">🧱 Blankets</option>
              <option value="Testing">🧪 Labor & Testing</option>
              <option value="MACKs">🧱 MACKs</option>
              <option value="HV Testers">⚡ HV Testers</option>
              <option value="Phasing Sets">⚡ Phasing Sets</option>
              <option value="Grounds">⚡ Grounds</option>
              <option value="Hot Sticks">🔴 Hot Sticks</option>
              <option value="AED">🏥 AED Units / Pads</option>
              <option value="Other">📦 Other / Equipment</option>
            </select>
          </div>
          <div>
            <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Class / Voltage</label>
            <select id="mo-add-item-class" class="batch-delivery-input" onchange="window.procurementEngine.onMoAddItemChange(true)">
              <option value="Class 0">Class 0</option>
              <option value="Class 2" selected>Class 2</option>
              <option value="Class 3">Class 3</option>
              <option value="Class 4">Class 4</option>
              <option value="N/A">N/A</option>
            </select>
          </div>
          <div>
            <label id="mo-add-item-size-label" style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Size / Item</label>
            <input type="text" id="mo-add-item-size" list="mo-item-size-suggestions" class="batch-delivery-input" placeholder="e.g. 8.5" value="8.5" style="text-align: center; font-weight: 600;" onchange="window.procurementEngine.onMoAddItemChange(true)" oninput="window.procurementEngine.onMoAddItemChange(true)">
            <datalist id="mo-item-size-suggestions">
              <option value="8"></option>
              <option value="8.5"></option>
              <option value="9"></option>
              <option value="9.5"></option>
              <option value="10"></option>
              <option value="10.5"></option>
              <option value="11"></option>
              <option value="11.5"></option>
              <option value="12"></option>
            </datalist>
          </div>
          <div>
            <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Quantity</label>
            <input type="number" min="1" step="1" id="mo-add-item-qty" class="batch-delivery-input" value="1" style="text-align: center; font-weight: 600;">
          </div>
          <div>
            <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Unit Price ($)</label>
            <input type="number" min="0" step="0.01" id="mo-add-item-price" class="batch-delivery-input" placeholder="0.00" style="text-align: right; font-weight: 600; color: #34d399;">
          </div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-top: 6px;">
          <div style="flex: 1;">
            <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">👤 Ordered For (Lineman / Shelf Stock)</label>
            <select id="mo-add-item-assignee" class="batch-delivery-input" style="font-weight: 600;">
              ${empOptions}
            </select>
          </div>
          <div>
            <button type="button" class="btn btn-primary" onclick="window.procurementEngine.addCustomItemToMarkOrderedModal()" style="padding: 7px 16px; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; background: #10b981; border: none; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);">
              <span>➕</span> Add Item to Order
            </button>
          </div>
        </div>
      </div>

      <div style="display: flex; justify-content: flex-end; align-items: center; gap: 14px; padding: 12px 16px; background: rgba(15, 23, 42, 0.6); border-radius: 6px; border: 1px solid var(--border-color);">
        <span style="font-size: 13px; color: #94a3b8; font-weight: 600;">Estimated Order Total:</span>
        <span id="mark-order-grand-total" style="font-size: 20px; font-weight: 800; color: #34d399; font-family: monospace;">
          $0.00
        </span>
      </div>
    `;

    this.renderMarkOrderedTableRows();
    this.recalcMarkOrderedModal();
    this.onMoAddItemChange(true);

    modal.style.display = 'flex';
    modal.classList.add('active');
  }

  renderMarkOrderedTableRows() {
    const tbody = document.getElementById('mark-ordered-tbody');
    if (!tbody) return;

    if (!this.pendingMarkOrderedItems || this.pendingMarkOrderedItems.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="padding: 24px 14px; text-align: center; color: #94a3b8; font-size: 12.5px; background: rgba(15, 23, 42, 0.4);">
            <div style="font-size: 24px; margin-bottom: 6px;">📦</div>
            <div style="font-weight: 600; color: #cbd5e1;">No items in this order yet</div>
            <div style="font-size: 11.5px; color: #64748b; margin-top: 2px;">Use the form below to add line items to this order.</div>
          </td>
        </tr>
      `;
      return;
    }

    const vSelect = document.getElementById('mark-order-vendor-select');
    const vendorName = (vSelect && vSelect.value && vSelect.value !== '__custom__') ? vSelect.value : '';

    let rowsHtml = '';
    this.pendingMarkOrderedItems.forEach((item, idx) => {
      const catalogPrice = vendorName ? this.getVendorPrice(vendorName, item.itemType, item.size, item.classVal) : 0;
      const unitPrice = item.price > 0 ? item.price : (catalogPrice > 0 ? catalogPrice : 0);
      const qty = parseInt(item.quantity, 10) || 1;
      const subtotal = unitPrice * qty;

      let empDisplay = '';
      if (item.employees && item.employees.length > 0) {
        const checked = item.employees.filter(e => e.checked && e.name && !e.name.toLowerCase().includes('shelf') && !e.name.toLowerCase().includes('stock'));
        if (checked.length > 0) {
          empDisplay = checked.map(e => e.name).join(', ');
        }
      }
      if (!empDisplay && item.employeeName && !item.employeeName.toLowerCase().includes('shelf') && !item.employeeName.toLowerCase().includes('stock')) {
        empDisplay = item.employeeName;
      }

      const isShelf = !empDisplay;
      const empBadge = isShelf
        ? `<span class="badge" style="background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.3); font-size: 11px;">📦 On Shelf</span>`
        : `<span class="badge" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35); font-size: 11px;" title="${this.escapeHtml(empDisplay)}">👤 ${this.escapeHtml(empDisplay)}</span>`;

      const isTesting = item.itemType === 'Testing' || item.category === 'Testing' || /\b(?:testing|labor)\b/i.test(item.itemType || '') || /\b(?:testing|labor)\b/i.test(item.typeLabel || '') || /\b(?:testing|labor)\b/i.test(item.size || '');
      const typeDisplay = isTesting
        ? `<span style="color: #6ee7b7; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;"><span>🧪</span> ${this.escapeHtml(item.typeLabel || item.size || 'Testing & Labor')}</span>`
        : this.escapeHtml(item.typeLabel || item.itemType || 'Equipment');
      const classDisplay = isTesting ? `<span style="color: #64748b;">N/A</span>` : this.escapeHtml(item.classVal || 'Class 2');

      rowsHtml += `
        <tr class="mark-ordered-item-row" data-idx="${idx}">
          <td style="padding: 8px 10px; font-weight: 600; color: #f1f5f9;">
            ${typeDisplay}
          </td>
          <td style="padding: 8px 10px; text-align: center;">
            <input type="text" class="mark-ordered-size-input batch-delivery-input" value="${this.escapeHtml(item.size || 'Standard')}" style="width: ${isTesting ? '120px' : '80px'}; text-align: center;" onchange="window.procurementEngine.onMarkOrderRowSizeChange(${idx}, this.value)">
          </td>
          <td style="padding: 8px 10px; text-align: center; color: #94a3b8;">
            ${classDisplay}
          </td>
          <td style="padding: 8px 10px; text-align: center;">
            <input type="number" min="1" class="mark-ordered-qty-input batch-delivery-input" value="${qty}" style="width: 60px; text-align: center;" onchange="window.procurementEngine.recalcMarkOrderedModal()">
          </td>
          <td style="padding: 8px 10px; text-align: right;">
            <div style="display: flex; align-items: center; justify-content: flex-end; gap: 4px;">
              <span style="color: #64748b;">$</span>
              <input type="number" step="0.01" min="0" class="mark-ordered-price-input batch-delivery-input" value="${unitPrice > 0 ? unitPrice.toFixed(2) : ''}" placeholder="0.00" style="width: 85px; text-align: right;" onchange="window.procurementEngine.recalcMarkOrderedModal()">
            </div>
          </td>
          <td style="padding: 8px 10px; text-align: right; font-weight: 700; color: #34d399;" class="mark-ordered-subtotal">
            $${subtotal.toFixed(2)}
          </td>
          <td style="padding: 8px 10px; font-size: 11.5px; color: #cbd5e1;">
            ${empBadge}
          </td>
          <td style="padding: 8px 6px; text-align: center;">
            <button type="button" class="btn btn-xs" onclick="window.procurementEngine.removeMarkOrderedItem(${idx})" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #f87171; padding: 3px 6px; font-size: 11px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;" title="Remove this line from order">
              🗑️
            </button>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = rowsHtml;
  }

  /**
   * Recalculates line-item subtotals, unit/line counts, and the Estimated Order Total
   * inside the Create Order / Mark Ordered modal.
   */
  recalcMarkOrderedModal() {
    let grandTotal = 0;
    let totalUnits = 0;
    let lineCount = 0;

    const rows = document.querySelectorAll('.mark-ordered-item-row');
    rows.forEach(r => {
      lineCount += 1;
      const idx = parseInt(r.getAttribute('data-idx'), 10);
      const qtyInput = r.querySelector('.mark-ordered-qty-input');
      const priceInput = r.querySelector('.mark-ordered-price-input');
      const subtotalEl = r.querySelector('.mark-ordered-subtotal');

      const qty = Math.max(1, parseInt(qtyInput?.value, 10) || 1);
      const unitPrice = Math.max(0, parseFloat(priceInput?.value) || 0);
      const subtotal = qty * unitPrice;

      grandTotal += subtotal;
      totalUnits += qty;

      if (!isNaN(idx) && this.pendingMarkOrderedItems && this.pendingMarkOrderedItems[idx]) {
        this.pendingMarkOrderedItems[idx].quantity = qty;
        this.pendingMarkOrderedItems[idx].price = unitPrice;
      }
      if (subtotalEl) {
        subtotalEl.textContent = `$${subtotal.toFixed(2)}`;
      }
    });

    const heading = document.getElementById('mark-order-items-count-heading');
    if (heading) {
      heading.textContent = lineCount > 0
        ? `Items in this Order (${lineCount} ${lineCount === 1 ? 'line' : 'lines'}, ${totalUnits} ${totalUnits === 1 ? 'unit' : 'units'})`
        : 'Items in this Order';
    }

    const totalEl = document.getElementById('mark-order-grand-total');
    if (totalEl) {
      totalEl.textContent = `$${grandTotal.toFixed(2)}`;
    }
  }

  syncPendingMarkOrderedItemsFromDom() {
    if (!this.pendingMarkOrderedItems) return;
    const rows = document.querySelectorAll('.mark-ordered-item-row');
    rows.forEach(r => {
      const idx = parseInt(r.getAttribute('data-idx'), 10);
      if (isNaN(idx) || !this.pendingMarkOrderedItems[idx]) return;
      const sizeInput = r.querySelector('.mark-ordered-size-input');
      const qtyInput = r.querySelector('.mark-ordered-qty-input');
      const priceInput = r.querySelector('.mark-ordered-price-input');
      if (sizeInput) this.pendingMarkOrderedItems[idx].size = sizeInput.value.trim();
      if (qtyInput) this.pendingMarkOrderedItems[idx].quantity = Math.max(1, parseInt(qtyInput.value, 10) || 1);
      if (priceInput) this.pendingMarkOrderedItems[idx].price = Math.max(0, parseFloat(priceInput.value) || 0);
    });
  }

  removeMarkOrderedItem(idx) {
    this.syncPendingMarkOrderedItemsFromDom();
    if (!this.pendingMarkOrderedItems || !this.pendingMarkOrderedItems[idx]) return;
    this.pendingMarkOrderedItems.splice(idx, 1);
    this.renderMarkOrderedTableRows();
    this.recalcMarkOrderedModal();
  }

  onMoAddItemCatChange(cat) {
    const classSelect = document.getElementById('mo-add-item-class');
    const sizeInput = document.getElementById('mo-add-item-size');
    const datalist = document.getElementById('mo-item-size-suggestions');
    const sizeLabel = document.getElementById('mo-add-item-size-label');
    const vSelect = document.getElementById('mark-order-vendor-select');
    const vendorName = (vSelect && vSelect.value && vSelect.value !== '__custom__') ? vSelect.value : '';

    if (cat === 'Gloves') {
      if (sizeLabel) sizeLabel.textContent = 'Size / Item';
      if (classSelect) classSelect.value = 'Class 2';
      if (sizeInput) {
        sizeInput.value = '8.5';
        sizeInput.placeholder = 'e.g. 8.5';
      }
      const vItems = this.getVendorTestingItems(vendorName).filter(it => (it.item || '').toLowerCase().includes('glove'));
      let extraOpts = vItems.map(it => `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} — $${Number(it.price || 0).toFixed(2)}</option>`).join('');
      if (datalist) {
        datalist.innerHTML = `
          <option value="8"></option>
          <option value="8.5"></option>
          <option value="9"></option>
          <option value="9.5"></option>
          <option value="10"></option>
          <option value="10.5"></option>
          <option value="11"></option>
          <option value="11.5"></option>
          <option value="12"></option>
          ${extraOpts}
        `;
      }
    } else if (cat === 'Sleeves') {
      if (sizeLabel) sizeLabel.textContent = 'Size / Item';
      if (classSelect) classSelect.value = 'Class 2';
      if (sizeInput) {
        sizeInput.value = 'Regular';
        sizeInput.placeholder = 'e.g. Regular';
      }
      const vItems = this.getVendorTestingItems(vendorName).filter(it => (it.item || '').toLowerCase().includes('sleeve'));
      let extraOpts = vItems.map(it => `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} — $${Number(it.price || 0).toFixed(2)}</option>`).join('');
      if (datalist) {
        datalist.innerHTML = `
          <option value="Regular"></option>
          <option value="Large"></option>
          <option value="Extra Large"></option>
          ${extraOpts}
        `;
      }
    } else if (cat === 'Blankets') {
      if (sizeLabel) sizeLabel.textContent = 'Size / Item';
      if (classSelect) classSelect.value = 'Class 4';
      if (sizeInput) {
        sizeInput.value = 'Regular';
        sizeInput.placeholder = 'e.g. Regular';
      }
      const vItems = this.getVendorTestingItems(vendorName).filter(it => (it.item || '').toLowerCase().includes('blanket'));
      let extraOpts = vItems.map(it => `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} — $${Number(it.price || 0).toFixed(2)}</option>`).join('');
      if (datalist) {
        datalist.innerHTML = `
          <option value="Regular"></option>
          <option value="Split"></option>
          <option value="Eyelet"></option>
          <option value="Canister"></option>
          ${extraOpts}
        `;
      }
    } else if (cat === 'Testing') {
      if (sizeLabel) sizeLabel.textContent = 'Testing / Service Item';
      if (classSelect) classSelect.value = 'N/A';
      const testingItems = this.getVendorTestingItems(vendorName);
      if (datalist) {
        let opts = testingItems.map(it => 
          `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} ${it.price > 0 ? '— $' + Number(it.price).toFixed(2) : ''}${it.itemNumber ? ' (Part: ' + this.escapeHtml(it.itemNumber) + ')' : ''}</option>`
        ).join('');
        if (!opts.includes('Glove Testing')) opts += `<option value="Glove Testing">Glove Testing</option>`;
        if (!opts.includes('Sleeve Testing')) opts += `<option value="Sleeve Testing">Sleeve Testing</option>`;
        if (!opts.includes('Blanket Testing')) opts += `<option value="Blanket Testing">Blanket Testing</option>`;
        if (!opts.includes('Labor Testing')) opts += `<option value="Labor Testing">Labor Testing</option>`;
        if (!opts.includes('Dielectric Testing')) opts += `<option value="Dielectric Testing">Dielectric Testing</option>`;
        datalist.innerHTML = opts;
      }
      if (sizeInput) {
        sizeInput.value = (testingItems.length > 0 ? testingItems[0].item : 'Glove Testing');
        sizeInput.placeholder = 'Select or type testing service...';
      }
    } else if (cat === 'MACKs') {
      if (sizeLabel) sizeLabel.textContent = 'Size / Rating';
      if (classSelect) classSelect.value = 'Class 4';
      if (sizeInput) {
        sizeInput.value = 'Standard';
        sizeInput.placeholder = 'e.g. Standard';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="Standard"></option>
          <option value="15kV"></option>
          <option value="25kV"></option>
          <option value="35kV"></option>
        `;
      }
    } else if (cat === 'HV Testers' || cat === 'Phasing Sets') {
      if (sizeLabel) sizeLabel.textContent = 'Rating / Model';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = 'Standard';
        sizeInput.placeholder = 'e.g. Standard';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="Standard"></option>
          <option value="15kV"></option>
          <option value="25kV"></option>
          <option value="40kV"></option>
        `;
      }
    } else if (cat === 'Grounds') {
      if (sizeLabel) sizeLabel.textContent = 'Style / Type';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = 'Single';
        sizeInput.placeholder = 'e.g. Single';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="Single"></option>
          <option value="Cluster"></option>
          <option value="4-Way"></option>
          <option value="Overhead"></option>
          <option value="Underground"></option>
        `;
      }
    } else if (cat === 'Hot Sticks') {
      if (sizeLabel) sizeLabel.textContent = 'Length / Type';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = '8ft';
        sizeInput.placeholder = 'e.g. 8ft';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="6ft"></option>
          <option value="8ft"></option>
          <option value="10ft"></option>
          <option value="12ft"></option>
          <option value="Telescopic"></option>
        `;
      }
    } else if (cat === 'AED') {
      if (sizeLabel) sizeLabel.textContent = 'Component';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = 'Unit';
        sizeInput.placeholder = 'e.g. Unit';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="Unit"></option>
          <option value="Adult Pads"></option>
          <option value="Pediatric Pads"></option>
          <option value="Battery Pack"></option>
        `;
      }
    } else {
      if (sizeLabel) sizeLabel.textContent = 'Item / Service Description';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = 'Standard';
        sizeInput.placeholder = 'e.g. Glove Testing, Utility Tool, Hardware...';
      }
      const vObj = (this.vendors || []).find(v => v.name.toLowerCase() === vendorName.toLowerCase());
      const catItems = (vObj?.items || []).filter(it => it.category === 'Other' || it.category === 'Testing' || /\b(?:testing|labor)\b/i.test(it.item || '') || /\b(?:testing|labor)\b/i.test(it.itemNumber || ''));
      if (datalist) {
        let opts = catItems.map(it => `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} ${it.price > 0 ? '— $' + Number(it.price).toFixed(2) : ''}</option>`).join('');
        opts += `<option value="Standard"></option><option value="Labor / Testing"></option>`;
        datalist.innerHTML = opts;
      }
    }
    this.onMoAddItemChange(true);
  }

  onMoAddItemChange(forcePriceUpdate = false) {
    const cat = document.getElementById('mo-add-item-cat')?.value || 'Gloves';
    const classVal = document.getElementById('mo-add-item-class')?.value || 'Class 2';
    const size = document.getElementById('mo-add-item-size')?.value || '';
    const vSelect = document.getElementById('mark-order-vendor-select');
    let vendor = vSelect ? vSelect.value : '';
    if (vendor && vendor !== '__custom__' && size) {
      const price = this.getVendorPrice(vendor, cat, size, classVal);
      const priceInput = document.getElementById('mo-add-item-price');
      if (priceInput && (forcePriceUpdate || !priceInput.value || parseFloat(priceInput.value) === 0)) {
        priceInput.value = price > 0 ? price.toFixed(2) : '';
      }
    }
  }

  addCustomItemToMarkOrderedModal() {
    const catSelect = document.getElementById('mo-add-item-cat');
    let cat = catSelect ? catSelect.value : 'Gloves';
    const classSelect = document.getElementById('mo-add-item-class');
    let classVal = classSelect ? classSelect.value : 'Class 2';
    const sizeInput = document.getElementById('mo-add-item-size');
    const size = sizeInput ? sizeInput.value.trim() : 'Standard';
    if (!size) {
      alert('⚠️ Please specify a size or item description.');
      if (sizeInput) sizeInput.focus();
      return;
    }
    const qtyInput = document.getElementById('mo-add-item-qty');
    const qty = Math.max(1, parseInt(qtyInput?.value, 10) || 1);
    const priceInput = document.getElementById('mo-add-item-price');
    const unitPrice = Math.max(0, parseFloat(priceInput?.value) || 0);
    const empSelect = document.getElementById('mo-add-item-assignee');
    const assignee = empSelect ? empSelect.value : 'On Shelf';

    const isTesting = (cat === 'Testing' || /\b(?:testing|labor|service|dielectric)\b/i.test(cat) || /\b(?:testing|labor|service|dielectric)\b/i.test(size));
    if (isTesting) {
      cat = 'Testing';
      if (!classVal || classVal === 'Class 2') classVal = 'N/A';
    }

    const isShelf = !assignee || assignee === 'On Shelf' || assignee.toLowerCase().includes('shelf') || assignee.toLowerCase().includes('stock');

    const newItem = {
      itemType: cat,
      typeLabel: isTesting ? (size && size !== 'Standard' ? size : 'Testing & Labor') : cat,
      size: size,
      classVal: classVal,
      quantity: qty,
      price: unitPrice,
      employeeName: isShelf ? 'On Shelf' : assignee,
      employees: isShelf ? [] : [{ name: assignee, label: assignee, checked: true }],
      section: 'custom_order_item'
    };

    this.syncPendingMarkOrderedItemsFromDom();
    if (!this.pendingMarkOrderedItems) this.pendingMarkOrderedItems = [];
    this.pendingMarkOrderedItems.push(newItem);
    this.renderMarkOrderedTableRows();
    this.recalcMarkOrderedModal();

    if (qtyInput) qtyInput.value = '1';
  }

  closeMarkOrderedModal() {
    const modal = document.getElementById('mark-ordered-modal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.remove('active');
    }
    this.pendingMarkOrderedItems = null;
  }

  onMarkOrderRowSizeChange(idx, newSize) {
    if (!this.pendingMarkOrderedItems || !this.pendingMarkOrderedItems[idx]) return;
    const item = this.pendingMarkOrderedItems[idx];
    item.size = newSize;
    const vSelect = document.getElementById('mark-order-vendor-select');
    const vendorName = (vSelect && vSelect.value && vSelect.value !== '__custom__') ? vSelect.value : '';
    if (vendorName) {
      const price = this.getVendorPrice(vendorName, item.itemType, newSize, item.classVal);
      const rows = document.querySelectorAll('.mark-ordered-item-row');
      const row = rows[idx];
      if (row) {
        const priceInput = row.querySelector('.mark-ordered-price-input');
        if (priceInput && price > 0) {
          priceInput.value = price.toFixed(2);
          item.price = price;
          this.recalcMarkOrderedModal();
        }
      }
    }
  }

  onMarkOrderVendorChange(val) {
    const customInput = document.getElementById('mark-order-custom-vendor');
    if (!customInput) return;
    if (val === '__custom__') {
      customInput.style.display = 'block';
      customInput.focus();
    } else {
      customInput.style.display = 'none';
      if (this.pendingMarkOrderedItems) {
        const rows = document.querySelectorAll('.mark-ordered-item-row');
        rows.forEach(r => {
          const idx = parseInt(r.getAttribute('data-idx'), 10);
          if (isNaN(idx) || !this.pendingMarkOrderedItems[idx]) return;
          const item = this.pendingMarkOrderedItems[idx];
          const sizeInput = r.querySelector('.mark-ordered-size-input');
          const effSize = sizeInput ? sizeInput.value.trim() : (item.size || '');
          const priceInput = r.querySelector('.mark-ordered-price-input');
          const price = this.getVendorPrice(val, item.itemType, effSize, item.classVal);
          if (price > 0 && priceInput) {
            priceInput.value = price.toFixed(2);
            item.price = price;
          }
        });
        this.recalcMarkOrderedModal();
      }
    }
    const curMoCat = document.getElementById('mo-add-item-cat')?.value;
    if (curMoCat) {
      this.onMoAddItemCatChange(curMoCat);
    } else {
      this.onMoAddItemChange(true);
    }
  }

  async confirmMarkOrdered() {
    this.syncPendingMarkOrderedItemsFromDom();
    if (!this.pendingMarkOrderedItems || this.pendingMarkOrderedItems.length === 0) {
      alert('⚠️ Please add at least one item to this order.');
      return;
    }

    const poNumInput = document.getElementById('mark-order-po-num');
    let orderNum = poNumInput ? poNumInput.value.trim() : '';
    if (!orderNum) {
      orderNum = this.generateNextRequestPoNumber();
      if (poNumInput) poNumInput.value = orderNum;
    }

    const vSelect = document.getElementById('mark-order-vendor-select');
    let vendorName = vSelect ? vSelect.value : '';
    if (vendorName === '__custom__') {
      const customV = document.getElementById('mark-order-custom-vendor');
      vendorName = customV ? customV.value.trim() : '';
    }
    if (!vendorName) {
      alert('⚠️ Please select or enter a Vendor.');
      return;
    }

    const orderDateInput = document.getElementById('mark-order-date');
    const orderDate = orderDateInput ? orderDateInput.value : '';
    const deliveryDateInput = document.getElementById('mark-order-delivery-date');
    const expectedDelivery = deliveryDateInput ? deliveryDateInput.value : '';

    const confirmBtn = document.getElementById('btn-confirm-mark-ordered');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '⏳ Saving Order...';
    }

    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);

      const itemsSummaryList = [];
      let grandTotal = 0;
      let totalUnits = 0;
      const allCheckedEmps = [];

      for (let i = 0; i < this.pendingMarkOrderedItems.length; i++) {
        const origItem = this.pendingMarkOrderedItems[i];
        if (!origItem) continue;

        const resolvedSize = (origItem.size || 'Standard').trim();
        const qty = Math.max(1, parseInt(origItem.quantity, 10) || 1);
        const unitPrice = Math.max(0, parseFloat(origItem.price) || 0);
        const subtotal = qty * unitPrice;

        grandTotal += subtotal;
        totalUnits += qty;

        // Collect assigned employee names
        let rawEmps = [];
        if (origItem.employees && origItem.employees.length > 0) {
          rawEmps = origItem.employees.filter(e => e.checked && e.name).map(e => e.name);
        } else if (origItem.employeeName) {
          rawEmps = [origItem.employeeName];
        }

        // Exclude shelf/stock placeholders from linemen assignments
        const validLinemen = rawEmps.filter(name => {
          if (!name) return false;
          const lower = name.toLowerCase();
          return !lower.includes('shelf') && !lower.includes('stock');
        });

        allCheckedEmps.push(...validLinemen);

        const empTag = validLinemen.length > 0 ? ` [For: ${validLinemen.join(', ')}]` : '';
        const isTestingOrService = (origItem.itemType === 'Testing' || origItem.category === 'Testing' || /\b(?:testing|labor)\b/i.test(origItem.itemType || '') || /\b(?:testing|labor)\b/i.test(origItem.typeLabel || '') || /\b(?:testing|labor)\b/i.test(resolvedSize));
        let summaryStr = '';
        if (isTestingOrService) {
          const itemLabel = resolvedSize && resolvedSize !== 'Standard' ? resolvedSize : (origItem.typeLabel || origItem.itemType || 'Testing & Labor');
          summaryStr = `(${qty}) ${itemLabel}${empTag}${unitPrice > 0 ? ' @ $' + unitPrice.toFixed(2) : ''}`;
        } else {
          summaryStr = `(${qty}) ${origItem.classVal || ''} ${origItem.itemType || origItem.typeLabel || 'Equipment'}, Size ${resolvedSize}${empTag}${unitPrice > 0 ? ' @ $' + unitPrice.toFixed(2) : ''}`;
        }
        itemsSummaryList.push(summaryStr);

        // Auto-sync vendor catalog price if entered
        if (unitPrice > 0) {
          await this.syncVendorPrice(vendorName, origItem.itemType, resolvedSize, origItem.classVal, unitPrice);
        }

        const catKey = (origItem.itemType || '').toLowerCase();
        const swapKey = this._getSwapTableKeyForCategory(catKey);

        const swapTable = swapKey ? ((this.db && typeof this.db.getTable === 'function' ? this.db.getTable(swapKey) : null) || snap?.tables?.[swapKey]) : null;

        for (const empName of validLinemen) {
          if (!empName) continue;
          const orderNote = `Ordered on ${orderDate || new Date().toLocaleDateString()}, Order #: ${orderNum}, Vendor: ${vendorName}${expectedDelivery ? ', Est. Delivery: ' + expectedDelivery : ''}${unitPrice > 0 ? ', Price: $' + unitPrice.toFixed(2) : ''}`;

          let updatedInSwap = false;
          if (swapTable && swapTable.rows) {
            const sRow = swapTable.rows.find(sr => {
              const name = String(sr['Employee'] || sr['Employee Name'] || sr['Crew Lead / Employee'] || sr['Assigned To'] || Object.values(sr)[0] || '').trim();
              return this.isNameMatch(name, empName);
            });
            if (sRow) {
              const nextStatus = `Ordered (Order #: ${orderNum})`;
              const nextNotes = sRow['Notes'] ? `${sRow['Notes']}; ${orderNote}` : orderNote;
              await this._queueCellMutation(swapTable, swapKey, sRow, 'status', nextStatus);
              await this._queueCellMutation(swapTable, swapKey, sRow, 'notes', nextNotes);
              sRow['Status'] = nextStatus;
              sRow['Notes'] = nextNotes;
              updatedInSwap = true;
            }
          }

          const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
          if (needsTable && needsTable.rows) {
            const nRow = needsTable.rows.find(nr => {
              const meta = this._getSafetyNeedMeta(nr);
              if (!meta) return false;
              return this.isNameMatch(meta.employee, empName) && meta.itemType.toLowerCase().includes(catKey.slice(0, 4));
            });
            if (nRow) {
              await this._queueRowUpdate(needsTable, 'safety_equipment_needs', 'Safety Equipment Needs', nRow, {
                'Status': 'Ordered',
                'Notes': orderNote
              });
            } else if (!updatedInSwap) {
              // Only create a new safety_equipment_needs row if this item is NOT already tracked in a swap sheet
              const newNeed = this._buildSafetyNeedRow({
                employee: empName,
                itemType: origItem.typeLabel || origItem.itemType,
                size: resolvedSize,
                classVal: origItem.classVal || 'Class 2',
                urgency: 'Immediate',
                status: 'Ordered',
                dateRequested: orderDate || new Date().toLocaleDateString(),
                notes: orderNote
              });
              await this.db.addRow('safety_equipment_needs', newNeed, 'Purchase Order');
            }
          }
        }
      }

      const formatToMdY = (dStr) => {
        if (!dStr) return '';
        if (dStr.includes('/')) return dStr;
        const parts = dStr.split('-');
        if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`;
        return dStr;
      };

      const uniqueEmps = Array.from(new Set(allCheckedEmps)).filter(Boolean);
      let empNoteStr = uniqueEmps.length > 0
        ? `Ordered ${totalUnits} units (For: ${uniqueEmps.join(', ')})`
        : `Ordered ${totalUnits} units for Mountain Power Operations (Shelf Stock)`;
      if (orderNum) {
        empNoteStr += `; Order #: ${orderNum}`;
      }

      const poRowObj = {
        'Date': formatToMdY(orderDate) || new Date().toLocaleDateString(),
        'PO Number': orderNum,
        'Vendor': vendorName,
        'Items': itemsSummaryList.join('; '),
        'Total Price': grandTotal > 0 ? grandTotal : 0,
        'Expected Delivery': formatToMdY(expectedDelivery) || 'Pending',
        'Status': 'Ordered',
        'Notes': empNoteStr
      };

      await this.db.addRow('purchase_orders', poRowObj, 'Purchase Order');

      this.closeMarkOrderedModal();
      await this.loadData();

      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }

      alert(`✅ Successfully created Order #${orderNum} with ${vendorName} for ${totalUnits} item(s)!`);
    } catch (err) {
      console.error('Error confirming mark ordered:', err);
      alert('❌ Failed to mark items as ordered: ' + (err.message || err));
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<span>📦</span> Confirm & Create Order';
      }
    }
  }

  // =========================================================================
  // BATCH DELIVERY TO INVENTORY MODAL & WORKFLOW
  // =========================================================================

  /**
   * Opens the batch delivery receiving modal pre-filtered to the line items of a specific PO/Order.
   */
  openBatchDeliveryModalForPo(poNum) {
    if (!poNum) {
      this.openBatchDeliveryModal();
      return;
    }
    const clean = String(poNum).trim().toLowerCase();
    const matched = (this.items || []).filter(i => {
      if (i.section !== 'ordered_pending') return false;
      const oNum = String(i.orderInfo?.vendorOrderNumber || i.orderInfo?.orderNumber || i.orderInfo?.poNumber || '').trim().toLowerCase();
      if (oNum === clean || (clean.length >= 3 && oNum.includes(clean))) return true;
      if (i.employees && i.employees.some(e => {
        const eo = String(e.orderInfo?.vendorOrderNumber || e.orderInfo?.orderNumber || '').trim().toLowerCase();
        return eo === clean || (clean.length >= 3 && eo.includes(clean));
      })) return true;
      return false;
    });
    if (matched.length) {
      this.openBatchDeliveryModal(matched);
    } else {
      this.openBatchDeliveryModal();
    }
  }

  async quickMarkOrderReceivedFromKey(orderKey) {
    const grp = this.orderGroupsMap ? this.orderGroupsMap.get(orderKey) : null;
    const poNum = grp ? String(grp.vendorOrderNumber || grp.orderNumber || grp.poNumber || '').trim() : '';

    if (!confirm(`Mark Order #${poNum || ''} as Received and clear from Awaiting Delivery?\n\nUse this when the order has arrived and items have already been entered into inventory. It will update the tracking log to "Received" and clear all pending line items without creating duplicate inventory entries.`)) {
      return;
    }

    try {
      const todayStr = this.formatToMdY ? this.formatToMdY(new Date().toISOString().split('T')[0]) : new Date().toLocaleDateString();

      const assignedEmps = [];
      if (grp && grp.items) {
        grp.items.forEach(it => {
          (it.employees || []).forEach(e => { if (e.name) assignedEmps.push(e.name); });
        });
      }

      await this.resolveReceivedOrderItems(poNum, {
        assignedEmployees: assignedEmps,
        isReadyForDelivery: false,
        todayStr: todayStr
      });

      await this.loadData();
      this.render();

      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }

      alert(`✅ Order #${poNum || ''} marked as Received and cleared from Awaiting Delivery!`);
    } catch (err) {
      console.error('Error marking order received from key:', err);
      alert('❌ Failed to update order status: ' + (err.message || err));
    }
  }

  async quickMarkItemReceived(globalIdx) {
    const item = (this.items || [])[globalIdx];
    if (!item) return;
    const emps = (item.employees || []).map(e => e.name).filter(Boolean);
    const poNum = item.orderInfo?.vendorOrderNumber || item.orderInfo?.orderNumber || item.orderInfo?.poNumber || '';
    const desc = `${item.quantity || 1}x ${item.itemType} (Size ${item.size})`;

    if (!confirm(`Mark ${desc} as Received?\n\nThis will update tracking status to "Received" and clear this item from Awaiting Delivery without creating duplicate inventory records.`)) {
      return;
    }

    try {
      const todayStr = this.formatToMdY ? this.formatToMdY(new Date().toISOString().split('T')[0]) : new Date().toLocaleDateString();
      const targetUnits = (emps.length > 0 ? emps : ['On Shelf']).map(emp => ({
        category: item.itemType,
        itemType: item.itemType,
        size: item.size,
        classVal: item.classVal,
        empName: emp,
        orderInfo: item.orderInfo || null
      }));
      await this.resolveReceivedOrderItems(poNum, {
        assignedEmployees: emps,
        units: targetUnits,
        partialOnly: true,
        isReadyForDelivery: false,
        todayStr: todayStr
      });
      await this.loadData();
      this.render();
      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }
      alert(`✅ Marked as Received!`);
    } catch (err) {
      console.error('Error marking item received:', err);
      alert('❌ Failed to mark received: ' + (err.message || err));
    }
  }

  async quickMarkEmployeeItemReceived(empName, itemType, size, classVal, globalIdx) {
    const item = (this.items || [])[globalIdx];
    const poNum = item?.orderInfo?.vendorOrderNumber || item?.orderInfo?.orderNumber || item?.orderInfo?.poNumber || '';

    if (!confirm(`Mark ${itemType} (Size ${size}) for ${empName} as Received?\n\nThis will clear this pending item from Awaiting Delivery.`)) {
      return;
    }

    try {
      const todayStr = this.formatToMdY ? this.formatToMdY(new Date().toISOString().split('T')[0]) : new Date().toLocaleDateString();
      await this.resolveReceivedOrderItems(poNum, {
        assignedEmployees: [empName],
        units: [{
          category: itemType,
          itemType: itemType,
          size: size,
          classVal: classVal,
          empName: empName,
          orderInfo: item?.orderInfo || null
        }],
        partialOnly: true,
        isReadyForDelivery: false,
        todayStr: todayStr
      });
      await this.loadData();
      this.render();
      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }
      alert(`✅ Marked as Received for ${empName}!`);
    } catch (err) {
      console.error('Error marking employee item received:', err);
      alert('❌ Failed to mark received: ' + (err.message || err));
    }
  }

  /**
   * Comprehensive handler to resolve and clear matching line items across All Needs & Orders
   * (safety_equipment_needs, swap sheets, and purchase_orders) when an order is received or marked delivered.
   */
  async resolveReceivedOrderItems(poIdentifiers, options = {}) {
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);

    const isReadyForDelivery = !!options.isReadyForDelivery;
    const todayStr = options.todayStr || (this.formatToMdY ? this.formatToMdY(new Date().toISOString().split('T')[0]) : new Date().toLocaleDateString());

    // 1. Normalize all PO / Order Numbers to match against
    const rawIds = Array.isArray(poIdentifiers) ? poIdentifiers : [poIdentifiers];
    const poNumSet = new Set();
    for (const id of rawIds) {
      if (!id) continue;
      const clean = String(id).trim();
      if (clean && clean.toLowerCase() !== 'ed' && clean.toLowerCase() !== 'pending') {
        poNumSet.add(clean);
        poNumSet.add(clean.toLowerCase());
      }
    }

    // Also look up PO row if poRowIdx or matched PO row exists to harvest any additional order numbers
    const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
    let targetPoRows = [];
    if (poTable && poTable.rows) {
      targetPoRows = poTable.rows.filter((r, idx) => {
        const rIdx = r._rowIdx || (idx + 2);
        if (options.poRowIdx && rIdx === options.poRowIdx) return true;
        const p1 = String(r['PO Number'] || r['PO #'] || '').trim();
        if (p1 && (poNumSet.has(p1) || poNumSet.has(p1.toLowerCase()))) return true;
        const notes = String(r['Notes'] || '');
        for (const pid of poNumSet) {
          if (pid.length >= 3 && notes.toLowerCase().includes(pid.toLowerCase())) return true;
        }
        return false;
      });
      for (const poRow of targetPoRows) {
        const p1 = String(poRow['PO Number'] || poRow['PO #'] || '').trim();
        if (p1 && p1.toLowerCase() !== 'ed') {
          poNumSet.add(p1);
          poNumSet.add(p1.toLowerCase());
        }
        const parsedNotes = this.parseOrderInfoFromNotes(poRow['Notes'] || '');
        if (parsedNotes?.vendorOrderNumber && parsedNotes.vendorOrderNumber.toLowerCase() !== 'ed') {
          poNumSet.add(parsedNotes.vendorOrderNumber);
          poNumSet.add(parsedNotes.vendorOrderNumber.toLowerCase());
        }
      }
    }

    // 2. Normalize assigned employees
    const empNamesSet = new Set();
    if (options.assignedEmployees) {
      for (const e of options.assignedEmployees) {
        if (!e) continue;
        const clean = this.cleanEmployeeName(e);
        if (clean && !clean.toLowerCase().includes('shelf') && !clean.toLowerCase().includes('stock')) {
          empNamesSet.add(this.normalizeName(clean));
        }
      }
    }
    if (options.units) {
      for (const u of options.units) {
        const name = u.empName;
        if (name && !name.toLowerCase().includes('shelf') && !name.toLowerCase().includes('stock')) {
          empNamesSet.add(this.normalizeName(name));
        }
        if (u.orderInfo?.orderNumber) poNumSet.add(String(u.orderInfo.orderNumber).trim());
        if (u.orderInfo?.vendorOrderNumber) poNumSet.add(String(u.orderInfo.vendorOrderNumber).trim());
      }
    }
    for (const poRow of targetPoRows) {
      const notes = String(poRow['Notes'] || '');
      const forMatch = notes.match(/(?:for|assign(?:ed)?\s*to)\s*[:=]?\s*([A-Za-z0-9\s.',&-]+?)(?:;|\)|$)/i);
      if (forMatch) {
        const parsedEmps = forMatch[1].split(',').map(n => this.cleanEmployeeName(n)).filter(Boolean);
        for (const pe of parsedEmps) {
          if (!pe.toLowerCase().includes('shelf') && !pe.toLowerCase().includes('stock')) {
            empNamesSet.add(this.normalizeName(pe));
          }
        }
      }
    }

    const escapeRx = (str) => String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isPartialOnly = Boolean(options.partialOnly);
    const matchesPoOrEmp = (empName, statusStr, notesStr) => {
      const s = String(statusStr || '');
      const n = String(notesStr || '');
      const sLower = s.toLowerCase();
      const nLower = n.toLowerCase();

      // When resolving only specific unit(s) / employee(s), NEVER match unrelated employees on the same PO
      if (isPartialOnly && empNamesSet.size > 0) {
        if (!empName) return false;
        const normEmp = this.normalizeName(empName);
        let empHit = Boolean(normEmp && empNamesSet.has(normEmp));
        if (!empHit) {
          for (const ke of empNamesSet) {
            if (this.isNameMatch(ke, empName)) { empHit = true; break; }
          }
        }
        return empHit && (sLower.includes('order') || nLower.includes('order'));
      }

      // Check PO numbers match with boundary guard so short IDs don't false-match unrelated numbers
      for (const pid of poNumSet) {
        if (pid.length >= 2) {
          const rx = new RegExp(`(^|[^a-z0-9])${escapeRx(pid)}([^a-z0-9]|$)`, 'i');
          if (rx.test(s) || rx.test(n)) return true;
        }
      }
      // Check employee name match if item is marked ordered
      if (empName && (sLower.includes('order') || nLower.includes('order'))) {
        const normEmp = this.normalizeName(empName);
        if (normEmp && empNamesSet.has(normEmp)) return true;
        for (const ke of empNamesSet) {
          if (this.isNameMatch(ke, empName)) return true;
        }
      }
      return false;
    };

    // 3. Update safety_equipment_needs
    const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
    if (needsTable && needsTable.rows) {
      for (const nr of needsTable.rows) {
        const meta = this._getSafetyNeedMeta(nr);
        if (!meta) continue;
        if (matchesPoOrEmp(meta.employee, meta.status, meta.notes)) {
          const nextStatus = isReadyForDelivery ? 'Ready For Delivery' : 'Fulfilled';
          const nextNotes = `${meta.notes}; Order received & fulfilled on ${todayStr}`.trim().replace(/^;\s*/, '');
          await this._queueRowUpdate(needsTable, 'safety_equipment_needs', 'Safety Equipment Needs', nr, {
            'Status': nextStatus,
            'Notes': nextNotes
          });
        }
      }
    }

    // 4. Update swap tables across all 9 equipment categories
    const parseSwapCls = (c) => {
      if (c === undefined || c === null || c === '') return null;
      const m = String(c).match(/\d+/);
      return m ? parseInt(m[0], 10) : null;
    };
    const swapConfigs = this._getAllSwapTableConfigs();
    for (const meta of swapConfigs) {
      const sk = meta.swapKey;
      const sTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(sk) : null) || snap?.tables?.[sk];
      if (sTable) {
        const invTableForSk = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(meta.invKey) : null) || snap?.tables?.[meta.invKey];
        const empColInfo = this._findTableCol(sTable, sk, 'employee');
        const statColInfo = this._findTableCol(sTable, sk, 'status');
        const notesColInfo = this._findTableCol(sTable, sk, 'notes');

        if (sTable.rows && sTable.rows.length > 0) {
          for (const sr of sTable.rows) {
            const emp = String(sr['Employee'] || sr['Employee Name'] || sr['Crew Lead / Employee'] || sr['Assigned To'] || Object.values(sr)[0] || '').trim();
            const stat = String(sr['Status'] || '');
            const statLower = stat.toLowerCase();
            if (statLower === 'complete' || statLower.includes('ready for delivery')) continue;
            const notes = String(sr['Notes'] || '');
            if (matchesPoOrEmp(emp, stat, notes)) {
              const oldItemNum = String(sr['Current Glove #'] || sr['Current Sleeve #'] || sr['Current Blanket #'] || sr['Current MACK #'] || sr['Current Item #'] || sr['Current Item'] || sr['Serial #'] || '').trim();
              let srClass = parseSwapCls(sr['Class'] || sr['KV']);
              if (meta.isRubber && srClass === null && oldItemNum && invTableForSk && Array.isArray(invTableForSk.rows)) {
                const oldInv = invTableForSk.rows.find(it => String(it['Item #'] || it['Glove'] || it['Sleeve'] || it['ESL ID'] || '').trim() === oldItemNum);
                if (oldInv) srClass = parseSwapCls(oldInv['Class']);
              }

              let assignedItemNum = '';
              if (Array.isArray(options.units) && options.units.length > 0) {
                const empCatUnits = options.units.filter(u =>
                  this.isNameMatch(u.empName, emp) &&
                  this._getSwapTableKeyForCategory(u.category || u.itemType) === sk
                );
                const empAnyUnits = options.units.filter(u => this.isNameMatch(u.empName, emp));
                if (empAnyUnits.length > 0 && empCatUnits.length === 0) continue; // Units for another category only

                const matchedU = empCatUnits.find(u => {
                  if (!meta.isRubber || srClass === null) return true;
                  const uClass = parseSwapCls(u.classVal || u.itemClass);
                  return uClass === null || uClass === srClass;
                });
                if (empCatUnits.length > 0 && !matchedU) continue; // Units exist in another rubber class (e.g. Class 3 vs Class 2)
                if (matchedU && (matchedU.suggestedNum || matchedU.itemNum)) {
                  assignedItemNum = matchedU.suggestedNum || matchedU.itemNum;
                }
              }
              const newStatus = isReadyForDelivery ? 'Ready For Delivery 🚚' : 'Complete';
              const hasValidPickNum = Boolean(assignedItemNum && assignedItemNum !== '—' && assignedItemNum !== '-');

              // Queue Pick List BEFORE Status so GAS manual-pick styling cannot clobber Status
              if (hasValidPickNum) {
                await this._queueCellMutation(sTable, sk, sr, 'pickList', assignedItemNum);
                sr['Pick List Item #'] = assignedItemNum;
                sr['Picked For'] = assignedItemNum;
              }
              await this._queueCellMutation(sTable, sk, sr, 'status', newStatus);
              sr['Status'] = newStatus;

              // Only queue Picked = true when Ready For Delivery with a valid physical Pick List item #
              // (Sending Picked = true without a Pick List # or on Complete triggers unintended GAS Stage 1 flips)
              if (isReadyForDelivery && hasValidPickNum) {
                await this._queueCellMutation(sTable, sk, sr, 'picked', true);
                sr['Picked'] = true;
                if (typeof this.db.saveManualPick === 'function') {
                  this.db.saveManualPick(sk, emp, oldItemNum, assignedItemNum, 'Ready For Delivery 🚚', true);
                }
              }
            }
          }
        } else if (sTable.rawGrid && Array.isArray(sTable.rawGrid) && empColInfo && statColInfo) {
          // Fallback: update rawGrid directly when sTable.rows is empty or detached
          for (let r = 1; r < sTable.rawGrid.length; r++) {
            const gridRow = sTable.rawGrid[r];
            if (!Array.isArray(gridRow)) continue;
            const emp = String(gridRow[empColInfo.col0Based] || '').trim();
            const stat = String(gridRow[statColInfo.col0Based] || '').trim();
            const notes = notesColInfo ? String(gridRow[notesColInfo.col0Based] || '').trim() : '';
            if (emp && stat.toLowerCase().includes('order') && matchesPoOrEmp(emp, stat, notes)) {
              const newStatus = isReadyForDelivery ? 'Ready For Delivery 🚚' : 'Complete';
              await this._queueCellMutation(sTable, sk, r, 'status', newStatus);
            }
          }
        }
      }
    }

    // 5. Update purchase_orders table
    if (poTable && poTable.rows) {
      for (const po of targetPoRows) {
        const poId = String(po['PO Number'] || po['PO #'] || '').trim();
        if (isPartialOnly && Array.isArray(options.units) && options.units.length > 0 && po['Items']) {
          const parsedPoItems = this.parsePoItemsString(String(po['Items']));
          let totalPoUnits = parsedPoItems.reduce((sum, pi) => sum + (parseInt(pi.quantity, 10) || 1), 0);
          if (totalPoUnits > options.units.length) {
            const receivedDesc = options.units.map(u => `${u.empName || 'Shelf'} (${u.itemType || u.category} ${u.size || ''})`).join(', ');
            const updatedFields = {
              'Status': 'Partially Received',
              'Notes': `${po['Notes'] || ''}; Partial receipt (${receivedDesc}) on ${todayStr}`.trim().replace(/^;\s*/, '')
            };
            await this._queueRowUpdate(poTable, 'purchase_orders', 'Purchase Orders', po, updatedFields, poId);
            continue;
          }
        }
        const updatedFields = {
          'Status': 'Received',
          'Expected Delivery': (!po['Expected Delivery'] || po['Expected Delivery'] === 'Pending') ? todayStr : po['Expected Delivery'],
          'Notes': `${po['Notes'] || ''}; Received on ${todayStr}`.trim().replace(/^;\s*/, '')
        };
        await this._queueRowUpdate(poTable, 'purchase_orders', 'Purchase Orders', po, updatedFields, poId);
      }
    }
  }

  /**
   * Returns true when a procurement line item or unit is a non-receivable testing/labor service
   * rather than physical equipment entered into inventory sheets.
   */
  isTestingServiceItem(item) {
    if (!item) return false;
    const rawCat = String(item.itemType || item.category || '').trim();
    const rawSize = String(item.size || '').trim();
    const rawLabel = String(item.typeLabel || '').trim();
    const rawPart = String(item.partNumber || item.orderInfo?.partNumber || '').trim();
    const lowerCat = rawCat.toLowerCase();

    if (lowerCat === 'testing' || lowerCat === 'testing & labor') return true;
    // Do not misclassify physical testing instruments (HV Testers, Phasing Sets) as service fees
    if (/\b(?:hv\s*tester|phasing|voltmeter|hi-pot|hipot|detector)\b/i.test(rawCat)) return false;

    const combined = `${rawCat} ${rawSize} ${rawLabel} ${rawPart}`;
    return /\b(?:testing|labor|retest|recertification|dielectric\s*testing|tester\s*calibration)\b/i.test(combined) &&
      !/\b(?:voltmeter|phasing|hi-pot|hipot|bierer|detector|hv\s*tester)\b/i.test(combined);
  }

  _collectBatchPoNumbers(extraItems = []) {
    const sources = [
      ...(this._pendingDeliveryUnits || []),
      ...(this.pendingBatchDeliveryItems || []),
      ...(extraItems || [])
    ];
    return [...new Set(
      sources
        .map(x =>
          x?.orderInfo?.vendorOrderNumber ||
          x?.orderInfo?.orderNumber ||
          x?.orderInfo?.poNumber ||
          x?.origItem?.orderInfo?.vendorOrderNumber ||
          x?.origItem?.orderInfo?.orderNumber ||
          x?.origItem?.orderInfo?.poNumber
        )
        .filter(Boolean)
    )];
  }

  async _markTestingOnlyOrderReceived(testingItems) {
    try {
      const todayStr = this.formatToMdY ? this.formatToMdY(new Date().toISOString().split('T')[0]) : new Date().toLocaleDateString();
      const poNums = this._collectBatchPoNumbers(testingItems);
      await this.resolveReceivedOrderItems(poNums, {
        assignedEmployees: [],
        isReadyForDelivery: false,
        todayStr: todayStr
      });
      await this.loadData();
      this.render();
      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }
      alert('✅ Testing / Labor item(s) marked as Received and cleared from Awaiting Delivery.');
    } catch (err) {
      console.error('Error marking testing-only order received:', err);
      alert('❌ Failed to mark Testing order received: ' + (err.message || err));
    }
  }

  _getBatchDraftStorageKey() {
    return 'sa_batch_delivery_drafts_v1';
  }

  _normalizeBatchPoKey(poNum) {
    const clean = String(poNum || '').trim().toLowerCase();
    return clean || '_none';
  }

  _getBatchDraftStore() {
    try {
      if (typeof localStorage === 'undefined') return {};
      const raw = localStorage.getItem(this._getBatchDraftStorageKey());
      const parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
      return {};
    }
  }

  _saveBatchDraftStore(store) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(this._getBatchDraftStorageKey(), JSON.stringify(store || {}));
    } catch (e) {
      console.warn('Could not persist batch delivery draft:', e);
    }
  }

  _getPoOrderDraftSummary(poNum) {
    const store = this._getBatchDraftStore();
    const key = this._normalizeBatchPoKey(poNum);
    const bucket = store[key];
    if (!bucket || !bucket.units || typeof bucket.units !== 'object') {
      return { hasDraft: false, editedCount: 0, receivedCount: 0, updatedAt: '' };
    }
    const vals = Object.values(bucket.units);
    const receivedCount = vals.filter(v => v && v.received).length;
    return {
      hasDraft: vals.length > 0,
      editedCount: vals.length,
      receivedCount,
      updatedAt: bucket.updatedAt || ''
    };
  }

  _buildBatchDatalistsHtml() {
    const empTable = (this.db && typeof this.db.getTable === 'function')
      ? this.db.getTable('employees')
      : (window.localDB && typeof window.localDB.getTable === 'function' ? window.localDB.getTable('employees') : null);
    const employees = (empTable && empTable.rows) ? empTable.rows : [];
    const seenNames = new Set(['on shelf', 'in testing', 'ready for delivery']);
    const empOpts = [
      '<option value="On Shelf">On Shelf (Warehouse Stock)</option>',
      '<option value="In Testing">In Testing</option>'
    ];
    const seenLocs = new Set(["cody's truck", 'helena', 'bozeman', 'butte', 'great falls', 'missoula', 'billings', 'kalispell']);
    const locOpts = [
      '<option value="Cody\'s Truck"></option>',
      '<option value="Helena"></option>',
      '<option value="Bozeman"></option>',
      '<option value="Butte"></option>',
      '<option value="Great Falls"></option>',
      '<option value="Missoula"></option>',
      '<option value="Billings"></option>',
      '<option value="Kalispell"></option>'
    ];

    employees.forEach(e => {
      const name = String(e['Name'] || e['Employee Name'] || '').trim();
      const loc = String(e['Location'] || '').trim();
      if (name && !seenNames.has(name.toLowerCase())) {
        seenNames.add(name.toLowerCase());
        empOpts.push(`<option value="${this.escapeHtml(name)}">${this.escapeHtml(loc ? `${name} (${loc})` : name)}</option>`);
      }
      if (loc && !seenLocs.has(loc.toLowerCase())) {
        seenLocs.add(loc.toLowerCase());
        locOpts.push(`<option value="${this.escapeHtml(loc)}"></option>`);
      }
    });

    return `
      <datalist id="batch-delivery-employees-datalist">${empOpts.join('')}</datalist>
      <datalist id="batch-delivery-locations-datalist">${locOpts.join('')}</datalist>
    `;
  }

  _collectBatchDraftRowsFromDom() {
    const rows = document.querySelectorAll('.batch-delivery-unit-row');
    const store = this._getBatchDraftStore();
    const nowIso = new Date().toISOString();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const u = this._pendingDeliveryUnits && this._pendingDeliveryUnits[i];
      if (!u || !u.unitKey) continue;

      const bucketKey = u.poBucketKey || '_none';
      if (!store[bucketKey] || typeof store[bucketKey] !== 'object') {
        store[bucketKey] = { updatedAt: nowIso, units: {} };
      }
      if (!store[bucketKey].units || typeof store[bucketKey].units !== 'object') {
        store[bucketKey].units = {};
      }
      store[bucketKey].updatedAt = nowIso;

      if (u._alreadyReceived) {
        const existing = store[bucketKey].units[u.unitKey] || {};
        store[bucketKey].units[u.unitKey] = {
          ...existing,
          received: true,
          checked: false
        };
        continue;
      }

      const includeEl = r.querySelector('.batch-unit-include');
      const classEl = r.querySelector('.batch-class');
      const sizeEl = r.querySelector('.batch-size');
      const assignedEl = r.querySelector('.batch-assigned-to');
      const itemNumEl = r.querySelector('.batch-item-num');
      const eslEl = r.querySelector('.batch-esl-id');
      const dateEl = r.querySelector('.batch-test-date');
      const locEl = r.querySelector('.batch-location');
      const statEl = r.querySelector('.batch-status');

      const curItemNum = itemNumEl ? itemNumEl.value.trim() : (u.suggestedNum || '');
      const defaultSugg = (itemNumEl && itemNumEl.getAttribute)
        ? (itemNumEl.getAttribute('data-default-suggested') || u.defaultSuggestedNum || '')
        : (u.defaultSuggestedNum || '');

      store[bucketKey].units[u.unitKey] = {
        checked: includeEl ? !!includeEl.checked : true,
        classVal: classEl ? classEl.value.trim() : u.classVal,
        size: sizeEl ? sizeEl.value.trim() : u.size,
        empName: assignedEl ? assignedEl.value.trim() : (u.empName || ''),
        itemNum: curItemNum,
        itemNumEdited: curItemNum !== defaultSugg,
        eslId: eslEl ? eslEl.value.trim() : '',
        testDate: dateEl ? dateEl.value : '',
        location: locEl ? locEl.value.trim() : '',
        status: statEl ? statEl.value : 'On Shelf',
        received: false
      };
    }

    return store;
  }

  saveBatchDeliveryDraft(showStatus = true) {
    if (!this._pendingDeliveryUnits || !this._pendingDeliveryUnits.length) return false;
    const store = this._collectBatchDraftRowsFromDom();
    this._saveBatchDraftStore(store);

    if (showStatus) {
      const indicator = document.getElementById('batch-draft-save-indicator');
      if (indicator) {
        const timeStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        indicator.textContent = `💾 Saved at ${timeStr}`;
        indicator.style.color = '#fcd34d';
      }
    }
    return true;
  }

  saveBatchDeliveryDraftAndClose() {
    this.saveBatchDeliveryDraft(true);
    this.closeBatchDeliveryModal();
    if (typeof this.render === 'function') {
      this.render();
    }
  }

  resetBatchDeliveryDraft() {
    if (!this._pendingDeliveryUnits || !this._pendingDeliveryUnits.length) return;
    if (!confirm('Reset all saved draft edits for these items back to defaults?\n\nNote: Items already added to inventory will not be deleted from sheets, only local draft edits will be cleared.')) {
      return;
    }
    const keys = [...new Set(this._pendingDeliveryUnits.map(u => u.poBucketKey || '_none'))];
    const store = this._getBatchDraftStore();
    keys.forEach(k => { delete store[k]; });
    this._saveBatchDraftStore(store);
    this.openBatchDeliveryModal(this.pendingBatchDeliveryItems || null);
  }

  _clearBatchDraftsForPoNums(poNums = [], extraBucketKeys = []) {
    const store = this._getBatchDraftStore();
    const keysToDelete = new Set([
      ...(extraBucketKeys || []),
      ...(poNums || []).map(p => this._normalizeBatchPoKey(p))
    ]);
    let changed = false;
    keysToDelete.forEach(k => {
      if (Object.prototype.hasOwnProperty.call(store, k)) {
        delete store[k];
        changed = true;
      }
    });
    if (changed) this._saveBatchDraftStore(store);
  }

  onBatchItemNumInput(el) {
    if (el) {
      const def = (el.getAttribute && el.getAttribute('data-default-suggested')) || '';
      const val = String(el.value || '').trim();
      if (el.dataset) {
        el.dataset.manualEdit = (val !== def) ? 'true' : 'false';
      }
    }
    this.onBatchDeliveryFieldChange();
  }

  _nextUnusedInModalSeries(targetIdx, category, sizeOrSpec = '') {
    const base = this.suggestNextItemNumber(category, sizeOrSpec);
    const mBase = base.match(/^([A-Za-z#\s\-_]*)(\d+)$/);
    if (!mBase) return base;
    const prefix = mBase[1];
    let candidateNum = parseInt(mBase[2], 10);
    const padLen = /^0\d+/.test(mBase[2]) ? mBase[2].length : 0;

    const used = new Set();
    const rows = document.querySelectorAll('.batch-delivery-unit-row');
    rows.forEach((r, idx) => {
      if (idx === targetIdx) return;
      const val = String(r.querySelector('.batch-item-num')?.value || '').trim().toUpperCase();
      if (val) used.add(val);
    });

    const formatCandidate = (n) => {
      const numStr = (padLen > 0 && String(n).length < padLen) ? String(n).padStart(padLen, '0') : String(n);
      return `${prefix}${numStr}`;
    };

    while (used.has(formatCandidate(candidateNum).toUpperCase())) {
      candidateNum++;
    }
    return formatCandidate(candidateNum);
  }

  onBatchSpecChange(idx) {
    const rows = document.querySelectorAll('.batch-delivery-unit-row');
    const r = rows[idx];
    const u = this._pendingDeliveryUnits && this._pendingDeliveryUnits[idx];
    if (r && u && !u._alreadyReceived && String(u.category || '').toLowerCase().includes('blanket')) {
      const sizeEl = r.querySelector('.batch-size');
      const itemNumEl = r.querySelector('.batch-item-num');
      if (sizeEl && itemNumEl) {
        const newSize = sizeEl.value.trim();
        const isSplit = newSize.toLowerCase().includes('split');
        const expectedPrefix = isSplit ? 'S' : 'B';
        const curVal = String(itemNumEl.value || '').trim();
        const curDef = (itemNumEl.getAttribute && itemNumEl.getAttribute('data-default-suggested')) || '';
        const manualEdit = itemNumEl.dataset && itemNumEl.dataset.manualEdit === 'true';

        // Re-suggest if untouched, empty, or switching between B### and S### blanket prefixes
        if (!curVal || (!manualEdit && (curVal === curDef || /^[BS]\d+$/i.test(curVal)))) {
          if (!curVal || !curVal.toUpperCase().startsWith(expectedPrefix)) {
            const nextNum = this._nextUnusedInModalSeries(idx, u.category, newSize);
            itemNumEl.value = nextNum;
            if (itemNumEl.setAttribute) itemNumEl.setAttribute('data-default-suggested', nextNum);
            if (itemNumEl.dataset) itemNumEl.dataset.manualEdit = 'false';
          }
        }
      }
    }
    this.onBatchDeliveryFieldChange();
  }

  onBatchDeliveryFieldChange() {
    this.saveBatchDeliveryDraft(true);
    this._updateBatchDeliveryActionUi();
  }

  toggleAllBatchDeliveryUnits(checked) {
    const boxes = document.querySelectorAll('.batch-unit-include');
    boxes.forEach(cb => {
      if (!cb.disabled) cb.checked = !!checked;
    });
    this.onBatchDeliveryFieldChange();
  }

  _updateBatchDeliveryActionUi() {
    const rows = document.querySelectorAll('.batch-delivery-unit-row');
    let pendingCount = 0;
    let checkedPending = 0;

    rows.forEach((r, idx) => {
      const u = this._pendingDeliveryUnits && this._pendingDeliveryUnits[idx];
      if (!u || u._alreadyReceived) return;
      pendingCount++;
      const cb = r.querySelector('.batch-unit-include');
      if (!cb || cb.checked) checkedPending++;
    });

    const selectAllEl = document.getElementById('batch-select-all');
    if (selectAllEl && pendingCount > 0) {
      selectAllEl.checked = (checkedPending === pendingCount);
      selectAllEl.indeterminate = (checkedPending > 0 && checkedPending < pendingCount);
    }

    const confirmBtn = document.getElementById('btn-confirm-batch-delivery');
    if (confirmBtn && pendingCount > 0) {
      const hasPreviouslyReceived = (this._pendingDeliveryUnits || []).some(u => u._alreadyReceived);
      if (checkedPending === 0) {
        confirmBtn.innerHTML = '<span>📦</span> Select Items to Add to Inventory';
      } else if (checkedPending < pendingCount) {
        confirmBtn.innerHTML = `<span>📦</span> Add Selected (${checkedPending} of ${pendingCount}) &amp; Save Rest`;
      } else if (hasPreviouslyReceived) {
        confirmBtn.innerHTML = `<span>📦</span> Add Remaining (${checkedPending}) &amp; Complete Delivery`;
      } else {
        confirmBtn.innerHTML = '<span>📦</span> Add to Inventory &amp; Complete Delivery';
      }
    }
  }

  openBatchDeliveryModal(itemsToDeliver = null) {
    let items = itemsToDeliver;
    if (!items || !items.length) {
      items = (this.items || []).filter(i => i.selected && i.quantity > 0 && i.section === 'ordered_pending');
      if (!items || !items.length) {
        items = (this.items || []).filter(i => i.section === 'ordered_pending');
      }
    }
    if (!items || !items.length) {
      alert('⚠️ No ordered items found awaiting delivery. Mark items as Ordered first.');
      return;
    }

    const skippedTestingItems = items.filter(i => this.isTestingServiceItem(i));
    const receivableItems = items.filter(i => !this.isTestingServiceItem(i));

    if (!receivableItems.length) {
      if (confirm('🧪 Testing / Labor items are non-inventory services and do not belong on the Receive Inventory screen.\n\nMark these Testing item(s) / PO as Received now and clear from Awaiting Delivery?')) {
        this._markTestingOnlyOrderReceived(skippedTestingItems);
      }
      return;
    }

    this.pendingBatchDeliveryItems = items;
    const modal = document.getElementById('batch-delivery-modal');
    const body = document.getElementById('batch-delivery-modal-body');
    if (!modal || !body) return;

    const today = new Date();
    const todayYmd = today.toISOString().split('T')[0];

    const draftStore = this._getBatchDraftStore();
    const specSeqMap = {};
    const units = [];
    const catCounters = {};
    let restoredDraftCount = 0;
    let alreadyReceivedCount = 0;

    receivableItems.forEach(item => {
      const cat = item.itemType || 'Gloves';
      const origSize = item.size || 'Standard';
      const origClass = item.classVal || 'Class 2';
      const poRaw = item.orderInfo?.vendorOrderNumber || item.orderInfo?.orderNumber || item.orderInfo?.poNumber || '';
      const poBucketKey = this._normalizeBatchPoKey(poRaw);
      const bucketUnits = draftStore[poBucketKey]?.units || {};
      const cleanCat = cat.toLowerCase();
      const isBlanketCat = cleanCat.includes('blanket');

      const emps = (item.employees && item.employees.length > 0)
        ? item.employees.filter(e => e.checked).map(e => e.name)
        : (item.employees?.map(e => e.name) || []);

      const count = Math.max(item.quantity, emps.length, 1);

      for (let u = 0; u < count; u++) {
        const empName = emps[u] || '';
        const specPrefix = `${poBucketKey}|${cat}|${origClass}|${origSize}`;
        const seqIdx = specSeqMap[specPrefix] || 0;
        specSeqMap[specPrefix] = seqIdx + 1;
        const unitKey = `${specPrefix}#${seqIdx}`;
        const saved = bucketUnits[unitKey] || null;
        const alreadyReceived = !!(saved && saved.received);

        if (saved) restoredDraftCount++;
        if (alreadyReceived) alreadyReceivedCount++;

        const effectiveEmp = (saved && saved.empName !== undefined) ? saved.empName : empName;
        const isAssignedDefault = !!effectiveEmp && !effectiveEmp.toLowerCase().includes('shelf') && !effectiveEmp.toLowerCase().includes('stock');
        const effectiveSize = (saved && saved.size) ? saved.size : origSize;
        const effectiveClass = (saved && saved.classVal) ? saved.classVal : origClass;

        const isSplitBlanket = isBlanketCat && String(effectiveSize || '').toLowerCase().includes('split');
        const seriesKey = isBlanketCat ? (isSplitBlanket ? 'blankets:split' : 'blankets:regular') : cleanCat;
        if (!catCounters[seriesKey]) {
          catCounters[seriesKey] = 0;
        }

        const baseSuggested = this.suggestNextItemNumber(cat, effectiveSize);
        let defaultSuggestedNum = baseSuggested;
        const hasValidManualNum = !!(saved && saved.itemNumEdited && saved.itemNum);
        if (!alreadyReceived && !hasValidManualNum) {
          const prefixMatch = baseSuggested.match(/^([A-Za-z#\s\-_]+)(\d+)$/);
          const numOnlyMatch = baseSuggested.match(/^(\d+)$/);

          if (prefixMatch) {
            const pref = prefixMatch[1];
            const rawNext = parseInt(prefixMatch[2], 10) + catCounters[seriesKey];
            const padLen = /^0\d+/.test(prefixMatch[2]) ? prefixMatch[2].length : 0;
            const formattedNext = (padLen > 0 && String(rawNext).length < padLen)
              ? String(rawNext).padStart(padLen, '0')
              : String(rawNext);
            defaultSuggestedNum = `${pref}${formattedNext}`;
          } else if (numOnlyMatch) {
            const val = parseInt(numOnlyMatch[1], 10) + catCounters[seriesKey];
            defaultSuggestedNum = String(val);
          }
          catCounters[seriesKey]++;
        }

        const effectiveItemNum = alreadyReceived
          ? (saved.receivedItemNum || saved.itemNum || defaultSuggestedNum)
          : (hasValidManualNum ? saved.itemNum : defaultSuggestedNum);
        const effectiveEsl = (saved && saved.eslId !== undefined) ? saved.eslId : '';
        const effectiveDate = (saved && saved.testDate) ? saved.testDate : todayYmd;
        const effectiveLoc = (saved && saved.location) ? saved.location : (isAssignedDefault ? "Cody's Truck" : 'Helena');
        const effectiveStatus = (saved && saved.status) ? saved.status : (isAssignedDefault ? 'Ready For Delivery' : 'On Shelf');
        const effectiveChecked = alreadyReceived ? false : (saved && saved.checked !== undefined ? !!saved.checked : true);

        units.push({
          category: cat,
          size: effectiveSize,
          classVal: effectiveClass,
          origSize: origSize,
          origClassVal: origClass,
          empName: effectiveEmp,
          suggestedNum: effectiveItemNum,
          defaultSuggestedNum: defaultSuggestedNum,
          eslId: effectiveEsl,
          testDate: effectiveDate,
          location: effectiveLoc,
          status: effectiveStatus,
          checked: effectiveChecked,
          poBucketKey: poBucketKey,
          unitKey: unitKey,
          _savedDraft: saved,
          _alreadyReceived: alreadyReceived,
          orderInfo: item.orderInfo || null,
          origItem: item
        });
      }
    });

    let unitRowsHtml = units.map((u, idx) => {
      const disabledAttr = u._alreadyReceived ? 'disabled' : '';
      const rowClass = u._alreadyReceived ? 'batch-delivery-unit-row is-already-received' : 'batch-delivery-unit-row';

      return `
        <tr class="${rowClass}" data-unit-idx="${idx}" style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 8px 4px; width: 36px; min-width: 36px; text-align: center;">
            <input type="checkbox" class="batch-unit-include" ${u.checked ? 'checked' : ''} ${disabledAttr} onchange="window.procurementEngine.onBatchDeliveryFieldChange()" title="${u._alreadyReceived ? 'Already added to inventory' : 'Include this item when adding to inventory'}" style="cursor: ${u._alreadyReceived ? 'not-allowed' : 'pointer'}; width: 15px; height: 15px;">
          </td>
          <td style="padding: 8px 6px; width: 42px; min-width: 42px; font-weight: 700; color: #38bdf8; text-align: center;">
            <div>#${idx + 1}</div>
            ${u._alreadyReceived ? `<div style="font-size: 9.5px; color: #34d399; font-weight: 700; margin-top: 2px;">✅ Added</div>` : ''}
          </td>
          <td style="padding: 8px 10px; width: 210px; min-width: 200px;">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 4px;">
              <span style="font-weight: 600; color: #f1f5f9; font-size: 13px;">${this.escapeHtml(u.category)}</span>
              ${u.orderInfo?.orderNumber ? `<span style="font-size: 10px; color: #34d399; font-family: monospace;">PO ${this.escapeHtml(u.orderInfo.vendorOrderNumber || u.orderInfo.orderNumber)}</span>` : ''}
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
              <div>
                <input type="text" class="batch-spec-mini-input batch-class" value="${this.escapeHtml(u.classVal)}" ${disabledAttr} oninput="window.procurementEngine.onBatchDeliveryFieldChange()" title="Class / KV" placeholder="Class">
              </div>
              <div>
                <input type="text" class="batch-spec-mini-input batch-size" value="${this.escapeHtml(u.size)}" ${disabledAttr} oninput="window.procurementEngine.onBatchSpecChange(${idx})" title="Size / Type" placeholder="Size / Type">
              </div>
            </div>
          </td>
          <td style="padding: 8px 10px; width: 240px; min-width: 220px;">
            <input type="text" class="batch-delivery-input batch-assigned-to" list="batch-delivery-employees-datalist" value="${this.escapeHtml(u.empName || '')}" ${disabledAttr} oninput="window.procurementEngine.onBatchDeliveryFieldChange()" placeholder="Lineman Name or leave blank for Shelf">
          </td>
          <td style="padding: 8px 10px; width: 115px; min-width: 105px;">
            <input type="text" class="batch-delivery-input batch-item-num" value="${this.escapeHtml(u.suggestedNum)}" data-default-suggested="${this.escapeHtml(u.defaultSuggestedNum)}" ${disabledAttr} oninput="window.procurementEngine.onBatchItemNumInput(this)" style="font-weight: 700; color: #4ade80;" placeholder="Item # *">
          </td>
          <td style="padding: 8px 10px; width: 125px; min-width: 115px;">
            <input type="text" class="batch-delivery-input batch-esl-id" value="${this.escapeHtml(u.eslId || '')}" ${disabledAttr} oninput="window.procurementEngine.onBatchDeliveryFieldChange()" placeholder="Optional ESL ID">
          </td>
          <td style="padding: 8px 10px; width: 140px; min-width: 135px;">
            <input type="date" class="batch-delivery-input batch-test-date" value="${this.escapeHtml(u.testDate || todayYmd)}" ${disabledAttr} onchange="window.procurementEngine.onBatchDeliveryFieldChange()">
          </td>
          <td style="padding: 8px 10px; width: 130px; min-width: 120px;">
            <input type="text" class="batch-delivery-input batch-location" list="batch-delivery-locations-datalist" value="${this.escapeHtml(u.location)}" ${disabledAttr} oninput="window.procurementEngine.onBatchDeliveryFieldChange()" placeholder="Helena">
          </td>
          <td style="padding: 8px 10px; width: 185px; min-width: 180px;">
            <select class="batch-delivery-input batch-status" ${disabledAttr} onchange="window.procurementEngine.onBatchDeliveryFieldChange()">
              <option value="Ready For Delivery" ${u.status === 'Ready For Delivery' ? 'selected' : ''}>Ready For Delivery 🚚</option>
              <option value="Assigned" ${u.status === 'Assigned' ? 'selected' : ''}>Assigned (Direct Hand-off)</option>
              <option value="On Shelf" ${u.status === 'On Shelf' ? 'selected' : ''}>On Shelf</option>
            </select>
          </td>
        </tr>
      `;
    }).join('');

    const skippedTestingUnits = skippedTestingItems.reduce((sum, it) => sum + (parseInt(it.quantity, 10) || 1), 0);
    const skippedNoticeHtml = skippedTestingUnits > 0
      ? `<div style="margin-top: 6px; font-size: 11.5px; color: #6ee7b7;">🧪 Excluded ${skippedTestingUnits} non-inventory Testing / Labor item(s) from receiving (they will still resolve when the PO is completed).</div>`
      : '';

    const draftNoticeHtml = restoredDraftCount > 0
      ? `
        <div style="margin-top: 8px; padding: 8px 12px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 6px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
          <span style="font-size: 12px; color: #fcd34d;">
            💾 <strong>Saved Draft Restored</strong> (${restoredDraftCount} row${restoredDraftCount === 1 ? '' : 's'}${alreadyReceivedCount > 0 ? `, ${alreadyReceivedCount} already added to inventory` : ''}) — uncheck items to receive only part of the order now and come back later for the rest.
          </span>
          <button type="button" class="btn btn-xs" onclick="window.procurementEngine.resetBatchDeliveryDraft()" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #fca5a5; padding: 3px 9px; font-size: 11px; border-radius: 4px; cursor: pointer;">
            ↺ Reset Draft
          </button>
        </div>
      `
      : '';

    body.innerHTML = `
      ${this._buildBatchDatalistsHtml()}
      <div style="margin-bottom: 16px; background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 8px; padding: 14px 18px;">
        <div style="font-weight: 700; font-size: 14px; color: #60a5fa; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
          <span>🚚</span> Batch Delivery Receiving
        </div>
        <div style="font-size: 12px; color: #cbd5e1;">
          Edit any row's specs, <strong>Assign To Lineman</strong>, stamped <strong>Item #</strong>, ESL ID, Test Date, Location, or Status.
          Uncheck items you aren't ready to add yet, or click <strong>Save Progress &amp; Close</strong> anytime to pick up where you left off later.
        </div>
        ${skippedNoticeHtml}
        ${draftNoticeHtml}
      </div>

      <div style="overflow-x: auto; border: 1px solid var(--border-color); border-radius: 6px; margin-bottom: 16px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">
          <thead>
            <tr style="background: rgba(30, 41, 59, 0.85); border-bottom: 2px solid var(--border-color); text-align: left; color: #94a3b8; font-size: 11px; text-transform: uppercase;">
              <th style="padding: 10px 4px; text-align: center; width: 36px; min-width: 36px;">
                <input type="checkbox" id="batch-select-all" checked onchange="window.procurementEngine.toggleAllBatchDeliveryUnits(this.checked)" title="Select / Deselect all pending items" style="cursor: pointer; width: 15px; height: 15px;">
              </th>
              <th style="padding: 10px 6px; text-align: center; width: 42px; min-width: 42px;">#</th>
              <th style="padding: 10px; width: 210px; min-width: 200px;">Item / Class &amp; Size</th>
              <th style="padding: 10px; width: 240px; min-width: 220px;">Assign To Lineman</th>
              <th style="padding: 10px; width: 115px; min-width: 105px;">New Item # *</th>
              <th style="padding: 10px; width: 125px; min-width: 115px;">ESL ID</th>
              <th style="padding: 10px; width: 140px; min-width: 135px;">Test Date *</th>
              <th style="padding: 10px; width: 130px; min-width: 120px;">Location</th>
              <th style="padding: 10px; width: 185px; min-width: 180px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${unitRowsHtml}
          </tbody>
        </table>
      </div>
    `;

    this._pendingDeliveryUnits = units;
    const indicator = document.getElementById('batch-draft-save-indicator');
    if (indicator) indicator.textContent = restoredDraftCount > 0 ? '💾 Draft loaded' : '';
    this._updateBatchDeliveryActionUi();
    modal.style.display = 'flex';
    modal.classList.add('active');
  }

  closeBatchDeliveryModal() {
    const modal = document.getElementById('batch-delivery-modal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.remove('active');
    }
  }

  async confirmBatchDelivery() {
    const rows = document.querySelectorAll('.batch-delivery-unit-row');
    if (!rows.length || !this._pendingDeliveryUnits) {
      alert('⚠️ No delivery units found.');
      return;
    }

    // Save current edits immediately so unchecked rows retain their edits
    const draftStore = this._collectBatchDraftRowsFromDom();
    this._saveBatchDraftStore(draftStore);

    const pendingCheckedIndices = [];
    let pendingTotalCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const u = this._pendingDeliveryUnits[i];
      if (!u || u._alreadyReceived || this.isTestingServiceItem(u)) continue;
      pendingTotalCount++;

      const includeEl = r.querySelector('.batch-unit-include');
      const isIncluded = includeEl ? !!includeEl.checked : true;
      if (!isIncluded) continue;

      const itemNumInput = r.querySelector('.batch-item-num');
      const itemNum = itemNumInput ? itemNumInput.value.trim() : '';
      if (!itemNum) {
        alert(`⚠️ Please provide an Item # for unit #${i + 1} (${u.category}).`);
        if (itemNumInput) itemNumInput.focus();
        return;
      }
      pendingCheckedIndices.push(i);
    }

    if (pendingCheckedIndices.length === 0) {
      alert('⚠️ Please check at least one item to add to inventory (or click "Save Progress & Close" to save your changes for later).');
      return;
    }

    // Pre-check for duplicate Item # within this batch or already present in local inventory
    const seenBatchNums = new Map();
    const resolveCatKey = (catStr) => {
      const cat = String(catStr || '').toLowerCase();
      if (cat.includes('glove')) return 'gloves';
      if (cat.includes('sleeve')) return 'sleeves';
      if (cat.includes('blanket')) return 'blankets';
      if (cat.includes('mack')) return 'macks';
      if (cat.includes('hv') || cat.includes('tester')) return 'hv_testers';
      if (cat.includes('phasing')) return 'phasing_sets';
      if (cat.includes('ground')) return 'grounds';
      if (cat.includes('hot') || cat.includes('stick')) return 'hot_sticks';
      if (cat.includes('aed')) return 'aed';
      return 'gloves';
    };
    for (const i of pendingCheckedIndices) {
      const r = rows[i];
      const u = this._pendingDeliveryUnits[i];
      if (!u || this.isTestingServiceItem(u)) continue;
      const itemNumInput = r.querySelector('.batch-item-num');
      const itemNum = itemNumInput ? itemNumInput.value.trim() : '';
      const ck = resolveCatKey(u.category);
      const batchKey = `${ck}::${itemNum.toLowerCase()}`;
      if (seenBatchNums.has(batchKey)) {
        alert(`⚠️ Duplicate Item #${itemNum} entered in this delivery batch (units #${seenBatchNums.get(batchKey) + 1} and #${i + 1}). Please assign unique item numbers.`);
        if (itemNumInput) itemNumInput.focus();
        return;
      }
      seenBatchNums.set(batchKey, i);

      const invTbl = (this.db && typeof this.db.getTable === 'function') ? this.db.getTable(ck) : null;
      if (invTbl && Array.isArray(invTbl.rows)) {
        const dupExists = invTbl.rows.some(ex => {
          const exNum = String(
            ex['Item #'] || ex['Glove'] || ex['Sleeve'] || ex['Blanket'] || ex['MACK'] ||
            ex['HVT #'] || ex['HV Tester'] || ex['Phasing Set #'] || ex['Phasing Set'] || ex['PS #'] ||
            ex['AED #'] || ex['AED'] || ex['Ground #'] || ex['Hot Stick #'] || ex['Hot Stick'] || ex['Serial #'] || ''
          ).trim().toLowerCase();
          return exNum && exNum === itemNum.toLowerCase();
        });
        if (dupExists) {
          alert(`⚠️ Item #${itemNum} already exists in ${invTbl.name || ck}. Please enter a unique Item # before receiving.`);
          if (itemNumInput) itemNumInput.focus();
          return;
        }
      }
    }

    const uncheckedPendingCount = pendingTotalCount - pendingCheckedIndices.length;
    const isPartialDelivery = uncheckedPendingCount > 0;

    const confirmBtn = document.getElementById('btn-confirm-batch-delivery');
    if (confirmBtn) confirmBtn.textContent = '⏳ Adding to Inventory...';

    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);

      const addedItemsSummary = [];
      const committedUnits = [];
      const formatToMdY = (dStr) => {
        if (!dStr) return '';
        if (dStr.includes('/')) return dStr;
        const parts = dStr.split('-');
        if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`;
        return dStr;
      };

      const now = new Date();
      const todayIso = now.toISOString().split('T')[0];
      const todayStr = formatToMdY(todayIso);
      let anyReadyForDelivery = false;

      for (const i of pendingCheckedIndices) {
        const r = rows[i];
        const u = this._pendingDeliveryUnits[i];
        if (!u || this.isTestingServiceItem(u)) continue;

        const itemNumInput = r.querySelector('.batch-item-num');
        const itemNum = itemNumInput ? itemNumInput.value.trim() : '';
        const classInput = r.querySelector('.batch-class');
        const editedClassVal = (classInput && classInput.value.trim()) ? classInput.value.trim() : (u.classVal || 'Class 2');
        const sizeInput = r.querySelector('.batch-size');
        const editedSize = (sizeInput && sizeInput.value.trim()) ? sizeInput.value.trim() : (u.size || 'Standard');
        const assignedInput = r.querySelector('.batch-assigned-to');
        const assignedTo = assignedInput ? assignedInput.value.trim() : (u.empName || '');
        const eslInput = r.querySelector('.batch-esl-id');
        const eslId = eslInput ? eslInput.value.trim() : '';
        const testDateInput = r.querySelector('.batch-test-date');
        const testDate = formatToMdY(testDateInput?.value) || todayStr;
        const locInput = r.querySelector('.batch-location');
        const location = locInput ? locInput.value.trim() : 'Helena';
        const statSelect = r.querySelector('.batch-status');
        const status = statSelect ? statSelect.value : (assignedTo ? 'Ready For Delivery' : 'On Shelf');

        const isReadyForDelivery = (status === 'Ready For Delivery' || status === 'Ready For Delivery 🚚');
        if (isReadyForDelivery) anyReadyForDelivery = true;
        const invStatus = isReadyForDelivery ? 'Ready For Delivery' : status;
        const invAssignedTo = isReadyForDelivery ? 'Packed For Delivery' : (assignedTo || (invStatus === 'On Shelf' ? 'On Shelf' : ''));
        const invPickedFor = (isReadyForDelivery && assignedTo) ? `${assignedTo} Picked On ${todayIso}` : '';
        const invLocation = isReadyForDelivery ? (location === 'Helena' ? "Cody's Truck" : location) : location;

        const catKey = resolveCatKey(u.category);

        let changeOutDate = '';
        if (window.inventoryManager && typeof window.inventoryManager.calculateChangeOutDate === 'function') {
          changeOutDate = window.inventoryManager.calculateChangeOutDate(todayStr, invLocation, invAssignedTo, catKey, { testDate: testDate });
        } else {
          const d = new Date();
          d.setMonth(d.getMonth() + (isReadyForDelivery ? 3 : 6));
          changeOutDate = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
        }

        let newRow = {};
        if (catKey === 'gloves' || catKey === 'sleeves') {
          const itemHeader = catKey === 'gloves' ? 'Glove' : 'Sleeve';
          newRow = {
            [itemHeader]: itemNum,
            'Item #': itemNum,
            'ESL ID': eslId,
            'Size': editedSize,
            'Class': (editedClassVal || 'Class 2').replace(/[^0-9]/g, '') || '2',
            'Test Date': testDate,
            'Date Assigned': assignedTo ? todayStr : '',
            'Location': invLocation,
            'Status': invStatus,
            'Assigned To': invAssignedTo,
            'Change Out Date': changeOutDate,
            'Picked For': invPickedFor,
            'Notes': 'New'
          };
        } else if (catKey === 'blankets') {
          newRow = {
            'Blanket': itemNum,
            'Item #': itemNum,
            'Type': editedSize || 'Regular',
            'Class': (editedClassVal || 'Class 4').replace(/[^0-9]/g, '') || '4',
            'Test Date': testDate,
            'Date Assigned': assignedTo ? todayStr : testDate,
            'Location': invLocation,
            'Status': invStatus,
            'Assigned To': invAssignedTo,
            'Change Out Date': changeOutDate,
            'Picked For': invPickedFor,
            'Notes': 'New'
          };
        } else if (catKey === 'macks') {
          const kvMatch = String(editedClassVal || '').match(/(\d+\s*kv)/i) || String(editedSize || '').match(/(\d+\s*kv)/i);
          const lenMatch = String(editedSize || '').match(/(\d+\s*(?:ft|'))/i);
          newRow = {
            'MACK': itemNum,
            'Item #': itemNum,
            'ESL ID': eslId || itemNum,
            'KV': kvMatch ? kvMatch[1].toUpperCase().replace(/\s+/g, '') : (editedClassVal && !/^n\/a$/i.test(editedClassVal) ? editedClassVal : '15KV'),
            'Size': editedSize || '1/0',
            'Length': lenMatch ? lenMatch[1] : '8 ft',
            'Test Date': testDate,
            'Date Assigned': assignedTo ? todayStr : testDate,
            'Location': invLocation,
            'Status': invStatus,
            'Assigned To': invAssignedTo,
            'Change Out Date': changeOutDate,
            'Picked For': invPickedFor,
            'Notes': 'New'
          };
        } else if (catKey === 'hv_testers' || catKey === 'phasing_sets') {
          const isHvt = catKey === 'hv_testers';
          newRow = {
            [isHvt ? 'HV Tester' : 'Phasing Set']: itemNum,
            [isHvt ? 'HVT #' : 'PS #']: itemNum,
            'Item #': itemNum,
            'Model': editedSize || '',
            'KV': editedClassVal || '',
            'Serial #': eslId || itemNum,
            'Calibration Date': testDate,
            'Date Assigned': assignedTo ? todayStr : '',
            'Location': invLocation,
            'Status': invStatus,
            'Assigned To': invAssignedTo,
            'Change Out Date': changeOutDate,
            'Picked For': invPickedFor,
            'Notes': 'New'
          };
        } else if (catKey === 'aed') {
          newRow = {
            'AED': itemNum,
            'AED #': itemNum,
            'Item #': itemNum,
            'Model': editedSize || '',
            'Pad Expiration': testDate,
            'Date Assigned': assignedTo ? todayStr : '',
            'Location': invLocation,
            'Status': invStatus,
            'Assigned To': invAssignedTo,
            'Change Out Date': changeOutDate,
            'Picked For': invPickedFor,
            'Notes': 'New'
          };
        } else if (catKey === 'grounds') {
          const lenMatch = String(editedSize || '').match(/(\d+\s*(?:ft|'))/i);
          newRow = {
            'Serial #': itemNum,
            'Ground #': itemNum,
            'Item #': itemNum,
            'Type': 'OH',
            'Size': editedSize || '2/0',
            'KV': editedClassVal || '',
            'Length': lenMatch ? lenMatch[1] : '',
            'Test Date': testDate,
            'Date Assigned': assignedTo ? todayStr : '',
            'Location': invLocation,
            'Status': invStatus,
            'Assigned To': invAssignedTo,
            'Change Out Date': changeOutDate,
            'Picked For': invPickedFor,
            'Notes': 'New'
          };
        } else if (catKey === 'hot_sticks') {
          const lenMatch = String(editedSize || '').match(/(\d+\s*(?:ft|'))/i);
          newRow = {
            'Hot Stick': itemNum,
            'Item #': itemNum,
            'Type': editedSize || 'Switch Stick',
            'Length': lenMatch ? lenMatch[1] : '',
            'Test Date': testDate,
            'Date Assigned': assignedTo ? todayStr : '',
            'Location': invLocation,
            'Status': invStatus,
            'Assigned To': invAssignedTo,
            'Change Out Date': changeOutDate,
            'Picked For': invPickedFor,
            'Notes': 'New'
          };
        } else {
          newRow = {
            'Item #': itemNum,
            'Location': invLocation,
            'Status': invStatus,
            'Assigned To': invAssignedTo,
            'Test Date': testDate,
            'Date Assigned': assignedTo ? todayStr : '',
            'Change Out Date': changeOutDate,
            'Picked For': invPickedFor,
            'Notes': 'New'
          };
        }

        const addOriginNote = isReadyForDelivery
          ? `Packed For Delivery (${assignedTo})`
          : ((assignedTo && !assignedTo.toLowerCase().includes('shelf')) ? `Assigned To (${assignedTo})` : 'New Purchase');
        await this.db.addRow(catKey, newRow, addOriginNote);
        addedItemsSummary.push(`${u.category} #${itemNum} (${isReadyForDelivery ? 'Packed for ' + assignedTo : (assignedTo || 'Shelf')})`);

        if (assignedTo) {
          await this._syncReceivedItemToSwapSheet({
            catKey,
            assignedTo,
            itemNum,
            itemClass: editedClassVal,
            size: editedSize,
            invItemData: newRow,
            isReadyForDelivery,
            snap
          });

          const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
          if (needsTable && needsTable.rows) {
            const nRow = needsTable.rows.find(nr => {
              const meta = this._getSafetyNeedMeta(nr);
              if (!meta) return false;
              return this.isNameMatch(meta.employee, assignedTo) && meta.itemType.toLowerCase().includes(catKey.slice(0, 4));
            });
            if (nRow) {
              await this._queueRowUpdate(needsTable, 'safety_equipment_needs', 'Safety Equipment Needs', nRow, {
                'Status': isReadyForDelivery ? 'Ready For Delivery' : 'Fulfilled',
                'Notes': isReadyForDelivery ? `Packed as #${itemNum} for delivery on ${todayStr}` : `Delivered & added as #${itemNum} on ${todayStr}`
              });
            }
          }
        }
      }

      // Mark committed units in draft store first so partial progress stays accurate
      for (const i of pendingCheckedIndices) {
        const r = rows[i];
        const u = this._pendingDeliveryUnits[i];
        if (!u || this.isTestingServiceItem(u)) continue;
        const itemNumVal = r.querySelector('.batch-item-num')?.value.trim() || u.suggestedNum || '';
        const classVal = r.querySelector('.batch-class')?.value.trim() || u.classVal;
        const sizeVal = r.querySelector('.batch-size')?.value.trim() || u.size;
        const empVal = r.querySelector('.batch-assigned-to')?.value.trim() || '';
        committedUnits.push({
          ...u,
          empName: empVal,
          suggestedNum: itemNumVal,
          classVal,
          size: sizeVal
        });
        const bKey = u.poBucketKey || '_none';
        if (u.unitKey && draftStore[bKey]?.units?.[u.unitKey]) {
          draftStore[bKey].units[u.unitKey] = {
            ...draftStore[bKey].units[u.unitKey],
            received: true,
            receivedItemNum: itemNumVal,
            receivedAt: todayStr,
            checked: false
          };
        }
      }

      const poNums = this._collectBatchPoNumbers();
      const bucketKeys = [...new Set(this._pendingDeliveryUnits.map(u => u.poBucketKey).filter(Boolean))];

      const refreshDeliveryViews = () => {
        if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
          window.ppeTrackingEngine.refresh();
        }
        if (window.inventoryManager && typeof window.inventoryManager.loadData === 'function') {
          window.inventoryManager.loadData();
        }
        if (window.sheetNavigator && typeof window.sheetNavigator.renderActiveView === 'function') {
          window.sheetNavigator.renderActiveView();
        }
        if (window.tripPlanner && typeof window.tripPlanner.renderPickedSwapsList === 'function') {
          window.tripPlanner.renderPickedSwapsList();
        }
      };

      if (isPartialDelivery) {
        this._saveBatchDraftStore(draftStore);
        // Mark matching open PO rows as Partially Received so partial receipts are reflected in Order History & sync
        const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
        if (poTable && Array.isArray(poTable.rows) && poNums.length > 0) {
          const poNumLowerSet = new Set(poNums.map(p => String(p || '').trim().toLowerCase()).filter(Boolean));
          for (const po of poTable.rows) {
            const pNum = String(po['PO Number'] || po['PO #'] || '').trim();
            const pStat = String(po['Status'] || '').toLowerCase();
            if (pNum && poNumLowerSet.has(pNum.toLowerCase()) && !pStat.includes('received') && !pStat.includes('cancel')) {
              const nextNotes = `${po['Notes'] || ''}; Partial delivery (${addedItemsSummary.length} unit(s)) on ${todayStr}`.trim().replace(/^;\s*/, '');
              await this._queueRowUpdate(poTable, 'purchase_orders', 'Purchase Orders', po, {
                'Status': 'Partially Received',
                'Notes': nextNotes
              }, pNum);
            }
          }
        }
        this.closeBatchDeliveryModal();
        await this.loadData();
        refreshDeliveryViews();

        alert(
          `✅ Added ${addedItemsSummary.length} item(s) to inventory!\n\n` +
          addedItemsSummary.join('\n') +
          `\n\n💾 ${uncheckedPendingCount} remaining item(s) saved in draft so you can finish receiving this order later.`
        );
      } else {
        // Resolve and clear all matching line items across swap sheets, safety equipment needs, and purchase orders
        const assignedEmps = committedUnits.map(u => u.empName).filter(Boolean);

        await this.resolveReceivedOrderItems(poNums, {
          units: committedUnits,
          assignedEmployees: assignedEmps,
          isReadyForDelivery: anyReadyForDelivery,
          todayStr: todayStr
        });

        this._clearBatchDraftsForPoNums(poNums, bucketKeys);
        this.closeBatchDeliveryModal();
        await this.loadData();
        refreshDeliveryViews();

        alert(`✅ Successfully received and created ${addedItemsSummary.length} inventory item(s)!\n\n` + addedItemsSummary.join('\n'));
      }
    } catch (err) {
      console.error('Error confirming batch delivery:', err);
      alert('❌ Failed to process batch delivery: ' + (err.message || err));
    } finally {
      this._updateBatchDeliveryActionUi();
    }
  }

  async confirmMarkDeliveredWithoutInventory() {
    if (!this._pendingDeliveryUnits || !this._pendingDeliveryUnits.length) {
      alert('⚠️ No delivery units found.');
      return;
    }

    if (!confirm('Mark this order as Received / Delivered WITHOUT adding new items to the inventory sheets?\n\nUse this when the items have already been manually entered into the Gloves/Sleeves sheets previously. It will resolve the PO in tracking history and clear it from Awaiting Delivery.')) {
      return;
    }

    const noInvBtn = document.getElementById('btn-mark-delivered-no-inv');
    if (noInvBtn) noInvBtn.textContent = '⏳ Marking Delivered...';

    try {
      const todayStr = this.formatToMdY ? this.formatToMdY(new Date().toISOString().split('T')[0]) : new Date().toLocaleDateString();

      // Collect all PO numbers and assigned employees from pending units + skipped service items
      const poNums = this._collectBatchPoNumbers();
      const bucketKeys = [...new Set(this._pendingDeliveryUnits.map(u => u.poBucketKey).filter(Boolean))];
      const assignedEmps = this._pendingDeliveryUnits.map(u => u.empName).filter(Boolean);

      await this.resolveReceivedOrderItems(poNums, {
        units: this._pendingDeliveryUnits,
        assignedEmployees: assignedEmps,
        isReadyForDelivery: false,
        todayStr: todayStr
      });

      this._clearBatchDraftsForPoNums(poNums, bucketKeys);
      this.closeBatchDeliveryModal();
      await this.loadData();
      this.render();

      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }

      alert('✅ Order marked as Received/Delivered and cleared from All Needs & Orders.');
    } catch (err) {
      console.error('Error marking delivered without inventory:', err);
      alert('❌ Failed to update order: ' + (err.message || err));
    } finally {
      if (noInvBtn) noInvBtn.innerHTML = '<span>✅</span> Mark Delivered Only (Already Added to Inventory)';
    }
  }

  openDeliverForEmployee(empName, itemType, preferredSize) {
    const norm = this.cleanEmployeeName(empName);
    const cat = (itemType || '').toLowerCase();
    const cfg = this._getAllSwapTableConfigs().find(c => cat.includes(c.cat) || c.type.toLowerCase() === cat || c.invKey === cat);
    const targetType = cfg ? cfg.type : (cat.includes('glove') ? 'Gloves' : 'Sleeves');
    const typeLabelMap = {
      'Gloves': '🧤 Gloves',
      'Sleeves': '🦺 Sleeves',
      'Blankets': '🧱 Blankets',
      'MACKs': '🔶 MACKs',
      'HV Testers': '⚡ HV Testers',
      'Phasing Sets': '⚡ Phasing Sets',
      'AED': '❤️ AED',
      'Grounds': '⚡ Grounds',
      'Hot Sticks': '🦯 Hot Sticks'
    };

    const match = this.items.find(i => {
      if (i.section !== 'ordered_pending') return false;
      if (!i.itemType.toLowerCase().includes(targetType.toLowerCase().slice(0, 4))) return false;
      if (i.employees && i.employees.some(e => this.isNameMatch(e.name, norm))) return true;
      return false;
    });

    if (match) {
      const matchedEmp = (match.employees || []).find(e => this.isNameMatch(e.name, norm)) || { name: empName, label: empName, checked: true };
      const isolatedItem = {
        ...match,
        quantity: 1,
        employees: [{ ...matchedEmp, checked: true }]
      };
      this.openBatchDeliveryModal([isolatedItem]);
    } else {
      const isRubber = targetType === 'Gloves' || targetType === 'Sleeves';
      const classVal = (isRubber && window.ppeTrackingEngine && typeof window.ppeTrackingEngine.getPreferredPpeClass === 'function')
        ? window.ppeTrackingEngine.getPreferredPpeClass(empName, targetType.toLowerCase())
        : (targetType === 'Blankets' ? 'Class 4' : 'Class 2');

      const singleItem = {
        section: 'ordered_pending',
        itemType: targetType,
        typeLabel: typeLabelMap[targetType] || `📦 ${targetType}`,
        size: (preferredSize && preferredSize !== '—') ? preferredSize : (targetType === 'Gloves' ? '10' : 'Regular'),
        classVal: classVal,
        quantity: 1,
        employees: [{ name: empName, label: empName, checked: true }],
        orderInfo: this.lookupOrderForEmployee(empName, targetType) || { orderNumber: '', vendor: '' }
      };
      this.openBatchDeliveryModal([singleItem]);
    }
  }

  // =========================================================================
  // ADD PAST ORDER MODAL & ORDERS HISTORY
  // =========================================================================

  openAddPastOrderModal() {
    const modal = document.getElementById('add-past-order-modal');
    const body = document.getElementById('add-past-order-modal-body');
    if (!modal || !body) return;

    const todayYmd = new Date().toISOString().split('T')[0];
    const vendorOptions = this.vendors.map(v => `<option value="${this.escapeHtml(v.name)}">${this.escapeHtml(v.name)}</option>`).join('');

    body.innerHTML = `
      <div style="margin-bottom: 16px; background: rgba(71, 85, 105, 0.15); border: 1px solid rgba(71, 85, 105, 0.35); border-radius: 8px; padding: 12px 16px;">
        <div style="font-weight: 700; font-size: 13.5px; color: #cbd5e1; margin-bottom: 3px; display: flex; align-items: center; gap: 8px;">
          <span>➕</span> Manually Log Past or External Order
        </div>
        <div style="font-size: 12px; color: #94a3b8;">
          Record past orders into the system tracking log. If you enter purchase prices for items, they will automatically synchronize with the vendor catalog.
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px;">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Order # *</label>
          <input type="text" id="past-order-po-num" class="batch-delivery-input" placeholder="e.g. 0819764" style="font-weight: 700; color: #38bdf8;">
          <div style="font-size: 11px; color: #64748b; margin-top: 2px;">Order number from vendor</div>
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Vendor *</label>
          <select id="past-order-vendor-select" class="batch-delivery-input" onchange="window.procurementEngine.onPastOrderVendorChange(this.value)">
            ${vendorOptions}
            <option value="__custom__">➕ New / Custom Vendor...</option>
          </select>
          <input type="text" id="past-order-custom-vendor" class="batch-delivery-input" placeholder="Enter vendor name..." style="display: none; margin-top: 6px;">
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 14px;">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Order Date *</label>
          <input type="date" id="past-order-date" class="batch-delivery-input" value="${todayYmd}">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Delivery Date</label>
          <input type="date" id="past-order-deliv-date" class="batch-delivery-input" value="${todayYmd}">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Status *</label>
          <select id="past-order-status" class="batch-delivery-input">
            <option value="Received" selected>Received (Delivered)</option>
            <option value="Ordered">Ordered (Awaiting Delivery)</option>
            <option value="Partially Received">Partially Received</option>
            <option value="Cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px;">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Total Order Cost ($)</label>
          <input type="number" step="0.01" min="0" id="past-order-total-price" class="batch-delivery-input" placeholder="0.00" style="font-weight: 700; color: #34d399;">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Item Summary / Description *</label>
          <input type="text" id="past-order-items" class="batch-delivery-input" placeholder="e.g. (4) Class 2 Gloves, Size 10; (2) Class 2 Sleeves, Regular">
        </div>
      </div>

      <div style="margin-bottom: 10px;">
        <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Notes & Reference Info</label>
        <textarea id="past-order-notes" class="batch-delivery-input" rows="3" placeholder="Additional details, invoice number, or recipient notes..."></textarea>
      </div>
    `;

    modal.style.display = 'flex';
    modal.classList.add('active');
  }

  closeAddPastOrderModal() {
    const modal = document.getElementById('add-past-order-modal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.remove('active');
    }
  }

  /**
   * Syncs a received order item into the matching Swap sheet without crossing rubber classes
   * (creating a New Assignment row for Class 3/0 items when an employee keeps existing Class 2 gear).
   */
  async _syncReceivedItemToSwapSheet({ catKey, assignedTo, itemNum, itemClass = '', size = '', invItemData = null, isReadyForDelivery = true, snap = null } = {}) {
    if (!assignedTo || !itemNum) return;
    const swapKey = this._getSwapTableKeyForCategory(catKey);
    if (!swapKey) return;

    const parseOrderClass = (c) => {
      if (c === undefined || c === null || c === '') return null;
      const m = String(c).match(/\d+/);
      return m ? parseInt(m[0], 10) : null;
    };
    const isRubber = (catKey === 'gloves' || catKey === 'sleeves');
    const orderClass = isRubber ? parseOrderClass(itemClass || (invItemData && invItemData['Class'])) : null;
    const invTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(catKey) : null) || snap?.tables?.[catKey];
    const swapTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(swapKey) : null) || snap?.tables?.[swapKey];

    let updatedExisting = false;
    if (swapTable && Array.isArray(swapTable.rows)) {
      const sRow = swapTable.rows.find(sr => {
        const name = String(sr['Employee'] || sr['Employee Name'] || sr['Crew Lead / Employee'] || sr['Assigned To'] || Object.values(sr)[0] || '').trim();
        const empMatch = this.isNameMatch(name, assignedTo) ||
          (typeof window !== 'undefined' && window.employeeResolver && typeof window.employeeResolver.areSameEmployee === 'function' && window.employeeResolver.areSameEmployee(name, assignedTo));
        if (!empMatch) return false;
        if (String(sr['Date Changed'] || '').trim()) return false;
        const statLower = String(sr['Status'] || '').toLowerCase();
        if (statLower.includes('return') || statLower.includes('reclaim') || statLower.includes('locate')) return false;

        if (isRubber && orderClass !== null) {
          const oldNum = String(sr['Current Glove #'] || sr['Current Sleeve #'] || sr['Current Item #'] || sr['Current Item'] || '').trim();
          let srClass = parseOrderClass(sr['Class']);
          if (oldNum && invTable && Array.isArray(invTable.rows)) {
            const oldInv = invTable.rows.find(it => String(it['Item #'] || it['Glove'] || it['Sleeve'] || it['ESL ID'] || '').trim() === oldNum);
            if (oldInv) srClass = parseOrderClass(oldInv['Class']);
          }
          if (srClass !== null && srClass !== orderClass) return false;
        }
        return true;
      });

      if (sRow) {
        updatedExisting = true;
        const oldItemNum = String(sRow['Current Glove #'] || sRow['Current Sleeve #'] || sRow['Current Blanket #'] || sRow['Current MACK #'] || sRow['Current Item #'] || sRow['Current Item'] || sRow['Serial #'] || '').trim();
        const targetStatus = isReadyForDelivery ? 'Ready For Delivery 🚚' : 'Complete';
        const hasValidPickNum = Boolean(itemNum && itemNum !== '—' && itemNum !== '-');

        // Queue Pick List BEFORE Status, and only set Picked = true when Ready For Delivery with a real Pick List item #
        if (hasValidPickNum) {
          await this._queueCellMutation(swapTable, swapKey, sRow, 'pickList', itemNum);
          sRow['Pick List Item #'] = itemNum;
          sRow['Picked For'] = itemNum;
        }
        await this._queueCellMutation(swapTable, swapKey, sRow, 'status', targetStatus);
        sRow['Status'] = targetStatus;

        if (isReadyForDelivery && hasValidPickNum) {
          await this._queueCellMutation(swapTable, swapKey, sRow, 'picked', true);
          sRow['Picked'] = true;
          if (typeof this.db.saveManualPick === 'function') {
            this.db.saveManualPick(swapKey, assignedTo, oldItemNum, itemNum, 'Ready For Delivery 🚚', true);
          }
        }
      }
    }

    if (!updatedExisting && isRubber && isReadyForDelivery) {
      if (typeof window !== 'undefined' && window.swapEngine && typeof window.swapEngine.upsertNewAssignmentSwapRow === 'function') {
        await window.swapEngine.upsertNewAssignmentSwapRow(swapKey, {
          empName: assignedTo,
          itemNum,
          itemClass,
          size,
          invItemData
        });
      } else if (this.db && typeof this.db.saveManualPick === 'function') {
        this.db.saveManualPick(swapKey, assignedTo, '', itemNum, 'Ready For Delivery 🚚', true);
      }
    }
  }

  onPastOrderVendorChange(val) {
    const custom = document.getElementById('past-order-custom-vendor');
    if (!custom) return;
    if (val === '__custom__') {
      custom.style.display = 'block';
      custom.focus();
    } else {
      custom.style.display = 'none';
    }
  }

  async confirmAddPastOrder() {
    const poNumInput = document.getElementById('past-order-po-num');
    let orderNum = poNumInput ? poNumInput.value.trim() : '';

    if (!orderNum) {
      orderNum = this.generateNextRequestPoNumber();
      if (poNumInput) poNumInput.value = orderNum;
    }
    const poNum = orderNum;

    const vSelect = document.getElementById('past-order-vendor-select');
    let vendorName = vSelect ? vSelect.value : '';
    if (vendorName === '__custom__') {
      const customV = document.getElementById('past-order-custom-vendor');
      vendorName = customV ? customV.value.trim() : '';
    }
    if (!vendorName) {
      alert('⚠️ Please select or enter a Vendor.');
      return;
    }

    const orderDateInput = document.getElementById('past-order-date');
    const orderDate = orderDateInput ? orderDateInput.value : '';
    const delivDateInput = document.getElementById('past-order-deliv-date');
    const delivDate = delivDateInput ? delivDateInput.value : '';
    const statusSelect = document.getElementById('past-order-status');
    const status = statusSelect ? statusSelect.value : 'Received';
    const priceInput = document.getElementById('past-order-total-price');
    const totalPrice = parseFloat(priceInput?.value) || 0;
    const itemsInput = document.getElementById('past-order-items');
    const itemsStr = itemsInput ? itemsInput.value.trim() : '';
    if (!itemsStr) {
      alert('⚠️ Please enter an item summary or description.');
      if (itemsInput) itemsInput.focus();
      return;
    }
    const notesInput = document.getElementById('past-order-notes');
    const notes = notesInput ? notesInput.value.trim() : '';

    let finalNotes = notes;
    if (finalNotes.toLowerCase().includes('order #:')) {
      finalNotes = finalNotes.replace(/order #:\s*[^;,]+/i, `Order #: ${orderNum}`);
    } else if (orderNum && !finalNotes.includes(orderNum)) {
      finalNotes = finalNotes ? `${finalNotes}; Order #: ${orderNum}` : `Order #: ${orderNum}`;
    }

    const formatToMdY = (dStr) => {
      if (!dStr) return '';
      if (dStr.includes('/')) return dStr;
      const parts = dStr.split('-');
      if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`;
      return dStr;
    };

    const confirmBtn = document.getElementById('btn-confirm-add-past-order');
    if (confirmBtn) {
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = '⏳ Saving...';
    }

    try {
      const rowObj = {
        'Date': formatToMdY(orderDate) || new Date().toLocaleDateString(),
        'PO Number': poNum,
        'Vendor': vendorName,
        'Items': itemsStr,
        'Total Price': totalPrice > 0 ? totalPrice : 0,
        'Expected Delivery': formatToMdY(delivDate) || (status === 'Received' ? 'Delivered' : 'Pending'),
        'Status': status,
        'Notes': finalNotes || 'Manually logged past order'
      };

      const parsedItems = this.parsePoItemsString(itemsStr);
      for (const pi of parsedItems) {
        if (pi.unitPrice > 0) {
          await this.syncVendorPrice(vendorName, pi.category, pi.size, pi.classVal, pi.unitPrice);
        }
      }

      await this.db.addRow('purchase_orders', rowObj, 'Manual Past Order');

      if (status === 'Received') {
        const assignedEmps = parsedItems
          .flatMap(it => String(it.employeeName || '').split(',').map(s => s.trim()))
          .filter(Boolean);
        await this.resolveReceivedOrderItems(poNum, {
          assignedEmployees: assignedEmps,
          isReadyForDelivery: false,
          todayStr: formatToMdY(delivDate) || new Date().toLocaleDateString()
        });
      }

      this.closeAddPastOrderModal();
      await this.loadData();
      this.render();

      alert(`✅ Past Purchase Order #${poNum} logged successfully!`);
    } catch (err) {
      console.error('Error logging past order:', err);
      alert('❌ Failed to save past order: ' + (err.message || err));
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<span>💾</span> Save Order to Tracking Log';
      }
    }
  }

  renderOrdersHistory(container, tabsHtml = '') {
    if (!tabsHtml) {
      tabsHtml = this.getSectionTabsHtml('history', this.getSectionCounts());
    }

    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);

    const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
    const rows = poTable ? (poTable.rows || poTable.rawGrid || []) : [];

    let totalSpend = 0;
    let openCount = 0;
    let completedCount = 0;

    const poList = [];
    rows.forEach((r, idx) => {
      let date = '';
      let poNum = '';
      let vendor = '';
      let items = '';
      let price = 0;
      let expDeliv = '';
      let status = '';
      let notes = '';

      if (Array.isArray(r)) {
        if (String(r[0] || '').toLowerCase() === 'date') return;
        date = String(r[0] || '').trim();
        poNum = String(r[1] || '').trim();
        vendor = String(r[2] || '').trim();
        items = String(r[3] || '').trim();
        price = parseFloat(r[4]) || 0;
        expDeliv = String(r[5] || '').trim();
        status = String(r[6] || '').trim();
        notes = String(r[7] || '').trim();
      } else if (r && typeof r === 'object') {
        date = String(r['Date'] || '').trim();
        poNum = String(r['PO Number'] || r['PO #'] || '').trim();
        vendor = String(r['Vendor'] || '').trim();
        items = String(r['Items'] || '').trim();
        price = parseFloat(r['Total Price'] || r['Price'] || 0) || 0;
        expDeliv = String(r['Expected Delivery'] || '').trim();
        status = String(r['Status'] || '').trim();
        notes = String(r['Notes'] || '').trim();
      }

      if (!poNum && !vendor && !items) return;

      const statLower = status.toLowerCase();
      if (!statLower.includes('cancel')) {
        totalSpend += price;
      }
      if (statLower.includes('partial')) {
        openCount++;
      } else if (statLower.includes('received') || statLower.includes('fulfilled')) {
        completedCount++;
      } else if (statLower.includes('ordered') || statLower.includes('pending')) {
        openCount++;
      }

      const rowIdx = (r && r._rowIdx) ? r._rowIdx : (idx + 2);
      const parsedNotes = this.parseOrderInfoFromNotes(notes);
      const vendorOrderNum = parsedNotes?.vendorOrderNumber || '';
      poList.push({ rowIdx, date, poNum, vendorOrderNum, vendor, items, price, expDeliv, status, notes, raw: r });
    });

    // Default sort order is Date descending (newest first)
    if (!this.historySortCol) this.historySortCol = 'date';
    if (!this.historySortDir) this.historySortDir = 'desc';

    poList.sort((a, b) => {
      if (this.historySortCol === 'date') {
        const timeA = this.parseDateForSort(a.date);
        const timeB = this.parseDateForSort(b.date);
        if (timeA !== timeB) {
          return this.historySortDir === 'asc' ? timeA - timeB : timeB - timeA;
        }
        return this.historySortDir === 'asc' ? a.rowIdx - b.rowIdx : b.rowIdx - a.rowIdx;
      }
      if (this.historySortCol === 'po') {
        const valA = String(a.poNum || '').toLowerCase();
        const valB = String(b.poNum || '').toLowerCase();
        const cmp = valA.localeCompare(valB, undefined, { numeric: true });
        if (cmp !== 0) return this.historySortDir === 'asc' ? cmp : -cmp;
        return a.rowIdx - b.rowIdx;
      }
      if (this.historySortCol === 'vendor') {
        const valA = String(a.vendor || '').toLowerCase();
        const valB = String(b.vendor || '').toLowerCase();
        const cmp = valA.localeCompare(valB);
        if (cmp !== 0) return this.historySortDir === 'asc' ? cmp : -cmp;
        return a.rowIdx - b.rowIdx;
      }
      if (this.historySortCol === 'price') {
        const pA = a.price || 0;
        const pB = b.price || 0;
        if (pA !== pB) return this.historySortDir === 'asc' ? pA - pB : pB - pA;
        return a.rowIdx - b.rowIdx;
      }
      if (this.historySortCol === 'status') {
        const valA = String(a.status || '').toLowerCase();
        const valB = String(b.status || '').toLowerCase();
        const cmp = valA.localeCompare(valB);
        if (cmp !== 0) return this.historySortDir === 'asc' ? cmp : -cmp;
        return a.rowIdx - b.rowIdx;
      }
      return 0;
    });

    this.poHistoryList = poList;

    let tableRows = '';
    if (poList.length === 0) {
      tableRows = `
        <tr>
          <td colspan="7" style="padding: 30px; text-align: center; color: #64748b;">
            No purchase orders currently recorded in history. Click <strong>"➕ Add Past Order"</strong> above to record orders.
          </td>
        </tr>
      `;
    } else {
      tableRows = poList.map((po, poHistoryIdx) => {
        const statLower = po.status.toLowerCase();
        let badgeStyle = 'background: rgba(100, 116, 139, 0.2); color: #94a3b8; border: 1px solid rgba(100, 116, 139, 0.4);';
        let badgeIcon = '📄';

        if (statLower.includes('received') || statLower.includes('fulfilled')) {
          badgeStyle = 'background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4);';
          badgeIcon = '✅';
        } else if (statLower.includes('ordered')) {
          badgeStyle = 'background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4);';
          badgeIcon = '📦';
        } else if (statLower.includes('partial')) {
          badgeStyle = 'background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4);';
          badgeIcon = '🔄';
        }

        const isDeliverable = statLower.includes('ordered') || statLower.includes('partial');

        return `
          <tr style="border-bottom: 1px solid var(--border-color);">
            <td style="padding: 10px 12px; font-family: monospace; font-size: 12px; color: #94a3b8;">
              ${this.escapeHtml(po.date)}
            </td>
            <td style="padding: 10px 12px; font-size: 13px;">
              <div style="font-weight: 700; color: #38bdf8; display: flex; align-items: center; gap: 6px;">
                ${this.escapeHtml(po.vendorOrderNum || po.poNum || '—')}
                ${(/^REQ-/i.test(po.vendorOrderNum || po.poNum || '') || /pending/i.test(po.vendorOrderNum || po.poNum || '')) ? `
                  <span class="badge" style="background: rgba(245, 158, 11, 0.2); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.45); font-size: 10px; padding: 1px 5px; border-radius: 3px;">Request</span>
                ` : ''}
              </div>
            </td>
            <td style="padding: 10px 12px; font-weight: 600; color: #f1f5f9;">
              ${this.escapeHtml(po.vendor || '—')}
            </td>
            <td style="padding: 10px 12px; font-size: 12px; max-width: 380px;">
              <div style="color: #cbd5e1;">${this.escapeHtml(po.items)}</div>
              ${po.notes ? `<div style="font-size: 11px; color: #64748b; margin-top: 2px;">${this.escapeHtml(po.notes)}</div>` : ''}
              ${po.expDeliv && po.expDeliv !== 'Pending' ? `<div style="font-size: 11px; color: #38bdf8; margin-top: 2px;">🚚 Deliv: ${this.escapeHtml(po.expDeliv)}</div>` : ''}
            </td>
            <td style="padding: 10px 12px; text-align: right; font-weight: 700; font-family: monospace; color: ${po.price > 0 ? '#34d399' : '#64748b'};">
              ${po.price > 0 ? `$${po.price.toFixed(2)}` : '—'}
            </td>
            <td style="padding: 10px 12px; text-align: center;">
              <span class="badge" style="${badgeStyle} font-size: 11px; padding: 3px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;">
                <span>${badgeIcon}</span> ${this.escapeHtml(po.status || 'Ordered')}
              </span>
            </td>
            <td style="padding: 8px 10px; text-align: center;">
              <div style="display: flex; align-items: center; justify-content: center; gap: 4px; flex-wrap: wrap;">
                ${isDeliverable ? `
                  <button class="btn btn-xs" onclick="window.procurementEngine.openBatchDeliveryModalForPo('${this.escapeJs(po.vendorOrderNum || po.poNum)}')" style="background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.4); color: #93c5fd; padding: 3px 7px; font-size: 11px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Receive items and generate inventory serial numbers on Gloves/Sleeves page">
                    <span>🚚</span> Receive
                  </button>
                  <button class="btn btn-xs" onclick="window.procurementEngine.quickMarkOrderReceived(${po.rowIdx}, '${this.escapeJs(po.vendorOrderNum || po.poNum)}')" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #6ee7b7; padding: 3px 7px; font-size: 11px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Quick mark as Received and clear all matching line items from All Needs & Orders">
                    <span>✅</span> Mark Rec'd
                  </button>
                ` : ''}
                ${(/^REQ-/i.test(po.vendorOrderNum || po.poNum || '') || /pending/i.test(po.vendorOrderNum || po.poNum || '')) ? `
                  <button class="btn btn-xs" onclick="window.procurementEngine.promptUpdateVendorOrderNum('${this.escapeJs(po.vendorOrderNum || po.poNum)}')" style="background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.45); color: #fcd34d; padding: 3px 7px; font-size: 11px; border-radius: 3px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Update this Request with official Vendor Order # once received">
                    <span>🏷️</span> Vendor #
                  </button>
                ` : ''}
                <button class="btn btn-xs" onclick="window.procurementEngine.emailOrderFromHistory(${poHistoryIdx})" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #6ee7b7; padding: 3px 7px; font-size: 11px; border-radius: 3px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Email this purchase order / request to vendor">
                  <span>✉️</span> Email
                </button>
                <button class="btn btn-xs" onclick="window.procurementEngine.openEditOrderModal(${poHistoryIdx})" style="background: rgba(148, 163, 184, 0.15); border: 1px solid rgba(148, 163, 184, 0.35); color: #cbd5e1; padding: 3px 7px; font-size: 11px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Edit Order #, Vendor, Dates, or Details">
                  <span>✏️</span> Edit
                </button>
                <button class="btn btn-xs" onclick="window.procurementEngine.deleteOrder(${po.rowIdx}, '${this.escapeJs(po.vendorOrderNum || po.poNum)}')" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #f87171; padding: 3px 7px; font-size: 11px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Delete this order from tracking history">
                  <span>🗑️</span> Delete
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    container.innerHTML = tabsHtml + `
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; padding: 14px 18px; background: rgba(30, 41, 59, 0.7); border: 1px solid var(--border-color); border-radius: 8px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 20px;">📜</span>
          <div>
            <div style="font-weight: 800; font-size: 15px; color: #f1f5f9;">PURCHASE ORDERS TRACKING & HISTORY</div>
            <div style="font-size: 12px; color: #94a3b8;">Full historical log of placed, delivered, and past purchase orders with suppliers</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <div style="display: flex; gap: 8px;">
            <span class="brand-badge" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35); font-size: 11.5px; padding: 4px 10px;">
              Total Orders: <strong>${poList.length}</strong>
            </span>
            <span class="brand-badge" style="background: rgba(245, 158, 11, 0.15); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.35); font-size: 11.5px; padding: 4px 10px;">
              Open: <strong>${openCount}</strong>
            </span>
            <span class="brand-badge" style="background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.35); font-size: 11.5px; padding: 4px 10px;">
              Delivered: <strong>${completedCount}</strong>
            </span>
            <span class="brand-badge" style="background: rgba(168, 85, 247, 0.15); color: #d8b4fe; border: 1px solid rgba(168, 85, 247, 0.35); font-size: 11.5px; padding: 4px 10px;">
              Total Spend: <strong>$${totalSpend.toFixed(2)}</strong>
            </span>
          </div>
          <button class="btn btn-primary" onclick="window.procurementEngine.openCreateOrderModal()" style="display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 6px 14px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); border: none; box-shadow: 0 2px 6px rgba(59, 130, 246, 0.35); color: #fff; font-weight: 700;">
            <span>➕</span> Create Order
          </button>
          <button class="btn btn-secondary" onclick="window.procurementEngine.openAddPastOrderModal()" style="display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 6px 12px;">
            <span>📜</span> Log Past Order
          </button>
        </div>
      </div>

      <div style="overflow-x: auto; border: 1px solid var(--border-color); border-radius: 6px;">
        <table class="procurement-orders-table" style="width: 100%; border-collapse: collapse; font-size: 12.5px;">
          <thead>
            <tr style="user-select: none;">
              <th style="width: 105px; cursor: pointer; color: ${this.historySortCol === 'date' ? '#38bdf8' : 'inherit'};" onclick="window.procurementEngine.toggleHistorySort('date')" title="Click to sort by Date (${this.historySortCol === 'date' && this.historySortDir === 'desc' ? 'Currently Newest First' : 'Currently Oldest First'})">
                <div style="display: flex; align-items: center; gap: 4px;">
                  <span>Date</span>
                  <span style="font-size: 11px; opacity: ${this.historySortCol === 'date' ? '1' : '0.4'};">${this.historySortCol === 'date' ? (this.historySortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                </div>
              </th>
              <th style="width: 135px; cursor: pointer; color: ${this.historySortCol === 'po' ? '#38bdf8' : 'inherit'};" onclick="window.procurementEngine.toggleHistorySort('po')" title="Click to sort by Order Number">
                <div style="display: flex; align-items: center; gap: 4px;">
                  <span>Order #</span>
                  <span style="font-size: 11px; opacity: ${this.historySortCol === 'po' ? '1' : '0.4'};">${this.historySortCol === 'po' ? (this.historySortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                </div>
              </th>
              <th style="width: 150px; cursor: pointer; color: ${this.historySortCol === 'vendor' ? '#38bdf8' : 'inherit'};" onclick="window.procurementEngine.toggleHistorySort('vendor')" title="Click to sort by Vendor">
                <div style="display: flex; align-items: center; gap: 4px;">
                  <span>Vendor</span>
                  <span style="font-size: 11px; opacity: ${this.historySortCol === 'vendor' ? '1' : '0.4'};">${this.historySortCol === 'vendor' ? (this.historySortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                </div>
              </th>
              <th>Items & Order Details</th>
              <th style="text-align: right; width: 115px; cursor: pointer; color: ${this.historySortCol === 'price' ? '#38bdf8' : 'inherit'};" onclick="window.procurementEngine.toggleHistorySort('price')" title="Click to sort by Total Price">
                <div style="display: flex; align-items: center; justify-content: flex-end; gap: 4px;">
                  <span>Total Price</span>
                  <span style="font-size: 11px; opacity: ${this.historySortCol === 'price' ? '1' : '0.4'};">${this.historySortCol === 'price' ? (this.historySortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                </div>
              </th>
              <th style="text-align: center; width: 120px; cursor: pointer; color: ${this.historySortCol === 'status' ? '#38bdf8' : 'inherit'};" onclick="window.procurementEngine.toggleHistorySort('status')" title="Click to sort by Status">
                <div style="display: flex; align-items: center; justify-content: center; gap: 4px;">
                  <span>Status</span>
                  <span style="font-size: 11px; opacity: ${this.historySortCol === 'status' ? '1' : '0.4'};">${this.historySortCol === 'status' ? (this.historySortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                </div>
              </th>
              <th style="text-align: center; width: 200px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    `;
  }

  toggleHistorySort(col) {
    if (this.historySortCol === col) {
      this.historySortDir = this.historySortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.historySortCol = col;
      this.historySortDir = (col === 'date' || col === 'price') ? 'desc' : 'asc';
    }
    const container = document.getElementById('procurement-items-table');
    if (container) {
      this.renderOrdersHistory(container);
    }
  }

  async quickMarkOrderReceived(rowIdx, poNum) {
    if (!confirm(`Mark Order #${poNum || ''} as Received?\n\nThis will update the order tracking status to "Received" and clear all matching line items from All Needs & Orders WITHOUT adding duplicate items to the Gloves/Sleeves inventory page.`)) {
      return;
    }

    try {
      const todayStr = this.formatToMdY ? this.formatToMdY(new Date().toISOString().split('T')[0]) : new Date().toLocaleDateString();

      await this.resolveReceivedOrderItems(poNum, {
        poRowIdx: rowIdx,
        isReadyForDelivery: false,
        todayStr: todayStr
      });

      await this.loadData();
      this.render();

      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }

      alert(`✅ Order #${poNum || ''} marked as Received and cleared from All Needs & Orders!`);
    } catch (err) {
      console.error('Error marking order received:', err);
      alert('❌ Failed to update order status: ' + (err.message || err));
    }
  }

  generateNextRequestPoNumber() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const datePrefix = `REQ-${yyyy}${mm}${dd}-`;

    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];

    let maxSeq = 0;
    const checkString = (str) => {
      if (!str) return;
      const re = new RegExp(`${datePrefix}(\\d+)`, 'i');
      const match = String(str).match(re);
      if (match) {
        const seq = parseInt(match[1], 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    };

    if (poTable && poTable.rows) {
      poTable.rows.forEach(r => {
        checkString(r['PO Number']);
        checkString(r['PO #']);
        checkString(r['Notes']);
      });
    }

    // Also check swap tables and equipment needs
    ['glove_swaps', 'sleeve_swaps', 'blanket_swaps', 'mack_swaps', 'safety_equipment_needs'].forEach(sk => {
      const tbl = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(sk) : null) || snap?.tables?.[sk];
      if (tbl && tbl.rows) {
        tbl.rows.forEach(r => {
          checkString(r['Status']);
          checkString(r['Notes']);
        });
      }
    });

    const nextSeq = String(maxSeq + 1).padStart(2, '0');
    return `${datePrefix}${nextSeq}`;
  }

  fillNextRequestPoNumber() {
    const el = document.getElementById('edit-order-po-num');
    if (el) {
      el.value = this.generateNextRequestPoNumber();
      el.focus();
      el.select();
    }
  }

  fillNextMarkOrderPoNumber() {
    const el = document.getElementById('mark-order-po-num');
    if (el) {
      el.value = this.generateNextRequestPoNumber();
      el.focus();
      el.select();
    }
  }

  async promptUpdateVendorOrderNum(orderKeyOrPoNum) {
    let oldNum = orderKeyOrPoNum;
    if (this.orderGroupsMap && this.orderGroupsMap.has(orderKeyOrPoNum)) {
      const grp = this.orderGroupsMap.get(orderKeyOrPoNum);
      oldNum = grp.vendorOrderNumber || grp.orderNumber || grp.poNumber || orderKeyOrPoNum;
    }
    const promptMsg = `Enter official Vendor Order # for ${oldNum}:`;
    const newNum = prompt(promptMsg, '');
    if (newNum === null) return;
    const trimmed = newNum.trim();
    if (!trimmed) {
      alert('⚠️ Vendor Order # cannot be empty.');
      return;
    }
    await this.updateOrderNumber(oldNum, trimmed);
  }

  async updateOrderNumber(oldOrderNum, newOrderNum) {
    if (!oldOrderNum || !newOrderNum) return;
    const oldClean = String(oldOrderNum).trim();
    const newClean = String(newOrderNum).trim();
    if (oldClean.toLowerCase() === newClean.toLowerCase()) return;

    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);

      const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // 1. Update purchase_orders table
      const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
      if (poTable && poTable.rows) {
        const poRow = poTable.rows.find(r => {
          const p = String(r['PO Number'] || r['PO #'] || '').trim().toLowerCase();
          const n = String(r['Notes'] || '').toLowerCase();
          return p === oldClean.toLowerCase() || n.includes(oldClean.toLowerCase());
        });
        if (poRow) {
          const origPoId = String(poRow['PO Number'] || poRow['PO #'] || oldClean).trim();
          const updatedPoFields = { 'PO Number': newClean };
          if (poRow['Notes']) {
            updatedPoFields['Notes'] = poRow['Notes'].replace(new RegExp(escapeRegex(oldClean), 'gi'), newClean);
          }
          await this._queueRowUpdate(poTable, 'purchase_orders', 'Purchase Orders', poRow, updatedPoFields, origPoId);
        }
      }

      // 2. Cascade to all swap sheets and safety_equipment_needs
      const targetSwapKeys = this._getAllSwapKeys();
      const oldRegex = new RegExp(`(?:Order\\s*#:\\s*|PO:\\s*)?${escapeRegex(oldClean)}`, 'gi');

      for (const sk of targetSwapKeys) {
        const sTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(sk) : null) || snap?.tables?.[sk];
        if (sTable && sTable.rows) {
          for (const sr of sTable.rows) {
            const stat = String(sr['Status'] || '');
            const notes = String(sr['Notes'] || '');

            if (stat.toLowerCase().includes(oldClean.toLowerCase())) {
              const nextStat = stat.replace(oldRegex, `Order #: ${newClean}`);
              await this._queueCellMutation(sTable, sk, sr, 'status', nextStat);
              sr['Status'] = nextStat;
            }
            if (notes.toLowerCase().includes(oldClean.toLowerCase())) {
              const nextNotes = notes.replace(oldRegex, `Order #: ${newClean}`);
              await this._queueCellMutation(sTable, sk, sr, 'notes', nextNotes);
              sr['Notes'] = nextNotes;
            }
          }
        }
      }

      const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
      if (needsTable && needsTable.rows) {
        for (const nr of needsTable.rows) {
          const stat = String(nr['Status'] || '');
          const notes = String(nr['Notes'] || '');
          const updates = {};
          if (stat.toLowerCase().includes(oldClean.toLowerCase())) {
            updates['Status'] = stat.replace(oldRegex, `Order #: ${newClean}`);
          }
          if (notes.toLowerCase().includes(oldClean.toLowerCase())) {
            updates['Notes'] = notes.replace(oldRegex, `Order #: ${newClean}`);
          }
          if (Object.keys(updates).length > 0) {
            await this._queueRowUpdate(needsTable, 'safety_equipment_needs', 'Safety Equipment Needs', nr, updates);
          }
        }
      }

      if (this.db && typeof this.db.persistSnapshot === 'function') {
        await this.db.persistSnapshot(snap);
      } else if (window.desktopAPI && typeof window.desktopAPI.saveLocalSnapshot === 'function' && snap) {
        await window.desktopAPI.saveLocalSnapshot(snap);
      }
      this.scanPurchaseNeeds();
      this.render();
      if (window.showToast) {
        window.showToast(`✅ Order updated: ${oldClean} ➔ ${newClean}`, 'success');
      } else {
        alert(`✅ Order updated successfully: ${oldClean} ➔ ${newClean}`);
      }
    } catch (err) {
      console.error('Error updating order number:', err);
      alert('❌ Failed to update order number: ' + (err.message || err));
    }
  }

  openCreateOrderModal() {
    if (!this.vendors || !this.vendors.length) this.loadVendors();
    const selectedItems = (this.items || []).filter(i => i.selected && i.quantity > 0 && i.section !== 'ordered_pending');
    if (selectedItems.length > 0) {
      this.openMarkOrderedModal(selectedItems);
      return;
    }

    const nextReq = this.generateNextRequestPoNumber();
    const defaultVendor = (this.selectedVendor && typeof this.selectedVendor === 'object' ? this.selectedVendor.name : this.selectedVendor)
      || (this.vendors && this.vendors[0] ? this.vendors[0].name : 'Wagner Smith');
    this.openEditOrderModal({
      rowIdx: null,
      poNum: nextReq,
      orderNum: nextReq,
      vendor: defaultVendor,
      date: new Date().toISOString().split('T')[0],
      expDeliv: '',
      status: 'Ordered',
      price: 0,
      items: '',
      notes: `Order Request; Request #: ${nextReq}`
    });
    const title = document.getElementById('edit-order-modal-title');
    if (title) title.innerHTML = `<span>➕</span> Create Order Request / Requisition`;
    const deleteBtn = document.getElementById('btn-delete-order');
    if (deleteBtn) deleteBtn.style.display = 'none';
    const saveBtn = document.getElementById('btn-save-edit-order');
    if (saveBtn) saveBtn.innerHTML = '<span>🚀</span> Submit / Create Order Request';
  }

  openEditOrderModal(poIndex) {
    const po = (typeof poIndex === 'object' && poIndex !== null)
      ? poIndex
      : (this.poHistoryList ? this.poHistoryList[poIndex] : null);
    if (!po) return;

    this.editingOrder = { ...po, _historyIdx: typeof poIndex === 'number' ? poIndex : null };
    const modal = document.getElementById('edit-order-modal');
    const body = document.getElementById('edit-order-modal-body');
    const title = document.getElementById('edit-order-modal-title');
    if (!modal || !body) return;

    const notes = po.notes || '';
    const parsedNotes = this.parseOrderInfoFromNotes(notes);
    let cleanOrderNum = (parsedNotes?.orderNumber && parsedNotes.orderNumber.toLowerCase() !== 'ed')
      ? parsedNotes.orderNumber
      : ((po.vendorOrderNum && po.vendorOrderNum.toLowerCase() !== 'ed')
          ? po.vendorOrderNum
          : ((po.poNum && po.poNum.toLowerCase() !== 'ed') ? po.poNum : (po.orderNum || '')));
    if (cleanOrderNum.toLowerCase() === 'ed') cleanOrderNum = '';

    if (title) {
      if (po.rowIdx) {
        const isReq = /^REQ-/i.test(cleanOrderNum);
        title.innerHTML = isReq
          ? `<span>✏️</span> Edit Order Request <span style="color: #fbbf24;">#${this.escapeHtml(cleanOrderNum)}</span>`
          : (cleanOrderNum ? `<span>✏️</span> Edit Order <span style="color: #60a5fa;">#${this.escapeHtml(cleanOrderNum)}</span>` : '<span>✏️</span> Edit Order');
      } else {
        title.innerHTML = `<span>➕</span> Create Order Request / Requisition`;
      }
    }

    const deleteBtn = document.getElementById('btn-delete-order');
    if (deleteBtn) deleteBtn.style.display = po.rowIdx ? 'inline-block' : 'none';
    const saveBtn = document.getElementById('btn-save-edit-order');
    if (saveBtn) saveBtn.innerHTML = po.rowIdx ? '<span>💾</span> Save Changes' : '<span>🚀</span> Submit / Create Order Request';

    const toYmd = (dStr) => {
      if (!dStr) return '';
      if (dStr.includes('-')) return dStr;
      const parts = dStr.split('/');
      if (parts.length === 3) {
        const m = parts[0].padStart(2, '0');
        const d = parts[1].padStart(2, '0');
        const y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
        return `${y}-${m}-${d}`;
      }
      return '';
    };

    const orderYmd = toYmd(po.date) || new Date().toISOString().split('T')[0];
    const delivYmd = toYmd(po.expDeliv) || '';

    const rawVendor = po.vendor;
    const currentVendor = (typeof rawVendor === 'object' && rawVendor !== null)
      ? String(rawVendor.name || '')
      : String(rawVendor || (this.selectedVendor?.name || (this.vendors[0]?.name || '')));
    const vendorExists = this.vendors.some(v => v.name.toLowerCase() === currentVendor.toLowerCase());

    let vendorOptions = this.vendors.map(v => 
      `<option value="${this.escapeHtml(v.name)}" ${v.name.toLowerCase() === currentVendor.toLowerCase() ? 'selected' : ''}>${this.escapeHtml(v.name)}</option>`
    ).join('');
    vendorOptions += `<option value="__custom__" ${(!vendorExists && currentVendor) ? 'selected' : ''}>➕ New / Custom Vendor...</option>`;

    // Active employees for line item assignment
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    const empTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employees') : null) || snap?.tables?.['employees'];
    const activeEmployees = [];
    if (empTable && empTable.rows) {
      for (const er of empTable.rows) {
        const name = String(er['Name'] || er['Employee'] || Object.values(er)[0] || '').trim();
        const stat = String(er['Status'] || er['Employment Status'] || '').toLowerCase();
        if (name && !stat.includes('inactive') && !stat.includes('term') && !stat.includes('prev')) {
          activeEmployees.push(name);
        }
      }
    }
    activeEmployees.sort();

    let empOptions = `<option value="On Shelf" selected>📦 On Shelf (Stock / Spare)</option>`;
    for (const name of activeEmployees) {
      empOptions += `<option value="${this.escapeHtml(name)}">👤 ${this.escapeHtml(name)}</option>`;
    }

    // Initialize structured line items array
    this.editingOrderItems = this.parsePoItemsString(po.items || '');
    if (!this.editingOrderItems.length && po.items && po.items.trim()) {
      this.editingOrderItems.push({
        quantity: 1,
        category: 'Gloves',
        itemType: 'Gloves',
        classVal: 'Class 2',
        size: 'Standard',
        unitPrice: po.price || 0,
        employeeName: ''
      });
    }

    // Refresh part numbers & missing prices from current vendor catalog
    for (const it of this.editingOrderItems) {
      const cat = it.itemType || it.category || 'Gloves';
      const sz = it.size || 'Standard';
      const cl = it.classVal || 'Class 2';
      const livePart = this.getVendorPartNumber(currentVendor, cat, sz, cl);
      if (livePart) it.partNumber = livePart;
      if (!(it.unitPrice > 0)) {
        const livePrice = this.getVendorPrice(currentVendor, cat, sz, cl);
        if (livePrice > 0) it.unitPrice = livePrice;
      }
    }

    // Correlate line items with assigned linemen from safety_equipment_needs, swap sheets, and order notes
    const assignedEmpsMap = new Map(); // key: category|size|classVal -> [empNames]
    const cleanPoNum = cleanOrderNum || po.poNum || po.orderNum || '';

    // 1. Check safety_equipment_needs
    const sneedsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
    if (sneedsTable && sneedsTable.rows && cleanPoNum) {
      for (const r of sneedsTable.rows) {
        const notesStr = String(r['Notes'] || '');
        const statStr = String(r['Status'] || '');
        if (notesStr.includes(cleanPoNum) || statStr.includes(cleanPoNum)) {
          const emp = String(r['Employee'] || '').trim();
          if (!emp || emp.toLowerCase().includes('shelf') || emp.toLowerCase().includes('stock')) continue;
          const rawType = String(r['Item Type'] || 'Gloves');
          const cat = this.cleanItemType(rawType);
          const sz = this.cleanSize(r['Size'] || '');
          const rawCl = String(r['Class'] || 'Class 2').trim();
          const cl = rawCl ? (rawCl.toLowerCase().startsWith('class') ? rawCl : `Class ${rawCl}`) : 'Class 2';
          const k = `${cat}|${sz}|${cl}`;
          if (!assignedEmpsMap.has(k)) assignedEmpsMap.set(k, []);
          if (!assignedEmpsMap.get(k).includes(emp)) assignedEmpsMap.get(k).push(emp);
        }
      }
    }

    // 2. Check swap sheets (glove_swaps, sleeve_swaps, blanket_swaps, mack_swaps)
    const swapKeys = ['glove_swaps', 'sleeve_swaps', 'blanket_swaps', 'mack_swaps'];
    for (const sk of swapKeys) {
      const sTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(sk) : null) || snap?.tables?.[sk];
      if (sTable && sTable.rows && cleanPoNum) {
        for (const r of sTable.rows) {
          const notesStr = String(r['Notes'] || '');
          const statStr = String(r['Status'] || '');
          if (notesStr.includes(cleanPoNum) || statStr.includes(cleanPoNum)) {
            const emp = String(r['Employee'] || '').trim();
            if (!emp || emp.toLowerCase().includes('shelf') || emp.toLowerCase().includes('stock')) continue;
            let cat = 'Gloves';
            if (sk.includes('sleeve')) cat = 'Sleeves';
            else if (sk.includes('blanket')) cat = 'Blankets';
            else if (sk.includes('mack')) cat = 'MACKs';
            const sz = this.cleanSize(r['Size'] || r['Type'] || '');
            const rawCl = String(r['Class'] || '').trim();
            const cl = rawCl ? (rawCl.toLowerCase().startsWith('class') ? rawCl : `Class ${rawCl}`) : 'Class 2';
            const k = `${cat}|${sz}|${cl}`;
            if (!assignedEmpsMap.has(k)) assignedEmpsMap.set(k, []);
            if (!assignedEmpsMap.get(k).includes(emp)) assignedEmpsMap.get(k).push(emp);
          }
        }
      }
    }

    // 3. Fallback: Parse employees from po.notes if present (e.g. "For: Taylor Goff, Owen Filburn...")
    if (notes) {
      const forMatch = notes.match(/(?:for|assign(?:ed)?\s*to)\s*[:=]?\s*([A-Za-z0-9\s.',&-]+?)(?:;|\)|$)/i);
      if (forMatch) {
        const rawNames = forMatch[1].split(',').map(n => n.trim()).filter(Boolean);
        for (const nm of rawNames) {
          if (/^(?:on shelf|shelf|stock|spare)$/i.test(nm)) continue;
          if (empTable && empTable.rows) {
            const eRow = empTable.rows.find(er => this.isNameMatch(er['Employee Name'] || er['Name'] || '', nm));
            if (eRow) {
              const gSize = this.cleanSize(eRow['Glove Size']);
              if (gSize) {
                const k = `Gloves|${gSize}|Class 2`;
                if (!assignedEmpsMap.has(k)) assignedEmpsMap.set(k, []);
                if (!assignedEmpsMap.get(k).includes(nm)) assignedEmpsMap.get(k).push(nm);
              }
            }
          }
        }
      }
    }

    // Attach correlated linemen to matching line items
    for (const it of this.editingOrderItems) {
      if (!it.employeeName || it.employeeName.toLowerCase().includes('shelf') || it.employeeName.toLowerCase().includes('stock')) {
        const exactKey = `${it.category}|${it.size}|${it.classVal}`;
        if (assignedEmpsMap.has(exactKey) && assignedEmpsMap.get(exactKey).length > 0) {
          it.employeeName = assignedEmpsMap.get(exactKey).join(', ');
        } else {
          // Try matching category and size
          for (const [k, names] of assignedEmpsMap.entries()) {
            const [c, s] = k.split('|');
            if (c === it.category && s === it.size && names.length > 0) {
              it.employeeName = names.join(', ');
              break;
            }
          }
        }
      }
    }

    body.innerHTML = `
      <div style="margin-bottom: 16px; background: rgba(30, 58, 138, 0.2); border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 8px; padding: 12px 16px;">
        <div style="font-weight: 700; font-size: 13.5px; color: #93c5fd; margin-bottom: 3px; display: flex; align-items: center; gap: 8px;">
          <span>✏️</span> Edit Order Details & Line Items
        </div>
        <div style="font-size: 12px; color: #cbd5e1;">
          Update the Order #, vendor, delivery date, or status. You can manage existing line items or add extra items (e.g. extra shelf stock or lineman gear) below.
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
            <label style="font-size: 12px; font-weight: 600; color: #94a3b8;">Order # / PO Request #</label>
            <button type="button" class="btn btn-xs" onclick="window.procurementEngine.fillNextRequestPoNumber()" style="padding: 1px 6px; font-size: 10px; background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.35); color: #60a5fa; cursor: pointer;" title="Auto-generate new Request #">
              ⚡ Generate Request #
            </button>
          </div>
          <input type="text" id="edit-order-po-num" class="batch-delivery-input" value="${this.escapeHtml(cleanOrderNum || this.generateNextRequestPoNumber())}" placeholder="e.g. 0819764 or REQ-..." style="font-weight: 700; color: #38bdf8; pointer-events: auto !important; user-select: text !important; -webkit-user-select: text !important; cursor: text; width: 100%;">
          <div style="font-size: 11px; color: #64748b; margin-top: 3px;">
            💡 Don't have a vendor order number yet? Leave as Request # or blank. You can update with the vendor's Order # at any time once received.
          </div>
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Vendor *</label>
          <select id="edit-order-vendor-select" class="batch-delivery-input" onchange="window.procurementEngine.onEditOrderVendorChange(this.value)">
            ${vendorOptions}
          </select>
          <input type="text" id="edit-order-custom-vendor" class="batch-delivery-input" value="${this.escapeHtml(!vendorExists ? currentVendor : '')}" placeholder="Enter vendor name..." style="display: ${(!vendorExists && currentVendor) ? 'block' : 'none'}; margin-top: 6px;">
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 16px;">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Order Date *</label>
          <input type="date" id="edit-order-date" class="batch-delivery-input" value="${orderYmd}">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Delivery Date</label>
          <input type="date" id="edit-order-deliv-date" class="batch-delivery-input" value="${delivYmd}">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Status *</label>
          <select id="edit-order-status" class="batch-delivery-input">
            <option value="Ordered" ${po.status.toLowerCase().includes('order') ? 'selected' : ''}>Ordered (Awaiting Delivery)</option>
            <option value="Received" ${po.status.toLowerCase().includes('received') || po.status.toLowerCase().includes('fulfill') ? 'selected' : ''}>Received (Delivered)</option>
            <option value="Partially Received" ${po.status.toLowerCase().includes('partial') ? 'selected' : ''}>Partially Received</option>
            <option value="Cancelled" ${po.status.toLowerCase().includes('cancel') ? 'selected' : ''}>Cancelled</option>
          </select>
        </div>
      </div>

      <!-- Line Items Section -->
      <div style="margin-bottom: 16px; background: rgba(15, 23, 42, 0.5); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <label style="font-size: 12.5px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 6px;">
            <span>📦</span> Line Items in this Order
          </label>
          <span style="font-size: 11px; color: #94a3b8;">Review, remove, or add extra line items</span>
        </div>

        <div id="edit-order-items-list-container" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px;">
          <!-- Populated by renderEditOrderItemsContainer() -->
        </div>

        <!-- Add Line Item Builder -->
        <div style="background: rgba(30, 41, 59, 0.7); border: 1px dashed rgba(59, 130, 246, 0.45); border-radius: 6px; padding: 12px 14px;">
          <div style="font-weight: 700; font-size: 12.5px; color: #60a5fa; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
            <span>➕</span> Add Line Item to this Order
          </div>
          <div style="display: grid; grid-template-columns: 1.3fr 1fr 1fr 0.8fr 1fr; gap: 10px; margin-bottom: 8px;">
            <div>
              <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Item Type</label>
              <select id="add-order-item-cat" class="batch-delivery-input" onchange="window.procurementEngine.onAddOrderItemCatChange(this.value)">
                <option value="Gloves" selected>🧤 Rubber Gloves</option>
                <option value="Sleeves">🦺 Rubber Sleeves</option>
                <option value="Blankets">🧱 Blankets</option>
                <option value="Testing">🧪 Labor & Testing</option>
                <option value="MACKs">🧱 MACKs</option>
                <option value="HV Testers">⚡ HV Testers</option>
                <option value="Phasing Sets">⚡ Phasing Sets</option>
                <option value="Grounds">⚡ Grounds</option>
                <option value="Hot Sticks">🔴 Hot Sticks</option>
                <option value="AED">🏥 AED Units / Pads</option>
                <option value="Other">📦 Other / Equipment</option>
              </select>
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Class / Voltage</label>
              <select id="add-order-item-class" class="batch-delivery-input" onchange="window.procurementEngine.onAddOrderItemChange(true)">
                <option value="Class 0">Class 0</option>
                <option value="Class 2" selected>Class 2</option>
                <option value="Class 3">Class 3</option>
                <option value="Class 4">Class 4</option>
                <option value="N/A">N/A</option>
              </select>
            </div>
            <div>
              <label id="add-order-item-size-label" style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Size / Item</label>
              <input type="text" id="add-order-item-size" list="order-item-size-suggestions" class="batch-delivery-input" placeholder="e.g. 8.5" value="8.5" style="text-align: center; font-weight: 600;" onchange="window.procurementEngine.onAddOrderItemChange(true)" oninput="window.procurementEngine.onAddOrderItemChange(true)">
              <datalist id="order-item-size-suggestions">
                <option value="8"></option>
                <option value="8.5"></option>
                <option value="9"></option>
                <option value="9.5"></option>
                <option value="10"></option>
                <option value="10.5"></option>
                <option value="11"></option>
                <option value="11.5"></option>
                <option value="12"></option>
              </datalist>
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Quantity</label>
              <input type="number" min="1" step="1" id="add-order-item-qty" class="batch-delivery-input" value="1" style="text-align: center; font-weight: 600;">
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Unit Price ($)</label>
              <input type="number" min="0" step="0.01" id="add-order-item-price" class="batch-delivery-input" placeholder="0.00" style="text-align: right; font-weight: 600; color: #34d399;">
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-top: 6px;">
            <div style="flex: 1;">
              <label style="display: block; font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">👤 Ordered For (Lineman / Shelf Stock)</label>
              <select id="add-order-item-assignee" class="batch-delivery-input" style="font-weight: 600;">
                ${empOptions}
              </select>
            </div>
            <div>
              <button type="button" class="btn btn-primary" onclick="window.procurementEngine.addOrderItemToEditOrder()" style="padding: 7px 16px; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; background: #2563eb; border: none; box-shadow: 0 2px 8px rgba(37, 99, 235, 0.4);">
                <span>➕</span> Add Item to Order
              </button>
            </div>
          </div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 14px; margin-bottom: 14px;">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Total Order Cost ($)</label>
          <input type="number" step="0.01" min="0" id="edit-order-total-price" class="batch-delivery-input" value="${po.price > 0 ? po.price.toFixed(2) : ''}" placeholder="0.00" style="font-weight: 700; color: #34d399;">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Item Summary / Description *</label>
          <input type="text" id="edit-order-items" class="batch-delivery-input" value="${this.escapeHtml(po.items || '')}" placeholder="e.g. (4) Class 2 Gloves, Size 10; (2) Class 2 Sleeves, Regular">
        </div>
      </div>

      <div style="margin-bottom: 10px;">
        <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Notes & Reference Info</label>
        <textarea id="edit-order-notes" class="batch-delivery-input" rows="2" placeholder="Additional details, invoice number, or recipient notes...">${this.escapeHtml(po.notes || '')}</textarea>
      </div>
    `;

    modal.style.display = 'flex';
    modal.classList.add('active');
    this.renderEditOrderItemsContainer();
    this.onAddOrderItemChange(true);
    // Only auto-generate summary/total on open for new order requests or when summary is empty,
    // so existing custom Items text and Total Price are never overwritten just by opening Edit Order.
    if (this.editingOrder?.isNewRequest || !po.items) {
      this.syncEditOrderSummaryFromItems();
    }

    if (window.desktopAPI && typeof window.desktopAPI.forceFocusWindow === 'function') {
      window.desktopAPI.forceFocusWindow().catch(() => {});
    }
    setTimeout(() => {
      window.focus();
      const poInp = document.getElementById('edit-order-po-num');
      if (poInp) {
        poInp.focus();
        poInp.select();
      }
    }, 60);
  }

  renderEditOrderItemsContainer() {
    const container = document.getElementById('edit-order-items-list-container');
    if (!container) return;
    if (!this.editingOrderItems || this.editingOrderItems.length === 0) {
      container.innerHTML = `
        <div style="padding: 12px; background: rgba(15, 23, 42, 0.4); border: 1px dashed rgba(148, 163, 184, 0.25); border-radius: 6px; text-align: center; color: #94a3b8; font-size: 12px;">
          No individual line items recorded. Use the form below to add items to this order.
        </div>
      `;
      return;
    }

    const vSelect = document.getElementById('edit-order-vendor-select');
    const rawVendor = this.editingOrder?.vendor;
    const fallbackVendor = (typeof rawVendor === 'object' && rawVendor !== null) ? (rawVendor.name || '') : String(rawVendor || '');
    const currentVendor = (vSelect && vSelect.value && vSelect.value !== '__custom__') ? vSelect.value : fallbackVendor;

    container.innerHTML = this.editingOrderItems.map((it, idx) => {
      const qty = parseInt(it.quantity, 10) || 1;
      const lineCost = (it.unitPrice > 0 ? (it.unitPrice * qty) : 0);
      const isShelf = !it.employeeName || it.employeeName.toLowerCase().includes('shelf') || it.employeeName.toLowerCase().includes('stock');
      const assigneeBadge = isShelf 
        ? `<span class="badge" style="background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.3); font-size: 11px;">📦 On Shelf</span>`
        : `<span class="badge" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35); font-size: 11px;">👤 ${this.escapeHtml(it.employeeName)}</span>`;

      const livePart = currentVendor ? this.getVendorPartNumber(currentVendor, it.itemType || it.category || 'Gloves', it.size || 'Standard', it.classVal || 'Class 2') : '';
      const partNum = livePart || it.partNumber || '';
      if (livePart) it.partNumber = livePart;

      const partBadge = partNum
        ? `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.35); font-size: 11px; font-family: monospace;">Part #: ${this.escapeHtml(partNum)}</span>`
        : '';

      const isTesting = (it.itemType === 'Testing' || it.category === 'Testing' || /\b(?:testing|labor)\b/i.test(it.itemType || '') || /\b(?:testing|labor)\b/i.test(it.size || ''));
      const catBadge = isTesting
        ? `<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.4); font-size: 11px; padding: 1px 6px;">🧪 Testing / Labor</span>`
        : `<span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); font-size: 11px; padding: 1px 6px;">${this.escapeHtml(it.classVal || 'Class 2')}</span>`;

      const itemTitle = isTesting
        ? (it.size && it.size !== 'Standard' ? it.size : (it.itemType || 'Labor & Testing'))
        : (it.itemType || it.category || 'Gloves');

      const sizeBadge = isTesting
        ? ''
        : `<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.4); font-size: 11px; font-weight: 700; padding: 1px 6px;">Size: ${this.escapeHtml(it.size || 'Standard')}</span>`;

      return `
        <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(15, 23, 42, 0.65); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 6px; padding: 8px 12px; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <div style="display: inline-flex; align-items: center; gap: 4px;" title="Edit quantity">
              <span style="font-size: 11px; color: #94a3b8; font-weight: 600;">Qty:</span>
              <input type="number" min="1" step="1" class="batch-delivery-input" value="${qty}" onchange="window.procurementEngine.updateEditOrderItemField(${idx}, 'quantity', this.value)" style="width: 54px; padding: 3px 6px; font-size: 12px; font-weight: 800; color: #38bdf8; text-align: center;">
            </div>
            <span style="font-weight: 700; color: #f8fafc; font-size: 13px;">${this.escapeHtml(itemTitle)}</span>
            ${catBadge}
            ${sizeBadge}
            ${partBadge}
            <div style="display: inline-flex; align-items: center; gap: 4px;" title="Edit unit price ($)">
              <span style="font-size: 11px; color: #64748b; font-family: monospace;">@ $</span>
              <input type="number" min="0" step="0.01" class="batch-delivery-input" value="${it.unitPrice > 0 ? it.unitPrice.toFixed(2) : ''}" placeholder="0.00" onchange="window.procurementEngine.updateEditOrderItemField(${idx}, 'unitPrice', this.value)" style="width: 78px; padding: 3px 6px; font-size: 12px; font-family: monospace; font-weight: 700; color: #34d399; text-align: right;">
              ${qty > 1 && lineCost > 0 ? `<span style="font-family: monospace; font-size: 11.5px; color: #94a3b8;">($${lineCost.toFixed(2)})</span>` : ''}
            </div>
            ${assigneeBadge}
          </div>
          <button type="button" class="btn btn-xs" onclick="window.procurementEngine.removeEditOrderItem(${idx})" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #f87171; padding: 3px 8px; font-size: 11px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Remove this line item">
            <span>🗑️</span> Remove
          </button>
        </div>
      `;
    }).join('');
  }

  updateEditOrderItemField(idx, field, val) {
    if (!this.editingOrderItems || !this.editingOrderItems[idx]) return;
    const item = this.editingOrderItems[idx];
    if (field === 'quantity') {
      item.quantity = Math.max(1, parseInt(val, 10) || 1);
    } else if (field === 'unitPrice') {
      item.unitPrice = Math.max(0, parseFloat(val) || 0);
    }
    this.syncEditOrderSummaryFromItems();
    this.renderEditOrderItemsContainer();
  }

  addOrderItemToEditOrder() {
    const catSelect = document.getElementById('add-order-item-cat');
    let cat = catSelect ? catSelect.value : 'Gloves';
    const classSelect = document.getElementById('add-order-item-class');
    let classVal = classSelect ? classSelect.value : 'Class 2';
    const sizeInput = document.getElementById('add-order-item-size');
    const size = sizeInput ? sizeInput.value.trim() : 'Standard';
    if (!size) {
      alert('⚠️ Please specify a size or item description.');
      if (sizeInput) sizeInput.focus();
      return;
    }
    const qtyInput = document.getElementById('add-order-item-qty');
    const qty = Math.max(1, parseInt(qtyInput?.value, 10) || 1);
    const priceInput = document.getElementById('add-order-item-price');
    const unitPrice = Math.max(0, parseFloat(priceInput?.value) || 0);
    const empSelect = document.getElementById('add-order-item-assignee');
    const assignee = empSelect ? empSelect.value : 'On Shelf';
    const vSelect = document.getElementById('edit-order-vendor-select');
    const currentVendor = (vSelect && vSelect.value && vSelect.value !== '__custom__') ? vSelect.value : '';

    const isTesting = (cat === 'Testing' || /\b(?:testing|labor|service|dielectric)\b/i.test(cat) || /\b(?:testing|labor|service|dielectric)\b/i.test(size));
    if (isTesting) {
      cat = 'Testing';
      if (!classVal || classVal === 'Class 2') classVal = 'N/A';
    }

    const partNumber = currentVendor ? this.getVendorPartNumber(currentVendor, cat, size, classVal) : '';

    if (!this.editingOrderItems) this.editingOrderItems = [];
    this.editingOrderItems.push({
      quantity: qty,
      category: cat,
      itemType: cat,
      classVal: classVal,
      size: size,
      unitPrice: unitPrice,
      partNumber: partNumber,
      employeeName: assignee
    });

    this.syncEditOrderSummaryFromItems();
    this.renderEditOrderItemsContainer();

    if (qtyInput) qtyInput.value = '1';
  }

  removeEditOrderItem(idx) {
    if (!this.editingOrderItems || !this.editingOrderItems[idx]) return;
    this.editingOrderItems.splice(idx, 1);
    this.syncEditOrderSummaryFromItems();
    this.renderEditOrderItemsContainer();
  }

  syncEditOrderSummaryFromItems() {
    if (!this.editingOrderItems) return;
    const summaryParts = this.editingOrderItems.map(it => {
      const isTestingOrService = (it.itemType === 'Testing' || it.category === 'Testing' || /\b(?:testing|labor)\b/i.test(it.itemType || '') || /\b(?:testing|labor)\b/i.test(it.size || ''));
      let s = '';
      if (isTestingOrService) {
        const itemLabel = it.size && it.size !== 'Standard' ? it.size : (it.itemType && it.itemType !== 'Testing' ? it.itemType : 'Labor & Testing');
        s = `(${it.quantity || 1}) ${itemLabel}`;
      } else {
        s = `(${it.quantity || 1}) ${it.classVal || 'Class 2'} ${it.itemType || it.category || 'Gloves'}, Size ${it.size || 'Standard'}`;
      }
      if (it.unitPrice > 0) s += ` @ $${it.unitPrice.toFixed(2)}`;
      if (it.employeeName && !it.employeeName.toLowerCase().includes('shelf')) s += ` [For: ${it.employeeName}]`;
      return s;
    });
    const itemsInput = document.getElementById('edit-order-items');
    if (itemsInput) itemsInput.value = summaryParts.join('; ');

    // Recalculate Total Order Cost ($) from line items
    const totalPriceInput = document.getElementById('edit-order-total-price');
    if (totalPriceInput) {
      const calcTotal = this.editingOrderItems.reduce((sum, it) => {
        const q = parseInt(it.quantity, 10) || 1;
        const p = parseFloat(it.unitPrice) || 0;
        return sum + (q * p);
      }, 0);
      if (calcTotal > 0 || this.editingOrderItems.length === 0) {
        totalPriceInput.value = calcTotal > 0 ? calcTotal.toFixed(2) : '';
      }
    }

    // Auto-update total unit count in Notes & Reference Info (Issue 2)
    const totalUnits = this.editingOrderItems.reduce((sum, it) => sum + (parseInt(it.quantity, 10) || 1), 0);
    const notesInput = document.getElementById('edit-order-notes');
    if (notesInput && notesInput.value) {
      let nVal = notesInput.value;
      if (/Ordered\s+\d+\s+units/i.test(nVal)) {
        notesInput.value = nVal.replace(/Ordered\s+\d+\s+units/gi, `Ordered ${totalUnits} units`);
      }
    }
  }

  onAddOrderItemCatChange(cat) {
    const classSelect = document.getElementById('add-order-item-class');
    const sizeInput = document.getElementById('add-order-item-size');
    const datalist = document.getElementById('order-item-size-suggestions');
    const sizeLabel = document.getElementById('add-order-item-size-label');
    const vSelect = document.getElementById('edit-order-vendor-select');
    const vendorName = (vSelect && vSelect.value && vSelect.value !== '__custom__') ? vSelect.value : '';

    if (cat === 'Gloves') {
      if (sizeLabel) sizeLabel.textContent = 'Size / Item';
      if (classSelect) classSelect.value = 'Class 2';
      if (sizeInput) {
        sizeInput.value = '8.5';
        sizeInput.placeholder = 'e.g. 8.5';
      }
      const vItems = this.getVendorTestingItems(vendorName).filter(it => (it.item || '').toLowerCase().includes('glove'));
      let extraOpts = vItems.map(it => `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} — $${Number(it.price || 0).toFixed(2)}</option>`).join('');
      if (datalist) {
        datalist.innerHTML = `
          <option value="8"></option>
          <option value="8.5"></option>
          <option value="9"></option>
          <option value="9.5"></option>
          <option value="10"></option>
          <option value="10.5"></option>
          <option value="11"></option>
          <option value="11.5"></option>
          <option value="12"></option>
          ${extraOpts}
        `;
      }
    } else if (cat === 'Sleeves') {
      if (sizeLabel) sizeLabel.textContent = 'Size / Item';
      if (classSelect) classSelect.value = 'Class 2';
      if (sizeInput) {
        sizeInput.value = 'Regular';
        sizeInput.placeholder = 'e.g. Regular';
      }
      const vItems = this.getVendorTestingItems(vendorName).filter(it => (it.item || '').toLowerCase().includes('sleeve'));
      let extraOpts = vItems.map(it => `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} — $${Number(it.price || 0).toFixed(2)}</option>`).join('');
      if (datalist) {
        datalist.innerHTML = `
          <option value="Regular"></option>
          <option value="Large"></option>
          <option value="Extra Large"></option>
          ${extraOpts}
        `;
      }
    } else if (cat === 'Blankets') {
      if (sizeLabel) sizeLabel.textContent = 'Size / Item';
      if (classSelect) classSelect.value = 'Class 4';
      if (sizeInput) {
        sizeInput.value = 'Regular';
        sizeInput.placeholder = 'e.g. Regular';
      }
      const vItems = this.getVendorTestingItems(vendorName).filter(it => (it.item || '').toLowerCase().includes('blanket'));
      let extraOpts = vItems.map(it => `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} — $${Number(it.price || 0).toFixed(2)}</option>`).join('');
      if (datalist) {
        datalist.innerHTML = `
          <option value="Regular"></option>
          <option value="Split"></option>
          <option value="Eyelet"></option>
          <option value="Canister"></option>
          ${extraOpts}
        `;
      }
    } else if (cat === 'Testing') {
      if (sizeLabel) sizeLabel.textContent = 'Testing / Service Item';
      if (classSelect) classSelect.value = 'N/A';
      const testingItems = this.getVendorTestingItems(vendorName);
      if (datalist) {
        let opts = testingItems.map(it => 
          `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} ${it.price > 0 ? '— $' + Number(it.price).toFixed(2) : ''}${it.itemNumber ? ' (Part: ' + this.escapeHtml(it.itemNumber) + ')' : ''}</option>`
        ).join('');
        if (!opts.includes('Glove Testing')) opts += `<option value="Glove Testing">Glove Testing</option>`;
        if (!opts.includes('Sleeve Testing')) opts += `<option value="Sleeve Testing">Sleeve Testing</option>`;
        if (!opts.includes('Blanket Testing')) opts += `<option value="Blanket Testing">Blanket Testing</option>`;
        if (!opts.includes('Labor Testing')) opts += `<option value="Labor Testing">Labor Testing</option>`;
        if (!opts.includes('Dielectric Testing')) opts += `<option value="Dielectric Testing">Dielectric Testing</option>`;
        datalist.innerHTML = opts;
      }
      if (sizeInput) {
        sizeInput.value = (testingItems.length > 0 ? testingItems[0].item : 'Glove Testing');
        sizeInput.placeholder = 'Select or type testing service...';
      }
    } else if (cat === 'MACKs') {
      if (sizeLabel) sizeLabel.textContent = 'Size / Rating';
      if (classSelect) classSelect.value = 'Class 4';
      if (sizeInput) {
        sizeInput.value = 'Standard';
        sizeInput.placeholder = 'e.g. Standard';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="Standard"></option>
          <option value="15kV"></option>
          <option value="25kV"></option>
          <option value="35kV"></option>
        `;
      }
    } else if (cat === 'HV Testers' || cat === 'Phasing Sets') {
      if (sizeLabel) sizeLabel.textContent = 'Rating / Model';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = 'Standard';
        sizeInput.placeholder = 'e.g. Standard';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="Standard"></option>
          <option value="15kV"></option>
          <option value="25kV"></option>
          <option value="40kV"></option>
        `;
      }
    } else if (cat === 'Grounds') {
      if (sizeLabel) sizeLabel.textContent = 'Style / Type';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = 'Single';
        sizeInput.placeholder = 'e.g. Single';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="Single"></option>
          <option value="Cluster"></option>
          <option value="4-Way"></option>
          <option value="Overhead"></option>
          <option value="Underground"></option>
        `;
      }
    } else if (cat === 'Hot Sticks') {
      if (sizeLabel) sizeLabel.textContent = 'Length / Type';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = '8ft';
        sizeInput.placeholder = 'e.g. 8ft';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="6ft"></option>
          <option value="8ft"></option>
          <option value="10ft"></option>
          <option value="12ft"></option>
          <option value="Telescopic"></option>
        `;
      }
    } else if (cat === 'AED') {
      if (sizeLabel) sizeLabel.textContent = 'Component';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = 'Unit';
        sizeInput.placeholder = 'e.g. Unit';
      }
      if (datalist) {
        datalist.innerHTML = `
          <option value="Unit"></option>
          <option value="Adult Pads"></option>
          <option value="Pediatric Pads"></option>
          <option value="Battery Pack"></option>
        `;
      }
    } else {
      if (sizeLabel) sizeLabel.textContent = 'Item / Service Description';
      if (classSelect) classSelect.value = 'N/A';
      if (sizeInput) {
        sizeInput.value = 'Standard';
        sizeInput.placeholder = 'e.g. Glove Testing, Utility Tool, Hardware...';
      }
      const vObj = (this.vendors || []).find(v => v.name.toLowerCase() === vendorName.toLowerCase());
      const catItems = (vObj?.items || []).filter(it => it.category === 'Other' || it.category === 'Testing' || /\b(?:testing|labor)\b/i.test(it.item || '') || /\b(?:testing|labor)\b/i.test(it.itemNumber || ''));
      if (datalist) {
        let opts = catItems.map(it => `<option value="${this.escapeHtml(it.item)}">${this.escapeHtml(it.item)} ${it.price > 0 ? '— $' + Number(it.price).toFixed(2) : ''}</option>`).join('');
        opts += `<option value="Standard"></option><option value="Labor / Testing"></option>`;
        datalist.innerHTML = opts;
      }
    }
    this.onAddOrderItemChange(true);
  }

  onAddOrderItemChange(forcePriceUpdate = false) {
    const cat = document.getElementById('add-order-item-cat')?.value || 'Gloves';
    const classVal = document.getElementById('add-order-item-class')?.value || 'Class 2';
    const size = document.getElementById('add-order-item-size')?.value || '';
    const vSelect = document.getElementById('edit-order-vendor-select');
    let vendor = vSelect ? vSelect.value : '';
    if (vendor && vendor !== '__custom__' && size) {
      const price = this.getVendorPrice(vendor, cat, size, classVal);
      const priceInput = document.getElementById('add-order-item-price');
      if (priceInput && (forcePriceUpdate || document.activeElement !== priceInput)) {
        priceInput.value = price > 0 ? price.toFixed(2) : '';
      }
    }
  }

  closeEditOrderModal() {
    const modal = document.getElementById('edit-order-modal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.remove('active');
    }
    this.editingOrder = null;
    this.editingOrderItems = [];
  }

  onEditOrderVendorChange(val) {
    const custom = document.getElementById('edit-order-custom-vendor');
    if (custom) {
      if (val === '__custom__') {
        custom.style.display = 'block';
        custom.focus();
      } else {
        custom.style.display = 'none';
      }
    }
    if (this.editingOrderItems && val && val !== '__custom__') {
      this.editingOrderItems.forEach(it => {
        const cat = it.itemType || it.category || 'Gloves';
        const sz = it.size || 'Standard';
        const cl = it.classVal || 'Class 2';
        it.partNumber = this.getVendorPartNumber(val, cat, sz, cl);
        const catPrice = this.getVendorPrice(val, cat, sz, cl);
        if (catPrice > 0) it.unitPrice = catPrice;
      });
    }
    this.syncEditOrderSummaryFromItems();
    this.renderEditOrderItemsContainer();
    const curCat = document.getElementById('add-order-item-cat')?.value;
    if (curCat) {
      this.onAddOrderItemCatChange(curCat);
    } else {
      this.onAddOrderItemChange(true);
    }
  }

  async confirmSaveEditOrder() {
    if (!this.editingOrder) return;
    const poNumInput = document.getElementById('edit-order-po-num');
    let orderNum = poNumInput ? poNumInput.value.trim() : '';
    if (!orderNum || orderNum.toLowerCase() === 'ed') {
      orderNum = this.generateNextRequestPoNumber();
      if (poNumInput) poNumInput.value = orderNum;
    }

    const vSelect = document.getElementById('edit-order-vendor-select');
    let vendorName = vSelect ? vSelect.value : '';
    if (vendorName === '__custom__') {
      const customV = document.getElementById('edit-order-custom-vendor');
      vendorName = customV ? customV.value.trim() : '';
    }
    if (!vendorName) {
      alert('⚠️ Please select or enter a Vendor.');
      return;
    }

    const orderDateInput = document.getElementById('edit-order-date');
    const orderDate = orderDateInput ? orderDateInput.value : '';
    const delivDateInput = document.getElementById('edit-order-deliv-date');
    const delivDate = delivDateInput ? delivDateInput.value : '';
    const statusSelect = document.getElementById('edit-order-status');
    const status = statusSelect ? statusSelect.value : 'Ordered';
    const priceInput = document.getElementById('edit-order-total-price');
    const totalPrice = parseFloat(priceInput?.value) || 0;
    const itemsInput = document.getElementById('edit-order-items');
    if (this.editingOrderItems && this.editingOrderItems.length > 0 && (!itemsInput || !itemsInput.value.trim())) {
      this.syncEditOrderSummaryFromItems();
    }
    const itemsStr = itemsInput ? itemsInput.value.trim() : '';
    if (!itemsStr) {
      alert('⚠️ Please add at least one line item (click "Add Item to Order") or enter an Item Summary / Description.');
      if (itemsInput) itemsInput.focus();
      return;
    }
    const notesInput = document.getElementById('edit-order-notes');
    const notes = notesInput ? notesInput.value.trim() : '';

    let finalNotes = notes;
    if (this.editingOrderItems && this.editingOrderItems.length) {
      const totalUnits = this.editingOrderItems.reduce((acc, it) => acc + (parseInt(it.quantity, 10) || 1), 0);
      if (/Ordered\s+\d+\s+units/i.test(finalNotes)) {
        finalNotes = finalNotes.replace(/Ordered\s+\d+\s+units/gi, `Ordered ${totalUnits} units`);
      }
    }
    if (orderNum) {
      const isReq = /^REQ-/i.test(orderNum);
      const tag = isReq ? `Request #: ${orderNum}` : `Order #: ${orderNum}`;
      if (finalNotes.toLowerCase().includes('order #:') || finalNotes.toLowerCase().includes('request #:')) {
        finalNotes = finalNotes.replace(/(?:order|request)\s*#:\s*[^;,]+/i, tag);
      } else if (finalNotes.toLowerCase().includes('vendor order #:')) {
        finalNotes = finalNotes.replace(/vendor order #:\s*[^;,]+/i, tag);
      } else {
        finalNotes = finalNotes ? `${finalNotes}; ${tag}` : tag;
      }
    }

    const isNewOrderRequest = !this.editingOrder.rowIdx;
    const saveBtn = document.getElementById('btn-save-edit-order');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Saving...';
    }

    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);

      const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
      if (!poTable) throw new Error('Purchase Orders table not found');

      const updatedRowObj = {
        'Date': this.formatToMdY(orderDate) || this.editingOrder.date || new Date().toLocaleDateString(),
        'PO Number': orderNum,
        'Vendor': vendorName,
        'Items': itemsStr,
        'Total Price': totalPrice > 0 ? totalPrice : 0,
        'Expected Delivery': this.formatToMdY(delivDate) || (status === 'Received' ? 'Delivered' : 'Pending'),
        'Status': status,
        'Notes': finalNotes
      };

      let targetRowIdx = this.editingOrder.rowIdx;

      let foundRow = null;
      if (targetRowIdx && poTable.rows) {
        foundRow = poTable.rows.find((r, idx) => {
          const rIdx = r._rowIdx || (idx + 2);
          return rIdx === targetRowIdx;
        });
      }

      const wasEditingEdRow = String(this.editingOrder.vendorOrderNum || this.editingOrder.poNum || '').trim().toLowerCase() === 'ed';
      if (!foundRow && poTable.rows) {
        // Fallback: match exact PO Number, or 'ed' placeholder only when editing an existing 'ed' order
        foundRow = poTable.rows.find(r => {
          const p = String(r['PO Number'] || r['PO #'] || '').trim().toLowerCase();
          return p === orderNum.toLowerCase() || (wasEditingEdRow && p === 'ed');
        });
        if (foundRow) {
          targetRowIdx = foundRow._rowIdx || (poTable.rows.indexOf(foundRow) + 2);
        }
      }

      if (foundRow && targetRowIdx) {
        const origPoId = String(foundRow['PO Number'] || foundRow['PO #'] || orderNum).trim();
        await this._queueRowUpdate(poTable, 'purchase_orders', 'Purchase Orders', foundRow, updatedRowObj, origPoId);
      } else {
        await this.db.addRow('purchase_orders', updatedRowObj, 'Purchase Order');
      }

      // Cascade Order Number change to swap tables and safety needs if order number was modified
      const oldOrderNum = this.editingOrder.orderNumber || this.editingOrder.vendorOrderNum || this.editingOrder.poNum;
      const oldPoNum = this.editingOrder.poNum;
      const oldKeys = [oldOrderNum, oldPoNum, ...(wasEditingEdRow ? ['ed'] : [])].filter(Boolean);
      const uniqueOldKeys = Array.from(new Set(oldKeys.map(k => String(k).trim())));
      for (const oldNum of uniqueOldKeys) {
        if (oldNum && oldNum.toLowerCase() !== orderNum.toLowerCase()) {
          const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const makePoRegex = (isGlobal) => oldNum.toLowerCase() === 'ed'
            ? new RegExp('(?:Order\\s*#:\\s*|Request\\s*#:\\s*|PO:\\s*)\\bed\\b', isGlobal ? 'gi' : 'i')
            : new RegExp(`(?:Order\\s*#:\\s*|Request\\s*#:\\s*|PO:\\s*)?\\b${escapeRegex(oldNum)}\\b`, isGlobal ? 'gi' : 'i');

          for (const sk of this._getAllSwapKeys()) {
            const sTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(sk) : null) || snap?.tables?.[sk];
            if (sTable && sTable.rows) {
              for (const sr of sTable.rows) {
                const stat = String(sr['Status'] || '');
                const sNotes = String(sr['Notes'] || '');
                if (makePoRegex(false).test(stat)) {
                  const nextStat = stat.replace(makePoRegex(true), `Order #: ${orderNum}`);
                  await this._queueCellMutation(sTable, sk, sr, 'status', nextStat);
                  sr['Status'] = nextStat;
                }
                if (makePoRegex(false).test(sNotes)) {
                  const nextNotes = sNotes.replace(makePoRegex(true), `Order #: ${orderNum}`);
                  await this._queueCellMutation(sTable, sk, sr, 'notes', nextNotes);
                  sr['Notes'] = nextNotes;
                }
              }
            }
          }

          const snTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
          if (snTable && snTable.rows) {
            for (const sr of snTable.rows) {
              const stat = String(sr['Status'] || '');
              const sNotes = String(sr['Notes'] || '');
              const updates = {};
              if (makePoRegex(false).test(stat)) updates['Status'] = stat.replace(makePoRegex(true), `Order #: ${orderNum}`);
              if (makePoRegex(false).test(sNotes)) updates['Notes'] = sNotes.replace(makePoRegex(true), `Order #: ${orderNum}`);
              if (Object.keys(updates).length > 0) {
                await this._queueRowUpdate(snTable, 'safety_equipment_needs', 'Safety Equipment Needs', sr, updates);
              }
            }
          }
        }
      }

      // If order is marked Received, resolve and clear all matching items from swap sheets and safety equipment needs
      const statusLower = String(status || '').toLowerCase();
      if (statusLower === 'received') {
        const assignedEmps = (this.editingOrderItems || [])
          .flatMap(it => String(it.employeeName || '').split(',').map(n => n.trim()))
          .filter(Boolean);
        await this.resolveReceivedOrderItems(orderNum, {
          assignedEmployees: assignedEmps,
          isReadyForDelivery: false,
          todayStr: this.formatToMdY(delivDate) || new Date().toLocaleDateString()
        });
      } else if (!statusLower.includes('cancel') && !statusLower.includes('partial') && this.editingOrderItems && this.editingOrderItems.length) {
        // If line items are assigned to linemen on an active/ordered PO, sync to their swap sheet and safety equipment rows as Ordered
        for (const item of this.editingOrderItems) {
          const catKey = (item.itemType || item.category || '').toLowerCase();
          const swapKey = this._getSwapTableKeyForCategory(catKey);

          const empNameStr = item.employeeName || '';
          if (!empNameStr) continue;
          const assignedEmps = empNameStr.split(',').map(n => n.trim()).filter(Boolean);

          for (const singleEmp of assignedEmps) {
            if (singleEmp.toLowerCase().includes('shelf') || singleEmp.toLowerCase().includes('stock')) continue;

            const orderNote = `Ordered on ${orderDate || new Date().toLocaleDateString()}, Order #: ${orderNum}, Vendor: ${vendorName}${delivDate ? ', Est. Delivery: ' + delivDate : ''}${item.unitPrice > 0 ? ', Price: $' + item.unitPrice.toFixed(2) : ''}`;

            // Sync to swap sheet (all 9 categories supported)
            if (swapKey) {
              const sTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(swapKey) : null) || snap?.tables?.[swapKey];
              if (sTable && sTable.rows) {
                const sRow = sTable.rows.find(sr => {
                  const name = String(sr['Employee'] || sr['Employee Name'] || sr['Crew Lead / Employee'] || sr['Assigned To'] || Object.values(sr)[0] || '').trim();
                  return this.isNameMatch(name, singleEmp);
                });
                if (sRow) {
                  const nextStat = `Ordered (Order #: ${orderNum})`;
                  const nextNotes = sRow['Notes'] ? `${sRow['Notes']}; ${orderNote}` : orderNote;
                  await this._queueCellMutation(sTable, swapKey, sRow, 'status', nextStat);
                  await this._queueCellMutation(sTable, swapKey, sRow, 'notes', nextNotes);
                  sRow['Status'] = nextStat;
                  sRow['Notes'] = nextNotes;
                }
              }
            }

            // Sync to safety_equipment_needs (matching both employee AND item type)
            const snTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
            if (snTable && snTable.rows) {
              const snRow = snTable.rows.find(sr => {
                const meta = this._getSafetyNeedMeta(sr);
                if (!meta) return false;
                const typeMatch = !catKey || meta.itemType.toLowerCase().includes(catKey.slice(0, 4));
                return this.isNameMatch(meta.employee, singleEmp) && typeMatch;
              });
              if (snRow) {
                const updates = { 'Status': 'Ordered', 'Notes': orderNote };
                if (item.classVal) updates['Class'] = item.classVal;
                if (item.size) updates['Size'] = item.size;
                await this._queueRowUpdate(snTable, 'safety_equipment_needs', 'Safety Equipment Needs', snRow, updates);
              }
            }
          }
        }
      }

      const parsedItems = this.parsePoItemsString(itemsStr);
      for (const pi of parsedItems) {
        if (pi.unitPrice > 0) {
          await this.syncVendorPrice(vendorName, pi.itemType, pi.size, pi.classVal, pi.unitPrice);
        }
      }

      this.closeEditOrderModal();
      await this.loadData();
      this.render();

      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }

      alert(`✅ Order #${orderNum} updated successfully!`);
    } catch (err) {
      console.error('Error saving edited order:', err);
      alert('❌ Failed to save order changes: ' + (err.message || err));
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = isNewOrderRequest ? '<span>🚀</span> Submit / Create Order Request' : '<span>💾</span> Save Changes';
      }
    }
  }

  async deleteOrder(rowIdx, poNum) {
    if (!confirm(`Are you sure you want to permanently delete Order #${poNum || 'Unknown'} from the tracking history?\n\nThis will also revert any pending items for this order back to "Needs to Order".`)) {
      return;
    }

    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);

      const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
      if (!poTable) throw new Error('Purchase Orders table not found');

      const targetRowIdx = rowIdx;

      let deletedOrderNotes = '';
      let targetPoRow = null;
      if (poTable.rows) {
        targetPoRow = poTable.rows.find((r, i) => (r._rowIdx || (i + 2)) === targetRowIdx) || null;
        if (targetPoRow) {
          deletedOrderNotes = String(targetPoRow['Notes'] || '');
        }
      }

      if (targetPoRow) {
        await this._queueDeletePoRow(poTable, targetPoRow);
      } else {
        await this.db.addMutation({
          action: 'DELETE_ROW',
          sheetName: poTable.name || 'Purchase Orders',
          tableKey: 'purchase_orders',
          row: targetRowIdx,
          itemIdentifier: (poNum && poNum !== '—' && poNum.toLowerCase() !== 'pending') ? poNum : ''
        });
      }

      // Also revert any swap rows and safety_equipment_needs rows matching this order number
      const parsedNotes = this.parseOrderInfoFromNotes(deletedOrderNotes);
      const targetNums = Array.from(new Set([poNum, parsedNotes?.orderNumber, parsedNotes?.vendorOrderNumber]
        .map(n => String(n || '').trim())
        .filter(n => n && n.length >= 2 && n.toLowerCase() !== 'pending' && n !== '—')));
      const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matchesTargetOrderNum = (text) => targetNums.some(num => {
        const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(num)}([^a-z0-9]|$)`, 'i');
        return re.test(String(text || ''));
      });

      for (const sk of this._getAllSwapKeys()) {
        const sTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable(sk) : null) || snap?.tables?.[sk];
        if (sTable && sTable.rows) {
          for (const sr of sTable.rows) {
            const stat = String(sr['Status'] || '');
            const notes = String(sr['Notes'] || '');
            if ((matchesTargetOrderNum(stat) || matchesTargetOrderNum(notes)) && stat.toLowerCase().includes('order')) {
              const cleanedNotes = notes ? notes.replace(/Ordered on [^;]+;?/gi, '').trim() : '';
              await this._queueCellMutation(sTable, sk, sr, 'status', 'Need To Purchase');
              await this._queueCellMutation(sTable, sk, sr, 'notes', cleanedNotes);
              sr['Status'] = 'Need To Purchase';
              if (sr['Notes'] !== undefined) sr['Notes'] = cleanedNotes;
            }
          }
        }
      }

      const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
      if (needsTable && needsTable.rows) {
        for (const nr of needsTable.rows) {
          const meta = this._getSafetyNeedMeta(nr);
          if (!meta) continue;
          if ((matchesTargetOrderNum(meta.status) || matchesTargetOrderNum(meta.notes)) && meta.status.toLowerCase().includes('order')) {
            const cleanedNotes = meta.notes ? meta.notes.replace(/Ordered on [^;]+;?/gi, '').trim() : '';
            await this._queueRowUpdate(needsTable, 'safety_equipment_needs', 'Safety Equipment Needs', nr, {
              'Status': 'Pending',
              'Notes': cleanedNotes
            });
          }
        }
      }

      await this.loadData();
      this.render();

      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }

      alert(`🗑️ Order #${poNum || ''} deleted and associated items reverted to "Needs to Order".`);
    } catch (err) {
      console.error('Error deleting order:', err);
      alert('❌ Failed to delete order: ' + (err.message || err));
    }
  }

  async confirmDeleteCurrentOrder() {
    if (!this.editingOrder) return;
    const { rowIdx, poNum } = this.editingOrder;
    this.closeEditOrderModal();
    await this.deleteOrder(rowIdx, poNum);
  }

  async cancelPendingOrderItem(itemIdx, empIdx = null) {
    const item = (this.items || [])[itemIdx];
    if (!item) return;

    let targetEmps = [];
    if (empIdx !== null && item.employees && item.employees[empIdx]) {
      targetEmps = [item.employees[empIdx]];
    } else if (item.employees && item.employees.length > 0) {
      targetEmps = item.employees;
    }

    const empNamesStr = targetEmps.map(e => e.name || e.label || 'On Shelf').join(', ');
    const label = targetEmps.length > 0 ? `for ${empNamesStr}` : '';
    const poNum = item.orderInfo?.orderNumber || item.orderInfo?.poNumber || '';
    const poMsg = poNum ? ` under Order #${poNum}` : '';

    if (!confirm(`Are you sure you want to cancel the pending order for:\n${item.typeLabel || item.itemType} (${item.size}, ${item.classVal}) ${label}${poMsg}?\n\nThis will revert this requirement back to "Needs to Order".`)) {
      return;
    }

    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);

      const catKey = (item.itemType || '').toLowerCase();
      const swapKey = this._getSwapTableKeyForCategory(catKey);

      const swapTable = swapKey ? ((this.db && typeof this.db.getTable === 'function' ? this.db.getTable(swapKey) : null) || snap?.tables?.[swapKey]) : null;
      const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];

      for (const emp of targetEmps) {
        const empName = emp.name || '';
        if (swapTable && swapTable.rows && empName) {
          const sRow = swapTable.rows.find(sr => {
            const name = String(sr['Employee'] || sr['Employee Name'] || sr['Crew Lead / Employee'] || sr['Assigned To'] || Object.values(sr)[0] || '').trim();
            const stat = String(sr['Status'] || '').toLowerCase();
            const sSize = String(sr['Size'] || sr['Type'] || sr['Model'] || '').trim().toLowerCase();
            const sClass = String(sr['Class'] || sr['KV'] || '').trim().toLowerCase();
            const itSize = String(item.size || '').trim().toLowerCase();
            const itClass = String(item.classVal || '').trim().toLowerCase();

            const isName = this.isNameMatch(name, empName) || (empName.toLowerCase().includes('shelf') && name.toLowerCase().includes('shelf'));
            const isOrder = stat.includes('order');
            const isSize = !itSize || itSize === 'standard' || sSize === itSize;
            const isClass = !itClass || itClass === 'n/a' || itClass === 'class n/a' || !sClass || sClass.includes(itClass.replace(/[^0-9]/g, '')) || itClass.includes(sClass.replace(/[^0-9]/g, ''));
            return isName && isOrder && isSize && isClass;
          });
          if (sRow) {
            const cleanedNotes = sRow['Notes'] ? sRow['Notes'].replace(/Ordered on [^;]+;?/gi, '').trim() : '';
            await this._queueCellMutation(swapTable, swapKey, sRow, 'status', 'Need To Purchase');
            await this._queueCellMutation(swapTable, swapKey, sRow, 'notes', cleanedNotes);
            sRow['Status'] = 'Need To Purchase';
            if (sRow['Notes'] !== undefined) sRow['Notes'] = cleanedNotes;
          }
        }

        if (needsTable && needsTable.rows && empName) {
          const nRow = needsTable.rows.find(nr => {
            const meta = this._getSafetyNeedMeta(nr);
            if (!meta) return false;
            const isOrdered = meta.status.toLowerCase().includes('order');
            const isType = meta.itemType.toLowerCase().includes(catKey.slice(0, 4));
            const isPo = !poNum || meta.notes.toLowerCase().includes(poNum.toLowerCase()) || meta.status.toLowerCase().includes(poNum.toLowerCase());
            return this.isNameMatch(meta.employee, empName) && isType && isOrdered && isPo;
          });
          if (nRow) {
            const cleanedNotes = nRow['Notes'] ? nRow['Notes'].replace(/Ordered on [^;]+;?/gi, '').trim() : '';
            await this._queueRowUpdate(needsTable, 'safety_equipment_needs', 'Safety Equipment Needs', nRow, {
              'Status': 'Pending',
              'Notes': cleanedNotes
            });
          }
        }
      }

      // If this item was originated by an open PO in purchase_orders, surgically update the items in the PO
      const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
      if (poTable && poTable.rows && poNum) {
        const voNum = item.orderInfo?.vendorOrderNumber || '';
        const isOpenPo = (r) => {
          const stat = String(r['Status'] || (Array.isArray(r) ? r[6] : '') || '').toLowerCase();
          return !stat.includes('received') && !stat.includes('fulfilled') && !stat.includes('cancel');
        };
        let poRow = null;
        if (voNum) {
          poRow = poTable.rows.find(r => isOpenPo(r) && String(r['Notes'] || '').includes(voNum));
        }
        if (!poRow) {
          poRow = poTable.rows.find(r => {
            const num = String(r['PO Number'] || r['PO #'] || (Array.isArray(r) ? r[1] : '') || '').trim();
            return isOpenPo(r) && num.toLowerCase() === poNum.toLowerCase();
          });
        }
        if (poRow) {
          const itemsStr = String(Array.isArray(poRow) ? poRow[3] : poRow['Items'] || '');
          const parsedItems = this.parsePoItemsString(itemsStr);
          const normClassCmp = (c) => {
            const cl = String(c || '').toLowerCase().replace(/^class\s+/i, '').trim();
            return (!cl || cl === 'n/a' || cl === '—') ? 'n/a' : cl;
          };
          const cancelSize = String(item.size || '').toLowerCase().trim();
          const cancelClass = normClassCmp(item.classVal);
          const cancelCat = String(item.itemType || '').toLowerCase().trim();
          const targetEmpNames = targetEmps.map(e => e.name).filter(Boolean);
          let unitsToRemove = targetEmps.length || 1;

          const updatedItems = [];
          for (const pi of parsedItems) {
            const pCat = String(pi.category || pi.itemType || '').toLowerCase().trim();
            const pSize = String(pi.size || '').toLowerCase().trim();
            const pClass = normClassCmp(pi.classVal);
            const empMatchesChunk = targetEmpNames.length === 0 || !pi.employeeName ||
              targetEmpNames.some(tn => this.isNameMatch(pi.employeeName, tn));

            const isMatch = (pCat === cancelCat && pSize === cancelSize && pClass === cancelClass && empMatchesChunk);
            if (isMatch && unitsToRemove > 0) {
              if (pi.quantity > unitsToRemove) {
                pi.quantity -= unitsToRemove;
                if (pi.employeeName && targetEmpNames.length > 0) {
                  const remainingEmps = pi.employeeName.split(',').map(s => s.trim()).filter(n => !targetEmpNames.some(tn => this.isNameMatch(n, tn)));
                  pi.employeeName = remainingEmps.join(', ');
                }
                unitsToRemove = 0;
                updatedItems.push(pi);
              } else {
                unitsToRemove -= pi.quantity;
                // chunk completely removed
              }
            } else {
              updatedItems.push(pi);
            }
          }

          const origPoId = String(poRow['PO Number'] || poRow['PO #'] || poNum).trim();
          if (updatedItems.length === 0) {
            // Entire order is empty now -> mark Cancelled
            if (Array.isArray(poRow)) {
              poRow[6] = 'Cancelled';
              poRow[4] = 0;
            } else {
              await this._queueRowUpdate(poTable, 'purchase_orders', 'Purchase Orders', poRow, {
                'Status': 'Cancelled',
                'Total Price': 0
              }, origPoId);
            }
          } else {
            // Reconstruct Items string and recalculate Total Price
            const newItemsStr = updatedItems.map(pi => {
              const empTag = pi.employeeName ? ` [For: ${pi.employeeName}]` : '';
              const priceTag = pi.unitPrice > 0 ? ` @ $${pi.unitPrice.toFixed(2)}` : '';
              return `(${pi.quantity}) ${pi.classVal} ${pi.category}, Size ${pi.size}${empTag}${priceTag}`;
            }).join('; ');
            const newTotalPrice = updatedItems.reduce((sum, pi) => sum + (pi.quantity * (pi.unitPrice || 0)), 0);

            if (Array.isArray(poRow)) {
              poRow[3] = newItemsStr;
              poRow[4] = newTotalPrice;
            } else {
              await this._queueRowUpdate(poTable, 'purchase_orders', 'Purchase Orders', poRow, {
                'Items': newItemsStr,
                'Total Price': newTotalPrice
              }, origPoId);
            }
          }
        }
      }

      await this.loadData();
      this.render();

      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }

      alert('🗑️ Pending order cancelled and reverted to Needs to Order.');
    } catch (err) {
      console.error('Error cancelling pending order item:', err);
      alert('❌ Failed to cancel order item: ' + (err.message || err));
    }
  }

  openEditPendingOrderItem(itemIdx, empIdx = null) {
    const item = (this.items || [])[itemIdx];
    if (!item) return;

    let targetEmp = null;
    if (empIdx !== null && item.employees && item.employees[empIdx]) {
      targetEmp = item.employees[empIdx];
    } else if (item.employees && item.employees.length === 1) {
      targetEmp = item.employees[0];
    }

    this.editingPendingItem = {
      itemIdx,
      empIdx,
      item,
      targetEmp
    };

    const modal = document.getElementById('edit-pending-order-item-modal');
    const body = document.getElementById('edit-pending-item-modal-body');
    const title = document.getElementById('edit-pending-item-modal-title');
    if (!modal || !body) return;

    if (title) {
      title.textContent = `Edit Pending Order: ${item.typeLabel || item.itemType} (${item.size}, ${item.classVal})`;
    }

    const orderInfo = item.orderInfo || {};
    let cleanOrderNum = orderInfo.orderNumber || orderInfo.vendorOrderNumber || orderInfo.poNumber || '';
    if (cleanOrderNum.toLowerCase() === 'ed') cleanOrderNum = '';

    const isMultiEmpConsolidated = !targetEmp && Array.isArray(item.employees) && item.employees.length > 1;
    const currentAssignee = targetEmp ? targetEmp.name : (isMultiEmpConsolidated ? item.employees[0].name : (item.employees?.[0]?.name || 'On Shelf'));

    // Fallback if order number was missing or corrupted
    if (!cleanOrderNum) {
      const activePo = this.findActiveOpenPo(currentAssignee, item.itemType, item.size, item.classVal);
      if (activePo) cleanOrderNum = activePo.orderNumber;
    }

    const toYmd = (dStr) => {
      if (!dStr) return '';
      const s = String(dStr).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
      const d = new Date(s);
      if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      return '';
    };

    const vendorName = orderInfo.vendor || '';
    const orderDateYmd = toYmd(orderInfo.orderDate);
    const expDeliveryYmd = toYmd(orderInfo.expectedDelivery);
    const currentVendor = vendorName || (this.selectedVendor?.name || (this.vendors[0]?.name || ''));
    const catalogPrice = this.getVendorPrice(currentVendor, item.itemType, item.size, item.classVal);
    const rawPriceVal = item.price > 0 ? item.price : (orderInfo.price > 0 ? orderInfo.price : catalogPrice);
    const price = rawPriceVal > 0 ? rawPriceVal.toFixed(2) : '';

    // Get active employees list for selection
    const snap = (this.db && typeof this.db.getSnapshot === 'function')
      ? this.db.getSnapshot()
      : (window.localDB ? window.localDB.getSnapshot() : null);
    const empTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('employees') : null) || snap?.tables?.['employees'];
    const activeEmployees = [];
    if (empTable && empTable.rows) {
      for (const er of empTable.rows) {
        const name = String(er['Name'] || er['Employee'] || Object.values(er)[0] || '').trim();
        const stat = String(er['Status'] || er['Employment Status'] || '').toLowerCase();
        if (name && !stat.includes('inactive') && !stat.includes('term') && !stat.includes('prev')) {
          activeEmployees.push(name);
        }
      }
    }
    activeEmployees.sort();

    let empOptions = `<option value="On Shelf" ${currentAssignee.toLowerCase().includes('shelf') ? 'selected' : ''}>📦 On Shelf (Stock / Spare)</option>`;
    for (const name of activeEmployees) {
      const isSelected = this.isNameMatch(currentAssignee, name);
      empOptions += `<option value="${this.escapeHtml(name)}" ${isSelected ? 'selected' : ''}>👤 ${this.escapeHtml(name)}</option>`;
    }
    if (!activeEmployees.some(n => this.isNameMatch(currentAssignee, n)) && !currentAssignee.toLowerCase().includes('shelf')) {
      empOptions += `<option value="${this.escapeHtml(currentAssignee)}" selected>👤 ${this.escapeHtml(currentAssignee)} (Current)</option>`;
    }

    const vendorExists = this.vendors.some(v => v.name.toLowerCase() === currentVendor.toLowerCase());

    let vendorOptions = this.vendors.map(v => 
      `<option value="${this.escapeHtml(v.name)}" ${v.name.toLowerCase() === currentVendor.toLowerCase() ? 'selected' : ''}>${this.escapeHtml(v.name)}</option>`
    ).join('');
    vendorOptions += `<option value="__custom__" ${(!vendorExists && currentVendor) ? 'selected' : ''}>➕ New / Custom Vendor...</option>`;

    body.innerHTML = `
      <div style="margin-bottom: 16px; background: rgba(13, 148, 136, 0.12); border: 1px solid rgba(13, 148, 136, 0.35); border-radius: 8px; padding: 12px 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; flex-wrap: wrap; gap: 8px;">
          <div style="font-weight: 700; font-size: 13.5px; color: #5eead4; display: flex; align-items: center; gap: 8px;">
            <span>✏️</span> Edit Ordered Item & Lineman Assignment
          </div>
          <button type="button" class="btn btn-xs" onclick="window.procurementEngine.openEditOrderFromCurrentPendingItem()" style="background: rgba(59, 130, 246, 0.25); border: 1px solid rgba(59, 130, 246, 0.55); color: #93c5fd; padding: 4px 10px; font-size: 11px; border-radius: 4px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;">
            <span>➕</span> Add Another Item to this Order
          </button>
        </div>
        <div style="font-size: 12px; color: #cbd5e1;">
          Update who this item was ordered for (e.g. assign to a specific lineman or move to shelf stock), modify the Order #, vendor, price, or estimated delivery date. To add more items to this order, click <strong>"Add Another Item to this Order"</strong> above.
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px;">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">👤 Ordered For (Lineman / Shelf) *</label>
          <select id="edit-pending-assignee" class="batch-delivery-input" style="font-weight: 600; color: #f8fafc;">
            ${empOptions}
          </select>
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Order # *</label>
          <input type="text" id="edit-pending-po-num" class="batch-delivery-input" value="${this.escapeHtml(cleanOrderNum)}" placeholder="e.g. 0819764" style="font-weight: 700; color: #38bdf8;">
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 14px;">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Vendor</label>
          <select id="edit-pending-vendor-select" class="batch-delivery-input" onchange="window.procurementEngine.onEditPendingVendorChange(this.value)">
            ${vendorOptions}
          </select>
          <input type="text" id="edit-pending-custom-vendor" class="batch-delivery-input" value="${this.escapeHtml(!vendorExists ? currentVendor : '')}" placeholder="Enter vendor name..." style="display: ${(!vendorExists && currentVendor) ? 'block' : 'none'}; margin-top: 6px;">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Order Date</label>
          <input type="date" id="edit-pending-order-date" class="batch-delivery-input" value="${orderDateYmd || new Date().toISOString().split('T')[0]}">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Expected Delivery Date</label>
          <input type="date" id="edit-pending-deliv-date" class="batch-delivery-input" value="${expDeliveryYmd}">
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 14px;">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Size</label>
          <input type="text" id="edit-pending-size" class="batch-delivery-input" value="${this.escapeHtml(item.size || 'Standard')}" style="text-align: center; font-weight: 600;" onchange="window.procurementEngine.onEditPendingItemSpecChange()" oninput="window.procurementEngine.onEditPendingItemSpecChange()">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Class / KV</label>
          <input type="text" id="edit-pending-class" class="batch-delivery-input" value="${this.escapeHtml(item.classVal || 'Class 2')}" style="text-align: center; color: #94a3b8;" onchange="window.procurementEngine.onEditPendingItemSpecChange()" oninput="window.procurementEngine.onEditPendingItemSpecChange()">
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 5px;">Unit Price ($)</label>
          <input type="number" step="0.01" min="0" id="edit-pending-price" class="batch-delivery-input" value="${price}" placeholder="0.00" style="text-align: right; font-weight: 600; color: #34d399;">
        </div>
      </div>
    `;

    modal.style.display = 'flex';
    modal.classList.add('active');
  }

  openEditOrderFromCurrentPendingItem() {
    if (!this.editingPendingItem) return;
    const item = this.editingPendingItem.item;
    const meta = this.getOrderKeyForPendingItem(item);
    this.closeEditPendingOrderItemModal();
    if (meta && meta.orderKey) {
      this.openEditOrderFromKey(meta.orderKey);
    }
  }

  closeEditPendingOrderItemModal() {
    const modal = document.getElementById('edit-pending-order-item-modal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.remove('active');
    }
    this.editingPendingItem = null;
  }

  onEditPendingItemSpecChange() {
    if (!this.editingPendingItem || !this.editingPendingItem.item) return;
    const item = this.editingPendingItem.item;
    const vSelect = document.getElementById('edit-pending-vendor-select');
    const vendor = (vSelect && vSelect.value && vSelect.value !== '__custom__') ? vSelect.value : '';
    const size = document.getElementById('edit-pending-size')?.value?.trim() || item.size || 'Standard';
    const classVal = document.getElementById('edit-pending-class')?.value?.trim() || item.classVal || 'Class 2';
    const priceInput = document.getElementById('edit-pending-price');
    if (vendor && priceInput && document.activeElement !== priceInput) {
      const catPrice = this.getVendorPrice(vendor, item.itemType, size, classVal);
      if (catPrice > 0) {
        priceInput.value = catPrice.toFixed(2);
      }
    }
  }

  onEditPendingVendorChange(val) {
    const custom = document.getElementById('edit-pending-custom-vendor');
    if (!custom) return;
    if (val === '__custom__') {
      custom.style.display = 'block';
      custom.focus();
    } else {
      custom.style.display = 'none';
      this.onEditPendingItemSpecChange();
    }
  }

  async confirmSaveEditPendingOrderItem() {
    if (!this.editingPendingItem) return;
    const { item, targetEmp } = this.editingPendingItem;

    const assigneeSelect = document.getElementById('edit-pending-assignee');
    const newAssignee = assigneeSelect ? assigneeSelect.value.trim() : '';
    const poNumInput = document.getElementById('edit-pending-po-num');
    let orderNum = poNumInput ? poNumInput.value.trim() : '';
    if (!orderNum || orderNum.toLowerCase() === 'ed') {
      alert('⚠️ Please enter a valid Order Number (e.g. 0819764).');
      if (poNumInput) poNumInput.focus();
      return;
    }

    const vSelect = document.getElementById('edit-pending-vendor-select');
    let vendorName = vSelect ? vSelect.value : '';
    if (vendorName === '__custom__') {
      const customV = document.getElementById('edit-pending-custom-vendor');
      vendorName = customV ? customV.value.trim() : '';
    }

    const sizeInput = document.getElementById('edit-pending-size');
    const newSize = sizeInput ? sizeInput.value.trim() : (item.size || 'Standard');
    const classInput = document.getElementById('edit-pending-class');
    const newClass = classInput ? classInput.value.trim() : (item.classVal || 'Class 2');
    const priceInput = document.getElementById('edit-pending-price');
    const unitPrice = parseFloat(priceInput?.value) || 0;
    const orderDateInput = document.getElementById('edit-pending-order-date');
    const orderDate = orderDateInput ? orderDateInput.value : '';
    const delivDateInput = document.getElementById('edit-pending-deliv-date');
    const delivDate = delivDateInput ? delivDateInput.value : '';

    const saveBtn = document.getElementById('btn-save-edit-pending-item');
    if (saveBtn) {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Saving...';
    }

    try {
      const snap = (this.db && typeof this.db.getSnapshot === 'function')
        ? this.db.getSnapshot()
        : (window.localDB ? window.localDB.getSnapshot() : null);

      const catKey = (item.itemType || '').toLowerCase();
      const swapKey = this._getSwapTableKeyForCategory(catKey);

      const oldAssignee = targetEmp ? targetEmp.name : (item.employees?.[0]?.name || '');
      const orderNote = `Ordered on ${orderDate || new Date().toLocaleDateString()}, Order #: ${orderNum}${vendorName ? ', Vendor: ' + vendorName : ''}${delivDate ? ', Est. Delivery: ' + delivDate : ''}${unitPrice > 0 ? ', Price: $' + unitPrice.toFixed(2) : ''}`;

      const swapTable = swapKey ? ((this.db && typeof this.db.getTable === 'function' ? this.db.getTable(swapKey) : null) || snap?.tables?.[swapKey]) : null;
      if (swapTable && swapTable.rows) {
        const itSizeLower = String(item.size || '').trim().toLowerCase();
        const sRow = swapTable.rows.find(sr => {
          const name = String(sr['Employee'] || sr['Employee Name'] || sr['Crew Lead / Employee'] || sr['Assigned To'] || Object.values(sr)[0] || '').trim();
          const stat = String(sr['Status'] || '').toLowerCase();
          const sSize = String(sr['Size'] || sr['Type'] || sr['Model'] || '').trim().toLowerCase();
          const nameOk = this.isNameMatch(name, oldAssignee) || (oldAssignee.toLowerCase().includes('shelf') && name.toLowerCase().includes('shelf'));
          const sizeOk = !itSizeLower || itSizeLower === 'standard' || !sSize || sSize === itSizeLower;
          return nameOk && stat.includes('order') && sizeOk;
        });
        if (sRow) {
          if (newAssignee && newAssignee !== oldAssignee) {
            await this._queueCellMutation(swapTable, swapKey, sRow, 'employee', newAssignee);
            sRow['Employee'] = newAssignee;
          }
          if (newSize) {
            await this._queueCellMutation(swapTable, swapKey, sRow, 'size', newSize);
            sRow['Size'] = newSize;
          }
          if (newClass) {
            await this._queueCellMutation(swapTable, swapKey, sRow, 'class', newClass);
            if (sRow['Class'] !== undefined) sRow['Class'] = newClass;
            if (sRow['KV'] !== undefined) sRow['KV'] = newClass;
          }
          const nextStat = `Ordered (Order #: ${orderNum})`;
          await this._queueCellMutation(swapTable, swapKey, sRow, 'status', nextStat);
          await this._queueCellMutation(swapTable, swapKey, sRow, 'notes', orderNote);
          sRow['Status'] = nextStat;
          sRow['Notes'] = orderNote;
        }
      }

      // Also sync safety_equipment_needs row if present
      const needsTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('safety_equipment_needs') : null) || snap?.tables?.['safety_equipment_needs'];
      if (needsTable && needsTable.rows && oldAssignee) {
        const nRow = needsTable.rows.find(nr => {
          const meta = this._getSafetyNeedMeta(nr);
          if (!meta) return false;
          return this.isNameMatch(meta.employee, oldAssignee) && meta.itemType.toLowerCase().includes(catKey.slice(0, 4)) && meta.status.toLowerCase().includes('order');
        });
        if (nRow) {
          const needUpdates = { 'Notes': orderNote };
          if (newAssignee && newAssignee !== oldAssignee) {
            needUpdates['Employee'] = newAssignee;
            needUpdates['Foreman'] = newAssignee;
          }
          if (newSize) needUpdates['Size'] = newSize;
          if (newClass) needUpdates['Class'] = newClass;
          await this._queueRowUpdate(needsTable, 'safety_equipment_needs', 'Safety Equipment Needs', nRow, needUpdates);
        }
      }

      // Also cascade to purchase_orders table if order row exists with old number or 'ed'
      const poTable = (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('purchase_orders') : null) || snap?.tables?.['purchase_orders'];
      if (poTable && poTable.rows) {
        const oldOrderNum = item.orderInfo?.orderNumber || item.orderInfo?.vendorOrderNumber || item.orderInfo?.poNumber;
        const targetOld = (oldOrderNum && oldOrderNum.toLowerCase() !== 'ed') ? oldOrderNum.toLowerCase() : null;
        let matchedPo = null;
        if (targetOld) {
          matchedPo = poTable.rows.find(r => {
            const p = String(r['PO Number'] || r['PO #'] || '').trim().toLowerCase();
            const n = String(r['Notes'] || '').toLowerCase();
            return p === targetOld || n.includes(targetOld);
          });
        }
        if (!matchedPo) {
          matchedPo = poTable.rows.find(r => {
            const stat = String(r['Status'] || '').toLowerCase();
            const notes = String(r['Notes'] || '');
            const items = String(r['Items'] || '');
            const p = String(r['PO Number'] || r['PO #'] || '').trim().toLowerCase();
            return (p === 'ed' || p === orderNum.toLowerCase() || (!stat.includes('received') && (this.isNameMatch(notes, oldAssignee) || this.isNameMatch(items, oldAssignee))));
          });
        }
        if (matchedPo) {
          const origPoId = String(matchedPo['PO Number'] || matchedPo['PO #'] || orderNum).trim();
          const poUpdates = { 'PO Number': orderNum };
          if (vendorName) poUpdates['Vendor'] = vendorName;
          if (orderDate) poUpdates['Date'] = this.formatToMdY(orderDate) || matchedPo['Date'];
          if (delivDate) poUpdates['Expected Delivery'] = this.formatToMdY(delivDate) || matchedPo['Expected Delivery'];
          if (matchedPo['Notes']) {
            let nextNotes = matchedPo['Notes'].replace(/\bed\b/gi, orderNum);
            if (oldOrderNum && oldOrderNum !== orderNum) {
              nextNotes = nextNotes.replace(oldOrderNum, orderNum);
            }
            poUpdates['Notes'] = nextNotes;
          }
          // Update matching line item inside PO Items and recalculate Total Price
          if (matchedPo['Items']) {
            const parsedPoItems = this.parsePoItemsString(String(matchedPo['Items']));
            if (parsedPoItems.length > 0) {
              const oldCat = String(item.itemType || '').toLowerCase().trim();
              const oldSz = String(item.size || '').toLowerCase().trim();
              const targetPi = parsedPoItems.find(pi =>
                String(pi.category || pi.itemType || '').toLowerCase().trim() === oldCat &&
                String(pi.size || '').toLowerCase().trim() === oldSz &&
                (!pi.employeeName || !oldAssignee || this.isNameMatch(pi.employeeName, oldAssignee))
              );
              if (targetPi) {
                if (newSize) targetPi.size = newSize;
                if (newClass) targetPi.classVal = newClass;
                if (unitPrice > 0) targetPi.unitPrice = unitPrice;
                if (newAssignee && newAssignee !== oldAssignee && targetPi.employeeName) {
                  const emps = targetPi.employeeName.split(',').map(s => s.trim());
                  const replaced = emps.map(e => this.isNameMatch(e, oldAssignee) ? newAssignee : e);
                  targetPi.employeeName = replaced.join(', ');
                }
                poUpdates['Items'] = parsedPoItems.map(pi => {
                  const empTag = pi.employeeName ? ` [For: ${pi.employeeName}]` : '';
                  const priceTag = pi.unitPrice > 0 ? ` @ $${pi.unitPrice.toFixed(2)}` : '';
                  return `(${pi.quantity}) ${pi.classVal} ${pi.category}, Size ${pi.size}${empTag}${priceTag}`;
                }).join('; ');
                const recalcTotal = parsedPoItems.reduce((sum, pi) => sum + ((pi.quantity || 1) * (pi.unitPrice || 0)), 0);
                if (recalcTotal > 0) poUpdates['Total Price'] = recalcTotal;
              }
            }
          }
          await this._queueRowUpdate(poTable, 'purchase_orders', 'Purchase Orders', matchedPo, poUpdates, origPoId);
        }
      }

      // Also sync vendor pricing if price updated
      if (unitPrice > 0 && vendorName) {
        await this.syncVendorPrice(vendorName, item.itemType, newSize, newClass, unitPrice);
      }

      this.closeEditPendingOrderItemModal();
      await this.loadData();
      this.render();

      if (window.ppeTrackingEngine && typeof window.ppeTrackingEngine.refresh === 'function') {
        window.ppeTrackingEngine.refresh();
      }

      alert('✅ Ordered item updated successfully!');
    } catch (err) {
      console.error('Error saving pending order item:', err);
      alert('❌ Failed to update item: ' + (err.message || err));
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<span>💾</span> Save Changes';
      }
    }
  }

  async confirmCancelPendingOrderItem() {
    if (!this.editingPendingItem) return;
    const { itemIdx, empIdx } = this.editingPendingItem;
    this.closeEditPendingOrderItemModal();
    await this.cancelPendingOrderItem(itemIdx, empIdx);
  }

  /**
   * Generates formatted PO Email via mailto:
   */
  sendPoEmail() {
    const activeItems = (this.items || []).filter(i => i.selected && i.quantity > 0);
    if (activeItems.length === 0) {
      alert('⚠️ No purchase items selected.');
      return;
    }

    // If all selected items are existing ordered_pending items from one order group, route directly to emailOrderFromKey
    const orderedSelected = activeItems.filter(i => i.section === 'ordered_pending');
    const needsSelected = activeItems.filter(i => i.section !== 'ordered_pending');
    if (orderedSelected.length > 0 && needsSelected.length === 0 && this.orderGroupsMap) {
      let detectedOrderKey = null;
      for (const item of orderedSelected) {
        const meta = this.getOrderKeyForPendingItem(item);
        const candidates = [
          item.orderKey,
          meta?.orderKey,
          meta?.orderNumber ? `ORDER_${meta.orderNumber.trim().toUpperCase()}` : null
        ].filter(Boolean);
        const hit = candidates.find(k => this.orderGroupsMap.has(k));
        if (hit) {
          detectedOrderKey = hit;
          break;
        }
      }
      if (detectedOrderKey) {
        this.emailOrderFromKey(detectedOrderKey);
        return;
      }
    }

    // Otherwise generate PO text for selected needs items and open modal
    this.generatePOText();
  }

  /**
   * Downloads formatted CSV for purchasing system import.
   */
  downloadPoCsv() {
    const activeItems = (this.items || []).filter(i => i.selected && i.quantity > 0 && i.section !== 'ordered_pending');
    if (activeItems.length === 0) {
      alert('⚠️ No purchase items needing order are selected.');
      return;
    }

    const consolidatedItems = this.consolidateItemsBySizeAndClass(activeItems);
    const csvCell = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;

    const lines = ['Item Category,Size,Class / KV,Part Number,Quantity,Unit Price,Subtotal,Assigned Personnel'];
    consolidatedItems.forEach(i => {
      const sub = (i.price * i.quantity).toFixed(2);
      const checkedEmps = (i.employees || []).filter(e => e.checked).map(e => e.name || e.label);
      const emps = csvCell(checkedEmps.join('; '));
      const sizeDisplay = i.hasNoSize ? '⚠️ Needs Size' : i.size;
      lines.push(`${csvCell(i.itemType)},${csvCell(sizeDisplay)},${csvCell(i.classVal)},${csvCell(i.partNumber || '')},${i.quantity},$${i.price.toFixed(2)},$${sub},${emps}`);
    });

    const csvContent = lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Purchase_Order_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

// Attach globally
window.ProcurementEngine = ProcurementEngine;
