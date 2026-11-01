import fs from 'node:fs';
import crypto from 'node:crypto';
import { LOG_FILE_PATH } from '../config.mjs';

// ─── 统一诊断日志系统 (Logger & Ring Buffer) ─────────────────────────────
export class Logger {
  static ringBuffer = [];
  static maxBufferSize = 1000;

  static write(level, category, message, meta = null) {
    const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const id = crypto.randomUUID().slice(0, 8);
    const logItem = {
      id,
      time,
      level: level.toUpperCase(),
      category: category.toUpperCase(),
      message,
      meta
    };

    this.ringBuffer.unshift(logItem);
    if (this.ringBuffer.length > this.maxBufferSize) {
      this.ringBuffer.pop();
    }

    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    const line = `[${time}] [${logItem.level.padEnd(5)}] [${logItem.category}] ${message}${metaStr}\n`;

    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    fs.appendFile(LOG_FILE_PATH, line, () => {});
  }

  static info(category, message, meta) { this.write('info', category, message, meta); }
  static warn(category, message, meta) { this.write('warn', category, message, meta); }
  static error(category, message, meta) { this.write('error', category, message, meta); }

  static getLogs(limit = 250) {
    return this.ringBuffer.slice(0, limit);
  }

  static clear() {
    this.ringBuffer = [];
  }

  // ─── 日志保留策略：严格仅保留最近 3 天的日志流水 ─────────────────────
  static pruneOldLogs(retentionDays = 3) {
    if (!fs.existsSync(LOG_FILE_PATH)) return;
    try {
      const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const cutoffDateStr = new Date(cutoffTime).toISOString().slice(0, 10);
      const content = fs.readFileSync(LOG_FILE_PATH, 'utf8');
      const lines = content.split('\n');
      const retained = [];
      let prunedCount = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        const m = line.match(/^\[(\d{4}-\d{2}-\d{2})/);
        if (m) {
          if (m[1] >= cutoffDateStr) {
            retained.push(line);
          } else {
            prunedCount++;
          }
        } else {
          if (retained.length > 0) retained.push(line);
        }
      }

      if (prunedCount > 0) {
        fs.writeFileSync(LOG_FILE_PATH, retained.join('\n') + '\n', 'utf8');
        this.info('SYSTEM', `日志轮转清理完成：已裁剪清除 3 天前的过期日志 (共清理 ${prunedCount} 行，保留最近 ${retentionDays} 天)`);
      }

      // 同时清理内存环形缓冲区中的过期记录
      this.ringBuffer = this.ringBuffer.filter(item => {
        const itemDate = (item.time || '').slice(0, 10);
        return !itemDate || itemDate >= cutoffDateStr;
      });
    } catch (_) {}
  }
}
