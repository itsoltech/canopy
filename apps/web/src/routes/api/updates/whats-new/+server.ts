import { error, json } from "@sveltejs/kit";
import { fetchReleaseNotes } from "@canopy/domain/release/notes";
import type { RequestHandler } from "./$types";

/** Public, fixed Pages resource. No user input, gateway credentials or GitHub API fallback. */
export const GET: RequestHandler = async () => {
  try {
    return json(await fetchReleaseNotes(), { headers: { "cache-control": "public, max-age=900" } });
  } catch {
    error(502, "Could not load release notes. Retry or view releases on GitHub.");
  }
};
