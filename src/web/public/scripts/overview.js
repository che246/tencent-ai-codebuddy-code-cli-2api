// ─── 概览与看板指标 ───────────────────────────────────────────────────────
    function switchMetricsRange(range, el) {
      currentMetricsRange = range;
      document.querySelectorAll('#metricsRangeTabs .filter-btn').forEach(b => b.classList.remove('active'));
      if (el) el.classList.add('active');
      loadMetrics(range);
    }

    // ─── 报表统计加载引擎 (对齐 Agent2API 架构，支持 今日/昨日/7天/30天/全部 筛选) ─────────
    async function loadMetrics(range = currentMetricsRange) {
      try {
        currentMetricsRange = range;
        const res = await fetch('/api/metrics?range=' + encodeURIComponent(range));
        const m = await res.json();
        
        // 0. 更新区间状态徽章
        const badge = document.getElementById('badgeMetricsRange');
        if (badge) {
          badge.innerText = m.rangeLabel ? `${m.rangeLabel}区间` : '全部区间';
        }

        // 0.5. 更新当前使用账号状态展示 (当前使用账号 · 备注 · 积分 · 调度模式)
        const ca = m.currentAccount || {};
        const nameEl = document.getElementById('repCurrentAccountName');
        const badgeEl = document.getElementById('repCurrentAccountBadge');
        const pillEl = document.getElementById('badgeCurrentAccountPill');
        const subEl = document.getElementById('repCurrentAccountSub');
        const credEl = document.getElementById('repCurrentAccountCredits');
        const infEl = document.getElementById('repCurrentAccountInFlight');
        const stratEl = document.getElementById('repRoutingModeLabel');

        if (ca.hasAccount) {
          const titleTxt = ca.displayName || (ca.note ? `${ca.name} [${ca.note}]` : ca.name);
          if (nameEl) nameEl.innerText = titleTxt;

          if (ca.pinnedRestricted) {
            if (pillEl) pillEl.innerText = `👤 当前账号: ${titleTxt} (指定受限·已切回轮换)`;
            if (badgeEl) {
              badgeEl.className = 'badge badge-cool';
              badgeEl.innerText = '⚠️ 指定受限 · 已切回池轮换';
            }
            if (subEl) {
              subEl.innerText = `全局指定账号 [${ca.pinnedAccountName}] 遇到限制 (${ca.restrictedReason})，已自动切换回账号池动态轮换服务`;
            }
          } else {
            if (pillEl) pillEl.innerText = `👤 当前账号: ${titleTxt}`;
            if (badgeEl) {
              badgeEl.className = 'badge ' + (ca.isPinned ? 'badge-purple' : 'badge-ok');
              badgeEl.innerText = ca.isPinned ? '⭐ 全局指定' : '🔄 池动态轮换';
            }
            if (subEl) {
              subEl.innerText = `UID: ${ca.uid} · ${ca.modeLabel}`;
            }
          }

          if (credEl) credEl.innerText = Number(ca.creditsRemain || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
          if (infEl) infEl.innerText = `${ca.inFlight || 0} 并发`;
          if (stratEl) {
            stratEl.innerText = (ca.isPinned && !ca.pinnedRestricted) ? '优先指定' : (ca.strategy === 'round-robin' ? '严格轮询' : ca.strategy === 'credits' ? '最多积分' : '最小并发削峰');
          }
        } else {
          if (nameEl) nameEl.innerText = '暂无可用账号';
          if (pillEl) pillEl.innerText = '👤 暂无账号';
          if (badgeEl) {
            badgeEl.className = 'badge badge-err';
            badgeEl.innerText = '未配置';
          }
        }

        // 1. 统计概览 7 卡片 (缓存命中率成为主指标，官网折算价降为辅助信息)
        document.getElementById('repTotalTokens').innerText = m.totalTokensDisplay || '0';
        document.getElementById('repTokensSplit').innerText = `${m.inputTokensDisplay || '0'} + ${m.outputTokensDisplay || '0'}`;
        if (document.getElementById('repHitRate')) {
          document.getElementById('repHitRate').innerText = m.overallCacheHitRate || '0.0%';
        }
        if (document.getElementById('repCachedTokens')) {
          document.getElementById('repCachedTokens').innerText = m.cachedTokensDisplay || '0';
        }
        // 命中率进度条：把百分比数字直接映射为宽度（0~100）
        if (document.getElementById('repHitRateBar')) {
          const rateNum = parseFloat(String(m.overallCacheHitRate || '0').replace('%', '')) || 0;
          document.getElementById('repHitRateBar').style.width = Math.max(0, Math.min(100, rateNum)) + '%';
        }
        if (document.getElementById('repSavedCost')) {
          document.getElementById('repSavedCost').innerText = m.totalSavedCostDisplay || '¥0.00';
        }
        if (document.getElementById('repCachedCost')) {
          document.getElementById('repCachedCost').innerText = m.totalCachedCostDisplay || '¥0.00';
        }
        document.getElementById('repSuccessReq').innerText = (m.successRequests || 0).toLocaleString();
        document.getElementById('repSuccessRate').innerText = m.successRate || '100%';
        document.getElementById('repTotalReq').innerText = (m.totalRequests || 0).toLocaleString();
        document.getElementById('repTodayReq').innerText = (m.todayRequests || 0).toLocaleString();
        document.getElementById('repActiveDays').innerText = m.activeDays || (m.totalRequests > 0 ? 1 : 0);
        document.getElementById('repTotalDays').innerText = m.totalDaysRange || 1;
        document.getElementById('repConsecutiveDays').innerText = m.consecutiveDays || 0;
        document.getElementById('repTopModel').innerText = m.topModel?.id || '-';
        document.getElementById('repTopModelTokens').innerText = m.topModel?.tokensDisplay || '0';
        document.getElementById('repTopModelPercent').innerText = m.topModel?.percentage || '100%';

        // 2. 模型排行分布 (Top Models，展示各模型用量、缓存命中与按官网价格折算的大概价钱)
        const modelRankBox = document.getElementById('modelRankList');
        if (Array.isArray(m.modelsList) && m.modelsList.length > 0) {
          const colors = ['#f43f5e', '#38bdf8', '#c084fc', '#facc15', '#4ade80', '#fb923c'];
          modelRankBox.innerHTML = m.modelsList.map((item, idx) => {
            const color = colors[idx % colors.length];
            const costHtml = item.costDisplay
              ? `<span style="color:#22c55e; font-family:monospace; font-weight:700; font-size:12px; cursor:help;" title="${escapeAttr(item.priceVendor || '官网')}: ${escapeAttr(item.priceNote || '')}">约 ${item.costDisplay}</span>`
              : '';
            const cacheHtml = item.cachedTokens > 0
              ? `<span style="color:#38bdf8; font-size:11px;" title="命中缓存: ${item.cachedTokensDisplay} tokens">⚡ 缓存 ${item.cacheHitRate}</span>`
              : '';
            return `
              <div class="rank-row" title="模型: ${escapeAttr(item.name)}&#10;消耗: ${item.totalTokensDisplay} tokens&#10;缓存命中: ${item.cachedTokensDisplay || '0'} tokens (${item.cacheHitRate || '0.0%'})&#10;官网折算价钱: ${item.costDisplay || '¥0.00'}&#10;定价依据: ${escapeAttr(item.priceVendor || '')} - ${escapeAttr(item.priceNote || '')}">
                <span class="rank-name" title="${item.name}">${item.name}</span>
                <div class="rank-track">
                  <div class="rank-fill" style="width: ${item.percentNum}%; background: ${color};"></div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <span class="rank-val" style="color:var(--text-main); font-size:12px;">${item.totalTokensDisplay}</span>
                  ${cacheHtml}
                  ${costHtml}
                </div>
                <span class="rank-pct">${item.percentage}</span>
              </div>
            `;
          }).join('');
        } else {
          modelRankBox.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:15px;">该区间暂无模型调用数据</div>';
        }

        // 3. 每日历史趋势 (Daily Trend Table - 全部完整显示，包含每日折算价钱与缓存命中)
        const dailyBody = document.getElementById('dailyTrendBody');
        const badgeTrend = document.getElementById('badgeDailyTrendTotal');
        if (badgeTrend && Array.isArray(m.dailyTrend)) {
          badgeTrend.innerText = `全量共 ${m.dailyTrend.length} 天记录`;
        }

        if (Array.isArray(m.dailyTrend) && m.dailyTrend.length > 0) {
          dailyBody.innerHTML = m.dailyTrend.map(d => {
            const dateBadge = d.isToday
              ? '<span class="badge badge-ok" style="font-size:10px; padding:1px 5px; margin-left:6px;">今天</span>'
              : (d.isYesterday ? '<span class="badge badge-purple" style="font-size:10px; padding:1px 5px; margin-left:6px;">昨天</span>' : '');

            const failDisplay = d.failedRequests > 0
              ? `<span style="color:#f87171; font-weight:600;">${d.failedRequests}</span>`
              : `<span style="color:var(--text-muted);">0</span>`;

            const topModelHtml = d.topModel && d.topModel !== '-'
              ? `<span class="badge badge-blue" style="font-family:monospace; font-size:11px;">${escapeHtml(d.topModel)}</span>`
              : `<span style="color:var(--text-muted);">-</span>`;

            const cacheCell = (d.cachedTokens || 0) > 0
              ? `<span style="color:#38bdf8; font-family:monospace; font-weight:700;">${d.cachedTokensDisplay}</span> <span style="font-size:10px; color:#4ade80;">(${d.cacheHitRate || '0.0%'})</span>`
              : `<span style="color:var(--text-muted); font-family:monospace;">0</span> <span style="font-size:10px; color:var(--text-muted);">(0.0%)</span>`;

            return `
              <tr>
                <td><code>${d.date}</code>${dateBadge}</td>
                <td><b>${(d.requests || 0).toLocaleString()} 次</b></td>
                <td><span style="color:#4ade80; font-weight:600;">${(d.successRequests || 0).toLocaleString()}</span> / ${failDisplay}</td>
                <td><span style="color:#4ade80; font-weight:600;">${d.successRate || '100%'}</span></td>
                <td>${topModelHtml}</td>
                <td style="color:var(--text-muted); font-family:monospace;">${d.inputTokensDisplay}</td>
                <td style="color:var(--text-muted); font-family:monospace;">${d.outputTokensDisplay}</td>
                <td>${cacheCell}</td>
                <td><b style="color:var(--accent); font-family:monospace; font-size:13px;">${d.totalTokensDisplay}</b></td>
                <td><b style="color:#22c55e; font-family:monospace; font-size:12px;">${d.totalCostDisplay || '¥0.00'}</b></td>
              </tr>
            `;
          }).join('');
        } else {
          dailyBody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:20px;">暂无历史趋势记录</td></tr>';
        }

      } catch (err) {
        console.error('loadMetrics error:', err);
      }
    }

    // ─── 积分刷新状态 ─────────────────────────────────────────────────────
    // forceNext: 下一次 loadAccounts 是否带 ?refresh=1（用户手动点刷新 / 切页触发）
    let creditsForceNext = false;
    // 页面级别的「最后进入时间」，用于切页判断是否值得向上游拉一次
    let lastAccountsEnterAt = 0;
    const CREDITS_STALE_MS = 30000;   // 超过 30s 未刷新就按需拉一次上游

    /** 把毫秒差格式化成「刚刚 / 12 秒前 / 3 分钟前」 */

// ─── 报表数据容量裁剪 ─────────────────────────────────────────────────────
    function openMetricsPruneModal() {
      document.getElementById('metricsPruneModal').style.display = 'flex';
    }

    function closeMetricsPruneModal() {
      document.getElementById('metricsPruneModal').style.display = 'none';
    }

    async function executeMetricsPrune() {
      const opt = document.querySelector('input[name="metricsPruneOpt"]:checked')?.value || 'today_only';
      const keepDays = parseInt(document.getElementById('inputMetricsKeepDays').value, 10) || 1;
      const confirmMsg = opt === 'all'
        ? '确定一键清空全部报表统计记录吗？此操作将把所有请求数和Token统计重置为0！'
        : (opt === 'today_only' ? '确定仅保留今天的统计数据，清理今天之前的所有历史记录吗？' : `确定仅保留最近 ${keepDays} 天的统计数据，清理更早之前的记录吗？`);
      if (!confirm(confirmMsg)) return;

      try {
        const res = await fetch('/api/metrics/prune', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: opt, keepDays })
        });
        const d = await res.json();
        if (d.ok) {
          alert(`✅ 统计数据清理成功！已清理 ${d.deletedDaysCount} 个历史日期的统计记录。`);
          closeMetricsPruneModal();
          loadMetrics(currentMetricsRange);
        } else {
          alert('清理失败: ' + (d.error || '未知错误'));
        }
      } catch (e) {
        alert('网络异常: ' + e.message);
      }
    }

