// 每日签到 / 国际版活跃打卡（scheduler.mjs:759-1060）。
package scheduler

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/upstream"
)

var (
	checkinLangs     = []string{"Python", "TypeScript", "JavaScript", "Go", "Rust", "Java", "C++", "Shell", "SQL", "Kotlin"}
	checkinKeywords  = []string{"async/await", "defer", "match", "yield", "const", "static", "lambda", "interface", "struct", "enum"}
	checkinTools     = []string{"Git", "Linux bash", "Docker", "cURL", "Nginx", "grep", "jq"}
	checkinAlgos     = []string{"QuickSort", "Binary Search", "Hash Table lookup", "MergeSort", "Dijkstra's algorithm", "LRU Cache"}
	checkinHTTPCodes = []string{"204 No Content", "301 Moved Permanently", "400 Bad Request", "401 Unauthorized", "403 Forbidden", "404 Not Found", "429 Too Many Requests", "500 Internal Error", "502 Bad Gateway", "503 Service Unavailable"}
	// IntlCheckinPrompts 兼容老调用引用的提示词列表。
	IntlCheckinPrompts = []string{
		"Give me an inspiring thought about engineering craftsmanship in under 15 words.",
		"How do I safely parse a JSON string in Python? Answer in one line.",
		"What does the CAP theorem state in distributed databases? Keep it under 20 words.",
		"In Linux bash, what command checks free memory in human-readable format?",
	}
	intlCheckinModel = "deepseek-v4.1-flash"
)

func pick(arr []string) string { return arr[rand.Intn(len(arr))] }
func randInt(min, max int) int { return rand.Intn(max-min+1) + min }

