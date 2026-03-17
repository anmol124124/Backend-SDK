import aio_pika
from aio_pika.abc import AbstractRobustConnection

from app.core.config import settings

_connection: AbstractRobustConnection | None = None


async def init_rabbitmq() -> AbstractRobustConnection:
    global _connection
    _connection = await aio_pika.connect_robust(settings.RABBITMQ_URL)
    return _connection


async def close_rabbitmq() -> None:
    global _connection
    if _connection is not None and not _connection.is_closed:
        await _connection.close()
        _connection = None


def get_rabbitmq() -> AbstractRobustConnection:
    if _connection is None:
        raise RuntimeError("RabbitMQ connection not initialised — call init_rabbitmq() first")
    return _connection


# ── Convenience helpers (used by modules when publishing events) ──────────────

async def publish_event(exchange_name: str, routing_key: str, body: bytes) -> None:
    """Fire-and-forget event publisher.  Modules call this; no direct aio_pika imports needed."""
    conn = get_rabbitmq()
    async with conn.channel() as channel:
        exchange = await channel.declare_exchange(
            exchange_name, aio_pika.ExchangeType.TOPIC, durable=True
        )
        await exchange.publish(
            aio_pika.Message(body=body, content_type="application/json"),
            routing_key=routing_key,
        )
