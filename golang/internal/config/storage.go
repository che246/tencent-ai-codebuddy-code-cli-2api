package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ─── 健壮 JSON 容错解析（config.mjs:63-115） ───────────────────────────────────

// RobustParseJSON 对应 robustParseJson：
// 先直接解析；失败则去尾逗号/分号、"accounts": 片段补 '{'，再按栈自动闭合未配对的 " } ]。
func RobustParseJSON(str string) (json.RawMessage, error) {
	s := strings.TrimSpace(str)
	if s == "" {
		return nil, nil
	}
	if json.Valid([]byte(s)) {
		return json.RawMessage(s), nil
	}
	s = strings.TrimSpace(strings.TrimRight(strings.TrimSpace(s), ",;"))
	if len(s) > 0 && s[0] == '"' || len(s) > 0 && s[0] == '\'' {
		// 可能以 "accounts": 开头
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, `"accounts"`) || strings.HasPrefix(lower, `'accounts'`) || strings.HasPrefix(lower, "accounts") {
		rest := strings.TrimSpace(lower[strings.IndexAny(lower, ":"):])
		if strings.HasPrefix(rest, ":") {
			s = "{" + s
		}
	}
	var stack []byte
	inString := false
	escape := false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if escape {
			escape = false
			continue
		}
		if ch == '\\' {
			escape = true
			continue
		}
		if ch == '"' {
			inString = !inString
			continue
		}
		if !inString {
			switch ch {
			case '{':
				stack = append(stack, '}')
			case '[':
				stack = append(stack, ']')
			case '}', ']':
				if n := len(stack); n > 0 && stack[n-1] == ch {
					stack = stack[:n-1]
				}
			}
		}
	}
	if inString {
		s += `"`
	}
	for i := len(stack) - 1; i >= 0; i-- {
		s += string(stack[i])
	}
	if !json.Valid([]byte(s)) {
		return nil, fmt.Errorf("robustParseJson: invalid JSON after repair")
	}
	return json.RawMessage(s), nil
}

// ─── 路径工具 ───────────────────────────────────────────────────────────────────

// EnsureBackupDir 确保 backups/ 存在（config.mjs:249-255）。
func EnsureBackupDir(p Paths) {
	_ = os.MkdirAll(p.BackupDir, 0o755)
}

// BackupPath 主文件在 backups/ 中的镜像路径（config.mjs:258-261）。
func BackupPath(p Paths, mainPath string) string {
	return filepath.Join(p.BackupDir, filepath.Base(mainPath)+".bak")
}

// MigrateLegacyBackups 把根目录遗留 .bak 迁入 backups/（config.mjs:267-293）。
func MigrateLegacyBackups(p Paths) {
	EnsureBackupDir(p)
	for _, name := range []string{"accounts.json.bak", "accounts.json.bak-credits", "config.json.bak", "stats.json.bak", "pricing.json.bak"} {
		oldPath := filepath.Join(p.DataDir, name)
		newPath := filepath.Join(p.BackupDir, name)
		if _, err := os.Stat(oldPath); err != nil {
			continue
		}
		if _, err := os.Stat(newPath); err != nil {
			if data, err := os.ReadFile(oldPath); err == nil {
				_ = os.WriteFile(newPath, data, 0o644)
			}
		}
		_ = os.Remove(oldPath)
	}
}

// marshalPretty 与 JSON.stringify(obj, null, 2) 等价：2 空格缩进、不转义 <>&。
func marshalPretty(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// WriteJSONWithBackup 原子写 + 镜像备份（config.mjs:300-326）。
// 【网关自有策略】tmp → rename；Windows 下目标被占用时 rename 失败 → 回退直接写入（与 Node 容错一致）。
func WriteJSONWithBackup(p Paths, mainPath string, data any) error {
	EnsureBackupDir(p)
	content, err := marshalPretty(data)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(p, mainPath, content); err != nil {
		return err
	}
	return os.WriteFile(BackupPath(p, mainPath), content, 0o644)
}

func writeJSONWithBackup(p Paths, mainPath string, v any) error {
	return WriteJSONWithBackup(p, mainPath, v)
}

func writeFileAtomic(_ Paths, mainPath string, content []byte) error {
	tmpPath := fmt.Sprintf("%s.%d.%s.tmp", mainPath, time.Now().UnixMilli(), randString(4))
	err := os.WriteFile(tmpPath, content, 0o644)
	if err == nil {
		err = os.Rename(tmpPath, mainPath)
	}
	if err != nil {
		// 容错：rename 异常（跨盘符或被极端进程锁定时）退回直接写入
		if werr := os.WriteFile(mainPath, content, 0o644); werr != nil {
			return werr
		}
	}
	_ = os.Remove(tmpPath)
	return nil
}

func randString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

// loadJSONWithBackup 三级恢复（config.mjs:335-386）：主文件 → backups/ → 根目录 legacy .bak。
func loadJSONWithBackup(p Paths, mainPath string, out any) error {
	EnsureBackupDir(p)
	bakPath := BackupPath(p, mainPath)
	legacyBakPath := mainPath + ".bak"

	if data, ok := readHealthyJSON(mainPath); ok {
		if err := json.Unmarshal(data, out); err == nil {
			if _, statErr := os.Stat(bakPath); statErr != nil {
				_ = os.WriteFile(bakPath, data, 0o644)
			}
			return nil
		}
	}
	if data, ok := readHealthyJSON(bakPath); ok {
		if err := json.Unmarshal(data, out); err == nil {
			pretty, _ := marshalPretty(out)
			_ = os.WriteFile(mainPath, pretty, 0o644)
			return nil
		}
	}
	if data, ok := readHealthyJSON(legacyBakPath); ok {
		if err := json.Unmarshal(data, out); err == nil {
			pretty, _ := marshalPretty(out)
			_ = os.WriteFile(mainPath, pretty, 0o644)
			_ = os.WriteFile(bakPath, pretty, 0o644)
			_ = os.Remove(legacyBakPath)
			return nil
		}
	}
	return nil
}

// LoadJSONWithBackup 公开版本（供 metrics/pricing 复用）。
func LoadJSONWithBackup(p Paths, mainPath string, out any) error {
	return loadJSONWithBackup(p, mainPath, out)
}

func readHealthyJSON(path string) ([]byte, bool) {
	data, err := os.ReadFile(path)
	if err != nil || len(bytes.TrimSpace(data)) <= 1 {
		return nil, false
	}
	if !json.Valid(data) {
		return nil, false
	}
	return data, true
}

var errInvalidJSON = errors.New("invalid json")
