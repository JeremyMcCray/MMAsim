// Pit two brains against each other headless and print the record.
//   node tools/versus.js <brainA> <brainB> [fights=10] [rounds=3] [roundLen=180]
// A brain is `cpu` / `cpu:0.3` (scripted CPU at a level) or a checkpoint file such as brains/gen-0120.json.
// Sides and archetypes alternate so neither brain gets the red corner every time.
const fs = require('fs');
const path = require('path');
const A = require('./arena.js');

function parse(s) {
  if (s === 'cpu' || s.startsWith('cpu:')) return { type: 'cpu', diff: s === 'cpu' ? 0.6 : parseFloat(s.slice(4)), label: 'CPU ' + (s === 'cpu' ? 0.6 : s.slice(4)) };
  const file = fs.existsSync(s) ? s : path.join(__dirname, '..', 'brains', s);
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { type: 'nn', arch: g.arch, w: g.w, label: g.name || path.basename(file) };
}

(async () => {
  const [a, b] = [parse(process.argv[2] || 'cpu'), parse(process.argv[3] || 'cpu:0.9')];
  const fights = parseInt(process.argv[4] || '10', 10), rounds = parseInt(process.argv[5] || '3', 10), roundLen = parseInt(process.argv[6] || '180', 10);
  await A.init();
  const F = ['striker', 'wrestler', 'grappler', 'balanced'];
  const rec = { a: 0, b: 0, d: 0 }, methods = {};
  for (let n = 0; n < fights; n++) {
    const swap = n % 2 === 1;
    const r = A.runMatch({ seed: 1000 + n, brains: swap ? [b, a] : [a, b], fighters: [F[n % 4], F[(n * 3 + 1) % 4]], rounds, roundLen });
    const winner = r.winner == null ? null : (r.winner === 0) !== swap ? 'a' : 'b';
    rec[winner || 'd']++;
    const m = r.method.replace(/\(.*\)/, '').trim(); methods[m] = (methods[m] || 0) + 1;
    console.log(`fight ${n + 1}: ${winner === 'a' ? a.label : winner === 'b' ? b.label : 'draw'}  ${r.method} R${r.round || '-'}  landed ${r.tally[swap ? 1 : 0].landed}/${r.tally[swap ? 0 : 1].landed}`);
  }
  console.log(`\n${a.label} ${rec.a} – ${rec.b} ${b.label}${rec.d ? ' (' + rec.d + ' draws)' : ''}   ${Object.entries(methods).map(([k, v]) => k + ' ' + v).join(', ')}`);
})();
