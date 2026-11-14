import { isJsonArray, isJsonObject, isNumber, isString, type JsonValue } from "../json.ts";
import { VISUAL_LIMITS } from "./limits.ts";
import type {
  ButtonSize,
  ButtonVariant,
  VisualAction,
  VisualNode,
  VisualSpec,
  VisualState,
  VisualStateDomain,
  VisualStateValue,
} from "./types.ts";
import { walkVisual } from "./walk.ts";

const BUTTON_VARIANTS: readonly ButtonVariant[] = ["primary", "secondary", "outline", "ghost", "danger"];
const KIND_NAMES = { enum: "options", boolean: "true/false", number: "a step number" } as const;
const BUTTON_SIZES: readonly ButtonSize[] = ["sm", "md", "lg"];

/** Keys whose values are tokens or references, not text shown to the user. */
const TOKEN_KEYS = new Set(["type", "action", "tone", "variant", "size", "gap", "align", "direction", "device"]);
const TOKEN_KEY_SUFFIXES = ["state_key", "_from", "shape", "kind"];

interface Usage {
  /** Ordered option values of controls bound to an enum key. */
  choices: string[];
  /** Largest stepper length bound to a number key. */
  steps: number;
  /** Diagram extent expands free numeric state without narrowing stored v1 values. */
  diagramSteps: number;
  booleanControl: boolean;
  /** Values the spec compares or assigns, with where they appear. */
  values: { value: VisualStateValue; path: string }[];
  /** Kinds a reference requires: enum of variants, of sizes, boolean, number. */
  requires: { kind: "variant" | "size" | "boolean" | "number" | "node_ids"; path: string; ids?: readonly string[] }[];
  steppedBy: { action: VisualAction["action"]; path: string }[];
  bindings: { kind: "enum" | "boolean" | "number"; path: string }[];
}

function collectUsage(spec: VisualSpec): { usage: Map<string, Usage>; problem?: string } {
  const usage = new Map<string, Usage>();
  let problem: string | undefined;
  let count = 0;

  const use = (key: string) => {
    let entry = usage.get(key);

    if (!entry) {
      entry = {
        choices: [],
        steps: 0,
        diagramSteps: 0,
        booleanControl: false,
        values: [],
        requires: [],
        steppedBy: [],
        bindings: [],
      };
      usage.set(key, entry);
    }

    return entry;
  };

  walkVisual(spec.root, ({ node, path, depth }) => {
    count += 1;

    if (count > VISUAL_LIMITS.nodes) problem = `the spec has more than ${VISUAL_LIMITS.nodes} nodes`;
    else if (depth > VISUAL_LIMITS.depth) problem = `${path}: nesting is deeper than ${VISUAL_LIMITS.depth} levels`;
    else problem = nodeUsage(node, path, use);

    return problem === undefined;
  });

  return problem === undefined ? { usage } : { usage, problem };
}

