import * as THREE from 'three';
import { Input } from './input.js';
import { TRACKS, Track } from './track.js';
import { CHARACTERS } from './characters.js';
import { Racer, resolveKartCollisions } from './kart.js';
import { KartAI } from './ai.js';
import { PowerSystem, POWERS, POWER_TIME } from './powers.js';
import { Audio } from './audio.js';

// ---------------------------------------------------------------- estado

const state = {
  phase: 'menu',            // menu | countdown | racing | finishing | results
  paused: false,
  characterIndex: 0,
  trackIndex: 0,
  menuFocus: 'char',        // char | track | start
  countdown: 3.999,
  clock: 0,
  camMode: 0,
};

const input = new Input();
const audio = new Audio();

// ---------------------------------------------------------------- three.js

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.4, 2400);

const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3d6, 1.35);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 220;
const SH = 60;
sun.shadow.camera.left = -SH; sun.shadow.camera.right = SH;
sun.shadow.camera.top = SH; sun.shadow.camera.bottom = -SH;
sun.shadow.bias = -0.0012;
scene.add(sun, sun.target);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- partículas

class Sparks {
  constructor(max = 600) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.head = 0;
    this._color = new THREE.Color();
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -1000;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.42, vertexColors: true, transparent: true,
      opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.geo = geo;
  }

  emit(x, y, z, color, spread = 3, life = 0.4) {
    const i = this.head = (this.head + 1) % this.max;
    const c = this._color.setHex(color);
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    this.vel[i * 3] = (Math.random() - 0.5) * spread;
    this.vel[i * 3 + 1] = Math.random() * spread * 0.7 + 1;
    this.vel[i * 3 + 2] = (Math.random() - 0.5) * spread;
    this.life[i] = life;
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 12 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.col[i * 3] *= 0.99; this.col[i * 3 + 1] *= 0.985; this.col[i * 3 + 2] *= 0.985;
      if (this.life[i] <= 0) this.pos[i * 3 + 1] = -1000;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- corrida

let race = null;

function startRace() {
  if (state.phase !== 'menu') return;
  if (race) {
    scene.remove(race.track.mesh, race.sparks.points);
    for (const r of race.racers) scene.remove(r.mesh);
    scene.remove(race.powers.group);
  }

  const def = TRACKS[state.trackIndex];
  const track = new Track(def);
  scene.add(track.mesh);
  scene.background = new THREE.Color(def.sky);
  scene.fog = new THREE.Fog(def.fog, 190, 900);
  hemi.color.setHex(def.sky);
  sun.position.set(80, 140, 60);

  // grade: jogador sorteado no meio do pelotão
  const playerChar = CHARACTERS[state.characterIndex];
  const others = CHARACTERS.filter((c) => c !== playerChar);
  const order = [];
  const playerSlot = 3;
  let oi = 0;
  for (let i = 0; i < 6; i++) order.push(i === playerSlot ? playerChar : others[oi++]);

  const racers = order.map((c, i) => new Racer(c, track, i, i === playerSlot));
  const player = racers[playerSlot];
  let aiSeed = 0;
  for (const r of racers) {
    scene.add(r.mesh);
    if (!r.isPlayer) r.ai = new KartAI(r, aiSeed++);
  }

  const powers = new PowerSystem(track, scene);
  const sparks = new Sparks();
  scene.add(sparks.points);

  race = {
    track, racers, player, powers, sparks,
    time: 0,
    finishDelay: 0,
    results: null,
  };

  state.phase = 'countdown';
  state.countdown = 3.999;
  state.camMode = 0;
  camera.position.copy(player.position).add(new THREE.Vector3(0, 9, -16));
  camSmooth.copy(camera.position);
  camTargetSmooth.copy(player.position);

  ui.menu.classList.add('hidden');
  ui.results.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.lapTotal.textContent = `/${track.laps}`;
  ui.posTotal.textContent = `/${racers.length}`;
  ui.best.textContent = '--:--.--';
  buildMinimap(track);
}

// ---------------------------------------------------------------- câmera

const camSmooth = new THREE.Vector3();
const camTargetSmooth = new THREE.Vector3();
const CAM_MODES = [
  { dist: 12.5, height: 5.6, fov: 62, look: 7 },
  { dist: 18.5, height: 8.2, fov: 58, look: 9 },
  { dist: 0.1, height: 2.3, fov: 74, look: 12 },  // capacete
];

function updateCamera(dt) {
  const p = race.player;
  const mode = CAM_MODES[state.camMode];
  const back = input.lookBack ? -1 : 1;

  // velocidade puxa a câmera para trás e abre o FOV
  const spd = Math.min(1, p.speed / 40);
  const dist = mode.dist * (1 + spd * 0.18) * (p.boosting ? 1.1 : 1);
  const fov = mode.fov + spd * 6 + (p.boosting ? 6 : 0);

  const yaw = p.yaw + (p.drifting ? -p.driftDir * 0.28 : 0);
  const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const want = p.position.clone()
    .addScaledVector(dir, -dist * back)
    .add(new THREE.Vector3(0, mode.height, 0));

  const lag = state.camMode === 2 ? 22 : 6.5;
  camSmooth.lerp(want, Math.min(1, dt * lag));
  camera.position.copy(camSmooth);

  const target = p.position.clone().addScaledVector(dir, mode.look * back).add(new THREE.Vector3(0, 1.4, 0));
  camTargetSmooth.lerp(target, Math.min(1, dt * 9));
  camera.lookAt(camTargetSmooth);

  // trepidação ao bater
  if (p.wallHit || p.bumped) {
    const s = (p.wallHit || 0) + (p.bumped || 0);
    camera.position.x += (Math.random() - 0.5) * s * 1.4;
    camera.position.y += (Math.random() - 0.5) * s * 1.4;
  }

  camera.fov += (fov - camera.fov) * Math.min(1, dt * 5);
  camera.updateProjectionMatrix();

  sun.position.copy(p.position).add(new THREE.Vector3(70, 120, 50));
  sun.target.position.copy(p.position);
  sun.target.updateMatrixWorld();
}

// ---------------------------------------------------------------- UI refs

const ui = {
  hud: document.getElementById('hud'),
  menu: document.getElementById('menu'),
  results: document.getElementById('results'),
  pause: document.getElementById('pause'),
  lap: document.getElementById('lap'),
  pos: document.getElementById('pos'),
  time: document.getElementById('time'),
  best: document.getElementById('best'),
  speedVal: document.getElementById('speed-val'),
  speedFg: document.getElementById('speed-fg'),
  speedo: document.getElementById('speedo'),
  powerSlot: document.getElementById('power-slot'),
  powerIcon: document.getElementById('power-icon'),
  powerName: document.getElementById('power-name'),
  powerFill: document.getElementById('power-fill'),
  driftMeter: document.getElementById('drift-meter'),
  driftFill: document.getElementById('drift-fill'),
  centerMsg: document.getElementById('center-msg'),
  padStatus: document.getElementById('pad-status'),
  menuPad: document.getElementById('menu-pad'),
  roster: document.getElementById('roster'),
  tracks: document.getElementById('tracks'),
  startBtn: document.getElementById('start'),
  resultTable: document.getElementById('result-table'),
  resultTitle: document.getElementById('result-title'),
  againBtn: document.getElementById('again'),
};
ui.lapTotal = ui.lap.querySelector('.small');
ui.posTotal = ui.pos.querySelector('.small');

// minimapa (criado por JS para ficar junto do resto do HUD)
const miniCanvas = document.createElement('canvas');
miniCanvas.id = 'minimap';
miniCanvas.width = miniCanvas.height = 190;
Object.assign(miniCanvas.style, {
  position: 'absolute', bottom: '22px', left: '22px', width: '160px', height: '160px',
  background: 'rgba(10,14,30,.5)', border: '1px solid rgba(255,255,255,.14)',
  borderRadius: '14px', backdropFilter: 'blur(8px)',
});
ui.hud.appendChild(miniCanvas);
ui.padStatus.style.bottom = '192px';
const mini = miniCanvas.getContext('2d');
let miniPath = null;

function buildMinimap(track) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of track.samples) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const pad = 16, size = miniCanvas.width - pad * 2;
  const scale = size / Math.max(maxX - minX, maxZ - minZ);
  const ox = pad + (size - (maxX - minX) * scale) / 2;
  const oz = pad + (size - (maxZ - minZ) * scale) / 2;
  miniPath = {
    toX: (x) => ox + (x - minX) * scale,
    toY: (z) => oz + (z - minZ) * scale,
    samples: track.samples,
  };
}

