#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { VERSION } from "./constants.js";
import { DEFAULT_PROXY, hasCodexProxy, normalizeProxyInput, removeCodexProxy, writeCodexProxy } from "./proxy.js";
import { ensureBundledRuntime, validateBundledRuntimeSource } from "./runtime.js";
import { acquireSingleInstance } from "./single-instance.js";
import { readLatestStartupDiagnosis } from "./startup.js";
import {
  activateCodex,
  type CodexInstallation,
  discoverCodexInstallation,
  getCodexProcessIds,
  prewarmCodexShell,
  stopCodex,
  validateNativeHelper,
  waitForCodexWindow
} from "./windows.js";

const HELP = `codex-fast ${VERSION}

Windows Codex 桌面版冷启动加速工具

用法：
  codex-fast          启动并加速 Codex
  codex-fast proxy [地址或端口]  配置 Codex 代理
  codex-fast --check  检查运行环境，但不启动
  codex-fast --help   显示帮助
  codex-fast --version
`;

async function confirm(question: string, defaultValue: boolean): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await reader.question(question)).trim().toLowerCase();
    return answer === "" ? defaultValue : answer === "y" || answer === "yes";
  } finally {
    reader.close();
  }
}

function validatePlatform(): void {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("codex-fast 目前只支持 win32-x64。");
  }
}

async function runExclusively(operation: () => Promise<void>): Promise<void> {
  const instanceLock = await acquireSingleInstance();
  try {
    await operation();
  } finally {
    await instanceLock.release();
  }
}

async function promptForProxy(): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return DEFAULT_PROXY;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return await reader.question(`输入代理地址或端口 [${DEFAULT_PROXY}]：`);
  } finally {
    reader.close();
  }
}

async function configureProxy(argument: string | undefined): Promise<void> {
  if (argument === undefined) {
    if (await hasCodexProxy()) {
      if (await confirm("检测到 Codex 代理已配置。是否移除？(y/N) ", false)) {
        await removeCodexProxy();
        console.log("Codex 代理已移除，请重启 Codex 生效。");
      } else {
        console.log("已保留 Codex 代理配置。");
      }
      return;
    }
  }
  const proxy = normalizeProxyInput(argument ?? await promptForProxy());
  const changed = await writeCodexProxy(proxy);
  console.log(changed ? `代理配置完成：${proxy}\n请重启 Codex 生效。` : "Codex 代理已配置。");
}

async function launchCodex(installation: CodexInstallation): Promise<void> {
  // 预热与进程检查并行，省掉一次串行的 PowerShell 启动等待。
  const shellPrewarm = prewarmCodexShell();
  const runningIds = await getCodexProcessIds();
  if (runningIds.length > 0) {
    if (!(await confirm("检测到 Codex 正在运行。关闭并重新启动以应用加速？(Y/n) ", true))) {
      throw new Error("Codex 已在运行。请先完全退出 Codex，再重新执行 codex-fast。");
    }
    console.log("正在关闭现有 Codex…");
    await stopCodex(runningIds);
  }

  console.log("正在预热 Codex 启动环境…");
  const prepareStartedAt = Date.now();
  const [runtime, shell] = await Promise.all([
    ensureBundledRuntime(installation.installLocation),
    shellPrewarm
  ]);
  const prepareMs = Date.now() - prepareStartedAt;
  if (runtime.copied) console.log("已修复并预置本版本的 Codex 内置运行时。");
  if (!shell.ok) {
    throw new Error(`PowerShell 环境加载异常，已阻止一次注定缓慢的启动：${shell.detail ?? "未知错误"}`);
  }
  console.log(`启动环境已就绪（准备耗时 ${prepareMs}ms），正在启动 Codex…`);

  const startedAt = Date.now();
  const pid = await activateCodex(installation.aumid, "");
  const windowProcessId = await waitForCodexWindow(installation.installLocation);
  const startupMs = Date.now() - startedAt;
  if (windowProcessId !== undefined) {
    console.log(`Codex 主界面已启动（启动耗时 ${startupMs}ms）。`);
    return;
  }

  const startup = await readLatestStartupDiagnosis(startedAt);
  if (startup.diagnosis === "ready") {
    console.log(`Codex 主界面已启动（启动耗时 ${startupMs}ms）。`);
    return;
  }
  if (startup.diagnosis === "shell-env-stalled") {
    throw new Error(`Codex 进程 ${pid} 已创建，但后端仍卡在 shell 环境加载阶段（已等待 ${startupMs}ms）；未将其误报为启动成功。`);
  }
  if (startup.diagnosis === "backend-stalled") {
    throw new Error(`Codex 进程 ${pid} 已创建且后端已启动，但主窗口在 ${startupMs}ms 内仍不可见；未将其误报为启动成功。`);
  }
  throw new Error(`Codex 进程 ${pid} 已创建，但主界面在 ${startupMs}ms 内没有就绪；未将其误报为启动成功。`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(HELP);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    stdout.write(`${VERSION}\n`);
    return;
  }

  validatePlatform();
  if (args[0] === "proxy") {
    if (args.length > 2) throw new Error("proxy 子命令最多接受一个地址或端口。请运行 codex-fast --help。");
    await runExclusively(() => configureProxy(args[1]));
    return;
  }
  const checkOnly = args.length === 1 && args[0] === "--check";
  if (args.length > 0 && !checkOnly) throw new Error(`未知参数：${args.join(" ")}。请运行 codex-fast --help。`);

  const installation = await discoverCodexInstallation();
  if (checkOnly) {
    await Promise.all([
      validateBundledRuntimeSource(installation.installLocation),
      validateNativeHelper()
    ]);
    const shell = await prewarmCodexShell();
    if (!shell.ok) throw new Error(`PowerShell 环境加载异常：${shell.detail ?? "未知错误"}`);
    console.log("检查通过。");
    return;
  }

  await runExclusively(() => launchCodex(installation));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`错误：${message}`);
  process.exitCode = 1;
});
