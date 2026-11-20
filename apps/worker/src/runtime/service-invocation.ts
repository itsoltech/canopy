import { runProcess } from "@canopy/process-governor";

const invocationId = /^[0-9a-f]{32}$/;
const workerUnit = "canopy-worker.service";

// SD_MESSAGE_UNIT_FAILURE_RESULT, emitted by the manager when the unit actually fails.
const failed = "MESSAGE_ID=d9b373ed55a64feb8242e02dbe79a49c";

/** Ignore systemd variables inherited by a worker started inside another application. */
export function workerServiceInvocation(): string {
  const env = process.env;
  const id = env["INVOCATION_ID"] ?? "";
  const mainPid = env["CANOPY_SUPERVISED"] === "1" ? process.ppid : process.pid;

  return process.platform === "linux" && env["SYSTEMD_EXEC_PID"] === String(mainPid) && invocationId.test(id) ? id : "";
}

/** Match the manager's terminal result for the exact worker invocation. No free-form log text leaves the host. */
export async function serviceFailedFromOom(id: string): Promise<boolean> {
  const uid = process.getuid?.();

  if (process.platform !== "linux" || uid === undefined || !invocationId.test(id)) return false;

  const result = [failed, "UNIT_RESULT=oom-kill"];

  const argv = [
    "journalctl",
    "--quiet",
    "--no-pager",
    "--lines=1",
    "--output=cat",
    "--output-fields=UNIT_RESULT",
    "_PID=1",
    `UNIT=${workerUnit}`,
    `INVOCATION_ID=${id}`,
    ...result,
    "+",
    `_UID=${uid}`,
    `_SYSTEMD_UNIT=user@${uid}.service`,
    "_SYSTEMD_USER_UNIT=init.scope",
    "_COMM=systemd",
    `USER_UNIT=${workerUnit}`,
    `USER_INVOCATION_ID=${id}`,
    ...result,
  ];

  try {
    const reply = await runProcess({ argv, timeoutMs: 1500, maxBytes: 1024 }, { kind: "probe", maxQueueMs: 100 });

    return reply.code === 0 && reply.stdout.trim() === "oom-kill";
  } catch {
    return false;
  }
}