function drawMinimap() {
  if (!miniPath || !race) return;
  const c = mini, N = miniCanvas.width;
  c.clearRect(0, 0, N, N);
  c.strokeStyle = 'rgba(255,255,255,.32)';
  c.lineWidth = 9;
  c.lineJoin = 'round';
  c.beginPath();
  const s = miniPath.samples;
  for (let i = 0; i <= s.length; i += 4) {
    const p = s[i % s.length];
    const x = miniPath.toX(p.x), y = miniPath.toY(p.z);
    i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
  }
  c.closePath();
  c.stroke();

  // linha de chegada
  c.strokeStyle = '#fff'; c.lineWidth = 3;
  c.beginPath();
  c.arc(miniPath.toX(s[0].x), miniPath.toY(s[0].z), 4, 0, 7);
  c.stroke();

  for (const r of race.racers) {
    c.fillStyle = '#' + r.character.color.toString(16).padStart(6, '0');
    c.beginPath();
    c.arc(miniPath.toX(r.position.x), miniPath.toY(r.position.z), r.isPlayer ? 6 : 4.5, 0, 7);
    c.fill();
    if (r.isPlayer) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke(); }
  }
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  ui.roster.innerHTML = '';
  CHARACTERS.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'char' + (i === state.characterIndex ? ' sel' : '');
    el.innerHTML = `
      <div class="swatch" style="background:#${c.color.toString(16).padStart(6, '0')}"></div>
      <div class="cname">${c.name}</div>
      <div class="cstat">${c.desc}<br>
        VEL ${bar(c.speed)}<br>ACE ${bar(c.accel)}<br>CUR ${bar(c.grip)}</div>`;
    el.onclick = () => { state.characterIndex = i; refreshMenu(); };
    ui.roster.appendChild(el);
  });

  ui.tracks.innerHTML = '';
  TRACKS.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'trk' + (i === state.trackIndex ? ' sel' : '');
    el.textContent = t.name;
    el.onclick = () => { state.trackIndex = i; refreshMenu(); };
    ui.tracks.appendChild(el);
  });
}

