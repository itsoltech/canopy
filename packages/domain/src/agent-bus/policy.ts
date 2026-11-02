import { agentBusToolsFor, SPAWN_PERMISSION_MODES, type AgentBusCall, type SpawnPermissionMode } from "./tools.ts";

/**
 * Who may do what on the agent bus (docs/agent-bus.md#4-reguły-dostępu-i-limity).
 * Pure: the gateway loads the facts (tree, counts, hops, referenced rows) in the same
 * transaction and asks here.
 *
 * - Two levels: the main thread (depth 0) orchestrates; side threads (depth 1) cannot spawn
 *   or control other threads, and are not offered those tools at all.
 * - The communication domain is one thread tree: read, wait for and message any other
 *   thread of the tree (children, parent, siblings).
 * - Control (interrupt, close, answering interactions, schedules of others) only over own descendants.
 * - A side thread never gets broader permissions than the thread that spawned it.
 * - Every turn started through the bus (messages, notifications, agent-created schedules)
 *   carries hops = hops of the causing turn + 1; human input and provider wake-ups start at 0.
 *   This stops agent ping-pong without a human.
 */

export interface ThreadNode {
  readonly id: string;
  readonly rootId: string;
  readonly depth: number;
  /** Parent first, root last. Empty for the root. */
  readonly ancestorIds: readonly string[];
  readonly provider: string;
  readonly archived: boolean;
}

export interface InteractionFacts {
  readonly id: string;
  readonly threadId: string;
  readonly kind: "permission" | "question" | "elicitation";
  readonly routedTo: "parent" | "human";
  readonly status: string;
}

export interface ScheduleFacts {
  readonly id: string;
  readonly threadId: string;
}

export interface BusLimits {
  readonly maxDepth: number;
  readonly maxChildrenPerThread: number;
  readonly maxActiveThreadsPerTree: number;
  readonly maxHops: number;
  readonly maxSchedulesPerThread: number;
  readonly maxRecurringDays: number;
  readonly minCronMinutes: number;
}

export const DEFAULT_BUS_LIMITS: BusLimits = {
  maxDepth: 1, // main thread + one level of side threads; matches threads_max_depth
  maxChildrenPerThread: 8,
  maxActiveThreadsPerTree: 16,
  maxHops: 8,
  maxSchedulesPerThread: 10,
  maxRecurringDays: 30,
  minCronMinutes: 5,
};

export interface BusFacts {
  readonly caller: ThreadNode;
  /** Hops of the caller's current turn (0 for human input and provider wake-ups). */
  readonly callerHops: number;
  /** Threads addressed by the call (thread_id / thread_ids / schedule target), resolved. Missing ids are absent. */
  readonly targets: ReadonlyMap<string, ThreadNode>;
  /** spawn_thread: non-archived children of the caller and busy threads in the tree. */
  readonly callerChildren: number;
  readonly activeInTree: number;
  /** spawn_thread: provider of the agent that will run the new thread. */
  readonly spawnProvider?: string;
  /** spawn_thread: the caller's own permission mode, the ceiling for the new thread. */
  readonly callerPermissionMode?: SpawnPermissionMode;
  /** answer_interaction: the referenced interaction. */
  readonly interaction?: InteractionFacts;
  /** cancel_schedule: the referenced schedule. */
  readonly schedule?: ScheduleFacts;
  /** schedule_*: active schedules of the target thread. */
  readonly targetSchedules?: number;
  readonly now: Date;
}

export type BusDecision =
  | { readonly allowed: true; readonly hops?: number }
  | { readonly allowed: false; readonly reason: string };

const deny = (reason: string): BusDecision => ({ allowed: false, reason });
const allow: BusDecision = { allowed: true };

