package upstream

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strings"
	"time"
)

// UUIDv7 生成 UUID v7（36 字符带横线）——对齐 CLI 的 uuidv7().toString()
// （package/dist/codebuddy-headless.js 模块 34506）。
// 结构：48 位毫秒时间戳 | 4 位版本(7) | 12 位 rand_a | 2 位变体(10) | 62 位 rand_b（headers.mjs:92-111）。
func UUIDv7() string {
	var b [16]byte
	ms := time.Now().UnixMilli()
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	_, _ = rand.Read(b[6:])
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// UUIDv7Hex UUID v7 去横线 32 位 hex（CLI 的 toHex()）。
func UUIDv7Hex() string { return strings.ReplaceAll(UUIDv7(), "-", "") }

// UUIDv4 等价 crypto.randomUUID()（Anthropic 适配层 msgId 用）。
func UUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// UUIDv4Hex UUID v4 去横线。
func UUIDv4Hex() string { return strings.ReplaceAll(UUIDv4(), "-", "") }

// RandomHex n 字节随机数的 hex 表示（等价 crypto.randomBytes(n).toString('hex')）。
func RandomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// UUIDv7Regex 判断是否合法 UUID v7 文本（headers.mjs:207，大小写不敏感）。
var uuidV7Re = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// Hex32Regex 判断是否 32 位 hex（headers.mjs:210，大小写不敏感）。
var hex32Re = regexp.MustCompile(`(?i)^[0-9a-f]{32}$`)
