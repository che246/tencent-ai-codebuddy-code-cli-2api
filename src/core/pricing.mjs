import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, SEARCH_URL, USER_AGENT, formatAccountFullDesc } from '../config.mjs';
import { AccountScheduler } from './scheduler.mjs';
import { Logger } from './logger.mjs';

export const PRICING_FILE_PATH = path.resolve(ROOT_DIR, 'pricing.json');

// ─── 各大模型官网真实标准单价基准库 (单位: 人民币 元 / 1M Tokens = 100万 Tokens) ────
// 数据源对齐: DeepSeek官网(deepseek.com), 智谱开放平台(bigmodel.cn), 月之暗面(moonshot.cn), 腾讯混元(cloud.tencent.com), MiniMax
// 严格包含【输入基础单价】、【缓存命中(Cache Hit)优惠单价】与【输出单价】
export const DEFAULT_OFFICIAL_PRICES = {
  // DeepSeek 官方系列 (官方缓存命中享受 75% 优惠，仅需 ¥0.50/M)
  'deepseek-v4.1-flash': { input: 1.00, cacheHit: 0.50, output: 2.00, name: 'DeepSeek-V4.1-Flash', vendor: 'DeepSeek官网', note: '官网定价: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M' },
  'deepseek-v4-flash':   { input: 1.00, cacheHit: 0.50, output: 2.00, name: 'DeepSeek-V4-Flash',   vendor: 'DeepSeek官网', note: '官网定价: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M' },
  'deepseek-v4-pro':     { input: 4.00, cacheHit: 1.00, output: 16.00, name: 'DeepSeek-V4-Pro',   vendor: 'DeepSeek官网', note: '官网定价: 输入 ¥4.00/M (缓存命中 ¥1.00/M), 输出 ¥16.00/M' },
  'deepseek-v3-2-volc':  { input: 2.00, cacheHit: 0.50, output: 8.00,  name: 'DeepSeek-V3.2',      vendor: '火山/深度求索', note: '标准价: 输入 ¥2.00/M (缓存命中 ¥0.50/M), 输出 ¥8.00/M' },

  // 智谱 GLM 官方系列 (bigmodel.cn，官方公布缓存命中单价低至 ¥0.57/M)
  'glm-5.3-flash':       { input: 0.80, cacheHit: 0.57, output: 2.80,  name: 'GLM-5.3-Flash',      vendor: '智谱AI开放平台', note: '官方开放平台: 输入 ¥0.80/M (缓存命中 ¥0.57/M), 输出 ¥2.80/M' },
  'glm-5.3':             { input: 5.00, cacheHit: 2.00, output: 5.00,  name: 'GLM-5.3',            vendor: '智谱AI开放平台', note: '旗舰级: 输入 ¥5.00/M (缓存命中 ¥2.00/M), 输出 ¥5.00/M' },
  'glm-5.2':             { input: 8.00, cacheHit: 2.00, output: 28.00, name: 'GLM-5.2',            vendor: '智谱AI开放平台', note: '旗舰超长: 输入 ¥8.00/M (缓存命中 ¥2.00/M), 输出 ¥28.00/M' },
  'glm-5.0':             { input: 6.00, cacheHit: 1.50, output: 24.00, name: 'GLM-5.0',            vendor: '智谱AI开放平台', note: '标准价: 输入 ¥6.00/M (缓存命中 ¥1.50/M), 输出 ¥24.00/M' },
  'glm-5.0-turbo':       { input: 5.00, cacheHit: 2.00, output: 5.00,  name: 'GLM-5.0-Turbo',      vendor: '智谱AI开放平台', note: '极速旗舰: 输入 ¥5.00/M (缓存命中 ¥2.00/M), 输出 ¥5.00/M' },
  'glm-4.7':             { input: 1.00, cacheHit: 0.50, output: 2.00,  name: 'GLM-4.7',            vendor: '智谱AI开放平台', note: '轻量经济: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M' },
  'glm-4.6':             { input: 1.00, cacheHit: 0.50, output: 2.00,  name: 'GLM-4.6',            vendor: '智谱AI开放平台', note: '轻量经济: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M' },
  'glm-4.6v':            { input: 0.80, cacheHit: 0.50, output: 2.80,  name: 'GLM-4.6V (视觉)',    vendor: '智谱AI开放平台', note: '多模态视觉: 输入 ¥0.80/M (缓存命中 ¥0.50/M), 输出 ¥2.80/M' },

  // 月之暗面 Kimi 官方系列 (moonshot.cn，前缀缓存命中低至 1~2折)
  'kimi-k3-1':           { input: 12.00, cacheHit: 2.40, output: 12.00, name: 'Kimi-K3',          vendor: '月之暗面开放平台', note: 'K3 旗舰1M: 输入 ¥12.00/M (缓存命中 ¥2.40/M), 输出 ¥12.00/M' },
  'kimi-k3.1-pro':       { input: 12.00, cacheHit: 2.40, output: 12.00, name: 'Kimi-K3.1-Pro',    vendor: '月之暗面开放平台', note: 'K3.1 Pro: 输入 ¥12.00/M (缓存命中 ¥2.40/M), 输出 ¥12.00/M' },
  'kimi-k2.8-preview':   { input: 8.00,  cacheHit: 1.60, output: 8.00,  name: 'Kimi-K2.8',         vendor: '月之暗面开放平台', note: 'K2.8 预览: 输入 ¥8.00/M (缓存命中 ¥1.60/M), 输出 ¥8.00/M' },
  'kimi-k2.5':           { input: 3.00,  cacheHit: 0.70, output: 9.00,  name: 'Kimi-K2.5',         vendor: '月之暗面开放平台', note: 'K2.5 均衡: 输入 ¥3.00/M (缓存命中 ¥0.70/M), 输出 ¥9.00/M' },
  'kimi-k2-thinking':    { input: 4.00,  cacheHit: 1.00, output: 16.00, name: 'Kimi-K2-Thinking', vendor: '月之暗面开放平台', note: '深度思考版: 输入 ¥4.00/M (缓存命中 ¥1.00/M), 输出 ¥16.00/M' },

  // MiniMax 官方系列 (minimax.io)
  'minimax-m2.5':        { input: 1.00, cacheHit: 0.50, output: 2.00,  name: 'MiniMax-M2.5',       vendor: 'MiniMax开放平台', note: '标准价: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M' },
  'minimax-m2.7':        { input: 1.00, cacheHit: 0.50, output: 2.00,  name: 'MiniMax-M2.7',       vendor: 'MiniMax开放平台', note: '标准价: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M' },
  'minimax-m3.1-flash':  { input: 0.80, cacheHit: 0.40, output: 2.00,  name: 'MiniMax-M3.1-Flash', vendor: 'MiniMax开放平台', note: '极速版: 输入 ¥0.80/M (缓存命中 ¥0.40/M), 输出 ¥2.00/M' },

  // 腾讯混元与自研系列 (cloud.tencent.com)
  'hy3':                 { input: 0.00, cacheHit: 0.00, output: 0.00,  name: '混元大模型3 (hy3)',  vendor: '腾讯云官方',   note: '官方限免: ¥0.00 / 1M tokens' },
  'hy4free':             { input: 0.00, cacheHit: 0.00, output: 0.00,  name: '混元4试用 (hy4free)',vendor: '腾讯云官方',   note: '官方试用: ¥0.00 / 1M tokens' },
  'hy3-x':               { input: 0.50, cacheHit: 0.25, output: 1.00,  name: '混元3增强 (hy3-x)',  vendor: '腾讯云官方',   note: '低倍率自研: 输入 ¥0.50/M (缓存命中 ¥0.25/M), 输出 ¥1.00/M' },
  'hy4std':              { input: 2.00, cacheHit: 1.00, output: 4.00,  name: '混元4标准 (hy4std)', vendor: '腾讯云官方',   note: '混元4旗舰: 输入 ¥2.00/M (缓存命中 ¥1.00/M), 输出 ¥4.00/M' },
  'hy4-preview-x':       { input: 2.00, cacheHit: 1.00, output: 4.00,  name: '混元4预览 (hy4-preview)', vendor: '腾讯云官方', note: '混元4旗舰: 输入 ¥2.00/M (缓存命中 ¥1.00/M), 输出 ¥4.00/M' },
  'hunyuan-chat':        { input: 2.00, cacheHit: 1.00, output: 4.00,  name: '腾讯混元对话',       vendor: '腾讯云官方',   note: '腾讯云标准: 输入 ¥2.00/M (缓存命中 ¥1.00/M), 输出 ¥4.00/M' },

  // 阶跃星辰与其它
  'step-5-preview':      { input: 4.00, cacheHit: 1.00, output: 12.00, name: '阶跃星辰 Step-5',    vendor: '阶跃星辰开放平台', note: 'Step-5: 输入 ¥4.00/M (缓存命中 ¥1.00/M), 输出 ¥12.00/M' },
  'mimo-v2.6-pro':       { input: 2.00, cacheHit: 0.50, output: 8.00,  name: 'MIMO-V2.6-Pro',      vendor: 'MIMO智能平台', note: '标准价: 输入 ¥2.00/M (缓存命中 ¥0.50/M), 输出 ¥8.00/M' },

  // 通用/缺省模型
  'default':             { input: 2.00, cacheHit: 0.50, output: 4.00,  name: 'Default 官方通用',  vendor: '官方参考基准', note: '基准价: 输入 ¥2.00/M (缓存命中 ¥0.50/M), 输出 ¥4.00/M' }
};

