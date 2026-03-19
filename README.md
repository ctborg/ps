# 🤙 Pinky Swear

> *Legally unenforceable. Cosmically binding.*

A peer-to-peer video app for making promises that actually mean something. When both parties raise their pinky fingers at the same time, the app detects it and seals the oath — with confetti, a polaroid snapshot, and the full weight of internet law.

**[Live demo → ctborg.github.io/ps](https://ctborg.github.io/ps/)**

---

## What it does

Two people connect over a direct video call. Each raises their pinky. The moment both pinkies are detected simultaneously, the swear is sealed:

- 🎉 Confetti fires
- 📸 A polaroid-style photo is captured and beautified
- 🤙 Both parties receive the same photo — burnt-in date stamp and all
- 🔒 The connection closes. The promise is made.

No accounts. No servers storing your video. The call is peer-to-peer and gone the moment you close the tab.

---

## How it works

### Frontend (`index.html`)

A single self-contained HTML file. No build step, no dependencies to install.

**Pinky detection** uses [MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) with a single shared WASM instance (dual instances crash due to shared WASM globals). Rather than splitting a composite frame or alternating on a timer, detection uses **motion-triggered attention switching**: each frame, a 32×24 pixel thumbnail diff scores both video streams, and MediaPipe inference runs on whichever stream has more motion. A starvation guard forces a check on the idle stream every ~330ms so a perfectly still raised pinky is never missed.

**WebRTC** handles the video call. The signaling server exchanges SDP offers/answers via Cloud Run; ICE uses STUN with optional TURN (via [Metered](https://www.metered.ca/)) for cross-network connections.

**Photo pipeline:**
1. Frames are frozen the instant the swear fires
2. A WebGL bilateral filter pipeline runs — skin smoothing, warmth, brightness lift, saturation boost, and a soft glow — before the image is drawn into the polaroid
3. Both polaroids are composited onto a dark background with rotated card animations
4. The initiating party sends the full composite to their partner over the DataChannel, so both sides receive an identical image

**Swear trigger sync** — whoever detects the swear first sends a `swear_trigger` DataChannel message to the other party, forcing their banner and photo even if their local pinky detection is a frame behind. This prevents one side getting a photo and the other getting nothing.

### Backend (`pinky-signal/`)

A minimal [Express](https://expressjs.com/) + [Firestore](https://firebase.google.com/docs/firestore) signaling server deployed on [Google Cloud Run](https://cloud.google.com/run). It only brokers the initial WebRTC handshake — no video ever touches it.

| Endpoint | Purpose |
|---|---|
| `GET /` | Health check (Cloud Run startup probe) |
| `GET /ice-config` | Return ICE server config with TURN credentials |
| `POST /create` | Store SDP offer, return emoji room code |
| `GET /offer/:code` | Retrieve offer SDP for a room |
| `POST /join/:code` | Store answer SDP |
| `GET /wait/:code` | Long-poll for answer (25s window, client retries on 202) |
| `DELETE /room/:code` | Delete room after connection is established |
| `POST /cleanup` | Delete all rooms older than 1 hour (requires `X-Cleanup-Token` header) |

Room codes are 3-emoji sequences from a fixed palette of 20 emoji (e.g. `🐼🔥🌊`) — 8,000 combinations. Rooms expire after 10 minutes. Expired rooms are also cleaned up opportunistically on each `/create` call (up to 20 at a time), and in bulk via the authenticated `/cleanup` endpoint which can be triggered by a Cloud Scheduler job.

The `/wait` endpoint holds the HTTP connection open with a Firestore `onSnapshot` listener, resolving immediately when the answer SDP appears. This avoids polling loops entirely — the initiator is notified the instant the joiner posts their answer. The 25s window stays safely under Cloud Run's 60s request timeout; the client retries immediately on a 202 response.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS — no framework, no build |
| Hand detection | [MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) via [jsDelivr CDN](https://www.jsdelivr.com/package/npm/@mediapipe/hands) |
| Image processing | WebGL (bilateral filter, composite) + Canvas 2D |
| Video call | [WebRTC](https://webrtc.org/) (RTCPeerConnection + DataChannel) |
| Signaling | [Express](https://expressjs.com/) on [Google Cloud Run](https://cloud.google.com/run) |
| Storage | [Firestore](https://firebase.google.com/docs/firestore) (Native Mode) |
| Hosting | [GitHub Pages](https://pages.github.com/) |
| TURN | [Metered TURN](https://www.metered.ca/tools/openrelay/) |
| Fonts | [Abril Fatface](https://fonts.google.com/specimen/Abril+Fatface) + [DM Mono](https://fonts.google.com/specimen/DM+Mono) via [Google Fonts](https://fonts.google.com/) |

---

## Running locally

### Frontend

Just open `index.html` in a browser. For camera access you'll need HTTPS or `localhost` — use:

```bash
npx serve .
```

Point `SIGNAL_URL` in `index.html` to your local or deployed backend.

### Backend

```bash
cd pinky-signal
npm install
node index.js
```

Env vars:

```
ALLOWED_ORIGIN=https://your-frontend-url   # required — CORS allowed origin
METERED_TURN_USER=...                       # Metered TURN username
METERED_TURN_CREDENTIAL=...                 # Metered TURN credential
CLEANUP_TOKEN=...                           # Secret token for POST /cleanup
PORT=8080                                   # Optional, defaults to 8080
```

**Never commit credentials.** Set them via:

```bash
gcloud run services update pinky-signal \
  --set-env-vars ALLOWED_ORIGIN=https://your-frontend-url,METERED_TURN_USER=...,METERED_TURN_CREDENTIAL=...,CLEANUP_TOKEN=...
```

### Deploying to Cloud Run

```bash
gcloud run deploy pinky-signal \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --service-account pinky-signal-sa@YOUR_PROJECT.iam.gserviceaccount.com
```

---

## Firestore rules

Rooms are readable and creatable by anyone (required for signaling), but writes are constrained:

- **Create** — must include `offer`, `createdAt`, `expiresAt`; `answer` must be null
- **Update** — only `answer` and `joinedAt` fields; cannot overwrite an existing answer
- **Delete** — denied to clients; handled server-side only via the service account

Deploy with:

```bash
firebase deploy --only firestore:rules
```

---

## Architecture notes

**Why one MediaPipe instance?** MediaPipe Hands uses shared WASM global state. Two simultaneous instances on the same page collide and produce incorrect results. All hand detection runs through a single `Hands` instance that alternates attention between the local and remote video streams.

**Why motion-triggered switching?** A fixed 1-second timer wastes inference cycles on still frames. A pixel diff on a 32×24 thumbnail (~768 pixels) costs almost nothing and naturally focuses attention on whoever is actively raising their hand.

**Why freeze frames before teardown?** The WebRTC connection closes the moment the swear fires — before the photo modal opens. Frames are captured to offscreen canvases first, then the connection closes, then the beautify filter runs, then the polaroids render. This means the photo is always a clean still, never a live-video race condition.

**Why send the composite instead of raw frames?** Earlier versions sent each party's local frame to the other, resulting in each side rendering a different composite (different frozen frames, different timestamps). Now the first-firing party renders the full composite and sends it over the DataChannel as a JPEG. Both parties see the identical image.

**Why long-poll instead of polling?** The `/wait` endpoint attaches a Firestore `onSnapshot` listener and holds the HTTP connection open. The initiator is notified in real time the instant the joiner posts their SDP answer — no repeated requests, no delay.

---

## Security

- Per-IP rate limiting — 10 room creations/minute, 60 general requests/minute
- 32KB cap on SDP payloads (real SDPs are ~4KB; this blocks payload bloat attacks)
- Emoji room code validation on all endpoints — prevents path traversal
- 40KB Express body limit
- `POST /cleanup` requires `X-Cleanup-Token` header with timing-safe comparison; wrong token incurs a 500ms delay to slow brute-force
- CORS locked to `https://ctborg.github.io`
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Powered-By` removed
- Firestore `delete: if false` — rooms can only be deleted server-side via the service account
- Firestore update rules prevent overwriting an existing answer (no session hijacking)
- Dedicated service account with `roles/datastore.user` only — no broader GCP access
- `/ice-config` response served with `Cache-Control: private, no-store`

---

## License

MIT
