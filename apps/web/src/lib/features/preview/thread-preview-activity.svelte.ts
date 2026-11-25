import { AgentTool, ItemStatus, type Item, type ui } from "@canopy/contracts";

interface Admission {
  activity: ui.ThreadAutomationActivity;
  start: bigint;
  legacyItem?: string | undefined;
}

interface TurnUse {
  workerId: string;
  /** Completing a newer call can leave an older call running without admitting a new visual source. */
  admissionId: string;
  calls: Map<string, Admission>;
  seen: Set<string>;
  last?: Admission;
  after: bigint;
}

const servers = new Map([
  ["agent_browser", AgentTool.BROWSER],
  ["agent_desktop", AgentTool.DESKTOP],
  ["agent_device", AgentTool.DEVICE],
]);

function remember(ids: Set<string>, id: string, limit: number): void {
  ids.add(id);

  if (ids.size > limit) {
    const oldest = ids.values().next().value;

    if (oldest !== undefined) ids.delete(oldest);
  }
}

function work(item: Item, tool: AgentTool) {
  const content = item.content;

  if (content.case === "toolCall") {
    const { server, name } = content.value;

    if (servers.get(server) === tool) return "visual";

    // A Codex exec/wait can enclose any mix of native tools, including a Desktop call.
    if ((!server || server === "functions") && ["exec", "wait", "functions.exec", "functions.wait"].includes(name))
      return "container";
  }

  switch (content.case) {
    case "userMessage":
    case "agentMessage":
    case "reasoning":
    case undefined:
      return undefined;
    case "backgroundTask":
      return "background";
    default:
      return "other";
  }
}

/** Only a direct native item already in progress can corroborate an older admission. */
function legacyItem(activity: ui.ThreadAutomationActivity, items: ui.TimelineItem[]) {
  const direct = items.filter(
    (entry) =>
      entry.turnId === activity.turnId &&
      !entry.inherited &&
      entry.item?.status === ItemStatus.IN_PROGRESS &&
      work(entry.item, activity.tool) === "visual",
  );

  return direct.length === 1 ? direct[0]?.item?.itemId : undefined;
}

function lastUse(use: TurnUse, snapshot: ui.ThreadSnapshot) {
  const last = use.last;

  if (!last) return;
  let visualRunning = false;
  let otherWork = false;

  for (const entry of snapshot.items) {
    if (entry.inherited || entry.turnId !== last.activity.turnId || !entry.item) continue;
    const kind = work(entry.item, last.activity.tool);
    const running = entry.item.status === ItemStatus.IN_PROGRESS;

    if (kind === "visual" && running && entry.item.itemId === last.legacyItem) visualRunning = true;

    if (
      (kind === "other" && running) ||
      (kind === "container" && running && entry.firstSeq > last.start) ||
      (kind && kind !== "visual" && entry.firstSeq > use.after)
    )
      otherWork = true;
  }

  if (otherWork && !visualRunning) {
    delete use.last;

    return;
  }

  return { activity: last.activity, admissionId: use.admissionId, settled: !visualRunning };
}

/** Only live admissions can open Mini. Their ids are independent of the enclosing harness item. */
export class ThreadPreviewActivity {
  readonly #turns = new Map<string, TurnUse>();
  readonly #ended = new Set<string>();
  current = $state.raw<{ activity: ui.ThreadAutomationActivity; admissionId: string; settled: boolean }>();

  clear(): void {
    this.#turns.clear();
    this.#ended.clear();
    this.current = undefined;
  }

  apply(snapshot: ui.ThreadSnapshot, update: ui.ThreadUpdate): void {
    const change = update.change;

    if (change.case === "automationActivityReset") this.#reset(change.value);

    if (change.case === "event" && change.value.event?.body.case === "turnFinished")
      this.#end(change.value.event.turnId);

    if (change.case === "automationActivity" || change.case === "automationActivityFinished") {
      const activity = change.value;

      if (snapshot.thread && snapshot.thread.workerId !== activity.workerId) return;
      this.#receive(activity, change.case === "automationActivityFinished", snapshot);
    }

    if (!this.#turns.size) {
      this.current = undefined;

      return;
    }

    if (change.case === "event" && change.value.event?.body.case === "itemDelta") return;
    const next = this.#selection(snapshot);

    if (
      this.current?.activity !== next?.activity ||
      this.current?.admissionId !== next?.admissionId ||
      this.current?.settled !== next?.settled
    )
      this.current = next;
  }

  #end(id: string): void {
    this.#turns.delete(id);
    remember(this.#ended, id, 4);
  }

  #reset(id: string): void {
    for (const use of this.#turns.values()) {
      if (id) use.calls.delete(id);
      else use.calls.clear();

      if (!id || use.last?.activity.id === id) delete use.last;

      if (!id || use.admissionId === id)
        use.admissionId = Array.from(use.calls.keys()).at(-1) ?? use.last?.activity.id ?? "";
    }
  }

  #receive(activity: ui.ThreadAutomationActivity, finished: boolean, snapshot: ui.ThreadSnapshot): void {
    if (!activity.turnId || !activity.id || !activity.workerId || this.#ended.has(activity.turnId)) return;
    let turn = this.#turns.get(activity.turnId);

    if (!turn || turn.workerId !== activity.workerId) {
      // Admission can reach the client just before its durable turn row.
      if (this.#turns.size >= 4) {
        const oldest = this.#turns.keys().next().value;

        if (oldest !== undefined) this.#turns.delete(oldest);
      }

      turn = {
        workerId: activity.workerId,
        admissionId: "",
        calls: new Map(),
        seen: new Set(),
        after: snapshot.lastSeq,
      };
      this.#turns.set(activity.turnId, turn);
    }

    if (!finished && (turn.seen.has(activity.id) || turn.calls.has(activity.id))) return;
    // A duplicate start, including after an earlier finish, cannot reopen a discarded view.
    remember(turn.seen, activity.id, 256);

    if (finished) {
      const admitted = turn.calls.get(activity.id);

      if (!admitted) return;
      turn.calls.delete(activity.id);
      turn.last = admitted;
    } else {
      const admitted = {
        activity,
        start: snapshot.lastSeq,
        legacyItem: activity.reportsCompletion ? undefined : legacyItem(activity, snapshot.items),
      };

      if (activity.reportsCompletion) turn.calls.set(activity.id, admitted);
      turn.last = admitted;
      turn.admissionId = activity.id;
    }

    turn.after = snapshot.lastSeq;
  }

  #selection(snapshot: ui.ThreadSnapshot) {
    const thread = snapshot.thread;

    if (!thread) return;

    for (const [id, use] of this.#turns) {
      const turn = snapshot.turns.find((entry) => entry.id === id && !entry.inherited);

      if (
        thread.workerId !== use.workerId ||
        thread.archivedAt ||
        thread.deletedAt ||
        thread.status === "archived" ||
        thread.status === "failed"
      ) {
        this.#turns.delete(id);
        continue;
      }

      if (turn && turn.status !== "queued" && turn.status !== "running") {
        this.#end(id);
        continue;
      }

      if (turn?.status !== "running") continue;

      // Active admissions take precedence over parallel shell work and out-of-order completions.
      if (use.calls.size) {
        const active = Array.from(use.calls.values()).at(-1);

        if (active) return { activity: active.activity, admissionId: use.admissionId, settled: false };
      }

      const last = lastUse(use, snapshot);

      if (last) return last;
    }
  }
}
