#!/usr/bin/env python3
"""
esp-emu-peris dev server.

Serves this repository (the peris UI) merged with the stock esp-emulator
browser bundle, so the page can load /pkg/esp_emu.js + wasm from the
tools checkout without copying anything into it.

Routes:
    /pkg/*                      -> <www>/pkg/*
    everything else             -> this repository

Usage: python serve.py [port] [--www PATH]
       default port 8080, default www vendor/esp-emu-browser/www
       (fetched from the espressif/esp-emulator release by
        tools/fetch_esp_emu.py — npm run build does that automatically)
"""
import argparse
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

REPO = os.path.dirname(os.path.abspath(__file__))

MIME = {
    '.wasm': 'application/wasm',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
}


class Handler(SimpleHTTPRequestHandler):
    www_dir = REPO  # class attribute set in main()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext, super().guess_type(path))

    def translate_path(self, path):
        path = unquote(urlparse(path).path)
        if path.startswith('/pkg/'):
            rel = os.path.relpath(os.path.join(self.www_dir, path.lstrip('/')), self.www_dir)
            if not rel.startswith('..'):
                return os.path.join(self.www_dir, rel)
        # serve repository files (and only those) for everything else
        rel = os.path.relpath(os.path.join(REPO, path.lstrip('/')), REPO)
        if rel.startswith('..'):
            self.send_error(403, 'outside root')
            return os.devnull
        return os.path.join(REPO, rel)


def main():
    default_www = os.environ.get(
        'ESP_EMU_WWW',
        os.path.normpath(os.path.join(REPO, 'vendor', 'esp-emu-browser', 'www')))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('port', nargs='?', type=int, default=8080)
    ap.add_argument('--www', default=default_www, help='esp-emu-browser www directory')
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(args.www, 'pkg')):
        print(f'error: {args.www}/pkg not found — run "python tools/fetch_esp_emu.py" '
              f'(or "npm run build") first, or pass --www /path/to/esp-emu-browser/www',
              file=sys.stderr)
        sys.exit(1)
    Handler.www_dir = args.www

    url = f'http://127.0.0.1:{args.port}/esp-emu-peris.html'
    print(f'serving repo  : {REPO}')
    print(f'serving /pkg  : {args.www}/pkg')
    print(f'open          : {url}')
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
