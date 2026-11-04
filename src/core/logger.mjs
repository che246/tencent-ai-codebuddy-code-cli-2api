import fs from 'node:fs';
import crypto from 'node:crypto';
import { LOG_FILE_PATH, getLocalTimeString } from '../config.mjs';
import { LogDatabase } from './database.mjs';

// ─── 统一诊断日志系统 (Logger & SQLite Database) ───────────────────────────
export class Logger {
  static ringBuffer = [];
  static maxBufferSize = 1000;

  static write(level, category, message, meta = null) {
    const time = getLocalTimeString();
    const date = time.slice(0, 10);
    const id = crypto.randomUUID().slice(0, 8);
    const logItem = {
      id,
      time,
      date,
      level: level.toUpperCase(),
      category: category.toUpperCase(),
      message,
      meta
    };

    // 1. 写入 SQLite 数据库持久化存储
    LogDatabase.insertLog(logItem);

    // 2. 写入内存环形缓冲区 (保留最近 1000 条热数据)
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

  static getLogs({ date = null, level = null, category = null, search = null, limit = 200, offset = 0 } = {}) {
    const dbRes = LogDatabase.queryLogs({ date, level, category, search, limit, offset });
    if (dbRes && dbRes.logs && dbRes.logs.length > 0) {
      return dbRes;
    }
    // 内存兜底
    let filtered = this.ringBuffer;
    if (date && date !== 'ALL') filtered = filtered.filter(l => (l.date || l.time?.slice(0, 10)) === date);
    if (level && level !== 'ALL') filtered = filtered.filter(l => l.level === level.toUpperCase());
    if (category && category !== 'ALL') filtered = filtered.filter(l => l.category === category.toUpperCase());
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(l => (l.message || '').toLowerCase().includes(q));
    }
    return {
      total: filtered.length,
      logs: filtered.slice(offset, offset + limit)
    };
  }

  static getDates() {
    const dbDates = LogDatabase.getDates();
    if (dbDates && dbDates.length > 0) return dbDates;
    const dateSet = new Set();
    for (const l of this.ringBuffer) {
      const d = l.date || l.time?.slice(0, 10);
      if (d) dateSet.add(d);
    }
    return Array.from(dateSet).sort().reverse();
  }

  static clear() {
    this.ringBuffer = [];
    LogDatabase.clearLogs();
  }

  // ─── 日志保留策略：保留指定天数，并根据 MB 上限自动收缩释放磁盘 ─────────────────────
  static pruneOldLogs(retentionDays = 3) {
    LogDatabase.pruneOldLogs(retentionDays);
    LogDatabase.checkAndPruneBySize();
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
