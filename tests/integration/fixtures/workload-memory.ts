// Runs only in the disposable, memory-limited systemd user service created by workload-memory.live.test.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { configureWorkloadMemory, startWorkload } from "@canopy/process-governor";

const control = readFileSync("/proc/self/cgroup", "utf8").trim().slice(3);

assert.ok(control.endsWith(".service/canopy-control"));

configureWorkloadMemory(console.info);

const root = join("/sys/fs/cgroup", dirname(control));
const workloads = join(root, "canopy-workloads");
const MiB = 1024 * 1024;
const argc = "literal '$HOME' with spaces";

const shell = startWorkload(
  ["/bin/sh", "-c", 'read value; printf "%s\\n" "$1" "$value" "$sample"; exec cat /proc/self/cgroup', "sh", argc],
  (argv) => spawn(argv[0]!, argv.slice(1), { stdio: "pipe", env: { ...process.env, sample: "kept" } }),
);

const shellClosed = once(shell, "close");
const shellOutput: Buffer[] = [];

shell.stdout.on("data", (chunk: Buffer) => shellOutput.push(chunk));

// A native tool can create a new session and still inherit its launcher's cgroup.
function allocateInChild(oomTarget: "tree" | "process") {
  return startWorkload(
    [
      "/bin/sh",
      "-c",
      'cat /proc/self/cgroup; setsid "$1" -e "$2"; test "$?" = 137 && echo survived',
      "sh",
      process.execPath,
      "const hold = []; while (true) hold.push(Buffer.alloc(4 * 1024 * 1024, 1));",
    ],
    (argv) => Bun.spawn([...argv], { stdout: "pipe", stderr: "inherit" }),
    oomTarget,
  );
}

try {
  const tree = allocateInChild("tree");
  const treeGroup = (await new Response(tree.stdout).text()).trim().slice(3);
  assert.equal(await tree.exited, 137);
  assert.equal(dirname(treeGroup), join(dirname(control), "canopy-workloads"));
  assert.match(readFileSync(join(workloads, "memory.events"), "utf8"), /^oom_kill [1-9]\d*$/m);

  const shared = allocateInChild("process");
  const sharedOutput = await new Response(shared.stdout).text();
  assert.equal(await shared.exited, 0);
  assert.equal(sharedOutput.trim().split("\n")[1], "survived");

  shell.stdin.end("still running\n");
  assert.deepEqual(await shellClosed, [0, null]);
  const [literal, reply, env, sibling] = Buffer.concat(shellOutput).toString().trim().split("\n");
  assert.deepEqual([literal, reply, env], [argc, "still running", "kept"]);
  assert.ok(sibling);
  assert.equal(dirname(sibling.slice(3)), dirname(treeGroup));
  assert.notEqual(sibling.slice(3), treeGroup);
  assert.equal(
    Number(readFileSync(join(workloads, "memory.max"), "utf8")),
    Math.floor((256 * MiB * 0.8) / 4096) * 4096,
  );

  const deadline = Date.now() + 5_000;

  while (readdirSync(workloads, { withFileTypes: true }).some((entry) => entry.isDirectory())) {
    assert.ok(Date.now() < deadline, "workload cgroups were not released");
    await Bun.sleep(25);
  }

  assert.ok(existsSync(join(root, "canopy-control")));
} finally {
  shell.kill();
  await shellClosed;
}
