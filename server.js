import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { SAMPLE_ID, SAMPLE_OPENINGS } from './lib/sample-openings.js';
import { TEXTS, RUNS, runCase, formatCase } from './lib/selftest.js';
import {
  CLASSIFY_INSTRUCTIONS, QUESTION_INSTRUCTIONS, DISCUSS_INSTRUCTIONS, KINDS, KIND_LENSES,
  buildTextBlock, buildStudentContext, buildQuestionRequest,
} from './lib/prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.BOOKZ_MODEL || 'claude-sonnet-5-5';
const EFFORT = process.env.BOOKZ_EFFORT || 'medium'; // how hard the model thinks before a reply or an opening

// Without a key the app still runs: the companion returns clearly labelled demo replies.
const live = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = live ? new Anthropic() : null;

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/jszip', express.static(path.join(__dirname, 'node_modules/jszip/dist')));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));

app.get('/api/health', (_req, res) => res.json({ live, model: MODEL }));

/** An error that should reach the browser with this status and message. */
class Reply extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validDoc(doc) {
  return (
    doc &&
    typeof doc.title === 'string' &&
    Array.isArray(doc.chapters) &&
    doc.chapters.length > 0 &&
    doc.chapters.every(
      (c) => c && typeof c.title === 'string' && Array.isArray(c.paragraphs) && c.paragraphs.every((p) => typeof p === 'string'),
    )
  );
}

function sendError(res, error) {
  if (error instanceof Reply) {
    res.status(error.status).json({ error: error.message });
  } else if (error instanceof Anthropic.AuthenticationError) {
    res.status(502).json({ error: 'The API key was rejected. Check ANTHROPIC_API_KEY.' });
  } else if (error instanceof Anthropic.RateLimitError) {
    res.status(429).json({ error: 'The companion is busy. Try again in a moment.' });
  } else if (error instanceof Anthropic.APIError) {
    console.error(`Anthropic API error ${error.status}: ${error.message}`);
    res.status(502).json({ error: 'The companion could not answer. Try again.' });
  } else {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}

// ---------- the conversation ----------

// Placeholder replies shown until the API key is connected. They cannot see the text.
const DEMO_TALK = [
  (ch) => `Which line makes you say that? Have another look at the first paragraph, (ch ${ch}, ¶1), and see whether it still fits.`,
  () => 'There is a sentence in this passage that seems to pull the other way. See if you can find the one I mean.',
  (ch) => `Try that against the second paragraph, (ch ${ch}, ¶2). The same idea comes back there in other words.`,
  () => 'You have got somewhere with this. How would you put what you now think in one sentence of your own? It is worth adding to your notes.',
];

async function chatReply({ doc, position, quote, marks, messages, read } = {}) {
  if (!validDoc(doc)) throw new Reply(400, 'No text was sent.');
  if (!Array.isArray(messages) || !messages.length || messages.at(-1).role !== 'user') {
    throw new Reply(400, 'No question was sent.');
  }
  const history = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-40);

  if (!live) {
    const turn = history.filter((m) => m.role === 'user').length;
    return { text: DEMO_TALK[(turn - 1) % DEMO_TALK.length]((position?.ch ?? 0) + 1), demo: true };
  }

  const focus = [position?.ch ?? 0, ...(quote ? [quote.ch] : []), ...(marks || []).map((m) => m.ch).reverse()];
  const context = buildStudentContext({ doc, position, quote, marks, read: Array.isArray(read) ? read.filter(Number.isInteger) : [] });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 3000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: EFFORT },
    // The text comes first and is cached, so replies and openings share one cached copy.
    system: [
      { type: 'text', text: buildTextBlock(doc, focus), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: DISCUSS_INSTRUCTIONS },
    ],
    messages: history.map((m, i) => ({
      role: m.role,
      // The student's current context rides with their latest message, so the cached text stays untouched.
      content: i === history.length - 1 ? `${context}\n\n${m.text}` : m.text,
    })),
  });
  if (response.stop_reason === 'refusal') {
    return { text: 'I can’t help with that one. Try asking about a passage in the text.' };
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text: text || 'Try asking that another way.' };
}

app.post('/api/chat', async (req, res) => {
  try {
    res.json(await chatReply(req.body));
  } catch (error) {
    sendError(res, error);
  }
});

