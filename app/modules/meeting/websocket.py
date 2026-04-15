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
from app.modules.project.models import ProjectMeeting, ProjectMeetingParticipant
from app.modules.public_meeting.models import PublicMeeting

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Signaling"])


# ── Analytics helpers ─────────────────────────────────────────────────────────

async def _is_project_meeting(room_id: str) -> bool:
    """Return True if this room_id belongs to a ProjectMeeting."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ProjectMeeting).where(ProjectMeeting.room_name == room_id)
        )
        return result.scalar_one_or_none() is not None


async def _record_participant_join(room_id: str, user_id: str, display_name: str, role: str) -> None:
    from datetime import datetime, timezone, timedelta
    try:
        async with AsyncSessionLocal() as db:
            now = datetime.now(timezone.utc)

            # Guard: if already has an open session (left_at is None), skip duplicate
            open_result = await db.execute(
                select(ProjectMeetingParticipant).where(
                    ProjectMeetingParticipant.room_name == room_id,
                    ProjectMeetingParticipant.user_id == user_id,
                    ProjectMeetingParticipant.left_at.is_(None),
                )
            )
            if open_result.scalars().first():
                return

            # Reconnect detection: if this user left very recently (within 30s),
            # reopen the existing record instead of creating a duplicate row.
            recent_result = await db.execute(
                select(ProjectMeetingParticipant).where(
                    ProjectMeetingParticipant.room_name == room_id,
                    ProjectMeetingParticipant.user_id == user_id,
                    ProjectMeetingParticipant.left_at >= now - timedelta(seconds=30),
                ).order_by(ProjectMeetingParticipant.joined_at.desc())
            )
            reconnect = recent_result.scalars().first()
            if reconnect:
                reconnect.left_at = None
                await db.commit()
                return

            participant = ProjectMeetingParticipant(
                room_name=room_id,
                user_id=user_id,
                display_name=display_name,
                role=role,
                joined_at=now,
            )
            db.add(participant)
            await db.commit()
    except Exception as exc:
        logger.warning("Failed to record participant join  room=%s  user=%s  error=%s", room_id, user_id, exc)


async def _record_participant_leave(room_id: str, user_id: str) -> None:
    from datetime import datetime, timezone
    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(ProjectMeetingParticipant).where(
                    ProjectMeetingParticipant.room_name == room_id,
                    ProjectMeetingParticipant.user_id == user_id,
                    ProjectMeetingParticipant.left_at.is_(None),
                ).order_by(ProjectMeetingParticipant.joined_at.desc())
            )
            p = result.scalars().first()
            if p:
                p.left_at = datetime.now(timezone.utc)
                await db.commit()
    except Exception as exc:
        logger.warning("Failed to record participant leave  room=%s  user=%s  error=%s", room_id, user_id, exc)


async def _record_meeting_end(room_id: str) -> None:
    from datetime import datetime, timezone
    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(ProjectMeeting).where(ProjectMeeting.room_name == room_id)
            )
            pm = result.scalar_one_or_none()
            if pm and pm.ended_at is None:
                pm.ended_at = datetime.now(timezone.utc)
                await db.commit()
    except Exception as exc:
        logger.warning("Failed to record meeting end  room=%s  error=%s", room_id, exc)


async def _deactivate_public_meeting(room_code: str) -> None:
    """Mark a public meeting as inactive so refresh/rejoin is blocked."""
    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(PublicMeeting).where(PublicMeeting.room_code == room_code)
            )
            pm = result.scalar_one_or_none()
            if pm and pm.is_active:
                pm.is_active = False
                await db.commit()
    except Exception as exc:
        logger.warning("Failed to deactivate public meeting  room=%s  error=%s", room_code, exc)

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
_CTRL_TYPES  = {"leave", "knock-approve", "knock-deny", "kick", "transfer-host", "end-meeting",
                "host-mute-user", "host-unmute-user", "host-cam-off-user", "host-cam-on-user"}


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


def _get_token_role(token: str) -> str | None:
    """Return 'host', 'guest', or None (old tokens without role field)."""
    try:
        return decode_public_token(token).get("role")
    except JWTError:
        pass
    try:
        return decode_token(token).get("role")
    except JWTError:
        return None

_ROOM_TYPES  = {"chat", "chat-private", "raise-hand", "reaction", "name", "presenting", "mute-all", "unmute-all", "cam-mute-all", "cam-unmute-all", "cam-state", "mic-state"}
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

    # Check domain allowlist for all embed tokens (host and guest)
    if not await check_embed_domain(token, origin or ""):
        logger.warning("Domain blocked  origin=%s", origin)
        return None

    # Guest embed tokens → synthetic user, no DB lookup needed.
    # Use the token's own sub (a unique UUID4 per token) as the stable ID
    # so the same guest token reconnecting after a refresh maps to the same
    # base_user_id — enabling the was_admitted bypass without re-approval.
    if payload.get("role") == "guest":
        import types as _types
        raw_sub = payload.get("sub", "")
        try:
            guest_id = uuid.UUID(raw_sub)
        except ValueError:
            guest_id = uuid.uuid4()
        synthetic = _types.SimpleNamespace(
            id=guest_id,
            name="Guest",
            email="guest@embed.local",
        )
        return synthetic

    raw_id = payload.get("sub")
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
    base_user_id = str(user.id)
    # Append a short session suffix so the same user can join from multiple
    # tabs/devices without overwriting their own slot in the connection manager
    user_id = base_user_id + "_" + str(uuid.uuid4())[:8]

    # ── Step 3: load token role (needed for MAU and meeting settings) ─────────
    token_type   = _get_token_type(token)
    token_role   = _get_token_role(token)
    is_guest     = token_type == "public_guest" or (token_type == "access" and token_role == "guest")
    is_embed_host = token_type == "access" and token_role == "host"
    is_public    = token_type in ("public_guest", "public_host")
    # public_host tokens carry no "role" field (token_role is None), so checking
    # token_role != "host" alone would incorrectly subject the host to the limit.
    is_any_host  = is_embed_host or (token_type == "public_host")

    def _non_host_count() -> int:
        """Current non-host participant count connected to the room."""
        size = manager.room_size(room_id)
        hid  = manager.get_host(room_id)
        host_in_room = 1 if (hid and manager.is_connected(room_id, hid)) else 0
        return max(0, size - host_in_room)

    # Always fetch plan info so p_limit is available in the host's message loop
    # for the knock-approve race-condition guard (pending guests are invisible to
    # room_size, so multiple simultaneous knockers can all pass the initial check
    # unless we re-check at approval time with the correct limit).
    from app.modules.project.mau import (
        check_and_record_mau, get_project_and_plan, PLAN_PARTICIPANT_LIMITS, PLAN_TIME_LIMITS,
        PUBLIC_MEETING_PARTICIPANT_LIMIT, PUBLIC_MEETING_TIME_LIMIT_MINUTES,
    )
    project_id, owner_plan, _room_found = await get_project_and_plan(meeting_id)
    _is_public_meeting = (project_id is None and _room_found)
    if _is_public_meeting:
        p_limit: int | None = PUBLIC_MEETING_PARTICIPANT_LIMIT
    else:
        p_limit: int | None = PLAN_PARTICIPANT_LIMITS.get(owner_plan, 100) if _room_found else None

    # ── Step 4: MAU + concurrent participant limit (non-hosts only) ──────────
    if not is_any_host:
        _joiner_name = websocket.query_params.get("name") or "A participant"

        # _room_found distinguishes a free-tier owner (owner_plan=None, found=True)
        # from an unknown room (found=False) where limits should not be enforced.
        if _room_found:
            # 4a: Concurrent participant limit — checked before MAU so the
            #     "room full" message is more user-friendly than an MAU error.
            if p_limit is not None:
                non_host_count = _non_host_count()
                logger.info(
                    "Capacity check  room=%s  user=%s  room_size=%d  host_id=%s  "
                    "host_connected=%s  non_host_count=%d  p_limit=%d",
                    room_id, user_id,
                    manager.room_size(room_id),
                    manager.get_host(room_id),
                    bool(manager.get_host(room_id) and manager.is_connected(room_id, manager.get_host(room_id))),
                    non_host_count, p_limit,
                )
                if non_host_count >= p_limit:
                    # Race-condition guard: a participant may be mid-disconnect
                    # (their finally block hasn't run yet). Wait briefly and recheck
                    # before issuing a hard rejection.
                    await asyncio.sleep(2.0)
                    non_host_count = _non_host_count()
                    logger.info(
                        "Capacity recheck (after sleep)  room=%s  room_size=%d  non_host_count=%d  p_limit=%d",
                        room_id, manager.room_size(room_id), non_host_count, p_limit,
                    )
                if non_host_count >= p_limit:
                    await websocket.accept()
                    await websocket.send_json({
                        "type": "error",
                        "from": "server",
                        "payload": {
                            "detail": (
                                f"This meeting is full ({non_host_count}/{p_limit} participants). "
                                "Ask the host to upgrade their plan to allow more participants."
                            ),
                            "code": "room_full",
                            "limit": p_limit,
                            "current": non_host_count,
                            "plan": owner_plan or "basic",
                        },
                    })
                    await websocket.close(code=4430, reason="Room full")
                    hid = manager.get_host(room_id)
                    if hid:
                        await manager.send_personal(room_id, hid, {
                            "type": "room_full_warning",
                            "from": "server",
                            "payload": {
                                "name": _joiner_name,
                                "current": non_host_count,
                                "limit": p_limit,
                                "plan": owner_plan or "basic",
                            },
                        })
                    logger.info(
                        "Room full — participant blocked  room=%s  user=%s  count=%d  limit=%d",
                        room_id, user_id, non_host_count, p_limit,
                    )
                    return

            # 4b: MAU enforcement
            # Skip MAU check when a concurrent participant limit is in place — the
            # concurrent limit already controls who can be in the room.  MAU would
            # otherwise block new joiners even when there is a free slot (e.g. plan
            # has 5 MAU and 5 concurrent: after 5 unique users join+leave, no new
            # user could ever join despite the room having space).
            # Use base_user_id (no session suffix) so the same person rejoining
            # doesn't burn a new MAU slot each time they refresh or rejoin.
            # Also skip MAU for public meetings (project_id is None — no project to track against)
            _skip_mau = (p_limit is not None) or (project_id is None)
            allowed, reason = (True, "") if _skip_mau else await check_and_record_mau(project_id, base_user_id, owner_plan)
            if not allowed:
                await websocket.accept()
                await websocket.send_json({
                    "type": "error",
                    "from": "server",
                    "payload": {"detail": reason, "code": "mau_limit_reached"},
                })
                await websocket.close(code=4429, reason="MAU limit reached")
                host_id = manager.get_host(meeting_id)
                if host_id:
                    await manager.send_personal(meeting_id, host_id, {
                        "type": "mau_warning",
                        "from": "server",
                        "payload": {"message": "A participant was blocked — your monthly active user limit has been reached. Upgrade your plan to allow more participants."},
                    })
                return

    meeting_settings: dict = {}
    if is_public:
        async with AsyncSessionLocal() as db:
            pm = (
                await db.execute(
                    select(PublicMeeting).where(PublicMeeting.room_code == room_id)
                )
            ).scalar_one_or_none()
            if pm:
                if not pm.is_active:
                    await websocket.accept()
                    await websocket.send_json({
                        "type": "meeting_ended_plan_limit",
                        "from": "server",
                        "payload": {
                            "plan": "free",
                            "minutes": 0,
                            "message": "This meeting has ended — its time limit was reached.",
                        },
                    })
                    await websocket.close(code=1000)
                    return
                meeting_settings = {
                    "require_approval":             pm.require_approval,
                    "allow_participants_see_others": pm.allow_participants_see_others,
                    "allow_participant_admit":       pm.allow_participant_admit,
                    "allow_chat":                   pm.allow_chat,
                    "allow_screen_share":           pm.allow_screen_share,
                    "allow_unmute_self":            pm.allow_unmute_self,
                    # Authoritative host — from DB, not in-memory WS state
                    "host_user_id":                 str(pm.created_by) if pm.created_by else None,
                }

    # ── Step 5: knock-to-join for public guests (if host already in room) ───────
    # Prefer the name the guest typed in the lobby (sent as WS query param)
    guest_name  = websocket.query_params.get("name") or getattr(user, "name", None) or "Guest"

    # Resolve the current host:
    # 1. Try in-memory (fastest — already tracked from WS connection)
    # 2. Fall back to DB-authoritative created_by — find their active session by base user ID.
    #    This handles the case where the host IS connected but _room_hosts was cleared
    #    (e.g. after a brief disconnect/reconnect cycle that reset in-memory state).
    host_id = manager.get_host(room_id)
    if host_id is None:
        db_host_base = meeting_settings.get("host_user_id")
        if db_host_base:
            session_id = manager.get_session_id_for_base(room_id, db_host_base)
            if session_id:
                host_id = session_id
                manager.set_host(room_id, session_id)
                logger.info(
                    "Host resolved from DB  room=%s  host_base=%s  session=%s",
                    room_id, db_host_base, session_id,
                )

    is_reconnect = websocket.query_params.get("reconnect") == "1"
    require_approval = meeting_settings.get("require_approval", True)

    logger.info(
        "WS connect attempt  room=%s  user=%s  name=%s  token_type=%s  "
        "is_guest=%s  is_reconnect=%s  require_approval=%s  host_in_room=%s  room_size=%d",
        room_id, user_id, guest_name, token_type,
        is_guest, is_reconnect, require_approval,
        host_id, manager.room_size(room_id),
    )

    # A guest with reconnect=1 may bypass knock ONLY if they were previously admitted.
    # If reconnect=1 but the guest was never admitted (e.g. refreshed from waiting screen),
    # treat as a fresh connection and route through the knock flow.
    if is_guest and is_reconnect and require_approval and not manager.was_admitted(room_id, base_user_id):
        logger.warning(
            "Reconnect=1 from unadmitted guest — forcing knock flow  room=%s  user=%s  base=%s",
            room_id, user_id, base_user_id,
        )
        is_reconnect = False

    if is_guest and not is_reconnect and require_approval:
        # Accept WS but hold guest in waiting room until host approves
        await websocket.accept()
        approval_event = manager.add_pending(room_id, user_id, websocket, guest_name)
        logger.info(
            "Knock-pending  room=%s  guest=%s  name=%s  pending_count=%d",
            room_id, user_id, guest_name, len(manager.get_pending_ids(room_id)),
        )

        # Re-read the current host AFTER add_pending — the host may have joined while
        # we were awaiting websocket.accept(), which would have run the host's join
        # coroutine (including its re-send-pending check) before we added ourselves.
        # Using the fresh value ensures we don't miss that race window.
        current_host_id = manager.get_host(room_id)
        if current_host_id is None:
            db_host_base = meeting_settings.get("host_user_id")
            if db_host_base:
                session_id = manager.get_session_id_for_base(room_id, db_host_base)
                if session_id:
                    current_host_id = session_id
                    manager.set_host(room_id, session_id)
        host_connected = bool(current_host_id and manager.is_connected(room_id, current_host_id))

        try:
            await websocket.send_json({
                "type": "knock-waiting",
                "from": "server",
                "payload": {"name": guest_name, "host_present": host_connected},
            })
            logger.info("Knock-waiting sent  room=%s  guest=%s  host_present=%s", room_id, user_id, host_connected)
        except Exception as exc:
            logger.warning("Knock-waiting send FAILED  room=%s  guest=%s  error=%s", room_id, user_id, exc)
            manager.remove_pending(room_id, user_id)
            return

        # Notify host only if currently connected — otherwise re-sent when host joins
        _knock_msg = {"type": "knock-request", "from": "server", "payload": {"guestId": user_id, "name": guest_name}}
        if host_connected:
            logger.info("Sending knock-request to host  room=%s  host=%s  guest=%s", room_id, current_host_id, user_id)
            sent = await manager.send_personal(room_id, current_host_id, _knock_msg)
            if not sent:
                logger.warning(
                    "knock-request delivery FAILED (host WS dead) — will retry on host reconnect  "
                    "room=%s  host=%s  guest=%s",
                    room_id, current_host_id, user_id,
                )
        else:
            logger.warning(
                "Host not connected — knock-request deferred  room=%s  guest=%s  host_id=%s  "
                "room_size=%d  permanent_host=%s  pending_count=%d",
                room_id, user_id, current_host_id,
                manager.room_size(room_id),
                manager.get_permanent_host(room_id),
                len(manager.get_pending_ids(room_id)),
            )
        # When participants can admit others, also send knock-request to all
        # non-host participants already in the room so they see the request too.
        if meeting_settings.get("allow_participant_admit", False) and host_connected:
            await manager.broadcast_to_room(
                room_id, _knock_msg, exclude_user_id=current_host_id
            )

        # Wait for host decision while also watching for guest disconnect (10-min timeout)
        logger.info("Waiting for approval  room=%s  guest=%s  timeout=600s", room_id, user_id)

        ws_disconnected = asyncio.Event()

        async def _ws_close_guard():
            """Set ws_disconnected if the guest's WS closes while pending."""
            try:
                while True:
                    await websocket.receive_text()
            except (WebSocketDisconnect, RuntimeError):
                pass
            ws_disconnected.set()

        ws_guard_task = asyncio.create_task(_ws_close_guard())
        approval_task = asyncio.create_task(approval_event.wait())
        try:
            done, _ = await asyncio.wait(
                {ws_guard_task, approval_task},
                timeout=600,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            ws_guard_task.cancel()
            approval_task.cancel()

        if not done:
            # 10-minute timeout — no host decision
            logger.warning("Knock timed out  room=%s  guest=%s  name=%s", room_id, user_id, guest_name)
            manager.remove_pending(room_id, user_id)
            try:
                await websocket.send_json({
                    "type": "knock-denied",
                    "from": "server",
                    "payload": {"reason": "Request timed out"},
                })
                await websocket.close()
            except Exception as e:
                logger.debug("Could not send timeout/close to guest WebSocket  %s", e)
            return

        if ws_disconnected.is_set() and not approval_event.is_set():
            # Guest's WS closed before host made a decision — clean up silently
            logger.warning(
                "Pending guest WS closed before approval  room=%s  guest=%s  name=%s",
                room_id, user_id, guest_name,
            )
            manager.remove_pending(room_id, user_id)
            return

        pending_data = manager.get_pending(room_id, user_id)
        manager.remove_pending(room_id, user_id)

        if not pending_data or not pending_data.get("approved"):
            logger.info("Knock denied  room=%s  guest=%s  name=%s", room_id, user_id, guest_name)
            try:
                await websocket.send_json({
                    "type": "knock-denied",
                    "from": "server",
                    "payload": {"reason": "The host declined your request to join"},
                })
                await websocket.close()
            except Exception as e:
                logger.debug("Could not send decline/close to guest WebSocket  %s", e)
            return

        logger.info("Knock approved  room=%s  guest=%s  name=%s", room_id, user_id, guest_name)
        # Record admission so future reconnect=1 from this guest is allowed
        manager.mark_admitted(room_id, base_user_id)
        # Approved — add to active room
        manager.add_to_room(room_id, user_id, websocket)
    else:
        logger.info(
            "Direct join (no knock)  room=%s  user=%s  is_guest=%s  is_reconnect=%s  require_approval=%s",
            room_id, user_id, is_guest, is_reconnect, require_approval,
        )
        # Host / direct join / nobody in room yet
        await manager.connect(room_id, user_id, websocket)

    # ── Analytics: record participant join for ProjectMeeting rooms ──────────
    _is_pm = is_embed_host or (token_type == "access" and token_role == "guest")
    if _is_pm and await _is_project_meeting(room_id):
        _p_role = "host" if is_embed_host else "guest"
        _p_name = guest_name if not is_embed_host else getattr(user, "email", str(user.id))
        asyncio.create_task(_record_participant_join(room_id, base_user_id, _p_name, _p_role))

    # Public-host and embed-host tokens always reclaim host (handles refresh + reinstatement)
    if token_type == "public_host" or is_embed_host:
        # First time this meeting has a host — record as permanent host
        if manager.get_permanent_host(room_id) is None:
            manager.set_permanent_host(room_id, user_id)
            logger.info("Host initialized the meeting  room=%s  host=%s", room_id, user_id)
            # Start time limit timer (only on first host join, not reconnects)
            # Public meetings use a fixed 40-minute limit; embed meetings use plan-based limit
            _t_limit: int | None = PUBLIC_MEETING_TIME_LIMIT_MINUTES if _is_public_meeting else PLAN_TIME_LIMITS.get(owner_plan)
            if _t_limit is not None:
                _plan_label = owner_plan or "free"
                _plan_display = _plan_label.capitalize()
                _t_minutes = _t_limit
                _is_pub_mtg = _is_public_meeting
                async def _end_meeting_time_limit(
                    _rid=room_id, _label=_plan_label, _display=_plan_display, _mins=_t_minutes, _pub=_is_pub_mtg
                ):
                    if _pub:
                        _msg = (
                            f"Your meeting has ended — public meetings allow a maximum of "
                            f"{_mins} minutes. Create a project and upgrade your plan to host longer meetings."
                        )
                    else:
                        _msg = (
                            f"Your meeting has ended — the {_display} plan allows only "
                            f"{_mins} minute{'s' if _mins != 1 else ''}. "
                            "Please upgrade your plan to host longer meetings."
                        )
                    await manager.broadcast_to_room(_rid, {
                        "type": "meeting_ended_plan_limit",
                        "from": "server",
                        "payload": {"plan": _label, "minutes": _mins, "message": _msg},
                    })
                    for _pid in manager.get_pending_ids(_rid):
                        manager.resolve_pending(_rid, _pid, False)
                    await _record_meeting_end(_rid)
                    if _pub:
                        await _deactivate_public_meeting(_rid)
                    manager._time_limit_tasks.pop(_rid, None)
                    logger.info(
                        "Meeting ended by time limit  room=%s  plan=%s  minutes=%d",
                        _rid, _label, _mins,
                    )
                manager.start_time_limit(room_id, _end_meeting_time_limit, timeout_seconds=_t_limit * 60)
                logger.info(
                    "Time limit timer started  room=%s  plan=%s  minutes=%d",
                    room_id, _plan_label, _t_limit,
                )
        else:
            logger.info("Host rejoined the meeting  room=%s  host=%s", room_id, user_id)
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
                "hostId": manager.get_host(room_id),
                "settings": {k: v for k, v in meeting_settings.items() if k != "host_user_id"},
                # Server-authoritative forced media state for THIS participant
                "forcedMicOff": manager.is_forced_mic_off(room_id, base_user_id),
                "forcedCamOff": manager.is_forced_cam_off(room_id, base_user_id),
                # Full lists for host panel (base user IDs of all force-muted participants)
                "forcedMicUsers": manager.get_forced_mic_off(room_id),
                "forcedCamUsers": manager.get_forced_cam_off(room_id),
                # Self-reported cam/mic states for all participants (base_user_id → {cam, mic})
                # Allows host panel to show correct buttons immediately after refresh
                "participantStates": manager.get_participant_states(room_id),
                # Bulk-mute state so host buttons restore correctly after refresh
                "allMicsMuted": manager.is_all_mics_muted(room_id),
                "allCamsMuted": manager.is_all_cams_muted(room_id),
                # Raised hands — base user IDs of participants with hand currently raised
                "raisedHands": manager.get_raised_hands(room_id),
            },
        },
    )

    # ── Send public chat history to new joiner ────────────────────────────────
    chat_history = manager.get_public_chat(room_id)
    if chat_history:
        await manager.send_personal(room_id, user_id, {
            "type": "chat:history",
            "from": "server",
            "payload": {"messages": chat_history},
        })

    # ── Step 7: notify others ─────────────────────────────────────────────────
    await manager.broadcast_to_room(
        room_id,
        {"type": "join", "from": user_id, "payload": {"user_id": user_id, "name": guest_name}},
        exclude_user_id=user_id,
    )

    # Re-send any pending knock requests to the host (handles host refresh).
    # When allow_participant_admit is enabled, also notify newly joining participants.
    _send_knocks_to = []
    if manager.is_host(room_id, user_id):
        _send_knocks_to.append(user_id)
    elif meeting_settings.get("allow_participant_admit", False):
        _send_knocks_to.append(user_id)

    if _send_knocks_to:
        pending_ids = manager.get_pending_ids(room_id)
        logger.info(
            "Joined — re-sending pending knocks  room=%s  user=%s  pending=%s",
            room_id, user_id, pending_ids,
        )
        for pending_uid in pending_ids:
            pending = manager.get_pending(room_id, pending_uid)
            if pending:
                logger.info(
                    "Re-sending knock-request  room=%s  user=%s  guest=%s  name=%s",
                    room_id, user_id, pending_uid, pending["name"],
                )
                for recipient in _send_knocks_to:
                    await manager.send_personal(room_id, recipient, {
                        "type": "knock-request",
                        "from": "server",
                        "payload": {"guestId": pending_uid, "name": pending["name"]},
                    })
                if manager.is_host(room_id, user_id):
                    # Also update the guest's waiting screen — they may still show
                    # "Waiting for host to join" since the host wasn't connected when
                    # they first knocked.
                    try:
                        await pending["ws"].send_json({
                            "type": "knock-waiting",
                            "from": "server",
                            "payload": {"name": pending["name"], "host_present": True},
                        })
                    except Exception as exc:
                        logger.warning(
                            "Failed to update knock-waiting for guest  room=%s  guest=%s  error=%s",
                            room_id, pending_uid, exc,
                        )

    # ── Step 8: message loop ──────────────────────────────────────────────────
    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except (WebSocketDisconnect, RuntimeError):
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
                guest_id = payload.get("guestId")
                logger.info(
                    "Knock action received  room=%s  action=%s  guest_id=%s  sender=%s  can_admit=%s  pending_exists=%s",
                    room_id, msg_type, guest_id, user_id, can_admit,
                    bool(guest_id and manager.get_pending(room_id, guest_id)),
                )
                if can_admit:
                    if guest_id:
                        approved = (msg_type == "knock-approve")
                        # Re-check participant limit at approval time to prevent
                        # the race condition where multiple guests knock
                        # simultaneously (pending guests are not counted in
                        # room_size), all pass the initial check, and the host
                        # approves more than the plan allows.
                        if approved and p_limit is not None:
                            current_count = _non_host_count()
                            if current_count >= p_limit:
                                logger.info(
                                    "Knock-approve blocked — room full at approval time  "
                                    "room=%s  guest=%s  count=%d  limit=%d",
                                    room_id, guest_id, current_count, p_limit,
                                )
                                pending_entry = manager.get_pending(room_id, guest_id)
                                if pending_entry:
                                    try:
                                        await pending_entry["ws"].send_json({
                                            "type": "error",
                                            "from": "server",
                                            "payload": {
                                                "detail": (
                                                    f"This meeting is full "
                                                    f"({current_count}/{p_limit} participants). "
                                                    "Ask the host to upgrade their plan to allow more participants."
                                                ),
                                                "code": "room_full",
                                                "limit": p_limit,
                                                "current": current_count,
                                            },
                                        })
                                        await pending_entry["ws"].close(code=4430, reason="Room full")
                                    except Exception as e:
                                        logger.debug("Could not close full-room pending WebSocket  %s", e)
                                manager.resolve_pending(room_id, guest_id, False)
                                continue
                        manager.resolve_pending(room_id, guest_id, approved)
                        logger.info(
                            "Knock resolved  room=%s  guest=%s  approved=%s  by=%s",
                            room_id, guest_id, approved, user_id,
                        )
                    else:
                        logger.warning("Knock action missing guestId  room=%s  sender=%s", room_id, user_id)
                else:
                    logger.warning(
                        "Knock action rejected — sender not allowed  room=%s  sender=%s  is_host=%s",
                        room_id, user_id, manager.is_host(room_id, user_id),
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
                        # Revoke admission so kicked guest needs re-approval on next join.
                        # user_id format: "<base_uuid>_<8chars>" — strip the suffix.
                        kicked_base = target_id.rsplit("_", 1)[0]
                        manager.remove_admitted(room_id, kicked_base)
                        logger.info("Kick  room=%s  target=%s  by_host=%s", room_id, target_id, user_id)
                continue

            # ── per-user force mute/cam (host only) ────────────────────────────
            if msg_type in ("host-mute-user", "host-unmute-user",
                            "host-cam-off-user", "host-cam-on-user"):
                if manager.is_host(room_id, user_id):
                    target_id = payload.get("target_id")
                    out_type = {
                        "host-mute-user":    "you-are-force-muted",
                        "host-unmute-user":  "you-are-force-unmuted",
                        "host-cam-off-user": "you-are-force-cam-off",
                        "host-cam-on-user":  "you-are-force-cam-on",
                    }[msg_type]
                    if target_id and manager.is_connected(room_id, target_id):
                        # Persist forced state by base user ID (survives participant refresh)
                        target_base = target_id.rsplit("_", 1)[0]
                        if msg_type == "host-mute-user":
                            manager.set_forced_mic(room_id, target_base, True)
                            manager.set_participant_mic(room_id, target_base, False)
                        elif msg_type == "host-unmute-user":
                            manager.set_forced_mic(room_id, target_base, False)
                            manager.set_participant_mic(room_id, target_base, True)
                        elif msg_type == "host-cam-off-user":
                            manager.set_forced_cam(room_id, target_base, True)
                            manager.set_participant_cam(room_id, target_base, False)
                        elif msg_type == "host-cam-on-user":
                            manager.set_forced_cam(room_id, target_base, False)
                            manager.set_participant_cam(room_id, target_base, True)
                        await manager.send_personal(
                            room_id, target_id,
                            {"type": out_type, "from": user_id, "payload": {}},
                        )
                        logger.info(
                            "Host force-control  room=%s  type=%s  target=%s  target_base=%s  by=%s",
                            room_id, msg_type, target_id, target_base, user_id,
                        )
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
                    manager.cancel_time_limit(room_id)
                    asyncio.create_task(_record_meeting_end(room_id))
                    logger.info("Meeting ended by host  room=%s  host=%s", room_id, user_id)
                    break  # host leaves after ending
                continue

            # ── host-only room broadcasts ──────────────────────────────────────
            if msg_type in ("mute-all", "unmute-all", "cam-mute-all", "cam-unmute-all"):
                if not manager.is_host(room_id, user_id):
                    continue  # silently drop — only host can send these
                # Track bulk-mute state so host button is correct after refresh
                if msg_type == "mute-all":
                    manager.set_all_mics_muted(room_id, True)
                elif msg_type == "unmute-all":
                    manager.set_all_mics_muted(room_id, False)
                    manager.clear_all_forced_mic(room_id)
                elif msg_type == "cam-mute-all":
                    manager.set_all_cams_muted(room_id, True)
                elif msg_type == "cam-unmute-all":
                    manager.set_all_cams_muted(room_id, False)
                    manager.clear_all_forced_cam(room_id)

            # ── SFU messages ───────────────────────────────────────────────────
            if msg_type in _SFU_TYPES:
                await _handle_sfu(msg_type, payload, room_id, user_id, websocket)
                continue

            # ── Private chat routing ───────────────────────────────────────────
            if msg_type == "chat-private":
                if manager.is_host(room_id, user_id):
                    # Host → specific guest (payload must include 'to' with guest session ID)
                    to_user = payload.get("to")
                    if to_user and manager.is_connected(room_id, to_user):
                        fwd_payload = {k: v for k, v in payload.items() if k != "to"}
                        await manager.send_personal(room_id, to_user, {
                            "type": "chat-private", "from": user_id, "payload": fwd_payload,
                        })
                else:
                    # Guest → host
                    host_id = manager.get_host(room_id)
                    if host_id and manager.is_connected(room_id, host_id):
                        await manager.send_personal(room_id, host_id, {
                            "type": "chat-private", "from": user_id, "payload": payload,
                        })
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
                # Persist public chat for late joiners
                if msg_type == "chat":
                    manager.add_public_message(room_id, {"from": user_id, "payload": payload})
                # Track participant cam/mic state so admin panel is correct after refresh
                elif msg_type == "cam-state":
                    manager.set_participant_cam(room_id, base_user_id, bool(payload.get("enabled", True)))
                elif msg_type == "mic-state":
                    manager.set_participant_mic(room_id, base_user_id, bool(payload.get("enabled", True)))
                # Track raised-hand state so it survives other participants' refreshes
                elif msg_type == "raise-hand":
                    manager.set_hand_raised(room_id, base_user_id, bool(payload.get("raised", False)))

    except Exception:
        logger.exception("Unexpected error  meeting=%s  user=%s", room_id, user_id)

    finally:
        # ── Step 9: cleanup ───────────────────────────────────────────────────
        # Capture host flags BEFORE disconnect() — it clears _permanent_hosts and
        # cancels grace tasks when the room empties, so checking after is too late.
        was_host = manager.is_host(room_id, user_id)
        was_permanent_host = manager.is_permanent_host(room_id, user_id)

        if _is_pm:
            asyncio.create_task(_record_participant_leave(room_id, base_user_id))

        manager.disconnect(room_id, user_id)
        manager.remove_participant_state(room_id, base_user_id)
        manager.set_hand_raised(room_id, base_user_id, False)

        # If the room is now empty AND the host didn't just leave, end the meeting.
        # When the host leaves, the grace period below handles ending (gives time to reconnect).
        if _is_pm and manager.room_size(room_id) == 0 and not was_host:
            asyncio.create_task(_record_meeting_end(room_id))

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
        # This also covers the case where the host was the only participant (room_size == 0).
        if was_host and was_permanent_host:
            async def _end_meeting_after_grace():
                logger.info("Grace period expired  room=%s  host=%s", room_id, user_id)
                await manager.broadcast_to_room(
                    room_id,
                    {"type": "meeting-ended", "from": "server",
                     "payload": {"reason": "Host did not return"}},
                )
                for pid in manager.get_pending_ids(room_id):
                    manager.resolve_pending(room_id, pid, False)
                manager.cancel_time_limit(room_id)
                await _record_meeting_end(room_id)
            manager.start_host_grace(room_id, _end_meeting_after_grace, timeout=60)
            logger.info("Host absent — grace period started  room=%s", room_id)

        logger.info("WS cleanup done  meeting=%s  user=%s", room_id, user_id)
