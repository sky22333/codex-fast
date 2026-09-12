import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { CODEX_PACKAGE_NAME } from "./constants.js";
import { runCommand, type CommandResult } from "./process-runner.js";

const POWERSHELL = "powershell.exe";

/**
 * PowerShell 默认按控制台代码页输出（中文系统是 GBK），Node 按 UTF-8 解码会得到
 * 乱码，含中文的安装路径也会被破坏。所有脚本都在开头强制切换为 UTF-8 输出。
 */
const UTF8_OUTPUT = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; ";

export interface ShellPrewarmResult {
  elapsedMs: number;
  ok: boolean;
  detail?: string;
}

export interface CodexInstallation {
  aumid: string;
  installLocation: string;
}

interface PowerShellOptions {
  timeoutMs?: number;
  warmProfile?: boolean;
}

async function runPowerShell(script: string, options: PowerShellOptions = {}): Promise<CommandResult> {
  const args = ["-NoLogo"];
  // 预热要保留用户配置文件，才能真实反映 shell 环境是否拖慢启动，其余调用则跳过。
  if (options.warmProfile !== true) args.push("-NoProfile", "-ExecutionPolicy", "Bypass");
  args.push("-NonInteractive", "-Command", `${UTF8_OUTPUT}${script}`);
  return await runCommand(POWERSHELL, args, options.timeoutMs);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function discoverCodexInstallation(): Promise<CodexInstallation> {
  const script = [
    `$package = Get-AppxPackage -Name '${CODEX_PACKAGE_NAME}' | Sort-Object Version -Descending | Select-Object -First 1`,
    "if ($null -eq $package) { exit 2 }",
    "$manifest = Get-AppxPackageManifest -Package $package.PackageFullName",
    "$app = $manifest.Package.Applications.Application | Select-Object -First 1",
    "if ($null -eq $app) { exit 3 }",
    "Write-Output \"$($package.PackageFamilyName)!$($app.Id)|$($package.InstallLocation)\""
  ].join("; ");
  let result: CommandResult;
  try {
    result = await runPowerShell(script);
  } catch (error) {
    throw new Error(`无法运行 PowerShell 查询 Codex 安装信息：${describeError(error)}`);
  }
  if (result.code === 2) throw new Error("未找到 Windows 商店版 Codex，请先安装或更新 Codex。");
  if (result.code === 3) throw new Error("Codex 应用包中没有可启动的应用条目，请重新安装或更新 Codex。");
  if (result.code !== 0) throw new Error(`读取 Codex 安装信息失败（PowerShell 退出码 ${result.code}）。`);
  const line = result.stdout.split(/\r?\n/u).map((value) => value.trim()).find((value) => value.includes("!"));
  const separator = line?.indexOf("|") ?? -1;
  if (!line || separator < 1) throw new Error("无法读取 Codex 的安装信息。");
  return { aumid: line.slice(0, separator), installLocation: line.slice(separator + 1) };
}

export async function prewarmCodexShell(): Promise<ShellPrewarmResult> {
  const startedAt = Date.now();
  try {
    const result = await runPowerShell("Get-ChildItem Env: | Out-String | Out-Null", { timeoutMs: 8_000, warmProfile: true });
    return {
      elapsedMs: Date.now() - startedAt,
      ok: result.code === 0,
      ...(result.code === 0 ? {} : { detail: `PowerShell 退出码 ${result.code}` })
    };
  } catch (error) {
    return {
      elapsedMs: Date.now() - startedAt,
      ok: false,
      detail: describeError(error)
    };
  }
}

export async function getCodexProcessIds(): Promise<number[]> {
  const script = [
    "$items = Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue",
    "$ids = foreach ($item in $items) {",
    "  try { if ($item.Path -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe') { $item.Id } } catch {}",
    "}",
    "$ids | Sort-Object -Unique | ForEach-Object { Write-Output $_ }"
  ].join("\n");
  const result = await runPowerShell(script);
  if (result.code !== 0) throw new Error(`无法读取 Codex 进程列表（PowerShell 退出码 ${result.code}）。`);
  return result.stdout
    .split(/\s+/u)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function stopCodex(processIds: readonly number[]): Promise<void> {
  const uniqueIds = [...new Set(processIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  let failureCode: number | undefined;
  for (const id of uniqueIds) {
    // 进程可能刚好自己退出，taskkill 会返回非零；是否真的结束以随后的轮询结果为准，
    // 因此不解析 taskkill 的本地化文本。
    const result = await runCommand("taskkill.exe", ["/PID", String(id), "/T", "/F"]);
    if (result.code !== 0 && failureCode === undefined) failureCode = result.code;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await getCodexProcessIds()).length === 0) return;
    await wait(250);
  }
  throw new Error(
    `Codex 未能在 10 秒内完全退出${failureCode === undefined ? "" : `（taskkill 退出码 ${failureCode}）`}，请手动关闭后重试。`
  );
}

function nativeHelperPath(): string {
  return fileURLToPath(new URL("../native/bin/codex-launch-helper.exe", import.meta.url));
}

export async function validateNativeHelper(): Promise<void> {
  try {
    await access(nativeHelperPath());
  } catch {
    throw new Error("原生启动辅助程序缺失，请重新安装 @sky22333/codex-fast。");
  }
}

export async function activateCodex(aumid: string, argumentsLine: string): Promise<number> {
  const helper = nativeHelperPath();
  await validateNativeHelper();
  const result = await runCommand(helper, ["--aumid", aumid, "--arguments", argumentsLine], 10_000);
  const combined = `${result.stdout}\n${result.stderr}`;
  const pid = Number(/PID=(\d+)/u.exec(combined)?.[1]);
  if (result.code !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
    const hresult = /HRESULT=(0x[\dA-Fa-f]+)/u.exec(combined)?.[1];
    throw new Error(`Windows 无法启动 Codex${hresult ? `（${hresult}）` : ""}。`);
  }
  return pid;
}

export async function waitForCodexWindow(installLocation: string, timeoutMs = 30_000): Promise<number | undefined> {
  const executable = join(basename(installLocation), "app", "ChatGPT.exe");
  const result = await runCommand(nativeHelperPath(), [
    "--wait-window", "--executable", executable, "--timeout-ms", String(timeoutMs)
  ], timeoutMs + 5_000);
  const processId = Number(/WINDOW_PID=(\d+)/u.exec(`${result.stdout}\n${result.stderr}`)?.[1]);
  if (result.code === 0 && Number.isSafeInteger(processId) && processId > 0) return processId;
  if (result.code === 30) return undefined;
  // 原生辅助程序只输出 ASCII 标记（ERROR=、HRESULT=），可以安全地展示。
  throw new Error(`Codex 主窗口检测器运行异常（退出码 ${result.code}）：${result.stderr || result.stdout || "未知错误"}`);
}
