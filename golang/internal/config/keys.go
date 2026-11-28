package config

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	mathrand "math/rand"
	"strings"
	"time"
)

// ─── API Key（config.mjs:435-576） ─────────────────────────────────────────────

// SafeCompareTokens 常量时间比对（config.mjs:435-444）。
func SafeCompareTokens(a, b string) bool {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if a == "" || b == "" {
		return false
	}
	ab, bb := []byte(a), []byte(b)
	if len(ab) != len(bb) {
		return false
	}
	return subtle.ConstantTimeCompare(ab, bb) == 1
}

// GenerateRandomApiKey 格式 sk-cb-<48 位 hex>（config.mjs:449-451）。
func GenerateRandomApiKey() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		// 极端情况回退到 math/rand（仅用于不可预测性要求较低的场景）
		var rng = mathrand.New(mathrand.NewSource(time.Now().UnixNano()))
		rng.Read(b)
	}
	return "sk-cb-" + hex.EncodeToString(b)
}

func newKeyID() string {
	return fmt.Sprintf("key_%d_%s", time.Now().UnixMilli(), randString(4))
}

// GetAPIKeys 对应 getApiKeys（config.mjs:458-473）：空列表且有历史 apiKey 时纳管为默认主密钥。
func (s *Store) GetAPIKeys() []APIKey {
	c := s.cfg.Load()
	if c.APIKeys == nil {
		_ = s.UpdateConfig(func(n *Config) { n.APIKeys = []APIKey{} })
		c = s.cfg.Load()
	}
	if len(c.APIKeys) == 0 && strings.TrimSpace(c.APIKey) != "" {
		entry := APIKey{ID: fmt.Sprintf("key_%d", time.Now().UnixMilli()), Key: strings.TrimSpace(c.APIKey), Note: "默认主密钥", CreatedAt: time.Now().UnixMilli(), Enabled: true}
		_ = s.UpdateConfig(func(n *Config) { n.APIKeys = []APIKey{entry} })
		return []APIKey{entry}
	}
	out := make([]APIKey, len(c.APIKeys))
	copy(out, c.APIKeys)
	return out
}

// IsValidAPIKey 对应 isValidApiKey（config.mjs:479-495）。
func (s *Store) IsValidAPIKey(token string) bool {
	token = strings.TrimSpace(token)
	if token == "" {
		return false
	}
	c := s.cfg.Load()
	keys := s.GetAPIKeys()
	if len(keys) == 0 {
		return c.APIKey != "" && SafeCompareTokens(token, c.APIKey)
	}
	for _, k := range keys {
		if k.Enabled && SafeCompareTokens(token, k.Key) {
			return true
		}
	}
	return false
}

// AddAPIKey 对应 addApiKey（config.mjs:500-516）。
func (s *Store) AddAPIKey(key, note string) (APIKey, error) {
	actualKey := strings.TrimSpace(key)
	if actualKey == "" {
		actualKey = GenerateRandomApiKey()
	}
	var entry APIKey
	err := s.UpdateConfig(func(c *Config) {
		if c.APIKeys == nil {
			c.APIKeys = []APIKey{}
		}
		actualNote := strings.TrimSpace(note)
		if actualNote == "" {
			actualNote = fmt.Sprintf("密钥 #%d", len(c.APIKeys)+1)
		}
		entry = APIKey{ID: newKeyID(), Key: actualKey, Note: actualNote, CreatedAt: time.Now().UnixMilli(), Enabled: true}
		c.APIKeys = append(c.APIKeys, entry)
		syncPrimary(c)
	})
	return entry, err
}

// UpdateAPIKey 对应 updateApiKey（config.mjs:521-532）。
func (s *Store) UpdateAPIKey(id string, note *string, enabled *bool, key *string) (*APIKey, error) {
	var updated *APIKey
	err := s.UpdateConfig(func(c *Config) {
		for i := range c.APIKeys {
			if c.APIKeys[i].ID == id || c.APIKeys[i].Key == id {
				if note != nil {
					c.APIKeys[i].Note = strings.TrimSpace(*note)
				}
				if enabled != nil {
					c.APIKeys[i].Enabled = *enabled
				}
				if key != nil && strings.TrimSpace(*key) != "" {
					c.APIKeys[i].Key = strings.TrimSpace(*key)
				}
				e := c.APIKeys[i]
				updated = &e
				break
			}
		}
		if updated != nil {
			syncPrimary(c)
		}
	})
	if updated == nil && err == nil {
		return nil, errors.New("未找到指定密钥")
	}
	return updated, err
}

// RemoveAPIKey 对应 removeApiKey（config.mjs:537-549），至少保留一个。
func (s *Store) RemoveAPIKey(id string) error {
	keys := s.GetAPIKeys()
	if len(keys) <= 1 {
		return errors.New("系统至少需要保留一个有效 API Key，不能全部删除")
	}
	found := false
	return s.UpdateConfig(func(c *Config) {
		out := c.APIKeys[:0]
		for _, k := range c.APIKeys {
			if !found && (k.ID == id || k.Key == id) {
				found = true
				continue
			}
			out = append(out, k)
		}
		c.APIKeys = out
		syncPrimary(c)
	})
}

// EnsureAPIKey 对应 ensureApiKey（config.mjs:555-576）；返回是否新建。
func (s *Store) EnsureAPIKey() bool {
	c := s.cfg.Load()
	keys := c.APIKeys
	if len(keys) == 0 {
		newKey := GenerateRandomApiKey()
		_ = s.UpdateConfig(func(n *Config) {
			n.APIKey = newKey
			n.APIKeys = []APIKey{{ID: fmt.Sprintf("key_%d", time.Now().UnixMilli()), Key: newKey, Note: "默认主密钥", CreatedAt: time.Now().UnixMilli(), Enabled: true}}
		})
		return true
	}
	first := firstActive(keys)
	if first != nil && c.APIKey != first.Key {
		_ = s.UpdateConfig(func(n *Config) { n.APIKey = first.Key })
	}
	return false
}

func firstActive(keys []APIKey) *APIKey {
	for i := range keys {
		if keys[i].Enabled {
			return &keys[i]
		}
	}
	if len(keys) > 0 {
		return &keys[0]
	}
	return nil
}

// syncPrimary config.apiKey = 首个启用项（或首项）。
func syncPrimary(c *Config) {
	if fa := firstActive(c.APIKeys); fa != nil {
		c.APIKey = fa.Key
	}
}
