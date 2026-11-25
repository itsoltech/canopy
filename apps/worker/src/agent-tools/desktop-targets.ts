import { str } from "@canopy/domain/json";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import { cursorCommand, desktopActionReport } from "./desktop-cursor-observation.ts";
import { desktopObservation, desktopScreenshotScope, type DesktopObservation } from "./desktop-observation.ts";
import { DesktopObservationStore } from "./desktop-observation-store.ts";
import {
  continuesDesktopScope,
  describes,
  desktopResultProof,
  fromRef,
  scopeProof,
  windowOperations,
} from "./desktop-target-evidence.ts";
import {
  nativeData,
  sameDesktopWindow,
  type DesktopNativeCall,
  observeDesktopWindows,
  resolveDesktopTarget,
  type DesktopTarget,
  type DesktopWindow,
  type DesktopWindowProof,
  verifiedDesktopWindow,
} from "./desktop-window.ts";
import type { ToolEnv } from "./paths.ts";

interface Session {
  current: DesktopTarget | undefined;
  snapshots: Map<string, DesktopTarget>;
  order: number;
}

/** One private target per fixed session, independent of cursor presentation or the user's focused app. */
export class DesktopTargets {
  readonly #observations = new DesktopObservationStore((session) => this.#notify(session));
  readonly #sessions = new Map<string, Session>();
  readonly #watches = new Set<{ session: string; changed: () => void }>();

  current(session: string) {
    const slot = this.#sessions.get(session);

    if (slot?.current) {
      this.#sessions.delete(session);
      this.#sessions.set(session, slot);
    }

    return slot?.current;
  }

  watch(session: string, signal: AbortSignal, changed: () => void): void {
    if (signal.aborted) return;
    const watch = { session, changed };
    this.#watches.add(watch);
    signal.addEventListener("abort", () => this.#watches.delete(watch), { once: true });
  }

  observation(session: string) {
    return this.#observations.get(session);
  }

  #notify(session: string) {
    for (const watch of this.#watches) {
      if (watch.session !== session) continue;

      try {
        watch.changed();
      } catch {
        // A disconnected viewer must not change the model's tool result or stop other viewers.
      }
    }
  }

