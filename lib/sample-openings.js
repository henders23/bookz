// Hand-written conversation openings for the bundled sample text (Meditations).
// They are used only when no API key is connected, so the sample shows what a real,
// text-specific opening looks like. Keys are chapter indexes; "p" is the paragraph index.
//
// Each one follows the same rules Sonnet is given: say where to look, point at something
// that does not quite fit without explaining it, then ask one question that sends the
// student back to the page.

export const SAMPLE_ID = 'sample-meditations';

export const SAMPLE_OPENINGS = {
  1: [
    {
      p: 4,
      lens: 'structure',
      where: 'Read the fifth paragraph, the one that begins "Of my grandfather Verus".',
      notice: 'Each sentence here has the same shape: a person, then a quality he took from them. His grandfather and his mother are never described. We get what they left him and nothing else.',
      question: 'What do you learn about him from the kinds of things he chooses to list?',
    },
    {
      p: 12,
      lens: 'examples',
      where: 'Read the thirteenth paragraph, about Alexander the Platonic.',
      notice: 'Next to lessons about liberty and bearing pain, this one is about a single excuse: saying "I am not at leisure". It gets a paragraph to itself in an emperor\'s private notes.',
      question: 'Why might so small a habit sit in the same list as the large ones?',
    },
  ],
  2: [
    {
      p: 0,
      lens: 'themes',
      where: 'Read the first paragraph again.',
      notice: 'He starts by scolding himself for delay: "how long thou hast already put off these things". But he never says what "these things" are, and what he tells himself to do next is to understand the world, not to act.',
      question: 'Going by the rest of the paragraph, what do you think "these things" are?',
    },
    {
      p: 1,
      lens: 'themes',
      where: 'Read the second paragraph again, from "go about every action as thy last action".',
      notice: 'It sounds like a line about dying. But look at what comes straight after it: a list of things to be free from, and death is not on it.',
      question: 'What do the things on that list have in common?',
    },
    {
      p: 6,
      lens: 'examples',
      where: 'Go to the seventh paragraph, where he brings in Theophrastus.',
      notice: 'He almost never argues a case, and here he does. Wrong done through lust is ranked worse than wrong done in anger, and the reason given is that the angry man was "first wronged" while the other "did of himself merely resolve".',
      question: 'What would have to be true about anger for that ranking to be fair?',
    },
    {
      p: 7,
      lens: 'structure',
      where: 'Read the eighth paragraph, from "And as for death".',
      notice: 'He begins with two cases, gods or no gods, as if death is nothing to fear either way. A few lines on, one case has gone: "But gods there be certainly". No reason is given for dropping it.',
      question: 'What happens to his argument about death if you put the second case back in?',
    },
    {
      p: 11,
      lens: 'themes',
      where: 'Read the twelfth paragraph, beginning "If thou shouldst live three thousand".',
      notice: 'He says the longest life and the shortest "come both to one effect". The reason given is that nobody can lose the past or the future, only the present moment. It is a tidy argument for something most people would not accept.',
      question: 'Which step of that reasoning would you want to test first?',
    },
    {
      p: 14,
      lens: 'connections',
      where: 'Read the fifteenth paragraph, almost the end of the book.',
      notice: 'It runs through what a life is like: "a point", "a stream", "a dream", "a smoke". Then it asks what is left, and the answer is one word, philosophy. But the philosophy he goes on to describe has nothing to do with books or study.',
      question: 'Going by his own description, what does "philosophy" actually require a person to do?',
    },
  ],
  5: [
    {
      p: 0,
      lens: 'character',
      where: 'Read the first paragraph of The Fifth Book again.',
      notice: 'He is arguing with himself about getting out of bed, and he lets the other side speak: "O but this is pleasing", "But thou must have some rest". His answer is sparrows, ants, spiders and bees.',
      question: 'What does he assume a person has in common with an ant or a bee?',
    },
    {
      p: 6,
      lens: 'examples',
      where: 'Read the seventh paragraph, the Athenians\' prayer.',
      notice: 'He quotes a prayer for rain on "all the grounds and fields that belong to the Athenians" and calls it the right way to pray: not "every one for himself". Yet the prayer still stops at the edge of Athens.',
      question: 'How far does "not for himself alone" actually reach in this example?',
    },
  ],
};
