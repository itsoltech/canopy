import { parseObject } from "@canopy/domain/json";
import { runProcess } from "@canopy/process-governor";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import type { LocalAutomationServer } from "../agent-tools-mcp/stdio.ts";
import {
  cursorCommand,
  desktopActionReport,
  desktopBatchEffect,
  desktopSessionEnded,
  deliveredDesktopCursor,
  observeDesktopCursor,
  type DesktopCursorLocation,
} from "./desktop-cursor-observation.ts";
import { desktopPointerCatalog, type DesktopPointerPresentation } from "./desktop-pointer.ts";
import { DesktopTargets } from "./desktop-targets.ts";
import { sameDesktopWindow } from "./desktop-window.ts";
import type { AgentToolLifecycle } from "./lifecycle.ts";
import { toolArgv, type ToolEnv } from "./paths.ts";

const CLICK_MS = 4_000;
const MAX_SESSIONS = 64;

export interface DesktopCursorSample extends DesktopCursorLocation {
  actionId: string;
}

export type DesktopPresentation = Pick<
  DesktopPointerPresentation,
  "settings" | "configure" | "disableLegacy" | "show" | "hide" | "end" | "close"
>;

type NativeCall = Parameters<NonNullable<LocalAutomationServer["managed"]>["call"]>[2];

interface Slot {
  sample?: DesktopCursorSample;
  clickUntil: number;
  started: number;
  applied: number;
  pending: number;
}

/** Only the latest confirmed action for a fixed session and window can reach either renderer. */
export class DesktopCursors {
  readonly targets = new DesktopTargets();
  readonly #slots = new Map<string, Slot>();
  readonly #stop = new AbortController();
  readonly #presentation: DesktopPresentation;

  constructor(presentation: DesktopPresentation) {
    this.#presentation = presentation;
  }

