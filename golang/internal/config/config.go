// Package config 对应 Node 版 src/config.mjs：
// 常量/路径/区域端点、Config 与 Account 持久化（原子写 + 三级恢复）、
// API Key、模型黑名单、思考/Prompt/日志/私有数据策略。
//
// 迁移原则：行为等价。所有 JSON 键名与 Node 版完全一致；未知键通过 Extra 原样保留。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

// ─── 版本与区域 ────────────────────────────────────────────────────────────────

// CurrentVersion 严格对齐 package/package.json 官方 CLI 版本（config.mjs:220）。
const CurrentVersion = "2.179.0"

// UserAgent 官方 CLI UA（config.mjs:221）。
const UserAgent = "CLI/" + CurrentVersion + " CodeBuddy/" + CurrentVersion

const (
	RegionCn   = "cn"
	RegionIntl = "intl"
)

// RegionBase 区域 base 配置（config.mjs:19-32）。
type RegionBase struct {
	Label string `json:"label"`
	API   string `json:"api"`
	Web   string `json:"web"`
}

var regionBase = map[string]RegionBase{
	RegionCn:   {Label: "国内版", API: "https://copilot.tencent.com", Web: "https://www.codebuddy.cn"},
	RegionIntl: {Label: "国际版", API: "https://www.codebuddy.ai", Web: "https://www.codebuddy.ai"},
}

// BaseForRegion 返回区域 base；未知区域回落国内版。
func BaseForRegion(region string) RegionBase {
	if b, ok := regionBase[region]; ok {
		return b
	}
	return regionBase[RegionCn]
}

// NormalizeRegion 规范化 region，未知值回落国内版（config.mjs:35-39）。
func NormalizeRegion(region string) string {
	switch strings.ToLower(trimSpace(region)) {
	case RegionIntl, "international", "global", "ai":
		return RegionIntl
	}
	return RegionCn
}

// Endpoints 某账号/区域的完整端点集合（config.mjs:183-217）。
type Endpoints struct {
	APIBase      string
	WebBase      string
	Upstream     string
	Config       string
	Summary      string
	Checkin      string
	Search       string
	WebFetch     string
	AuthState    string
	AuthRefresh  string
	Accounts     string
	LoginBase    string // `${web}/login/?platform=CLI&state=` 前缀，AuthURL/ LoginURL 生成完整 URL
	TokenBase    string // `${api}/v2/plugin/auth/token?state=` 前缀
	LoginAccBase string // `${api}/v2/plugin/login/account?state=` 前缀
}

// AuthTokenURL 轮询 token 的 URL。
func (e Endpoints) AuthTokenURL(state string) string { return e.TokenBase + urlQueryEscape(state) }

// LoginAccountURL 兜底账号查询 URL。
func (e Endpoints) LoginAccountURL(state string) string {
	return e.LoginAccBase + urlQueryEscape(state)
}

// LoginURL 官方 CLI 实际打开的登录页（web 域 + 尾斜杠 + version）。
func (e Endpoints) LoginURL(state string) string {
	return e.LoginBase + urlQueryEscape(state) + "&version=v" + CurrentVersion
}

// EndpointsForRegion 按区域拼端点（config.mjs:183-217）。
func EndpointsForRegion(region string) Endpoints {
	b := BaseForRegion(region)
	return Endpoints{
		APIBase:      b.API,
		WebBase:      b.Web,
		Upstream:     b.API + "/v2/chat/completions",
		Config:       b.API + "/v3/config",
		Summary:      b.API + "/billing/meter/get-user-resource-summary",
		Checkin:      b.Web + "/v2/billing/meter/daily-checkin",
		Search:       b.API + "/agenttool/v1/search",
		WebFetch:     b.API + "/agenttool/v1/webfetch",
		AuthState:    b.API + "/v2/plugin/auth/state?platform=CLI",
		AuthRefresh:  b.API + "/v2/plugin/auth/token/refresh",
		Accounts:     b.API + "/v2/plugin/accounts",
		LoginBase:    b.Web + "/login/?platform=CLI&state=",
		TokenBase:    b.API + "/v2/plugin/auth/token?state=",
		LoginAccBase: b.API + "/v2/plugin/login/account?state=",
	}
}

// EndpointsFor 按账号区域拼端点。
func EndpointsFor(acc *Account) Endpoints { return EndpointsForRegion(acc.Region) }

// ─── 策略常量 ──────────────────────────────────────────────────────────────────

