/* global MiniSearch */

const DATA_URL = "./kokomo_services.json";

const $q = document.getElementById("q");
const $results = document.getElementById("results");
const $meta = document.getElementById("meta");
const $chips = document.getElementById("chips");
const $clearBtn = document.getElementById("clearBtn");
const $suggestions = document.getElementById("suggestions");
const $assistant = document.getElementById("assistant");
const $clarifier = document.getElementById("clarifier");

let miniSearch;
let entries = [];
let TAG_POOL = [];

const QUICK_CHIPS = [
  "pay water bill",
  "report pothole",
  "trash pickup",
  "police non emergency",
  "school phone",
  "hours",
  "directions",
  "animal control"
];

/**
 * Intent rules (no LLM)
 * - match: array of words/phrases that indicate intent
 * - say: what we show in the assistant banner
 * - boost: field/category boosts + extra query expansion terms
 */
const INTENTS = [
  {
    id: "pay_bill",
    match: ["pay", "payment", "bill", "billing", "invoice", "late fee"],
    say: "Sounds like you’re trying to **pay a bill / handle billing**.",
    expand: ["pay bill", "billing", "payment"],
    boost: { tags: 2.5, name: 2.0, summary: 1.2, org: 1.1 }
  },
  {
    id: "report_issue",
    match: ["report", "complaint", "problem", "pothole", "broken", "noise", "leak", "outage"],
    say: "Sounds like you want to **report an issue**.",
    expand: ["report", "complaint", "service request"],
    boost: { tags: 2.6, name: 1.8, summary: 1.3, org: 1.1 }
  },
  {
    id: "hours",
    match: ["hours", "open", "close", "closing", "time", "when"],
    say: "Sounds like you’re looking for **hours / when something is open**.",
    expand: ["hours", "open", "close"],
    boost: { summary: 1.5, tags: 2.0, name: 1.8, org: 1.1 }
  },
  {
    id: "phone",
    match: ["phone", "call", "number", "contact"],
    say: "Sounds like you need a **phone number / contact**.",
    expand: ["phone", "call", "contact"],
    boost: { name: 2.2, tags: 2.0, summary: 1.2, org: 1.1 }
  },
  {
    id: "directions",
    match: ["address", "directions", "where", "location", "map"],
    say: "Sounds like you’re looking for an **address / directions**.",
    expand: ["address", "directions", "map"],
    boost: { tags: 2.0, summary: 1.3, name: 1.7, org: 1.1 }
  },
  {
    id: "school",
    match: ["school", "elementary", "middle", "high", "bus", "enroll", "registration"],
    say: "Sounds like you’re looking for **school info**.",
    expand: ["school", "enroll", "registration"],
    boost: { tags: 2.5, name: 2.2, summary: 1.2, org: 1.2 }
  }
];

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatPhoneLink(phone) {
  const digits = String(phone).replace(/[^\d+]/g, "");
  return `tel:${digits}`;
}

function bestPrimaryLink(entry) {
  const links = entry.links || [];
  const priority = ["payment", "form", "action", "map", "info"];
  for (const type of priority) {
    const found = links.find((l) => (l.type || "info") === type);
    if (found) return found;
  }
  return null;
}

/* ---------------------------
   Assistant banner + clarifier
---------------------------- */

function setAssistantMessage(markdownish) {
  if (!markdownish) {
    $assistant.style.display = "none";
    $assistant.innerHTML = "";
    return;
  }
  // quick “markdownish” -> bold only
  const html = escapeHtml(markdownish).replaceAll("**", "<strong>").replaceAll("<strong><strong>", "**");
  // the replace above isn’t perfect; do a safer pass:
  const fixed = markdownish
    .split("**")
    .map((p, i) => (i % 2 === 1 ? `<strong>${escapeHtml(p)}</strong>` : escapeHtml(p)))
    .join("");

  $assistant.style.display = "block";
  $assistant.innerHTML = `<p class="line">${fixed}</p>`;
}

function clearClarifier() {
  $clarifier.style.display = "none";
  $clarifier.innerHTML = "";
}

function showClarifier(prompt, options) {
  if (!options?.length) return clearClarifier();
  $clarifier.style.display = "flex";
  $clarifier.innerHTML =
    `<div class="prompt">${escapeHtml(prompt)}</div>` +
    options
      .map(
        (o) =>
          `<button class="clarBtn" type="button" data-q="${escapeHtml(o.query)}">${escapeHtml(o.label)}</button>`
      )
      .join("");

  $clarifier.querySelectorAll("button.clarBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nq = btn.getAttribute("data-q") || "";
      $q.value = nq;
      renderResults(nq);
      $q.focus();
    });
  });
}

