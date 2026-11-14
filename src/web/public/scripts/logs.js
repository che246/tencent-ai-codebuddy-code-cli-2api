// ─── 日志数据库检索与实时日志看板 ─────────────────────────────────────────
    function getTodayDateStr() {
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    let currentLogDate = getTodayDateStr(); // 默认展示单天 (当天)

    async function loadLogDates() {
      try {
        const res = await fetch('/api/logs/dates');
        const data = await res.json();
        const sel = document.getElementById('logDateFilter');
        const todayStr = getTodayDateStr();
        if (sel && Array.isArray(data.dates)) {
          const datesList = [...data.dates];
          if (!datesList.includes(todayStr)) {
            datesList.unshift(todayStr);
          }

          // 默认单天模式：优先选中当天；若当天暂无日志且历史列表有数据，则选中最近有日志的单天
          if (!currentLogDate || currentLogDate === 'ALL' || (!data.dates.includes(currentLogDate) && currentLogDate === todayStr && data.dates.length > 0)) {
            currentLogDate = data.dates.includes(todayStr) ? todayStr : (data.dates[0] || todayStr);
          }

          const options = datesList.map(d => {
            const isToday = d === todayStr;
            const label = isToday ? `📅 今天 (${d})` : `📅 ${d}`;
            return `<option value="${d}" ${d === currentLogDate ? 'selected' : ''}>${label}</option>`;
          });
          options.push(`<option value="ALL" ${currentLogDate === 'ALL' ? 'selected' : ''}>📅 所有历史日期</option>`);
          sel.innerHTML = options.join('');
          sel.value = currentLogDate;
        }
      } catch (_) {}
    }

    function onLogDateChange() {
      const sel = document.getElementById('logDateFilter');
      if (sel) currentLogDate = sel.value;
      fetchLogs();
    }

    async function fetchLogs() {
      try {
        const sel = document.getElementById('logDateFilter');
        const dateVal = sel ? sel.value : currentLogDate;
        currentLogDate = dateVal;

        // 默认获取单天最新的 200 条记录
        let queryUrl = '/api/logs?limit=200';
        if (dateVal && dateVal !== 'ALL') {
          queryUrl += '&date=' + encodeURIComponent(dateVal);
        }
        if (logCatFilter && logCatFilter !== 'ALL') {
          queryUrl += '&category=' + encodeURIComponent(logCatFilter);
        }
        if (logLevelFilter && logLevelFilter !== 'ALL') {
          queryUrl += '&level=' + encodeURIComponent(logLevelFilter);
        }

        const res = await fetch(queryUrl);
        const data = await res.json();
        allLogs = data.logs || [];
        const badge = document.getElementById('logCountBadge');
        if (badge) {
          const isSingle = Boolean(dateVal && dateVal !== 'ALL');
          const dayTitle = isSingle ? `${dateVal} 单天` : '全量历史';
          badge.innerText = `${dayTitle} · 最新 ${allLogs.length} 条 (共 ${data.total || allLogs.length} 条)`;
        }
        renderLogs();
      } catch (_) {}
    }

    function renderLogs() {
      const query = document.getElementById('logSearch').value.toLowerCase().trim();
      const logBox = document.getElementById('logBox');

      const filtered = allLogs.filter(item => {
        if (logCatFilter !== 'ALL' && item.category !== logCatFilter) return false;
        if (logLevelFilter !== 'ALL' && item.level !== logLevelFilter) return false;
        if (query) {
          const str = (item.time + item.level + item.category + item.message + JSON.stringify(item.meta || '')).toLowerCase();
          return str.includes(query);
        }
        return true;
      });

      if (filtered.length === 0) {
        logBox.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:30px;">暂无符合条件的日志记录</div>';
        return;
      }

      logBox.innerHTML = filtered.map(item => {
        const badgeClass = item.level === 'ERROR' ? 'log-badge-error' : item.level === 'WARN' ? 'log-badge-warn' : 'log-badge-info';
        
        let hasContext = false;
        let displayMeta = item.meta;
        let contextData = null;
        if (item.meta && typeof item.meta === 'object') {
          if (item.meta.context) {
            hasContext = true;
            contextData = item.meta.context;
            displayMeta = { ...item.meta };
            delete displayMeta.context;
          }
        }

        const metaHtml = (displayMeta && Object.keys(displayMeta).length > 0)
          ? `<span class="log-meta">${escapeHtml(JSON.stringify(displayMeta))}</span>`
          : '';
        const timeDisplay = currentLogDate === 'ALL' ? item.time : item.time.slice(11);
        const catClass = `log-cat log-cat-${(item.category || '').toLowerCase()}`;
        let msgHtml = escapeHtml(item.message);
        if (item.category === 'CREDIT_MONITOR') {
          msgHtml = msgHtml.replace(/积分变动:\s*(\+[0-9.]+)/, '积分变动: <span style="color:#34d399; font-weight:bold;">$1</span>')
                           .replace(/积分变动:\s*(\-[0-9.]+)/, '积分变动: <span style="color:#f87171; font-weight:bold;">$1</span>');
        }

        const contextBadge = hasContext
          ? `<span class="badge badge-purple" style="font-size:10px; padding:1px 6px; margin-left:6px; cursor:pointer;" onclick="event.stopPropagation(); toggleLogContext('${item.id}')">🔍 查看请求上下文</span>`
          : '';

        const contextBox = hasContext ? `
          <div id="ctx-box-${item.id}" class="log-context-box" style="display:none; width:100%; margin:4px 0 8px 0; padding:10px 14px; background:rgba(0,0,0,0.5); border-radius:6px; border:1px solid rgba(168,85,247,0.35); font-family:monospace; font-size:11.5px; white-space:pre-wrap; max-height:360px; overflow-y:auto; color:var(--text-main);">
            <div style="font-weight:bold; color:#c084fc; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
              <span>📝 本轮请求上下文 (system / messages 原文)</span>
              <button class="btn-outline" style="padding:2px 8px; font-size:11px;" onclick="event.stopPropagation(); copyLogContext('${item.id}')">📋 复制原文</button>
            </div>
            <pre style="margin:0; font-family:inherit; white-space:pre-wrap; word-break:break-all;">${escapeHtml(JSON.stringify(contextData, null, 2))}</pre>
          </div>
        ` : '';

        const rowClick = hasContext ? `onclick="toggleLogContext('${item.id}')" style="cursor:pointer;" title="点击展开/收起请求上下文"` : '';

        return `
          <div style="display:flex; flex-direction:column; border-bottom:1px solid rgba(255,255,255,0.03);">
            <div class="log-row" style="border-bottom:none;" ${rowClick}>
              <span class="log-time" title="${item.time}">${timeDisplay}</span>
              <span class="${badgeClass}">${item.level}</span>
              <span class="${catClass}">[${item.category}]</span>
              <span class="log-msg">${msgHtml}${metaHtml}${contextBadge}</span>
            </div>
            ${contextBox}
          </div>
        `;
      }).join('');

      if (autoScrollEnabled) {
        logBox.scrollTop = 0;
      }
    }

    function toggleLogContext(id) {
      const el = document.getElementById('ctx-box-' + id);
      if (el) {
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
      }
    }

    function copyLogContext(id) {
      const item = allLogs.find(l => String(l.id) === String(id));
      if (item && item.meta && item.meta.context) {
        copyToClipboard(JSON.stringify(item.meta.context, null, 2), '已复制请求上下文 JSON 到剪贴板！');
      }
    }

    function setLogCategory(cat, el) {
      logCatFilter = cat;
      el.parentElement.querySelectorAll('.filter-btn').forEach(b => {
        if (b.getAttribute('onclick')?.includes('setLogCategory')) {
          b.classList.remove('active');
        }
      });
      el.classList.add('active');
      fetchLogs();
    }

    function setLogLevel(lvl, el) {
      logLevelFilter = lvl;
      el.parentElement.querySelectorAll('.filter-btn').forEach(b => {
        if (b.getAttribute('onclick')?.includes('setLogLevel')) {
          b.classList.remove('active');
        }
      });
      el.classList.add('active');
      fetchLogs();
    }

    function filterLogs() {
      renderLogs();
    }


    async function clearLiveLogs() {
      await fetch('/api/logs/clear', { method: 'POST' });
      allLogs = [];
      renderLogs();
    }

    async function refreshTokenSingle(uid) {
      if (!confirm('确定向官方发起新令牌换发吗？系统将使用当前账号的 refreshToken 换领全新的 accessToken')) return;
      try {
        const res = await fetch('/api/accounts/refresh-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid })
        });
        const data = await res.json();
        if (data.ok) {
          alert('✅ ' + (data.msg || '新令牌换发成功！'));
          loadAccounts();
          fetchLogs();
        } else {
          alert('❌ 令牌换发失败: ' + (data.msg || '未知错误'));
        }
      } catch (e) {
        alert('网络异常: ' + e.message);
      }
    }

    function exportLogFile() {
      const token = localStorage.getItem('cb_web_token') || '';
      let url = '/api/logs/export?token=' + encodeURIComponent(token);
      if (currentLogDate && currentLogDate !== 'ALL') {
        url += '&date=' + encodeURIComponent(currentLogDate);
      }
      window.open(url, '_blank');
    }

