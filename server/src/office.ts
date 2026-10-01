// Text from Office files (Word .docx, PowerPoint .pptx, Excel .xlsx) without
// libraries: they're ZIP archives of XML, and Workers can inflate ZIP entries
// with DecompressionStream. Used for attachments and connected files.

type Entry = { name: string; method: number; csize: number; size: number; offset: number };

function entries(buf: Uint8Array): Entry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: the last 0x06054b50 record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: Entry[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    out.push({ name: new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen)), method, csize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function read(buf: Uint8Array, e: Entry): Promise<string> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error('unsupported compression');
  if (e.size > 50 * 1024 * 1024) throw new Error('too big');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

// Paragraph texts: <w:p> / <a:p> holding <w:t> / <a:t> runs.
function paragraphs(xml: string, ns: 'w' | 'a') {
  const out: string[] = [];
  for (const p of xml.split(new RegExp(`</${ns}:p>`))) {
    const runs = [...p.matchAll(new RegExp(`<${ns}:(t|tab|br)(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${ns}:t>)`, 'g'))]
      .map((m) => (m[1] === 'tab' ? '\t' : m[1] === 'br' ? '\n' : unxml(m[2] || '')));
    const line = runs.join('');
    if (line.trim()) out.push(line);
  }
  return out;
}

const col = (ref: string) => { let n = 0; for (const c of ref.replace(/\d+/g, '')) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export type OfficeKind = 'docx' | 'pptx' | 'xlsx';
export function officeKind(name: string, mime = ''): OfficeKind | null {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (ext === 'docx' || mime.includes('wordprocessingml')) return 'docx';
  if (ext === 'pptx' || mime.includes('presentationml')) return 'pptx';
  if (ext === 'xlsx' || mime.includes('spreadsheetml')) return 'xlsx';
  return null;
}

// The text of an Office file (sheets as CSV), and how many pages/slides/sheets.
export async function officeText(bytes: Uint8Array, kind: OfficeKind): Promise<{ text: string; parts: number }> {
  const list = entries(bytes);
  const get = (name: string) => list.find((e) => e.name === name);
  if (kind === 'docx') {
    const doc = get('word/document.xml');
    if (!doc) throw new Error('not a Word file');
    return { text: paragraphs(await read(bytes, doc), 'w').join('\n'), parts: 1 };
  }
  if (kind === 'pptx') {
    const slides = list.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => +a.name.match(/\d+/)![0] - +b.name.match(/\d+/)![0]);
    const out: string[] = [];
    for (const [i, s] of slides.entries()) out.push(`Slide ${i + 1}\n${paragraphs(await read(bytes, s), 'a').join('\n')}`);
    return { text: out.join('\n\n'), parts: slides.length };
  }
  const shared: string[] = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) for (const si of (await read(bytes, ss)).split('</si>')) shared.push(unxml([...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
  const book = get('xl/workbook.xml');
  const names = book ? [...(await read(bytes, book)).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unxml(m[1])) : [];
  const sheets = list.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a, b) => +a.name.match(/\d+/)![0] - +b.name.match(/\d+/)![0]);
  const out: string[] = [];
  for (const [i, s] of sheets.entries()) {
    const rows: string[][] = [];
    for (const row of (await read(bytes, s)).split('</row>')) {
      const cells: string[] = [];
      for (const c of row.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = /t="(\w+)"/.exec(c[2])?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[3] || '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[3] || '')?.[1] ?? '';
        cells[col(c[1])] = type === 's' ? shared[+v] ?? '' : unxml(v);
      }
      if (cells.length) rows.push(Array.from(cells, (x) => x ?? ''));
    }
    out.push(`Sheet: ${names[i] || `Sheet${i + 1}`}\n${rows.map((r) => r.map(csvCell).join(',')).join('\n')}`);
  }
  return { text: out.join('\n\n'), parts: sheets.length };
}
