import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/** Old project URL: the project now lives in Settings. */
export const load: PageLoad = ({ params }) => redirect(308, `/settings/projects/${params.projectId}`);