// StickyDefaultTtlMs 会话粘性默认 7 天。
// 网关自有策略，无 CLI 对应实现：CLI 基准 3e5/18e5 为单会话消费端设计，网关多客户端长会话需要更长窗口（config.mjs:391-408）。
const StickyDefaultTtlMs int64 = 7 * 24 * 60 * 60 * 1000

const ModelBlacklistKey = "modelBlacklist"

var ValidThinkingLevels = []string{"minimal", "low", "medium", "high", "xhigh", "max"}
var ValidOverrideModes = []string{"client_first", "gateway_level_only", "gateway_override_all"}
var ValidPromptModes = []string{"passthrough", "custom", "append"}

const DefaultPromptText = "You are a helpful AI assistant."

// DefaultThinkingPolicy 网关级思考策略默认值（config.mjs:777-782）。
func DefaultThinkingPolicy() ThinkingPolicy {
	return ThinkingPolicy{Enabled: false, DefaultLevel: "high", OverrideMode: "client_first", ModelLevels: map[string]string{}}
}

// ─── Config 结构 ───────────────────────────────────────────────────────────────

// ThinkingPolicy 思考档位策略（config.mjs:765-782）。
type ThinkingPolicy struct {
	Enabled      bool              `json:"enabled"`
	DefaultLevel string            `json:"defaultLevel"`
	OverrideMode string            `json:"overrideMode"`
	ModelLevels  map[string]string `json:"modelLevels"`
}

// APIKey 多密钥条目（config.mjs:455）。
type APIKey struct {
	ID        string `json:"id"`
	Key       string `json:"key"`
	Note      string `json:"note"`
	CreatedAt int64  `json:"createdAt"`
	Enabled   bool   `json:"enabled"`
}

