<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";
  import { controlClasses, useField } from "./field.ts";
  import { clampNumber, numberBound, parseNumber, stepNumber } from "./number.ts";
  import StepperButtons from "./StepperButtons.svelte";

  /** Internal renderer for Input type=number. Text editing stays native; steppers are ours. */
  type Props = Omit<HTMLInputAttributes, "class" | "type"> & { class?: ClassValue };

  let {
    value = $bindable(),
    min,
    max,
    step = 1,
    class: className,
    id: explicitId,
    disabled,
    readonly,
    oninput,
    onchange,
    onblur,
    onkeydown,
    ...rest
  }: Props = $props();

  const field = useField();
  const uid = $props.id();
  const id = $derived(explicitId ?? field?.id ?? uid);
  const lower = $derived(numberBound(min));
  const upper = $derived(numberBound(max));
  let input = $state<HTMLInputElement>();
  let raw = $state("");
  const parsed = $derived(parseNumber(raw));
  const invalid = $derived(Boolean(raw.trim()) && parsed === undefined);
  const label = $derived(rest["aria-label"] ?? input?.labels?.[0]?.textContent?.trim() ?? rest.name ?? "value");

  $effect(() => {
    const text = value == null ? "" : String(value);

    if (untrack(() => input === document.activeElement) && (value == null || Number.isNaN(value))) return;

    if (untrack(() => parseNumber(raw)) !== numberBound(text) || text === "") raw = text;
  });

  $effect(() => {
    input?.setCustomValidity(invalid ? "Enter a number." : "");
  });

  function commit() {
    if (parsed === undefined) {
      if (!raw.trim()) value = null;

      return;
    }

    value = clampNumber(parsed, lower, upper);
    raw = String(value);
  }

  function move(direction: number) {
    if (disabled || readonly || input?.matches(":disabled")) return;
    value = stepNumber(parsed, direction, numberBound(step), lower, upper);
    raw = String(value);

    if (input) input.value = raw;
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  }

  $effect(() => {
    const initial = untrack(() => value);
    const owner = input?.form;

    const reset = () => {
      value = initial;
      raw = initial == null ? "" : String(initial);
    };

    owner?.addEventListener("reset", reset);

    return () => owner?.removeEventListener("reset", reset);
  });
</script>

<div class={["flex min-w-0 items-center gap-2", className]}>
  <input
    {...rest}
    bind:this={input}
    {id}
    type="text"
    role="spinbutton"
    inputmode={rest.inputmode ?? "decimal"}
    {disabled}
    {readonly}
    aria-valuemin={lower}
    aria-valuemax={upper}
    aria-valuenow={parsed}
    aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
    aria-invalid={invalid || rest["aria-invalid"] || field?.invalid || undefined}
    class={[controlClasses, "min-w-0 flex-1 tabular-nums pointer-coarse:min-h-12"]}
    bind:value={raw}
    oninput={(event) => {
      const next = parseNumber(event.currentTarget.value);
      value = next ?? (event.currentTarget.value.trim() ? NaN : null);
      oninput?.(event);
    }}
    onchange={(event) => {
      commit();
      onchange?.(event);
    }}
    onblur={(event) => {
      commit();
      onblur?.(event);
    }}
    onkeydown={(event) => {
      onkeydown?.(event);
      if (event.defaultPrevented || readonly || event.isComposing) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        move(event.key === "ArrowUp" ? 1 : -1);
      } else if (event.key === "Enter") commit();
    }}
  />
  <StepperButtons
    {label}
    decrease={() => move(-1)}
    increase={() => move(1)}
    decreaseDisabled={Boolean(disabled || readonly || (lower !== undefined && parsed !== undefined && parsed <= lower))}
    increaseDisabled={Boolean(disabled || readonly || (upper !== undefined && parsed !== undefined && parsed >= upper))}
  />
</div>
