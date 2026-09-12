import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, toNamespacedPath } from "node:path";
import { test } from "node:test";
import { copyRuntimeTree, ensureBundledRuntime } from "./runtime.js";

async function snapshot(root: string, current = root, entries = new Map<string, string>()): Promise<Map<string, string>> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const name = relative(root, path);
    if (entry.isDirectory()) {
      entries.set(`${name}\\`, "");
      await snapshot(root, path, entries);
    } else {
      entries.set(name, await readFile(path, "utf8"));
    }
  }
  return entries;
}

// 真实运行时位于 WindowsApps 下，加上内部的 pnpm store 后路径会超过 MAX_PATH，
// 用例必须覆盖同样的深度。
async function createDeepRuntime(root: string): Promise<{ source: string; destination: string }> {
  const source = toNamespacedPath(join(root, "source"));
  const destination = toNamespacedPath(join(root, "destination"));
  const deepDirectory = join(source, "bin", ...Array.from({ length: 26 }, (_, index) => `pnpm-store-${index}`), "tslib");
  await mkdir(deepDirectory, { recursive: true });
  await mkdir(join(source, "空目录"), { recursive: true });
  const deepFile = join(deepDirectory, "tslib.es6.js");
  await writeFile(deepFile, "export {};\n");
  await writeFile(join(source, "manifest.json"), "{}\n");
  assert.ok(deepFile.length - source.length > 255, "用例必须覆盖超过 MAX_PATH 的路径");
  return { source, destination };
}

test("copyRuntimeTree 复制超过 MAX_PATH 的深层路径、空目录与非 ASCII 名称", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-fast-copy-"));
  try {
    const { source, destination } = await createDeepRuntime(root);
    await copyRuntimeTree(source, destination);
    assert.deepEqual(await snapshot(destination), await snapshot(source));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureBundledRuntime 只复制一次，并在缓存不完整时重新复制", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-fast-runtime-"));
  try {
    const installLocation = join(root, "install");
    const localAppData = join(root, "local");
    const sourceRoot = join(installLocation, "app", "resources", "cua_node");
    await mkdir(join(sourceRoot, "bin", "node_modules", "@oai"), { recursive: true });
    await writeFile(join(sourceRoot, "manifest.json"), "{\"version\":1}\n");
    await writeFile(join(sourceRoot, "bin", "node.exe"), "node-binary\n");
    await writeFile(join(sourceRoot, "bin", "node_repl.exe"), "repl-binary\n");
    await writeFile(join(sourceRoot, "bin", "node_modules", "@oai", "sky.js"), "sky\n");

    const first = await ensureBundledRuntime(installLocation, localAppData);
    assert.equal(first.copied, true);
    const cached = join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node", first.hash);
    assert.deepEqual(await snapshot(cached), await snapshot(sourceRoot));

    assert.deepEqual(await ensureBundledRuntime(installLocation, localAppData), { copied: false, hash: first.hash });

    await unlink(join(cached, "bin", "node_repl.exe"));
    const repaired = await ensureBundledRuntime(installLocation, localAppData);
    assert.deepEqual(repaired, { copied: true, hash: first.hash });
    assert.deepEqual(await snapshot(cached), await snapshot(sourceRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
