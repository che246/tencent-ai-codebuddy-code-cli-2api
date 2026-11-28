package config

import (
	"os"
	"path/filepath"
	"strings"
)

// ─── 思考档位策略（config.mjs:765-825） ────────────────────────────────────────

// GetThinkingPolicy 读取并规范化策略。
func (s *Store) GetThinkingPolicy() ThinkingPolicy {
	c := s.cfg.Load()
	p := c.ThinkingPolicy
	if p == nil {
		return DefaultThinkingPolicy()
	}
	out := ThinkingPolicy{
		Enabled:      p.Enabled,
		DefaultLevel: "high",
		OverrideMode: "client_first",
		ModelLevels:  map[string]string{},
	}
	if contains(ValidThinkingLevels, p.DefaultLevel) {
		out.DefaultLevel = p.DefaultLevel
	}
	if contains(ValidOverrideModes, p.OverrideMode) {
		out.OverrideMode = p.OverrideMode
	}
	for k, v := range p.ModelLevels {
		out.ModelLevels[k] = v
	}
	return out
}

// SetThinkingPolicy 对应 setThinkingPolicy。
func (s *Store) SetThinkingPolicy(enabled *bool, defaultLevel, overrideMode *string, modelLevels map[string]string) (ThinkingPolicy, error) {
	err := s.UpdateConfig(func(c *Config) {
		cur := DefaultThinkingPolicy()
		if c.ThinkingPolicy != nil {
			cur = normalizeThinking(c.ThinkingPolicy)
		}
		next := ThinkingPolicy{Enabled: cur.Enabled, DefaultLevel: cur.DefaultLevel, OverrideMode: cur.OverrideMode, ModelLevels: map[string]string{}}
		if enabled != nil {
			next.Enabled = *enabled
		}
		if defaultLevel != nil && contains(ValidThinkingLevels, *defaultLevel) {
			next.DefaultLevel = *defaultLevel
		}
		if overrideMode != nil && contains(ValidOverrideModes, *overrideMode) {
			next.OverrideMode = *overrideMode
		}
		if modelLevels != nil {
			for k, v := range modelLevels {
				next.ModelLevels[k] = v
			}
		} else {
			for k, v := range cur.ModelLevels {
				next.ModelLevels[k] = v
			}
		}
		c.ThinkingPolicy = &next
	})
	return s.GetThinkingPolicy(), err
}

// SetModelThinkingLevel 对应 setModelThinkingLevel。
func (s *Store) SetModelThinkingLevel(modelID, level string) (ThinkingPolicy, error) {
	if strings.TrimSpace(modelID) == "" {
		return s.GetThinkingPolicy(), nil
	}
	err := s.UpdateConfig(func(c *Config) {
		cur := DefaultThinkingPolicy()
		if c.ThinkingPolicy != nil {
			cur = normalizeThinking(c.ThinkingPolicy)
		}
		levels := map[string]string{}
		for k, v := range cur.ModelLevels {
			levels[k] = v
		}
		if level == "" || level == "default" {
			delete(levels, modelID)
		} else {
			levels[modelID] = level
		}
		c.ThinkingPolicy = &ThinkingPolicy{Enabled: cur.Enabled, DefaultLevel: cur.DefaultLevel, OverrideMode: cur.OverrideMode, ModelLevels: levels}
	})
	return s.GetThinkingPolicy(), err
}

func normalizeThinking(p *ThinkingPolicy) ThinkingPolicy {
	out := ThinkingPolicy{Enabled: p.Enabled, DefaultLevel: "high", OverrideMode: "client_first", ModelLevels: map[string]string{}}
	if contains(ValidThinkingLevels, p.DefaultLevel) {
		out.DefaultLevel = p.DefaultLevel
	}
	if contains(ValidOverrideModes, p.OverrideMode) {
		out.OverrideMode = p.OverrideMode
	}
	for k, v := range p.ModelLevels {
		out.ModelLevels[k] = v
	}
	return out
}

// ─── 系统提示词策略（config.mjs:835-884） ──────────────────────────────────────

// LoadSystemPromptContent 读取提示词文件；跨系统按 basename 回落到数据目录；失败用默认文本。
func (s *Store) LoadSystemPromptContent(filePath string) string {
	target := strings.TrimSpace(filePath)
	if target == "" {
		return DefaultPromptText
	}
	if data, err := os.ReadFile(target); err == nil && strings.TrimSpace(string(data)) != "" {
		return string(data)
	}
	fallback := filepath.Join(s.paths.DataDir, filepath.Base(target))
	if data, err := os.ReadFile(fallback); err == nil && strings.TrimSpace(string(data)) != "" {
		return string(data)
	}
	return DefaultPromptText
}

// PromptPolicy {mode, file}。
type PromptPolicy struct {
	Mode string `json:"mode"`
	File string `json:"file"`
}

// GetPromptPolicy 对应 getPromptPolicy。
func (s *Store) GetPromptPolicy() PromptPolicy {
	c := s.cfg.Load()
	mode := "passthrough"
	if contains(ValidPromptModes, c.PromptMode) {
		mode = c.PromptMode
	}
	return PromptPolicy{Mode: mode, File: strings.TrimSpace(c.PromptFile)}
}

// SetPromptPolicy 对应 setPromptPolicy。
func (s *Store) SetPromptPolicy(mode *string, file *string) (PromptPolicy, error) {
	err := s.UpdateConfig(func(c *Config) {
		if mode != nil && contains(ValidPromptModes, *mode) {
			c.PromptMode = *mode
		}
		if file != nil {
			c.PromptFile = strings.TrimSpace(*file)
		}
	})
	return s.GetPromptPolicy(), err
}

// ─── 日志策略（config.mjs:889-905） ───────────────────────────────────────────

// LoggingPolicy {requestClientInfo, requestArchiveContext}。
type LoggingPolicy struct {
	RequestClientInfo     bool `json:"requestClientInfo"`
	RequestArchiveContext bool `json:"requestArchiveContext"`
}

// GetLoggingPolicy 对应 getLoggingPolicy。
func (s *Store) GetLoggingPolicy() LoggingPolicy {
	c := s.cfg.Load()
	return LoggingPolicy{RequestClientInfo: c.IsRequestClientInfo(), RequestArchiveContext: c.IsRequestArchiveContext()}
}

// SetLoggingPolicy 对应 setLoggingPolicy。
func (s *Store) SetLoggingPolicy(clientInfo, archiveContext *bool) (LoggingPolicy, error) {
	err := s.UpdateConfig(func(c *Config) {
		if clientInfo != nil {
			c.RequestClientInfo = clientInfo
		}
		if archiveContext != nil {
			c.RequestArchiveContext = archiveContext
		}
	})
	return s.GetLoggingPolicy(), err
}

// ─── 私有数据策略（config.mjs:909-922） ──────────────────────────────────────

// GetPrivateDataPolicy 'auto' | 'true' | 'false'，默认 auto。
func (s *Store) GetPrivateDataPolicy() string {
	switch s.cfg.Load().PrivateDataPolicy {
	case "true", "false":
		return s.cfg.Load().PrivateDataPolicy
	}
	return "auto"
}

// SetPrivateDataPolicy 接受 "true"/"false"/"auto" 或 bool。
func (s *Store) SetPrivateDataPolicy(val any) (string, error) {
	normalized := "auto"
	switch v := val.(type) {
	case bool:
		if v {
			normalized = "true"
		} else {
			normalized = "false"
		}
	case string:
		if v == "true" || v == "false" {
			normalized = v
		}
	}
	err := s.UpdateConfig(func(c *Config) { c.PrivateDataPolicy = normalized })
	return normalized, err
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
