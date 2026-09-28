// Small, dependency-free CSV read/write — the spreadsheets churches see (device-pull
// export, member/attendance uploads) are plain .csv files that open natively in Excel.
// Pure functions, no DOM, so they're easy to unit test (see app/test/csv.test.js) and to
// reuse from both browser code and anywhere else that needs them.

// Parse CSV text into rows of string cells. Handles the RFC 4180 basics Excel actually
// produces: quoted fields, commas/quotes/newlines inside a quoted field, and "" as an
// escaped quote. Not exhaustive (e.g. no support for stray unescaped quotes), just correct
// for normal Excel-exported CSVs.
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip — paired \n (if any) ends the row */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Turn rows of cells back into CSV text, quoting only the fields that need it (contain a
// comma, quote or newline) so a plain spreadsheet stays easy to read/diff.
export function toCSV(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}
