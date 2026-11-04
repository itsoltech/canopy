/** JSON data at I/O boundaries; decode it before treating it as a domain value. */
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };
