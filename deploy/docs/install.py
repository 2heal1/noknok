#!/usr/bin/python3
"""Administrator installs a static-only SSH publisher; no sudo or Docker access."""
import argparse
import grp
import importlib.util
import json
import os
from pathlib import Path
import pwd
import sys

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('restricted_install', SOURCE.parent / 'release/install.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
USER = 'noknok-docs'
HOME = Path('/var/lib/noknok-docs-user')
DATA = Path('/var/lib/noknok-docs')
ENTRY = Path('/usr/local/libexec/noknok-docs-ssh')
CODE = Path('/usr/local/lib/noknok-docs/publish.py')
shared.HOME, shared.ENTRY = HOME, ENTRY


def install(args):
    if os.geteuid() != 0:
        raise ValueError('Run as administrator root.')
    os.umask(0o022)
    key = Path(args.public_key)
    for path in (SOURCE, SOURCE.parent / 'release/install.py', key, SOURCE / 'publish.py', SOURCE / ENTRY.name):
        shared.trusted_path(path)
    authorized = shared.public_key(key.read_text())
    for path in (HOME, ENTRY, CODE):
        shared.trusted_path(path, missing=True)
    try:
        account = pwd.getpwnam(USER)
        if (account.pw_uid == 0 or account.pw_dir != str(HOME) or account.pw_shell != '/bin/bash'
                or grp.getgrgid(account.pw_gid).gr_name != USER
                or set(os.getgrouplist(USER, account.pw_gid)) != {account.pw_gid}):
            raise ValueError('Existing docs account is not isolated.')
    except KeyError:
        shared.command('/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', str(HOME), '--shell', '/bin/bash', USER)
        account = pwd.getpwnam(USER)
    shared.command('/usr/sbin/usermod', '--lock', USER)
    shared.check_ssh_policy(shared.command('/usr/sbin/sshd', '-T', '-C', f'user={USER},host=localhost,addr=127.0.0.1').stdout)
    HOME.mkdir(mode=0o755, exist_ok=True)
    HOME.chmod(0o755)
    (HOME / '.ssh').mkdir(mode=0o755, exist_ok=True)
    shared.trusted_path(HOME / '.ssh')
    (HOME / '.ssh').chmod(0o755)
    shared.write_atomic(HOME / '.ssh/authorized_keys', authorized.encode(), 0o644)
    shared.write_atomic(ENTRY, (SOURCE / ENTRY.name).read_bytes(), 0o755)
    shared.write_atomic(CODE, (SOURCE / 'publish.py').read_bytes(), 0o644)
    DATA.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    shared.trusted_path(DATA.parent)
    if DATA.exists() or DATA.is_symlink():
        info = DATA.lstat()
        if DATA.is_symlink() or not DATA.is_dir() or info.st_uid != account.pw_uid or info.st_mode & 0o022:
            raise ValueError('Unexpected docs data directory ownership.')
    else:
        DATA.mkdir(mode=0o755)
        os.chown(DATA, account.pw_uid, account.pw_gid)
    shared.command('/usr/sbin/sshd', '-t')
    print(json.dumps({'status': 'installed', 'user': USER, 'sudo': False, 'dockerAccess': False, 'applicationChanged': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-key', required=True)
    try:
        install(parser.parse_args())
    except (OSError, ValueError, shared.InstallError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
