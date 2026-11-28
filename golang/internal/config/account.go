package config

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
)

// Account 对应 accounts.json 元素（字段名与 Node 版完全一致；未知键保留在 Extra）。
type Account struct {
	UID                  string            `json:"uid,omitempty"`
	Uin                  string            `json:"uin,omitempty"`
	Email                string            `json:"email"`
	Nickname             string            `json:"nickname,omitempty"`
	PhoneNumber          string            `json:"phoneNumber,omitempty"`
	Type                 string            `json:"type,omitempty"`
	Region               string            `json:"region,omitempty"`
	AccessToken          string            `json:"accessToken,omitempty"`
	RefreshToken         string            `json:"refreshToken,omitempty"`
	ExpiresAt            int64             `json:"expiresAt,omitempty"`
	CreditsRemain        float64           `json:"creditsRemain,omitempty"`
	CreditsUpdatedAt     int64             `json:"creditsUpdatedAt,omitempty"`
	Status               string            `json:"status,omitempty"`
	InFlight             int               `json:"inFlight,omitempty"`
	Note                 string            `json:"note,omitempty"`
	Domain               string            `json:"domain,omitempty"`
	Realm                string            `json:"realm,omitempty"`
	Product              string            `json:"product,omitempty"`
	Endpoint             string            `json:"endpoint,omitempty"`
	ModelCooldowns       map[string]int64  `json:"modelCooldowns,omitempty"`
	ModelCooldownReasons map[string]string `json:"modelCooldownReasons,omitempty"`
	CooldownUntil        int64             `json:"cooldownUntil,omitempty"`
	RestrictedAt         int64             `json:"restrictedAt,omitempty"`
	RestrictedReason     string            `json:"restrictedReason,omitempty"`
	LastCheckinDate      string            `json:"lastCheckinDate,omitempty"`
	LastCheckinSuccess   bool              `json:"lastCheckinSuccess"`
	LastCheckinMsg       string            `json:"lastCheckinMsg,omitempty"`
	LastCheckinTime      string            `json:"lastCheckinTime,omitempty"`
	LastAPICallTimestamp int64             `json:"lastApiCallTimestamp,omitempty"`
	// 运行期状态（scheduler 写入并随 accounts.json 落盘，键名与 Node 版一致）
	LastUsedAt         int64                      `json:"lastUsedAt,omitempty"`
	NeedsCreditRefresh bool                       `json:"needsCreditRefresh,omitempty"`
	EnterpriseID       string                     `json:"enterpriseId,omitempty"`
	Extra              map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON 解析已知字段并保留未知键。
func (a *Account) UnmarshalJSON(data []byte) error {
	type alias Account
	var al alias
	if err := json.Unmarshal(data, &al); err != nil {
		return err
	}
	*a = Account(al)
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	a.Extra = map[string]json.RawMessage{}
	var probe alias
	pb, _ := json.Marshal(probe)
	known := map[string]json.RawMessage{}
	_ = json.Unmarshal(pb, &known)
	// 别名零值 marshal 会省略 omitempty 字段，因此改用 reflect 获取全部 json tag
	for k := range raw {
		if !accountKnownKeys[k] {
			a.Extra[k] = raw[k]
		}
	}
	return nil
}

// MarshalJSON 输出已知字段 + Extra。
func (a Account) MarshalJSON() ([]byte, error) {
	type alias Account
	b, err := json.Marshal(alias(a))
	if err != nil {
		return nil, err
	}
	m := map[string]json.RawMessage{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	for k, v := range a.Extra {
		if _, exists := m[k]; !exists {
			m[k] = v
		}
	}
	return json.Marshal(m)
}

var accountKnownKeys = map[string]bool{
	"uid": true, "uin": true, "email": true, "nickname": true, "phoneNumber": true, "type": true,
	"region": true, "accessToken": true, "refreshToken": true, "expiresAt": true, "creditsRemain": true,
	"creditsUpdatedAt": true, "status": true, "inFlight": true, "note": true, "domain": true, "realm": true,
	"product": true, "endpoint": true, "modelCooldowns": true, "modelCooldownReasons": true, "cooldownUntil": true,
	"restrictedAt": true, "restrictedReason": true, "lastCheckinDate": true, "lastCheckinSuccess": true,
	"lastCheckinMsg": true, "lastApiCallTimestamp": true, "lastCheckinTime": true,
	"lastUsedAt": true, "needsCreditRefresh": true, "enterpriseId": true,
}

// ResolveAccountRegion 从账号推断区域（config.mjs:46-56）。
func ResolveAccountRegion(a *Account) string {
	if a == nil {
		return RegionCn
	}
	if a.Region != "" {
		return NormalizeRegion(a.Region)
	}
	if a.Realm != "" {
		return NormalizeRegion(a.Realm)
	}
	ep := strings.ToLower(a.Endpoint)
	dm := strings.ToLower(a.Domain)
	if strings.Contains(ep, "codebuddy.ai") || strings.Contains(ep, "workbuddy.ai") ||
		strings.Contains(dm, "codebuddy.ai") || strings.Contains(dm, "workbuddy.ai") {
		return RegionIntl
	}
	return RegionCn
}

// HasToken 至少有一种凭据。
func (a *Account) HasToken() bool {
	return a != nil && (a.AccessToken != "" || a.RefreshToken != "")
}

// NormalizeAccount 对应 normalizeAccount（config.mjs:124-175）。
func NormalizeAccount(a *Account) *Account {
	if a == nil {
		return nil
	}
	acc := *a
	if acc.Extra == nil {
		acc.Extra = map[string]json.RawMessage{}
	}
	// 1. 缺 email 时从 accessToken JWT Payload 提取
	if acc.Email == "" && strings.Contains(acc.AccessToken, ".") {
		if payload, ok := parseJWTPayload(acc.AccessToken); ok {
			if v, ok := payload["email"].(string); ok && v != "" {
				acc.Email = v
			} else if v, ok := payload["preferred_username"].(string); ok && v != "" {
				acc.Email = v
			} else if v, ok := payload["name"].(string); ok && v != "" {
				acc.Email = v
			}
			if acc.Nickname == "" {
				if v, ok := payload["preferred_username"].(string); ok {
					acc.Nickname = v
				}
			}
			if acc.ExpiresAt == 0 {
				if exp, ok := payload["exp"].(float64); ok && exp > 0 {
					acc.ExpiresAt = int64(exp * 1000)
				}
			}
		}
	}
	if acc.Email == "" {
		if acc.Nickname != "" {
			acc.Email = acc.Nickname
		} else if acc.UID != "" {
			acc.Email = acc.UID
		} else {
			acc.Email = "unnamed-account"
		}
	}
	// 2. 区域
	acc.Region = ResolveAccountRegion(&acc)
	// 3. endpoint
	if acc.Endpoint == "" {
		if acc.Region == RegionIntl {
			acc.Endpoint = "https://www.codebuddy.ai"
		} else {
			acc.Endpoint = "https://copilot.tencent.com"
		}
	}
	// 4. 兜底
	if acc.Type == "" {
		acc.Type = "personal"
	}
	if acc.Status == "" {
		acc.Status = "healthy"
	}
	if acc.ModelCooldowns == nil {
		acc.ModelCooldowns = map[string]int64{}
	}
	if acc.ModelCooldownReasons == nil {
		acc.ModelCooldownReasons = map[string]string{}
	}
	// 5. 备注
	if acc.Note == "" {
		isWb := acc.Product == "workbuddy" || strings.Contains(acc.Domain, "workbuddy")
		if isWb {
			if acc.Region == RegionIntl {
				acc.Note = "WorkBuddy 国际版"
			} else {
				acc.Note = "WorkBuddy 国内版"
			}
		} else if acc.Region == RegionIntl {
			acc.Note = "CodeBuddy 国际版"
		} else {
			acc.Note = "国内版"
		}
	}
	return &acc
}

func normalizeAccountJSON(raw json.RawMessage) (*Account, error) {
	var a Account
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	return NormalizeAccount(&a), nil
}

// parseJWTPayload 解析 JWT 第二段（Node Buffer.from(x,'base64') 是宽松解码，这里兼容有无 padding 与 URL 安全字符）。
func parseJWTPayload(token string) (map[string]any, bool) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil, false
	}
	seg := parts[1]
	data, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		data, err = base64.URLEncoding.DecodeString(seg)
	}
	if err != nil {
		data, err = base64.RawStdEncoding.DecodeString(strings.ReplaceAll(strings.ReplaceAll(seg, "-", "+"), "_", "/"))
	}
	if err != nil {
		data, err = base64.StdEncoding.DecodeString(seg)
	}
	if err != nil {
		return nil, false
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, false
	}
	return m, true
}

