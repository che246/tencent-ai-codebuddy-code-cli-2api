// Package tlscerts 对应 Node 版 src/core/tls-certs.mjs（TlsCertificateStack）。
// 来源顺序：系统根证书池（替代 Node 内置 Mozilla 根证书，见下方差异说明）→ 本地/官方客户端 pem bundle
// → OS 自提取（Windows powershell / macOS security / Linux crt）→ 环境变量附加证书。
// 【差异】Node 自带 ~144 张 Mozilla 根证书；Go 只读系统。容器镜像需安装 ca-certificates，或通过 WB_CA_BUNDLE 提供。
package tlscerts

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"codebuddy-gateway/internal/core/logger"
)

// Stack 证书栈。
type Stack struct {
	pool        *x509.CertPool
	loadedCount int
	insecure    bool
}

var pemBlockRe = regexp.MustCompile(`-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----`)

// Load 构建证书池；lg 可为 nil。
func Load(lg *logger.Logger) *Stack {
	s := &Stack{}
	// 1. 系统根证书池（替代 Node 内置 Mozilla 根证书）
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	// 2. 本地 / 官方客户端 bundle
	home := os.Getenv("USERPROFILE")
	if home == "" {
		home = os.Getenv("HOME")
	}
	candidates := []string{
		filepath.Join(cwdOrDot(), "system-ca-bundle.pem"),
		filepath.Join(cwdOrDot(), "ca.pem"),
		filepath.Join(home, ".workbuddy", "system-ca-bundle.pem"),
		filepath.Join(home, ".codebuddy", "system-ca-bundle.pem"),
	}
	foundBundle := false
	count := 0
	for _, p := range candidates {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		blocks := pemBlockRe.FindAllString(string(data), -1)
		if len(blocks) == 0 {
			continue
		}
		for _, b := range blocks {
			if pool.AppendCertsFromPEM([]byte(b)) {
				count++
			}
		}
		foundBundle = true
		if lg != nil {
			lg.Info("TLS", "已载入系统/企业根证书: "+p+" (包含 "+strconv.Itoa(len(blocks))+" 张 CA 证书)")
		}
	}
	// 兜底：直接从操作系统证书库自提取
	if !foundBundle {
		blocks := extractOSCertificates()
		if len(blocks) > 0 {
			for _, b := range blocks {
				if pool.AppendCertsFromPEM([]byte(b)) {
					count++
				}
			}
			if lg != nil {
				lg.Info("TLS", "未检测到官方客户端文件，已直接从操作系统证书库自提取 "+strconv.Itoa(len(blocks))+" 张系统根证书")
			}
		}
	}
	// 3. 环境变量扩展证书
	envCa := os.Getenv("WB_CA_BUNDLE")
	if envCa == "" {
		envCa = os.Getenv("NODE_EXTRA_CA_CERTS")
	}
	if envCa != "" {
		if data, err := os.ReadFile(envCa); err == nil {
			blocks := pemBlockRe.FindAllString(string(data), -1)
			for _, b := range blocks {
				if pool.AppendCertsFromPEM([]byte(b)) {
					count++
				}
			}
			if len(blocks) > 0 && lg != nil {
				lg.Info("TLS", "已载入环境变量额外根证书: "+envCa+" (包含 "+strconv.Itoa(len(blocks))+" 张 CA 证书)")
			}
		}
	}
	s.pool = pool
	s.loadedCount = count
	if lg != nil {
		lg.Info("TLS", "官方同款 TLS 运行栈已全局就绪：共装载 "+strconv.Itoa(count)+" 张根证书（含系统级 CA）")
	}
	// 4. 校验开关
	if os.Getenv("NODE_TLS_REJECT_UNAUTHORIZED") == "0" {
		s.insecure = true
		if lg != nil {
			lg.Warn("TLS", "检测到 NODE_TLS_REJECT_UNAUTHORIZED=0，已全局关闭严格证书校验")
		}
	}
	return s
}

// Pool 供 http.Transport.TLSClientConfig.RootCAs 使用。
func (s *Stack) Pool() *x509.CertPool {
	if s == nil || s.pool == nil {
		return nil
	}
	return s.pool
}

// LoadedCount 去重后的附加证书数。
func (s *Stack) LoadedCount() int {
	if s == nil {
		return 0
	}
	return s.loadedCount
}

// InsecureSkipVerify 对应 NODE_TLS_REJECT_UNAUTHORIZED=0（安全风险，保持兼容）。
func (s *Stack) InsecureSkipVerify() bool { return s != nil && s.insecure }

// TLSClientConfig 生成上游 TLS 配置。
func (s *Stack) TLSClientConfig() *tls.Config {
	return &tls.Config{RootCAs: s.Pool(), InsecureSkipVerify: s.InsecureSkipVerify(), MinVersion: tls.VersionTLS12}
}

// extractOsCertificates 对应 extractOsCertificates（tls-certs.mjs:11-42）。
func extractOSCertificates() []string {
	var certs []string
	switch runtime.GOOS {
	case "windows":
		script := `$ErrorActionPreference = 'SilentlyContinue'; Get-ChildItem -Path Cert:\LocalMachine\Root, Cert:\LocalMachine\CA, Cert:\CurrentUser\Root, Cert:\CurrentUser\CA | ForEach-Object { [System.Convert]::ToBase64String($_.RawData) }`
		ctx, cancel := context.WithTimeout(context.Background(), 4000*time.Millisecond)
		defer cancel()
		out, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
		if err != nil {
			return nil
		}
		for _, line := range strings.Split(string(out), "\n") {
			b64 := strings.TrimSpace(line)
			if b64 == "" {
				continue
			}
			var wrapped []string
			for i := 0; i < len(b64); i += 64 {
				end := i + 64
				if end > len(b64) {
					end = len(b64)
				}
				wrapped = append(wrapped, b64[i:end])
			}
			certs = append(certs, "-----BEGIN CERTIFICATE-----\n"+strings.Join(wrapped, "\n")+"\n-----END CERTIFICATE-----")
		}
	case "linux":
		for _, p := range []string{"/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"} {
			data, err := os.ReadFile(p)
			if err != nil {
				continue
			}
			certs = append(certs, pemBlockRe.FindAllString(string(data), -1)...)
			break
		}
	case "darwin":
		ctx, cancel := context.WithTimeout(context.Background(), 4000*time.Millisecond)
		defer cancel()
		out, err := exec.CommandContext(ctx, "security", "find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain").Output()
		if err == nil {
			certs = append(certs, pemBlockRe.FindAllString(string(out), -1)...)
		}
	}
	return certs
}

func cwdOrDot() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}
