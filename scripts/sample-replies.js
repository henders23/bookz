#!/usr/bin/env node
// Prints the companion's real openings and replies for a fixed set of student messages,
// so they can be read and judged after changing lib/prompt.js.
//
//   npm run sample                      every text, every run, against http://localhost:3000
//   npm run sample -- heat thin         one text, one run
//   BOOKZ_URL=https://example.com npm run sample
//
// The server must be running with ANTHROPIC_API_KEY set, or the output is demo text.

import { TEXTS, RUNS, runCase, formatCase } from '../lib/selftest.js';

const base = (process.env.BOOKZ_URL || 'http://localhost:3000').replace(/\/$/, '');
const args = process.argv.slice(2);
const texts = args.filter((a) => TEXTS[a]);
const runs = args.filter((a) => RUNS.includes(a));
const unknown = args.filter((a) => !TEXTS[a] && !RUNS.includes(a));
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(', ')}\nTexts: ${Object.keys(TEXTS).join(', ')}\nRuns: ${RUNS.join(', ')}`);
  process.exit(1);
}

async function post(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${data.error || 'no message'}`);
  return data;
}
const api = { questions: (b) => post('/api/questions', b), chat: (b) => post('/api/chat', b) };

const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
if (!health) {
  console.error(`No Bookz server answered at ${base}. Start it with "npm start" or set BOOKZ_URL.`);
  process.exit(1);
}
console.log(`# Bookz sample replies\n\nServer: ${base} · model: ${health.model} · ${health.live ? 'live' : 'DEMO MODE (no API key): the text below is placeholder'}\n`);

let flagged = 0;
for (const text of texts.length ? texts : Object.keys(TEXTS)) {
  for (const run of runs.length ? runs : RUNS) {
    try {
      const result = await runCase(text, run, api);
      flagged += result.lines.filter((l) => l.flags.length).length;
      console.log(formatCase(result));
    } catch (error) {
      console.log(`## ${text}: ${run}\n\nFAILED: ${error.message}\n`);
      flagged++;
    }
  }
}
console.log(`---\n${flagged} line(s) flagged by the automatic checks. The checks catch length, double questions and bad references; whether a reply is any good still needs reading.`);
