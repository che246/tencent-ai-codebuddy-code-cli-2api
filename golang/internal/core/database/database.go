// Package database 对应 Node 版 src/core/database.mjs（node:sqlite DatabaseSync）。
// 纯 Go 驱动 modernc.org/sqlite，CGO_ENABLED=0；DDL 与 Node 版一字不差，现有 logs.db 可直接打开。
package database

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ShiftedDate 本地日期偏移（database.mjs:6-14）。
func ShiftedDate(base string, days int) string {
	t, err := time.ParseInLocation("2006-01-02", base, time.Local)
	if err != nil {
		return base
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

// LogQuery 查询条件（database.mjs:209）。
type LogQuery struct {
	Date     string
	Level    string
	Category string
	Search   string
	Limit    int
	Offset   int
}

// LogRow 单条日志（database.mjs:240-248）。
type LogRow struct {
	ID       string `json:"id"`
	Time     string `json:"time"`
	Date     string `json:"date"`
	Level    string `json:"level"`
	Category string `json:"category"`
	Message  string `json:"message"`
	Meta     any    `json:"meta"`
}

// LogQueryResult {total, logs}。
type LogQueryResult struct {
	Total int      `json:"total"`
	Logs  []LogRow `json:"logs"`
}

// PruneResult 裁剪结果（database.mjs:196-206 / 299）。
type PruneResult struct {
	OK            bool    `json:"ok"`
	Reason        string  `json:"reason,omitempty"`
	Error         string  `json:"error,omitempty"`
	Mode          string  `json:"mode,omitempty"`
	CutoffDate    string  `json:"cutoffDate,omitempty"`
	DeletedRows   int     `json:"deletedRows"`
	RemainingRows int     `json:"remainingRows,omitempty"`
	Pruned        bool    `json:"pruned,omitempty"`
	BeforeBytes   int64   `json:"beforeBytes"`
	AfterBytes    int64   `json:"afterBytes"`
	BeforeMb      float64 `json:"beforeMb,omitempty"`
	AfterMb       float64 `json:"afterMb,omitempty"`
	LimitMb       int     `json:"limitMb,omitempty"`
	TargetMb      float64 `json:"targetMb,omitempty"`
	TargetBytes   int64   `json:"targetBytes,omitempty"`
}

// CreditRecord 积分变动记录（database.mjs:316）。
type CreditRecord struct {
	AccountUID  string
	AccountName string
	Delta       float64
	Balance     float64
	Description string
	CreatedAt   int64 // ms；0 = now
}

// CreditRow 查询结果行（database.mjs:384-395）。
type CreditRow struct {
	ID          int64   `json:"id"`
	CreatedAt   int64   `json:"createdAt"`
	Time        string  `json:"time"`
	FullTime    string  `json:"fullTime"`
	Date        string  `json:"date"`
	AccountUID  string  `json:"accountUid"`
	AccountName string  `json:"accountName"`
	Delta       float64 `json:"delta"`
	Balance     float64 `json:"balance"`
	Description string  `json:"description"`
}

// CreditQuery 积分历史查询条件（database.mjs:340）。
type CreditQuery struct {
	AccountUID string
	Range      string
	Date       string
	Limit      int
	Offset     int
}

// CreditQueryResult {total, records}。
type CreditQueryResult struct {
	Total   int         `json:"total"`
	Records []CreditRow `json:"records"`
}

// Engine SQLite 引擎。
type Engine struct {
	db        *sql.DB
	path      string
	available bool
	inserts   int
	maxMb     func() int
}

var logLineRe = regexp.MustCompile(`^\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]\s+\[([A-Z]+)\s*\]\s+\[([A-Z0-9_\-]+)\]\s+(.*)$`)

// Open 打开/创建数据库；失败时返回 available=false 的引擎（Node 版静默降级，疑点 D5）。
func Open(path string, maxLogDbMb func() int) *Engine {
	e := &Engine{path: path, maxMb: maxLogDbMb}
	if maxLogDbMb == nil {
		e.maxMb = func() int { return 30 }
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return e
	}
	// MaxOpenConns=1 保证写序与 Node DatabaseSync 等价
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxIdleTime(0)
	pragmas := []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA busy_timeout = 5000",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			db.Close()
			return e
		}
	}
	ddl := `
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
        CREATE INDEX IF NOT EXISTS idx_credit_history_date ON credit_history(date);
    `
	if _, err := db.Exec(ddl); err != nil {
		db.Close()
		return e
	}
	e.db = db
	e.available = true
	return e
}

