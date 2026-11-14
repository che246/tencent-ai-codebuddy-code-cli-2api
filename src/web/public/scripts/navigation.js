// ─── 页面导航与接入指南切换 ────────────────────────────────────────────────
    function switchPage(pageKey, el) {
      document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => item.classList.remove('active'));
      if (el) el.classList.add('active');
      document.querySelectorAll('.page-section').forEach(sec => sec.classList.remove('active'));
      const targetSec = document.getElementById('page-' + pageKey);
      if (targetSec) targetSec.classList.add('active');

      const crumb = PAGE_CRUMBS[pageKey] || { title: '控制台', sub: '' };
      document.getElementById('pageCrumbTitle').innerText = crumb.title;
      document.getElementById('pageCrumbSub').innerText = crumb.sub;

      if (pageKey === 'overview') loadMetrics(currentMetricsRange);
      if (pageKey === 'accounts') {
        // 切到账号页时：若距上次进入已超过阈值，触发一次按需刷新积分，
        // 避免看到的是最多 5 分钟前的旧数据。
        if (Date.now() - lastAccountsEnterAt > CREDITS_STALE_MS) {
          creditsForceNext = true;
        }
        lastAccountsEnterAt = Date.now();
        loadAccounts();
      }
      if (pageKey === 'models') loadModels();
      if (pageKey === 'logs') { loadLogDates().then(() => fetchLogs()); }
      if (pageKey === 'settings') loadSettings();
    }

    const guides = {
      openai: `# OpenAI 兼容客户端配置 (如 Cursor / NextChat / Chatbox / LobeChat)
Base URL: http://127.0.0.1:{{PORT}}/v1
API Key : {{API_KEY}}

# 模型名支持区域前缀：cn: 走国内版，intl: 走国际版（不带前缀则按账号池自动路由）
常用模型:
  cn:deepseek-v4.1-flash   (国内版, 100万上下文/思考模式)
  cn:hy4-preview
  intl:deepseek-v4.1-flash-sg
  intl:gpt-6-astra         (国际版专属, 需国际版付费等级)
  intl:grok-4.7
完整列表: GET http://127.0.0.1:{{PORT}}/v1/models`,
      claude: `# Claude Code 官方命令行原生适配 (零配置直连)
export ANTHROPIC_BASE_URL=http://127.0.0.1:{{PORT}}
export ANTHROPIC_API_KEY={{API_KEY}}
export ANTHROPIC_MODEL=cn:deepseek-v4.1-flash
# 国际版账号可换成: intl:deepseek-v4.1-flash-sg

claude`,
      search: `# 官方免费服务端联网检索与抓取
curl http://127.0.0.1:{{PORT}}/v1/search \\
  -H "Authorization: Bearer {{API_KEY}}" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "腾讯云 CodeBuddy", "max_results": 3}'`,
      curl: `# 终端 cURL 快速测试 (带思维链与客户端工具)
curl http://127.0.0.1:{{PORT}}/v1/chat/completions \\
  -H "Authorization: Bearer {{API_KEY}}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"cn:deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}],"stream":false}'

# 国际版账号（需该账号有对应模型权限）
curl http://127.0.0.1:{{PORT}}/v1/chat/completions \\
  -H "Authorization: Bearer {{API_KEY}}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"intl:deepseek-v4.1-flash-sg","messages":[{"role":"user","content":"你好"}],"stream":false}'`
    };

    function switchGuide(type, el) {
      document.querySelectorAll('.guide-tab-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('guideCodeText').innerText = guides[type];
    }
    document.getElementById('guideCodeText').innerText = guides.openai;

    function copyCurrentGuide() {
      const txt = document.getElementById('guideCodeText')?.innerText || '';
      copyToClipboard(txt, '接入配置代码已复制到剪贴板！');
    }

    // 锁定全局暗黑模式，清除历史遗留的 light 本地存储
    try {
      localStorage.removeItem('theme');
    } catch (_) {}
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');

    let currentSettings = { concurrencyLimitEnabled: true, maxInFlightPerAccount: 3, modelFallbackEnabled: true, accountFailoverEnabled: true, routingStrategy: 'least-inflight' };
    let currentBlacklist = [];      // 已保存的模型黑名单规则（服务端返回）


    function toggleAutoScroll() {
      autoScrollEnabled = !autoScrollEnabled;
      document.getElementById('btnAutoScroll').innerText = autoScrollEnabled ? '⏸ 滚动锁定: 开' : '▶ 滚动锁定: 关';
    }

