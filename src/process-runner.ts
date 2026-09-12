import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Windows 自带命令按控制台代码页写输出（中文系统是 GBK），而 Node 只能按 UTF-8
 * 解码，直接使用会得到乱码。因此这里按字节收集、最后统一解码，并丢弃无法解码的
 * 字节：结构化标记（PID=、WINDOW_PID=、HRESULT= 等）都是纯 ASCII，不受影响；
 * 本地化文本则不会以乱码形式出现在用户面前。
 */
function decodeOutput(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").replace(/\uFFFD/gu, "").trim();
}

export async function runCommand(command: string, args: readonly string[], timeoutMs = 15_000): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          shell: false,
          stdio: "ignore"
        });
        killer.unref();
      } else {
        child.kill("SIGKILL");
      }
      finish(() => reject(new Error(`命令执行超时：${command}`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk); });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("exit", (code) => {
      finish(() => resolve({ code: code ?? -1, stdout: decodeOutput(stdout), stderr: decodeOutput(stderr) }));
    });
  });
}
