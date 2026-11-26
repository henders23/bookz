// A fixed set of student messages to run against the companion, so its real replies can be
// read and judged. Used by scripts/sample-replies.js and by GET /api/selftest.

import meditations from '../public/sample/meditations.json' with { type: 'json' };
import { SAMPLE_OPENINGS } from './sample-openings.js';

// A short expository text written for testing. It has weak points on purpose: a survey said to
// "prove" a cause, a prediction that the evidence contradicts, and a conclusion that outruns the argument.
const heat = {
  id: 'test-urban-heat',
  title: 'Why cities run hot',
  author: 'Bookz test text',
  chapters: [
    {
      title: 'The urban heat island',
      paragraphs: [
        'On a still summer night the centre of a large city can be several degrees warmer than the fields a few kilometres away. This difference is known as the urban heat island. It was first described in London in the early nineteenth century, and it has since been measured in cities of every size and climate.',
        'The usual explanation is material. Concrete, brick and asphalt absorb sunlight during the day and release it slowly after dark, while soil and plants lose heat quickly through evaporation. A city is, in effect, a large storage heater that is charged by the sun.',
        'Surveys support this. In one study of forty cities, the districts with the least tree cover were on average three degrees warmer at night than the districts with the most. This proves that removing vegetation causes cities to heat up.',
        'A second cause is waste heat. Engines, air conditioners and industrial processes all release heat into the street. In winter this can account for most of the difference between city and countryside, although in summer its share is small.',
        'The shape of a city matters as well. Tall buildings on narrow streets trap outgoing heat and block the wind that would carry it away. It follows that low, spread-out cities should have weak heat islands, yet some of the strongest have been recorded in exactly such cities.',
        'The consequences are serious. Hot nights prevent the body from recovering after hot days, and deaths during heatwaves are concentrated in the warmest districts. These are often the poorest districts too, which have the fewest trees and the least access to cooling.',
        'The remedy is therefore clear. Cities should plant trees and replace dark surfaces with pale ones. Since the heat island is man-made, it can be unmade, and any city that fails to act is choosing to let its residents suffer.',
      ],
    },
  ],
};

export const TEXTS = {
  meditations: {
    doc: meditations,
    kind: 'literature',
    ch: 2,
    p: 0,
    opening: SAMPLE_OPENINGS[2][0],
    highlight: { ch: 2, p: 7, text: 'But gods there be certainly', note: '' },
    strong: [
      "I think 'these things' means sorting out his own mind, because he says the time is for calming 'the many distempers of thy soul'.",
      "It's odd that he needs to understand the whole universe just to calm down though.",
      "Maybe because seeing he is 'a part' of it makes his own worries smaller.",
      'So understanding the world is how he gets calm, and getting calm is the thing he has been putting off.',
    ],
    thin: 'idk',
    wrong: 'He is scared the gods will punish him for being late.',
    tell: 'Can you just tell me what he means?',
    ask: ['Why does he talk about gods so much in this book?', 'So does he believe in them or not?'],
  },
  heat: {
    doc: heat,
    kind: 'academic',
    ch: 0,
    p: 2,
    opening: {
      p: 2,
      lens: 'evidence',
      where: 'Read the third paragraph again.',
      notice: 'It reports that districts with the least tree cover were three degrees warmer at night, then says this "proves" that removing vegetation causes the heat. The survey compares districts. It does not remove anything.',
      question: 'What else might differ between a leafy district and a bare one?',
    },
    highlight: { ch: 0, p: 4, text: 'yet some of the strongest have been recorded in exactly such cities', note: '' },
    strong: [
      'Leafy districts are probably richer and less dense, with fewer roads and more gardens, so it might be the density and not the trees.',
      "So the survey can't separate trees from everything else that comes with them.",
      'Paragraph 6 says the poorest districts have the fewest trees, so that fits.',
      'I think the author found a real link but claimed too much.',
    ],
    thin: 'not sure',
    wrong: 'The study proves trees cool cities because 40 cities is a big sample.',
    tell: "Can you just tell me what's wrong with it?",
    ask: ['Is the author right that cities are choosing to let people suffer?', 'So is that a yes or a no?'],
  },
};

export const RUNS = ['opening', 'strong', 'thin', 'wrong', 'tell', 'offtopic', 'ask'];

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const questionMarks = (s) => (s.match(/\?/g) || []).length;

function badRefs(doc, s) {
  const bad = [];
  for (const m of s.matchAll(/\(ch (\d+)(?:, ¶(\d+))?\)/g)) {
    const ch = doc.chapters[Number(m[1]) - 1];
    if (!ch || (m[2] && !ch.paragraphs[Number(m[2]) - 1])) bad.push(m[0]);
  }
  return bad;
}

