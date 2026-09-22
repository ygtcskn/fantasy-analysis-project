const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function builder() {
  const controls = { 'builder-formation': { value: '4-3-3' } };
  const context = vm.createContext({
    $: id => controls[id],
    number: value => value == null || value === '' ? null : Number(value),
    state: { seasonSlug: '2026-2027' },
    fantasyState: { season: '2026-2027', projections: new Map(), summaries: new Map() },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/web/features/builder/builder.js'), 'utf8'), context);
  vm.runInContext(`
    const testPlayers = [
      { id: '1', name: 'Starter', positions: ['Attacker'], squadTeam: '1' },
      { id: '2', name: 'Substitute', positions: ['Attacker'], squadTeam: '2' },
      { id: '3', name: 'Expensive', positions: ['Attacker'], squadTeam: '3' },
    ];
    for (const [id, price] of [['1', 10], ['2', 5], ['3', 99]])
      fantasyState.projections.set(id, [{ price_million_try: price, position: 'FOR', team_id: id }]);
    builderData = () => ({ players: testPlayers });
    renderSquadBuilder = () => {};
    focusBuilderSlot = () => {};
    builderMessage = () => {};
  `, context);
  return code => vm.runInContext(code, context);
}

test('substitutes consume money, swap without double charging, and refund on removal', () => {
  const run = builder();
  run(`placeBuilderPlayer('1', 'FWD-0'); placeBuilderPlayer('2', 'BENCH-0');`);
  assert.equal(run('builderBudget().spent'), 15_000_000);
  assert.equal(run('builderBudget().bench'), 5_000_000);
  run(`placeBuilderPlayer('1', 'BENCH-0');`);
  assert.equal(run(`builderState.selected.get('FWD-0')`), '2');
  assert.equal(run('builderBudget().spent'), 15_000_000);
  assert.equal(run('builderBudget().bench'), 10_000_000);
  run(`removeBuilderPlayer('BENCH-0');`);
  assert.equal(run('builderBudget().remaining'), 95_000_000);
});

test('bench is retained through formation changes and overspending is rejected', () => {
  const run = builder();
  run(`placeBuilderPlayer('1', 'FWD-0'); placeBuilderPlayer('2', 'BENCH-0');
    $('builder-formation').value = '4-4-2'; changeBuilderFormation();`);
  assert.equal(run(`builderState.selected.get('BENCH-0')`), '2');
  assert.equal(run('builderSlots().length'), 15);
  run(`placeBuilderPlayer('3', 'BENCH-1');`);
  assert.equal(run(`builderState.selected.has('BENCH-1')`), false);
  assert.equal(run('builderBudget().spent'), 15_000_000);
});

test('unknown bench prices are not treated as free players', () => {
  const run = builder();
  run(`fantasyState.projections.get('2')[0].price_million_try = ''; placeBuilderPlayer('2', 'BENCH-0');`);
  assert.equal(run('builderState.selected.size'), 0);
});
