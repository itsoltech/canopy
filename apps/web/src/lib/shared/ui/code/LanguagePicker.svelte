<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import PickerRow from "../PickerRow.svelte";
  import PillButton from "../PillButton.svelte";
  import SearchPicker from "../SearchPicker.svelte";
  import { fenceTag, LANGUAGE_NAMES, LANGUAGES, languageOf, type LanguageId } from "./languages.ts";

  /**
   * The language of a code block as a pill ("Plain text ▾"): a searchable list of the languages we highlight, by name
   * or any tag that names them (`py`, `golang`, `yml`). `value` is the fence's word as typed (one we do not know shows
   * as it is); choosing writes the language's short tag (`fenceTag`), "Plain text" writes none.
   */
  let { value, onselect, class: className }: { value: string; onselect: (tag: string) => void; class?: ClassValue } = $props();

  type Item = { readonly id: LanguageId | ""; readonly name: string; readonly words: readonly string[] };
  const items: readonly Item[] = [{ id: "", name: "Plain text", words: ["text", "plain", "txt"] }, ...LANGUAGES];
  const language = $derived(languageOf(value));
  const label = $derived(language ? LANGUAGE_NAMES[language] : value || "Plain text");
</script>

<SearchPicker
  label="Code language"
  searchLabel="Search languages"
  placeholder="Search languages…"
  {items}
  key={(item) => item.id}
  text={(item) => `${item.name} ${item.words.join(" ")}`}
  value={language ?? (value ? undefined : "")}
  onselect={(item) => onselect(item.id ? fenceTag(item.id) : "")}
  class="w-[min(16rem,calc(100vw-1rem))]"
>
  {#snippet trigger(props)}
    <PillButton {...props} class={className} aria-label="Code language: {label}">
      <span class="truncate">{label}</span>
    </PillButton>
  {/snippet}
  {#snippet option(item, state)}
    <PickerRow title={item.name} detail={item.id ? fenceTag(item.id) : undefined} detailClass="font-mono" selected={state.selected} />
  {/snippet}
  {#snippet empty(query)}No languages match “{query}”.{/snippet}
</SearchPicker>
