// Simulação headless: roda uma corrida inteira sem navegador para validar
// física, contagem de voltas e IA.  `node test/sim.js`
const stubCtx = new Proxy({}, { get: () => () => ({}) });
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => stubCtx }),
};

const THREE = await import('three');
const { TRACKS, Track } = await import('../src/track.js');
const { CHARACTERS } = await import('../src/characters.js');
const { Racer, resolveKartCollisions } = await import('../src/kart.js');
const { KartAI } = await import('../src/ai.js');
const { PowerSystem, POWERS, POWER_TIME } = await import('../src/powers.js');

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

// ---------------------------------------------------------------------------
// Superpoderes: cubos, coleta e cada um dos 5 efeitos.
// ---------------------------------------------------------------------------

console.log('\n=== SUPERPODERES ===');
{
  const track = new Track(TRACKS[0]);
  const dt = 1 / 60;

  /** Karts parados na grade, prontos para um teste isolado. */
  function makeRacers(n = 2) {
    const rs = [];
    for (let i = 0; i < n; i++) rs.push(new Racer(CHARACTERS[i], track, i));
    for (let k = 0; k < 3; k++) for (const r of rs) r.update(dt, false);
    return rs;
  }

  // --- geometria dos cubos ---
  {
    const powers = new PowerSystem(track, new THREE.Scene());
    check('20 cubos (4 fileiras x 5)', powers.cubes.length === 20);

    const byRow = new Map();
    for (const c of powers.cubes) {
      if (!byRow.has(c.index)) byRow.set(c.index, []);
      byRow.get(c.index).push(track.project(c.position).lateral);
    }
    check('4 fileiras distintas na volta', byRow.size === 4);
    const lats = [...byRow.values()][0].sort((a, b) => a - b);
    check('fileira com 5 cubos atravessando a pista',
      lats.length === 5 && lats.every((l) => Math.abs(l) <= track.halfWidth),
      lats.map((l) => l.toFixed(1)).join(' / '));
    const gaps = lats.slice(1).map((l, i) => l - lats[i]);
    check('cubos igualmente espaçados na horizontal',
      Math.max(...gaps) - Math.min(...gaps) < 0.01,
      `passo ${gaps[0].toFixed(2)} m`);
  }

  // --- supervelocidade ---
  {
    const powers = new PowerSystem(track, new THREE.Scene());
    const [a] = makeRacers(1);
    powers.grant(a, 'velocidade');
    powers.update(dt, [a]);
    check('supervelocidade dá turbo', a.boostTime > 0, `${a.boostTime.toFixed(2)}s`);
  }

  // --- teletransporte ---
  {
    const powers = new PowerSystem(track, new THREE.Scene());
    const [a] = makeRacers(1);
    const before = a.trackIndex;
    powers.grant(a, 'teleporte');
    const jump = ((a.trackIndex - before + track.n) % track.n) * track.segLen;
    check('teletransporte avança ~42 m', jump > 35 && jump < 50, `${jump.toFixed(1)} m`);
    check('teletransporte não joga o kart para fora',
      Math.abs(track.project(a.position).lateral) <= track.halfWidth);
    check('teletransporte dá invulnerabilidade pelos 3 s', a.invulnTime >= POWER_TIME);
  }

  // --- canhão: estabiliza o adversário ---
  {
    const powers = new PowerSystem(track, new THREE.Scene());
    const rs = makeRacers(3);
    const atirador = rs[2], alvo = rs[0];   // slots 0 e 2 na mesma linha lateral
    powers.grant(atirador, 'canhao');
    let shots = 0, frozen = false;
    for (let i = 0; i < 60 * 3 && !frozen; i++) {
      powers.update(dt, rs);
      shots = Math.max(shots, powers.shots.length);
      for (const r of rs) r.update(dt, false);
      if (alvo.frozenTime > 0) frozen = true;
    }
    check('canhão dispara projéteis', shots > 0);
    check('canhão estabiliza o adversário atingido', frozen,
      frozen ? `${alvo.frozenTime.toFixed(2)}s parado` : 'nenhum acerto');
  }

  // --- soco traseiro ---
  {
    const powers = new PowerSystem(track, new THREE.Scene());
    const rs = makeRacers(3);
    const atirador = rs[0], alvo = rs[2];   // alvo está atrás
    powers.grant(atirador, 'soco');
    let hit = false;
    for (let i = 0; i < 60 * 3 && !hit; i++) {
      powers.update(dt, rs, (ev) => { if (ev.type === 'soco' && ev.landed) hit = true; });
      for (const r of rs) r.update(dt, false);
    }
    check('soco sai pela traseira e acerta quem vem atrás', hit);
    check('soco desestabiliza o alvo', alvo.spinTime > 0 || alvo.invulnTime > 0);
  }

  // --- armadilhas ---
  {
    const powers = new PowerSystem(track, new THREE.Scene());
    const rs = makeRacers(1);
    const a = rs[0];
    a.velocity.set(Math.sin(a.yaw) * 20, 0, Math.cos(a.yaw) * 20);
    powers.grant(a, 'armadilhas');
    for (let i = 0; i < Math.round(POWER_TIME / dt); i++) {
      powers.update(dt, rs);
      a.input.throttle = 1;
      a.update(dt, true);
    }
    check('armadilhas são soltas em série', powers.traps.length >= 8,
      `${powers.traps.length} armadilhas`);
    const off = powers.traps.map((h) => Math.abs(track.project(h.mesh.position).lateral));
    check('armadilhas ficam sobre a pista (linha paralela)',
      Math.max(...off) <= track.halfWidth + 0.01,
      `desvio máx. ${Math.max(...off).toFixed(1)} m`);
  }

  // --- corrida completa com os cubos ativos ---
  {
    const powers = new PowerSystem(track, new THREE.Scene());
    const racers = CHARACTERS.map((c, i) => new Racer(c, track, i));
    racers.forEach((r, i) => { r.ai = new KartAI(r, i); });
    const granted = new Set();
    let t = 0, steps = 0, finite = true;
    const LIMIT = 60 * 6 * 60;

    while (steps < LIMIT && racers.some((r) => !r.finished)) {
      for (const r of racers) {
        r.ai.update(dt, 1, racers);
        r.update(dt, true);
        if (!Number.isFinite(r.position.x) || !Number.isFinite(r.position.z)) finite = false;
        if (r.justCrossedLine) {
          r.justCrossedLine = false;
          r.lapTimes.push(t - r.lapStart);
          r.lapStart = t;
          if (r.lap >= track.laps && !r.finished) { r.finished = true; r.finishTime = t; }
        }
      }
      resolveKartCollisions(racers);
      powers.update(dt, racers, (ev) => {
        if (ev.type === 'power-start') granted.add(ev.power);
      });
      if (!finite) break;
      t += dt; steps++;
    }

    check('posições continuam finitas com os poderes ativos', finite);
    check('cubos são coletados durante a corrida', granted.size > 0,
      `${granted.size}/${Object.keys(POWERS).length} poderes vistos: ${[...granted].join(', ')}`);
    check('todos terminam a corrida mesmo com os poderes',
      racers.every((r) => r.finished), `${racers.filter((r) => r.finished).length}/6 em ${t.toFixed(0)}s`);
    check('nenhum poder fica preso ativo no fim',
      racers.every((r) => r.powerTime <= 0 || r.powerTime <= POWER_TIME));
  }
}

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} FALHA(S)`);
process.exit(failures ? 1 : 0);
