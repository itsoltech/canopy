/**
 * The web runs in the gateway's process, and Bun ends a process on an unhandled rejection or an uncaught
 * exception. One from the web's own code (its modules load from the extracted release directory, so their
 * frames name it) is logged and the gateway runs on; anything else still ends the process as before, so
 * systemd or Docker restart a gateway in an unknown state.
 */
let contained = false;

export function containWebFaults(webRoot: string, log: (message: string) => void): void {
  if (contained) return;
  contained = true;
  const fromWeb = (cause: unknown) => cause instanceof Error && (cause.stack ?? "").includes(webRoot);

  const fault = (kind: string) => (cause: unknown) => {
    if (fromWeb(cause)) {
      log(`web: ${kind} in the web app, contained: ${cause instanceof Error ? (cause.stack ?? cause.message) : ""}`);

      return;
    }

    console.error(cause);
    process.exit(1);
  };

  process.on("unhandledRejection", fault("unhandled rejection"));
  process.on("uncaughtException", fault("uncaught exception"));
}