let cachedCustomPrices = null;

export function loadModelPrices() {
  if (cachedCustomPrices) return cachedCustomPrices;
  let custom = {};
  if (fs.existsSync(PRICING_FILE_PATH)) {
    try {
      custom = JSON.parse(fs.readFileSync(PRICING_FILE_PATH, 'utf8'));
    } catch (_) {}
  }
  cachedCustomPrices = { ...DEFAULT_OFFICIAL_PRICES, ...custom };
  return cachedCustomPrices;
}

export function saveModelPrices(newPrices) {
  cachedCustomPrices = { ...loadModelPrices(), ...newPrices };
  try {
    fs.writeFileSync(PRICING_FILE_PATH, JSON.stringify(cachedCustomPrices, null, 2), 'utf8');
  } catch (_) {}
  return cachedCustomPrices;
}

/**
 * 计算单个模型的真实用量估算价值 (以人民币元计)
 * 优先采用上游返回的真实 cachedTokens，无真实标记时采用长效 Prompt 缓存典型 80% 测算
 */
export function calculateModelUsageCost(modelId, inputTokens = 0, outputTokens = 0, actualCachedTokens = null) {
  const prices = loadModelPrices();
  const rule = prices[modelId] || prices['default'] || { input: 1.5, cacheHit: 0.5, output: 3.0, vendor: '官方基准估算', note: '参考公网大模型标准计费' };

  const inputMillion = (inputTokens || 0) / 1000000;
  const outputMillion = (outputTokens || 0) / 1000000;

  const inputPrice = rule.input || 0;
  const cacheHitPrice = rule.cacheHit !== undefined ? rule.cacheHit : (inputPrice * 0.5);
  const outputPrice = rule.output || 0;

  // 1. 全量无缓存标准价值 (未考虑缓存优化的原始总价值)
  const standardInputCost = inputMillion * inputPrice;
  const outputCost = outputMillion * outputPrice;
  const standardTotalCost = standardInputCost + outputCost;

  // 2. 考虑 Prompt 缓存命中 (优先读取上游真实返回的 cachedTokens，无真实命中记录时按 Agent 典型 80% 测算)
  let cachedTotalCost = 0;
  let isRealCache = false;
  let hitTokens = 0;

  if (typeof actualCachedTokens === 'number' && actualCachedTokens > 0) {
    isRealCache = true;
    hitTokens = Math.min(inputTokens, actualCachedTokens);
    const missTokens = Math.max(0, inputTokens - hitTokens);
    const hitCost = (hitTokens / 1000000) * cacheHitPrice;
    const missCost = (missTokens / 1000000) * inputPrice;
    cachedTotalCost = hitCost + missCost + outputCost;
  } else {
    // 默认按照长效 Prompt 缓存基准 (典型 80% 命中) 估算
    const defaultCacheRate = 0.8;
    hitTokens = Math.round(inputTokens * defaultCacheRate);
    const cachedHitInputCost = (inputMillion * defaultCacheRate) * cacheHitPrice;
    const missedInputCost = (inputMillion * (1 - defaultCacheRate)) * inputPrice;
    cachedTotalCost = cachedHitInputCost + missedInputCost + outputCost;
  }

  // 3. 提示词缓存所产生的节省价值
  const savedCost = Math.max(0, standardTotalCost - cachedTotalCost);
  const realHitRate = inputTokens > 0 ? (((hitTokens) / inputTokens) * 100).toFixed(1) + '%' : '0%';

  return {
    modelId,
    // 标准无缓存计费
    standardCost: standardTotalCost,
    totalCost: standardTotalCost, // 默认兼容字段
    inputCost: standardInputCost,
    outputCost,
    costDisplay: formatCurrency(standardTotalCost),

    // 缓存命中实际折算
    cachedCost: cachedTotalCost,
    cachedCostDisplay: formatCurrency(cachedTotalCost),
    savedCost,
    savedCostDisplay: formatCurrency(savedCost),
    savingsPercent: standardTotalCost > 0 ? (((savedCost) / standardTotalCost) * 100).toFixed(1) + '%' : '0%',
    hitTokens,
    realHitRate,
    isRealCache,

    // 价格明细规则
    inputPricePerM: inputPrice,
    cacheHitPricePerM: cacheHitPrice,
    outputPricePerM: outputPrice,
    vendor: rule.vendor || '官方',
    note: rule.note || `输入 ¥${inputPrice}/M (缓存 ¥${cacheHitPrice}/M), 输出 ¥${outputPrice}/M`
  };
}

