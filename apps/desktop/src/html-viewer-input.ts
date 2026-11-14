import { Schema } from "effect";
import { HTML_DOCUMENT_BYTES } from "@canopy/domain/visual-html-source";

export const ViewerInput = Schema.Struct({
  specJson: Schema.String.check(Schema.isMaxLength(HTML_DOCUMENT_BYTES * 6 + 64)),
  title: Schema.String.check(Schema.isMaxLength(200)),
});
