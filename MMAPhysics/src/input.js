// Keyboard + mouse input for the player fighter.
export class Input {
  constructor(el) {
    this.keys = new Set();
    this.pressed = [];      // one-shot key presses since last poll
    this.punchAlt = 0;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      this.pressed.push(k);
      if ([' ', 'shift'].includes(k)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.pressed.push(this.punchAlt++ % 2 === 0 ? 'j' : 'k'); }
      if (e.button === 2) { this.pressed.push(this.punchAlt % 2 === 0 ? 'n' : 'm'); }
    });
  }

  // Drive a fighter from current input state.
  apply(fighter) {
    const k = this.keys;
    let x = 0, z = 0;
    if (k.has('w') || k.has('arrowup')) z += 1;
    if (k.has('s') || k.has('arrowdown')) z -= 1;
    if (k.has('a') || k.has('arrowleft')) x -= 1;
    if (k.has('d') || k.has('arrowright')) x += 1;
    fighter.setMove(x, z);
    fighter.setGuard(k.has(' '));

    const map = { j: 'jab', k: 'cross', u: 'lhook', i: 'rhook', n: 'lkick', m: 'rkick' };
    for (const p of this.pressed) {
      if (map[p]) fighter.startStrike(map[p]);
      else if (p === 'shift') fighter.dash(x, z);
    }
    const restart = this.pressed.includes('r');
    const debug = this.pressed.includes('f3');
    this.pressed.length = 0;
    return { restart, debug };
  }
}
