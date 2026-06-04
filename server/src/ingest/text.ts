export async function extractText(buffer: Buffer): Promise<string> {
  return buffer.toString("utf8").trim();
}
