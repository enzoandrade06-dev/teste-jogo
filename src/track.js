import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Definição das pistas: pontos de controle de uma spline fechada.
// y = elevação. O traçado é reamostrado por comprimento de arco para que o
// "progresso" na volta seja linear em metros.
// ---------------------------------------------------------------------------

export const TRACKS = [
  {
    id: 'circuito',
    name: 'CIRCUITO SOL',
    halfWidth: 11,
    laps: 3,
    sky: 0x8fd0ff,
    fog: 0xbfe4ff,
    ground: 0x4c9e4a,
    points: [
      [0, 0, -120], [70, 0, -110], [120, 0, -50], [118, 2, 30],
      [70, 4, 90], [0, 4, 110], [-60, 2, 96], [-104, 0, 40],
      [-120, 0, -30], [-96, 0, -96], [-40, 0, -128],
    ],
  },
  {
    id: 'serra',
    name: 'SERRA DUPLA',
    halfWidth: 10,
    laps: 3,
    sky: 0xffb37a,
    fog: 0xffd2ab,
    ground: 0x8a6a3d,
    points: [
      // reta principal (sul), começando a subir a serra
      [-110, 0, -195], [30, 2, -200], [120, 6, -186],
      // curva 1 — direita larga
      [180, 10, -140], [196, 14, -70],
      // reta leste, ponto mais alto
      [188, 18, 20], [170, 20, 80],
      // curva 2 — esquerda média
      [120, 18, 130], [40, 14, 158],
      // chicane no alto
      [-45, 12, 150], [-105, 10, 168],
      // curva 3 — grampo aberto a oeste
      [-170, 6, 130], [-198, 4, 55],
      // descida de volta
      [-192, 2, -40], [-160, 0, -125],
    ],
  },
  {
    id: 'fabrica',
    name: 'FÁBRICA NEON',
    halfWidth: 12,
    laps: 3,
    sky: 0x14102b,
    fog: 0x241a44,
    ground: 0x1a1730,
    points: [
      [-70, 0, -150], [60, 0, -155],      // reta de largada
      [125, 0, -120], [145, 0, -55],      // curva 1
      [130, 0, 10], [90, 0, 55],          // esse rápido
      [95, 0, 115], [45, 0, 155],         // curva 2
      [-40, 0, 160], [-110, 0, 130],      // curva 3
      [-140, 0, 65], [-120, 0, 5],        // grampo oeste
      [-155, 0, -55], [-140, 0, -120],    // retorno
    ],
  },
];

const SAMPLES = 900;
const UP = new THREE.Vector3(0, 1, 0);

export class Track {
  constructor(def) {
    this.def = def;
    this.halfWidth = def.halfWidth;
    this.laps = def.laps;

    const pts = def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);

    // amostragem uniforme por comprimento de arco
    const spaced = this.curve.getSpacedPoints(SAMPLES);
    spaced.pop(); // último == primeiro numa curva fechada
    this.samples = spaced;
    this.n = spaced.length;

    this.tangents = [];
    this.sides = [];
    for (let i = 0; i < this.n; i++) {
      const a = spaced[(i - 1 + this.n) % this.n];
      const b = spaced[(i + 1) % this.n];
      const t = new THREE.Vector3().subVectors(b, a).normalize();
      const s = new THREE.Vector3().crossVectors(t, UP).normalize();
      this.tangents.push(t);
      this.sides.push(s);
    }

    this.length = this.curve.getLength();
    this.segLen = this.length / this.n;

