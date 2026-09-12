import assert from "node:assert/strict";
import test from "node:test";
import { acquireSingleInstance } from "./single-instance.js";

test("同一时间只允许一个启动流程", async () => {
  const pipe = `\\\\.\\pipe\\codex-fast-test-${process.pid}-${Date.now()}`;
  const first = await acquireSingleInstance(pipe);
  await assert.rejects(acquireSingleInstance(pipe), /另一个 codex-fast 正在运行/u);
  await first.release();

  const next = await acquireSingleInstance(pipe);
  await next.release();
});
