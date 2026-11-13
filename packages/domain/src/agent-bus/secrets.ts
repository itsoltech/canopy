import { Schema } from "effect";

export const RequestSecret = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  placeholder: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  name: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))),
  request_id: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
});
