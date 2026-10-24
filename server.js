// NP Caro - máy chủ không cần cài thêm thư viện nào (chỉ dùng Node.js >= 18)
const http = require('http');
const fs = require('fs');
const path = require('path');
const AVN = 35;
const MOVE_MS = Number(process.env.MOVE_MS) || 60000;
const avOf = (v, d) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < AVN && v !== '' && v != null) ? Number(v) : d;
const rooms = new Map();
const players = new Map(); // fid -> {fid,pid,name,av,friends:Set,res,inbox:[],pending:Set}
const FID = /^[A-Z0-9]{6}$/;
const cleanFriends = (arr, self) => { const s = new Set(); for (const f of arr) { const u = String(f).toUpperCase(); if (FID.test(u) && u !== self && s.size < 100) s.add(u); } return s; };
const send = (p, o) => { if (p && p.res) p.res.write('data: ' + JSON.stringify(o) + '\n\n'); };
const isMutual = (a, b) => a && b && a.friends.has(b.fid) && b.friends.has(a.fid);
function pushFriends(p) {
  if (!p || !p.res) return;
  const list = [...p.friends].map((f) => { const q = players.get(f); const on = !!(q && q.res && q.friends.has(p.fid)); return { fid: f, online: on, name: on ? q.name : '', av: on ? q.av : 0 }; });
  send(p, { type: 'friends', list });
}
function notifyFriends(p) { for (const f of p.friends) { const q = players.get(f); if (q) pushFriends(q); } }
function armTimer(room) {
  clearTimeout(room.t);
  if (room.winner || !room.o) { room.deadline = 0; return; }
  room.deadline = Date.now() + MOVE_MS;
  room.t = setTimeout(() => {
    if (room.winner) return;
    room.winner = room.turn === 'X' ? 'O' : 'X';
    room.reason = 'time'; room.deadline = 0;
    broadcast(room);
  }, MOVE_MS);
}
const INDEX = path.join(__dirname, 'index.html');

