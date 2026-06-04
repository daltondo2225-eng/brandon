// pdf-parse's top-level entry tries to load a test fixture from disk at import time
// (a long-standing maintenance quirk). Importing the inner module bypasses that.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export async function extractPdf(buffer: Buffer): Promise<string> {
  const result = await pdfParse(buffer);
  return result.text.trim();
}
