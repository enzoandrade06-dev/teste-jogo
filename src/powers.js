import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Superpoderes: fileiras de 5 cubos atravessam a pista. Quem passa por um cubo
// recebe um poder sorteado que fica ativo por 3 segundos e age sozinho durante
// esse tempo (vale para o jogador e para os bots).
// ---------------------------------------------------------------------------

const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();

export const POWER_TIME = 3;          // duração de qualquer poder, em segundos

export const POWERS = {
  canhao:     { icon: '💥', name: 'Canhão',          color: 0xff5c8a },
  velocidade: { icon: '⚡', name: 'Supervelocidade', color: 0x9dff6b },
  armadilhas: { icon: '💣', name: 'Armadilhas',      color: 0xffa53d },
  soco:       { icon: '👊', name: 'Soco Traseiro',   color: 0xffd93d },
  teleporte:  { icon: '🌀', name: 'Teletransporte',  color: 0x8ad7ff },
};
const KEYS = Object.keys(POWERS);

// --- ajustes de balanceamento ---
const CUBE_ROWS = 4;            // fileiras espalhadas pela volta
const CUBES_PER_ROW = 5;        // cubos por fileira (atravessando a pista)
const CUBE_COOLDOWN = 5;        // segundos até o cubo voltar
const CUBE_RADIUS = 2.9;        // raio de coleta

const CANNON_INTERVAL = 0.85;   // um tiro a cada X s enquanto o poder dura
const CANNON_SPEED = 62;
const CANNON_RANGE = 120;       // alcance de mira, em metros
const FREEZE_TIME = 1.35;       // quanto o alvo fica estabilizado

const TRAP_INTERVAL = 0.3;      // uma armadilha a cada X s
const TRAP_LIFE = 9;

const PUNCH_INTERVAL = 1.2;     // um soco a cada X s (3 socos em 3 s)
const PUNCH_SPEED = 46;
const PUNCH_RANGE = 45;         // alcance médio-alto, em metros
const PUNCH_IMPULSE = 26;

const TELEPORT_DIST = 42;       // salto médio para a frente, em metros

/** Distância assinada, ao longo da pista, de `a` até `b` (metros). */
function forwardGap(a, b, t) {
  let d = (b.trackIndex - a.trackIndex) * t.segLen;
  if (d < -t.length / 2) d += t.length;
  if (d > t.length / 2) d -= t.length;
  return d;
}

export class PowerSystem {
  constructor(track, scene) {
    this.track = track;
    this.scene = scene;
    this.cubes = [];
    this.shots = [];
    this.traps = [];

    this.group = new THREE.Group();
    scene.add(this.group);

    this._prepareTemplates();
    this._makeCubes();
  }

  _prepareTemplates() {
    this.cubeGeo = new THREE.BoxGeometry(1.7, 1.7, 1.7);
    this.cubeEdgeGeo = new THREE.BoxGeometry(2.35, 2.35, 2.35);
    this.cubeMat = new THREE.MeshLambertMaterial({
      color: 0xc06bff, emissive: 0x5a1e9c, transparent: true, opacity: 0.9,
    });
    this.cubeEdgeMat = new THREE.MeshBasicMaterial({
      color: 0xe9c2ff, wireframe: true, transparent: true, opacity: 0.55,
    });

    this.shotGeo = new THREE.SphereGeometry(0.62, 10, 8);
    this.shotMat = new THREE.MeshBasicMaterial({ color: POWERS.canhao.color });
    this.fistGeo = new THREE.BoxGeometry(1.7, 1.5, 1.5);
    this.fistMat = new THREE.MeshLambertMaterial({
      color: POWERS.soco.color, emissive: 0x6b4c00,
    });
    this.trapGeo = new THREE.OctahedronGeometry(1.0);
    this.trapMat = new THREE.MeshLambertMaterial({
      color: POWERS.armadilhas.color, emissive: 0x7a3d00,
    });
  }

  /** Fileiras de 5 cubos alinhados na horizontal, atravessando a pista. */
  _makeCubes() {
    const t = this.track;
    for (let r = 0; r < CUBE_ROWS; r++) {
      // 0.2, 0.4, 0.6, 0.8 da volta — longe das caixas de item (0.1, 0.3, ...)
      const index = Math.round((r + 1) / (CUBE_ROWS + 1) * t.n);
      for (let c = 0; c < CUBES_PER_ROW; c++) {
        const k = c / (CUBES_PER_ROW - 1) * 2 - 1;   // -1 .. +1
        const lat = k * t.halfWidth * 0.78;
        const mesh = new THREE.Mesh(this.cubeGeo, this.cubeMat.clone());
        mesh.add(new THREE.Mesh(this.cubeEdgeGeo, this.cubeEdgeMat));
        const p = t.worldAt(index, lat, 1.6);
        mesh.position.copy(p);
        this.group.add(mesh);
        this.cubes.push({ mesh, position: p, cooldown: 0, index, phase: r * 1.3 + c * 0.5 });
      }
    }
  }