function bar(v) {
  const n = Math.round((v - 0.75) / 0.5 * 5);
  return '▮'.repeat(Math.max(1, Math.min(5, n))) + '▯'.repeat(5 - Math.max(1, Math.min(5, n)));
}

function refreshMenu() {
  [...ui.roster.children].forEach((el, i) => el.classList.toggle('sel', i === state.characterIndex));
  [...ui.tracks.children].forEach((el, i) => el.classList.toggle('sel', i === state.trackIndex));
}

buildMenu();

ui.startBtn.onclick = () => { audio.start(); startRace(); };
ui.againBtn.onclick = () => {
  ui.results.classList.add('hidden');
  ui.menu.classList.remove('hidden');
  ui.hud.classList.add('hidden');
  state.phase = 'menu';
};

// navegação do menu pelo controle
function menuInput() {
  const pad = input.pad;
  const connected = !!pad;
  ui.menuPad.textContent = connected
    ? `🎮 ${shortPadName(input.padName)} conectado — ✕ para correr`
    : 'Conecte um controle (ou use o teclado) — pressione um botão para detectar';
  ui.menuPad.classList.toggle('on', connected);

  const left = input.justAction('left') || input.justKey('ArrowLeft') || input.justKey('KeyA');
  const right = input.justAction('right') || input.justKey('ArrowRight') || input.justKey('KeyD');
  const up = input.justPressed(12) || input.justKey('ArrowUp') || input.justKey('KeyW');
  const down = input.justPressed(13) || input.justKey('ArrowDown') || input.justKey('KeyS');

  if (left || right) {
    const d = right ? 1 : -1;
    if (state.menuFocus === 'track') {
      state.trackIndex = (state.trackIndex + d + TRACKS.length) % TRACKS.length;
    } else {
      state.characterIndex = (state.characterIndex + d + CHARACTERS.length) % CHARACTERS.length;
    }
    refreshMenu();
  }
  if (up) state.menuFocus = 'char';
  if (down) state.menuFocus = 'track';
  if (input.justAction('confirm')) { audio.start(); startRace(); }
}

