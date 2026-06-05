// Convert a File/Blob into a base64-without-prefix payload for the server,
// plus a data-URL preview. Shared by the overlay and the chat composer.
export interface PendingImage { mediaType: string; data: string; previewUrl: string; }

const OK_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export async function fileToImage(file: File | Blob): Promise<PendingImage> {
  const mediaType = OK_TYPES.includes(file.type) ? file.type : "image/png";
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ""));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
  return { mediaType, data, previewUrl: dataUrl };
}

/** Pull image files out of a clipboard paste event. */
export function imagesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}