/* ---------------------------
   Matched-on explanation
---------------------------- */

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function computeMatchedOn(entry, query, limit = 4) {
  const qTokens = new Set(tokenize(query));
  if (!qTokens.size) return [];

  const tagHits = (entry.tags || []).filter((t) => qTokens.has(String(t).toLowerCase()));
  const nameTokens = tokenize(entry.name);
  const nameHits = nameTokens.filter((t) => qTokens.has(t));
  const summaryTokens = tokenize(entry.summary || "");
  const summaryHits = summaryTokens.filter((t) => qTokens.has(t));

  const combined = [...new Set([...tagHits, ...nameHits, ...summaryHits])];
  return combined.slice(0, limit);
}

/* ---------------------------
   Cards (no category badges)
---------------------------- */

function renderEntryCard(entry, score, query) {
  const c = entry.contact || {};
  const phone = c.phone_primary ? escapeHtml(c.phone_primary) : "";
  const email = c.email ? escapeHtml(c.email) : "";
  const address = c.address ? escapeHtml(c.address) : "";
  const hours = c.hours ? escapeHtml(c.hours) : "";

  const links = Array.isArray(entry.links) ? entry.links : [];
  const primary = bestPrimaryLink(entry);

  const linkButtons = links.map((l) => {
    const label = escapeHtml(l.label || "Link");
    const url = escapeHtml(l.url || "#");
    const isPrimary = primary && primary.url === l.url;
    return `<a class="btn ${isPrimary ? "primary" : ""}" href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });

  const phoneBtn = phone ? `<a class="btn primary" href="${formatPhoneLink(phone)}">Call</a>` : "";
  const emailBtn = email ? `<a class="btn" href="mailto:${email}">Email</a>` : "";

  const matchedOn = query ? computeMatchedOn(entry, query) : [];
  const matchedLine = matchedOn.length
    ? `<div class="small">Matched on: ${matchedOn.map(escapeHtml).join(", ")}</div>`
    : "";

  return `
    <article class="card">
      <h3 class="title">${escapeHtml(entry.name)}</h3>
      ${entry.org ? `<div class="small">${escapeHtml(entry.org)}</div>` : ""}

      ${entry.summary ? `<p class="summary">${escapeHtml(entry.summary)}</p>` : ""}

      ${phone ? `<div class="small">📞 ${phone}</div>` : ""}
      ${email ? `<div class="small">✉️ ${email}</div>` : ""}
      ${address ? `<div class="small">📍 ${address}</div>` : ""}
      ${hours ? `<div class="small">🕒 ${hours}</div>` : ""}

      <div class="actions">
        ${phoneBtn}
        ${emailBtn}
        ${linkButtons.join("")}
      </div>

      ${matchedLine}
    </article>
  `;
}

/* ---------------------------
   Chips
---------------------------- */

function buildChips() {
  $chips.innerHTML = QUICK_CHIPS
    .map((t) => `<button class="chip" type="button" data-chip="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
    .join("");

  $chips.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-chip]");
    if (!btn) return;
    const term = btn.getAttribute("data-chip") || "";
    $q.value = term;
    renderResults(term);
    $q.focus();
  });
}

/* ---------------------------
   Did you mean
---------------------------- */

function buildTagPool(entries) {
  const set = new Set();
  for (const e of entries) for (const t of e.tags || []) set.add(String(t).toLowerCase());
  return [...set];
}

function levenshtein(a, b) {
  a = String(a);
  b = String(b);
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      m[i][j] =
        b[i - 1] === a[j - 1] ? m[i - 1][j - 1] : 1 + Math.min(m[i - 1][j], m[i][j - 1], m[i - 1][j - 1]);
    }
  }
  return m[b.length][a.length];
}

function suggestTerms(query, resultCount) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];
  if (resultCount > 2) return []; // keep it subtle

  const direct = TAG_POOL.filter((t) => t.includes(q));
  const fuzzy = TAG_POOL.filter((t) => {
    const lenDiff = Math.abs(t.length - q.length);
    if (lenDiff > 3) return false;
    return levenshtein(t, q) <= 2;
  });

  const combined = [...new Set([...direct, ...fuzzy])];
  if (!combined.length) return QUICK_CHIPS.slice(0, 5);
  return combined.slice(0, 5);
}

