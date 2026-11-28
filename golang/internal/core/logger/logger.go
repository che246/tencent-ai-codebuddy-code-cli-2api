// Package logger 对应 Node 版 src/core/logger.mjs。
// 行格式逐字节复刻：`[YYYY-MM-DD HH:mm:ss] [LEVEL ] [CATEGORY] message | {"meta":...}\n`
// 输出顺序：SQLite 同步插入 → 环形缓冲(1000) → stdout/stderr → gateway.log 追加。
// 【网关】SQLite 插入保持同步（与 Node 一致；异步化属行为差异，未采用）。
package logger

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/database"
)

const maxRingSize = 1000

// LogItem 单条日志（logger.mjs:15-23）。
type LogItem struct {
	ID       string `json:"id"`
	Time     string `json:"time"`
	Date     string `json:"date"`
	Level    string `json:"level"`
	Category string `json:"category"`
	Message  string `json:"message"`
	Meta     any    `json:"meta"`
}

// LogQuery 对应 getLogs 参数。
type LogQuery struct {
	Date, Level, Category, Search string
	Limit, Offset                 int
}

// Logger 日志器。
type Logger struct {
	mu     sync.Mutex
	ring   []LogItem
	db     *database.Engine
	file   io.WriteCloser
	path   string
	out    io.Writer
	errOut io.Writer
	now    func() time.Time
}

// New 创建 Logger；db 可为 nil（仅内存）。
func New(db *database.Engine, logFilePath string) *Logger {
	l := &Logger{db: db, path: logFilePath, out: os.Stdout, errOut: os.Stderr, now: time.Now}
	if logFilePath != "" {
		if f, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			l.file = f
		}
	}
	return l
}

// SetClock 注入时钟（测试用）。
func (l *Logger) SetClock(fn func() time.Time) { l.now = fn }

// SetWriters 重定向控制台输出（测试/嵌入场景）。
func (l *Logger) SetWriters(out, errOut io.Writer) {
	if out != nil {
		l.out = out
	}
	if errOut != nil {
		l.errOut = errOut
	}
}

