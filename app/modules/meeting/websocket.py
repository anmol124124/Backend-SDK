"""
WebRTC Signaling + SFU coordination — WebSocket endpoint.

Connection URL:
    ws://localhost:8000/ws/meetings/{meeting_id}?token=<JWT>

══════════════════════════════════════════════════════════════════════════════
 Message flow (Client ↔ FastAPI ↔ mediasoup)
══════════════════════════════════════════════════════════════════════════════

 1. Client connects → FastAPI validates JWT + participant membership
 2. FastAPI calls   → mediasoup: ensure_room  (creates Router if needed)
 3. FastAPI sends   → client: { type:"sfu:rtpCapabilities", payload:{...} }
 4. FastAPI sends   → client: { type:"user-list", payload:{users:[...]} }
 5. FastAPI broadcasts → others: { type:"join", from: userId }

 --- Transport negotiation (repeated for send AND recv direction) ---
 6. Client sends    → { type:"sfu:createTransport", payload:{ direction:"send" } }
 7. FastAPI calls   → mediasoup: create_transport
 8. FastAPI replies → { type:"sfu:transportCreated", payload:{ transportId, ice, dtls, ... } }

 9. Client sends    → { type:"sfu:connectTransport", payload:{ transportId, dtlsParameters } }
10. FastAPI calls   → mediasoup: connect_transport
11. FastAPI replies → { type:"sfu:transportConnected", payload:{ transportId } }

 --- Producing (sending media) ---
12. Client sends    → { type:"sfu:produce", payload:{ transportId, kind, rtpParameters } }
13. FastAPI calls   → mediasoup: produce
14. FastAPI replies → { type:"sfu:produced", payload:{ producerId } }
15. FastAPI broadcasts → others: { type:"sfu:newProducer", payload:{ producerId, peerId, kind } }

 --- Consuming (receiving media) ---
16. Client sends    → { type:"sfu:consume", payload:{ producerId, transportId, rtpCapabilities } }
17. FastAPI calls   → mediasoup: consume
18. FastAPI replies → { type:"sfu:consumed", payload:{ consumerId, producerId, kind, rtpParameters } }

19. Client sends    → { type:"sfu:resumeConsumer", payload:{ consumerId } }
20. FastAPI calls   → mediasoup: resume_consumer
21. FastAPI replies → { type:"sfu:consumerResumed", payload:{ consumerId } }

 --- Discovery (existing producers when joining mid-meeting) ---
22. Client sends    → { type:"sfu:getProducers" }
23. FastAPI calls   → mediasoup: get_producers
24. FastAPI replies → { type:"sfu:producers", payload:{ producers:[...] } }

 --- Disconnect ---
25. Client disconnects (or sends "leave")
26. FastAPI calls   → mediasoup: remove_peer (cleanup transports/producers/consumers)
27. FastAPI broadcasts → others: { type:"leave", from: userId }

══════════════════════════════════════════════════════════════════════════════
 Client → Server message format
══════════════════════════════════════════════════════════════════════════════
{
  "type":    "offer" | "answer" | "ice-candidate" | "leave"
           | "sfu:createTransport" | "sfu:connectTransport"
           | "sfu:produce"         | "sfu:consume"
           | "sfu:resumeConsumer"  | "sfu:getProducers",
  "to":      "<target_user_id>",   // peer-to-peer only; omit for broadcast/server
  "payload": { ... }
}

══════════════════════════════════════════════════════════════════════════════
 Server → Client message format
══════════════════════════════════════════════════════════════════════════════
{
  "type":    "user-list" | "join" | "leave" | "error"
           | "offer" | "answer" | "ice-candidate"
           | "sfu:rtpCapabilities" | "sfu:transportCreated"
           | "sfu:transportConnected" | "sfu:produced"
           | "sfu:newProducer" | "sfu:consumed"
           | "sfu:consumerResumed" | "sfu:producers",
  "from":    "<user_id>" | "server",
  "payload": { ... }
}
"""


