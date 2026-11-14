// tsyringe (through @peculiar/x509) needs the Reflect polyfill first. The gateway below is a dynamic import, so the
// bundler wraps it lazily and runs ESM dependencies before CJS ones: x509's own `import "reflect-metadata"` comes
// too late there. Loaded eagerly here, in the entry, it is in place before any of the gateway runs.
import "reflect-metadata";

// `canopy-gateway web` is the embedded web BFF (src/web), a child of the gateway: it must not load the gateway.
if (Bun.argv[2] === "web") {
  const { serveEmbeddedWeb } = await import("./web/serve.ts");
  const code = await serveEmbeddedWeb();

  if (code !== undefined) process.exit(code);
} else {
  await import("./gateway.ts");
}
