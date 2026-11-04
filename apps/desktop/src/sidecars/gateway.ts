// tsyringe (through @peculiar/x509) needs the Reflect polyfill first. The gateway below is a dynamic import, so the
// bundler wraps it lazily and runs ESM dependencies before CJS ones: x509's own `import "reflect-metadata"` comes
// too late there. Loaded eagerly here, in the entry, it is in place before any of the gateway runs.
import "reflect-metadata";

// stdin EOF provides a graceful stop on Windows as well as POSIX.
process.stdin.on("end", () => process.emit("SIGTERM"));

process.stdin.resume();

await import("../../../gateway/src/main.ts");