  #forget(session: string): void {
    this.#slots.delete(session);
    this.#presentation.hide(session);
  }

  end(session: string): void {
    this.targets.end(session);
    this.#slots.delete(session);
    this.#presentation.end(session);
  }

  close(): void {
    this.targets.close();
    this.#stop.abort();
    this.#slots.clear();
    this.#presentation.close();
  }

  #clearSample(session: string, slot: Slot): void {
    delete slot.sample;
    this.#presentation.hide(session);

    if (!slot.pending) this.#slots.delete(session);
  }

  missingWindow(session: string, actionId: string): void {
    const slot = this.#slots.get(session);

    if (slot?.sample?.actionId === actionId) this.#clearSample(session, slot);
  }

  current(session: string): DesktopCursorSample | undefined {
    const slot = this.#slots.get(session);

    if (!slot?.sample) return undefined;
    const style = this.#presentation.settings(session);

    if (!style) {
      this.#forget(session);

      return undefined;
    }

    this.#slots.delete(session);
    this.#slots.set(session, slot);

    return slot.sample.click && (!style.ripple || Date.now() >= slot.clickUntil)
      ? { ...slot.sample, click: false }
      : slot.sample;
  }

  #begin(session: string): Slot {
    const slot = this.#slots.get(session) ?? { clickUntil: 0, started: 0, applied: 0, pending: 0 };
    this.#slots.delete(session);

    if (this.#slots.size >= MAX_SESSIONS) {
      const oldest = this.#slots.keys().next();

      if (!oldest.done) this.#forget(oldest.value);
    }

    this.#slots.set(session, slot);
    slot.pending++;

    return slot;
  }

  /** Viewer input and one-shot operations also run the pinned executable and can wake a previous native overlay. */
  prepareCli(session: string, executable: string, env: ToolEnv, signal: AbortSignal): Promise<void> {
    if (!session) return Promise.resolve();

    return this.#presentation.disableLegacy(
      session,
      AbortSignal.any([signal, this.#stop.signal]),
      async (params, request) => {
        if (params.name !== "desktop_cursor_overlay_disable") return undefined;

        const result = await runProcess(
          {
            argv: toolArgv(executable, ["--session", session, "cursor-overlay", "disable"], env),
            env,
            signal: request,
            timeoutMs: 5_000,
            maxBytes: 16 * 1024,
          },
          { kind: "utility", maxQueueMs: 1_000, signal: request },
        );

        return { content: [], isError: result.code !== 0, structuredContent: parseObject(result.stdout) };
      },
      env,
    );
  }

  configure(
    session: string,
    env: ToolEnv,
    headed: boolean,
    lifecycle: AgentToolLifecycle,
  ): Pick<LocalAutomationServer, "managed" | "prepare"> {
    return {
      prepare: async () => lifecycle.assertOpen(session),
      managed: {
        tools: [],
        catalog: desktopPointerCatalog,
        call: (params, signal, next) =>
          lifecycle.run(session, () =>
            this.#call(session, env, headed, params, AbortSignal.any([signal, this.#stop.signal]), next),
          ),
      },
    };
  }

  async #call(
    session: string,
    env: ToolEnv,
    headed: boolean,
    params: AutomationCall,
    signal: AbortSignal,
    next: NativeCall,
  ) {
    signal.throwIfAborted();

    if (params.name === "desktop_cursor_overlay_enable" || params.name === "desktop_cursor_overlay_disable") {
      const result = await this.#presentation.configure(session, params, signal, next, env);

      if (result && !result.isError) this.#forget(session);

      return result;
    }

    await this.#presentation.disableLegacy(session, signal, next, env);
    signal.throwIfAborted();

    const result = await this.targets.run(session, env, params, signal, next, () =>
      this.#reportCursor(session, env, headed, params, signal, next),
    );

    const target = this.targets.current(session);
    const slot = this.#slots.get(session);

    if (target && slot?.sample && !sameDesktopWindow(target.identity, slot.sample.identity))
      this.#clearSample(session, slot);

    return result;
  }

  async #reportCursor(
    session: string,
    env: ToolEnv,
    headed: boolean,
    params: AutomationCall,
    signal: AbortSignal,
    next: NativeCall,
  ) {
    if (params.name === "desktop_batch" || params.name === "desktop_session_end") {
      const slot = this.#slots.get(session);
      const order = slot ? ++slot.started : 0;
      const result = await next(params, signal);

      const effect =
        params.name === "desktop_batch"
          ? desktopBatchEffect(session, result)
          : desktopSessionEnded(session, result)
            ? "end"
            : undefined;

      if (effect === "end") this.end(session);
      else if (effect === "hide" && slot && this.#slots.get(session) === slot && order > slot.applied) {
        slot.applied = order;
        this.#clearSample(session, slot);
      }

      return result;
    }

    const command = cursorCommand(params.name, headed);

    if (!command) return next(params, signal);

    if (!this.#presentation.settings(session)) {
      if (this.#slots.has(session)) this.#forget(session);

      return next(params, signal);
    }

    const slot = this.#begin(session);
    const order = ++slot.started;
    let dispatched = false;

    try {
      const before = await observeDesktopCursor(session, env, command, params.arguments, next, signal);
      signal.throwIfAborted();
      dispatched = true;
      const result = await next(params, signal);
      const report = desktopActionReport(command, result);

      if (!report || this.#slots.get(session) !== slot || order <= slot.applied) return result;

      const location =
        !signal.aborted &&
        report !== "hide" &&
        before &&
        (await deliveredDesktopCursor(command, report, before, next, signal));

      if (this.#slots.get(session) !== slot || order <= slot.applied) return result;
      slot.applied = order;
      const style = this.#presentation.settings(session);

      if (location && style && !signal.aborted) {
        slot.sample = { ...location, click: location.click && style.ripple, actionId: crypto.randomUUID() };
        slot.clickUntil = Date.now() + CLICK_MS;
        this.#presentation.show(session, slot.sample);
      } else this.#clearSample(session, slot);

      return result;
    } catch (error) {
      // A transport disconnect after dispatch can lose the disposition even though native input already ran.
      if (dispatched && this.#slots.get(session) === slot && order > slot.applied) {
        slot.applied = order;
        this.#clearSample(session, slot);
      }

      throw error;
    } finally {
      slot.pending--;

      if (!slot.pending && !slot.sample && this.#slots.get(session) === slot) this.#slots.delete(session);
    }
  }
}