function renderSuggestions(list) {
  if (!list || !list.length) {
    $suggestions.innerHTML = "";
    return;
  }
  $suggestions.innerHTML =
    `<span class="small">Did you mean:</span>` +
    list.map((s) => `<button class="suggest" type="button" data-s="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("");

  $suggestions.querySelectorAll("button.suggest").forEach((btn) => {
    btn.addEventListener("click", () => {
      const term = btn.getAttribute("data-s") || "";
      $q.value = term;
      renderResults(term);
      $q.focus();
    });
  });
}

/* ---------------------------
   Intent detection + query expansion
---------------------------- */

function detectIntent(query) {
  const q = String(query || "").toLowerCase();
  if (!q.trim()) return null;

  let best = null;
  let bestHits = 0;

  for (const intent of INTENTS) {
    let hits = 0;
    for (const m of intent.match) {
      if (q.includes(m)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = intent;
    }
  }

  // require at least one signal
  return bestHits ? best : null;
}

function buildExpandedQuery(rawQuery, intent) {
  const q = rawQuery.trim();
  if (!intent) return q;

  // Add expansion terms once, without spam
  const extras = (intent.expand || []).filter((x) => x && !q.toLowerCase().includes(x));
  if (!extras.length) return q;

  // MiniSearch doesn't support OR syntax like Google; but adding extra words
  // can help fuzzy/prefix matching without an LLM.
  return `${q} ${extras.join(" ")}`.trim();
}

/* ---------------------------
   Search + “AI feel”
---------------------------- */

function renderResults(query) {
  const raw = (query || "").trim();

  if (!raw) {
    setAssistantMessage("Ask me something like **pay water bill**, **report pothole**, or **school phone**.");
    clearClarifier();
    renderSuggestions([]);
    $meta.textContent = `Loaded ${entries.length} entries. Try a chip.`;
    $results.innerHTML = entries.slice(0, 8).map((e) => renderEntryCard(e, null, "")).join("");
    return;
  }

  const intent = detectIntent(raw);
  setAssistantMessage(intent?.say || "Okay — I’ll try to find the best match.");

  const expanded = buildExpandedQuery(raw, intent);

  const hits = miniSearch.search(expanded, {
    boost: intent?.boost || { name: 2.0, tags: 2.0, summary: 1.2, org: 1.1 },
    prefix: true,
    fuzzy: 0.2
  });

  // Build scored results, allow priority tie-break if present
  const ranked = hits
    .map((h) => {
      const entry = entries.find((e) => e.id === h.id);
      if (!entry) return null;
      const priority = typeof entry.priority === "number" ? entry.priority : 50;
      return { entry, score: h.score + priority * 0.01 };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const top = ranked.slice(0, 12);

  $meta.textContent = top.length
    ? `Showing ${top.length} results for “${raw}”.`
    : `No results for “${raw}”. Try different words (e.g., "trash", "permit", "pothole").`;

  $results.innerHTML = top.length
    ? top.map(({ entry, score }) => renderEntryCard(entry, score, raw)).join("")
    : "";

  // Did you mean
  renderSuggestions(suggestTerms(raw, top.length));

  // Clarifier: if top two are close, ask
  clearClarifier();
  if (top.length >= 2) {
    const a = top[0], b = top[1];
    const ratio = b.score / a.score; // close to 1.0 means ambiguous
    if (ratio > 0.88) {
      showClarifier("Quick question — did you mean:", [
        { label: top[0].entry.name, query: `${raw} ${top[0].entry.name}` },
        { label: top[1].entry.name, query: `${raw} ${top[1].entry.name}` }
      ]);
    }
  }
}

/* ---------------------------
   Init
---------------------------- */

async function init() {
  buildChips();

  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`Failed to load ${DATA_URL}`);
  const data = await res.json();

  // Expecting { entries: [...] }
  entries = (data.entries || []).map((e) => ({
    ...e,
    org: e.org || "",
    tags: (e.tags || []).map((t) => String(t).toLowerCase()),
    summary: e.summary || "",
    name: e.name || ""
  }));

  TAG_POOL = buildTagPool(entries);

  miniSearch = new MiniSearch({
    fields: ["name", "tags", "summary", "org"],
    storeFields: ["id"],
    idField: "id"
  });

  miniSearch.addAll(entries);

  renderResults("");

  $q.addEventListener("input", () => renderResults($q.value));
  $clearBtn.addEventListener("click", () => {
    $q.value = "";
    renderResults("");
    $q.focus();
  });
}

init().catch((err) => {
  console.error(err);
  $meta.textContent = "Error loading directory data. Check console.";
});
