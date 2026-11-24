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

There is one place to talk about the text: the Discuss tab. Its instructions are in [`lib/prompt.js`](lib/prompt.js), in plain English: `QUESTION_INSTRUCTIONS` for an opening and `DISCUSS_INSTRUCTIONS` for every reply.

- Either side can start. The student can ask anything, or press one button and the companion opens: it says where to look ("Read the first paragraph again"), gives a view of its own about that passage, and asks the student to take it further.
- Each reply answers what the student said, adds one thing of its own, and hands it back. It shares views but does not deliver a complete reading, sum the text up, or write anything for the student to copy.
- Openings and replies are told to be specific to the passage (naming its people, claims and examples, with short quotations) and to deal with matters of substance, not single words.
- The student's highlights and notes are sent with every request. Openings start from them where that gives something real to say.
- An opening is always about a paragraph the student has already read. References are written as `(ch 3, ¶12)` and the app turns them into links that jump to the passage.
- The text is classified once as literature, academic or general, which decides the topics on offer under Options. There the student can also set how far to be pushed, where to draw from, and a topic.
- Without an API key, the bundled sample uses hand-written openings from `lib/sample-openings.js`. Uploaded texts get labelled placeholders that have not read the text.
- Conversations the student took part in are included in the PDF export.

With each request the server sends the text, the open chapter, the student's highlights and notes, and the current conversation. The text is cached between requests. Texts over about 600,000 characters are sent in part (contents list plus the chapters the student is working in).

On a phone the Discuss and Notes panel is a sheet that slides up over the text and tucks away when the student follows a link to a passage.

## What is where

| Path | What it does |
| --- | --- |
| `server.js` | Serves the app and calls the Anthropic API |
| `lib/prompt.js` | The companion's instructions and the context it is given |
| `public/app.js` | Reader, highlights, notes, conversations, export |
| `public/parse.js` | Reads uploaded EPUB, PDF, Word (.docx) and plain text files |
| `public/sample/meditations.json` | The sample text |

## Things to know

- Uploaded texts, highlights, notes and conversations are stored in the student's browser only. There are no accounts and no server-side storage.
- Export uses the browser's print window; the student chooses "Save as PDF".
- PDF uploads are read one page per chapter, so the companion can point to a page. Scanned PDFs without a text layer cannot be read.
- Word uploads must be `.docx`; headings (Heading 1 to 3) become chapters. Older `.doc` files are not supported.
- The sample text is Meditations by Marcus Aurelius in Meric Casaubon's 1634 translation, taken from Project Gutenberg eBook 2680. It is in the public domain in the United States.
