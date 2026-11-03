/** The platform's MCP server / tool namespace in the harnesses: `mcp__canopy__ask_user`, Grok `canopy__list_threads`. */
export const PLATFORM_SERVER = "canopy";

export const isPlatformServer = (name: string | null | undefined): boolean => name === PLATFORM_SERVER;

/** Marker of the platform's notes for the agent in front of a user message. */
export const PLATFORM_NOTE = "[canopy]";

export const hasPlatformNote = (text: string): boolean => text.startsWith(PLATFORM_NOTE);
