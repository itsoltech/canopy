process.stdin.on("end", () => process.emit("SIGTERM"));
process.stdin.resume();
process.once("SIGTERM", () => process.stdin.destroy());
await import("../../../worker/src/main.ts");
