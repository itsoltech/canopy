import type { ReadonlyURL } from "$app/state";
import { hasComposerContent } from "@canopy/domain/composer-drafts";
import type { GatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
import { webDrafts } from "#lib/features/drafts/local.svelte.ts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

export function firstRunView(url: ReadonlyURL, overview: OverviewState, capabilities: GatewayCapabilities) {
  if (url.pathname === "/") return "loading";

  if (
    url.pathname !== "/threads/new" ||
    url.searchParams.has("project") ||
    url.searchParams.has("workspace") ||
    capabilities.incompatible ||
    capabilities.offerOnboarding === false ||
    capabilities.state === "unavailable"
  )
    return "app";

  const { onboardingSkipped, onboardingSent } = devicePreferences.view;

  if (
    onboardingSkipped ||
    onboardingSent ||
    overview.agentChoiceThreads.length ||
    overview.projects.some((project) => project.kind !== "scratch")
  )
    return "app";

  const scope = capabilities.clientPreferencesScope;

  if (!scope && capabilities.methods) return "app";

  void webDrafts.generation;

  if (
    !capabilities.offerOnboarding ||
    !overview.resyncs ||
    !devicePreferences.viewLoaded ||
    !webDrafts.ready ||
    webDrafts.scope !== scope
  )
    return "loading";

  void webDrafts.version;

  const hasDraft = webDrafts.local
    .list()
    .some(
      (entry) =>
        entry.pendingForm || entry.pendingSend.length || hasComposerContent(entry.draft?.content, entry.files.length),
    );

  return hasDraft ? "app" : "intro";
}
