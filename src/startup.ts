import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type StartupDiagnosis = "ready" | "shell-env-stalled" | "backend-stalled" | "unknown";

export interface StartupSnapshot {
  diagnosis: StartupDiagnosis;
  logFile?: string;
  routesMounted: boolean;
  stdioSpawned: boolean;
  windowReady: boolean;
}

export function inspectStartupLog(contents: string): StartupSnapshot {
  const routesMounted = /app routes mounted[^\r\n]*rendererWindowAppearance=primary/u.test(contents);
  const stdioSpawned = contents.includes("stdio_transport_spawned");
  const windowReady = /(?:window ready-to-show appearance=primary|startup window revealed)/u.test(contents);
  const diagnosis: StartupDiagnosis = routesMounted || windowReady
    ? "ready"
    : stdioSpawned
      ? "backend-stalled"
      : contents.includes("Launching app")
        ? "shell-env-stalled"
        : "unknown";
  return { diagnosis, routesMounted, stdioSpawned, windowReady };
}

function dateDirectories(logRoot: string, timestamp: number): string[] {
  const center = new Date(timestamp);
  return [-1, 0, 1].map((offset) => {
    const date = new Date(center.getTime() + offset * 86_400_000);
    return join(logRoot, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
  });
}

export async function readLatestStartupDiagnosis(
  startedAt: number,
  logRoot = join(process.env.LOCALAPPDATA ?? "", "Codex", "Logs")
): Promise<StartupSnapshot> {
  const candidates: Array<{ modified: number; path: string }> = [];
  for (const directory of dateDirectories(logRoot, startedAt)) {
    try {
      for (const name of await readdir(directory)) {
        if (!name.includes("-t0-") || !name.endsWith(".log")) continue;
        const path = join(directory, name);
        const metadata = await stat(path);
        if (metadata.mtimeMs >= startedAt - 60_000) candidates.push({ modified: metadata.mtimeMs, path });
      }
    } catch {
      // 日志目录可能还没有创建。
    }
  }
  const logFile = candidates.sort((left, right) => right.modified - left.modified)[0]?.path;
  if (!logFile) return { diagnosis: "unknown", routesMounted: false, stdioSpawned: false, windowReady: false };
  try {
    return { ...inspectStartupLog(await readFile(logFile, "utf8")), logFile };
  } catch {
    return { diagnosis: "unknown", logFile, routesMounted: false, stdioSpawned: false, windowReady: false };
  }
}
