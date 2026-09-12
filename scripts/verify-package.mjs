import { access } from "node:fs/promises";

const REQUIRED_FILES = ["../dist/cli.js", "../native/bin/codex-launch-helper.exe"];

for (const relative of REQUIRED_FILES) {
  try {
    await access(new URL(relative, import.meta.url));
  } catch {
    throw new Error(`缺少运行必需文件：${relative.slice(3)}（请先执行 npm run build）`);
  }
}

console.log(`发布产物校验通过：${REQUIRED_FILES.length} 个运行必需文件齐全。`);