  #replace(
    session: string,
    slot: Session,
    target: DesktopTarget | undefined,
    visual?: { image: DesktopObservation; signal: AbortSignal },
  ) {
    const hadImage = this.#observations.clear(session);
    const changed = slot.current !== target;
    slot.current = target;

    if (visual) this.#observations.set(session, visual.image, visual.signal);

    if (changed || hadImage || visual) this.#notify(session);
  }

  missing(session: string, target: DesktopTarget) {
    const slot = this.#sessions.get(session);

    if (slot?.current === target) {
      slot.order++;
      this.#replace(session, slot, undefined);
    }
  }

  end(session: string) {
    const slot = this.#sessions.get(session);

    if (slot) this.#replace(session, slot, undefined);
    this.#sessions.delete(session);
  }

  close() {
    for (const session of this.#sessions.keys()) this.end(session);
    this.#watches.clear();
  }

  #session(session: string): Session {
    const slot = this.#sessions.get(session) ?? { current: undefined, snapshots: new Map(), order: 0 };
    this.#sessions.delete(session);

    if (this.#sessions.size >= 64) this.end(this.#sessions.keys().next().value!);
    this.#sessions.set(session, slot);

    return slot;
  }

  async run(
    session: string,
    env: ToolEnv,
    params: AutomationCall,
    signal: AbortSignal,
    native: DesktopNativeCall,
    invoke: DesktopNativeCall,
  ) {
    const command = params.name.slice("desktop_".length).replaceAll("_", "-");
    const args = params.arguments;
    const observing = ["snapshot", "find", "screenshot"].includes(command);
    const refRead = command === "get" || command === "is";
    const acting = Boolean(cursorCommand(params.name, true)) || windowOperations.has(command);
    const scope = scopeProof(args);
    const timedWait = command === "wait" && args["ms"] != null;
    const selectedRead = (command === "list-windows" && Boolean(scope?.app)) || (command === "wait" && !timedWait);
    const windowCommand = observing || refRead || acting || selectedRead;

    const slot = this.#session(session);
    const order = ++slot.order;
    const ref = str(args[command === "drag" ? "to" : command === "wait" ? "element" : observing ? "root" : "ref_id"]);
    const source = fromRef(session, env, ref, slot.snapshots);

    const windowSurface =
      (args["surface"] == null || args["surface"] === "window") &&
      args["screen"] == null &&
      (command !== "screenshot" || Boolean(desktopScreenshotScope(args)));

    // Keep a verified capture running through consecutive observations of the same window. The previous
    // MCP image is always superseded, including when the new observation uses that very same scope.
    const current = () => this.#sessions.get(session) === slot && slot.order === order;

    const compatibleRef =
      describes(source, slot.current) &&
      (!scope?.app || scope.app === slot.current?.app) &&
      (!scope?.id || scope.id === slot.current?.identity.id);

    const sameScope = windowSurface && observing && args["root"] == null && continuesDesktopScope(scope, slot.current);
    const waitingInWindow = timedWait && (!scope || continuesDesktopScope(scope, slot.current));
    const keepWindow = windowSurface && ((windowCommand && compatibleRef) || sameScope || waitingInWindow);
    this.#replace(session, slot, keepWindow ? slot.current : undefined);

    const before =
      observing && (scope || command === "snapshot") && !source && windowSurface
        ? await observeDesktopWindows(native, signal, scope?.app)
        : undefined;

    if (before && current() && slot.current && !verifiedDesktopWindow(before, slot.current))
      this.#replace(session, slot, undefined);
    signal.throwIfAborted();
    let result: CallToolResult | undefined;

    try {
      result = await invoke(params, signal);
    } catch (error) {
      if (current()) this.#replace(session, slot, undefined);
      throw error;
    }

    if (!current()) return result;
    const data = nativeData(result, command);
    const delivery = acting && desktopActionReport(command, result);

    if (signal.aborted || delivery === "hide" || command === "batch") {
      this.#replace(session, slot, undefined);

      return result;
    }

    if (data === undefined || !result) {
      this.#replace(session, slot, undefined);

      return result;
    }

    const { proof, snapshotId: saveSnapshot } = windowCommand
      ? desktopResultProof(
          {
            session,
            env,
            command,
            scope,
            source,
            snapshots: slot.snapshots,
            windowSurface,
            delivered: Boolean(delivery),
          },
          data,
        )
      : {};

    let target = timedWait ? slot.current : proof && (await this.#resolve(proof, before, native, signal));

    if (!current() || signal.aborted) return result;

    if (
      target &&
      slot.current &&
      target.app === slot.current.app &&
      target.unique === slot.current.unique &&
      sameDesktopWindow(target.identity, slot.current.identity)
    )
      target = slot.current;

    const image = await desktopObservation({ command, args, result, target, before }, native, signal);

    if (!current() || signal.aborted) return result;

    // A tool can return the exact pixels it saw even if its claimed window was replaced during capture.
    if (command === "screenshot" && result.content.some((block) => block.type === "image") && !image?.target)
      target = undefined;
    this.#replace(session, slot, target, image ? { image, signal } : undefined);

    if (saveSnapshot && target) {
      slot.snapshots.delete(saveSnapshot);

      if (slot.snapshots.size >= 12) slot.snapshots.delete(slot.snapshots.keys().next().value!);
      slot.snapshots.set(saveSnapshot, target);
    }

    return result;
  }

  async #resolve(
    proof: DesktopWindowProof,
    before: DesktopWindow[] | undefined,
    native: DesktopNativeCall,
    signal: AbortSignal,
  ) {
    if (proof.app && proof.id && proof.pid && proof.process_instance && !proof.unique)
      return {
        app: proof.app,
        identity: { id: proof.id, pid: proof.pid, process_instance: proof.process_instance },
        unique: false,
      };

    // Without a captured process identity, bind the reported target to the inventory from before the command.
    // Preview checks the same process generation again on both sides of the native screenshot.
    const windows = proof.pid ? await observeDesktopWindows(native, signal, proof.app) : before;

    return windows && resolveDesktopTarget(windows, proof);
  }
}
