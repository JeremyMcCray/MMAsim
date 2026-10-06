import * as THREE from 'three';

export class HUD {
  constructor() {
    this.el = {
      hpL: document.getElementById('hpL'), hpR: document.getElementById('hpR'),
      ghostL: document.getElementById('ghostL'), ghostR: document.getElementById('ghostR'),
      stL: document.getElementById('stL'), stR: document.getElementById('stR'),
      timer: document.getElementById('timer'), round: document.getElementById('round'),
      popups: document.getElementById('popups'), flash: document.getElementById('flash'),
      overlay: document.getElementById('overlay'), debug: document.getElementById('debug'),
      nameL: document.getElementById('nameL'), nameR: document.getElementById('nameR'),
    };
    this.flashA = 0;
    this._v = new THREE.Vector3();
  }

  setNames(l, r) { this.el.nameL.textContent = l; this.el.nameR.textContent = r; }

  update(fL, fR, timeLeft, roundText) {
    this.el.hpL.style.width = fL.health + '%';
    this.el.hpR.style.width = fR.health + '%';
    this.el.ghostL.style.width = fL.health + '%';
    this.el.ghostR.style.width = fR.health + '%';
    this.el.stL.style.width = fL.stamina + '%';
    this.el.stR.style.width = fR.stamina + '%';
    const t = Math.max(0, timeLeft);
    this.el.timer.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    if (roundText) this.el.round.textContent = roundText;
    if (this.flashA > 0) {
      this.flashA = Math.max(0, this.flashA - 0.06);
      this.el.flash.style.opacity = this.flashA.toFixed(3);
    }
  }

  flash(a) { this.flashA = Math.max(this.flashA, a); this.el.flash.style.opacity = this.flashA; }

  popup(worldPos, text, cls, camera) {
    const v = this._v.copy(worldPos).project(camera);
    const x = (v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    const d = document.createElement('div');
    d.className = 'pop ' + cls;
    d.textContent = text;
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    this.el.popups.appendChild(d);
    setTimeout(() => d.remove(), 1200);
  }

  center(text, cls = 'ko') {
    const d = document.createElement('div');
    d.className = 'pop ' + cls;
    d.textContent = text;
    d.style.left = '50%'; d.style.top = '42%';
    d.style.animationDuration = '2.6s';
    this.el.popups.appendChild(d);
    setTimeout(() => d.remove(), 2700);
  }

  showOverlay(show) { this.el.overlay.classList.toggle('hidden', !show); }
  setOverlayText(h1, p1, p2) {
    this.el.overlay.querySelector('h1').textContent = h1;
    const ps = this.el.overlay.querySelectorAll('p');
    ps[0].textContent = p1; ps[1].textContent = p2;
  }
  debug(text) { this.el.debug.textContent = text; }
  toggleDebug() { this.el.debug.style.display = this.el.debug.style.display === 'block' ? 'none' : 'block'; }
}
