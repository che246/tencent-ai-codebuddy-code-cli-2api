package config

import (
	"fmt"
	"strings"
	"time"
)

// ─── 时间与格式化工具 ───────────────────────────────────────────────────────────

// TodayString 本地日期 YYYY-MM-DD（config.mjs:593-599）。
func TodayString() string { return time.Now().Local().Format("2006-01-02") }

// TodayStringAt 指定时间的本地日期。
func TodayStringAt(t time.Time) string { return t.Local().Format("2006-01-02") }

// LocalTimeString 本地时间 YYYY-MM-DD HH:mm:ss（config.mjs:601-610）。
func LocalTimeString(t time.Time) string { return t.Local().Format("2006-01-02 15:04:05") }

// UTCTodayString 裁剪 cutoff 用 UTC 日期。
// 【疑点 D4 照搬】日志时间为本地、裁剪日期为 UTC，与 Node 版 new Date().toISOString().slice(0,10) 一致。
func UTCTodayString() string { return time.Now().UTC().Format("2006-01-02") }

// FormatUptime 毫秒 → 人类可读运行时长（config.mjs:624-635）。
func FormatUptime(ms int64) string {
	if ms <= 0 {
		return "0 秒"
	}
	sec := ms / 1000
	if sec < 60 {
		return fmt.Sprintf("%d 秒", sec)
	}
	min := sec / 60
	if min < 60 {
		return fmt.Sprintf("%d 分 %02d 秒", min, sec%60)
	}
	hour := min / 60
	if hour < 24 {
		return fmt.Sprintf("%d 小时 %02d 分", hour, min%60)
	}
	day := hour / 24
	return fmt.Sprintf("%d 天 %02d 小时", day, hour%24)
}

// AccountLogName `[email|uid] (备注: note)`（config.mjs:638-646）。
func AccountLogName(a *Account) string {
	if a == nil {
		return "未知账号"
	}
	name := a.Email
	if name == "" {
		name = a.UID
	}
	if name == "" {
		name = "未知账号"
	}
	note := strings.TrimSpace(a.Note)
	if note != "" {
		return fmt.Sprintf("%s (备注: %s)", name, note)
	}
	return name
}

// AccountFullDesc `name (备注: note, uid)`（config.mjs:648-660）。
func AccountFullDesc(a *Account) string {
	if a == nil {
		return "未知账号"
	}
	name := a.Email
	if name == "" {
		name = a.UID
	}
	if name == "" {
		name = "未知账号"
	}
	var parts []string
	if note := strings.TrimSpace(a.Note); note != "" {
		parts = append(parts, "备注: "+note)
	}
	if a.UID != "" {
		parts = append(parts, a.UID)
	}
	if len(parts) > 0 {
		return fmt.Sprintf("%s (%s)", name, strings.Join(parts, ", "))
	}
	return name
}

// MaskKey 密钥脱敏：前 8 + **** + 后 4；长度 ≤12 则 ****（routes.mjs:237-239）。
func MaskKey(key string) string {
	if len(key) > 12 {
		return key[:8] + "****" + key[len(key)-4:]
	}
	return "****"
}

func trimSpace(s string) string { return strings.TrimSpace(s) }

// urlQueryEscape 等价 encodeURIComponent（JS）：保留 A-Z a-z 0-9 - _ . ! ~ * ' ( )。
func urlQueryEscape(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}
