import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, Provider, type Mention } from "@canopy/contracts";

/**
 * Mentions in a message (docs/ui-api.md, "Wzmianki"; docs/protocol.md, "Wzmianki"): commands, skills, plugins, files
 * and other threads the user picked in the composer. Each one covers its placeholder in the text ([start, end),
 * UTF-16), so the message still reads as plain text: "/review", "$transitions-dev", "@docs/notes.md", "#Thread title".
 *
 * Delivery per provider (composeMessage):
 * - Claude: a command runs only at the very start of the input, so a command mention moves there ("/name rest");
 *   a skill at the start becomes "/name" (Claude Code loads it like a command); other skills, files and threads get
 *   a platform note (Skill tool, absolute paths, read_thread / get_thread).
 * - Codex: the text stays as written; the worker adds text_elements and native items (skill, mention, localImage)
 *   from the mentions; threads get the platform note.
 */

/** The character that starts each kind's placeholder (and opens its popup in the composer). */
export const MENTION_TRIGGERS = { command: "/", skill: "$", plugin: "$", file: "@", thread: "#", bot: "@", connector: "@" } as const;

export const MAX_MENTIONS = 50;

export type MentionKindName = "command" | "skill" | "plugin" | "file" | "thread" | "bot" | "connector";

export function mentionKindName(kind: MentionKind): MentionKindName | undefined {
  switch (kind) {
    case MentionKind.COMMAND:
      return "command";
    case MentionKind.SKILL:
      return "skill";
    case MentionKind.PLUGIN:
      return "plugin";
    case MentionKind.FILE:
      return "file";
    case MentionKind.THREAD:
      return "thread";
    case MentionKind.BOT:
      return "bot";
    case MentionKind.CONNECTOR:
      return "connector";
    default:
      return undefined;
  }
}

/** The text a mention occupies in the message. */
export function mentionPlaceholder(mention: Pick<Mention, "kind" | "name" | "label">): string {
  const kind = mentionKindName(mention.kind);
  if (!kind) return "";
  return `${MENTION_TRIGGERS[kind]}${kind === "thread" || kind === "bot" || kind === "connector" ? mention.label || mention.name : mention.name}`;
}

/** What a chip shows: the display name, a file's last path segment, a thread's title. */
export function mentionLabel(mention: Pick<Mention, "kind" | "name" | "label">): string {
  if (mention.label) return mention.label;
  if (mention.kind === MentionKind.FILE) return mention.name.split("/").filter(Boolean).pop() ?? mention.name;
  return mention.name;
}

export class MentionError extends Error {
  override readonly name = "MentionError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path relative to the thread's folder that cannot leave it ("/" separators, no "..", not absolute). */
export function isWorkspaceRelative(path: string): boolean {
  if (!path || path.length > 4096 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== "..");
}

/**
 * The mentions sorted by position, checked against the text: known kind, inside the text, not overlapping, each
 * starting with its kind's trigger, at most one command, file paths inside the workspace, thread ids as uuids.
 */
export function checkMentions(text: string, mentions: readonly Mention[]): Mention[] {
  if (mentions.length > MAX_MENTIONS) throw new MentionError(`a message can carry up to ${MAX_MENTIONS} mentions`);
  const sorted = [...mentions].sort((a, b) => a.start - b.start);
  let end = 0;
  let commands = 0;
  for (const m of sorted) {
    const kind = mentionKindName(m.kind);
    if (!kind) throw new MentionError("a mention has no kind");
    if (!m.name.trim()) throw new MentionError(`a ${kind} mention has no name`);
    if (m.end <= m.start || m.end > text.length) throw new MentionError(`the ${kind} mention "${m.name}" is outside the text`);
    if (m.start < end) throw new MentionError(`the ${kind} mention "${m.name}" overlaps another one`);
    if (!text.startsWith(MENTION_TRIGGERS[kind], m.start)) throw new MentionError(`the ${kind} mention "${m.name}" does not start with ${MENTION_TRIGGERS[kind]}`);
    if (kind === "command" && ++commands > 1) throw new MentionError("a message can run one command");
    if (kind === "file" && !isWorkspaceRelative(m.name)) throw new MentionError(`"${m.name}" is not a path inside the thread's folder`);
    if (kind === "thread" && !UUID.test(m.name)) throw new MentionError(`"${m.name}" is not a thread id`);
    if (kind === "bot" && !UUID.test(m.name)) throw new MentionError(`"${m.name}" is not a bot id`);
    if (kind === "connector" && !UUID.test(m.name)) throw new MentionError("invalid connector account id");
    end = m.end;
  }
  return sorted;
}

export interface ComposedInput {
  /** What the model gets: the note (if any), an empty line, the delivered message. */
  readonly text: string;
  /** Platform note lines (attachments, mentions); no empty line inside (the UI splits the full text at the first). */
  readonly note: string;
  /** The message as delivered (Claude: a command or a leading skill moved or turned into "/name"). */
  readonly message: string;
  /** The mentions with their ranges in `text`. */
  readonly mentions: Mention[];
}

/**
 * The input of a turn (or a steer) from the user's message and its checked mentions. `notes`: other platform notes
 * that go first (e.g. the attachments'). Platform commands (source "platform") are the gateway's and never get here.
 */
export function composeMessage(provider: Provider, message: string, mentions: readonly Mention[], notes: readonly string[] = []): ComposedInput {
  const sorted = [...mentions].sort((a, b) => a.start - b.start);
  const { text: delivered, mentions: placed, invoked } = provider === Provider.CLAUDE ? claudeMessage(message, sorted) : { text: message, mentions: sorted, invoked: undefined };
  const note = [...notes.filter(Boolean), ...mentionNotes(provider, placed, invoked)].join("\n");
  if (!note) return { text: delivered, note: "", message: delivered, mentions: placed };
  if (!delivered.trim()) return { text: note, note, message: delivered, mentions: [] };
  const offset = note.length + 2;
  return { text: `${note}\n\n${delivered}`, note, message: delivered, mentions: placed.map((m) => shifted(m, offset)) };
}

type Segment = string | { readonly mention: Mention; readonly text: string };

/**
 * Claude runs "/name" only at the very start: a command mention moves there (the text around it closes up), else a
 * skill at the start becomes "/name" (Claude Code loads the skill like a command). `invoked`: the mention run that way.
 */
function claudeMessage(message: string, mentions: Mention[]): { text: string; mentions: Mention[]; invoked: Mention | undefined } {
  const segments = segmentsOf(message, mentions);
  const command = mentions.find((m) => m.kind === MentionKind.COMMAND && m.source !== "platform");
  if (command) {
    const at = segments.findIndex((s) => typeof s !== "string" && s.mention === command);
    const left = segments.slice(0, at);
    const right = segments.slice(at + 1);
    // Whitespace at the seam closes up to one space.
    const lastLeft = left.at(-1);
    if (typeof lastLeft === "string") left[left.length - 1] = lastLeft.replace(/\s+$/, "");
    const firstRight = right[0];
    if (typeof firstRight === "string") right[0] = firstRight.replace(/^\s+/, "");
    const rest: Segment[] = [...left, ...(left.some(nonEmpty) && right.some(nonEmpty) ? [" "] : []), ...right];
    const firstRest = rest[0];
    if (typeof firstRest === "string") rest[0] = firstRest.replace(/^\s+/, "");
    const head: Segment = { mention: command, text: `/${command.name}` };
    return { ...rebuild([head, ...(rest.some(nonEmpty) ? [" ", ...rest] : [])]), invoked: command };
  }
  const first = mentions[0];
  if (first && first.kind === MentionKind.SKILL && !message.slice(0, first.start).trim()) {
    return { ...rebuild(segments.map((s) => (typeof s !== "string" && s.mention === first ? { mention: first, text: `/${first.name}` } : s))), invoked: first };
  }
  return { text: message, mentions, invoked: undefined };
}

function nonEmpty(segment: Segment): boolean {
  return typeof segment !== "string" || segment.length > 0;
}

function segmentsOf(message: string, sorted: readonly Mention[]): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const mention of sorted) {
    if (mention.start > at) segments.push(message.slice(at, mention.start));
    segments.push({ mention, text: message.slice(mention.start, mention.end) });
    at = mention.end;
  }
  if (at < message.length) segments.push(message.slice(at));
  return segments;
}

