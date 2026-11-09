import { Schema } from "effect";
import { join } from "node:path";

export const Control = Schema.Struct({
  id: Schema.Number,
  action: Schema.Literals([
    "info",
    "invitation",
    "pair",
    "mobile",
    "watch",
    "begin",
    "end",
    "stream",
    "restart",
    "attach",
    "mirror",
    "stop",
  ]),
  url: Schema.String,
  code: Schema.String,
  node: Schema.String,
  threads: Schema.Array(Schema.String),
});

export type Control = typeof Control.Type;

const Reply = Schema.Struct({ id: Schema.Number, ok: Schema.Boolean, payload: Schema.String });

export const ProcessInfo = Schema.Struct({
  url: Schema.String,
  address: Schema.String,
  node: Schema.String,
  threads: Schema.Array(Schema.String),
});

export const decodeInfo = Schema.decodeSync(Schema.fromJsonString(ProcessInfo));

/** Child test processes retain the shared PostgreSQL descriptor and use only ephemeral listener ports. */
export function syncProcess(role: "home" | "viewer" | "bff") {
  let id = 0;
  const pending = new Map<number, { resolve: (value: string) => void; reject: (cause: Error) => void }>();
  const directory = process.env["CANOPY_SYNC_PROFILE_DIR"];
  let markReady!: () => void;
  let failReady!: (error: Error) => void;

  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });

  const profile = directory
    ? ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${directory}`, `--cpu-prof-name=${role}.md`]
    : [];

  const child = Bun.spawn([process.execPath, ...profile, join(import.meta.dir, "sync-process-entry.ts")], {
    env: { ...process.env, CANOPY_SYNC_ROLE: role },
    stdout: "ignore",
    stderr: "inherit",
    ipc(message) {
      const reply = Schema.decodeUnknownSync(Reply)(message);

      if (!reply.id) {
        markReady();

        return;
      }

      const request = pending.get(reply.id);

      pending.delete(reply.id);

      if (reply.ok) request?.resolve(reply.payload);
      else request?.reject(new Error(`Sync ${role} command failed`));
    },
  });

  void child.exited.then(() => {
    failReady(new Error(`Sync ${role} exited before ready`));

    for (const request of pending.values()) request.reject(new Error(`Sync ${role} exited`));
    pending.clear();
  });

  const run = async (action: Control["action"], fields: Partial<Omit<Control, "id" | "action">> = {}) => {
    await ready;
    const request = { id: ++id, action, url: "", code: "", node: "", threads: [], ...fields };

    return new Promise<string>((resolve, reject) => {
      pending.set(request.id, { resolve, reject });
      child.send(request);
    });
  };

  return {
    run,
    async close() {
      if (child.exitCode !== null) return;

      try {
        await run("stop");
        await child.exited;
      } finally {
        if (child.exitCode === null) child.kill();
      }
    },
  };
}
