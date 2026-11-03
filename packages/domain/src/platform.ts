/** The platform's MCP server / tool namespace in the harnesses: `mcp__canopy__ask_user`, Grok `canopy__list_threads`. */
export const PLATFORM_SERVER = "canopy";
/** Its name before the rename to Canopy; threads from then keep it (Codex dynamic tools, stored transcripts). */
export const LEGACY_PLATFORM_SERVER = "openagents";

export const isPlatformServer = (name: string | null | undefined): boolean =>
  name === PLATFORM_SERVER || name === LEGACY_PLATFORM_SERVER;

/** Marker of the platform's notes for the agent in front of a user message. */
export const PLATFORM_NOTE = "[canopy]";
/** The marker before the rename, in stored turns. */
export const LEGACY_PLATFORM_NOTE = "[open-agents]";

export const hasPlatformNote = (text: string): boolean => text.startsWith(PLATFORM_NOTE) || text.startsWith(LEGACY_PLATFORM_NOTE);