function nodeUsage(node: VisualNode, path: string, use: (key: string) => Usage): string | undefined {
  const choose = (key: string, values: readonly string[]) => {
    if (new Set(values).size !== values.length) return `${path}: option values must be unique`;
    const entry = use(key);
    entry.bindings.push({ kind: "enum", path });

    for (const value of values) if (!entry.choices.includes(value)) entry.choices.push(value);

    return undefined;
  };

  switch (node.type) {
    case "segmented":
      return choose(
        node.state_key,
        node.options.map((option) => (isString(option) ? option : option.value)),
      );
    case "tabs":
      return choose(
        node.state_key,
        node.tabs.map((tab) => tab.value),
      );
    case "artboards":
      return choose(
        node.state_key,
        node.artboards.map((board) => board.value),
      );
    case "toggle":
      use(node.state_key).bindings.push({ kind: "boolean", path });
      use(node.state_key).booleanControl = true;

      return undefined;
    case "stepper": {
      const entry = use(node.state_key);
      entry.bindings.push({ kind: "number", path });
      entry.steps = Math.max(entry.steps, node.steps.length);

      return undefined;
    }

    case "when":
      for (const value of Array.isArray(node.equals) ? node.equals : [node.equals])
        use(node.state_key).values.push({ value, path: `${path}.equals` });

      return undefined;
    case "button":
      for (const [index, action] of node.actions.entries()) {
        if (action.action === "reset") continue;
        const entry = use(action.state_key);
        const at = `${path}.actions[${index}]`;

        if (action.action === "set") entry.values.push({ value: action.value, path: at });
        else entry.steppedBy.push({ action: action.action, path: at });
      }

      return undefined;
    case "button_preview":
      for (const [key, kind] of [
        [node.variant_from, "variant"],
        [node.size_from, "size"],
        [node.disabled_from, "boolean"],
        [node.loading_from, "boolean"],
      ] as const)
        if (key) use(key).requires.push({ kind, path });

      return undefined;
    case "flow":
      return flowProblem(node, path, use);
    case "sequence":
      for (const [index, message] of node.messages.entries())
        if (
          !node.participants.some((p) => p.id === message.from) ||
          !node.participants.some((p) => p.id === message.to)
        )
          return `${path}.messages[${index}]: from and to must name participants`;

      if (new Set(node.participants.map((p) => p.id)).size !== node.participants.length)
        return `${path}: participant ids must be unique`;

      if (node.step_from) {
        const entry = use(node.step_from);
        entry.requires.push({ kind: "number", path });
        entry.diagramSteps = Math.max(entry.diagramSteps, node.messages.length);
      }

      return undefined;
    case "chart":
      return chartProblem(node, path);
    case "table":
      return node.rows.some((row) => row.length > node.columns.length)
        ? `${path}: a row has more cells than columns`
        : undefined;
    default:
      return undefined;
  }
}

function flowProblem(
  node: Extract<VisualNode, { type: "flow" }>,
  path: string,
  use: (key: string) => Usage,
): string | undefined {
  const ids = node.nodes.map((n) => n.id);

  if (new Set(ids).size !== ids.length) return `${path}: node ids must be unique`;

  for (const [index, edge] of node.edges.entries())
    if (!ids.includes(edge.from) || !ids.includes(edge.to))
      return `${path}.edges[${index}]: from and to must name nodes`;

  if (node.highlight_from) use(node.highlight_from).requires.push({ kind: "node_ids", path, ids });

  return undefined;
}

function chartProblem(node: Extract<VisualNode, { type: "chart" }>, path: string): string | undefined {
  if (node.series.some((series) => series.values.length !== node.categories.length))
    return `${path}: every series needs one value per category`;

  if (node.series.length * node.categories.length > VISUAL_LIMITS.chartPoints)
    return `${path}: a chart has at most ${VISUAL_LIMITS.chartPoints} points`;

  return undefined;
}

export interface ResolvedVisualState {
  readonly domains: Map<string, VisualStateDomain>;
  readonly problem?: string;
}

/** Allowed values per declared state key, or the first reference that doesn't line up. */
export function resolveVisualState(spec: VisualSpec): ResolvedVisualState {
  const domains = new Map<string, VisualStateDomain>();
  const { usage, problem } = collectUsage(spec);

  if (problem) return { domains, problem };
  const state = spec.state ?? {};

  if (Object.keys(state).length > VISUAL_LIMITS.stateKeys)
    return { domains, problem: `state has more than ${VISUAL_LIMITS.stateKeys} keys` };

  for (const key of usage.keys())
    if (!Object.hasOwn(state, key)) return { domains, problem: `state key "${key}" is used but not declared in state` };

  for (const [key, initial] of Object.entries(state)) {
    const entry = usage.get(key);
    const resolved = entry ? keyDomain(key, initial, entry) : { domain: unusedDomain(initial) };

    if ("problem" in resolved) return { domains, problem: resolved.problem };
    domains.set(key, resolved.domain);
  }

  return { domains };
}

const isBoolean = (value: VisualStateValue): value is boolean => typeof value === "boolean";

function valueKind(value: VisualStateValue): VisualStateDomain["kind"] {
  if (isBoolean(value)) return "boolean";

  return isNumber(value) ? "number" : "enum";
}

function unusedDomain(initial: VisualStateValue): VisualStateDomain {
  if (isBoolean(initial)) return { kind: "boolean" };

  return isNumber(initial) ? { kind: "number", min: initial, max: initial } : { kind: "enum", values: [initial] };
}

