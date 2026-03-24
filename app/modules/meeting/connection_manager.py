"""
ConnectionManager — per-room WebSocket registry.

Current implementation: in-memory (single process).

Redis Pub/Sub scaling path (for multi-instance deployments):
─────────────────────────────────────────────────────────────
Replace broadcast_to_room() with:
  1. redis.publish(f"meeting:{meeting_id}", json.dumps(message))
Add a background subscriber task on startup:
  1. redis.subscribe("meeting:*")
  2. On each message, deliver to local sockets in that room.
This lets N backend instances share signaling across a load-balancer.
"""

import asyncio
import logging
from collections import defaultdict

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self) -> None:
        # meeting_id (str) → { user_id (str) → WebSocket }
        self._rooms: dict[str, dict[str, WebSocket]] = defaultdict(dict)
        # join order per room (for host transfer)
        self._room_join_order: dict[str, list[str]] = defaultdict(list)
        # current host per room
        self._room_hosts: dict[str, str] = {}
        # permanent host — set by public_host token, only changed on explicit transfer
        self._permanent_hosts: dict[str, str] = {}
        # grace period asyncio tasks (host absent → end meeting after timeout)
        self._grace_tasks: dict[str, asyncio.Task] = {}
        # pending guests waiting for host approval
        # room_id → { user_id → { ws, name, event, approved } }
        self._pending: dict[str, dict[str, dict]] = defaultdict(dict)

    # ── Connection lifecycle ───────────────────────────────────────────────────

    async def connect(
        self, meeting_id: str, user_id: str, websocket: WebSocket
    ) -> None:
        await websocket.accept()
        self._add_to_room(meeting_id, user_id, websocket)

    def add_to_room(self, meeting_id: str, user_id: str, websocket: WebSocket) -> None:
        """Add an already-accepted WebSocket to the room (no accept() call)."""
        self._add_to_room(meeting_id, user_id, websocket)

    def _add_to_room(self, meeting_id: str, user_id: str, websocket: WebSocket) -> None:
        self._rooms[meeting_id][user_id] = websocket
        self._room_join_order[meeting_id].append(user_id)
        logger.info(
            "WS connect    meeting=%s  user=%s  room_size=%d",
            meeting_id, user_id, len(self._rooms[meeting_id]),
        )

    # ── Knock-to-join (waiting room) ──────────────────────────────────────────

    def add_pending(self, meeting_id: str, user_id: str, websocket: WebSocket, name: str):
        """Register a guest as pending approval. Returns an asyncio.Event to await."""
        import asyncio
        event = asyncio.Event()
        self._pending[meeting_id][user_id] = {
            "ws": websocket, "name": name, "event": event, "approved": False,
        }
        logger.info(
            "Pending add  meeting=%s  guest=%s  name=%s  total_pending=%d",
            meeting_id, user_id, name, len(self._pending[meeting_id]),
        )
        return event

    def resolve_pending(self, meeting_id: str, user_id: str, approved: bool) -> None:
        """Called by host to approve or deny a pending guest."""
        entry = self._pending.get(meeting_id, {}).get(user_id)
        if entry:
            entry["approved"] = approved
            entry["event"].set()
            logger.info("Pending resolved  meeting=%s  guest=%s  approved=%s", meeting_id, user_id, approved)
        else:
            logger.warning(
                "Pending resolve MISS — guest not in pending list  meeting=%s  guest=%s  "
                "pending_ids=%s",
                meeting_id, user_id, list(self._pending.get(meeting_id, {}).keys()),
            )

    def remove_pending(self, meeting_id: str, user_id: str) -> None:
        self._pending.get(meeting_id, {}).pop(user_id, None)
        if not self._pending.get(meeting_id):
            self._pending.pop(meeting_id, None)
        logger.info("Pending removed  meeting=%s  guest=%s", meeting_id, user_id)

    def get_pending(self, meeting_id: str, user_id: str) -> dict | None:
        return self._pending.get(meeting_id, {}).get(user_id)

    def get_pending_ids(self, meeting_id: str) -> list[str]:
        return list(self._pending.get(meeting_id, {}).keys())

    def disconnect(self, meeting_id: str, user_id: str) -> None:
        room = self._rooms.get(meeting_id, {})
        room.pop(user_id, None)
        order = self._room_join_order.get(meeting_id, [])
        if user_id in order:
            order.remove(user_id)
        if not room:                      # last user left — free the room
            self._rooms.pop(meeting_id, None)
            self._room_join_order.pop(meeting_id, None)
            self._room_hosts.pop(meeting_id, None)
            self._permanent_hosts.pop(meeting_id, None)
            self.cancel_host_grace(meeting_id)
        logger.info("WS disconnect  meeting=%s  user=%s", meeting_id, user_id)

    # ── Host management ───────────────────────────────────────────────────────

    def set_host(self, meeting_id: str, user_id: str) -> None:
        self._room_hosts[meeting_id] = user_id

    def get_host(self, meeting_id: str) -> str | None:
        return self._room_hosts.get(meeting_id)

    def is_host(self, meeting_id: str, user_id: str) -> bool:
        return self._room_hosts.get(meeting_id) == user_id

    # ── Permanent host (meeting creator) ──────────────────────────────────────

    def set_permanent_host(self, meeting_id: str, user_id: str) -> None:
        """Set the permanent host (meeting creator). Only changes on explicit transfer."""
        self._permanent_hosts[meeting_id] = user_id

    def get_permanent_host(self, meeting_id: str) -> str | None:
        return self._permanent_hosts.get(meeting_id)

    def is_permanent_host(self, meeting_id: str, user_id: str) -> bool:
        return self._permanent_hosts.get(meeting_id) == user_id

    # ── Grace period (host absent) ─────────────────────────────────────────────

    def start_host_grace(self, meeting_id: str, on_expire_coro, timeout: int = 60) -> None:
        """Start a grace period. If host doesn't reconnect within timeout, on_expire_coro is called."""
        self.cancel_host_grace(meeting_id)
        async def _task():
            await asyncio.sleep(timeout)
            await on_expire_coro()
        self._grace_tasks[meeting_id] = asyncio.create_task(_task())

    def cancel_host_grace(self, meeting_id: str) -> None:
        task = self._grace_tasks.pop(meeting_id, None)
        if task and not task.done():
            task.cancel()

    def next_in_room(self, meeting_id: str, exclude_user_id: str) -> str | None:
        """Return the next user in join order, skipping exclude_user_id."""
        for uid in self._room_join_order.get(meeting_id, []):
            if uid != exclude_user_id:
                return uid
        return None

    # ── Introspection ─────────────────────────────────────────────────────────

    def get_user_ids(self, meeting_id: str) -> list[str]:
        return list(self._rooms.get(meeting_id, {}).keys())

    def is_connected(self, meeting_id: str, user_id: str) -> bool:
        return user_id in self._rooms.get(meeting_id, {})

    def room_size(self, meeting_id: str) -> int:
        return len(self._rooms.get(meeting_id, {}))

    # ── Message delivery ──────────────────────────────────────────────────────

    async def send_personal(
        self, meeting_id: str, user_id: str, message: dict
    ) -> bool:
        """Send a message to one specific user in a room. Returns True on success."""
        ws = self._rooms.get(meeting_id, {}).get(user_id)
        if ws is None:
            logger.warning(
                "send_personal MISS — user not in room  meeting=%s  user=%s  msg_type=%s  room_users=%s",
                meeting_id, user_id, message.get("type"), list(self._rooms.get(meeting_id, {}).keys()),
            )
            return False
        try:
            await ws.send_json(message)
            return True
        except Exception as exc:
            logger.warning(
                "send_personal failed  meeting=%s  user=%s  error=%s",
                meeting_id, user_id, exc,
            )
            return False

    async def broadcast_to_room(
        self,
        meeting_id: str,
        message: dict,
        exclude_user_id: str | None = None,
    ) -> None:
        """
        Broadcast to every connected user in the room.
        Pass exclude_user_id to skip the sender.
        Failures on individual sockets are logged but do not abort the broadcast.
        """
        # Snapshot to avoid mutation during iteration
        recipients = {
            uid: ws
            for uid, ws in self._rooms.get(meeting_id, {}).items()
            if uid != exclude_user_id
        }
        if not recipients:
            return

        results = await asyncio.gather(
            *[ws.send_json(message) for ws in recipients.values()],
            return_exceptions=True,
        )
        for uid, result in zip(recipients.keys(), results):
            if isinstance(result, Exception):
                logger.warning(
                    "broadcast failed  meeting=%s  user=%s  error=%s",
                    meeting_id, uid, result,
                )


# ── Module-level singleton ─────────────────────────────────────────────────────
# One shared instance per process.
# Replace with a Redis-backed implementation for multi-process deployments.
manager = ConnectionManager()