function shortPadName(id) {
  if (/dualsense|0ce6|0df2/i.test(id)) return 'DualSense';
  if (/dualshock|054c/i.test(id)) return 'DualShock';
  return id.split('(')[0].trim().slice(0, 22) || 'Controle';
}

// ---------------------------------------------------------------- HUD

function fmt(t) {
  if (t == null) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

// mensagem central ao ser atingido por cada superpoder
const POWER_MSG = {
  canhao: 'ESTABILIZADO!',
  soco: 'SOCO!',
  armadilha: 'ARMADILHA!',
};

let msgTimer = 0;
function showMsg(text, seconds = 1.2, color = '#fff') {
  ui.centerMsg.textContent = text;
  ui.centerMsg.style.color = color;
  ui.centerMsg.classList.add('show');
  msgTimer = seconds;
}

function updateHUD(dt) {
  const p = race.player;

  ui.lap.firstChild.textContent = Math.min(p.lap + 1, race.track.laps);
  ui.pos.firstChild.textContent = p.place;
  ui.time.textContent = fmt(race.time);
  const best = p.lapTimes.length ? Math.min(...p.lapTimes) : null;
  ui.best.textContent = fmt(best);

  const kmh = Math.max(0, p.forwardSpeed) * 3.6;
  ui.speedVal.textContent = Math.round(kmh);
  const frac = Math.min(1, kmh / ((p.topSpeed + 15) * 3.6));
  ui.speedFg.style.strokeDashoffset = String(158 * (1 - frac));
  ui.speedo.classList.toggle('boost', p.boosting);

  // superpoder ativo
  const hasPower = p.powerTime > 0 && p.power;
  ui.powerSlot.classList.toggle('on', !!hasPower);
  if (hasPower) {
    const def = POWERS[p.power];
    ui.powerIcon.textContent = def.icon;
    ui.powerName.textContent = def.name;
    ui.powerFill.style.width = Math.max(0, p.powerTime / POWER_TIME * 100) + '%';
    const hex = '#' + def.color.toString(16).padStart(6, '0');
    ui.powerFill.style.background = hex;
    ui.powerSlot.style.borderColor = hex;
  }

  // carga do drift
  const tier = p.driftTier;
  ui.driftMeter.classList.toggle('on', p.drifting);
  ui.driftFill.style.width = Math.min(100, p.driftCharge / 3.8 * 100) + '%';
  ui.driftFill.style.background = tier > 0
    ? '#' + p.driftTierColor.toString(16).padStart(6, '0')
    : 'var(--accent)';

  // mensagem central
  if (msgTimer > 0) {
    msgTimer -= dt;
    if (msgTimer <= 0) ui.centerMsg.classList.remove('show');
  }

  const on = input.connected;
  ui.padStatus.className = on ? 'on' : 'off';
  ui.padStatus.textContent = on ? `🎮 ${shortPadName(input.padName)}` : '🎮 Controle desconectado';

  drawMinimap();
}

// ---------------------------------------------------------------- posições

function updatePlaces() {
  const sorted = [...race.racers].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.raceProgress - a.raceProgress;
  });
  sorted.forEach((r, i) => { r.place = i + 1; });
  return sorted;
}

