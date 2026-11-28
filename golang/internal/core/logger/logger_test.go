package logger

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codebuddy-gateway/internal/core/database"
)

func TestLoggerFormatAndQuery(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "gateway.log")
	e := database.Open(filepath.Join(dir, "logs.db"), nil)
	defer e.Close()
	l := New(e, logPath)
	defer l.Close()
	l.SetClock(func() time.Time { return time.Date(2026, 11, 29, 10, 0, 0, 0, time.Local) })
	l.Info("SYSTEM", "启动完成", "port", 8317, "x", "<y>")
	l.Error("UPSTREAM", "boom")
	l.Warn("tls", "warned")
	if len(l.ring) != 3 {
		t.Fatalf("ring=%d", len(l.ring))
	}
	data, err := readFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	want := "[2026-11-29 10:00:00] [INFO ] [SYSTEM] 启动完成 | {\"port\":8317,\"x\":\"<y>\"}\n"
	if !strings.HasPrefix(data, want) {
		t.Fatalf("format mismatch:\n got=%q\nwant=%q", data, want)
	}
	if !strings.Contains(data, "[2026-11-29 10:00:00] [ERROR] [UPSTREAM] boom\n") {
		t.Fatalf("error line missing: %q", data)
	}
	if !strings.Contains(data, "[WARN ] [TLS]") {
		t.Fatalf("warn line missing: %q", data)
	}
	res := l.GetLogs(LogQuery{Level: "error"})
	if res.Total != 1 || res.Logs[0].Category != "UPSTREAM" {
		t.Fatalf("query=%+v", res)
	}
	if d := l.GetDates(); len(d) != 1 || d[0] != "2026-11-29" {
		t.Fatalf("dates=%v", d)
	}
	l.PruneLogsByTime("all", 0)
	// 清理 3 条后仅剩清理动作自身的 SYSTEM 汇总日志
	if res := l.GetLogs(LogQuery{}); res.Total != 1 || res.Logs[0].Category != "SYSTEM" {
		t.Fatalf("after prune all expect 1 summary log, got %+v", res)
	}
}
