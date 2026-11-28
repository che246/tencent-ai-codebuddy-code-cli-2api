package database

import (
	"bytes"
	"encoding/json"
)

// marshalCompact 紧凑 JSON，不转义 <>&（与 JSON.stringify 一致）。
func marshalCompact(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// parseJSONOrString 能解析则返回对象，否则原样字符串。
func parseJSONOrString(s string) any {
	var v any
	if err := json.Unmarshal([]byte(s), &v); err == nil {
		return v
	}
	return s
}
