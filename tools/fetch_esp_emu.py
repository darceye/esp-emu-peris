#!/usr/bin/env python3
"""
Fetch the esp-emulator browser (wasm) build from the espressif/esp-emulator
GitHub releases and unpack it into vendor/esp-emu-browser/www.

- Idempotent: skips the download when the requested version is already in
  place (vendor/esp-emu-browser/VERSION + www/pkg/esp_emu_bg.wasm).
- Verifies the tarball against the release SHA256SUMS asset.
- Honours the standard proxy environment variables
  (https_proxy / HTTPS_PROXY / all_proxy ...), e.g.
      https_proxy=http://127.0.0.1:10809 python tools/fetch_esp_emu.py

Usage: python tools/fetch_esp_emu.py [--version 0.51.0] [--force] [--no-verify]
  version default: 0.51.0 (or env ESP_EMU_VERSION)
  downloaded tarballs are cached in vendor/downloads/ (never re-downloaded)

Afterwards: python serve.py   ->   http://127.0.0.1:8080/esp-emu-peris.html
"""
import argparse
import hashlib
import os
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_VERSION = '0.51.0'
VENDOR_DIR = os.path.join(REPO, 'vendor', 'esp-emu-browser')
CACHE_DIR = os.path.join(REPO, 'vendor', 'downloads')
RETRIES = 3
TIMEOUT = 60


def log(msg):
    print(f'[fetch_esp_emu] {msg}', flush=True)


def build_opener():
    """urllib opener that honours proxy env vars (https_proxy etc.)."""
    proxies = {}
    # explicit env first (works everywhere, incl. Windows without registry proxies)
    for scheme in ('http', 'https', 'all'):
        for var in (f'{scheme}_proxy'.lower(), f'{scheme}_proxy'.upper()):
            val = os.environ.get(var)
            if val:
                proxies.setdefault('https' if scheme == 'all' else scheme, val)
    if not proxies:
        proxies = urllib.request.getproxies()
    return urllib.request.build_opener(urllib.request.ProxyHandler(proxies))


def download(opener, url, dest, retries=RETRIES):
    for attempt in range(1, retries + 1):
        try:
            log(f'downloading {url}')
            with opener.open(url, timeout=TIMEOUT) as resp, open(dest, 'wb') as out:
                total = int(resp.headers.get('Content-Length') or 0)
                done = 0
                while True:
                    chunk = resp.read(1 << 16)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = done * 100 // total
                        print(f'\r  {done // 1024} / {total // 1024} KiB ({pct}%)', end='', flush=True)
            print()
            return True
        except (urllib.error.URLError, OSError) as e:
            log(f'download attempt {attempt}/{retries} failed: {e}')
            if os.path.exists(dest):
                os.remove(dest)
            if attempt < retries:
                time.sleep(2 * attempt)
    return False


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def verify(opener, tarball, version, asset):
    """Check the tarball against the release SHA256SUMS asset (best effort
    by default: a failed SUMS *download* only warns, a hash mismatch fails)."""
    sums_url = (f'https://github.com/espressif/esp-emulator/releases/download/'
                f'v{version}/SHA256SUMS')
    try:
        with opener.open(sums_url, timeout=TIMEOUT) as resp:
            text = resp.read().decode('utf-8', 'replace')
    except (urllib.error.URLError, OSError) as e:
        log(f'warning: could not fetch SHA256SUMS ({e}); skipping verification')
        return True
    want = None
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == asset:
            want = parts[0]
            break
    if want is None:
        log(f'warning: {asset} not listed in SHA256SUMS; skipping verification')
        return True
    got = sha256_of(tarball)
    if got != want:
        log(f'error: sha256 mismatch for {asset}\n  want {want}\n  got  {got}')
        return False
    log(f'sha256 ok ({want[:16]}…)')
    return True


def safe_extract(tar, dest):
    try:
        tar.extractall(dest, filter='data')  # Python 3.12+
        return
    except TypeError:
        pass
    # older Pythons: reject absolute paths and .. escapes manually
    base = os.path.abspath(dest)
    for m in tar.getmembers():
        target = os.path.abspath(os.path.join(dest, m.name))
        if not target.startswith(base + os.sep) and target != base:
            raise RuntimeError(f'unsafe path in archive: {m.name}')
    tar.extractall(dest)


