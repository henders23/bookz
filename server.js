import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANION_INSTRUCTIONS, buildTextBlock, buildStudentContext } from './lib/prompt.js';

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
      system: [
        { type: 'text', text: COMPANION_INSTRUCTIONS },
        { type: 'text', text: buildTextBlock(doc, focus), cache_control: { type: 'ephemeral' } },
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
});

app.listen(PORT, () => {
  console.log(`Bookz is running at http://localhost:${PORT}`);
  console.log(live ? `Companion: ${MODEL}` : 'Companion: demo replies (set ANTHROPIC_API_KEY to connect Sonnet)');
});