function rebuild(segments: readonly Segment[]): { text: string; mentions: Mention[] } {
  let text = "";
  const mentions: Mention[] = [];
  for (const segment of segments) {
    if (typeof segment === "string") {
      text += segment;
      continue;
    }
    mentions.push(create(MentionSchema, { ...segment.mention, start: text.length, end: text.length + segment.text.length }));
    text += segment.text;
  }
  return { text, mentions };
}

function shifted(m: Mention, by: number): Mention {
  return create(MentionSchema, { ...m, start: m.start + by, end: m.end + by });
}

/** Platform note lines for what the provider has no native input for. */
function mentionNotes(provider: Provider, mentions: readonly Mention[], invoked: Mention | undefined): string[] {
  const lines: string[] = [];
  const threads = mentions.filter((m) => m.kind === MentionKind.THREAD);
  if (threads.length > 0) {
    lines.push(
      `[canopy] The user mentioned ${threads.length === 1 ? "another thread" : `${threads.length} other threads`}; read ${threads.length === 1 ? "it" : "them"} with get_thread / read_thread when you need ${threads.length === 1 ? "it" : "them"}:`,
      ...unique(threads).map((m) => `- "${mentionLabel(m)}" (thread_id: ${m.name})`),
    );
  }
  if (provider !== Provider.CLAUDE) return lines;
  const named = mentions.filter((m) => m.kind === MentionKind.SKILL && !(invoked && m.start === invoked.start));
  if (named.length > 0) {
    lines.push(`[canopy] The user picked ${named.length === 1 ? "a skill" : "skills"} for this message; use ${named.length === 1 ? "it" : "each"} with the Skill tool: ${unique(named).map((m) => m.name).join(", ")}`);
  }
  const plugins = mentions.filter((m) => m.kind === MentionKind.PLUGIN);
  if (plugins.length > 0) lines.push(`[canopy] The user mentioned ${plugins.length === 1 ? "a plugin" : "plugins"}; prefer its tools and skills: ${unique(plugins).map((m) => m.name).join(", ")}`);
  const files = mentions.filter((m) => m.kind === MentionKind.FILE);
  if (files.length > 0) {
    lines.push(
      `[canopy] The user mentioned ${files.length === 1 ? "a path" : "paths"} in this thread's folder:`,
      ...unique(files).map((m) => `- ${m.path || m.name}${m.isDir ? " (directory)" : ""}`),
    );
  }
  return lines;
}

function unique(mentions: readonly Mention[]): Mention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => !seen.has(m.name) && Boolean(seen.add(m.name)));
}
