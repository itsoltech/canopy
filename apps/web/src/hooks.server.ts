import { building } from "$app/env";
import type { ServerInit } from "@sveltejs/kit/hooks";
import { requireServiceToken } from "#lib/server/gateway.ts";

export const init: ServerInit = () => {
  if (!building) requireServiceToken();
};
