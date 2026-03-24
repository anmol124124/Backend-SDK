"""
Async HTTP client for the mediasoup SFU service.

Uses a single persistent httpx.AsyncClient (connection pool) for the lifetime
of the process. The client is opened in the FastAPI lifespan (main.py) via
`await sfu.start()` and closed via `await sfu.stop()`.

All methods raise httpx.HTTPStatusError on 4xx/5xx so callers get a clean
exception that FastAPI can translate into a WebSocket error message.

Usage:
    from app.core.mediasoup_client import sfu

    caps  = await sfu.ensure_room(room_id)
    tp    = await sfu.create_transport(room_id, peer_id, "send")
    ...
"""

import logging

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


class MediasoupClient:
    def __init__(self) -> None:
        self._base = settings.MEDIASOUP_URL.rstrip("/")
        self._headers = {
            "x-internal-secret": settings.MEDIASOUP_INTERNAL_SECRET,
            "Content-Type": "application/json",
        }
        # Initialised by start(), closed by stop() — called from lifespan
        self._client: httpx.AsyncClient | None = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Open the shared connection pool. Call once at application startup."""
        self._client = httpx.AsyncClient(
            base_url=self._base,
            headers=self._headers,
            timeout=10.0,
        )

    async def stop(self) -> None:
        """Close the connection pool. Call once at application shutdown."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _ensure_started(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError(
                "MediasoupClient is not started. "
                "Ensure sfu.start() is called in the FastAPI lifespan."
            )
        return self._client

    async def _post(self, path: str, body: dict | None = None) -> dict:
        client = self._ensure_started()
        r = await client.post(path, json=body or {})
        r.raise_for_status()
        return r.json()

    async def _get(self, path: str, params: dict | None = None) -> dict:
        client = self._ensure_started()
        r = await client.get(path, params=params or {})
        r.raise_for_status()
        return r.json()

    async def _delete(self, path: str) -> dict:
        client = self._ensure_started()
        r = await client.delete(path)
        r.raise_for_status()
        return r.json()

    # ── Public API ────────────────────────────────────────────────────────────

    async def ensure_room(self, room_id: str) -> dict:
        logger.info("SFU ensure_room  room=%s", room_id)
        result = await self._post(f"/api/rooms/{room_id}/ensure")
        logger.info("SFU ensure_room OK  room=%s", room_id)
        return result

    async def create_transport(
        self, room_id: str, peer_id: str, direction: str
    ) -> dict:
        logger.info("SFU create_transport  room=%s  peer=%s  direction=%s", room_id, peer_id, direction)
        result = await self._post(
            f"/api/rooms/{room_id}/transports",
            {"peerId": peer_id, "direction": direction},
        )
        logger.info("SFU create_transport OK  room=%s  peer=%s  direction=%s  transportId=%s",
                    room_id, peer_id, direction, result.get("transportId"))
        return result

    async def connect_transport(
        self,
        room_id: str,
        peer_id: str,
        transport_id: str,
        dtls_parameters: dict,
    ) -> dict:
        logger.info("SFU connect_transport  room=%s  peer=%s  transportId=%s", room_id, peer_id, transport_id)
        result = await self._post(
            f"/api/rooms/{room_id}/transports/{transport_id}/connect",
            {"peerId": peer_id, "dtlsParameters": dtls_parameters},
        )
        logger.info("SFU connect_transport OK  room=%s  peer=%s  transportId=%s", room_id, peer_id, transport_id)
        return result

    async def produce(
        self,
        room_id: str,
        peer_id: str,
        transport_id: str,
        kind: str,
        rtp_parameters: dict,
        app_data: dict | None = None,
    ) -> dict:
        logger.info("SFU produce  room=%s  peer=%s  kind=%s  transportId=%s", room_id, peer_id, kind, transport_id)
        result = await self._post(
            f"/api/rooms/{room_id}/transports/{transport_id}/produce",
            {
                "peerId": peer_id,
                "kind": kind,
                "rtpParameters": rtp_parameters,
                "appData": app_data or {},
            },
        )
        logger.info("SFU produce OK  room=%s  peer=%s  kind=%s  producerId=%s",
                    room_id, peer_id, kind, result.get("producerId"))
        return result

    async def consume(
        self,
        room_id: str,
        consumer_peer_id: str,
        producer_id: str,
        transport_id: str,
        rtp_capabilities: dict,
    ) -> dict:
        logger.info("SFU consume  room=%s  consumerPeer=%s  producerId=%s  transportId=%s",
                    room_id, consumer_peer_id, producer_id, transport_id)
        result = await self._post(
            f"/api/rooms/{room_id}/consumers",
            {
                "consumerPeerId": consumer_peer_id,
                "producerId": producer_id,
                "transportId": transport_id,
                "rtpCapabilities": rtp_capabilities,
            },
        )
        logger.info("SFU consume OK  room=%s  consumerPeer=%s  consumerId=%s  kind=%s",
                    room_id, consumer_peer_id, result.get("consumerId"), result.get("kind"))
        return result

    async def resume_consumer(
        self, room_id: str, peer_id: str, consumer_id: str
    ) -> dict:
        logger.info("SFU resume_consumer  room=%s  peer=%s  consumerId=%s", room_id, peer_id, consumer_id)
        result = await self._post(
            f"/api/rooms/{room_id}/consumers/{consumer_id}/resume",
            {"peerId": peer_id},
        )
        logger.info("SFU resume_consumer OK  room=%s  peer=%s  consumerId=%s", room_id, peer_id, consumer_id)
        return result

    async def get_producers(self, room_id: str, exclude_peer_id: str) -> dict:
        logger.info("SFU get_producers  room=%s  excludePeer=%s", room_id, exclude_peer_id)
        result = await self._get(
            f"/api/rooms/{room_id}/producers",
            {"excludePeerId": exclude_peer_id},
        )
        logger.info("SFU get_producers OK  room=%s  count=%d", room_id, len(result.get("producers", [])))
        return result

    async def remove_peer(self, room_id: str, peer_id: str) -> None:
        logger.info("SFU remove_peer  room=%s  peer=%s", room_id, peer_id)
        await self._delete(f"/api/rooms/{room_id}/peers/{peer_id}")
        logger.info("SFU remove_peer OK  room=%s  peer=%s", room_id, peer_id)


# Module-level singleton — one shared client per process
sfu = MediasoupClient()
