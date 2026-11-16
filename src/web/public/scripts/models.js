// ─── 模型矩阵管理与展示 ───────────────────────────────────────────────────
    async function loadModels(force = false) {
      try {
        const countEl = document.getElementById('modelFilteredCount');
        if (countEl) countEl.innerText = '正在同步...';
        const [res, setRes] = await Promise.all([
          fetch('/api/models-detail' + (force ? '?refresh=1' : '')),
          fetch('/api/settings')
        ]);
        allModels = await res.json();
        try {
          const s = await setRes.json();
          if (s.thinkingPolicy) currentThinkingPolicy = s.thinkingPolicy;
        } catch (_) {}
        await refreshBlacklistState();
        renderModels();
      } catch (e) {
        const countEl = document.getElementById('modelFilteredCount');
        if (countEl) countEl.innerText = '加载失败';
      }
    }

    function getModelMultiplier(m) {
      if (typeof m.multiplier === 'number') return m.multiplier;
      if (!m.credits || typeof m.credits !== 'string') return 1.0;
      const match = m.credits.match(/x?\s*([\d.]+)/i);
      if (match) {
        const val = parseFloat(match[1]);
        if (!isNaN(val)) return val;
      }
      return 1.0;
    }

    /** 取模型的区域标记（兼容旧数据：无 regions 字段时按国内版处理） */
    function modelRegions(m) {
      if (Array.isArray(m.regions) && m.regions.length) return m.regions;
      return ['cn'];
    }

    async function toggleModelVisibility(fullId, isVisible) {
      const bare = fullId.replace(/^(cn|intl):/, '');
      let next = [...currentBlacklist];
      if (isVisible) {
        // 设为可见：从黑名单中移除
        next = next.filter(x => x !== fullId && x !== bare);
      } else {
        // 设为不可见：加入黑名单
        if (!next.includes(fullId)) next.push(fullId);
      }
      currentBlacklist = next;
      try {
        await fetch('/api/models/blacklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blacklist: next })
        });
      } catch (e) {
        console.error('更新模型可见状态失败:', e);
      }
      renderModels();
    }

    function renderModels() {
      const query = (document.getElementById('modelSearch')?.value || '').toLowerCase().trim();
      const regionFilter = document.getElementById('filterRegion')?.value || 'all';
      const capabilityFilter = document.getElementById('filterCapability')?.value || 'all';
      const effortFilter = document.getElementById('filterEffort')?.value || 'all';
      const priceFilter = document.getElementById('filterPrice')?.value || 'all';
      const sortFilter = document.getElementById('filterSort')?.value || 'default';
      const tbody = document.getElementById('modelBody');
      if (!tbody) return;

      // 1. 把模型矩阵按其可用的区域展开（cn:... / intl:...）
      const regionalItems = [];
      for (const m of allModels) {
        const rs = modelRegions(m);
        for (const r of rs) {
          regionalItems.push({
            ...m,
            fullId: `${r}:${m.id}`,
            region: r
          });
        }
      }

      // 2. 综合多维度筛选
      let filtered = regionalItems.filter(item => {
        // 搜索过滤：全ID、裸ID、名称、描述、厂商
        if (query) {
          const matchQuery = item.fullId.toLowerCase().includes(query)
            || item.id.toLowerCase().includes(query)
            || (item.name || '').toLowerCase().includes(query)
            || (item.descriptionZh || '').toLowerCase().includes(query)
            || (item.descriptionEn || '').toLowerCase().includes(query)
            || (item.vendor || '').toLowerCase().includes(query);
          if (!matchQuery) return false;
        }

        // 区域过滤：全部区域 / 国内版 CN / 国际版 Global
        if (regionFilter === 'cn' && item.region !== 'cn') return false;
        if (regionFilter === 'intl' && item.region !== 'intl') return false;

        // 能力过滤：全部能力 / 支持工具调用 / 支持视觉 / 支持思考 / 默认模型 / 上游繁忙拥堵
        if (capabilityFilter === 'tool' && !item.supportsToolCall) return false;
        if (capabilityFilter === 'vision' && !item.supportsImages) return false;
        if (capabilityFilter === 'reasoning' && !(item.supportsReasoning || item.onlyReasoning || item.reasoning)) return false;
        if (capabilityFilter === 'default') {
          const isDef = item.id === 'default' || item.id === 'fast-model' || item.id === 'balanced-model' || item.isDefault;
          if (!isDef) return false;
        }
        if (capabilityFilter === 'busy') {
          const b = item.busy || item.busy_level || item.busyLevel;
          if (b !== 'busy' && b !== 'congested' && b !== 'unavailable') return false;
        }

        // 档位过滤：全部档位 / 可关闭思考 / low / medium / high / xhigh / max
        if (effortFilter !== 'all') {
          if (effortFilter === 'can_disable') {
            const canDis = item.reasoning?.canDisableThinking !== false && !item.onlyReasoning;
            if (!canDis) return false;
          } else {
            const effList = Array.isArray(item.reasoning?.supportedEfforts)
              ? item.reasoning.supportedEfforts
              : (item.reasoning?.effort ? [item.reasoning.effort] : []);
            if (!effList.includes(effortFilter)) return false;
          }
        }

        // 价格过滤：全部价格 / 有活动折扣/限时免费 / 限时免费 / 夜间折扣 / 打折特惠(非免费)
        if (priceFilter !== 'all') {
          const promo = item.promotion;
          const mult = getModelMultiplier(item);
          const isFree = (promo && (promo.kind === 'free' || promo.discount?.factor === 0))
            || mult === 0
            || (item.credits || '').includes('0.00')
            || (item.credits || '').includes('0x');
          const isNight = Boolean(promo && promo.badge?.label?.includes('夜间'));
          const isDiscount = Boolean(promo && promo.discount?.factor && promo.discount.factor < 1 && promo.discount.factor > 0)
            || isNight
            || (mult > 0 && mult < 1);

          if (priceFilter === 'discount_or_free' && !isFree && !isDiscount) return false;
          if (priceFilter === 'free' && !isFree) return false;
          if (priceFilter === 'night' && !isNight) return false;
          if (priceFilter === 'discount' && (!isDiscount || isFree)) return false;
        }

        return true;
      });

      // 3. 排序方案：上游默认 / 倍率低->高 / 上下文大->小 / 最大输出大->小 / ID A->Z
      if (sortFilter === 'price_asc') {
        filtered = [...filtered].sort((a, b) => getModelMultiplier(a) - getModelMultiplier(b));
      } else if (sortFilter === 'context_desc') {
        filtered = [...filtered].sort((a, b) => (b.maxInputTokens || 0) - (a.maxInputTokens || 0));
      } else if (sortFilter === 'output_desc') {
        filtered = [...filtered].sort((a, b) => (b.maxOutputTokens || 0) - (a.maxOutputTokens || 0));
      } else if (sortFilter === 'id_asc') {
        filtered = [...filtered].sort((a, b) => a.fullId.localeCompare(b.fullId));
      }

      // 4. 更新顶部与工具栏计数
      const filteredCountEl = document.getElementById('modelFilteredCount');
      if (filteredCountEl) filteredCountEl.innerText = `${filtered.length} 个模型 · 已剔除降级缓存`;
      const tableCountEl = document.getElementById('modelTableCount');
      if (tableCountEl) tableCountEl.innerText = `${filtered.length} 个模型`;

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:40px;">未找到匹配的模型</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(item => {
        // 下游可见性判定（黑名单）
        const isBlocked = currentBlacklist.includes(item.fullId) || currentBlacklist.includes(item.id);
        const isVisible = !isBlocked;

        // 1. 模型列 (ID, 名称, 特性徽章, 促销活动角标)
        const isDefault = item.id === 'default' || item.id === 'fast-model';
        const hasTool = item.supportsToolCall;
        const hasVision = item.supportsImages;
        const hasReasoning = Boolean(item.supportsReasoning || item.onlyReasoning || item.reasoning);
        const reasoningAlwaysOn = hasReasoning && (item.reasoning?.canDisableThinking === false || item.onlyReasoning);
        const subPriority = item.id.includes('glm-5.3');

        let badgesHtml = '';
        if (isDefault) badgesHtml += '<span class="badge" style="background:rgba(74,222,128,0.15); color:#4ade80; border:1px solid rgba(74,222,128,0.35); font-size:10px; padding:1px 6px; border-radius:4px;">默认</span>';
        if (subPriority) badgesHtml += '<span class="badge" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3); font-size:10px; padding:1px 6px; border-radius:4px;">订阅优先</span>';
        if (hasTool) badgesHtml += '<span class="badge" style="background:rgba(255,255,255,0.06); color:#cbd5e1; border:1px solid rgba(255,255,255,0.12); font-size:10px; padding:1px 6px; border-radius:4px;">工具</span>';
        if (hasVision) badgesHtml += '<span class="badge" style="background:rgba(255,255,255,0.06); color:#cbd5e1; border:1px solid rgba(255,255,255,0.12); font-size:10px; padding:1px 6px; border-radius:4px;">视觉</span>';
        if (reasoningAlwaysOn) badgesHtml += '<span class="badge" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3); font-size:10px; padding:1px 6px; border-radius:4px;">思考常开</span>';

        // 上游模型繁忙度（POST /v2/chat/busy 实时；对齐官方客户端文案：congested=极度拥堵, busy=拥堵）
        const BUSY_WORDS = { idle: '空闲', normal: '畅通', busy: '拥堵', congested: '极度拥堵', unavailable: '不可用' };
        const busyLevel = item.busy || item.busy_level || item.busyLevel || null;
        if (busyLevel && BUSY_WORDS[busyLevel]) {
          const isBad = busyLevel === 'congested' || busyLevel === 'unavailable';
          const bg = isBad ? 'rgba(239,68,68,0.2)' : 'rgba(249,115,22,0.18)';
          const color = isBad ? '#ef4444' : '#fb923c';
          const border = isBad ? 'rgba(239,68,68,0.4)' : 'rgba(249,115,22,0.35)';
          const title = `上游繁忙程度：${BUSY_WORDS[busyLevel]} (${escapeAttr(busyLevel)})（/v2/chat/busy 实时探针；服务端偶发无数据）`;
          badgesHtml += `<span class="badge" style="background:${bg}; color:${color}; border:1px solid ${border}; font-size:10px; padding:1px 6px; border-radius:4px; font-weight:600;" title="${title}">${BUSY_WORDS[busyLevel]}</span>`;
        }

        const nameZh = item.name || item.id;
        const promo = item.promotion || null;
        const mult = getModelMultiplier(item);
        const isFree = (promo && (promo.kind === 'free' || promo.discount?.factor === 0)) || mult === 0 || (item.credits || '').includes('0.00') || (item.credits || '').includes('0x');

        let promoBadgeHtml = '';
        if (promo && promo.badge) {
          const badgeLabel = promo.badge.label || (isFree ? '限时免费' : '限时折扣');
          const badgeColor = promo.badge.color || '#009273';
          const iconHtml = promo.badge.icon
            ? `<img src="${promo.badge.icon}" style="width:12px; height:12px; vertical-align:middle; margin-right:3px; display:inline-block;" alt="" />`
            : (badgeLabel.includes('夜间') ? '🌙 ' : (badgeLabel.includes('免费') ? '🎁 ' : '⚡ '));

          const hoverText = promo.hover?.textZh || (isFree ? '当前模型处于官方限时免费阶段，调用消耗 0 积分。' : '官方限时优惠活动中');
          const scheduleText = promo.schedule?.validUntil
            ? `<div style="margin-top:5px; font-size:11px; color:#94a3b8; display:flex; align-items:center; gap:4px;"><span>📅</span><span>活动有效期至: ${new Date(promo.schedule.validUntil).toLocaleDateString()}</span></div>`
            : '';
          const discountDesc = (promo.discount?.factor && promo.discount.factor < 1 && promo.discount.factor > 0)
            ? `<div style="margin-top:3px; font-size:11px; color:#4ade80; font-weight:600;">💰 折算比例: ${Math.round(promo.discount.factor * 10)} 折优惠 (${promo.discount.discountedCredits || ''})</div>`
            : '';
          const actionText = promo.hover?.action?.labelZh
            ? `<span style="color:#38bdf8; font-size:11px; margin-left:4px;">${escapeHtml(promo.hover.action.labelZh)} &rarr;</span>`
            : '';

          promoBadgeHtml = `
            <div class="promo-badge-wrap" title="${escapeAttr(hoverText)}">
              <span class="promo-pill" style="background:${badgeColor}22; color:${badgeColor}; border:1px solid ${badgeColor}66;">
                ${iconHtml}<span>${escapeHtml(badgeLabel)}</span>
              </span>
              <div class="promo-tooltip">
                <div style="font-weight:700; color:#fff; font-size:12.5px; margin-bottom:4px; display:flex; align-items:center; gap:5px;">
                  ${iconHtml}<span>${escapeHtml(badgeLabel)}</span>
                </div>
                <div style="color:#e2e8f0; font-size:11.5px; line-height:1.5;">${escapeHtml(hoverText)}${actionText}</div>
                ${discountDesc}
                ${scheduleText}
              </div>
            </div>
          `;
        }

        // 2. 积分倍率
        let priceHtml = '';
        if (isFree) {
          priceHtml = `
            <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
              <span style="font-weight:700; color:#4ade80; font-size:12.5px;">0x</span>
              <span style="color:var(--text-muted); font-size:11px;">(免积分)</span>
            </div>
          `;
        } else if (promo && promo.discount?.factor && promo.discount.factor < 1 && promo.discount.factor > 0) {
          const discountedMult = (mult * promo.discount.factor).toFixed(2);
          priceHtml = `
            <div style="display:flex; flex-direction:column; gap:2px;">
              <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
                <span style="font-weight:700; color:#fff; font-size:12.5px;">x${mult.toFixed(2)}</span>
                <span style="font-size:11px; color:#4ade80; font-weight:600; background:rgba(74,222,128,0.12); border:1px solid rgba(74,222,128,0.25); padding:1px 5px; border-radius:3px;">${Math.round(promo.discount.factor * 10)}折</span>
              </div>
              <span style="color:var(--text-muted); font-size:11px;">特惠折后 ≈ x${discountedMult}</span>
            </div>
          `;
        } else {
          priceHtml = `<span style="font-weight:700; color:#fff; font-size:12.5px;">x${mult.toFixed(2)}</span>`;
        }

        // 3. 网关档位 (下拉框：选项即该模型所支持的思考档位原样，支持关闭则带 off)
        let gwEffortHtml = '<span style="color:var(--text-muted); font-size:12px;">-</span>';
        if (hasReasoning) {
          const r = item.reasoning || {};
          const canDisable = r.canDisableThinking !== false && !item.onlyReasoning;
          let supported = [];
          if (Array.isArray(r.supportedEfforts) && r.supportedEfforts.length > 0) {
            supported = r.supportedEfforts;
          } else if (typeof r.effort === 'string' && r.effort) {
            supported = [r.effort];
          } else {
            supported = ['low', 'medium', 'high', 'xhigh', 'max'];
          }

          const curOverride = (currentThinkingPolicy.modelLevels && (currentThinkingPolicy.modelLevels[item.id] || currentThinkingPolicy.modelLevels[item.fullId])) || '';
          const upstreamDef = r.defaultEffort || r.effort || 'high';
          const effectiveLevel = curOverride && curOverride !== 'default' ? curOverride : upstreamDef;

          const EFFORT_ZH = { low: '浅思', medium: '标准', high: '深度', xhigh: '极高', max: '极致', off: '关闭' };
          let opts = '';
          for (const eff of supported) {
            const labelZh = EFFORT_ZH[eff] ? `${eff} (${EFFORT_ZH[eff]})` : eff;
            opts += `<option value="${eff}"${effectiveLevel === eff ? ' selected' : ''}>${labelZh}</option>`;
          }
          if (canDisable) {
            opts += `<option value="off"${effectiveLevel === 'off' || effectiveLevel === 'none' ? ' selected' : ''}>off (关闭)</option>`;
          }

          gwEffortHtml = `
            <select class="search-input" style="padding:4px 8px; font-size:12px; width:115px; border-radius:6px; background:var(--surface);" onchange="updateModelThinkingLevel('${escapeAttr(item.id)}', this.value)">
              ${opts}
            </select>
          `;
        }

        // 4. 上游默认
        let upstreamDefHtml = '<span style="color:var(--text-muted); font-size:12px;">-</span>';
        if (hasReasoning) {
          const upstreamDef = item.reasoning?.defaultEffort || item.reasoning?.effort || '';
          if (upstreamDef) {
            const EFFORT_ZH = { low: '浅思', medium: '标准', high: '深度', xhigh: '极高', max: '极致', off: '关闭' };
            const defLabel = EFFORT_ZH[upstreamDef] ? `${upstreamDef} (${EFFORT_ZH[upstreamDef]})` : upstreamDef;
            upstreamDefHtml = `<span class="badge" style="background:rgba(34,197,94,0.18); color:#4ade80; border:1px solid rgba(34,197,94,0.35); padding:2px 10px; border-radius:12px; font-weight:600; font-size:11.5px;">${escapeHtml(defLabel)}</span>`;
          }
        }

        // 5. 支持的思考档位
        let supportedHtml = '<span style="color:var(--text-muted); font-size:12px;">-</span>';
        if (hasReasoning) {
          const r = item.reasoning || {};
          const isFixed = item.id.includes('fast-model') || item.id.includes('balanced-model') || item.id.includes('deep-model');
          const EFFORT_ZH = { low: '浅思', medium: '标准', high: '深度', xhigh: '极高', max: '极致', off: '关闭' };
          if (isFixed) {
            const defZh = EFFORT_ZH[r.effort] || '标准';
            supportedHtml = `<span style="color:var(--text-muted); font-size:12px;">固定档 · 默认 ${r.effort || 'medium'} (${defZh})</span>`;
          } else if (Array.isArray(r.supportedEfforts) && r.supportedEfforts.length > 0) {
            const badges = r.supportedEfforts.map(e => {
              const zh = EFFORT_ZH[e] ? `·${EFFORT_ZH[e]}` : '';
              return `<span class="badge" style="background:rgba(234,179,8,0.12); color:#facc15; border:1px solid rgba(234,179,8,0.3); font-size:11px; padding:2px 7px; border-radius:4px; margin-right:4px;">${e}${zh}</span>`;
            }).join('');
            const canDisableText = (r.canDisableThinking !== false && !item.onlyReasoning) ? '<span style="color:var(--text-muted); font-size:11px; margin-left:3px;">off (可关)</span>' : '';
            supportedHtml = `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:3px;">${badges}${canDisableText}</div>`;
          } else if (r.effort) {
            const zh = EFFORT_ZH[r.effort] ? ` (${EFFORT_ZH[r.effort]})` : '';
            supportedHtml = `<span class="badge" style="background:rgba(234,179,8,0.12); color:#facc15; border:1px solid rgba(234,179,8,0.3); font-size:11px; padding:2px 7px; border-radius:4px;">${r.effort}${zh}</span>`;
          }
        }

        // 6. 上下文长度 (>=1M 渲染为 1M, 对齐官方)
        const inTokens = item.maxInputTokens || 0;
        const ctxStr = inTokens >= 1000000
          ? `${(inTokens / 1000000).toFixed(inTokens % 1000000 === 0 ? 0 : 1)}M`
          : (inTokens >= 1000 ? `${Math.round(inTokens / 1000)}K` : (inTokens || '-'));

        // 7. 最大输出
        const outTokens = item.maxOutputTokens || 0;
        const outStr = outTokens >= 1000000
          ? `${(outTokens / 1000000).toFixed(outTokens % 1000000 === 0 ? 0 : 1)}M`
          : (outTokens >= 1000 ? `${Math.round(outTokens / 1000)}K` : (outTokens || '-'));

        return `
          <tr style="${!isVisible ? 'opacity:0.45;' : ''} border-bottom:1px solid rgba(255,255,255,0.05);">
            <td style="padding:10px 12px;">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span style="font-weight:700; color:#fff; font-size:13.5px; line-height:1.4;">${escapeHtml(item.fullId)}</span>
                ${promoBadgeHtml}
              </div>
              <div style="color:var(--text-muted); font-size:12px; margin-top:2px; margin-bottom:4px;">${escapeHtml(nameZh)}</div>
              <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">${badgesHtml}</div>
            </td>
            <td style="padding:10px 12px;">${priceHtml}</td>
            <td style="padding:10px 12px;">${gwEffortHtml}</td>
            <td style="padding:10px 12px;">${upstreamDefHtml}</td>
            <td style="padding:10px 12px;">${supportedHtml}</td>
            <td style="padding:10px 12px; font-weight:600; color:#fff; font-size:12.5px;">${ctxStr}</td>
            <td style="padding:10px 12px; font-weight:600; color:#fff; font-size:12.5px;">${outStr}</td>
            <td style="padding:10px 12px; text-align:center;">
              <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; font-size:12px; color:var(--text-main); user-select:none;">
                <input type="checkbox" ${isVisible ? 'checked' : ''} onchange="toggleModelVisibility('${escapeAttr(item.fullId)}', this.checked)" style="width:15px; height:15px; cursor:pointer;">
                <span>可见</span>
              </label>
            </td>
          </tr>
        `;
      }).join('');
    }

    function resetModelFilters() {
      const search = document.getElementById('modelSearch');
      if (search) search.value = '';
      const reg = document.getElementById('filterRegion');
      if (reg) reg.value = 'all';
      const cap = document.getElementById('filterCapability');
      if (cap) cap.value = 'all';
      const eff = document.getElementById('filterEffort');
      if (eff) eff.value = 'all';
      const pri = document.getElementById('filterPrice');
      if (pri) pri.value = 'all';
      const srt = document.getElementById('filterSort');
      if (srt) srt.value = 'default';
      renderModels();
    }

    function showRawJson(modelId) {
      const model = allModels.find(m => m.id === modelId) || allModels[0];
      if (!model) return;
      document.getElementById('rawModalTitle').innerText = model.id;
      document.getElementById('rawModalCode').innerText = JSON.stringify(model, null, 2);
      document.getElementById('rawModal').style.display = 'flex';
    }


