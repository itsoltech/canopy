import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/** Old project URL: the project now lives in Settings. */
export const load: PageServerLoad = ({ params }) => redirect(308, `/settings/projects/${params.projectId}`);
