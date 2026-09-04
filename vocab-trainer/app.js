/* Vocab Trainer
 *
 * Flow per term: definition shown -> pick the term (multiple choice) ->
 * type the term. A term counts as learned only when both steps are right.
 * Any miss shows the correct answer and pushes the term to the end of the
 * current batch. Terms are studied in batches (default 15); each batch and
 * the whole session end with an accuracy score.
 */
(function () {
  "use strict";

  var DEFAULT_BATCH_SIZE = 15;
  var CHOICES = 4;
  var AUTO_ADVANCE_MS = 900;

  var $app = document.getElementById("app");
  var $status = document.getElementById("topbar-status");
  var sets = window.VOCAB_SETS || [];

  var prefs = loadPrefs();
  var session = null;      // active study session, or null on the home screen
  var advanceTimer = null; // pending auto-advance after a correct answer

  // ---------- helpers ----------

  function loadPrefs() {
    var p = { setId: sets.length ? sets[0].id : null, shuffle: true, batchSize: DEFAULT_BATCH_SIZE };
    try {
      var saved = JSON.parse(localStorage.getItem("vocab-trainer-prefs") || "{}");
      if (saved.setId && sets.some(function (s) { return s.id === saved.setId; })) p.setId = saved.setId;
      if (typeof saved.shuffle === "boolean") p.shuffle = saved.shuffle;
      if (saved.batchSize >= 1 && saved.batchSize <= 100) p.batchSize = saved.batchSize;
    } catch (e) { /* ignore */ }
    return p;
  }
  function savePrefs() {
    try { localStorage.setItem("vocab-trainer-prefs", JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }

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

  // Lower-case, strip accents, drop punctuation, collapse whitespace.
  function normalize(s) {
    return String(s)
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[‘’'`]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function singular(s) {
    return s.length > 3 && s.slice(-1) === "s" ? s.slice(0, -1) : s;
  }
  function answerMatches(card, typed) {
    var t = normalize(typed);
    if (!t) return false;
    var accepted = [card.term].concat(card.alt || []).map(normalize);
    return accepted.some(function (a) { return a === t || singular(a) === singular(t); });
  }

  function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }
  function grade(p) { return p >= 85 ? "ok" : p >= 60 ? "warn" : "bad"; }

  function currentSet() {
    return sets.filter(function (s) { return s.id === prefs.setId; })[0] || sets[0];
  }

  // ---------- session ----------

  function startSession(set, cardIdxs) {
    clearTimeout(advanceTimer);
    var order = prefs.shuffle ? shuffle(cardIdxs) : cardIdxs.slice();
    session = {
      set: set,
      batches: chunk(order, prefs.batchSize),
      batchIdx: 0,
      results: [],   // one summary per finished batch
      batch: null,
      current: null,
      view: "question"
    };
    startBatch();
  }

  function startBatch() {
    var ids = session.batches[session.batchIdx];
    session.batch = {
      queue: ids.slice(),
      size: ids.length,
      completed: 0,        // terms that passed both steps
      firstTry: {},        // cardIdx -> true (clean) / false (missed at least once)
      answered: 0,
      correct: 0,
      missed: []           // cardIdx, in the order first missed
    };
    nextItem();
  }

  function nextItem() {
    clearTimeout(advanceTimer);
    var b = session.batch;
    if (!b.queue.length) { finishBatch(); return; }
    var ci = b.queue.shift();
    session.current = { ci: ci, stage: "mc", choices: makeChoices(ci), picked: null, typed: "", result: null };
    session.view = "question";
    render();
  }

  function makeChoices(ci) {
    var cards = session.set.cards;
    var pool = [];
    for (var i = 0; i < cards.length; i++) if (i !== ci) pool.push(i);
    var picks = shuffle(pool).slice(0, Math.min(CHOICES - 1, pool.length));
    return shuffle(picks.concat([ci]));
  }

  function recordMiss(ci) {
    var b = session.batch;
    b.answered++;
    if (b.firstTry[ci] !== false) {
      b.firstTry[ci] = false;
      b.missed.push(ci);
    }
    b.queue.push(ci); // back to the end of the batch
  }

  function recordPass(ci) {
    var b = session.batch;
    b.answered++;
    b.correct++;
    b.completed++;
    if (b.firstTry[ci] === undefined) b.firstTry[ci] = true;
  }

  function answerChoice(idx) {
    var cur = session.current;
    if (cur.stage !== "mc" || cur.result) return;
    cur.picked = idx;
    if (idx === cur.ci) {
      session.batch.answered++;
      session.batch.correct++;
      cur.result = "ok";
      render();
      advanceTimer = setTimeout(function () {
        cur.stage = "type"; cur.result = null; render();
      }, 500);
    } else {
      recordMiss(cur.ci);
      cur.result = "bad";
      render();
    }
  }

  function answerTyped(text) {
    var cur = session.current;
    if (cur.stage !== "type" || cur.result) return;
    cur.typed = text;
    if (answerMatches(session.set.cards[cur.ci], text)) {
      recordPass(cur.ci);
      cur.result = "ok";
      render();
      advanceTimer = setTimeout(nextItem, AUTO_ADVANCE_MS);
    } else {
      cur.result = "bad"; // not recorded until Continue / Override
      render();
    }
  }

  function continueAfterFeedback() {
    var cur = session.current;
    if (!cur || !cur.result) return;
    if (cur.stage === "type" && cur.result === "bad") recordMiss(cur.ci);
    nextItem();
  }

  function overrideCorrect() {
    var cur = session.current;
    if (!cur || cur.stage !== "type" || cur.result !== "bad") return;
    recordPass(cur.ci);
    nextItem();
  }

  function finishBatch() {
    var b = session.batch;
    var cleanCount = 0;
    session.batches[session.batchIdx].forEach(function (ci) { if (b.firstTry[ci] === true) cleanCount++; });
    session.results.push({
      size: b.size,
      clean: cleanCount,
      accuracy: pct(cleanCount, b.size),
      answered: b.answered,
      correct: b.correct,
      missed: b.missed.slice()
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

  function render() {
    if (!session) return renderHome();
    if (session.view === "question") return renderQuestion();
    if (session.view === "batch-summary") return renderBatchSummary();
    return renderFinal();
  }

  function renderHome() {
    $status.textContent = "";
    if (!sets.length) {
      $app.innerHTML = '<div class="card"><h1>No term sets found</h1><p>Add a file under <code>sets/</code> and include it in <code>index.html</code>.</p></div>';
      return;
    }
    var set = currentSet();
    var options = sets.map(function (s) {
      return '<option value="' + escapeHtml(s.id) + '"' + (s.id === set.id ? " selected" : "") + ">" +
        escapeHtml(s.title) + " (" + s.cards.length + " terms)</option>";
    }).join("");
    var batches = Math.ceil(set.cards.length / prefs.batchSize);

    $app.innerHTML =
      '<div class="card">' +
        "<h1>Learn</h1>" +
        '<p class="muted">You get the definition. First pick the term, then type it. Miss either step and the term comes back at the end of the batch.</p>' +
        '<label class="field"><span>Term set</span><select id="set-select">' + options + "</select></label>" +
        '<div class="row">' +
          '<label class="field" style="flex:1"><span>Batch size</span><input id="batch-size" type="number" min="1" max="100" value="' + prefs.batchSize + '"></label>' +
          '<label class="check" style="margin-top:24px"><input id="shuffle" type="checkbox"' + (prefs.shuffle ? " checked" : "") + "> Shuffle terms</label>" +
        "</div>" +
        '<p class="small muted">' + set.cards.length + " terms &rarr; " + batches + " batch" + (batches === 1 ? "" : "es") +
          (set.source ? " &middot; source: " + escapeHtml(set.source) : "") + "</p>" +
        '<div class="row"><button class="btn primary" id="start">Start</button>' +
        '<button class="btn link" id="toggle-terms">Show all terms</button></div>' +
        '<div id="term-list" class="term-list" style="margin-top:16px" hidden>' +
          set.cards.map(function (c) { return "<div><b>" + escapeHtml(c.term) + "</b>" + escapeHtml(c.definition) + "</div>"; }).join("") +
        "</div>" +
        '<p class="small muted" style="margin-top:18px">Shortcuts: <span class="kbd">1</span>-<span class="kbd">4</span> pick a choice, <span class="kbd">Enter</span> submits or continues.</p>' +
      "</div>";

    document.getElementById("set-select").onchange = function (e) { prefs.setId = e.target.value; savePrefs(); render(); };
    document.getElementById("batch-size").onchange = function (e) {
      var v = parseInt(e.target.value, 10);
      prefs.batchSize = isNaN(v) ? DEFAULT_BATCH_SIZE : Math.max(1, Math.min(100, v));
      savePrefs(); render();
    };
    document.getElementById("shuffle").onchange = function (e) { prefs.shuffle = e.target.checked; savePrefs(); };
    document.getElementById("toggle-terms").onclick = function (e) {
      var list = document.getElementById("term-list");
      list.hidden = !list.hidden;
      e.target.textContent = list.hidden ? "Show all terms" : "Hide terms";
    };
    document.getElementById("start").onclick = function () {
      startSession(set, set.cards.map(function (_, i) { return i; }));
    };
  }

  function progressHtml() {
    var b = session.batch;
    var pctDone = pct(b.completed, b.size);
    return '<div class="progress"><div class="meta">' +
      "<span>Batch " + (session.batchIdx + 1) + " of " + session.batches.length + "</span>" +
      "<span>" + b.completed + " / " + b.size + " learned &middot; " + (b.size - b.completed) + " to go</span>" +
      '</div><div class="bar"><i style="width:' + pctDone + '%"></i></div></div>';
  }

  function renderQuestion() {
    var cur = session.current;
    var card = session.set.cards[cur.ci];
    var b = session.batch;
    $status.textContent = "Batch " + (session.batchIdx + 1) + "/" + session.batches.length + " · " + b.completed + "/" + b.size;

    var body;
    if (cur.stage === "mc") {
      body = '<span class="stage-tag">Step 1 · Pick the term</span>' +
        '<p class="definition">' + escapeHtml(card.definition) + "</p>" +
        '<div class="choices">' +
        cur.choices.map(function (ci, n) {
          var cls = "choice";
          if (cur.result) {
            if (ci === cur.ci) cls += " correct";
            else if (ci === cur.picked) cls += " wrong";
          }
          return '<button class="' + cls + '" data-choice="' + ci + '"' + (cur.result ? " disabled" : "") + ">" +
            '<span class="key">' + (n + 1) + "</span><span>" + escapeHtml(session.set.cards[ci].term) + "</span></button>";
        }).join("") +
        "</div>";
      if (cur.result === "bad") {
        body += '<div class="feedback bad"><strong>Not quite.</strong> The answer is <b>' + escapeHtml(card.term) + "</b>. This term goes back to the end of the batch." +
          '<div class="actions"><button class="btn primary" id="continue">Continue</button><span class="small muted">or press Enter</span></div></div>';
      }
    } else {
      var inputCls = cur.result === "ok" ? " class=\"correct\"" : cur.result === "bad" ? " class=\"wrong\"" : "";
      body = '<span class="stage-tag">Step 2 · Type the term</span>' +
        '<p class="definition">' + escapeHtml(card.definition) + "</p>" +
        '<form class="answer-form" id="answer-form" autocomplete="off">' +
          '<input type="text" id="answer" placeholder="Type the term" value="' + escapeHtml(cur.typed) + '"' + inputCls + (cur.result ? " disabled" : "") +
            ' autocapitalize="off" autocorrect="off" spellcheck="false">' +
          '<button class="btn primary" type="submit"' + (cur.result ? " disabled" : "") + ">Answer</button>" +
        "</form>";
      if (cur.result === "ok") {
        body += '<div class="feedback ok"><strong>Correct!</strong> ' + escapeHtml(card.term) +
          '<div class="actions"><button class="btn" id="continue">Next</button><span class="small muted">moving on automatically…</span></div></div>';
      } else if (cur.result === "bad") {
        body += '<div class="feedback bad"><strong>Not quite.</strong> The answer is <b>' + escapeHtml(card.term) + "</b>." +
          (card.alt && card.alt.length ? '<div class="small muted">Also accepted: ' + card.alt.map(escapeHtml).join(", ") + "</div>" : "") +
          '<div class="actions"><button class="btn primary" id="continue">Continue</button>' +
          '<button class="btn" id="override">Override: I was right</button><span class="small muted">Enter continues</span></div></div>';
      }
    }

    $app.innerHTML = progressHtml() + '<div class="card">' + body + "</div>";

    Array.prototype.forEach.call($app.querySelectorAll("[data-choice]"), function (btn) {
      btn.onclick = function () { answerChoice(parseInt(btn.getAttribute("data-choice"), 10)); };
    });
    var form = document.getElementById("answer-form");
    if (form) {
      form.onsubmit = function (e) { e.preventDefault(); answerTyped(document.getElementById("answer").value); };
      var input = document.getElementById("answer");
      if (!cur.result) input.focus();
    }
    var cont = document.getElementById("continue");
    if (cont) { cont.onclick = continueAfterFeedback; cont.focus(); }
    var ov = document.getElementById("override");
    if (ov) ov.onclick = overrideCorrect;
  }

  function missedTable(missedIdxs) {
    if (!missedIdxs.length) return '<p class="muted">Nothing missed. Clean sweep.</p>';
    return "<table><thead><tr><th>Term</th><th>Definition</th></tr></thead><tbody>" +
      missedIdxs.map(function (ci) {
        var c = session.set.cards[ci];
        return '<tr><td class="term">' + escapeHtml(c.term) + "</td><td>" + escapeHtml(c.definition) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function renderBatchSummary() {
    var r = session.results[session.results.length - 1];
    var isLast = session.batchIdx + 1 >= session.batches.length;
    $status.textContent = "Batch " + (session.batchIdx + 1) + "/" + session.batches.length + " done";

    $app.innerHTML =
      '<div class="card">' +
        '<p class="muted small">Batch ' + (session.batchIdx + 1) + " of " + session.batches.length + "</p>" +
        "<h1>Accuracy</h1>" +
        '<div class="big-stat ' + grade(r.accuracy) + '">' + r.accuracy + "%</div>" +
        '<p class="muted">' + r.clean + " of " + r.size + " terms right on the first try (both steps).</p>" +
        '<div class="stats">' +
          '<div class="stat"><b>' + r.size + "</b><span>terms in batch</span></div>" +
          '<div class="stat"><b>' + r.missed.length + "</b><span>terms missed</span></div>" +
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

    $app.innerHTML =
      '<div class="card">' +
        '<p class="muted small">' + escapeHtml(session.set.title) + "</p>" +
        "<h1>Session complete</h1>" +
        '<div class="big-stat ' + grade(acc) + '">' + acc + "%</div>" +
        '<p class="muted">' + clean + " of " + total + " terms right on the first try.</p>" +
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
    if (pm) pm.onclick = function () { startSession(session.set, missed); };
    document.getElementById("again").onclick = function () {
      startSession(session.set, session.set.cards.map(function (_, i) { return i; }));
    };
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
    if (cur.result && e.key === "Enter") {
      e.preventDefault();
      if (cur.result === "ok" && cur.stage === "mc") return; // brief flash, then typing
      continueAfterFeedback();
      return;
    }
    if (cur.stage === "mc" && !cur.result && /^[1-9]$/.test(e.key)) {
      var idx = parseInt(e.key, 10) - 1;
      if (idx < cur.choices.length) { e.preventDefault(); answerChoice(cur.choices[idx]); }
    }
  });

  document.getElementById("brand").onclick = function (e) { e.preventDefault(); goHome(); };

  render();
})();