// Close 关闭日志文件句柄。
func (l *Logger) Close() {
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

// ─── 有序 Meta（保证 JSON.stringify 的键插入顺序） ───────────────────────────

// Meta 保持插入顺序的键值对。
type Meta struct {
	keys []string
	vals []any
}

// NewMeta 以 (key, value) 交替构造有序 meta。
func NewMeta(kvs ...any) *Meta {
	m := &Meta{}
	for i := 0; i+1 < len(kvs); i += 2 {
		m.Set(fmt.Sprint(kvs[i]), kvs[i+1])
	}
	return m
}

// Set 追加/覆盖键。
func (m *Meta) Set(key string, v any) *Meta {
	for i, k := range m.keys {
		if k == key {
			m.vals[i] = v
			return m
		}
	}
	m.keys = append(m.keys, key)
	m.vals = append(m.vals, v)
	return m
}

// MarshalJSON 按插入顺序输出紧凑 JSON。
func (m *Meta) MarshalJSON() ([]byte, error) {
	if m == nil {
		return []byte("null"), nil
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range m.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		b.Write(kb)
		b.WriteByte(':')
		vb, err := marshalNoEscape(m.vals[i])
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

func marshalNoEscape(v any) ([]byte, error) {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return []byte(strings.TrimRight(buf.String(), "\n")), nil
}

// ─── 写入 ─────────────────────────────────────────────────────────────────────

func shortID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return hex.EncodeToString(b[:4])
}

// Write 对应 Logger.write（logger.mjs:11-44）。
func (l *Logger) Write(level, category, message string, meta any) {
	tm := config.LocalTimeString(l.now())
	item := LogItem{
		ID:       shortID(),
		Time:     tm,
		Date:     tm[:10],
		Level:    strings.ToUpper(level),
		Category: strings.ToUpper(category),
		Message:  message,
		Meta:     meta,
	}
	// 1. SQLite 同步
	if l.db != nil {
		l.db.InsertLog(item.Time, item.Date, item.Level, item.Category, item.Message, meta)
	}
	// 2. 环形缓冲
	l.mu.Lock()
	l.ring = append([]LogItem{item}, l.ring...)
	if len(l.ring) > maxRingSize {
		l.ring = l.ring[:maxRingSize]
	}
	l.mu.Unlock()

	// 3. 行格式
	metaStr := ""
	if meta != nil {
		mb, err := marshalNoEscape(meta)
		if err == nil {
			metaStr = " | " + string(mb)
		}
	}
	line := fmt.Sprintf("[%s] [%-5s] [%s] %s%s\n", tm, item.Level, item.Category, message, metaStr)
	if item.Level == "ERROR" {
		_, _ = l.errOut.Write([]byte(line))
	} else {
		_, _ = l.out.Write([]byte(line))
	}
	// 4. 文件追加
	if l.file != nil {
		_, _ = l.file.Write([]byte(line))
	}
}

// Info 信息日志。
func (l *Logger) Info(category, message string, meta ...any) {
	l.writeWithMeta("info", category, message, meta)
}

// Warn 警告日志。
func (l *Logger) Warn(category, message string, meta ...any) {
	l.writeWithMeta("warn", category, message, meta)
}

// Error 错误日志。
func (l *Logger) Error(category, message string, meta ...any) {
	l.writeWithMeta("error", category, message, meta)
}

func (l *Logger) writeWithMeta(level, category, message string, meta []any) {
	var m any
	switch len(meta) {
	case 0:
	case 1:
		m = meta[0]
	default:
		m = NewMeta(meta...)
	}
	l.Write(level, category, message, m)
}

// ─── 查询 ─────────────────────────────────────────────────────────────────────

// GetLogs 优先 DB，无结果时环形缓冲兜底（logger.mjs:50-68）。
func (l *Logger) GetLogs(q LogQuery) database.LogQueryResult {
	if q.Limit <= 0 {
		q.Limit = 200
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	if l.db != nil {
		res := l.db.QueryLogs(database.LogQuery{Date: q.Date, Level: q.Level, Category: q.Category, Search: q.Search, Limit: q.Limit, Offset: q.Offset})
		if len(res.Logs) > 0 {
			return res
		}
	}
	l.mu.Lock()
	filtered := make([]LogItem, 0, len(l.ring))
	for _, it := range l.ring {
		if q.Date != "" && q.Date != "ALL" && it.Date != q.Date {
			continue
		}
		if q.Level != "" && q.Level != "ALL" && it.Level != strings.ToUpper(q.Level) {
			continue
		}
		if q.Category != "" && q.Category != "ALL" && it.Category != strings.ToUpper(q.Category) {
			continue
		}
		if s := strings.ToLower(strings.TrimSpace(q.Search)); s != "" && !strings.Contains(strings.ToLower(it.Message), s) {
			continue
		}
		filtered = append(filtered, it)
	}
	l.mu.Unlock()
	total := len(filtered)
	if q.Offset > total {
		q.Offset = total
	}
	end := q.Offset + q.Limit
	if end > total {
		end = total
	}
	logs := []database.LogRow{}
	for _, it := range filtered[q.Offset:end] {
		logs = append(logs, database.LogRow{ID: it.ID, Time: it.Time, Date: it.Date, Level: it.Level, Category: it.Category, Message: it.Message, Meta: it.Meta})
	}
	return database.LogQueryResult{Total: total, Logs: logs}
}

// GetDates 优先 DB，兜底环形缓冲倒序（logger.mjs:70-79）。
func (l *Logger) GetDates() []string {
	if l.db != nil {
		if d := l.db.GetDates(); len(d) > 0 {
			return d
		}
	}
	set := map[string]bool{}
	l.mu.Lock()
	for _, it := range l.ring {
		if it.Date != "" {
			set[it.Date] = true
		}
	}
	l.mu.Unlock()
	out := make([]string, 0, len(set))
	for d := range set {
		out = append(out, d)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(out)))
	return out
}

// Clear 清空环形缓冲与 DB（logger.mjs:81-84）。
func (l *Logger) Clear() {
	l.mu.Lock()
	l.ring = nil
	l.mu.Unlock()
	if l.db != nil {
		l.db.ClearLogs()
	}
}

var datePrefixRe = regexp.MustCompile(`^\[(\d{4}-\d{2}-\d{2})`)

// PruneLogsByTime 按时间裁剪 DB + 环形缓冲 + gateway.log（logger.mjs:86-133）。
func (l *Logger) PruneLogsByTime(mode string, keepDays int) map[string]any {
	var dbRes database.PruneResult
	if l.db != nil {
		dbRes = l.db.PruneLogsByTime(mode, keepDays)
	}
	today := time.Now().UTC().Format("2006-01-02")
	cutoff := today
	if mode == "days" {
		days := keepDays
		if days < 1 {
			days = 1
		}
		cutoff = time.Now().UTC().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	}
	if mode == "all" {
		l.mu.Lock()
		l.ring = nil
		l.mu.Unlock()
		_ = os.WriteFile(l.path, []byte(""), 0o644)
	} else {
		l.mu.Lock()
		kept := l.ring[:0]
		for _, it := range l.ring {
			if it.Time[:min(10, len(it.Time))] >= cutoff {
				kept = append(kept, it)
			}
		}
		l.ring = kept
		l.mu.Unlock()
		if data, err := os.ReadFile(l.path); err == nil {
			var retained []string
			for _, line := range strings.Split(string(data), "\n") {
				if strings.TrimSpace(line) == "" {
					continue
				}
				if m := datePrefixRe.FindStringSubmatch(line); m != nil {
					if m[1] >= cutoff {
						retained = append(retained, line)
					}
				} else if len(retained) > 0 {
					retained = append(retained, line)
				}
			}
			out := strings.Join(retained, "\n")
			if len(retained) > 0 {
				out += "\n"
			}
			_ = os.WriteFile(l.path, []byte(out), 0o644)
		}
	}
	cutoffLabel := cutoff
	if mode == "all" {
		cutoffLabel = "全部清空"
	}
	l.Info("SYSTEM", fmt.Sprintf("日志按时间清理完成: 模式 [%s], 截止日期 [%s], 共清理 %d 条数据库日志", mode, cutoffLabel, dbRes.DeletedRows))
	return map[string]any{"ok": true, "mode": mode, "deletedRows": dbRes.DeletedRows, "remainingRows": dbRes.RemainingRows}
}

// PruneOldLogs 保留 N 天并按体积收缩（logger.mjs:136-173）。
func (l *Logger) PruneOldLogs(retentionDays int) {
	if l.db != nil {
		l.db.PruneOldLogs(retentionDays)
		l.db.CheckAndPruneBySize(0)
	}
	if _, err := os.Stat(l.path); err != nil {
		return
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -retentionDays).Format("2006-01-02")
	data, err := os.ReadFile(l.path)
	if err != nil {
		return
	}
	var retained []string
	pruned := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if m := datePrefixRe.FindStringSubmatch(line); m != nil {
			if m[1] >= cutoff {
				retained = append(retained, line)
			} else {
				pruned++
			}
		} else if len(retained) > 0 {
			retained = append(retained, line)
		}
	}
	if pruned > 0 {
		_ = os.WriteFile(l.path, []byte(strings.Join(retained, "\n")+"\n"), 0o644)
		l.Info("SYSTEM", fmt.Sprintf("日志轮转清理完成：已裁剪清除 3 天前的过期日志 (共清理 %d 行，保留最近 %d 天)", pruned, retentionDays))
	}
	l.mu.Lock()
	kept := l.ring[:0]
	for _, it := range l.ring {
		d := ""
		if len(it.Time) >= 10 {
			d = it.Time[:10]
		}
		if d == "" || d >= cutoff {
			kept = append(kept, it)
		}
	}
	l.ring = kept
	l.mu.Unlock()
}

// ─── slog.Handler（供标准库生态；输出仍走精确文本格式） ─────────────────────

// Handler 返回 slog.Handler 适配器。
func (l *Logger) Handler() slog.Handler { return &slogAdapter{l: l, category: "LOG"} }

type slogAdapter struct {
	l        *Logger
	category string
}

func (a *slogAdapter) Enabled(_ context.Context, lv slog.Level) bool { return true }
func (a *slogAdapter) WithAttrs(attrs []slog.Attr) slog.Handler {
	cat := a.category
	for _, at := range attrs {
		if at.Key == "category" {
			cat = at.Value.String()
		}
	}
	return &slogAdapter{l: a.l, category: cat}
}
func (a *slogAdapter) WithGroup(_ string) slog.Handler { return a }
func (a *slogAdapter) Handle(_ context.Context, r slog.Record) error {
	lv := "info"
	if r.Level >= slog.LevelError {
		lv = "error"
	} else if r.Level >= slog.LevelWarn {
		lv = "warn"
	}
	meta := NewMeta()
	r.Attrs(func(at slog.Attr) bool {
		if at.Key != "category" {
			meta.Set(at.Key, at.Value.Any())
		}
		return true
	})
	var m any
	if len(meta.keys) > 0 {
		m = meta
	}
	a.l.Write(lv, a.category, r.Message, m)
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
