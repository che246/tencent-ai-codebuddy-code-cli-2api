package config

import (
	"regexp"
	"strings"
)

// ─── 模型黑名单（config.mjs:662-763） ─────────────────────────────────────────

// GetModelBlacklist 读取黑名单（非数组视为空；trim 去空）。
func (s *Store) GetModelBlacklist() []string {
	c := s.cfg.Load()
	out := make([]string, 0, len(c.ModelBlacklist))
	for _, x := range c.ModelBlacklist {
		if v := strings.TrimSpace(x); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// SetModelBlacklist 写入黑名单（去重 + 去空 + 保持顺序）；仅改内存，调用方负责 SaveConfig。
func (s *Store) SetModelBlacklist(list []string) []string {
	seen := map[string]bool{}
	clean := make([]string, 0, len(list))
	for _, raw := range list {
		item := strings.TrimSpace(raw)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		clean = append(clean, item)
	}
	_ = s.UpdateConfig(func(c *Config) { c.ModelBlacklist = clean })
	return clean
}

// IsModelBlacklisted 判断带前缀的模型 ID 是否被屏蔽（config.mjs:701-725）。
func (s *Store) IsModelBlacklisted(prefixedID, bareID, region string) bool {
	return IsModelBlacklisted(s.GetModelBlacklist(), prefixedID, bareID, region)
}

// IsModelBlacklisted 纯函数版本。
func IsModelBlacklisted(list []string, prefixedID, bareID, region string) bool {
	if len(list) == 0 {
		return false
	}
	pid, bare, reg := prefixedID, bareID, region
	for _, rule := range list {
		// 规则自身带区域前缀时，区域必须一致才生效
		if strings.HasPrefix(rule, "cn:") || strings.HasPrefix(rule, "intl:") {
			ruleRegion := rule[:strings.Index(rule, ":")]
			if ruleRegion != reg {
				continue
			}
			if matchModelPattern(rule, pid) {
				return true
			}
			continue
		}
		// 规则不带前缀：只按裸模型名匹配
		if matchModelPattern(rule, bare) {
			return true
		}
		// 兼容把带前缀的完整 ID 当裸名写进黑名单
		if matchModelPattern(rule, pid) {
			return true
		}
	}
	return false
}

// IsStepUnavailableByBlacklist 降级链步骤是否彻底不可用（config.mjs:753-763）。
func (s *Store) IsStepUnavailableByBlacklist(bareID string, region string) bool {
	return IsStepUnavailableByBlacklist(s.GetModelBlacklist(), bareID, region)
}

// IsStepUnavailableByBlacklist 纯函数版本。
func IsStepUnavailableByBlacklist(list []string, bareID string, region string) bool {
	bare := strings.TrimSpace(bareID)
	if bare == "" {
		return true
	}
	if region != "" {
		return IsModelBlacklisted(list, region+":"+bare, bare, region)
	}
	cnBlocked := IsModelBlacklisted(list, RegionCn+":"+bare, bare, RegionCn)
	intlBlocked := IsModelBlacklisted(list, RegionIntl+":"+bare, bare, RegionIntl)
	return cnBlocked && intlBlocked
}

// matchModelPattern 支持 * 通配符，大小写不敏感（config.mjs:728-740）。
func matchModelPattern(pattern, value string) bool {
	if pattern == "" || value == "" {
		return false
	}
	if !strings.Contains(pattern, "*") {
		return strings.EqualFold(pattern, value)
	}
	esc := regexp.QuoteMeta(pattern) // 与 JS 的 /[.+?^${}()|[\]\\]/ 转义集合等价
	esc = strings.ReplaceAll(esc, `\*`, ".*")
	re, err := regexp.Compile(`(?i)^` + esc + `$`)
	if err != nil {
		return false
	}
	return re.MatchString(value)
}
