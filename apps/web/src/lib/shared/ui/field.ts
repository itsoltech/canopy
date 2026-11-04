import { getContext, setContext } from "svelte";

/** A `Field` hands its control the id and the ids of its description and error (for aria-describedby). */
export interface FieldContext {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

const KEY = Symbol("field");
export const provideField = (field: FieldContext) => setContext(KEY, field);
export const useField = (): FieldContext | undefined => getContext<FieldContext | undefined>(KEY);

/** Text controls (input, select, textarea) share one look; `focus` uses an inset outline. */
export const controlClasses =
  "w-full rounded-lg bg-surface px-3 py-2 text-base/6 text-ink outline-1 -outline-offset-1 outline-divider placeholder:text-muted focus:outline-2 focus:-outline-offset-1 focus:outline-accent disabled:cursor-not-allowed disabled:bg-panel disabled:text-muted aria-invalid:outline-rose-500 sm:py-1.5 sm:text-sm/6";

/** A text control without a box (search field inside a picker): text, placeholder, no outline of its own. */
export const bareControlClasses =
  "block w-full bg-transparent py-2.5 text-base/6 text-zinc-950 placeholder:text-zinc-400 focus:outline-none sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-500";
