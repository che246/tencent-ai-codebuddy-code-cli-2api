package database

import (
	"path/filepath"
	"testing"
)

func TestEngineLifecycle(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "logs.db")
	e := Open(p, func() int { return 30 })
	if !e.Available() {
		t.Fatal("sqlite unavailable")
	}
	defer e.Close()
	e.InsertLog("2026-11-29 10:00:00", "2026-11-29", "info", "SYSTEM", "hello", map[string]any{"a": 1})
	e.InsertLog("2026-11-29 10:00:01", "2026-11-29", "ERROR", "UPSTREAM", "boom <b>", nil)
	res := e.QueryLogs(LogQuery{Date: "2026-11-29"})
	if res.Total != 2 || len(res.Logs) != 2 {
		t.Fatalf("want 2 logs, got %+v", res)
	}
	if res.Logs[0].Level != "ERROR" {
		t.Fatalf("expect newest first, got %s", res.Logs[0].Level)
	}
	if res.Logs[1].Meta == nil {
		t.Fatalf("meta should be parsed")
	}
	if d := e.GetDates(); len(d) != 1 || d[0] != "2026-11-29" {
		t.Fatalf("dates=%v", d)
	}
	if q := e.QueryLogs(LogQuery{Search: "boom"}); q.Total != 1 {
		t.Fatalf("search total=%d", q.Total)
	}
	e.RecordCreditChange(CreditRecord{AccountUID: "u1", AccountName: "n1", Delta: -5, Balance: 95, Description: "test"})
	cr := e.QueryCreditHistory(CreditQuery{Range: "today"})
	if cr.Total != 1 || cr.Records[0].Delta != -5 {
		t.Fatalf("credit=%+v", cr)
	}
	pr := e.PruneLogsByTime("today_only", 1)
	if !pr.OK || pr.DeletedRows != 0 {
		t.Fatalf("prune=%+v", pr)
	}
	pr = e.PruneLogsByTime("all", 0)
	if pr.DeletedRows != 2 {
		t.Fatalf("prune all deleted=%d", pr.DeletedRows)
	}
	if r := e.CheckAndPruneBySize(30); !r.OK {
		t.Fatalf("size prune=%+v", r)
	}
}

func TestMigrateFromGatewayLog(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "gateway.log")
	if err := writeFile(logPath, "[2026-11-28 09:00:00] [INFO ] [SYSTEM] 启动 | {\"port\":8317}\n[2026-11-28 09:00:01] [WARN ] [TLS] x\nnope\n"); err != nil {
		t.Fatal(err)
	}
	e := Open(filepath.Join(dir, "logs.db"), nil)
	if !e.Available() {
		t.Fatal("sqlite unavailable")
	}
	defer e.Close()
	e.MigrateFromGatewayLogIfEmpty(logPath, nil)
	res := e.QueryLogs(LogQuery{})
	if res.Total != 2 {
		t.Fatalf("migrated=%d", res.Total)
	}
	if res.Logs[1].Meta == nil || res.Logs[1].Message != "启动" {
		t.Fatalf("meta parse failed: %+v", res.Logs[1])
	}
}
