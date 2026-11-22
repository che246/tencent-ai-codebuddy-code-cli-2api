// ─── 账号池状态管理与刷新 ─────────────────────────────────────────────────
    let allAccountsData = [];
    let currentAccountRegionFilter = 'all'; // 'all' | 'cn' | 'intl'
    let currentAccountDateRange = 'today';   // 'today' | 'yesterday' | '7d' | '30d' | 'all' (默认今天)

    function setAccountRegionFilter(filter) {
      currentAccountRegionFilter = filter;
      ['all', 'cn', 'intl'].forEach(f => {
        const btn = document.getElementById('accFilterBtn' + f.charAt(0).toUpperCase() + f.slice(1));
        if (btn) {
          if (f === filter) btn.classList.add('active');
          else btn.classList.remove('active');
        }
      });
      renderAccountList();
    }

    function setAccountDateRange(range) {
      currentAccountDateRange = range;
      ['today', 'yesterday', '7d', '30d', 'all'].forEach(r => {
        const btn = document.getElementById('accDateBtn' + r.charAt(0).toUpperCase() + r.slice(1));
        if (btn) {
          if (r === range) btn.classList.add('active');
          else btn.classList.remove('active');
        }
      });
      const badge = document.getElementById('accTokenRangeBadge');
      const labelMap = { today: '今日', yesterday: '昨日', '7d': '近7天', '30d': '近30天', all: '全部历史' };
      if (badge) {
        badge.innerText = labelMap[range] || '今日';
      }
      loadAccounts();
    }

    function updateAccountFilterCounts() {
      const cnCount = allAccountsData.filter(a => a.region === 'cn').length;
      const intlCount = allAccountsData.filter(a => a.region === 'intl').length;
      const elAll = document.getElementById('accCountAll');
      const elCn = document.getElementById('accCountCn');
      const elIntl = document.getElementById('accCountIntl');
      if (elAll) elAll.innerText = `(${allAccountsData.length})`;
      if (elCn) elCn.innerText = `(${cnCount})`;
      if (elIntl) elIntl.innerText = `(${intlCount})`;
    }

    async function forceRefreshCredits() {
      const btn = event?.target;
      const oldText = btn?.innerText;
      if (btn) { btn.disabled = true; btn.innerText = '⏳ 刷新中...'; }
      try {
        const qs = '?refresh=1&range=' + encodeURIComponent(currentAccountDateRange || 'today');
        await fetch('/api/accounts' + qs).then(r => r.json());
        await loadAccounts();
      } catch (e) {
        alert('刷新积分失败: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.innerText = oldText || '🔄 刷新积分'; }
      }
    }

    async function loadAccounts(silent = false) {
      try {
        // 按需刷新策略：
        //   · creditsForceNext=true  → 带 ?refresh=1 强制拉上游（切页/手动刷新时置位）
        //   · silent=true（5 秒轮询）→ 带 ?stale=0 只读缓存，避免每 5 秒打一次计费接口
        //   · 其他情况               → 交给服务端判断 stale（>30s 才拉）
        //   · 日期范围               → 携带 ?range=today|yesterday|7d|30d|all (默认今日)
        const params = new URLSearchParams();
        if (creditsForceNext) {
          params.set('refresh', '1');
          creditsForceNext = false;
        } else if (silent) {
          params.set('stale', '0');
        }
        params.set('range', currentAccountDateRange || 'today');
        const qs = '?' + params.toString();
        const res = await fetch('/api/accounts' + qs);
        const data = await res.json();

        let totalCredits = 0;
        let inFlightTotal = 0;
        let activeAccCount = 0;

        data.forEach(a => {
          totalCredits += (a.creditsRemain || 0);
          inFlightTotal += (a.inFlight || 0);
          if (a.status === 'healthy' && !a.isCooldown) activeAccCount++;
        });

        // 积分新鲜度徽章：取所有账号里最近一次刷新时间
        const freshBadge = document.getElementById('creditsFreshBadge');
        if (freshBadge && data.length > 0) {
          const newest = data.reduce((mx, a) => Math.max(mx, a.creditsUpdatedAt || 0), 0);
          const oldest = data.reduce((mn, a) => {
            const t = a.creditsUpdatedAt || 0;
            return (mn === 0 || (t > 0 && t < mn)) ? t : mn;
          }, 0);
          if (!newest) {
            freshBadge.innerText = '从未刷新';
            freshBadge.style.color = '#f87171';
          } else {
            const staleSec = Math.floor((Date.now() - oldest) / 1000);
            freshBadge.innerText = `刷新于 ${fmtAgo(newest)}`;
            freshBadge.style.color = staleSec > 600 ? '#facc15' : 'var(--text-muted)';
          }
        }

        document.getElementById('kpiTotalAcc').innerText = data.length;
        document.getElementById('kpiActiveAcc').innerText = activeAccCount;
        document.getElementById('kpiTotalCredits').innerText = totalCredits.toLocaleString('en-US', { minimumFractionDigits: 2 });
        document.getElementById('badgeAccountCount').innerText = `${activeAccCount} / ${data.length} 个可用`;

        // 渲染模型锁池状态总览看板
        const allLockedAccounts = data.filter(a => (a.lockedCount > 0) || a.isCooldown);
        const bannerBadge = document.getElementById('badgeLockPoolSummary');
        const bannerDesc = document.getElementById('descLockPoolSummary');
        const detailList = document.getElementById('lockPoolDetailList');
        const actionArea = document.getElementById('lockPoolActionArea');

        if (bannerBadge && detailList) {
          if (allLockedAccounts.length === 0) {
            bannerBadge.className = 'badge badge-ok';
            bannerBadge.innerText = '🟢 全池畅通 (无锁池)';
            bannerDesc.innerText = '所有账号均处于健康服务状态，所有模型均畅通就绪，无任何模型退避锁定。';
            detailList.style.display = 'none';
            if (actionArea) {
              actionArea.innerHTML = '<button class="btn-outline" style="font-size:12px; padding:4px 10px;" onclick="loadAccounts()">🔄 实时探测</button>';
            }
          } else {
            bannerBadge.className = 'badge badge-err';
            bannerBadge.innerText = `🔴 检测到 ${allLockedAccounts.length} 个账号触发模型限流锁池`;
            bannerDesc.innerText = '当某账号调用特定模型返回 429/6004 限流时触发局部退避。网关已自动调度其他健康账号无感接力。';
            detailList.style.display = 'grid';
            detailList.style.gridTemplateColumns = 'repeat(auto-fit, minmax(320px, 1fr))';
            detailList.style.gap = '12px';

            detailList.innerHTML = allLockedAccounts.map(acc => {
              const accLabel = acc.note ? `${acc.email} [${acc.note}]` : acc.email;
              const modelRows = (acc.lockedModels || []).map(lm => `
                <div style="background:rgba(239, 68, 68, 0.1); border:1px solid rgba(239, 68, 68, 0.25); border-radius:6px; padding:6px 10px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                  <div>
                    <code style="color:#fca5a5; font-weight:bold;">${escapeHtml(lm.modelId)}</code>
                    <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">原因: ${escapeHtml(lm.reason)}</div>
                  </div>
                  <span style="color:#facc15; font-weight:bold; font-family:monospace; font-size:12px;">剩 ${lm.remainingSec}s</span>
                </div>
              `).join('');

              const globalRow = acc.isCooldown ? `
                <div style="background:rgba(234, 179, 8, 0.1); border:1px solid rgba(234, 179, 8, 0.25); border-radius:6px; padding:6px 10px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                  <span style="color:#fde047; font-weight:bold;">⏱️ 全局限流冷却退避</span>
                  <span style="color:#facc15; font-weight:bold; font-family:monospace; font-size:12px;">剩 ${acc.cooldownRemainingSec || 0}s</span>
                </div>
              ` : '';

              return `
                <div style="background:var(--code-bg); border:1px solid var(--card-border); border-radius:8px; padding:12px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <b>👤 ${escapeHtml(accLabel)}</b>
                    <button class="btn-outline" style="font-size:11px; padding:2px 8px; color:#38bdf8; border-color:#38bdf8;" onclick="unlockAccountModels('${acc.uid}')">🔓 一键解除该账号锁池</button>
                  </div>
                  ${modelRows}
                  ${globalRow}
                </div>
              `;
            }).join('');

            if (actionArea) {
              actionArea.innerHTML = `
                <button class="btn-primary" style="font-size:12px; padding:4px 12px; background:#dc2626;" onclick="unlockAllPoolModels()">🔓 一键解锁全池所有模型</button>
                <button class="btn-outline" style="font-size:12px; padding:4px 10px;" onclick="loadAccounts()">🔄 实时探测</button>
              `;
            }
          }
        }

        allAccountsData = Array.isArray(data) ? data : [];
        updateAccountFilterCounts();
        populateCreditHistoryAccountFilter();
        renderAccountList();

        // 同步更新设置页中的指定账号下拉列表
        const selPinned = document.getElementById('selPinnedAccount');
        if (selPinned) {
          const currentVal = (currentSettings && currentSettings.pinnedAccount) || '';
          selPinned.innerHTML = '<option value="">全池自动轮换 (未指定)</option>' + data.map(a => {
            const label = (a.email || a.uid) + (a.note ? ' [' + a.note + ']' : '') + ' (' + a.uid.slice(-4) + ')';
            return `<option value="${a.uid}" ${a.uid === currentVal ? 'selected' : ''}>${label}</option>`;
          }).join('');
        }

        // 渲染概览页中的账号排名简表 (展示真实 Token 消耗与积分状态)
        const accRankBox = document.getElementById('accountRankList');
        if (accRankBox) {
          const totalAccTokens = data.reduce((sum, a) => sum + (a.totalTokens || 0), 0);
          const colors = ['#38bdf8', '#c084fc', '#facc15', '#4ade80', '#fb923c'];

          accRankBox.innerHTML = data.map((a, idx) => {
            const accLabel = a.note ? `${a.email} (${a.note})` : `${a.email}`;
            const pct = totalAccTokens > 0 
              ? Math.max(3, Math.round(((a.totalTokens || 0) / totalAccTokens) * 100))
              : (a.creditsRemain > 0 ? 100 : 0);
            const pctDisplay = totalAccTokens > 0 
              ? (((a.totalTokens || 0) / totalAccTokens) * 100).toFixed(1) + '%'
              : (a.inFlight || 0) + ' 并发';
            const color = colors[idx % colors.length];

            return `
              <div class="rank-row" title="账号: ${accLabel}&#10;已消耗: ${(a.totalTokens || 0).toLocaleString()} tokens (入: ${(a.inputTokens || 0).toLocaleString()}, 出: ${(a.outputTokens || 0).toLocaleString()})&#10;请求数: ${a.requests || 0} 次&#10;可用积分: ${(a.creditsRemain || 0).toFixed(0)} credits">
                <span class="rank-name" title="${accLabel}">${accLabel}</span>
                <div class="rank-track">
                  <div class="rank-fill" style="width: ${pct}%; background: ${color};"></div>
                </div>
                <span class="rank-val" style="color:var(--accent);">${a.totalTokensDisplay || '0'}</span>
                <span class="rank-pct">${pctDisplay}</span>
              </div>
            `;
          }).join('');
        }

        // [网关自有策略] 每次加载账号时同步刷新积分历史记录
        if (!silent) {
          loadCreditHistory();
        }

      } catch (err) {
        console.error('loadAccounts render error:', err);
      }
    }

    function renderAccountList() {
      const tbody = document.getElementById('accBody');
      if (!tbody) return;
      if (!Array.isArray(allAccountsData) || allAccountsData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:30px;">暂无可用账号，请点击右上角「➕ 扫码添加账号」</td></tr>';
        return;
      }

      const q = (document.getElementById('accSearchInput')?.value || '').trim().toLowerCase();
      const filtered = allAccountsData.filter(a => {
        if (currentAccountRegionFilter === 'cn' && a.region !== 'cn') return false;
        if (currentAccountRegionFilter === 'intl' && a.region !== 'intl') return false;
        if (q) {
          const uid = (a.uid || '').toLowerCase();
          const email = (a.email || '').toLowerCase();
          const nickname = (a.nickname || '').toLowerCase();
          const note = (a.note || '').toLowerCase();
          if (!uid.includes(q) && !email.includes(q) && !nickname.includes(q) && !note.includes(q)) {
            return false;
          }
        }
        return true;
      });

      if (filtered.length === 0) {
        const filterName = currentAccountRegionFilter === 'cn' ? '国内版' : (currentAccountRegionFilter === 'intl' ? '国际版 (国外)' : '');
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:30px;">未找到匹配${filterName ? '【' + filterName + '】' : ''}的账号</td></tr>`;
        return;
      }

      const maxLimit = (currentSettings && currentSettings.concurrencyLimitEnabled !== false)
        ? (currentSettings.maxInFlightPerAccount || 3)
        : '无限制';

      tbody.innerHTML = filtered.map(a => {
        // 国内版走每日签到接口，国际版通过随机轻量对话激活当日活跃奖励(+30 积分)
        const isIntlAcc = a.region === 'intl';
        const isDone = Boolean(a.isCheckedInToday);
        const checkinTitle = isIntlAcc
          ? (isDone ? (a.lastCheckinMsg || '今日活跃对话打卡已完成') : '国际版：随机与上游轻量对话一次激活当日活跃奖励(+30 积分)')
          : (a.lastCheckinMsg || (isDone ? '今天已签到' : '今日未签到'));
        const checkinText = isIntlAcc
          ? (isDone ? '✅ 已打卡' : '⏳ 未打卡')
          : (isDone ? '✅ 已签到' : '⏳ 未签到');
        const checkinBtnText = isIntlAcc ? '对话打卡' : '打卡';
        const checkinBadge = isDone
          ? `<span class="badge badge-ok" title="${escapeAttr(checkinTitle)}">${checkinText}</span>`
          : `<span class="badge badge-cool" title="${escapeAttr(checkinTitle)}">${checkinText}</span> <button class="btn-primary" style="padding:2px 8px; font-size:11px; margin-left:6px;" onclick="runCheckinSingle('${a.uid}')">${checkinBtnText}</button>`;

        const noteHtml = a.note 
          ? `<span class="acc-note-tag" onclick="editAccountNote('${a.uid}', '${escapeAttr(a.note)}')" title="点击修改备注">📝 ${escapeHtml(a.note)}</span>` 
          : `<span class="acc-note-empty" onclick="editAccountNote('${a.uid}', '')" title="点击添加备注">➕ 添加备注</span>`;

        // 区域标识：国内版 / 国际版。点击可在两版之间切换（token 不通用，切换后需重新授权）
        const accRegion = a.region === 'intl' ? 'intl' : 'cn';
        const regionBadge = accRegion === 'intl'
          ? `<span class="badge" style="font-size:9px; padding:1px 5px; background:rgba(168,85,247,0.18); color:#c084fc; border:1px solid rgba(168,85,247,0.45); cursor:pointer;" onclick="switchAccountRegion('${a.uid}','cn')" title="当前为国际版 (www.codebuddy.ai)。点击切换为国内版">🌐 国际版</span>`
          : `<span class="badge" style="font-size:9px; padding:1px 5px; background:rgba(2,132,199,0.18); color:#38bdf8; border:1px solid rgba(2,132,199,0.45); cursor:pointer;" onclick="switchAccountRegion('${a.uid}','intl')" title="当前为国内版 (www.codebuddy.cn)。点击切换为国际版">🇨🇳 国内版</span>`;

        const isPinned = currentSettings && currentSettings.pinnedAccount === a.uid;
        const pinBtn = isPinned
          ? `<button class="btn-copy" style="background:#7e22ce; color:#fff; border-color:#a855f7; padding:3px 7px; font-size:11px;" onclick="pinAccount('')" title="当前全局锁定指定！点击取消并恢复自动轮换">⭐ 已指定</button>`
          : `<button class="btn-outline" style="padding:3px 7px; font-size:11px;" onclick="pinAccount('${a.uid}')" title="设置该账号为网关全局优先指定账号">⭐ 设为指定</button>`;

        const rangeLabelMap = {
          today: '今日',
          yesterday: '昨日',
          '7d': '近7天',
          '30d': '近30天',
          all: '全部历史'
        };
        const activeRangeLabel = rangeLabelMap[currentAccountDateRange] || '今日';
        const isAllTime = currentAccountDateRange === 'all';
        const tokenTip = `【${activeRangeLabel}用量】&#10;总消耗: ${(a.totalTokens || 0).toLocaleString()} tokens&#10;输入: ${(a.inputTokens || 0).toLocaleString()} tokens&#10;输出: ${(a.outputTokens || 0).toLocaleString()} tokens&#10;请求数: ${a.requests || 0} 次${isAllTime ? '' : `&#10;─────&#10;历史累计总消耗: ${(a.allTimeTokens || 0).toLocaleString()} tokens`}`;

        let tokenExpiryHtml = '';
        const daysColor = (a.daysRemaining !== null && a.daysRemaining <= (a.advanceDays || 7)) ? '#fb923c' : '#4ade80';
        const daysLabel = a.daysRemaining !== null ? `剩 ${a.daysRemaining} 天` : '长效有效';

        if (a.hasRefreshToken) {
          const refreshBtn = a.isRefreshEligible
            ? `<button class="btn-primary" style="padding:1px 6px; font-size:10px; margin-top:3px;" onclick="refreshTokenSingle('${a.uid}')" title="满足提前换发条件，点击立即换发新令牌">⚡ 提前续签</button>`
            : `<button class="btn-outline" style="padding:1px 5px; font-size:10px; margin-top:3px; opacity:0.75;" onclick="refreshTokenSingle('${a.uid}')" title="点击立即强制与官方换发新令牌">换发</button>`;

          tokenExpiryHtml = `
            <div style="font-size:12px;">
              <span class="badge badge-ok" style="font-size:9px; padding:1px 4px;">自动续期</span>
              <b style="color:${daysColor}; font-family:monospace; margin-left:2px;">${daysLabel}</b>
              <span style="font-size:10px; color:var(--text-muted); display:block; margin-top:2px;">至 ${a.expiresAtFmt}</span>
              ${refreshBtn}
            </div>
          `;
        } else {
          tokenExpiryHtml = `
            <div style="font-size:12px;">
              <span class="badge badge-cool" style="font-size:9px; padding:1px 4px;" title="手动录入或未记录 refreshToken，到期前需重新扫码">无刷新令牌</span>
              <b style="color:${daysColor}; font-family:monospace; margin-left:2px;">${daysLabel}</b>
              <span style="font-size:10px; color:var(--text-muted); display:block; margin-top:2px;">至 ${a.expiresAtFmt}</span>
              <button class="btn-outline" style="padding:1px 5px; font-size:10px; margin-top:3px;" onclick="startOAuth()" title="重新扫码授权即可获取长效 refreshToken 实现永久自动续签">扫码补齐</button>
            </div>
          `;
        }

        let lockPoolHtml = '';
        if (a.lockedCount > 0) {
          const listItems = (a.lockedModels || []).map(lm => `
            <div style="font-size:12px; margin:4px 0; color:#fff; display:flex; justify-content:space-between; align-items:center; gap:8px;">
              <span>• <b>${escapeHtml(lm.modelId)}</b></span>
              <span style="color:#facc15; font-size:11px; font-weight:bold; white-space:nowrap;">剩 ${lm.remainingSec}s</span>
            </div>
            <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px; padding-left:8px;">原因: ${escapeHtml(lm.reason)}</div>
          `).join('');

          lockPoolHtml = `
            <div class="probe-tip-wrap">
              <span class="badge badge-err" style="cursor:help;">🔒 已锁 ${a.lockedCount} 款模型</span>
              <div class="probe-tip-popover" style="border-color:rgba(239, 68, 68, 0.6); min-width:240px;">
                <div style="font-weight:bold; color:#f87171; font-size:12px; margin-bottom:4px;">🔒 当前账号模型锁池清单:</div>
                ${listItems}
                <button class="btn-outline" style="font-size:10px; padding:3px 8px; margin-top:6px; width:100%; text-align:center; color:#38bdf8; border-color:#38bdf8;" onclick="unlockAccountModels('${a.uid}')">🔓 一键解除锁池</button>
              </div>
            </div>
          `;
        } else if (a.isCooldown) {
          lockPoolHtml = `<span class="badge badge-cool" title="账号处于全局冷却退避中">⏱️ 全局锁 (剩 ${a.cooldownRemainingSec || 0}s)</span>`;
        } else if (a.status === 'restricted') {
          lockPoolHtml = `<span class="badge badge-err" style="background:rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.35);" title="${escapeAttr(a.restrictedReason || '已被上游风控封锁')}">🚫 全局不可用</span>`;
        } else {
          lockPoolHtml = `<span class="badge badge-ok">🟢 全部模型可用</span>`;
        }

        const unlockBtn = (a.lockedCount > 0 || a.isCooldown || a.status === 'restricted')
          ? `<button class="btn-outline" style="padding:3px 7px; font-size:11px; color:#38bdf8; border-color:#38bdf8;" onclick="unlockAccountModels('${a.uid}')" title="${a.status === 'restricted' ? '重置风控受限状态并解除锁池' : '立即解除锁池与冷却状态'}">🔓 解锁</button>`
          : '';

        return `
          <tr>
            <td><code>${a.uid}</code></td>
            <td><b>${a.email || a.uid}</b></td>
            <td>${noteHtml}<div style="margin-top:4px;">${regionBadge}</div></td>
            <td>${tokenExpiryHtml}</td>
            <td>
              <b style="color:#4ade80; font-size:14px; cursor:pointer;" onclick="showCreditDetails('${a.uid}')" title="点击查看官方 plans-usage 积分构成明细">${(a.creditsRemain || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</b>
              <button class="btn-copy" style="margin-left:6px; font-size:10px; padding:1px 5px;" onclick="showCreditDetails('${a.uid}')" title="查看官方 plans-usage 积分构成明细">明细</button>
              <button class="btn-copy" style="margin-left:3px; font-size:10px; padding:1px 5px; color:#38bdf8; border-color:rgba(56,189,248,0.4);" onclick="filterCreditHistoryByAccount('${a.uid}')" title="筛选查看该账号的积分变动历史留痕">变动</button>
              <span style="display:block; font-size:10px; color:var(--text-muted); margin-top:2px;" title="该账号积分最后一次从上游成功刷新的时间">${fmtAgo(a.creditsUpdatedAt)}</span>
            </td>
            <td>
              <b style="color:var(--accent); font-family:monospace; font-size:13px; cursor:help;" title="${tokenTip}">${a.totalTokensDisplay || '0'}</b>
              <span style="font-size:11px; color:var(--text-muted); display:block;">${(a.requests || 0)} 次请求</span>
              ${(!isAllTime && (a.allTimeTokens || 0) > 0) ? `<span style="font-size:10px; color:var(--text-muted); opacity:0.8; display:block;" title="历史累计消耗: ${(a.allTimeTokens || 0).toLocaleString()} tokens">历史: ${a.allTimeTokensDisplay || '0'}</span>` : ''}
            </td>
            <td>${checkinBadge}</td>
            <td><span class="badge ${a.inFlight > 0 ? 'badge-blue' : ''}">${a.inFlight || 0} / ${maxLimit}</span></td>
            <td>
              ${a.status === 'unauthorized' ? '<span class="badge badge-err">Token失效</span>' : 
                a.status === 'restricted' ? `<span class="badge badge-err" style="background:rgba(239,68,68,0.2); color:#ef4444; border:1px solid rgba(239,68,68,0.4);" title="${escapeAttr(a.restrictedReason || '账号存在异常行为，已被上游限制使用 (11140)')}">🚫 风控受限</span>` :
                a.isCooldown ? '<span class="badge badge-cool">冷却退避</span>' : 
                '<span class="badge badge-ok">健康活跃</span>'}
            </td>
            <td>${lockPoolHtml}</td>
            <td style="white-space:nowrap;">
              ${pinBtn}
              ${unlockBtn}
              <button class="btn-outline" style="padding:3px 8px; font-size:11px;" onclick="runCheckinSingle('${a.uid}')" title="同步积分">🔄 刷新</button>
              <button class="btn-danger" onclick="deleteAccount('${a.uid}')">删除</button>
            </td>
          </tr>
        `;
      }).join('');
    }

    // ─── [网关自有策略] 积分历史变动监控留痕与按账号/日期筛选 ─────────────────
    let currentCreditHistoryDateRange = 'today'; // 默认今天

    function setCreditHistoryDateRange(range) {
      currentCreditHistoryDateRange = range;
      ['today', 'yesterday', '7d', '30d', 'all'].forEach(r => {
        const btn = document.getElementById('creditDateBtn' + r.charAt(0).toUpperCase() + r.slice(1));
        if (btn) {
          if (r === range) btn.classList.add('active');
          else btn.classList.remove('active');
        }
      });
      const badge = document.getElementById('creditHistoryDateRangeBadge');
      const labelMap = { today: '今日', yesterday: '昨日', '7d': '近7天', '30d': '近30天', all: '全部' };
      if (badge) {
        badge.innerText = labelMap[range] || '今日';
      }
      loadCreditHistory();
    }

    function populateCreditHistoryAccountFilter() {
      const sel = document.getElementById('creditHistoryAccountFilter');
      if (!sel || !Array.isArray(allAccountsData)) return;

      const currentVal = sel.value || '';
      let html = '<option value="">全部账号 (全部显示)</option>';

      const cnAccounts = allAccountsData.filter(a => a.region === 'cn');
      const intlAccounts = allAccountsData.filter(a => a.region !== 'cn');

      if (cnAccounts.length > 0) {
        html += '<optgroup label="🇨🇳 国内版账号">';
        cnAccounts.forEach(a => {
          const label = (a.nickname || a.email || a.uid) + (a.note ? ` [${a.note}]` : '') + ` (${a.uid.slice(-4)})`;
          const selected = a.uid === currentVal ? 'selected' : '';
          html += `<option value="${escapeAttr(a.uid)}" ${selected}>${escapeHtml(label)}</option>`;
        });
        html += '</optgroup>';
      }

      if (intlAccounts.length > 0) {
        html += '<optgroup label="🌐 国际版账号">';
        intlAccounts.forEach(a => {
          const label = (a.nickname || a.email || a.uid) + (a.note ? ` [${a.note}]` : '') + ` (${a.uid.slice(-4)})`;
          const selected = a.uid === currentVal ? 'selected' : '';
          html += `<option value="${escapeAttr(a.uid)}" ${selected}>${escapeHtml(label)}</option>`;
        });
        html += '</optgroup>';
      }

      sel.innerHTML = html;
      sel.value = currentVal;
    }

    function filterCreditHistoryByAccount(uid) {
      if (!uid) return;
      const sel = document.getElementById('creditHistoryAccountFilter');
      if (sel) {
        sel.value = uid;
      }
      loadCreditHistory();
      const card = document.getElementById('cardCreditHistory');
      if (card) {
        card.scrollIntoView({ behavior: 'smooth' });
      }
    }

    function resetCreditHistoryAccountFilter() {
      const sel = document.getElementById('creditHistoryAccountFilter');
      if (sel) {
        sel.value = '';
      }
      loadCreditHistory();
    }

    async function loadCreditHistory(forceRefresh = false) {
      const tbody = document.getElementById('creditHistoryBody');
      if (!tbody) return;
      const limitEl = document.getElementById('creditHistoryLimit');
      const limit = limitEl ? limitEl.value : 100;
      const accFilterEl = document.getElementById('creditHistoryAccountFilter');
      const selectedUid = accFilterEl ? accFilterEl.value : '';

      // 更新顶部筛选状态胶囊
      const pill = document.getElementById('badgeCreditHistoryFilterPill');
      const labelAcc = document.getElementById('labelCreditHistoryFilteredAcc');
      if (pill && labelAcc) {
        if (selectedUid) {
          const matchAcc = allAccountsData.find(a => a.uid === selectedUid);
          const name = matchAcc ? (matchAcc.nickname || matchAcc.email || matchAcc.uid) + (matchAcc.note ? ` [${matchAcc.note}]` : '') : selectedUid;
          labelAcc.innerText = name;
          pill.style.display = 'block';
        } else {
          pill.style.display = 'none';
        }
      }

      const params = new URLSearchParams();
      params.set('limit', limit);
      params.set('range', currentCreditHistoryDateRange || 'today');
      if (forceRefresh) params.set('refresh', '1');
      if (selectedUid) params.set('uid', selectedUid);

      const qs = '?' + params.toString();

      try {
        const res = await fetch('/api/credits/history' + qs);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const records = data.records || [];

        if (records.length === 0) {
          const dateLabelMap = { today: '今天', yesterday: '昨天', '7d': '近7天', '30d': '近30天', all: '全部历史' };
          const activeDateLabel = dateLabelMap[currentCreditHistoryDateRange] || '今天';
          const scopePrefix = selectedUid ? '该账号在' : '全池在';
          const switchAllLink = currentCreditHistoryDateRange !== 'all'
            ? `<div style="margin-top:6px;"><a href="javascript:void(0)" onclick="setCreditHistoryDateRange('all')" style="color:var(--accent); text-decoration:underline; font-size:12px;">切换查看全部历史记录 &rarr;</a></div>`
            : '';
          tbody.innerHTML = `
            <tr>
              <td colspan="5" style="text-align:center; padding:30px; color:var(--text-muted);">
                ${scopePrefix}【${activeDateLabel}】暂无积分变动记录（每次真实查到余额与上次比对，变动即自动留痕）
                ${switchAllLink}
              </td>
            </tr>
          `;
          return;
        }

        tbody.innerHTML = records.map(r => {
          const isPositive = r.delta > 0;
          const deltaColor = isPositive ? '#4ade80' : '#f87171';
          const deltaSign = isPositive ? '+' : '';
          const deltaFmt = `${deltaSign}${Number(r.delta).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
          const balanceFmt = Number(r.balance || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

          return `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
              <td style="padding:10px 12px; font-family:monospace; font-size:12px; color:var(--text-muted);" title="${escapeHtml(r.fullTime || '')}">
                ${escapeHtml(r.time || '')}
              </td>
              <td style="padding:10px 12px; font-size:13px; color:var(--text-main);">
                <span style="cursor:pointer; color:var(--accent); text-decoration:underline; text-underline-offset:3px;" onclick="filterCreditHistoryByAccount('${escapeAttr(r.accountUid || '')}')" title="点击仅看此账号的变动记录">
                  ${escapeHtml(r.accountName || r.accountUid || '未知账号')}
                </span>
              </td>
              <td style="padding:10px 12px; font-family:monospace; font-size:13px; font-weight:700; color:${deltaColor};">
                ${deltaFmt}
              </td>
              <td style="padding:10px 12px; font-family:monospace; font-size:13px; font-weight:700; color:var(--text-main);">
                ${balanceFmt}
              </td>
              <td style="padding:10px 12px; font-size:12px; color:var(--text-muted);">
                ${escapeHtml(r.description || '')}
              </td>
            </tr>
          `;
        }).join('');
      } catch (e) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align:center; padding:30px; color:#f87171;">
              加载积分历史失败: ${escapeHtml(e.message)}
            </td>
          </tr>
        `;
      }
    }

    async function clearCreditHistory() {
      if (!confirm('确定要清空全部积分变动历史记录吗？此操作无法撤销。')) return;
      try {
        const res = await fetch('/api/credits/history/clear', { method: 'POST' });
        if (res.ok) {
          loadCreditHistory();
        } else {
          alert('清空失败');
        }
      } catch (e) {
        alert('清空异常: ' + e.message);
      }
    }


// ─── 账号签到 ─────────────────────────────────────────────────────────────
    async function runCheckin() {
      const btn = document.getElementById('btnAllCheckin');
      btn.disabled = true;
      btn.innerText = '⏳ 正在全员签到...';

      try {
        const res = await fetch('/api/checkin', { method: 'POST' });
        const data = await res.json();
        const results = data.results || [];
        const successList = results.filter(r => r.success);

        const alertBox = document.getElementById('checkinAlert');
        const alertTitle = document.getElementById('checkinAlertTitle');
        const alertDetail = document.getElementById('checkinAlertDetail');

        alertTitle.innerText = `🎉 全员打卡完成：共 ${results.length} 个账号，${successList.length} 个成功/已处于今日签到状态`;
        alertDetail.innerText = results.map(r => `• 账号 [${r.email || r.uid}]：${r.msg}`).join('\n');
        alertBox.style.display = 'block';

        window.scrollTo({ top: 0, behavior: 'smooth' });
        loadAccounts();
        fetchLogs();
      } catch (e) {
        alert('全员签到失败: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerText = '⚡ 全员打卡签到';
      }
    }

    async function runCheckinSingle(uid) {
      try {
        const res = await fetch('/api/checkin-single', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid })
        });
        const data = await res.json();
        alert(`[打卡签到反馈] ${data.msg}`);
        loadAccounts();
        fetchLogs();
      } catch (e) {
        alert('签到失败: ' + e.message);
      }
    }


// ─── 账号 OAuth 授权与快捷操作 ───────────────────────────────────────────
    // ─── OAuth 区域选择 ───────────────────────────────────────────────────
    let oauthRegion = 'cn';

    function onOAuthRegionChange(region) {
      oauthRegion = region;
      const cnLabel = document.getElementById('regionCnLabel');
      const intlLabel = document.getElementById('regionIntlLabel');
      const hint = document.getElementById('regionHint');
      const on = '2px solid var(--primary)';
      const onBg = 'rgba(2,132,199,0.12)';
      const off = '2px solid transparent';
      const offBg = 'rgba(255,255,255,0.04)';
      if (cnLabel) { cnLabel.style.border = region === 'cn' ? on : off; cnLabel.style.background = region === 'cn' ? onBg : offBg; }
      if (intlLabel) { intlLabel.style.border = region === 'intl' ? on : off; intlLabel.style.background = region === 'intl' ? onBg : offBg; }
      if (hint) {
        hint.innerHTML = region === 'intl'
          ? '国际版账号（www.codebuddy.ai）。额外可用 GPT-6 / Grok / Gemini 系列，需用国际版账号扫码。'
          : '国内版账号（www.codebuddy.cn）。包含 DeepSeek / GLM / Kimi 等，需用国内账号扫码。';
      }

      // 切换区域后，旧的授权链接立即作废（state 与区域是绑定的），
      // 清空展示避免用户复制到上一个区域的链接。
      const linkEl = document.getElementById('loginLink');
      const urlInput = document.getElementById('loginUrlInput');
      const statusEl = document.getElementById('pollStatus');
      if (linkEl) {
        linkEl.removeAttribute('href');
        linkEl.innerText = '👉 请先点击「获取授权链接」';
      }
      if (urlInput) urlInput.value = '';
      if (statusEl) statusEl.innerText = `已选择${region === 'intl' ? '国际版' : '国内版'}，请点击「获取授权链接」`;
      if (typeof pollTimer !== 'undefined' && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function startOAuth() {
      // ── 时序修正 ──────────────────────────────────────────────
      // 原实现一进来就读单选框并立即请求后端，但此时弹窗尚未打开，
      // 用户根本没机会选择区域，因此永远发出默认的 cn
      // → 国际版账号拿到的总是国内版授权页。
      // 现在改为：先打开弹窗让用户选，再由点击「获取授权链接」触发请求。
      const checked = document.querySelector('input[name="oauthRegion"]:checked');
      if (checked) oauthRegion = checked.value;

      // 同步卡片高亮与提示文案（首次打开时保证 UI 与 oauthRegion 一致）
      onOAuthRegionChange(oauthRegion);

      document.getElementById('oauthModal').style.display = 'flex';
      document.getElementById('pollStatus').innerText = '请先选择账号所属版本，再点击「获取授权链接」';
      document.getElementById('loginLink').removeAttribute('href');
      document.getElementById('loginLink').innerText = '👉 请先选择版本并获取授权链接';
      const urlInputEl = document.getElementById('loginUrlInput');
      if (urlInputEl) urlInputEl.value = '';
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    /** 真正请求后端生成授权链接（用户选好区域后点按钮触发） */
    async function requestOAuthLink() {
      const checked = document.querySelector('input[name="oauthRegion"]:checked');
      if (checked) oauthRegion = checked.value;

      const res = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: oauthRegion })
      });
      const data = await res.json();
      if (!data.state) return alert('获取登录链接失败');

      const regionLabel = data.region === 'intl' ? '国际版' : '国内版';
      const titleEl = document.querySelector('#oauthModal h3');
      if (titleEl) titleEl.innerText = `${regionLabel} · 官方扫码授权`;

      document.getElementById('loginLink').href = data.loginUrl;
      const urlInput = document.getElementById('loginUrlInput');
      if (urlInput) urlInput.value = data.loginUrl;
      const copyBtn = document.getElementById('btnCopyLoginUrl');
      if (copyBtn) copyBtn.innerText = '📋 复制链接';

      document.getElementById('oauthModal').style.display = 'flex';
      document.getElementById('pollStatus').innerText = '等待手机扫码授权中...';

      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        const pRes = await fetch('/api/oauth/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: data.state, region: data.region || oauthRegion })
        });
        const pData = await pRes.json();
        if (pData.ok) {
          clearInterval(pollTimer);
          document.getElementById('pollStatus').innerText = `✅ ${regionLabel}账号登录成功，已录入池！`;
          setTimeout(() => { closeModal(); loadAccounts(); loadModels(true); fetchLogs(); }, 1200);
        }
      }, 2000);
    }

    async function copyLoginUrl() {
      const urlInput = document.getElementById('loginUrlInput');
      const url = urlInput ? urlInput.value : '';
      if (!url) return;
      const ok = await copyToClipboard(url, '');
      if (ok) {
        const btn = document.getElementById('btnCopyLoginUrl');
        if (btn) {
          const old = btn.innerText;
          btn.innerText = '✅ 已复制!';
          setTimeout(() => btn.innerText = old, 2000);
        }
      }
    }

    function closeModal() {
      document.getElementById('oauthModal').style.display = 'none';
      if (pollTimer) clearInterval(pollTimer);
    }


