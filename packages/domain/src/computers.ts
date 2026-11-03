/**
 * Ids of things whose home is another linked computer (docs/linked-computers.md, stage 2).
 * The gateway that proxies them appends `~` and the first 16 hex characters of the home's node id,
 * so a browser can hold ids from several computers in one list without ambiguity. Routing happens in
 * the gateway: it strips the suffix and forwards the call to that computer over the pinned link.
 */
export const REMOTE_THREADS = "remote_threads";
export const THREAD_MIRROR = "thread_mirror";
export const REMOTE_BOTS = "remote_bots";
export const AGENT_BUS = "agent_bus";
/** Stage 6: the computer accepts `RouteAnnouncement` frames (its partner's current addresses). */
export const LAN_ROUTES = "lan_routes";
export const NODE_REF_LENGTH = 16;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const QUALIFIED = /^(.+)~([0-9a-f]{16})$/;
const ENTITY = new RegExp(`^${UUID}(?:~[0-9a-f]{16})?$`, "i");
const PLAIN = new RegExp(`^${UUID}$`, "i");

export const nodeRef = (nodeId: string): string => nodeId.slice(0, NODE_REF_LENGTH);

/** A local uuid gets the home's suffix; anything else (provider ids, already qualified ids) is kept. */
export const qualifyId = (id: string, nodeId: string): string => (PLAIN.test(id) ? `${id}~${nodeRef(nodeId)}` : id);

/** `{ id, node }` for a qualified id, `{ id }` for a local one. */
export function splitId(value: string): { id: string; node?: string } {
  const match = QUALIFIED.exec(value);
  return match ? { id: match[1]!, node: match[2]! } : { id: value };
}

/** A uuid of this computer or of a linked one (sidebar pins, queue order, fork points). */
export const isEntityId = (value: string): boolean => ENTITY.test(value);

/**
 * Stage 4: configuration shared between linked computers. Keys name the item on every computer:
 * a provider instance (its definition, not CLI paths or worker choices), an instance's model choices,
 * a user settings section, or a project (its identity and name, not its workspaces).
 */
export const SHARED_CONFIG = "shared_config";
export const SHARED_SETTINGS = ["appearance", "thread_defaults", "timezone", "text_generation"] as const;
export type SharedSettingsSection = (typeof SHARED_SETTINGS)[number];
export const sharedKey = {
  instance: (harness: string, id: string) => `instance:${harness}:${id}`,
  models: (harness: string, id: string) => `models:${harness}:${id}`,
  settings: (section: SharedSettingsSection) => `settings:${section}`,
  project: (id: string) => `project:${id}`,
};
export type SharedKey =
  | { kind: "instance" | "models"; harness: string; id: string }
  | { kind: "settings"; section: SharedSettingsSection }
  | { kind: "project"; id: string };
const SHARED_KEY = /^(instance|models):(claude|codex|grok):([a-z0-9][a-z0-9_-]{0,62})$|^settings:([a-z_]+)$|^project:([0-9a-f-]{36})$/;
/** The item a key names, or undefined for anything this version does not share. */
export function parseSharedKey(key: string): SharedKey | undefined {
  const m = SHARED_KEY.exec(key);
  if (!m) return undefined;
  if (m[1]) return { kind: m[1] as "instance" | "models", harness: m[2]!, id: m[3]! };
  if (m[4]) return (SHARED_SETTINGS as readonly string[]).includes(m[4]) ? { kind: "settings", section: m[4] as SharedSettingsSection } : undefined;
  return PLAIN.test(m[5]!) ? { kind: "project", id: m[5]!.toLowerCase() } : undefined;
}
