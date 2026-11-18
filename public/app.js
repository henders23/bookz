import { parseFile } from './parse.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
};
const uid = () => Math.random().toString(36).slice(2, 10);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

// ---------- storage ----------

const memoryDocs = new Map();
function db() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('bookz', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('docs', { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction('docs', mode).objectStore('docs'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveDoc(doc) {
  memoryDocs.set(doc.id, doc);
  try { await store('readwrite', (s) => s.put(doc)); } catch { /* kept in memory for this visit */ }
}
async function listDocs() {
  try { return await store('readonly', (s) => s.getAll()); } catch { return [...memoryDocs.values()]; }
}
async function deleteDoc(id) {
  memoryDocs.delete(id);
  try { await store('readwrite', (s) => s.delete(id)); } catch { /* nothing stored */ }
  try { localStorage.removeItem(`bookz:state:${id}`); } catch { /* ignore */ }
}
function loadState(id) {
  try { return JSON.parse(localStorage.getItem(`bookz:state:${id}`)) || {}; } catch { return {}; }
}
function saveState() {
  if (!doc) return;
  try {
    localStorage.setItem(`bookz:state:${doc.id}`, JSON.stringify({ ch: pos.ch, marks, threads, activeThread, kind, visited, questions, qPrefs }));
  } catch { /* storage full or blocked: state lasts for this visit only */ }
}

// ---------- state ----------

let doc = null;
let pos = { ch: 0 };
let marks = []; // { id, ch, p, start, end, text, note }  (p == null: a note on the chapter)
let threads = []; // { id, title, open, showAll, messages: [{ role, text, quote, demo, error }] }
let activeThread = null;
let pendingQuote = null; // { ch, p, text }
let pendingSelection = null; // [{ ch, p, start, end, text }]
let selectedMark = null;
let busy = false;
let kind = null; // 'literature' | 'academic' | 'general', set automatically and changeable
let visited = []; // chapters the student has opened; questions only draw on these
let questions = []; // { id, question, ch, p, lens, level, demo, threadId }
let qPrefs = { lens: 'mix', level: 'notice', scope: 'chapter' };
let qBusy = false;
let barShownAt = 0;

// ---------- start page ----------

async function refreshRecent() {
  const docs = (await listDocs()).filter((d) => d.uploaded);
  $('recent').hidden = !docs.length;
  $('recent-list').replaceChildren(
    ...docs.map((d) =>
      el('li', {},
        el('button', { type: 'button', class: 'btn open', text: d.title, onclick: () => openDoc(d) }),
        el('button', {
          type: 'button', class: 'btn btn-small', text: 'Remove', 'aria-label': `Remove ${d.title}`,
          onclick: async () => {
            if (confirm(`Remove “${d.title}” and its highlights and notes from this browser?`)) {
              await deleteDoc(d.id);
              refreshRecent();
            }
          },
        }),
      ),
    ),
  );
}

async function handleFile(file) {
  const status = $('upload-status');
  status.className = 'status';
  status.textContent = `Reading ${file.name}…`;
  try {
    const parsed = await parseFile(file);
    await saveDoc(parsed);
    status.textContent = '';
    openDoc(parsed);
  } catch (error) {
    status.className = 'status error';
    status.textContent = error.message || 'That file could not be read.';
  }
  $('file').value = '';
}

$('file').addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));

$('open-sample').addEventListener('click', async () => {
  const btn = $('open-sample');
  btn.disabled = true;
  try {
    const res = await fetch('sample/meditations.json');
    openDoc(await res.json());
  } catch {
    $('upload-status').className = 'status error';
    $('upload-status').textContent = 'The sample could not be loaded.';
  }
  btn.disabled = false;
});

$('home').addEventListener('click', () => {
  hideSelBar();
  $('reader').hidden = true;
  $('start').hidden = false;
  refreshRecent();
});

// ---------- reader ----------

function openDoc(d) {
  doc = d;
  const saved = loadState(d.id);
  pos = { ch: Math.min(saved.ch || 0, d.chapters.length - 1) };
  marks = saved.marks || [];
  threads = saved.threads || [];
  activeThread = saved.activeThread || null;
  pendingQuote = null;
  kind = saved.kind || null;
  visited = saved.visited || [];
  questions = saved.questions || [];
  qPrefs = { lens: 'mix', level: 'notice', scope: 'chapter', ...saved.qPrefs };
  $('q-status').textContent = '';
  if (!kind) classify(d);
  $('doc-title').textContent = d.title;
  $('doc-author').textContent = d.author || '';
  $('oa-tag').hidden = !d.rights;
  $('chapter').replaceChildren(...d.chapters.map((c, i) => el('option', { value: i, text: clip(c.title, 60) })));
  $('start').hidden = true;
  $('reader').hidden = false;
  renderChapter();
  renderThreads();
  renderNotes();
  renderQuote();
  renderQuestionSetup();
  renderQuestions();
}

function placeLabel(ch, p) {
  const title = clip(doc.chapters[ch]?.title || `Chapter ${ch + 1}`, 28);
  return p == null ? title : `${title} · ¶${p + 1}`;
}

function fillPara(node, text, list) {
  node.replaceChildren();
  let at = 0;
  for (const m of list.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    if (m.start > at) node.append(text.slice(at, m.start));
    node.append(el('mark', { 'data-id': m.id, class: m.note ? 'has-note' : '', text: text.slice(Math.max(m.start, at), m.end) }));
    at = Math.max(at, m.end);
  }
  if (at < text.length) node.append(text.slice(at));
}

// A table (from a Word upload) is stored as one paragraph: rows on lines, cells split by " | ".
function tableNode(ci, pi) {
  const ch = doc.chapters[ci];
  if (!ch.tables?.includes(pi)) return null;
  const headed = ch.tableHeads?.includes(pi);
  const rows = ch.paragraphs[pi].split('\n').map((r) => r.split(' | '));
  const width = Math.max(...rows.map((r) => r.length));
  const row = (cells, tag) =>
    el('tr', {}, ...cells.map((c, i) => el(tag, { text: c, colspan: i === cells.length - 1 && cells.length < width ? width - i : null })));
  return el('table', {},
    headed ? el('thead', {}, row(rows[0], 'th')) : null,
    el('tbody', {}, ...rows.slice(headed ? 1 : 0).map((r) => row(r, 'td'))),
  );
}

function renderChapter(flashP) {
  const ch = doc.chapters[pos.ch];
  if (!visited.includes(pos.ch)) visited.push(pos.ch);
  const text = $('text');
  const last = doc.chapters.length - 1;
  text.replaceChildren(
    el('div', { class: 'eyebrow', text: `${pos.ch + 1} of ${doc.chapters.length}` }),
    el('h1', { text: ch.title }),
    ...ch.paragraphs.map((p, i) => {
      const table = tableNode(pos.ch, i);
      const body = table ? el('div', { class: 'table-wrap' }, table) : el('p', { class: 'ptext' });
      if (!table) fillPara(body, p, marks.filter((m) => m.ch === pos.ch && m.p === i));
      return el('div', { class: 'para', 'data-p': i }, el('span', { class: 'pnum', 'aria-hidden': 'true', text: i + 1 }), body);
    }),
    el('nav', { class: 'chapter-nav', 'aria-label': 'Chapters' },
      pos.ch > 0 ? el('button', { type: 'button', class: 'linkish', text: `‹ ${clip(doc.chapters[pos.ch - 1].title, 30)}`, onclick: () => goTo(pos.ch - 1) }) : el('span'),
      pos.ch < last ? el('button', { type: 'button', class: 'linkish', text: `${clip(doc.chapters[pos.ch + 1].title, 30)} ›`, onclick: () => goTo(pos.ch + 1) }) : el('span'),
    ),
  );
  $('chapter').value = pos.ch;
  $('prev').disabled = pos.ch === 0;
  $('next').disabled = pos.ch === last;
  hideSelBar();
  if (flashP == null) {
    $('text-pane').scrollTop = 0;
    if (window.matchMedia('(max-width: 900px)').matches) window.scrollTo(0, 0);
  } else {
    const target = text.querySelector(`.para[data-p="${flashP}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('flash');
    }
  }
}

function goTo(ch, p) {
  if (!doc.chapters[ch]) return;
  pos.ch = ch;
  renderChapter(p);
  saveState();
}

$('chapter').addEventListener('change', (e) => goTo(Number(e.target.value)));
$('prev').addEventListener('click', () => goTo(pos.ch - 1));
$('next').addEventListener('click', () => goTo(pos.ch + 1));

// ---------- selecting and highlighting ----------

function offsetIn(ptext, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(ptext);
  r.setEnd(node, offset);
  return r.toString().length;
}

function readSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!$('text').contains(range.commonAncestorContainer)) return null;
  const parts = [];
  for (const ptext of $('text').querySelectorAll('.ptext')) {
    if (!range.intersectsNode(ptext)) continue;
    const full = ptext.textContent;
    const start = ptext.contains(range.startContainer) ? offsetIn(ptext, range.startContainer, range.startOffset) : 0;
    const end = ptext.contains(range.endContainer) ? offsetIn(ptext, range.endContainer, range.endOffset) : full.length;
    if (end > start && full.slice(start, end).trim()) {
      parts.push({ ch: pos.ch, p: Number(ptext.parentElement.dataset.p), start, end, text: full.slice(start, end) });
    }
  }
  return parts.length ? { parts, rect: range.getBoundingClientRect() } : null;
}

function showSelBar(rect, forMark) {
  const bar = $('sel-bar');
  bar.querySelector('[data-act="highlight"]').hidden = forMark;
  bar.querySelector('[data-act="remove"]').hidden = !forMark;
  bar.hidden = false;
  barShownAt = Date.now();
  const w = bar.offsetWidth;
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, document.documentElement.clientWidth - w - 8));
  const above = rect.top - bar.offsetHeight - 8;
  bar.style.left = `${left + window.scrollX}px`;
  bar.style.top = `${(above < 8 ? rect.bottom + 8 : above) + window.scrollY}px`;
}
function hideSelBar() {
  $('sel-bar').hidden = true;
  pendingSelection = null;
  selectedMark = null;
}

function onSelectionEnd() {
  setTimeout(() => {
    const found = readSelection();
    if (found) {
      pendingSelection = found.parts;
      selectedMark = null;
      showSelBar(found.rect, false);
    }
  }, 0);
}
$('text').addEventListener('mouseup', onSelectionEnd);
$('text').addEventListener('touchend', onSelectionEnd);
$('text').addEventListener('keyup', (e) => e.shiftKey && onSelectionEnd());

$('text').addEventListener('click', (e) => {
  const markEl = e.target.closest('mark');
  if (!markEl || !window.getSelection().isCollapsed) return;
  selectedMark = marks.find((m) => m.id === markEl.dataset.id) || null;
  pendingSelection = null;
  if (selectedMark) showSelBar(markEl.getBoundingClientRect(), true);
});
document.addEventListener('mousedown', (e) => {
  if (!$('sel-bar').hidden && !e.target.closest('#sel-bar') && !e.target.closest('mark')) hideSelBar();
});
$('text-pane').addEventListener('scroll', () => {
  // A scroll that lands just as the bar opens (the click itself scrolled the pane) should not close it.
  if (!$('sel-bar').hidden && Date.now() - barShownAt > 250) hideSelBar();
});

function addHighlights(parts) {
  const made = [];
  for (const part of parts) {
    const full = doc.chapters[part.ch].paragraphs[part.p];
    const overlapping = marks.filter((m) => m.ch === part.ch && m.p === part.p && m.start < part.end && m.end > part.start);
    const start = Math.min(part.start, ...overlapping.map((m) => m.start));
    const end = Math.max(part.end, ...overlapping.map((m) => m.end));
    const note = overlapping.map((m) => m.note).filter(Boolean).join(' ');
    marks = marks.filter((m) => !overlapping.includes(m));
    const mark = { id: uid(), ch: part.ch, p: part.p, start, end, text: full.slice(start, end), note };
    marks.push(mark);
    made.push(mark);
  }
  window.getSelection().removeAllRanges();
  afterMarksChange();
  return made;
}

function afterMarksChange() {
  const scroll = $('text-pane').scrollTop;
  for (const para of $('text').querySelectorAll('.para')) {
    const p = Number(para.dataset.p);
    const body = para.querySelector('.ptext');
    if (body) fillPara(body, doc.chapters[pos.ch].paragraphs[p], marks.filter((m) => m.ch === pos.ch && m.p === p));
  }
  $('text-pane').scrollTop = scroll;
  renderNotes();
  saveState();
}

function focusNote(id) {
  showTab('notes');
  const card = $('notes').querySelector(`[data-id="${id}"]`);
  if (card) {
    card.scrollIntoView({ block: 'nearest' });
    card.querySelector('textarea').focus();
  }
}

$('sel-bar').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  const selection = pendingSelection;
  const mark = selectedMark;
  hideSelBar();
  if (act === 'highlight' && selection) addHighlights(selection);
  if (act === 'note') {
    const target = mark || (selection && addHighlights(selection)[0]);
    if (target) focusNote(target.id);
  }
  if (act === 'ask') {
    const src = mark || selection?.[0];
    if (src) {
      pendingQuote = { ch: src.ch, p: src.p, text: selection ? selection.map((s) => s.text).join(' ') : src.text };
      window.getSelection().removeAllRanges();
      renderQuote();
      showTab('chat');
      $('ask').focus();
    }
  }
  if (act === 'quiz') {
    const src = mark || selection?.[0];
    if (src) {
      window.getSelection().removeAllRanges();
      showTab('questions');
      askQuestions({ paragraph: { ch: src.ch, p: src.p } });
    }
  }
  if (act === 'remove' && mark) {
    marks = marks.filter((m) => m !== mark);
    afterMarksChange();
  }
});

// ---------- tabs ----------

function showTab(name) {
  for (const tab of ['chat', 'questions', 'notes']) {
    $(`tab-${tab}`).setAttribute('aria-selected', tab === name);
    $(`panel-${tab}`).hidden = tab !== name;
  }
}
for (const tab of ['chat', 'questions', 'notes']) $(`tab-${tab}`).addEventListener('click', () => showTab(tab));

// ---------- notes ----------

function renderNotes() {
  $('note-count').textContent = marks.length;
  const box = $('notes');
  if (!marks.length) {
    box.replaceChildren(el('p', { class: 'empty', text: 'Select text to highlight it, or write a note below.' }));
    return;
  }
  const sorted = [...marks].sort((a, b) => a.ch - b.ch || (a.p ?? -1) - (b.p ?? -1) || (a.start ?? 0) - (b.start ?? 0));
  const out = [];
  let lastCh = -1;
  for (const m of sorted) {
    if (m.ch !== lastCh) {
      out.push(el('div', { class: 'group-title', text: clip(doc.chapters[m.ch]?.title || '', 44) }));
      lastCh = m.ch;
    }
    const area = el('textarea', { rows: 2, placeholder: 'Add a note', 'aria-label': 'Note' });
    area.value = m.note || '';
    area.addEventListener('input', () => {
      m.note = area.value;
      // Update the highlight in place: rebuilding the paragraph here would swallow a click on it.
      $('text').querySelector(`mark[data-id="${m.id}"]`)?.classList.toggle('has-note', Boolean(m.note));
      saveState();
    });
    out.push(
      el('div', { class: 'note-card', 'data-id': m.id },
        el('button', { type: 'button', class: 'linkish where', text: m.p == null ? 'Chapter note' : `¶${m.p + 1}`, onclick: () => goTo(m.ch, m.p ?? 0) }),
        m.text ? el('p', { class: 'quote' }, el('span', { text: clip(m.text, 280) })) : null,
        area,
        el('div', { class: 'row' },
          m.text ? el('button', { type: 'button', class: 'btn btn-small', text: 'Ask', onclick: () => {
            pendingQuote = { ch: m.ch, p: m.p, text: m.text };
            renderQuote();
            showTab('chat');
            $('ask').focus();
          } }) : null,
          el('button', { type: 'button', class: 'btn btn-small', text: 'Remove', onclick: () => {
            marks = marks.filter((x) => x !== m);
            afterMarksChange();
          } }),
        ),
      ),
    );
  }
  box.replaceChildren(...out);
}

$('note-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('note').value.trim();
  if (!text) return;
  marks.push({ id: uid(), ch: pos.ch, p: null, text: '', note: text });
  $('note').value = '';
  renderNotes();
  saveState();
});

// ---------- companion ----------

const REF = /\(?\bch\.?\s*(\d+)(?:\s*,\s*¶\s*(\d+))?\)?/g;

function renderReply(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(REF)) {
    const ch = Number(m[1]) - 1;
    const p = m[2] ? Number(m[2]) - 1 : null;
    if (!doc.chapters[ch] || (p != null && !doc.chapters[ch].paragraphs[p])) continue;
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(el('button', { type: 'button', class: 'ref', text: placeLabel(ch, p), onclick: () => goTo(ch, p ?? 0) }));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function messageNode(m) {
  if (m.role === 'user') {
    return el('div', { class: 'msg user' }, m.quote ? el('span', { class: 'q', text: `“${clip(m.quote.text, 120)}”` }) : null, m.text);
  }
  return el('div', { class: `msg bot${m.error ? ' error' : ''}` },
    el('span', { class: 'who', text: m.demo ? 'Companion · demo reply' : 'Companion' }),
    ...(m.error ? [m.text] : renderReply(m.text)),
  );
}

const FOLD_AFTER = 6; // longer topics fold their earlier messages
const KEEP_VISIBLE = 4;

function renderThreads() {
  const box = $('threads');
  if (!threads.length) {
    box.replaceChildren(el('p', { class: 'empty', text: 'Ask about a passage, a theme, or a connection you have noticed.' }));
    return;
  }
  box.replaceChildren(
    ...threads.map((t) => {
      const isActive = t.id === activeThread;
      const fold = t.messages.length > FOLD_AFTER && !t.showAll;
      const shown = fold ? t.messages.slice(-KEEP_VISIBLE) : t.messages;
      const hiddenCount = t.messages.length - shown.length;
      const body = el('div', { class: 'thread-body', id: `thread-${t.id}` },
        t.messages.length > FOLD_AFTER
          ? el('button', {
              type: 'button', class: 'btn btn-small fold',
              text: fold ? `Show ${hiddenCount} earlier messages` : 'Hide earlier messages',
              onclick: () => { t.showAll = !t.showAll; renderThreads(); saveState(); },
            })
          : null,
        ...shown.map(messageNode),
        busy && isActive ? el('div', { class: 'msg bot pending', text: 'Thinking of a hint…' }) : null,
      );
      const head = el('button', {
        type: 'button', class: 'thread-head', 'aria-expanded': String(Boolean(t.open)), 'aria-controls': `thread-${t.id}`,
        onclick: () => {
          t.open = !t.open;
          if (t.open) activeThread = t.id;
          renderThreads();
          saveState();
        },
      },
        el('span', { class: 'chev', 'aria-hidden': 'true', text: '▸' }),
        el('span', { class: 't-title', text: t.title }),
        el('span', { class: 't-count', text: `${t.messages.length}` }),
      );
      return el('section', { class: `thread${t.open ? ' open' : ''}${isActive ? ' active' : ''}` }, head, body);
    }),
  );
  const open = box.querySelector('.thread.active.open .thread-body');
  if (open) open.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

function renderQuote() {
  $('quote-chip').hidden = !pendingQuote;
  if (pendingQuote) $('quote-text').textContent = `“${pendingQuote.text}”`;
}
$('quote-clear').addEventListener('click', () => { pendingQuote = null; renderQuote(); });

$('new-thread').addEventListener('click', () => {
  for (const t of threads) t.open = false;
  activeThread = null;
  renderThreads();
  saveState();
  $('ask').focus();
});

function apiText(m) {
  if (m.role !== 'user' || !m.quote) return m.text;
  return `[Selection at (ch ${m.quote.ch + 1}, ¶${m.quote.p + 1}): "${clip(m.quote.text, 600)}"]\n${m.text}`;
}

$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('ask').value.trim();
  if (text) sendMessage(text);
});

function apiMessages(thread) {
  const list = thread.messages.filter((m) => !m.error);
  // A topic opened from a question starts with the companion's question. The API needs the student
  // to speak first, so that question travels as a note on their first message instead.
  const lead = list[0]?.role === 'assistant' ? list.shift() : null;
  return list.map((m, i) => ({
    role: m.role,
    text: (lead && i === 0 ? `[The student is answering this question you set: "${lead.text}"]\n` : '') + apiText(m),
  }));
}

async function sendMessage(text) {
  if (busy) return;
  let thread = threads.find((t) => t.id === activeThread && t.open);
  if (!thread) {
    for (const t of threads) t.open = false; // starting a new topic collapses the others
    thread = { id: uid(), title: clip(text, 48), open: true, showAll: false, messages: [] };
    threads.push(thread);
    activeThread = thread.id;
  }
  const quote = pendingQuote;
  thread.messages.push({ role: 'user', text, quote });
  $('ask').value = '';
  pendingQuote = null;
  renderQuote();
  busy = true;
  renderThreads();
  saveState();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc: { title: doc.title, author: doc.author, chapters: doc.chapters },
        position: pos,
        quote,
        marks: marks.map(({ ch, p, text: t, note }) => ({ ch, p, text: t, note })),
        messages: apiMessages(thread),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The companion could not answer. Try again.');
    thread.messages.push({ role: 'assistant', text: data.text, demo: Boolean(data.demo) });
  } catch (error) {
    thread.messages.push({ role: 'assistant', text: error.message || 'The companion could not answer. Try again.', error: true });
  }
  busy = false;
  renderThreads();
  saveState();
}

// ---------- questions ----------

const KIND_LENSES = {
  literature: ['themes', 'examples', 'connections', 'close', 'character', 'imagery', 'structure'],
  academic: ['themes', 'examples', 'connections', 'close', 'argument', 'evidence', 'terms', 'assumptions'],
  general: ['themes', 'examples', 'connections', 'close'],
};
const LENS_LABELS = {
  mix: 'A mix', themes: 'Themes', examples: 'Examples', connections: 'Connections', close: 'Close reading',
  character: 'Character and voice', imagery: 'Imagery and language', structure: 'Structure',
  argument: 'The argument', evidence: 'Evidence', terms: 'Key terms', assumptions: 'Assumptions and limits',
};
const LEVELS = ['notice', 'interpret', 'connect'];
const STEP_LABELS = ['Wide view', 'Closer', 'Closest']; // each set of three runs broad to specific
const LEVEL_LABELS = { notice: 'Notice', interpret: 'Interpret', connect: 'Connect' };
const lensLabel = (lens) => (lens === 'themes' && kind === 'academic' ? 'Main ideas' : LENS_LABELS[lens] || 'Themes');
const docPayload = () => ({ title: doc.title, author: doc.author, chapters: doc.chapters });
const answering = new Set(); // ids of questions waiting for a reply
let optionsOpen = false;

async function classify(d) {
  try {
    const res = await fetch('/api/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: { title: d.title, author: d.author, chapters: d.chapters } }),
    });
    const data = await res.json();
    if (doc !== d || kind) return; // the student moved on, or already chose
    kind = KIND_LENSES[data.kind] ? data.kind : 'general';
  } catch {
    if (doc !== d || kind) return;
    kind = 'general';
  }
  renderQuestionSetup();
  saveState();
}

function chipRow(box, items, current, onPick) {
  box.replaceChildren(
    ...items.map(([value, label]) =>
      el('button', { type: 'button', class: 'chip', 'aria-pressed': String(value === current), text: label, onclick: () => onPick(value) }),
    ),
  );
}

// The one button asks straight away with the saved options. The options stay folded unless wanted.
function renderQuestionSetup() {
  const lenses = KIND_LENSES[kind || 'general'];
  if (qPrefs.lens !== 'mix' && !lenses.includes(qPrefs.lens)) qPrefs.lens = 'mix';
  $('kind').value = kind || 'general';
  $('q-scope').value = qPrefs.scope;
  chipRow($('lenses'), [['mix', 'A mix'], ...lenses.map((l) => [l, lensLabel(l)])], qPrefs.lens, (v) => { qPrefs.lens = v; renderQuestionSetup(); saveState(); });
  chipRow($('levels'), LEVELS.map((l) => [l, LEVEL_LABELS[l]]), qPrefs.level, (v) => { qPrefs.level = v; renderQuestionSetup(); saveState(); });
  $('q-go').disabled = qBusy;
  $('q-go').textContent = qPrefs.scope === 'read' ? 'Ask me about what I have read' : 'Ask me about this chapter';
  $('q-options').hidden = !optionsOpen;
  $('q-options-toggle').setAttribute('aria-expanded', String(optionsOpen));
  $('q-options-toggle').textContent = optionsOpen ? 'Hide options' : 'Options';
}
$('kind').addEventListener('change', (e) => { kind = e.target.value; renderQuestionSetup(); renderQuestions(); saveState(); });
$('q-scope').addEventListener('change', (e) => { qPrefs.scope = e.target.value; renderQuestionSetup(); saveState(); });
$('q-go').addEventListener('click', () => askQuestions());
$('q-options-toggle').addEventListener('click', () => { optionsOpen = !optionsOpen; renderQuestionSetup(); });

// opts can override the saved options for one request: { lens, level, exclude, paragraph }
async function askQuestions(opts = {}) {
  if (qBusy) return;
  qBusy = true;
  renderQuestionSetup();
  renderQuestions();
  const lens = opts.lens || qPrefs.lens;
  const level = opts.level || qPrefs.level;
  const status = $('q-status');
  status.className = 'status';
  status.textContent = 'Reading for good questions…';
  try {
    const res = await fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc: docPayload(),
        kind: kind || 'general',
        lens,
        level,
        exclude: opts.exclude,
        chapters: qPrefs.scope === 'read' ? visited : [pos.ch],
        position: pos,
        paragraph: opts.paragraph,
        focus: $('q-focus').value.trim(),
        avoid: questions.slice(0, 20).map((q) => q.question),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No questions came back. Try again.');
    const batch = uid();
    const fresh = data.questions.map((q, i) => ({
      ...q, id: uid(), batch, step: i + 1, level, asked: lens, paragraph: opts.paragraph || null, demo: Boolean(data.demo), messages: [],
    }));
    questions = [...fresh, ...questions].slice(0, 30);
    status.textContent = '';
    $('panel-questions').scrollTop = 0;
  } catch (error) {
    status.className = 'status error';
    status.textContent = error.message || 'No questions came back. Try again.';
  }
  qBusy = false;
  renderQuestionSetup();
  renderQuestions();
  saveState();
}

// The student answers on the card. The companion replies under it, by the same hints-only rules as the chat.
async function answerQuestion(q, text) {
  if (!text || answering.has(q.id)) return;
  q.messages = q.messages || [];
  q.messages.push({ role: 'user', text });
  q.draft = '';
  q.open = true;
  answering.add(q.id);
  renderQuestions(q.id);
  saveState();
  const note = `[The student is answering this prompt you set about (ch ${q.ch + 1}, ¶${q.p + 1}): "${fullQuestion(q)}"]\n`;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc: docPayload(),
        position: pos,
        quote: null,
        marks: marks.map(({ ch, p, text: t, note: n }) => ({ ch, p, text: t, note: n })),
        messages: q.messages.filter((m) => !m.error).map((m, i) => ({ role: m.role, text: (i === 0 ? note : '') + m.text })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The companion could not answer. Try again.');
    q.messages.push({ role: 'assistant', text: data.text, demo: Boolean(data.demo) });
  } catch (error) {
    q.messages.push({ role: 'assistant', text: error.message || 'The companion could not answer. Try again.', error: true });
  }
  answering.delete(q.id);
  renderQuestions(q.id);
  saveState();
}

// Where to look, what to notice, then the question. Older saved questions only have the last part.
const fullQuestion = (q) => [q.where, q.notice, q.question].filter(Boolean).join(' ');

function questionCard(q) {
  const para = doc.chapters[q.ch]?.paragraphs[q.p] || '';
  const count = (q.messages || []).length;
  const input = el('input', { type: 'text', autocomplete: 'off', placeholder: 'Write your answer', 'aria-label': 'Your answer' });
  input.value = q.draft || '';
  input.addEventListener('input', () => { q.draft = input.value; });
  const menu = el('details', { class: 'q-menu' },
    el('summary', { 'aria-label': 'More' }, '⋯'),
    el('div', { class: 'q-menu-items' },
      el('button', { type: 'button', text: 'Hint', onclick: () => answerQuestion(q, 'Can I have a hint?') }),
      el('button', { type: 'button', text: 'Save to notes', onclick: () => {
        marks.push({ id: uid(), ch: q.ch, p: q.p, text: '', note: `Question: ${fullQuestion(q)}` });
        menu.open = false;
        $('q-status').className = 'status';
        $('q-status').textContent = 'Saved to notes.';
        renderNotes();
        saveState();
      } }),
      el('button', { type: 'button', text: 'Remove', onclick: () => { questions = questions.filter((x) => x !== q); renderQuestions(); saveState(); } }),
    ),
  );
  return el('div', { class: 'q-card', 'data-id': q.id },
    el('span', { class: 'q-tag', text: `${q.step ? `${q.step} of 3 · ${STEP_LABELS[q.step - 1] || ''} · ` : ''}${lensLabel(q.lens)} · ${LEVEL_LABELS[q.level] || 'Notice'}${q.demo ? ' · demo' : ''}` }),
    el('p', { class: 'q-lead' }, ...renderReply(q.where || `Look at ${placeLabel(q.ch, q.p)}.`)),
    el('div', { class: 'q-where' },
      el('strong', { text: placeLabel(q.ch, q.p) }),
      el('span', { text: `“${clip(para.replace(/\s+/g, ' '), 90)}”` }),
    ),
    q.notice ? el('p', { class: 'q-notice' }, ...renderReply(q.notice)) : null,
    el('p', { class: 'q-text' }, ...renderReply(q.question)),
    el('div', { class: 'q-buttons' },
      el('button', { type: 'button', class: 'btn btn-small go', text: 'Go to passage', onclick: () => goTo(q.ch, q.p) }),
      el('button', {
        type: 'button', class: 'btn btn-small', 'aria-expanded': String(Boolean(q.open)),
        text: q.open ? 'Close' : count ? `Answer · ${count}` : 'Answer',
        onclick: () => { q.open = !q.open; renderQuestions(q.open ? q.id : null); saveState(); },
      }),
      menu,
    ),
    q.open
      ? el('div', { class: 'q-answer' },
          ...(q.messages || []).map(messageNode),
          answering.has(q.id) ? el('div', { class: 'msg bot pending', text: 'Thinking of a hint…' }) : null,
          el('form', { class: 'composer-row', onsubmit: (e) => { e.preventDefault(); answerQuestion(q, input.value.trim()); } },
            input,
            el('button', { type: 'submit', class: 'btn btn-solid btn-send', 'aria-label': 'Send answer', text: '↑' }),
          ),
        )
      : null,
  );
}

// After a set of questions, the student steers the next set by reacting to this one.
function followUps(latest) {
  const first = latest[0];
  const used = [...new Set(latest.map((q) => q.lens))];
  const base = { level: first.level, lens: first.asked || 'mix', paragraph: first.paragraph || undefined };
  const next = LEVELS[LEVELS.indexOf(first.level) + 1];
  const chip = (text, opts) => el('button', { type: 'button', class: 'chip', text, disabled: qBusy, onclick: () => askQuestions(opts) });
  return el('div', { class: 'q-follow' },
    el('span', { class: 'q-tag', text: 'Next' }),
    el('div', { class: 'chips' },
      next ? chip('Harder', { ...base, level: next }) : null,
      ...(base.lens === 'mix' ? used.slice(0, 3).map((l) => chip(`More on ${lensLabel(l).toLowerCase()}`, { ...base, lens: l })) : []),
      chip('More like this', base),
      chip('Something else', { ...base, lens: 'mix', exclude: used }),
    ),
  );
}

function renderQuestions(focusId) {
  const box = $('questions');
  if (!questions.length) {
    box.replaceChildren(el('p', { class: 'empty', text: 'One click gives you three questions on the chapter you are reading. Each one tells you which passage it is about.' }));
    return;
  }
  const batch = questions[0].batch;
  const latest = batch ? questions.filter((q) => q.batch === batch) : [];
  const earlier = questions.filter((q) => !latest.includes(q));
  box.replaceChildren(
    ...latest.map(questionCard),
    latest.length ? followUps(latest) : null,
    earlier.length ? el('div', { class: 'group-title', text: 'Earlier questions' }) : null,
    ...earlier.map(questionCard),
  );
  if (focusId) box.querySelector(`.q-card[data-id="${focusId}"] .q-answer input`)?.focus();
}

// ---------- export ----------

$('export').addEventListener('click', () => {
  $('export-error').textContent = '';
  $('export-dialog').showModal();
});
$('export-cancel').addEventListener('click', () => $('export-dialog').close());

function buildPrint(withText, withMarks) {
  const root = $('print-root');
  const out = [
    el('h1', { text: doc.title }),
    doc.author ? el('div', { class: 'p-author', text: doc.author }) : null,
    doc.rights ? el('div', { class: 'p-rights', text: doc.rights }) : null,
  ];
  if (withText) {
    doc.chapters.forEach((c, ci) => {
      out.push(el('h2', { text: c.title }));
      c.paragraphs.forEach((p, pi) => {
        const table = tableNode(ci, pi);
        const node = table || el('p');
        if (!table) fillPara(node, p, withMarks ? marks.filter((m) => m.ch === ci && m.p === pi) : []);
        out.push(node);
      });
    });
  }
  if (withMarks) {
    const section = el('div', { class: withText ? 'p-section' : '' }, el('h2', { text: 'Highlights and notes' }));
    const sorted = [...marks].sort((a, b) => a.ch - b.ch || (a.p ?? -1) - (b.p ?? -1) || (a.start ?? 0) - (b.start ?? 0));
    if (!sorted.length) section.append(el('p', { text: 'No highlights or notes yet.' }));
    let lastCh = -1;
    for (const m of sorted) {
      if (m.ch !== lastCh) {
        section.append(el('h3', { text: doc.chapters[m.ch]?.title || '' }));
        lastCh = m.ch;
      }
      section.append(
        el('div', { class: 'p-item' },
          el('div', { class: 'p-where', text: m.p == null ? 'Chapter note' : `Paragraph ${m.p + 1}` }),
          m.text ? el('p', {}, el('mark', { text: m.text })) : null,
          m.note ? el('div', { class: 'p-note', text: m.note }) : null,
        ),
      );
    }
    out.push(section);
    const answered = questions.filter((q) => (q.messages || []).some((m) => m.role === 'user'));
    if (answered.length) {
      const qa = el('div', { class: 'p-section' }, el('h2', { text: 'Questions and answers' }));
      for (const q of answered) {
        qa.append(
          el('div', { class: 'p-item' },
            el('div', { class: 'p-where', text: `${doc.chapters[q.ch]?.title || ''} · paragraph ${q.p + 1}` }),
            el('p', {}, [q.where, q.notice].filter(Boolean).join(' '), ' ', el('strong', { text: q.question })),
            ...q.messages.filter((m) => !m.error).map((m) => el('div', { class: 'p-note', text: `${m.role === 'user' ? 'Me' : 'Companion'}: ${m.text}` })),
          ),
        );
      }
      out.push(qa);
    }
  }
  root.replaceChildren(...out.filter(Boolean));
}

$('export-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const withText = $('exp-text').checked;
  const withMarks = $('exp-marks').checked;
  if (!withText && !withMarks) {
    $('export-error').className = 'status error';
    $('export-error').textContent = 'Choose at least one.';
    return;
  }
  $('export-dialog').close();
  buildPrint(withText, withMarks);
  const title = document.title;
  document.title = `${doc.title} - Bookz`; // becomes the suggested PDF file name
  window.addEventListener('afterprint', () => {
    document.title = title;
    $('print-root').replaceChildren();
  }, { once: true });
  window.print();
});

// ---------- boot ----------

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => { $('demo-tag').hidden = h.live; $('demo-tag-q').hidden = h.live; })
  .catch(() => {});
refreshRecent();
