// sports/nfl/csv.js — streaming quoted-CSV parser for nflverse flat files.
// Handles double-quoted fields containing commas or newlines (PBP description
// columns contain commas), and emits only the requested columns per row to keep
// memory bounded on the ~50MB play_by_play file.

/**
 * Iterate CSV rows, emitting an object keyed by the requested column names.
 * @param {string} text full CSV text
 * @param {Record<string, number>} header  column name -> 0-based index (from headerMap)
 * @param {string[]} wantedNames  column names to keep
 * @param {(row: Record<string, string>) => void} emit  called once per data row
 */
export function iterCSV(text, header, wantedNames, emit) {
  const wantIdx = new Set();
  const nameByRank = []; // sorted [index, name]
  for (const n of wantedNames) {
    const i = header[n];
    if (i !== undefined && i !== null) { wantIdx.add(i); nameByRank.push([i, n]); }
  }
  nameByRank.sort((a, b) => a[0] - b[0]);
  const rankOf = new Map();
  nameByRank.forEach(([i, n], r) => rankOf.set(i, r));

  let fieldIdx = 0, buf = '', inQuote = false, obj = {}, have = 0;
  const push = () => {
    if (wantIdx.has(fieldIdx)) { obj[nameByRank[rankOf.get(fieldIdx)][1]] = buf; have++; }
    fieldIdx++; buf = '';
  };
  const flushRow = () => { if (have > 0) emit(obj); obj = {}; have = 0; fieldIdx = 0; };

  for (let i = 0, len = text.length; i < len; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { buf += '"'; i++; }
        else inQuote = false;
      } else buf += ch;
    } else {
      if (ch === '"') { inQuote = true; continue; }
      if (ch === ',') { push(); continue; }
      if (ch === '\n') { push(); flushRow(); continue; }
      if (ch === '\r') continue;
      buf += ch;
    }
  }
  if (have > 0 || buf !== '') { push(); flushRow(); }
}

/** Parse a header line into a column-name -> index map. */
export function headerMap(headerLine) {
  const cols = {};
  const parts = headerLine.split(',');
  for (let i = 0; i < parts.length; i++) cols[parts[i]] = i;
  return cols;
}
