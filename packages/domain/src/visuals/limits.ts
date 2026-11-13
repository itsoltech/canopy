/** Visuals v1 limits (docs/agent-visuals.md §3–§5). Lower owner limits may apply on top; none of these truncate. */
export const VISUAL_LIMITS = {
  /** UTF-8 bytes of the serialized spec, checked before it is parsed. */
  specBytes: 128 * 1024,
  nodes: 300,
  depth: 12,
  /** UTF-8 bytes of all text in the spec. */
  textBytes: 32 * 1024,
  stateKeys: 32,
  actionsPerButton: 8,
  tableRows: 100,
  tableColumns: 12,
  diagramNodes: 40,
  diagramEdges: 80,
  chartPoints: 200,
  chartSeries: 6,
  titleChars: 100,
  descriptionChars: 1000,
  minHeight: 160,
  maxHeight: 720,
  defaultHeight: 360,
  perTurn: 10,
  turnSpecBytes: 1024 * 1024,
  htmlBytes: 2 * 1024 * 1024,
  /** Host ↔ visual channel. */
  messageBytes: 8 * 1024,
  messagesPerSecond: 10,
  heightsPerSecond: 4,
  stateBytes: 4 * 1024,
} as const;

export const VISUAL_SCHEMA_VERSION = 1;

/** The kit compiled into every visual; a stored visual keeps the version it was published with. */
export const VISUAL_KIT_VERSION = 1;

/** Kit versions a client must refuse to run (a security fix replaces them); the spec stays readable. */
export const REVOKED_VISUAL_KITS: ReadonlySet<number> = new Set();

/** Host ↔ visual message protocol. */
export const VISUAL_PROTOCOL_VERSION = 1;
