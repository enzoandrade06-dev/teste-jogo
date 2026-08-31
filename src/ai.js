import * as THREE from 'three';

const TMP = new THREE.Vector3();

// Personalidades: variam a linha de corrida, a agressividade e o quanto
// arriscam nas curvas. Isso evita que os 5 bots andem colados.
const PERSONALITIES = [
  { line: 0.00, brave: 1.00, aggro: 0.5 },
  { line: 0.34, brave: 0.94, aggro: 0.3 },
  { line: -0.30, brave: 1.05, aggro: 0.7 },
  { line: 0.18, brave: 0.90, aggro: 0.4 },
  { line: -0.16, brave: 1.02, aggro: 0.6 },
];

export class KartAI {
  constructor(racer, seed = 0) {
    this.racer = racer;
    this.p = PERSONALITIES[seed % PERSONALITIES.length];
    this.seed = seed;
    this.wobblePhase = seed * 1.7;
    this.itemCooldown = 1 + seed * 0.4;
    this.stuckTimer = 0;
  }

  /**
   * @param {number} dt
   * @param {number} difficulty 0.85 .. 1.05 (rubber-band)
   */
  update(dt, difficulty, racers) {
    const r = this.racer;
    const t = r.track;
    const inp = r.input;
    this.wobblePhase += dt * 0.6;

    // ---- ponto de mira à frente, proporcional à velocidade ----
    const lookaheadM = 9 + r.speed * 0.62;
    const targetIndex = (r.trackIndex + Math.round(lookaheadM / t.segLen)) % t.n;

    // linha de corrida: pende para dentro da curva que vem
    const curve = signedCurvature(t, r.trackIndex, lookaheadM);
    const apex = -Math.sign(curve) * Math.min(1, Math.abs(curve) * 55) * 0.62;
    const wobble = Math.sin(this.wobblePhase) * 0.1;
    let targetLat = (this.p.line + apex + wobble) * t.halfWidth * 0.72;

    // desviar de obstáculos e de karts logo à frente
    targetLat += this._avoid(racers, t);
    targetLat = THREE.MathUtils.clamp(targetLat, -t.halfWidth * 0.88, t.halfWidth * 0.88);

    const target = t.worldAt(targetIndex, targetLat);
    TMP.subVectors(target, r.position);
    const desiredYaw = Math.atan2(TMP.x, TMP.z);
    let err = wrapAngle(desiredYaw - r.yaw);

    // steer positivo = direita, e virar à direita reduz o yaw -> inverte o erro
    inp.steer = THREE.MathUtils.clamp(-err * 2.1, -1, 1);

    // ---- velocidade alvo: quanto mais fechada a curva à frente, mais devagar ----
    // metros, não amostras — a antecipação precisa ser igual em todas as pistas
    const cAhead = Math.max(
      t.curvatureAt(r.trackIndex, 18),
      t.curvatureAt(r.trackIndex, 38) * 0.85,
      t.curvatureAt(r.trackIndex, 64) * 0.6,
    );
    const safe = THREE.MathUtils.clamp(1.28 - cAhead * 26, 0.42, 1) * this.p.brave * difficulty;
    const targetSpeed = r.topSpeed * safe;
    const v = r.forwardSpeed;

    if (v < targetSpeed) { inp.throttle = 1; inp.brake = 0; }
    else if (v > targetSpeed * 1.16) { inp.throttle = 0; inp.brake = 0.75; }
    else { inp.throttle = 0.45; inp.brake = 0; }

    // fora da pista: volta pro asfalto a todo custo
    if (Math.abs(r.lateral) > t.halfWidth) inp.throttle = 1;

    // ---- derrapar em curvas longas para ganhar mini-turbo ----
    const wantDrift = cAhead > 0.019 && v > 15 && Math.abs(inp.steer) > 0.3;
    if (r.drifting) {
      // segura até carregar pelo menos o turbo azul, e solta quando a curva abre
      inp.drift = r.driftTier < 1 || cAhead > 0.012;
    } else {
      inp.drift = wantDrift;
    }

    // ---- destravar quando bate no muro ou empaca ----
    if (Math.abs(v) < 2.2 && r.spinTime <= 0) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.6) {
        inp.throttle = 0; inp.brake = 1;
        inp.steer = Math.sign(err || 1);
        if (this.stuckTimer > 3.2) { r.respawn(); this.stuckTimer = 0; }
      }
    } else this.stuckTimer = 0;

    // ---- itens ----
    this.itemCooldown -= dt;
    inp.useItem = false;
    if (r.item && this.itemCooldown <= 0) {
      inp.useItem = true;
      this.itemCooldown = 1.4 + (this.seed % 3) * 0.5;
    }
  }

  _avoid(racers, t) {
    const r = this.racer;
    let push = 0;
    for (const o of racers) {
      if (o === r) continue;
      const dz = forwardGap(r, o, t);
      if (dz < 1 || dz > 13) continue;
      const dl = o.lateral - r.lateral;
      if (Math.abs(dl) > 5.5) continue;
      // desvia para o lado mais livre
      push += (dl >= 0 ? -1 : 1) * (1 - dz / 13) * 4.2 * (1 + this.p.aggro * 0.3);
    }
    return push;
  }
}

function forwardGap(a, b, t) {
  let d = (b.trackIndex - a.trackIndex) * t.segLen;
  if (d < -t.length / 2) d += t.length;
  if (d > t.length / 2) d -= t.length;
  return d;
}

function signedCurvature(t, index, meters) {
  const ahead = Math.max(2, Math.round(meters / t.segLen));
  const i = ((index % t.n) + t.n) % t.n;
  const j = (i + ahead) % t.n;
  const a = t.tangents[i], b = t.tangents[j];
  const cross = a.z * b.x - a.x * b.z;
  const dot = THREE.MathUtils.clamp(a.x * b.x + a.z * b.z, -1, 1);
  return Math.sign(cross) * Math.acos(dot) / (ahead * t.segLen);
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
