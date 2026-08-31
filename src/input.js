// Entrada unificada: DualSense (PS5) via Gamepad API + teclado como fallback.
//
// No mapeamento "standard" do navegador o DualSense expõe:
//   0 ✕   1 ◯   2 □   3 △
//   4 L1  5 R1  6 L2  7 R2   (L2/R2 são analógicos: button.value 0..1)
//   8 Create  9 Options  10 L3  11 R3
//   12..15 D-pad (cima, baixo, esq, dir)
//   axes: [0,1] analógico esquerdo, [2,3] analógico direito

const DEADZONE = 0.12;
const TRIGGER_FLOOR = 0.04;

export const BTN = {
  CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3,
  L1: 4, R1: 5, L2: 6, R2: 7,
  CREATE: 8, OPTIONS: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

function applyDeadzone(v) {
  if (Math.abs(v) < DEADZONE) return 0;
  const s = Math.sign(v);
  return s * (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
}

export class Input {
  constructor() {
    this.padIndex = null;
    this.padName = '';
    this.keys = new Set();

    // estado do frame
    this.steer = 0;       // -1 esquerda .. +1 direita
    this.throttle = 0;    // 0..1
    this.brake = 0;       // 0..1
    this.drift = false;
    this.lookBack = false;

    // eventos de borda (consumidos uma vez)
    this._prevButtons = [];
    this._pressed = new Set();

    this._prevKeys = new Set();

    window.addEventListener('gamepadconnected', (e) => {
      if (this.padIndex === null) {
        this.padIndex = e.gamepad.index;
        this.padName = e.gamepad.id;
      }
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.padIndex === e.gamepad.index) {
        this.padIndex = null;
        this.padName = '';
      }
    });

    window.addEventListener('keydown', (e) => {
      // evita rolagem da página com setas/espaço
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  get pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.padIndex !== null && pads[this.padIndex]) return pads[this.padIndex];
    // alguns navegadores só populam o gamepad após o primeiro input, sem disparar o evento
    for (const p of pads) {
      if (p && p.connected) {
        this.padIndex = p.index;
        this.padName = p.id;
        return p;
      }
    }
    return null;
  }

  get connected() { return this.pad !== null; }

  /** Chame uma vez por frame, antes de ler o estado. */
  update() {
    const pad = this.pad;
    const k = this.keys;

    // --- direção ---
    let steer = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) steer -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) steer += 1;

    if (pad) {
      const stick = applyDeadzone(pad.axes[0] ?? 0);
      let dpad = 0;
      if (pad.buttons[BTN.LEFT]?.pressed) dpad -= 1;
      if (pad.buttons[BTN.RIGHT]?.pressed) dpad += 1;
      const padSteer = dpad !== 0 ? dpad : stick;
      if (Math.abs(padSteer) > Math.abs(steer)) steer = padSteer;
    }
    this.steer = Math.max(-1, Math.min(1, steer));

    // --- acelerador / freio (gatilhos analógicos) ---
    let throttle = (k.has('KeyW') || k.has('ArrowUp')) ? 1 : 0;
    let brake = (k.has('KeyS') || k.has('ArrowDown')) ? 1 : 0;

    if (pad) {
      const r2 = this._triggerValue(pad, BTN.R2);
      const l2 = this._triggerValue(pad, BTN.L2);
      throttle = Math.max(throttle, r2);
      brake = Math.max(brake, l2);
      // ✕ também acelera (conforto), mas ✕ é o botão de item — só se não houver gatilho
      if (pad.buttons[BTN.UP]?.pressed) throttle = Math.max(throttle, 1);
      if (pad.buttons[BTN.DOWN]?.pressed) brake = Math.max(brake, 1);
    }
    this.throttle = throttle;
    this.brake = brake;

    // --- derrapagem (segurar) ---
    this.drift = k.has('ShiftLeft') || k.has('ShiftRight') ||
      !!(pad && (pad.buttons[BTN.L1]?.pressed || pad.buttons[BTN.R1]?.pressed));

    // --- olhar para trás (segurar) ---
    this.lookBack = k.has('KeyC') ||
      !!(pad && pad.buttons[BTN.TRIANGLE]?.pressed);

    // --- bordas de botão ---
    this._pressed.clear();
    if (pad) {
      for (let i = 0; i < pad.buttons.length; i++) {
        const down = pad.buttons[i].pressed || pad.buttons[i].value > 0.6;
        if (down && !this._prevButtons[i]) this._pressed.add(i);
        this._prevButtons[i] = down;
      }
    } else {
      this._prevButtons.length = 0;
    }

    this._justKeys = new Set([...k].filter((c) => !this._prevKeys.has(c)));
    this._prevKeys = new Set(k);
  }

  _triggerValue(pad, index) {
    const b = pad.buttons[index];
    if (!b) return 0;
    const v = b.value > 0 ? b.value : (b.pressed ? 1 : 0);
    return v < TRIGGER_FLOOR ? 0 : v;
  }

  /** Botão do controle pressionado neste frame. */
  justPressed(btn) { return this._pressed.has(btn); }

  /** Tecla pressionada neste frame (e.code). */
  justKey(code) { return this._justKeys?.has(code) ?? false; }

  /** Ação lógica pressionada neste frame (controle ou teclado). */
  justAction(name) {
    switch (name) {
      case 'item':    return this.justPressed(BTN.CROSS) || this.justKey('Space');
      case 'camera':  return this.justPressed(BTN.CIRCLE) || this.justKey('KeyV');
      case 'respawn': return this.justPressed(BTN.SQUARE) || this.justKey('KeyR');
      case 'pause':   return this.justPressed(BTN.OPTIONS) || this.justKey('Escape');
      case 'confirm': return this.justPressed(BTN.CROSS) || this.justKey('Enter') || this.justKey('Space');
      case 'left':    return this.justPressed(BTN.LEFT);
      case 'right':   return this.justPressed(BTN.RIGHT);
      default: return false;
    }
  }

  /** Vibração do DualSense (ignora silenciosamente se não suportado). */
  rumble(strong = 0.5, weak = 0.3, duration = 200) {
    const pad = this.pad;
    const act = pad?.vibrationActuator;
    if (!act?.playEffect) return;
    act.playEffect('dual-rumble', {
      startDelay: 0,
      duration,
      strongMagnitude: strong,
      weakMagnitude: weak,
    }).catch(() => {});
  }
}
