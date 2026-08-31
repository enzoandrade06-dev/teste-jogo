// Simulação headless: roda uma corrida inteira sem navegador para validar
// física, contagem de voltas e IA.  `node test/sim.js`
const stubCtx = new Proxy({}, { get: () => () => ({}) });
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => stubCtx }),
};

const { TRACKS, Track } = await import('../src/track.js');
const { CHARACTERS } = await import('../src/characters.js');
const { Racer, resolveKartCollisions } = await import('../src/kart.js');
const { KartAI } = await import('../src/ai.js');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

for (const def of TRACKS) {
  console.log(`\n=== ${def.name} ===`);
  const track = new Track(def);
  check('traçado fechado e amostrado', track.n === 900 && track.length > 200,
    `${track.length.toFixed(0)} m, ${track.segLen.toFixed(2)} m/amostra`);

  // --- geometria: curvas dirigíveis e sem auto-interseção ---
  let minR = Infinity, minRAt = 0;
  for (let i = 0; i < track.n; i++) {
    const c = track.curvatureAt(i, 12);
    if (c > 1e-6 && 1 / c < minR) { minR = 1 / c; minRAt = i; }
  }
  check('raio mínimo de curva >= 20 m', minR >= 20,
    `${minR.toFixed(1)} m na amostra ${minRAt}`);

  const clearance = (track.halfWidth + 2.2) * 2 + 6;  // dois muros + folga
  let minGap = Infinity, gapAt = null;
  for (let i = 0; i < track.n; i += 2) {
    for (let j = i + 2; j < track.n; j += 2) {
      // só compara trechos distantes ao longo da volta
      if (Math.min(j - i, track.n - (j - i)) * track.segLen < 70) continue;
      const a = track.samples[i], b = track.samples[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < minGap) { minGap = d; gapAt = `${i}/${j}`; }
    }
  }
  check('sem auto-interseção do traçado', minGap >= clearance,
    `${minGap.toFixed(1)} m entre trechos ${gapAt} (precisa >= ${clearance.toFixed(0)} m)`);

  const racers = CHARACTERS.map((c, i) => new Racer(c, track, i));
  racers.forEach((r, i) => { r.ai = new KartAI(r, i); });

  // grade dentro da pista
  check('grade dentro da pista',
    racers.every((r) => Math.abs(track.project(r.position).lateral) < track.halfWidth));

  const dt = 1 / 60;
  let t = 0;
  const LIMIT = 60 * 6 * 60; // 6 minutos simulados
  let steps = 0;
  let maxSpeed = 0;
  let offroadFrames = 0;

  while (steps < LIMIT && racers.some((r) => !r.finished)) {
    for (const r of racers) {
      r.ai.update(dt, 1, racers);
      r.update(dt, true);
      maxSpeed = Math.max(maxSpeed, r.forwardSpeed);
      if (Math.abs(r.lateral) > track.halfWidth) offroadFrames++;
      if (r.justCrossedLine) {
        r.justCrossedLine = false;
        const lapTime = t - r.lapStart;
        r.lapStart = t;
        r.lapTimes.push(lapTime);
        if (r.lap >= track.laps && !r.finished) { r.finished = true; r.finishTime = t; }
      }
      if (!Number.isFinite(r.position.x) || !Number.isFinite(r.position.z)) {
        check(`posição finita (${r.character.name})`, false);
        steps = LIMIT;
      }
    }
    resolveKartCollisions(racers);
    t += dt; steps++;
  }

  const done = racers.filter((r) => r.finished);
  check('todos os 6 bots terminaram 3 voltas', done.length === 6,
    `${done.length}/6 em ${t.toFixed(0)}s simulados`);

  const laps = racers.flatMap((r) => r.lapTimes);
  const avg = laps.reduce((a, b) => a + b, 0) / (laps.length || 1);
  check('tempo de volta plausível (20–110 s)', avg > 20 && avg < 110,
    `média ${avg.toFixed(1)}s`);
  check('velocidade de ponta plausível (< 200 km/h)', maxSpeed * 3.6 < 200,
    `${(maxSpeed * 3.6).toFixed(0)} km/h`);
  check('bots ficam majoritariamente no asfalto',
    offroadFrames / (steps * 6) < 0.2,
    `${(offroadFrames / (steps * 6) * 100).toFixed(1)}% do tempo fora`);

  const order = [...racers].sort((a, b) =>
    (a.finishTime ?? 1e9) - (b.finishTime ?? 1e9));
  console.log('  classificação: ' + order
    .map((r, i) => `${i + 1}º ${r.character.name} ${r.finishTime?.toFixed(1) ?? '—'}s`)
    .join('  '));
}

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} FALHA(S)`);
process.exit(failures ? 1 : 0);
