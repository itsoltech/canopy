/**
 * Looks shared by listboxes whose options are driven from a text field (Combobox, the composer's mention popup):
 * a sticky group heading and an option row that highlights the active option (`data-active`).
 */
export const listboxHeadingClasses =
  "sticky top-0 z-10 bg-white pt-2 pb-1 text-sm/5 font-medium text-zinc-500 sm:text-xs/4 dark:bg-zinc-900 dark:text-zinc-400";

export const listboxOptionClasses =
  "cursor-default scroll-mt-9 rounded-lg px-2.5 py-2 text-base/6 text-zinc-800 select-none data-active:bg-zinc-950/5 data-active:text-zinc-950 sm:py-1.5 sm:text-sm/5 dark:text-zinc-200 dark:data-active:bg-white/8 dark:data-active:text-white";

/** Select data and navigation stay independent of the DOM. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly icon?: import("./icons.ts").IconName | undefined;
  readonly group?: string | undefined;
  readonly separator?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

export function selectedIndex(options: readonly SelectOption[], value: unknown): number {
  const index = options.findIndex((option) => option.value === value && !option.disabled);

  return index >= 0 ? index : options.findIndex((option) => !option.disabled);
}

export function moveOption(options: readonly SelectOption[], current: number, direction: number): number {
  for (let distance = 1; distance <= options.length; distance++) {
    const next = (current + direction * distance + options.length * 2) % options.length;

    if (!options[next]?.disabled) return next;
  }

  return -1;
}

export function selectTypeahead() {
  let buffer = "";
  let last = 0;

  return (options: readonly SelectOption[], current: number, character: string, now = Date.now()) => {
    buffer = now - last > 700 ? character : buffer + character;
    last = now;
    const text = buffer.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
    const repeated = [...text].every((letter) => letter === text[0]);
    const query = repeated ? text[0]! : text;

    for (let distance = repeated ? 1 : 0; distance < options.length + (repeated ? 1 : 0); distance++) {
      const index = (Math.max(current, 0) + distance) % options.length;
      const option = options[index]!;

      if (
        !option.disabled &&
        option.label.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().startsWith(query)
      )
        return index;
    }

    return current;
  };
}