export function authorizeBusCall(call: AgentBusCall, facts: BusFacts, limits: BusLimits = DEFAULT_BUS_LIMITS): BusDecision {
  const { caller } = facts;
  if (!agentBusToolsFor(caller.depth).includes(call.tool)) {
    return deny(`${call.tool} is not available in side threads; ask your parent thread with send_message`);
  }
  const nextHops = facts.callerHops + 1;
  const withHops = (notify: boolean | undefined): BusDecision =>
    nextHops > limits.maxHops || ((notify ?? true) && nextHops + 1 > limits.maxHops)
      ? deny(`agent-to-agent chain limit reached (${limits.maxHops} hops without human input)`)
      : { allowed: true, hops: nextHops };

  switch (call.tool) {
    case "list_agents":
    case "list_threads":
    case "list_interactions":
    case "list_schedules":
      return allow;

    case "spawn_thread": {
      if (caller.archived) return deny("this thread is archived");
      if (caller.depth + 1 > limits.maxDepth) return deny("side threads cannot start further side threads");
      if (facts.callerChildren >= limits.maxChildrenPerThread) {
        return deny(`side thread limit (${limits.maxChildrenPerThread}) reached; close finished threads first`);
      }
      if (facts.activeInTree >= limits.maxActiveThreadsPerTree) {
        return deny(`too many active threads in this tree (${limits.maxActiveThreadsPerTree})`);
      }
      if (call.args.fork && facts.spawnProvider !== undefined && facts.spawnProvider !== caller.provider) {
        return deny(`fork keeps the provider: ${caller.provider} cannot fork into ${facts.spawnProvider}`);
      }
      const wanted = call.args.permission_mode;
      const ceiling = facts.callerPermissionMode ?? "ask";
      if (wanted !== undefined && permissionRank(wanted) > permissionRank(ceiling)) {
        return deny(`permission_mode ${wanted} is broader than yours (${ceiling}); a subagent cannot get more permissions than you`);
      }
      return withHops(call.args.notify);
    }

    case "send_message": {
      const target = inTree(facts, call.args.thread_id);
      if (typeof target === "string") return deny(target);
      if (target.archived) return deny("target thread is archived");
      return withHops(call.args.notify);
    }

    case "wait_threads": {
      for (const id of call.args.thread_ids) {
        const target = inTree(facts, id);
        if (typeof target === "string") return deny(target);
      }
      return allow;
    }

    case "get_thread":
    case "read_thread": {
      const target = inTree(facts, call.args.thread_id);
      return typeof target === "string" ? deny(target) : allow;
    }

    case "interrupt_thread":
    case "close_thread": {
      const target = descendant(facts, call.args.thread_id);
      return typeof target === "string" ? deny(target) : allow;
    }

    case "answer_interaction": {
      const interaction = facts.interaction;
      if (!interaction || interaction.id !== call.args.request_id) return deny(`interaction ${call.args.request_id} not found`);
      const owner = descendant(facts, interaction.threadId);
      if (typeof owner === "string") return deny(`interaction ${interaction.id} not found`);
      if (interaction.routedTo !== "parent") return deny("this interaction is answered by the user");
      if (interaction.status !== "pending") return deny(`interaction is already ${interaction.status}`);
      const { response } = call.args;
      if (interaction.kind === "permission" && response === "answer") return deny("permission prompts take allow or deny");
      if (interaction.kind !== "permission" && (response === "allow" || response === "deny")) {
        return deny(`${interaction.kind} takes answer or cancel`);
      }
      if (response === "answer" && call.args.answer_json === undefined) return deny("answer requires answer_json");
      return allow;
    }

    case "schedule_wakeup": {
      const target = scheduleTarget(facts, call.args.thread_id, limits);
      if (typeof target === "string") return deny(target);
      const { delay_seconds: delay, at } = call.args;
      if ((delay === undefined) === (at === undefined)) return deny("set exactly one of delay_seconds or at");
      if (at !== undefined) {
        const when = Date.parse(at);
        if (Number.isNaN(when)) return deny("at must be an ISO 8601 time");
        const ahead = (when - facts.now.getTime()) / 1000;
        if (ahead < 60 || ahead > 7 * 24 * 3600) return deny("at must be between 1 minute and 7 days from now");
      }
      return withHops(false);
    }

    case "schedule_recurring": {
      const target = scheduleTarget(facts, call.args.thread_id, limits);
      if (typeof target === "string") return deny(target);
      const cron = checkCron(call.args.cron, limits.minCronMinutes);
      if (cron) return deny(cron);
      if (call.args.timezone !== undefined && !isTimeZone(call.args.timezone)) return deny(`unknown time zone ${call.args.timezone}`);
      // Agents may not create open-ended schedules; users can, from the UI.
      if (call.args.until === undefined && call.args.max_runs === undefined) return deny("set until or max_runs");
      if (call.args.until !== undefined) {
        const until = Date.parse(call.args.until);
        if (Number.isNaN(until)) return deny("until must be an ISO 8601 time");
        if (until <= facts.now.getTime()) return deny("until is in the past");
        if (until - facts.now.getTime() > limits.maxRecurringDays * 24 * 3600 * 1000) {
          return deny(`until must be within ${limits.maxRecurringDays} days`);
        }
      }
      return withHops(false);
    }

    case "cancel_schedule": {
      const schedule = facts.schedule;
      if (!schedule || schedule.id !== call.args.schedule_id) return deny(`schedule ${call.args.schedule_id} not found`);
      if (schedule.threadId === caller.id) return allow;
      const owner = descendant(facts, schedule.threadId);
      return typeof owner === "string" ? deny(`schedule ${schedule.id} not found`) : allow;
    }
  }
}

/** read_only < ask < accept_edits < full_auto: how much a thread may do without a human answer. */
export function permissionRank(mode: SpawnPermissionMode): number {
  return SPAWN_PERMISSION_MODES.indexOf(mode);
}

/** Target in the caller's tree, or the reason why not. Unknown and foreign threads look the same. */
function inTree(facts: BusFacts, id: string): ThreadNode | string {
  if (id === facts.caller.id) return "a thread cannot address itself";
  const target = facts.targets.get(id);
  if (!target || target.rootId !== facts.caller.rootId) return `thread ${id} not found in your thread tree`;
  return target;
}

function descendant(facts: BusFacts, id: string): ThreadNode | string {
  const target = inTree(facts, id);
  if (typeof target === "string") return target;
  if (!target.ancestorIds.includes(facts.caller.id)) return "you can only control threads you spawned";
  return target;
}

function scheduleTarget(facts: BusFacts, id: string | undefined, limits: BusLimits): ThreadNode | string {
  const target = id === undefined || id === facts.caller.id ? facts.caller : descendant(facts, id);
  if (typeof target === "string") return target;
  if (target.archived) return "target thread is archived";
  if ((facts.targetSchedules ?? 0) >= limits.maxSchedulesPerThread) {
    return `schedule limit (${limits.maxSchedulesPerThread}) reached for this thread`;
  }
  return target;
}

/**
 * Basic shape check of a five-field cron expression and of the minute step.
 * The gateway computes next runs with a cron library and enforces the minimum interval precisely.
 */
function checkCron(cron: string, minMinutes: number): string | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return "cron must have five fields (minute hour day month weekday)";
  if (!fields.every((f) => /^[\d*,/\-A-Za-z]+$/.test(f))) return "cron contains invalid characters";
  const minute = fields[0] ?? "";
  if (minute === "*") return `cron runs every minute; the minimum interval is ${minMinutes} minutes`;
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && Number(step[1]) < minMinutes) return `cron interval is below ${minMinutes} minutes`;
  return undefined;
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
