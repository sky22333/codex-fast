import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";

const REQUIRED_FILES = ["manifest.json", "bin/node.exe", "bin/node_repl.exe"] as const;
const COPY_CONCURRENCY = 4;

export interface RuntimePreparation {
  copied: boolean;
  hash: string;
}

interface RuntimeFile {
  source: string;
  destination: string;
}

/**
 * Windows 的 260 字符路径上限靠扩展长度前缀（\\?\）绕过，而放宽该上限的
 * LongPathsEnabled 开关在用户机器上并不一定打开。这里显式转换，保证深层目录在任何
 * 机器上都能读写；转换是幂等的，非 Windows 平台原样返回。
 */
function extendedPath(path: string): string {
  return process.platform === "win32" ? toNamespacedPath(path) : path;
}

export async function validateBundledRuntimeSource(installLocation: string): Promise<void> {
  const sourceRoot = join(installLocation, "app", "resources", "cua_node");
  await Promise.all(REQUIRED_FILES.map((name) => access(join(sourceRoot, name))));
  await access(join(sourceRoot, "bin", "node_modules"));
}

async function digestFile(path: string): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    hash.update(buffer);
  }
  return { digest: hash.digest("hex"), size };
}

async function runtimeIdentity(sourceRoot: string): Promise<{
  hash: string;
  files: ReadonlyArray<{ digest: string; name: string; size: number }>;
}> {
  const files = [];
  const combined = createHash("sha256");
  for (const name of REQUIRED_FILES) {
    const identity = await digestFile(join(sourceRoot, name));
    files.push({ ...identity, name });
    combined.update(name);
    combined.update("\0");
    combined.update(identity.digest);
    combined.update("\0");
  }
  return { files, hash: combined.digest("hex").slice(0, 16) };
}

async function runtimeIsComplete(
  destinationRoot: string,
  files: ReadonlyArray<{ digest: string; name: string; size: number }>
): Promise<boolean> {
  try {
    if (!(await stat(join(destinationRoot, "bin", "node_modules"))).isDirectory()) return false;
    for (const expected of files) {
      const path = join(destinationRoot, expected.name);
      if ((await stat(path)).size !== expected.size) return false;
      if ((await digestFile(path)).digest !== expected.digest) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * MSIX 受保护目录里的文件带 EFS 加密，CopyFile 对它们会以没有具体错误码的 UNKNOWN
 * 失败——这正是 Codex 自身对这种失败也要退回“先读入内存再写出”的原因。
 */
function needsReadWriteFallback(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, errno } = error as NodeJS.ErrnoException;
  return errno === 6000 || (errno === -4094 && code === "UNKNOWN");
}

/**
 * 建立目标目录结构并收集待复制的文件（空目录也会一并保留）。
 */
async function indexRuntimeTree(sourceRoot: string, destinationRoot: string, files: RuntimeFile[]): Promise<void> {
  await mkdir(destinationRoot, { recursive: true });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    const isDirectory = entry.isSymbolicLink() ? (await stat(source)).isDirectory() : entry.isDirectory();
    if (isDirectory) {
      await indexRuntimeTree(source, destination, files);
      continue;
    }
    files.push({ source, destination });
  }
}

/**
 * 递归复制 Codex 内置运行时。
 *
 * 不能用 xcopy：`cua_node` 里的文件路径超过 255 个字符，xcopy 只会以“内存不足”
 * （退出码 4）失败。改用 Node 的 fs 之后还有一个关键细节：EFS 加密的源文件会让
 * copyFile 逐个失败，而每次失败都很昂贵——实测 4052 个文件全部先失败一次要多花
 * 约 90 秒。因此这里只探测一次，失败后整棵树都改用“读入内存再写出”。
 * 单文件复制在等待解密与落盘，因此再用少量并发把等待重叠掉。
 */
export async function copyRuntimeTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  const files: RuntimeFile[] = [];
  await indexRuntimeTree(extendedPath(sourceRoot), extendedPath(destinationRoot), files);

  let kernelCopyUsable = true;
  const copyOne = async (file: RuntimeFile): Promise<void> => {
    if (kernelCopyUsable) {
      try {
        await copyFile(file.source, file.destination);
        return;
      } catch (error) {
        if (!needsReadWriteFallback(error)) throw error;
        kernelCopyUsable = false;
      }
    }
    await writeFile(file.destination, await readFile(file.source));
  };

  let cursor = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, async () => {
    while (failure === undefined) {
      const file = files[cursor];
      if (file === undefined) return;
      cursor += 1;
      try {
        await copyOne(file);
      } catch (error) {
        if (failure === undefined) failure = error;
        return;
      }
    }
  }));
  if (failure !== undefined) throw failure;
}

export async function ensureBundledRuntime(
  installLocation: string,
  localAppData = process.env.LOCALAPPDATA ?? ""
): Promise<RuntimePreparation> {
  if (!localAppData) throw new Error("无法读取 LOCALAPPDATA，不能准备 Codex 运行时。");
  const sourceRoot = extendedPath(join(installLocation, "app", "resources", "cua_node"));
  await access(sourceRoot);
  const identity = await runtimeIdentity(sourceRoot);
  const destinationParent = join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
  const destinationRoot = extendedPath(join(destinationParent, identity.hash));
  if (await runtimeIsComplete(destinationRoot, identity.files)) return { copied: false, hash: identity.hash };

  await mkdir(destinationParent, { recursive: true });
  const stagingRoot = extendedPath(join(destinationParent, `.codex-fast-staging-${identity.hash}-${randomUUID()}`));
  try {
    await copyRuntimeTree(sourceRoot, stagingRoot);
    if (!(await runtimeIsComplete(stagingRoot, identity.files))) throw new Error("复制后的运行时完整性检查失败");
    await rm(destinationRoot, { force: true, recursive: true });
    await rename(stagingRoot, destinationRoot);
    return { copied: true, hash: identity.hash };
  } catch (error) {
    await rm(stagingRoot, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}
