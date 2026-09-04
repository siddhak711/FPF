# Vocab Trainer

A Quizlet-style "Learn" mode for memorizing terms and definitions. No build
step, no dependencies: open `index.html` in a browser or host it as a static
site (GitHub Pages works).

## How a session works

1. Terms are shuffled and split into batches of 15 (configurable on the home screen).
2. Each batch has two rounds. You always see the **definition**:
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

## Adding a term set

1. Create `sets/<name>.js`:

   ```js
   window.VOCAB_SETS = window.VOCAB_SETS || [];
   window.VOCAB_SETS.push({
     id: "my-set",
     title: "My Set",
     source: "where it came from (optional)",
     cards: [
       { term: "Term", definition: "What is shown as the prompt.", alt: ["other accepted spellings"] },
       { term: "Some Philosopher", definition: "Who they were.", kind: "person" },
     ]
   });
   ```

2. Add `<script src="sets/<name>.js"></script>` to `index.html` above `app.js`.

The set then appears in the dropdown on the home screen. Cards with
`kind: "person"` (philosophers, authors, works) are hidden unless the
"Include philosophers & works" box is ticked. Avoid repeating the term inside
its own definition, or the multiple-choice round gives it away.

## Included sets

- `sets/ethics-week1.js`: 69 terms and concepts from *Week 1: An Introduction
  to Ethics* (meta-ethics, first-order ethics, virtue ethics, and the diversity
  of ethical language), plus 17 optional philosophers and works.