import asyncio
import json
import logging
import uuid

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError
from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.core.mediasoup_client import sfu
from app.core.rsa_tokens import decode_public_token
from app.core.security import decode_token
from app.modules.auth.models import User
from app.modules.meeting.connection_manager import manager
from app.modules.meeting.models import Meeting, Participant
from app.modules.project.embed_check import check_embed_domain
from app.modules.public_meeting.models import PublicMeeting

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Signaling"])

# ── Accepted client message types ─────────────────────────────────────────────

_P2P_TYPES = {"offer", "answer", "ice-candidate"}   # relayed peer-to-peer
_SFU_TYPES = {                                       # handled by mediasoup
    "sfu:createTransport",
    "sfu:connectTransport",
    "sfu:produce",
    "sfu:consume",
    "sfu:resumeConsumer",
    "sfu:getProducers",
}
_CTRL_TYPES  = {"leave", "knock-approve", "knock-deny", "kick", "transfer-host", "end-meeting"}


def _get_token_type(token: str) -> str | None:
    """Return token type: 'public_host', 'public_guest', 'access', or None."""
    try:
        return decode_public_token(token).get("type")
    except JWTError:
        pass
    try:
        return decode_token(token).get("type")
    except JWTError:
        return None
_ROOM_TYPES  = {"chat", "raise-hand", "name", "presenting", "mute-all", "unmute-all", "cam-mute-all", "cam-unmute-all"}
_ALL_TYPES   = _P2P_TYPES | _SFU_TYPES | _CTRL_TYPES | _ROOM_TYPES


# ── Auth & validation helpers ─────────────────────────────────────────────────

async def _get_user_from_token(token: str, origin: str | None = None) -> User | None:
    """
    Accepts two token types:

    1. HS256 "access" token  — enterprise embed flow (existing behaviour).
       Validates domain allowlist via check_embed_domain.

    2. RS256 "public_host" / "public_guest" tokens — public meeting flow.
       No domain allowlist check — security comes from the RS256 signature.
       Returns a synthetic User-like object for guests (no DB row needed).
    """
    # ── Try RS256 public meeting token first ──────────────────────────────
    try:
        pub_payload = decode_public_token(token)
        token_type = pub_payload.get("type")
        if token_type in ("public_host", "public_guest"):
            raw_id = pub_payload.get("sub", "")
            # For public_host: sub is a real user UUID → fetch from DB
            if token_type == "public_host":
                try:
                    user_id = uuid.UUID(raw_id)
                except ValueError:
                    return None
                async with AsyncSessionLocal() as db:
                    result = await db.execute(select(User).where(User.id == user_id))
                    return result.scalar_one_or_none()
            # For public_guest: create a lightweight synthetic user object
            # (no DB row — guests are anonymous; use SimpleNamespace to avoid
            #  SQLAlchemy _sa_instance_state issues with User.__new__)
            import types
            guest_name = pub_payload.get("name", "Guest")
            synthetic = types.SimpleNamespace(
                id    = uuid.uuid5(uuid.NAMESPACE_URL, raw_id),
                name  = guest_name,
                email = f"{raw_id}@guest.local",
            )
            return synthetic
    except JWTError:
        pass  # not a public token — fall through to HS256 check

    # ── HS256 enterprise embed token ──────────────────────────────────────
    try:
        payload = decode_token(token)
    except JWTError:
        return None

    if payload.get("type") != "access":
        return None

    raw_id = payload.get("sub")
    if not raw_id:
        return None

    try:
        user_id = uuid.UUID(raw_id)
    except ValueError:
        return None

    # Check domain allowlist for embed tokens
    if not await check_embed_domain(token, origin or ""):
        logger.warning("Domain blocked  origin=%s", origin)
        return None

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()


async def _validate_participant(
    meeting_id: uuid.UUID, user_id: uuid.UUID
) -> tuple[bool, str]:
    async with AsyncSessionLocal() as db:
        meeting = (
            await db.execute(select(Meeting).where(Meeting.id == meeting_id))
        ).scalar_one_or_none()

        if meeting is None:
            return False, "Meeting not found"
        if not meeting.is_active:
            return False, "Meeting is not active"

        participant = (
            await db.execute(
                select(Participant).where(
                    Participant.meeting_id == meeting_id,
                    Participant.user_id == user_id,
                )
            )
        ).scalar_one_or_none()

        if participant is None:
            return False, "You are not a participant of this meeting"

    return True, ""


