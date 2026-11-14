// ─── 核心运行策略与网关多 API Key 管理 ─────────────────────────────────────
    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const s = await res.json();
        currentSettings = s;
        
        const isConcOn = s.concurrencyLimitEnabled !== false;
        document.getElementById('chkConcurrency').checked = isConcOn;
        document.getElementById('badgeConcurrency').className = 'badge ' + (isConcOn ? 'badge-ok' : 'badge-cool');
        document.getElementById('badgeConcurrency').innerText = isConcOn ? '已开启' : '已关闭';
        if (document.getElementById('valMaxInFlight')) {
          document.getElementById('valMaxInFlight').innerText = s.maxInFlightPerAccount || 3;
        }
        if (document.getElementById('inputMaxInFlight')) {
          document.getElementById('inputMaxInFlight').value = s.maxInFlightPerAccount || 3;
        }
        if (document.getElementById('concurrencyConfigRow')) {
          document.getElementById('concurrencyConfigRow').style.display = isConcOn ? 'flex' : 'none';
        }

        document.getElementById('chkFailover').checked = s.accountFailoverEnabled !== false;
        document.getElementById('badgeFailover').className = 'badge ' + (s.accountFailoverEnabled !== false ? 'badge-ok' : 'badge-cool');
        document.getElementById('badgeFailover').innerText = s.accountFailoverEnabled !== false ? '已开启' : '已关闭';

        document.getElementById('chkFallback').checked = s.modelFallbackEnabled;
        document.getElementById('badgeFallback').className = 'badge ' + (s.modelFallbackEnabled ? 'badge-ok' : 'badge-cool');
        document.getElementById('badgeFallback').innerText = s.modelFallbackEnabled ? '已开启' : '已关闭';

        if (document.getElementById('selStrategy') && s.routingStrategy) {
          document.getElementById('selStrategy').value = s.routingStrategy;
        }

        if (document.getElementById('badgePinnedAccount')) {
          const hasPin = Boolean(s.pinnedAccount);
          document.getElementById('badgePinnedAccount').className = 'badge ' + (hasPin ? 'badge-purple' : 'badge-cool');
          document.getElementById('badgePinnedAccount').innerText = hasPin ? '已指定' : '未指定';
        }
        if (document.getElementById('selPinnedAccount')) {
          document.getElementById('selPinnedAccount').value = s.pinnedAccount || '';
        }

        cachedSettings = s;

        // 渲染 API Key 密钥管理
        renderApiKeysTable(s.apiKeys || []);

        if (s.apiKey) {
          guides.openai = guides.openai.replace(/API Key\s*:\s*[^\n]+/, `API Key : ${s.apiKey}`);
          guides.claude = guides.claude.replace(/ANTHROPIC_API_KEY=[^\n]+/, `ANTHROPIC_API_KEY=${s.apiKey}`);
          guides.search = guides.search.replace(/Bearer [^\\]+/, `Bearer ${s.apiKey} `);
          guides.curl = guides.curl.replace(/Bearer [^\\]+/, `Bearer ${s.apiKey} `);
          const activeGuide = document.querySelector('.guide-tab-btn.active');
          if (activeGuide) {
            const txt = activeGuide.innerText;
            const type = txt.includes('Claude') ? 'claude' : txt.includes('搜索') ? 'search' : txt.includes('cURL') ? 'curl' : 'openai';
            document.getElementById('guideCodeText').innerText = guides[type] || guides.openai;
          }
        }

        const isWebAuthOn = s.webAuthEnabled !== false;
        if (document.getElementById('chkWebAuth')) {
          document.getElementById('chkWebAuth').checked = isWebAuthOn;
          document.getElementById('badgeWebAuth').className = 'badge ' + (isWebAuthOn ? 'badge-ok' : 'badge-cool');
          document.getElementById('badgeWebAuth').innerText = isWebAuthOn ? '已开启' : '已关闭';
        }
        if (document.getElementById('webPasswordSection')) {
          document.getElementById('webPasswordSection').style.display = isWebAuthOn ? 'flex' : 'none';
        }
        if (document.getElementById('inputWebPassword')) {
          document.getElementById('inputWebPassword').value = s.webPassword || '';
        }
        const effectivePwd = s.webPassword || s.apiKey || '';
        if (document.getElementById('lblCurrentWebPasswordNote')) {
          document.getElementById('lblCurrentWebPasswordNote').innerText = s.webPassword ? '(已设置专属密码)' : '(未单独设置，回落使用 apiKey)';
        }
        if (document.getElementById('txtActiveWebPassword')) {
          document.getElementById('txtActiveWebPassword').innerText = isActiveWebPasswordShown ? effectivePwd : '••••••••';
        }

        if (document.getElementById('inputMaxLogDbSize')) {
          document.getElementById('inputMaxLogDbSize').value = s.maxLogDbSizeMb || 30;
        }
        if (document.getElementById('badgeLogDbSize')) {
          document.getElementById('badgeLogDbSize').innerText = `当前体积: ${s.logDbSizeMb || 0} MB / 上限 ${s.maxLogDbSizeMb || 30} MB`;
        }

        if (document.getElementById('inputTokenAdvanceDays')) {
          document.getElementById('inputTokenAdvanceDays').value = s.tokenRefreshAdvanceDays || 7;
        }
        if (document.getElementById('badgeTokenAdvanceDays')) {
          document.getElementById('badgeTokenAdvanceDays').innerText = `提前 ${s.tokenRefreshAdvanceDays || 7} 天自动换发`;
        }

        // 系统提示词策略
        if (s.promptPolicy) {
          if (document.getElementById('selPromptMode')) {
            document.getElementById('selPromptMode').value = s.promptPolicy.mode || 'passthrough';
          }
          if (document.getElementById('inputPromptFile')) {
            document.getElementById('inputPromptFile').value = s.promptPolicy.file || '';
          }
          if (s.rootDir && document.getElementById('txtLinuxPromptExample')) {
            const sep = s.rootDir.includes('\\') ? '\\' : '/';
            const normalizedRoot = s.rootDir.replace(/[/\\]+$/, '');
            document.getElementById('txtLinuxPromptExample').innerText = `${normalizedRoot}${sep}v1.1.40_prompt.txt`;
          }
          updatePromptUiState();
        }

        // 思考档位策略
        if (s.thinkingPolicy) {
          currentThinkingPolicy = s.thinkingPolicy;
          if (document.getElementById('chkThinkingEnabled')) {
            document.getElementById('chkThinkingEnabled').checked = Boolean(s.thinkingPolicy.enabled);
          }
          if (document.getElementById('selDefaultThinkingLevel')) {
            document.getElementById('selDefaultThinkingLevel').value = s.thinkingPolicy.defaultLevel || 'high';
          }
          const radio = document.querySelector(`input[name="thinkingOverrideMode"][value="${s.thinkingPolicy.overrideMode || 'client_first'}"]`);
          if (radio) radio.checked = true;
        }

        // 日志采集策略
        if (document.getElementById('chkRequestClientInfo')) {
          document.getElementById('chkRequestClientInfo').checked = s.requestClientInfo !== false;
        }
        if (document.getElementById('chkRequestArchiveContext')) {
          document.getElementById('chkRequestArchiveContext').checked = Boolean(s.requestArchiveContext);
        }

        // 数据用途声明策略 (X-Private-Data)
        if (s.privateDataPolicy && document.getElementById('selPrivateDataPolicy')) {
          document.getElementById('selPrivateDataPolicy').value = s.privateDataPolicy;
          updatePrivateDataUiSubtitle();
        }

        // 规范化多级备用模型降级链配置并渲染
        if (s.modelFallback && typeof s.modelFallback === 'object') {
          const normalized = {};
          for (const [k, v] of Object.entries(s.modelFallback)) {
            if (Array.isArray(v)) normalized[k] = [...v];
            else if (typeof v === 'string' && v.trim()) normalized[k] = [v.trim()];
            else normalized[k] = [];
          }
          currentSettings.modelFallback = normalized;
        } else {
          currentSettings.modelFallback = {};
        }
        // 降级链要标出被黑名单剔除的步骤，先确保黑名单已加载
        if (Array.isArray(s.modelBlacklist)) {
          currentBlacklist = s.modelBlacklist.filter(Boolean);
        } else if (currentBlacklist.length === 0) {
          try {
            const blRes = await fetch('/api/models/blacklist');
            const blData = await blRes.json();
            currentBlacklist = Array.isArray(blData.blacklist) ? blData.blacklist : [];
          } catch (_) {}
        }
        renderFallbackChains();

      } catch (_) {}
    }

    /**
     * 把 /api/models-detail 的裸模型列表展开成「带区域前缀」的可选项。
     * 每个模型按它可用的区域各生成一条：cn:xxx / intl:xxx，
     * 与 /v1/models 的输出保持一致，避免用户在下拉里选到裸名后无法确定走哪个区。
     */
    function buildRegionPrefixedOptions() {
      const out = [];
      const seen = new Set();
      for (const m of allModels) {
        const regions = Array.isArray(m.regions) && m.regions.length ? m.regions : ['cn'];
        for (const r of regions) {
          const id = `${r}:${m.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({ id, bare: m.id, region: r, label: r === 'intl' ? '国际版' : '国内版' });
        }
      }
      // 按区域分组：国内在前，国际在后；组内按裸名排序
      out.sort((a, b) => {
        if (a.region !== b.region) return a.region === 'cn' ? -1 : 1;
        return a.bare.localeCompare(b.bare);
      });
      return out;
    }

    /** 生成带 <optgroup> 分组的 <option> HTML */
    function buildRegionSelectOptions(excludeSet) {
      const opts = buildRegionPrefixedOptions();
      const cnItems = opts.filter(o => o.region === 'cn' && (!excludeSet || !excludeSet.has(o.id)));
      const intlItems = opts.filter(o => o.region === 'intl' && (!excludeSet || !excludeSet.has(o.id)));
      const mk = (arr) => arr.map(o => `<option value="${escapeAttr(o.id)}">${escapeHtml(o.id)}</option>`).join('');
      let html = '';
      if (cnItems.length) html += `<optgroup label="🇨🇳 国内版 (${cnItems.length})">${mk(cnItems)}</optgroup>`;
      if (intlItems.length) html += `<optgroup label="🌐 国际版 (${intlItems.length})">${mk(intlItems)}</optgroup>`;
      return html;
    }

    /**
     * 判断降级链中的某个步骤是否会被黑名单剔除。
     * 与后端 isStepUnavailableByBlacklist 保持一致：
     *   · 带区域前缀 → 该区域被屏蔽即失效
     *   · 不带前缀   → 两个区域都被屏蔽才失效
     */
    function isStepBlockedByBlacklist(step) {
      const s = String(step || '').trim();
      if (!s) return true;
      const hasRegion = s.startsWith('cn:') || s.startsWith('intl:');
      const region = hasRegion ? s.slice(0, s.indexOf(':')) : null;
      const bare = hasRegion ? s.slice(s.indexOf(':') + 1) : s;

      const matchOne = (pattern, value) => {
        if (!pattern) return false;
        if (!pattern.includes('*')) return pattern.toLowerCase() === value.toLowerCase();
        const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        try { return new RegExp(`^${esc}$`, 'i').test(value); } catch (_) { return false; }
      };
      const isBlockedIn = (r) => {
        const pid = `${r}:${bare}`;
        return currentBlacklist.some(rule => {
          const ruleHasRegion = rule.startsWith('cn:') || rule.startsWith('intl:');
          if (ruleHasRegion) {
            const ruleRegion = rule.slice(0, rule.indexOf(':'));
            return ruleRegion === r && matchOne(rule, pid);
          }
          return matchOne(rule, bare) || matchOne(rule, pid);
        });
      };

      if (region) return isBlockedIn(region);
      return isBlockedIn('cn') && isBlockedIn('intl');
    }

    function renderFallbackChains() {
      const container = document.getElementById('fallbackChainsContainer');
      if (!container) return;
      const chains = currentSettings.modelFallback || {};
      const entries = Object.entries(chains);

      if (entries.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:20px;">暂未配置模型降级链，可点击右上角「➕ 新建主模型降级链」添加</div>';
        return;
      }

      container.innerHTML = entries.map(([primary, fallbacks]) => {
        const fallbackList = Array.isArray(fallbacks) ? fallbacks : [];
        // 已用过的（主模型 + 链中已有）不再出现在下拉里
        const usedSet = new Set([primary, ...fallbackList]);
        const remainingCount = buildRegionPrefixedOptions().filter(o => !usedSet.has(o.id)).length;

        const stepsHtml = fallbackList.map((fb, idx) => {
          // 该备用模型是否会被黑名单剔除（与后端 isStepUnavailableByBlacklist 同逻辑）
          const unavailable = isStepBlockedByBlacklist(fb);
          const tip = unavailable
            ? '该模型命中黑名单，运行时会被自动跳过，不会参与降级轮换'
            : '正常参与降级轮换';
          return `
          <div style="background:${unavailable ? 'rgba(239,68,68,0.10)' : 'rgba(255, 255, 255, 0.05)'}; border:1px solid ${unavailable ? 'rgba(239,68,68,0.45)' : 'var(--card-border)'}; padding:5px 10px; border-radius:6px; display:inline-flex; align-items:center; gap:6px;" title="${escapeAttr(tip)}">
            <span style="font-family:monospace; font-weight:600; color:${unavailable ? '#f87171' : '#4ade80'}; ${unavailable ? 'text-decoration:line-through; opacity:0.75;' : ''}">${idx + 2}. ${escapeHtml(fb)}</span>
            ${unavailable ? '<span class="badge badge-err" style="font-size:9px; padding:1px 5px;">🚫 已屏蔽</span>' : ''}
            <button onclick="moveFallbackStep('${escapeAttr(primary)}', ${idx}, -1)" title="上移/前移优先" class="btn-outline" style="padding:1px 5px; font-size:10px;" ${idx === 0 ? 'disabled style="opacity:0.35;"' : ''}>↑</button>
            <button onclick="moveFallbackStep('${escapeAttr(primary)}', ${idx}, 1)" title="下移/后移后备" class="btn-outline" style="padding:1px 5px; font-size:10px;" ${idx === fallbackList.length - 1 ? 'disabled style="opacity:0.35;"' : ''}>↓</button>
            <button onclick="removeFallbackStep('${escapeAttr(primary)}', ${idx})" title="移除此备用模型" style="background:transparent; color:#f87171; border:none; cursor:pointer; font-size:13px; font-weight:bold; padding:0 3px;">✕</button>
          </div>
          ${idx < fallbackList.length - 1 ? '<span style="color:var(--text-muted); font-size:13px;">➔</span>' : ''}
        `;
        }).join('');

        const selectOptions = buildRegionSelectOptions(usedSet);

        return `
          <div style="background:var(--code-bg); border:1px solid var(--card-border); border-radius:10px; padding:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:12px; color:var(--text-muted); font-weight:bold;">主请求模型:</span>
                <code style="font-size:13px; font-weight:bold; color:var(--accent);">${escapeHtml(primary)}</code>
                <span style="font-size:11px; color:var(--text-muted);">（限流且全池账号耗尽时，按右侧顺序逐级自动降级）</span>
              </div>
              <button class="btn-danger" style="padding:3px 8px; font-size:11px;" onclick="removeFallbackChain('${escapeAttr(primary)}')">✕ 移除此链</button>
            </div>

            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:14px;">
              <div style="background:rgba(2, 132, 199, 0.15); border:1px solid rgba(56, 189, 248, 0.4); padding:6px 12px; border-radius:6px; font-weight:bold; color:var(--accent);">
                1. ${escapeHtml(primary)} (主)
              </div>
              ${fallbackList.length > 0 ? '<span style="color:var(--text-muted); font-size:13px;">➔</span>' : ''}
              ${stepsHtml}
            </div>

            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <select id="selAddFallback_${escapeAttr(primary)}" class="search-input" style="width:240px; padding:4px 8px; font-size:12px;">
                ${selectOptions || '<option value="">无更多可选模型</option>'}
              </select>
              <button class="btn-outline" style="padding:4px 10px; font-size:11px;" onclick="appendFallbackStep('${escapeAttr(primary)}')" ${remainingCount === 0 ? 'disabled' : ''}>➕ 追加备用模型到链尾</button>
            </div>
          </div>
        `;
      }).join('');
    }

    function moveFallbackStep(primary, idx, dir) {
      const list = currentSettings.modelFallback?.[primary];
      if (!Array.isArray(list)) return;
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= list.length) return;
      const temp = list[idx];
      list[idx] = list[targetIdx];
      list[targetIdx] = temp;
      renderFallbackChains();
    }

    function removeFallbackStep(primary, idx) {
      const list = currentSettings.modelFallback?.[primary];
      if (!Array.isArray(list)) return;
      list.splice(idx, 1);
      renderFallbackChains();
    }

    function appendFallbackStep(primary) {
      const sel = document.getElementById('selAddFallback_' + primary);
      const val = sel ? sel.value : '';
      if (!val) return;
      if (!currentSettings.modelFallback[primary]) currentSettings.modelFallback[primary] = [];
      if (!currentSettings.modelFallback[primary].includes(val)) {
        currentSettings.modelFallback[primary].push(val);
      }
      renderFallbackChains();
    }

    // ─── 新建降级链：主模型选择弹窗 ──────────────────────────────────────
    let pickPrimaryRegion = 'all';
    let pickPrimarySelected = null;

    function setPickPrimaryRegion(region, el) {
      pickPrimaryRegion = region;
      document.querySelectorAll('#pickPrimaryModelModal [data-pick-region]').forEach(b => b.classList.remove('active'));
      if (el) el.classList.add('active');
      renderPickPrimaryList();
    }

    function getPickPrimaryCandidates() {
      const existing = new Set(Object.keys(currentSettings.modelFallback || {}));
      const q = (document.getElementById('pickPrimarySearch')?.value || '').toLowerCase().trim();
      return buildRegionPrefixedOptions().filter(o => {
        if (existing.has(o.id)) return false;
        if (pickPrimaryRegion !== 'all' && o.region !== pickPrimaryRegion) return false;
        if (q && !o.id.toLowerCase().includes(q)) return false;
        return true;
      });
    }

    function renderPickPrimaryList() {
      const box = document.getElementById('pickPrimaryList');
      if (!box) return;
      const list = getPickPrimaryCandidates();
      const countEl = document.getElementById('pickPrimaryCount');
      if (countEl) countEl.innerText = `共 ${list.length} 个可选模型`;

      if (list.length === 0) {
        box.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:20px; font-size:12px;">没有匹配的可选模型</div>';
        return;
      }

      box.innerHTML = list.map(o => {
        const isSel = pickPrimarySelected === o.id;
        const bg = isSel ? 'rgba(2,132,199,0.22)' : 'transparent';
        const bd = isSel ? '1px solid rgba(56,189,248,0.6)' : '1px solid transparent';
        const tag = o.region === 'intl'
          ? '<span style="font-size:9px; padding:1px 5px; border-radius:4px; background:rgba(168,85,247,0.18); color:#c084fc; border:1px solid rgba(168,85,247,0.45);">🌐 国际</span>'
          : '<span style="font-size:9px; padding:1px 5px; border-radius:4px; background:rgba(2,132,199,0.18); color:#38bdf8; border:1px solid rgba(2,132,199,0.45);">🇨🇳 国内</span>';
        return `<div onclick="selectPickPrimary('${escapeAttr(o.id)}')" style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 10px; border-radius:6px; cursor:pointer; background:${bg}; border:${bd}; margin-bottom:2px;">
            <code style="font-size:12px; color:var(--text-main);">${escapeHtml(o.id)}</code>
            ${tag}
          </div>`;
      }).join('');
    }

    function selectPickPrimary(id) {
      pickPrimarySelected = id;
      renderPickPrimaryList();
    }

    function confirmPickPrimaryModel() {
      const list = getPickPrimaryCandidates();
      if (!list.length) return alert('没有可选模型');
      const chosen = pickPrimarySelected && list.some(o => o.id === pickPrimarySelected)
        ? pickPrimarySelected
        : list[0].id;
      if (!currentSettings.modelFallback) currentSettings.modelFallback = {};
      if (!currentSettings.modelFallback[chosen]) currentSettings.modelFallback[chosen] = [];
      closePickPrimaryModal();
      renderFallbackChains();
    }

    function closePickPrimaryModal() {
      const m = document.getElementById('pickPrimaryModelModal');
      if (m) m.style.display = 'none';
      pickPrimarySelected = null;
    }

    function addFallbackChainRule() {
      const candidates = buildRegionPrefixedOptions()
        .filter(o => !new Set(Object.keys(currentSettings.modelFallback || {})).has(o.id));
      if (candidates.length === 0) {
        return alert('所有已同步模型均已建立降级链！');
      }
      // 重置状态并打开选择弹窗
      pickPrimarySelected = null;
      pickPrimaryRegion = 'all';
      document.querySelectorAll('#pickPrimaryModelModal [data-pick-region]').forEach(b => {
        b.classList.toggle('active', b.dataset.pickRegion === 'all');
      });
      const search = document.getElementById('pickPrimarySearch');
      if (search) search.value = '';
      const modal = document.getElementById('pickPrimaryModelModal');
      if (modal) modal.style.display = 'flex';
      renderPickPrimaryList();
    }

    function removeFallbackChain(primary) {
      if (!confirm('确定删除主模型 [' + primary + '] 的整条降级链吗？')) return;
      delete currentSettings.modelFallback[primary];
      renderFallbackChains();
    }

    async function saveModelFallbackChains() {
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelFallback: currentSettings.modelFallback })
        });
        const data = await res.json();
        if (data.ok) {
          alert('✅ 备用模型多级降级链已成功保存并即时生效！');
          await loadSettings();
        } else {
          alert('保存失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        alert('网络异常: ' + e.message);
      }
    }

    async function changePinnedAccountFromSelect() {
      const val = document.getElementById('selPinnedAccount').value;
      await pinAccount(val);
    }

    async function togglePolicy() {
      const isConc = document.getElementById('chkConcurrency').checked;
      const isFailover = document.getElementById('chkFailover').checked;
      const isFall = document.getElementById('chkFallback').checked;
      const isWebAuth = document.getElementById('chkWebAuth') ? document.getElementById('chkWebAuth').checked : true;
      const strat = document.getElementById('selStrategy').value;
      const maxInFlight = document.getElementById('inputMaxInFlight') ? parseInt(document.getElementById('inputMaxInFlight').value, 10) : 3;

      if (document.getElementById('concurrencyConfigRow')) {
        document.getElementById('concurrencyConfigRow').style.display = isConc ? 'flex' : 'none';
      }
      if (document.getElementById('webPasswordSection')) {
        document.getElementById('webPasswordSection').style.display = isWebAuth ? 'flex' : 'none';
      }

      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          concurrencyLimitEnabled: isConc,
          maxInFlightPerAccount: maxInFlight,
          accountFailoverEnabled: isFailover,
          modelFallbackEnabled: isFall,
          webAuthEnabled: isWebAuth,
          routingStrategy: strat
        })
      });

      await loadSettings();
      loadAccounts();
      fetchLogs();
    }

    async function saveMaxInFlight() {
      const val = parseInt(document.getElementById('inputMaxInFlight').value, 10);
      if (isNaN(val) || val < 1) return alert('请输入有效的并发数 (>= 1)');
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxInFlightPerAccount: val })
      });
      alert(`已将单账号最大在途并发设置为 ${val} 个！`);
      await loadSettings();
      loadAccounts();
    }

    let isWebPasswordShown = false;
    let isActiveWebPasswordShown = false;
    let isApiKeyShown = false;
    let cachedSettings = null;

    function toggleShowWebPassword() {
      const inp = document.getElementById('inputWebPassword');
      const btn = document.getElementById('btnToggleWebPassword');
      if (!inp) return;
      isWebPasswordShown = !isWebPasswordShown;
      inp.type = isWebPasswordShown ? 'text' : 'password';
      if (btn) btn.innerText = isWebPasswordShown ? '🙈 隐藏' : '👁️ 显示';
    }

    function toggleActiveWebPasswordDisplay() {
      const txt = document.getElementById('txtActiveWebPassword');
      const btn = document.getElementById('btnToggleActiveWebPassword');
      if (!txt) return;
      isActiveWebPasswordShown = !isActiveWebPasswordShown;
      const effectivePwd = cachedSettings?.webPassword || cachedSettings?.apiKey || '';
      txt.innerText = isActiveWebPasswordShown ? effectivePwd : '••••••••';
      if (btn) btn.innerText = isActiveWebPasswordShown ? '🙈 隐藏明文' : '👁️ 显示明文';
    }

    function copyCurrentWebPassword() {
      const effectivePwd = cachedSettings?.webPassword || cachedSettings?.apiKey || '';
      if (!effectivePwd) return alert('当前暂无密码');
      copyToClipboard(effectivePwd, '✅ 当前生效控制台密码已复制到剪贴板！');
    }

    async function saveWebPassword() {
      const pwd = document.getElementById('inputWebPassword').value.trim();
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ webPassword: pwd })
        });
        const data = await res.json();
        if (data.ok) {
          if (data.webAuthToken) {
            localStorage.setItem('cb_web_token', data.webAuthToken);
          }
          alert('✅ 控制台专属密码已更新并即时生效！');
          await loadSettings();
        } else {
          alert('❌ 保存失败：' + (data.error || '未知错误'));
        }
      } catch (err) {
        alert('保存控制台密码异常: ' + err.message);
      }
    }

    // ─── 多 API Key 管理 ───────────────────────────────────────────────────────
    let apiKeysList = [];
    const visibleKeyIds = new Set();

    function renderApiKeysTable(keys) {
      apiKeysList = Array.isArray(keys) ? keys : [];
      const badge = document.getElementById('badgeApiKeyCount');
      if (badge) {
        badge.innerText = `共 ${apiKeysList.length} 个密钥`;
      }
      const tbody = document.getElementById('apiKeysTableBody');
      if (!tbody) return;

      if (apiKeysList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">暂无配置的 API Key，点击右上角「➕ 添加新密钥」进行添加</td></tr>`;
        return;
      }

      tbody.innerHTML = apiKeysList.map((item, idx) => {
        const isVisible = visibleKeyIds.has(item.id);
        const rawKey = item.key || '';
        let displayKey = rawKey;
        if (!isVisible) {
          if (rawKey.length > 14) {
            displayKey = rawKey.slice(0, 8) + '••••••••••••••••' + rawKey.slice(-4);
          } else {
            displayKey = '••••••••••••••••';
          }
        }
        const isEnabled = item.enabled !== false;
        const timeStr = item.createdAt ? new Date(item.createdAt).toLocaleString() : '-';
        const note = item.note || `密钥 #${idx + 1}`;

        return `
          <tr style="border-bottom:1px solid rgba(255,255,255,0.05); transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
            <td style="padding:10px 12px; vertical-align:middle;">
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:600; color:var(--text-main); font-size:13px;">${escapeHtml(note)}</span>
              </div>
            </td>
            <td style="padding:10px 12px; vertical-align:middle;">
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <code style="font-family:monospace; font-size:12px; color:#a78bfa; background:rgba(255,255,255,0.04); padding:3px 8px; border-radius:4px; border:1px solid rgba(255,255,255,0.06); word-break:break-all;">${escapeHtml(displayKey)}</code>
                <div style="display:flex; gap:4px;">
                  <button class="btn-outline" style="padding:2px 7px; font-size:11px;" onclick="toggleKeyVisibility('${item.id}')" title="${isVisible ? '隐藏明文' : '显示明文'}">${isVisible ? '🙈' : '👁️'}</button>
                  <button class="btn-outline" style="padding:2px 7px; font-size:11px;" onclick="copyApiKeyById('${item.id}')" title="复制此 API Key">📋</button>
                </div>
              </div>
            </td>
            <td style="padding:10px 12px; vertical-align:middle; color:var(--text-muted); font-size:12px;">
              ${escapeHtml(timeStr)}
            </td>
            <td style="padding:10px 12px; vertical-align:middle; text-align:center;">
              <span class="badge ${isEnabled ? 'badge-ok' : 'badge-cool'}" style="cursor:pointer; user-select:none;" onclick="toggleApiKeyStatus('${item.id}', ${!isEnabled})" title="点击切换启用/禁用状态">
                ${isEnabled ? '已启用' : '已禁用'}
              </span>
            </td>
            <td style="padding:10px 12px; vertical-align:middle; text-align:right;">
              <div style="display:flex; justify-content:flex-end; gap:6px;">
                <button class="btn-outline" style="padding:3px 9px; font-size:11.5px;" onclick="openEditKeyNoteModal('${item.id}')" title="修改此密钥的备注说明">✏️ 备注</button>
                <button class="btn-outline" style="padding:3px 9px; font-size:11.5px; color:#f87171; border-color:rgba(248,113,113,0.3);" onclick="deleteApiKey('${item.id}')" ${apiKeysList.length <= 1 ? 'disabled title="系统至少需保留一个有效密钥，无法删除"' : 'title="删除此密钥"'}>🗑️ 删除</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    function toggleKeyVisibility(id) {
      if (visibleKeyIds.has(id)) {
        visibleKeyIds.delete(id);
      } else {
        visibleKeyIds.add(id);
      }
      renderApiKeysTable(apiKeysList);
    }

    function copyApiKeyById(id) {
      const item = apiKeysList.find(k => k.id === id);
      if (!item || !item.key) return alert('当前密钥为空');
      copyToClipboard(item.key, '✅ API Key 已复制到剪贴板！');
    }

    function copySingleApiKey(rawKey) {
      if (!rawKey) return alert('当前密钥为空');
      copyToClipboard(rawKey, '✅ API Key 已复制到剪贴板！');
    }

    function openAddApiKeyModal() {
      const noteInp = document.getElementById('inputNewKeyNote');
      const valInp = document.getElementById('inputNewKeyValue');
      if (noteInp) noteInp.value = '';
      if (valInp) valInp.value = '';
      document.getElementById('addApiKeyModal').style.display = 'flex';
      setTimeout(() => { if (noteInp) noteInp.focus(); }, 100);
    }

    function closeAddApiKeyModal() {
      document.getElementById('addApiKeyModal').style.display = 'none';
    }

    function generateModalRandomKey() {
      const valInp = document.getElementById('inputNewKeyValue');
      if (!valInp) return;
      const chars = '0123456789abcdef';
      let rnd = '';
      for (let i = 0; i < 48; i++) {
        rnd += chars[Math.floor(Math.random() * chars.length)];
      }
      valInp.value = 'sk-cb-' + rnd;
    }

    async function submitAddApiKey() {
      const note = document.getElementById('inputNewKeyNote')?.value.trim() || '';
      const key = document.getElementById('inputNewKeyValue')?.value.trim() || '';
      try {
        const res = await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, note })
        });
        const data = await res.json();
        if (data.ok) {
          closeAddApiKeyModal();
          alert('✅ 成功添加新 API Key 并已即时生效！');
          await loadSettings();
        } else {
          alert('❌ 添加失败：' + (data.error || '未知错误'));
        }
      } catch (err) {
        alert('添加 API Key 异常: ' + err.message);
      }
    }

    async function quickGenerateApiKey() {
      const defaultNote = `密钥 #${apiKeysList.length + 1}`;
      try {
        const res = await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: defaultNote })
        });
        const data = await res.json();
        if (data.ok) {
          alert(`🎉 快速生成并添加成功！\n备注：${data.entry.note}\n密钥：${data.entry.key}`);
          await loadSettings();
        } else {
          alert('❌ 生成失败：' + (data.error || '未知错误'));
        }
      } catch (err) {
        alert('快速生成 API Key 异常: ' + err.message);
      }
    }

    function openEditKeyNoteModal(id) {
      const item = apiKeysList.find(k => k.id === id);
      if (!item) return;
      document.getElementById('editKeyId').value = item.id;
      document.getElementById('editKeyDisplay').innerText = item.key;
      document.getElementById('inputEditKeyNote').value = item.note || '';
      document.getElementById('editKeyNoteModal').style.display = 'flex';
      setTimeout(() => { document.getElementById('inputEditKeyNote')?.focus(); }, 100);
    }

    function closeEditKeyNoteModal() {
      document.getElementById('editKeyNoteModal').style.display = 'none';
    }

    async function submitEditKeyNote() {
      const id = document.getElementById('editKeyId')?.value;
      const note = document.getElementById('inputEditKeyNote')?.value.trim() || '';
      if (!id) return;
      try {
        const res = await fetch('/api/keys/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, note })
        });
        const data = await res.json();
        if (data.ok) {
          closeEditKeyNoteModal();
          alert('✅ 备注修改已保存！');
          await loadSettings();
        } else {
          alert('❌ 修改失败：' + (data.error || '未知错误'));
        }
      } catch (err) {
        alert('修改备注异常: ' + err.message);
      }
    }

    async function toggleApiKeyStatus(id, enabled) {
      try {
        const res = await fetch('/api/keys/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, enabled })
        });
        const data = await res.json();
        if (data.ok) {
          await loadSettings();
        } else {
          alert('❌ 状态切换失败：' + (data.error || '未知错误'));
        }
      } catch (err) {
        alert('切换状态异常: ' + err.message);
      }
    }

    async function deleteApiKey(id) {
      if (apiKeysList.length <= 1) {
        return alert('⚠️ 系统至少需要保留一个有效 API Key，无法删除！');
      }
      const item = apiKeysList.find(k => k.id === id);
      const noteStr = item ? `「${item.note || item.id}」` : '';
      if (!confirm(`⚠️ 确定要删除该 API Key ${noteStr} 吗？\n删除后使用该 Key 的客户端将无法继续访问网关！`)) {
        return;
      }
      try {
        const res = await fetch('/api/keys/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (data.ok) {
          alert('✅ API Key 已成功删除！');
          await loadSettings();
        } else {
          alert('❌ 删除失败：' + (data.error || '未知错误'));
        }
      } catch (err) {
        alert('删除 API Key 异常: ' + err.message);
      }
    }

    async function saveMaxLogDbSize() {
      const sizeVal = parseInt(document.getElementById('inputMaxLogDbSize').value, 10);
      if (isNaN(sizeVal) || sizeVal < 1) return alert('请输入有效的 MB 容量上限（>= 1）');
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxLogDbSizeMb: sizeVal })
      });
      alert(`已将 logs.db 自动清理阈值设置为 ${sizeVal} MB！当文件超过该大小时，将自动清理最久记录直至降至 ${Math.floor(sizeVal / 2)} MB`);
      await loadSettings();
    }

    async function saveTokenAdvanceDays() {
      const daysVal = parseInt(document.getElementById('inputTokenAdvanceDays').value, 10);
      if (isNaN(daysVal) || daysVal < 1 || daysVal > 30) return alert('请输入有效的天数（1 - 30 天）');
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenRefreshAdvanceDays: daysVal })
      });
      alert(`已设置提前 ${daysVal} 天自动换发新令牌！当账号剩余有效期不足 ${daysVal} 天时，系统将自动调用官方端点无感续期。`);
      await loadSettings();
      loadAccounts();
    }

    async function triggerManualPruneSize() {
      const sizeVal = parseInt(document.getElementById('inputMaxLogDbSize').value, 10);
      const res = await fetch('/api/logs/prune-size', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxSizeMb: sizeVal })
      });
      const data = await res.json();
      if (data.pruned) {
        alert(`✅ 数据库体积超限，已清理最久历史日志 ${data.deletedRows} 条，体积从 ${data.beforeMb} MB 成功收缩至 ${data.afterMb} MB (目标 <= ${data.targetMb} MB)！`);
      } else {
        alert(`ℹ️ 当前 logs.db 体积 (${data.beforeMb || 0} MB) 未超过设定阈值 (${data.limitMb} MB)，无需缩减`);
      }
      await loadSettings();
      fetchLogs();
    }

    function updatePromptUiState() {
      const mode = document.getElementById('selPromptMode')?.value || 'passthrough';
      const promptFileRow = document.getElementById('promptFileRow');
      if (promptFileRow) {
        promptFileRow.style.display = (mode === 'custom' || mode === 'append') ? 'flex' : 'none';
      }
      const badge = document.getElementById('badgePromptMode');
      if (badge) {
        badge.innerText = mode;
        badge.className = 'badge ' + (mode === 'custom' ? 'badge-ok' : mode === 'append' ? 'badge-blue' : 'badge-cool');
      }
    }

    async function savePromptPolicy() {
      const mode = document.getElementById('selPromptMode').value;
      const file = document.getElementById('inputPromptFile').value.trim();
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ promptPolicy: { mode, file } })
        });
        const data = await res.json();
        if (data.ok) {
          alert('✅ 系统提示词策略已保存并即时生效！');
        } else {
          alert('❌ 保存失败：' + (data.error || '未知错误'));
        }
        await loadSettings();
      } catch (err) {
        alert('保存系统提示词失败：' + err.message);
      }
    }

    // ─── 思考档位策略 ─────────────────────────────────────────────────────────
    let currentThinkingPolicy = {
      enabled: false,
      defaultLevel: 'high',
      overrideMode: 'client_first',
      modelLevels: {}
    };

    async function saveThinkingPolicyFromUi() {
      const enabled = Boolean(document.getElementById('chkThinkingEnabled')?.checked);
      const defaultLevel = document.getElementById('selDefaultThinkingLevel')?.value || 'high';
      const checked = document.querySelector('input[name="thinkingOverrideMode"]:checked');
      const overrideMode = checked ? checked.value : 'client_first';

      currentThinkingPolicy.enabled = enabled;
      currentThinkingPolicy.defaultLevel = defaultLevel;
      currentThinkingPolicy.overrideMode = overrideMode;

      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thinkingPolicy: currentThinkingPolicy })
        });
      } catch (_) {}
    }

    async function saveLoggingPolicyFromUi() {
      const requestClientInfo = Boolean(document.getElementById('chkRequestClientInfo')?.checked);
      const requestArchiveContext = Boolean(document.getElementById('chkRequestArchiveContext')?.checked);
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestClientInfo, requestArchiveContext })
        });
      } catch (_) {}
    }

    function updatePrivateDataUiSubtitle() {
      const val = document.getElementById('selPrivateDataPolicy')?.value || 'auto';
      const sub = document.getElementById('lblPrivateDataSubtitle');
      if (sub) {
        sub.innerText = val === 'true' ? '(强制为私有数据)'
          : val === 'false' ? '(强制允许模型优化)'
          : '(跟随身份默认)';
      }
    }

    async function savePrivateDataPolicy() {
      const val = document.getElementById('selPrivateDataPolicy')?.value || 'auto';
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ privateDataPolicy: val })
        });
        const data = await res.json();
        if (data.ok) {
          alert('✅ 数据用途声明策略已保存并即时生效！');
        } else {
          alert('❌ 保存失败：' + (data.error || '未知错误'));
        }
        await loadSettings();
      } catch (err) {
        alert('保存数据用途声明失败：' + err.message);
      }
    }

    async function updateModelThinkingLevel(modelId, level) {
      if (!currentThinkingPolicy.modelLevels) currentThinkingPolicy.modelLevels = {};
      if (level === 'default') {
        delete currentThinkingPolicy.modelLevels[modelId];
      } else {
        currentThinkingPolicy.modelLevels[modelId] = level;
      }
      try {
        await fetch('/api/models/thinking-level', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, level })
        });
      } catch (_) {}
    }

    // 默认区间：只显示今天。用户仍可手动切到 昨天 / 7天 / 30天 / 全部。
    let currentMetricsRange = 'today';

