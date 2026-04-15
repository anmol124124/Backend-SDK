from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings

# Uses Redis as backing store so limits are shared across multiple workers.
# Falls back to in-memory if Redis URL is unavailable.
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=settings.REDIS_URL,
    default_limits=[],
)
