process.stdin.on("end", () => process.emit("SIGTERM"));

process.stdin.resume();

process.once("SIGTERM", () => {
  process.stdin.destroy();

  // A listener keeps the process alive on SIGTERM. Until the worker installs its own stop (it is still starting)
  // this one would swallow the stop, and an orphaned worker would run on: nothing to stop gracefully yet, so exit.
  if (process.listenerCount("SIGTERM") === 0) process.exit(143);
});

await import("../../../worker/src/main.ts");
