// tsyringe (through @peculiar/x509) needs the Reflect polyfill first. The gateway below is a dynamic import, so the
// bundler wraps it lazily and runs ESM dependencies before CJS ones: x509's own `import "reflect-metadata"` comes
// too late there. Loaded eagerly here, in the entry, it is in place before any of the gateway runs.
import "reflect-metadata";

const command = Bun.argv[2];
const oneShot = command === "healthcheck" || command === "service" || Bun.argv.includes("--version");

// Neither `canopy-gateway web` (the web alone, src/web/serve.ts) nor the supervisor of a standalone binary loads the
// gateway: the supervisor stays a small watchdog process next to the one process that runs gateway and web.
if (command === "web") {
  const { serveEmbeddedWeb } = await import("./web/serve.ts");
  const code = await serveEmbeddedWeb();

  if (code !== undefined) process.exit(code);
} else {
  const { installKind, superviseBinary } = await import("@canopy/updater");

  if (!oneShot && installKind() === "binary" && !process.env["CANOPY_SUPERVISED"])
    process.exit(
      await superviseBinary({ binaryPath: process.execPath, args: Bun.argv.slice(2), log: (m) => console.warn(m) }),
    );

  await import("./gateway.ts");
}
