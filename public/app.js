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
    localStorage.setItem(`bookz:state:${doc.id}`, JSON.stringify({ ch: pos.ch, marks, kind, visited, questions, qPrefs }));
  } catch { /* storage full or blocked: state lasts for this visit only */ }
}

// ---------- state ----------

let doc = null;
let pos = { ch: 0 };
let marks = []; // { id, ch, p, start, end, text, note }  (p == null: a note on the chapter)
let pendingQuote = null; // { ch, p, text }
let pendingSelection = null; // [{ ch, p, start, end, text }]
let selectedMark = null;
let kind = null; // 'literature' | 'academic' | 'general', set automatically and changeable
let visited = []; // chapters the student has opened; questions only draw on these
let questions = []; // conversations, newest first: { id, started: 'companion' | 'student', ch, p, where, notice, question, lens, messages }
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
  pendingQuote = null;
  kind = saved.kind || null;
  visited = saved.visited || [];
  questions = saved.questions || [];
  // Topics from the old Companion tab become conversations, so nothing the student wrote is lost.
  for (const t of saved.threads || []) {
    const msgs = (t.messages || []).filter((m) => !m.error);
    if (!msgs.some((m) => m.role === 'user')) continue;
    const lead = msgs[0].role === 'assistant' ? msgs.shift() : null;
    questions.push({ id: uid(), started: lead ? 'companion' : 'student', ch: msgs[0].quote?.ch ?? pos.ch, p: msgs[0].quote?.p ?? null, notice: lead ? lead.text : '', question: lead ? '' : t.title || clip(msgs[0].text, 90), messages: msgs });
  }
  startFresh = false;
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
  renderNotes();
  renderQuote();
  renderQuestionSetup();
  renderQuestions();
  renderComposer();
  showTab('questions', false);
  setSheet(false);
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
  if (p != null && onPhone()) setSheet(false); // show the passage; the handle brings the conversation back
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
      showTab('questions');
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

const onPhone = () => window.matchMedia('(max-width: 900px)').matches;

// On a phone the side panel is a sheet that slides up over the text and tucks away again.
function setSheet(open) {
  $('side').classList.toggle('open', open);
  $('sheet-handle').setAttribute('aria-expanded', String(open));
  $('sheet-label').textContent = open ? 'Back to the text' : 'Discuss and notes';
}
$('sheet-handle').addEventListener('click', () => setSheet(!$('side').classList.contains('open')));

function showTab(name, reveal = true) {
  for (const tab of ['questions', 'notes']) {
    $(`tab-${tab}`).setAttribute('aria-selected', tab === name);
    $(`panel-${tab}`).hidden = tab !== name;
  }
  if (reveal && onPhone()) setSheet(true);
}
for (const tab of ['questions', 'notes']) $(`tab-${tab}`).addEventListener('click', () => showTab(tab));

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
            showTab('questions');
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

// ---------- conversations ----------
// One place to talk about the text. The companion can open ("Start a conversation") or the
// student can ("Ask..."). Either way it is the same conversation, held by the same rules.

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
const LEVEL_LABELS = { notice: 'Notice', interpret: 'Interpret', connect: 'Connect' };
const lensLabel = (lens) => (lens === 'themes' && kind === 'academic' ? 'Main ideas' : LENS_LABELS[lens] || 'Themes');
const docPayload = () => ({ title: doc.title, author: doc.author, chapters: doc.chapters });
const marksPayload = () => marks.map(({ ch, p, text, note }) => ({ ch, p, text, note }));
const answering = new Set(); // ids of conversations waiting for a reply
let optionsOpen = false;
let startFresh = false; // the next message from the student starts a new conversation

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

function renderQuestionSetup() {
  const lenses = KIND_LENSES[kind || 'general'];
  if (qPrefs.lens !== 'mix' && !lenses.includes(qPrefs.lens)) qPrefs.lens = 'mix';
  $('kind').value = kind || 'general';
  $('q-scope').value = qPrefs.scope;
  chipRow($('lenses'), [['mix', 'A mix'], ...lenses.map((l) => [l, lensLabel(l)])], qPrefs.lens, (v) => { qPrefs.lens = v; renderQuestionSetup(); saveState(); });
  chipRow($('levels'), LEVELS.map((l) => [l, LEVEL_LABELS[l]]), qPrefs.level, (v) => { qPrefs.level = v; renderQuestionSetup(); saveState(); });
  $('q-go').disabled = qBusy;
  $('q-go').textContent = (questions.length ? 'Start one for me about ' : 'Start a conversation about ') + (qPrefs.scope === 'read' ? 'what I have read' : 'this chapter');
  $('q-go').className = questions.length ? 'btn btn-outline' : 'btn btn-solid';
  $('q-options').hidden = !optionsOpen;
  $('q-options-toggle').setAttribute('aria-expanded', String(optionsOpen));
  $('q-options-toggle').textContent = optionsOpen ? 'Hide options' : 'Options';
}
$('kind').addEventListener('change', (e) => { kind = e.target.value; renderQuestionSetup(); renderQuestions(); saveState(); });
$('q-scope').addEventListener('change', (e) => { qPrefs.scope = e.target.value; renderQuestionSetup(); saveState(); });
$('q-go').addEventListener('click', () => askQuestions());
$('q-options-toggle').addEventListener('click', () => { optionsOpen = !optionsOpen; renderQuestionSetup(); });

