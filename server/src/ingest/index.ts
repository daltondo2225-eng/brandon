import { extractDocx } from "./docx.js";
import { extractPdf } from "./pdf.js";
import { extractText } from "./text.js";

export async function extractByMime(mime: string, buffer: Buffer): Promise<string> {
  if (mime === "application/pdf") return extractPdf(buffer);
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return extractDocx(buffer);
  }
  if (mime === "text/plain" || mime === "text/markdown") return extractText(buffer);
  throw new Error(`Unsupported file type: ${mime}`);
}
