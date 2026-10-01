// Reads files people attach (up to 10 per message), in the browser:
// pictures are shrunk to at most 2048 px, PDFs are read with pdf.js (scanned
// PDFs become page pictures), text and code files are read as text, and Word,
// PowerPoint and Excel files go to the server to be read. Shared by Lumio Chat
// and Lumio Browser (copied into the app).
export const MAX_FILES = 10;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const SCANNED_PAGES = 5;
const vendor = new URL('./vendor/', import.meta.url).href;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|zsh|bash|sql|yaml|yml|toml|ini|cfg|conf|log|env|srt|vtt|tex|rtf|svg)$/i;
export const ACCEPT = 'image/*,.pdf,.docx,.pptx,.xlsx,.txt,.md,.csv,.json,.xml,.html,.htm,.js,.ts,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.swift,.kt,.sql,.yaml,.yml,.log,text/*';

export function kindOf(file) {
  const n = file.name.toLowerCase();
  if (file.type.startsWith('image/') && !/heic|heif/.test(file.type)) return 'image';
  if (/\.(heic|heif)$/.test(n) || /heic|heif/.test(file.type)) return 'heic';
  if (n.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (/\.(docx|pptx|xlsx)$/.test(n)) return 'office';
  if (TEXT_EXT.test(n) || file.type.startsWith('text/') || /json|xml|javascript/.test(file.type)) return 'text';
  return null;
}

export class AttachError extends Error {}

// A picture as a smaller JPEG (or the original when it's already small).
export async function shrink(file, max = 2048) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new AttachError(`Couldn’t open ${file.name}. Try a PNG or JPEG.`); }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= 2.5 * 1024 * 1024 && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) { bmp.close?.(); return file; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

let pdfjs = null;
async function loadPdf() {
  if (!pdfjs) {
    pdfjs = await import(vendor + 'pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = vendor + 'pdf.worker.min.mjs';
  }
  return pdfjs;
}

// A PDF's text, or (for scanned PDFs) pictures of its first pages.
export async function readPdf(file) {
  if (file.size > MAX_PDF_BYTES) throw new AttachError(`${file.name} is over 50 MB.`);
  const lib = await loadPdf();
  let doc;
  try { doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise; } catch (err) {
    throw new AttachError(err?.name === 'PasswordException' ? `${file.name} is password-protected.` : `Couldn’t read ${file.name}.`);
  }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim());
  }
  const text = pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join('\n\n');
  if (pages.join('').replace(/\s/g, '').length >= 30 * Math.min(doc.numPages, 3)) return { text, pages: doc.numPages };
  // Scanned: render the first pages as pictures.
  const images = [];
  for (let i = 1; i <= Math.min(doc.numPages, SCANNED_PAGES); i++) {
    const page = await doc.getPage(i);
    const v = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1600 / v.width) });
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    images.push(new File([blob], `${file.name.replace(/\.pdf$/i, '')} – page ${i}.jpg`, { type: 'image/jpeg' }));
  }
  return { images, pages: doc.numPages };
}

export async function readText(file) {
  if (file.size > MAX_TEXT_BYTES) throw new AttachError(`${file.name} is too big to read (over 4 MB of text).`);
  const text = await file.text();
  if (!text.trim()) throw new AttachError(`${file.name} is empty.`);
  return text;
}

// Lumio Chat: reads one file and uploads what Lumio needs. Returns the server's
// file records (a scanned PDF becomes several pictures).
export async function uploadFile(file, { endpoint = '/api/files', headers = {} } = {}) {
  const kind = kindOf(file);
  if (kind === 'heic') throw new AttachError(`${file.name}: HEIC photos aren’t supported in the browser. Export it as JPEG first.`);
  if (!kind) throw new AttachError(`Lumio can’t read ${file.name.split('.').pop()?.toUpperCase() || 'that'} files yet.`);
  const post = async (body, type, name) => {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': type, ...(name ? { 'x-file-name': encodeURIComponent(name) } : {}), ...headers }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new AttachError(data.error || `Couldn’t attach ${file.name}.`);
    return data.file;
  };
  if (kind === 'image') { const img = await shrink(file); return [await post(img, img.type, img.name)]; }
  if (kind === 'office') return [await post(file, file.type || 'application/octet-stream', file.name)];
  if (kind === 'text') return [await post(JSON.stringify({ name: file.name, mime: file.type || 'text/plain', text: await readText(file) }), 'application/json')];
  const pdf = await readPdf(file);
  if (pdf.text) return [await post(JSON.stringify({ name: file.name, mime: 'application/pdf', text: pdf.text, pages: pdf.pages }), 'application/json')];
  const out = [];
  for (const img of pdf.images) out.push(await post(img, img.type, img.name));
  return out;
}
