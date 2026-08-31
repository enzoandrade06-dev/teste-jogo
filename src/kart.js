import * as THREE from 'three';
import { buildKart, buildBoostFlames } from './characters.js';

const FORWARD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const TMP = new THREE.Vector3();

// Constantes de dirigibilidade (metros / segundos / radianos)
const BASE_TOP_SPEED = 33;      // ~119 km/h
const BASE_ACCEL = 19;
const REVERSE_TOP = 9;
const BRAKE_POWER = 34;
const DRAG = 0.005;             // arrasto quadrático
const ROLL_RESIST = 0.9;
const MAX_TURN = 2.05;          // rad/s no pico
const GRIP_NORMAL = 9.5;        // quanto maior, menos desliza de lado
const GRIP_DRIFT = 2.2;
const GRIP_OFFROAD = 4.0;
const OFFROAD_SPEED = 0.52;
const OFFROAD_DRAG = 0.9;
const DRIFT_MIN_SPEED = 11;
const HOP_TIME = 0.22;
const BOOST_SPEED = 15;         // acréscimo à velocidade máxima durante o turbo
const BOOST_ACCEL = 26;
const MINI_TURBO = [
  { charge: 1.1, time: 0.75, color: 0x53c8ff },   // azul
  { charge: 2.3, time: 1.25, color: 0xff9a2e },   // laranja
  { charge: 3.8, time: 1.9,  color: 0xc36bff },   // roxo
];

export class Racer {
  /**
   * @param {object} character  entrada de CHARACTERS
   * @param {import('./track.js').Track} track
   * @param {number} slot posição na grade (0 = pole)
   * @param {boolean} isPlayer
   */
  constructor(character, track, slot, isPlayer = false) {
    this.character = character;
    this.track = track;
    this.isPlayer = isPlayer;
    this.slot = slot;

    const grid = track.gridSlot(slot);
    this.position = grid.position.clone();
    this.yaw = grid.yaw;
    this.velocity = new THREE.Vector3();
    this.vy = 0;

    this.trackIndex = grid.index;
    this.lateral = 0;
    this.prevS = grid.index * track.segLen;
    this.lap = 0;
    this.halfway = false;
    this.lapTimes = [];
    this.lapStart = 0;
    this.finished = false;
    this.finishTime = null;
    this.raceProgress = 0;   // metros percorridos no total (ordenação)
    this.place = slot + 1;

    // estado de derrapagem
    this.drifting = false;
    this.driftDir = 0;
    this.driftCharge = 0;
    this.hopTimer = 0;
    this.airborne = false;

    // turbo
    this.boostTime = 0;
    this.boostColor = 0x53c8ff;

    // penalidades
    this.spinTime = 0;
    this.frozenTime = 0;      // "estabilizado" pelo canhão: trava no lugar
    this.invulnTime = 0;

    // superpoderes (ver powers.js): ativo por alguns segundos
    this.power = null;
    this.powerTime = 0;
    this.powerCooldown = 0;

    // entradas (preenchidas pelo jogador ou pela IA)
    this.input = { steer: 0, throttle: 0, brake: 0, drift: false };

    // visual
    this.mesh = buildKart(character);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;
    this.flames = buildBoostFlames();
    this.mesh.add(this.flames);
    this.visualRoll = 0;
    this.wheelSpin = 0;

    // IA
    this.ai = null;
  }

  get speed() { return this.velocity.length(); }
  get forwardSpeed() {
    FORWARD.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    return this.velocity.dot(FORWARD);
  }
  get topSpeed() { return BASE_TOP_SPEED * this.character.speed; }
  get boosting() { return this.boostTime > 0; }

  /** Aplica um turbo (segundos). */
  addBoost(seconds, color = 0x53c8ff) {
    this.boostTime = Math.max(this.boostTime, seconds);
    this.boostColor = color;
  }