// ─── AccountStore ──────────────────────────────────────────────────────────────

// AccountStore 保持 accounts.json 的数组顺序；所有读写并发安全。
type AccountStore struct {
	mu  sync.RWMutex
	ord []string
	by  map[string]*Account
}

// NewAccountStore 创建空存储。
func NewAccountStore() *AccountStore {
	return &AccountStore{by: map[string]*Account{}}
}

// List 按文件顺序返回账号快照（拷贝）。
func (s *AccountStore) List() []*Account {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Account, 0, len(s.ord))
	for _, uid := range s.ord {
		if a, ok := s.by[uid]; ok {
			c := *a
			out = append(out, &c)
		}
	}
	return out
}

// Len 账号数量。
func (s *AccountStore) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.ord)
}

// Get 返回账号快照。
func (s *AccountStore) Get(uid string) *Account {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if a, ok := s.by[uid]; ok {
		c := *a
		return &c
	}
	return nil
}

// Find 返回首个满足条件的账号快照。
func (s *AccountStore) Find(pred func(*Account) bool) *Account {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, uid := range s.ord {
		a := s.by[uid]
		if pred(a) {
			c := *a
			return &c
		}
	}
	return nil
}

// Each 持读锁遍历；fn 内禁止写。
func (s *AccountStore) Each(fn func(*Account) bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, uid := range s.ord {
		if a, ok := s.by[uid]; ok {
			if !fn(a) {
				return
			}
		}
	}
}