const empty = () => new Map();
function newCode() {
  for (let t = 0; t < 200; t++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return null;
}
function check(cells, r, c, ch) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const l = [[r, c]];
    for (const s of [1, -1]) {
      let rr = r + dr * s, cc = c + dc * s;
      while (cells.get(rr + ',' + cc) === ch) { l.push([rr, cc]); rr += dr * s; cc += dc * s; }
    }
    if (l.length >= 5) return l;
  }
  return null;
}
function view(room, pid) {
  return {
    cells: room.moves, turn: room.turn, winner: room.winner, line: room.line, last: room.last,
    xn: room.x.name, on: room.o ? room.o.name : '', hasO: !!room.o,
    left: room.deadline ? Math.max(0, room.deadline - Date.now()) : 0, reason: room.reason || '',
    xa: room.x.av, oa: room.o ? room.o.av : 1,
    you: room.x.id === pid ? 'X' : (room.o && room.o.id === pid ? 'O' : '')
  };
}
function broadcast(room) {
  room.updated = Date.now();
  for (const cl of room.clients) cl.res.write('data: ' + JSON.stringify(view(room, cl.pid)) + '\n\n');
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 5000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const clean = (s) => String(s || 'Người chơi').replace(/[<>]/g, '').trim().slice(0, 14) || 'Người chơi';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(INDEX, (e, d) => {
      if (e) { res.writeHead(500); return res.end('Thiếu index.html'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const fid = (url.searchParams.get('fid') || '').toUpperCase(), pid = url.searchParams.get('pid') || '';
    if (!FID.test(fid) || !pid) { res.writeHead(400); return res.end(); }
    let p = players.get(fid);
    if (p && p.pid !== pid && p.res) { res.writeHead(409); return res.end(); }
    if (!p || p.pid !== pid) { p = { fid, pid, inbox: [], pending: new Set(), friends: new Set(), res: null }; players.set(fid, p); }
    if (p.res) { try { p.res.end(); } catch (e) {} }
    p.name = clean(url.searchParams.get('name')); p.av = avOf(url.searchParams.get('av'), 0);
    p.friends = cleanFriends((url.searchParams.get('friends') || '').split(','), fid);
    p.seen = Date.now();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    p.res = res;
    send(p, { type: 'hello' });
    while (p.inbox.length) send(p, p.inbox.shift());
    pushFriends(p); notifyFriends(p);
    const ka = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); p.seen = Date.now(); if (p.res === res) { p.res = null; notifyFriends(p); } });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const room = rooms.get(url.searchParams.get('code'));
    const pid = url.searchParams.get('pid') || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (!room) { res.write('event: gone\ndata: {}\n\n'); return res.end(); }
    const cl = { res, pid };
    room.clients.add(cl);
    res.write('data: ' + JSON.stringify(view(room, pid)) + '\n\n');
    const ka = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); room.clients.delete(cl); });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const b = await readBody(req);
    const pid = String(b.pid || '').slice(0, 40);
    if (!pid) return json(res, 400, { error: 'Thiếu mã người chơi' });
    if (['/api/sync', '/api/friend/request', '/api/friend/accept', '/api/invite'].includes(url.pathname)) {
      const p = players.get(String(b.fid || '').toUpperCase());
      if (!p || p.pid !== pid) return json(res, 403, { error: 'Chưa kết nối, hãy tải lại trang' });
      if (url.pathname === '/api/sync') {
        p.name = clean(b.name); p.av = avOf(b.av, p.av);
        if (Array.isArray(b.friends)) p.friends = cleanFriends(b.friends, p.fid);
        pushFriends(p); notifyFriends(p);
        return json(res, 200, { ok: true });
      }
      const to = players.get(String(b.to || '').toUpperCase());
      if (url.pathname === '/api/friend/request') {
        if (!to || to === p || !to.res) return json(res, 404, { error: 'Bạn đó chưa online hoặc mã bị sai 🤔' });
        if (isMutual(p, to)) return json(res, 409, { error: 'Hai bạn đã là bạn bè rồi!' });
        to.pending.add(p.fid);
        send(to, { type: 'request', fid: p.fid, name: p.name, av: p.av });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/friend/accept') {
        if (!to || !p.pending.has(to.fid)) return json(res, 404, { error: 'Lời mời đã hết hạn' });
        p.pending.delete(to.fid); p.friends.add(to.fid); to.friends.add(p.fid);
        const note = { type: 'added', fid: p.fid, name: p.name, av: p.av };
        if (to.res) send(to, note); else to.inbox.push(note);
        pushFriends(p); pushFriends(to);
        return json(res, 200, { ok: true });
      }
      if (!to || !isMutual(p, to) || !to.res) return json(res, 404, { error: 'Bạn đó đang offline' });
      if (!/^\d{4}$/.test(String(b.code))) return json(res, 400, { error: 'Mã phòng sai' });
      send(to, { type: 'invite', fid: p.fid, name: p.name, av: p.av, code: String(b.code) });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/create') {
      const code = newCode();
      if (!code) return json(res, 503, { error: 'Máy chủ đang đầy, thử lại sau nhé' });
      rooms.set(code, { cells: empty(), moves: [], turn: 'X', x: { id: pid, name: clean(b.name), av: avOf(b.av, 0) }, o: null, winner: '', reason: '', deadline: 0, t: null, line: [], last: null, clients: new Set(), updated: Date.now() });
      return json(res, 200, { code });
    }
    const room = rooms.get(String(b.code));
    if (!room) return json(res, 404, { error: 'Không thấy phòng ' + (b.code || '') + ' 🤔' });
    if (url.pathname === '/api/join') {
      if (room.x.id !== pid && !(room.o && room.o.id === pid)) {
        if (room.o) return json(res, 409, { error: 'Phòng này đủ 2 người rồi.' });
        let a = avOf(b.av, 1);
        if (a === room.x.av) a = (a + 1) % AVN;
        room.o = { id: pid, name: clean(b.name), av: a };
        armTimer(room);
        broadcast(room);
      }
      return json(res, 200, { ok: true });
    }
    const mark = room.x.id === pid ? 'X' : (room.o && room.o.id === pid ? 'O' : '');
    if (!mark) return json(res, 403, { error: 'Bạn không ở trong phòng này' });
    if (url.pathname === '/api/chat') {
      const now = Date.now();
      room.lc = room.lc || {};
      if (now - (room.lc[pid] || 0) < 600) return json(res, 429, { error: 'Từ từ thôi nè 😄' });
      room.lc[pid] = now;
      const st = String(b.st || '').replace(/[<>]/g, '').slice(0, 12);
      const text = st ? '' : String(b.text || '').replace(/[<>]/g, '').trim().slice(0, 100);
      if (!st && !text) return json(res, 400, { error: 'Tin nhắn trống' });
      const msg = JSON.stringify({ m: mark, name: (mark === 'X' ? room.x : room.o).name, text, st });
      for (const cl of room.clients) cl.res.write('event: chat\ndata: ' + msg + '\n\n');
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/move') {
      const r = Number(b.r), c = Number(b.c), k = r + ',' + c;
      if (!room.o || room.winner || room.turn !== mark || !Number.isInteger(r) || !Number.isInteger(c) || Math.abs(r) > 100000 || Math.abs(c) > 100000 || room.cells.has(k)) return json(res, 400, { error: 'Nước đi không hợp lệ' });
      room.cells.set(k, mark); room.moves.push([r, c, mark]); room.last = [r, c];
      const l = check(room.cells, r, c, mark);
      if (l) { room.winner = mark; room.line = l; } else room.turn = mark === 'X' ? 'O' : 'X';
      armTimer(room);
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/throw') {
      const kind = String(b.kind);
      if (!room.o || !['stone', 'egg', 'flower'].includes(kind)) return json(res, 400, { error: 'Chưa có đối thủ để ném 😅' });
      const now = Date.now(); room.lt = room.lt || {};
      if (now - (room.lt[pid] || 0) < 800) return json(res, 429, { error: 'Từ từ thôi nè 😄' });
      room.lt[pid] = now;
      const msg = JSON.stringify({ m: mark, name: (mark === 'X' ? room.x : room.o).name, kind });
      for (const cl of room.clients) cl.res.write('event: throw\ndata: ' + msg + '\n\n');
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/again') {
      if (room.winner && room.o) {
        [room.x, room.o] = [room.o, room.x];
        Object.assign(room, { cells: empty(), moves: [], turn: 'X', winner: '', reason: '', line: [], last: null });
        armTimer(room);
        broadcast(room);
      }
      return json(res, 200, { ok: true });
    }
  }
  res.writeHead(404); res.end('Not found');
});

setInterval(() => {
  const old = Date.now() - 3 * 3600 * 1000;
  for (const [c, r] of rooms) if (r.updated < old && r.clients.size === 0) { clearTimeout(r.t); rooms.delete(c); }
  for (const [f, p] of players) if (!p.res && (p.seen || 0) < Date.now() - 12 * 3600 * 1000) players.delete(f);
}, 600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('NP Caro chạy tại cổng ' + PORT));