// GenerateDynamicCheckinDialogue 国际版拟真打卡对话动态生成器 (Anti-Pattern / Anti-Fingerprint)。
// 超参数严格对齐官方 CLI：DEFAULT_TEMPERATURE = 1，不进行人工超参数扰动。
func GenerateDynamicCheckinDialogue() (string, float64) {
	generators := []func() string{
		// 1. 编程语言语法与工程小贴士
		func() string {
			return fmt.Sprintf("How do I format an ISO date string in %s? Give a one-line example.", pick(checkinLangs))
		},
		func() string {
			return fmt.Sprintf("What is the recommended way to handle null or undefined in %s? Brief tip.", pick(checkinLangs))
		},
		func() string {
			return fmt.Sprintf("Give a concise 1-line %s snippet to read environment variables.", pick(checkinLangs))
		},
		func() string {
			return fmt.Sprintf("What does the '%s' keyword do in %s? Explain in one sentence.", pick(checkinKeywords), pick(checkinLangs))
		},
		func() string {
			return fmt.Sprintf("How do I safely parse a JSON string in %s? Answer in one line.", pick(checkinLangs))
		},
		func() string {
			return fmt.Sprintf("Show a quick %s one-liner to filter out empty strings from an array or list.", pick(checkinLangs))
		},
		func() string {
			return fmt.Sprintf("What is the idiomatic way to handle file I/O errors in %s? Short tip.", pick(checkinLangs))
		},
		func() string {
			return fmt.Sprintf("Give an example of a simple dictionary/map lookup with a fallback default in %s.", pick(checkinLangs))
		},
		// 2. 命令行与 DevOps / Linux 运维
		func() string {
			return fmt.Sprintf("In %s, what command shows the recent commit summaries or status? Give just the command.", pick(checkinTools))
		},
		func() string {
			return "In Linux bash, what command checks free memory or disk usage in human-readable format? Brief command."
		},
		func() string { return "How do I pass a custom Authorization Bearer header using curl? Give the flag." },
		func() string { return "What is the difference between git rebase and git merge in one sentence?" },
		func() string {
			return "How do I format or pretty-print a JSON file using the jq command line tool? Short example."
		},
		func() string {
			return "In Linux, how do I find processes listening on a specific port using ss or lsof? One command."
		},
		func() string {
			return "What command lists running Docker containers with their CPU and memory usage? One line."
		},
		// 3. 算法、数据结构与系统设计
		func() string {
			return fmt.Sprintf("What is the average time complexity of %s? Answer in one line.", pick(checkinAlgos))
		},
		func() string {
			return "In REST API design, why should a GET request be idempotent and safe? Brief note."
		},
		func() string {
			return "What is the key difference between horizontal scaling and vertical scaling in cloud architecture?"
		},
		func() string {
			return "What is the main benefit of connection pooling in database drivers? Short answer."
		},
		func() string { return "Explain what a race condition is in concurrent programming in one sentence." },
		func() string {
			return "What does the CAP theorem state in distributed databases? Keep it under 20 words."
		},
		// 4. 通用日常与工程生活问答
		func() string {
			return "Give me an inspiring thought about engineering craftsmanship in under 15 words."
		},
		func() string {
			return fmt.Sprintf("Calculate %d + %d * %d. Return only the calculated number.", randInt(11, 49), randInt(12, 58), randInt(2, 6))
		},
		func() string { return "Share one practical ergonomics tip for programmers sitting at a desk all day." },
		func() string {
			return fmt.Sprintf("What does HTTP status code %s indicate? Explain in 5 words.", pick(checkinHTTPCodes))
		},
		func() string {
			return "Name three core principles of writing clean, maintainable software in bullet points."
		},
		func() string {
			return "Give a friendly, polite one-sentence message thanking a colleague for a prompt code review."
		},
		func() string {
			return "What is a good naming convention for boolean variables in code? Give two examples."
		},
	}
	// 超参数严格对齐官方 CLI 对话规范：
	// 官方 CLI DEFAULT_TEMPERATURE = 1，package/product.json 声明 deepseek-v4.1-flash temperature: 1
	// 不进行人工超参数扰动，与官方 CLI 请求体完全一致
	promptText := generators[rand.Intn(len(generators))]()
	// 官方 CLI DEFAULT_TEMPERATURE = 1
	temperature := 1.0
	return promptText, temperature
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// CheckinResult 签到结果。
type CheckinResult struct {
	Success          bool   `json:"success"`
	AlreadyCheckedIn bool   `json:"alreadyCheckedIn,omitempty"`
	Msg              string `json:"msg"`
}

// DailyCheckin 每日签到入口：国内版调官方 checkin 接口，国际版发起一次轻量活跃对话。
func (s *Scheduler) DailyCheckin(uid string, force bool) CheckinResult {
	acc := s.accounts().Get(uid)
	if acc == nil {
		return CheckinResult{Success: false, Msg: "无有效 Token"}
	}
	if acc.AccessToken == "" {
		return CheckinResult{Success: false, Msg: "无有效 Token"}
	}
	if acc.Status == "restricted" {
		return CheckinResult{Success: false, Msg: "账号已被上游风控限制 (11140)，已跳过签到"}
	}
	if config.ResolveAccountRegion(acc) == config.RegionIntl {
		return s.dailyCheckinIntl(acc, force)
	}
	return s.dailyCheckinCn(acc, force)
}

// dailyCheckinCn 国内版每日签到：调用官方 /v2/billing/meter/daily-checkin 接口领积分。
func (s *Scheduler) dailyCheckinCn(acc *config.Account, force bool) CheckinResult {
	if s.client == nil {
		return CheckinResult{Success: false, Msg: "网络错误: 上游客户端未初始化"}
	}
	today := config.TodayStringAt(s.now())
	// 1. 前置状态判断：当天若已成功签到且非强制，则直接返回已签到状态，避免频繁重复调用上游
	isAlreadyDoneToday := acc.LastCheckinDate == today && (acc.LastCheckinSuccess ||
		strings.Contains(acc.LastCheckinMsg, "已签到") || strings.Contains(acc.LastCheckinMsg, "成功"))
	if !force && isAlreadyDoneToday {
		return CheckinResult{Success: true, AlreadyCheckedIn: true, Msg: orElse(acc.LastCheckinMsg, "今天已签到，请明天再来")}
	}
	ctx, cancel := context.WithTimeout(s.rootCtx(), 10*time.Second)
	defer cancel()
	status, body, err := s.client.DoJSON(ctx, http.MethodPost, s.epFn(acc).Checkin, billingHeaders(acc.AccessToken), []byte("{}"))
	if err != nil {
		s.lg.Error("CHECKIN", fmt.Sprintf("账号 [%s] 签到网络异常: %s", config.AccountFullDesc(acc), err.Error()))
		return CheckinResult{Success: false, Msg: "网络错误: " + err.Error()}
	}
	data, perr := upstream.ParseObj(body)
	if perr != nil {
		// Node 版 `await res.json()` 抛错 → 进入 catch → 记录网络异常
		s.lg.Error("CHECKIN", fmt.Sprintf("账号 [%s] 签到网络异常: %s", config.AccountFullDesc(acc), perr.Error()))
		return CheckinResult{Success: false, Msg: "网络错误: " + perr.Error()}
	}
	_ = status
	rawMsg := upstream.GetString(data, "msg")
	isSuccess := jsonNumZero(data.Get("code")) || strings.Contains(rawMsg, "成功")
	isAlready := strings.Contains(rawMsg, "已签到") || strings.Contains(rawMsg, "明天再来")
	userMsg := rawMsg
	switch {
	case isSuccess:
		userMsg = "签到成功，已领积分"
		s.accounts().Mutate(acc.UID, func(x *config.Account) {
			x.LastCheckinDate, x.LastCheckinSuccess, x.LastCheckinTime, x.LastCheckinMsg = today, true, config.LocalTimeString(s.now()), userMsg
		})
	case isAlready:
		userMsg = "今天已签到，请明天再来"
		s.accounts().Mutate(acc.UID, func(x *config.Account) {
			x.LastCheckinDate, x.LastCheckinSuccess, x.LastCheckinTime, x.LastCheckinMsg = today, true, config.LocalTimeString(s.now()), userMsg
		})
	case strings.Contains(rawMsg, "企业账号"):
		userMsg = "企业账号不支持签到"
		s.accounts().Mutate(acc.UID, func(x *config.Account) {
			x.LastCheckinDate, x.LastCheckinSuccess, x.LastCheckinTime, x.LastCheckinMsg = today, false, config.LocalTimeString(s.now()), userMsg
		})
	default:
		userMsg = orElse(rawMsg, "签到失败")
		s.accounts().Mutate(acc.UID, func(x *config.Account) { x.LastCheckinSuccess = false })
	}
	s.lg.Info("CHECKIN", fmt.Sprintf("账号 [%s] 签到: %s", config.AccountFullDesc(acc), userMsg))
	s.RefreshCredits(acc.UID)
	_ = s.store.SaveAccounts()
	return CheckinResult{Success: isSuccess || isAlready, Msg: userMsg}
}

// dailyCheckinIntl 国际版每日打卡：官方国际版无单独 checkin 接口，每日与上游发起一次轻量随机对话即视为活跃并激活当日奖励。
func (s *Scheduler) dailyCheckinIntl(acc *config.Account, force bool) CheckinResult {
	if s.client == nil {
		return CheckinResult{Success: false, Msg: "网络错误: 上游客户端未初始化"}
	}
	today := config.TodayStringAt(s.now())
	isAlreadyDoneToday := acc.LastCheckinDate == today && (acc.LastCheckinSuccess ||
		strings.Contains(acc.LastCheckinMsg, "完成") || strings.Contains(acc.LastCheckinMsg, "成功") ||
		strings.Contains(acc.LastCheckinMsg, "已签到") || strings.Contains(acc.LastCheckinMsg, "已打卡"))
	if !force && isAlreadyDoneToday {
		return CheckinResult{Success: true, AlreadyCheckedIn: true, Msg: orElse(acc.LastCheckinMsg, "今天已完成活跃打卡，请明天再来")}
	}
	model := intlCheckinModel
	promptText, temperature := GenerateDynamicCheckinDialogue()
	messages := []*upstream.Obj{upstream.NewObj().Set("role", "user").Set("content", promptText)}
	messages = upstream.EnsureLeadingSystemMessage(messages, config.RegionIntl)
	msgsAny := make([]any, 0, len(messages))
	for _, m := range messages {
		msgsAny = append(msgsAny, m)
	}
	upstreamPayload := upstream.NewObj().
		Set("model", model).
		Set("messages", msgsAny).
		Set("stream", true).
		Set("temperature", numJSON(temperature)).
		Set("stream_options", upstream.NewObj().Set("include_usage", true)).
		Set("extra_vars", upstream.NewObj().Set("initiator", "user").Set("interactionType", "prompt"))
	body, isGzip, _ := upstream.PrepareUpstreamBody(upstreamPayload)
	headers := upstream.BuildOfficialUpstreamHeaders(s.lg, acc.AccessToken, model, "checkin-"+num(float64(s.nowMs())), acc.UID, isGzip, acc, s.store.Config().PrivateDataPolicy)
	ep := s.epFn(acc)
	ctx, cancel := context.WithTimeout(s.rootCtx(), 20*time.Second)
	defer cancel()
	res, err := s.client.Do(ctx, http.MethodPost, ep.Upstream, headers, body)
	if err != nil {
		s.lg.Error("CHECKIN", fmt.Sprintf("国际版账号 [%s] 活跃对话打卡异常: %s", config.AccountFullDesc(acc), err.Error()))
		return CheckinResult{Success: false, Msg: "网络错误: " + err.Error()}
	}
	defer res.Body.Close()
	status := res.StatusCode
	if !isOK(status) {
		errBytes, _ := io.ReadAll(res.Body)
		errText := string(errBytes)
		parsedErr, _ := upstream.ParseObj(errBytes)
		bizCode := 0
		if parsedErr != nil {
			if c, ok := upstream.ExtractStructuredBizCode(parsedErr, 6); ok {
				bizCode = c
			} else if c, ok := parsedErr.Get("code").(json.Number); ok {
				f, _ := c.Float64()
				bizCode = int(f)
			}
		}
		s.accounts().Mutate(acc.UID, func(x *config.Account) {
			x.LastCheckinDate, x.LastCheckinSuccess, x.LastCheckinTime = today, false, config.LocalTimeString(s.now())
		})
		if (bizCode != 0 && upstream.AccountRestrictedCodes[bizCode]) || status == http.StatusForbidden {
			reason := "账号存在异常行为，已被限制使用 (11140)"
			if parsedErr != nil {
				dm := upstream.GetObj(parsedErr, "displayMsg")
				reason = orElse(orElse(upstream.GetString(dm, "zh"), upstream.GetString(parsedErr, "msg")), reason)
			}
			lastMsg := fmt.Sprintf("上游风控受限 (11140): %s", reason)
			s.accounts().Mutate(acc.UID, func(x *config.Account) {
				x.Status = "restricted"
				x.RestrictedAt = s.nowMs()
				x.RestrictedReason = reason
				x.LastCheckinMsg = lastMsg
			})
			codeStr := num(float64(bizCode))
			if bizCode == 0 {
				codeStr = "11140"
			}
			s.lg.Error("CHECKIN", fmt.Sprintf("国际版账号 [%s] 触发上游风控限制 (HTTP 403 / %s): %s，已自动标记为受限并移出调度池", config.AccountFullDesc(acc), codeStr, reason))
			_ = s.store.SaveAccounts()
			return CheckinResult{Success: false, Msg: lastMsg}
		}
		lastMsg := fmt.Sprintf("对话打卡失败 (HTTP %d)", status)
		s.accounts().Mutate(acc.UID, func(x *config.Account) { x.LastCheckinMsg = lastMsg })
		s.lg.Error("CHECKIN", fmt.Sprintf("国际版账号 [%s] 活跃对话打卡失败 HTTP %d: %s", config.AccountFullDesc(acc), status, jsSlice(errText, 150)))
		_ = s.store.SaveAccounts()
		return CheckinResult{Success: false, Msg: lastMsg}
	}
	// 消费流式响应完成对话链路
	replyText := readCheckinReply(res.Body)
	userMsg := "活跃对话完成，已激活当日奖励"
	s.accounts().Mutate(acc.UID, func(x *config.Account) {
		x.LastCheckinDate, x.LastCheckinSuccess, x.LastCheckinTime, x.LastCheckinMsg = today, true, config.LocalTimeString(s.now()), userMsg
	})
	s.lg.Info("CHECKIN", fmt.Sprintf("国际版账号 [%s] 活跃对话打卡成功: [%s...] (上游回复: %s)", config.AccountFullDesc(acc), jsSlice(promptText, 50), orElse(jsSlice(strings.TrimSpace(replyText), 30), "OK")))
	// 稍等 1 秒待上游入账后刷新积分
	_ = sleepCtx(s.rootCtx(), 1200*time.Millisecond)
	s.RefreshCredits(acc.UID)
	_ = s.store.SaveAccounts()
	return CheckinResult{Success: true, Msg: userMsg}
}

// readCheckinReply 读取打卡对话 SSE，累积 delta.content（逐行 data: 事件，忽略 [DONE]）。
func readCheckinReply(r io.Reader) string {
	replyText := ""
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") && !strings.Contains(line, "[DONE]") {
			if data, err := upstream.ParseObj([]byte(line[6:])); err == nil {
				if choices := upstream.GetArr(data, "choices"); len(choices) > 0 {
					if ch, ok := choices[0].(*upstream.Obj); ok {
						replyText += upstream.GetString(upstream.GetObj(ch, "delta"), "content")
					}
				}
			}
		}
	}
	return replyText
}

