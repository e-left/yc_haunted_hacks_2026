#!/usr/bin/env python3
"""Serve the static storefront and expose only its public Supabase settings."""

import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent


def public_config():
    values = {}
    for env_path in (ROOT.parent / ".env.local", ROOT / ".env.local"):
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:]
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"\'')
    return {
        "url": values.get("SUPABASE_URL", "").rstrip("/"),
        "publishableKey": values.get("SUPABASE_PUBLISHABLE_KEY") or values.get("SUPABASE_ANON_KEY", ""),
    }


class StorefrontHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if urlsplit(self.path).path == "/supabase-config.js":
            body = ("window.AMAZOMBIE_SUPABASE = " + json.dumps(public_config()) + ";\n").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Amazombie demo server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.bind, args.port), StorefrontHandler)
    print(f"Amazombie: http://{args.bind}:{args.port}/", flush=True)
    server.serve_forever()