function keyDomain(
  key: string,
  initial: VisualStateValue,
  usage: Usage,
): { domain: VisualStateDomain } | { problem: string } {
  const kind = valueKind(initial);
  const mismatch = usage.bindings.find((binding) => binding.kind !== kind);

  if (mismatch)
    return { problem: `${mismatch.path}: state "${key}" holds ${KIND_NAMES[kind]}, not ${KIND_NAMES[mismatch.kind]}` };
  let domain: VisualStateDomain;

  if (kind === "boolean") domain = { kind: "boolean" };
  else if (kind === "number") {
    const numbers = [initial, ...usage.values.map((v) => v.value)].filter(isNumber);
    domain = usage.steps
      ? { kind: "number", min: 0, max: usage.steps - 1 }
      : {
          kind: "number",
          min: Math.min(...numbers, usage.diagramSteps ? 0 : Number.POSITIVE_INFINITY),
          max: Math.max(...numbers, usage.diagramSteps - 1),
        };
  } else {
    const extra = [initial, ...usage.values.map((v) => v.value)].filter(isString);
    domain = { kind: "enum", values: usage.choices.length ? usage.choices : [...new Set(extra)] };
  }

  for (const { value, path } of [{ value: initial, path: `state.${key}` }, ...usage.values])
    if (!stateValueAllowed(domain, value))
      return { problem: `${path}: ${JSON.stringify(value)} is not a value of "${key}"` };

  for (const stepped of usage.steppedBy) {
    if ((stepped.action === "toggle") !== (kind === "boolean"))
      return { problem: `${stepped.path}: use toggle for true/false state and next/previous for options or steps` };
  }

  return requirementsProblem(key, domain, usage) ?? { domain };
}

function requirementMet(domain: VisualStateDomain, requirement: Usage["requires"][number]): boolean {
  switch (requirement.kind) {
    case "boolean":
    case "number":
      return domain.kind === requirement.kind;
    case "node_ids":
      // A step number highlights the node at that index; option values must name nodes.
      return (
        domain.kind === "number" || (domain.kind === "enum" && domain.values.every((v) => requirement.ids?.includes(v)))
      );
    case "variant":
      return domain.kind === "enum" && domain.values.every((v) => BUTTON_VARIANTS.some((variant) => variant === v));
    case "size":
      return domain.kind === "enum" && domain.values.every((v) => BUTTON_SIZES.some((size) => size === v));
  }
}

function requirementsProblem(key: string, domain: VisualStateDomain, usage: Usage): { problem: string } | undefined {
  const unmet = usage.requires.find((requirement) => !requirementMet(domain, requirement));

  return unmet ? { problem: `${unmet.path}: state "${key}" has values this component can't use` } : undefined;
}

export function stateValueAllowed(domain: VisualStateDomain, value: VisualStateValue): boolean {
  switch (domain.kind) {
    case "boolean":
      return isBoolean(value);
    case "number":
      return isNumber(value) && Number.isInteger(value) && value >= domain.min && value <= domain.max;
    case "enum":
      return isString(value) && domain.values.includes(value);
  }
}

/** Accepts a cached or reported local state only when every value fits the spec; otherwise the caller resets. */
export function validVisualState(domains: ReadonlyMap<string, VisualStateDomain>, state: VisualState): boolean {
  const entries = Object.entries(state);

  return (
    entries.length <= VISUAL_LIMITS.stateKeys &&
    entries.every(([key, value]) => {
      const domain = domains.get(key);

      return domain !== undefined && stateValueAllowed(domain, value);
    })
  );
}

/** UTF-8 bytes of user-visible text in a spec's JSON (tokens and references don't count). */
export function visualTextBytes(raw: JsonValue): number {
  const encoder = new TextEncoder();
  const stack: [string, JsonValue][] = [["root", raw]];
  let bytes = 0;

  while (stack.length) {
    const [key, value] = stack.pop()!;

    if (isString(value)) {
      if (!TOKEN_KEYS.has(key) && !TOKEN_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix)))
        bytes += encoder.encode(value).length;
    } else if (isJsonArray(value)) for (const child of value) stack.push([key, child]);
    else if (isJsonObject(value)) for (const [childKey, child] of Object.entries(value)) stack.push([childKey, child]);
  }

  return bytes;
}
