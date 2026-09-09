# Vocab Trainer

A Quizlet-style "Learn" mode for memorizing terms and definitions, built for
vocabulary-first studying: clear a week's terms before opening that week's
readings, lectures, or slides. No build step, no dependencies: open
`index.html` in a browser or host it as a static site.

The home screen has a tab per course and lists each course's weeks with a
status. A week is **cleared**
once you finish every term in a writing or both-rounds session with at least
90% first-try accuracy. Progress is stored in your browser.

## How a session works

1. Terms are shuffled and split into batches of 15 (configurable on the home screen).
2. Each batch has up to two rounds, chosen by the **Study mode** on the home
   screen (both rounds, writing only, or multiple choice only). You always see
   the **definition**:
   - **Round 1**: pick the term from four choices for every term in the batch (keys `1`-`4` work).
   - **Round 2**: type the term for every term in the batch (`Enter` submits).
3. If you miss a term in either round, the correct answer is shown and the
   term is pushed to the **end of that round's queue**, so the round only ends
   once you have got every term right.
4. After round 2 you get the batch **accuracy**: the share of the batch's
   terms you got right on the first try in both rounds, plus the list of terms
   you missed.
5. After the last batch you get the overall accuracy, a per-batch table, every
   missed term, and a **Practice missed terms** button.

Typed answers are checked case-insensitively, ignoring punctuation, accents,
and extra spaces, and tolerating a trailing "s". Each card can list `alt`
answers (e.g. `"Kant"` for `"Immanuel Kant"`). If the checker rejects an answer
you think was right, use **Override: I was right**.

## Editing terms in the app

"Show all terms" lists the week's terms. **Remove** on a row asks for
confirmation, then hides that term; removed terms sit in a collapsible list
with a **Restore** button. The form at the bottom adds a term (term,
definition, optional accepted spellings). These edits are stored in your
browser, not in the set file. **Export edits** shows them as JSON to paste
back so the set file can be updated for good.

## Adding a term set

1. Create `sets/<name>.js`:

   ```js
   window.VOCAB_SETS = window.VOCAB_SETS || [];
   window.VOCAB_SETS.push({
     id: "ethics-week2",
     course: "Ethics",
     week: 2,
     title: "What the week is about",
     materials: ["reading.pdf", "lecture-2-transcript.txt", "slides-2.pdf"],
     cards: [
       { term: "Term", definition: "What is shown as the prompt.", alt: ["other accepted spellings"] },
       { term: "Some Philosopher", definition: "Who they were.", kind: "person" },
     ]
   });
   ```

2. Add `<script src="sets/<name>.js"></script>` to `index.html` above `app.js`.

The set then appears in the week list on the home screen. Cards with
`kind: "person"` (philosophers, authors, works) are hidden unless the
"Include people & works" box is ticked. Avoid repeating the term inside
its own definition, or the multiple-choice round gives it away.

## Included sets

- Ethics, week 1 (`sets/ethics-week1.js`): 78 concepts from *An Introduction
  to Ethics* and Appiah's *Cross-cultural Conversation*, plus 22 optional
  philosophers, authors, and works.
- Operations Management, week 1 (`sets/opsmgmt-week1.js`): 16 process
  analysis terms from the session 2 pre-class slides.
- Economics of Global Business, week 1 (`sets/egb-week1.js`): 50 concepts
  from the intro and national accounts slides, plus the textbook author.
