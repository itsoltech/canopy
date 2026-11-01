import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/** No bot exists yet: every bot chat is a 404 until the gateway has bots. */
export const load: PageLoad = () => error(404, "This bot does not exist");
