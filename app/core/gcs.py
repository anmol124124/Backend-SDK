"""
Google Cloud Storage upload helper.

Usage:
    from app.core.gcs import upload_to_gcs

    public_url = await upload_to_gcs(content_bytes, "recordings/filename.webm", "video/webm")
"""

import asyncio
import json
import logging
from functools import lru_cache

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _get_gcs_client():
    """Build and cache a GCS client from the service-account JSON in settings."""
    from google.cloud import storage
    from google.oauth2 import service_account
    from app.core.config import settings

    sa_json = settings.GCS_SERVICE_ACCOUNT_JSON
    if not sa_json:
        raise RuntimeError("GCS_SERVICE_ACCOUNT_JSON is not configured")

    sa_info = json.loads(sa_json)
    credentials = service_account.Credentials.from_service_account_info(
        sa_info,
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    return storage.Client(credentials=credentials, project=sa_info.get("project_id"))


async def upload_to_gcs(
    content: bytes,
    blob_name: str,
    content_type: str = "video/webm",
) -> str:
    """
    Upload *content* to GCS and return its public HTTPS URL.

    Runs the blocking GCS SDK call in a thread-pool executor so it does not
    block the asyncio event loop.
    """
    from app.core.config import settings

    def _upload() -> str:
        client = _get_gcs_client()
        bucket = client.bucket(settings.GCS_BUCKET_NAME)
        blob = bucket.blob(blob_name)
        blob.upload_from_string(content, content_type=content_type)
        # Make the object publicly readable
        blob.make_public()
        return blob.public_url

    loop = asyncio.get_running_loop()
    public_url = await loop.run_in_executor(None, _upload)
    logger.info("GCS upload complete  blob=%s  url=%s", blob_name, public_url)
    return public_url