// Conversations the student has replied to are never dropped; unanswered openings are, past a limit.
function trimConversations() {
  let spare = 0;
  questions = questions.filter((q) => (q.messages || []).length || spare++ < 15);
}

// The companion opens. opts can override the saved options once: { lens, level, exclude, paragraph }
async function askQuestions(opts = {}) {
  if (qBusy) return;
  qBusy = true;
  renderQuestionSetup();
  renderQuestions();
  const lens = opts.lens || qPrefs.lens;
  const level = opts.level || qPrefs.level;
  const status = $('q-status');
  status.className = 'status';
  status.textContent = 'Reading for something worth talking about…';
  try {
    const res = await fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc: docPayload(),
        docId: doc.id,
        kind: kind || 'general',
        lens,
        level,
        exclude: opts.exclude,
        chapters: qPrefs.scope === 'read' ? visited : [pos.ch],
        position: pos,
        paragraph: opts.paragraph,
        marks: marksPayload(),
        focus: $('q-focus').value.trim(),
        avoid: questions.filter((q) => q.started !== 'student').slice(0, 20).map((q) => q.question),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Nothing came back. Try again.');
    const fresh = data.questions.map((q) => ({
      ...q, id: uid(), started: 'companion', level, asked: lens, paragraph: opts.paragraph || null, demo: Boolean(data.demo), messages: [],
    }));
    questions = [...fresh, ...questions];
    trimConversations();
    startFresh = false;
    status.textContent = '';
    $('questions').scrollTop = 0;
  } catch (error) {
    status.className = 'status error';
    status.textContent = error.message || 'Nothing came back. Try again.';
  }
  qBusy = false;
  renderQuestionSetup();
  renderQuestions();
  renderComposer();
  saveState();
}

const fullQuestion = (q) => [q.where, q.notice, q.question].filter(Boolean).join(' ');

function apiMessages(q) {
  const opened = q.started !== 'student' && fullQuestion(q)
    ? `[You opened this conversation about (ch ${q.ch + 1}, ¶${q.p + 1}) by saying: "${fullQuestion(q)}"]\n`
    : '';
  return q.messages.filter((m) => !m.error).map((m, i) => {
    const sel = m.quote ? `[Selection at (ch ${m.quote.ch + 1}, ¶${m.quote.p + 1}): "${clip(m.quote.text, 600)}"]\n` : '';
    return { role: m.role, text: (i === 0 ? opened : '') + sel + m.text };
  });
}

// The student speaks: a reply in the current conversation, or the first line of a new one.
async function sendMessage(text) {
  if (!text) return;
  let q = startFresh ? null : questions[0];
  if (q && answering.has(q.id)) return;
  const quote = pendingQuote;
  if (!q) {
    q = { id: uid(), started: 'student', ch: quote ? quote.ch : pos.ch, p: quote ? quote.p : null, question: clip(text, 90), messages: [] };
    questions.unshift(q);
    startFresh = false;
  }
  q.messages.push({ role: 'user', text, quote });
  pendingQuote = null;
  $('ask').value = '';
  growComposer();
  answering.add(q.id);
  renderQuote();
  renderQuestionSetup();
  renderQuestions(true);
  renderComposer();
  saveState();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: docPayload(), position: pos, quote, marks: marksPayload(), messages: apiMessages(q) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The companion could not answer. Try again.');
    q.messages.push({ role: 'assistant', text: data.text, demo: Boolean(data.demo) });
  } catch (error) {
    q.messages.push({ role: 'assistant', text: error.message || 'The companion could not answer. Try again.', error: true });
  }
  answering.delete(q.id);
  renderQuestions(questions[0] === q);
  saveState();
}

