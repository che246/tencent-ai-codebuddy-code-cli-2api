package upstream

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"os"
	"time"

	"codebuddy-gateway/internal/core/logger"
)

// ─── 上游 HTTP 客户端（架构文档 §8） ────────────────────────────────────────────

// Client 上游 HTTP 客户端；所有上游请求共用同一连接池与 TLS 配置。
type Client struct {
	http *http.Client
	lg   *logger.Logger
}

func tlsConfig(rootCAs *x509.CertPool, insecure bool) *tls.Config {
	return &tls.Config{RootCAs: rootCAs, InsecureSkipVerify: insecure, MinVersion: tls.VersionTLS12}
}

// NewClient 构造客户端。rootCAs 来自 tlscerts.Stack.Pool()；insecure 对应 NODE_TLS_REJECT_UNAUTHORIZED=0。
//   - HTTP/1.1（ForceAttemptHTTP2=false；Node fetch/undici 默认 HTTP/1.1）
//   - MaxIdleConnsPerHost=64 / IdleConnTimeout=90s（近似 undici 连接池）
//   - 代理：仅当 GW_UPSTREAM_PROXY 设置时遵循环境代理（Node fetch 不读环境代理，默认 nil 保持等价）
//   - 无总超时：首字节/静默超时由 Lifecycle 统一控制
func NewClient(rootCAs *x509.CertPool, insecure bool, lg *logger.Logger) *Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ForceAttemptHTTP2 = false
	tr.MaxIdleConns = 0
	tr.MaxIdleConnsPerHost = 64
	tr.IdleConnTimeout = 90 * time.Second
	tr.TLSClientConfig = tlsConfig(rootCAs, insecure)
	tr.ResponseHeaderTimeout = 0
	if os.Getenv("GW_UPSTREAM_PROXY") != "" {
		tr.Proxy = http.ProxyFromEnvironment
	} else {
		tr.Proxy = nil
	}
	return &Client{http: &http.Client{Transport: tr}, lg: lg}
}

// HTTPClient 暴露底层客户端（仅供测试注入 Transport）。
func (c *Client) HTTPClient() *http.Client { return c.http }

// Do 发送请求；ctx 控制取消（来自 Lifecycle.Ctx()）。调用方负责关闭 resp.Body。
// 请求头按键原样写入（不经 Canonical 化），保持与抓包一致的大小写。
func (c *Client) Do(ctx context.Context, method, rawURL string, headers http.Header, body []byte) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, rd)
	if err != nil {
		return nil, err
	}
	for k, vs := range headers {
		req.Header[k] = append([]string(nil), vs...)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		logWarn(c.lg, "NETWORK", "上游请求失败: "+method+" "+rawURL+" | "+err.Error())
		return nil, err
	}
	return resp, nil
}

// DoJSON 发送并读取完整响应体（非流式接口）。
func (c *Client) DoJSON(ctx context.Context, method, rawURL string, headers http.Header, body []byte) (int, []byte, error) {
	resp, err := c.Do(ctx, method, rawURL, headers, body)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, data, nil
}
