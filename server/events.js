'use strict';

/**
 * Bus d'evenements temps reel (Server-Sent Events).
 * Alimente la galerie de la WebApp de vote et l'ecran de classement.
 */
class EventHub {
  constructor() {
    this.clients = new Set();
    this.lastId = 0;
    this.heartbeat = setInterval(() => this.ping(), 25000);
    this.heartbeat.unref?.();
  }

  subscribe(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  emit(type, data = {}) {
    this.lastId += 1;
    const frame = `id: ${this.lastId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  ping() {
    for (const res of this.clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        this.clients.delete(res);
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* client deja parti */
      }
    }
    this.clients.clear();
  }
}

module.exports = { EventHub };
