// ─── 全局状态与基础配置 ───────────────────────────────────────────────────
    let pollTimer = null;
    let allModels = [];
    let currentFilter = 'all';
    let pollIntervals = [];

    // ─── 全局通用剪贴板复制工具 (兼容 HTTPS、HTTP 局域网及各主流浏览器) ─────────────
    async function copyToClipboard(text, successMsg = '已复制到剪贴板！') {
      if (text === undefined || text === null) return false;
      const str = String(text);

      // 1. 若处于安全上下文 (HTTPS 或 localhost) 且原生 Clipboard API 可用
      if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(str);
          if (successMsg) alert(successMsg);
          return true;
        } catch (e) {
          console.warn('navigator.clipboard.writeText 异常，切换至 fallback 机制:', e);
        }
      }

      // 2. 传统兼容方案：document.execCommand('copy')（广泛兼容局域网 HTTP、主流浏览器）
      try {
        const textArea = document.createElement('textarea');
        textArea.value = str;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '-9999px';
        textArea.style.opacity = '0';
        textArea.setAttribute('readonly', '');
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, str.length);
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (successful) {
          if (successMsg) alert(successMsg);
          return true;
        }
      } catch (err) {
        console.warn('execCommand copy 失败:', err);
      }

      // 3. 终极托底方案：系统 prompt 交互提示用户手动 Ctrl+C 复制
      try {
        window.prompt('当前环境安全限制无法直接操作剪贴板，请手动按 Ctrl+C 复制：', str);
        return true;
      } catch (_) {
        alert('复制失败，请手动选择内容后复制');
        return false;
      }
    }

    // ─── 统一 API 客户端鉴权拦截器 ─────────────────────────────────────────────
    const _nativeFetch = window.fetch;
    window.fetch = async function(resource, init = {}) {
      const url = typeof resource === 'string' ? resource : resource?.url || '';
      if (typeof url === 'string' && url.startsWith('/api/')) {
        init = init || {};
        init.headers = init.headers || {};
        const token = localStorage.getItem('cb_web_token') || '';
        if (token) {
          if (init.headers instanceof Headers) {
            if (!init.headers.has('Authorization')) init.headers.set('Authorization', 'Bearer ' + token);
          } else if (Array.isArray(init.headers)) {
            init.headers.push(['Authorization', 'Bearer ' + token]);
          } else {
            if (!init.headers['Authorization']) init.headers['Authorization'] = 'Bearer ' + token;
          }
        }
      }
      const res = await _nativeFetch(resource, init);
      if (res.status === 401 && typeof url === 'string' && url.startsWith('/api/') && !url.includes('/api/auth/')) {
        showAuthOverlay('访问受限或登录已过期，请输入控制台访问密码');
      }
      return res;
    };

    function showAuthOverlay(msg = '') {
      document.getElementById('authOverlay').style.display = 'flex';
      const errBox = document.getElementById('authErrorMsg');
      if (msg) {
        errBox.innerText = msg;
        errBox.style.display = 'block';
      } else {
        errBox.style.display = 'none';
      }
      const btnLogout = document.getElementById('btnLogoutBtn');
      if (btnLogout) btnLogout.style.display = 'none';
      setTimeout(() => {
        const inp = document.getElementById('authPasswordInput');
        if (inp) inp.focus();
      }, 100);
    }

    function hideAuthOverlay() {
      document.getElementById('authOverlay').style.display = 'none';
      const btnLogout = document.getElementById('btnLogoutBtn');
      if (btnLogout) btnLogout.style.display = 'inline-block';
    }

    async function submitAuthLogin() {
      const pwdInput = document.getElementById('authPasswordInput');
      const errBox = document.getElementById('authErrorMsg');
      const password = (pwdInput.value || '').trim();
      if (!password) {
        errBox.innerText = '请输入访问密码或 API Key';
        errBox.style.display = 'block';
        pwdInput.focus();
        return;
      }

      errBox.style.display = 'none';
      try {
        const res = await _nativeFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.ok) {
          localStorage.setItem('cb_web_token', data.token);
          pwdInput.value = '';
          hideAuthOverlay();
          startAppPolling();
        } else {
          errBox.innerText = data.error || '验证失败，密码错误';
          errBox.style.display = 'block';
          pwdInput.focus();
        }
      } catch (e) {
        errBox.innerText = '网络异常: ' + e.message;
        errBox.style.display = 'block';
      }
    }

    function logoutWebAuth() {
      if (!confirm('确定退出控制台并锁定访问吗？')) return;
      localStorage.removeItem('cb_web_token');
      stopAppPolling();
      showAuthOverlay('已成功退出登录，请输入访问密钥重新进入');
    }

    function startAppPolling() {
      loadMetrics(currentMetricsRange);
      loadAccounts();
      loadModels();
      loadSettings();
      loadLogDates().then(() => fetchLogs());
      stopAppPolling();
      pollIntervals.push(setInterval(() => loadMetrics(currentMetricsRange), 5000));
      pollIntervals.push(setInterval(() => loadAccounts(true), 5000));
      pollIntervals.push(setInterval(fetchLogs, 2500));
    }

    function stopAppPolling() {
      for (const t of pollIntervals) clearInterval(t);
      pollIntervals = [];
    }

    async function checkAuthAndInit() {
      try {
        const res = await _nativeFetch('/api/auth/status');
        const st = await res.json();
        if (!st.webAuthEnabled) {
          hideAuthOverlay();
          const btnLogout = document.getElementById('btnLogoutBtn');
          if (btnLogout) btnLogout.style.display = 'none';
          startAppPolling();
          return;
        }

        const savedToken = localStorage.getItem('cb_web_token');
        if (savedToken) {
          const verifyRes = await _nativeFetch('/api/auth/status', {
            headers: { 'Authorization': 'Bearer ' + savedToken }
          });
          const vData = await verifyRes.json();
          if (vData.authenticated) {
            hideAuthOverlay();
            startAppPolling();
            return;
          }
        }

        // 未登录或 token 无效，弹出授权框
        showAuthOverlay();
      } catch (e) {
        console.error('Auth status check error:', e);
        showAuthOverlay('无法连接到网关服务，请确认网关是否正常运行');
      }
    }

    let allLogs = [];
    let logCatFilter = 'ALL';
    let logLevelFilter = 'ALL';
    let autoScrollEnabled = true;

    // 页面切换路由
    const PAGE_CRUMBS = {
      overview: { title: '📊 报表统计概览', sub: '· 官方模型实时吞吐监控' },
      accounts: { title: '👥 账号池运维状态', sub: '· 账号健康度与实时并发削峰' },
      models: { title: '📋 官方模型矩阵', sub: '· 33款全量模型特性与探针' },
      docs: { title: '🔌 客户端接入指引', sub: '· Cursor / Claude Code / NextChat 接入' },
      logs: { title: '📜 实时运行日志与诊断', sub: '· 链路追踪与报错排查' },
      settings: { title: '⚙️ 系统与策略设置', sub: '· 并发保护与限流自动改道' }
    };


// ─── 基础通用转义与格式化工具 ───────────────────────────────────────────
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }


    function escapeAttr(str) {
      return String(str || '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;');
    }

    function fmtAgo(ts) {
      if (!ts) return '从未刷新';
      const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 5) return '刚刚';
      if (s < 60) return `${s} 秒前`;
      if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
      if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
      return `${Math.floor(s / 86400)} 天前`;
    }

    /** 手动强制刷新积分（忽略 30s 最小间隔，直接拉上游） */
