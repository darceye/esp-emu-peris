#!/usr/bin/env python3
"""
Build the esp-emu-peris release archives for the GitHub release page.

Stages the repository (git-tracked files + the compiled build/ tree) into
dist/package/esp-emu-peris-<version>/ and writes
dist/release/esp-emu-peris-<version>.zip and .tar.gz.

The archives include install.sh / install.bat, which fetch the
esp-emulator browser (wasm) build from espressif/esp-emulator releases —
so a release user needs no local esp-emulator checkout.

Usage: python tools/package_release.py       (run "npm run build" first)
"""
import json
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(REPO, 'dist')
EXTRA_DIRS = ['build']  # not in git, but shipped pre-compiled


def log(msg):
    print(f'[package_release] {msg}', flush=True)


def tracked_files():
    out = subprocess.run(['git', 'ls-files'], cwd=REPO, capture_output=True,
                         text=True, check=True).stdout
    return [line for line in out.splitlines() if line.strip()]


def stage(version):
    stage_root = os.path.join(DIST, 'package')
    stage_dir = os.path.join(stage_root, f'esp-emu-peris-{version}')
    if os.path.isdir(stage_root):
        shutil.rmtree(stage_root)
    os.makedirs(stage_dir)

    files = tracked_files()
    skip = {'.gitignore', '.gitattributes'}  # not meaningful outside a repo
    skip_prefixes = ('.vscode/',)  # IDE prefs carry machine-local paths
    copied = 0
    for rel in files:
        if rel in skip or rel.startswith(skip_prefixes):
            continue
        src = os.path.join(REPO, rel)
        if not os.path.isfile(src):
            continue
        dst = os.path.join(stage_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
    for d in EXTRA_DIRS:
        src = os.path.join(REPO, d)
        if not os.path.isdir(src):
            log(f'warning: {d}/ missing — run "npm run build" first')
            continue
        for root, _dirs, names in os.walk(src):
            for name in names:
                s = os.path.join(root, name)
                rel = os.path.relpath(s, REPO)
                dst = os.path.join(stage_dir, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(s, dst)
                copied += 1
    log(f'staged {copied} files -> {os.path.relpath(stage_dir, REPO)}')
    return stage_dir


def make_zip(stage_dir, dest):
    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, _dirs, names in os.walk(stage_dir):
            for name in sorted(names):
                s = os.path.join(root, name)
                zf.write(s, os.path.relpath(s, os.path.dirname(stage_dir)))
    log(f'wrote {os.path.relpath(dest, REPO)} ({os.path.getsize(dest) // 1024} KiB)')


def make_targz(stage_dir, dest):
    with tarfile.open(dest, 'w:gz') as tf:
        tf.add(stage_dir, arcname=os.path.basename(stage_dir))
    log(f'wrote {os.path.relpath(dest, REPO)} ({os.path.getsize(dest) // 1024} KiB)')


def main():
    with open(os.path.join(REPO, 'package.json'), encoding='utf-8') as f:
        version = json.load(f)['version']
    release_dir = os.path.join(DIST, 'release')
    os.makedirs(release_dir, exist_ok=True)
    stage_dir = stage(version)
    make_zip(stage_dir, os.path.join(release_dir, f'esp-emu-peris-{version}.zip'))
    make_targz(stage_dir, os.path.join(release_dir, f'esp-emu-peris-{version}.tar.gz'))
    log('release archives ready — upload with:')
    log(f'  gh release create v{version} '
        f'dist/release/esp-emu-peris-{version}.zip '
        f'dist/release/esp-emu-peris-{version}.tar.gz')
    return 0


if __name__ == '__main__':
    sys.exit(main())
