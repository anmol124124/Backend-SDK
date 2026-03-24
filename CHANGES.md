# Changes & Fixes Log

## Production Deployment Notes for Claude Code

This file documents all changes made during the debugging session so production
can apply the same fixes.

---

## 1. Bug Fix — Intermittent knock/approval request not reaching host

**Files changed:**
- `app/modules/meeting/websocket.py`
- `app/modules/meeting/connection_manager.py`

### Root cause
When the host's WebSocket was in a CLOSING state (not yet fully disconnected),
`send_personal()` silently failed with:
`"Cannot call 'send' once a close message has been sent."`

The host was still registered in `_rooms` so `is_connected()` returned `True`,
but the send failed silently — the guest waited 120 seconds then timed out.

### Fix 1 — `connection_manager.py`: `send_personal` now returns `bool`
```python
# Before
async def send_personal(...) -> None:

# After
async def send_personal(...) -> bool:
    # returns True on success, False on miss or exception
```

### Fix 2 — `websocket.py`: Check knock-request delivery result
If `send_personal` fails when sending `knock-request` to the host, a clear
warning is logged. The guest remains in the pending queue and will receive the
knock-request when the host reconnects (existing re-send logic at line ~544).

```python
sent = await manager.send_personal(room_id, host_id, { "type": "knock-request", ... })
if not sent:
    logger.warning("knock-request delivery FAILED (host WS dead) — will retry on host reconnect ...")
```

### Fix 3 — `websocket.py`: RuntimeError in receive loop
Starlette raises `RuntimeError` (not `WebSocketDisconnect`) when a client
disconnects abruptly in some cases. This was causing "Unexpected error" log
spam and going through the wrong code path.

```python
# Before
except WebSocketDisconnect:
    break

# After
except (WebSocketDisconnect, RuntimeError):
    break
```

---

## 2. Bug Fix — mediasoup DNS resolution failure

**File changed:** `backend/.env`

### Root cause
`MEDIASOUP_URL=http://mediasoup:3000` — the hostname `mediasoup` is a
docker-compose service name alias that only works when containers are started
via `docker-compose up`. When containers are started individually with
`docker run`, only the container name is registered in Docker DNS.

### Fix
```env
# Before
MEDIASOUP_URL=http://mediasoup:3000

# After
MEDIASOUP_URL=http://webrtc_mediasoup:3000
```

**Production note:** On the production server (`srv1120434`) the containers are
started via systemd/docker-compose so `mediasoup` resolves correctly. This fix
only matters for local docker-run setups. Verify by running:
```bash
docker exec webrtc_backend python3 -c "import socket; print(socket.gethostbyname('mediasoup'))"
```
If it resolves → keep `mediasoup`. If it fails → use `webrtc_mediasoup`.

---

## 3. Comprehensive Logging Added (commit: af5d5aa)

Logging was added across all services to trace the approval flow end-to-end.

### `app/modules/meeting/websocket.py`
- WS connect attempt logs: room, user, token_type, is_guest, is_reconnect,
  require_approval, host_in_room, room_size
- Knock flow: pending add, knock-waiting sent/failed, knock-request
  sent/deferred, waiting for approval, timeout, denied, approved
- Host joins: re-sending pending knock-requests
- Knock action received: action, sender, can_admit, pending_exists
- Knock resolved: approved/denied + by whom

### `app/modules/meeting/connection_manager.py`
- `add_pending`: logs total_pending
- `resolve_pending`: logs resolved, or CRITICAL warning on MISS (host approved
  after guest timed out)
- `send_personal`: MISS warning includes list of actual room_users for debugging

### `app/core/mediasoup_client.py`
- Every SFU call logs before + after: ensure_room, create_transport,
  connect_transport, produce, consume, resume_consumer, get_producers,
  remove_peer

### `app/modules/auth/service.py`
- signup: attempt, OK, rejected (duplicate email)
- login: attempt, OK, failed (with reason: user not found vs wrong password)

### `app/modules/public_meeting/service.py`
- create_meeting: room created log
- get_host_token: token issued log
- get_guest_token: request, issued, rejected logs

### `public/js/app.js` (frontend)
- `_sendWS`: logs every outgoing WS message type + state, or DROPPED with state
  code if WS not open
- `_knockAction`: logs action + guestId before sending
- WS lifecycle: onopen, onclose (with code+reason), onerror
- knock-waiting received, knock-request received
- All SFU message cases: transportId, producerId, consumerId, kind, count

### `mediasoup-server/src/api.js`
- All 8 routes log entry + result + FAIL warnings

### `mediasoup-server/src/peer.js`
- addTransport, addProducer, addConsumer: IDs + totals
- close: peer ID + counts of open transports/producers/consumers

### `mediasoup-server/src/room.js`
- getOrCreatePeer: new peer creation + total_peers count

### `mediasoup-server/src/roomManager.js`
- getOrCreate: HIT / IN-FLIGHT / NEW / created / FAILED

---

## 4. Local Dev — nginx dev config for ngrok testing

**File added:** `nginx/nginx.dev.conf`

Single HTTP nginx config (no SSL) that exposes everything through one port (80)
for ngrok tunneling. Routes:
- `/api/` → `backend:8000`
- `/ws/` → `backend:8000` (WebSocket, no read timeout)
- `/health`, `/public/`, `/meet/` → `backend:8000`
- `/` → `public-meet:80`

To use:
```bash
# Start nginx with dev config
docker run -d \
  --name webrtc_nginx \
  --network webrtc_webrtc_net \
  -v $(pwd)/nginx/nginx.dev.conf:/etc/nginx/nginx.conf:ro \
  -p 80:80 \
  nginx:1.27-alpine

# Tunnel through ngrok (single URL for everything)
ngrok http --url=<your-static-ngrok-url> 80
```

Containers must be on `webrtc_webrtc_net` with correct network aliases:
- `webrtc_backend` must have alias `backend`
- `webrtc_public_meet` must have alias `public-meet`

```bash
docker run -d --name webrtc_backend --network webrtc_webrtc_net \
  --network-alias backend --env-file ./backend/.env -p 8000:8000 webrtc_backend:latest

docker run -d --name webrtc_public_meet --network webrtc_webrtc_net \
  --network-alias public-meet --env-file ./public-meet/.env -p 3002:80 webrtc_public-meet
```
