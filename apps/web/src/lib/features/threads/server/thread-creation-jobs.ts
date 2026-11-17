import { createHash } from "node:crypto";
import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { error } from "@sveltejs/kit";
import { gateway, onGatewayTargetChange } from "#lib/server/gateway.ts";
import { gatewayFailure } from "#lib/server/gateway-errors.ts";

const MAX_LIVE = 64;
const MAX_RETAINED = 256;
const RETENTION_MS = 15 * 60_000;
const TIMEOUT_MS = 110_000;
const statuses = ["pending", "running", "completed", "skipped", "failed"] as const;

type Status = (typeof statuses)[number];

interface Step {
  step: string;
  label: string;
  status: Status;
  detail: string;
}

export interface ThreadCreationSnapshot {
  requestId: string;
  message: string;
  projectId: string;
  steps: Step[];
  threadId: string;
  done: boolean;
  error: string;
}

interface Job {
  snapshot: ThreadCreationSnapshot;
  fingerprint: string;
  controller: AbortController;
  deadline?: ReturnType<typeof setTimeout>;
  retirement?: ReturnType<typeof setTimeout>;
}

const jobs = new Map<string, Job>();

function clearJobs() {
  for (const job of jobs.values()) {
    clearTimeout(job.deadline);
    clearTimeout(job.retirement);
    job.controller.abort();
  }

  jobs.clear();
}

const stop = onGatewayTargetChange(clearJobs);

import.meta.hot?.dispose(() => {
  stop();
  clearJobs();
});

function initialSteps(): Step[] {
  return [
    ["check_workspace", "Check workspace"],
    ["fetch_remote", "Fetch remote branch"],
    ["create_worktree", "Create worktree"],
    ["prepare_message", "Prepare message"],
    ["start_thread", "Start thread"],
  ].map(([step, label]) => ({ step: step!, label: label!, status: "pending", detail: "" }));
}

function finish(job: Job) {
  if (job.snapshot.done) return;
  job.snapshot.done = true;
  clearTimeout(job.deadline);

  if (jobs.get(job.snapshot.requestId) === job) {
    job.retirement = setTimeout(() => jobs.delete(job.snapshot.requestId), RETENTION_MS);
    job.retirement.unref();
  }
}

function failJob(job: Job, detail: string, timedOut = false) {
  if (job.snapshot.done) return;

  const step =
    job.snapshot.steps.find((entry) => entry.status === "failed") ??
    job.snapshot.steps.find((entry) => entry.status === "running") ??
    job.snapshot.steps.find((entry) => entry.status === "pending");

  if (step) {
    step.status = "failed";
    step.detail = detail;
  }

  job.snapshot.error = timedOut
    ? "Thread setup timed out. Check the worker connection, then try again."
    : "Could not start this thread. Review the failed step, then try again.";
  finish(job);
}

/** Progress text uses the same public error sanitiser as unary gateway failures. */
function publicDetail(detail: string): string {
  return detail ? gatewayFailure(new ConnectError(detail, Code.FailedPrecondition)).message : "";
}

function applyProgress(job: Job, event: ui.CreateThreadProgress) {
  const step = job.snapshot.steps.find((entry) => entry.step === event.step);
  const status = statuses.find((value) => value === event.status);

  if (!step || !status) throw new ConnectError("The gateway sent an invalid preparation update", Code.Internal);
  step.status = status;
  step.detail = publicDetail(event.detail);

  if (status === "failed") {
    failJob(job, step.detail || "The gateway could not finish this preparation step");
  } else if (event.step === "start_thread" && status === "completed" && event.thread?.id) {
    // Older workers and linked homes report only the operations they can observe.
    job.snapshot.steps = job.snapshot.steps.filter((entry) => entry.status !== "pending");
    job.snapshot.threadId = event.thread.id;
    finish(job);
  }
}

async function fallback(job: Job, request: ui.CreateThreadRequest, api: Client<typeof ui.GatewayService>) {
  job.snapshot.steps = [
    {
      step: "start_thread",
      label: "Start thread",
      status: "running",
      detail: "Preparing the workspace and starting the thread.",
    },
  ];
  const response = await api.createThread(request, { signal: job.controller.signal, timeoutMs: TIMEOUT_MS });

  if (job.snapshot.done || job.controller.signal.aborted) return;

  if (!response.thread?.id) throw new ConnectError("The gateway did not return the created thread", Code.Internal);
  job.snapshot.threadId = response.thread.id;
  job.snapshot.steps[0]!.status = "completed";
  job.snapshot.steps[0]!.detail = "";
  finish(job);
}

async function run(job: Job, request: ui.CreateThreadRequest, api: Client<typeof ui.GatewayService>) {
  let received = false;

  try {
    try {
      for await (const event of api.createThreadWithProgress(request, {
        signal: job.controller.signal,
        timeoutMs: TIMEOUT_MS,
      })) {
        if (job.controller.signal.aborted || job.snapshot.done) return;
        received = true;
        applyProgress(job, event);

        if (job.snapshot.done) return;
      }
    } catch (cause) {
      if (!received && cause instanceof ConnectError && cause.code === Code.Unimplemented) {
        await fallback(job, request, api);
      } else {
        throw cause;
      }
    }

    if (!job.snapshot.done && !job.controller.signal.aborted)
      failJob(
        job,
        "The gateway stopped reporting progress before confirming the thread. Check the worker, then retry.",
      );
  } catch (cause) {
    if (job.controller.signal.aborted || job.snapshot.done) return;
    failJob(job, gatewayFailure(cause).message, cause instanceof ConnectError && cause.code === Code.DeadlineExceeded);
  }
}

/** The job owns its RPC; closing an HTTP request never cancels thread preparation. */
export function startThreadCreation(request: ui.CreateThreadRequest): string {
  const api = gateway();
  const bytes = toBinary(ui.CreateThreadRequestSchema, request);

  if (bytes.byteLength > 512_000) error(413, "This message is too large. Shorten it, then try again.");
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  const existing = jobs.get(request.clientRequestId);

  if (existing) {
    if (existing.fingerprint !== fingerprint)
      error(409, "This request already contains a different message. Start a new request to change it.");

    return request.clientRequestId;
  }

  if ([...jobs.values()].filter((job) => !job.snapshot.done).length >= MAX_LIVE)
    error(429, "Too many threads are being prepared. Wait for one to finish, then retry.");

  if (jobs.size >= MAX_RETAINED) {
    const oldest = [...jobs.values()].find((job) => job.snapshot.done);

    if (oldest) {
      clearTimeout(oldest.retirement);
      jobs.delete(oldest.snapshot.requestId);
    }
  }

  const job: Job = {
    fingerprint,
    controller: new AbortController(),
    snapshot: {
      requestId: request.clientRequestId,
      message: request.initialMessage,
      projectId: request.projectId,
      steps: initialSteps(),
      threadId: "",
      done: false,
      error: "",
    },
  };

  jobs.set(request.clientRequestId, job);
  job.deadline = setTimeout(() => {
    failJob(job, "The gateway request timed out", true);
    job.controller.abort();
  }, TIMEOUT_MS);
  job.deadline.unref();
  void run(job, request, api);

  return request.clientRequestId;
}

export function threadCreationSnapshot(requestId: string): ThreadCreationSnapshot {
  // Resolve lazy target changes before reading any private state.
  gateway();
  const job = jobs.get(requestId);

  if (!job) error(404, "This thread setup has expired. Return to your project to start a thread.");

  return job.snapshot;
}
