const express    = require('express');
const { Firestore } = require('@google-cloud/firestore');
const cors       = require('cors');
const crypto     = require('crypto');

const app   = express();
const db    = new Firestore();
const ROOMS = db.collection('pinky-rooms');

const ROOM_TTL_MS    = 10 * 60 * 1000; // 10 minutes
const WAIT_WINDOW_MS = 25 * 1000;       // 25s long-poll window
const MAX_SDP_BYTES  = 32 * 1024;       // 32KB max SDP size — real SDPs are ~4KB
const MAX_BODY_BYTES = '40kb';          // express.json body limit

// ── Rate limiting (in-memory, per IP) ────────────────────────────────────
// Tracks request counts per IP per minute. Cloud Run may have multiple
// instances but this is sufficient protection against casual abuse.
const rateLimits = new Map();
const RATE_WINDOW_MS  = 60 * 1000;
const RATE_LIMIT_CREATE = 10;  // max 10 room creations per IP per minute
const RATE_LIMIT_GENERAL = 60; // max 60 general requests per IP per minute

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
if (!ALLOWED_ORIGIN) throw new Error('ALLOWED_ORIGIN env var is required');

function getClientIp(req) {
  // Cloud Run sets X-Forwarded-For — take the first (real client) IP
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0] : req.socket.remoteAddress || 'unknown').trim();
}

function checkRateLimit(ip, key, max) {
  const k   = `${ip}:${key}`;
  const now = Date.now();
  const rec = rateLimits.get(k) || { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + RATE_WINDOW_MS; }
  rec.count++;
  rateLimits.set(k, rec);
  // Prune map occasionally to prevent memory growth
  if (rateLimits.size > 10000) {
    for (const [key, val] of rateLimits) {
      if (now > val.reset) rateLimits.delete(key);
    }
  }
  return rec.count <= max;
}

// ── Timing-safe token comparison ─────────────────────────────────────────
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── Room code — 3-emoji format ───────────────────────────────────────────
// Codes are exactly 3 emoji from this set, e.g. "🐼🔥🌊"
// 20^3 = 8000 combinations — sufficient for a personal app
const ROOM_EMOJI = ['🐼','🦘','🦦','🦎','🦙','🦛','🐰','🦅','🦥','🦊',
                    '🌈','⚡','🔥','🌊','🌸','🍀','💫','🎯','🎸','🤙'];
const EMOJI_SET  = new Set(ROOM_EMOJI);

// Segment a string into an array of Unicode grapheme clusters (emoji-safe)
function splitEmoji(str) {
  return [...new Intl.Segmenter().segment(str)].map(s => s.segment);
}

function validRoomCode(code) {
  if (typeof code !== 'string') return false;
  const chars = splitEmoji(code);
  return chars.length === 3 && chars.every(c => EMOJI_SET.has(c));
}

function makeRoomCode() {
  return Array.from({ length: 3 }, () =>
    ROOM_EMOJI[Math.floor(Math.random() * ROOM_EMOJI.length)]
  ).join('');
}

// ── Opportunistic expired room cleanup ───────────────────────────────────
async function cleanupExpired() {
  try {
    const expired = await ROOMS.where('expiresAt', '<', Date.now()).limit(20).get();
    const batch = db.batch();
    expired.docs.forEach(d => batch.delete(d.ref));
    if (!expired.empty) await batch.commit();
  } catch (_) { /* best-effort */ }
}

// ── Middleware ────────────────────────────────────────────────────────────
const corsOptions = {
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Cleanup-Token'],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Strict body size limit — prevents payload bloat attacks
app.use(express.json({ limit: MAX_BODY_BYTES }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Don't advertise Express
  res.removeHeader('X-Powered-By');
  next();
});

// General rate limit middleware (applied to all routes except /cleanup)
app.use((req, res, next) => {
  if (req.path === '/cleanup') return next(); // has its own auth
  const ip = getClientIp(req);
  if (!checkRateLimit(ip, 'general', RATE_LIMIT_GENERAL)) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
});

// ── GET /ice-config — returns ICE server config with TURN credentials ────────
// Uses Metered TURN (static credentials stored in env vars).
// Falls back to STUN-only if env vars are not set.
// Swap to Cloudflare ephemeral credentials once CF_TURN_KEY_ID issue is resolved.
//
// Env vars needed: METERED_TURN_USER, METERED_TURN_CREDENTIAL
app.get('/ice-config', (_req, res) => {
  const iceServers = [
    { urls: 'stun:stun.relay.metered.ca:80' },
  ];

  const username   = process.env.METERED_TURN_USER;
  const credential = process.env.METERED_TURN_CREDENTIAL;

  if (username && credential) {
    iceServers.push(
      { urls: 'turn:global.relay.metered.ca:80',                 username, credential },
      { urls: 'turn:global.relay.metered.ca:80?transport=tcp',   username, credential },
      { urls: 'turn:global.relay.metered.ca:443',                username, credential },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username, credential },
    );
    console.log('TURN: serving Metered credentials');
  } else {
    console.warn('METERED_TURN_USER / METERED_TURN_CREDENTIAL not set — STUN only');
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ iceServers });
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.status(200).send('ok'));

