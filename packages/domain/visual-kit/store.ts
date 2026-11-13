import type { VisualAction, VisualState, VisualStateDomain, VisualStateValue } from "../src/visuals/types.ts";

type Listener = () => void;

/** Local component state of one visual. Only values inside the validated domains are ever stored. */
export class Store {
  private values: Map<string, VisualStateValue>;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly all = new Set<Listener>();

  constructor(
    private readonly initial: VisualState,
    private readonly domains: ReadonlyMap<string, VisualStateDomain>,
    restored: VisualState,
  ) {
    this.values = new Map(Object.entries({ ...initial, ...restored }));
  }

  get(key: string): VisualStateValue | undefined {
    return this.values.get(key);
  }

  domain(key: string): VisualStateDomain | undefined {
    return this.domains.get(key);
  }

  snapshot(): VisualState {
    return Object.fromEntries(this.values);
  }

  /** Runs `listener` now and whenever one of `keys` changes. */
  watch(keys: readonly string[], listener: Listener): void {
    for (const key of keys) {
      const set = this.listeners.get(key) ?? new Set();
      set.add(listener);
      this.listeners.set(key, set);
    }

    listener();
  }

  onChange(listener: Listener): void {
    this.all.add(listener);
  }

  set(key: string, value: VisualStateValue): void {
    this.commit(new Map([[key, value]]));
  }

  /** Applies a button's actions as one change; actions never trigger further actions. */
  apply(actions: readonly VisualAction[]): void {
    const next = new Map<string, VisualStateValue>();

    for (const action of actions) {
      if (action.action === "reset") {
        for (const [key, value] of Object.entries(this.initial)) next.set(key, value);
        continue;
      }

      const current = next.get(action.state_key) ?? this.values.get(action.state_key);

      if (current === undefined) continue;
      const value = action.action === "set" ? action.value : this.step(action.state_key, current, action.action);

      if (value !== undefined) next.set(action.state_key, value);
    }

    this.commit(next);
  }

  reset(): void {
    this.commit(new Map(Object.entries(this.initial)));
  }

  private step(key: string, current: VisualStateValue, action: "next" | "previous" | "toggle") {
    const domain = this.domains.get(key);

    if (!domain) return undefined;

    switch (domain.kind) {
      case "boolean":
        return action === "toggle" ? !current : undefined;
      case "number": {
        const value = Number(current) + (action === "next" ? 1 : -1);

        return Math.min(domain.max, Math.max(domain.min, value));
      }

      case "enum": {
        const index = domain.values.indexOf(String(current));
        const size = domain.values.length;

        return domain.values[(index + (action === "next" ? 1 : size - 1)) % size];
      }
    }
  }

  private commit(next: ReadonlyMap<string, VisualStateValue>): void {
    const changed = new Set<Listener>();

    for (const [key, value] of next) {
      if (!this.allowed(key, value) || this.values.get(key) === value) continue;
      this.values.set(key, value);

      for (const listener of this.listeners.get(key) ?? []) changed.add(listener);
    }

    if (!changed.size) return;

    for (const listener of changed) listener();

    for (const listener of this.all) listener();
  }

  private allowed(key: string, value: VisualStateValue): boolean {
    const domain = this.domains.get(key);

    switch (domain?.kind) {
      case "boolean":
        return value === true || value === false;
      case "number":
        return Number.isInteger(value) && Number(value) >= domain.min && Number(value) <= domain.max;
      case "enum":
        return domain.values.includes(String(value)) && value === String(value);
      default:
        return false;
    }
  }
}