// ─── 账号区域与用量明细 ───────────────────────────────────────────────────
    // 切换账号所属版本（国内版 / 国际版）。
    // 两版的上游路径完全同构，但 token 按签发域校验：切换后原 token 会 401，
    // 需重新扫码授权。因此这里要明确告知用户，避免误以为切换即生效。
    async function switchAccountRegion(uid, targetRegion) {
      const label = targetRegion === 'intl' ? '国际版 (www.codebuddy.ai)' : '国内版 (www.codebuddy.cn)';
      const msg = `确认将该账号切换为「${label}」？\n\n`
        + `注意：账号 token 按签发域校验，切换后原 token 将无法使用，\n`
        + `需要在对应版本重新扫码授权（OAuth 里选择相同版本）。\n\n`
        + `是否继续？`;
      if (!confirm(msg)) return;
      try {
        const res = await fetch('/api/accounts/region', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid, region: targetRegion })
        });
        const data = await res.json();
        if (data.ok) {
          loadAccounts();
          loadModels(true);
          fetchLogs();
          alert(`已切换为${label}。\n请在「扫码添加账号」中选择同一版本重新授权。`);
        } else {
          alert('切换失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        alert('网络异常: ' + e.message);
      }
    }

    async function editAccountNote(uid, currentNote) {
      const newNote = prompt('请输入该账号的备注说明（如：日常开发主号、团队备用、测试号）：', currentNote || '');
      if (newNote === null) return;
      try {
        const res = await fetch('/api/accounts/note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid, note: newNote })
        });
        const data = await res.json();
        if (data.ok) {
          loadAccounts();
          fetchLogs();
        } else {
          alert('更新备注失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        alert('网络异常: ' + e.message);
      }
    }

    async function pinAccount(uid) {
      try {
        const res = await fetch('/api/accounts/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: uid || '' })
        });
        const data = await res.json();
        if (data.ok) {
          await loadSettings();
          loadAccounts();
          fetchLogs();
        } else {
          alert('指定账号设置失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        alert('网络异常: ' + e.message);
      }
    }

    async function deleteAccount(uid) {
      if (!confirm('确定删除该账号吗？')) return;
      await fetch('/api/accounts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid })
      });
      loadAccounts();
      fetchLogs();
    }

    // ─── 积分消耗明细（按账号维度）───────────────────────────────────────
    // 数据来源：网关 /api/accounts/usage-records → 上游 /billing/meter/get-user-request-usage
    let currentUsageUid = null;
    let currentUsagePage = 1;
    let currentUsageDays = 7;
    const USAGE_PAGE_SIZE = 10;

    function setUsageRange(days, el) {
      currentUsageDays = days;
      document.querySelectorAll('#usageRangeTabs .filter-btn').forEach(b => b.classList.remove('active'));
      if (el) el.classList.add('active');
      if (currentUsageUid) loadUsageRecords(1);
    }

    function fmtUsageTime(t) {
      // 官方格式 "2026-11-08 15:14:00"，原样展示即可
      return t || '-';
    }

    async function loadUsageRecords(page = 1) {
      if (!currentUsageUid) return;
      if (page < 1) page = 1;
      currentUsagePage = page;

      const box = document.getElementById('usageRecordsBody');
      const badge = document.getElementById('usageRangeBadge');
      const totalBadge = document.getElementById('usageTotalBadge');
      const pager = document.getElementById('usagePager');

      box.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:12px;">⏳ 正在拉取消耗流水...</div>';

      try {
        const qs = `uid=${encodeURIComponent(currentUsageUid)}&days=${currentUsageDays}&page=${page}&pageSize=${USAGE_PAGE_SIZE}`;
        const res = await fetch('/api/accounts/usage-records?' + qs);
        const d = await res.json();

        if (!d.ok) {
          box.innerHTML = `<div style="text-align:center; padding:20px; color:#f87171; font-size:12px;">加载失败：${escapeHtml(d.error || '未知错误')}</div>`;
          if (pager) pager.style.display = 'none';
          return;
        }

        if (badge) badge.innerText = `${d.range.from} ~ ${d.range.to}`;
        if (totalBadge) totalBadge.innerText = `共 ${d.total} 条`;

        if (!d.records || d.records.length === 0) {
          box.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:12px;">该时间范围内无消耗记录</div>';
          if (pager) pager.style.display = 'none';
          return;
        }

        // 表格渲染
        const rows = d.records.map(r => {
          const creditColor = r.credit > 0 ? '#f87171' : 'var(--text-muted)';
          const inputPreview = (r.inputTrunc || '').replace(/\s+/g, ' ').slice(0, 60);
          const inputTitle = escapeAttr(r.inputFull || r.inputTrunc || '');
          return `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
              <td style="padding:8px 6px; font-size:11.5px; color:var(--text-muted); white-space:nowrap; vertical-align:top;">${escapeHtml(fmtUsageTime(r.time))}</td>
              <td style="padding:8px 6px; font-size:11.5px; max-width:340px;" title="${inputTitle}">
                <div style="color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(inputPreview) || '<span style="color:var(--text-muted);">(无内容)</span>'}</div>
                <div style="color:var(--text-muted); font-size:10px; font-family:monospace; margin-top:2px;">${escapeHtml(r.requestId.slice(0, 32))}</div>
              </td>
              <td style="padding:8px 6px; font-size:12px; font-family:monospace; font-weight:700; color:${creditColor}; text-align:right; white-space:nowrap;">${r.credit.toFixed(2)}</td>
              <td style="padding:8px 6px; font-size:11.5px; white-space:nowrap;">${escapeHtml(r.model)}</td>
              <td style="padding:8px 6px; font-size:11px; color:var(--text-muted); white-space:nowrap;">${escapeHtml(r.client)}</td>
            </tr>
          `;
        }).join('');

        box.innerHTML = `
          <table style="width:100%; border-collapse:collapse;">
            <thead>
              <tr style="border-bottom:1px solid var(--card-border); position:sticky; top:0; background:var(--card-bg);">
                <th style="padding:6px; text-align:left; font-size:11px; color:var(--text-muted); font-weight:600;">时间</th>
                <th style="padding:6px; text-align:left; font-size:11px; color:var(--text-muted); font-weight:600;">请求</th>
                <th style="padding:6px; text-align:right; font-size:11px; color:var(--text-muted); font-weight:600;">积分消耗</th>
                <th style="padding:6px; text-align:left; font-size:11px; color:var(--text-muted); font-weight:600;">模型</th>
                <th style="padding:6px; text-align:left; font-size:11px; color:var(--text-muted); font-weight:600;">使用端</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `;

        // 分页
        const totalPages = Math.max(1, Math.ceil(d.total / USAGE_PAGE_SIZE));
        if (pager) {
          pager.style.display = 'flex';
          const info = document.getElementById('usagePagerInfo');
          if (info) info.innerText = `第 ${page} / ${totalPages} 页 · 本页 ${d.records.length} 条 · 本页积分 ${d.pageCredit}`;
          const prev = document.getElementById('usagePrevBtn');
          const next = document.getElementById('usageNextBtn');
          if (prev) prev.disabled = page <= 1;
          if (next) next.disabled = page >= totalPages;
        }
      } catch (e) {
        box.innerHTML = `<div style="text-align:center; padding:20px; color:#f87171; font-size:12px;">加载异常：${escapeHtml(e.message)}</div>`;
      }
    }

    async function showCreditDetails(uid) {
      const modal = document.getElementById('creditModal');
      modal.style.display = 'flex';
      document.getElementById('creditModalTitle').innerText = '正在加载官方账本数据...';
      document.getElementById('creditModalBody').innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);">⏳ 正在向腾讯云上游调取实时积分包快照...</div>';

      // 初始化消耗明细区（按当前账号加载）
      currentUsageUid = uid;
      currentUsagePage = 1;
      const usageBox = document.getElementById('usageRecordsBody');
      if (usageBox) usageBox.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:12px;">⏳ 正在拉取消耗流水...</div>';
      const pager = document.getElementById('usagePager');
      if (pager) pager.style.display = 'none';
      loadUsageRecords(1);

      try {
        const res = await fetch('/api/accounts/credit-details?uid=' + encodeURIComponent(uid));
        const d = await res.json();
        if (d.error) throw new Error(d.error);

        document.getElementById('creditModalTitle').innerText = `💎 官方积分明细 · 账号 [${d.email || d.uid}]${d.note ? ' (' + d.note + ')' : ''}`;

        // 官方 plans-usage 链接按账号区域切换：
        //   国内版 → www.codebuddy.cn    国际版 → www.codebuddy.ai
        const plansLink = document.getElementById('creditModalPlansLink');
        if (plansLink) {
          const plansHost = d.region === 'intl' ? 'www.codebuddy.ai' : 'www.codebuddy.cn';
          const plansUrl = `https://${plansHost}/profile/plans-usage`;
          plansLink.href = plansUrl;
          plansLink.innerText = plansUrl;
          plansLink.title = `${d.region === 'intl' ? '国际版' : '国内版'}官方套餐与用量账本`;
        }

        const inUseHtml = d.inUsagePackage ? `
          <div style="background:rgba(56, 189, 248, 0.08); border:1px solid rgba(56, 189, 248, 0.25); border-radius:8px; padding:14px; margin-bottom:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <div style="font-weight:700; color:var(--accent); font-size:13px; display:flex; align-items:center; gap:6px;">
                <span>🚀 当前优先扣减中资源包</span>
                <span class="badge badge-blue">使用中</span>
              </div>
              <div style="font-size:12px; color:var(--text-muted);">
                已用 ${d.inUsagePackage.used.toFixed(2)} / ${d.inUsagePackage.total} 积分 (${d.inUsagePackage.percent}%)
              </div>
            </div>
            <div style="font-size:12px; margin-bottom:6px;">
              <b>${escapeHtml(d.inUsagePackage.name)}</b> <span style="color:var(--text-muted);">· 发放原因: ${escapeHtml(d.inUsagePackage.grantReason)}</span>
            </div>
            <div class="rank-track" style="height:8px;">
              <div class="rank-fill" style="width:${d.inUsagePackage.percent}%; background:#38bdf8;"></div>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted); margin-top:4px;">
              <span>资源ID: <code>${d.inUsagePackage.id}</code></span>
              <span style="color:#4ade80; font-weight:600;">剩余: ${d.inUsagePackage.remain.toFixed(2)} 积分</span>
            </div>
          </div>
        ` : '';

        const listHtml = (d.packagesList || []).map(p => `
          <tr>
            <td><code>${p.id}</code></td>
            <td><b>${escapeHtml(p.grantReason)}</b></td>
            <td style="color:var(--text-muted); font-size:11px;">${p.startTime ? p.startTime.slice(0, 16) : '-'}</td>
            <td style="font-family:monospace;">${p.total}</td>
            <td style="font-family:monospace; color:#4ade80; font-weight:700;">${p.remain.toFixed(2)}</td>
            <td style="font-family:monospace; color:var(--text-muted);">${p.used.toFixed(2)}</td>
          </tr>
        `).join('');

        document.getElementById('creditModalBody').innerHTML = `
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:16px;">
            <div class="kpi-card" style="padding:12px;">
              <div class="kpi-label">套餐基础积分</div>
              <div class="kpi-value" style="font-size:20px; color:#38bdf8;">${d.breakdown.baseCredits} <span style="font-size:11px; font-weight:normal; color:var(--text-muted);">credits</span></div>
              <div class="kpi-hint">个人体验版/标准版月度配额</div>
            </div>
            <div class="kpi-card" style="padding:12px;">
              <div class="kpi-label">购买加量积分</div>
              <div class="kpi-value" style="font-size:20px; color:#facc15;">${d.breakdown.paidCredits} <span style="font-size:11px; font-weight:normal; color:var(--text-muted);">credits</span></div>
              <div class="kpi-hint">自费按需加量补充包</div>
            </div>
            <div class="kpi-card" style="padding:12px;">
              <div class="kpi-label">平台奖励积分</div>
              <div class="kpi-value" style="font-size:20px; color:#c084fc;">${d.breakdown.rewardCredits} <span style="font-size:11px; font-weight:normal; color:var(--text-muted);">credits</span></div>
              <div class="kpi-hint">签到/活动/限免返还/补偿包</div>
            </div>
          </div>

          ${inUseHtml}

          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <div style="font-size:13px; font-weight:700;">有效积分资源包清单 (共 ${d.activePackagesCount} 个包有效，${d.usedUpPackagesCount} 个历史包已用尽)</div>
          </div>
          <div style="max-height:280px; overflow-y:auto; border:1px solid var(--card-border); border-radius:8px;">
            <table>
              <thead>
                <tr>
                  <th>资源标识</th>
                  <th>发放来源 / 类别</th>
                  <th>下发时间</th>
                  <th>总量</th>
                  <th>剩余</th>
                  <th>已用</th>
                </tr>
              </thead>
              <tbody>
                ${listHtml || '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">暂无有效资源包</td></tr>'}
              </tbody>
            </table>
          </div>
        `;

      } catch (err) {
        document.getElementById('creditModalBody').innerHTML = `<div style="text-align:center; padding:30px; color:#f87171;">获取官方积分明细失败: ${escapeHtml(err.message)}</div>`;
      }
    }

    function closeCreditModal() {
      document.getElementById('creditModal').style.display = 'none';
      // 清空消耗明细状态，避免下次打开残留上一个账号的数据
      currentUsageUid = null;
      currentUsagePage = 1;
      const pager = document.getElementById('usagePager');
      if (pager) pager.style.display = 'none';
    }


