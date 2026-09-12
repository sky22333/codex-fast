import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PROXY = "http://127.0.0.1:10808";
const REQUIRED_NO_PROXY = ["localhost", "127.0.0.1", "::1"] as const;
const REQUIRED_NO_PROXY_SET = new Set<string>(REQUIRED_NO_PROXY);
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
type ProxyKey = typeof PROXY_KEYS[number];

export function codexEnvPath(): string {
  return join(homedir(), ".codex", ".env");
}

export function normalizeProxyInput(input: string): string {
  let value = input.trim();
  if (!value) return DEFAULT_PROXY;
  if (/^\d{1,5}$/u.test(value)) value = `127.0.0.1:${value}`;
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) value = `http://${value}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("代理地址无效，请输入端口、主机:端口或完整 HTTP(S) 地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("代理地址无效，请输入端口、主机:端口或完整 HTTP(S) 地址。");
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw new Error("代理端口必须在 1 到 65535 之间。");
  }
  return `${url.protocol}//${url.hostname}:${port}`;
}

function proxyValues(proxy: string, noProxy: string): Record<ProxyKey, string> {
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: noProxy
  };
}

function matchProxyKey(line: string): ProxyKey | undefined {
  const match = /^\s*(?:export\s+)?(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)\s*=/iu.exec(line);
  return match ? PROXY_KEYS.find((key) => key === match[1]?.toUpperCase()) : undefined;
}

function envValue(line: string): string {
  const value = line.slice(line.indexOf("=") + 1).trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

export function configuredProxy(contents: string): string | undefined {
  const found = new Map<ProxyKey, string[]>();
  for (const line of contents.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const key = matchProxyKey(line);
    if (!key) continue;
    const values = found.get(key) ?? [];
    values.push(envValue(line));
    found.set(key, values);
  }
  if (PROXY_KEYS.some((key) => found.get(key)?.length !== 1)) return undefined;
  const httpProxy = found.get("HTTP_PROXY")?.[0];
  const noProxy = new Set(found.get("NO_PROXY")?.[0]?.split(",").map((value) => value.trim().toLowerCase()));
  return httpProxy && found.get("HTTPS_PROXY")?.[0] === httpProxy && found.get("ALL_PROXY")?.[0] === httpProxy &&
    REQUIRED_NO_PROXY.every((value) => noProxy.has(value))
    ? httpProxy
    : undefined;
}

export function hasProxyEnv(contents: string): boolean {
  return contents.replace(/^\uFEFF/u, "").split(/\r?\n/u).some((line) => {
    const key = matchProxyKey(line);
    return key !== undefined && key !== "NO_PROXY" && envValue(line) !== "";
  });
}

function mergedNoProxy(lines: readonly string[]): string {
  const values: string[] = [];
  const normalized = new Set<string>();
  for (const line of lines) {
    if (matchProxyKey(line) !== "NO_PROXY") continue;
    for (const value of envValue(line).split(",").map((item) => item.trim()).filter(Boolean)) {
      const key = value.toLowerCase();
      if (!normalized.has(key)) {
        values.push(value);
        normalized.add(key);
      }
    }
  }
  for (const value of REQUIRED_NO_PROXY) {
    if (!normalized.has(value)) values.push(value);
  }
  return values.join(",");
}

export function updateProxyEnv(contents: string, proxy: string): string {
  const bom = contents.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? contents.slice(1) : contents;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const endedWithEol = /\r?\n$/u.test(body);
  const lines = body ? body.split(/\r?\n/u) : [];
  if (endedWithEol) lines.pop();

  const values = proxyValues(proxy, mergedNoProxy(lines));
  const written = new Set<ProxyKey>();
  const output: string[] = [];
  for (const line of lines) {
    const key = matchProxyKey(line);
    if (!key) {
      output.push(line);
    } else if (!written.has(key)) {
      output.push(`${key}=${values[key]}`);
      written.add(key);
    }
  }
  for (const key of PROXY_KEYS) {
    if (!written.has(key)) output.push(`${key}=${values[key]}`);
  }
  return `${bom}${output.join(eol)}${eol}`;
}

export function removeProxyEnv(contents: string): string {
  const bom = contents.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? contents.slice(1) : contents;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const endedWithEol = /\r?\n$/u.test(body);
  const lines = body ? body.split(/\r?\n/u) : [];
  if (endedWithEol) lines.pop();

  const remainingNoProxy = mergedNoProxy(lines).split(",").filter((value) => !REQUIRED_NO_PROXY_SET.has(value.toLowerCase()));
  let noProxyWritten = false;
  const output: string[] = [];
  for (const line of lines) {
    const key = matchProxyKey(line);
    if (!key) {
      output.push(line);
    } else if (key === "NO_PROXY" && !noProxyWritten && remainingNoProxy.length > 0) {
      output.push(`NO_PROXY=${remainingNoProxy.join(",")}`);
      noProxyWritten = true;
    }
  }
  return output.length > 0 ? `${bom}${output.join(eol)}${endedWithEol ? eol : ""}` : "";
}

async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function hasCodexProxy(path = codexEnvPath()): Promise<boolean> {
  return hasProxyEnv(await readEnvFile(path));
}

async function replaceEnvFile(path: string, contents: string): Promise<void> {
  if (!contents) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const stagingPath = `${path}.codex-fast-${randomUUID()}`;
  try {
    await writeFile(stagingPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(stagingPath, path);
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeCodexProxy(proxy: string, path = codexEnvPath()): Promise<boolean> {
  const contents = await readEnvFile(path);
  const updated = updateProxyEnv(contents, proxy);
  if (updated === contents) return false;
  await replaceEnvFile(path, updated);
  return true;
}

export async function removeCodexProxy(path = codexEnvPath()): Promise<boolean> {
  const contents = await readEnvFile(path);
  const updated = removeProxyEnv(contents);
  if (updated === contents) return false;
  await replaceEnvFile(path, updated);
  return true;
}
