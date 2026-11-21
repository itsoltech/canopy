import { Provider } from "@canopy/contracts";
import { claudeProviderSettingsProblem } from "@canopy/domain/provider-settings-json";
import { untrack } from "svelte";

/** Check the draft after a typing pause and verify the exact text before sending it. */
export function settingsValidation(harness: () => Provider, source: () => string) {
  const required = () => harness() === Provider.CLAUDE;

  let checked = $state.raw<{ text: string; problem: string | undefined } | undefined>(
    untrack(() => {
      if (!required()) return undefined;

      const text = source();

      return { text, problem: claudeProviderSettingsProblem(text) };
    }),
  );

  function validate(text = source()) {
    if (!required()) return undefined;

    if (checked?.text !== text) checked = { text, problem: claudeProviderSettingsProblem(text) };

    return checked.problem;
  }

  $effect(() => {
    const text = source();

    if (!required() || checked?.text === text) return;
    const timer = setTimeout(() => validate(text), 150);

    return () => clearTimeout(timer);
  });

  return {
    get problem() {
      return required() ? checked?.problem : undefined;
    },
    get blocked() {
      return required() && (checked?.text !== source() || !!checked?.problem);
    },
    validate,
  };
}
