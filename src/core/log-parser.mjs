import fs from 'node:fs';
import { LOG_FILE_PATH } from '../config.mjs';

export function rebuildRealStatsFromLog() {
  if (!fs.existsSync(LOG_FILE_PATH)) {
    return null;
  }
  const lines = fs.readFileSync(LOG_FILE_PATH, 'utf8').split('\n');

  let totalRequests = 0;
  let successRequests = 0;
  let failedRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const daily = {};
  const models = {};
  const accounts = {};

  let currentAcc = { uid: '18948117020', name: '小宝' };

  for (const line of lines) {
    if (!line.trim()) continue;
    const timeMatch = line.match(/^\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]/);
    if (!timeMatch) continue;
    const date = timeMatch[1];

    const dispatchMatch = line.match(/(?:调度选中账号|精准路由至网关全局指定账号|粘性会话复用账号)\s+\[([^\]]+?)(?:\s*\(([^)]+)\))?\]/);
    if (dispatchMatch) {
      const name = dispatchMatch[1].trim();
      const uid = dispatchMatch[2] ? dispatchMatch[2].trim() : name;
      currentAcc = { uid, name };
    }

    if (line.includes('收到 OpenAI 对话请求') || line.includes('收到 Claude Code 协议请求')) {
      totalRequests++;
      const modelMatch = line.match(/(?:对话请求|协议请求)\s+\[([a-zA-Z0-9.\-_]+)\]/);
      const model = modelMatch ? modelMatch[1] : 'deepseek-v4.1-flash';

      let msgCount = 1;
      const msgMatch = line.match(/"messagesCount":(\d+)/);
      if (msgMatch) msgCount = parseInt(msgMatch[1], 10);
      const estimatedInput = Math.max(20, msgCount * 150);
      totalInputTokens += estimatedInput;

      if (!daily[date]) {
        daily[date] = { requests: 0, successRequests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, models: {}, accounts: {} };
      }
      daily[date].requests++;
      daily[date].inputTokens += estimatedInput;
      daily[date].totalTokens += estimatedInput;

      if (!daily[date].models) daily[date].models = {};
      if (!daily[date].models[model]) {
        daily[date].models[model] = { name: model, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      daily[date].models[model].requests++;
      daily[date].models[model].inputTokens += estimatedInput;
      daily[date].models[model].totalTokens += estimatedInput;

      if (!models[model]) {
        models[model] = { name: model, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      models[model].requests++;
      models[model].inputTokens += estimatedInput;
      models[model].totalTokens += estimatedInput;

      const accKey = currentAcc.uid || currentAcc.name;
      if (!daily[date].accounts) daily[date].accounts = {};
      if (!daily[date].accounts[accKey]) {
        daily[date].accounts[accKey] = { uid: currentAcc.uid, name: currentAcc.name, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      daily[date].accounts[accKey].requests++;
      daily[date].accounts[accKey].inputTokens += estimatedInput;
      daily[date].accounts[accKey].totalTokens += estimatedInput;

      if (!accounts[accKey]) {
        accounts[accKey] = { uid: currentAcc.uid, name: currentAcc.name, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      accounts[accKey].requests++;
      accounts[accKey].inputTokens += estimatedInput;
      accounts[accKey].totalTokens += estimatedInput;
    }

    if (line.includes('流式输出完成') || line.includes('流式回复完成') || line.includes('非流式完成') || line.includes('非流式回复完成')) {
      successRequests++;
      const durationMatch = line.match(/耗时\s+(\d+)ms/);
      const duration = durationMatch ? parseInt(durationMatch[1], 10) : 1000;
      const estimatedOutput = Math.max(15, Math.round(duration / 15));
      totalOutputTokens += estimatedOutput;

      const modelMatch = line.match(/(?:输出完成|回复完成)\s+\[([a-zA-Z0-9.\-_]+)\]/);
      const model = modelMatch ? modelMatch[1] : 'deepseek-v4.1-flash';

      const accMatch = line.match(/账号:\s*\[([^\]]+)\]/);
      let accKey = currentAcc.uid;
      if (accMatch) {
        const accName = accMatch[1].trim();
        for (const k of Object.keys(accounts)) {
          if (accounts[k].name === accName) {
            accKey = k;
            break;
          }
        }
      }

      if (daily[date]) {
        daily[date].successRequests++;
        daily[date].outputTokens += estimatedOutput;
        daily[date].totalTokens += estimatedOutput;

        if (!daily[date].models) daily[date].models = {};
        if (!daily[date].models[model]) {
          daily[date].models[model] = { name: model, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        }
        daily[date].models[model].successRequests++;
        daily[date].models[model].outputTokens += estimatedOutput;
        daily[date].models[model].totalTokens += estimatedOutput;

        if (!daily[date].accounts) daily[date].accounts = {};
        if (!daily[date].accounts[accKey]) {
          daily[date].accounts[accKey] = { uid: accKey, name: currentAcc.name, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        }
        daily[date].accounts[accKey].successRequests++;
        daily[date].accounts[accKey].outputTokens += estimatedOutput;
        daily[date].accounts[accKey].totalTokens += estimatedOutput;
      }

      if (models[model]) {
        models[model].successRequests++;
        models[model].outputTokens += estimatedOutput;
        models[model].totalTokens += estimatedOutput;
      }

      if (!accounts[accKey]) {
        accounts[accKey] = { uid: accKey, name: currentAcc.name, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      accounts[accKey].successRequests++;
      accounts[accKey].outputTokens += estimatedOutput;
      accounts[accKey].totalTokens += estimatedOutput;
    }

    if (line.includes('[ERROR]') && (line.includes('上游报错') || line.includes('处理对话请求异常') || line.includes('处理请求异常'))) {
      failedRequests++;
      if (daily[date]) daily[date].failedRequests++;
    }
  }

  return {
    summary: {
      totalRequests,
      successRequests,
      failedRequests,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens
    },
    models,
    daily,
    accounts
  };
}
