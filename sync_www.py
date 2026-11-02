#!/usr/bin/env python3
"""
Publish esp-emu-peris into an esp-emu-browser www directory: copies the
entry HTML, the peris/ tree and examples/. Existing stock files
(index.html, app.js, worker.js, pkg/) are never touched.

Usage: python sync_www.py [--www PATH] [--clean]
       default www vendor/esp-emu-browser/www (fetched from the
       espressif/esp-emulator release by tools/fetch_esp_emu.py)
       --clean removes a previously synced peris/ from www first
"""
import argparse
import os
import shutil

REPO = os.path.dirname(os.path.abspath(__file__))
ITEMS = ['esp-emu-peris.html', 'build', 'peris', 'examples']


def sync(www, clean=False):
    ok = True
    for name in ITEMS:
        src = os.path.join(REPO, name)
        dst = os.path.join(www, name)
        if not os.path.exists(src):
            print(f'skip (missing in repo): {name}')
            continue
        if clean and os.path.isdir(dst):
            shutil.rmtree(dst)
        try:
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
            print(f'copied: {name}')
        except OSError as e:
            print(f'FAILED: {name}: {e}')
            ok = False
    return ok


def main():
    default_www = os.environ.get(
        'ESP_EMU_WWW',
        os.path.normpath(os.path.join(REPO, 'vendor', 'esp-emu-browser', 'www')))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--www', default=default_www, help='esp-emu-browser www directory')
    ap.add_argument('--clean', action='store_true', help='remove old peris/ in www before copying')
    args = ap.parse_args()

    if not os.path.isdir(args.www):
        raise SystemExit(f'error: {args.www} is not a directory')
    ok = sync(args.www, args.clean)
    print('done' if ok else 'done with errors')
    raise SystemExit(0 if ok else 1)


if __name__ == '__main__':
    main()