// CheckAndRunHourlyCheckin 每小时定时轮巡：未签到的账号或进入新一天时自动补签；返回 (成功数, 跳过数)。
func (s *Scheduler) CheckAndRunHourlyCheckin(force bool) (int, int) {
	today := config.TodayStringAt(s.now())
	checkedCount, skippedCount := 0, 0
	for _, acc := range s.accounts().List() {
		if acc.AccessToken == "" || acc.Status != "healthy" {
			continue
		}
		// 检查当天签到/打卡状态：如果当天已完成，则跳过，直至次日零点跨天后再检测
		isAlreadyDoneToday := acc.LastCheckinDate == today && (acc.LastCheckinSuccess ||
			strings.Contains(acc.LastCheckinMsg, "已签到") || strings.Contains(acc.LastCheckinMsg, "已打卡") ||
			strings.Contains(acc.LastCheckinMsg, "成功") || strings.Contains(acc.LastCheckinMsg, "完成"))
		if !force && isAlreadyDoneToday {
			skippedCount++
			continue
		}
		// 避免规律性连续突发：若目标账号为国际版且本次已有账号打卡，引入 8 ~ 20 秒随机休眠打散时序
		if config.ResolveAccountRegion(acc) == config.RegionIntl && checkedCount > 0 {
			jitterMs := 8000 + rand.Intn(12000)
			if sleepCtx(s.rootCtx(), time.Duration(jitterMs)*time.Millisecond) != nil {
				return checkedCount, skippedCount
			}
		}
		// 未签到或已跨入新的一天，进行签到/打卡（国内版走签到接口，国际版走活跃对话）
		res := s.DailyCheckin(acc.UID, force)
		if res.Success {
			checkedCount++
		}
	}
	if checkedCount > 0 {
		s.lg.Info("SCHEDULER", fmt.Sprintf("每小时签到巡检：成功为 %d 个账号完成签到/活跃打卡（%d 个账号今日已完成自动跳过）", checkedCount, skippedCount))
	}
	return checkedCount, skippedCount
}