// ─── 账号模型锁定解除 ─────────────────────────────────────────────────────
    async function unlockAccountModels(uid, modelId = null) {
      const targetLabel = modelId ? `模型 [${modelId}]` : '所有模型的锁池、冷却与风控受限状态';
      if (!confirm(`确定为该账号解除 ${targetLabel} 吗？`)) return;
      try {
        const res = await fetch('/api/accounts/unlock-models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid, modelId })
        });
        const d = await res.json();
        if (d.ok) {
          alert('✅ ' + (d.msg || '锁池状态已成功解除！'));
          loadAccounts();
          loadModels(true);
        } else {
          alert('解除失败: ' + (d.error || '未知错误'));
        }
      } catch (e) {
        alert('网络异常: ' + e.message);
      }
    }

    async function unlockAllPoolModels() {
      if (!confirm('确定一键解锁全池所有账号的模型锁池与冷却状态吗？')) return;
      try {
        const res = await fetch('/api/accounts?range=all');
        const data = await res.json();
        let unlockedCount = 0;
        for (const a of data) {
          if (a.lockedCount > 0 || a.isCooldown) {
            await fetch('/api/accounts/unlock-models', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uid: a.uid })
            });
            unlockedCount++;
          }
        }
        alert(`✅ 全池操作完成！已为 ${unlockedCount} 个受限账号解除锁池与冷却状态。`);
        loadAccounts();
        loadModels(true);
      } catch (e) {
        alert('操作异常: ' + e.message);
      }
    }

