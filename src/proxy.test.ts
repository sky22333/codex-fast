import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredProxy, DEFAULT_PROXY, hasProxyEnv, normalizeProxyInput, removeCodexProxy, removeProxyEnv, updateProxyEnv, writeCodexProxy } from "./proxy.js";

test("代理输入支持默认值、端口、主机端口和完整地址", () => {
  assert.equal(normalizeProxyInput(""), DEFAULT_PROXY);
  assert.equal(normalizeProxyInput("7890"), "http://127.0.0.1:7890");
  assert.equal(normalizeProxyInput("192.168.1.2:8080"), "http://192.168.1.2:8080");
  assert.equal(normalizeProxyInput("https://proxy.example.com:8443"), "https://proxy.example.com:8443");
  assert.throws(() => normalizeProxyInput("socks5://127.0.0.1:1080"), /代理地址无效/u);
});

test("只更新代理变量并保留其他配置", () => {
  const original = "# existing\r\nOPENAI_API_KEY=keep-me\r\nhttp_proxy=http://old:1\r\nHTTP_PROXY=http://duplicate:2\r\nNO_PROXY=internal.example\r\n";
  const updated = updateProxyEnv(original, DEFAULT_PROXY);
  assert.equal(updated, [
    "# existing",
    "OPENAI_API_KEY=keep-me",
    `HTTP_PROXY=${DEFAULT_PROXY}`,
    "NO_PROXY=internal.example,localhost,127.0.0.1,::1",
    `HTTPS_PROXY=${DEFAULT_PROXY}`,
    `ALL_PROXY=${DEFAULT_PROXY}`,
    ""
  ].join("\r\n"));
  assert.equal(configuredProxy(updated), DEFAULT_PROXY);
});

test("完整配置不会被重复写入", () => {
  const configured = updateProxyEnv("OTHER=value\n", DEFAULT_PROXY);
  assert.equal(updateProxyEnv(configured, DEFAULT_PROXY), configured);
});

test("移除代理并保留其他配置和额外直连规则", () => {
  const configured = updateProxyEnv("OTHER=value\nNO_PROXY=internal.example\n", DEFAULT_PROXY);
  assert.equal(removeProxyEnv(configured), "OTHER=value\nNO_PROXY=internal.example\n");
  assert.equal(removeProxyEnv(updateProxyEnv("", DEFAULT_PROXY)), "");
});

test("不完整的手工代理配置也能被识别", () => {
  assert.equal(hasProxyEnv("HTTPS_PROXY=http://127.0.0.1:7890\n"), true);
  assert.equal(hasProxyEnv("NO_PROXY=localhost\nOTHER=value\n"), false);
});

test("原子更新现有文件且保留无关配置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-fast-proxy-"));
  try {
    const path = join(directory, ".env");
    await writeFile(path, "OTHER=value\nHTTP_PROXY=http://old:1\n", "utf8");
    assert.equal(await writeCodexProxy(DEFAULT_PROXY, path), true);
    const updated = await readFile(path, "utf8");
    assert.match(updated, /^OTHER=value$/mu);
    assert.equal(configuredProxy(updated), DEFAULT_PROXY);
    assert.equal(await removeCodexProxy(path), true);
    assert.equal(await readFile(path, "utf8"), "OTHER=value\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