    this.mesh = new THREE.Group();
    this._buildRoad();
    this._buildWalls();
    this._buildScenery();
  }

  // -------------------------------------------------------------- consultas

  /**
   * Projeta uma posição no traçado.
   * @param {THREE.Vector3} pos
   * @param {number} hint índice provável (busca local, muito mais barata)
   * @returns {{index:number, s:number, lateral:number, point:THREE.Vector3, tangent:THREE.Vector3}}
   */
  project(pos, hint = -1) {
    let best = -1;
    let bestD = Infinity;

    const scan = (from, to) => {
      for (let k = from; k <= to; k++) {
        const i = ((k % this.n) + this.n) % this.n;
        const p = this.samples[i];
        const dx = pos.x - p.x, dz = pos.z - p.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    };

    if (hint >= 0) {
      scan(hint - 40, hint + 40);
      // se ficou na borda da janela, o palpite estava ruim: varre tudo
      const delta = Math.abs(((best - hint + this.n * 1.5) % this.n) - this.n * 0.5);
      if (delta > 34) { bestD = Infinity; best = -1; scan(0, this.n - 1); }
    } else {
      scan(0, this.n - 1);
    }

    const point = this.samples[best];
    const side = this.sides[best];
    const lateral = (pos.x - point.x) * side.x + (pos.z - point.z) * side.z;

    return {
      index: best,
      s: best * this.segLen,
      lateral,
      point,
      tangent: this.tangents[best],
    };
  }

  /** Altura do asfalto num ponto do traçado (interpolada entre amostras). */
  heightAt(index, lateral = 0) {
    return this.samples[index].y;
  }

  /** Posição no mundo a partir de (índice, deslocamento lateral). */
  worldAt(index, lateral, height = 0) {
    const i = ((index % this.n) + this.n) % this.n;
    const p = this.samples[i], s = this.sides[i];
    return new THREE.Vector3(
      p.x + s.x * lateral,
      p.y + height,
      p.z + s.z * lateral,
    );
  }

  /** Ângulo (yaw) do traçado num índice. */
  yawAt(index) {
    const t = this.tangents[((index % this.n) + this.n) % this.n];
    return Math.atan2(t.x, t.z);
  }

  /**
   * Curvatura aproximada (rad/m) — usada pela IA para saber quando frear.
   * @param {number} meters distância de antecipação, em metros (não em amostras:
   *   segLen varia de ~0,85 m a ~1,8 m entre as pistas).
   */
  curvatureAt(index, meters = 24) {
    const lookahead = Math.max(2, Math.round(meters / this.segLen));
    const i = ((index % this.n) + this.n) % this.n;
    const j = (i + lookahead) % this.n;
    const a = this.tangents[i], b = this.tangents[j];
    const dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z));
    return Math.acos(dot) / (lookahead * this.segLen);
  }

  // -------------------------------------------------------------- geometria

  _buildRoad() {
    const geo = new THREE.BufferGeometry();
    const pos = [], uv = [], idx = [], nrm = [];
    const w = this.halfWidth;

    for (let i = 0; i <= this.n; i++) {
      const k = i % this.n;
      const p = this.samples[k], s = this.sides[k];
      pos.push(p.x - s.x * w, p.y, p.z - s.z * w);
      pos.push(p.x + s.x * w, p.y, p.z + s.z * w);
      nrm.push(0, 1, 0, 0, 1, 0);
      const v = i * this.segLen / 12;
      uv.push(0, v, 1, v);
    }
    for (let i = 0; i < this.n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);

    const tex = makeAsphaltTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const road = new THREE.Mesh(geo, mat);
    road.receiveShadow = true;
    this.mesh.add(road);

    // acostamento (zebrado) dos dois lados
    for (const sign of [-1, 1]) {
      const g = new THREE.BufferGeometry();
      const P = [], U = [], I = [], N = [];
      for (let i = 0; i <= this.n; i++) {
        const k = i % this.n;
        const p = this.samples[k], s = this.sides[k];
        const inner = w * sign, outer = (w + 2.2) * sign;
        P.push(p.x + s.x * inner, p.y + 0.02, p.z + s.z * inner);
        P.push(p.x + s.x * outer, p.y + 0.02, p.z + s.z * outer);
        N.push(0, 1, 0, 0, 1, 0);
        const v = i * this.segLen / 3;
        U.push(0, v, 1, v);
      }
      for (let i = 0; i < this.n; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        if (sign > 0) I.push(a, c, b, b, c, d);
        else I.push(a, b, c, b, d, c);
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      g.setIndex(I);
      const rt = makeRumbleTexture();
      rt.wrapS = rt.wrapT = THREE.RepeatWrapping;
      this.mesh.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: rt })));
    }

    // linha de chegada quadriculada
    const finish = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 2, 5),
      new THREE.MeshBasicMaterial({ map: makeCheckerTexture(), transparent: true }),
    );
    const p0 = this.samples[0];
    finish.position.set(p0.x, p0.y + 0.05, p0.z);
    finish.rotation.x = -Math.PI / 2;
    finish.rotation.z = -this.yawAt(0);
    this.mesh.add(finish);
  }

  _buildWalls() {
    const h = 2.4;
    const w = this.halfWidth + 2.2;
    this.walls = [];
    for (const sign of [-1, 1]) {
      const geo = new THREE.BufferGeometry();
      const P = [], I = [], N = [], U = [];
      for (let i = 0; i <= this.n; i++) {
        const k = i % this.n;
        const p = this.samples[k], s = this.sides[k];
        const x = p.x + s.x * w * sign, z = p.z + s.z * w * sign;
        P.push(x, p.y, z);
        P.push(x, p.y + h, z);
        const nx = -s.x * sign, nz = -s.z * sign;
        N.push(nx, 0, nz, nx, 0, nz);
        const u = i * this.segLen / 6;
        U.push(u, 0, u, 1);
      }
      for (let i = 0; i < this.n; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        if (sign > 0) I.push(a, b, c, b, d, c);
        else I.push(a, c, b, b, c, d);
      }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      geo.setIndex(I);
      const tex = makeWallTexture();
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      this.mesh.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex })));
    }
  }

  _buildScenery() {
    // chão infinito
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000),
      new THREE.MeshLambertMaterial({ color: this.def.ground }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.6;
    ground.receiveShadow = true;
    this.mesh.add(ground);

    // objetos decorativos fora da pista (árvores / postes)
    const isNeon = this.def.id === 'fabrica';
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3.4, 6);
    const leafGeo = isNeon
      ? new THREE.BoxGeometry(1.6, 5, 1.6)
      : new THREE.ConeGeometry(2.6, 6, 7);
    const trunkMat = new THREE.MeshLambertMaterial({ color: isNeon ? 0x33306a : 0x6b4529 });
    const leafMat = isNeon
      ? new THREE.MeshBasicMaterial({ color: 0x00e5ff })
      : new THREE.MeshLambertMaterial({ color: 0x2f7d32 });

    const count = Math.floor(this.n / 14);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count * 2);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, count * 2);
    const m = new THREE.Matrix4();
    let n = 0;
    for (let i = 0; i < count; i++) {
      const idx = i * 14;
      for (const sign of [-1, 1]) {
        const off = (this.halfWidth + 8 + ((i * 7919) % 17)) * sign;
        const p = this.worldAt(idx, off);
        const sc = 0.8 + ((i * 31) % 10) / 14;
        m.makeScale(sc, sc, sc);
        m.setPosition(p.x, p.y + 1.4 * sc, p.z);
        trunks.setMatrixAt(n, m);
        m.makeScale(sc, sc, sc);
        m.setPosition(p.x, p.y + (isNeon ? 4.4 : 5.4) * sc, p.z);
        leaves.setMatrixAt(n, m);
        n++;
      }
    }
    trunks.count = n; leaves.count = n;
    this.mesh.add(trunks, leaves);
  }

  /** Grade de largada: 6 posições escalonadas atrás da linha. */
  gridSlot(i) {
    const row = Math.floor(i / 2);
    const col = i % 2 === 0 ? -1 : 1;
    const back = 10 + row * 9;
    const index = (this.n - Math.round(back / this.segLen)) % this.n;
    return {
      position: this.worldAt(index, col * this.halfWidth * 0.42, 0),
      yaw: this.yawAt(index),
      index,
    };
  }
}

// ------------------------------------------------------------ texturas proc.

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function makeAsphaltTexture() {
  const [c, g] = canvas2d(128, 128);
  g.fillStyle = '#3a3a42';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2600; i++) {
    const v = 40 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 6},${0.25 + Math.random() * 0.4})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  // linha central tracejada
  g.fillStyle = 'rgba(240,240,240,0.75)';
  g.fillRect(61, 0, 6, 46);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}

function makeRumbleTexture() {
  const [c, g] = canvas2d(16, 64);
  g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, 16, 32);
  g.fillStyle = '#d8322f'; g.fillRect(0, 32, 16, 32);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

function makeWallTexture() {
  const [c, g] = canvas2d(64, 64);
  g.fillStyle = '#d9dde4'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#2a6cd4'; g.fillRect(0, 20, 64, 12);
  g.fillStyle = '#e2453f'; g.fillRect(0, 40, 64, 8);
  return new THREE.CanvasTexture(c);
}

function makeCheckerTexture() {
  const [c, g] = canvas2d(128, 32);
  const s = 16;
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#fff';
      g.fillRect(x * s, y * s, s, s);
    }
  }
  return new THREE.CanvasTexture(c);
}
