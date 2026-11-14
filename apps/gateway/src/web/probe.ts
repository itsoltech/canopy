import { createServer } from "node:net";
import { isJsonObject, parseJson } from "@canopy/domain/json";
import { WEB_INSTANCE_HEADER } from "./protocol.ts";

/**
 * Why the web can't listen on host:port, or undefined when it can. Checked before each start, so an existing
 * web on the port (an older separate install, another app) gives a specific reason instead of a health timeout.
 */
export function listenProblem(host: string, port: number): Promise<string | undefined> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE")
        done(`Port ${port} is in use by another process. Set CANOPY_WEB_PORT to a free port, or CANOPY_WEB=off.`);
      else if (error.code === "EACCES") done(`Not allowed to listen on port ${port}. Set CANOPY_WEB_PORT above 1023.`);
      else if (error.code === "EADDRNOTAVAIL")
        done(`${host} is not an address of this computer. Check CANOPY_WEB_HOST.`);
      else done(`Can't listen on ${host}:${port}: ${error.message}`);
    });
    server.listen({ host: host.replace(/^\[|\]$/g, ""), port, exclusive: true }, () =>
      server.close(() => done(undefined)),
    );
  });
}

/** `/api/health` of this exact child (its instance header) with this build's version. */
export async function healthAnswer(url: string, instance: string, version: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = parseJson(await response.text());
    const answered = isJsonObject(body) ? body["version"] : undefined;

    if (response.headers.get(WEB_INSTANCE_HEADER) !== instance) return "another process answers on the web port";

    return response.ok && answered === version ? undefined : `HTTP ${response.status}, version ${String(answered)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
