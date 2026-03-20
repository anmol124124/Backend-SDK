from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_KNOWN_INSECURE_DEFAULTS = {
    'change-this-in-production',
    'change-this-to-a-very-long-random-secret-key-in-production',
    'change-this-secret-in-production',
    'postgres',
    'guest',
    '',
}


class Settings(BaseSettings):
    # ── App ───────────────────────────────────────────────────────────────
    APP_NAME: str = "WebRTC SaaS Platform"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = False

    # ── PostgreSQL ────────────────────────────────────────────────────────
    POSTGRES_USER: str = "postgres"
    POSTGRES_PASSWORD: str = "postgres"
    POSTGRES_HOST: str = "postgres"
    POSTGRES_PORT: int = 5432
    POSTGRES_DB: str = "webrtc_db"

    @property
    def DATABASE_URL(self) -> str:
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    # ── Redis ─────────────────────────────────────────────────────────────
    REDIS_HOST: str = "redis"
    REDIS_PORT: int = 6379
    REDIS_DB: int = 0
    REDIS_PASSWORD: str = ""

    @property
    def REDIS_URL(self) -> str:
        if self.REDIS_PASSWORD:
            return f"redis://:{self.REDIS_PASSWORD}@{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"
        return f"redis://{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"

    # ── RabbitMQ ──────────────────────────────────────────────────────────
    RABBITMQ_USER: str = "guest"
    RABBITMQ_PASSWORD: str = "guest"
    RABBITMQ_HOST: str = "rabbitmq"
    RABBITMQ_PORT: int = 5672

    @property
    def RABBITMQ_URL(self) -> str:
        return (
            f"amqp://{self.RABBITMQ_USER}:{self.RABBITMQ_PASSWORD}"
            f"@{self.RABBITMQ_HOST}:{self.RABBITMQ_PORT}/"
        )

    # ── mediasoup SFU ─────────────────────────────────────────────────────
    MEDIASOUP_URL: str = "http://mediasoup:3000"
    MEDIASOUP_INTERNAL_SECRET: str = ""

    # ── JWT ───────────────────────────────────────────────────────────────
    JWT_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # ── CORS ──────────────────────────────────────────────────────────────
    # Allow all origins — security is enforced via the domain allowlist in DB.
    # Customers embed the HTML on their own domains so we cannot predict origins.
    CORS_ORIGINS: str = "*"

    @property
    def CORS_ORIGINS_LIST(self) -> list[str]:
        if self.CORS_ORIGINS.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    # ── RSA key pair (RS256) — public meeting tokens ─────────────────────
    # Stored as base64-encoded PEM. Generate with:
    #   python -c "from cryptography.hazmat.primitives.asymmetric import rsa; ..."
    RSA_PRIVATE_KEY: str = ""   # base64(PEM private key)
    RSA_PUBLIC_KEY:  str = ""   # base64(PEM public key)

    # Token TTL for public meeting tokens (hours)
    PUBLIC_HOST_TOKEN_TTL_HOURS:  int = 12
    PUBLIC_GUEST_TOKEN_TTL_HOURS: int = 12

    # ── Public meet frontend URL ──────────────────────────────────────────
    PUBLIC_MEET_URL: str = "https://meet.antier.xyz"

    # ── Backend public URL ────────────────────────────────────────────────
    BACKEND_PUBLIC_URL: str = "http://localhost:8000"

    # ── Secret validation ─────────────────────────────────────────────────
    # Fail at startup if secrets are missing or left as placeholder values.
    # This prevents deploying with known-insecure defaults.
    @model_validator(mode='after')
    def validate_secrets(self) -> 'Settings':
        # Skip strict validation in local dev
        if self.DEBUG:
            return self

        errors = []

        if self.JWT_SECRET_KEY in _KNOWN_INSECURE_DEFAULTS:
            errors.append(
                "JWT_SECRET_KEY is not set. "
                "Generate: python -c \"import secrets; print(secrets.token_hex(32))\""
            )
        if self.MEDIASOUP_INTERNAL_SECRET in _KNOWN_INSECURE_DEFAULTS:
            errors.append(
                "MEDIASOUP_INTERNAL_SECRET is not set. "
                "Generate: python -c \"import secrets; print(secrets.token_hex(32))\""
            )
        if self.POSTGRES_PASSWORD in _KNOWN_INSECURE_DEFAULTS:
            errors.append(
                "POSTGRES_PASSWORD is using a weak default. Set a strong password in .env"
            )
        if self.RABBITMQ_PASSWORD in _KNOWN_INSECURE_DEFAULTS:
            errors.append(
                "RABBITMQ_PASSWORD is using a weak default. Set a strong password in .env"
            )
        if self.RSA_PRIVATE_KEY in _KNOWN_INSECURE_DEFAULTS:
            errors.append(
                "RSA_PRIVATE_KEY is not set. Required for public meeting tokens."
            )
        if self.RSA_PUBLIC_KEY in _KNOWN_INSECURE_DEFAULTS:
            errors.append(
                "RSA_PUBLIC_KEY is not set. Required for public meeting tokens."
            )

        if errors:
            raise ValueError("Insecure configuration detected:\n  " + "\n  ".join(errors))
        return self

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
