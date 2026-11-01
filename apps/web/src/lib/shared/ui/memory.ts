import { getContext, setContext } from "svelte";

/**
 * UI state a virtual list would lose when it unmounts a row (an expanded disclosure): kept per list,
 * in nested scopes (row → item → nested item), so a row scrolled back into view looks the same.
 */
export class UiMemory {
  readonly #values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.#values.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.#values.set(key, value);
  }
}

interface Scope {
  readonly memory: UiMemory;
  readonly path: string;
}

const KEY = Symbol("ui-memory");

/** Starts a memory (`memory` given) or narrows the surrounding one to `name`. */
export function provideMemoryScope(name: string, memory?: UiMemory): void {
  const parent = getContext<Scope | undefined>(KEY);
  const root = memory ?? parent?.memory;
  if (!root) return;
  setContext(KEY, { memory: root, path: memory || !parent ? name : `${parent.path}/${name}` } satisfies Scope);
}

/** A value remembered in the surrounding scope under `name`; undefined outside any memory. */
export function useRemembered<T>(name: string): { get(): T | undefined; set(value: T): void } | undefined {
  const scope = getContext<Scope | undefined>(KEY);
  if (!scope) return undefined;
  const key = `${scope.path}#${name}`;
  return { get: () => scope.memory.get<T>(key), set: (value) => scope.memory.set(key, value) };
}
