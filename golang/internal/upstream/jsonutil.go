package upstream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Obj 是保持键插入顺序的 JSON 对象，等价于 JS 普通对象 + JSON.stringify：
//   - 重新序列化时键顺序与解包时一致（map[string]any 会按字母序打乱）；
//   - 数字保存为 json.Number，原样回写（避免 float64 精度/格式漂移）；
//   - 嵌套对象递归为 *Obj，数组为 []any。
type Obj struct {
	keys []string
	m    map[string]any
}

// NewObj 创建空对象。
func NewObj() *Obj { return &Obj{m: map[string]any{}} }

// ObjFromMap 由 map 构造（键按字典序，保证确定性）。
func ObjFromMap(m map[string]any) *Obj {
	o := NewObj()
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		o.Set(k, m[k])
	}
	return o
}

// Get 取值（不存在返回 nil）。
func (o *Obj) Get(k string) any {
	if o == nil {
		return nil
	}
	return o.m[k]
}

// GetOK 取值并报告是否存在。
func (o *Obj) GetOK(k string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.m[k]
	return v, ok
}

// Set 追加或覆盖键（覆盖保持原位置）。
func (o *Obj) Set(k string, v any) *Obj {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
	return o
}

// Delete 删除键。
func (o *Obj) Delete(k string) {
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	for i, kk := range o.keys {
		if kk == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// Has 是否存在键。
func (o *Obj) Has(k string) bool { _, ok := o.GetOK(k); return ok }

// Keys 键顺序。
func (o *Obj) Keys() []string {
	if o == nil {
		return nil
	}
	return append([]string(nil), o.keys...)
}

// Len 键数量。
func (o *Obj) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Map 返回底层 map（只读用途）。
func (o *Obj) Map() map[string]any {
	if o == nil {
		return map[string]any{}
	}
	return o.m
}

// Clone 浅拷贝（等价 JS `{...obj}`），保持键顺序。
func (o *Obj) Clone() *Obj {
	if o == nil {
		return nil
	}
	n := NewObj()
	n.keys = append([]string(nil), o.keys...)
	for k, v := range o.m {
		n.m[k] = v
	}
	return n
}

// MarshalJSON 按插入顺序输出，不转义 HTML。
func (o *Obj) MarshalJSON() ([]byte, error) {
	if o == nil {
		return []byte("null"), nil
	}
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, err := marshalNoEscape(k)
		if err != nil {
			return nil, err
		}
		b.Write(kb)
		b.WriteByte(':')
		vb, err := marshalNoEscape(o.m[k])
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// UnmarshalJSON 解析为有序对象（递归）。
func (o *Obj) UnmarshalJSON(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return err
	}
	obj, ok := v.(*Obj)
	if !ok {
		return fmt.Errorf("upstream.Obj: expected JSON object, got %T", v)
	}
	o.keys = obj.keys
	o.m = obj.m
	return nil
}

// String 调试用。
func (o *Obj) String() string {
	b, _ := o.MarshalJSON()
	return string(b)
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return decodeFromToken(dec, tok)
}

func decodeFromToken(dec *json.Decoder, tok json.Token) (any, error) {
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := NewObj()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("upstream.Obj: invalid object key %v", kt)
				}
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(key, v)
			}
			if _, err := dec.Token(); err != nil { // '}'
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil { // ']'
				return nil, err
			}
			return arr, nil
		}
	case json.Number:
		return t, nil
	}
	return tok, nil
}

// ─── 序列化辅助 ───────────────────────────────────────────────────────────────

// MarshalJSON 紧凑 JSON，不转义 <>&（等价 JSON.stringify）。
func MarshalJSON(v any) ([]byte, error) { return marshalNoEscape(v) }

func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// ParseObj 解析 JSON 文本为有序对象；非对象返回错误。
func ParseObj(data []byte) (*Obj, error) {
	o := NewObj()
	if err := o.UnmarshalJSON(data); err != nil {
		return nil, err
	}
	return o, nil
}

// ParseAny 解析任意 JSON（数字为 json.Number，对象为 *Obj）。
func ParseAny(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return decodeValue(dec)
}

// ─── 取值辅助（JS 语义：类型不符即视为不存在） ───────────────────────────────

// GetString 仅当值为字符串时返回。
func GetString(o *Obj, k string) string {
	s, _ := o.Get(k).(string)
	return s
}

// GetStringOK 仅当值为字符串时返回 (值, true)。
func GetStringOK(o *Obj, k string) (string, bool) {
	s, ok := o.Get(k).(string)
	return s, ok
}

// GetBool 仅当值为布尔时返回。
func GetBool(o *Obj, k string) (bool, bool) {
	b, ok := o.Get(k).(bool)
	return b, ok
}

// GetObj 仅当值为对象时返回。
func GetObj(o *Obj, k string) *Obj {
	v, _ := o.Get(k).(*Obj)
	return v
}

// GetArr 仅当值为数组时返回。
func GetArr(o *Obj, k string) []any {
	v, _ := o.Get(k).([]any)
	return v
}

// GetNum 解析数字（json.Number / float64）；非数字返回 false。
func GetNum(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case string:
		f, err := json.Number(n).Float64()
		return f, err == nil
	}
	return 0, false
}

// ToStr 把任意标量转为字符串（等价 String(x)，对象/数组走 JSON）。
func ToStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case json.Number:
		return t.String()
	case float64:
		return json.Number(fmt.Sprintf("%g", t)).String()
	case *Obj:
		return t.String()
	}
	b, err := marshalNoEscape(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// Truthy JS 真值判定：false/0/""/null/undefined/NaN → false，其余 true（空数组/空对象为 true）。
func Truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case json.Number:
		f, ok := GetNum(t)
		return ok && f != 0
	case float64:
		return t != 0
	case float32:
		return t != 0
	case int:
		return t != 0
	case int64:
		return t != 0
	case *Obj:
		// 类型化 nil 指针代表 JS 的 null/undefined（GetObj 未命中时返回），必须判为假值
		return t != nil
	}
	return true
}

// JSLength 等价 JS 字符串 .length（UTF-16 码元数）。
func JSLength(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// Lower 小写。
func Lower(s string) string { return strings.ToLower(s) }

// Num 整数 → json.Number（原样回写，避免 float64 格式漂移）。
func Num(n int64) json.Number { return json.Number(strconv.FormatInt(n, 10)) }

// Itoa 整数转字符串。
func Itoa(n int) string { return strconv.Itoa(n) }
