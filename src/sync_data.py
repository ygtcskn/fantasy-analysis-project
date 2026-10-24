"""Copy the project's data between this computer and Cloudflare R2.

GitHub Actions keeps fantezianaliz.com up to date without this computer
(.github/workflows/update-site.yml). R2 holds the data between its runs and is
the main copy; this is how GitHub and this computer read and write it.

    python src/sync_data.py pull                 # R2 -> here
    python src/sync_data.py push                 # here -> R2
    python src/sync_data.py push --path data/final/tff_fantasy   # after a TFF export
    python src/sync_data.py pull --dry-run       # only list what would change

Without --path, both directions cover data/final and the update history in
data/temp/site_update. A file is copied when the other side lacks it or its
content differs (compared by MD5, which R2 reports for files uploaded whole).
push also leaves a file alone when the R2 copy is newer than this one, so a
computer that has not pulled for a while cannot overwrite newer results;
--force uploads it anyway. Nothing is ever deleted on either side.

Needs boto3 (pip install boto3) and, in the environment or .env, R2_ACCOUNT_ID,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET. Their values are never printed.
"""

import argparse
import hashlib
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.fetch.sportmonks import local_setting  # noqa: E402


DEFAULT_PATHS = ("data/final", "data/temp/site_update")
SETTINGS = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
# Every file goes up in one piece, so R2's ETag is its MD5 and comparisons work.
# The largest file is a few MB; anything bigger than this would need another rule.
SINGLE_PART_LIMIT = 256 * 1024 * 1024


def settings():
    values = {name: local_setting(name) for name in SETTINGS}
    missing = [name for name, value in values.items() if not value]
    if missing and os.environ.get("GITHUB_ACTIONS") == "true":
        # The workflow fills these from repository secrets, R2_ACCOUNT_ID from
        # CLOUDFLARE_ACCOUNT_ID and R2_BUCKET from the workflow itself, or from
        # NAME=value lines in the one FANTEZI_ANALIZ_SECRET secret.
        secrets = sorted({"R2_ACCOUNT_ID": "CLOUDFLARE_ACCOUNT_ID"}.get(name, name) for name in missing)
        raise SystemExit(f"Missing settings: {', '.join(missing)}. Add repository secrets {', '.join(secrets)} "
                         "under Settings -> Secrets and variables -> Actions -> Secrets, or put "
                         f"{', '.join(name + '=...' for name in missing)} lines in FANTEZI_ANALIZ_SECRET.")
    if missing:
        raise SystemExit(f"Add {', '.join(missing)} to the environment or the project .env file.")
    return values


def storage(values):
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        raise SystemExit("Install boto3 first: pip install boto3") from None
    return boto3.client(
        "s3", endpoint_url=f"https://{values['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=values["R2_ACCESS_KEY_ID"], aws_secret_access_key=values["R2_SECRET_ACCESS_KEY"],
        region_name="auto", config=Config(retries={"max_attempts": 5, "mode": "standard"}))


def checked_key(key):
    """A bucket key as a path in this project, refusing anything that could land outside data/."""
    target = (ROOT / key).resolve()
    if not key.startswith("data/") or ".." in Path(key).parts or not target.is_relative_to(ROOT / "data"):
        raise SystemExit(f"Refusing a file outside data/: {key}")
    return target


def md5_of(path):
    digest = hashlib.md5()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def local_files(scope):
    """Project-relative keys of the files under scope (a folder or one file)."""
    base = ROOT / scope
    if base.is_file():
        return {scope: base}
    if not base.is_dir():
        return {}
    return {path.relative_to(ROOT).as_posix(): path for path in sorted(base.rglob("*")) if path.is_file()}


def remote_files(client, bucket, scope):
    """Keys under scope in the bucket: (MD5, or None for one uploaded in parts; when last written)."""
    found = {}
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=scope):
        for item in page.get("Contents", []):
            key = item["Key"]
            if key == scope or key.startswith(scope.rstrip("/") + "/"):
                etag = item["ETag"].strip('"')
                found[key] = (None if "-" in etag else etag, item["LastModified"].timestamp())
    return found


def push(client, bucket, scopes, dry_run, force=False):
    from boto3.s3.transfer import TransferConfig
    transfer = TransferConfig(multipart_threshold=SINGLE_PART_LIMIT)
    sent = same = kept = size = 0
    for scope in scopes:
        remote = remote_files(client, bucket, scope)
        for key, path in local_files(scope).items():
            checked_key(key)
            etag, written = remote.get(key, (None, None))
            if etag and etag == md5_of(path):
                same += 1
                continue
            if written is not None and path.stat().st_mtime <= written and not force:
                kept += 1
                print(f"keep R2's newer {key} (pull first, or --force)")
                continue
            sent += 1
            size += path.stat().st_size
            print(f"{'would upload' if dry_run else 'upload'} {key}")
            if not dry_run:
                client.upload_file(str(path), bucket, key, Config=transfer)
    print(f"{'Would upload' if dry_run else 'Uploaded'} {sent} files ({size / 1024 / 1024:.1f} MB); "
          f"{same} already in R2; {kept} newer in R2, left alone.")


def pull(client, bucket, scopes, dry_run):
    got = same = 0
    for scope in scopes:
        for key, (etag, _) in remote_files(client, bucket, scope).items():
            target = checked_key(key)
            if target.is_file() and etag and md5_of(target) == etag:
                same += 1
                continue
            got += 1
            print(f"{'would download' if dry_run else 'download'} {key}")
            if dry_run:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            # Written beside the target and then swapped in, so an interrupted
            # download never leaves half a file where a whole one was.
            partial = target.with_name(f".{target.name}.partial")
            client.download_file(bucket, key, str(partial))
            os.replace(partial, target)
    print(f"{'Would download' if dry_run else 'Downloaded'} {got} files; {same} already up to date here.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("direction", choices=("pull", "push"))
    parser.add_argument("--path", action="append", dest="paths",
                        help="A folder or file under data/, relative to the project. Repeat for more. "
                             f"Default: {', '.join(DEFAULT_PATHS)}.")
    parser.add_argument("--dry-run", action="store_true", help="Only list what would be copied.")
    parser.add_argument("--force", action="store_true", help="push: upload even files whose R2 copy is newer.")
    args = parser.parse_args()
    scopes = [path.replace("\\", "/").strip("/") for path in (args.paths or DEFAULT_PATHS)]
    for scope in scopes:
        if not scope.startswith("data/") or ".." in scope.split("/"):
            parser.error(f"--path must be under data/: {scope}")
    values = settings()
    client = storage(values)
    if args.direction == "push":
        push(client, values["R2_BUCKET"], scopes, args.dry_run, args.force)
    else:
        pull(client, values["R2_BUCKET"], scopes, args.dry_run)


if __name__ == "__main__":
    main()
