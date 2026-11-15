import { statSync } from "node:fs";
import type { AgentTool } from "@canopy/contracts";
import { discoverAgentTool, type AgentToolProbe, type DiscoveredAgentTool } from "./probe.ts";
import type { AgentToolScope } from "./scope.ts";
import type { AgentToolSpec } from "./specs.ts";

interface CachedDiscovery {
  readonly found: DiscoveredAgentTool;
  readonly identity: string;
  readonly until: number;
}

const identity = (path: string): string => {
  try {
    const file = statSync(path);

    return `${file.ino}/${file.mtimeMs}/${file.size}`;
  } catch {
    return "";
  }
};

/** Polling reuses a recent runtime check, but replacing/removing the executable forces discovery. */
export class AgentToolDiscoveryCache {
  readonly #entries = new Map<string, CachedDiscovery>();
  readonly #pending = new Map<string, Promise<DiscoveredAgentTool>>();

  discover(
    spec: AgentToolSpec,
    probe: AgentToolProbe,
    scope: AgentToolScope = {},
    force = false,
  ): Promise<DiscoveredAgentTool> {
    const key = JSON.stringify([spec.tool, scope.session ?? "", scope.platform ?? "", scope.deviceId ?? ""]);
    const cached = this.#entries.get(key);

    if (!force && cached && cached.until > Date.now() && cached.identity === identity(cached.found.path))
      return Promise.resolve(cached.found);
    const pending = this.#pending.get(key);

    if (pending) return pending;

    const task = discoverAgentTool(spec, probe, scope).then((found) => {
      if (this.#entries.size >= 128) this.#entries.clear();
      this.#entries.set(key, {
        found,
        identity: identity(found.path),
        until: Date.now() + (found.ready ? 30_000 : 5_000),
      });

      return found;
    });

    this.#pending.set(key, task);

    const clear = () => {
      this.#pending.delete(key);
    };

    void task.then(clear, clear);

    return task;
  }

  invalidate(tool: AgentTool): void {
    for (const [key, value] of this.#entries) if (value.found.spec.tool === tool) this.#entries.delete(key);
  }
}