function checkReply(doc, text) {
  const flags = [];
  if (words(text) > 55) flags.push(`long (${words(text)} words, limit 55)`);
  if (questionMarks(text) > 1) flags.push(`${questionMarks(text)} questions`);
  if (!/["“'‘]/.test(text) && !/\(ch \d+/.test(text)) flags.push('no quotation or reference');
  const bad = badRefs(doc, text);
  if (bad.length) flags.push(`bad reference ${bad.join(' ')}`);
  return flags;
}

function checkOpening(doc, o) {
  const flags = [];
  if (words(o.where) > 20) flags.push(`where is long (${words(o.where)})`);
  if (words(o.notice) > 50) flags.push(`notice is long (${words(o.notice)})`);
  if (words(o.question) > 25) flags.push(`question is long (${words(o.question)})`);
  if (questionMarks(o.question) !== 1) flags.push(`${questionMarks(o.question)} question marks`);
  if (/,? and (what|how|why|where|which|who|does|do|is|are|can)\b/i.test(o.question)) flags.push('two questions joined by "and"');
  if (!/["“'‘]/.test(`${o.where} ${o.notice}`)) flags.push('no quotation from the text');
  if (!doc.chapters[o.ch]?.paragraphs[o.p]) flags.push('points to a paragraph that does not exist');
  return flags;
}

const openingText = (o) => [o.where, o.notice, o.question].join(' ');

/**
 * Runs one case. `api` has questions(body) and chat(body), each returning the endpoint's JSON.
 * Returns { title, lines: [{ who, text, flags }] }.
 */
export async function runCase(textKey, run, api) {
  const t = TEXTS[textKey];
  if (!t) throw new Error(`Unknown text "${textKey}". Use one of: ${Object.keys(TEXTS).join(', ')}`);
  const { doc } = t;
  const position = { ch: t.ch };
  const lines = [];
  const say = (who, text, flags = []) => lines.push({ who, text, flags });

  if (run === 'opening') {
    const base = { doc: { title: doc.title, author: doc.author, chapters: doc.chapters }, kind: t.kind, lens: 'mix', level: 'notice', position, avoid: [] };
    const cases = [
      ['Pinned to one paragraph', { ...base, chapters: [t.ch], paragraph: { ch: t.ch, p: t.p }, marks: [] }],
      ['Free choice in the chapter, with one highlight', { ...base, chapters: [t.ch], marks: [t.highlight] }],
      ['Free choice, asked for connections', { ...base, lens: 'connections', level: 'connect', chapters: [t.ch], marks: [] }],
    ];
    const results = await Promise.all(cases.map(([, body]) => api.questions(body)));
    results.forEach((data, i) => {
      const o = data.questions[0];
      say(`Opening: ${cases[i][0]}${data.demo ? ' (DEMO)' : ''}`, `[${doc.chapters[o.ch].title} ¶${o.p + 1} · ${o.lens}] ${openingText(o)}`, checkOpening(doc, o));
    });
    return { title: `${doc.title}: openings`, lines };
  }

  const turns =
    run === 'strong' ? t.strong
    : run === 'ask' ? t.ask
    : run === 'offtopic' ? ['Can you help me with my maths homework instead?']
    : t[run] ? [t[run]]
    : null;
  if (!turns) throw new Error(`Unknown run "${run}". Use one of: ${RUNS.join(', ')}`);

  const led = run !== 'ask'; // every run except "ask" starts from the companion's opening
  if (led) say('Companion (opening)', openingText(t.opening));
  const note = led ? `[You opened this conversation about (ch ${t.ch + 1}, ¶${t.p + 1}) by saying: "${openingText(t.opening)}"]\n` : '';
  const messages = [];
  for (const [i, turn] of turns.entries()) {
    say('Student', turn);
    messages.push({ role: 'user', text: (i === 0 ? note : '') + turn });
    const data = await api.chat({
      doc: { title: doc.title, author: doc.author, chapters: doc.chapters },
      position,
      quote: null,
      marks: [t.highlight],
      messages,
    });
    say(`Companion${data.demo ? ' (DEMO)' : ''}`, data.text, checkReply(doc, data.text));
    messages.push({ role: 'assistant', text: data.text });
  }
  return { title: `${doc.title}: ${run}`, lines };
}

export function formatCase({ title, lines }) {
  const out = [`## ${title}`, ''];
  for (const l of lines) {
    out.push(`**${l.who}:** ${l.text}`);
    if (l.flags.length) out.push(`  ⚠ ${l.flags.join('; ')}`);
    out.push('');
  }
  return out.join('\n');
}