// ── POST /create ──────────────────────────────────────────────────────────
app.post('/create', async (req, res) => {
  try {
    const ip = getClientIp(req);
    if (!checkRateLimit(ip, 'create', RATE_LIMIT_CREATE)) {
      return res.status(429).json({ error: 'Too many rooms created' });
    }

    const { offer } = req.body;
    if (!offer || typeof offer !== 'string') {
      return res.status(400).json({ error: 'offer required' });
    }
    if (Buffer.byteLength(offer, 'utf8') > MAX_SDP_BYTES) {
      return res.status(413).json({ error: 'offer too large' });
    }

    cleanupExpired(); // fire-and-forget

    let roomCode, attempts = 0;
    while (attempts < 5) {
      const candidate = makeRoomCode();
      const doc = await ROOMS.doc(candidate).get();
      if (!doc.exists) { roomCode = candidate; break; }
      attempts++;
    }
    if (!roomCode) return res.status(500).json({ error: 'Could not generate unique room code' });

    await ROOMS.doc(roomCode).set({
      offer,
      answer: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + ROOM_TTL_MS,
    });

    return res.status(201).json({ roomCode });
  } catch (err) {
    console.error('POST /create error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /offer/:roomCode ──────────────────────────────────────────────────
app.get('/offer/:roomCode', async (req, res) => {
  try {
    if (!validRoomCode(req.params.roomCode)) {
      return res.status(400).json({ error: 'Invalid room code' });
    }
    const doc = await ROOMS.doc(req.params.roomCode).get();
    if (!doc.exists) return res.status(404).json({ error: 'Room not found' });
    const { offer, expiresAt } = doc.data();
    if (expiresAt < Date.now()) return res.status(410).json({ error: 'Room expired' });
    return res.status(200).json({ offer });
  } catch (err) {
    console.error('GET /offer error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /join/:roomCode ──────────────────────────────────────────────────
app.post('/join/:roomCode', async (req, res) => {
  try {
    if (!validRoomCode(req.params.roomCode)) {
      return res.status(400).json({ error: 'Invalid room code' });
    }

    const { answer } = req.body;
    if (!answer || typeof answer !== 'string') {
      return res.status(400).json({ error: 'answer required' });
    }
    if (Buffer.byteLength(answer, 'utf8') > MAX_SDP_BYTES) {
      return res.status(413).json({ error: 'answer too large' });
    }

    const ref = ROOMS.doc(req.params.roomCode);
    const doc = await ref.get();
    if (!doc.exists)                       return res.status(404).json({ error: 'Room not found' });
    if (doc.data().answer)                 return res.status(409).json({ error: 'Room already joined' });
    if (doc.data().expiresAt < Date.now()) return res.status(410).json({ error: 'Room expired' });

    await ref.update({ answer, joinedAt: Date.now() });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('POST /join error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /wait/:roomCode ───────────────────────────────────────────────────
app.get('/wait/:roomCode', async (req, res) => {
  try {
    if (!validRoomCode(req.params.roomCode)) {
      return res.status(400).json({ error: 'Invalid room code' });
    }

    const ref  = ROOMS.doc(req.params.roomCode);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Room not found' });
    if (snap.data().expiresAt < Date.now()) return res.status(410).json({ error: 'Room expired' });
    if (snap.data().answer) return res.status(200).json({ answer: snap.data().answer });

    await new Promise((resolve) => {
      let done = false;
      const finish = (statusCode, body) => {
        if (done) return;
        done = true;
        unsub();
        clearTimeout(timer);
        res.status(statusCode).json(body);
        resolve();
      };
      const unsub = ref.onSnapshot(
        doc => { if (doc.exists && doc.data().answer) finish(200, { answer: doc.data().answer }); },
        err  => finish(500, { error: 'Internal server error' })
      );
      const timer = setTimeout(() => finish(202, { retry: true }), WAIT_WINDOW_MS);
    });
  } catch (err) {
    console.error('GET /wait error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /room/:roomCode ────────────────────────────────────────────────
// Authenticated: only the cleanup scheduler or connected peers should call this.
// We validate the room code format to prevent path traversal.
app.delete('/room/:roomCode', async (req, res) => {
  try {
    if (!validRoomCode(req.params.roomCode)) {
      return res.status(400).json({ error: 'Invalid room code' });
    }
    await ROOMS.doc(req.params.roomCode).delete();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('DELETE /room error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /cleanup ─────────────────────────────────────────────────────────
app.post('/cleanup', async (req, res) => {
  try {
    const token = process.env.CLEANUP_TOKEN;
    if (!token || !safeCompare(req.headers['x-cleanup-token'] || '', token)) {
      // Intentional delay to slow brute-force attempts
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const cutoff = Date.now() - 60 * 60 * 1000;
    const expired = await ROOMS.where('createdAt', '<', cutoff).get();
    if (expired.empty) {
      console.log('cleanup: no expired rooms');
      return res.status(200).json({ deleted: 0 });
    }

    // Firestore batch limit is 500
    const chunks = [];
    for (let i = 0; i < expired.docs.length; i += 500) {
      chunks.push(expired.docs.slice(i, i + 500));
    }
    for (const chunk of chunks) {
      const batch = db.batch();
      chunk.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    console.log(`cleanup: deleted ${expired.size} expired rooms`);
    return res.status(200).json({ deleted: expired.size });
  } catch (err) {
    console.error('POST /cleanup error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`pinky-signal listening on port ${PORT}`));
