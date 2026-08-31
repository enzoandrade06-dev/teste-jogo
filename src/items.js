import * as THREE from 'three';

const TMP = new THREE.Vector3();

export const ITEMS = {
  turbo:  { icon: '💨', name: 'Turbo' },
  missil: { icon: '🚀', name: 'Míssil' },
  oleo:   { icon: '🛢️', name: 'Óleo' },
  escudo: { icon: '🛡️', name: 'Escudo' },
  raio:   { icon: '⚡', name: 'Raio' },
};

// Tabela de sorteio por posição: quem está atrás recebe itens melhores.
// [turbo, missil, oleo, escudo, raio]
const ODDS = [
  [10, 18, 46, 26, 0],   // 1º
  [18, 30, 30, 20, 2],   // 2º
  [24, 32, 20, 18, 6],   // 3º
  [28, 30, 14, 16, 12],  // 4º
  [32, 26, 10, 14, 18],  // 5º
  [34, 22, 8, 12, 24],   // 6º+
];
const KEYS = ['turbo', 'missil', 'oleo', 'escudo', 'raio'];

function rollItem(place) {
  const row = ODDS[Math.min(place - 1, ODDS.length - 1)];
  const total = row.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < row.length; i++) {
    r -= row[i];
    if (r <= 0) return KEYS[i];
  }
  return 'turbo';
}

export class ItemSystem {
  constructor(track, scene) {
    this.track = track;
    this.scene = scene;
    this.boxes = [];
    this.projectiles = [];
    this.hazards = [];

    this.group = new THREE.Group();
    scene.add(this.group);

    this._makeBoxes();
    this._prepareTemplates();
  }

