// A separate process group survives terminal signals to the test runner. The private IPC channel
// closes even on SIGKILL. Only this process creates and removes its container, in that order.
const name = `canopy-test-${Bun.randomUUIDv7().slice(-12)}`;
const image = process.argv[2] === "18" ? "postgres:18" : "postgres:17";

const created = Bun.spawnSync([
  "docker",
  "create",
  "--rm",
  "--name",
  name,
  "--label",
  `canopy-test.created=${Date.now()}`,
  "-e",
  "POSTGRES_PASSWORD=test",
  "-e",
  "POSTGRES_INITDB_ARGS=--no-sync",
  "-p",
  "127.0.0.1::5432",
  image,
  "-c",
  "fsync=off",
  "-c",
  "synchronous_commit=off",
  "-c",
  "full_page_writes=off",
]);

if (created.exitCode !== 0) throw new Error(`docker create failed: ${created.stderr.toString()}`);

const id = created.stdout.toString().trim();

if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid test container ID");

function remove() {
  const result = Bun.spawnSync(["docker", "rm", "-f", "-v", id], { stdout: "ignore", stderr: "inherit" });
  process.exit(result.exitCode ?? 1);
}

process.once("disconnect", remove);

if (!process.connected) remove();

const started = Bun.spawnSync(["docker", "start", id], { stdout: "ignore", stderr: "inherit" });

if (started.exitCode !== 0) remove();

const portResult = Bun.spawnSync(["docker", "port", id, "5432/tcp"]);
const port = Number(portResult.stdout.toString().trim().split(":").at(-1));

if (portResult.exitCode !== 0 || !Number.isInteger(port) || port <= 0 || port > 65535) remove();

process.send?.(port, (error: Error | null) => {
  if (error) remove();
});