function talkNode(q, current) {
  if (!current) {
    // Earlier conversations fold to one line. Opening one brings it back to the top to carry on.
    return el('button', {
      type: 'button', class: 'talk-row', 'data-id': q.id,
      onclick: () => { questions = [q, ...questions.filter((x) => x !== q)]; startFresh = false; renderQuestions(true); renderComposer(); saveState(); },
    },
      el('span', { class: 'chev', 'aria-hidden': 'true', text: '▸' }),
      el('span', { class: 't-title', text: q.question || 'Conversation' }),
    );
  }
  const mine = q.started === 'student';
  const menu = el('details', { class: 'q-menu' },
    el('summary', { 'aria-label': 'More' }, '⋯'),
    el('div', { class: 'q-menu-items' },
      mine ? null : el('button', { type: 'button', text: 'Save to notes', onclick: () => {
        marks.push({ id: uid(), ch: q.ch, p: q.p, text: '', note: `From a conversation: ${fullQuestion(q)}` });
        menu.open = false;
        $('q-status').className = 'status';
        $('q-status').textContent = 'Saved to notes.';
        renderNotes();
        saveState();
      } }),
      el('button', { type: 'button', text: 'Remove', onclick: () => { questions = questions.filter((x) => x !== q); renderQuestionSetup(); renderQuestions(); renderComposer(); saveState(); } }),
    ),
  );
  return el('article', { class: 'talk', 'data-id': q.id },
    el('div', { class: 'talk-head' },
      q.p != null
        ? el('button', { type: 'button', class: 'ref', text: `${placeLabel(q.ch, q.p)} →`, 'aria-label': `Go to ${placeLabel(q.ch, q.p)}`, onclick: () => goTo(q.ch, q.p) })
        : el('span', { class: 'q-tag', text: clip(doc.chapters[q.ch]?.title || '', 40) }),
      menu,
    ),
    mine ? null : el('p', { class: 'talk-say' }, ...renderReply([q.where, q.notice].filter(Boolean).join(' '))),
    mine ? null : el('p', { class: 'talk-ask' }, ...renderReply(q.question)),
    q.generic ? el('p', { class: 'talk-note', text: 'This is a placeholder that has not read your text. Connect the API key for a conversation about what it actually says.' }) : null,
    ...(q.messages || []).map((m) =>
      m.role === 'user'
        ? el('div', { class: 'msg user' }, m.quote ? el('span', { class: 'q', text: `“${clip(m.quote.text, 120)}”` }) : null, m.text)
        : el('div', { class: `msg bot${m.error ? ' error' : ''}` }, ...(m.error ? [m.text] : renderReply(m.text))),
    ),
    answering.has(q.id) ? el('div', { class: 'msg bot pending', text: 'Thinking…' }) : null,
  );
}

// Under a conversation the companion opened: quiet ways to have it open a different one.
function followUps(q) {
  if (q.started === 'student' || !q.lens) return null;
  const base = { level: q.level, paragraph: q.paragraph || undefined };
  const link = (text, opts) => el('button', { type: 'button', class: 'linkish', text, disabled: qBusy, onclick: () => askQuestions(opts) });
  return el('div', { class: 'q-follow' },
    el('span', { text: 'Start another:' }),
    link(`more on ${lensLabel(q.lens).toLowerCase()}`, { ...base, lens: q.lens }),
    link('a different angle', { ...base, lens: 'mix', exclude: [q.lens] }),
  );
}

function renderQuestions(toEnd) {
  const box = $('questions');
  if (!questions.length) {
    box.replaceChildren(el('p', { class: 'empty', text: 'Ask anything about what you are reading, or let me start: I will pick a passage, say what I notice in it, and ask what you make of it.' }));
    return;
  }
  const [current, ...earlier] = questions;
  box.replaceChildren(
    startFresh ? el('p', { class: 'empty', text: 'Your next message starts a new conversation.' }) : talkNode(current, true),
    startFresh ? null : followUps(current),
    (startFresh ? questions : earlier).length ? el('div', { class: 'group-title', text: 'Earlier conversations' }) : null,
    ...(startFresh ? questions : earlier).map((q) => talkNode(q, false)),
  );
  if (toEnd) {
    const last = box.querySelector('.talk')?.lastElementChild;
    if (last) last.scrollIntoView({ block: 'nearest' });
  }
}

// ---------- composer ----------

function renderQuote() {
  $('quote-chip').hidden = !pendingQuote;
  if (pendingQuote) $('quote-text').textContent = `“${pendingQuote.text}”`;
}
$('quote-clear').addEventListener('click', () => { pendingQuote = null; renderQuote(); });

function renderComposer() {
  const fresh = startFresh || !questions.length;
  $('ask').placeholder = fresh ? 'Ask about the text, a theme or your notes' : 'Reply, or ask something else';
  $('new-topic').hidden = fresh;
}
function growComposer() {
  const box = $('ask');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 180)}px`;
}
$('ask').addEventListener('input', growComposer);
$('ask').addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter makes a new line.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('ask-form').requestSubmit();
  }
});
$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage($('ask').value.trim());
});
$('new-topic').addEventListener('click', () => {
  startFresh = true;
  renderQuestions();
  renderComposer();
  $('ask').focus();
});

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
      const qa = el('div', { class: 'p-section' }, el('h2', { text: 'Conversations' }));
      for (const q of answered) {
        qa.append(
          el('div', { class: 'p-item' },
            el('div', { class: 'p-where', text: `${doc.chapters[q.ch]?.title || ''}${q.p == null ? '' : ` · paragraph ${q.p + 1}`}` }),
            q.started === 'student' ? null : el('p', {}, [q.where, q.notice].filter(Boolean).join(' '), ' ', el('strong', { text: q.question })),
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
  .then((h) => { $('demo-tag-q').hidden = h.live; })
  .catch(() => {});
refreshRecent();
