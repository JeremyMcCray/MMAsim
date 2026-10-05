/* PeerJS wrapper: host-authoritative rooms. The host runs the simulation,
   the guest sends inputs and receives state snapshots. */
(function (root) {
  'use strict';
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const PREFIX = 'cagerules-v1-';

  function makeCode() { let s = ''; for (let i = 0; i < 5; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)]; return s; }

  class Net {
    constructor(h) {
      this.h = h || {};
      this.peer = null; this.conn = null; this.role = null; this.code = null;
      this.ping = 0; this._pingT = 0; this._lastPingSent = 0;
    }

    _newPeer(id) {
      const opts = { debug: 1 };
      if (root.PEER_SERVER) Object.assign(opts, root.PEER_SERVER);
      return id ? new Peer(id, opts) : new Peer(opts);
    }

    host() {
      this.role = 'host';
      this.code = makeCode();
      this.peer = this._newPeer(PREFIX + this.code);
      this.peer.on('open', () => this.h.onReady && this.h.onReady(this.code));
      this.peer.on('connection', (c) => {
        if (this.conn && this.conn.open) { c.close(); return; } // one guest only
        this._bind(c);
      });
      this.peer.on('error', (e) => {
        if (e.type === 'unavailable-id') { this.code = makeCode(); this.peer.destroy(); this.host(); return; }
        this.h.onError && this.h.onError(this._errText(e));
      });
      this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch (_) {} });
    }

    join(code) {
      this.role = 'guest';
      this.code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      this.peer = this._newPeer();
      this.peer.on('open', () => {
        const c = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
        this._bind(c);
        setTimeout(() => { if (!c.open) this.h.onError && this.h.onError('Could not reach room ' + this.code + '. Check the code and that the host is still waiting.'); }, 9000);
      });
      this.peer.on('error', (e) => this.h.onError && this.h.onError(this._errText(e)));
    }

    _errText(e) {
      switch (e.type) {
        case 'peer-unavailable': return 'No room with that code is open right now.';
        case 'network': return 'Lost connection to the matchmaking server (0.peerjs.com). Check your internet and try again.';
        case 'server-error': case 'socket-error': case 'socket-closed': return 'Matchmaking server unavailable. Try again in a moment.';
        case 'browser-incompatible': return 'This browser does not support WebRTC.';
        default: return 'Connection error: ' + (e.message || e.type || e);
      }
    }

    _bind(c) {
      this.conn = c;
      c.on('open', () => {
        this.h.onConnect && this.h.onConnect();
        this._pingTimer = setInterval(() => { this._lastPingSent = performance.now(); this.send({ t: 'ping' }); }, 2000);
      });
      c.on('data', (d) => {
        if (!d || typeof d !== 'object') return;
        if (d.t === 'ping') { this.send({ t: 'pong' }); return; }
        if (d.t === 'pong') { this.ping = Math.round(performance.now() - this._lastPingSent); return; }
        this.h.onData && this.h.onData(d);
      });
      c.on('close', () => { clearInterval(this._pingTimer); this.h.onClose && this.h.onClose(); });
      c.on('error', (e) => this.h.onError && this.h.onError('Connection error: ' + (e.message || e)));
    }

    send(obj) { if (this.conn && this.conn.open) { try { this.conn.send(obj); } catch (_) {} } }
    get connected() { return !!(this.conn && this.conn.open); }

    destroy() {
      clearInterval(this._pingTimer);
      try { this.conn && this.conn.close(); } catch (_) {}
      try { this.peer && this.peer.destroy(); } catch (_) {}
      this.conn = null; this.peer = null; this.role = null;
    }
  }

  root.MMANet = { Net, makeCode };
})(typeof window !== 'undefined' ? window : globalThis);
