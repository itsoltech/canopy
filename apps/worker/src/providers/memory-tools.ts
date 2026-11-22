import { MEMORY_TOOLS } from "@canopy/domain/memory-tools";

/** Thread memory uses the refreshable platform MCP catalog, including on provider resume and fork. */
export function threadMemoryTools(enabled?: boolean) {
  return enabled
    ? MEMORY_TOOLS.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters }))
    : [];
}
