import { dev } from "$app/env";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/** Dev-only benchmark of a long synthetic thread; not part of a build's routes. */
export const load: PageLoad = ({ url }) => {
  if (!dev) error(404, "Not found");
  const number = (name: string, fallback: number) => Math.max(0, Math.min(20_000, Number(url.searchParams.get(name) ?? fallback) || 0));
  return { turns: number("turns", 1000), inherited: number("inherited", 0) };
};
