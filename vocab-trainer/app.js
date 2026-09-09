/* Vocab Trainer
 *
 * Vocabulary-first studying across several courses. Each course has weekly
 * term sets (files under sets/). Terms are studied in batches (default 15)
 * with up to two rounds per batch:
 *   Round 1: for every term, see the definition and pick the term (multiple choice).
 *   Round 2: for every term, see the definition and type the term.
 * A miss in either round shows the correct answer and pushes the term to the
 * end of that round's queue. Batch accuracy = terms right on the first try.
 * A week is "cleared" after a full-set writing or both-rounds session at
 * CLEAR_THRESHOLD or better.
 *
 * The owner can remove terms and add their own from the term list; those
 * edits live in localStorage as an overlay on the set files and can be
 * exported as JSON to fold back into the repo.
 */
(function () {
  "use strict";

  var DEFAULT_BATCH_SIZE = 15;
  var CHOICES = 4;
  var AUTO_ADVANCE_MS = 900;
  var MC_ADVANCE_MS = 500;
  var CLEAR_THRESHOLD = 90; // first-try accuracy needed to mark a week as cleared

  var $app = document.getElementById("app");
  var $status = document.getElementById("topbar-status");
  var sets = window.VOCAB_SETS || [];

  var prefs = loadPrefs();
  var progress = loadJson("vocab-trainer-progress"); // setId -> { best, last, lastAt, sessions, cleared }
  var edits = loadJson("vocab-trainer-edits");       // setId -> { removed: [term], added: [{term, definition, alt}] }
  var ui = { termsOpen: false, removedOpen: false, pendingRemove: null, exportOpen: false, addError: "", addDraft: { term: "", definition: "", alt: "" } };
  var session = null;      // active study session, or null on the home screen
  var advanceTimer = null; // pending auto-advance after a correct answer

  // ---------- storage ----------

  function loadJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (e) { return {}; }
  }
  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }
  function loadPrefs() {
    var p = { setId: null, course: null, shuffle: true, batchSize: DEFAULT_BATCH_SIZE, includePeople: false, mode: "both", sourcesOff: {} };
    var saved = loadJson("vocab-trainer-prefs");
    if (saved.setId && sets.some(function (s) { return s.id === saved.setId; })) p.setId = saved.setId;
    if (typeof saved.course === "string") p.course = saved.course;
    if (typeof saved.shuffle === "boolean") p.shuffle = saved.shuffle;
    if (typeof saved.includePeople === "boolean") p.includePeople = saved.includePeople;
    if (saved.mode === "both" || saved.mode === "write" || saved.mode === "mc") p.mode = saved.mode;
    if (saved.batchSize === "all" || (saved.batchSize >= 1 && saved.batchSize <= 100)) p.batchSize = saved.batchSize;
    if (saved.sourcesOff && typeof saved.sourcesOff === "object") p.sourcesOff = saved.sourcesOff;
    return p;
  }
  function savePrefs() { saveJson("vocab-trainer-prefs", prefs); }

  // ---------- courses and sets ----------

  function courses() {
    var seen = {}, out = [];
    sets.forEach(function (s) { var c = s.course || "Other"; if (!seen[c]) { seen[c] = true; out.push(c); } });
    return out.sort();
  }
  function currentCourse() {
    var all = courses();
    return all.indexOf(prefs.course) >= 0 ? prefs.course : all[0];
  }
  function setsForCourse(course) {
    return sets.filter(function (s) { return (s.course || "Other") === course; })
      .sort(function (a, b) { return (a.week || 0) - (b.week || 0); });
  }
  function currentSet() {
    var inCourse = setsForCourse(currentCourse());
    return inCourse.filter(function (s) { return s.id === prefs.setId; })[0] || inCourse[0] || null;
  }
  function setName(set) { return (set.week ? "Week " + set.week + " · " : "") + set.title; }
  function isPerson(card) { return card.kind === "person"; }

  // Set file cards minus removed ones, plus the owner's additions.
  function editsFor(set) {
    return edits[set.id] || { removed: [], added: [] };
  }
  function effectiveCards(set) {
    var e = editsFor(set);
    var removed = {};
    e.removed.forEach(function (t) { removed[t.toLowerCase()] = true; });
    var out = set.cards.filter(function (c) { return !removed[c.term.toLowerCase()]; });
    e.added.forEach(function (c) { out.push({ term: c.term, definition: c.definition, alt: c.alt || [], custom: true }); });
    return out;
  }
  function saveEdits() { saveJson("vocab-trainer-edits", edits); }
  function removeTerm(set, term) {
    var e = editsFor(set);
    var wasAdded = e.added.some(function (c) { return c.term === term; });
    if (wasAdded) e.added = e.added.filter(function (c) { return c.term !== term; });
    else if (e.removed.indexOf(term) < 0) e.removed.push(term);
    edits[set.id] = e; saveEdits();
  }
  function restoreTerm(set, term) {
    var e = editsFor(set);
    e.removed = e.removed.filter(function (t) { return t !== term; });
    edits[set.id] = e; saveEdits();
  }
  function addTerm(set, term, definition, altText) {
    term = term.trim(); definition = definition.trim();
    if (!term || !definition) return "Both a term and a definition are needed.";
    var exists = effectiveCards(set).some(function (c) { return normalize(c.term) === normalize(term); });
    if (exists) return "\"" + term + "\" is already in this set.";
    var alt = altText.split(",").map(function (a) { return a.trim(); }).filter(Boolean);
    var e = editsFor(set);
    e.added.push({ term: term, definition: definition, alt: alt });
    e.removed = e.removed.filter(function (t) { return t.toLowerCase() !== term.toLowerCase(); });
    edits[set.id] = e; saveEdits();
    return "";
  }

  // Source materials of a set can be switched off; a card stays in play while
  // any of its sources is on. Cards without `src` (e.g. the owner's additions) always stay.
  function sourceOn(set, i) {
    var off = prefs.sourcesOff[set.id] || [];
    return off.indexOf(i) < 0;
  }
  function toggleSource(set, i, on) {
    var off = (prefs.sourcesOff[set.id] || []).filter(function (x) { return x !== i; });
    if (!on) off.push(i);
    prefs.sourcesOff[set.id] = off;
    savePrefs();
  }
  function cardInSources(set, c) {
    if (!c.src || !c.src.length) return true;
    return c.src.some(function (i) { return sourceOn(set, i); });
  }
  function materialName(file) {
    return String(file).replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Indices (into effectiveCards) this session draws from: cards from enabled
  // sources, concepts only unless people are enabled.
  function poolFor(set, cards) {
    var out = [];
    cards.forEach(function (c, i) {
      if (!cardInSources(set, c)) return;
      if (prefs.includePeople || !isPerson(c)) out.push(i);
    });
    return out;
  }

  // ---------- progress ----------

  function recordResult(set, accuracy, countsForClearing) {
    var p = progress[set.id] || { best: 0, last: 0, lastAt: null, sessions: 0, cleared: false };
    p.sessions++;
    p.last = accuracy;
    p.lastAt = new Date().toISOString();
    if (countsForClearing) {
      p.best = Math.max(p.best, accuracy);
      if (accuracy >= CLEAR_THRESHOLD) p.cleared = true;
    }
    progress[set.id] = p;
    saveJson("vocab-trainer-progress", progress);
    return p;
  }
  function statusOf(set) {
    var p = progress[set.id];
    if (!p) return { key: "new", label: "Not started" };
    if (p.cleared) return { key: "cleared", label: "Cleared · best " + p.best + "%" };
    return { key: "progress", label: "In progress · best " + p.best + "%" };
  }

  // ---------- helpers ----------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function chunk(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }
  // Lower-case, strip accents, drop apostrophes and other punctuation, collapse whitespace.
  function normalize(s) {
    return String(s)
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[‘’'`]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function singular(s) { return s.length > 3 && s.slice(-1) === "s" ? s.slice(0, -1) : s; }

  // Edit distance (insertions, deletions, substitutions) between two strings.
  function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[b.length];
  }
  // How many typos to forgive, by length of the accepted answer.
  function allowedTypos(answer) {
    var n = answer.replace(/\s/g, "").length;
    return n <= 4 ? 0 : n <= 8 ? 1 : n <= 14 ? 2 : 3;
  }
  // Returns "exact", "near", or null. `others` are the other cards in play; a
  // typo that exactly spells one of them is never forgiven.
  function matchQuality(card, typed, others) {
    var t = normalize(typed);
    if (!t) return null;
    var accepted = [card.term].concat(card.alt || []).map(normalize);
    var exact = accepted.some(function (a) { return a === t || singular(a) === singular(t); });
    if (exact) return "exact";
    var collides = (others || []).some(function (c) {
      if (c === card) return false;
      return [c.term].concat(c.alt || []).map(normalize).some(function (a) { return a === t || singular(a) === singular(t); });
    });
    if (collides) return null;
    var near = accepted.some(function (a) {
      return editDistance(singular(a), singular(t)) <= allowedTypos(singular(a));
    });
    return near ? "near" : null;
  }
  function answerMatches(card, typed, others) { return matchQuality(card, typed, others) !== null; }
  function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }
  // Batch size in effect for a session over `count` cards ("all" = one batch).
  function batchSizeFor(count) {
    return prefs.batchSize === "all" ? Math.max(1, count) : prefs.batchSize;
  }
  function grade(p) { return p >= 85 ? "ok" : p >= 60 ? "warn" : "bad"; }

  function rounds() { return (session ? session.mode : prefs.mode) === "both" ? 2 : 1; }
  function roundTitle(round) { return round === "mc" ? "Multiple choice" : "Writing"; }
  function roundLabel(round) {
    if (rounds() === 1) return roundTitle(round);
    return "Round " + (round === "mc" ? 1 : 2) + " of 2 &middot; " + roundTitle(round);
  }
  function accuracyNote() {
    var mode = session ? session.mode : prefs.mode;
    return mode === "both" ? "in both rounds" : "in the " + roundTitle(mode === "mc" ? "mc" : "type").toLowerCase() + " round";
  }

  // ---------- session ----------

  function startSession(set, cards, cardIdxs, pool) {
    clearTimeout(advanceTimer);
    var order = prefs.shuffle ? shuffle(cardIdxs) : cardIdxs.slice();
    session = {
      set: set,
      cards: cards,                    // effective cards at session start
      pool: pool,                      // distractors are drawn from here
      mode: prefs.mode,
      fullSet: cardIdxs.length === pool.length,
      recorded: false,
      batches: chunk(order, batchSizeFor(order.length)),
      batchIdx: 0,
      results: [],
      batch: null,
      current: null,
      view: "question"
    };
    startBatch();
  }

  function startBatch() {
    var ids = session.batches[session.batchIdx];
    session.batch = {
      ids: ids,
      size: ids.length,
      round: session.mode === "write" ? "type" : "mc",
      queue: ids.slice(),
      mcDone: 0,
      typeDone: 0,
      firstTry: {},        // cardIdx -> true (clean) / false (missed at least once)
      answered: 0,
      correct: 0,
      missed: [],
      mcMisses: 0,
      typeMisses: 0
    };
    nextItem();
  }

  function nextItem() {
    clearTimeout(advanceTimer);
    var b = session.batch;
    if (!b.queue.length) {
      if (b.round === "mc" && session.mode === "both") { session.view = "round-break"; render(); return; }
      finishBatch(); return;
    }
    var ci = b.queue.shift();
    session.current = { ci: ci, choices: b.round === "mc" ? makeChoices(ci) : null, picked: null, typed: "", result: null };
    session.view = "question";
    render();
  }

  function startWritingRound() {
    var b = session.batch;
    b.round = "type";
    b.queue = b.ids.slice();
    nextItem();
  }

  function makeChoices(ci) {
    var pool = session.pool.filter(function (i) { return i !== ci; });
    var picks = shuffle(pool).slice(0, Math.min(CHOICES - 1, pool.length));
    return shuffle(picks.concat([ci]));
  }

  function recordMiss(ci) {
    var b = session.batch;
    b.answered++;
    if (b.round === "mc") b.mcMisses++; else b.typeMisses++;
    if (b.firstTry[ci] !== false) { b.firstTry[ci] = false; b.missed.push(ci); }
    b.queue.push(ci);
  }
  function recordPass(ci) {
    var b = session.batch;
    b.answered++;
    b.correct++;
    if (b.round === "mc") b.mcDone++; else b.typeDone++;
    if (b.firstTry[ci] === undefined) b.firstTry[ci] = true;
  }

  function answerChoice(idx) {
    var cur = session.current;
    if (session.batch.round !== "mc" || cur.result) return;
    cur.picked = idx;
    if (idx === cur.ci) {
      recordPass(cur.ci); cur.result = "ok"; render();
      advanceTimer = setTimeout(nextItem, MC_ADVANCE_MS);
    } else {
      recordMiss(cur.ci); cur.result = "bad"; render();
    }
  }
  function answerTyped(text) {
    var cur = session.current;
    if (session.batch.round !== "type" || cur.result) return;
    cur.typed = text;
    var quality = matchQuality(session.cards[cur.ci], text, session.cards);
    if (quality) {
      cur.near = quality === "near";
      recordPass(cur.ci); cur.result = "ok"; render();
      advanceTimer = setTimeout(nextItem, AUTO_ADVANCE_MS);
    } else {
      cur.result = "bad"; render(); // recorded on Continue / Override
    }
  }
  function continueAfterFeedback() {
    var cur = session.current;
    if (!cur || !cur.result) return;
    if (session.batch.round === "type" && cur.result === "bad") recordMiss(cur.ci);
    nextItem();
  }
  function overrideCorrect() {
    var cur = session.current;
    if (!cur || session.batch.round !== "type" || cur.result !== "bad") return;
    recordPass(cur.ci);
    nextItem();
  }

  function finishBatch() {
    var b = session.batch;
    var cleanCount = 0;
    b.ids.forEach(function (ci) { if (b.firstTry[ci] === true) cleanCount++; });
    session.results.push({
      size: b.size, clean: cleanCount, accuracy: pct(cleanCount, b.size),
      answered: b.answered, correct: b.correct, mcMisses: b.mcMisses, typeMisses: b.typeMisses, missed: b.missed.slice()
    });
    session.view = "batch-summary";
    render();
  }
  function nextBatch() {
    session.batchIdx++;
    if (session.batchIdx >= session.batches.length) { session.view = "final"; render(); return; }
    startBatch();
  }
  function allMissed() {
    var seen = {}, out = [];
    session.results.forEach(function (r) {
      r.missed.forEach(function (ci) { if (!seen[ci]) { seen[ci] = true; out.push(ci); } });
    });
    return out;
  }
  function goHome() {
    clearTimeout(advanceTimer);
    session = null;
    render();
  }

  // ---------- rendering ----------

  var lastScreen = null;
  function screenKey() {
    if (!session) return "home";
    var b = session.batch, c = session.current;
    return [session.view, session.batchIdx, b && b.round, c && c.ci].join(":");
  }
  function cardClass() {
    var k = screenKey();
    var cls = k === lastScreen ? "card" : "card enter";
    lastScreen = k;
    return cls;
  }

  function render() {
    if (!session) return renderHome();
    if (session.view === "question") return renderQuestion();
    if (session.view === "round-break") return renderRoundBreak();
    if (session.view === "batch-summary") return renderBatchSummary();
    return renderFinal();
  }

  function courseTabsHtml(course) {
    var all = courses();
    if (all.length < 2) return "";
    return '<div class="segmented" style="margin-bottom:6px">' + all.map(function (c) {
      return '<button class="tab' + (c === course ? " active" : "") + '" data-course="' + escapeHtml(c) + '">' + escapeHtml(c) + "</button>";
    }).join("") + "</div>";
  }

  function weekListHtml(course, set) {
    return '<div class="weeks">' + setsForCourse(course).map(function (s) {
      var st = statusOf(s);
      var n = effectiveCards(s).filter(function (c) { return !isPerson(c) && cardInSources(s, c); }).length;
      return '<button class="week' + (set && s.id === set.id ? " selected" : "") + '" data-set="' + escapeHtml(s.id) + '">' +
        '<span class="week-name">' + escapeHtml(setName(s)) + "<small>" + n + " terms</small></span>" +
        '<span class="week-right"><span class="badge ' + st.key + '"><i></i>' + st.label + '</span><span class="chev"></span></span></button>';
    }).join("") + "</div>";
  }

  function termListHtml(set, cards, pool) {
    var e = editsFor(set);
    var rows = pool.map(function (i) {
      var c = cards[i];
      var pending = ui.pendingRemove === c.term;
      var actions = pending
        ? '<span class="confirm">Remove <b>' + escapeHtml(c.term) + '</b>? <button class="btn small danger" data-remove-confirm="' + escapeHtml(c.term) + '">Remove</button> <button class="btn small" data-remove-cancel>Cancel</button></span>'
        : '<button class="btn link small" data-remove="' + escapeHtml(c.term) + '" title="Remove this term">Remove</button>';
      return '<div class="term-row' + (pending ? " pending" : "") + '"><div class="term-body"><b>' + escapeHtml(c.term) +
        (c.custom ? ' <span class="tag">added by you</span>' : "") + "</b>" + escapeHtml(c.definition) + "</div>" + actions + "</div>";
    }).join("");

    var removed = e.removed.length
      ? '<details class="removed"' + (ui.removedOpen ? " open" : "") + '><summary>Removed terms (' + e.removed.length + ")</summary>" +
        e.removed.map(function (t) {
          return '<div class="term-row"><div class="term-body"><b>' + escapeHtml(t) + '</b></div><button class="btn link small" data-restore="' + escapeHtml(t) + '">Restore</button></div>';
        }).join("") + "</details>"
      : "";

    var d = ui.addDraft;
    var addForm =
      '<form id="add-form" class="add-form">' +
        "<h3>Add a term</h3>" +
        '<input type="text" id="add-term" placeholder="Term" value="' + escapeHtml(d.term) + '" autocomplete="off">' +
        '<textarea id="add-def" placeholder="Definition (don\'t repeat the term in it)" rows="2">' + escapeHtml(d.definition) + "</textarea>" +
        '<input type="text" id="add-alt" placeholder="Other accepted answers, comma-separated (optional)" value="' + escapeHtml(d.alt) + '" autocomplete="off">' +
        (ui.addError ? '<div class="form-error">' + escapeHtml(ui.addError) + "</div>" : "") +
        '<div class="row"><button class="btn primary" type="submit">Add term</button>' +
        '<span class="small muted">Saved in this browser. Use "Export edits" to get them into the set file.</span></div>' +
      "</form>";

    var hasEdits = e.removed.length || e.added.length;
    var exportBlock = hasEdits
      ? '<div class="export-row"><button class="btn link small" id="export-toggle">' + (ui.exportOpen ? "Hide export" : "Export edits") + "</button></div>" +
        (ui.exportOpen ? '<textarea class="export" readonly rows="6">' + escapeHtml(JSON.stringify({ setId: set.id, removed: e.removed, added: e.added }, null, 2)) + "</textarea>" : "")
      : "";

    return '<div id="term-list" class="term-list">' + rows + removed + addForm + exportBlock + "</div>";
  }

  function renderHome() {
    $status.textContent = "";
    // keep the term list and the page where they were across re-renders
    var prevList = document.getElementById("term-list");
    var listScroll = prevList ? prevList.scrollTop : 0;
    var pageScroll = window.scrollY;
    if (!sets.length) {
      $app.innerHTML = '<div class="card"><h1>No term sets found</h1><p>Add a file under <code>sets/</code> and include it in <code>index.html</code>.</p></div>';
      return;
    }
    var course = currentCourse();
    var set = currentSet();
    var cards = set ? effectiveCards(set) : [];
    var pool = set ? poolFor(set, cards) : [];
    var people = cards.filter(function (c) { return isPerson(c) && cardInSources(set, c); }).length;
    var sourcesHtml = "";
    if (set && set.materials && set.materials.length) {
      sourcesHtml = '<label class="field"><span>Sources</span></label><div class="toggles sources">' +
        set.materials.map(function (file, i) {
          var n = cards.filter(function (c) { return c.src && c.src.indexOf(i) >= 0 && (prefs.includePeople || !isPerson(c)); }).length;
          return '<label class="check"><input type="checkbox" data-source="' + i + '"' + (sourceOn(set, i) ? " checked" : "") + "> " +
            escapeHtml(materialName(file)) + ' <span class="muted small">' + n + " terms</span></label>";
        }).join("") + "</div>";
    }
    var batches = Math.ceil(pool.length / batchSizeFor(pool.length));

    $app.innerHTML =
      '<div class="' + cardClass() + '">' +
        '<p class="eyebrow">Vocabulary first</p>' +
        "<h1>Clear this week's vocabulary before the readings</h1>" +
        '<p class="muted">A week is cleared once you finish every term in a writing or both-rounds session with at least ' + CLEAR_THRESHOLD + "% first-try accuracy.</p>" +
        courseTabsHtml(course) +
        weekListHtml(course, set) +
        (set ? (
          '<h2 style="margin-top:28px">' + escapeHtml(setName(set)) + "</h2>" +
          sourcesHtml +
          '<label class="field"><span>Study mode</span></label>' +
          '<div class="segmented" id="mode">' +
            '<button data-mode="both" class="' + (prefs.mode === "both" ? "active" : "") + '">Multiple choice, then writing</button>' +
            '<button data-mode="write" class="' + (prefs.mode === "write" ? "active" : "") + '">Writing only</button>' +
            '<button data-mode="mc" class="' + (prefs.mode === "mc" ? "active" : "") + '">Multiple choice only</button>' +
          "</div>" +
          '<label class="field"><span>Batch size</span></label>' +
          '<div class="segmented" id="batch-size">' +
            [10, 15, 20, "all"].map(function (v) {
              return '<button data-batch="' + v + '" class="' + (String(prefs.batchSize) === String(v) ? "active" : "") + '">' + (v === "all" ? "All terms" : v) + "</button>";
            }).join("") +
          "</div>" +
          '<div class="row" style="margin-top:18px">' +
            '<div class="toggles">' +
              '<label class="check"><input id="shuffle" type="checkbox"' + (prefs.shuffle ? " checked" : "") + "> Shuffle terms</label>" +
              (people ? '<label class="check"><input id="include-people" type="checkbox"' + (prefs.includePeople ? " checked" : "") + "> Include people &amp; works (" + people + ")</label>" : "") +
            "</div>" +
          "</div>" +
          '<p class="small muted" style="margin-top:14px">' + pool.length + " terms &middot; " + (prefs.batchSize === "all" ? "one batch" : batches + " batch" + (batches === 1 ? "" : "es") + " of " + prefs.batchSize) + "</p>" +
          '<div class="row"><button class="btn primary" id="start"' + (pool.length ? "" : " disabled") + ">Start studying</button>" +
          '<button class="btn link" id="toggle-terms">' + (ui.termsOpen ? "Hide terms" : "Show all terms") + "</button></div>" +
          (ui.termsOpen ? termListHtml(set, cards, pool) : "")
        ) : '<p class="muted">No weeks in this course yet.</p>') +
        '<p class="small muted" style="margin-top:24px">Keys <span class="kbd">1</span>–<span class="kbd">4</span> pick a choice. <span class="kbd">Enter</span> submits or continues.</p>' +
      "</div>";
    var newList = document.getElementById("term-list");
    if (newList) newList.scrollTop = listScroll;
    window.scrollTo(0, pageScroll);

    // course + week selection
    Array.prototype.forEach.call($app.querySelectorAll("[data-course]"), function (btn) {
      btn.onclick = function () { prefs.course = btn.getAttribute("data-course"); prefs.setId = null; ui.pendingRemove = null; savePrefs(); render(); };
    });
    Array.prototype.forEach.call($app.querySelectorAll("[data-set]"), function (btn) {
      btn.onclick = function () { prefs.setId = btn.getAttribute("data-set"); ui.pendingRemove = null; savePrefs(); render(); };
    });
    if (!set) return;

    // settings
    Array.prototype.forEach.call($app.querySelectorAll("[data-mode]"), function (btn) {
      btn.onclick = function () { prefs.mode = btn.getAttribute("data-mode"); savePrefs(); render(); };
    });
    Array.prototype.forEach.call($app.querySelectorAll("[data-batch]"), function (btn) {
      btn.onclick = function () {
        var v = btn.getAttribute("data-batch");
        prefs.batchSize = v === "all" ? "all" : parseInt(v, 10);
        savePrefs(); render();
      };
    });
    document.getElementById("shuffle").onchange = function (e) { prefs.shuffle = e.target.checked; savePrefs(); };
    Array.prototype.forEach.call($app.querySelectorAll("[data-source]"), function (box) {
      box.onchange = function () { toggleSource(set, parseInt(box.getAttribute("data-source"), 10), box.checked); render(); };
    });
    var inc = document.getElementById("include-people");
    if (inc) inc.onchange = function (e) { prefs.includePeople = e.target.checked; savePrefs(); render(); };
    document.getElementById("toggle-terms").onclick = function () { ui.termsOpen = !ui.termsOpen; ui.pendingRemove = null; render(); };
    document.getElementById("start").onclick = function () {
      var c = effectiveCards(set), p = poolFor(set, c);
      startSession(set, c, p, p);
    };

    // term list editing
    Array.prototype.forEach.call($app.querySelectorAll("[data-remove]"), function (btn) {
      btn.onclick = function () { ui.pendingRemove = btn.getAttribute("data-remove"); render(); };
    });
    Array.prototype.forEach.call($app.querySelectorAll("[data-remove-confirm]"), function (btn) {
      btn.onclick = function () { removeTerm(set, btn.getAttribute("data-remove-confirm")); ui.pendingRemove = null; render(); };
    });
    Array.prototype.forEach.call($app.querySelectorAll("[data-remove-cancel]"), function (btn) {
      btn.onclick = function () { ui.pendingRemove = null; render(); };
    });
    Array.prototype.forEach.call($app.querySelectorAll("[data-restore]"), function (btn) {
      btn.onclick = function () { restoreTerm(set, btn.getAttribute("data-restore")); render(); };
    });
    var form = document.getElementById("add-form");
    if (form) {
      form.onsubmit = function (e) {
        e.preventDefault();
        var term = document.getElementById("add-term").value;
        var def = document.getElementById("add-def").value;
        var alt = document.getElementById("add-alt").value;
        var err = addTerm(set, term, def, alt);
        if (err) { ui.addError = err; ui.addDraft = { term: term, definition: def, alt: alt }; }
        else { ui.addError = ""; ui.addDraft = { term: "", definition: "", alt: "" }; }
        render();
        var f = document.getElementById("add-form");
        if (f) f.scrollIntoView({ block: "nearest" });
        var t = document.getElementById("add-term");
        if (t) t.focus();
      };
    }
    var det = $app.querySelector("details.removed");
    if (det) det.ontoggle = function () { ui.removedOpen = det.open; };
    var ex = document.getElementById("export-toggle");
    if (ex) ex.onclick = function () { ui.exportOpen = !ui.exportOpen; render(); };
  }

  function progressHtml() {
    var b = session.batch;
    var done = b.round === "mc" ? b.mcDone : b.typeDone;
    var pctDone = pct(b.mcDone + b.typeDone, b.size * rounds());
    return '<div class="progress"><div class="meta">' +
      "<span>Batch " + (session.batchIdx + 1) + " of " + session.batches.length + " &middot; " + roundLabel(b.round) + "</span>" +
      "<span>" + done + " / " + b.size + " this round</span>" +
      '</div><div class="bar"><i style="width:' + pctDone + '%"></i></div></div>';
  }

  function renderQuestion() {
    var cur = session.current;
    var card = session.cards[cur.ci];
    var b = session.batch;
    $status.textContent = "Batch " + (session.batchIdx + 1) + "/" + session.batches.length + " · " + (rounds() === 2 ? (b.round === "mc" ? "Round 1" : "Round 2") : roundTitle(b.round));

    var body;
    if (b.round === "mc") {
      body = '<span class="stage-tag">' + (rounds() === 2 ? "Round 1 · " : "") + "Pick the term</span>" +
        '<p class="definition">' + escapeHtml(card.definition) + "</p>" +
        '<div class="choices">' +
        cur.choices.map(function (ci, n) {
          var cls = "choice";
          if (cur.result) {
            if (ci === cur.ci) cls += " correct";
            else if (ci === cur.picked) cls += " wrong";
          }
          return '<button class="' + cls + '" data-choice="' + ci + '"' + (cur.result ? " disabled" : "") + ">" +
            '<span class="key">' + (n + 1) + "</span><span>" + escapeHtml(session.cards[ci].term) + "</span></button>";
        }).join("") +
        "</div>";
      if (cur.result === "bad") {
        body += '<div class="feedback bad"><strong>Not quite.</strong> The answer is <b>' + escapeHtml(card.term) + "</b>. This term goes back to the end of the round." +
          '<div class="actions"><button class="btn primary" id="continue">Continue</button><span class="small muted">or press Enter</span></div></div>';
      }
    } else {
      var inputCls = cur.result === "ok" ? ' class="correct"' : cur.result === "bad" ? ' class="wrong"' : "";
      body = '<span class="stage-tag">' + (rounds() === 2 ? "Round 2 · " : "") + "Type the term</span>" +
        '<p class="definition">' + escapeHtml(card.definition) + "</p>" +
        '<form class="answer-form" id="answer-form" autocomplete="off">' +
          '<input type="text" id="answer" placeholder="Type the term" value="' + escapeHtml(cur.typed) + '"' + inputCls + (cur.result ? " disabled" : "") +
            ' autocapitalize="off" autocorrect="off" spellcheck="false">' +
          '<button class="btn primary" type="submit"' + (cur.result ? " disabled" : "") + ">Answer</button>" +
        "</form>";
      if (cur.result === "ok") {
        body += '<div class="feedback ok"><strong>' + (cur.near ? "Close enough." : "Correct!") + "</strong> " +
          (cur.near ? "Exact spelling: <b>" + escapeHtml(card.term) + "</b>" : escapeHtml(card.term)) +
          '<div class="actions"><button class="btn" id="continue">Next</button><span class="small muted">moving on automatically…</span></div></div>';
      } else if (cur.result === "bad") {
        body += '<div class="feedback bad"><strong>Not quite.</strong> The answer is <b>' + escapeHtml(card.term) + "</b>. It goes back to the end of the round." +
          (card.alt && card.alt.length ? '<div class="small muted">Also accepted: ' + card.alt.map(escapeHtml).join(", ") + "</div>" : "") +
          '<div class="actions"><button class="btn primary" id="continue">Continue</button>' +
          '<button class="btn" id="override">Override: I was right</button><span class="small muted">Enter continues</span></div></div>';
      }
    }

    $app.innerHTML = progressHtml() + '<div class="' + cardClass() + '">' + body + "</div>";

    Array.prototype.forEach.call($app.querySelectorAll("[data-choice]"), function (btn) {
      btn.onclick = function () { answerChoice(parseInt(btn.getAttribute("data-choice"), 10)); };
    });
    var form = document.getElementById("answer-form");
    if (form) {
      form.onsubmit = function (e) { e.preventDefault(); answerTyped(document.getElementById("answer").value); };
      if (!cur.result) document.getElementById("answer").focus();
    }
    var cont = document.getElementById("continue");
    if (cont) { cont.onclick = continueAfterFeedback; cont.focus(); }
    var ov = document.getElementById("override");
    if (ov) ov.onclick = overrideCorrect;
  }

  function renderRoundBreak() {
    var b = session.batch;
    $status.textContent = "Batch " + (session.batchIdx + 1) + "/" + session.batches.length + " · Round 1 done";
    $app.innerHTML = progressHtml() +
      '<div class="' + cardClass() + '">' +
        '<span class="stage-tag">Round 1 complete</span>' +
        "<h1>Now write them</h1>" +
        '<p class="muted">You picked all ' + b.size + " terms" + (b.mcMisses ? " with " + b.mcMisses + " miss" + (b.mcMisses === 1 ? "" : "es") : " without a miss") +
          ". Round 2 shows the same definitions; type the term for each.</p>" +
        '<div class="row"><button class="btn primary" id="next">Start writing round</button><span class="small muted">or press Enter</span></div>' +
      "</div>";
    var n = document.getElementById("next");
    n.onclick = startWritingRound; n.focus();
  }

  function missedTable(missedIdxs) {
    if (!missedIdxs.length) return '<p class="muted">Nothing missed. Clean sweep.</p>';
    return "<table><thead><tr><th>Term</th><th>Definition</th></tr></thead><tbody>" +
      missedIdxs.map(function (ci) {
        var c = session.cards[ci];
        return '<tr><td class="term">' + escapeHtml(c.term) + "</td><td>" + escapeHtml(c.definition) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function renderBatchSummary() {
    var r = session.results[session.results.length - 1];
    var isLast = session.batchIdx + 1 >= session.batches.length;
    $status.textContent = "Batch " + (session.batchIdx + 1) + "/" + session.batches.length + " done";
    $app.innerHTML =
      '<div class="' + cardClass() + '">' +
        '<p class="eyebrow">Batch ' + (session.batchIdx + 1) + " of " + session.batches.length + "</p>" +
        "<h1>Accuracy</h1>" +
        '<div class="big-stat ' + grade(r.accuracy) + '">' + r.accuracy + "%</div>" +
        '<p class="muted">' + r.clean + " of " + r.size + " terms right on the first try " + accuracyNote() + ".</p>" +
        '<div class="stats">' +
          (session.mode !== "write" ? '<div class="stat"><b>' + r.mcMisses + "</b><span>misses, multiple choice</span></div>" : "") +
          (session.mode !== "mc" ? '<div class="stat"><b>' + r.typeMisses + "</b><span>misses, writing</span></div>" : "") +
          '<div class="stat"><b>' + r.correct + " / " + r.answered + "</b><span>answers correct</span></div>" +
        "</div>" +
        "<h2>Missed this batch</h2>" + missedTable(r.missed) +
        '<div class="row" style="margin-top:22px">' +
          '<button class="btn primary" id="next">' + (isLast ? "See final results" : "Next batch (" + (session.batchIdx + 2) + " of " + session.batches.length + ")") + "</button>" +
          '<button class="btn link" id="home">Quit to home</button>' +
        "</div>" +
      "</div>";
    var next = document.getElementById("next");
    next.onclick = nextBatch; next.focus();
    document.getElementById("home").onclick = goHome;
  }

  function renderFinal() {
    var total = 0, clean = 0, answered = 0, correct = 0;
    session.results.forEach(function (r) { total += r.size; clean += r.clean; answered += r.answered; correct += r.correct; });
    var acc = pct(clean, total);
    var missed = allMissed();
    $status.textContent = "Session complete";
    var counts = session.fullSet && session.mode !== "mc";
    if (!session.recorded) { recordResult(session.set, acc, counts); session.recorded = true; }
    var st = statusOf(session.set);
    var verdict;
    if (st.key === "cleared" && counts && acc >= CLEAR_THRESHOLD) verdict = '<div class="feedback ok"><strong>Week cleared.</strong> You can open the readings, lectures, and slides for ' + escapeHtml(setName(session.set)) + ".</div>";
    else if (st.key === "cleared") verdict = '<div class="feedback ok"><strong>Already cleared.</strong> This week counted as cleared earlier (best ' + progress[session.set.id].best + "%).</div>";
    else if (!counts) verdict = '<div class="feedback bad"><strong>Not counted toward clearing.</strong> ' + (session.mode === "mc" ? "Multiple-choice-only sessions" : "Practice sessions on missed terms") + " don't clear a week; run every term in writing or both-rounds mode.</div>";
    else verdict = '<div class="feedback bad"><strong>Not cleared yet.</strong> You need ' + CLEAR_THRESHOLD + "% first-try accuracy over the whole week; this run was " + acc + "%. Practice the missed terms, then run the full set again.</div>";

    $app.innerHTML =
      '<div class="' + cardClass() + '">' +
        '<p class="eyebrow">' + escapeHtml((session.set.course || "") + " · " + setName(session.set)) + "</p>" +
        "<h1>Session complete</h1>" +
        '<div class="big-stat ' + grade(acc) + '">' + acc + "%</div>" +
        '<p class="muted">' + clean + " of " + total + " terms right on the first try " + accuracyNote() + ".</p>" +
        verdict +
        '<div class="stats">' +
          '<div class="stat"><b>' + session.results.length + "</b><span>batches</span></div>" +
          '<div class="stat"><b>' + missed.length + "</b><span>terms missed</span></div>" +
          '<div class="stat"><b>' + correct + " / " + answered + "</b><span>answers correct</span></div>" +
        "</div>" +
        "<h2>By batch</h2>" +
        "<table><thead><tr><th>Batch</th><th>Accuracy</th><th>First try</th><th>Missed</th></tr></thead><tbody>" +
        session.results.map(function (r, i) {
          return "<tr><td>" + (i + 1) + '</td><td><span class="pill ' + (r.accuracy >= 85 ? "ok" : "bad") + '">' + r.accuracy + "%</span></td><td>" +
            r.clean + " / " + r.size + "</td><td>" + r.missed.length + "</td></tr>";
        }).join("") +
        "</tbody></table>" +
        '<h2 style="margin-top:22px">All missed terms</h2>' + missedTable(missed) +
        '<div class="row" style="margin-top:22px">' +
          (missed.length ? '<button class="btn primary" id="practice-missed">Practice missed terms (' + missed.length + ")</button>" : "") +
          '<button class="btn" id="again">Study everything again</button>' +
          '<button class="btn link" id="home">Home</button>' +
        "</div>" +
      "</div>";

    var pm = document.getElementById("practice-missed");
    if (pm) pm.onclick = function () { startSession(session.set, session.cards, missed, session.pool); };
    document.getElementById("again").onclick = function () { startSession(session.set, session.cards, session.pool, session.pool); };
    document.getElementById("home").onclick = goHome;
  }

  // ---------- keyboard ----------

  document.addEventListener("keydown", function (e) {
    if (!session) return;
    if (session.view !== "question") {
      if (e.key === "Enter") { e.preventDefault(); var n = document.getElementById("next"); if (n) n.click(); }
      return;
    }
    var cur = session.current;
    if (cur.result && e.key === "Enter") { e.preventDefault(); continueAfterFeedback(); return; }
    if (session.batch.round === "mc" && !cur.result && /^[1-9]$/.test(e.key)) {
      var idx = parseInt(e.key, 10) - 1;
      if (idx < cur.choices.length) { e.preventDefault(); answerChoice(cur.choices[idx]); }
    }
  });

  document.getElementById("brand").onclick = function (e) { e.preventDefault(); goHome(); };

  render();
})();
