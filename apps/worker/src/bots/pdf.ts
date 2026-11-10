import { getDocumentProxy } from "unpdf";

/** Extract only a bounded prefix; scripts, external resources and OCR are never executed. */
export async function pdfText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(data, { useSystemFonts: false, verbosity: 0 }).catch(() => undefined);

  if (!pdf) return "[Canopy could not open this PDF. Forward it to a thread to work with the original.]";

  try {
    let text = "";
    const pages = Math.min(pdf.numPages, 50);

    for (let number = 1; number <= pages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();

      text += content.items.flatMap((item) => ("str" in item ? [item.str] : [])).join(" ") + "\n";
      page.cleanup();

      if (text.length > 64_000) break;
    }

    return text.trim()
      ? text.slice(0, 64_001) + (pages < pdf.numPages ? "\n[Canopy extracted the first 50 pages only.]" : "")
      : "[This PDF contains no extractable text. Forward it to a thread for visual inspection.]";
  } catch {
    return "[Canopy could not extract PDF text. Forward it to a thread to work with the original.]";
  } finally {
    await pdf.loadingTask.destroy();
  }
}
