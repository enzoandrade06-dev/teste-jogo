import * as THREE from 'three';

// Elenco genérico — sem nenhuma propriedade intelectual de terceiros.
// Todos os pilotos têm exatamente as mesmas características: a escolha do
// personagem é só estética (cor). A corrida é decidida pela pista e pelos
// superpoderes, não por vantagem de veículo.
// speed  : velocidade máxima
// accel  : aceleração
// grip   : aderência em curva (quanto menos, mais desliza)
// weight : massa (empurra os outros nas colisões, sofre menos knockback)
export const CHARACTERS = [
  { id: 'vera',  name: 'VERA',   color: 0xff4d6d, accent: 0xffd166, speed: 1.00, accel: 1.00, grip: 1.00, weight: 1.00, desc: 'Equilibrada' },
  { id: 'bolt',  name: 'BOLT',   color: 0x3ddc97, accent: 0x0b3d2e, speed: 1.00, accel: 1.00, grip: 1.00, weight: 1.00, desc: 'Equilibrada' },
  { id: 'tuk',   name: 'TUK',    color: 0xffc233, accent: 0x6b3f00, speed: 1.00, accel: 1.00, grip: 1.00, weight: 1.00, desc: 'Equilibrada' },
  { id: 'brutus',name: 'BRUTUS', color: 0x8b6bff, accent: 0x241546, speed: 1.00, accel: 1.00, grip: 1.00, weight: 1.00, desc: 'Equilibrada' },
  { id: 'nina',  name: 'NINA',   color: 0x36c5f0, accent: 0x0a3b52, speed: 1.00, accel: 1.00, grip: 1.00, weight: 1.00, desc: 'Equilibrada' },
  { id: 'zed',   name: 'ZED',    color: 0xff8b3d, accent: 0x4a1f00, speed: 1.00, accel: 1.00, grip: 1.00, weight: 1.00, desc: 'Equilibrada' },
];

/** Monta o kart + piloto em blocos simples (estilo low-poly colorido). */
export function buildKart(character) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  g.userData.body = body;

  const paint = new THREE.MeshLambertMaterial({ color: character.color });
  const dark = new THREE.MeshLambertMaterial({ color: 0x22242e });
  const accent = new THREE.MeshLambertMaterial({ color: character.accent });
  const skin = new THREE.MeshLambertMaterial({ color: 0xf0c9a0 });

  // chassi
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.42, 2.9), paint);
  chassis.position.y = 0.52;
  chassis.castShadow = true;
  body.add(chassis);

  // bico
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.3, 0.8), accent);
  nose.position.set(0, 0.44, 1.72);
  body.add(nose);

  // laterais
  for (const s of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.5, 1.9), accent);
    pod.position.set(s * 0.92, 0.5, -0.1);
    body.add(pod);
  }

  // motor traseiro
  const engine = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.6, 0.7), dark);
  engine.position.set(0, 0.78, -1.42);
  body.add(engine);

  // escapamentos
  for (const s of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.7, 6), new THREE.MeshLambertMaterial({ color: 0x9aa0aa }));
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(s * 0.34, 0.86, -1.85);
    body.add(pipe);
  }

  // banco
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.22), dark);
  seat.position.set(0, 1.06, -0.72);
  body.add(seat);

  // piloto
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.8, 0.6), new THREE.MeshLambertMaterial({ color: character.accent }));
  torso.position.set(0, 1.12, -0.42);
  torso.castShadow = true;
  body.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.58, 0.6), skin);
  head.position.set(0, 1.76, -0.42);
  head.castShadow = true;
  body.add(head);

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), paint);
  helmet.position.set(0, 1.86, -0.42);
  body.add(helmet);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.08), new THREE.MeshLambertMaterial({ color: 0x111827 }));
  visor.position.set(0, 1.8, -0.12);
  body.add(visor);

  // braços apontando para o volante
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.85), skin);
    arm.position.set(s * 0.3, 1.2, 0.06);
    arm.rotation.x = -0.35;
    body.add(arm);
  }

  // volante
  const wheelSteer = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.06, 6, 12), dark);
  wheelSteer.position.set(0, 1.24, 0.5);
  wheelSteer.rotation.x = 1.15;
  body.add(wheelSteer);
  g.userData.steeringWheel = wheelSteer;

  // rodas
  const tireMat = new THREE.MeshLambertMaterial({ color: 0x1b1c22 });
  const rimMat = new THREE.MeshLambertMaterial({ color: 0xdde3ea });
  const wheels = [];
  const mk = (x, z, r, w) => {
    const grp = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 12), tireMat);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    grp.add(tire);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, w + 0.04, 8), rimMat);
    rim.rotation.z = Math.PI / 2;
    grp.add(rim);
    grp.position.set(x, r, z);
    body.add(grp);
    wheels.push(grp);
    return grp;
  };
  g.userData.frontWheels = [mk(-0.92, 1.02, 0.42, 0.34), mk(0.92, 1.02, 0.42, 0.34)];
  g.userData.rearWheels = [mk(-0.98, -1.12, 0.54, 0.46), mk(0.98, -1.12, 0.54, 0.46)];
  g.userData.wheels = wheels;

  // aerofólio
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.44), accent);
  wing.position.set(0, 1.24, -1.72);
  body.add(wing);
  for (const s of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.42, 0.1), dark);
    strut.position.set(s * 0.7, 1.03, -1.72);
    body.add(strut);
  }

  return g;
}

/** Anel/aura de turbo que aparece durante o boost. */
export function buildBoostFlames() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.9 });
  for (const s of [-1, 1]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.24, 1.1, 7), mat);
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(s * 0.34, 0.86, -2.5);
    g.add(cone);
  }
  g.visible = false;
  return g;
}
