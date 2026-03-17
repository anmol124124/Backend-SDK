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

    # ── Connection lifecycle ───────────────────────────────────────────────────

    async def connect(
        self, meeting_id: str, user_id: str, websocket: WebSocket
    ) -> None:
        await websocket.accept()
        self._rooms[meeting_id][user_id] = websocket
        logger.info(
            "WS connect    meeting=%s  user=%s  room_size=%d",
            meeting_id, user_id, len(self._rooms[meeting_id]),
        )

    def disconnect(self, meeting_id: str, user_id: str) -> None:
        room = self._rooms.get(meeting_id, {})
        room.pop(user_id, None)
        if not room:                      # last user left — free the room
            self._rooms.pop(meeting_id, None)
        logger.info("WS disconnect  meeting=%s  user=%s", meeting_id, user_id)

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
    ) -> None:
        """Send a message to one specific user in a room."""
        ws = self._rooms.get(meeting_id, {}).get(user_id)
        if ws is None:
            return
        try:
            await ws.send_json(message)
        except Exception as exc:
            logger.warning(
                "send_personal failed  meeting=%s  user=%s  error=%s",
                meeting_id, user_id, exc,
            )

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