# ── SFU message handlers ──────────────────────────────────────────────────────

async def _handle_sfu(
    msg_type: str,
    payload: dict,
    room_id: str,
    user_id: str,
    websocket: WebSocket,
) -> None:
    """
    Process an SFU-related message from the client.
    Calls the mediasoup HTTP API and sends the result back to the client only.
    Side-effects like broadcasting new producer events are handled here too.
    """

    async def reply(reply_type: str, data: dict) -> None:
        await manager.send_personal(
            room_id, user_id,
            {"type": reply_type, "from": "server", "payload": data},
        )

    async def error(detail: str) -> None:
        await reply("error", {"detail": detail})

    try:
        # ── sfu:createTransport ────────────────────────────────────────────────
        if msg_type == "sfu:createTransport":
            direction = payload.get("direction")
            if direction not in ("send", "recv"):
                return await error("direction must be 'send' or 'recv'")
            data = await sfu.create_transport(room_id, user_id, direction)
            await reply("sfu:transportCreated", data)

        # ── sfu:connectTransport ───────────────────────────────────────────────
        elif msg_type == "sfu:connectTransport":
            transport_id = payload.get("transportId")
            dtls = payload.get("dtlsParameters")
            if not transport_id or not dtls:
                return await error("transportId and dtlsParameters are required")
            await sfu.connect_transport(room_id, user_id, transport_id, dtls)
            await reply("sfu:transportConnected", {"transportId": transport_id})

        # ── sfu:produce ────────────────────────────────────────────────────────
        elif msg_type == "sfu:produce":
            transport_id = payload.get("transportId")
            kind = payload.get("kind")
            rtp_params = payload.get("rtpParameters")
            if not transport_id or not kind or not rtp_params:
                return await error("transportId, kind, and rtpParameters are required")

            data = await sfu.produce(
                room_id, user_id, transport_id, kind, rtp_params,
                app_data=payload.get("appData", {}),
            )
            await reply("sfu:produced", data)

            # Notify all other peers so they can create consumers
            await manager.broadcast_to_room(
                room_id,
                {
                    "type": "sfu:newProducer",
                    "from": "server",
                    "payload": {
                        "producerId": data["producerId"],
                        "peerId": user_id,
                        "kind": kind,
                    },
                },
                exclude_user_id=user_id,
            )
            logger.info(
                "New producer  room=%s  peer=%s  kind=%s  producer=%s",
                room_id, user_id, kind, data["producerId"],
            )

        # ── sfu:consume ────────────────────────────────────────────────────────
        elif msg_type == "sfu:consume":
            producer_id = payload.get("producerId")
            transport_id = payload.get("transportId")
            rtp_caps = payload.get("rtpCapabilities")
            if not producer_id or not transport_id or not rtp_caps:
                return await error("producerId, transportId, and rtpCapabilities are required")

            data = await sfu.consume(
                room_id, user_id, producer_id, transport_id, rtp_caps
            )
            await reply("sfu:consumed", data)

        # ── sfu:resumeConsumer ─────────────────────────────────────────────────
        elif msg_type == "sfu:resumeConsumer":
            consumer_id = payload.get("consumerId")
            if not consumer_id:
                return await error("consumerId is required")
            await sfu.resume_consumer(room_id, user_id, consumer_id)
            await reply("sfu:consumerResumed", {"consumerId": consumer_id})

        # ── sfu:getProducers ───────────────────────────────────────────────────
        elif msg_type == "sfu:getProducers":
            data = await sfu.get_producers(room_id, exclude_peer_id=user_id)
            await reply("sfu:producers", data)

    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or str(exc)
        logger.warning("SFU HTTP error  type=%s  status=%d  %s", msg_type, exc.response.status_code, detail)
        await error(f"SFU error: {detail}")

    except httpx.RequestError as exc:
        logger.error("SFU unreachable  type=%s  error=%s", msg_type, exc)
        await error("Media server is temporarily unavailable")


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@router.websocket("/ws/meetings/{meeting_id}")
async def signaling_endpoint(
    websocket: WebSocket,
    meeting_id: str,
) -> None:
    token: str | None = websocket.query_params.get("token")
    origin: str | None = websocket.headers.get("origin")

    # ── Step 1: token present ─────────────────────────────────────────────────
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    # ── Step 2: authenticate ──────────────────────────────────────────────────
    user = await _get_user_from_token(token, origin)
    if user is None:
        await websocket.close(code=4001, reason="Invalid or expired token")
        return

    room_id = meeting_id
    # Append a short session suffix so the same user can join from multiple
    # tabs/devices without overwriting their own slot in the connection manager
    user_id = str(user.id) + "_" + str(uuid.uuid4())[:8]

    # ── Step 4: load meeting settings (public meetings only) ──────────────────
    token_type  = _get_token_type(token)
    is_guest    = token_type == "public_guest"
    is_public   = token_type in ("public_guest", "public_host")

    meeting_settings: dict = {}
    if is_public:
        async with AsyncSessionLocal() as db:
            pm = (
                await db.execute(
                    select(PublicMeeting).where(PublicMeeting.room_code == room_id)
                )
            ).scalar_one_or_none()
            if pm:
                meeting_settings = {
                    "require_approval":             pm.require_approval,
                    "allow_participants_see_others": pm.allow_participants_see_others,
                    "allow_participant_admit":       pm.allow_participant_admit,
                    "allow_chat":                   pm.allow_chat,
                    "allow_screen_share":           pm.allow_screen_share,
                    "allow_unmute_self":            pm.allow_unmute_self,
                }

    # ── Step 5: knock-to-join for public guests (if host already in room) ───────
    # Prefer the name the guest typed in the lobby (sent as WS query param)
    guest_name  = websocket.query_params.get("name") or getattr(user, "name", None) or "Guest"
    host_id     = manager.get_host(room_id)

    is_reconnect = websocket.query_params.get("reconnect") == "1"
    require_approval = meeting_settings.get("require_approval", True)

    if is_guest and not is_reconnect and require_approval:
        # Accept WS but hold guest in waiting room until host approves
        await websocket.accept()
        approval_event = manager.add_pending(room_id, user_id, websocket, guest_name)

        try:
            await websocket.send_json({
                "type": "knock-waiting",
                "from": "server",
                "payload": {"name": guest_name},
            })
        except Exception:
            manager.remove_pending(room_id, user_id)
            return

        # Notify host only if currently connected — otherwise re-sent when host joins
        if host_id and manager.is_connected(room_id, host_id):
            await manager.send_personal(room_id, host_id, {
                "type": "knock-request",
                "from": "server",
                "payload": {"guestId": user_id, "name": guest_name},
            })
        logger.info("Knock-to-join  room=%s  guest=%s  name=%s  host_online=%s",
                    room_id, user_id, guest_name, bool(host_id and manager.is_connected(room_id, host_id)))

        # Wait for host decision (2-min timeout)
        try:
            await asyncio.wait_for(approval_event.wait(), timeout=120)
        except asyncio.TimeoutError:
            manager.remove_pending(room_id, user_id)
            try:
                await websocket.send_json({
                    "type": "knock-denied",
                    "from": "server",
                    "payload": {"reason": "Request timed out"},
                })
                await websocket.close()
            except Exception:
                pass
            return

        pending_data = manager.get_pending(room_id, user_id)
        manager.remove_pending(room_id, user_id)

        if not pending_data or not pending_data.get("approved"):
            try:
                await websocket.send_json({
                    "type": "knock-denied",
                    "from": "server",
                    "payload": {"reason": "The host declined your request to join"},
                })
                await websocket.close()
            except Exception:
                pass
            return

        # Approved — add to active room
        manager.add_to_room(room_id, user_id, websocket)
    else:
        # Host / direct join / nobody in room yet
        await manager.connect(room_id, user_id, websocket)

    # Public-host token always reclaims host (handles refresh + reinstatement)
    if token_type == "public_host":
        # First time this meeting has a host — record as permanent host
        if manager.get_permanent_host(room_id) is None:
            manager.set_permanent_host(room_id, user_id)
        # Cancel any pending grace period (host reconnected in time)
        manager.cancel_host_grace(room_id)
        prev_host = manager.get_host(room_id)
        manager.set_host(room_id, user_id)
        if prev_host and prev_host != user_id:
            # Notify everyone that host is back (in case UI showed someone else as host)
            await manager.broadcast_to_room(
                room_id,
                {"type": "host-changed", "from": "server", "payload": {"hostId": user_id}},
                exclude_user_id=user_id,
            )
    elif manager.get_host(room_id) is None:
        manager.set_host(room_id, user_id)

    # ── Step 5: initialise SFU room + send capabilities ───────────────────────
    sfu_available = True
    try:
        sfu_data = await sfu.ensure_room(room_id)
        await manager.send_personal(
            room_id, user_id,
            {
                "type": "sfu:rtpCapabilities",
                "from": "server",
                "payload": {"rtpCapabilities": sfu_data["rtpCapabilities"]},
            },
        )
    except (httpx.RequestError, httpx.HTTPStatusError) as exc:
        sfu_available = False
        logger.error("Could not reach mediasoup on join  room=%s  error=%s", room_id, exc)

    # ── Step 6: tell new user who is already in the room ─────────────────────
    existing = [uid for uid in manager.get_user_ids(room_id) if uid != user_id]
    await manager.send_personal(
        room_id, user_id,
        {
            "type": "user-list",
            "from": "server",
            "payload": {
                "users": existing,
                "sfuAvailable": sfu_available,
                "myId": user_id,
                "isHost": manager.is_host(room_id, user_id),
                "settings": meeting_settings,
            },
        },
    )

    # ── Step 7: notify others ─────────────────────────────────────────────────
    await manager.broadcast_to_room(
        room_id,
        {"type": "join", "from": user_id, "payload": {"user_id": user_id}},
        exclude_user_id=user_id,
    )

    # Re-send any pending knock requests to the host (handles host refresh)
    if manager.is_host(room_id, user_id):
        for pending_uid in manager.get_pending_ids(room_id):
            pending = manager.get_pending(room_id, pending_uid)
            if pending:
                await manager.send_personal(room_id, user_id, {
                    "type": "knock-request",
                    "from": "server",
                    "payload": {"guestId": pending_uid, "name": pending["name"]},
                })

    # ── Step 8: message loop ──────────────────────────────────────────────────
    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send_personal(
                    room_id, user_id,
                    {"type": "error", "from": "server",
                     "payload": {"detail": "Message must be valid JSON"}},
                )
                continue

            msg_type: str | None = data.get("type")
            payload: dict = data.get("payload", {})
            target_id: str | None = data.get("to")

            # Unknown type
            if msg_type not in _ALL_TYPES:
                await manager.send_personal(
                    room_id, user_id,
                    {"type": "error", "from": "server",
                     "payload": {"detail": f"Unknown type '{msg_type}'"}},
                )
                continue

            # ── leave ──────────────────────────────────────────────────────────
            if msg_type == "leave":
                break

            # ── knock approval (host, or participants if setting allows) ──────────
            if msg_type in ("knock-approve", "knock-deny"):
                can_admit = manager.is_host(room_id, user_id) or meeting_settings.get("allow_participant_admit", False)
                if can_admit:
                    guest_id = payload.get("guestId")
                    if guest_id:
                        approved = (msg_type == "knock-approve")
                        manager.resolve_pending(room_id, guest_id, approved)
                        logger.info(
                            "Knock %s  room=%s  guest=%s  by_host=%s",
                            "approved" if approved else "denied", room_id, guest_id, user_id,
                        )
                continue

            # ── kick (host only) ───────────────────────────────────────────────
            if msg_type == "kick":
                if manager.is_host(room_id, user_id):
                    target_id = payload.get("userId")
                    if target_id and manager.is_connected(room_id, target_id):
                        await manager.send_personal(
                            room_id, target_id,
                            {"type": "you-were-kicked", "from": "server", "payload": {}},
                        )
                        logger.info("Kick  room=%s  target=%s  by_host=%s", room_id, target_id, user_id)
                continue

            # ── transfer-host (host only) ──────────────────────────────────────
            if msg_type == "transfer-host":
                if manager.is_host(room_id, user_id):
                    new_host_id = payload.get("userId")
                    if new_host_id and manager.is_connected(room_id, new_host_id):
                        manager.set_host(room_id, new_host_id)
                        manager.set_permanent_host(room_id, new_host_id)
                        manager.cancel_host_grace(room_id)
                        await manager.broadcast_to_room(
                            room_id,
                            {"type": "host-changed", "from": "server", "payload": {"hostId": new_host_id}},
                        )
                        logger.info("Host transferred  room=%s  from=%s  to=%s", room_id, user_id, new_host_id)
                continue

            # ── end-meeting (host only) ────────────────────────────────────────
            if msg_type == "end-meeting":
                if manager.is_host(room_id, user_id):
                    await manager.broadcast_to_room(
                        room_id,
                        {"type": "meeting-ended", "from": "server", "payload": {"reason": "Meeting ended by host"}},
                    )
                    for pid in manager.get_pending_ids(room_id):
                        manager.resolve_pending(room_id, pid, False)
                    logger.info("Meeting ended by host  room=%s  host=%s", room_id, user_id)
                    break  # host leaves after ending
                continue

            # ── host-only room broadcasts ──────────────────────────────────────
            if msg_type in ("mute-all", "unmute-all", "cam-mute-all", "cam-unmute-all"):
                if not manager.is_host(room_id, user_id):
                    continue  # silently drop — only host can send these

            # ── SFU messages ───────────────────────────────────────────────────
            if msg_type in _SFU_TYPES:
                await _handle_sfu(msg_type, payload, room_id, user_id, websocket)
                continue

            # ── P2P relay (offer / answer / ice-candidate) ─────────────────────
            outbound = {"type": msg_type, "from": user_id, "payload": payload}
            if target_id:
                if not manager.is_connected(room_id, target_id):
                    await manager.send_personal(
                        room_id, user_id,
                        {"type": "error", "from": "server",
                         "payload": {"detail": f"User '{target_id}' is not in this room"}},
                    )
                else:
                    await manager.send_personal(room_id, target_id, outbound)
            else:
                await manager.broadcast_to_room(room_id, outbound, exclude_user_id=user_id)

    except Exception:
        logger.exception("Unexpected error  meeting=%s  user=%s", room_id, user_id)

    finally:
        # ── Step 9: cleanup ───────────────────────────────────────────────────
        # Check host status before disconnecting
        was_host = manager.is_host(room_id, user_id)

        manager.disconnect(room_id, user_id)

        # Remove peer from mediasoup (closes transports, producers, consumers)
        try:
            await sfu.remove_peer(room_id, user_id)
        except Exception as exc:
            logger.warning("SFU peer cleanup failed  room=%s  user=%s  error=%s", room_id, user_id, exc)

        # Notify remaining peers of leave
        await manager.broadcast_to_room(
            room_id,
            {"type": "leave", "from": user_id, "payload": {"user_id": user_id}},
        )

        # If the permanent host left, start a 60-second grace period.
        # If they reconnect in time, cancel it. Otherwise, end the meeting.
        if was_host and manager.is_permanent_host(room_id, user_id) and manager.room_size(room_id) > 0:
            async def _end_meeting_after_grace():
                logger.info("Grace period expired  room=%s  host=%s", room_id, user_id)
                await manager.broadcast_to_room(
                    room_id,
                    {"type": "meeting-ended", "from": "server",
                     "payload": {"reason": "Host did not return"}},
                )
                for pid in manager.get_pending_ids(room_id):
                    manager.resolve_pending(room_id, pid, False)
            manager.start_host_grace(room_id, _end_meeting_after_grace, timeout=60)
            logger.info("Host absent — grace period started  room=%s", room_id)

        logger.info("WS cleanup done  meeting=%s  user=%s", room_id, user_id)