// ─── 日志容量裁剪 ─────────────────────────────────────────────────────────
    function openLogsPruneModal() {
      document.getElementById('logsPruneModal').style.display = 'flex';
    }

    function closeLogsPruneModal() {
      document.getElementById('logsPruneModal').style.display = 'none';
    }

    async function executeLogsPrune() {
      const opt = document.querySelector('input[name="logsPruneOpt"]:checked')?.value || 'today_only';
      const keepDays = parseInt(document.getElementById('inputLogsKeepDays').value, 10) || 1;
      const confirmMsg = opt === 'all'
        ? '确定一键清空全部运行日志吗？此操作将清空 logs.db 数据库、日志文件并重置！'
        : (opt === 'today_only' ? '确定仅保留今天的运行日志，清理今天之前的所有历史日志吗？' : `确定仅保留最近 ${keepDays} 天的运行日志，清理更早之前的记录吗？`);
      if (!confirm(confirmMsg)) return;

      try {
        const res = await fetch('/api/logs/prune', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: opt, keepDays })
        });
        const d = await res.json();
        if (d.ok) {
          alert(`✅ 日志清理成功！已从数据库删除 ${d.deletedRows} 条历史日志，并执行 VACUUM 释放物理磁盘。`);
          closeLogsPruneModal();
          await loadLogDates();
          fetchLogs();
        } else {
          alert('清理失败: ' + (d.error || '未知错误'));
        }
      } catch (e) {
        alert('网络异常: ' + e.message);
      }
    }