  /** Leva um golpe: rodopia e perde velocidade. */
  hit(kind = 'spin') {
    if (this.invulnTime > 0) return false;
    if (kind === 'freeze') {
      // canhão: o kart é estabilizado e para de responder por um instante
      this.frozenTime = 1.35;
      this.velocity.multiplyScalar(0.05);
    } else if (kind === 'punch') {
      // soco: rodopia mais forte e perde quase toda a velocidade
      this.spinTime = 1.35;
      this.velocity.multiplyScalar(0.2);
    } else {
      this.spinTime = 1.15;
      this.velocity.multiplyScalar(0.35);
    }
    this.boostTime = 0;
    this.drifting = false;
    this.driftCharge = 0;
    this.invulnTime = 1.9;
    return true;
  }

  respawn() {
    const p = this.track.project(this.position, this.trackIndex);
    this.position.copy(this.track.worldAt(p.index, 0, 0.4));
    this.yaw = this.track.yawAt(p.index);
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.spinTime = 0;
    this.frozenTime = 0;
    this.drifting = false;
    this.driftCharge = 0;
    this.invulnTime = 1.2;
  }

  // ------------------------------------------------------------------ física

  update(dt, raceStarted) {
    const t = this.track;
    const inp = this.input;

    const stunned = this.spinTime > 0 || this.frozenTime > 0;
    this.spinTime = Math.max(0, this.spinTime - dt);
    this.frozenTime = Math.max(0, this.frozenTime - dt);
    this.invulnTime = Math.max(0, this.invulnTime - dt);
    this.boostTime = Math.max(0, this.boostTime - dt);

    FORWARD.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    RIGHT.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));

    let vF = this.velocity.dot(FORWARD);
    let vR = this.velocity.dot(RIGHT);

    // estabilizado: freio total, sem direção e sem turbo
    if (this.frozenTime > 0) {
      const damp = Math.exp(-7 * dt);
      vF *= damp;
      vR *= damp;
    }

    // --- onde estamos na pista ---
    const proj = t.project(this.position, this.trackIndex);
    this.trackIndex = proj.index;
    this.lateral = proj.lateral;
    const offroad = Math.abs(this.lateral) > t.halfWidth;

    const throttle = raceStarted && !stunned ? inp.throttle : 0;
    const brake = raceStarted && !stunned ? inp.brake : 0;
    const steerIn = stunned ? 0 : inp.steer;

    // --- salto / início da derrapagem ---
    if (this.hopTimer > 0) {
      this.hopTimer -= dt;
      if (this.hopTimer <= 0 && !this.drifting) {
        // pousou: se ainda segura o botão e está virando, entra em derrapagem
        if (inp.drift && Math.abs(steerIn) > 0.25 && vF > DRIFT_MIN_SPEED) {
          this.drifting = true;
          this.driftDir = Math.sign(steerIn);
          this.driftCharge = 0;
        }
      }
    }
    if (inp.drift && !this._prevDrift && !this.drifting && !stunned && this.vy === 0) {
      this.hopTimer = HOP_TIME;
      this.vy = 3.4;
    }
    this._prevDrift = inp.drift;

    // --- fim da derrapagem ---
    if (this.drifting) {
      if (!inp.drift || vF < DRIFT_MIN_SPEED * 0.65 || throttle < 0.1) {
        this._releaseDrift();
      } else {
        // carrega mais rápido quando o volante acompanha o sentido do drift
        const aligned = 0.55 + 0.45 * Math.max(0, steerIn * this.driftDir);
        this.driftCharge += dt * aligned * 1.6;
      }
    }

    // --- direção ---
    const speedFactor = Math.min(1, Math.abs(vF) / 9);
    const turnScale = 1 - Math.min(0.42, Math.abs(vF) / this.topSpeed * 0.42);
    let turn;
    if (this.drifting) {
      // no drift o kart mantém um ângulo mínimo para o lado escolhido
      const bias = 0.62 + 0.38 * Math.max(0, steerIn * this.driftDir);
      turn = this.driftDir * MAX_TURN * 1.28 * bias;
    } else {
      turn = steerIn * MAX_TURN * this.character.grip;
    }
    if (this.spinTime > 0) turn = 9.5 * (this.slot % 2 ? 1 : -1);
    this.yaw -= turn * speedFactor * turnScale * dt * (vF < -0.5 ? -1 : 1);

    // --- motor ---
    const boostFactor = this.boosting ? 1 : 0;
    const top = (this.topSpeed + BOOST_SPEED * boostFactor) * (offroad ? OFFROAD_SPEED : 1);
    const accel = (BASE_ACCEL * this.character.accel + BOOST_ACCEL * boostFactor);

    if (throttle > 0) {
      const room = Math.max(0, 1 - Math.max(0, vF) / top);
      vF += accel * throttle * (0.35 + 0.65 * room) * dt;
    }
    if (brake > 0) {
      if (vF > 0.4) vF -= BRAKE_POWER * brake * dt;
      else vF = Math.max(-REVERSE_TOP, vF - BASE_ACCEL * 0.55 * brake * dt);
    }
    if (throttle === 0 && brake === 0) {
      vF -= Math.sign(vF) * Math.min(Math.abs(vF), ROLL_RESIST * dt * 4);
    }

    // arrasto
    const drag = DRAG * (offroad ? 1 + OFFROAD_DRAG : 1);
    vF -= drag * vF * Math.abs(vF) * dt;
    if (vF > top) vF += (top - vF) * Math.min(1, dt * 2.5);

    // --- aderência lateral ---
    let grip = this.drifting ? GRIP_DRIFT : GRIP_NORMAL * this.character.grip;
    if (offroad) grip = Math.min(grip, GRIP_OFFROAD);
    vR *= Math.exp(-grip * dt);
    // no drift o kart escorrega para fora da curva
    if (this.drifting) vR += -this.driftDir * Math.abs(vF) * 0.9 * dt;

    this.velocity.copy(FORWARD).multiplyScalar(vF).addScaledVector(RIGHT, vR);

    // --- vertical (salto do drift / relevo) ---
    const groundY = t.heightAt(this.trackIndex);
    this.vy -= 22 * dt;
    let newY = this.position.y + this.vy * dt;
    if (newY <= groundY) { newY = groundY; this.vy = 0; this.airborne = false; }
    else this.airborne = true;

    // --- integra ---
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = newY;

    // --- muros ---
    const wallLimit = t.halfWidth + 2.0;
    const after = t.project(this.position, this.trackIndex);
    if (Math.abs(after.lateral) > wallLimit) {
      const sign = Math.sign(after.lateral);
      this.position.copy(t.worldAt(after.index, sign * wallLimit, this.position.y - t.heightAt(after.index)));
      // reflete a componente lateral e perde energia
      const side = t.sides[after.index];
      const vLat = this.velocity.x * side.x + this.velocity.z * side.z;
      if (vLat * sign > 0) {
        this.velocity.x -= side.x * vLat * 1.5;
        this.velocity.z -= side.z * vLat * 1.5;
        this.velocity.multiplyScalar(0.72);
        this.wallHit = Math.min(1, Math.abs(vLat) / 12);
        this.drifting = false;
        this.driftCharge = 0;
      }
      this.trackIndex = after.index;
      this.lateral = sign * wallLimit;
    }

    // --- volta ---
    this._updateLap(after.index >= 0 ? after.index : proj.index, raceStarted);

    // --- visual ---
    this._updateVisual(dt, vF, steerIn, offroad);
  }

  _releaseDrift() {
    if (!this.drifting) return;
    this.drifting = false;
    let tier = -1;
    for (let i = MINI_TURBO.length - 1; i >= 0; i--) {
      if (this.driftCharge >= MINI_TURBO[i].charge) { tier = i; break; }
    }
    if (tier >= 0) {
      this.addBoost(MINI_TURBO[tier].time, MINI_TURBO[tier].color);
      this.miniTurboFlash = tier + 1;
    }
    this.driftCharge = 0;
    this.driftDir = 0;
  }

  /** Nível atual do mini-turbo carregado: 0 = nenhum, 1..3. */
  get driftTier() {
    let tier = 0;
    for (let i = 0; i < MINI_TURBO.length; i++) {
      if (this.driftCharge >= MINI_TURBO[i].charge) tier = i + 1;
    }
    return tier;
  }

  get driftTierColor() {
    const t = this.driftTier;
    return t > 0 ? MINI_TURBO[t - 1].color : 0xffffff;
  }

  _updateLap(index, raceStarted) {
    const t = this.track;
    const s = index * t.segLen;
    let ds = s - this.prevS;
    if (ds < -t.length / 2) {
      // cruzou a linha para frente
      if (this.halfway) {
        this.lap++;
        this.halfway = false;
        this.justCrossedLine = true;
      }
    } else if (ds > t.length / 2) {
      // voltou cruzando a linha de ré
      this.lap = Math.max(0, this.lap - 1);
      this.halfway = true;
    }
    if (index > t.n * 0.45 && index < t.n * 0.62) this.halfway = true;
    this.prevS = s;
    this.raceProgress = this.lap * t.length + s;
  }

  _updateVisual(dt, vF, steerIn, offroad) {
    const ud = this.mesh.userData;
    this.mesh.position.copy(this.position);

    // no drift o corpo aponta para fora da curva
    const targetSlip = this.drifting ? -this.driftDir * 0.45 : 0;
    ud.body.rotation.y += (targetSlip - ud.body.rotation.y) * Math.min(1, dt * 9);
    this.mesh.rotation.y = this.yaw;

    // inclinação lateral
    const targetRoll = -(this.drifting ? this.driftDir * 0.22 : steerIn * 0.09) * Math.min(1, Math.abs(vF) / 14);
    this.visualRoll += (targetRoll - this.visualRoll) * Math.min(1, dt * 8);
    ud.body.rotation.z = this.visualRoll;

    // rodas
    this.wheelSpin += vF * dt * 2.1;
    for (const w of ud.wheels) {
      w.children[0].rotation.x = this.wheelSpin;
      w.children[1].rotation.x = this.wheelSpin;
    }
    const steerAngle = (this.drifting ? this.driftDir * 0.5 : steerIn * 0.42);
    for (const w of ud.frontWheels) w.rotation.y = -steerAngle;
    if (ud.steeringWheel) ud.steeringWheel.rotation.z = -steerAngle * 1.8;

    // chamas do turbo
    this.flames.visible = this.boosting;
    if (this.boosting) {
      const s = 0.8 + Math.sin(performance.now() * 0.03) * 0.25;
      this.flames.scale.set(1, 1, s);
      for (const c of this.flames.children) c.material.color.setHex(this.boostColor);
    }

    // pisca quando invulnerável
    this.mesh.visible = !(this.invulnTime > 0.05 && Math.floor(performance.now() / 70) % 2 === 0 && this.spinTime <= 0);
  }
}

/** Empurrão entre karts (chame com todos os pares). */
export function resolveKartCollisions(racers) {
  const R = 1.55;
  for (let i = 0; i < racers.length; i++) {
    for (let j = i + 1; j < racers.length; j++) {
      const a = racers[i], b = racers[j];
      TMP.subVectors(b.position, a.position);
      TMP.y = 0;
      const d = TMP.length();
      if (d > R * 2 || d < 1e-4) continue;
      TMP.divideScalar(d);
      const overlap = R * 2 - d;
      const ma = a.character.weight, mb = b.character.weight;
      const total = ma + mb;
      a.position.addScaledVector(TMP, -overlap * (mb / total));
      b.position.addScaledVector(TMP, overlap * (ma / total));

      // troca de impulso: quem vem mais rápido empurra
      const rel = TMP.dot(a.velocity) - TMP.dot(b.velocity);
      if (rel > 0) {
        const imp = rel * 0.8;
        a.velocity.addScaledVector(TMP, -imp * (mb / total));
        b.velocity.addScaledVector(TMP, imp * (ma / total));
        a.bumped = b.bumped = Math.min(1, rel / 14);
      }
    }
  }
}
