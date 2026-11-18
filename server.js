import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  COMPANION_INSTRUCTIONS, CLASSIFY_INSTRUCTIONS, QUESTION_INSTRUCTIONS, KINDS, KIND_LENSES,
  buildTextBlock, buildStudentContext, buildQuestionRequest,
} from './lib/prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.BOOKZ_MODEL || 'claude-sonnet-5-5';

// Without a key the app still runs: the companion returns clearly labelled demo replies.
const live = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = live ? new Anthropic() : null;

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/jszip', express.static(path.join(__dirname, 'node_modules/jszip/dist')));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));

app.get('/api/health', (_req, res) => res.json({ live, model: MODEL }));

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

const DEMO_HINTS = [
  (ch) => `Read (ch ${ch}, ¶1) again slowly. Which single word carries the most weight?`,
  (ch) => `Put your last highlight beside (ch ${ch}, ¶2) and look at what repeats.`,
  () => 'Who is being spoken to here? Check whether that changes later in the chapter.',
  (ch) => `Look for where this idea first appears in (ch ${ch}). Mark it.`,
];

app.post('/api/chat', async (req, res) => {
  const { doc, position, quote, marks, messages } = req.body || {};
  if (!validDoc(doc)) return res.status(400).json({ error: 'No text was sent.' });
  if (!Array.isArray(messages) || !messages.length || messages.at(-1).role !== 'user') {
    return res.status(400).json({ error: 'No question was sent.' });
  }
  const history = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-40);

  if (!live) {
    const turn = history.filter((m) => m.role === 'user').length;
    const hint = DEMO_HINTS[(turn - 1) % DEMO_HINTS.length]((position?.ch ?? 0) + 1);
    return res.json({ text: hint, demo: true });
  }

  const focus = [position?.ch ?? 0, ...(quote ? [quote.ch] : []), ...(marks || []).map((m) => m.ch).reverse()];
  const context = buildStudentContext({ doc, position, quote, marks });
  const apiMessages = history.map((m, i) => ({
    role: m.role,
    // The student's current context rides with their latest message, so the cached text stays untouched.
    content: i === history.length - 1 ? `${context}\n\n${m.text}` : m.text,
  }));

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      // The text comes first and is cached, so chat and question requests share one cached copy.
      system: [
        { type: 'text', text: buildTextBlock(doc, focus), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: COMPANION_INSTRUCTIONS },
      ],
      messages: apiMessages,
    });
    if (response.stop_reason === 'refusal') {
      return res.json({ text: 'I can’t help with that one. Try asking about a passage in the text.' });
    }
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    res.json({ text: text || 'Try asking that another way.' });
  } catch (error) {
    sendApiError(res, error);
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

// ---------- questions mode ----------

const QuestionSet = z.object({
  questions: z.array(z.object({ question: z.string(), ch: z.number().int(), p: z.number().int(), lens: z.string() })),
});

const DEMO_QUESTIONS = {
  notice: ['What is repeated in this paragraph?', 'Who is being addressed here, and how can you tell?', 'What things are listed or contrasted here?'],
  interpret: ['Why might this paragraph open the way it does?', 'What is the last sentence here doing?', 'Which word here matters most, and why that word?'],
  connect: ['What does this paragraph share with the one before it?', 'Where else have you read something that sits beside this?', 'How does this change what came earlier in the chapter?'],
};

app.post('/api/questions', async (req, res) => {
  const { doc, kind, lens, level, chapters, paragraph, focus, avoid, exclude } = req.body || {};
  if (!validDoc(doc)) return res.status(400).json({ error: 'No text was sent.' });
  const hasPara = (c, p) => Number.isInteger(c) && Number.isInteger(p) && Boolean(doc.chapters[c]?.paragraphs[p]);
  const para = paragraph && hasPara(paragraph.ch, paragraph.p) ? { ch: paragraph.ch, p: paragraph.p } : null;
  const read = [...new Set((Array.isArray(chapters) ? chapters : []).filter((c) => Number.isInteger(c) && doc.chapters[c]))].sort((a, b) => a - b);
  if (!para && !read.length) return res.status(400).json({ error: 'Open a chapter first.' });
  const allowed = (c, p) => hasPara(c, p) && (para ? c === para.ch && p === para.p : read.includes(c));
  const lenses = KIND_LENSES[KINDS.includes(kind) ? kind : 'general'];

  if (!live) {
    const pool = DEMO_QUESTIONS[level] || DEMO_QUESTIONS.notice;
    const questions = pool.map((question, i) => {
      const ch = para ? para.ch : read[read.length - 1];
      const count = doc.chapters[ch].paragraphs.length;
      const p = para ? para.p : Math.floor(((i + 1) * count) / 4 + (avoid?.length || 0)) % count;
      const pool2 = lenses.filter((l) => !(Array.isArray(exclude) ? exclude : []).includes(l));
      return { question, ch, p, lens: lenses.includes(lens) ? lens : (pool2.length ? pool2 : lenses)[i % (pool2.length || lenses.length)] };
    });
    return res.json({ questions, demo: true });
  }

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low', format: zodOutputFormat(QuestionSet) },
      system: [
        { type: 'text', text: buildTextBlock(doc, para ? [para.ch] : [...read].reverse()), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: QUESTION_INSTRUCTIONS },
      ],
      messages: [{ role: 'user', content: buildQuestionRequest({ doc, kind, lens, level, chapters: read, paragraph: para, focus, avoid, exclude: Array.isArray(exclude) ? exclude : [] }) }],
    });
    // The model writes 1-based numbers, as shown in the text. Drop anything outside what the student has read.
    const questions = (response.parsed_output?.questions || [])
      .map((q) => ({ question: q.question.trim(), ch: q.ch - 1, p: q.p - 1, lens: lenses.includes(q.lens) ? q.lens : 'themes' }))
      .filter((q) => q.question && allowed(q.ch, q.p))
      .slice(0, 3);
    if (!questions.length) return res.status(502).json({ error: 'No questions came back. Try again.' });
    res.json({ questions });
  } catch (error) {
    sendApiError(res, error);
  }
});

function sendApiError(res, error) {
  if (error instanceof Anthropic.AuthenticationError) {
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

app.listen(PORT, () => {
  console.log(`Bookz is running at http://localhost:${PORT}`);
  console.log(live ? `Companion: ${MODEL}` : 'Companion: demo replies (set ANTHROPIC_API_KEY to connect Sonnet)');
});
