/** Reserved harness metadata, never part of an approved plugin bundle. */
export const isClaudeCacheMarker = (path: string): boolean => path === ".in_use" || path.startsWith(".in_use/");
