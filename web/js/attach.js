// Attachments on the page: shrink a photo, read a file as base64, and tell a saved user message apart again.
// The server limits (attach.py) are the real ones; these just stop the page from sending what would be refused.
export const MAX_FILES = 4, MAX_DOC_BYTES = 3_000_000, MAX_TOTAL_B64 = 8_500_000;
export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const extOf = (name) => (/\.[^./\\]+$/.exec(name) || [""])[0].toLowerCase();

// Downscale to at most `max` px on the long side and re-encode as JPEG (also fixes phone-photo rotation).
export async function shrinkImage(file, max = 1280, quality = 0.82) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); // transparent PNGs get a white background
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", quality));
}
export const toBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

// A saved user message -> what to show: the typed text, document names, photo file names.
// Documents are stored inside the text as <attached_file name="..."> blocks (what the model reads); the page shows chips instead.
const WRAP = /\n*<attached_file name="([^"]*)"[^>]*>\n[\s\S]*?\n<\/attached_file>/g;
export function parseUserContent(content) {
  const parts = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
  let text = "";
  const images = [];
  for (const p of parts) {
    if (p.type === "text") text += p.text;
    else if (p.type === "image_ref") images.push(String(p.name).replace(/^uploads\//, ""));
  }
  const files = [];
  text = text.replace(WRAP, (_, name) => { files.push(name); return ""; }).trim();
  return { text, files, images };
}
