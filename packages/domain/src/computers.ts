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

/** Stage 7: opt-in forwarding through exactly one trusted intermediary. */
export const RELAY = "relay";

/**
 * Messages may place their attachments in the text (MentionKind.ATTACHMENT). A home without it gets the same message
 * with the badges left as plain text. Not offered through a relay: older intermediaries refuse unknown features.
 */
export const INLINE_ATTACHMENTS = "inline_attachments";

/** Stage 8: two-phase moves of threads and bots between directly linked computers, and redirects. */
export const MOVE_ITEMS = "move_items";
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

/** Per-field configuration across direct links whose two ends share configuration. */
export const CONFIG_SYNC = "config_sync";
