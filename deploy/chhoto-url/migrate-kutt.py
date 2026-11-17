"""Convert a private Kutt SQLite snapshot to a NEW Chhoto 7.11.4 database.

Never modifies the source. Never prints URL targets or credential values.
The application creates its own FTS tables and indices on first startup.
"""
import argparse
import datetime
import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit

SCHEMA = """
CREATE TABLE urls (
  id INTEGER PRIMARY KEY,
  short_url TEXT NOT NULL,
  long_url TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  expiry_time DATETIME,
  enabled BOOL NOT NULL DEFAULT TRUE,
  notes TEXT
);
CREATE UNIQUE INDEX idx_short_url ON urls(short_url);
PRAGMA user_version = 5;
PRAGMA application_id = 1667786868;
"""


def expiry_epoch(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value / 1000 if value > 10_000_000_000 else value)
    date = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if date.tzinfo is None:
        date = date.replace(tzinfo=datetime.timezone.utc)
    return int(date.timestamp())


def read_rows(source):
    with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Source database integrity check failed")
        rows = list(conn.execute("SELECT * FROM links ORDER BY id"))
    result = []
    for row in rows:
        # Do not silently remove per-link access protection or custom domains.
        if row["password"] or row["domain_id"] is not None:
            raise ValueError("Unsupported protected or custom-domain link; source unchanged")
        slug = row["address"]
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", slug) or slug in {"api", "admin", "oidc"}:
            raise ValueError("Unsupported or reserved short code; source unchanged")
        if urlsplit(row["target"]).scheme not in {"http", "https", "ftp", "magnet"}:
            raise ValueError("Unsupported target protocol; source unchanged")
        result.append((slug, row["target"], int(row["visit_count"] or 0),
                       expiry_epoch(row["expire_in"]), not bool(row["banned"]), row["description"]))
    return result


def migrate(source, destination):
    source, destination = Path(source), Path(destination)
    rows = read_rows(source)
    # Exclusive creation avoids replacing any existing migration or live database.
    with destination.open("xb"):
        pass
    try:
        with closing(sqlite3.connect(destination)) as conn:
            conn.executescript(SCHEMA)
            conn.executemany("INSERT INTO urls(short_url,long_url,hits,expiry_time,enabled,notes) VALUES(?,?,?,?,?,?)", rows)
            stored = list(conn.execute("SELECT short_url,long_url,hits,expiry_time,enabled,notes FROM urls ORDER BY id"))
            if stored != rows or conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Migration verification failed")
            conn.commit()
        return {"links": len(rows), "target_bytes_verified": True, "source_unchanged": True}
    except Exception:
        destination.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(migrate(args.source, args.destination)))
    except Exception:
        raise SystemExit("Migration failed; source unchanged. Inspect schema and unsupported link features without printing targets.")
