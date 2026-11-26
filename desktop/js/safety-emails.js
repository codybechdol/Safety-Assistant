/**
 * Safety Assistant Desktop - Safety Email Processing Engine
 * Handles Gmail scanning for JHAs, Weekly Safety Meetings, and Monthly Checklists directly from the Desktop App.
 */

class SafetyEmailsEngine {
  constructor(db) {
    this.db = db;
    this.isProcessing = false;
    this.isMinimized = false;
    this.cancelRequested = false;
    this.bgDismissTimer = null;
    this.activeCategoryFilter = 'all';
    this.selectedMonthFilter = 'all';
    this.activeSortOption = 'date_desc';
    this.searchQuery = '';
    this.pdfCache = new Map();
    window.safetyComplianceEngine = this;
    window.safetyEmailsEngine = this;
  }

  init() {
    console.log('SafetyEmailsEngine initialized');
  }

  parseDate(val) {
    if (!val || val === 'N/A' || val === '—') return null;
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    const s = String(val).trim();
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
    if (s.includes('-')) {
      const parts = s.split(' ')[0].split('-');
      if (parts.length === 3) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const d = parseInt(parts[2], 10);
        const dt = new Date(y, m, d, 12, 0, 0);
        return isNaN(dt.getTime()) ? null : dt;
      }
    }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
  }

  getAvailableMonths() {
    const monthMap = new Map();
    (this.currentLogs || []).forEach(log => {
      const dStr = log.date || log.dateReceived;
      const d = this.parseDate(dStr);
      if (d) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const key = `${yyyy}-${mm}`;
        if (!monthMap.has(key)) {
          const monthName = d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
          monthMap.set(key, { key: key, label: monthName });
        }
      }
    });

    const months = Array.from(monthMap.values());
    months.sort((a, b) => b.key.localeCompare(a.key)); // Newest month first
    return months;
  }

  sortLogs(logs, sortOption) {
    const parseLogDate = (log) => {
      const dStr = log.date || log.dateReceived;
      if (!dStr) return 0;
      const d = this.parseDate(dStr);
      return d ? d.getTime() : 0;
    };

    const parseReceivedDate = (log) => {
      const dStr = log.dateReceived || log.date;
      if (!dStr) return 0;
      const d = this.parseDate(dStr);
      return d ? d.getTime() : 0;
    };

    const getMonthKey = (log) => {
      const dStr = log.date || log.dateReceived;
      const d = this.parseDate(dStr);
      if (!d) return '9999-99';
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      return `${yyyy}-${mm}`;
    };

    const getJobKey = (log) => {
      const j = String(log.jobNumber || '').trim().toLowerCase();
      const f = String(log.foreman || '').trim().toLowerCase();
      return `${j}|${f}`;
    };

    return [...logs].sort((a, b) => {
      if (sortOption === 'job_foreman') {
        const jA = getJobKey(a);
        const jB = getJobKey(b);
        if (jA !== jB) return jA.localeCompare(jB);
        return parseLogDate(b) - parseLogDate(a);
      }

      if (sortOption === 'month_job_foreman') {
        const mA = getMonthKey(a);
        const mB = getMonthKey(b);
        if (mA !== mB) return mB.localeCompare(mA);
        const jA = getJobKey(a);
        const jB = getJobKey(b);
        if (jA !== jB) return jA.localeCompare(jB);
        return parseLogDate(b) - parseLogDate(a);
      }

      if (sortOption === 'month_asc') {
        const mA = getMonthKey(a);
        const mB = getMonthKey(b);
        if (mA !== mB) return mA.localeCompare(mB);
        return parseLogDate(a) - parseLogDate(b);
      }

      if (sortOption === 'month_desc') {
        const mA = getMonthKey(a);
        const mB = getMonthKey(b);
        if (mA !== mB) return mB.localeCompare(mA);
        return parseLogDate(b) - parseLogDate(a);
      }

      if (sortOption === 'date_asc') {
        return parseLogDate(a) - parseLogDate(b);
      }

      if (sortOption === 'received_desc') {
        return parseReceivedDate(b) - parseReceivedDate(a);
      }

      // Default: date_desc
      return parseLogDate(b) - parseLogDate(a);
    });
  }

  /**
   * Renders the interactive completion view with clickable category cards, sorting options, and live drill-down log table.
   */
  renderCompletionModalContent(container, stats) {
    const availableMonths = this.getAvailableMonths();

    const warningBanner = stats.complianceError ? `
      <div style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 8px; padding: 10px 14px; color: #fcd34d; font-size: 12px; line-height: 1.4;">
        <strong>⚠️ Compliance Calculation Notice:</strong> Emails were logged, but matrix recalculation reported:
        <div style="font-family: monospace; font-size: 11px; margin-top: 4px; color: #fef08a;">${this.escapeHtml(stats.complianceError)}</div>
        You can use the <strong>🔄 Recalculate</strong> button on the toolbar to re-run compliance calculation.
      </div>
    ` : '';

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 14px;">
        ${warningBanner}
        <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(5, 150, 105, 0.05) 100%); border: 1px solid rgba(16, 185, 129, 0.4); border-radius: 8px; padding: 12px 18px; text-align: center;">
          <div style="font-size: 24px; margin-bottom: 4px;">✅</div>
          <h3 style="color: #6ee7b7; font-size: 15px; font-weight: 800; margin-bottom: 2px;">Safety Emails & Complete Audit Log</h3>
          <p style="color: var(--text-secondary); font-size: 12px; margin: 0;">
            Inspect original email PDFs, filter by month, sort by crew, or correct typos directly in the log.
          </p>
        </div>

        <!-- Interactive Summary Breakdown Cards -->
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
          ${(() => {
            const logs = this.currentLogs || [];
            const totalInDb = logs.length;
            const jhaInDb = logs.filter(l => l.type === 'JHA' || l.sheetName === 'JHA Log').length;
            const weeklyInDb = logs.filter(l => l.type === 'Weekly Safety Meeting' || l.sheetName === 'Weekly Safety Log').length;
            const monthlyInDb = logs.filter(l => l.type === 'Monthly Checklist' || l.sheetName === 'Monthly Checklist Log').length;
            const issuesInDb = logs.filter(l => l.hasEquipmentIssues === 'Yes' || l.type === 'Equipment').length;

            const newJha = (stats.cumulativeLogs && stats.cumulativeLogs.jha) || 0;
            const newWeekly = (stats.cumulativeLogs && stats.cumulativeLogs.weekly) || 0;
            const newMonthly = (stats.cumulativeLogs && stats.cumulativeLogs.monthly) || 0;
            const totalNew = (stats.totalLogs !== undefined && stats.totalLogs > 0) ? stats.totalLogs : (newJha + newWeekly + newMonthly);

            const allDisplay = totalInDb > 0 ? totalInDb : (stats.totalLogs || 0);
            const jhaDisplay = jhaInDb > 0 ? jhaInDb : newJha;
            const weeklyDisplay = weeklyInDb > 0 ? weeklyInDb : newWeekly;
            const monthlyDisplay = monthlyInDb > 0 ? monthlyInDb : newMonthly;
            const issuesDisplay = issuesInDb > 0 ? issuesInDb : (stats.totalIssues || 0);

            return `
              <div class="stat-card-clickable ${this.activeCategoryFilter === 'all' ? 'active' : ''}" onclick="window.safetyComplianceEngine.setCategoryFilter('all')" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px;">
                <span class="view-hint">🔍 View</span>
                <div style="font-size: 10.5px; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">✨ All Logs</div>
                <div style="font-size: 18px; font-weight: 800; color: #34d399; margin-top: 2px;">${allDisplay}</div>
                <div style="font-size: 10px; color: ${totalNew > 0 ? '#6ee7b7' : '#94a3b8'}; margin-top: 2px; font-weight: ${totalNew > 0 ? '700' : '500'};">${totalNew > 0 ? `+${totalNew} new` : 'All up to date'}</div>
              </div>
              <div class="stat-card-clickable ${this.activeCategoryFilter === 'jha' ? 'active' : ''}" onclick="window.safetyComplianceEngine.setCategoryFilter('jha')" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px;">
                <span class="view-hint">🔍 View</span>
                <div style="font-size: 10.5px; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">📋 Daily JHAs</div>
                <div style="font-size: 18px; font-weight: 700; color: #60a5fa; margin-top: 2px;">${jhaDisplay}</div>
                <div style="font-size: 10px; color: ${newJha > 0 ? '#60a5fa' : '#94a3b8'}; margin-top: 2px; font-weight: ${newJha > 0 ? '700' : '500'};">${newJha > 0 ? `+${newJha} new` : 'Up to date'}</div>
              </div>
              <div class="stat-card-clickable ${this.activeCategoryFilter === 'weekly' ? 'active' : ''}" onclick="window.safetyComplianceEngine.setCategoryFilter('weekly')" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px;">
                <span class="view-hint">🔍 View</span>
                <div style="font-size: 10.5px; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">🗣️ Weekly Meetings</div>
                <div style="font-size: 18px; font-weight: 700; color: #a78bfa; margin-top: 2px;">${weeklyDisplay}</div>
                <div style="font-size: 10px; color: ${newWeekly > 0 ? '#a78bfa' : '#94a3b8'}; margin-top: 2px; font-weight: ${newWeekly > 0 ? '700' : '500'};">${newWeekly > 0 ? `+${newWeekly} new` : 'Up to date'}</div>
              </div>
              <div class="stat-card-clickable ${this.activeCategoryFilter === 'monthly' ? 'active' : ''}" onclick="window.safetyComplianceEngine.setCategoryFilter('monthly')" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px;">
                <span class="view-hint">🔍 View</span>
                <div style="font-size: 10.5px; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">🚛 Monthly Checklists</div>
                <div style="font-size: 18px; font-weight: 700; color: #34d399; margin-top: 2px;">${monthlyDisplay}</div>
                <div style="font-size: 10px; color: ${newMonthly > 0 ? '#34d399' : '#94a3b8'}; margin-top: 2px; font-weight: ${newMonthly > 0 ? '700' : '500'};">${newMonthly > 0 ? `+${newMonthly} new` : 'Up to date'}</div>
              </div>
              <div class="stat-card-clickable ${this.activeCategoryFilter === 'equipment' ? 'active' : ''}" onclick="window.safetyComplianceEngine.setCategoryFilter('equipment')" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px;">
                <span class="view-hint">🔍 View</span>
                <div style="font-size: 10.5px; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">⚠️ Equipment Needs</div>
                <div style="font-size: 18px; font-weight: 700; color: #f59e0b; margin-top: 2px;">${issuesDisplay}</div>
                <div style="font-size: 10px; color: ${(stats.totalIssues || 0) > 0 ? '#f59e0b' : '#94a3b8'}; margin-top: 2px;">${(stats.totalIssues || 0) > 0 ? `${stats.totalIssues} new` : 'None detected'}</div>
              </div>
              <div class="stat-card-clickable" onclick="window.safetyComplianceEngine.setCategoryFilter('all')" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px;">
                <div style="font-size: 10.5px; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">📬 Total Emails</div>
                <div style="font-size: 18px; font-weight: 800; color: #f8fafc; margin-top: 2px;">${stats.totalThreads || allDisplay}</div>
                <div style="font-size: 10px; color: #94a3b8; margin-top: 2px;">Scanned in Gmail</div>
              </div>
            `;
          })()}
        </div>

        <!-- Filter bar, Month selector & Sort Controls -->
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 2px;">
          <input type="text" id="safety-log-search" placeholder="🔍 Search foreman, job #, date..." value="${this.escapeHtml(this.searchQuery)}" oninput="window.safetyComplianceEngine.onSearchInput(this.value)" style="flex: 1; min-width: 180px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 12px; color: var(--text-primary); font-size: 12px;" />
          
          <!-- Month Filter Selector -->
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 11px; color: var(--text-muted); font-weight: 600;">Month:</span>
            <select id="safety-log-month-filter" onchange="window.safetyComplianceEngine.setMonthFilter(this.value)" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 10px; color: #60a5fa; font-size: 12px; font-weight: 600;">
              <option value="all" ${this.selectedMonthFilter === 'all' ? 'selected' : ''}>🗓️ All Months (Full Year)</option>
              ${availableMonths.map(m => `
                <option value="${m.key}" ${this.selectedMonthFilter === m.key ? 'selected' : ''}>${m.label}</option>
              `).join('')}
            </select>
          </div>

          <!-- Sort Order Selector -->
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 11px; color: var(--text-muted); font-weight: 600;">Sort By:</span>
            <select id="safety-log-sort-filter" onchange="window.safetyComplianceEngine.setSortOption(this.value)" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 10px; color: #34d399; font-size: 12px; font-weight: 600;">
              <option value="date_desc" ${this.activeSortOption === 'date_desc' ? 'selected' : ''}>📅 Date (Newest First)</option>
              <option value="date_asc" ${this.activeSortOption === 'date_asc' ? 'selected' : ''}>📅 Date (Oldest First)</option>
              <option value="month_desc" ${this.activeSortOption === 'month_desc' ? 'selected' : ''}>🗓️ Month (Newest to Oldest)</option>
              <option value="month_asc" ${this.activeSortOption === 'month_asc' ? 'selected' : ''}>🗓️ Month (Oldest to Newest)</option>
              <option value="job_foreman" ${this.activeSortOption === 'job_foreman' ? 'selected' : ''}>👷 Job # / Foreman</option>
              <option value="month_job_foreman" ${this.activeSortOption === 'month_job_foreman' ? 'selected' : ''}>🗓️👷 Month, then Job # / Foreman</option>
              <option value="received_desc" ${this.activeSortOption === 'received_desc' ? 'selected' : ''}>📥 Date Received (Newest)</option>
            </select>
          </div>

          <span id="log-count-indicator" style="font-size: 11.5px; color: var(--text-muted); font-weight: 600;"></span>
        </div>

        <!-- Drill-down log items list -->
        <div class="safety-logs-container" id="safety-logs-table-container">
          ${this.renderLogsTableHtml()}
        </div>
      </div>
    `;
    this.updateLogCountIndicator();
  }

  setCategoryFilter(category) {
    this.activeCategoryFilter = category;
    const body = document.getElementById('process-safety-emails-modal-body');
    if (body) {
      const cards = body.querySelectorAll('.stat-card-clickable');
      cards.forEach(card => card.classList.remove('active'));
      const container = document.getElementById('safety-logs-table-container');
      if (container) {
        container.innerHTML = this.renderLogsTableHtml();
        this.updateLogCountIndicator();
      }
    }
  }

  setMonthFilter(monthKey) {
    this.selectedMonthFilter = monthKey || 'all';
    const container = document.getElementById('safety-logs-table-container');
    if (container) {
      container.innerHTML = this.renderLogsTableHtml();
      this.updateLogCountIndicator();
    }
  }

  setSortOption(sortKey) {
    this.activeSortOption = sortKey || 'date_desc';
    const container = document.getElementById('safety-logs-table-container');
    if (container) {
      container.innerHTML = this.renderLogsTableHtml();
      this.updateLogCountIndicator();
    }
  }

  onSearchInput(val) {
    this.searchQuery = val || '';
    const container = document.getElementById('safety-logs-table-container');
    if (container) {
      container.innerHTML = this.renderLogsTableHtml();
      this.updateLogCountIndicator();
    }
  }

  updateLogCountIndicator() {
    const ind = document.getElementById('log-count-indicator');
    if (ind) {
      const filtered = this.getFilteredLogs();
      ind.textContent = `Showing ${filtered.length} item(s)`;
    }
  }

  getFilteredLogs() {
    let logs = this.currentLogs || [];

    // Category filter
    if (this.activeCategoryFilter === 'jha') {
      logs = logs.filter(l => l.type === 'JHA' || l.sheetName === 'JHA Log');
    } else if (this.activeCategoryFilter === 'weekly') {
      logs = logs.filter(l => l.type === 'Weekly Safety Meeting' || l.sheetName === 'Weekly Safety Log');
    } else if (this.activeCategoryFilter === 'monthly') {
      logs = logs.filter(l => l.type === 'Monthly Checklist' || l.sheetName === 'Monthly Checklist Log');
    } else if (this.activeCategoryFilter === 'equipment') {
      logs = logs.filter(l => l.hasEquipmentIssues === 'Yes' || l.type === 'Equipment');
    }

    // Month filter
    if (this.selectedMonthFilter && this.selectedMonthFilter !== 'all') {
      logs = logs.filter(l => {
        const dStr = l.date || l.dateReceived;
        const d = this.parseDate(dStr);
        if (!d) return false;
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${yyyy}-${mm}` === this.selectedMonthFilter;
      });
    }

    // Search query filter
    if (this.searchQuery && this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase().trim();
      logs = logs.filter(l => {
        return (l.foreman && l.foreman.toLowerCase().includes(q)) ||
               (l.jobNumber && l.jobNumber.toLowerCase().includes(q)) ||
               (l.creditedTo && l.creditedTo.toLowerCase().includes(q)) ||
               (l.date && l.date.toLowerCase().includes(q)) ||
               (l.dateReceived && l.dateReceived.toLowerCase().includes(q)) ||
               (l.subject && l.subject.toLowerCase().includes(q)) ||
               (l.notes && l.notes.toLowerCase().includes(q));
      });
    }

    // Apply active sort
    return this.sortLogs(logs, this.activeSortOption || 'date_desc');
  }

  renderLogsTableHtml() {
    const logs = this.getFilteredLogs();
    if (!logs || logs.length === 0) {
      return `
        <div style="padding: 32px 16px; text-align: center; color: var(--text-muted); font-size: 12.5px;">
          No log entries match the selected filter.
        </div>
      `;
    }

    return `
      <table class="safety-log-table">
        <thead>
          <tr>
            <th style="width: 105px;">Type</th>
            <th style="width: 85px;">Report Date</th>
            <th style="width: 110px;">Date Received</th>
            <th style="width: 75px;">Job #</th>
            <th>Foreman</th>
            <th style="width: 80px;">Credited</th>
            <th style="width: 75px;">Status</th>
            <th style="width: 175px; text-align: center;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map((log) => {
            const typeClass = log.type === 'JHA' ? 'jha' : (log.type === 'Weekly Safety Meeting' ? 'weekly' : (log.type === 'Monthly Checklist' ? 'monthly' : 'equipment'));
            const typeLabel = log.type === 'JHA' ? '📋 JHA' : (log.type === 'Weekly Safety Meeting' ? '🗣️ Meeting' : (log.type === 'Monthly Checklist' ? '🚛 Checklist' : '⚠️ Issue'));
            const statusColor = log.status === 'Credited' ? '#34d399' : (log.status === 'Unknown Job' ? '#f59e0b' : '#94a3b8');
            const logIdentifier = this.escapeHtml(log.id || (log.sheetName + '_' + log.rowIndex));

            return `
              <tr>
                <td>
                  <span class="badge-log-type ${typeClass}">${typeLabel}</span>
                </td>
                <td style="font-weight: 600; color: #f8fafc;">${this.escapeHtml(log.date || '—')}</td>
                <td style="font-size: 11.5px; color: #94a3b8; font-family: monospace;">${this.escapeHtml(log.dateReceived || '—')}</td>
                <td><span style="font-family: monospace; font-weight: 700; color: #60a5fa;">${this.escapeHtml(log.jobNumber || '—')}</span></td>
                <td style="font-weight: 600;">${this.escapeHtml(log.foreman || 'UNKNOWN')}</td>
                <td><span style="font-family: monospace; color: #cbd5e1;">${this.escapeHtml(log.creditedTo || '—')}</span></td>
                <td>
                  <span style="color: ${statusColor}; font-weight: 700; font-size: 11px;">
                    ${this.escapeHtml(log.status || 'Pending')}
                  </span>
                </td>
                <td style="text-align: center;">
                  <div style="display: inline-flex; align-items: center; justify-content: center; gap: 5px;">
                    <button class="btn-pdf-link" onclick="window.safetyComplianceEngine.openPdfViewer('${logIdentifier}')" title="Preview original attached PDF document directly in the app">
                      📄 View PDF
                    </button>
                    <button class="btn-edit-log-row" onclick="window.safetyComplianceEngine.openEditLogModal('${logIdentifier}')" title="Edit log info (fix typos)">
                      ✏️ Edit
                    </button>
                    <button class="btn-delete-log-row" onclick="window.safetyComplianceEngine.deleteLogEntry('${logIdentifier}')" title="Delete log record">
                      🗑️
                    </button>
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  openProcessEmailsModal() {
    const modal = document.getElementById('process-safety-emails-modal');
    const modalBox = document.getElementById('process-safety-emails-modal-box');
    const titleEl = document.getElementById('process-safety-emails-modal-title');
    const iconEl = document.getElementById('process-safety-emails-modal-icon');
    const body = document.getElementById('process-safety-emails-modal-body');
    const footer = document.getElementById('process-safety-emails-modal-footer');
    if (!modal || !body) return;

    if (modalBox) modalBox.style.maxWidth = '740px';
    if (titleEl) titleEl.textContent = 'Process Safety Emails (Gmail Scanner)';
    if (iconEl) iconEl.textContent = '📬';

    const jhaTable = this.db.getTable('jha_log');
    const weeklyTable = this.db.getTable('weekly_safety_log');
    const monthlyTable = this.db.getTable('monthly_checklist_log');

    const totalJhaCount = jhaTable && jhaTable.rows ? jhaTable.rows.length : 0;
    const totalWeeklyCount = weeklyTable && weeklyTable.rows ? weeklyTable.rows.length : 0;
    const totalMonthlyCount = monthlyTable && monthlyTable.rows ? monthlyTable.rows.length : 0;

    body.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <!-- Overview Banner -->
        <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(5, 150, 105, 0.05) 100%); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 14px 18px;">
          <div style="font-size: 13.5px; font-weight: 700; color: #6ee7b7; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
            <span>📬</span> Automated Safety Documentation Scanner
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.5;">
            Scans your safety mailbox for incoming foreman emails, parses PDF attachments, updates the <strong>JHA Log</strong>, <strong>Weekly Safety Log</strong>, and <strong>Monthly Checklist Log</strong>, and recalculates the <strong>Safety Compliance</strong> matrix.
          </div>
        </div>

        <!-- Current Database Statistics -->
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
          <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px; text-align: center;">
            <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">📋 Logged JHAs</div>
            <div style="font-size: 18px; font-weight: 800; color: #60a5fa; margin-top: 2px;">${totalJhaCount}</div>
          </div>
          <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px; text-align: center;">
            <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">🗣️ Weekly Meetings</div>
            <div style="font-size: 18px; font-weight: 800; color: #a78bfa; margin-top: 2px;">${totalWeeklyCount}</div>
          </div>
          <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px; text-align: center;">
            <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">🚛 Monthly Checks</div>
            <div style="font-size: 18px; font-weight: 800; color: #34d399; margin-top: 2px;">${totalMonthlyCount}</div>
          </div>
        </div>

        <!-- Step 1: Select Report Type -->
        <div style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px 16px;">
          <label style="font-size: 12px; font-weight: 700; color: #f8fafc; display: block; margin-bottom: 8px;">
            1. Report Types to Process
          </label>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); cursor: pointer; background: var(--bg-primary); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color);">
              <input type="radio" name="proc-report-type" value="ALL" checked style="accent-color: #10b981;">
              <span>🌟 All Safety Reports (Recommended)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); cursor: pointer; background: var(--bg-primary); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color);">
              <input type="radio" name="proc-report-type" value="JHA" style="accent-color: #10b981;">
              <span>📋 Daily JHAs Only</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); cursor: pointer; background: var(--bg-primary); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color);">
              <input type="radio" name="proc-report-type" value="WEEKLY" style="accent-color: #10b981;">
              <span>🗣️ Weekly Safety Meetings Only</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); cursor: pointer; background: var(--bg-primary); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color);">
              <input type="radio" name="proc-report-type" value="MONTHLY" style="accent-color: #10b981;">
              <span>🚛 Monthly Fleet Checklists Only</span>
            </label>
          </div>
        </div>

        <!-- Step 2: Select Date Range / Scope -->
        <div style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px 16px;">
          <label style="font-size: 12px; font-weight: 700; color: #f8fafc; display: block; margin-bottom: 8px;">
            2. Email Date Range
          </label>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); cursor: pointer;">
              <input type="radio" name="proc-date-scope" value="new" checked onchange="document.getElementById('custom-date-box').style.display='none';" style="accent-color: #10b981;">
              <span>⚡ <strong>Only New Emails</strong> (Fastest — scans since last processed date)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); cursor: pointer;">
              <input type="radio" name="proc-date-scope" value="7" onchange="document.getElementById('custom-date-box').style.display='none';" style="accent-color: #10b981;">
              <span>📅 Last 7 Days</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); cursor: pointer;">
              <input type="radio" name="proc-date-scope" value="14" onchange="document.getElementById('custom-date-box').style.display='none';" style="accent-color: #10b981;">
              <span>📅 Last 14 Days</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); cursor: pointer;">
              <input type="radio" name="proc-date-scope" value="30" onchange="document.getElementById('custom-date-box').style.display='none';" style="accent-color: #10b981;">
              <span>📅 Last 30 Days</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); cursor: pointer;">
              <input type="radio" name="proc-date-scope" value="custom" onchange="document.getElementById('custom-date-box').style.display='flex';" style="accent-color: #10b981;">
              <span>🗓️ Custom Date Range...</span>
            </label>
          </div>

          <!-- Custom Date Range Picker (Hidden by default) -->
          <div id="custom-date-box" style="display: none; align-items: center; gap: 12px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border-color);">
            <div style="flex: 1;">
              <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 2px;">Start Date:</label>
              <input type="date" id="proc-start-date" class="sheet-search" style="width: 100%; font-size: 12px;">
            </div>
            <div style="flex: 1;">
              <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 2px;">End Date (Optional):</label>
              <input type="date" id="proc-end-date" class="sheet-search" style="width: 100%; font-size: 12px;">
            </div>
          </div>
        </div>

        <!-- Step 3: Select Processing Speed / Mode -->
        <div style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px 16px;">
          <label style="font-size: 12px; font-weight: 700; color: #f8fafc; display: block; margin-bottom: 8px;">
            3. Processing Mode
          </label>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
            <label style="display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--text-primary); cursor: pointer; background: var(--bg-primary); padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border-color);">
              <input type="radio" name="proc-speed-mode" value="fast" checked style="accent-color: #10b981; margin-top: 2px;">
              <div>
                <span style="font-weight: 700; color: #6ee7b7;">⚡ Fast Mode (Recommended)</span>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px; line-height: 1.35;">
                  Parses subject lines & email dates. Blazing fast (15-20 emails/batch) and prevents Google proxy timeouts.
                </div>
              </div>
            </label>
            <label style="display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--text-primary); cursor: pointer; background: var(--bg-primary); padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border-color);">
              <input type="radio" name="proc-speed-mode" value="deep" style="accent-color: #10b981; margin-top: 2px;">
              <div>
                <span style="font-weight: 700; color: #f8fafc;">🔍 Deep Scan (Extract PDFs)</span>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px; line-height: 1.35;">
                  Uses Google Drive OCR to read attached PDFs for internal JHA dates. Automatically runs in the background (6-min cloud quota) to prevent browser proxy timeouts.
                </div>
              </div>
            </label>
          </div>
        </div>
      </div>
    `;

    if (footer) {
      footer.innerHTML = `
        <button class="btn btn-secondary" onclick="window.safetyComplianceEngine.closeProcessEmailsModal()">Cancel</button>
        <button class="btn btn-secondary" id="btn-bg-process-emails" onclick="window.safetyComplianceEngine.startCloudBackgroundProcess()" style="display: flex; align-items: center; gap: 6px;" title="Execute processing directly on Google Cloud servers in the background with a 6-minute quota and zero proxy timeouts">
          <span>⚡</span> Run in Background
        </button>
        <button class="btn btn-primary" id="btn-start-process-emails" onclick="window.safetyComplianceEngine.runProcessEmails()" style="font-weight: 700; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border: none; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);">
          <span>🚀</span> Process Safety Emails Now
        </button>
      `;
    }

    modal.style.display = 'flex';
  }

  /**
   * Triggers asynchronous background safety email processing on Google Cloud servers.
   * Executes via a 1-shot time-driven trigger on Google Apps Script with a 6-minute quota,
   * completely avoiding HTTP proxy gateway limits, while polling status in the desktop app.
   */
  async startCloudBackgroundProcess() {
    const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
    if (!syncUrl) {
      alert('Sync URL not configured. Please connect to Google Sheets in the header bar first.');
      return;
    }

    const scopeRadio = document.querySelector('input[name="proc-date-scope"]:checked');
    const scopeVal = scopeRadio ? scopeRadio.value : '7';
    let daysBack = 7;
    let newOnlyMode = true;
    let startDate = '';
    let endDate = '';

    if (scopeVal === 'new') {
      newOnlyMode = true;
      daysBack = 7;
    } else if (scopeVal === 'custom') {
      newOnlyMode = false;
      startDate = document.getElementById('proc-start-date') ? document.getElementById('proc-start-date').value : '';
      endDate = document.getElementById('proc-end-date') ? document.getElementById('proc-end-date').value : '';
      if (startDate) {
        const startParsed = new Date(startDate);
        const now = new Date();
        daysBack = Math.max(1, Math.ceil((now.getTime() - startParsed.getTime()) / (1000 * 60 * 60 * 24)));
      }
    } else {
      newOnlyMode = false;
      daysBack = parseInt(scopeVal, 10) || 7;
    }

    const speedRadio = document.querySelector('input[name="proc-speed-mode"]:checked');
    const skipPdfExtraction = speedRadio ? (speedRadio.value === 'fast') : true;

    const filterRadio = document.querySelector('input[name="proc-report-type"]:checked');
    const reportTypeFilter = filterRadio ? filterRadio.value : 'ALL';

    this.closeProcessEmailsModal();
    this.showToast('⚡ Initiating background email scan on Google Cloud servers...');

    const widget = document.getElementById('safety-emails-bg-widget');
    if (widget) widget.style.display = 'flex';
    this.updateBackgroundWidget({
      title: 'Google Cloud Background Scan',
      sub: 'Starting background worker on Google Apps Script...'
    });

    try {
      const payload = {
        action: 'startProcessSafetyEmailsInBackground',
        reportTypeFilter: reportTypeFilter,
        daysBack: daysBack,
        newOnlyMode: newOnlyMode,
        fastMode: skipPdfExtraction,
        startDate: startDate,
        endDate: endDate
      };

      const startRes = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', payload, 30000);
      if (!startRes || !startRes.success) {
        throw new Error((startRes && startRes.error) || 'Failed to start background trigger on server.');
      }

      this.updateBackgroundWidget({
        title: 'Google Cloud Background Scan',
        sub: 'Worker running in cloud. Polling status...'
      });

      // Poll status every 4 seconds
      const startTime = Date.now();
      const pollInterval = setInterval(async () => {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);

        try {
          const statusRes = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', {
            action: 'getSafetyEmailsStatus',
            reportTypeFilter: reportTypeFilter
          }, 30000);

          const curStatus = (statusRes && statusRes.currentStatus) || 'IDLE';

          if (curStatus === 'RUNNING') {
            this.updateBackgroundWidget({
              title: 'Google Cloud Background Scan',
              sub: `Worker active in cloud (${elapsedSec}s elapsed)...`
            });
          } else if (curStatus === 'COMPLETE') {
            clearInterval(pollInterval);
            this.updateBackgroundWidget({
              title: '✅ Cloud Scan Completed',
              sub: `Finished in ${elapsedSec}s. Syncing local tables...`
            });

            // Refresh database from Google Sheets
            if (window.syncEngine) {
              await window.syncEngine.syncWithGoogleSheets();
            }
            if (window.sheetNavigator) {
              window.sheetNavigator.renderSafetyCompliance();
            }
            this.showToast('✅ Safety emails processed successfully in the cloud! Compliance updated.');

            setTimeout(() => {
              if (widget) widget.style.display = 'none';
            }, 6000);

          } else if (curStatus.startsWith('ERROR')) {
            clearInterval(pollInterval);
            this.updateBackgroundWidget({
              title: '❌ Cloud Scan Error',
              sub: curStatus
            });
            this.showToast(curStatus, true);
          } else if (elapsedSec > 360) {
            // Safety timeout after 6 minutes
            clearInterval(pollInterval);
            this.updateBackgroundWidget({
              title: '⚠️ Background Scan Timeout',
              sub: 'Worker took longer than 6 minutes. Try running again.'
            });
          }
        } catch (pollErr) {
          console.warn('Status poll warning:', pollErr);
        }
      }, 4000);

    } catch (err) {
      console.error('startCloudBackgroundProcess error:', err);
      this.updateBackgroundWidget({
        title: '❌ Failed to Start Cloud Scan',
        sub: err.message
      });
      this.showToast(`Error: ${err.message}`, true);
    }
  }

  showToast(msg, isError = false) {
    const existing = document.getElementById('app-toast');
    if (existing) {
      if (typeof existing.remove === 'function') existing.remove();
      else if (existing.parentNode) existing.parentNode.removeChild(existing);
    }
    const toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: ${isError ? '#ef4444' : '#10b981'};
      color: #ffffff;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      z-index: 99999;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: slideInUp 0.2s ease-out;
    `;
    toast.innerHTML = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4500);
  }

  minimizeProcessEmailsModal() {
    this.isMinimized = true;
    const modal = document.getElementById('process-safety-emails-modal');
    if (modal) modal.style.display = 'none';

    const widget = document.getElementById('safety-emails-bg-widget');
    if (widget) widget.style.display = 'flex';

    this.showToast('📬 Email scan is continuing in the background. You can navigate and make edits freely!');
  }

  restoreProcessEmailsModal() {
    this.isMinimized = false;
    const widget = document.getElementById('safety-emails-bg-widget');
    if (widget) widget.style.display = 'none';

    const modal = document.getElementById('process-safety-emails-modal');
    if (modal) modal.style.display = 'flex';
  }

  cancelProcessEmails() {
    if (!this.isProcessing) return;
    this.cancelRequested = true;
    const subEl = document.getElementById('proc-live-sub');
    if (subEl) subEl.textContent = '🛑 Stopping scan after current batch finishes...';
    this.updateBackgroundWidget({ sub: 'Stopping after current batch...' });
    this.showToast('🛑 Safety email scanner will stop after the current batch finishes.');
  }

  dismissBackgroundWidget() {
    const widget = document.getElementById('safety-emails-bg-widget');
    if (widget) widget.style.display = 'none';
  }

  updateBackgroundWidget(opts = {}) {
    const widget = document.getElementById('safety-emails-bg-widget');
    if (!widget) return;

    if (opts.pct !== undefined) {
      const pctEl = document.getElementById('safety-bg-pct');
      if (pctEl) pctEl.textContent = `${opts.pct}%`;
      const barEl = document.getElementById('safety-bg-bar');
      if (barEl) barEl.style.width = `${Math.max(5, opts.pct)}%`;
    }

    if (opts.title) {
      const titleEl = document.getElementById('safety-bg-title-text');
      if (titleEl) titleEl.textContent = opts.title;
    }

    if (opts.sub) {
      const subEl = document.getElementById('safety-bg-sub');
      if (subEl) subEl.textContent = opts.sub;
    }

    if (opts.status === 'completed') {
      widget.classList.add('completed');
      widget.classList.remove('error');
      const spinner = document.getElementById('safety-bg-spinner');
      if (spinner) {
        spinner.style.animation = 'none';
        spinner.style.border = 'none';
        spinner.textContent = '✅';
        spinner.style.fontSize = '18px';
      }
      const dismissBtn = document.getElementById('safety-bg-dismiss-btn');
      if (dismissBtn) dismissBtn.style.display = 'flex';
    } else if (opts.status === 'error') {
      widget.classList.add('error');
      widget.classList.remove('completed');
      const spinner = document.getElementById('safety-bg-spinner');
      if (spinner) {
        spinner.style.animation = 'none';
        spinner.style.border = 'none';
        spinner.textContent = '❌';
        spinner.style.fontSize = '18px';
      }
      const dismissBtn = document.getElementById('safety-bg-dismiss-btn');
      if (dismissBtn) dismissBtn.style.display = 'flex';
    } else {
      widget.classList.remove('completed', 'error');
      const spinner = document.getElementById('safety-bg-spinner');
      if (spinner) {
        spinner.textContent = '';
        spinner.style.fontSize = '';
        spinner.style.border = '2.5px solid rgba(16, 185, 129, 0.25)';
        spinner.style.borderTopColor = '#34d399';
        spinner.style.animation = 'spin 0.85s linear infinite';
      }
      const dismissBtn = document.getElementById('safety-bg-dismiss-btn');
      if (dismissBtn) dismissBtn.style.display = 'none';
    }
  }

  closeProcessEmailsModal() {
    if (this.isProcessing) {
      this.minimizeProcessEmailsModal();
      return;
    }
    const modal = document.getElementById('process-safety-emails-modal');
    if (modal) modal.style.display = 'none';
  }

  async runProcessEmails(options = {}) {
    if (this.isProcessing) {
      if (!options || !options.runInBackground) {
        this.restoreProcessEmailsModal();
      }
      return;
    }

    const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
    if (!syncUrl) {
      if (!options || !options.silent) {
        alert('⚠️ Please configure your Google Apps Script Web App sync URL first in Settings.');
      }
      return;
    }

    const isBackground = !!(options && options.runInBackground);

    const typeRadio = document.querySelector('input[name="proc-report-type"]:checked');
    const reportTypeFilter = (options && options.reportTypeFilter) || (typeRadio ? typeRadio.value : 'ALL');

    const scopeRadio = document.querySelector('input[name="proc-date-scope"]:checked');
    const scopeVal = scopeRadio ? scopeRadio.value : 'new';

    let daysBack = (options && options.daysBack !== undefined) ? options.daysBack : 7;
    let newOnlyMode = (options && options.newOnlyMode !== undefined) ? options.newOnlyMode : true;
    let startDate = (options && options.startDate) || null;
    let endDate = (options && options.endDate) || null;

    if (!options || (options.newOnlyMode === undefined && options.daysBack === undefined)) {
      if (scopeVal === 'new') {
        newOnlyMode = true;
        daysBack = 7;
      } else if (scopeVal === 'custom') {
        newOnlyMode = false;
        startDate = document.getElementById('proc-start-date')?.value || null;
        endDate = document.getElementById('proc-end-date')?.value || null;
        if (startDate) {
          const startD = new Date(startDate);
          const nowD = new Date();
          const diffDays = Math.max(1, Math.ceil((nowD - startD) / (1000 * 60 * 60 * 24)));
          daysBack = diffDays;
        }
      } else {
        newOnlyMode = false;
        daysBack = parseInt(scopeVal, 10) || 7;
      }
    }

    const speedRadio = document.querySelector('input[name="proc-speed-mode"]:checked');
    let skipPdfExtraction = (options && options.skipPdfExtraction !== undefined)
      ? options.skipPdfExtraction
      : (speedRadio ? (speedRadio.value === 'fast') : true);

    // Deep Scan uses Google Drive OCR (~15-30s per PDF) which exceeds Google's synchronous 25s Web App HTTP proxy timeout.
    // Automatically route Deep Scan to the Cloud Background Worker where it executes with a full 6-minute quota and zero proxy timeouts!
    if (!skipPdfExtraction) {
      console.log('Deep Scan selected: routing to Cloud Background Process to prevent HTTP proxy timeout.');
      return this.startCloudBackgroundProcess();
    }

    this.isProcessing = true;
    this.isMinimized = isBackground;
    this.cancelRequested = false;

    const modal = document.getElementById('process-safety-emails-modal');
    if (modal) {
      if (isBackground) {
        modal.style.display = 'none';
      } else {
        modal.style.display = 'flex';
      }
    }

    const widget = document.getElementById('safety-emails-bg-widget');
    if (widget && isBackground) {
      widget.style.display = 'flex';
    }

    const minBtn = document.getElementById('btn-minimize-process-emails');
    if (minBtn) minBtn.style.display = 'inline-flex';

    const body = document.getElementById('process-safety-emails-modal-body');
    const footer = document.getElementById('process-safety-emails-modal-footer');

    if (body) {
      body.innerHTML = `
        <div style="padding: 24px 16px; text-align: center;">
          <div class="spinner" style="width: 44px; height: 44px; border: 4px solid rgba(16, 185, 129, 0.2); border-top-color: #10b981; border-radius: 50%; animation: spin 0.85s linear infinite; margin: 0 auto 16px auto;"></div>
          <h3 id="proc-live-title" style="color: #f8fafc; font-size: 16px; font-weight: 700; margin-bottom: 6px;">Scanning Gmail & Processing Emails...</h3>
          <div id="proc-live-sub" style="color: var(--text-secondary); font-size: 12.5px; margin-bottom: 18px;">
            Connecting to Gmail, searching for safety emails (${reportTypeFilter})...
          </div>

          <!-- Live Progress Bar -->
          <div style="width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 12px; height: 22px; overflow: hidden; position: relative; margin-bottom: 14px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.4);">
            <div id="proc-live-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981 0%, #059669 100%); border-radius: 12px; transition: width 0.3s ease; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5);">
              0%
            </div>
          </div>

          <!-- Running Email Counter Box -->
          <div id="proc-live-counter" style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px; display: inline-flex; flex-direction: column; gap: 4px; min-width: 320px;">
            <div style="font-size: 13px; font-weight: 700; color: #6ee7b7;" id="proc-live-count-text">
              Searching Gmail...
            </div>
            <div style="font-size: 11px; color: var(--text-muted);" id="proc-live-stats-text">
              0 processed • 0 skipped • 0 equipment issues
            </div>
          </div>
        </div>
      `;
    }

    if (footer) {
      footer.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <button class="btn btn-secondary" onclick="window.safetyComplianceEngine.minimizeProcessEmailsModal()" style="font-weight: 600; color: #a7f3d0; border: 1px solid rgba(16, 185, 129, 0.4); background: rgba(6, 78, 59, 0.4); display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 6px 12px;" title="Keep scanning in the background while you use other tabs and make edits">
            <span>🗕</span> Run in Background
          </button>
          <div style="display: flex; align-items: center; gap: 10px;">
            <span class="spinner" style="width: 14px; height: 14px; border: 2px solid rgba(16, 185, 129, 0.2); border-top-color: #10b981; border-radius: 50%; display: inline-block; animation: spin 0.85s linear infinite;"></span>
            <span style="font-size: 12px; color: var(--text-muted);">Scanning Gmail...</span>
            <button class="btn btn-secondary" onclick="window.safetyComplianceEngine.cancelProcessEmails()" style="font-size: 11px; padding: 4px 8px; color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.1);" title="Finish current batch and save progress">
              🛑 Stop After Batch
            </button>
          </div>
        </div>
      `;
    }

    this.updateBackgroundWidget({
      title: '📬 Scanning Emails',
      sub: `Connecting to Gmail (${reportTypeFilter})...`,
      pct: 0,
      status: 'scanning'
    });

    try {
      let totalThreads = 0;
      let totalProcessed = 0;
      let totalSkipped = 0;
      let totalIssues = 0;
      let cumulativeLogs = { jha: 0, weekly: 0, monthly: 0 };
      let isComplete = false;
      let isPostProcessing = false;
      let lastResult = null;
      let finalSnapshot = null;
      let finalUpdatedRows = null;
      let finalResult = null;
      let batchIndex = 1;

      while (!isComplete) {
        if (this.cancelRequested) {
          console.log('User requested cancellation of safety email scanning.');
          isComplete = true;
          break;
        }

        console.log(`Executing safety email batch #${batchIndex}...`);
        const payload = {
          action: 'processSafetyEmails',
          daysBack: daysBack,
          // Safe batch sizes: 8 threads on batch 1 (accounts for initial search/setup), 15 threads on continuation batches, 1 thread in Deep Scan (OCR)
          batchSize: skipPdfExtraction ? (batchIndex === 1 && !isPostProcessing ? 8 : 15) : 1,
          reportTypeFilter: reportTypeFilter,
          newOnlyMode: newOnlyMode,
          skipPdfExtraction: skipPdfExtraction,
          endDate: endDate,
          isPostProcessing: isPostProcessing,
          prevResult: lastResult,
          resetBatch: (batchIndex === 1 && !isPostProcessing)
        };

        // Resilient network request with automatic retry on temporary server/gateway hiccups
        let response = null;
        let batchAttempts = 0;
        while (batchAttempts < 3) {
          batchAttempts++;
          try {
            response = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', payload, 180000);
            if (response && response.success) {
              break;
            }
            if (batchAttempts < 3) {
              console.warn(`Safety email batch #${batchIndex} attempt ${batchAttempts} returned non-success, retrying in 3.5s:`, response);
              // If we were running in Deep Scan mode and timed out, automatically fall back to Fast Mode for this and remaining batches!
              if (!skipPdfExtraction) {
                console.warn('Switching to Fast Mode (skipPdfExtraction = true) for subsequent attempt to bypass heavy PDF OCR timeout.');
                skipPdfExtraction = true;
                payload.skipPdfExtraction = true;
                payload.batchSize = 15;
              }
              const subEl = document.getElementById('proc-live-sub');
              if (subEl) subEl.textContent = `Server busy, retrying batch #${batchIndex} (attempt ${batchAttempts + 1}/3)...`;
              this.updateBackgroundWidget({ sub: `Retrying batch #${batchIndex} (${batchAttempts + 1}/3)...` });
              await new Promise(r => setTimeout(r, 3500));
            }
          } catch (netErr) {
            if (batchAttempts < 3) {
              console.warn(`Safety email batch #${batchIndex} attempt ${batchAttempts} network error, retrying in 3.5s:`, netErr);
              // If we were running in Deep Scan mode and encountered a timeout/404, auto-switch to Fast Mode to bypass the bad PDF
              if (!skipPdfExtraction) {
                console.warn('Switching to Fast Mode (skipPdfExtraction = true) for subsequent attempt to bypass heavy PDF OCR timeout.');
                skipPdfExtraction = true;
                payload.skipPdfExtraction = true;
                payload.batchSize = 15;
              }
              const subEl = document.getElementById('proc-live-sub');
              if (subEl) subEl.textContent = `Server busy or proxy timeout, retrying batch #${batchIndex} (attempt ${batchAttempts + 1}/3)...`;
              this.updateBackgroundWidget({ sub: `Retrying batch #${batchIndex} (${batchAttempts + 1}/3)...` });
              await new Promise(r => setTimeout(r, 3500));
            } else {
              throw netErr;
            }
          }
        }

        console.log(`Safety email batch #${batchIndex} response:`, response);

        // Guard against receiving a raw database snapshot on server timeout/redirect
        if (response && response.version && response.tables && !response.result) {
          throw new Error('The Google Apps Script server timed out while scanning emails. Please try selecting a shorter date range (e.g. Last 7 Days) or try again.');
        }

        if (!response || !response.success) {
          let errMsg = (response && (response.error || response.message)) 
            ? (response.error || response.message) 
            : 'No response from Apps Script server.';
          if (typeof errMsg === 'object') {
            errMsg = JSON.stringify(errMsg);
          }
          if (errMsg.length > 250) {
            errMsg = errMsg.substring(0, 250) + '...';
          }
          throw new Error(errMsg);
        }

        const res = response.result || {};
        lastResult = res;

        // Extract numbers
        if (res.totalThreads !== undefined) totalThreads = res.totalThreads;
        const processedSoFar = res.threadsProcessed !== undefined ? res.threadsProcessed : (totalProcessed + (res.processedThisBatch || 0) + (res.skippedThisBatch || 0));
        totalProcessed += (res.processedThisBatch || 0);
        totalSkipped += (res.skippedThisBatch || 0);
        totalIssues += (res.issuesThisBatch || 0);

        if (res.logsCreated) {
          cumulativeLogs.jha += (res.logsCreated.jha || 0);
          cumulativeLogs.weekly += (res.logsCreated.weekly || 0);
          cumulativeLogs.monthly += (res.logsCreated.monthly || 0);
        }

        // Update Live UI
        const barEl = document.getElementById('proc-live-bar');
        const countTextEl = document.getElementById('proc-live-count-text');
        const statsTextEl = document.getElementById('proc-live-stats-text');
        const titleEl = document.getElementById('proc-live-title');
        const subEl = document.getElementById('proc-live-sub');

        const pct = totalThreads > 0 ? Math.min(100, Math.round((processedSoFar / totalThreads) * 100)) : (isPostProcessing ? 98 : 10);

        if (barEl) {
          barEl.style.width = `${Math.max(5, pct)}%`;
          barEl.textContent = `${pct}%`;
        }

        if (countTextEl) {
          if (totalThreads > 0) {
            countTextEl.innerHTML = `Scanned <strong>${processedSoFar}</strong> of <strong>${totalThreads}</strong> emails (${pct}%)`;
          } else {
            countTextEl.textContent = `Scanned ${processedSoFar} emails...`;
          }
        }

        if (statsTextEl) {
          statsTextEl.textContent = `${totalProcessed} logged • ${totalSkipped} skipped • ${totalIssues} equipment issues`;
        }

        this.updateBackgroundWidget({
          pct: pct,
          sub: totalThreads > 0 ? `Scanned ${processedSoFar} of ${totalThreads} (${pct}%) • Batch #${batchIndex}` : `Scanned ${processedSoFar} emails...`
        });

        // Check if finished
        if (response.complete === true) {
          isComplete = true;
          finalResult = res;
          finalSnapshot = response.snapshot || response.dataSnapshot || (response.result && (response.result.snapshot || response.result.dataSnapshot)) || null;
          finalUpdatedRows = response.updatedRows || (response.result && response.result.updatedRows) || null;
          break;
        }

        // Check if ready for post-processing
        if (res.isPostProcessing === true) {
          isPostProcessing = true;
          if (titleEl) titleEl.textContent = "Finalizing Compliance & Logs...";
          if (subEl) subEl.textContent = "Calculating crew scores, updating Safety Compliance matrix, and finalizing logs...";
          if (barEl) {
            barEl.style.width = "95%";
            barEl.textContent = "95%";
            barEl.style.background = "linear-gradient(90deg, #3b82f6 0%, #10b981 100%)";
          }
          this.updateBackgroundWidget({
            title: '🛡️ Finalizing Compliance',
            sub: 'Calculating scores & updating matrix...',
            pct: 95
          });
        }

        // Polite pause between batches to prevent Google edge proxy burst rate limiting
        await new Promise(r => setTimeout(r, 1200));
        batchIndex++;
      }

      // Merge initial batch results if returned
      if (finalUpdatedRows && finalUpdatedRows.length > 0) {
        this.mergeComplianceUpdates(finalUpdatedRows);
      } else if (finalSnapshot) {
        await window.localDB.setSnapshot(finalSnapshot);
      }

      const recentLogs = (finalResult && finalResult.recentLogs) || (lastResult && lastResult.recentLogs);
      if (recentLogs && recentLogs.length > 0) {
        this.mergeSafetyLogs(recentLogs);
      }

      // Automatically recalculate Safety Compliance matrix for current and previous weeks
      const titleEl = document.getElementById('proc-live-title');
      const subEl = document.getElementById('proc-live-sub');
      const barEl = document.getElementById('proc-live-bar');
      if (titleEl) titleEl.textContent = "🛡️ Recalculating Safety Compliance...";
      if (subEl) subEl.textContent = "Evaluating logged reports and updating compliance scores...";
      if (barEl) {
        barEl.style.width = "98%";
        barEl.textContent = "Recalculating...";
        barEl.style.background = "linear-gradient(90deg, #3b82f6 0%, #10b981 100%)";
      }
      this.updateBackgroundWidget({
        title: '🛡️ Recalculating Compliance',
        sub: 'Updating compliance matrix from logged data...',
        pct: 98
      });

      try {
        console.log('Automatically recalculating safety compliance after email scanning...');
        const recalcResponse = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', {
          action: 'recalculateCompliance',
          targetWeek: 'both'
        }, 180000);
        console.log('Auto-recalculate compliance response:', recalcResponse);

        if (recalcResponse && recalcResponse.success) {
          const autoUpdatedRows = recalcResponse.updatedRows || (recalcResponse.result && recalcResponse.result.updatedRows);
          if (autoUpdatedRows && autoUpdatedRows.length > 0) {
            this.mergeComplianceUpdates(autoUpdatedRows);
            if (window.sheetNavigator) {
              const weeks = autoUpdatedRows.map(r => r['Week Start']).filter(Boolean);
              weeks.sort((a, b) => (new Date(b).getTime() || 0) - (new Date(a).getTime() || 0));
              if (weeks.length > 0) {
                window.sheetNavigator.selectedComplianceWeek = weeks[0];
              }
            }
          } else {
            const freshSnap = recalcResponse.snapshot || recalcResponse.dataSnapshot || (recalcResponse.result && (recalcResponse.result.snapshot || recalcResponse.result.dataSnapshot));
            if (freshSnap) {
              await window.localDB.setSnapshot(freshSnap);
            }
          }
          const recLogs = recalcResponse.recentLogs || (recalcResponse.result && recalcResponse.result.recentLogs);
          if (recLogs && recLogs.length > 0) {
            this.mergeSafetyLogs(recLogs);
          }
        }
      } catch (autoRecalcErr) {
        console.warn('Auto-recalculate compliance after email scanning warning:', autoRecalcErr);
      }

      // Automatically scan EcoOnline Field iD weekly JHA Quality Failures after safety email sync
      try {
        await this.scanJhaFailureEmails({ daysBack: 30, silent: true });
      } catch (jhaFailErr) {
        console.warn('Auto-scan JHA Failures after safety emails warning:', jhaFailErr);
      }

      // Re-render Safety Compliance view immediately so user sees the new week and updated checks
      if (window.sheetNavigator) {
        window.sheetNavigator.renderSafetyCompliance();
      }

      // Hide header minimize button
      if (minBtn) minBtn.style.display = 'none';

      // Save logs in memory from localDB
      this.currentLogs = this.extractLogsFromLocalDB();

      this.activeCategoryFilter = 'all';
      this.searchQuery = '';

      const totalLogs = (cumulativeLogs.jha || 0) + (cumulativeLogs.weekly || 0) + (cumulativeLogs.monthly || 0);

      // Render completion content so it's ready in modal
      if (body) {
        this.renderCompletionModalContent(body, {
          totalThreads: totalThreads || totalProcessed + totalSkipped,
          totalLogs: totalLogs,
          cumulativeLogs: cumulativeLogs,
          totalIssues: totalIssues,
          complianceError: finalResult ? finalResult.complianceError : null
        });
      }

      if (footer) {
        footer.innerHTML = `
          <button class="btn btn-secondary" onclick="window.safetyComplianceEngine.openSafetyLogsModal()" style="font-size: 12px; font-weight: 600;">
            📋 Full Logs & PDFs
          </button>
          <button class="btn btn-primary" onclick="window.safetyComplianceEngine.closeProcessEmailsModal()" style="font-weight: 700; background: #10b981; border: none; padding: 8px 24px;">
            Done & View Compliance
          </button>
        `;
      }

      if (finalResult && finalResult.complianceError) {
        console.warn('Compliance calculation reported error:', finalResult.complianceError);
        window.syncEngine.updateStatusUI('error', 'Emails logged, but compliance calculation had an issue');
      } else {
        window.syncEngine.updateStatusUI('synced', `Compliance updated (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`);
      }

      // If running in background, update floating widget
      if (this.isMinimized) {
        this.updateBackgroundWidget({
          title: '✅ Email Processing Complete',
          sub: `${totalLogs} logged • ${totalIssues} issues • Click to view report`,
          pct: 100,
          status: 'completed'
        });
        // Auto-dismiss completed widget after 12 seconds if not manually dismissed
        setTimeout(() => {
          const w = document.getElementById('safety-emails-bg-widget');
          if (w && w.classList.contains('completed')) {
            this.dismissBackgroundWidget();
          }
        }, 12000);
      }

    } catch (err) {
      console.error('runProcessEmails error:', err);
      let displayError = (err && err.message) ? err.message : 'An error occurred while processing emails.';
      if (displayError.length > 300) {
        displayError = displayError.substring(0, 300) + '... (See console for full details)';
      }

      if (minBtn) minBtn.style.display = 'none';

      if (body) {
        body.innerHTML = `
          <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; padding: 16px 20px;">
            <div style="font-size: 14px; font-weight: 700; color: #fca5a5; margin-bottom: 6px;">❌ Processing Error</div>
            <div style="font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 12px; word-break: break-word;">
              ${this.escapeHtml(displayError)}
            </div>
            <div style="font-size: 11.5px; color: var(--text-muted);">
              Tip: If processing many emails, try selecting <strong>📅 Last 7 Days</strong> or clicking <strong>🗕 Run in Background</strong> to continue working while it scans.
            </div>
          </div>
        `;
      }

      if (footer) {
        footer.innerHTML = `
          <button class="btn btn-secondary" onclick="window.safetyComplianceEngine.closeProcessEmailsModal()">Close</button>
          <button class="btn btn-primary" onclick="window.safetyComplianceEngine.openProcessEmailsModal()">Try Again</button>
        `;
      }

      if (this.isMinimized) {
        this.updateBackgroundWidget({
          title: '❌ Email Processing Error',
          sub: `${displayError.substring(0, 45)}... Click to view`,
          status: 'error'
        });
        if (!options.silent) {
          this.showToast(`⚠️ Error processing safety emails: ${this.escapeHtml(displayError.substring(0, 80))}. <a href="javascript:void(0)" onclick="window.safetyComplianceEngine.restoreProcessEmailsModal()" style="color: #fef08a; text-decoration: underline; margin-left: 6px; font-weight: 700;">View Details</a>`, true);
        }
      }
    } finally {
      this.isProcessing = false;
      const minBtn = document.getElementById('btn-minimize-process-emails');
      if (minBtn) minBtn.style.display = 'none';
    }
  }

  /**
   * Directly merges updated compliance rows into the local IndexedDB snapshot
   * without requiring a full database download.
   */
  mergeComplianceUpdates(updatedRows) {
    if (!Array.isArray(updatedRows) || updatedRows.length === 0) return false;
    if (!window.localDB || !window.localDB.snapshot || !window.localDB.snapshot.tables) return false;

    let scTable = window.localDB.snapshot.tables.safety_compliance;
    if (!scTable) {
      scTable = {
        name: 'Safety Compliance',
        headers: ["Week Start", "Job Number", "Foreman", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Weekly Meeting", "Monthly Checklist", "Status", "Updated"],
        rows: [],
        rawGrid: []
      };
      window.localDB.snapshot.tables.safety_compliance = scTable;
    }

    if (!scTable.rows) scTable.rows = [];
    if (!scTable.headers || scTable.headers.length === 0) {
      scTable.headers = ["Week Start", "Job Number", "Foreman", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Weekly Meeting", "Monthly Checklist", "Status", "Updated"];
    }

    const parseWeekMs = (wStr) => {
      const s = String(wStr || '').trim();
      if (!s) return NaN;
      const parts = s.split(/[-/]/);
      if (parts.length === 3) {
        let y, m, d;
        if (parts[0].length === 4) {
          y = parseInt(parts[0], 10); m = parseInt(parts[1], 10); d = parseInt(parts[2], 10);
        } else {
          m = parseInt(parts[0], 10); d = parseInt(parts[1], 10); y = parseInt(parts[2], 10);
          if (y < 100) y += 2000;
        }
        if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
          return new Date(y, m - 1, d, 12, 0, 0).getTime();
        }
      }
      return new Date(s).getTime();
    };

    const isSameWeekStr = (w1, w2) => {
      if (w1 === w2) return true;
      const t1 = parseWeekMs(w1);
      const t2 = parseWeekMs(w2);
      return !isNaN(t1) && !isNaN(t2) && Math.abs(t1 - t2) <= 86400000 * 2;
    };

    // Track which weeks and jobs were authoritatively returned so stale deleted rows get pruned
    const refreshedWeeks = [];
    const returnedJobsByWeek = [];

    updatedRows.forEach(newRow => {
      const nwStr = String(newRow['Week Start'] || '').trim();
      const njStr = String(newRow['Job Number'] || '').trim();
      if (nwStr) {
        let wkIdx = refreshedWeeks.findIndex(w => isSameWeekStr(w, nwStr));
        if (wkIdx === -1) {
          wkIdx = refreshedWeeks.length;
          refreshedWeeks.push(nwStr);
          returnedJobsByWeek.push(new Set());
        }
        if (njStr) returnedJobsByWeek[wkIdx].add(njStr.toLowerCase());
      }

      let matched = false;
      for (let r = 0; r < scTable.rows.length; r++) {
        const row = scTable.rows[r];
        const rwStr = String(row['Week Start'] || '').trim();
        const rjStr = String(row['Job Number'] || '').trim();
        
        // Match job number and week start (exact string or within 2 calendar days for timezone offset)
        if (rjStr === njStr && isSameWeekStr(rwStr, nwStr)) {
          // Keep the grid's canonical Week Start so UI filters and tabs match 100%
          newRow['Week Start'] = rwStr;
          Object.assign(row, newRow);
          matched = true;
          break;
        }
      }
      if (!matched) {
        newRow._rowIdx = scTable.rows.length + 2;
        scTable.rows.push(newRow);
      }
    });

    // Prune stale local rows for any recalculated week that were removed on the server
    // (e.g. completed jobs whose end date preceded that week), preserving manually Resolved rows
    if (refreshedWeeks.length > 0) {
      scTable.rows = scTable.rows.filter(row => {
        const rwStr = String(row['Week Start'] || '').trim();
        const rjStr = String(row['Job Number'] || '').trim();
        const rStat = String(row['Status'] || '').trim();
        if (!rwStr || !rjStr || rStat === 'Resolved') return true;
        const wkIdx = refreshedWeeks.findIndex(w => isSameWeekStr(w, rwStr));
        if (wkIdx === -1) return true;
        return returnedJobsByWeek[wkIdx].has(rjStr.toLowerCase());
      });
      scTable.rows.forEach((r, idx) => { r._rowIdx = idx + 2; });
    }

    // Rebuild rawGrid so grid renderers have matching data
    scTable.rawGrid = [
      scTable.headers,
      ...scTable.rows.map(r => scTable.headers.map(h => r[h] !== undefined && r[h] !== null ? String(r[h]) : ''))
    ];
    scTable.rowCount = scTable.rows.length;
    scTable.maxRows = scTable.rows.length + 1;
    scTable.maxCols = scTable.headers.length;

    if (typeof window.localDB.markTableDirty === 'function') {
      window.localDB.markTableDirty('safety_compliance');
    }
    if (typeof window.localDB.persistSnapshot === 'function') {
      window.localDB.persistSnapshot(window.localDB.snapshot);
    }
    return true;
  }

  /**
   * Merges recent safety log entries into the local IndexedDB snapshot tables
   * (jha_log, weekly_safety_log, monthly_checklist_log).
   */
  mergeSafetyLogs(recentLogs) {
    if (!Array.isArray(recentLogs) || recentLogs.length === 0) return false;
    if (!window.localDB || !window.localDB.snapshot || !window.localDB.snapshot.tables) return false;

    const snap = window.localDB.snapshot;
    let modified = false;

    function ensureLogTable(key, name, headers) {
      if (!snap.tables[key]) {
        snap.tables[key] = {
          name: name,
          headers: headers,
          rows: [],
          rawGrid: []
        };
      }
      if (!snap.tables[key].rows) snap.tables[key].rows = [];
      return snap.tables[key];
    }

    const jhaTbl = ensureLogTable('jha_log', 'JHA Log', [
      'Date Received', 'Date Created', 'Job Number', 'Foreman', 'Email Subject', 'Email ID', 'Source', 'Status', 'Credited To', 'Notes'
    ]);
    const weeklyTbl = ensureLogTable('weekly_safety_log', 'Weekly Safety Log', [
      'Date Received', 'Week Of', 'Job Number', 'Foreman', 'Email Subject', 'Email ID', 'Status', 'Credited To', 'Notes'
    ]);
    const monthlyTbl = ensureLogTable('monthly_checklist_log', 'Monthly Checklist Log', [
      'Date Received', 'Date Created', 'Job Number', 'Foreman', 'Equipment Number', 'Email Subject', 'Email ID', 'Status', 'Credited To', 'Notes'
    ]);

    let aliasMap = {};
    try {
      aliasMap = JSON.parse(localStorage.getItem('FY_TRANSITION_ALIAS_MAP') || '{}');
      if (snap.configs && snap.configs['FY_TRANSITION_ALIAS_MAP']) {
        aliasMap = Object.assign({}, snap.configs['FY_TRANSITION_ALIAS_MAP'], aliasMap);
      }
    } catch (e) {}

    const resolveJobAlias = (jobNum, currentCreditedTo, currentStatus, notes) => {
      const raw = String(jobNum || '').trim();
      const base = raw.split('.')[0].trim();
      let cred = String(currentCreditedTo || '').trim();
      let status = String(currentStatus || 'Credited').trim();
      let newNotes = String(notes || '').trim();

      if (aliasMap[raw] || aliasMap[base]) {
        const target = aliasMap[raw] || aliasMap[base];
        if (!cred || cred === raw || cred === base) {
          cred = target;
          if (status === 'Unknown Job') status = 'Credited';
          const tag = `[FY Transition: credited to ${target}]`;
          if (!newNotes.includes(tag)) {
            newNotes = newNotes ? `${newNotes} ${tag}` : tag;
          }
        }
      }
      return { creditedTo: cred, status: status, notes: newNotes };
    };

    const outbox = (window.localDB && typeof window.localDB.getOutbox === 'function')
      ? (window.localDB.getOutbox() || [])
      : [];

    const hasPendingOutboxForLog = (sheetName, rowIdx, emailId) => {
      return outbox.some(m => {
        if (!m || m.sheetName !== sheetName) return false;
        if (emailId && m.itemIdentifier && String(m.itemIdentifier).trim() === emailId) return true;
        return Boolean(rowIdx && m.row === rowIdx);
      });
    };

    const syncGridRowFromObj = (tbl, rowObj) => {
      if (!tbl || !Array.isArray(tbl.rawGrid) || !Array.isArray(tbl.headers) || !rowObj) return;
      const gIdx = (rowObj._rowIdx && rowObj._rowIdx > 1) ? (rowObj._rowIdx - 1) : -1;
      if (gIdx > 0 && tbl.rawGrid[gIdx]) {
        tbl.headers.forEach((h, cIdx) => {
          if (rowObj[h] !== undefined) tbl.rawGrid[gIdx][cIdx] = rowObj[h];
        });
      }
    };

    const upsertLogRow = (tbl, sheetName, log, emailId, cleanFm, resolved, buildNewRow, extraFindFn) => {
      let existsIdx = tbl.rows.findIndex(r => {
        const rEmail = String(r['Email ID'] || r.email_id || '').trim();
        return Boolean(emailId && rEmail && rEmail === emailId);
      });
      if (existsIdx === -1 && typeof extraFindFn === 'function') {
        existsIdx = tbl.rows.findIndex(extraFindFn);
      }

      if (existsIdx === -1) {
        const newRow = buildNewRow();
        newRow._rowIdx = (Array.isArray(tbl.rawGrid) && tbl.rawGrid.length > 0)
          ? (tbl.rawGrid.length + 1)
          : (tbl.rows.length + 2);
        tbl.rows.push(newRow);
        if (Array.isArray(tbl.rawGrid) && Array.isArray(tbl.headers)) {
          tbl.rawGrid.push(tbl.headers.map(h => newRow[h] !== undefined ? newRow[h] : ''));
        }
        modified = true;
        return;
      }

      const existingRow = tbl.rows[existsIdx];
      if (hasPendingOutboxForLog(sheetName, existingRow._rowIdx, emailId)) return;

      const nextJob = String(log.jobNumber || '').trim();
      const currJob = String(existingRow['Job Number'] || '').trim();
      if (nextJob && currJob !== nextJob) {
        existingRow['Job Number'] = nextJob;
        modified = true;
      }

      const currFm = String(existingRow['Foreman'] || '');
      const isBadCurrFm = !currFm || /^\d{3}-\d{2}/.test(currFm) || currFm.toLowerCase() === 'unknown';
      const isValidNextFm = cleanFm && !/^\d{3}-\d{2}/.test(cleanFm) && cleanFm.toLowerCase() !== 'unknown';
      if (isValidNextFm && (isBadCurrFm || currFm !== cleanFm)) {
        existingRow['Foreman'] = cleanFm;
        modified = true;
      }

      if (String(existingRow['Credited To'] || '').trim() !== String(resolved.creditedTo || '').trim()) {
        existingRow['Credited To'] = resolved.creditedTo;
        modified = true;
      }
      if (resolved.status && String(existingRow['Status'] || '').trim() !== String(resolved.status).trim()) {
        existingRow['Status'] = resolved.status;
        modified = true;
      }
      if (resolved.notes !== undefined && String(existingRow['Notes'] || '').trim() !== String(resolved.notes || '').trim()) {
        existingRow['Notes'] = resolved.notes;
        modified = true;
      }
      syncGridRowFromObj(tbl, existingRow);
    };

    recentLogs.forEach(log => {
      const emailId = String(log.emailId || '').trim();
      const sheetName = log.sheetName;
      const resolved = resolveJobAlias(log.jobNumber, log.creditedTo, log.status, log.notes);
      let cleanFm = log.foreman || '';
      if (!cleanFm || /^\d{3}-\d{2}/.test(cleanFm) || cleanFm.toLowerCase() === 'unknown') {
        cleanFm = this.lookupForemanForCrew(resolved.creditedTo || log.jobNumber) || cleanFm;
      }

      if (sheetName === 'JHA Log' || log.type === 'JHA') {
        upsertLogRow(jhaTbl, 'JHA Log', log, emailId, cleanFm, resolved, () => ({
          'Date Received': log.dateReceived || '',
          'Date Created': log.date || '',
          'Job Number': log.jobNumber || '',
          'Foreman': cleanFm,
          'Email Subject': log.subject || '',
          'Email ID': emailId,
          'Source': log.source || '',
          'Status': resolved.status,
          'Credited To': resolved.creditedTo,
          'Notes': resolved.notes
        }));
      } else if (sheetName === 'Weekly Safety Log' || log.type === 'Weekly Safety Meeting') {
        const targetCrew = (resolved.creditedTo || log.jobNumber || '').trim().toLowerCase();
        const weekOf = (log.date || '').trim();
        upsertLogRow(
          weeklyTbl,
          'Weekly Safety Log',
          log,
          emailId,
          cleanFm,
          resolved,
          () => ({
            'Date Received': log.dateReceived || '',
            'Week Of': log.date || '',
            'Job Number': log.jobNumber || '',
            'Foreman': cleanFm,
            'Email Subject': log.subject || '',
            'Email ID': emailId,
            'Status': resolved.status,
            'Credited To': resolved.creditedTo,
            'Notes': resolved.notes
          }),
          r => {
            const rWeek = String(r['Week Of'] || '').trim();
            const rCrew = String(r['Credited To'] || r['Job Number'] || '').trim().toLowerCase();
            return weekOf && rWeek === weekOf && targetCrew && rCrew === targetCrew;
          }
        );
      } else if (sheetName === 'Monthly Checklist Log' || log.type === 'Monthly Checklist') {
        upsertLogRow(monthlyTbl, 'Monthly Checklist Log', log, emailId, cleanFm, resolved, () => ({
          'Date Received': log.dateReceived || '',
          'Date Created': log.date || '',
          'Job Number': log.jobNumber || '',
          'Foreman': cleanFm,
          'Equipment Number': log.equipmentNumber || '',
          'Email Subject': log.subject || '',
          'Email ID': emailId,
          'Status': resolved.status,
          'Credited To': resolved.creditedTo,
          'Notes': resolved.notes
        }));
      }
    });

    if (modified) {
      if (typeof window.localDB.markTableDirty === 'function') {
        window.localDB.markTableDirty(['jha_log', 'weekly_safety_log', 'monthly_checklist_log']);
      }
      if (typeof window.localDB.persistSnapshot === 'function') {
        window.localDB.persistSnapshot(window.localDB.snapshot);
      }
    }
    return modified;
  }

  /**
   * Recalculates Safety Compliance matrix without re-scanning Gmail.
   */
  async runRecalculateCompliance(floatingAssignments = null, skipConfirm = false) {
    if (this.isProcessing) return;

    const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
    if (!syncUrl) {
      alert('⚠️ Please configure your Google Apps Script Web App sync URL first in Settings.');
      return;
    }

    if (!skipConfirm) {
      const confirmRecalc = confirm('Recalculate Safety Compliance matrix now?\n\nThis will evaluate all logged JHAs, weekly safety meetings, and monthly checklists for current and previous weeks and refresh your desktop view.');
      if (!confirmRecalc) return;
    }

    this.isProcessing = true;
    window.syncEngine.updateStatusUI('syncing', 'Recalculating Compliance...');

    try {
      // Flush any unpushed local edits on Safety Log / Job Tracking sheets first so
      // Apps Script recalculates against the user's edited Credited To / schedule values.
      if (window.localDB && typeof window.localDB.getOutbox === 'function') {
        const SAFETY_INPUT_SHEETS = new Set(['JHA Log', 'Weekly Safety Log', 'Monthly Checklist Log', 'Job Tracking']);
        const fullOutbox = window.localDB.getOutbox() || [];
        const pendingLogMuts = fullOutbox.filter(m => m && SAFETY_INPUT_SHEETS.has(m.sheetName));
        if (pendingLogMuts.length > 0) {
          window.syncEngine.updateStatusUI('syncing', `Syncing ${pendingLogMuts.length} log edit(s) before recalculating...`);
          const pushRes = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', {
            action: 'applyMutations',
            mutations: pendingLogMuts,
            detectConflicts: false,
            force: true,
            skipPostProcessing: true,
            returnSnapshot: false
          }, 60000);
          if (!pushRes || (pushRes.success !== true && pushRes.status !== 'ok')) {
            throw new Error((pushRes && (pushRes.error || pushRes.message)) || 'Failed to sync pending safety log edits before recalculation.');
          }
          const flushedSet = new Set(pendingLogMuts);
          const remaining = (window.localDB.getOutbox() || []).filter(m => !flushedSet.has(m));
          if (typeof window.localDB.saveOutbox === 'function') {
            await window.localDB.saveOutbox(remaining);
          }
          if (typeof window.syncEngine.renderOutboxBadge === 'function') {
            window.syncEngine.renderOutboxBadge();
          }
          window.syncEngine.updateStatusUI('syncing', 'Recalculating Compliance...');
        }
      }

      const payload = {
        action: 'recalculateCompliance',
        targetWeek: 'both'
      };
      if (floatingAssignments) {
        payload.floatingAssignments = floatingAssignments;
      } else if (window.sheetNavigator && typeof window.sheetNavigator.getFloatingHolidayAssignments === 'function') {
        payload.floatingAssignments = window.sheetNavigator.getFloatingHolidayAssignments();
      }

      const response = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', payload, 180000);
      console.log('Recalculate compliance response:', response);

      if (!response || !response.success) {
        const errMsg = (response && (response.error || response.message || (response.result && response.result.error)))
          ? (response.error || response.message || response.result.error)
          : 'Failed to recalculate compliance.';
        throw new Error(errMsg);
      }

      const updatedRows = response.updatedRows || (response.result && response.result.updatedRows);
      if (updatedRows && updatedRows.length > 0) {
        this.mergeComplianceUpdates(updatedRows);
        if (window.sheetNavigator) {
          const weeks = updatedRows.map(r => r['Week Start']).filter(Boolean);
          weeks.sort((a, b) => (new Date(b).getTime() || 0) - (new Date(a).getTime() || 0));
          if (weeks.length > 0) {
            window.sheetNavigator.selectedComplianceWeek = weeks[0];
          }
        }
      } else {
        const freshSnap = response.snapshot || response.dataSnapshot || (response.result && (response.result.snapshot || response.result.dataSnapshot));
        if (freshSnap) {
          await window.localDB.setSnapshot(freshSnap);
        }
      }

      const recentLogs = response.recentLogs || (response.result && response.result.recentLogs);
      if (recentLogs && recentLogs.length > 0) {
        this.mergeSafetyLogs(recentLogs);
      }

      if (window.sheetNavigator) {
        window.sheetNavigator.renderSafetyCompliance();
      }

      window.syncEngine.updateStatusUI('synced', `Compliance recalculated (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`);
      alert('✅ Safety Compliance matrix recalculated successfully! View has been updated.');
    } catch (err) {
      console.error('runRecalculateCompliance error:', err);
      window.syncEngine.updateStatusUI('error', 'Recalculation failed');
      alert(`❌ Failed to recalculate compliance:\n\n${err.message}`);
    } finally {
      this.isProcessing = false;
    }
  }



  /**
   * Opens the In-App PDF Document Viewer Modal to render the attached safety PDF immediately.
   * Supports an optional array of relatedLogs (e.g. all monthly checklists for a crew in that month)
   * to render interactive, clickable pill buttons in the modal header for seamless document switching.
   */
  async openPdfViewer(logOrId, relatedLogs = null) {
    let log = null;
    if (typeof logOrId === 'object' && logOrId !== null) {
      log = logOrId;
    } else {
      log = (this.currentLogs || []).find(l => (l.id === logOrId || (l.sheetName + '_' + l.rowIndex) === logOrId));
    }
    if (!log) {
      alert('Log record not found.');
      return;
    }

    this._activeViewingLog = log;

    const modal = document.getElementById('safety-pdf-modal');
    const body = document.getElementById('safety-pdf-modal-body');
    const titleEl = document.getElementById('safety-pdf-modal-title');
    const subtitleEl = document.getElementById('safety-pdf-modal-subtitle');
    const gmailBtn = document.getElementById('safety-pdf-btn-gmail');
    const downloadBtn = document.getElementById('safety-pdf-btn-download');
    const popoutBtn = document.getElementById('safety-pdf-btn-newtab');
    const versionSelector = document.getElementById('safety-pdf-version-selector');
    const actionItemsBtn = document.getElementById('safety-pdf-btn-action-items');
    const actionDrawer = document.getElementById('safety-pdf-action-items-drawer');

    if (!modal || !body) return;

    modal.style.display = 'flex';
    modal.classList.remove('hidden');
    modal.classList.add('active');
    if (window.windowManager && typeof window.windowManager.bringToFront === 'function') {
      window.windowManager.bringToFront(modal);
    }

    const logType = log.type || log.reportType || 'Safety Document';
    const isChecklist = (logType === 'Monthly Checklist' || log.sheetName === 'Monthly Checklist Log');
    const logJob = log.jobNumber || log.crewId || 'N/A';
    const logForeman = log.foreman || 'UNKNOWN';
    const logDate = log.date || log.reportDate || 'N/A';
    const logDateRec = log.dateReceived || log.receivedDate || logDate;
    const logUnit = this.getLogUnitLabel(log);
    const logGmailUrl = log.gmailUrl || (log.emailId ? ('https://mail.google.com/mail/#all/' + String(log.emailId).trim().split('_')[0]) : '');

    if (titleEl) titleEl.textContent = `${logType} · Crew ${logJob}${logUnit && logUnit !== 'Checklist' ? ` (Unit ${logUnit})` : ''}`;
    if (subtitleEl) subtitleEl.textContent = `Foreman: ${logForeman}${logUnit && logUnit !== 'Checklist' ? ` | Unit: ${logUnit}` : ''} | Report Date: ${logDate} | Received: ${logDateRec}`;

    // Auto-discover related checklists if not passed explicitly for Monthly Checklist
    try {
      if (isChecklist && (!relatedLogs || relatedLogs.length === 0)) {
        relatedLogs = this.getMonthlyChecklistsForCrew(log.jobNumber || log.creditedTo, log.date || log.dateReceived, log.foreman);
      }

      // Render Clickable Pill Buttons in Header for multiple checklists
      if (versionSelector) {
        if (isChecklist && relatedLogs && relatedLogs.length > 1) {
          versionSelector.style.display = 'flex';
          versionSelector.style.gap = '6px';
          versionSelector.style.alignItems = 'center';
          versionSelector.style.overflowX = 'auto';
          versionSelector.style.maxWidth = '460px';
          versionSelector.style.padding = '2px 0';

          versionSelector.innerHTML = relatedLogs.map((l) => {
            const isSelected = (l.id === log.id || (l.sheetName + '_' + l.rowIndex) === log.id || (l.emailId && l.emailId === log.emailId));
            const unit = this.getLogUnitLabel(l);
            const dt = l.date ? String(l.date).replace(/\/20(\d\d)$/, '/$1') : (l.dateReceived ? String(l.dateReceived).split(' ')[0].replace(/\/20(\d\d)$/, '/$1') : '');
            const hasIssues = String(l.hasEquipmentIssues || '').toLowerCase() === 'yes' || this.hasEquipmentNeedsForLog(l);

            const btnBg = isSelected ? 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)' : 'rgba(255, 255, 255, 0.08)';
            const btnBorder = isSelected ? '#38bdf8' : 'rgba(255, 255, 255, 0.18)';
            const btnColor = isSelected ? '#ffffff' : '#cbd5e1';
            const shadow = isSelected ? 'box-shadow: 0 2px 8px rgba(2, 132, 199, 0.4);' : '';

            return `
              <button type="button" class="btn pdf-pill-btn ${isSelected ? 'active' : ''}" onclick="window.safetyComplianceEngine.openPdfViewer('${this.escapeJs(l.id)}', window.safetyComplianceEngine._activeChecklistsGroup)"
                      style="padding: 3px 9px; font-size: 11px; font-weight: 700; border-radius: 14px; border: 1px solid ${btnBorder}; background: ${btnBg}; color: ${btnColor}; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; ${shadow}"
                      title="Unit ${this.escapeHtml(unit)} · Date: ${this.escapeHtml(l.date || l.dateReceived)}${hasIssues ? ' · ⚠️ Equipment defect reported' : ''}">
                <span>🚗 ${this.escapeHtml(unit)}</span>
                ${dt ? `<span style="font-size: 9.5px; opacity: 0.85; font-weight: 500;">(${this.escapeHtml(dt)})</span>` : ''}
                ${hasIssues ? `<span style="color: #fbbf24; font-size: 11px;" title="Equipment defect reported">⚠️</span>` : ''}
              </button>
            `;
          }).join('');
          this._activeChecklistsGroup = relatedLogs;
        } else {
          versionSelector.style.display = 'none';
          versionSelector.innerHTML = '';
          this._activeChecklistsGroup = null;
        }
      }

      // Configure Action Items Button and Drawer
      if (actionDrawer) {
        actionDrawer.style.display = 'none'; // reset closed on document switch
      }
      if (actionItemsBtn) {
        if (isChecklist) {
          actionItemsBtn.style.display = 'inline-flex';
          const openNeeds = this.getEquipmentNeedsForLog(log);
          if (openNeeds.length > 0) {
            actionItemsBtn.innerHTML = `<span>⚠️</span> Action Items (${openNeeds.length})`;
            actionItemsBtn.style.background = 'rgba(239, 68, 68, 0.2)';
            actionItemsBtn.style.borderColor = 'rgba(239, 68, 68, 0.5)';
            actionItemsBtn.style.color = '#fca5a5';
          } else {
            actionItemsBtn.innerHTML = `<span>🔧</span> Action Items`;
            actionItemsBtn.style.background = 'rgba(245, 158, 11, 0.12)';
            actionItemsBtn.style.borderColor = 'rgba(245, 158, 11, 0.4)';
            actionItemsBtn.style.color = '#fbbf24';
          }
        } else {
          actionItemsBtn.style.display = 'none';
        }
      }
    } catch (headerErr) {
      console.warn('Error setting up PDF header elements:', headerErr);
    }

    if (gmailBtn) {
      gmailBtn.href = logGmailUrl || '#';
      gmailBtn.style.display = logGmailUrl ? 'inline-flex' : 'none';
      gmailBtn.onclick = (e) => {
        if (logGmailUrl && window.desktopAPI && typeof window.desktopAPI.openExternal === 'function') {
          e.preventDefault();
          window.desktopAPI.openExternal(logGmailUrl);
        }
      };
    }

    body.innerHTML = `
      <div style="margin: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: var(--text-secondary); padding: 40px;">
        <div class="loading-spinner" style="width: 40px; height: 40px; border: 3px solid rgba(16, 185, 129, 0.2); border-top-color: #10b981; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
        <div style="font-size: 13.5px; font-weight: 700; color: #f8fafc;">Retrieving attached PDF directly from Gmail...</div>
        <div style="font-size: 11.5px; color: #94a3b8;">${this.escapeHtml(log.subject || logJob)}</div>
      </div>
    `;

    try {
      const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
      if (!syncUrl) {
        throw new Error('Sync URL not configured.');
      }

      if (!this.pdfCache) this.pdfCache = new Map();
      const cacheKey = log.emailId || log.subject || (log.sheetName + '_' + log.rowIndex);
      let pdfData = this.pdfCache.get(cacheKey);

      if (!pdfData) {
        const payload = {
          action: 'getSafetyPdf',
          emailId: log.emailId || '',
          subject: log.subject || ''
        };

        let resJson = null;
        if (window.syncEngine && typeof window.syncEngine.executeNetworkRequest === 'function') {
          resJson = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', payload, 60000);
        } else if (window.desktopAPI && typeof window.desktopAPI.sendSyncRequest === 'function') {
          const apiRes = await window.desktopAPI.sendSyncRequest({ url: syncUrl, method: 'POST', body: payload });
          resJson = apiRes ? (apiRes.data || apiRes) : null;
        } else {
          // Browser fallback: send via GET with query parameters which redirects cleanly in browser
          const getUrl = `${syncUrl}?action=getSafetyPdf&emailId=${encodeURIComponent(log.emailId || '')}&subject=${encodeURIComponent(log.subject || '')}`;
          const response = await fetch(getUrl);
          if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
          resJson = await response.json();
        }

        if (resJson && resJson.result && !resJson.base64) {
          resJson = resJson.result;
        }

        if (!resJson || !resJson.success || !resJson.base64) {
          throw new Error((resJson && resJson.error) || 'Failed to extract PDF attachment.');
        }

        pdfData = resJson;
        this.pdfCache.set(cacheKey, pdfData);
      }

      // Convert base64 to Uint8Array safely
      const rawBase64 = String(pdfData.base64 || '').includes('base64,')
        ? String(pdfData.base64).split('base64,')[1].trim()
        : String(pdfData.base64 || '').trim().replace(/[\r\n\s]/g, '');
      const byteCharacters = atob(rawBase64);
      const byteArray = new Uint8Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteArray[i] = byteCharacters.charCodeAt(i);
      }

      // CRITICAL: Guarantee proper application/pdf MIME type and create Blob FIRST before any pdf.js operations,
      // so the Blob owns a permanent copy of the bytes before pdf.js Web Worker can detach the ArrayBuffer!
      const mimeType = (pdfData.filename && pdfData.filename.toLowerCase().endsWith('.pdf')) ? 'application/pdf' : (pdfData.contentType || 'application/pdf');
      const blob = new Blob([byteArray], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);

      // Auto-scan checklist PDF in background for equipment defects (expired fire extinguishers, AED pads, etc.)
      let detectedIssues = [];
      if (isChecklist) {
        try {
          detectedIssues = await this.scanAndSyncChecklistIssues(byteArray.slice(), log) || [];
        } catch (e) {
          console.warn('[PDF Viewer] Auto-scan checklist issues failed:', e);
        }
      }

      if (downloadBtn) {
        downloadBtn.href = blobUrl;
        downloadBtn.download = pdfData.filename || `${(logType || 'Safety_Document').replace(/\s+/g, '_')}_${logJob}.pdf`;
        downloadBtn.onclick = async (e) => {
          if (window.desktopAPI && typeof window.desktopAPI.savePdfToFile === 'function') {
            e.preventDefault();
            await window.desktopAPI.savePdfToFile(pdfData.base64, pdfData.filename || `${(logType || 'Safety_Document').replace(/\s+/g, '_')}_${logJob}.pdf`);
          }
        };
      }

      if (popoutBtn) {
        popoutBtn.href = blobUrl;
        popoutBtn.onclick = async (e) => {
          if (window.desktopAPI && typeof window.desktopAPI.openPdfExternally === 'function') {
            e.preventDefault();
            await window.desktopAPI.openPdfExternally(pdfData.base64, pdfData.filename || 'SafetyDocument.pdf');
          }
        };
      }

      if (gmailBtn) {
        gmailBtn.href = logGmailUrl || '#';
        gmailBtn.style.display = logGmailUrl ? 'inline-flex' : 'none';
        gmailBtn.onclick = (e) => {
          if (logGmailUrl && window.desktopAPI && typeof window.desktopAPI.openExternal === 'function') {
            e.preventDefault();
            window.desktopAPI.openExternal(logGmailUrl);
          }
        };
      }

      if (subtitleEl) {
        subtitleEl.textContent = `${pdfData.filename || 'Document.pdf'} (${Math.round((pdfData.sizeBytes || 0)/1024)} KB) · Foreman: ${logForeman}${logUnit && logUnit !== 'Checklist' ? ` · Unit: ${logUnit}` : ''} · Date: ${logDate} · Received: ${logDateRec}`;
      }

      // Configure View Switcher Toggle for Checklists (Highlighted Document vs Raw PDF)
      const headerControls = document.getElementById('safety-pdf-btn-action-items')?.parentElement;
      let viewToggleBtn = document.getElementById('safety-pdf-btn-view-toggle');
      if (isChecklist) {
        if (!viewToggleBtn && headerControls) {
          viewToggleBtn = document.createElement('button');
          viewToggleBtn.id = 'safety-pdf-btn-view-toggle';
          viewToggleBtn.className = 'btn btn-secondary';
          viewToggleBtn.type = 'button';
          viewToggleBtn.style.cssText = 'font-size: 11px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 5px; border-color: rgba(234, 179, 8, 0.4); background: rgba(234, 179, 8, 0.15); color: #fef08a; cursor: pointer; font-weight: 700; white-space: nowrap; flex-shrink: 0;';
          headerControls.insertBefore(viewToggleBtn, document.getElementById('safety-pdf-btn-action-items') || headerControls.firstChild);
        }
      } else if (viewToggleBtn) {
        viewToggleBtn.style.display = 'none';
      }

      // Default checklists to the rich PDF.js canvas Document View (which shows highlights if issues exist,
      // or renders all pages cleanly without highlights if clean).
      let isHighlightView = Boolean(isChecklist && window.pdfjsLib);

      const renderActivePdfView = async () => {
        if (isHighlightView) {
          if (viewToggleBtn) {
            viewToggleBtn.style.display = 'inline-flex';
            viewToggleBtn.innerHTML = (detectedIssues && detectedIssues.length > 0)
              ? `<span>🟡</span> Highlighted (${detectedIssues.length})`
              : `<span>📑</span> Document View`;
            viewToggleBtn.title = 'Viewing document with PDF.js. Click to switch to raw browser PDF view.';
            viewToggleBtn.onclick = () => { isHighlightView = false; renderActivePdfView(); };
          }
          await this.renderChecklistPdfWithHighlights(byteArray.slice(), log, detectedIssues, pdfData, blobUrl);
        } else {
          if (viewToggleBtn && isChecklist) {
            viewToggleBtn.style.display = 'inline-flex';
            viewToggleBtn.innerHTML = `<span>📄</span> Raw PDF`;
            viewToggleBtn.title = 'Viewing original embedded PDF. Click to switch to document view.';
            viewToggleBtn.onclick = () => { isHighlightView = true; renderActivePdfView(); };
          }
          body.innerHTML = `
            <object data="${blobUrl}#view=FitH&toolbar=1" type="application/pdf" style="width: 100%; height: 100%; border: none; background: #1e293b;">
              <iframe src="${blobUrl}#view=FitH" style="width: 100%; height: 100%; border: none; background: #1e293b;">
                <div style="padding: 30px; text-align: center; color: var(--text-secondary);">
                  <p>Preview cannot be rendered inline in this view.</p>
                  <button class="btn btn-primary" onclick="if (window.desktopAPI) window.desktopAPI.openPdfExternally('${pdfData.base64}', '${pdfData.filename || 'SafetyDocument.pdf'}')">Open in System PDF Viewer</button>
                </div>
              </iframe>
            </object>
          `;
        }
      };

      await renderActivePdfView();

    } catch (err) {
      body.innerHTML = `
        <div style="margin: auto; padding: 30px; text-align: center; max-width: 500px; color: #f87171;">
          <div style="font-size: 32px; margin-bottom: 12px;">⚠️</div>
          <div style="font-size: 14px; font-weight: 700; margin-bottom: 6px;">Could not load PDF document directly</div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 20px; line-height: 1.5;">${this.escapeHtml(err.message || 'Unknown error')}</div>
          ${logGmailUrl ? `
            <button onclick="if (window.desktopAPI) { window.desktopAPI.openExternal('${this.escapeHtml(logGmailUrl)}'); } else { window.open('${this.escapeHtml(logGmailUrl)}', '_blank'); }" class="btn btn-primary" style="font-weight: 700; background: #10b981; border: none; display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px; cursor: pointer; color: white; border-radius: 6px;">
              <span>✉️</span> Open Email in Gmail Instead
            </button>
          ` : ''}
        </div>
      `;
    }
  }

  closePdfModal() {
    const modal = document.getElementById('safety-pdf-modal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.remove('active');
      modal.classList.add('hidden');
      const drawer = document.getElementById('safety-pdf-action-items-drawer');
      if (drawer) drawer.style.display = 'none';
      this._activeChecklistsGroup = null;
      this._activeViewingLog = null;
      if (window.windowManager && typeof window.windowManager.syncBackdrop === 'function') {
        window.windowManager.syncBackdrop();
      }
    }
  }

  /**
   * Renders a Monthly Checklist PDF onto high-DPI canvases using pdfjsLib with
   * true aspect-ratio sizing, interactive zoom controls, and scoped yellow callouts
   * over any defective or expired equipment items.
   */
  async renderChecklistPdfWithHighlights(byteArray, log, issues, pdfData, blobUrl) {
    const body = document.getElementById('safety-pdf-modal-body');
    if (!body) return;

    body.innerHTML = `
      <div style="margin: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: var(--text-secondary); padding: 40px;">
        <div class="loading-spinner" style="width: 36px; height: 36px; border: 3px solid rgba(234, 179, 8, 0.2); border-top-color: #eab308; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
        <div style="font-size: 13.5px; font-weight: 700; color: #f8fafc;">Scanning document and highlighting action items...</div>
      </div>
    `;

    try {
      const loadingTask = window.pdfjsLib.getDocument({ data: byteArray.slice() });
      const pdfDoc = await loadingTask.promise;
      const numPages = pdfDoc.numPages;

      const container = document.createElement('div');
      container.id = 'pdf-highlight-container';
      container.style.cssText = 'width: 100%; height: 100%; flex: 1; min-height: 0; overflow: auto; background: #0b1329; padding: 14px 18px 24px; display: flex; flex-direction: column; align-items: stretch; gap: 14px; box-sizing: border-box;';

      // Sticky Zoom & Navigation Bar
      const zoomPresets = [
        { value: 'fit', label: 'Fit Width' },
        { value: 1.0, label: '100%' },
        { value: 1.25, label: '125%' },
        { value: 1.5, label: '150%' },
        { value: 2.0, label: '200%' }
      ];
      let currentZoom = 'fit';

      const zoomBar = document.createElement('div');
      zoomBar.style.cssText = 'flex: 0 0 auto; position: sticky; top: 0; z-index: 25; margin: 0 auto; max-width: 100%; background: rgba(15, 23, 42, 0.94); backdrop-filter: blur(8px); border: 1px solid #334155; border-radius: 8px; padding: 5px 10px; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 14px rgba(0,0,0,0.35); flex-wrap: wrap;';

      const zoomMinusBtn = document.createElement('button');
      zoomMinusBtn.type = 'button';
      zoomMinusBtn.className = 'btn btn-secondary';
      zoomMinusBtn.textContent = '➖';
      zoomMinusBtn.title = 'Zoom Out';
      zoomMinusBtn.style.cssText = 'font-size: 11px; padding: 3px 8px; cursor: pointer;';

      const zoomPlusBtn = document.createElement('button');
      zoomPlusBtn.type = 'button';
      zoomPlusBtn.className = 'btn btn-secondary';
      zoomPlusBtn.textContent = '➕';
      zoomPlusBtn.title = 'Zoom In';
      zoomPlusBtn.style.cssText = 'font-size: 11px; padding: 3px 8px; cursor: pointer;';

      const zoomButtons = new Map();
      const zoomInfoLabel = document.createElement('span');
      zoomInfoLabel.style.cssText = 'font-size: 11px; color: #94a3b8; margin-left: 6px; padding-left: 8px; border-left: 1px solid #334155; white-space: nowrap;';
      zoomInfoLabel.textContent = `${numPages} page${numPages > 1 ? 's' : ''}`;

      zoomBar.appendChild(zoomMinusBtn);
      zoomPresets.forEach((preset) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary';
        btn.textContent = preset.label;
        btn.style.cssText = 'font-size: 11px; padding: 3px 9px; cursor: pointer; font-weight: 700; white-space: nowrap;';
        zoomButtons.set(preset.value, btn);
        zoomBar.appendChild(btn);
      });
      zoomBar.appendChild(zoomPlusBtn);
      zoomBar.appendChild(zoomInfoLabel);
      container.appendChild(zoomBar);

      // 1. Action Items Summary Banner (if issues present)
      if (issues && issues.length > 0) {
        const banner = document.createElement('div');
        banner.style.cssText = 'flex: 0 0 auto; max-width: 960px; width: 100%; margin: 0 auto; background: linear-gradient(135deg, rgba(239, 68, 68, 0.16) 0%, rgba(185, 28, 28, 0.08) 100%); border: 1px solid rgba(239, 68, 68, 0.45); border-radius: 8px; padding: 12px 16px; box-shadow: 0 4px 14px rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; box-sizing: border-box;';

        banner.innerHTML = `
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 22px;">⚠️</span>
            <div>
              <div style="font-size: 13.5px; font-weight: 800; color: #fca5a5;">
                ${issues.length} Action Item${issues.length > 1 ? 's' : ''} Highlighted on this Checklist
              </div>
              <div style="font-size: 11.5px; color: #cbd5e1; margin-top: 2px;">
                Items needing repair, recharge, testing, or restock are highlighted in yellow on the document below.
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            ${issues.map((iss, i) => `
              <button type="button" class="btn" onclick="document.getElementById('pdf-highlight-anchor-${i}')?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });" style="font-size: 11px; font-weight: 700; background: rgba(234, 179, 8, 0.2); border: 1px solid #eab308; color: #fef08a; padding: 4px 10px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;" title="Jump to highlighted ${this.escapeHtml(iss.issueDescription || iss.equipmentType)}">
                <span>🔍 Jump to:</span> <strong>${this.escapeHtml(iss.shortLabel || iss.equipmentType)}</strong>
              </button>
            `).join('')}
          </div>
        `;
        container.appendChild(banner);
      }

      // Collect target search terms from detected issues (preserve scoped phrase terms)
      const searchTerms = [];
      if (issues && issues.length > 0) {
        issues.forEach((iss, issIdx) => {
          if (iss.rawDateStr) searchTerms.push({ text: iss.rawDateStr, issue: iss, issueIdx: issIdx });
          if (iss.feTestDate) searchTerms.push({ text: iss.feTestDate, issue: iss, issueIdx: issIdx });
          (iss.highlightKeywords || []).forEach(kw => {
            if (kw && kw.length > 1) searchTerms.push({ text: kw, issue: iss, issueIdx: issIdx });
          });
        });
      }

      const pagesHost = document.createElement('div');
      pagesHost.style.cssText = 'display: flex; flex-direction: column; align-items: stretch; gap: 18px; flex: 0 0 auto; width: 100%;';
      container.appendChild(pagesHost);

      // Mount container before rendering so container.clientWidth reflects actual modal width
      body.innerHTML = '';
      body.appendChild(container);

      const genericLabels = new Set([
        'no', 'yes', 'na', 'n/a', 'comments', 'comments:', 'test date', 'test date:',
        'test due', 'test due:', 'good condition', 'good condition?:', 'truck', 'trucks',
        'general', 'other', 'other:', 'date', 'unit', 'job'
      ]);

      const updateZoomButtonStyles = () => {
        zoomButtons.forEach((btn, val) => {
          const isActive = currentZoom === val;
          btn.style.background = isActive ? 'rgba(59, 130, 246, 0.3)' : '';
          btn.style.borderColor = isActive ? '#60a5fa' : '';
          btn.style.color = isActive ? '#bfdbfe' : '';
        });
      };

      let renderGeneration = 0;

      const renderPages = async (zoomMode) => {
        currentZoom = zoomMode;
        updateZoomButtonStyles();

        renderGeneration += 1;
        const myGen = renderGeneration;

        pagesHost.innerHTML = '';
        const availableWidth = Math.max(360, (container.clientWidth || body.clientWidth || 1040) - 44);
        const pixelRatio = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
        const highlightedIssueIndices = new Set();

        for (let p = 1; p <= numPages; p++) {
          if (myGen !== renderGeneration) return;

          const page = await pdfDoc.getPage(p);
          if (myGen !== renderGeneration) return;

          const unscaledViewport = page.getViewport({ scale: 1 });
          const fitScale = availableWidth / unscaledViewport.width;
          const displayScale = zoomMode === 'fit'
            ? Math.max(0.75, Math.min(2.5, fitScale))
            : (1.35 * Number(zoomMode || 1.0));

          const cssWidth = Math.round(unscaledViewport.width * displayScale);
          const cssHeight = Math.round(unscaledViewport.height * displayScale);
          const renderViewport = page.getViewport({ scale: displayScale * pixelRatio });

          if (p === 1) {
            const pctDisplay = Math.round((displayScale / 1.35) * 100);
            zoomInfoLabel.textContent = `${numPages} page${numPages > 1 ? 's' : ''} · ${zoomMode === 'fit' ? `Fit (${pctDisplay}%)` : `${pctDisplay}%`}`;
          }

          const pageWrapper = document.createElement('div');
          pageWrapper.className = 'pdf-page-wrapper';
          const sizingCss = zoomMode === 'fit'
            ? `width: min(${cssWidth}px, 100%); aspect-ratio: ${unscaledViewport.width} / ${unscaledViewport.height}; height: auto;`
            : `width: ${cssWidth}px; height: ${cssHeight}px;`;
          pageWrapper.style.cssText = `position: relative; flex: 0 0 auto; margin: 0 auto; ${sizingCss} background: #ffffff; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border-radius: 4px; overflow: visible;`;

          const canvas = document.createElement('canvas');
          canvas.width = Math.round(renderViewport.width);
          canvas.height = Math.round(renderViewport.height);
          canvas.style.cssText = 'width: 100%; height: 100%; display: block; border-radius: 4px;';
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
          if (myGen !== renderGeneration) return;

          pageWrapper.appendChild(canvas);

          // Scan text content to locate exact highlight positions
          const textContent = await page.getTextContent();
          if (myGen !== renderGeneration) return;
          const textItems = textContent.items || [];
          const paintedItemIssueKeys = new Set();

          for (let i = 0; i < textItems.length; i++) {
            const item = textItems[i];
            const str = (item.str || '').trim();
            if (!str) continue;

            const strLower = str.toLowerCase();
            // Build combined 2-token string when label and value live on the same row
            let combinedLower = '';
            let nextItem = null;
            for (let j = i + 1; j < Math.min(textItems.length, i + 3); j++) {
              const cand = textItems[j];
              const candStr = (cand.str || '').trim();
              if (!candStr) continue;
              if (Math.abs((cand.transform[5] || 0) - (item.transform[5] || 0)) < 10) {
                nextItem = cand;
                combinedLower = `${str} ${candStr}`.replace(/\s+/g, ' ').trim().toLowerCase();
              }
              break;
            }

            for (let s = 0; s < searchTerms.length; s++) {
              const termObj = searchTerms[s];
              const term = termObj.text.toLowerCase().trim();
              if (!term) continue;

              const itemIssueKey = `${i}:${termObj.issueIdx}`;
              if (paintedItemIssueKeys.has(itemIssueKey)) continue;

              const directMatch = strLower.includes(term);
              const splitSpanMatch = !directMatch && combinedLower &&
                combinedLower.includes(term) &&
                combinedLower.indexOf(term) < strLower.length &&
                !genericLabels.has(strLower);
              const specificInverseMatch = !directMatch && !splitSpanMatch &&
                term.length > 6 &&
                strLower.replace(/[:?\s]/g, '').length >= 6 &&
                !genericLabels.has(strLower) &&
                term.includes(strLower);

              if (!directMatch && !splitSpanMatch && !specificInverseMatch) continue;

              paintedItemIssueKeys.add(itemIssueKey);

              const renderScale = renderViewport.scale;
              const [vx, vy] = renderViewport.convertToViewportPoint(item.transform[4], item.transform[5]);
              const fontSizePt = item.height > 0
                ? item.height
                : Math.hypot(item.transform[0] || 0, item.transform[1] || 0) || Math.abs(item.transform[3] || 12);

              let spanWidth = item.width * renderScale;
              if (splitSpanMatch && nextItem) {
                const [nx] = renderViewport.convertToViewportPoint(nextItem.transform[4], nextItem.transform[5]);
                const nextRight = nx + (nextItem.width * renderScale);
                if (nextRight > vx) {
                  spanWidth = Math.max(spanWidth, nextRight - vx);
                }
              }

              const padX = 4 * pixelRatio;
              const padY = 2 * pixelRatio;
              const left = Math.max(0, vx - padX);
              const top = Math.max(0, vy - (fontSizePt * renderScale * 0.95) - padY);
              const width = Math.max(12 * pixelRatio, spanWidth + (padX * 2));
              const height = Math.max(10 * pixelRatio, (fontSizePt * renderScale * 1.25) + (padY * 2));

              // Draw translucent highlight directly on HiDPI canvas
              ctx.save();
              ctx.fillStyle = 'rgba(254, 240, 138, 0.45)';
              ctx.fillRect(left, top, width, height);
              ctx.strokeStyle = '#eab308';
              ctx.lineWidth = Math.max(2, 2 * pixelRatio);
              ctx.strokeRect(left, top, width, height);
              ctx.restore();

              const leftPct = (left / renderViewport.width) * 100;
              const topPct = (top / renderViewport.height) * 100;
              const widthPct = (width / renderViewport.width) * 100;
              const heightPct = (height / renderViewport.height) * 100;

              // Add interactive percentage-positioned DOM overlay element
              const overlay = document.createElement('div');
              overlay.className = 'pdf-highlight-overlay';
              if (!highlightedIssueIndices.has(termObj.issueIdx)) {
                overlay.id = `pdf-highlight-anchor-${termObj.issueIdx}`;
                highlightedIssueIndices.add(termObj.issueIdx);

                const badgePosCss = topPct < 5
                  ? 'top: 100%; margin-top: 4px;'
                  : 'bottom: 100%; margin-bottom: 4px;';
                const badge = document.createElement('div');
                badge.style.cssText = `position: absolute; left: 0; ${badgePosCss} background: #dc2626; color: #fff; font-size: 10.5px; font-weight: 800; padding: 2px 8px; border-radius: 4px; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.5); display: flex; align-items: center; gap: 4px; z-index: 10; pointer-events: none;`;
                badge.innerHTML = `<span>⚠️</span> Action Required: ${this.escapeHtml(termObj.issue.shortLabel || termObj.issue.equipmentType)}`;
                overlay.appendChild(badge);
              }

              overlay.style.cssText = `position: absolute; left: ${leftPct.toFixed(4)}%; top: ${topPct.toFixed(4)}%; width: ${widthPct.toFixed(4)}%; height: ${heightPct.toFixed(4)}%; pointer-events: auto; cursor: pointer; border-radius: 3px; z-index: 5;`;
              overlay.title = `Action Item: ${termObj.issue.issueDescription}`;
              pageWrapper.appendChild(overlay);
            }
          }

          pagesHost.appendChild(pageWrapper);

          const pageLabel = document.createElement('div');
          pageLabel.style.cssText = 'flex: 0 0 auto; font-size: 11px; color: #94a3b8; text-align: center; margin-top: -6px; margin-bottom: 4px;';
          pageLabel.textContent = `Page ${p} of ${numPages}`;
          pagesHost.appendChild(pageLabel);
        }
      };

      zoomButtons.forEach((btn, val) => {
        btn.onclick = () => renderPages(val);
      });
      const zoomSteps = [0.85, 1.0, 1.25, 1.5, 1.75, 2.0];
      zoomMinusBtn.onclick = () => {
        const numericCur = currentZoom === 'fit' ? 1.25 : Number(currentZoom);
        const prevStep = [...zoomSteps].reverse().find(z => z < numericCur - 0.01) || zoomSteps[0];
        renderPages(prevStep);
      };
      zoomPlusBtn.onclick = () => {
        const numericCur = currentZoom === 'fit' ? 1.0 : Number(currentZoom);
        const nextStep = zoomSteps.find(z => z > numericCur + 0.01) || zoomSteps[zoomSteps.length - 1];
        renderPages(nextStep);
      };

      await renderPages('fit');

    } catch (renderErr) {
      console.warn('PDF Highlight canvas rendering failed, falling back to object viewer:', renderErr);
      body.innerHTML = `
        <object data="${blobUrl}#view=FitH&toolbar=1" type="application/pdf" style="width: 100%; height: 100%; border: none; background: #1e293b;">
          <iframe src="${blobUrl}#view=FitH" style="width: 100%; height: 100%; border: none; background: #1e293b;"></iframe>
        </object>
      `;
    }
  }

  /**
   * Helper to parse dates in MM/DD/YYYY, YYYY-MM-DD, or Date objects timezone-safely at noon.
   */
  parseDateHelper(val) {
    if (!val) return null;
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    const str = String(val).trim();
    if (!str) return null;
    const mdy = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
    if (mdy) {
      const m = parseInt(mdy[1], 10) - 1;
      const d = parseInt(mdy[2], 10);
      let y = parseInt(mdy[3], 10);
      if (y < 100) y += 2000;
      return new Date(y, m, d, 12, 0, 0);
    }
    const ymd = str.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (ymd) {
      const y = parseInt(ymd[1], 10);
      const m = parseInt(ymd[2], 10) - 1;
      const d = parseInt(ymd[3], 10);
      return new Date(y, m, d, 12, 0, 0);
    }
    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  /**
   * Extracts clean vehicle / unit label from a checklist log record.
   */
  getLogUnitLabel(log) {
    if (!log) return 'Checklist';
    if (log.vehicleNumber && String(log.vehicleNumber).trim()) {
      return String(log.vehicleNumber).trim();
    }
    if (log.subject) {
      const m = String(log.subject).match(/(?:Safety Check\s*list(?:\s*Report)?|Vehicle(?:\s*Checklist)?)\s+([A-Za-z0-9]+)[\s\-]/i);
      if (m) return m[1].toUpperCase();
    }
    return 'Checklist';
  }

  /**
   * Retrieves all Monthly Checklist log entries for a crew within the calendar month of weekVal.
   */
  /**
   * Determines whether a safety log entry belongs to the target crew/foreman.
   * When Credited To explicitly names a crew, it is authoritative so a misnumbered
   * report reassigned to another crew will not match the wrong crew.
   */
  logMatchesCrew(log, cleanJob, cleanForeman) {
    if (!log) return false;
    const targetJob = String(cleanJob || '').trim();
    const lCredited = String(log.creditedTo || '').trim();
    const lJob = String(log.jobNumber || '').trim();
    const lForeman = String(log.foreman || '').trim().toLowerCase();
    const targetForeman = String(cleanForeman || '').trim().toLowerCase();
    const aliasMap = (window.localDB && window.localDB.snapshot && window.localDB.snapshot.configs && window.localDB.snapshot.configs['FY_TRANSITION_ALIAS_MAP']) || {};

    const matchesJobOrAlias = (val, target) => {
      if (!val || !target) return false;
      if (val === target) return true;
      if (aliasMap[val] === target || aliasMap[target] === val) return true;
      if (val.startsWith(target + ' (') || val.startsWith(target + ' -')) return true;
      if (target.startsWith(val + ' (') || target.startsWith(val + ' -')) {
        // When matching a parent job against a sub-crew like "040-26 (Fri-Sat)", require matching foreman if known
        if (targetForeman && lForeman && !val.includes('(') && !val.includes(' -')) {
          return lForeman === targetForeman;
        }
        return true;
      }
      return false;
    };

    const credLower = lCredited.toLowerCase();
    const hasExplicitCredited = Boolean(lCredited && credLower !== 'unknown' && credLower !== 'none');
    if (hasExplicitCredited) {
      return matchesJobOrAlias(lCredited, targetJob);
    }

    return matchesJobOrAlias(lJob, targetJob) ||
           Boolean(targetForeman && lForeman && lForeman === targetForeman);
  }

  /**
   * Retrieves all Monthly Checklist log entries for a crew within the calendar month of weekVal.
   */
  getMonthlyChecklistsForCrew(jobNum, weekVal, foreman) {
    if (!this.currentLogs || this.currentLogs.length === 0) {
      this.currentLogs = this.extractLogsFromLocalDB();
    }
    const cleanJob = String(jobNum || '').trim();
    const cleanForeman = String(foreman || '').trim().toLowerCase();

    let targetMonth = -1;
    let targetYear = -1;
    if (weekVal) {
      const d = this.parseDateHelper(weekVal);
      if (d) {
        // Monday of week is d + 1 day (standard month reference for Sunday-start weeks)
        const mon = new Date(d.getTime() + 24 * 60 * 60 * 1000);
        targetMonth = mon.getMonth();
        targetYear = mon.getFullYear();
      }
    }

    const matches = (this.currentLogs || []).filter(l => {
      if (l.type !== 'Monthly Checklist' && l.sheetName !== 'Monthly Checklist Log') return false;

      if (!this.logMatchesCrew(l, cleanJob, cleanForeman)) return false;

      if (targetMonth !== -1 && targetYear !== -1) {
        const itemDate = this.parseDateHelper(l.date || l.dateReceived);
        if (itemDate) {
          if (itemDate.getMonth() !== targetMonth || itemDate.getFullYear() !== targetYear) {
            return false;
          }
        }
      }
      return true;
    });

    const seen = new Set();
    const deduped = [];
    matches.forEach(m => {
      const key = m.emailId || m.id;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(m);
      }
    });

    return deduped;
  }

  /**
   * Retrieves any open equipment needs from safety_equipment_needs matching this log / unit.
   */
  getEquipmentNeedsForLog(log) {
    if (!log) return [];
    const snap = window.localDB ? window.localDB.getSnapshot() : null;
    const table = snap && snap.tables ? snap.tables.safety_equipment_needs : null;

    const unit = this.getLogUnitLabel(log).toLowerCase();
    const emailId = String(log.emailId || '').trim();
    const jobNum = String(log.jobNumber || log.creditedTo || '').trim().toLowerCase();

    const results = (table && table.rows ? table.rows : []).filter((r, idx) => {
      const status = String(r['Status'] || '').toLowerCase();
      if (status.includes('resolve') || status.includes('complete')) return false;

      const rVeh = String(r['Vehicle Number'] || r['Vehicle #'] || r['Truck'] || r['Unit'] || '').trim().toLowerCase();
      const rEmail = String(r['Source Email ID'] || r['Email ID'] || '').trim();
      const rJob = String(r['Job Number'] || r['Job #'] || r['Crew'] || '').trim().toLowerCase();

      // Match by email ID first
      if (emailId && rEmail && emailId === rEmail) {
        r._rowIdx = r._rowIdx || (idx + 2);
        return true;
      }

      // Or match by unit number + crew
      if (unit && rVeh && (unit === rVeh || rVeh.includes(unit) || unit.includes(rVeh))) {
        if (!jobNum || !rJob || jobNum === rJob) {
          r._rowIdx = r._rowIdx || (idx + 2);
          return true;
        }
      }
      return false;
    }).map(r => ({
      rowIdx: r._rowIdx,
      equipmentType: r['Equipment Type'] || r['Equipment'] || '',
      desc: r['Issue Description'] || r['Notes'] || '',
      notes: r['Notes'] || '',
      status: r['Status'] || 'Needs Attention',
      vehicleNumber: r['Vehicle Number'] || ''
    }));

    // If no database row found yet, check if tripPlanner has a synthesized need matching this log / unit
    if (results.length === 0 && window.tripPlanner && typeof window.tripPlanner.getEquipmentNeedsData === 'function') {
      try {
        const tpData = window.tripPlanner.getEquipmentNeedsData();
        const synthMatches = (tpData.items || []).filter(item => {
          if (!item.isSynthesized) return false;
          const sEmail = String(item.sourceEmailId || '').trim();
          if (emailId && sEmail && emailId === sEmail) return true;
          const sVeh = String(item.vehicleNumber || '').trim().toLowerCase();
          const sCrew = String(item.crewId || '').trim().toLowerCase();
          if (unit && sVeh && (unit === sVeh || sVeh.includes(unit) || unit.includes(sVeh))) {
            if (!jobNum || !sCrew || jobNum === sCrew) return true;
          }
          return false;
        }).map(item => ({
          rowIdx: null,
          equipmentType: item.equipmentType || '',
          desc: item.desc || item.notes || '',
          notes: item.notes || '',
          status: item.status || 'Needs Attention',
          vehicleNumber: item.vehicleNumber || '',
          isSynthesized: true
        }));
        if (synthMatches.length > 0) return synthMatches;
      } catch (_e) {}
    }

    return results;
  }

  hasEquipmentNeedsForLog(log) {
    return this.getEquipmentNeedsForLog(log).length > 0;
  }

  /**
   * Toggles the Action Items Drawer in the PDF Viewer Modal.
   */
  toggleActionItemsDrawer() {
    const drawer = document.getElementById('safety-pdf-action-items-drawer');
    if (!drawer) return;
    if (drawer.style.display !== 'none') {
      drawer.style.display = 'none';
      return;
    }
    drawer.style.display = 'block';
    this.renderActionItemsDrawer();
  }

  /**
   * Renders the Action Items Drawer content in the PDF Viewer Modal.
   */
  renderActionItemsDrawer() {
    const drawer = document.getElementById('safety-pdf-action-items-drawer');
    const log = this._activeViewingLog;
    if (!drawer || !log) return;

    const unit = this.getLogUnitLabel(log);
    const existingItems = this.getEquipmentNeedsForLog(log);

    let itemsHtml = '';
    if (existingItems.length > 0) {
      itemsHtml = `
        <div style="margin-bottom: 10px;">
          <div style="font-weight: 700; font-size: 11.5px; color: #fbbf24; margin-bottom: 6px; display: flex; align-items: center; gap: 5px;">
            <span>⚠️ Open Equipment Issues for Unit ${this.escapeHtml(unit)}:</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${existingItems.map(item => `
              <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                <div style="min-width: 0;">
                  <span style="font-weight: 700; color: #38bdf8;">${this.escapeHtml(item.equipmentType || 'Equipment')}</span>:
                  <span style="color: #f1f5f9;">${this.escapeHtml(item.desc || item.notes || 'Issue reported')}</span>
                  <span style="font-size: 10px; color: #94a3b8; margin-left: 6px;">(Status: ${this.escapeHtml(item.status || 'Needs Attention')})</span>
                </div>
                ${item.rowIdx ? `
                  <button type="button" class="btn btn-secondary" onclick="window.safetyComplianceEngine.resolveEquipmentNeedFromPdf(${item.rowIdx})"
                          style="font-size: 10px; padding: 2px 7px; color: #34d399; border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.1); cursor: pointer;" title="Mark this issue as Resolved in Safety Equipment Needs and Trip Planner">
                    ✓ Resolve
                  </button>
                ` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    } else {
      itemsHtml = `
        <div style="font-size: 11.5px; color: #94a3b8; margin-bottom: 10px; padding: 8px 12px; background: rgba(255, 255, 255, 0.02); border-radius: 6px; border: 1px dashed rgba(255, 255, 255, 0.1);">
          ✓ No open equipment defects currently logged for Unit <strong>${this.escapeHtml(unit)}</strong>.
        </div>
      `;
    }

    drawer.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 280px;">
          ${itemsHtml}
        </div>
        <!-- Quick Add Form -->
        <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; padding: 10px 14px; min-width: 320px; flex: 1;">
          <div style="font-weight: 700; font-size: 11.5px; color: #60a5fa; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
            <span>➕ Add Action Item to Trip Planner (Unit ${this.escapeHtml(unit)})</span>
            <button type="button" onclick="document.getElementById('safety-pdf-action-items-drawer').style.display='none'" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 13px;">✕</button>
          </div>
          <form onsubmit="window.safetyComplianceEngine.addEquipmentNeedFromPdf(event); return false;" style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; gap: 8px;">
              <select id="pdf-add-equip-type" style="padding: 4px 8px; font-size: 11.5px; background: #1e293b; color: #f8fafc; border: 1px solid #475569; border-radius: 4px; flex: 1;" required>
                <option value="Fire Extinguisher">🧯 Fire Extinguisher</option>
                <option value="AED">⚡ AED Defibrillator</option>
                <option value="Hot Sticks">🦯 Hot Sticks / Jumpers</option>
                <option value="Fall Protection">🦺 Fall Protection / Harness</option>
                <option value="First Aid">🩹 First Aid Kit / Eyewash</option>
                <option value="Truck">🚚 Truck Defect (Tires, Horn, Wipers)</option>
                <option value="Barriers">🚧 Barriers / Cones / Signs</option>
                <option value="Other">🔧 Other Safety Equipment</option>
              </select>
            </div>
            <div style="display: flex; gap: 8px;">
              <input type="text" id="pdf-add-equip-desc" placeholder="Issue description (e.g. Discharged, Expired pads, Torn wiper)..."
                     style="padding: 4px 8px; font-size: 11.5px; background: #1e293b; color: #f8fafc; border: 1px solid #475569; border-radius: 4px; flex: 1;" required />
              <button type="submit" class="btn btn-primary" style="font-size: 11px; padding: 4px 12px; font-weight: 700; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; white-space: nowrap;">
                Add to Trip Planner
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  /**
   * Adds an equipment action item directly to Safety Equipment Needs from the PDF viewer.
   */
  async addEquipmentNeedFromPdf(e) {
    if (e && e.preventDefault) e.preventDefault();
    const log = this._activeViewingLog;
    if (!log) return;

    const typeEl = document.getElementById('pdf-add-equip-type');
    const descEl = document.getElementById('pdf-add-equip-desc');
    const equipType = typeEl ? typeEl.value : 'Other';
    const desc = descEl ? descEl.value.trim() : '';

    if (!desc) {
      alert('Please enter an issue description.');
      return;
    }

    const today = new Date();
    const todayFormatted = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
    const unit = this.getLogUnitLabel(log);
    const jobNum = log.jobNumber || log.creditedTo || '';
    const foreman = log.foreman || '';
    const reportDate = log.date || todayFormatted;

    const newRow = {
      'Date': reportDate,
      'Report Date': reportDate,
      'Report Type': 'Safety Checklist',
      'Job Number': jobNum,
      'Foreman': foreman,
      'Vehicle Number': unit,
      'Equipment Type': equipType,
      'Issue Description': desc,
      'Status': 'Needs Attention',
      'Source Email ID': log.emailId || '',
      'Notes': `Added via PDF Viewer for Unit ${unit}`,
      'Email Subject': log.subject || '',
      'Received Date': log.dateReceived || todayFormatted
    };

    if (window.localDB && typeof window.localDB.addMutation === 'function') {
      await window.localDB.addMutation({
        action: 'ADD_ROW',
        sheetName: 'Safety Equipment Needs',
        tableKey: 'safety_equipment_needs',
        row: newRow
      });
    }

    log.hasEquipmentIssues = 'Yes';
    if (descEl) descEl.value = '';

    if (typeof window.showToast === 'function') {
      window.showToast(`✅ Added ${equipType} action item for Unit ${unit} to Trip Planner!`, 'success');
    }

    // Refresh drawer
    this.renderActionItemsDrawer();

    // Refresh Action Items button in modal header
    const actionItemsBtn = document.getElementById('safety-pdf-btn-action-items');
    if (actionItemsBtn) {
      const openNeeds = this.getEquipmentNeedsForLog(log);
      actionItemsBtn.innerHTML = `<span>⚠️</span> Action Items (${openNeeds.length})`;
      actionItemsBtn.style.background = 'rgba(239, 68, 68, 0.2)';
      actionItemsBtn.style.borderColor = 'rgba(239, 68, 68, 0.5)';
      actionItemsBtn.style.color = '#fca5a5';
    }

    // Re-render pill buttons to reflect ⚠️
    if (this._activeChecklistsGroup && this._activeChecklistsGroup.length > 1) {
      this.openPdfViewer(log.id, this._activeChecklistsGroup);
    }

    // Refresh Trip Planner sidebar if tripPlanner exists
    if (window.tripPlanner) {
      if (typeof window.tripPlanner.renderEquipmentNeedsList === 'function') {
        window.tripPlanner.renderEquipmentNeedsList();
      } else if (typeof window.tripPlanner.renderEquipmentSidebar === 'function') {
        window.tripPlanner.renderEquipmentSidebar();
      }
    }
  }

  /**
   * Resolves an equipment action item from the PDF viewer.
   */
  async resolveEquipmentNeedFromPdf(rowIdx) {
    const today = new Date();
    const todayFormatted = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;

    // If resolving a synthesized need (rowIdx is null)
    if (!rowIdx) {
      const log = this._activeViewingLog;
      const unit = this.getLogUnitLabel(log).toLowerCase();
      let resolvedKeys = [];
      try {
        resolvedKeys = JSON.parse(localStorage.getItem('sa_resolved_equip_needs') || '[]');
      } catch (_err) {
        resolvedKeys = [];
      }
      if (unit === 'x9') {
        resolvedKeys.push('equip_x9_fe');
        localStorage.setItem('sa_resolved_equip_x9_fe', 'true');
      }
      localStorage.setItem('sa_resolved_equip_needs', JSON.stringify(resolvedKeys));

      if (typeof window.showToast === 'function') {
        window.showToast('✅ Marked equipment need as Resolved.', 'info');
      }

      this.renderActionItemsDrawer();

      const actionItemsBtn = document.getElementById('safety-pdf-btn-action-items');
      if (actionItemsBtn) {
        actionItemsBtn.innerHTML = `<span>🔧</span> Action Items`;
        actionItemsBtn.style.background = 'rgba(245, 158, 11, 0.12)';
        actionItemsBtn.style.borderColor = 'rgba(245, 158, 11, 0.4)';
        actionItemsBtn.style.color = '#fbbf24';
      }

      if (window.tripPlanner) {
        if (typeof window.tripPlanner.renderEquipmentNeedsList === 'function') {
          window.tripPlanner.renderEquipmentNeedsList();
        } else if (typeof window.tripPlanner.renderEquipmentSidebar === 'function') {
          window.tripPlanner.renderEquipmentSidebar();
        }
      }
      return;
    }

    if (window.localDB && typeof window.localDB.addMutation === 'function') {
      await window.localDB.addMutation({
        action: 'UPDATE_CELL',
        sheetName: 'Safety Equipment Needs',
        tableKey: 'safety_equipment_needs',
        row: rowIdx,
        col: 8,
        header: 'Status',
        value: 'Resolved'
      });
      await window.localDB.addMutation({
        action: 'UPDATE_CELL',
        sheetName: 'Safety Equipment Needs',
        tableKey: 'safety_equipment_needs',
        row: rowIdx,
        col: 14,
        header: 'Resolved On',
        value: todayFormatted
      });
    }

    if (typeof window.showToast === 'function') {
      window.showToast('✅ Marked equipment need as Resolved.', 'info');
    }

    this.renderActionItemsDrawer();

    const log = this._activeViewingLog;
    if (log) {
      const actionItemsBtn = document.getElementById('safety-pdf-btn-action-items');
      if (actionItemsBtn) {
        const openNeeds = this.getEquipmentNeedsForLog(log);
        if (openNeeds.length > 0) {
          actionItemsBtn.innerHTML = `<span>⚠️</span> Action Items (${openNeeds.length})`;
        } else {
          actionItemsBtn.innerHTML = `<span>🔧</span> Action Items`;
          actionItemsBtn.style.background = 'rgba(245, 158, 11, 0.12)';
          actionItemsBtn.style.borderColor = 'rgba(245, 158, 11, 0.4)';
          actionItemsBtn.style.color = '#fbbf24';
        }
      }
    }

    if (window.tripPlanner) {
      if (typeof window.tripPlanner.renderEquipmentNeedsList === 'function') {
        window.tripPlanner.renderEquipmentNeedsList();
      } else if (typeof window.tripPlanner.renderEquipmentSidebar === 'function') {
        window.tripPlanner.renderEquipmentSidebar();
      }
    }
  }

  /**
   * Helper to extract a bounded section of text between startPattern and the next major section.
   */
  extractChecklistSection(text, startPattern, stopPattern) {
    const startMatch = text.match(startPattern);
    if (!startMatch) return '';
    const startIdx = startMatch.index + startMatch[0].length;
    const remaining = text.slice(startIdx);
    const stopMatch = remaining.match(stopPattern);
    if (stopMatch) {
      return remaining.slice(0, stopMatch.index);
    }
    return remaining.slice(0, 2500);
  }

  /**
   * Parses safety defects (fire extinguishers, AEDs, hot sticks, truck repairs, etc.)
   * from extracted checklist text with scoped highlight keywords.
   */
  parseChecklistIssuesFromText(text, context = {}) {
    const issues = [];
    if (!text) return issues;
    const normalized = String(text).replace(/\r?\n/g, ' ');

    const nextSectionRegex = /\b(?:First Aid Kits|Triangles|Hot Sticks|Fire Extinguisher|Cones|Signs|Insulated Jumpers|AED|Crane log books|Mileage books|Manuf\.?\s*operation manual|Fall Protection Gear|Harnesses\/Lanyards|Tools|Hot Hoist|Chains,\s*Chokers|Barriers|Trucks|Misc\s*Comments|General)\b/i;

    // 1. Fire Extinguisher section
    const feText = this.extractChecklistSection(normalized, /\bfire\s*extinguisher\b/i, nextSectionRegex);
    if (feText) {
      const testMatch = feText.match(/test\s*(?:date|due)\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i);
      if (testMatch) {
        const rawTestDate = testMatch[1].trim();
        const tDate = new Date(rawTestDate);
        if (!isNaN(tDate.getTime())) {
          const expDate = new Date(tDate);
          expDate.setFullYear(expDate.getFullYear() + 1);
          const refDate = context.date ? new Date(context.date) : new Date();
          const now = new Date();
          if (now > expDate || refDate > expDate) {
            const tDateStr = tDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
            const expDateStr = `${expDate.getMonth() + 1}/${expDate.getDate()}/${expDate.getFullYear()}`;
            const formattedTestDate = `${String(tDate.getMonth() + 1).padStart(2, '0')}/${String(tDate.getDate()).padStart(2, '0')}/${tDate.getFullYear()}`;
            issues.push({
              equipmentType: 'Fire Extinguisher',
              shortLabel: 'Fire Extinguisher',
              issueDescription: `Fire Extinguisher EXPIRED - Last test: ${tDateStr} (expired ${expDateStr})`,
              feTestDate: formattedTestDate,
              rawDateStr: rawTestDate,
              highlightKeywords: [rawTestDate, formattedTestDate, `Test due: ${rawTestDate}`, `Test date: ${rawTestDate}`, 'Fire Extinguisher'],
              notes: `Fire Extinguisher EXPIRED - Last test: ${tDateStr} (expired ${expDateStr})`
            });
          }
        }
      }

      const chargeMatch = feText.match(/properly\s*charged\s*\??\s*:?\s*(yes|no)/i);
      if (chargeMatch && chargeMatch[1].toLowerCase() === 'no') {
        issues.push({
          equipmentType: 'Fire Extinguisher',
          shortLabel: 'Fire Extinguisher (Charge)',
          issueDescription: 'Fire Extinguisher not properly charged',
          feTestDate: '',
          highlightKeywords: ['Properly charged?: No', 'Properly charged: No', 'Fire Extinguisher'],
          notes: 'Discharged / needs recharge'
        });
      }

      const inspMatch = feText.match(/monthly\s*inspection\s*done\s*\??\s*:?\s*(yes|no)/i);
      if (inspMatch && inspMatch[1].toLowerCase() === 'no') {
        issues.push({
          equipmentType: 'Fire Extinguisher',
          shortLabel: 'Fire Extinguisher (Insp)',
          issueDescription: 'Fire Extinguisher monthly inspection not done',
          feTestDate: '',
          highlightKeywords: ['Monthly inspection done?: No', 'Monthly inspection done: No', 'Fire Extinguisher'],
          notes: 'Monthly inspection missing'
        });
      }
    }

    // 2. AED section
    const aedText = this.extractChecklistSection(normalized, /\baed\b/i, nextSectionRegex);
    if (aedText) {
      const aedDamageNa = /any\s*damage\s*visible\s*\??\s*:?\s*na\b/i.test(aedText);
      const aedPadsNa = /defibrillation\s*pads\s*:?\s*na\b/i.test(aedText);

      const dmgMatch = aedText.match(/any\s*damage\s*visible\s*\??\s*:?\s*(yes|no)/i);
      if (dmgMatch && dmgMatch[1].toLowerCase() === 'yes') {
        issues.push({
          equipmentType: 'AED',
          shortLabel: 'AED Damage',
          issueDescription: 'AED has visible damage',
          highlightKeywords: ['Any damage visible?: Yes', 'Any damage visible: Yes', 'AED'],
          notes: 'Visible damage reported on AED'
        });
      }

      const padRegex = /expiration\s*date\s*of\s*pads\s*set\s*([12])\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/gi;
      let padMatch;
      const seenPadDates = new Set();
      while ((padMatch = padRegex.exec(aedText)) !== null) {
        const setNum = padMatch[1];
        const pDateStr = padMatch[2].trim();
        const pDate = new Date(pDateStr);
        if (!isNaN(pDate.getTime())) {
          const oneMonthFuture = new Date();
          oneMonthFuture.setMonth(oneMonthFuture.getMonth() + 1);
          if (pDate <= oneMonthFuture && !seenPadDates.has(`${setNum}:${pDateStr}`)) {
            seenPadDates.add(`${setNum}:${pDateStr}`);
            issues.push({
              equipmentType: 'AED',
              shortLabel: `AED Pads (Set ${setNum})`,
              issueDescription: `Needs AED Pads (Set ${setNum}: ${pDateStr})`,
              rawDateStr: pDateStr,
              highlightKeywords: [pDateStr, `Expiration date of pads Set ${setNum}: ${pDateStr}`, 'AED'],
              notes: `Set ${setNum} pads expire/expired on ${pDateStr}. Needs replacement AED pads.`
            });
          }
        }
      }

      // Only flag status indicator light failures when the unit carries an AED (not NA/NA)
      if (!(aedDamageNa && aedPadsNa)) {
        const lightMatch = aedText.match(/visual\s*rescue\s*ready\s*light(?:\s*is)?\s*:?\s*(no\s*light|red|flashing|blinking|error|fail)/i);
        if (lightMatch) {
          const lightStatus = lightMatch[1].trim();
          issues.push({
            equipmentType: 'AED',
            shortLabel: 'AED Status Light',
            issueDescription: `AED Visual Rescue Ready Light issue (${lightStatus})`,
            highlightKeywords: [`Visual Rescue Ready Light is: ${lightStatus}`, 'Visual Rescue Ready Light', lightStatus, 'AED'],
            notes: `AED rescue ready light reported as: ${lightStatus}`
          });
        }
      }
    }

    // 3. First Aid Kits
    const faText = this.extractChecklistSection(normalized, /\bfirst\s*aid\s*kits?\b/i, nextSectionRegex);
    if (faText) {
      const stockMatch = faText.match(/fully\s*stocked\s*\??\s*:?\s*(yes|no)/i);
      if (stockMatch && stockMatch[1].toLowerCase() === 'no') {
        issues.push({
          equipmentType: 'First Aid',
          shortLabel: 'First Aid Kit',
          issueDescription: 'First Aid Kit not fully stocked',
          highlightKeywords: ['Fully Stocked: No', 'Fully Stocked?: No', 'First Aid Kits'],
          notes: 'Restock First Aid supplies'
        });
      }
    }

    // 4. Hot Sticks
    const hsText = this.extractChecklistSection(normalized, /\bhot\s*sticks?\b/i, nextSectionRegex);
    if (hsText) {
      const condMatch = hsText.match(/good\s*condition\s*\??\s*:?\s*(yes|no)/i);
      if (condMatch && condMatch[1].toLowerCase() === 'no') {
        issues.push({
          equipmentType: 'Hot Sticks',
          shortLabel: 'Hot Sticks',
          issueDescription: 'Hot Sticks not in good condition',
          highlightKeywords: ['Good Condition?: No', 'Good Condition: No', 'Hot Sticks'],
          notes: 'Hot sticks damaged or failing inspection'
        });
      }
      const hsTestMatch = hsText.match(/test\s*(?:date|due)\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i);
      if (hsTestMatch) {
        const hsDate = new Date(hsTestMatch[1]);
        if (!isNaN(hsDate.getTime())) {
          const hsExp = new Date(hsDate);
          hsExp.setFullYear(hsExp.getFullYear() + 2); // 24-month cycle
          const now = new Date();
          if (now > hsExp) {
            const rawHsDate = hsTestMatch[1].trim();
            issues.push({
              equipmentType: 'Hot Sticks',
              shortLabel: 'Hot Sticks (Test)',
              issueDescription: `Hot Sticks EXPIRED / Due for Testing - Last test: ${rawHsDate}`,
              rawDateStr: rawHsDate,
              highlightKeywords: [rawHsDate, `Test Date: ${rawHsDate}`, `Test due: ${rawHsDate}`, 'Hot Sticks'],
              notes: 'Hot sticks overdue for dielectric test (2-year cycle)'
            });
          }
        }
      }
    }

    // 5. Insulated Jumpers
    const ijText = this.extractChecklistSection(normalized, /\binsulated\s*jumpers?\b/i, nextSectionRegex);
    if (ijText) {
      const condMatch = ijText.match(/good\s*condition\s*\??\s*:?\s*(yes|no)/i);
      if (condMatch && condMatch[1].toLowerCase() === 'no') {
        issues.push({
          equipmentType: 'Hot Sticks',
          shortLabel: 'Insulated Jumpers',
          issueDescription: 'Insulated Jumpers not in good condition',
          highlightKeywords: ['Good condition?: No', 'Good condition: No', 'Insulated Jumpers'],
          notes: 'Jumpers damaged or failing visual inspection'
        });
      }
    }

    // 6. Truck Defects (Page 2 "Trucks" section: Wipers, Horn/Air Horn, Other/Dashboard, Tires, Brakes, Lights, etc.)
    const truckText = this.extractChecklistSection(normalized, /\bTrucks\b/i, /\b(?:Misc\s*Comments|General)\b/i);
    if (truckText) {
      const seenTruckKeys = new Set();
      const truckFieldHeader = '(?:Tires|Wheel\\s*[Cc]hocks|Brakes|Lights|Mirrors|Reflectors|Warning\\s*[Ll]ights|Windows|Heater|Windshield|Wipers|Air\\s*[Hh]orns?|Horns?|Back-?[Uu]p\\s*[Aa]larm|Seat\\s*[Bb]elts|Other|[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)';
      const truckFieldBoundaryRegex = new RegExp(`(${truckFieldHeader})\\s*\\??\\s*:\\s*([Yy][Ee][Ss]|[Nn][Oo]|[Nn]\\/?[Aa])\\b`, 'g');
      const truckFields = [];
      let bMatch;
      while ((bMatch = truckFieldBoundaryRegex.exec(truckText)) !== null) {
        truckFields.push({
          label: bMatch[1].trim(),
          status: bMatch[2].trim().toLowerCase(),
          endIdx: truckFieldBoundaryRegex.lastIndex,
          startIdx: bMatch.index
        });
      }

      for (let i = 0; i < truckFields.length; i++) {
        const field = truckFields[i];
        if (field.status !== 'no') continue;

        const nextStart = i + 1 < truckFields.length ? truckFields[i + 1].startIdx : truckText.length;
        const rawBetween = truckText.slice(field.endIdx, nextStart).trim();
        const rawComment = rawBetween.replace(/^comments?\s*:?\s*/i, '').trim();

        const rawLabel = field.label;
        const normLabel = rawLabel.toLowerCase();
        if (seenTruckKeys.has(normLabel)) continue;
        seenTruckKeys.add(normLabel);

        let desc = `${rawLabel} requires repair/attention`;
        let shortLabel = rawLabel;
        if (/wiper/i.test(rawLabel)) {
          desc = rawComment ? `Windshield wipers need replacement (${rawComment})` : 'Windshield wipers need replacement';
          shortLabel = 'Wipers';
        } else if (/horn/i.test(rawLabel) || /air\s*horn/i.test(rawComment)) {
          desc = rawComment ? `${rawLabel}: ${rawComment}` : 'City/Air horn inoperative';
          shortLabel = /air\s*horn/i.test(`${rawLabel} ${rawComment}`) ? 'Air Horn' : rawLabel;
        } else if (/^other$/i.test(rawLabel) && rawComment) {
          desc = `Truck defect (Other): ${rawComment}`;
          shortLabel = 'Truck (Other)';
        } else if (rawComment) {
          desc = `Truck ${rawLabel}: ${rawComment}`;
        }

        const kws = [`${rawLabel}: No`, `${rawLabel}?: No`];
        if (rawComment && rawComment.length >= 4) {
          kws.push(rawComment);
        }

        issues.push({
          equipmentType: 'Truck',
          shortLabel,
          issueDescription: desc,
          highlightKeywords: kws,
          notes: rawComment || `${rawLabel} marked No on truck inspection`
        });
      }

      // Fallback checks for free-text truck failure phrasing when boolean format differs
      if (!seenTruckKeys.has('wipers')) {
        const badWiper = truckText.match(/wipers?\s*\??\s*:?\s*(bad|poor|torn|needs?\s*replac[^\s,;.]*)/i);
        if (badWiper) {
          issues.push({
            equipmentType: 'Truck',
            shortLabel: 'Wipers',
            issueDescription: 'Windshield wipers need replacement',
            highlightKeywords: [`Wipers: ${badWiper[1].trim()}`, badWiper[1].trim()],
            notes: 'Wipers torn or failing inspection'
          });
        }
      }
      if (!seenTruckKeys.has('horn') && !seenTruckKeys.has('horns') && !seenTruckKeys.has('air horn')) {
        const badHorn = truckText.match(/((?:air\s*)?horns?\s*\??\s*:?\s*(?:bad|poor|inop[^\s,;.]*|doesn't\s*work|does\s*not\s*work))/i);
        if (badHorn) {
          issues.push({
            equipmentType: 'Truck',
            shortLabel: 'Horn',
            issueDescription: 'City/Air horn inoperative',
            highlightKeywords: [badHorn[1].trim()],
            notes: 'Horn inoperative'
          });
        }
      }
    }

    return issues;
  }

  /**
   * Extracts text from a checklist PDF via pdfjsLib and syncs any detected equipment defects
   * directly to safety_equipment_needs and the Trip Planner.
   */
  async scanAndSyncChecklistIssues(byteArray, log) {
    if (!byteArray || !log || !window.pdfjsLib) return;

    try {
      const loadingTask = window.pdfjsLib.getDocument({ data: byteArray.slice() });
      const pdfDoc = await loadingTask.promise;
      let fullText = '';
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const page = await pdfDoc.getPage(p);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += '\n' + pageText;
      }

      if (!fullText.trim()) return;

      const checklistDate = log.date || log.dateReceived || '';
      const issues = this.parseChecklistIssuesFromText(fullText, { date: checklistDate });
      if (!issues || issues.length === 0) return;

      const unit = this.getLogUnitLabel(log);
      const jobNum = log.jobNumber || log.creditedTo || '';
      const foreman = log.foreman || '';
      const snap = window.localDB ? window.localDB.getSnapshot() : null;
      const equipTable = snap && snap.tables ? snap.tables.safety_equipment_needs : null;
      const existingRows = equipTable && equipTable.rows ? equipTable.rows : [];

      let addedAny = false;
      for (const issue of issues) {
        const alreadyExists = existingRows.some(r => {
          const status = String(r['Status'] || '').toLowerCase();
          if (status.includes('resolve') || status.includes('complete')) return false;

          const rVeh = String(r['Vehicle Number'] || r['Vehicle #'] || r['Truck'] || r['Unit'] || '').trim().toLowerCase();
          const rEmail = String(r['Source Email ID'] || r['Email ID'] || '').trim();
          const rType = String(r['Equipment Type'] || r['Equipment'] || '').trim().toLowerCase();
          const rJob = String(r['Job Number'] || r['Job #'] || r['Crew'] || '').trim().toLowerCase();

          if (log.emailId && rEmail && log.emailId === rEmail && rType === issue.equipmentType.toLowerCase()) {
            return true;
          }

          if (unit && rVeh && (unit.toLowerCase() === rVeh || rVeh.includes(unit.toLowerCase()))) {
            if (rType === issue.equipmentType.toLowerCase()) {
              if (!jobNum || !rJob || jobNum.toLowerCase() === rJob) {
                return true;
              }
            }
          }
          return false;
        });

        if (alreadyExists) continue;

        const today = new Date();
        const todayFormatted = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
        const repDate = log.date || todayFormatted;

        const newRow = {
          'Report Date': repDate,
          'Report Type': 'Safety Checklist',
          'Job Number': jobNum,
          'Foreman': foreman,
          'Vehicle Number': unit,
          'Equipment Type': issue.equipmentType,
          'Issue Description': issue.issueDescription,
          'Status': 'Needs Attention',
          'FE Test Date': issue.feTestDate || '',
          'Source Email ID': log.emailId || '',
          'Notes': issue.notes || issue.issueDescription,
          'Email Subject': log.subject || '',
          'Received Date': log.dateReceived || todayFormatted,
          'Resolved On': '',
          'Archive Controller': '',
          'Column 1': ''
        };

        if (window.localDB && typeof window.localDB.addMutation === 'function') {
          await window.localDB.addMutation({
            action: 'ADD_ROW',
            sheetName: 'Safety Equipment Needs',
            tableKey: 'safety_equipment_needs',
            row: newRow
          });
          addedAny = true;
        }
      }

      if (addedAny) {
        log.hasEquipmentIssues = 'Yes';
        if (window.localDB && log.rowIndex) {
          await window.localDB.addMutation({
            action: 'UPDATE_CELL',
            sheetName: 'Monthly Checklist Log',
            tableKey: 'monthly_checklist_log',
            row: log.rowIndex,
            col: 10,
            header: 'Has Equipment Issues',
            value: 'Yes'
          });
        }

        const actionItemsBtn = document.getElementById('safety-pdf-btn-action-items');
        if (actionItemsBtn) {
          const openNeeds = this.getEquipmentNeedsForLog(log);
          actionItemsBtn.innerHTML = `<span>⚠️</span> Action Items (${openNeeds.length})`;
          actionItemsBtn.style.background = 'rgba(239, 68, 68, 0.2)';
          actionItemsBtn.style.borderColor = 'rgba(239, 68, 68, 0.5)';
          actionItemsBtn.style.color = '#fca5a5';
        }

        if (this._activeChecklistsGroup && this._activeChecklistsGroup.length > 1) {
          const versionSelector = document.getElementById('safety-pdf-version-selector');
          if (versionSelector) {
            versionSelector.innerHTML = this._activeChecklistsGroup.map((l) => {
              const isSelected = (l.id === log.id || (l.sheetName + '_' + l.rowIndex) === log.id || (l.emailId && l.emailId === log.emailId));
              const u = this.getLogUnitLabel(l);
              const dt = l.date ? String(l.date).replace(/\/20(\d\d)$/, '/$1') : (l.dateReceived ? String(l.dateReceived).split(' ')[0].replace(/\/20(\d\d)$/, '/$1') : '');
              const hasIssues = String(l.hasEquipmentIssues || '').toLowerCase() === 'yes' || this.hasEquipmentNeedsForLog(l);

              const btnBg = isSelected ? 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)' : 'rgba(255, 255, 255, 0.08)';
              const btnBorder = isSelected ? '#38bdf8' : 'rgba(255, 255, 255, 0.18)';
              const btnColor = isSelected ? '#ffffff' : '#cbd5e1';
              const shadow = isSelected ? 'box-shadow: 0 2px 8px rgba(2, 132, 199, 0.4);' : '';

              return `
                <button type="button" class="btn pdf-pill-btn ${isSelected ? 'active' : ''}" onclick="window.safetyComplianceEngine.openPdfViewer('${this.escapeJs(l.id)}', window.safetyComplianceEngine._activeChecklistsGroup)"
                        style="padding: 3px 9px; font-size: 11px; font-weight: 700; border-radius: 14px; border: 1px solid ${btnBorder}; background: ${btnBg}; color: ${btnColor}; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; ${shadow}"
                        title="Unit ${this.escapeHtml(u)} · Date: ${this.escapeHtml(l.date || l.dateReceived)}${hasIssues ? ' · ⚠️ Equipment defect reported' : ''}">
                  <span>🚗 ${this.escapeHtml(u)}</span>
                  ${dt ? `<span style="font-size: 9.5px; opacity: 0.85; font-weight: 500;">(${this.escapeHtml(dt)})</span>` : ''}
                  ${hasIssues ? `<span style="color: #fbbf24; font-size: 11px;" title="Equipment defect reported">⚠️</span>` : ''}
                </button>
              `;
            }).join('');
          }
        }

        if (window.tripPlanner) {
          if (typeof window.tripPlanner.renderEquipmentNeedsList === 'function') {
            window.tripPlanner.renderEquipmentNeedsList();
          } else if (typeof window.tripPlanner.renderEquipmentSidebar === 'function') {
            window.tripPlanner.renderEquipmentSidebar();
          }
        }

        if (typeof window.showToast === 'function') {
          window.showToast(`⚠️ Detected equipment defect in Unit ${unit} checklist — added to Trip Planner!`, 'warning');
        }
      }
      return issues || [];
    } catch (err) {
      console.warn('[PDF Viewer] scanAndSyncChecklistIssues error:', err);
      return [];
    }
  }

  /**
   * Quick-opens the attached PDF for a cell clicked in the Safety Compliance tracker sheet.
   * If clicking Monthly Checklist, searches all checklists for that crew in the target month
   * and opens the viewer with clickable unit pill buttons.
   */
  openPdfForComplianceCell(jobNum, colHeader, weekStart, foreman = '') {
    if (!this.currentLogs || this.currentLogs.length === 0) {
      this.currentLogs = this.extractLogsFromLocalDB();
    }
    const cleanJob = String(jobNum || '').trim();
    const cleanWeek = String(weekStart || '').trim();
    const cleanForeman = String(foreman || '').trim();
    const hLower = String(colHeader || '').toLowerCase();

    let targetType = 'JHA';
    if (hLower.includes('meeting')) {
      targetType = 'Weekly Safety Meeting';
    } else if (hLower.includes('checklist')) {
      targetType = 'Monthly Checklist';
    }

    // 1. Monthly Checklist handling
    if (targetType === 'Monthly Checklist') {
      const checklists = this.getMonthlyChecklistsForCrew(cleanJob, cleanWeek, cleanForeman);
      if (checklists.length > 0) {
        // Open the newest one, passing the full group of checklists so pill buttons render
        this.openPdfViewer(checklists[0], checklists);
        return;
      }
    }

    // 2. Weekly Safety Meeting handling
    if (targetType === 'Weekly Safety Meeting') {
      const weeklyLogs = (this.currentLogs || []).filter(l => {
        const isWeekly = l.type === 'Weekly Safety Meeting' || l.sheetName === 'Weekly Safety Log';
        if (!isWeekly) return false;
        return this.logMatchesCrew(l, cleanJob, cleanForeman);
      });
      weeklyLogs.sort((a, b) => {
        const aExact = String(a.creditedTo || '').trim() === cleanJob ? 1 : 0;
        const bExact = String(b.creditedTo || '').trim() === cleanJob ? 1 : 0;
        return bExact - aExact;
      });

      if (weeklyLogs.length > 0) {
        let bestMatch = null;
        let hasValidWeek = false;
        if (cleanWeek) {
          const wStart = this.parseDateHelper(cleanWeek);
          if (wStart) {
            hasValidWeek = true;
            // Sunday noon reference
            const startMs = wStart.getTime() - 24 * 60 * 60 * 1000;
            const endMs = wStart.getTime() + 7 * 24 * 60 * 60 * 1000;
            bestMatch = weeklyLogs.find(l => {
              const mDate = this.parseDateHelper(l.date) || this.parseDateHelper(l.dateReceived);
              if (mDate) {
                return mDate.getTime() >= startMs && mDate.getTime() <= endMs;
              }
              return false;
            });
            // Extended search window if needed (covers slight timezone shifts)
            if (!bestMatch) {
              const extStartMs = wStart.getTime() - 4 * 24 * 60 * 60 * 1000;
              const extEndMs = wStart.getTime() + 11 * 24 * 60 * 60 * 1000;
              bestMatch = weeklyLogs.find(l => {
                const mDate = this.parseDateHelper(l.date) || this.parseDateHelper(l.dateReceived);
                if (mDate) {
                  return mDate.getTime() >= extStartMs && mDate.getTime() <= extEndMs;
                }
                return false;
              });
            }
          }
        }
        // Fallback to newest weekly meeting only if no valid week filter was supplied
        if (!bestMatch && !hasValidWeek) {
          bestMatch = weeklyLogs[0];
        }
        if (bestMatch) {
          this.openPdfViewer(bestMatch);
          return;
        }
      }
    }

    // 3. Daily JHA handling
    if (targetType === 'JHA') {
      const dayMap = { 'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6 };
      const dateMatch = String(colHeader).match(/(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/);
      let dateSubstr = dateMatch ? dateMatch[1] : '';
      let targetDateObj = null;

      if (!dateSubstr && cleanWeek && dayMap[hLower] !== undefined) {
        const wStart = this.parseDateHelper(cleanWeek);
        if (wStart) {
          targetDateObj = new Date(wStart.getTime() + dayMap[hLower] * 24 * 60 * 60 * 1000);
          const m = String(targetDateObj.getMonth() + 1).padStart(2, '0');
          const d = String(targetDateObj.getDate()).padStart(2, '0');
          dateSubstr = `${m}/${d}`;
        }
      }

      const jhaLogs = (this.currentLogs || []).filter(l => {
        if (l.type !== 'JHA' && l.sheetName !== 'JHA Log') return false;
        return this.logMatchesCrew(l, cleanJob, cleanForeman);
      });
      jhaLogs.sort((a, b) => {
        const aExact = String(a.creditedTo || '').trim() === cleanJob ? 1 : 0;
        const bExact = String(b.creditedTo || '').trim() === cleanJob ? 1 : 0;
        return bExact - aExact;
      });

      let bestJha = null;
      if (targetDateObj) {
        bestJha = jhaLogs.find(l => {
          const itemDate = this.parseDateHelper(l.date) || this.parseDateHelper(l.dateReceived);
          if (itemDate) {
            return itemDate.getFullYear() === targetDateObj.getFullYear() &&
                   itemDate.getMonth() === targetDateObj.getMonth() &&
                   itemDate.getDate() === targetDateObj.getDate();
          }
          return false;
        });
      }
      if (!bestJha && dateSubstr) {
        bestJha = jhaLogs.find(l => {
          return (l.date && l.date.includes(dateSubstr)) || (l.dateReceived && l.dateReceived.includes(dateSubstr));
        });
      }
      if (!bestJha && jhaLogs.length > 0) {
        bestJha = jhaLogs[0];
      }
      if (bestJha) {
        this.openPdfViewer(bestJha);
        return;
      }
    }

    // 4. Fallback if no matching record found at all: open audit logs modal with pre-filter
    this.openSafetyLogsModal();
    if (cleanJob) {
      this.onSearchInput(cleanJob);
      const searchBox = document.getElementById('safety-log-search');
      if (searchBox) searchBox.value = cleanJob;
    }
  }

  /**
   * Authoritative lookup that resolves a crew or job number to the real employee foreman name.
   * Checks job_tracking, FY_TRANSITION_ALIAS_MAP, employees, and employee_history.
   * NEVER returns a job number or 'UNKNOWN'.
   */
  lookupForemanForCrew(crewOrJob) {
    if (!crewOrJob) return '';
    const raw = String(crewOrJob).trim();
    if (!raw) return '';

    // If already a person's name (contains letters, spaces, no job number format, not UNKNOWN)
    if (!/^\d{3}-\d{2}/.test(raw) && raw.toLowerCase() !== 'unknown' && isNaN(raw) && raw.length >= 3) {
      return raw;
    }

    const snap = (window.localDB && typeof window.localDB.getSnapshot === 'function') ? window.localDB.getSnapshot() : null;
    if (!snap || !snap.tables) return '';

    const clean = raw.toLowerCase();
    const cleanBase = raw.split('.')[0].trim().toLowerCase();
    const aliasMap = (snap.configs && snap.configs['FY_TRANSITION_ALIAS_MAP']) || {};
    const aliased = (aliasMap[raw] || aliasMap[clean] || aliasMap[cleanBase] || '').toLowerCase();

    // 1. Check job_tracking table
    const jt = snap.tables.job_tracking;
    if (jt && jt.rows) {
      const row = jt.rows.find(r => {
        const jn = String(r['Job Number'] || r['Crew'] || r['Job #'] || '').trim().toLowerCase();
        const jnBase = jn.split('.')[0].trim();
        return jn === clean || jn === cleanBase || jn === aliased || jnBase === cleanBase;
      });
      if (row) {
        const fm = String(row['Foreman'] || row['Crew Lead'] || row['Lead'] || '').trim();
        if (fm && !/^\d{3}-\d{2}/.test(fm) && fm.toLowerCase() !== 'unknown') {
          return fm;
        }
      }
    }

    // 2. Check employees table (prefer foreman classifications)
    const emp = snap.tables.employees;
    if (emp && emp.rows) {
      const candidates = emp.rows.filter(r => {
        const jn = String(r['Job Number'] || r['Crew'] || '').trim().toLowerCase();
        const jnBase = jn.split('.')[0].trim();
        return jn === clean || jn === cleanBase || jn === aliased || jnBase === cleanBase;
      });
      if (candidates.length > 0) {
        const rank = (c) => {
          const cl = String(c['Classification'] || c['Title'] || '').toUpperCase();
          if (cl.includes('SUP')) return 1;
          if (cl.includes('GF')) return 2;
          if (cl === 'F' || cl.startsWith('F ') || cl.endsWith(' F')) return 3;
          if (cl.includes('GTO F')) return 4;
          if (cl.includes('JRY')) return 5;
          return 10;
        };
        candidates.sort((a, b) => rank(a) - rank(b));
        const empName = String(candidates[0]['Name'] || candidates[0]['Employee Name'] || '').trim();
        if (empName && !/^\d{3}-\d{2}/.test(empName) && empName.toLowerCase() !== 'unknown') {
          return empName;
        }
      }
    }

    // 3. Check employee_history table
    const hist = snap.tables.employee_history;
    if (hist && hist.rows) {
      const hRow = hist.rows.find(r => {
        const jn = String(r['Job Number'] || r['Crew'] || '').trim().toLowerCase();
        const jnBase = jn.split('.')[0].trim();
        return jn === clean || jn === cleanBase || jn === aliased || jnBase === cleanBase;
      });
      if (hRow) {
        const hName = String(hRow['Name'] || hRow['Employee Name'] || '').trim();
        if (hName && !/^\d{3}-\d{2}/.test(hName) && hName.toLowerCase() !== 'unknown') {
          return hName;
        }
      }
    }

    // 4. Known FY transition aliases fallback
    const knownTransitionForemen = {
      '053-26': 'Ryan Taylor',
      '014-27': 'Ryan Taylor',
      '049-26': 'Nick Wright',
      '026-27': 'Nick Wright',
      '012-26': 'Chad Cliff',
      '012-27': 'Chad Cliff'
    };
    if (knownTransitionForemen[raw]) return knownTransitionForemen[raw];

    return '';
  }

  /**
   * Immediately credits a report in the local Safety Compliance table and refreshes the UI.
   * Ensures UI cards (e.g. Chad Cliff 012-27) immediately show Received without waiting for cloud recalc.
   */
  /**
   * Parses date strings (including "Week of MM/DD/YYYY" prefixes) into a local noon Date.
   */
  parseComplianceDate_(dStr) {
    if (!dStr) return null;
    if (dStr instanceof Date) return isNaN(dStr.getTime()) ? null : dStr;
    const cleaned = String(dStr).replace(/^week\s*of\s*/i, '').trim();
    return this.parseDateHelper(cleaned);
  }

  /**
   * Computes the Sunday-start Date (at noon) for the week containing d.
   */
  getWeekSundayNoon_(d) {
    if (!d) return null;
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
    copy.setDate(copy.getDate() - copy.getDay());
    return copy;
  }

  /**
   * Checks whether two Dates fall in the same Sunday-Saturday compliance week.
   */
  isSameComplianceWeek_(d1, d2) {
    const s1 = this.getWeekSundayNoon_(d1);
    const s2 = this.getWeekSundayNoon_(d2);
    if (!s1 || !s2) return false;
    return Math.abs(s1.getTime() - s2.getTime()) < 86400000 * 3.5;
  }

  /**
   * Checks whether this.currentLogs contains at least one Credited log entry matching
   * targetCrew for the given period and reportType.
   */
  hasCreditedLogForPeriod(targetCrew, dateStr, reportType) {
    const cleanCrew = String(targetCrew || '').trim();
    const targetDate = this.parseComplianceDate_(dateStr);
    if (!cleanCrew || !targetDate) return false;

    if (!this.currentLogs || this.currentLogs.length === 0) {
      this.currentLogs = this.extractLogsFromLocalDB();
    }

    const typeLower = String(reportType || '').toLowerCase();
    const isWeekly = typeLower.includes('meeting') || typeLower.includes('weekly');
    const isMonthly = typeLower.includes('checklist') || typeLower.includes('monthly');
    const isJha = typeLower.includes('jha');

    const targetMon = new Date(this.getWeekSundayNoon_(targetDate).getTime() + 86400000);

    return (this.currentLogs || []).some(l => {
      if (!l || String(l.status || '').trim() !== 'Credited') return false;
      const lType = String(l.type || l.sheetName || '').toLowerCase();
      if (isWeekly && !(lType.includes('meeting') || lType.includes('weekly'))) return false;
      if (isMonthly && !(lType.includes('checklist') || lType.includes('monthly'))) return false;
      if (isJha && !lType.includes('jha')) return false;

      if (!this.logMatchesCrew(l, cleanCrew, '')) return false;

      const lDate = this.parseComplianceDate_(l.date || l.dateReceived);
      if (!lDate) return false;

      if (isWeekly) {
        return this.isSameComplianceWeek_(lDate, targetDate);
      }
      if (isMonthly) {
        return lDate.getMonth() === targetMon.getMonth() && lDate.getFullYear() === targetMon.getFullYear();
      }
      if (isJha) {
        return this.isSameComplianceWeek_(lDate, targetDate) && lDate.getDay() === targetDate.getDay();
      }
      return false;
    });
  }

  /**
   * Re-evaluates a crew's compliance cell for (targetCrew, dateStr, reportType) from current logs
   * and updates safety_compliance immediately (either crediting or un-crediting stale checkmarks).
   */
  reconcileComplianceCellFromLogs(targetCrew, dateStr, reportType, foreman = '') {
    const cleanCrew = String(targetCrew || '').trim();
    if (!cleanCrew || !dateStr) return;
    const stillCredited = this.hasCreditedLogForPeriod(cleanCrew, dateStr, reportType);
    this.creditComplianceRecordLocally({
      crew: cleanCrew,
      originalJob: cleanCrew,
      dateStr: dateStr,
      reportType: reportType,
      status: stillCredited ? 'Credited' : 'Uncredited',
      foreman: foreman,
      onlyUncreditIfChecked: !stillCredited
    });
  }

  creditComplianceRecordLocally({ crew, originalJob, dateStr, reportType, status, foreman, onlyUncreditIfChecked = false }) {
    if (!window.localDB || !window.localDB.snapshot || !window.localDB.snapshot.tables) return;
    const snap = window.localDB.snapshot;
    const scTable = snap.tables.safety_compliance;
    if (!scTable || !scTable.rows) return;

    const targetCrew = String(crew || originalJob || '').trim();
    if (!targetCrew) return;

    const reportDate = this.parseComplianceDate_(dateStr) || new Date();

    const isMatchCrew = (r) => {
      const jn = String(r['Job Number'] || r['Job #'] || r['Crew'] || '').trim().toLowerCase();
      const tc = targetCrew.toLowerCase();
      if (!jn || !tc) return false;
      if (jn === tc) return true;
      const jnBase = jn.split('.')[0].trim();
      const tcBase = tc.split('.')[0].trim();
      if (jnBase && jnBase === tcBase) return true;
      const aliasMap = (snap.configs && snap.configs['FY_TRANSITION_ALIAS_MAP']) || {};
      if (aliasMap[tc] && aliasMap[tc].toLowerCase() === jn) return true;
      if (aliasMap[jn] && aliasMap[jn].toLowerCase() === tc) return true;
      return false;
    };

    const matchingRow = scTable.rows.find(r => {
      if (!isMatchCrew(r)) return false;
      const wDate = this.parseComplianceDate_(r['Week Start'] || r['Week']);
      return Boolean(wDate && this.isSameComplianceWeek_(wDate, reportDate));
    });

    if (matchingRow) {
      const isCredited = (status === 'Credited');
      const weekSun = this.getWeekSundayNoon_(this.parseComplianceDate_(matchingRow['Week Start'] || matchingRow['Week']) || reportDate);
      const weekSatEnd = new Date(weekSun.getFullYear(), weekSun.getMonth(), weekSun.getDate() + 6, 23, 59, 59);
      const uncreditedMark = (new Date() > weekSatEnd) ? '❌' : '⏳';
      const markValue = isCredited ? '✅' : uncreditedMark;
      const typeLower = String(reportType || '').toLowerCase();

      let cellKey = '';
      if (typeLower.includes('meeting') || typeLower.includes('weekly')) {
        cellKey = 'Weekly Meeting';
      } else if (typeLower.includes('checklist') || typeLower.includes('monthly')) {
        cellKey = 'Monthly Checklist';
      } else if (typeLower.includes('jha')) {
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        cellKey = days[reportDate.getDay()];
      }

      if (cellKey) {
        const currCell = String(matchingRow[cellKey] || '');
        if (isCredited || !onlyUncreditIfChecked || currCell.includes('✅')) {
          matchingRow[cellKey] = markValue;
        }
      }

      if (isCredited && foreman && (!matchingRow['Foreman'] || matchingRow['Foreman'].toLowerCase() === 'unknown' || /^\d{3}-\d{2}/.test(matchingRow['Foreman']))) {
        matchingRow['Foreman'] = foreman;
      }

      // Recalculate row status
      const allDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      let hasMissing = false;
      let hasPending = false;
      for (const d of allDays) {
        const v = String(matchingRow[d] || '');
        if (v.startsWith('❌')) hasMissing = true;
        else if (v.includes('⏳')) hasPending = true;
      }
      const wm = String(matchingRow['Weekly Meeting'] || '');
      if (wm.startsWith('❌')) hasMissing = true;
      else if (wm.includes('⏳')) hasPending = true;

      const mc = String(matchingRow['Monthly Checklist'] || '');
      if (mc.startsWith('❌')) hasMissing = true;
      else if (mc.includes('⏳')) hasPending = true;

      if (hasMissing) matchingRow['Status'] = 'Missing Reports';
      else if (hasPending) matchingRow['Status'] = 'Pending';
      else matchingRow['Status'] = 'Complete';

      matchingRow['Updated'] = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Keep scTable.rawGrid synchronized with updated matchingRow
      if (Array.isArray(scTable.rawGrid) && Array.isArray(scTable.headers)) {
        const rowArrIdx = scTable.rows.indexOf(matchingRow);
        const gridIdx = (matchingRow._rowIdx && matchingRow._rowIdx > 1)
          ? (matchingRow._rowIdx - 1)
          : (rowArrIdx !== -1 ? rowArrIdx + 1 : -1);
        if (gridIdx > 0 && scTable.rawGrid[gridIdx]) {
          scTable.headers.forEach((h, cIdx) => {
            if (matchingRow[h] !== undefined) scTable.rawGrid[gridIdx][cIdx] = matchingRow[h];
          });
        }
      }

      // Persist snapshot to disk
      if (typeof window.localDB.markTableDirty === 'function') {
        window.localDB.markTableDirty('safety_compliance');
      }
      if (typeof window.localDB.persistSnapshot === 'function') {
        window.localDB.persistSnapshot(snap);
      }

      // Re-render Safety Compliance view immediately
      if (window.sheetNavigator && typeof window.sheetNavigator.renderSafetyCompliance === 'function') {
        window.sheetNavigator.renderSafetyCompliance();
      }
    }
  }

  /**
   * Opens the Edit Log Entry modal to allow fixing typos in Foreman, Job Number, Credited To, Date, Notes.
   */
  openEditLogModal(logId) {
    const log = (this.currentLogs || []).find(l => (l.id === logId || (l.sheetName + '_' + l.rowIndex) === logId));
    if (!log) {
      alert('Log record not found.');
      return;
    }

    const existingModal = document.getElementById('edit-log-entry-modal');
    if (existingModal) existingModal.remove();

    // Auto-resolve foreman if it is currently a job number or UNKNOWN
    let initialForeman = log.foreman || '';
    if (!initialForeman || /^\d{3}-\d{2}/.test(initialForeman) || initialForeman.toLowerCase() === 'unknown') {
      const resolved = this.lookupForemanForCrew(log.creditedTo || log.jobNumber);
      if (resolved) initialForeman = resolved;
    }

    const modal = document.createElement('div');
    modal.id = 'edit-log-entry-modal';
    modal.className = 'modal-overlay active';
    modal.style.cssText = 'position: fixed; inset: 0; background: transparent; z-index: 13500; display: flex; align-items: center; justify-content: center; pointer-events: none;';

    modal.innerHTML = `
      <div class="modal-box" style="background: #1e293b; border: 1px solid var(--border-color); border-radius: 12px; width: 480px; max-width: 95vw; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7); pointer-events: auto; position: relative; z-index: 13501;">
        <div class="modal-header wm-draggable-header" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border-color); background: rgba(0,0,0,0.2);">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 18px;">✏️</span>
            <h3 style="margin: 0; font-size: 15px; font-weight: 700; color: #f8fafc;">Edit Safety Log Record</h3>
          </div>
          <button onclick="document.getElementById('edit-log-entry-modal')?.remove(); if(window.windowManager) window.windowManager.syncBackdrop();" style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 18px;">✕</button>
        </div>

        <div style="padding: 18px; display: flex; flex-direction: column; gap: 12px; max-height: 70vh; overflow-y: auto;">
          <div style="font-size: 12px; color: #6ee7b7; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 6px; padding: 8px 12px;">
            Editing <strong>${this.escapeHtml(log.type || log.sheetName)}</strong> (Row ${log.rowIndex} in <em>${this.escapeHtml(log.sheetName)}</em>)
          </div>

          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">Foreman Name</label>
            <input type="text" id="edit-log-foreman" value="${this.escapeHtml(initialForeman)}" placeholder="e.g. Chad Cliff" style="width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: var(--text-primary); font-size: 13px;" />
            <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">Must be an employee name only (never a job number).</div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">Job Number</label>
              <input type="text" id="edit-log-jobnum" value="${this.escapeHtml(log.jobNumber || '')}" style="width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: var(--text-primary); font-size: 13px; font-family: monospace;" />
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">Credited To</label>
              <input type="text" id="edit-log-credited" value="${this.escapeHtml(log.creditedTo || '')}" style="width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: var(--text-primary); font-size: 13px; font-family: monospace;" />
            </div>
          </div>

          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">Work / Report Date</label>
            <input type="text" id="edit-log-date" value="${this.escapeHtml(log.date || '')}" placeholder="MM/DD/YYYY" style="width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: var(--text-primary); font-size: 13px;" />
          </div>

          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">Status</label>
            <select id="edit-log-status" style="width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: var(--text-primary); font-size: 13px;">
              <option value="Credited" ${log.status === 'Credited' ? 'selected' : ''}>Credited</option>
              <option value="Unknown Job" ${log.status === 'Unknown Job' ? 'selected' : ''}>Unknown Job</option>
              <option value="Duplicate" ${log.status === 'Duplicate' ? 'selected' : ''}>Duplicate</option>
              <option value="Error" ${log.status === 'Error' ? 'selected' : ''}>Error</option>
            </select>
          </div>

          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">Notes / Correction Reason</label>
            <textarea id="edit-log-notes" rows="2" style="width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: var(--text-primary); font-size: 12.5px; resize: vertical;">${this.escapeHtml(log.notes || '')}</textarea>
          </div>
        </div>

        <div style="padding: 12px 18px; border-top: 1px solid var(--border-color); background: rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: flex-end; gap: 8px;">
          <button class="btn btn-secondary" onclick="document.getElementById('edit-log-entry-modal')?.remove(); if(window.windowManager) window.windowManager.syncBackdrop();">Cancel</button>
          <button class="btn btn-primary" onclick="window.safetyComplianceEngine.saveLogEntryEdit('${this.escapeHtml(logId)}')" style="font-weight: 700; background: #10b981; border: none; padding: 8px 20px;">Save Changes</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    if (window.windowManager && typeof window.windowManager.enhanceModal === 'function') {
      window.windowManager.enhanceModal(modal);
      window.windowManager.bringToFront(modal);
    }

    // Attach dynamic auto-lookup listener when user types Job # or Credited To
    const jobInput = document.getElementById('edit-log-jobnum');
    const credInput = document.getElementById('edit-log-credited');
    const fmInput = document.getElementById('edit-log-foreman');
    const autoLookupForeman = () => {
      const target = credInput?.value.trim() || jobInput?.value.trim();
      if (target) {
        const found = this.lookupForemanForCrew(target);
        if (found && (!fmInput.value || /^\d{3}-\d{2}/.test(fmInput.value) || fmInput.value.toLowerCase() === 'unknown')) {
          fmInput.value = found;
        }
      }
    };
    jobInput?.addEventListener('input', autoLookupForeman);
    credInput?.addEventListener('input', autoLookupForeman);
  }

  /**
   * Saves edits made to a log record, updates local DB and queues synchronization.
   */
  async saveLogEntryEdit(logId) {
    const log = (this.currentLogs || []).find(l => (l.id === logId || (l.sheetName + '_' + l.rowIndex) === logId));
    if (!log) return;

    let foreman = document.getElementById('edit-log-foreman')?.value.trim() || '';
    const jobNum = document.getElementById('edit-log-jobnum')?.value.trim() || '';
    const credited = document.getElementById('edit-log-credited')?.value.trim() || '';
    const dateStr = document.getElementById('edit-log-date')?.value.trim() || '';
    const status = document.getElementById('edit-log-status')?.value.trim() || 'Credited';
    const notes = document.getElementById('edit-log-notes')?.value.trim() || '';

    // Enforce that Foreman is ALWAYS an employee name, NEVER a job number or UNKNOWN
    if (!foreman || /^\d{3}-\d{2}/.test(foreman) || foreman.toLowerCase() === 'unknown') {
      const resolved = this.lookupForemanForCrew(credited || jobNum);
      if (resolved) {
        foreman = resolved;
      }
    }

    // Capture pre-edit values before mutating log/snapshot so we can detect diffs & un-credit prior crews
    const prevForeman = String(log.foreman || '').trim();
    const prevJob = String(log.jobNumber || '').trim();
    const prevCredited = String(log.creditedTo || '').trim();
    const prevDate = String(log.date || '').trim();
    const prevStatus = String(log.status || '').trim();
    const prevNotes = String(log.notes || '').trim();

    // Update in-memory log
    log.foreman = foreman;
    log.jobNumber = jobNum;
    log.creditedTo = credited;
    log.date = dateStr;
    log.status = status;
    log.notes = notes;

    const LOG_SHEET_SPECS = {
      'JHA Log': { tblKey: 'jha_log', dateCol: 2, dateKeys: ['Date Created', 'Work Date'], dateHeader: 'Date Created', jobCol: 3, fmCol: 4, statusCol: 8, credCol: 9, notesCol: 10 },
      'Weekly Safety Log': { tblKey: 'weekly_safety_log', dateCol: 2, dateKeys: ['Week Of'], dateHeader: 'Week Of', jobCol: 3, fmCol: 4, statusCol: 7, credCol: 8, notesCol: 9 },
      'Monthly Checklist Log': { tblKey: 'monthly_checklist_log', dateCol: 2, dateKeys: ['Report Date', 'Date Created'], dateHeader: 'Date Created', jobCol: 3, fmCol: 4, statusCol: 8, credCol: 9, notesCol: 11 }
    };
    const spec = LOG_SHEET_SPECS[log.sheetName];

    // Update local snapshot table row + rawGrid and determine sheet row index
    let targetRowIdx = log.rowIndex;
    let tblHeaders = null;
    let oldCellVals = { date: prevDate, job: prevJob, foreman: prevForeman, status: prevStatus, credited: prevCredited, notes: prevNotes };

    if (window.localDB && window.localDB.snapshot && window.localDB.snapshot.tables) {
      const snap = window.localDB.snapshot;
      const tbl = spec ? snap.tables[spec.tblKey] : null;
      if (tbl && tbl.rows) {
        tblHeaders = Array.isArray(tbl.headers) ? tbl.headers : null;
        const row = tbl.rows.find(r => (r._rowIdx && r._rowIdx === log.rowIndex) || (log.emailId && (r['Email ID'] === log.emailId || r.email_id === log.emailId)));
        if (row) {
          if (row._rowIdx > 1) targetRowIdx = row._rowIdx;
          const existingDateVal = spec.dateKeys.map(k => row[k]).find(v => v !== undefined && v !== '');
          oldCellVals = {
            date: existingDateVal !== undefined ? String(existingDateVal) : prevDate,
            job: row['Job Number'] !== undefined ? String(row['Job Number']) : prevJob,
            foreman: row['Foreman'] !== undefined ? String(row['Foreman']) : prevForeman,
            status: row['Status'] !== undefined ? String(row['Status']) : prevStatus,
            credited: row['Credited To'] !== undefined ? String(row['Credited To']) : prevCredited,
            notes: row['Notes'] !== undefined ? String(row['Notes']) : prevNotes
          };

          row['Foreman'] = foreman;
          row['Job Number'] = jobNum;
          row['Credited To'] = credited;
          row['Status'] = status;
          row['Notes'] = notes;
          if (dateStr) {
            spec.dateKeys.forEach(k => { row[k] = dateStr; });
          }

          if (Array.isArray(tbl.rawGrid) && tblHeaders && targetRowIdx > 1 && tbl.rawGrid[targetRowIdx - 1]) {
            const gRow = tbl.rawGrid[targetRowIdx - 1];
            tblHeaders.forEach((h, cIdx) => {
              if (row[h] !== undefined) gRow[cIdx] = row[h];
            });
          }
        }
      }
      if (typeof window.localDB.persistSnapshot === 'function') {
        window.localDB.persistSnapshot(snap);
      }
    }

    // Queue changed cell mutations to sync back to Google Sheets
    if (window.syncEngine && spec && targetRowIdx > 1) {
      const queueField = (defaultCol, defaultHeader, oldVal, newVal, skipIfEmpty = false) => {
        if (skipIfEmpty && !newVal) return;
        const oldStr = String(oldVal ?? '').trim();
        const newStr = String(newVal ?? '').trim();
        if (oldStr === newStr) return;

        let resolvedCol = defaultCol;
        let resolvedHeader = defaultHeader;
        if (tblHeaders) {
          const idxByHdr = tblHeaders.findIndex(h => String(h || '').trim().toLowerCase() === defaultHeader.toLowerCase());
          if (idxByHdr !== -1) {
            resolvedCol = idxByHdr + 1;
            resolvedHeader = tblHeaders[idxByHdr];
          } else if (tblHeaders[defaultCol - 1]) {
            resolvedHeader = tblHeaders[defaultCol - 1];
          }
        }
        window.syncEngine.addMutation({
          action: 'UPDATE_CELL',
          sheetName: log.sheetName,
          row: targetRowIdx,
          col: resolvedCol,
          header: resolvedHeader,
          oldValue: oldVal ?? '',
          value: newVal,
          itemIdentifier: log.emailId || ''
        });
      };

      queueField(spec.dateCol, spec.dateHeader, oldCellVals.date, dateStr, true);
      queueField(spec.jobCol, 'Job Number', oldCellVals.job, jobNum);
      queueField(spec.fmCol, 'Foreman', oldCellVals.foreman, foreman);
      queueField(spec.statusCol, 'Status', oldCellVals.status, status);
      queueField(spec.credCol, 'Credited To', oldCellVals.credited, credited);
      queueField(spec.notesCol, 'Notes', oldCellVals.notes, notes);
    }

    // Immediately reconcile Safety Compliance for both prior crew(s)/date(s) and the newly credited crew/date
    const reportType = log.type || log.sheetName;
    const newOwner = credited || jobNum;
    const orderedCrews = Array.from(new Set([...[prevCredited, prevJob].filter(c => c && c !== newOwner), newOwner].filter(Boolean)));
    const datesToReconcile = Array.from(new Set([prevDate, dateStr].filter(Boolean)));
    if (datesToReconcile.length === 0 && log.dateReceived) datesToReconcile.push(log.dateReceived);

    for (const cCrew of orderedCrews) {
      for (const cDate of datesToReconcile) {
        this.reconcileComplianceCellFromLogs(cCrew, cDate, reportType, foreman);
      }
    }

    // Close edit modal
    const editModal = document.getElementById('edit-log-entry-modal');
    if (editModal) editModal.remove();
    if (window.windowManager && typeof window.windowManager.syncBackdrop === 'function') {
      window.windowManager.syncBackdrop();
    }

    // Re-render table
    const container = document.getElementById('safety-logs-table-container');
    if (container) {
      container.innerHTML = this.renderLogsTableHtml();
      this.updateLogCountIndicator();
    }

    if (typeof window.showToast === 'function') {
      window.showToast('✅ Safety log record updated and credited!', 'success');
    }
  }

  /**
   * Deletes a safety log entry from local DB and queues a DELETE_ROW mutation to Google Sheets.
   */
  async deleteLogEntry(logId) {
    const log = (this.currentLogs || []).find(l => (l.id === logId || (l.sheetName + '_' + l.rowIndex) === logId));
    if (!log) {
      alert('Log record not found.');
      return;
    }

    const confirmDelete = confirm(`Are you sure you want to delete this log entry?\n\nType: ${log.type || log.sheetName}\nForeman: ${log.foreman || 'UNKNOWN'}\nJob: ${log.jobNumber || 'N/A'}\nDate: ${log.date || 'N/A'}\n\nThis will remove the record and queue synchronization to Google Sheets.`);
    if (!confirmDelete) return;

    // Queue mutation to sync back to Google Sheets
    if (window.syncEngine && log.sheetName && log.rowIndex > 1) {
      window.syncEngine.addMutation({
        action: 'DELETE_ROW',
        sheetName: log.sheetName,
        row: log.rowIndex
      });
    }

    // Remove from localDB snapshot
    if (window.localDB && window.localDB.snapshot && window.localDB.snapshot.tables) {
      const snap = window.localDB.snapshot;
      let tblKey = '';
      if (log.sheetName === 'JHA Log') tblKey = 'jha_log';
      else if (log.sheetName === 'Weekly Safety Log') tblKey = 'weekly_safety_log';
      else if (log.sheetName === 'Monthly Checklist Log') tblKey = 'monthly_checklist_log';

      if (tblKey && snap.tables[tblKey] && snap.tables[tblKey].rows) {
        const rows = snap.tables[tblKey].rows;
        const idx = rows.findIndex(r => (r._rowIdx === log.rowIndex) || (log.emailId && (r['Email ID'] === log.emailId || r.email_id === log.emailId)));
        if (idx !== -1) {
          rows.splice(idx, 1);
          rows.forEach((r, i) => { r._rowIdx = i + 2; });
        }
      }
      if (typeof window.localDB.persistSnapshot === 'function') {
        window.localDB.persistSnapshot(snap);
      }
    }

    // Remove from in-memory currentLogs
    const logIdx = (this.currentLogs || []).indexOf(log);
    if (logIdx !== -1) {
      this.currentLogs.splice(logIdx, 1);
    }

    // Re-render table
    const container = document.getElementById('safety-logs-table-container');
    if (container) {
      container.innerHTML = this.renderLogsTableHtml();
      this.updateLogCountIndicator();
    }
    if (typeof window.showToast === 'function') {
      window.showToast('🗑️ Safety log entry deleted.', 'info');
    }
  }

  /**
   * Fallback extractor that reads existing safety logs from localDB snapshot tables.
   */
  extractLogsFromLocalDB() {
    const snap = window.localDB ? window.localDB.getSnapshot() : null;
    if (!snap || !snap.tables) return [];
    const all = [];

    function buildLogUrl(subject, emailId, jobNum, type) {
      if (subject && String(subject).trim()) {
        return `https://mail.google.com/mail/#search/${encodeURIComponent('subject:"' + String(subject).trim() + '"')}`;
      }
      if (emailId) {
        const baseId = String(emailId).trim().split('_')[0];
        if (baseId) return `https://mail.google.com/mail/#all/${baseId}`;
      }
      if (jobNum) {
        return `https://mail.google.com/mail/#search/${encodeURIComponent(jobNum + (type ? (' ' + type) : ''))}`;
      }
      return '';
    }

    function getLogRowDateReceived(row) {
      if (!row) return '';
      const v = row['Date Received'] || row['Date Recieved'] || row['date_received'] || row['date_recieved'] ||
                row['Date_Received'] || row['Date_Recieved'] || row.dateReceived || row.dateRecieved ||
                row['Received'] || row['received'] || '';
      if (!v && v !== 0) return '';
      if (v instanceof Date) {
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        const y = v.getFullYear();
        const hr = String(v.getHours()).padStart(2, '0');
        const mn = String(v.getMinutes()).padStart(2, '0');
        return (v.getHours() !== 0 || v.getMinutes() !== 0) ? `${m}/${d}/${y} ${hr}:${mn}` : `${m}/${d}/${y}`;
      }
      return String(v).trim();
    }

    // JHA Log
    const jhaTbl = snap.tables.jha_log;
    if (jhaTbl && jhaTbl.rows) {
      [...jhaTbl.rows].reverse().forEach((r, idx) => {
        const emailId = r['Email ID'] || r.email_id || '';
        const subject = r['Email Subject'] || r.email_subject || '';
        const jobNum = r['Job Number'] || r.job_number || '';
        all.push({
          id: 'jha_' + (r._rowIdx || (idx + 1)),
          sheetName: 'JHA Log',
          type: 'JHA',
          rowIndex: r._rowIdx || (idx + 2),
          dateReceived: getLogRowDateReceived(r),
          date: r['Date Created'] || r['Date Completed'] || r['Work Date'] || r.date || '',
          jobNumber: jobNum,
          foreman: (() => {
            const rawFm = r['Foreman'] || '';
            if (!rawFm || /^\d{3}-\d{2}/.test(rawFm) || rawFm.toLowerCase() === 'unknown') {
              return this.lookupForemanForCrew(r['Credited To'] || jobNum) || rawFm;
            }
            return rawFm;
          })(),
          subject: subject,
          emailId: emailId,
          gmailUrl: buildLogUrl(subject, emailId, jobNum, 'JHA'),
          status: r['Status'] || 'Credited',
          creditedTo: r['Credited To'] || '',
          notes: r['Notes'] || ''
        });
      });
    }

    // Weekly Safety Log
    const wklyTbl = snap.tables.weekly_safety_log;
    if (wklyTbl && wklyTbl.rows) {
      [...wklyTbl.rows].reverse().forEach((r, idx) => {
        const emailId = r['Email ID'] || r.email_id || '';
        const subject = r['Email Subject'] || r.email_subject || '';
        const jobNum = r['Job Number'] || r.job_number || '';
        all.push({
          id: 'weekly_' + (r._rowIdx || (idx + 1)),
          sheetName: 'Weekly Safety Log',
          type: 'Weekly Safety Meeting',
          rowIndex: r._rowIdx || (idx + 2),
          dateReceived: getLogRowDateReceived(r),
          date: r['Week Of'] || '',
          jobNumber: jobNum,
          foreman: (() => {
            const rawFm = r['Foreman'] || '';
            if (!rawFm || /^\d{3}-\d{2}/.test(rawFm) || rawFm.toLowerCase() === 'unknown') {
              return this.lookupForemanForCrew(r['Credited To'] || jobNum) || rawFm;
            }
            return rawFm;
          })(),
          subject: subject,
          emailId: emailId,
          gmailUrl: buildLogUrl(subject, emailId, jobNum, 'Safety Meeting'),
          status: r['Status'] || 'Credited',
          creditedTo: r['Credited To'] || '',
          notes: r['Notes'] || ''
        });
      });
    }

    // Monthly Checklist Log
    const monTbl = snap.tables.monthly_checklist_log;
    if (monTbl && monTbl.rows) {
      [...monTbl.rows].reverse().forEach((r, idx) => {
        const emailId = r['Email ID'] || r.email_id || '';
        const subject = r['Email Subject'] || r.email_subject || '';
        const jobNum = r['Job Number'] || r.job_number || '';
        all.push({
          id: 'monthly_' + (r._rowIdx || (idx + 1)),
          sheetName: 'Monthly Checklist Log',
          type: 'Monthly Checklist',
          rowIndex: r._rowIdx || (idx + 2),
          dateReceived: getLogRowDateReceived(r),
          date: r['Report Date'] || r['Date Created'] || r['Date Completed'] || r['Date'] || '',
          jobNumber: jobNum,
          foreman: (() => {
            const rawFm = r['Foreman'] || '';
            if (!rawFm || /^\d{3}-\d{2}/.test(rawFm) || rawFm.toLowerCase() === 'unknown') {
              return this.lookupForemanForCrew(r['Credited To'] || jobNum) || rawFm;
            }
            return rawFm;
          })(),
          vehicleNumber: r['Vehicle Number'] || r['Equipment Number'] || '',
          subject: subject,
          emailId: emailId,
          gmailUrl: buildLogUrl(subject, emailId, jobNum, 'Safety Checklist'),
          status: r['Status'] || 'Credited',
          creditedTo: r['Credited To'] || '',
          hasEquipmentIssues: r['Has Equipment Issues'] || 'No',
          notes: r['Notes'] || ''
        });
      });
    }

    return all;
  }

  /**
   * Opens the Safety Logs viewer modal directly from the toolbar.
   */
  openSafetyLogsModal() {
    this.isProcessing = false;
    this.currentLogs = this.extractLogsFromLocalDB();
    this.activeCategoryFilter = 'all';
    this.selectedMonthFilter = 'all';
    this.activeSortOption = 'date_desc';
    this.searchQuery = '';

    const modal = document.getElementById('process-safety-emails-modal');
    const modalBox = document.getElementById('process-safety-emails-modal-box');
    const titleEl = document.getElementById('process-safety-emails-modal-title');
    const iconEl = document.getElementById('process-safety-emails-modal-icon');
    const body = document.getElementById('process-safety-emails-modal-body');
    const footer = document.getElementById('process-safety-emails-modal-footer');
    if (!modal || !body) return;

    if (modalBox) modalBox.style.maxWidth = '1120px';
    if (titleEl) titleEl.textContent = 'Safety Documentation & Complete Audit Log';
    if (iconEl) iconEl.textContent = '📋';

    modal.style.display = 'flex';

    const jhaCount = this.currentLogs.filter(l => l.type === 'JHA').length;
    const weeklyCount = this.currentLogs.filter(l => l.type === 'Weekly Safety Meeting').length;
    const monthlyCount = this.currentLogs.filter(l => l.type === 'Monthly Checklist').length;

    this.renderCompletionModalContent(body, {
      totalThreads: this.currentLogs.length,
      totalLogs: this.currentLogs.length,
      cumulativeLogs: { jha: jhaCount, weekly: weeklyCount, monthly: monthlyCount },
      totalIssues: this.currentLogs.filter(l => l.hasEquipmentIssues === 'Yes').length
    });

    if (footer) {
      footer.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <button class="btn btn-primary" id="btn-refresh-audit-logs" onclick="window.safetyComplianceEngine.fetchLatestLogsFromSheets()" style="font-size: 12px; padding: 6px 14px; background: #3b82f6; color: white;">🔄 Fetch Latest from Sheets</button>
            <button class="btn btn-secondary" id="btn-clean-dedup-logs" onclick="window.safetyComplianceEngine.cleanAndDeduplicateLogs()" style="font-size: 12px; padding: 6px 14px; background: #0f766e; border-color: #14b8a6; color: white;" title="Auto-resolve job numbers in Foreman column to real employee names and delete duplicate entries">🧹 Clean Foremen & Deduplicate</button>
          </div>
          <button class="btn btn-secondary" onclick="window.safetyComplianceEngine.closeProcessEmailsModal()">Close</button>
        </div>
      `;
    }

    // Auto-fetch newest logs in background if connected to Web App
    this.fetchLatestLogsFromSheets(true);
  }

  async fetchLatestLogsFromSheets(silent = false) {
    const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
    if (!syncUrl) return;

    const btn = document.getElementById('btn-refresh-audit-logs');
    if (btn && !silent) {
      btn.disabled = true;
      btn.innerHTML = '⏳ Fetching latest...';
    }

    try {
      const response = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', { action: 'getRecentSafetyLogs', limit: 200 }, 60000);
      const logs = (response && response.logs) || [];
      if (logs.length > 0) {
        this.mergeSafetyLogs(logs);
        this.currentLogs = this.extractLogsFromLocalDB();
        const body = document.getElementById('process-safety-emails-modal-body');
        const modal = document.getElementById('process-safety-emails-modal');
        if (body && modal && modal.style.display !== 'none') {
          const jhaCount = this.currentLogs.filter(l => l.type === 'JHA').length;
          const weeklyCount = this.currentLogs.filter(l => l.type === 'Weekly Safety Meeting').length;
          const monthlyCount = this.currentLogs.filter(l => l.type === 'Monthly Checklist').length;

          this.renderCompletionModalContent(body, {
            totalThreads: this.currentLogs.length,
            totalLogs: this.currentLogs.length,
            cumulativeLogs: { jha: jhaCount, weekly: weeklyCount, monthly: monthlyCount },
            totalIssues: this.currentLogs.filter(l => l.hasEquipmentIssues === 'Yes').length
          });
        }
      }
    } catch (e) {
      console.warn('fetchLatestLogsFromSheets warning:', e);
    } finally {
      if (btn && !silent) {
        btn.disabled = false;
        btn.innerHTML = '🔄 Fetch Latest from Sheets';
      }
    }
  }

  /**
   * Strips "No JHA <date(s)>" submission-absence clauses so EcoOnline Field iD emails
   * are used strictly for JHA Quality tracking (App Safety Compliance always wins on missing JHAs).
   */
  parseJhaFailureComments(rawComments, refDate = null) {
    const raw = String(rawComments || '').replace(/\s+/g, ' ').trim();
    if (!raw) {
      return { rawComments: '', qualityComments: '', hasQualityIssue: false, categories: [], affectedDates: [] };
    }

    let stripped = raw.replace(
      /(?:^|[\s,;.-]+)(?:no|missing)\s+jha'?s?(?:\s+(?:submitted|received|turned\s+in|on|for))?(?:\s*(?:[:\-]\s*)?(?:(?:and|&)\s+)?\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?(?:\s*(?:,|&|and|\-|to)\s*\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)*)?(?:\s*\([^)]*\))?(?=\s*(?:$|[,;.]|\b(?:no\s+(?:job|site|photo|pic|paperwork|sign|tailgate|ems)|crew|missing|incomplete|hazard|ppe|signature|sign|blank|wrong|did|not|only|need|please|identify|photo|paperwork)\b|[A-Z]))/gi,
      ' '
    );
    stripped = stripped
      .replace(/^[,;:\-\s]+/, '')
      .replace(/[,;:\-\s]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    const hasQualityIssue = stripped.length > 0;
    const categories = [];
    const addCat = (lbl) => { if (!categories.includes(lbl)) categories.push(lbl); };

    if (hasQualityIssue) {
      if (/photo|pic(?:ture)?|image/i.test(stripped)) addCat('Missing Photo');
      if (/paperwork|attach|pdf|upload|doc(?:ument)?/i.test(stripped)) addCat('Missing Paperwork');
      if (/dut(?:y|ies)|position|role|crew\s+member/i.test(stripped)) addCat('Crew Duties');
      if (/sign(?:ature|ed|ing)?|initial/i.test(stripped)) addCat('Missing Signature');
      if (/\bems\b|emergency|ph(?:one)?\s*#/i.test(stripped)) addCat('Missing EMS Info');
      if (/hazard|control|mitigat|ppe|tailgate|brief|incomplete|blank|detail|identify/i.test(stripped) && categories.length === 0) {
        addCat('Incomplete / Quality');
      }
      if (categories.length === 0) addCat('Quality Issue');
    } else {
      addCat('No JHA Only');
    }

    const affectedDates = [];
    if (hasQualityIssue) {
      const refDt = refDate instanceof Date && !isNaN(refDate.getTime()) ? refDate : new Date();
      const baseYear = refDt.getFullYear();
      const refMonth = refDt.getMonth() + 1;
      const dateRe = /\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/g;
      let dm;
      while ((dm = dateRe.exec(stripped)) !== null) {
        const mm = parseInt(dm[1], 10);
        const dd = parseInt(dm[2], 10);
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
        let yy = baseYear;
        if (dm[3]) {
          yy = parseInt(dm[3], 10);
          if (yy < 100) yy += 2000;
        } else {
          if (refMonth === 1 && mm === 12) yy = baseYear - 1;
          else if (refMonth === 12 && mm === 1) yy = baseYear + 1;
        }
        const fmt = `${String(mm).padStart(2, '0')}/${String(dd).padStart(2, '0')}/${yy}`;
        if (!affectedDates.includes(fmt)) affectedDates.push(fmt);
      }
    }

    return { rawComments: raw, qualityComments: stripped, hasQualityIssue, categories, affectedDates };
  }

  /**
   * Normalizes a JHA Failures sheet row into a canonical Quality Fail object.
   * Returns null if the row has no quality defect (e.g. "No JHA <date>" only).
   */
  _normalizeJhaFailureRow(row) {
    if (!row) return null;
    const rawJob = String(row['Job #'] || row['Job Number'] || '').trim();
    const jobMatch = rawJob.match(/^(\d{2,4}-\d{2})/);
    const baseJob = jobMatch ? jobMatch[1] : rawJob.replace(/\s*\([^)]*\)/g, '').replace(/\.\d+.*$/, '').trim();
    if (!baseJob) return null;

    const weekDt = this.parseDate(row['Week Start'] || row['Week'] || '');
    const dueDt = this.parseDate(row['Due Date'] || '') || weekDt;
    if (!weekDt && !dueDt) return null;

    const sundayDt = weekDt
      ? new Date(weekDt.getFullYear(), weekDt.getMonth(), weekDt.getDate() - weekDt.getDay(), 12, 0, 0)
      : new Date(dueDt.getFullYear(), dueDt.getMonth(), dueDt.getDate() - dueDt.getDay(), 12, 0, 0);
    const weekKey = `${String(sundayDt.getMonth() + 1).padStart(2, '0')}/${String(sundayDt.getDate()).padStart(2, '0')}/${sundayDt.getFullYear()}`;

    const rawComments = String(row['Raw Comments'] || row['Comments'] || '').trim();
    const parsed = this.parseJhaFailureComments(rawComments || row['Quality Comments'] || '', dueDt || sundayDt);
    const sheetFlag = String(row['Has Quality Issue'] || '').trim().toLowerCase();
    // Always re-verify via stripped qualityComments so "No JHA"-only rows never leak into quality counts
    const qualityComments = parsed.qualityComments;
    const hasQualityIssue = Boolean(qualityComments) && sheetFlag !== 'no' && sheetFlag !== 'false';
    if (!hasQualityIssue) return null;

    const rawCats = String(row['Failure Categories'] || '').trim();
    const categories = (parsed.categories && parsed.categories.length > 0 && parsed.categories[0] !== 'No JHA Only')
      ? parsed.categories
      : (rawCats && rawCats.toLowerCase() !== 'no jha only'
          ? rawCats.split(',').map(s => s.trim()).filter(Boolean)
          : ['Quality Issue']);

    const affectedDates = parsed.affectedDates.length > 0
      ? parsed.affectedDates
      : String(row['Affected Dates'] || '').split(',').map(s => s.trim()).filter(Boolean);

    const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const affectedDayKeys = new Set();
    affectedDates.forEach(ds => {
      const dt = this.parseDate(ds);
      if (dt) {
        const diff = Math.round((dt.getTime() - sundayDt.getTime()) / 86400000);
        if (diff >= 0 && diff <= 6) {
          affectedDayKeys.add(DAY_KEYS[dt.getDay()]);
        }
      }
    });

    return {
      weekStart: weekKey,
      weekStartDate: sundayDt,
      dueDate: String(row['Due Date'] || '').trim(),
      jobNumber: baseJob,
      jobName: String(row['Job Name'] || '').trim(),
      foreman: String(row['Foreman'] || '').trim(),
      location: String(row['Location'] || '').trim(),
      rawComments,
      qualityComments,
      hasQualityIssue: true,
      categories,
      affectedDates,
      affectedDayKeys,
      ecoLink: String(row['EcoOnline Link'] || '').trim(),
      emailDate: String(row['Email Date'] || '').trim(),
      emailId: String(row['Email ID'] || '').trim()
    };
  }

  /**
   * Resolves a base job number against a weekly JHA Fails Map, with safe FY-adjacent fallback
   * (e.g. Safety Compliance lists 036-26 while EcoOnline lists 036-27, or 010-27 vs 010-26 on FY rollover).
   * Only uses a sibling when that sibling is not already its own active crew in the week.
   */
  findQualityJhaFailInMap(weekMap, jobNum, activeBaseJobsInWeek = null) {
    if (!weekMap || weekMap.size === 0) return null;
    const rawJob = String(jobNum || '').trim();
    const jm = rawJob.match(/^(\d{2,4}-\d{2})/);
    const baseJob = jm ? jm[1] : rawJob.replace(/\s*\([^)]*\)/g, '').replace(/\.\d+.*$/, '').trim();
    if (!baseJob) return null;
    if (weekMap.has(baseJob)) return weekMap.get(baseJob);

    const parts = baseJob.match(/^(\d{2,4})-(\d{2})$/);
    if (parts) {
      const prefix = parts[1];
      const yy = parseInt(parts[2], 10);
      const candidates = [
        `${prefix}-${String(yy + 1).padStart(2, '0')}`,
        `${prefix}-${String(Math.max(0, yy - 1)).padStart(2, '0')}`
      ];
      for (const sib of candidates) {
        if (weekMap.has(sib) && (!activeBaseJobsInWeek || !activeBaseJobsInWeek.has(sib))) {
          return weekMap.get(sib);
        }
      }
    }
    return null;
  }

  /**
   * Returns Map(baseJob -> normalized Quality JHA Fail) for the specified Safety Compliance week.
   */
  getQualityJhaFailsForWeek(weekVal) {
    const map = new Map();
    const targetDt = this.parseDate(weekVal);
    if (!targetDt) return map;
    const targetSun = new Date(targetDt.getFullYear(), targetDt.getMonth(), targetDt.getDate() - targetDt.getDay(), 12, 0, 0);
    const targetKey = `${String(targetSun.getMonth() + 1).padStart(2, '0')}/${String(targetSun.getDate()).padStart(2, '0')}/${targetSun.getFullYear()}`;

    const snap = (this.db && typeof this.db.getSnapshot === 'function') ? this.db.getSnapshot() : (this.db ? this.db.snapshot : null);
    const tbl = (snap && snap.tables && (snap.tables['jha_failures'] || snap.tables['JHA Failures'])) || (this.db && typeof this.db.getTable === 'function' ? this.db.getTable('jha_failures') : null);
    if (!tbl || !Array.isArray(tbl.rows)) return map;

    tbl.rows.forEach(r => {
      const item = this._normalizeJhaFailureRow(r);
      if (!item || item.weekStart !== targetKey) return;
      if (!map.has(item.jobNumber)) {
        map.set(item.jobNumber, item);
      }
    });
    return map;
  }

  /**
   * Looks up a single crew's Quality JHA Fail for a given job number & week start.
   */
  getQualityJhaFailForCrewWeek(jobNum, weekVal) {
    const weekMap = this.getQualityJhaFailsForWeek(weekVal);
    if (weekMap.size === 0) return null;
    // Build active jobs set for the week so FY-sibling fallback never steals another active crew's fail
    let activeJobs = null;
    const scTbl = (this.db && typeof this.db.getTable === 'function') ? this.db.getTable('safety_compliance') : null;
    const targetDt = this.parseDate(weekVal);
    if (scTbl && Array.isArray(scTbl.rows) && targetDt) {
      const targetSun = new Date(targetDt.getFullYear(), targetDt.getMonth(), targetDt.getDate() - targetDt.getDay(), 12, 0, 0);
      const targetKey = `${String(targetSun.getMonth() + 1).padStart(2, '0')}/${String(targetSun.getDate()).padStart(2, '0')}/${targetSun.getFullYear()}`;
      activeJobs = new Set();
      scTbl.rows.forEach(r => {
        const rd = this.parseDate(r['Week Start'] || r['Week'] || '');
        if (!rd) return;
        const rSun = new Date(rd.getFullYear(), rd.getMonth(), rd.getDate() - rd.getDay(), 12, 0, 0);
        const rKey = `${String(rSun.getMonth() + 1).padStart(2, '0')}/${String(rSun.getDate()).padStart(2, '0')}/${rSun.getFullYear()}`;
        if (rKey !== targetKey) return;
        const rawJn = String(r['Job Number'] || r['Job #'] || r['Crew'] || '').trim();
        const jm = rawJn.match(/^(\d{2,4}-\d{2})/);
        const bj = jm ? jm[1] : rawJn.replace(/\s*\([^)]*\)/g, '').replace(/\.\d+.*$/, '').trim();
        if (bj) activeJobs.add(bj);
      });
    }
    return this.findQualityJhaFailInMap(weekMap, jobNum, activeJobs);
  }

  /**
   * Scans Gmail for EcoOnline Field iD "JHA Completed w Failure Last Week" emails via Apps Script,
   * updates localDB.tables.jha_failures safely in-place (without overwriting concurrent edits),
   * and refreshes Safety Compliance & Foreman Report Cards.
   */
  async scanJhaFailureEmails({ daysBack = 30, allHistory = false, rescan = false, silent = false, _depth = 0 } = {}) {
    if (this._isScanningJhaFailures && _depth === 0) {
      if (!silent && typeof window.showToast === 'function') {
        window.showToast('⏳ JHA Fails scan is already running in the background…', 'info');
      }
      return { success: false, skipped: true };
    }
    if (window.currentRoleMode === 'view_only') return { success: false, error: 'View only mode' };

    const syncUrl = window.syncEngine ? window.syncEngine.getSyncUrl() : '';
    if (!syncUrl) {
      if (!silent && typeof window.showToast === 'function') {
        window.showToast('⚠️ Configure Sync URL in Settings before scanning Gmail.', 'warning');
      }
      return { success: false, error: 'No Sync URL configured' };
    }

    // Automatically run full historical backfill the first time JHA Failures is empty
    const preSnap = (this.db && typeof this.db.getSnapshot === 'function') ? this.db.getSnapshot() : (this.db ? this.db.snapshot : null);
    const existingTbl = preSnap && preSnap.tables ? preSnap.tables['jha_failures'] : null;
    const isFirstBackfill = !existingTbl || !Array.isArray(existingTbl.rows) || existingTbl.rows.length === 0;
    const effectiveAllHistory = Boolean(allHistory || rescan || isFirstBackfill);

    // Always reflect active scan state on the toolbar button (even during startup background scan)
    const btn = document.getElementById('btn-scan-jha-failures');
    if (btn && _depth === 0) {
      if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = effectiveAllHistory ? '⏳ Backfilling JHA Fails…' : '⏳ Scanning JHA Fails…';
    }

    this._isScanningJhaFailures = true;
    // Update Safety Compliance filter chip to indicate an active scan if currently visible with 0 loaded
    if (_depth === 0 && isFirstBackfill && window.sheetNavigator && typeof window.sheetNavigator.renderSafetyCompliance === 'function') {
      const scView = document.getElementById('safety-compliance-view');
      if (scView && scView.classList.contains('active')) {
        window.sheetNavigator.renderSafetyCompliance();
      }
    }

    try {
      const response = await window.syncEngine.executeNetworkRequest(syncUrl, 'POST', {
        action: 'scanJhaFailureEmails',
        daysBack,
        allHistory: effectiveAllHistory,
        rescan: Boolean(rescan && _depth === 0)
      }, 90000);

      if (response && response.success) {
        // Grab the CURRENT snapshot after the async call so we never clobber concurrent edits/scans
        const liveSnap = (this.db && typeof this.db.getSnapshot === 'function') ? this.db.getSnapshot() : (this.db ? this.db.snapshot : null);
        if (response.table && liveSnap) {
          if (!liveSnap.tables) liveSnap.tables = {};
          liveSnap.tables['jha_failures'] = response.table;
          if (typeof this.db.markTableDirty === 'function') {
            this.db.markTableDirty('jha_failures');
          }
          if (typeof this.db._invalidateIndices === 'function') {
            this.db._invalidateIndices();
          }
          if (typeof this.db.persistSnapshot === 'function') {
            await this.db.persistSnapshot(liveSnap);
          }
          if (typeof this.db.notify === 'function') {
            this.db.notify();
          }
        }

        // Auto-continue if Apps Script hit its 22s circuit breaker during initial historical backfill
        if (response.hasMore && (response.newCount || 0) > 0 && _depth < 3) {
          if (window.sheetNavigator && typeof window.sheetNavigator.renderSafetyCompliance === 'function') {
            window.sheetNavigator.renderSafetyCompliance();
          }
          return await this.scanJhaFailureEmails({
            daysBack,
            allHistory: true,
            rescan: false,
            silent,
            _depth: _depth + 1
          });
        }

        if (window.sheetNavigator && typeof window.sheetNavigator.renderSafetyCompliance === 'function') {
          window.sheetNavigator.renderSafetyCompliance();
        }
        if (window.foremanReportCardEngine) {
          window.foremanReportCardEngine.cachedModel = null;
          if (window.foremanReportCardEngine.isWorkspaceVisible && window.foremanReportCardEngine.isWorkspaceVisible()) {
            window.foremanReportCardEngine.renderWorkspace({ preservePage: true });
          }
        }

        const newCount = response.newCount || 0;
        const qualCount = response.qualityCount || 0;
        if ((!silent || newCount > 0) && typeof window.showToast === 'function') {
          if (newCount > 0) {
            window.showToast(`⚠️ JHA Fails synced: ${newCount} new row${newCount === 1 ? '' : 's'} (${qualCount} quality fail${qualCount === 1 ? '' : 's'})`, 'success');
          } else if (!silent) {
            window.showToast(`✅ JHA Fails up to date (${response.totalInSheet || 0} logged)`, 'info');
          }
        }
        return response;
      }

      if (!silent && typeof window.showToast === 'function') {
        window.showToast(`⚠️ JHA Fails scan failed: ${(response && response.error) || 'Unknown error'}`, 'error');
      }
      return response || { success: false };
    } catch (err) {
      console.warn('[JHA Failures Scan] Error:', err);
      if (!silent && typeof window.showToast === 'function') {
        window.showToast(`⚠️ JHA Fails scan error: ${err.message}`, 'error');
      }
      return { success: false, error: err.message };
    } finally {
      if (_depth === 0) {
        this._isScanningJhaFailures = false;
        const curBtn = document.getElementById('btn-scan-jha-failures');
        if (curBtn) {
          curBtn.disabled = false;
          curBtn.innerHTML = curBtn.dataset.origHtml || '<span>⚠️</span> JHA Fails';
        }
        if (window.sheetNavigator && typeof window.sheetNavigator.renderSafetyCompliance === 'function') {
          const scView = document.getElementById('safety-compliance-view');
          if (scView && scView.classList.contains('active')) {
            window.sheetNavigator.renderSafetyCompliance();
          }
        }
      }
    }
  }

  escapeHtml(str) {
    if (!str && str !== 0) return '';
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
      .replace(/"/g, '&quot;');
  }
}

// Attach globally
window.SafetyEmailsEngine = SafetyEmailsEngine;
if (window.safetyComplianceEngine) {
  window.safetyEmailsEngine = window.safetyComplianceEngine;
}