// Config 对应 config.json。字段顺序即输出顺序；未知键保留在 Extra。
type Config struct {
	Port                       int                        `json:"port,omitempty"`
	APIKey                     string                     `json:"apiKey,omitempty"`
	APIKeys                    []APIKey                   `json:"apiKeys,omitempty"`
	WebAuthEnabled             *bool                      `json:"webAuthEnabled,omitempty"`
	WebPassword                string                     `json:"webPassword,omitempty"`
	StickySessionEnabled       *bool                      `json:"stickySessionEnabled,omitempty"`
	StickySessionTtlMs         *int64                     `json:"stickySessionTtlMs,omitempty"`
	StickySessionMaxLifetimeMs *int64                     `json:"stickySessionMaxLifetimeMs,omitempty"`
	RoutingRegionScope         string                     `json:"routingRegionScope,omitempty"`
	RoutingStrategy            string                     `json:"routingStrategy,omitempty"`
	PinnedAccount              string                     `json:"pinnedAccount,omitempty"`
	ConcurrencyLimitEnabled    *bool                      `json:"concurrencyLimitEnabled,omitempty"`
	MaxInFlightPerAccount      *int                       `json:"maxInFlightPerAccount,omitempty"`
	AccountFailoverEnabled     *bool                      `json:"accountFailoverEnabled,omitempty"`
	ModelFallbackEnabled       *bool                      `json:"modelFallbackEnabled,omitempty"`
	ModelFallback              map[string]any             `json:"modelFallback,omitempty"`
	TokenRefreshAdvanceDays    *int                       `json:"tokenRefreshAdvanceDays,omitempty"`
	MaxLogDbSizeMb             *int                       `json:"maxLogDbSizeMb,omitempty"`
	AutoCheckin                *bool                      `json:"autoCheckin,omitempty"`
	ModelBlacklist             []string                   `json:"modelBlacklist,omitempty"`
	ThinkingPolicy             *ThinkingPolicy            `json:"thinkingPolicy,omitempty"`
	PromptMode                 string                     `json:"promptMode,omitempty"`
	PromptFile                 string                     `json:"promptFile,omitempty"`
	RequestClientInfo          *bool                      `json:"requestClientInfo,omitempty"`
	RequestArchiveContext      *bool                      `json:"requestArchiveContext,omitempty"`
	PrivateDataPolicy          string                     `json:"privateDataPolicy,omitempty"`
	Extra                      map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON 先按已知字段解析，再把未识别键收进 Extra（Node 版对象是透传的）。
func (c *Config) UnmarshalJSON(data []byte) error {
	type alias Config
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*c = Config(a)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	known := configKnownKeys()
	c.Extra = map[string]json.RawMessage{}
	for k, v := range raw {
		if !known[k] {
			c.Extra[k] = v
		}
	}
	return nil
}

// MarshalJSON 输出已知字段 + Extra，使用 2 空格缩进且不转义 HTML 字符（与 JSON.stringify(obj,null,2) 一致）。
func (c Config) MarshalJSON() ([]byte, error) {
	buf := map[string]json.RawMessage{}
	type alias Config
	b, err := json.Marshal(alias(c))
	if err != nil {
		return nil, err
	}
	var known map[string]json.RawMessage
	if err := json.Unmarshal(b, &known); err != nil {
		return nil, err
	}
	for k, v := range known {
		buf[k] = v
	}
	for k, v := range c.Extra {
		if _, exists := buf[k]; !exists {
			buf[k] = v
		}
	}
	return json.Marshal(buf)
}

func configKnownKeys() map[string]bool {
	return map[string]bool{
		"port": true, "apiKey": true, "apiKeys": true, "webAuthEnabled": true, "webPassword": true,
		"stickySessionEnabled": true, "stickySessionTtlMs": true, "stickySessionMaxLifetimeMs": true,
		"routingRegionScope": true, "routingStrategy": true, "pinnedAccount": true,
		"concurrencyLimitEnabled": true, "maxInFlightPerAccount": true, "accountFailoverEnabled": true,
		"modelFallbackEnabled": true, "modelFallback": true, "tokenRefreshAdvanceDays": true,
		"maxLogDbSizeMb": true, "autoCheckin": true, "modelBlacklist": true, "thinkingPolicy": true,
		"promptMode": true, "promptFile": true, "requestClientInfo": true, "requestArchiveContext": true,
		"privateDataPolicy": true,
	}
}

// ─── 便捷读取（带 Node 版默认值语义） ───────────────────────────────────────────

func (c *Config) boolOr(key *bool, def bool) bool {
	if key == nil {
		return def
	}
	return *key
}

// IsStickySessionEnabled 默认 true。
func (c *Config) IsStickySessionEnabled() bool { return c.boolOr(c.StickySessionEnabled, true) }

// IsConcurrencyLimitEnabled 默认 true。
func (c *Config) IsConcurrencyLimitEnabled() bool { return c.boolOr(c.ConcurrencyLimitEnabled, true) }

// IsAccountFailoverEnabled 默认 true。
func (c *Config) IsAccountFailoverEnabled() bool { return c.boolOr(c.AccountFailoverEnabled, true) }

// IsModelFallbackEnabled 默认 true。
func (c *Config) IsModelFallbackEnabled() bool { return c.boolOr(c.ModelFallbackEnabled, true) }

// IsWebAuthEnabled 默认 true。
func (c *Config) IsWebAuthEnabled() bool { return c.boolOr(c.WebAuthEnabled, true) }

// IsRequestClientInfo 默认 true。
func (c *Config) IsRequestClientInfo() bool { return c.boolOr(c.RequestClientInfo, true) }

// IsRequestArchiveContext 默认 false。
func (c *Config) IsRequestArchiveContext() bool { return c.boolOr(c.RequestArchiveContext, false) }

// MaxInFlight 默认 3。
func (c *Config) MaxInFlight() int {
	if c.MaxInFlightPerAccount != nil && *c.MaxInFlightPerAccount > 0 {
		return *c.MaxInFlightPerAccount
	}
	return 3
}

// TokenRefreshAdvanceDaysOr 默认 7。
func (c *Config) TokenRefreshAdvanceDaysOr() int {
	if c.TokenRefreshAdvanceDays != nil && *c.TokenRefreshAdvanceDays > 0 {
		return *c.TokenRefreshAdvanceDays
	}
	return 7
}

// MaxLogDbSizeMbOr 默认 30。
func (c *Config) MaxLogDbSizeMbOr() int {
	if c.MaxLogDbSizeMb != nil && *c.MaxLogDbSizeMb > 0 {
		return *c.MaxLogDbSizeMb
	}
	return 30
}

// EffectivePort 默认 8317。
func (c *Config) EffectivePort() int {
	if c.Port > 0 {
		return c.Port
	}
	return 8317
}

// ─── Store ─────────────────────────────────────────────────────────────────────

// Paths 数据目录下的全部持久化路径。
type Paths struct {
	DataDir      string
	ConfigPath   string
	AccountsPath string
	LogFilePath  string
	LogDBPath    string
	StatsPath    string
	PricingPath  string
	BackupDir    string
}

// Store 是 config + accounts 的唯一持有者。
type Store struct {
	paths               Paths
	cfg                 atomic.Pointer[Config]
	accounts            *AccountStore
	persist             sync.Mutex
	apiKeyAutogenerated bool
}

// ResolveDataDir 数据目录：GW_DATA_DIR > 可执行文件所在目录 > cwd。
// 【决策】等价 Node 的 ROOT_DIR=源码目录上级（config.mjs:226）：现网部署把入口与数据文件放同一目录。
func ResolveDataDir() string {
	if v := trimSpace(os.Getenv("GW_DATA_DIR")); v != "" {
		return v
	}
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	wd, _ := os.Getwd()
	return wd
}

// PathsFor 数据目录 → 路径集合。
func PathsFor(dataDir string) Paths {
	return Paths{
		DataDir:      dataDir,
		ConfigPath:   filepath.Join(dataDir, "config.json"),
		AccountsPath: filepath.Join(dataDir, "accounts.json"),
		LogFilePath:  filepath.Join(dataDir, "gateway.log"),
		LogDBPath:    filepath.Join(dataDir, "logs.db"),
		StatsPath:    filepath.Join(dataDir, "stats.json"),
		PricingPath:  filepath.Join(dataDir, "pricing.json"),
		BackupDir:    filepath.Join(dataDir, "backups"),
	}
}

// Open 执行模块初始化：迁移旧备份 → 加载 config（含粘性默认值）→ 加载 accounts → ensureApiKey。
func Open(dataDir string) (*Store, error) {
	if dataDir == "" {
		dataDir = ResolveDataDir()
	}
	p := PathsFor(dataDir)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("config: mkdir data dir: %w", err)
	}
	MigrateLegacyBackups(p)

	s := &Store{paths: p, accounts: NewAccountStore()}

	var cfg Config
	if err := loadJSONWithBackup(p, p.ConfigPath, &cfg); err != nil {
		return nil, err
	}
	applyConfigDefaults(&cfg)
	s.cfg.Store(&cfg)

	var rawAccounts []json.RawMessage
	if err := loadJSONWithBackup(p, p.AccountsPath, &rawAccounts); err != nil {
		return nil, err
	}
	for _, r := range rawAccounts {
		acc, err := normalizeAccountJSON(r)
		if err != nil || acc == nil {
			continue
		}
		s.accounts.upsert(acc)
	}
	s.apiKeyAutogenerated = s.EnsureAPIKey()
	return s, nil
}