// ---------- classify the text ----------

function guessKind(doc) {
  const sample = doc.chapters.slice(0, 6).map((c) => `${c.title} ${c.paragraphs.slice(0, 8).join(' ')}`).join(' ').toLowerCase();
  const hits = (sample.match(/\b(abstract|et al\.|hypothes[ie]s|methodology|references|figure \d|table \d|this (paper|study|chapter) |literature review|data)\b/g) || []).length;
  return hits >= 4 ? 'academic' : 'literature';
}

app.post('/api/classify', async (req, res) => {
  const { doc } = req.body || {};
  if (!validDoc(doc)) return res.status(400).json({ error: 'No text was sent.' });
  if (!live) return res.json({ kind: guessKind(doc), demo: true });
  // A sample is enough to tell: the title, the chapter list and the opening of a few chapters.
  const picks = [0, Math.floor(doc.chapters.length / 2), doc.chapters.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  const sample = [
    `Title: ${doc.title}`,
    doc.author ? `Author: ${doc.author}` : '',
    `Chapters: ${doc.chapters.slice(0, 40).map((c) => c.title).join(' | ')}`,
    ...picks.map((i) => `From "${doc.chapters[i].title}":\n${doc.chapters[i].paragraphs.join('\n').slice(0, 2500)}`),
  ].filter(Boolean).join('\n\n');
  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 1000,
      output_config: { effort: 'low', format: zodOutputFormat(z.object({ kind: z.enum(KINDS) })) },
      system: CLASSIFY_INSTRUCTIONS,
      messages: [{ role: 'user', content: sample }],
    });
    res.json({ kind: response.parsed_output?.kind || guessKind(doc) });
  } catch (error) {
    console.error(error);
    res.json({ kind: guessKind(doc) }); // never block reading on this
  }
});

// ---------- the companion opens a conversation ----------

const Opening = z.object({
  questions: z.array(z.object({ where: z.string(), notice: z.string(), question: z.string(), ch: z.number().int(), p: z.number().int(), lens: z.string() })),
});

// Placeholder openings shown until the API key is connected. They cannot see the text, so they stay general.
const DEMO_QUESTIONS = [
  ['It is not obvious who these lines are written for. The wording gives a few clues, and they do not all point the same way.', 'Which words tell you who is being spoken to here?'],
  ['This paragraph reads as if it is answering an objection, but the objection is never stated.', 'Going by what the paragraph bothers to defend, what do you think the objection is?'],
  ['The passage states its main point with confidence and gives very little to back it.', 'What would you want to be shown before you accepted it?'],
  ['The way this passage opens and the way it ends do not quite match.', 'Where would you say it turns?'],
];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const demoWhere = (doc, ch, p, open) => {
  const count = doc.chapters[ch].paragraphs.length;
  const which = p === count - 1 && count > 1 ? 'the last paragraph' : p < ORDINALS.length ? `the ${ORDINALS[p]} paragraph` : `paragraph ${p + 1}`;
  return `Read ${which}${ch === open ? '' : ` of ${doc.chapters[ch].title}`} again.`;
};

