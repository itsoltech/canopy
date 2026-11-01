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
  "block w-full rounded-lg bg-white px-3 py-2 text-base/6 text-zinc-950 outline-1 -outline-offset-1 outline-zinc-950/15 placeholder:text-zinc-400 focus:outline-2 focus:-outline-offset-1 focus:outline-sky-500 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 aria-invalid:outline-rose-500 sm:py-1.5 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-zinc-500 dark:disabled:bg-white/2.5 dark:disabled:text-zinc-400";