function showResults() {
  const sorted = updatePlaces();
  state.phase = 'results';
  audio.stopEngine();
  audio.finish();
  ui.hud.classList.add('hidden');
  ui.results.classList.remove('hidden');
  const p = race.player;
  ui.resultTitle.textContent = p.place === 1 ? 'VITÓRIA!' : `${p.place}º LUGAR`;
  ui.resultTable.innerHTML = sorted.map((r) => `
    <tr class="${r.isPlayer ? 'you' : ''}">
      <td>${r.place}º</td>
      <td>${r.character.name}${r.isPlayer ? ' (você)' : ''}</td>
      <td>${r.finished ? fmt(r.finishTime) : '+' + ((race.player.raceProgress - r.raceProgress) / 30).toFixed(1) + 's'}</td>
    </tr>`).join('');
}

// ---------------------------------------------------------------- loop

let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 1 / 20);   // evita explosões de física após travar/alt-tab

  input.update();

  if (state.phase === 'menu') {
    menuInput();
    renderer.render(scene, camera);
    return;
  }

  if (input.justAction('pause') && (state.phase === 'countdown' || state.phase === 'racing')) {
    state.paused = !state.paused;
    ui.pause.classList.toggle('hidden', !state.paused);
    if (state.paused) audio.stopEngine();
  }
  if (state.paused) { renderer.render(scene, camera); return; }

  step(dt);
  renderer.render(scene, camera);
}

