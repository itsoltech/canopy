import type { Server } from "node:http";
import { isJsonObject, parseJson } from "@canopy/domain/json";

/** Why the web couldn't listen, in words an operator can act on (a busy port: often an older separate web). */
function listenProblem(error: NodeJS.ErrnoException, host: string, port: number): string {
  if (error.code === "EADDRINUSE")
    return `Port ${port} is in use by another process. Set CANOPY_WEB_PORT to a free port, or CANOPY_WEB=off.`;

  if (error.code === "EACCES") return `Not allowed to listen on port ${port}. Set CANOPY_WEB_PORT above 1023.`;

  if (error.code === "EADDRNOTAVAIL") return `${host} is not an address of this computer. Check CANOPY_WEB_HOST.`;

  return `Can't listen on ${host}:${port}: ${error.message}`;
}

/** Binds the server; rejects with listenProblem's reason. */
export function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((done, fail) => {
    const failed = (error: NodeJS.ErrnoException) => fail(new Error(listenProblem(error, host, port)));
    server.once("error", failed);
    server.listen({ host: host.replace(/^\[|\]$/g, ""), port, exclusive: true }, () => {
      server.off("error", failed);
      done();
    });
  });
}

/** `/api/health` through the real listener with this build's version: the handler, not only the socket, works. */
export async function healthAnswer(url: string, version: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = parseJson(await response.text());
    const answered = isJsonObject(body) ? body["version"] : undefined;

    return response.ok && answered === version ? undefined : `HTTP ${response.status}, version ${String(answered)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
