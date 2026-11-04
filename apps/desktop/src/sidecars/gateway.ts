// stdin EOF provides a graceful stop on Windows as well as POSIX.
process.stdin.on("end", () => process.emit("SIGTERM"));

process.stdin.resume();

await import("../../../gateway/src/main.ts");
