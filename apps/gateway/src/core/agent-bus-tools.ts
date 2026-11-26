import { SANDBOX_DERIVATION_UNAVAILABLE, threadSandbox } from "../store/thread-sandbox.ts";
import { create, type JsonValue } from "@bufbuild/protobuf";
import { busScheduleTool } from "./agent-bus-schedules.ts";

export { busScheduleTool } from "./agent-bus-schedules.ts";

import { ui } from "@canopy/contracts";
import {
  agentCatalog,
  SETTINGS_GUIDE_TOOL,
  taskProgress,
  type AgentBusArgs,
  type AgentBusCall,
  type SpawnTarget,
} from "@canopy/domain";
import { Predicate, type Effect } from "effect";
import { AgentBusStore, GatewayStore, type CallSource, type ThreadRow } from "../store/index.ts";
import { BusRefusal, busState, scheduleIdOf, type BusHost } from "./agent-bus-context.ts";
import { busWait } from "./agent-bus-waiting.ts";
import { busRead } from "./agent-bus-reads.ts";
import type { AgentBus } from "./agent-bus.ts";
import { QUESTION_TIMEOUT_MS } from "../store/questions.ts";
import { findCanopySettings } from "./settings-guide.ts";
import type { WorkerConnection } from "../worker-link/index.ts";

/** A created schedule is announced to the UI before the agent hears back. */
export async function busAnnounced(hostContext: AgentBus, created: Promise<JsonValue>): Promise<JsonValue> {
  const result = await created;
  const id = scheduleIdOf(result);

  if (id) await hostContext[busState].host.scheduleChanged(id);

  return result;
}

export async function busExecute(
  hostContext: AgentBus,
  call: AgentBusCall,
  source: CallSource,
  caller: ThreadRow,
  hops: number,
  target: SpawnTarget,
  connection?: WorkerConnection,
): Promise<JsonValue> {
  const store = <A, E>(use: (s: AgentBusStore["Service"]) => Effect.Effect<A, E>) =>
    hostContext[busState].host.run(AgentBusStore.use(use));

  switch (call.tool) {
    case SETTINGS_GUIDE_TOOL:
      return findCanopySettings(call.args);
    case "update_tasks":
      // The call itself is the record: its transcript item carries the list to every client.
      return { updated: true, ...taskProgress(call.args.tasks) };
    case "switch_worktree":
      return hostContext[busState].host.switchWorktree(source, caller, call.args, hops);
    case "show_images":
    case "show_video":
      return hostContext[busState].host.publishMedia(source, caller, call);
    case "import_image_reply":
      return hostContext[busState].host.importImageReply(source, caller, call.args.item_id);
    case "render_visual":
    case "render_html":
      return hostContext[busState].host.renderVisual(source, caller, call.args);
    case "request_secret":
      return hostContext[busState].host.requestSecret(source, call.args, connection);
    case "list_project_secrets":
      return hostContext[busState].host.run(
        GatewayStore.use((s) => s.projectSecretNames(caller.owner_user_id, caller.id)),
      );
    case "ask_user": {
      const interaction = await store((s) => s.askUser(source, call.args, hops));
      await hostContext[busState].host.interaction(interaction);
      await hostContext.onInteraction(interaction);

      return busAnswers(hostContext, source, interaction.requestId, call.args.wait);
    }

    case "get_answers":
      return busAnswers(hostContext, source, call.args.question_set_id, call.args.wait ?? false);
    case "list_agents": {
      const host = hostContext[busState].host;

      return {
        ...agentCatalog(target, await host.spawnInstances(caller)),
        ...(await host.agentThreadCatalog(caller, call.args)),
      };
    }

    case "start_thread":
      return hostContext[busState].host.startAgentThread(source, caller, call.args, hops, target);
    case "spawn_thread":
      return spawnSideThread(hostContext[busState].host, source, caller, call.args, target, hops);

    case "message_delegating_bot":
      return hostContext[busState].host.messageDelegatingBot(source, call.args.text);

    case "send_message": {
      const sent = await store((s) => s.send({ source, caller, args: call.args, hops }));

      if (sent.turn) await hostContext[busState].host.queued(call.args.thread_id, sent.turn);
      else await hostContext[busState].host.steered(sent.steerId);

      return sent.result;
    }

    case "wait_threads":
      return busWait(hostContext, source, call.args);

    case "get_thread":
    case "read_thread":
      return busRead(hostContext, source, call);

    case "list_threads": {
      const { scope = "children", ...options } = call.args;

      return {
        threads: (await store((s) => s.listThreads(caller, scope, options))).map((thread) => ({
          ...thread,
        })),
      };
    }

    case "interrupt_thread":
      await store((s) => s.supersedeNotifications(caller.id, call.args.thread_id));
      await hostContext[busState].host.interrupt(call.args.thread_id);

      return { thread_id: call.args.thread_id, interrupted: true };
    case "close_thread": {
      await store((s) => s.supersedeNotifications(caller.id, call.args.thread_id));
      const commands = await store((s) => s.close(call.args.thread_id, caller.id));

      for (const worker of new Set(commands.map((entry) => entry.workerId)))
        await hostContext[busState].host.redeliver(worker);
      await hostContext[busState].host.broadcastThread(call.args.thread_id);

      return { thread_id: call.args.thread_id, closed: true };
    }

    case "list_interactions":
      return { interactions: [...(await store((s) => s.parentInteractions(caller.id)))] };
    case "answer_interaction": {
      const { request_id: requestId, response } = call.args;

      const interaction = await hostContext[busState].host.answer(
        { threadId: caller.id },
        create(ui.AnswerInteractionRequestSchema, {
          requestId,
          allow: response === "allow",
          cancelled: response === "cancel",
          ...(call.args.message !== undefined && { message: call.args.message }),
          ...(call.args.answer_json !== undefined && { answerJson: call.args.answer_json }),
        }),
      );

      return { request_id: requestId, status: interaction.status };
    }

    case "schedule_wakeup":
    case "schedule_recurring":
    case "list_schedules":
    case "cancel_schedule":
      return busScheduleTool(hostContext, call, source, caller, hops);
    case "list_background_tasks":
    case "get_background_task":
    case "stop_background_task":
      return await hostContext[busState].host.backgroundTask(call, caller.id);
    case "link_pull_request":
    case "watch_pr_checks":
    case "list_pr_watches":
    case "cancel_pr_watch":
      return await hostContext[busState].host.prChecks(call, source, caller, hops);
  }
}

