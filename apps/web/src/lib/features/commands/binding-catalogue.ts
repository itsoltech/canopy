import { bindingCatalogue as sharedCatalogue } from "@canopy/ui/keybindings";

export {
  contextsOverlap,
  type BindingContext,
  type BindingDefinition,
  type BindingGroup,
} from "@canopy/ui/keybindings";

/** The preload bridge exists before renderer modules load; browsers retain their own tab shortcuts. */
export const bindingCatalogue = sharedCatalogue.map((definition) => ({
  ...definition,
  defaults:
    typeof window !== "undefined" && window.canopyDesktop
      ? (definition.desktopDefaults ?? definition.defaults)
      : definition.defaults,
}));
