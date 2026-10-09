/* Bottom-left chat. Enter opens the box, Enter sends, Escape closes. */
(function (root) {
  'use strict';

  function Talk() {
    this.list = null;
    this.box = null;
    this.field = null;
    this.layer = null;
    this.floaters = [];
    this.onLine = null;
    this._v = null;
  }

  Talk.prototype.mount = function () {
    const col = document.createElement('div');
    col.id = 'talk';
    col.innerHTML = '<div class="talk-log"></div><form class="talk-box hidden"><input maxlength="80" placeholder="Press Enter to chat" autocomplete="off" spellcheck="false"></form>';
    document.body.appendChild(col);
    const layer = document.createElement('div');
    layer.id = 'talkFloat';
    document.body.appendChild(layer);
    this.list = col.querySelector('.talk-log');
    this.box = col.querySelector('form');
    this.field = col.querySelector('input');
    this.layer = layer;
    this.box.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.field.value;
      this.field.value = '';
      this.close();
      if (this.onLine) this.onLine(text);
    });
    this.field.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.field.value = '';
      this.close();
    });
  };

  Talk.prototype.isOpen = function () {
    return !!(this.box && !this.box.classList.contains('hidden'));
  };

  Talk.prototype.open = function () {
    if (!this.box) return;
    this.box.classList.remove('hidden');
    this.field.focus();
  };

  Talk.prototype.close = function () {
    if (!this.box) return;
    this.box.classList.add('hidden');
    if (document.activeElement === this.field) this.field.blur();
  };

  Talk.prototype.add = function (name, text, slot) {
    if (!this.list) return;
    const line = document.createElement('div');
    line.textContent = name + ': ' + text;
    this.list.appendChild(line);
    while (this.list.children.length > 8) this.list.removeChild(this.list.firstChild);
    if (slot == null || !this.layer) return;
    // one bubble per fighter: a new line replaces the last (which also caps what a chat flood can pile up)
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      if (this.floaters[i].slot === slot) { this.floaters[i].el.remove(); this.floaters.splice(i, 1); }
    }
    const el = document.createElement('div');
    el.className = 'talk-float';
    el.textContent = text;
    this.layer.appendChild(el);
    this.floaters.push({ el: el, slot: slot, t: 0, life: 3.6 });
  };

  Talk.prototype.tick = function (dt, project) {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const b = this.floaters[i];
      b.t += dt;
      const p = project ? project(b.slot) : null;
      if (!p || b.t >= b.life) {
        b.el.remove();
        this.floaters.splice(i, 1);
        continue;
      }
      b.el.style.left = p.x + 'px';
      b.el.style.top = (p.y - 16) + 'px';
      b.el.style.opacity = String(b.t > b.life - 0.55 ? Math.max(0, (b.life - b.t) / 0.55) : 1);
    }
  };

  root.CageTalk = { Talk: Talk };
})(typeof window !== 'undefined' ? window : globalThis);
