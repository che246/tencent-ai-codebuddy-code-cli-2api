import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT_DIR, LOG_FILE_PATH, config } from '../config.mjs';

const require = createRequire(import.meta.url);
export const DB_PATH = path.resolve(ROOT_DIR, 'logs.db');

class LogDatabaseEngine {
  constructor() {
    this.sqliteDb = null;
    this.useSqlite = false;
    this.insertCount = 0;
    this.init();
  }

  init() {
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.sqliteDb = new DatabaseSync(DB_PATH);
      this.useSqlite = true;

      // 开启 WAL (Write-Ahead Logging) 模式与 NORMAL 同步：读写不互斥，写入吞吐量提升 10 倍以上
      this.sqliteDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
      `);

      this.sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          time TEXT,
          date TEXT,
          level TEXT,
          category TEXT,
          message TEXT,
          meta TEXT,
          created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date);
        CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
        CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);

        -- [网关自有策略] 账号积分变动历史留痕表
        CREATE TABLE IF NOT EXISTS credit_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER,
          time TEXT,
          date TEXT,
          account_uid TEXT,
          account_name TEXT,
          delta REAL,
          balance REAL,
          description TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_credit_history_created_at ON credit_history(created_at);
        CREATE INDEX IF NOT EXISTS idx_credit_history_uid ON credit_history(account_uid);
      `);

      this.insertStmt = this.sqliteDb.prepare(`
        INSERT INTO logs (time, date, level, category, message, meta, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      this.insertCreditStmt = this.sqliteDb.prepare(`
        INSERT INTO credit_history (created_at, time, date, account_uid, account_name, delta, balance, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // 首次初始化：若数据库为空且本地存在 gateway.log，自动无感迁移预热历史日志
      this.migrateFromGatewayLogIfEmpty();

    } catch (e) {
      this.useSqlite = false;
      this.sqliteDb = null;
    }
  }

