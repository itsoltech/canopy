export type ModuleId = "threads" | "bots";

export function validModuleOrder(order: readonly string[]): order is readonly [ModuleId, ...ModuleId[]] {
  const [first, second] = order;

  return (
    (first === "threads" || first === "bots") &&
    (order.length === 1 || (order.length === 2 && (second === "threads" || second === "bots") && first !== second))
  );
}

/** Existing accounts start with Threads followed by Bots. */
export function enabledModules(settings?: { enabled: readonly string[] }): [ModuleId, ...ModuleId[]] {
  return settings && validModuleOrder(settings.enabled) ? [...settings.enabled] : ["threads", "bots"];
}
