// logparser.go 对应 src/core/log-parser.mjs：从 gateway.log 动态重构历史统计（仅首次无 stats.json 时使用）。
package metrics

import (
	"os"
	"regexp"
	"strconv"
	"strings"
)

var (
	lpTimeRe     = regexp.MustCompile(`^\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]`)
	lpDispatchRe = regexp.MustCompile(`(?:调度选中账号|精准路由至网关全局指定账号|粘性会话复用账号)\s+\[([^\]]+?)(?:\s*\(([^)]+)\))?\]`)
	lpModelRe    = regexp.MustCompile(`(?:对话请求|协议请求)\s+\[([a-zA-Z0-9.\-_]+)\]`)
	lpMsgCountRe = regexp.MustCompile(`"messagesCount":(\d+)`)
	lpDurationRe = regexp.MustCompile(`耗时\s+(\d+)ms`)
	lpCacheRe    = regexp.MustCompile(`缓存命中:\s*(\d+)\s*tok`)
	lpDoneModel  = regexp.MustCompile(`(?:输出完成|回复完成)\s+\[([a-zA-Z0-9.\-_]+)\]`)
	lpAccountRe  = regexp.MustCompile(`账号:\s*\[([^\]]+)\]`)
)

// RebuildRealStatsFromLog 从本地真实运行日志 (gateway.log) 动态提取重构真实历史数据。
// 文件不存在返回 nil。
func RebuildRealStatsFromLog(logFilePath string) *Stats {
	data, err := os.ReadFile(logFilePath)
	if err != nil {
		return nil
	}
	const fallbackModel = "deepseek-v4.1-flash"
	var totalRequests, successRequests, failedRequests int64
	var totalInputTokens, totalOutputTokens, totalCachedTokens int64
	daily := newOrdered[*DailyStat]()
	models := newOrdered[*ModelStat]()
	accounts := newOrdered[*AccountStat]()
	// 与 Node 版一致的默认当前账号
	currentUID, currentName := "18948117020", "小宝"

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		tm := lpTimeRe.FindStringSubmatch(line)
		if tm == nil {
			continue
		}
		date := tm[1]
		if dm := lpDispatchRe.FindStringSubmatch(line); dm != nil {
			name := strings.TrimSpace(dm[1])
			uid := name
			if dm[2] != "" {
				uid = strings.TrimSpace(dm[2])
			}
			currentUID, currentName = uid, name
		}
		if strings.Contains(line, "收到 OpenAI 对话请求") || strings.Contains(line, "收到 Claude Code 协议请求") {
			totalRequests++
			model := fallbackModel
			if mm := lpModelRe.FindStringSubmatch(line); mm != nil {
				model = mm[1]
			}
			msgCount := int64(1)
			if mc := lpMsgCountRe.FindStringSubmatch(line); mc != nil {
				if n, err := strconv.ParseInt(mc[1], 10, 64); err == nil {
					msgCount = n
				}
			}
			estimatedInput := msgCount * 150
			if estimatedInput < 20 {
				estimatedInput = 20
			}
			totalInputTokens += estimatedInput
			d := daily.Ensure(date, func() *DailyStat {
				return &DailyStat{Models: newOrdered[*ModelStat](), Accounts: newOrdered[*AccountStat]()}
			})
			d.Requests++
			d.InputTokens += estimatedInput
			d.TotalTokens += estimatedInput
			dm := d.Models.Ensure(model, func() *ModelStat { return &ModelStat{Name: model} })
			dm.Requests++
			dm.InputTokens += estimatedInput
			dm.TotalTokens += estimatedInput
			m := models.Ensure(model, func() *ModelStat { return &ModelStat{Name: model} })
			m.Requests++
			m.InputTokens += estimatedInput
			m.TotalTokens += estimatedInput
			accKey := currentUID
			if accKey == "" {
				accKey = currentName
			}
			da := d.Accounts.Ensure(accKey, func() *AccountStat { return &AccountStat{UID: currentUID, Counter: Counter{Name: currentName}} })
			da.Requests++
			da.InputTokens += estimatedInput
			da.TotalTokens += estimatedInput
			a := accounts.Ensure(accKey, func() *AccountStat { return &AccountStat{UID: currentUID, Counter: Counter{Name: currentName}} })
			a.Requests++
			a.InputTokens += estimatedInput
			a.TotalTokens += estimatedInput
		}
		if strings.Contains(line, "流式输出完成") || strings.Contains(line, "流式回复完成") || strings.Contains(line, "非流式完成") || strings.Contains(line, "非流式回复完成") {
			successRequests++
			duration := int64(1000)
			if dm := lpDurationRe.FindStringSubmatch(line); dm != nil {
				if n, err := strconv.ParseInt(dm[1], 10, 64); err == nil {
					duration = n
				}
			}
			estimatedOutput := duration / 15
			if duration%15 >= 8 { // Math.round(duration/15)
				estimatedOutput++
			}
			if estimatedOutput < 15 {
				estimatedOutput = 15
			}
			totalOutputTokens += estimatedOutput
			cachedHit := int64(0)
			if cm := lpCacheRe.FindStringSubmatch(line); cm != nil {
				if n, err := strconv.ParseInt(cm[1], 10, 64); err == nil {
					cachedHit = n
				}
			}
			totalCachedTokens += cachedHit
			model := fallbackModel
			if mm := lpDoneModel.FindStringSubmatch(line); mm != nil {
				model = mm[1]
			}
			accKey := currentUID
			if am := lpAccountRe.FindStringSubmatch(line); am != nil {
				accName := strings.TrimSpace(am[1])
				for _, k := range accounts.Keys() {
					a, _ := accounts.Get(k)
					if a.Name == accName {
						accKey = k
						break
					}
				}
			}
			if d, ok := daily.Get(date); ok {
				d.SuccessRequests++
				d.OutputTokens += estimatedOutput
				d.CachedTokens += cachedHit
				d.TotalTokens += estimatedOutput
				dm := d.Models.Ensure(model, func() *ModelStat { return &ModelStat{Name: model} })
				dm.SuccessRequests++
				dm.OutputTokens += estimatedOutput
				dm.CachedTokens += cachedHit
				dm.TotalTokens += estimatedOutput
				da := d.Accounts.Ensure(accKey, func() *AccountStat { return &AccountStat{UID: accKey, Counter: Counter{Name: currentName}} })
				da.SuccessRequests++
				da.OutputTokens += estimatedOutput
				da.CachedTokens += cachedHit
				da.TotalTokens += estimatedOutput
			}
			if m, ok := models.Get(model); ok {
				m.SuccessRequests++
				m.OutputTokens += estimatedOutput
				m.CachedTokens += cachedHit
				m.TotalTokens += estimatedOutput
			}
			a := accounts.Ensure(accKey, func() *AccountStat { return &AccountStat{UID: accKey, Counter: Counter{Name: currentName}} })
			a.SuccessRequests++
			a.OutputTokens += estimatedOutput
			a.CachedTokens += cachedHit
			a.TotalTokens += estimatedOutput
		}
		if strings.Contains(line, "[ERROR]") && (strings.Contains(line, "上游报错") || strings.Contains(line, "处理对话请求异常") || strings.Contains(line, "处理请求异常")) {
			failedRequests++
			if d, ok := daily.Get(date); ok {
				d.FailedRequests++
			}
		}
	}
	return &Stats{
		Summary: Summary{
			TotalRequests: totalRequests, SuccessRequests: successRequests, FailedRequests: failedRequests,
			TotalInputTokens: totalInputTokens, TotalOutputTokens: totalOutputTokens, TotalCachedTokens: totalCachedTokens,
			TotalTokens: totalInputTokens + totalOutputTokens,
		},
		Models: models, Accounts: accounts, Daily: daily,
	}
}
