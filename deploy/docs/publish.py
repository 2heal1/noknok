#!/usr/bin/python3
"""Unprivileged forced SSH command: receive only a bounded static-site archive."""
import fcntl
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import tempfile
import zlib
from datetime import datetime, timezone

ROOT = Path('/var/lib/noknok-docs')
MAX_ARCHIVE = 16 * 1024 * 1024
MAX_CONTENT = 64 * 1024 * 1024
MAX_FILES = 5000


def validate_archive(data):
    if len(data) > MAX_ARCHIVE:
        raise ValueError('Archive exceeds the upload limit.')
    files = []
    total = 0
    names = set()
    inflater = zlib.decompressobj(31)
    unpacked = inflater.decompress(data, MAX_CONTENT + MAX_FILES * 2048 + 1)
    if inflater.unconsumed_tail or inflater.unused_data or not inflater.eof:
        raise ValueError('Invalid, concatenated or oversized compressed archive.')
    with tarfile.open(fileobj=io.BytesIO(unpacked), mode='r:') as archive:
        count = 0
        for member in archive:
            count += 1
            if count > MAX_FILES:
                raise ValueError('Too many archive entries.')
            name = member.name
            while name.startswith('./'):
                name = name[2:]
            if name in ('', '.') and member.isdir():
                continue
            path = PurePosixPath(name)
            if (not name or len(name) > 512 or path.is_absolute() or '\\' in name
                    or any(ord(char) < 32 or ord(char) == 127 for char in name)
                    or any(part.startswith('.') for part in path.parts)
                    or name in names or name == '_noknok_deployment.json'
                    or not (member.isfile() or member.isdir())):
                raise ValueError('Unsafe or duplicate archive entry.')
            names.add(name)
            if member.isdir():
                continue
            total += member.size
            if member.size < 0 or total > MAX_CONTENT:
                raise ValueError('Expanded website exceeds its limit.')
            stream = archive.extractfile(member)
            content = stream.read(member.size + 1)
            if len(content) != member.size:
                raise ValueError('Truncated archive entry.')
            files.append((path, content))
    if 'index.html' not in names or 'guide/getting-started.html' not in names:
        raise ValueError('Expected the complete Rspress website.')
    return files


def publish(revision, data):
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('A complete commit SHA is required.')
    files = validate_archive(data)
    releases = ROOT / 'releases'
    releases.mkdir(mode=0o755, exist_ok=True)
    with (ROOT / 'publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stage = Path(tempfile.mkdtemp(prefix=revision + '-', dir=releases))
        stage.chmod(0o755)
        try:
            for path, content in files:
                destination = stage / str(path)
                destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                destination.write_bytes(content)
                destination.chmod(0o644)
            marker = {'revision': revision, 'publishedAt': datetime.now(timezone.utc).isoformat()}
            (stage / '_noknok_deployment.json').write_text(json.dumps(marker) + '\n')
            current = ROOT / 'current'
            if current.exists() and not current.is_symlink():
                raise ValueError('Current website must be a deployment symlink.')
            previous = os.readlink(current) if current.is_symlink() else None
            # Prepare state before activation; on failure the old website remains.
            state = {**marker, 'directory': stage.name, 'previous': previous}
            temporary = ROOT / 'state.next.json'
            temporary.write_text(json.dumps(state) + '\n')
            next_link = ROOT / 'current.next'
            next_link.unlink(missing_ok=True)
            next_link.symlink_to(Path('releases') / stage.name)
            os.replace(next_link, current)
            os.replace(temporary, ROOT / 'state.json')
            return {'status': 'published', 'revision': revision}
        except BaseException:
            if (ROOT / 'current').is_symlink() and (ROOT / 'current').resolve() == stage:
                if previous:
                    rollback = ROOT / 'current.rollback'
                    rollback.unlink(missing_ok=True)
                    rollback.symlink_to(previous)
                    os.replace(rollback, ROOT / 'current')
                else:
                    (ROOT / 'current').unlink()
            # Never remove the target if activation already happened.
            if not (ROOT / 'current').is_symlink() or (ROOT / 'current').resolve() != stage:
                shutil.rmtree(stage)
            raise


def main():
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    match = re.fullmatch(r'docs ([a-f0-9]{40})', command)
    if len(sys.argv) != 1 or not match:
        print('Only docs <full commit SHA> is allowed.', file=sys.stderr)
        return 64
    try:
        os.umask(0o022)
        print(json.dumps(publish(match[1], sys.stdin.buffer.read(MAX_ARCHIVE + 1))))
        return 0
    except (OSError, ValueError, tarfile.TarError, zlib.error):
        print('Static website upload rejected; previous website remains available.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
