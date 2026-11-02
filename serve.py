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
       — when the default www/pkg is missing it is fetched automatically
       from the espressif/esp-emulator release (tools/fetch_esp_emu.py)
"""
import argparse
import os
import subprocess
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
    default_www = os.path.normpath(
        os.path.join(REPO, 'vendor', 'esp-emu-browser', 'www'))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('port', nargs='?', type=int, default=8080)
    ap.add_argument('--www', default=None,
                    help='esp-emu-browser www directory (default: vendor/esp-emu-browser/www,'
                         ' auto-fetched from the esp-emulator release when missing)')
    args = ap.parse_args()

    www = os.path.normpath(args.www or os.environ.get('ESP_EMU_WWW') or default_www)
    if not os.path.isdir(os.path.join(www, 'pkg')):
        if www == default_www:
            # self-bootstrap: pull the esp-emulator browser build on demand
            print(f'{www}/pkg not found — fetching the esp-emulator browser build first ...')
            try:
                rc = subprocess.call([sys.executable,
                                      os.path.join(REPO, 'tools', 'fetch_esp_emu.py')])
            except OSError as e:
                rc = f'tools/fetch_esp_emu.py failed to start: {e}'
            if rc != 0 or not os.path.isdir(os.path.join(www, 'pkg')):
                sys.exit(f'error: fetch failed ({rc}) — run '
                         f'"python tools/fetch_esp_emu.py" manually and retry')
        else:
            sys.exit(f'error: {www}/pkg not found — run "python tools/fetch_esp_emu.py" '
                     f'(default location) or pass --www /path/to/esp-emu-browser/www')
    Handler.www_dir = www

    url = f'http://127.0.0.1:{args.port}/esp-emu-peris.html'
    print(f'serving repo  : {REPO}')
    print(f'serving /pkg  : {www}/pkg')
    print(f'open          : {url}')
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
