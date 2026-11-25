import { str } from "@canopy/domain/json";
import { z } from "zod";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import {
  desktopWindows,
  desktopWindowIdentity,
  nativeData,
  qualifiedDesktopRef,
  readDesktopRef,
  resolveDesktopTarget,
  type DesktopTarget,
  type DesktopWindowProof,
} from "./desktop-window.ts";
import type { ToolEnv } from "./paths.ts";

const snapshotId = z.string().regex(/^[A-Za-z0-9_-]{3,64}$/);

const snapshot = z.object({
  app: z.string().min(1).max(4096),
  snapshot_id: snapshotId,
  window: z.object({ id: desktopWindowIdentity.shape.id }).optional(),
});

const foundRef = z.object({ ref_id: z.string().max(100).nullish() });
const found = z.object({ match: foundRef.nullish(), matches: z.array(foundRef).optional() });

const process = z.object({
  pid: desktopWindowIdentity.shape.pid,
  instance: desktopWindowIdentity.shape.process_instance,
});

const reportedWindow = z.object({
  kind: z.literal("window"),
  id: desktopWindowIdentity.shape.id,
  process,
});

const reportedApp = z.object({ kind: z.literal("app"), name: z.string().min(1).max(4096), process });
const nativeTarget = z.object({ target: z.discriminatedUnion("kind", [reportedWindow, reportedApp]) });

const after = z.union([
  nativeTarget,
  z.object({ after_action: nativeTarget }).transform((value) => value.after_action),
]);

export const windowOperations = new Set([
  "key-down",
  "key-up",
  "mouse-down",
  "mouse-up",
  "press",
  "focus-window",
  "resize-window",
  "move-window",
  "minimize",
  "maximize",
  "restore",
  "launch",
  "close-app",
  "open-system-surface",
  "dismiss-notification",
  "dismiss-all-notifications",
  "notification-action",
  "batch",
]);

const launched = z.object({ app: z.string().min(1).max(4096), window: desktopWindowIdentity });

export function fromRef(
  session: string,
  env: ToolEnv,
  ref: string,
  snapshots: ReadonlyMap<string, DesktopTarget>,
): DesktopWindowProof | undefined {
  const source = readDesktopRef(session, env, ref);

  if (source === null) return undefined;
  const snapshot = qualifiedDesktopRef.exec(ref)?.[1];
  const cached = snapshot && snapshots.get(snapshot);

  if (!cached) return source;
  const proof = { app: cached.app, ...cached.identity, unique: cached.unique };

  if (!source) return proof;

  if (
    source.pid !== proof.pid ||
    source.process_instance !== proof.process_instance ||
    (source.app && source.app !== proof.app) ||
    (source.id && source.id !== proof.id)
  )
    return undefined;

  return { ...proof, unique: source.unique || proof.unique };
}

export function describes(proof: DesktopWindowProof | undefined, target: DesktopTarget | undefined) {
  return (
    proof &&
    target &&
    (!proof.app || proof.app === target.app) &&
    (!proof.unique || target.unique) &&
    proof.pid === target.identity.pid &&
    proof.process_instance === target.identity.process_instance &&
    (proof.id ? proof.id === target.identity.id : target.unique && proof.app === target.app)
  );
}

export function scopeProof(args: AutomationCall["arguments"]): DesktopWindowProof | undefined {
  const app = str(args["app"]);
  const id = str(args["window_id"]);

  return app || id ? { app: app || undefined, id: id || undefined } : undefined;
}

/** A same-app read can name a different window unless live capture already enforces process uniqueness. */
export function continuesDesktopScope(scope: DesktopWindowProof | undefined, target: DesktopTarget | undefined) {
  return (
    scope &&
    target &&
    (!scope.app || scope.app === target.app) &&
    (scope.id ? scope.id === target.identity.id : target.unique && Boolean(scope.app))
  );
}

function reportProof(data: ReturnType<typeof nativeData>): DesktopWindowProof | undefined {
  const report = after.safeParse(data).data?.target;

  if (!report) return undefined;

  return {
    ...(report.kind === "window" ? { id: report.id } : { app: report.name }),
    pid: report.process.pid,
    process_instance: report.process.instance,
  };
}

