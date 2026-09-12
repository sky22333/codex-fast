import assert from "node:assert/strict";
import test from "node:test";
import { inspectStartupLog } from "./startup.js";

test("主窗口路由挂载后判定日志已就绪", () => {
  const snapshot = inspectStartupLog([
    "Launching app",
    "[StdioConnection] stdio_transport_spawned",
    "[window-manager] window ready-to-show appearance=primary",
    "[startup][renderer] app routes mounted after 1234ms rendererWindowAppearance=primary"
  ].join("\n"));
  assert.equal(snapshot.diagnosis, "ready");
  assert.equal(snapshot.routesMounted, true);
});

test("主窗口 ready-to-show 后判定日志已就绪", () => {
  const snapshot = inspectStartupLog("window ready-to-show appearance=primary");
  assert.equal(snapshot.diagnosis, "ready");
  assert.equal(snapshot.windowReady, true);
});

test("只有进程日志时判定为 shell 环境阶段阻塞", () => {
  const snapshot = inspectStartupLog("Launching app");
  assert.equal(snapshot.diagnosis, "shell-env-stalled");
});

test("隐藏窗口路由不能冒充主界面", () => {
  const snapshot = inspectStartupLog("app routes mounted after 1234ms rendererWindowAppearance=avatarOverlay");
  assert.equal(snapshot.routesMounted, false);
});