/**
 * 格式化货币展示金额
 */
export function formatCurrency(amount) {
  if (typeof amount !== 'number' || isNaN(amount) || amount === 0) return '¥0.00';
  if (amount >= 10000) {
    return `¥${(amount / 10000).toFixed(2)}万`;
  }
  if (amount >= 1) {
    return `¥${amount.toFixed(2)}`;
  }
  if (amount >= 0.01) {
    return `¥${amount.toFixed(3)}`;
  }
  return `¥${amount.toFixed(4)}`;
}

/**
 * 基于网关已配置的官方联网检索功能 (/v1/search)，检索并提取各模型最新的官网定价信息
 */
export async function searchOfficialPricingOnline(keyword = '大模型 API 官方价格') {
  const acc = AccountScheduler.selectAccount();
  if (!acc || !acc.accessToken) {
    throw new Error('当前账号池暂无可用健康账号执行联网检索');
  }

  const queries = [
    `${keyword} DeepSeek 官方 API 价格 1M tokens`,
    `${keyword} 智谱 GLM-5 GLM-4 API 定价 百万tokens`,
    `${keyword} Kimi 月之暗面 API 价格 1M tokens`
  ];

  const searchResults = [];

  for (const q of queries) {
    try {
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: q, max_results: 3 })
      });
      if (res.ok) {
        const data = await res.json();
        searchResults.push({
          query: q,
          results: data.results || []
        });
      }
    } catch (e) {
      Logger.warn('SEARCH', `联网检索模型定价异常 [${q}]: ${e.message}`);
    }
  }

  return {
    searchedAt: new Date().toISOString(),
    account: formatAccountFullDesc(acc),
    results: searchResults,
    currentRules: loadModelPrices()
  };
}
