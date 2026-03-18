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

import json
import logging
import uuid

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError
from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.core.mediasoup_client import sfu
from app.core.security import decode_token
from app.modules.auth.models import User
from app.modules.meeting.connection_manager import manager
from app.modules.meeting.models import Meeting, Participant

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
_CTRL_TYPES  = {"leave"}
_ROOM_TYPES  = {"chat", "raise-hand", "name", "presenting"}   # broadcast to whole room
_ALL_TYPES   = _P2P_TYPES | _SFU_TYPES | _CTRL_TYPES | _ROOM_TYPES


# ── Auth & validation helpers ─────────────────────────────────────────────────

async def _get_user_from_token(token: str) -> User | None:
    try:
        payload = decode_token(token)
    except JWTError:
        return None

    if payload.get("type") != "access":
        return None

    raw_id: str | None = payload.get("sub")
    if not raw_id:
        return None

    try:
        user_id = uuid.UUID(raw_id)
    except ValueError:
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

    # ── Step 1: token present ─────────────────────────────────────────────────
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    # ── Step 2: authenticate ──────────────────────────────────────────────────
    user = await _get_user_from_token(token)
    if user is None:
        await websocket.close(code=4001, reason="Invalid or expired token")
        return

    room_id = meeting_id
    # Append a short session suffix so the same user can join from multiple
    # tabs/devices without overwriting their own slot in the connection manager
    user_id = str(user.id) + "_" + str(uuid.uuid4())[:8]

    # ── Step 4: accept & register ─────────────────────────────────────────────
    await manager.connect(room_id, user_id, websocket)

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
        # SFU down → signaling still works; media won't be available
        sfu_available = False
        logger.error("Could not reach mediasoup on join  room=%s  error=%s", room_id, exc)

    # ── Step 6: tell new user who is already in the room ─────────────────────
    existing = [uid for uid in manager.get_user_ids(room_id) if uid != user_id]
    await manager.send_personal(
        room_id, user_id,
        {
            "type": "user-list",
            "from": "server",
            "payload": {"users": existing, "sfuAvailable": sfu_available},
        },
    )

    # ── Step 7: notify others ─────────────────────────────────────────────────
    await manager.broadcast_to_room(
        room_id,
        {"type": "join", "from": user_id, "payload": {"user_id": user_id}},
        exclude_user_id=user_id,
    )

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
        manager.disconnect(room_id, user_id)

        # Remove peer from mediasoup (closes transports, producers, consumers)
        try:
            await sfu.remove_peer(room_id, user_id)
        except Exception as exc:
            logger.warning("SFU peer cleanup failed  room=%s  user=%s  error=%s", room_id, user_id, exc)

        # Notify remaining peers
        await manager.broadcast_to_room(
            room_id,
            {"type": "leave", "from": user_id, "payload": {"user_id": user_id}},
        )
        logger.info("WS cleanup done  meeting=%s  user=%s", room_id, user_id)
