import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { execSync } from 'node:child_process';
import { Logger } from './logger.mjs';

// ─── 官方同款 TLS 运行栈与证书管理器 (CertificateManager 纯血复刻) ─────
export class TlsCertificateStack {
  static loadedCount = 0;

  static extractOsCertificates() {
    const certs = [];
    if (process.platform === 'win32') {
      try {
        const script = `$ErrorActionPreference = 'SilentlyContinue'; Get-ChildItem -Path Cert:\\LocalMachine\\Root, Cert:\\LocalMachine\\CA, Cert:\\CurrentUser\\Root, Cert:\\CurrentUser\\CA | ForEach-Object { [System.Convert]::ToBase64String($_.RawData) }`;
        const out = execSync(`powershell -NoProfile -NonInteractive -Command "${script}"`, { encoding: 'utf8', timeout: 4000 });
        const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const b64 of lines) {
          certs.push(`-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`);
        }
      } catch (_) {}
    } else if (process.platform === 'linux') {
      const linuxPaths = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'];
      for (const p of linuxPaths) {
        if (fs.existsSync(p)) {
          try {
            const text = fs.readFileSync(p, 'utf8');
            const m = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
            certs.push(...m);
            break;
          } catch (_) {}
        }
      }
    } else if (process.platform === 'darwin') {
      try {
        const out = execSync('security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain', { encoding: 'utf8', timeout: 4000 });
        const m = out.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
        certs.push(...m);
      } catch (_) {}
    }
    return certs;
  }

  static init() {
    const certs = [];

    // 1. 装载 Node.js 原生 Mozilla 根证书 (约 144 个)
    try {
      if (Array.isArray(tls.rootCertificates)) {
        certs.push(...tls.rootCertificates);
      }
    } catch (_) {}

    // 2. 装载系统/企业根证书 (优先读取已有 bundle，若无客户端则直接向操作系统原语自提取)
    const possibleSysCaPaths = [
      path.resolve('system-ca-bundle.pem'),
      path.resolve('ca.pem'),
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'system-ca-bundle.pem'),
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.codebuddy', 'system-ca-bundle.pem')
    ];

    let foundBundle = false;
    for (const p of possibleSysCaPaths) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          const matched = content.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
          if (matched.length > 0) {
            certs.push(...matched);
            foundBundle = true;
            Logger.info('TLS', `已载入系统/企业根证书: ${p} (包含 ${matched.length} 张 CA 证书)`);
          }
        } catch (_) {}
      }
    }

    // 兜底：若未安装官方客户端且无本地 pem，直接从操作系统本地证书库自动提取
    if (!foundBundle) {
      const nativeOsCerts = this.extractOsCertificates();
      if (nativeOsCerts.length > 0) {
        certs.push(...nativeOsCerts);
        Logger.info('TLS', `未检测到官方客户端文件，已直接从操作系统证书库自提取 ${nativeOsCerts.length} 张系统根证书`);
      }
    }

    // 3. 环境变量扩展证书 (NODE_EXTRA_CA_CERTS / WB_CA_BUNDLE)
    const envCa = process.env.WB_CA_BUNDLE || process.env.NODE_EXTRA_CA_CERTS;
    if (envCa && fs.existsSync(envCa)) {
      try {
        const extra = fs.readFileSync(envCa, 'utf8');
        const matched = extra.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
        if (matched.length > 0) {
          certs.push(...matched);
          Logger.info('TLS', `已载入环境变量额外根证书: ${envCa} (包含 ${matched.length} 张 CA 证书)`);
        }
      } catch (_) {}
    }

    // 4. 调用官方同款底座 API：全局注入 Node TLS 堆栈
    const uniqueCerts = [...new Set(certs)];
    this.loadedCount = uniqueCerts.length;
    if (typeof tls.setDefaultCACertificates === 'function' && uniqueCerts.length > 0) {
      try {
        tls.setDefaultCACertificates(uniqueCerts);
        Logger.info('TLS', `官方同款 TLS 运行栈已全局就绪：共装载 ${uniqueCerts.length} 张根证书（含系统级 CA）`);
      } catch (err) {
        Logger.warn('TLS', `setDefaultCACertificates 注入警告: ${err.message}`);
      }
    }

    // 5. 校验开关 (NODE_TLS_REJECT_UNAUTHORIZED)
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      Logger.warn('TLS', '检测到 NODE_TLS_REJECT_UNAUTHORIZED=0，已全局关闭严格证书校验');
    }
  }
}
