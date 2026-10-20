"use strict";

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", quoted = false, closedQuote = false;
  const finishCell = () => { row.push(cell); cell = ""; closedQuote = false; };
  const finishRow = () => { finishCell(); if (row.some((value) => value !== "")) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else cell += ch;
    } else if (ch === ",") finishCell();
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; finishRow(); }
    else if (ch === '"' && cell === "" && !closedQuote) quoted = true;
    else {
      if (closedQuote || ch === '"') throw new Error("Invalid CSV quoting.");
      cell += ch;
    }
  }
  if (quoted) throw new Error("An incomplete quoted field was found.");
  if (cell !== "" || row.length || closedQuote) finishRow();
  if (!rows.length) throw new Error("The file is empty.");
  const header = rows.shift();
  if (header.some((name) => !name) || new Set(header).size !== header.length) throw new Error("Column names must be non-empty and unique.");
  const records = rows.map((values, index) => {
    if (values.length !== header.length) throw new Error(`Record ${index + 2} has an unexpected number of columns.`);
    return Object.fromEntries(header.map((key, index) => [key, values[index]]));
  });
  return { header, records };
}

// The served season's clubs, for code that runs on every page whether or not
// the page loaded the season itself (the profile's favourite team).
async function readSeasonTeams() {
  const response = await fetch("/local-data/teams.csv", { cache: "no-cache" });
  if (!response.ok) throw new Error(`teams.csv: HTTP ${response.status}`);
  return parseCSV(await response.text()).records;
}