  _makeBoxes() {
    const t = this.track;
    const geo = new THREE.BoxGeometry(1.9, 1.9, 1.9);
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffe066, emissive: 0x996600, transparent: true, opacity: 0.92,
    });
    // 4 fileiras espalhadas pela volta, 3 caixas lado a lado
    const rows = 5;
    for (let r = 0; r < rows; r++) {
      const index = Math.round((r + 0.5) / rows * t.n);
      for (const lat of [-t.halfWidth * 0.5, 0, t.halfWidth * 0.5]) {
        const mesh = new THREE.Mesh(geo, mat.clone());
        const p = t.worldAt(index, lat, 1.5);
        mesh.position.copy(p);
        this.group.add(mesh);
        this.boxes.push({ mesh, position: p, cooldown: 0, index });
      }
    }
  }

  _prepareTemplates() {
    this.missileGeo = new THREE.ConeGeometry(0.42, 1.5, 8);
    this.missileMat = new THREE.MeshLambertMaterial({ color: 0xff4d4d, emissive: 0x661111 });
    this.oilGeo = new THREE.CylinderGeometry(1.5, 1.5, 0.14, 16);
    this.oilMat = new THREE.MeshLambertMaterial({ color: 0x15151c });
  }

  /** Um kart pega uma caixa. */
  _tryPickup(racer, dt) {
    if (racer.item || racer.itemRolling > 0) return;
    for (const box of this.boxes) {
      if (box.cooldown > 0) continue;
      TMP.subVectors(racer.position, box.position);
      TMP.y = 0;
      if (TMP.lengthSq() < 3.4 * 3.4) {
        box.cooldown = 3.5;
        box.mesh.visible = false;
        racer.itemRolling = 0.9;
        racer.pendingItem = rollItem(racer.place);
        break;
      }
    }
  }

  /** Usa o item do kart. */
  use(racer, racers) {
    const item = racer.item;
    if (!item) return null;
    racer.item = null;

    switch (item) {
      case 'turbo':
        racer.addBoost(1.9, 0x9dff6b);
        break;

      case 'escudo':
        racer.shieldTime = 7;
        break;

      case 'missil': {
        const target = this._nextAhead(racer, racers);
        const mesh = new THREE.Mesh(this.missileGeo, this.missileMat);
        mesh.rotation.x = Math.PI / 2;
        const wrap = new THREE.Group();
        wrap.add(mesh);
        wrap.position.copy(racer.position).addScaledVector(
          new THREE.Vector3(Math.sin(racer.yaw), 0, Math.cos(racer.yaw)), 3.2,
        );
        wrap.position.y += 0.7;
        this.group.add(wrap);
        this.projectiles.push({
          mesh: wrap, owner: racer, target,
          speed: Math.max(racer.speed, 26) + 14,
          life: 7,
          trackIndex: racer.trackIndex,
          yaw: racer.yaw,
        });
        break;
      }

      case 'oleo': {
        const mesh = new THREE.Mesh(this.oilGeo, this.oilMat);
        const back = new THREE.Vector3(-Math.sin(racer.yaw), 0, -Math.cos(racer.yaw));
        mesh.position.copy(racer.position).addScaledVector(back, 3.6);
        mesh.position.y = this.track.heightAt(racer.trackIndex) + 0.08;
        this.group.add(mesh);
        this.hazards.push({ mesh, owner: racer, life: 22, armTime: 0.5 });
        break;
      }

      case 'raio': {
        for (const o of racers) {
          if (o === racer || o.finished) continue;
          if (o.raceProgress > racer.raceProgress) o.hit('squash');
        }
        racer.addBoost(0.5, 0xfff07a);
        return 'raio';
      }
    }
    return item;
  }

  _nextAhead(racer, racers) {
    let best = null, bestGap = Infinity;
    for (const o of racers) {
      if (o === racer) continue;
      let gap = o.raceProgress - racer.raceProgress;
      if (gap <= 0) continue;
      if (gap < bestGap) { bestGap = gap; best = o; }
    }
    return bestGap < 130 ? best : null;
  }

  update(dt, racers, onEvent) {
    const t = this.track;

    // caixas
    for (const box of this.boxes) {
      if (box.cooldown > 0) {
        box.cooldown -= dt;
        if (box.cooldown <= 0) box.mesh.visible = true;
      } else {
        box.mesh.rotation.y += dt * 1.9;
        box.mesh.rotation.x += dt * 1.1;
        box.mesh.position.y = box.position.y + Math.sin(performance.now() * 0.003 + box.index) * 0.28;
      }
    }

    for (const r of racers) {
      this._tryPickup(r, dt);
      if (r.itemRolling > 0) {
        r.itemRolling -= dt;
        if (r.itemRolling <= 0 && r.pendingItem) {
          r.item = r.pendingItem;
          r.pendingItem = null;
        }
      }
    }

    // mísseis
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;

      // segue a pista, com correção em direção ao alvo
      const proj = t.project(p.mesh.position, p.trackIndex);
      p.trackIndex = proj.index;
      const aheadIdx = (proj.index + Math.round(14 / t.segLen)) % t.n;
      let targetLat = 0;
      if (p.target) targetLat = THREE.MathUtils.clamp(p.target.lateral, -t.halfWidth, t.halfWidth);
      const aim = t.worldAt(aheadIdx, targetLat, 0.7);
      TMP.subVectors(aim, p.mesh.position);
      const want = Math.atan2(TMP.x, TMP.z);
      let d = want - p.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      p.yaw += THREE.MathUtils.clamp(d, -3.4 * dt, 3.4 * dt);
      p.mesh.rotation.y = p.yaw;
      p.mesh.position.x += Math.sin(p.yaw) * p.speed * dt;
      p.mesh.position.z += Math.cos(p.yaw) * p.speed * dt;
      p.mesh.position.y = t.heightAt(proj.index) + 0.8;

      let dead = p.life <= 0;
      if (!dead) {
        for (const r of racers) {
          if (r === p.owner || r.finished) continue;
          TMP.subVectors(r.position, p.mesh.position);
          TMP.y = 0;
          if (TMP.lengthSq() < 2.6 * 2.6) {
            const landed = r.hit('spin');
            onEvent?.({ type: 'missile', target: r, landed, owner: p.owner });
            dead = true;
            break;
          }
        }
      }
      if (Math.abs(proj.lateral) > t.halfWidth + 2.2) dead = true;

      if (dead) {
        this.group.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }

    // óleo no chão
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.life -= dt;
      h.armTime -= dt;
      let dead = h.life <= 0;
      if (!dead) {
        for (const r of racers) {
          if (r.finished) continue;
          if (r === h.owner && h.armTime > 0) continue;
          TMP.subVectors(r.position, h.mesh.position);
          TMP.y = 0;
          if (TMP.lengthSq() < 2.4 * 2.4) {
            const landed = r.hit('spin');
            onEvent?.({ type: 'oil', target: r, landed });
            dead = true;
            break;
          }
        }
      }
      if (dead) {
        this.group.remove(h.mesh);
        this.hazards.splice(i, 1);
      }
    }
  }
}