// Mutate 持写锁原地修改。
func (s *AccountStore) Mutate(uid string, fn func(*Account)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a, ok := s.by[uid]; ok {
		fn(a)
	}
}

// Acquire inFlight+1；返回幂等 release，调用方必须 defer。
func (s *AccountStore) Acquire(uid string) func() {
	s.mu.Lock()
	if a, ok := s.by[uid]; ok {
		a.InFlight++
	}
	s.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if a, ok := s.by[uid]; ok && a.InFlight > 0 {
				a.InFlight--
			}
		})
	}
}

// ResetInFlight 启动修正：全部归零（server.mjs:268-278）。
func (s *AccountStore) ResetInFlight() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.by {
		a.InFlight = 0
	}
}

// Upsert 按 uid 插入或替换；返回是否替换。
func (s *AccountStore) Upsert(acc *Account) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.upsert(acc)
}

func (s *AccountStore) upsert(acc *Account) bool {
	if acc == nil {
		return false
	}
	if s.by == nil {
		s.by = map[string]*Account{}
	}
	c := *acc
	if _, exists := s.by[acc.UID]; exists {
		s.by[acc.UID] = &c
		return true
	}
	s.by[acc.UID] = &c
	s.ord = append(s.ord, acc.UID)
	return false
}

// Remove 删除账号。
func (s *AccountStore) Remove(uid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.by[uid]; !ok {
		return false
	}
	delete(s.by, uid)
	for i, id := range s.ord {
		if id == uid {
			s.ord = append(s.ord[:i], s.ord[i+1:]...)
			break
		}
	}
	return true
}

// saveTo 持久化（原子写 + 备份）。
func (s *AccountStore) saveTo(p Paths) error {
	list := s.List()
	return writeJSONWithBackup(p, p.AccountsPath, list)
}

var ErrNoAccount = errors.New("no available account")