  migrateFromGatewayLogIfEmpty() {
    if (!this.useSqlite || !this.sqliteDb) return;
    try {
      const countRes = this.sqliteDb.prepare('SELECT count(*) as total FROM logs').get();
      if (countRes && countRes.total > 0) return;

      if (fs.existsSync(LOG_FILE_PATH)) {
        const content = fs.readFileSync(LOG_FILE_PATH, 'utf8');
        const lines = content.split('\n');

        this.sqliteDb.exec('BEGIN TRANSACTION');
        for (const line of lines) {
          if (!line.trim()) continue;
          const m = line.match(/^\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]\s+\[([A-Z]+)\s*\]\s+\[([A-Z0-9_\-]+)\]\s+(.*)$/);
          if (m) {
            const date = m[1];
            const time = `${m[1]} ${m[2]}`;
            const level = m[3].trim();
            const category = m[4].trim();
            let rawMsg = m[5];
            let meta = null;
            if (rawMsg.includes(' | {')) {
              const parts = rawMsg.split(' | {');
              rawMsg = parts[0];
              meta = '{' + parts.slice(1).join(' | {');
            }
            this.insertStmt.run(time, date, level, category, rawMsg, meta, Date.now());
          }
        }
        this.sqliteDb.exec('COMMIT');
      }
    } catch (_) {}
  }

  insertLog({ time, date, level, category, message, meta = null }) {
    const metaStr = meta ? (typeof meta === 'object' ? JSON.stringify(meta) : String(meta)) : null;
    if (this.useSqlite && this.insertStmt) {
      try {
        this.insertStmt.run(time, date, level.toUpperCase(), category.toUpperCase(), message, metaStr, Date.now());
        this.insertCount++;
        // 每 100 次写入检测一次物理文件大小是否超限
        if (this.insertCount % 100 === 0) {
          this.checkAndPruneBySize();
        }
        return;
      } catch (_) {}
    }
  }

  getSizeBytes() {
    if (!fs.existsSync(DB_PATH)) return 0;
    try {
      return fs.statSync(DB_PATH).size;
    } catch (_) {
      return 0;
    }
  }

  getSizeMb() {
    const bytes = this.getSizeBytes();
    return Number((bytes / (1024 * 1024)).toFixed(2));
  }

  // ─── 数据库大小熔断机制：超过上限 MB 则删除最久记录，并 VACUUM 紧凑收缩至 50% ───
  checkAndPruneBySize(maxSizeMb = null) {
    if (!this.useSqlite || !this.sqliteDb) return { ok: false, reason: 'sqlite_unavailable' };
    if (!fs.existsSync(DB_PATH)) return { ok: false, reason: 'file_not_found' };

    const limitMb = (typeof maxSizeMb === 'number' && maxSizeMb > 0) ? maxSizeMb : (config.maxLogDbSizeMb || 30);
    const maxBytes = limitMb * 1024 * 1024;
    const targetBytes = Math.floor(maxBytes / 2); // 目标回落到设置大小的一半 (50%)

    const initialSize = this.getSizeBytes();
    if (initialSize <= maxBytes) {
      return { ok: true, pruned: false, beforeBytes: initialSize, afterBytes: initialSize, limitMb, targetBytes };
    }

    let iterations = 0;
    let deletedRowsTotal = 0;
    const maxIterations = 20;

    while (iterations < maxIterations) {
      iterations++;
      const curSize = this.getSizeBytes();
      if (curSize <= targetBytes) break;

      const countRes = this.sqliteDb.prepare('SELECT count(*) as total FROM logs').get();
      const totalRows = countRes?.total || 0;
      if (totalRows <= 10) break; // 保护保留至少最新 10 条日志

      const excessRatio = Math.max(0.1, Math.min(0.8, (curSize - targetBytes) / curSize));
      const batchDeleteCount = Math.max(200, Math.floor(totalRows * excessRatio));

      const delStmt = this.sqliteDb.prepare(`
        DELETE FROM logs WHERE id IN (
          SELECT id FROM logs ORDER BY id ASC LIMIT ?
        )
      `);
      delStmt.run(batchDeleteCount);
      deletedRowsTotal += batchDeleteCount;

      // 执行 VACUUM 释放物理磁盘空间
      this.sqliteDb.exec('VACUUM');
    }

    const finalSize = this.getSizeBytes();
    return {
      ok: true,
      pruned: true,
      deletedRows: deletedRowsTotal,
      beforeBytes: initialSize,
      beforeMb: Number((initialSize / 1024 / 1024).toFixed(2)),
      afterBytes: finalSize,
      afterMb: Number((finalSize / 1024 / 1024).toFixed(2)),
      limitMb,
      targetMb: Number((targetBytes / 1024 / 1024).toFixed(2))
    };
  }

  queryLogs({ date = null, level = null, category = null, search = null, limit = 200, offset = 0 } = {}) {
    if (this.useSqlite && this.sqliteDb) {
      try {
        const conditions = [];
        const params = [];

        if (date && date !== 'ALL') {
          conditions.push('date = ?');
          params.push(date);
        }
        if (level && level !== 'ALL') {
          conditions.push('level = ?');
          params.push(level.toUpperCase());
        }
        if (category && category !== 'ALL') {
          conditions.push('category = ?');
          params.push(category.toUpperCase());
        }
        if (search && search.trim()) {
          conditions.push('(message LIKE ? OR meta LIKE ?)');
          const kw = `%${search.trim()}%`;
          params.push(kw, kw);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countSql = `SELECT count(*) as total FROM logs ${whereClause}`;
        const total = this.sqliteDb.prepare(countSql).get(...params)?.total || 0;

        const dataSql = `SELECT * FROM logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`;
        const rows = this.sqliteDb.prepare(dataSql).all(...params, limit, offset);

        const logs = rows.map(r => ({
          id: String(r.id),
          time: r.time,
          date: r.date,
          level: r.level,
          category: r.category,
          message: r.message,
          meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch (_) { return r.meta; } })() : null
        }));

        return { total, logs };
      } catch (_) {}
    }
    return { total: 0, logs: [] };
  }

  getDates() {
    if (this.useSqlite && this.sqliteDb) {
      try {
        const rows = this.sqliteDb.prepare('SELECT DISTINCT date FROM logs WHERE date IS NOT NULL ORDER BY date DESC').all();
        return rows.map(r => r.date).filter(Boolean);
      } catch (_) {}
    }
    return [];
  }

  clearLogs() {
    if (this.useSqlite && this.sqliteDb) {
      try {
        this.sqliteDb.exec('DELETE FROM logs');
        this.sqliteDb.exec('VACUUM');
      } catch (_) {}
    }
  }

  pruneLogsByTime({ mode = 'today_only', keepDays = 1 } = {}) {
    if (!this.useSqlite || !this.sqliteDb) return { ok: false, reason: 'sqlite_unavailable' };
    try {
      const today = new Date().toISOString().slice(0, 10);
      let deletedRows = 0;
      let cutoffDate = today;

      if (mode === 'all') {
        const c = this.sqliteDb.prepare('SELECT count(*) as total FROM logs').get();
        deletedRows = c?.total || 0;
        this.sqliteDb.exec('DELETE FROM logs');
      } else {
        if (mode === 'days') {
          const days = Math.max(1, parseInt(keepDays, 10) || 1);
          const cutoffTime = Date.now() - (days - 1) * 24 * 60 * 60 * 1000;
          cutoffDate = new Date(cutoffTime).toISOString().slice(0, 10);
        }
        const c = this.sqliteDb.prepare('SELECT count(*) as total FROM logs WHERE date < ?').get(cutoffDate);
        deletedRows = c?.total || 0;
        this.sqliteDb.prepare('DELETE FROM logs WHERE date < ?').run(cutoffDate);
      }

      this.sqliteDb.exec('VACUUM');
      const rem = this.sqliteDb.prepare('SELECT count(*) as total FROM logs').get()?.total || 0;
      return { ok: true, mode, cutoffDate, deletedRows, remainingRows: rem };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  pruneOldLogs(retentionDays = 3) {
    if (!this.useSqlite || !this.sqliteDb) return;
    try {
      const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const cutoffDateStr = new Date(cutoffTime).toISOString().slice(0, 10);
      const delStmt = this.sqliteDb.prepare('DELETE FROM logs WHERE date < ?');
      delStmt.run(cutoffDateStr);
    } catch (_) {}
  }

  // ─── [网关自有策略] 积分变动历史留痕查询与写入接口 ────────────────────────
  recordCreditChange({ accountUid, accountName, delta, balance, description, createdAt = Date.now(), time = null, date = null }) {
    if (!this.useSqlite || !this.insertCreditStmt) return false;
    try {
      const d = new Date(createdAt);
      const pad = (n) => String(n).padStart(2, '0');
      const timeStr = time || `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const dateStr = date || `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

      this.insertCreditStmt.run(
        createdAt,
        timeStr,
        dateStr,
        String(accountUid || ''),
        String(accountName || ''),
        Number(delta) || 0,
        Number(balance) || 0,
        String(description || '')
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  queryCreditHistory({ accountUid = null, limit = 100, offset = 0 } = {}) {
    if (!this.useSqlite || !this.sqliteDb) return { total: 0, records: [] };
    try {
      const conditions = [];
      const params = [];
      if (accountUid && accountUid !== 'ALL') {
        conditions.push('account_uid = ?');
        params.push(accountUid);
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const countSql = `SELECT count(*) as total FROM credit_history ${whereClause}`;
      const total = this.sqliteDb.prepare(countSql).get(...params)?.total || 0;

      const dataSql = `SELECT * FROM credit_history ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`;
      const rows = this.sqliteDb.prepare(dataSql).all(...params, limit, offset);

      const records = rows.map(r => {
        const d = new Date(r.created_at);
        const pad = (n) => String(n).padStart(2, '0');
        const fullTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        return {
          id: r.id,
          createdAt: r.created_at,
          time: r.time,
          fullTime,
          date: r.date,
          accountUid: r.account_uid,
          accountName: r.account_name,
          delta: r.delta,
          balance: r.balance,
          description: r.description
        };
      });

      return { total, records };
    } catch (_) {
      return { total: 0, records: [] };
    }
  }

  clearCreditHistory() {
    if (!this.useSqlite || !this.sqliteDb) return;
    try {
      this.sqliteDb.exec('DELETE FROM credit_history');
      this.sqliteDb.exec('VACUUM');
    } catch (_) {}
  }

  close() {
    if (!this.sqliteDb) return;
    try {
      // 优雅停机时执行 WAL checkpoint 截断合并，并关闭数据库连接
      this.sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.sqliteDb.close();
    } catch (_) {}
    this.sqliteDb = null;
    this.useSqlite = false;
  }
}

export const LogDatabase = new LogDatabaseEngine();
