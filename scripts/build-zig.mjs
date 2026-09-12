import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("原生辅助程序只能在 win32-x64 环境构建。");
}

const root = fileURLToPath(new URL("..", import.meta.url));
await mkdir(new URL("../native/bin/", import.meta.url), { recursive: true });

const args = [
  "build-exe",
  "native/src/main.zig",
  "-O",
  "ReleaseSmall",
  "-target",
  "x86_64-windows",
  "-lole32",
  "-luser32",
  "-ldwmapi",
  "-fstrip",
  "-femit-bin=native/bin/codex-launch-helper.exe"
];

await new Promise((resolve, reject) => {
  const child = spawn("zig", args, { cwd: root, stdio: "inherit", shell: false });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Zig 构建失败，退出码：${code ?? "未知"}`));
  });
});