// ─── 模型黑名单编排 ───────────────────────────────────────────────────────
    // ─── 模型黑名单管理 ───────────────────────────────────────────────────
    let draftBlacklist = [];        // 弹窗内编辑中的规则
    let blacklistPickSet = new Set(); // 多选面板里勾中的模型（暂存，未提交）

    /** 拉取黑名单规则并在页面提示条上显示生效状态 */
    async function refreshBlacklistState() {
      try {
        const res = await fetch('/api/models/blacklist');
        const data = await res.json();
        currentBlacklist = Array.isArray(data.blacklist) ? data.blacklist : [];
        draftBlacklist = [...currentBlacklist];

        const badge = document.getElementById('blacklistCountBadge');
        if (badge) badge.innerText = currentBlacklist.length ? `(${currentBlacklist.length})` : '';

        const notice = document.getElementById('blacklistNotice');
        const noticeText = document.getElementById('blacklistNoticeText');
        if (notice && noticeText) {
          if (currentBlacklist.length > 0) {
            notice.style.display = 'flex';
            const blocked = data.blockedCount || 0;
            noticeText.innerText = `${currentBlacklist.length} 条规则，实际屏蔽 ${blocked} 个模型条目：${currentBlacklist.join('、')}${currentBlacklist.length > 4 ? ' ...' : ''}`;
          } else {
            notice.style.display = 'none';
          }
        }
      } catch (e) {
        currentBlacklist = [];
        draftBlacklist = [];
      }
    }

    async function openBlacklistModal() {
      draftBlacklist = [...currentBlacklist];
      blacklistPickSet = new Set();
      if (document.getElementById('blacklistPickSearch')) {
        document.getElementById('blacklistPickSearch').value = '';
      }
      renderBlacklistModal();
      document.getElementById('blacklistModal').style.display = 'flex';
      renderBlacklistPickList();

      // 拉一次命中预览
      try {
        const res = await fetch('/api/models/blacklist');
        const data = await res.json();
        renderBlacklistPreview(data.blockedPreview || []);
      } catch (_) {}
    }

    function closeBlacklistModal() {
      document.getElementById('blacklistModal').style.display = 'none';
    }

    // ─── 多选面板：复选框勾选，支持筛选 / 全选 / 批量加入 ───────────────
    /** 收集当前矩阵里所有「带区域前缀」的模型条目 */
    function collectPickableModels() {
      const out = [];
      for (const m of allModels) {
        for (const r of modelRegions(m)) {
          const pid = `${r === 'intl' ? 'intl:' : 'cn:'}${m.id}`;
          out.push({ id: pid, region: r, bare: m.id, name: m.name || m.id });
        }
      }
      out.sort((a, b) => a.id.localeCompare(b.id));
      return out;
    }

    /** 按当前筛选词渲染复选框列表（已选状态来自 blacklistPickSet） */
    function renderBlacklistPickList() {
      const box = document.getElementById('blacklistPickList');
      if (!box) return;
      const q = (document.getElementById('blacklistPickSearch')?.value || '').toLowerCase().trim();

      let items = collectPickableModels();
      if (q) {
        items = items.filter(x => x.id.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
      }

      // 计数徽章
      const badge = document.getElementById('blacklistPickCountBadge');
      if (badge) badge.innerText = `已选 ${blacklistPickSet.size}`;

      if (items.length === 0) {
        box.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:12px; font-size:12px; grid-column:1/-1;">无匹配模型</div>';
        return;
      }

      box.innerHTML = items.map(x => {
        const checked = blacklistPickSet.has(x.id);
        const already = draftBlacklist.includes(x.id);
        const isIntl = x.region === 'intl';
        const color = isIntl ? '#c084fc' : '#38bdf8';
        return `
          <label style="display:flex; align-items:center; gap:7px; padding:5px 8px; border-radius:6px; cursor:pointer; font-size:11.5px; ${checked ? 'background:rgba(56,189,248,0.14);' : 'background:transparent;'} ${already ? 'opacity:0.55;' : ''}" title="${escapeAttr(x.id)}${already ? ' (已在黑名单)' : ''}">
            <input type="checkbox" ${checked ? 'checked' : ''} ${already ? 'disabled' : ''} onchange="toggleBlacklistPick('${escapeAttr(x.id)}', this.checked)" style="margin:0; cursor:pointer; flex-shrink:0;">
            <span style="color:${color}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(x.id)}</span>
            ${already ? '<span style="color:#f87171; font-size:10px; flex-shrink:0;">已禁</span>' : ''}
          </label>
        `;
      }).join('');
    }

    function toggleBlacklistPick(id, checked) {
      if (checked) blacklistPickSet.add(id);
      else blacklistPickSet.delete(id);
      renderBlacklistPickList();
    }

    /** 全选/清空（仅作用于当前筛选结果，且跳过已在黑名单的条目） */
    function blacklistPickAll(select) {
      const q = (document.getElementById('blacklistPickSearch')?.value || '').toLowerCase().trim();
      let items = collectPickableModels();
      if (q) items = items.filter(x => x.id.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
      for (const x of items) {
        if (draftBlacklist.includes(x.id)) continue;
        if (select) blacklistPickSet.add(x.id);
        else blacklistPickSet.delete(x.id);
      }
      renderBlacklistPickList();
    }

    /** 把勾中的条目一次性加入草稿黑名单 */
    function applyBlacklistPicks() {
      if (blacklistPickSet.size === 0) { alert('请先在下方勾选要屏蔽的模型'); return; }
      let added = 0;
      for (const id of blacklistPickSet) {
        if (!draftBlacklist.includes(id)) { draftBlacklist.push(id); added++; }
      }
      blacklistPickSet.clear();
      renderBlacklistModal();
      renderBlacklistPickList();
      // 命中预览按草稿实时刷新：直接在前端算，避免多打一次上游
      renderBlacklistPreview(computeDraftPreview());
      if (added === 0) alert('所选模型已在黑名单中');
    }

    /** 前端按当前草稿规则估算会被屏蔽的模型（与服务端匹配逻辑保持一致） */
    function computeDraftPreview() {
      const matchOne = (pattern, value) => {
        if (!pattern) return false;
        if (!pattern.includes('*')) return pattern.toLowerCase() === value.toLowerCase();
        const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        try { return new RegExp(`^${esc}$`, 'i').test(value); } catch (_) { return false; }
      };
      const out = [];
      for (const m of allModels) {
        for (const r of modelRegions(m)) {
          const pid = `${r === 'intl' ? 'intl:' : 'cn:'}${m.id}`;
          const hit = draftBlacklist.some(rule => {
            const hasRegion = rule.startsWith('cn:') || rule.startsWith('intl:');
            if (hasRegion) {
              const ruleRegion = rule.slice(0, rule.indexOf(':'));
              return ruleRegion === r && matchOne(rule, pid);
            }
            return matchOne(rule, m.id) || matchOne(rule, pid);
          });
          if (hit) out.push({ id: pid, bare: m.id, region: r });
        }
      }
      return out;
    }

    function renderBlacklistModal() {
      const box = document.getElementById('blacklistRuleList');
      const cnt = document.getElementById('blacklistRuleCount');
      if (cnt) cnt.innerText = draftBlacklist.length;
      if (!box) return;

      if (draftBlacklist.length === 0) {
        box.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:14px; font-size:12px;">暂无黑名单规则</div>';
        return;
      }
      box.innerHTML = draftBlacklist.map((rule, i) => `
        <div style="display:flex; align-items:center; gap:10px; background:var(--code-bg); padding:8px 12px; border-radius:7px; border:1px solid var(--card-border);">
          <code style="flex:1; font-size:12px; color:#f87171;">${escapeHtml(rule)}</code>
          <button class="btn-copy" style="font-size:11px; padding:2px 8px; color:#f87171; border-color:rgba(239,68,68,0.4);" onclick="removeBlacklistRule(${i})">✕ 移除</button>
        </div>
      `).join('');
    }

    function addBlacklistRule() {
      const input = document.getElementById('blacklistInput');
      const raw = (input?.value || '').trim();
      if (!raw) { alert('请输入要屏蔽的模型名'); return; }
      if (draftBlacklist.includes(raw)) { alert('该规则已存在'); return; }
      draftBlacklist.push(raw);
      if (input) input.value = '';
      renderBlacklistModal();
      renderBlacklistPickList();
      renderBlacklistPreview(computeDraftPreview());
    }

    function removeBlacklistRule(idx) {
      draftBlacklist.splice(idx, 1);
      renderBlacklistModal();
      renderBlacklistPickList();
      renderBlacklistPreview(computeDraftPreview());
    }

    function renderBlacklistPreview(list) {
      const wrap = document.getElementById('blacklistPreviewWrap');
      const box = document.getElementById('blacklistPreviewList');
      const cnt = document.getElementById('blacklistPreviewCount');
      if (!wrap || !box) return;
      if (!list || list.length === 0) {
        wrap.style.display = 'none';
        return;
      }
      wrap.style.display = 'block';
      if (cnt) cnt.innerText = list.length;
      box.innerHTML = list.map(x => {
        const isIntl = x.region === 'intl';
        return `<span class="badge" style="font-size:10.5px; ${isIntl ? 'background:rgba(168,85,247,0.18); color:#c084fc; border:1px solid rgba(168,85,247,0.45);' : 'background:rgba(2,132,199,0.18); color:#38bdf8; border:1px solid rgba(2,132,199,0.45);'}">${escapeHtml(x.id)}</span>`;
      }).join('');
    }

    async function saveBlacklist() {
      try {
        const res = await fetch('/api/models/blacklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blacklist: draftBlacklist })
        });
        const data = await res.json();
        if (!data.success) { alert('保存失败: ' + (data.error || '未知错误')); return; }
        currentBlacklist = data.blacklist || [];
        draftBlacklist = [...currentBlacklist];
        blacklistPickSet.clear();
        closeBlacklistModal();
        await refreshBlacklistState();
        // /v1/models 已变化，模型页计数也同步刷新
        renderModels();
        alert(`黑名单已保存并即时生效（共 ${currentBlacklist.length} 条规则）。\n/v1/models 已同步屏蔽。`);
      } catch (e) {
        alert('保存失败: ' + e.message);
      }
    }

    /** 单行「禁用」快捷操作：直接往黑名单里加/删该模型的两个区域条目 */
    async function toggleModelBlacklist(prefixedId) {
      const exists = currentBlacklist.includes(prefixedId);
      let next;
      if (exists) {
        next = currentBlacklist.filter(x => x !== prefixedId);
      } else {
        next = [...currentBlacklist, prefixedId];
      }
      try {
        const res = await fetch('/api/models/blacklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blacklist: next })
        });
        const data = await res.json();
        if (!data.success) { alert('操作失败: ' + (data.error || '未知错误')); return; }
        currentBlacklist = data.blacklist || [];
        draftBlacklist = [...currentBlacklist];
        await refreshBlacklistState();
        renderModels();
      } catch (e) {
        alert('操作失败: ' + e.message);
      }
    }

    /** 单行「屏蔽/恢复」：对该模型的所有区域条目一起切换 */
    async function toggleModelBlacklistByModel(bareId) {
      const model = allModels.find(x => x.id === bareId);
      if (!model) return;
      const targets = modelRegions(model).map(r => `${r === 'intl' ? 'intl:' : 'cn:'}${bareId}`);
      const allBlocked = targets.every(t => currentBlacklist.includes(t));

      let next;
      if (allBlocked) {
        next = currentBlacklist.filter(x => !targets.includes(x));
      } else {
        next = [...currentBlacklist];
        for (const t of targets) if (!next.includes(t)) next.push(t);
      }
      try {
        const res = await fetch('/api/models/blacklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blacklist: next })
        });
        const data = await res.json();
        if (!data.success) { alert('操作失败: ' + (data.error || '未知错误')); return; }
        currentBlacklist = data.blacklist || [];
        draftBlacklist = [...currentBlacklist];
        await refreshBlacklistState();
        renderModels();
      } catch (e) {
        alert('操作失败: ' + e.message);
      }
    }


