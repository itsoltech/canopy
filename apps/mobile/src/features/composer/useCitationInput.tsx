import { useEffect, useRef, useState, type ComponentRef } from "react";
import type { ui } from "@canopy/contracts";
import { TextInput } from "../../ui/TextInput";
import type { ComposerBadges } from "../threads/ComposerBox";
import { QuoteEditor } from "../quotes/QuoteEditor";

/** JS-only caret placement and citation editing for the existing native text badge editor. */
export function useCitationInput(badges: ComposerBadges | undefined) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [editing, setEditing] = useState<{ index: number; quote: ui.Quote }>();
  useEffect(() => {
    const focus = badges?.focusAt;

    if (!focus) return;
    focus.current = (caret) => {
      input.current?.focus();
      requestAnimationFrame(() => input.current?.setNativeProps({ selection: { start: caret, end: caret } }));
    };

    return () => {
      focus.current = undefined;
    };
  }, [badges?.focusAt]);

  return {
    input,
    edit: (quote: ui.Quote) => setEditing({ quote, index: badges?.quotes?.indexOf(quote) ?? -1 }),
    editor: editing && (
      <QuoteEditor
        quote={editing.quote}
        editing
        onSave={(quote) => badges?.editQuote?.(editing.index, quote)}
        onRemove={() => badges?.removeQuote?.(editing.index)}
        onClose={() => setEditing(undefined)}
      />
    ),
  };
}