// ─── 账号批量/快捷导入 (支持 CLI / WorkBuddy JSON 结构) ────────────────────
    function openImportAccountModal() {
      const txt = document.getElementById('txtImportAccountJson');
      const note = document.getElementById('inputImportAccountNote');
      const status = document.getElementById('importAccountStatus');
      if (txt) txt.value = '';
      if (note) note.value = '';
      if (status) status.innerText = '';
      const modal = document.getElementById('importAccountModal');
      if (modal) modal.style.display = 'flex';
    }

    function closeImportAccountModal() {
      const modal = document.getElementById('importAccountModal');
      if (modal) modal.style.display = 'none';
    }

    function robustParseJson(str) {
      let s = String(str || '').trim();
      if (!s) return null;

      try {
        return JSON.parse(s);
      } catch (_) {}

      // 剥离末尾可能多余的逗号或分号
      s = s.replace(/[,;]\s*$/, '').trim();

      // 兼容用户复制时仅复制了 "accounts": [...] 或 accounts: [...]
      if (/^['"]?accounts['"]?\s*:/i.test(s)) {
        s = '{' + s;
      }

      // 利用括号栈追踪未闭合的双引号、大括号与中括号
      const stack = [];
      let inString = false;
      let escape = false;

      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (ch === '{') stack.push('}');
          else if (ch === '[') stack.push(']');
          else if (ch === '}' || ch === ']') {
            if (stack.length > 0 && stack[stack.length - 1] === ch) {
              stack.pop();
            }
          }
        }
      }

      // 如果双引号未闭合，先闭合双引号
      if (inString) {
        s += '"';
      }

      // 按相反顺序补全所有未闭合的括号
      while (stack.length > 0) {
        s += stack.pop();
      }

      return JSON.parse(s);
    }

    async function submitImportAccount() {
      const txt = document.getElementById('txtImportAccountJson');
      const noteInp = document.getElementById('inputImportAccountNote');
      const statusEl = document.getElementById('importAccountStatus');
      const btn = document.getElementById('btnConfirmImportAccount');

      let raw = (txt ? txt.value : '').trim();
      const note = (noteInp ? noteInp.value : '').trim();

      if (!raw) {
        alert('请粘贴账号 JSON 凭据数据');
        return;
      }

      let parsed;
      try {
        parsed = robustParseJson(raw);
      } catch (e) {
        alert('JSON 解析失败，请检查格式是否有效:\n' + e.message);
        return;
      }

      if (btn) btn.disabled = true;
      if (statusEl) statusEl.innerText = '正在导入并校验账号...';

      try {
        const res = await fetch('/api/accounts/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rawJson: JSON.stringify(parsed), note })
        });
        const d = await res.json();
        if (!res.ok) {
          throw new Error(d.error || '导入失败');
        }
        alert(`🎉 成功导入/更新 ${d.count} 个账号！`);
        closeImportAccountModal();
        loadAccounts();
      } catch (err) {
        alert('导入失败: ' + err.message);
      } finally {
        if (btn) btn.disabled = false;
        if (statusEl) statusEl.innerText = '';
      }
    }
