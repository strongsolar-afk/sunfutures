from __future__ import annotations

import os
from pathlib import Path
from typing import BinaryIO, Optional, Dict, Any

import boto3

UPLOAD_DIR = Path(os.environ.get("SUNFUTURES_UPLOAD_DIR", "./data/uploads")).resolve()
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

S3_BUCKET = os.environ.get("SUNFUTURES_S3_BUCKET")  # if set, store uploads in S3
S3_PREFIX = os.environ.get("SUNFUTURES_S3_PREFIX", "uploads/")
S3_REGION = os.environ.get("SUNFUTURES_S3_REGION")
S3_ENDPOINT_URL = os.environ.get("SUNFUTURES_S3_ENDPOINT_URL")  # optional for R2/MinIO

def _s3():
    if not S3_BUCKET:
        return None
    return boto3.client("s3", region_name=S3_REGION, endpoint_url=S3_ENDPOINT_URL)

def put_bytes(file_id: str, filename: str, data: bytes) -> Dict[str, Any]:
    safe_name = Path(filename).name
    if S3_BUCKET:
        key = f"{S3_PREFIX}{file_id}__{safe_name}"
        s3 = _s3()
        assert s3 is not None
        s3.put_object(Bucket=S3_BUCKET, Key=key, Body=data)
        return {"backend": "s3", "bucket": S3_BUCKET, "key": key}
    out_path = UPLOAD_DIR / f"{file_id}__{safe_name}"
    out_path.write_bytes(data)
    return {"backend": "local", "path": str(out_path)}

def get_bytes(file_id: str, filename: str) -> Optional[bytes]:
    safe_name = Path(filename).name
    if S3_BUCKET:
        key = f"{S3_PREFIX}{file_id}__{safe_name}"
        s3 = _s3()
        assert s3 is not None
        try:
            obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
            return obj["Body"].read()
        except Exception:
            return None
    out_path = UPLOAD_DIR / f"{file_id}__{safe_name}"
    if not out_path.exists():
        return None
    return out_path.read_bytes()