def move_tree(src, dst):
    """Directory rename with retries: Windows Defender/indexer transiently
    locks freshly extracted files (WinError 5); copy+delete as a fallback."""
    for attempt in range(4):
        try:
            os.rename(src, dst)
            return
        except OSError:
            time.sleep(0.5 * (attempt + 1))
    shutil.copytree(src, dst, dirs_exist_ok=True)
    shutil.rmtree(src, ignore_errors=True)


def install(tarball, version):
    """Unpack <root>/esp-emu-<ver>-wasm/www into vendor/esp-emu-browser/www."""
    vendor_parent = os.path.join(REPO, 'vendor')
    staging = os.path.join(vendor_parent, f'.staging-{int(time.time())}')
    old = os.path.join(VENDOR_DIR, 'www.old')
    target = os.path.join(VENDOR_DIR, 'www')
    os.makedirs(staging, exist_ok=True)
    with tarfile.open(tarball, 'r:gz') as tar:
        safe_extract(tar, staging)
    inner = os.path.join(staging, f'esp-emu-{version}-wasm', 'www')
    if not os.path.isfile(os.path.join(inner, 'pkg', 'esp_emu_bg.wasm')):
        shutil.rmtree(staging, ignore_errors=True)
        raise RuntimeError(f'unexpected archive layout: {inner}/pkg missing')
    os.makedirs(VENDOR_DIR, exist_ok=True)
    if os.path.isdir(old):
        shutil.rmtree(old, ignore_errors=True)
    if os.path.isdir(target):
        move_tree(target, old)
    try:
        move_tree(inner, target)
    except OSError:
        if os.path.isdir(old) and not os.path.isdir(target):  # best-effort restore
            move_tree(old, target)
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    shutil.rmtree(old, ignore_errors=True)
    with open(os.path.join(VENDOR_DIR, 'VERSION'), 'w', encoding='utf-8') as f:
        f.write(f'{version}\n')
    log(f'installed esp-emulator browser {version} -> '
        f'{os.path.relpath(target, REPO).replace(os.sep, "/")}')


def already_installed(version):
    return (os.path.isfile(os.path.join(VENDOR_DIR, 'VERSION'))
            and open(os.path.join(VENDOR_DIR, 'VERSION'), encoding='utf-8').read().strip() == version
            and os.path.isfile(os.path.join(VENDOR_DIR, 'www', 'pkg', 'esp_emu_bg.wasm')))


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--version', default=os.environ.get('ESP_EMU_VERSION', DEFAULT_VERSION),
                    help=f'esp-emulator release tag without "v" (default {DEFAULT_VERSION})')
    ap.add_argument('--force', action='store_true', help='re-download/re-extract even if present')
    ap.add_argument('--no-verify', action='store_true', help='skip sha256 verification')
    args = ap.parse_args()

    version = args.version.strip().lstrip('vV')
    asset = f'esp-emu-{version}-wasm.tar.gz'
    url = (f'https://github.com/espressif/esp-emulator/releases/download/'
           f'v{version}/{asset}')

    if already_installed(version) and not args.force:
        log(f'esp-emulator browser {version} already present '
            f'(vendor/esp-emu-browser) — nothing to do')
        return 0

    os.makedirs(CACHE_DIR, exist_ok=True)
    tarball = os.path.join(CACHE_DIR, asset)
    opener = build_opener()

    if os.path.isfile(tarball) and not args.force:
        log(f'using cached {os.path.relpath(tarball, REPO)}')
    else:
        if not download(opener, url, tarball):
            log(f'error: download failed after {RETRIES} attempts '
                f'(behind a firewall? set https_proxy=… and retry)')
            return 1
    if not args.no_verify and not verify(opener, tarball, version, asset):
        os.remove(tarball)
        return 1
    try:
        install(tarball, version)
    except (RuntimeError, tarfile.TarError, OSError) as e:
        log(f'error: extraction failed: {e}')
        return 1
    log('next: python serve.py  ->  http://127.0.0.1:8080/esp-emu-peris.html')
    return 0


if __name__ == '__main__':
    sys.exit(main())
