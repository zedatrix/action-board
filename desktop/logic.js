// Pure board logic for the desktop app. No electron imports so node --test can run it.

// Same rule as the page's "Needs you": a decision with any answer is not open.
function openCards(board) {
  const decisions = board && Array.isArray(board.decisions) ? board.decisions : [];
  return decisions.filter((d) => d && typeof d === "object" && d.id != null && !d.answer);
}

function openCount(board) {
  return openCards(board).length;
}

function badgeText(count) {
  return count ? String(count) : "";
}

function newCards(seenIds, board) {
  return openCards(board).filter((d) => !seenIds.has(d.id));
}

function trim(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function notificationFor(card) {
  return {
    title: "New card: " + (card.title ? trim(card.title, 80) : trim(card.question, 80)),
    body: trim(card.context || card.question, 140),
  };
}

// First update seeds the seen ids (cards already open at launch are not announced).
// Later updates return open cards whose id was never seen; seen ids stay seen forever.
function createTracker() {
  const seen = new Set();
  let seeded = false;
  return {
    update(board) {
      const fresh = newCards(seen, board);
      for (const card of openCards(board)) seen.add(card.id);
      const count = openCount(board);
      const first = !seeded;
      seeded = true;
      return { count, badge: badgeText(count), fresh: first ? [] : fresh };
    },
  };
}

// Go menu items for the page's tab labels, in order: Cmd-1 is the first tab, up to Cmd-9.
function tabMenuItems(labels) {
  return (Array.isArray(labels) ? labels : [])
    .slice(0, 9)
    .map((label, i) => ({ label: String(label), accelerator: "CommandOrControl+" + (i + 1), index: i }));
}

module.exports = { openCards, openCount, badgeText, newCards, notificationFor, createTracker, tabMenuItems };
