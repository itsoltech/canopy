import { EMBEDDED_WEB } from "./embedded.ts";
import { webProcessEnv } from "./config.ts";
import { EmbeddedWebServer } from "./server.ts";

/**
 * `canopy-gateway web`: only the embedded web, in this process (release smoke tests, a web kept apart from its
 * gateway). The gateway itself serves the web in its own process (server.ts) and never runs this.
 */
export async function serveEmbeddedWeb(): Promise<number | undefined> {
  if (!EMBEDDED_WEB) {
    console.error("This canopy-gateway build has no embedded web. Use a release binary or the canopy-gateway image.");

    return 78;
  }

  // Alone, the web keeps only its own variables: no gateway secrets in this process.
  const env = webProcessEnv(process.env);

  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  const web = new EmbeddedWebServer({ archive: EMBEDDED_WEB, env, log: (m) => console.info(m), standalone: true });

  try {
    await web.start(true);
  } catch (error) {
    console.error(`web: ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => void web.stop().then(() => process.exit(0)));

  return undefined;
}
