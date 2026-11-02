import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT_DIR, LOG_FILE_PATH } from '../config.mjs';

const require = createRequire(import.meta.url);
export const DB_PATH = path.resolve(ROOT_DIR, 'logs.db');

class LogDatabaseEngine {
  constructor() {
    this.sqliteDb = null;
    this.useSqlite = false;
    this.init();
  }

  init() {
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.sqliteDb = new DatabaseSync(DB_PATH);
      this.useSqlite = true;

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
      `);

      this.insertStmt = this.sqliteDb.prepare(`
        INSERT INTO logs (time, date, level, category, message, meta, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
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
        return;
      } catch (_) {}
    }
  }

  queryLogs({ date = null, level = null, category = null, search = null, limit = 250, offset = 0 } = {}) {
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

  pruneOldLogs(retentionDays = 3) {
    if (!this.useSqlite || !this.sqliteDb) return;
    try {
      const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const cutoffDateStr = new Date(cutoffTime).toISOString().slice(0, 10);
      const delStmt = this.sqliteDb.prepare('DELETE FROM logs WHERE date < ?');
      delStmt.run(cutoffDateStr);
    } catch (_) {}
  }
}

export const LogDatabase = new LogDatabaseEngine();
