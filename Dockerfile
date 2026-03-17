FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Do NOT use --reload in production.
# --reload starts an extra watchdog process, is incompatible with --workers,
# and restarts the server if any file on disk changes.
#
# Single worker is intentional: the in-memory ConnectionManager (WebSocket
# registry) is not shared across processes. To scale horizontally, replace
# ConnectionManager with a Redis pub/sub backend and then raise --workers.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
