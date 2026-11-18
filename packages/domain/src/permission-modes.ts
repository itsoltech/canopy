/** Permission modes in ascending order of access, shared by thread inheritance and composer drafts. */
export const SPAWN_PERMISSION_MODES = ["read_only", "ask", "accept_edits", "full_auto", "full_access"] as const;

export type SpawnPermissionMode = (typeof SPAWN_PERMISSION_MODES)[number];
