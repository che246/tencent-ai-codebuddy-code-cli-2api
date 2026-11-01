#!/usr/bin/env node

/**
 * Tencent CodeBuddy 2API 网关服务入口 (生产级多协议适配器)
 * 架构已完成模块化分层解耦，业务与协议逻辑均位于 src/ 体系中：
 *   - src/config.mjs          : 全局配置、账号与常量
 *   - src/core/               : 基础设施 (日志、系统 TLS 证书栈、账号调度器)
 *   - src/upstream/           : 官方协议与上游适配 (请求头、Gzip、错误码、模型矩阵)
 *   - src/adapters/           : 客户端协议转译 (OpenAI, Anthropic, 官方搜索/抓取)
 *   - src/web/                : 控制台单页静态文件与运维 REST API
 *   - src/server.mjs          : HTTP 服务主入口
 */

import './src/server.mjs';
