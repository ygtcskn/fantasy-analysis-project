const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function summary() {
  const context = vm.createContext({
    number: value => value == null || value === '' ? null : Number(value),
  });
  // The site's language script loads first, as it does in index.html; outside
  // a browser it leaves every text as written.
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/web/core/language.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/web/data/fantasy.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/web/features/builder/summary.js'), 'utf8'), context);
  return code => vm.runInContext(code, context);
}

const row = (fields) => ({ availability_status: 'no_reported_absence', eligible_for_selection: 'True', ...fields });

test('totals add every available forecast and count confirmed outs as zero', () => {
  const run = summary();
  const rows = JSON.stringify([
    row({ expected_points: '5.5', expected_yellow_cards: '0.2' }),
    row({ expected_points: '3', expected_yellow_cards: '0.1' }),
    row({ availability_status: 'out', expected_points: '', expected_yellow_cards: '' }),
  ]);
  assert.deepEqual({ ...run(`builderSummaryTotal(${rows}, 'expected_points')`) }, { total: 8.5, count: 3 });
  assert.equal(run(`builderSummaryTotal(${rows}, 'expected_yellow_cards').total`).toFixed(2), '0.30');
});

test('missing, suppressed and older card-less forecasts are left out, never zero-filled', () => {
  const run = summary();
  const rows = JSON.stringify([
    row({ expected_points: '4' }),
    row({ availability_status: 'doubtful', expected_points: '' }),
    null,
  ]);
  assert.deepEqual({ ...run(`builderSummaryTotal(${rows}, 'expected_points')`) }, { total: 4, count: 1 });
  assert.deepEqual({ ...run(`builderSummaryTotal(${rows}, 'expected_yellow_cards')`) }, { total: null, count: 0 });
});
