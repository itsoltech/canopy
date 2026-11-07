import { create } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { linkedMessage, methodNamed } from "../computers/remote.ts";
import { target, unary, type Handler } from "./routed-context.ts";
import { gather } from "./routed-overview.ts";
import type { UiHandlers } from "./ui-service.ts";

/** Execution records are gathered from homes, never replicated as shared configuration. */
export function executionLists(
  core: GatewayCore,
  local: UiHandlers,
  routed: Record<string, Handler>,
): Partial<UiHandlers> {
  return {
    listWorktrees: async (request, context) => {
      if (target(methodNamed("ListWorktrees")!, request))
        return linkedMessage(ui.ListWorktreesResponseSchema, await unary(routed["listWorktrees"]!, request, context));

      const [result, others] = await Promise.all([
        local.listWorktrees(request, context),
        request.worktreeId || request.workerId
          ? []
          : gather<ui.ListWorktreesResponse>(core, "ListWorktrees", request, context.signal),
      ]);

      return create(ui.ListWorktreesResponseSchema, {
        entries: [...(result.entries ?? []), ...others.flatMap((response) => response.entries)],
      });
    },
    listBots: async (request, context) => {
      const unavailableComputers: ui.LinkedComputer[] = [];
      const refreshingComputers: ui.LinkedComputer[] = [];

      const [result, others] = await Promise.all([
        local.listBots(request, context),
        gather<bots.ListBotsResponse>(
          core,
          "ListBots",
          request,
          context.signal,
          unavailableComputers,
          refreshingComputers,
        ),
      ]);

      return create(bots.ListBotsResponseSchema, {
        bots: [...(result.bots ?? []), ...others.flatMap((r) => r.bots)],
        unavailableComputers,
        refreshingComputers,
      });
    },
    listSchedules: async (request, context) => {
      if (target(methodNamed("ListSchedules")!, request))
        return linkedMessage(ui.ListSchedulesResponseSchema, await unary(routed["listSchedules"]!, request, context));

      const [result, others] = await Promise.all([
        local.listSchedules(request, context),
        gather<ui.ListSchedulesResponse>(core, "ListSchedules", request, context.signal),
      ]);

      return create(ui.ListSchedulesResponseSchema, {
        schedules: [...(result.schedules ?? []), ...others.flatMap((r) => r.schedules)],
      });
    },
  };
}