// Available SQLite 是否可用。
func (e *Engine) Available() bool { return e != nil && e.available }

// Path 数据库路径。
func (e *Engine) Path() string { return e.path }

// MigrateFromGatewayLogIfEmpty 空库时从 gateway.log 迁移（database.mjs:90-122）。
func (e *Engine) MigrateFromGatewayLogIfEmpty(logFilePath string, now func() int64) {
	if !e.Available() {
		return
	}
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	var total int
	if err := e.db.QueryRow(`SELECT count(*) as total FROM logs`).Scan(&total); err != nil || total > 0 {
		return
	}
	content, err := os.ReadFile(logFilePath)
	if err != nil {
		return
	}
	tx, err := e.db.Begin()
	if err != nil {
		return
	}
	stmt, err := tx.Prepare(`INSERT INTO logs (time, date, level, category, message, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return
	}
	defer stmt.Close()
	for _, line := range strings.Split(string(content), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		m := logLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		date := m[1]
		tm := m[1] + " " + m[2]
		level, category := m[3], m[4]
		rawMsg := m[5]
		var meta any
		if strings.Contains(rawMsg, " | {") {
			parts := strings.Split(rawMsg, " | {")
			rawMsg = parts[0]
			meta = "{" + strings.Join(parts[1:], " | {")
		}
		_, _ = stmt.Exec(tm, date, level, category, rawMsg, meta, now())
	}
	_ = tx.Commit()
}

// InsertLog 同步插入；每 100 次检测一次体积（database.mjs:124-137）。
func (e *Engine) InsertLog(tm, date, level, category, message string, meta any) {
	if !e.Available() {
		return
	}
	var metaStr any
	if meta != nil {
		if s, ok := meta.(string); ok {
			metaStr = s
		} else {
			metaStr = jsonString(meta)
		}
	}
	if _, err := e.db.Exec(`INSERT INTO logs (time, date, level, category, message, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		tm, date, strings.ToUpper(level), strings.ToUpper(category), message, metaStr, time.Now().UnixMilli()); err != nil {
		return
	}
	e.inserts++
	if e.inserts%100 == 0 {
		e.CheckAndPruneBySize(0)
	}
}

// SizeBytes / SizeMb（database.mjs:139-151）。
func (e *Engine) SizeBytes() int64 {
	st, err := os.Stat(e.path)
	if err != nil {
		return 0
	}
	return st.Size()
}

// SizeMb 保留两位小数。
func (e *Engine) SizeMb() float64 {
	return round2(float64(e.SizeBytes()) / 1024 / 1024)
}

// CheckAndPruneBySize 体积熔断：超过上限删最旧记录并 VACUUM 收缩到 50%（database.mjs:154-207）。
func (e *Engine) CheckAndPruneBySize(maxSizeMb int) PruneResult {
	if !e.Available() {
		return PruneResult{Reason: "sqlite_unavailable"}
	}
	if _, err := os.Stat(e.path); err != nil {
		return PruneResult{Reason: "file_not_found"}
	}
	limitMb := maxSizeMb
	if limitMb <= 0 {
		limitMb = e.maxMb()
	}
	maxBytes := int64(limitMb) * 1024 * 1024
	targetBytes := maxBytes / 2
	initial := e.SizeBytes()
	if initial <= maxBytes {
		return PruneResult{OK: true, BeforeBytes: initial, AfterBytes: initial, LimitMb: limitMb, TargetBytes: targetBytes}
	}
	deleted := 0
	for i := 0; i < 20; i++ {
		cur := e.SizeBytes()
		if cur <= targetBytes {
			break
		}
		var total int
		_ = e.db.QueryRow(`SELECT count(*) as total FROM logs`).Scan(&total)
		if total <= 10 {
			break
		}
		ratio := (float64(cur) - float64(targetBytes)) / float64(cur)
		if ratio < 0.1 {
			ratio = 0.1
		} else if ratio > 0.8 {
			ratio = 0.8
		}
		batch := int(float64(total) * ratio)
		if batch < 200 {
			batch = 200
		}
		_, _ = e.db.Exec(`DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)`, batch)
		deleted += batch
		_, _ = e.db.Exec(`VACUUM`)
	}
	final := e.SizeBytes()
	return PruneResult{OK: true, Pruned: true, DeletedRows: deleted, BeforeBytes: initial, BeforeMb: round2(float64(initial) / 1024 / 1024), AfterBytes: final, AfterMb: round2(float64(final) / 1024 / 1024), LimitMb: limitMb, TargetMb: round2(float64(targetBytes) / 1024 / 1024), TargetBytes: targetBytes}
}

// QueryLogs 条件查询（database.mjs:209-254）。
func (e *Engine) QueryLogs(q LogQuery) LogQueryResult {
	if !e.Available() {
		return LogQueryResult{Logs: []LogRow{}}
	}
	if q.Limit <= 0 {
		q.Limit = 200
	}
	var conds []string
	var params []any
	if q.Date != "" && q.Date != "ALL" {
		conds = append(conds, "date = ?")
		params = append(params, q.Date)
	}
	if q.Level != "" && q.Level != "ALL" {
		conds = append(conds, "level = ?")
		params = append(params, strings.ToUpper(q.Level))
	}
	if q.Category != "" && q.Category != "ALL" {
		conds = append(conds, "category = ?")
		params = append(params, strings.ToUpper(q.Category))
	}
	if s := strings.TrimSpace(q.Search); s != "" {
		conds = append(conds, "(message LIKE ? OR meta LIKE ?)")
		kw := "%" + s + "%"
		params = append(params, kw, kw)
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	var total int
	_ = e.db.QueryRow(`SELECT count(*) as total FROM logs `+where, params...).Scan(&total)
	rs, err := e.db.Query(`SELECT * FROM logs `+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, append(params, q.Limit, q.Offset)...)
	if err != nil {
		return LogQueryResult{Logs: []LogRow{}}
	}
	defer rs.Close()
	cols, _ := rs.Columns()
	logs := []LogRow{}
	for rs.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rs.Scan(ptrs...); err != nil {
			continue
		}
		row := LogRow{Meta: nil}
		for i, c := range cols {
			switch c {
			case "id":
				row.ID = fmt.Sprint(vals[i])
			case "time":
				row.Time, _ = vals[i].(string)
			case "date":
				row.Date, _ = vals[i].(string)
			case "level":
				row.Level, _ = vals[i].(string)
			case "category":
				row.Category, _ = vals[i].(string)
			case "message":
				row.Message, _ = vals[i].(string)
			case "meta":
				if s, ok := vals[i].(string); ok && s != "" {
					row.Meta = parseJSONOrString(s)
				}
			}
		}
		logs = append(logs, row)
	}
	return LogQueryResult{Total: total, Logs: logs}
}

// GetDates 去重日期倒序（database.mjs:256-264）。
func (e *Engine) GetDates() []string {
	if !e.Available() {
		return []string{}
	}
	rs, err := e.db.Query(`SELECT DISTINCT date FROM logs WHERE date IS NOT NULL ORDER BY date DESC`)
	if err != nil {
		return []string{}
	}
	defer rs.Close()
	out := []string{}
	for rs.Next() {
		var d string
		if err := rs.Scan(&d); err == nil && d != "" {
			out = append(out, d)
		}
	}
	return out
}

// ClearLogs 清空 + VACUUM（database.mjs:266-273）。
func (e *Engine) ClearLogs() {
	if !e.Available() {
		return
	}
	_, _ = e.db.Exec(`DELETE FROM logs`)
	_, _ = e.db.Exec(`VACUUM`)
}

// PruneLogsByTime 按时间裁剪；cutoff 用 UTC 日期（疑点 D4 照搬）（database.mjs:275-303）。
func (e *Engine) PruneLogsByTime(mode string, keepDays int) PruneResult {
	if !e.Available() {
		return PruneResult{Reason: "sqlite_unavailable"}
	}
	today := time.Now().UTC().Format("2006-01-02")
	cutoff := today
	deleted := 0
	if mode == "all" {
		_ = e.db.QueryRow(`SELECT count(*) as total FROM logs`).Scan(&deleted)
		_, _ = e.db.Exec(`DELETE FROM logs`)
	} else {
		if mode == "days" {
			days := keepDays
			if days < 1 {
				days = 1
			}
			cutoff = time.Now().UTC().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
		}
		_ = e.db.QueryRow(`SELECT count(*) as total FROM logs WHERE date < ?`, cutoff).Scan(&deleted)
		_, _ = e.db.Exec(`DELETE FROM logs WHERE date < ?`, cutoff)
	}
	_, _ = e.db.Exec(`VACUUM`)
	var rem int
	_ = e.db.QueryRow(`SELECT count(*) as total FROM logs`).Scan(&rem)
	return PruneResult{OK: true, Mode: mode, CutoffDate: cutoff, DeletedRows: deleted, RemainingRows: rem}
}

// PruneOldLogs 保留 N 天（database.mjs:305-313）。
func (e *Engine) PruneOldLogs(retentionDays int) {
	if !e.Available() {
		return
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -retentionDays).Format("2006-01-02")
	_, _ = e.db.Exec(`DELETE FROM logs WHERE date < ?`, cutoff)
}

// RecordCreditChange 写积分变动（database.mjs:316-338）。
func (e *Engine) RecordCreditChange(r CreditRecord) bool {
	if !e.Available() {
		return false
	}
	createdAt := r.CreatedAt
	if createdAt == 0 {
		createdAt = time.Now().UnixMilli()
	}
	d := time.UnixMilli(createdAt).Local()
	_, err := e.db.Exec(`INSERT INTO credit_history (created_at, time, date, account_uid, account_name, delta, balance, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		createdAt, d.Format("15:04:05"), d.Format("2006-01-02"), r.AccountUID, r.AccountName, r.Delta, r.Balance, r.Description)
	return err == nil
}

// QueryCreditHistory 积分历史查询（database.mjs:340-402）。
func (e *Engine) QueryCreditHistory(q CreditQuery) CreditQueryResult {
	if !e.Available() {
		return CreditQueryResult{Records: []CreditRow{}}
	}
	if q.Limit <= 0 {
		q.Limit = 100
	}
	var conds []string
	var params []any
	if q.AccountUID != "" && q.AccountUID != "ALL" {
		conds = append(conds, "(account_uid = ? OR account_name = ?)")
		params = append(params, q.AccountUID, q.AccountUID)
	}
	today := time.Now().Local().Format("2006-01-02")
	switch {
	case q.Date != "":
		conds = append(conds, "date = ?")
		params = append(params, q.Date)
	case q.Range == "" || q.Range == "today":
		conds = append(conds, "date = ?")
		params = append(params, today)
	case q.Range == "yesterday":
		conds = append(conds, "date = ?")
		params = append(params, ShiftedDate(today, -1))
	case q.Range == "7d":
		conds = append(conds, "date >= ? AND date <= ?")
		params = append(params, ShiftedDate(today, -6), today)
	case q.Range == "30d":
		conds = append(conds, "date >= ? AND date <= ?")
		params = append(params, ShiftedDate(today, -29), today)
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	var total int
	_ = e.db.QueryRow(`SELECT count(*) as total FROM credit_history `+where, params...).Scan(&total)
	rs, err := e.db.Query(`SELECT id, created_at, time, date, account_uid, account_name, delta, balance, description FROM credit_history `+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, append(params, q.Limit, q.Offset)...)
	if err != nil {
		return CreditQueryResult{Records: []CreditRow{}}
	}
	defer rs.Close()
	records := []CreditRow{}
	for rs.Next() {
		var r CreditRow
		if err := rs.Scan(&r.ID, &r.CreatedAt, &r.Time, &r.Date, &r.AccountUID, &r.AccountName, &r.Delta, &r.Balance, &r.Description); err != nil {
			continue
		}
		r.FullTime = time.UnixMilli(r.CreatedAt).Local().Format("2006-01-02 15:04:05")
		records = append(records, r)
	}
	return CreditQueryResult{Total: total, Records: records}
}

// ClearCreditHistory 清空积分历史（database.mjs:404-410）。
func (e *Engine) ClearCreditHistory() {
	if !e.Available() {
		return
	}
	_, _ = e.db.Exec(`DELETE FROM credit_history`)
	_, _ = e.db.Exec(`VACUUM`)
}

// Close WAL checkpoint + 关闭（database.mjs:412-421）。
func (e *Engine) Close() error {
	if e == nil || e.db == nil {
		return nil
	}
	_, _ = e.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE);`)
	err := e.db.Close()
	e.db = nil
	e.available = false
	return err
}

func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }

// jsonString 与 JSON.stringify 等价（紧凑、不转义 HTML）。
func jsonString(v any) string {
	type stringer interface{ JSONString() string }
	if s, ok := v.(stringer); ok {
		return s.JSONString()
	}
	b, err := marshalCompact(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

var errClosed = errors.New("sql: database is closed")
