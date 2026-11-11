# Bookz

A reading companion. A student uploads a text, reads and highlights it, talks to an AI companion that gives hints and never answers, and exports the text and their highlights to PDF.

## Run it

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000.

## Connect Sonnet

Without an API key the companion returns clearly labelled demo replies, so the rest of the app can be used and tested.

To connect it, set `ANTHROPIC_API_KEY` in the environment before starting the server (see `.env.example`). The model defaults to `claude-sonnet-5-5`; set `BOOKZ_MODEL` to change it.

```bash
ANTHROPIC_API_KEY=your-key npm start
```

The key stays on the server. The browser only talks to `/api/chat`.

## How the companion behaves

Its instructions are in [`lib/prompt.js`](lib/prompt.js), in plain English. Edit `COMPANION_INSTRUCTIONS` to change its behaviour. In short:

- One hint per reply: a question, a pointer to a place in the text, or a suggestion of what to notice. Never the answer.
- One or two short sentences, 35 words at most.
- Themes and connections are welcome. There it may suggest where to look and need not end with a question.
- References are written as `(ch 3, ¶12)` and the app turns them into links that jump to the passage.

With each question the server sends the text, the open chapter, the student's highlights and notes, and the conversation in the current topic. The text is cached between questions. Texts over about 600,000 characters are sent in part (contents list plus the chapters the student is working in).

## What is where

| Path | What it does |
| --- | --- |
| `server.js` | Serves the app and calls the Anthropic API |
| `lib/prompt.js` | The companion's instructions and the context it is given |
| `public/app.js` | Reader, highlights, notes, topics, export |
| `public/parse.js` | Reads uploaded EPUB, PDF and plain text files |
| `public/sample/meditations.json` | The sample text |

## Things to know

- Uploaded texts, highlights, notes and conversations are stored in the student's browser only. There are no accounts and no server-side storage.
- Export uses the browser's print window; the student chooses "Save as PDF".
- PDF uploads are read one page per chapter, so the companion can point to a page. Scanned PDFs without a text layer cannot be read.
- The sample text is Meditations by Marcus Aurelius in Meric Casaubon's 1634 translation, taken from Project Gutenberg eBook 2680. It is in the public domain in the United States.