async function openingFor({ doc, docId, kind, lens, level, chapters, paragraph, focus, avoid, exclude, position, marks } = {}) {
  if (!validDoc(doc)) throw new Reply(400, 'No text was sent.');
  const marked = (Array.isArray(marks) ? marks : []).filter((m) => m && Number.isInteger(m.ch) && Number.isInteger(m.p));
  const excluded = Array.isArray(exclude) ? exclude : [];
  const asked = Array.isArray(avoid) ? avoid : [];
  const open = Number.isInteger(position?.ch) ? position.ch : -1;
  const hasPara = (c, p) => Number.isInteger(c) && Number.isInteger(p) && Boolean(doc.chapters[c]?.paragraphs[p]);
  const para = paragraph && hasPara(paragraph.ch, paragraph.p) ? { ch: paragraph.ch, p: paragraph.p } : null;
  const read = [...new Set((Array.isArray(chapters) ? chapters : []).filter((c) => Number.isInteger(c) && doc.chapters[c]))].sort((a, b) => a - b);
  if (!para && !read.length) throw new Reply(400, 'Open a chapter first.');
  const allowed = (c, p) => hasPara(c, p) && (para ? c === para.ch && p === para.p : read.includes(c));
  const lenses = KIND_LENSES[KINDS.includes(kind) ? kind : 'general'];

  if (!live) {
    // The bundled sample has hand-written openings, so it shows what a real one looks like without a key.
    if (docId === SAMPLE_ID) {
      const targets = para ? [para.ch] : [...read].reverse();
      const pool = targets.flatMap((ch) => (SAMPLE_OPENINGS[ch] || []).map((o) => ({ ...o, ch })));
      const fits = pool.filter((o) => !asked.includes(o.question) && (!para || o.p === para.p) && hasPara(o.ch, o.p));
      const pick = fits.find((o) => marked.some((m) => m.ch === o.ch && m.p === o.p)) || fits.find((o) => o.lens === lens) || fits.find((o) => !excluded.includes(o.lens)) || fits[0];
      if (pick) return { questions: [pick], demo: true };
    }
    const [notice, question] = DEMO_QUESTIONS[asked.length % DEMO_QUESTIONS.length];
    const ch = para ? para.ch : read[read.length - 1];
    const count = doc.chapters[ch].paragraphs.length;
    const p = para ? para.p : Math.floor(count / 4 + asked.length) % count;
    const pool = lenses.filter((l) => !excluded.includes(l));
    return {
      questions: [{ generic: true, where: demoWhere(doc, ch, p, open), notice, question, ch, p, lens: lenses.includes(lens) ? lens : (pool.length ? pool : lenses)[0] }],
      demo: true,
    };
  }

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 6000,
    output_config: { effort: EFFORT, format: zodOutputFormat(Opening) },
    system: [
      { type: 'text', text: buildTextBlock(doc, para ? [para.ch] : [...read].reverse()), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: QUESTION_INSTRUCTIONS },
    ],
    messages: [{ role: 'user', content: buildQuestionRequest({ doc, kind, lens, level, chapters: read, paragraph: para, focus, avoid: asked, exclude: excluded, open, marks: marked }) }],
  });
  // The model writes 1-based numbers, as shown in the text. Drop anything outside what the student has read.
  const questions = (response.parsed_output?.questions || [])
    .map((q) => ({ where: q.where.trim(), notice: q.notice.trim(), question: q.question.trim(), ch: q.ch - 1, p: q.p - 1, lens: lenses.includes(q.lens) ? q.lens : 'themes' }))
    .filter((q) => q.question && allowed(q.ch, q.p))
    .slice(0, 1);
  if (!questions.length) throw new Reply(502, 'Nothing came back. Try again.');
  return { questions };
}

app.post('/api/questions', async (req, res) => {
  try {
    res.json(await openingFor(req.body));
  } catch (error) {
    sendError(res, error);
  }
});

// ---------- self-test ----------
// Runs one fixed case from lib/selftest.js against the live model and returns the transcript as text,
// so the companion's real replies can be read on a deployment. Each request costs a few model calls.
// Set BOOKZ_SELFTEST=off to remove it.

app.get('/api/selftest', async (req, res) => {
  if (process.env.BOOKZ_SELFTEST === 'off') return res.status(404).type('text').send('Not found');
  const { text, run } = req.query;
  if (!text || !run) {
    return res.type('text').send(`Add ?text=<text>&run=<run>\nTexts: ${Object.keys(TEXTS).join(', ')}\nRuns: ${RUNS.join(', ')}\nModel: ${MODEL} · ${live ? 'live' : 'demo mode (no API key)'}`);
  }
  try {
    const result = await runCase(String(text), String(run), { questions: openingFor, chat: chatReply });
    res.type('text').send(formatCase(result));
  } catch (error) {
    const detail = error instanceof Anthropic.APIError ? `Anthropic API error ${error.status}: ${error.message}` : error.message;
    res.status(error instanceof Reply ? error.status : 500).type('text').send(`FAILED: ${detail}`);
  }
});

app.listen(PORT, () => {
  console.log(`Bookz is running at http://localhost:${PORT}`);
  console.log(live ? `Companion: ${MODEL}` : 'Companion: demo replies (set ANTHROPIC_API_KEY to connect Sonnet)');
});
