import { createServer } from "node:net";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./config.ts";

function saved(path: string): number | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    const port = Number(text);

    return /^\d+$/.test(text) && port >= 1024 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function available(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * The web UI origin (`http://127.0.0.1:<port>`) keys browser storage, so device preferences
 * survive a restart only when the port does. Reuse the saved port; pick and save a new one when it is taken.
 */
export async function stableWebPort(directory: string): Promise<number> {
  const path = join(directory, "web-port");
  const previous = saved(path);

  if (previous !== undefined && (await available(previous))) return previous;
  const port = await freePort();
  writeFileSync(`${path}.new`, `${port}\n`, { mode: 0o600 });
  renameSync(`${path}.new`, path);

  return port;
}