async function spawnSideThread(
  host: BusHost,
  source: CallSource,
  caller: ThreadRow,
  args: AgentBusArgs["spawn_thread"],
  target: SpawnTarget,
  hops: number,
) {
  if (threadSandbox(caller)) throw new BusRefusal(SANDBOX_DERIVATION_UNAVAILABLE);
  const placement = await host.prepareWorkspace?.(caller, args);

  const spawn = () =>
    host.run(
      AgentBusStore.use((s) => s.spawn({ source, caller, args, target, hops, ...(placement && { placement }) })),
    );

  const { thread, turn, result } = host.permissionMutation
    ? await host.permissionMutation(source.threadId, spawn)
    : await spawn();

  await host.startThread(thread);

  if (placement?.workspaceMode === ui.WorkspaceMode.NEW_WORKTREE) await host.nameWorkspace?.(thread, args.prompt);
  await host.queued(thread.id, turn);

  return result;
}

export async function busAnswers(
  hostContext: AgentBus,
  source: CallSource,
  id: string,
  wait: boolean,
): Promise<JsonValue> {
  const deadline = Date.now() + (wait ? QUESTION_TIMEOUT_MS : 0);

  for (;;) {
    const result = await hostContext[busState].host.run(AgentBusStore.use((s) => s.getAnswers(source, id, true)));

    const enforcedDeadline =
      Predicate.isObject(result) && Predicate.isString(result["expires_at"])
        ? Date.parse(result["expires_at"])
        : deadline;

    if (
      !wait ||
      !Predicate.isObject(result) ||
      result["status"] !== "pending" ||
      result["waiting"] === false ||
      Date.now() >= enforcedDeadline
    ) {
      if (wait && Predicate.isObject(result) && result["status"] === "pending") {
        const expired = await hostContext[busState].host.run(
          GatewayStore.use((s) => s.expireInteraction(id, source.threadId)),
        );

        if (expired) {
          await hostContext[busState].host.interaction(expired);
        }

        // Another waiter/decision may have won the lock. Never return the stale pending snapshot.
        return hostContext[busState].host.run(AgentBusStore.use((s) => s.getAnswers(source, id, false)));
      }

      return result;
    }

    await Bun.sleep(Math.min(250, Math.max(0, enforcedDeadline - Date.now())));
  }
}
