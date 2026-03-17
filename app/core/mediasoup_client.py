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

import httpx

from app.core.config import settings


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
        """
        Create room if it doesn't exist. Returns router RTP capabilities.
        Call this when a user connects to the WebSocket.
        """
        return await self._post(f"/api/rooms/{room_id}/ensure")

    async def create_transport(
        self, room_id: str, peer_id: str, direction: str
    ) -> dict:
        """
        Create a WebRTC transport for send or recv.
        Returns ice/dtls parameters that the browser needs to create its transport.
        """
        return await self._post(
            f"/api/rooms/{room_id}/transports",
            {"peerId": peer_id, "direction": direction},
        )

    async def connect_transport(
        self,
        room_id: str,
        peer_id: str,
        transport_id: str,
        dtls_parameters: dict,
    ) -> dict:
        """Provide the browser's DTLS fingerprint to complete the transport handshake."""
        return await self._post(
            f"/api/rooms/{room_id}/transports/{transport_id}/connect",
            {"peerId": peer_id, "dtlsParameters": dtls_parameters},
        )

    async def produce(
        self,
        room_id: str,
        peer_id: str,
        transport_id: str,
        kind: str,
        rtp_parameters: dict,
        app_data: dict | None = None,
    ) -> dict:
        """
        Tell mediasoup a browser has started sending a media track.
        Returns producerId.
        """
        return await self._post(
            f"/api/rooms/{room_id}/transports/{transport_id}/produce",
            {
                "peerId": peer_id,
                "kind": kind,
                "rtpParameters": rtp_parameters,
                "appData": app_data or {},
            },
        )

    async def consume(
        self,
        room_id: str,
        consumer_peer_id: str,
        producer_id: str,
        transport_id: str,
        rtp_capabilities: dict,
    ) -> dict:
        """
        Create a consumer so a peer can receive a remote producer's stream.
        Returns consumerId + rtpParameters needed by the browser.
        """
        return await self._post(
            f"/api/rooms/{room_id}/consumers",
            {
                "consumerPeerId": consumer_peer_id,
                "producerId": producer_id,
                "transportId": transport_id,
                "rtpCapabilities": rtp_capabilities,
            },
        )

    async def resume_consumer(
        self, room_id: str, peer_id: str, consumer_id: str
    ) -> dict:
        """Unpauses a consumer — call after the recv transport is confirmed connected."""
        return await self._post(
            f"/api/rooms/{room_id}/consumers/{consumer_id}/resume",
            {"peerId": peer_id},
        )

    async def get_producers(self, room_id: str, exclude_peer_id: str) -> dict:
        """
        Get all active producers in a room (excluding the requesting peer).
        Used on join so the new user can subscribe to existing streams.
        """
        return await self._get(
            f"/api/rooms/{room_id}/producers",
            {"excludePeerId": exclude_peer_id},
        )

    async def remove_peer(self, room_id: str, peer_id: str) -> None:
        """Clean up all transports/producers/consumers for a disconnected peer."""
        await self._delete(f"/api/rooms/{room_id}/peers/{peer_id}")


# Module-level singleton — one shared client per process
sfu = MediasoupClient()
