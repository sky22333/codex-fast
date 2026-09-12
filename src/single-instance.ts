import { createServer } from "node:net";

const DEFAULT_PIPE = "\\\\.\\pipe\\codex-fast-cli";

export interface InstanceLock {
  release(): Promise<void>;
}

export async function acquireSingleInstance(pipeName = DEFAULT_PIPE): Promise<InstanceLock> {
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(pipeName, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error("另一个 codex-fast 正在运行，请等待其完成。");
    }
    throw error;
  }
  server.unref();
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}