function snapshotProof(
  session: string,
  env: ToolEnv,
  data: ReturnType<typeof nativeData>,
  source: DesktopWindowProof | undefined,
  requestedId: string | undefined,
) {
  const captured = snapshot.safeParse(data).data;

  if (!captured || (requestedId && captured.window?.id !== requestedId)) return undefined;
  // Pinned Desktop allocates every ref from the same snapshot owner, including its process generation.
  const first = readDesktopRef(session, env, `@${captured.snapshot_id}:e1`);
  const owner = first ?? source;

  if (
    first === null ||
    (owner?.app && owner.app !== captured.app) ||
    (owner?.id && captured.window && owner.id !== captured.window.id)
  )
    return undefined;

  return {
    snapshotId: captured.snapshot_id,
    proof: { ...owner, app: captured.app, id: captured.window?.id ?? owner?.id, unique: !captured.window },
  };
}

const windowInfo = desktopWindowIdentity.extend({ app_name: z.string().min(1).max(4096) });
const returnedWindow = z.object({ window: windowInfo });
const focusedWindow = z.object({ focused: windowInfo });
const waitedWindow = returnedWindow.extend({ found: z.literal(true) });
const waitedRef = z.object({ found: z.literal(true), ref: z.string().max(100) });
const postActionSnapshot = snapshot.extend({ after_action: z.object({}) });

interface Context {
  session: string;
  env: ToolEnv;
  command: string;
  scope: DesktopWindowProof | undefined;
  snapshots: ReadonlyMap<string, DesktopTarget>;
  source: DesktopWindowProof | undefined;
  windowSurface: boolean;
  delivered: boolean;
}

interface ResultProof {
  proof?: DesktopWindowProof | undefined;
  snapshotId?: string;
}

/** Read only the explicit ownership evidence emitted by each native command. */
export function desktopResultProof(context: Context, data: ReturnType<typeof nativeData>): ResultProof {
  const { session, env, command, scope, source, snapshots, windowSurface, delivered } = context;

  if (command !== "snapshot" && postActionSnapshot.safeParse(data).success) {
    // A --wait-for action returns the observed AX snapshot at the top level. Its refs can belong
    // to a different window or a menu. Use the snapshot's own owner before considering the action.
    return snapshotProof(session, env, data, source ?? reportProof(data), undefined) ?? {};
  }

  switch (command) {
    case "snapshot":
      return (windowSurface && snapshotProof(session, env, data, source, scope?.id)) || {};
    case "find": {
      if (!windowSurface) return {};
      const matches = found.safeParse(data).data;
      const hit = matches?.match?.ref_id ?? matches?.matches?.find((item) => item.ref_id)?.ref_id;

      return { proof: hit ? fromRef(session, env, hit, snapshots) : (source ?? scope) };
    }

    case "screenshot":
      return { proof: windowSurface ? scope : undefined };
    case "get":
    case "is":
      return { proof: source };
    case "launch": {
      const app = launched.safeParse(data).data;

      return { proof: app && { ...app.window, app: app.app } };
    }

    case "list-windows": {
      const windows = desktopWindows.safeParse(data).data;
      const single = scope?.app && windows && resolveDesktopTarget(windows, { app: scope.app });

      return { proof: single ? { ...single.identity, app: single.app, unique: true } : undefined };
    }

    case "open-system-surface":
    case "focus-window":
    case "wait": {
      const win =
        command === "focus-window"
          ? focusedWindow.safeParse(data).data?.focused
          : (command === "wait" ? waitedWindow : returnedWindow).safeParse(data).data?.window;

      if (win)
        return { proof: { id: win.id, pid: win.pid, process_instance: win.process_instance, app: win.app_name } };
      const ref = command === "wait" && waitedRef.safeParse(data).data?.ref;

      return { proof: ref ? fromRef(session, env, ref, snapshots) : undefined };
    }

    case "close-app":
      return {};
    default:
      return { proof: reportProof(data) ?? (delivered ? source : undefined) };
  }
}