  // ------------------------------------------------------------- coleta

  _tryPickup(racer, onEvent) {
    if (racer.powerTime > 0 || racer.finished) return;
    for (const cube of this.cubes) {
      if (cube.cooldown > 0) continue;
      TMP.subVectors(racer.position, cube.position);
      TMP.y = 0;
      if (TMP.lengthSq() < CUBE_RADIUS * CUBE_RADIUS) {
        cube.cooldown = CUBE_COOLDOWN;
        cube.mesh.visible = false;
        this.grant(racer, KEYS[Math.floor(Math.random() * KEYS.length)], onEvent);
        break;
      }
    }
  }

  /** Concede um poder (exposto para testes e depuração). */
  grant(racer, key, onEvent) {
    racer.power = key;
    racer.powerTime = POWER_TIME;
    racer.powerCooldown = 0;

    if (key === 'velocidade') racer.addBoost(POWER_TIME, POWERS.velocidade.color);
    if (key === 'teleporte') this._teleport(racer);

    onEvent?.({ type: 'power-start', racer, power: key });
  }

  // ------------------------------------------------------------- poderes

  _teleport(r) {
    const t = this.track;
    const steps = Math.round(TELEPORT_DIST / t.segLen);
    const index = (r.trackIndex + steps) % t.n;
    const lat = THREE.MathUtils.clamp(r.lateral, -t.halfWidth * 0.8, t.halfWidth * 0.8);

    r.position.copy(t.worldAt(index, lat, 0.4));
    r.yaw = t.yawAt(index);
    r.trackIndex = index;
    r.vy = 0;
    r.drifting = false;
    r.driftCharge = 0;
    // mantém o embalo, mas realinhado ao novo trecho da pista
    const spd = Math.max(r.forwardSpeed, 14);
    r.velocity.set(Math.sin(r.yaw) * spd, 0, Math.cos(r.yaw) * spd);
    // some por 3 s: não pode ser atingido logo depois de reaparecer
    r.invulnTime = Math.max(r.invulnTime, POWER_TIME);
  }

  _fireCannon(r, racers) {
    const t = this.track;
    const target = this._nearestRival(r, racers, CANNON_RANGE);
    const dir = target ? Math.sign(forwardGap(r, target, t)) || 1 : 1;

    const mesh = new THREE.Mesh(this.shotGeo, this.shotMat);
    this.group.add(mesh);
    this.shots.push({
      mesh, owner: r, target, kind: 'canhao', dir,
      s: r.trackIndex + dir * (3.5 / t.segLen),
      lat: r.lateral,
      speed: CANNON_SPEED, life: 2.6, radius: 2.9, height: 0.95,
    });
  }

  _punch(r) {
    const t = this.track;
    const mesh = new THREE.Mesh(this.fistGeo, this.fistMat);
    this.group.add(mesh);
    this.shots.push({
      mesh, owner: r, target: null, kind: 'soco', dir: -1,
      s: r.trackIndex - 3.2 / t.segLen,
      lat: r.lateral,
      speed: PUNCH_SPEED, life: PUNCH_RANGE / PUNCH_SPEED, radius: 3.2, height: 1.1,
    });
  }

  /** Solta uma armadilha na traseira; a sequência forma uma linha paralela à pista. */
  _dropTrap(r) {
    const t = this.track;
    TMP.set(-Math.sin(r.yaw), 0, -Math.cos(r.yaw));
    TMP2.copy(r.position).addScaledVector(TMP, 3.4);
    const proj = t.project(TMP2, r.trackIndex);
    const lat = THREE.MathUtils.clamp(proj.lateral, -t.halfWidth, t.halfWidth);

    const mesh = new THREE.Mesh(this.trapGeo, this.trapMat);
    mesh.position.copy(t.worldAt(proj.index, lat, 0.55));
    this.group.add(mesh);
    this.traps.push({ mesh, owner: r, life: TRAP_LIFE, armTime: 0.7 });
  }

  _nearestRival(r, racers, range) {
    const t = this.track;
    let best = null, bestD = Infinity;
    for (const o of racers) {
      if (o === r || o.finished) continue;
      const d = Math.abs(forwardGap(r, o, t));
      if (d < bestD) { bestD = d; best = o; }
    }
    return bestD <= range ? best : null;
  }

