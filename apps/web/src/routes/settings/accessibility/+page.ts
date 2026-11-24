import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = () => {
  if (!window.canopyDesktop) redirect(307, "/settings/general");
};