function step(dt) {
  const { track, racers, player, powers, sparks } = race;

  // ---- contagem regressiva ----
  let racing = state.phase === 'racing' || state.phase === 'finishing';
  if (state.phase === 'countdown') {
    const before = Math.ceil(state.countdown);
    state.countdown -= dt;
    const after = Math.ceil(state.countdown);
    if (after !== before) {
      if (after > 0) { showMsg(String(after), 0.9, '#ffcc33'); audio.countBeep(); }
    }
    if (state.countdown <= 0) {
      state.phase = 'racing';
      racing = true;
      showMsg('VALENDO!', 1.1, '#7dff8a');
      audio.countBeep(true);
      input.rumble(0.7, 0.4, 300);
    }
  }

  if (racing) race.time += dt;

  // ---- entradas do jogador ----
  const pi = player.input;
  pi.steer = input.steer;
  pi.throttle = input.throttle;
  pi.brake = input.brake;
  pi.drift = input.drift;

  if (input.justAction('camera')) state.camMode = (state.camMode + 1) % CAM_MODES.length;
  if (input.justAction('respawn') && racing) { player.respawn(); showMsg('REPOSICIONADO', 0.8, '#ffcc33'); }

  // ---- IA ----
  // rubber band: bots à frente do jogador afrouxam um pouco, os de trás apertam
  for (const r of racers) {
    if (!r.ai) continue;
    const gap = (r.raceProgress - player.raceProgress) / track.length;
    const difficulty = THREE.MathUtils.clamp(0.99 - gap * 0.35, 0.86, 1.06);
    r.ai.update(dt, difficulty, racers);
  }

  // ---- física ----
  for (const r of racers) {
    if (r.finished) { r.input.throttle = 0.55; r.input.brake = 0; r.input.drift = false; }
    r.update(dt, racing);
  }
  resolveKartCollisions(racers);

  powers.update(dt, racers, (ev) => {
    if (ev.type === 'power-start') {
      if (ev.racer === player) {
        const def = POWERS[ev.power];
        showMsg(def.name.toUpperCase() + '!', 1.1, '#' + def.color.toString(16).padStart(6, '0'));
        audio.power(ev.power);
        input.rumble(0.5, 0.7, 220);
      }
      for (let i = 0; i < 16; i++) {
        sparks.emit(ev.racer.position.x, ev.racer.position.y + 0.8, ev.racer.position.z,
          POWERS[ev.power].color, 7, 0.5);
      }
      return;
    }
    if (ev.type === 'power-end') return;

    if (ev.target === player && ev.landed) {
      audio.hit();
      input.rumble(1, 0.9, 460);
      showMsg(POWER_MSG[ev.type] ?? 'ATINGIDO!', 1, '#ff6b6b');
    } else if (ev.owner === player && ev.landed) {
      audio.itemGet();
    }
  });

  // ---- eventos por kart ----
  for (const r of racers) {
    // voltas
    if (r.justCrossedLine) {
      r.justCrossedLine = false;
      const lapTime = race.time - r.lapStart;
      r.lapStart = race.time;
      r.lapTimes.push(lapTime);
      if (r.lap >= track.laps && !r.finished) {
        r.finished = true;
        r.finishTime = race.time;
        if (r.isPlayer) {
          state.phase = 'finishing';
          race.finishDelay = 2.6;
          showMsg('CHEGOU!', 2, '#ffe066');
          input.rumble(0.8, 0.8, 600);
        }
      } else if (r.isPlayer) {
        audio.lap();
        const best = Math.min(...r.lapTimes);
        showMsg(lapTime <= best ? `VOLTA ${r.lap + 1} • ${fmt(lapTime)}` : `VOLTA ${r.lap + 1}`, 1.4, '#7dd3fc');
      }
    }

    // faíscas do drift
    if (r.drifting && r.driftTier > 0) {
      const color = r.driftTierColor;
      const back = new THREE.Vector3(-Math.sin(r.yaw), 0, -Math.cos(r.yaw));
      for (const side of [-1, 1]) {
        const rx = Math.cos(r.yaw) * side * 1;
        const rz = -Math.sin(r.yaw) * side * 1;
        sparks.emit(
          r.position.x + back.x * 1.1 + rx, r.position.y + 0.3, r.position.z + back.z * 1.1 + rz,
          color, 3.5, 0.35,
        );
      }
      if (r.isPlayer) audio.skid(0.4 + r.driftTier * 0.2);
    }

    // poeira fora da pista
    if (Math.abs(r.lateral) > track.halfWidth && r.speed > 6 && Math.random() < 0.6) {
      sparks.emit(r.position.x, r.position.y + 0.2, r.position.z, 0xc8b48a, 2.4, 0.5);
    }

    // fumaça de rodopio
    if (r.spinTime > 0 && Math.random() < 0.8) {
      sparks.emit(r.position.x, r.position.y + 0.7, r.position.z, 0x888888, 4, 0.5);
    }

    // cristais de quem está estabilizado pelo canhão
    if (r.frozenTime > 0) {
      sparks.emit(r.position.x, r.position.y + 1, r.position.z, 0x9fe8ff, 2.6, 0.4);
    }

    // rastro de quem está com um superpoder ativo
    if (r.powerTime > 0 && r.power && Math.random() < 0.55) {
      sparks.emit(r.position.x, r.position.y + 0.9, r.position.z,
        POWERS[r.power].color, 2.2, 0.35);
    }

    // mini-turbo liberado
    if (r.miniTurboFlash) {
      if (r.isPlayer) { audio.miniTurbo(r.miniTurboFlash); input.rumble(0.5, 0.7, 220); }
      for (let i = 0; i < 14; i++) {
        sparks.emit(r.position.x, r.position.y + 0.5, r.position.z, r.boostColor, 7, 0.5);
      }
      r.miniTurboFlash = 0;
    }

    if (r.isPlayer) {
      if (r.wallHit) { audio.wall(); input.rumble(r.wallHit, r.wallHit * 0.6, 180); }
      if (r.bumped) { audio.bump(); input.rumble(r.bumped * 0.6, r.bumped * 0.4, 120); }
    }
    r.wallHit = 0;
    r.bumped = 0;
  }

  sparks.update(dt);
  updatePlaces();
  updateCamera(dt);
  updateHUD(dt);

  // motor
  const rpmBase = Math.min(1, Math.abs(player.forwardSpeed) / (player.topSpeed + 15));
  const gearWobble = (rpmBase * 4) % 1;
  audio.setEngine(rpmBase * 0.55 + gearWobble * 0.45, player.input.throttle);

  // ---- fim ----
  if (state.phase === 'finishing') {
    race.finishDelay -= dt;
    if (race.finishDelay <= 0) showResults();
  }
}

requestAnimationFrame(frame);

// deixa o áudio pronto no primeiro toque em qualquer lugar
addEventListener('pointerdown', () => audio.start(), { once: true });
addEventListener('keydown', () => audio.start(), { once: true });
