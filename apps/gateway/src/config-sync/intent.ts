import { canonicalJson } from "../store/instance-config.ts";
import type { ConfigRow, Field } from "./persistence.ts";
import { settingsValues } from "./settings.ts";
import type { Values } from "./provider-values.ts";

const INSTANCE_DEFAULTS = {
  label: "",
  kind: "native",
  baseUrl: "",
  proxy: "",
  accentColor: "",
  launchArgs: [],
  ownLogin: false,
  allWorkers: true,
  favorites: [],
  hidden: [],
  shown: [],
  custom: [],
  apiKey: null,
};

/** Legacy bootstrap has no intent bit. Only known singleton defaults can safely be called untouched. */
export function editedField(row: Pick<ConfigRow, "kind" | "global_id">, name: string, field: Field): boolean {
  if (field.edited !== undefined) return field.edited;

  if (field.prev) return true;

  const defaults: Values =
    row.kind === "settings"
      ? settingsValues({}, "")
      : row.kind === "instance" && row.global_id.endsWith(":native")
        ? INSTANCE_DEFAULTS
        : {};

  return !(name in defaults) || canonicalJson(field.value) !== canonicalJson(defaults[name]!);
}
