# codex-fast

Windows 商店版 Codex 冷启动加速 CLI。

## 安装并运行

需要 Windows 10/11 x64 与 Node.js 22.14+：

```powershell
npm install -g @sky22333/codex-fast

codex-fast
```

### 直接运行
```
npx --yes @sky22333/codex-fast
```

## 配置代理

```powershell
npx --yes @sky22333/codex-fast proxy
```

直接回车使用 `http://127.0.0.1:10808`。也可以输入端口、`主机:端口`或完整的 HTTP(S) 地址，例如：

```powershell
codex-fast proxy 7890
codex-fast proxy 127.0.0.1:7890
```

命令只更新 `%USERPROFILE%\.codex\.env` 中的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`和 `NO_PROXY`，其他配置保持不变；已有的 `NO_PROXY`条目也会保留。配置后请重启 Codex。

再次运行 `codex-fast proxy`时，如果检测到代理已经配置，确认后即可移除代理。

## 它做了什么

- 预热 PowerShell 环境，避免 shell 加载阻塞拖慢启动
- 预置 `cua_node` 运行时到本地缓存，绕过 MSIX 受保护目录复制失败
- 通过 Windows API 正确激活商店应用，并检测主窗口是否就绪

不修改 Codex 安装文件、不注入页面、不常驻后台，也不影响技能与插件。

## 支持范围

- Windows 10/11 x64
- Microsoft Store 安装的 Codex