// applyConfigDefaults 对齐 config.mjs:410-430。
func applyConfigDefaults(c *Config) {
	if c.StickySessionEnabled == nil {
		t := true
		c.StickySessionEnabled = &t
	}
	if c.StickySessionTtlMs == nil {
		v := StickyDefaultTtlMs
		c.StickySessionTtlMs = &v
	}
	if c.StickySessionMaxLifetimeMs == nil {
		v := StickyDefaultTtlMs
		c.StickySessionMaxLifetimeMs = &v
	}
	if c.StickySessionTtlMs != nil && c.StickySessionMaxLifetimeMs != nil && *c.StickySessionMaxLifetimeMs > 0 && *c.StickySessionMaxLifetimeMs < *c.StickySessionTtlMs {
		v := *c.StickySessionTtlMs
		c.StickySessionMaxLifetimeMs = &v
	}
	if c.RoutingRegionScope == "" {
		c.RoutingRegionScope = "all"
	}
}

// Paths 返回路径集合。
func (s *Store) Paths() Paths { return s.paths }

// Config 返回当前配置快照（只读，调用方不得修改）。
func (s *Store) Config() *Config { return s.cfg.Load() }

// APIKeyAutoGenerated 启动时是否自动生成了密钥。
func (s *Store) APIKeyAutoGenerated() bool { return s.apiKeyAutogenerated }

// UpdateConfig 拷贝 → 修改 → 原子替换 → 落盘。
func (s *Store) UpdateConfig(fn func(c *Config)) error {
	s.persist.Lock()
	defer s.persist.Unlock()
	next, err := cloneConfig(s.cfg.Load())
	if err != nil {
		return err
	}
	applyConfigDefaults(next)
	fn(next)
	s.cfg.Store(next)
	return s.SaveConfig()
}

// SaveConfig 持久化 config.json（原子写 + 备份）。
func (s *Store) SaveConfig() error {
	return writeJSONWithBackup(s.paths, s.paths.ConfigPath, s.cfg.Load())
}

// SaveAccounts 持久化 accounts.json。
func (s *Store) SaveAccounts() error {
	return s.accounts.saveTo(s.paths)
}

// SaveNow flush（停机用）。
func (s *Store) SaveNow() error {
	if err := s.SaveAccounts(); err != nil {
		return err
	}
	return s.SaveConfig()
}

// Accounts 返回账号存储。
func (s *Store) Accounts() *AccountStore { return s.accounts }

func cloneConfig(c *Config) (*Config, error) {
	if c == nil {
		return &Config{}, nil
	}
	b, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	var out Config
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

var errNotFound = errors.New("not found")
