import { create, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { AgentTool, ui } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

export const agentTools: { tool: AgentTool; name: string; description: string; icon: IconName }[] = [
  {
    tool: AgentTool.BROWSER,
    name: "Agent Browser",
    description: "Browse websites and interact with pages.",
    icon: "globe-alt",
  },
  {
    tool: AgentTool.DESKTOP,
    name: "Agent Desktop",
    description: "Use desktop apps and control windows.",
    icon: "computer-desktop",
  },
  {
    tool: AgentTool.DEVICE,
    name: "Agent Device",
    description: "Use apps on devices, emulators and simulators.",
    icon: "device-mobile",
  },
];

export type ToolWorker = { worker: ui.Worker; computer: string; readOnly: string };

export const toolKey = (workerId: string, tool: AgentTool) => `${workerId}/${tool}`;

export const workerTool = (worker: ui.Worker, tool: AgentTool) =>
  worker.agentTools.find((item) => item.tool?.tool === tool);

const requestErrors = {
  enable: "Could not save access. Check the worker, then retry.",
  install: "Could not start the install. Check the worker, then retry.",
  refresh: "Could not check tools. Check the worker, then retry.",
};

/** One page owns requests, including those for collapsed cards. Worker reports supply live progress. */
export class AgentToolActions {
  pending = $state<Record<string, string>>({});
  errors = $state<Record<string, string>>({});
  details = $state<Record<string, string>>({});
  notes = $state<Record<string, string>>({});
  disposed = false;
  #controllers = new Set<AbortController>();

  dispose() {
    this.disposed = true;

    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  async #request<Req extends DescMessage>(
    key: string,
    action: keyof typeof requestErrors,
    schema: Req,
    input: MessageInitShape<Req>,
  ) {
    if (this.disposed || this.pending[key]) return;
    const controller = new AbortController();
    this.#controllers.add(controller);
    this.pending[key] = action;
    delete this.errors[key];
    delete this.details[key];
    delete this.notes[key];

    try {
      return await requestJson(
        "POST",
        `/api/workers/agent-tools/${action}`,
        encode(schema, create(schema, input)),
        50_000,
        controller.signal,
      );
    } catch (cause) {
      if (!controller.signal.aborted) {
        this.errors[key] = requestErrors[action];
        this.details[key] = cause instanceof Error ? cause.message : "The worker did not complete the request.";
      }
    } finally {
      this.#controllers.delete(controller);
      delete this.pending[key];
    }
  }

  enable(workerId: string, tool: AgentTool, enabled: boolean) {
    return this.#request(toolKey(workerId, tool), "enable", ui.SetAgentToolEnabledRequestSchema, {
      workerId,
      tool,
      enabled,
    });
  }

  install(workerId: string, tool: AgentTool) {
    return this.#request(toolKey(workerId, tool), "install", ui.InstallAgentToolRequestSchema, {
      workerId,
      tool,
      installRuntime: tool === AgentTool.BROWSER,
    });
  }

  async refresh(workers: ToolWorker[]) {
    if (this.disposed || this.pending["refresh"]) return;
    this.pending["refresh"] = "refresh";
    delete this.notes["refresh"];
    delete this.details["refresh"];
    const eligible = workers.filter(({ worker, readOnly }) => worker.online && !readOnly);
    const skipped: string[] = [];

    try {
      for (let i = 0; i < eligible.length; i += 4) {
        if (this.disposed) return;
        await Promise.all(
          eligible.slice(i, i + 4).map(async ({ worker }) => {
            const key = `refresh/${worker.id}`;

            const response = await this.#request(key, "refresh", ui.RefreshAgentToolsRequestSchema, {
              workerId: worker.id,
            });

            if (response) skipped.push(...decode(ui.RefreshAgentToolsResponseSchema, response).skipped);
            else if (this.errors[key]) skipped.push(`${worker.name}: ${this.details[key]}`);
            delete this.errors[key];
            delete this.details[key];
          }),
        );
      }

      if (this.disposed) return;
      this.notes["refresh"] =
        skipped.length || eligible.length < workers.length
          ? "Some workers could not be checked. Connect them, then check again."
          : "Tool check complete.";

      if (skipped.length) this.details["refresh"] = skipped.join("\n");
    } finally {
      delete this.pending["refresh"];
    }
  }
}
