# Vocab Trainer

A Quizlet-style "Learn" mode for memorizing terms and definitions. No build
step, no dependencies: open `index.html` in a browser or host it as a static
site (GitHub Pages works).

## How a session works

1. Terms are shuffled and split into batches of 15 (configurable on the home screen).
2. For each term you see the **definition**:
   - **Step 1**: pick the term from four choices (keys `1`-`4` work).
   - **Step 2**: type the term (`Enter` submits).
3. A term is learned only when both steps are right. If you miss either step,
   the correct answer is shown and the term is pushed to the **end of the
   current batch**, so you see it again before the batch ends.
4. When the batch queue is empty you get the batch **accuracy**: the share of
   the batch's terms you got right on the first try (both steps), plus the
   list of terms you missed.
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
     ]
   });
   ```

2. Add `<script src="sets/<name>.js"></script>` to `index.html` above `app.js`.

The set then appears in the dropdown on the home screen. Avoid repeating the
term inside its own definition, or the multiple-choice step gives it away.

## Included sets

- `sets/ethics-week1.js`: 100 terms from *Week 1: An Introduction to Ethics*
  (meta-ethics, first-order ethics, virtue ethics, and the diversity of
  ethical language).
