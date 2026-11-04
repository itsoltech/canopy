import { error, json } from "@sveltejs/kit";
import { Match } from "effect";
import { call } from "#lib/server/gateway.ts";
import { updateNotes } from "#lib/server/update-notes.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  await call((api) => api.getUpdates({}));
  const source = url.searchParams.get("source") || "canopy";
  const current = url.searchParams.get("current") || "";
  const target = url.searchParams.get("target") || "";
  const channel = url.searchParams.get("channel") || "stable";

  if (
    !["canopy", "claude", "codex"].includes(source) ||
    current.length > 128 ||
    target.length > 128 ||
    channel.length > 64
  )
    error(400, "Invalid release notes request");

  try {
    return json(
      await updateNotes(
        Match.value(source).pipe(
          Match.when("claude", () => "claude" as const),
          Match.when("codex", () => "codex" as const),
          Match.orElse(() => "canopy" as const),
        ),
        current,
        target,
        channel,
      ),
      { headers: { "cache-control": "private, max-age=60" } },
    );
  } catch (cause) {
    error(502, cause instanceof Error ? cause.message : "Release notes could not be loaded");
  }
};