  /** Ação contínua do poder ativo. */
  _tick(r, dt, racers) {
    r.powerCooldown -= dt;
    switch (r.power) {
      case 'canhao':
        if (r.powerCooldown <= 0) { this._fireCannon(r, racers); r.powerCooldown = CANNON_INTERVAL; }
        break;
      case 'armadilhas':
        if (r.powerCooldown <= 0) { this._dropTrap(r); r.powerCooldown = TRAP_INTERVAL; }
        break;
      case 'soco':
        if (r.powerCooldown <= 0) { this._punch(r); r.powerCooldown = PUNCH_INTERVAL; }
        break;
      case 'velocidade':
        // renova o turbo enquanto o poder durar
        r.addBoost(Math.max(0.08, r.powerTime), POWERS.velocidade.color);
        break;
      // teleporte é instantâneo: só resta a invulnerabilidade dos 3 s
    }
  }

  // ------------------------------------------------------------- loop

  update(dt, racers, onEvent) {
    const t = this.track;
    const wobble = (typeof performance !== 'undefined' ? performance.now() : 0) * 0.003;

    // --- cubos ---
    for (const cube of this.cubes) {
      if (cube.cooldown > 0) {
        cube.cooldown -= dt;
        if (cube.cooldown <= 0) cube.mesh.visible = true;
      } else {
        cube.mesh.rotation.y += dt * 1.4;
        cube.mesh.rotation.x += dt * 0.9;
        cube.mesh.position.y = cube.position.y + Math.sin(wobble + cube.phase) * 0.3;
      }
    }

    // --- coleta e poderes ativos ---
    for (const r of racers) {
      this._tryPickup(r, onEvent);
      if (r.powerTime > 0) {
        this._tick(r, dt, racers);
        r.powerTime -= dt;
        if (r.powerTime <= 0) {
          onEvent?.({ type: 'power-end', racer: r, power: r.power });
          r.powerTime = 0;
          r.power = null;
        }
      }
    }

    // --- projéteis (canhão e soco) andam colados no traçado ---
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const p = this.shots[i];
      p.life -= dt;
      p.s += p.dir * p.speed * dt / t.segLen;
      const index = ((Math.round(p.s) % t.n) + t.n) % t.n;

      if (p.target) {
        const want = THREE.MathUtils.clamp(p.target.lateral, -t.halfWidth, t.halfWidth);
        p.lat += THREE.MathUtils.clamp(want - p.lat, -16 * dt, 16 * dt);
      }
      p.mesh.position.copy(t.worldAt(index, p.lat, p.height));
      p.mesh.rotation.y = t.yawAt(index);
      if (p.kind === 'soco') p.mesh.rotation.z += dt * 6;

      let dead = p.life <= 0;
      if (!dead) {
        for (const o of racers) {
          if (o === p.owner || o.finished) continue;
          TMP.subVectors(o.position, p.mesh.position);
          TMP.y = 0;
          if (TMP.lengthSq() > p.radius * p.radius) continue;

          const landed = o.hit(p.kind === 'canhao' ? 'freeze' : 'punch');
          if (landed && p.kind === 'soco') {
            // empurrão para trás, no sentido em que o soco viajava
            const tan = t.tangents[index];
            o.velocity.addScaledVector(tan, p.dir * PUNCH_IMPULSE);
            o.vy = Math.max(o.vy, 5.5);
          }
          onEvent?.({ type: p.kind, target: o, owner: p.owner, landed });
          dead = true;
          break;
        }
      }
      if (dead) {
        this.group.remove(p.mesh);
        this.shots.splice(i, 1);
      }
    }

    // --- armadilhas no chão ---
    for (let i = this.traps.length - 1; i >= 0; i--) {
      const h = this.traps[i];
      h.life -= dt;
      h.armTime -= dt;
      h.mesh.rotation.y += dt * 3.2;
      let dead = h.life <= 0;
      if (!dead) {
        for (const o of racers) {
          if (o.finished) continue;
          if (o === h.owner && h.armTime > 0) continue;
          TMP.subVectors(o.position, h.mesh.position);
          TMP.y = 0;
          if (TMP.lengthSq() < 2.5 * 2.5) {
            const landed = o.hit('spin');
            onEvent?.({ type: 'armadilha', target: o, owner: h.owner, landed });
            dead = true;
            break;
          }
        }
      }
      if (dead) {
        this.group.remove(h.mesh);
        this.traps.splice(i, 1);
      }
    }
  }
}
