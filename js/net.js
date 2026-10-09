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
      this.ping = 0; this._lastPingSent = 0;
    }

    _newPeer(id) {
      const opts = { debug: 1 };
      if (root.PEER_SERVER) Object.assign(opts, root.PEER_SERVER);
      return id ? new Peer(id, opts) : new Peer(opts);
    }

    // Every handler checks that its peer / connection is still this Net's: destroy() lets go of them before tearing
    // them down, and PeerJS fires 'disconnected' / 'close' during that teardown.
    host() {
      this.role = 'host';
      this.code = makeCode();
      const peer = this.peer = this._newPeer(PREFIX + this.code);
      peer.on('open', () => { if (this.peer === peer) this.h.onReady && this.h.onReady(this.code); });
      peer.on('connection', (c) => {
        if (this.peer !== peer || (this.conn && this.conn.open)) { c.close(); return; } // one guest only
        this._bind(c);
      });
      peer.on('error', (e) => {
        if (this.peer !== peer) return;
        if (e.type === 'unavailable-id') { this.peer = null; peer.destroy(); this.host(); return; } // code taken: roll another
        this.h.onError && this.h.onError(this._errText(e));
      });
      // the signalling socket dropped: rejoin under the same code. Not for a peer being destroyed — reconnecting
      // one mid-destroy opens a fresh socket that nothing ever closes, and the room code stays taken.
      peer.on('disconnected', () => { if (this.peer === peer) { try { peer.reconnect(); } catch (_) {} } });
    }

    join(code) {
      this.role = 'guest';
      this.code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const peer = this.peer = this._newPeer();
      peer.on('open', () => {
        if (this.peer !== peer) return;
        const c = peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
        this._bind(c);
        // cleared when the connection opens or the Net is destroyed, so it can't fire for an attempt that is over
        this._joinTimer = setTimeout(() => { if (this.conn === c && !c.open) this.h.onError && this.h.onError('Could not reach room ' + this.code + '. Check the code and that the host is still waiting.'); }, 9000);
      });
      peer.on('error', (e) => { if (this.peer === peer) this.h.onError && this.h.onError(this._errText(e)); });
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
        if (this.conn !== c) { c.close(); return; } // superseded while it was still connecting
        clearTimeout(this._joinTimer); clearInterval(this._pingTimer);
        this.h.onConnect && this.h.onConnect();
        this._pingTimer = setInterval(() => { this._lastPingSent = performance.now(); this.send({ t: 'ping' }); }, 2000);
      });
      c.on('data', (d) => {
        if (this.conn !== c || !d || typeof d !== 'object') return;
        if (d.t === 'ping') { this.send({ t: 'pong' }); return; }
        if (d.t === 'pong') { this.ping = Math.round(performance.now() - this._lastPingSent); return; }
        this.h.onData && this.h.onData(d);
      });
      // only a close we didn't start: leaving yourself is not "the opponent left"
      c.on('close', () => { if (this.conn !== c) return; clearInterval(this._pingTimer); this.h.onClose && this.h.onClose(); });
      c.on('error', (e) => { if (this.conn === c) this.h.onError && this.h.onError('Connection error: ' + (e.message || e)); });
    }

    send(obj) { if (this.conn && this.conn.open) { try { this.conn.send(obj); } catch (_) {} } }
    get connected() { return !!(this.conn && this.conn.open); }

    destroy() {
      clearInterval(this._pingTimer); clearTimeout(this._joinTimer);
      // let go first: the 'close' / 'disconnected' events the teardown fires then no longer count as ours
      const conn = this.conn, peer = this.peer;
      this.conn = null; this.peer = null; this.role = null;
      try { conn && conn.close(); } catch (_) {}
      try { peer && peer.destroy(); } catch (_) {}
    }
  }

  root.MMANet = { Net, makeCode };
})(typeof window !== 'undefined' ? window : globalThis);