// ─── 原始数据与导出 ───────────────────────────────────────────────────────
    function closeRawModal() {
      document.getElementById('rawModal').style.display = 'none';
    }

    function copyRawCode() {
      const code = document.getElementById('rawModalCode')?.innerText || '';
      copyToClipboard(code, '上游原始 JSON 已成功复制到剪贴板！');
    }

    function exportAllRawJson() {
      const jsonStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allModels, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", jsonStr);
      downloadAnchor.setAttribute("download", "codebuddy-upstream-models.json");
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    }

    function copyText(txt) {
      copyToClipboard(txt, `模型 ID 已复制: ${txt}`);
    }

// ─── 官方定价规则与在线同步 ───────────────────────────────────────────────
    async function openPricingModal() {
      const modal = document.getElementById('pricingModal');
      modal.style.display = 'flex';
      await loadPricingRules();
    }

    function closePricingModal() {
      document.getElementById('pricingModal').style.display = 'none';
      const resBox = document.getElementById('pricingOnlineResults');
      if (resBox) resBox.style.display = 'none';
    }

    async function loadPricingRules() {
      const tbody = document.getElementById('pricingTableBody');
      try {
        const res = await fetch('/api/pricing');
        const data = await res.json();
        const prices = data.prices || {};

        tbody.innerHTML = Object.entries(prices).map(([id, p]) => {
          const hitVal = p.cacheHit !== undefined ? p.cacheHit : (p.input * 0.5);
          return `
            <tr>
              <td><code>${escapeHtml(id)}</code></td>
              <td><b>${escapeHtml(p.name || id)}</b></td>
              <td><span class="badge badge-blue">${escapeHtml(p.vendor || '官方')}</span></td>
              <td style="color:#38bdf8; font-family:monospace; font-weight:700;">¥${Number(p.input || 0).toFixed(2)}/M</td>
              <td style="color:#22c55e; font-family:monospace; font-weight:700;">¥${Number(hitVal).toFixed(2)}/M <span style="font-size:10px; color:#facc15;">(低至2.5折)</span></td>
              <td style="color:#c084fc; font-family:monospace; font-weight:700;">¥${Number(p.output || 0).toFixed(2)}/M</td>
              <td style="color:var(--text-muted); font-size:12px;">${escapeHtml(p.note || '')}</td>
            </tr>
          `;
        }).join('');
      } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#f87171; padding:20px;">加载价格标准失败: ${escapeHtml(e.message)}</td></tr>`;
      }
    }

    async function runPricingSearchOnline() {
      const queryInput = document.getElementById('pricingSearchInput');
      const q = (queryInput ? queryInput.value.trim() : '') || '大模型 API 官方价格 1M tokens';
      const btn = document.getElementById('btnOnlineSearchPricing');
      const resBox = document.getElementById('pricingOnlineResults');

      if (btn) {
        btn.disabled = true;
        btn.innerText = '🔍 正在联网检索官方价格...';
      }

      resBox.style.display = 'block';
      resBox.innerHTML = '<div style="color:var(--text-muted); padding:10px; text-align:center;">🌐 正在通过网关执行上游联网检索 (POST /v1/search)...</div>';

      try {
        const res = await fetch('/api/pricing/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '检索失败');

        const items = (data.results || []).flatMap(r => r.results || []);
        if (items.length === 0) {
          resBox.innerHTML = '<div style="color:var(--text-muted); padding:10px;">未检索到相关官方定价网页片段</div>';
        } else {
          resBox.innerHTML = `
            <div style="font-weight:bold; color:var(--accent); margin-bottom:6px;">
              🌐 官方联网检索结果 (共实时抓取 ${items.length} 条权威源):
            </div>
            ${items.map(it => `
              <div style="margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid rgba(255,255,255,0.05);">
                <div style="font-weight:600; color:#38bdf8;">
                  <a href="${escapeAttr(it.url)}" target="_blank" style="color:#38bdf8; text-decoration:none;">🔗 ${escapeHtml(it.title)}</a>
                </div>
                <div style="color:var(--text-muted); font-size:11px; margin-top:2px;">
                  ${escapeHtml(it.snippet || '')}
                </div>
              </div>
            `).join('')}
          `;
        }
      } catch (err) {
        resBox.innerHTML = `<div style="color:#f87171; padding:10px;">联网检索失败: ${escapeHtml(err.message)}</div>`;
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = '🌐 联网检索官网最新价格';
        }
      }
    }

