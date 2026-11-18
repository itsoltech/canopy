import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { isMessage, type Message } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { BOT_THREAD_ACCESS } from "./capabilities.ts";
import {
  BOT_THREADS_DISCONNECTED,
  botThreadConnectionEnabled,
  ownerModuleEnabled,
  lockedOwnerModule,
  lockedBotThreadConnection,
  moduleDisabledMessage,
} from "../store/module-access.ts";
import { fail, type Arguments } from "./agents-context.ts";
import type { LinkedAgents } from "./agents.ts";

export function linkedModulesConnected(host: LinkedAgents) {
  return host.scope.run(botThreadConnectionEnabled(host.owner));
}

export async function requireLinkedModules(host: LinkedAgents) {
  if (!(await linkedModulesConnected(host))) fail(BOT_THREADS_DISCONNECTED);
}

/** Called before taking work/peer locks inside an admission transaction. */
export async function requireAgentModules(host: LinkedAgents, actor: string, target: string, lock = false) {
  const module = actor === "bot" ? "bots" : "threads";
  const both = actor !== target;

  const check = lock
    ? Effect.flatMap(SqlClient.SqlClient, (sql) =>
        both ? lockedBotThreadConnection(sql, host.owner) : lockedOwnerModule(sql, host.owner, module),
      )
    : both
      ? botThreadConnectionEnabled(host.owner)
      : ownerModuleEnabled(host.owner, module);

  if (!(await host.scope.run(check))) fail(both ? BOT_THREADS_DISCONNECTED : moduleDisabledMessage(module));
}

export function targetKind(operation: string, args: Arguments) {
  // Spawn, thread reads, controls and answers always address a thread.
  return operation === "send" && args["target_kind"] === "bot" ? "bot" : "thread";
}

/** Ordinary UI calls carry no module dependency. The sender sets this on behalf of an agent. */
export function requiresLinkedModules(request: Message) {
  return (
    isMessage(request, bots.ListThreadApprovalsRequestSchema) ||
    ("botThreadAccess" in request && request.botThreadAccess === true)
  );
}

/** A qualified approval id may name an ordinary bot card or a thread interaction.
 * Only the home can distinguish them. Older homes cannot honor the restriction. */
export async function restrictLinkedApproval(host: LinkedAgents, request: Message, node: string) {
  if (isMessage(request, bots.ListThreadApprovalsRequestSchema)) await requireLinkedModules(host);

  if (!isMessage(request, bots.AnswerBotApprovalRequestSchema)) return;

  if (!(await linkedModulesConnected(host))) request.botApprovalsOnly = true;

  if (request.botApprovalsOnly && !host.core.computers?.capabilities(node).includes(BOT_THREAD_ACCESS))
    fail("Update Canopy on the linked computer to answer this approval with a module disabled.");
}
