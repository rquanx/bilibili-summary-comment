"""Generate the local UI core from the pinned, already installed image (no network)."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
source = subprocess.check_output([
    "docker", "run", "--rm", "--pull=never", "--network=none", "--entrypoint=cat",
    "privatebin/nginx-fpm-alpine@sha256:9f808790567ef99454319cfd0e056a09c3aff1d496033d1d58fa07e5ad8a268e",
    "/var/www/js/privatebin.js",
]).decode("utf-8")
needle = "CryptTool.base58encode(data.encryptionKey),"
if source.count(needle) != 1:
    raise RuntimeError("Pinned upstream link builder changed; review before applying")
source = source.replace(needle, "CryptTool.base58encode(data.encryptionKey) + window.PrivateBinReader.shareSuffix(),")
(root / ".runtime").mkdir(exist_ok=True)
(root / ".runtime" / "privatebin-reader-core.js").write_text(source, encoding="utf-8")
