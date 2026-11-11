// Turns an uploaded file into { id, title, author, chapters: [{ title, paragraphs: [string] }] }.

const clean = (s) => s.replace(/\s+/g, ' ').trim();

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function finish(file, doc) {
  doc.chapters = doc.chapters.filter((c) => c.paragraphs.length);
  if (!doc.chapters.length) throw new Error('No readable text was found in that file.');
  const size = doc.chapters.reduce((n, c) => n + c.paragraphs.length, 0);
  doc.id = `u-${hash(`${file.name}|${file.size}|${size}`)}`;
  doc.title = doc.title || file.name.replace(/\.[^.]+$/, '');
  doc.uploaded = true;
  return doc;
}

// ---------- plain text ----------

const HEADING = /^(chapter|book|part|act|scene|canto|section|letter|volume)\b.{0,70}$|^[IVXLC]{1,7}\.?$/i;

function parseText(raw, file) {
  const paras = raw
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map(clean)
    .filter(Boolean);
  const heads = paras.map((p, i) => (p.length < 80 && HEADING.test(p) ? i : -1)).filter((i) => i >= 0);
  const chapters = [];
  if (heads.length >= 2) {
    if (heads[0] > 0) chapters.push({ title: 'Opening', paragraphs: paras.slice(0, heads[0]) });
    heads.forEach((h, k) => chapters.push({ title: paras[h], paragraphs: paras.slice(h + 1, heads[k + 1] ?? paras.length) }));
  } else {
    for (let i = 0; i < paras.length; i += 40) {
      chapters.push({ title: `Part ${i / 40 + 1}`, paragraphs: paras.slice(i, i + 40) });
    }
  }
  return finish(file, { title: '', author: '', chapters });
}

// ---------- EPUB ----------

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dd,dt';

function parseMarkup(text) {
  let d = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (d.querySelector('parsererror')) d = new DOMParser().parseFromString(text, 'text/html');
  return d;
}

async function parseEpub(file) {
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const read = async (p) => {
    const f = zip.file(p) || zip.file(decodeURIComponent(p));
    return f ? f.async('string') : null;
  };
  const container = await read('META-INF/container.xml');
  if (!container) throw new Error('That EPUB could not be read.');
  const opfPath = new DOMParser().parseFromString(container, 'application/xml').querySelector('rootfile')?.getAttribute('full-path');
  const opfText = opfPath && (await read(opfPath));
  if (!opfText) throw new Error('That EPUB could not be read.');
  const opf = new DOMParser().parseFromString(opfText, 'application/xml');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const meta = (name) => clean(opf.getElementsByTagNameNS('*', name)[0]?.textContent || '');
  const hrefs = {};
  for (const item of opf.getElementsByTagNameNS('*', 'item')) hrefs[item.getAttribute('id')] = item.getAttribute('href');

  const chapters = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    const href = hrefs[ref.getAttribute('idref')];
    const text = href && (await read(dir + href.split('#')[0]));
    if (!text) continue;
    const body = parseMarkup(text).querySelector('body');
    if (!body) continue;
    let title = '';
    const paragraphs = [];
    for (const el of body.querySelectorAll(BLOCKS)) {
      if (el.querySelector(BLOCKS)) continue; // a wrapper; its children are handled on their own
      const t = clean(el.textContent);
      if (!t) continue;
      if (!title && /^h[1-6]$/i.test(el.localName)) title = t;
      else paragraphs.push(t);
    }
    if (paragraphs.length) chapters.push({ title: title || `Section ${chapters.length + 1}`, paragraphs });
  }
  return finish(file, { title: meta('title'), author: meta('creator'), chapters });
}

// ---------- PDF ----------

async function parsePdf(file) {
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const chapters = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { items } = await page.getTextContent();
    // Group text runs into lines by their vertical position.
    const lines = [];
    for (const it of items) {
      if (!it.str) continue;
      const y = it.transform[5];
      const last = lines.at(-1);
      if (last && Math.abs(last.y - y) < 2) last.text += it.str;
      else lines.push({ y, text: it.str });
    }
    const gaps = lines.slice(1).map((l, i) => Math.abs(lines[i].y - l.y)).filter((g) => g > 0).sort((a, b) => a - b);
    const usual = gaps[Math.floor(gaps.length / 2)] || 12;
    const paragraphs = [];
    let current = '';
    lines.forEach((l, i) => {
      const gap = i ? Math.abs(lines[i - 1].y - l.y) : 0;
      if (current && gap > usual * 1.45) {
        paragraphs.push(clean(current));
        current = '';
      }
      current += (current && !current.endsWith('-') ? ' ' : '') + l.text;
    });
    if (clean(current)) paragraphs.push(clean(current));
    chapters.push({ title: `Page ${n}`, paragraphs: paragraphs.filter(Boolean) });
  }
  const info = await pdf.getMetadata().catch(() => null);
  const doc = finish(file, { title: clean(info?.info?.Title || ''), author: clean(info?.info?.Author || ''), chapters });
  doc.unit = 'page';
  return doc;
}

export async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.epub')) return parseEpub(file);
  if (name.endsWith('.pdf')) return parsePdf(file);
  if (name.endsWith('.txt') || name.endsWith('.md') || file.type.startsWith('text/')) return parseText(await file.text(), file);
  throw new Error('Use an EPUB, PDF or plain text file.');
}
