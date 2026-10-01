// Builds the files Lumio writes (PDF, Word, PowerPoint, Markdown, text, CSV,
// HTML) from their content, right in the browser. The AI writes Markdown;
// this turns it into a real document. The big libraries load on first use.
// Shared by Lumio Chat (website) and Lumio Browser (copied into the app).
import { marked } from './vendor/marked.js';

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', html: 'text/html',
};
const ACCENT = '2F6FDD';
const loaded = new Map();
function script(src) {
  if (!loaded.has(src)) loaded.set(src, new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Couldn’t load ${src}`)); document.head.append(s); }));
  return loaded.get(src);
}
const base = new URL('./vendor/', import.meta.url).href;

// Inline Markdown tokens -> runs { text, bold, italic, code, link, strike }.
function runs(tokens = [], style = {}) {
  const out = [];
  for (const t of tokens) {
    if (t.type === 'strong') out.push(...runs(t.tokens, { ...style, bold: true }));
    else if (t.type === 'em') out.push(...runs(t.tokens, { ...style, italic: true }));
    else if (t.type === 'del') out.push(...runs(t.tokens, { ...style, strike: true }));
    else if (t.type === 'codespan') out.push({ ...style, text: unescape(t.text), code: true });
    else if (t.type === 'link') out.push(...runs(t.tokens, { ...style, link: t.href }));
    else if (t.type === 'br') out.push({ ...style, text: '\n' });
    else if (t.tokens) out.push(...runs(t.tokens, style));
    else if (t.type !== 'html') out.push({ ...style, text: unescape(t.text ?? t.raw ?? '') });
  }
  return out;
}
const unescape = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const plain = (tokens) => runs(tokens).map((r) => r.text).join('');
const lex = (text) => marked.lexer(String(text || ''));

// ---------------------------------------------------------------- PDF (pdfmake)
async function pdf(title, text) {
  await script(base + 'pdfmake.min.js');
  await script(base + 'vfs_fonts.js');
  const inline = (rs) => rs.map((r) => ({ text: r.text, bold: r.bold, italics: r.italic, decoration: r.strike ? 'lineThrough' : undefined, ...(r.code ? { background: '#EEF1F6', fontSize: 9.5 } : {}), ...(r.link ? { link: r.link, color: '#' + ACCENT } : {}) }));
  const block = (t) => {
    switch (t.type) {
      case 'heading': return { text: inline(runs(t.tokens)), style: `h${Math.min(t.depth, 3)}` };
      case 'paragraph': return { text: inline(runs(t.tokens)), margin: [0, 0, 0, 8] };
      case 'list': {
        const items = t.items.map((i) => { const parts = i.tokens.map(block).filter(Boolean); return parts.length === 1 ? parts[0] : { stack: parts }; });
        return { [t.ordered ? 'ol' : 'ul']: items, margin: [0, 0, 0, 8] };
      }
      case 'text': return { text: inline(runs(t.tokens || [{ type: 'text', text: t.text }])) };
      case 'table': return {
        table: { headerRows: 1, widths: t.header.map(() => '*'), body: [t.header.map((c) => ({ text: inline(runs(c.tokens)), bold: true, fillColor: '#EEF1F6' })), ...t.rows.map((r) => r.map((c) => ({ text: inline(runs(c.tokens)) })))] },
        layout: { hLineColor: () => '#D7DCE4', vLineColor: () => '#D7DCE4' }, margin: [0, 2, 0, 10], fontSize: 9.5,
      };
      case 'code': return { table: { widths: ['*'], body: [[{ text: t.text, fontSize: 9, preserveLeadingSpaces: true, fillColor: '#F3F5F8', margin: [6, 6, 6, 6] }]] }, layout: 'noBorders', margin: [0, 0, 0, 10] };
      case 'blockquote': return { stack: t.tokens.map(block).filter(Boolean), italics: true, color: '#555B66', margin: [12, 0, 0, 8] };
      case 'hr': return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineColor: '#D7DCE4' }], margin: [0, 6, 0, 12] };
      default: return null;
    }
  };
  const tokens = lex(text);
  const content = tokens.map(block).filter(Boolean);
  const startsWithTitle = tokens.find((t) => t.type !== 'space')?.type === 'heading';
  const doc = {
    info: { title, creator: 'Lumio' },
    pageMargins: [56, 60, 56, 60],
    content: startsWithTitle ? content : [{ text: title, style: 'h1' }, ...content],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.3, color: '#1C1F24' },
    styles: {
      h1: { fontSize: 22, bold: true, margin: [0, 0, 0, 10], color: '#11141A' },
      h2: { fontSize: 16, bold: true, margin: [0, 12, 0, 6], color: '#11141A' },
      h3: { fontSize: 13, bold: true, margin: [0, 10, 0, 4], color: '#11141A' },
    },
    footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: 'right', fontSize: 8, color: '#9AA1AD', margin: [0, 20, 56, 0] }),
  };
  return new Promise((resolve) => window.pdfMake.createPdf(doc).getBlob(resolve));
}

// ---------------------------------------------------------------- Word (docx)
async function word(title, text) {
  await script(base + 'docx.iife.js');
  const d = window.docx;
  const textRuns = (rs, extra = {}) => rs.map((r) => {
    const run = new d.TextRun({ text: r.text, bold: r.bold, italics: r.italic, strike: r.strike, ...(r.code ? { font: 'Consolas', shading: { fill: 'EEF1F6', type: d.ShadingType.CLEAR } } : {}), ...(r.link ? { color: ACCENT, underline: {} } : {}), ...extra });
    return r.link ? new d.ExternalHyperlink({ link: r.link, children: [run] }) : run;
  });
  const HEAD = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4];
  const out = [];
  const add = (t, level = 0) => {
    switch (t.type) {
      case 'heading': out.push(new d.Paragraph({ heading: HEAD[Math.min(t.depth, 4) - 1], children: textRuns(runs(t.tokens)) })); break;
      case 'paragraph': out.push(new d.Paragraph({ children: textRuns(runs(t.tokens)), spacing: { after: 120 } })); break;
      case 'text': out.push(new d.Paragraph({ children: textRuns(runs(t.tokens || [{ type: 'text', text: t.text }])) })); break;
      case 'list':
        t.items.forEach((item, n) => {
          item.tokens.forEach((it, k) => {
            if (it.type === 'list') { add(it, level + 1); return; }
            const rs = runs(it.tokens || [{ type: 'text', text: it.text }]);
            out.push(new d.Paragraph(t.ordered
              ? { children: textRuns(k === 0 ? [{ text: `${(t.start || 1) + n}. ` }, ...rs] : rs), indent: { left: 360 * (level + 1), hanging: 260 } }
              : { bullet: { level }, children: textRuns(rs) }));
          });
        });
        break;
      case 'table': {
        const cell = (c, head) => new d.TableCell({ children: [new d.Paragraph({ children: textRuns(runs(c.tokens), head ? { bold: true } : {}) })], ...(head ? { shading: { fill: 'EEF1F6', type: d.ShadingType.CLEAR } } : {}) });
        out.push(new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows: [new d.TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }), ...t.rows.map((r) => new d.TableRow({ children: r.map((c) => cell(c)) }))] }));
        out.push(new d.Paragraph({ children: [] }));
        break;
      }
      case 'code': t.text.split('\n').forEach((line) => out.push(new d.Paragraph({ children: [new d.TextRun({ text: line, font: 'Consolas', size: 19 })], shading: { fill: 'F3F5F8', type: d.ShadingType.CLEAR } }))); break;
      case 'blockquote': t.tokens.forEach((x) => { if (x.type === 'paragraph') out.push(new d.Paragraph({ children: textRuns(runs(x.tokens), { italics: true }), indent: { left: 360 } })); }); break;
      case 'hr': out.push(new d.Paragraph({ border: { bottom: { color: 'D7DCE4', style: d.BorderStyle.SINGLE, size: 6 } }, children: [] })); break;
      default: break;
    }
  };
  const tokens = lex(text);
  if (tokens.find((t) => t.type !== 'space')?.type !== 'heading') out.push(new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun(title)] }));
  tokens.forEach((t) => add(t));
  const doc = new d.Document({
    creator: 'Lumio', title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children: out }],
  });
  return d.Packer.toBlob(doc);
}

// ---------------------------------------------------------------- PowerPoint (pptxgenjs)
// Each # or ## heading starts a slide; lists become bullets; tables become tables.
async function slides(title, text) {
  await script(base + 'pptxgen.bundle.js');
  const pptx = new window.PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.author = 'Lumio';
  const tokens = lex(text);
  const sections = [];
  let cur = null;
  for (const t of tokens) {
    if (t.type === 'heading' && t.depth <= 2) {
      const heading = plain(t.tokens).replace(/^slide\s*\d+\s*[:.\-–—]\s*/i, '').trim();
      if (/^title( slide)?$/i.test(heading) && sections.length === 1) continue; // a “Title slide” section the AI added
      cur = { heading: heading || title, depth: t.depth, body: [] }; sections.push(cur); continue;
    }
    if (t.type === 'hr') continue;
    if (t.type === 'space') continue;
    if (!cur) { cur = { heading: title, depth: 1, body: [] }; sections.push(cur); }
    cur.body.push(t);
  }
  if (!sections.length) sections.push({ heading: title, depth: 1, body: [] });
  // "# Title" then "## A subtitle" with nothing under either: one title slide.
  if (sections.length > 2 && !sections[0].body.length && !sections[1].body.length) {
    sections[0].subtitle = sections[1].heading;
    sections.splice(1, 1);
  }
  sections.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    const titleSlide = i === 0 && sections.length > 1 && s.body.length <= 1 && (s.depth === 1 || s.subtitle);
    if (titleSlide) {
      slide.background = { color: '0B0D12' };
      slide.addText(s.heading, { x: 0.8, y: 2.4, w: 11.7, h: 1.4, fontSize: 44, bold: true, color: 'FFFFFF', fontFace: 'Calibri' });
      const sub = s.subtitle || (s.body[0] ? plain(s.body[0].tokens || []) : '');
      if (sub) slide.addText(sub, { x: 0.8, y: 3.9, w: 11.7, h: 0.9, fontSize: 20, color: 'A9B4C7', fontFace: 'Calibri' });
      slide.addShape(pptx.ShapeType.rect, { x: 0.8, y: 2.2, w: 1.2, h: 0.08, fill: { color: ACCENT } });
      return;
    }
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: ACCENT } });
    slide.addText(s.heading, { x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontSize: 30, bold: true, color: '11141A', fontFace: 'Calibri' });
    const lines = [];
    let table = null;
    for (const t of s.body) {
      if (t.type === 'list') t.items.forEach((it) => {
        it.tokens.forEach((x) => {
          if (x.type === 'list') x.items.forEach((sub) => lines.push({ text: plain(sub.tokens), options: { bullet: { indent: 18 }, indentLevel: 1, fontSize: 16 } }));
          else lines.push({ text: plain(x.tokens || [{ type: 'text', text: x.text }]), options: { bullet: t.ordered ? { type: 'number' } : true, fontSize: 20 } });
        });
      });
      else if (t.type === 'paragraph' || t.type === 'heading') lines.push({ text: plain(t.tokens), options: { fontSize: t.type === 'heading' ? 22 : 18, bold: t.type === 'heading', breakLine: true } });
      else if (t.type === 'table') table = t;
      else if (t.type === 'code') lines.push({ text: t.text, options: { fontFace: 'Consolas', fontSize: 14 } });
    }
    const bodyH = table ? 2.4 : 5.6;
    if (lines.length) slide.addText(lines, { x: 0.6, y: 1.4, w: 12.1, h: bodyH, valign: 'top', color: '2A2F38', fontFace: 'Calibri', paraSpaceAfter: 8 });
    if (table) {
      const rows = [table.header.map((c) => ({ text: plain(c.tokens), options: { bold: true, fill: { color: 'EEF1F6' } } })), ...table.rows.map((r) => r.map((c) => ({ text: plain(c.tokens) })))];
      slide.addTable(rows, { x: 0.6, y: lines.length ? 4.0 : 1.5, w: 12.1, fontSize: 14, border: { type: 'solid', color: 'D7DCE4', pt: 1 }, fontFace: 'Calibri' });
    }
  });
  const blob = await pptx.write({ outputType: 'blob' });
  return new Blob([blob], { type: MIME.pptx });
}

// ---------------------------------------------------------------- the rest
function html(title, text) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1c1f24;max-width:760px;margin:48px auto;padding:0 20px}h1,h2,h3{line-height:1.25}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d7dce4;padding:6px 10px;text-align:left}th{background:#eef1f6}code{background:#eef1f6;padding:1px 5px;border-radius:4px}pre{background:#f3f5f8;padding:12px;border-radius:8px;overflow:auto}a{color:#2f6fdd}</style></head>
<body>${marked.parse(String(text || ''))}</body></html>`;
}

// The file for a document Lumio made: { name, format, text, title? } -> Blob.
export async function buildFile({ name, format, text, title }) {
  const t = title || String(name || 'Lumio').replace(/\.[a-z0-9]+$/i, '');
  if (format === 'pdf') return pdf(t, text);
  if (format === 'docx') return word(t, text);
  if (format === 'pptx') return slides(t, text);
  if (format === 'html') return new Blob([html(t, text)], { type: MIME.html });
  return new Blob([text], { type: `${MIME[format] || 'text/plain'};charset=utf-8` });
}

export function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
