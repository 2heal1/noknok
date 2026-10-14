#!/usr/bin/python3
"""Install the reviewed fixed deployment entry points; never deploy an app."""
import argparse
import base64
import fcntl
import grp
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import struct
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve().parent
USER = 'noknok-deploy'
HOME = Path('/var/lib/noknok-deploy-user')
BUNDLE = Path('/usr/local/lib/noknok-deploy')
CONFIG = Path('/etc/noknok/deploy.json')
DATA = Path('/var/lib/noknok-deploy')
ENTRY = Path('/usr/local/libexec/noknok-deploy-ssh')
WRAPPER = Path('/usr/local/sbin/noknok-release-deploy')
SUDOERS = Path('/etc/sudoers.d/noknok-deploy')


class InstallError(Exception):
    pass


def trusted_path(path, *, missing=False):
    """Reject symlinks and writable ancestors, allowing the root sticky /tmp."""
    if not path.is_absolute() or '..' in path.parts:
        raise InstallError('Installation inputs must be absolute paths without traversal.')
    for current in [*reversed(path.parents), path]:
        try:
            info = current.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise InstallError(f'Missing installation input: {current}')
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
            raise InstallError(f'Path must be root-owned and not a symlink: {current}')
        sticky_tmp = current == Path('/tmp') and stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX
        if info.st_mode & 0o022 and not sticky_tmp:
            raise InstallError(f'Path is writable by non-root users: {current}')


def command(*args, allow_failure=False):
    result = subprocess.run(args, capture_output=True, text=True, timeout=180,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'})
    if result.returncode and not allow_failure:
        raise InstallError(f'{Path(args[0]).name} failed: {result.stderr.strip()[:1000]}')
    return result


def public_key(text):
    lines = text.strip().splitlines()
    parts = lines[0].split() if len(lines) == 1 else []
    if len(parts) < 2 or parts[0] != 'ssh-ed25519':
        raise InstallError('Provide exactly one OpenSSH Ed25519 public key, not a private key or authorized_keys options.')
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except ValueError as error:
        raise InstallError('Invalid public-key encoding.') from error
    if blob[:4] != struct.pack('>I', 11) or blob[4:15] != b'ssh-ed25519' or blob[15:19] != struct.pack('>I', 32) or len(blob) != 51:
        raise InstallError('Invalid Ed25519 public key.')
    return f'restrict,command="{ENTRY}" ssh-ed25519 {parts[1]} noknok-ci\n'


def check_ssh_policy(output):
    settings = {}
    accepted_env = []
    for line in output.splitlines():
        name, _, value = line.partition(' ')
        settings[name] = value.strip()
        if name == 'acceptenv':
            accepted_env.extend(value.split())
    expected = {'pubkeyauthentication': 'yes', 'authorizedkeyscommand': 'none', 'trustedusercakeys': 'none',
                'authorizedprincipalscommand': 'none', 'authorizedprincipalsfile': 'none', 'forcecommand': 'none',
                'hostbasedauthentication': 'no', 'gssapiauthentication': 'no', 'passwordauthentication': 'no', 'usepam': 'yes',
                'kbdinteractiveauthentication': 'no', 'permituserenvironment': 'no'}
    if any(settings.get(name) != value for name, value in expected.items()):
        raise InstallError('SSH has additional authentication/startup policy; review it before installing this key-only account.')
    allowed = {'.ssh/authorized_keys', '.ssh/authorized_keys2', str(HOME / '.ssh' / 'authorized_keys')}
    key_files = settings.get('authorizedkeysfile', '').split()
    if not key_files or any(path not in allowed for path in key_files) or key_files == ['.ssh/authorized_keys2']:
        raise InstallError('SSH must use the protected deployment home authorized_keys file.')
    if any(name not in ('LANG', 'LANGUAGE', 'LC_*') for name in accepted_env):
        raise InstallError('SSH accepts environment variables beyond the supported locale-only policy.')
    if (HOME / '.ssh' / 'authorized_keys2').exists() or (HOME / '.ssh' / 'authorized_keys2').is_symlink():
        raise InstallError('Remove/review additional authorized_keys2 before installing the single restricted key.')


def write_atomic(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    trusted_path(path, missing=True)
    fd, temporary = tempfile.mkstemp(prefix='.noknok-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(args):
    if os.geteuid() != 0:
        raise InstallError('Run the installer as root.')
    os.umask(0o022)
    key_path, config_path = Path(args.public_key), Path(args.config)
    for path in (key_path, config_path, SOURCE):
        trusted_path(path)
    authorized = public_key(key_path.read_text())
    caddy = SOURCE / 'Caddyfile.hosted'
    if not caddy.exists():
        caddy = SOURCE.parent / 'Caddyfile.hosted'
    files = {BUNDLE / name: (SOURCE / name, 0o644) for name in ('Dockerfile.release', 'fetch-package.ts', 'compose.release.yaml')}
    files.update({BUNDLE / 'Caddyfile.hosted': (caddy, 0o644), ENTRY: (SOURCE / 'noknok-deploy-ssh', 0o755),
                  WRAPPER: (SOURCE / 'noknok-release-deploy.py', 0o755)})
    for source, _mode in files.values():
        trusted_path(source)
    trusted_path(SOURCE / 'noknok-deploy.sudoers')
    targets = [BUNDLE, ENTRY, WRAPPER, CONFIG, SUDOERS, HOME, DATA]
    for path in targets:
        trusted_path(path, missing=True)
    if not args.update and any(path.exists() for path in targets):
        raise InstallError('An installation already exists. Review it and use --update explicitly; config must remain identical.')
    if CONFIG.exists() and CONFIG.read_bytes() != config_path.read_bytes():
        raise InstallError('Existing root configuration differs; the installer will not overwrite it, including with --update.')
    try:
        account = pwd.getpwnam(USER)
    except KeyError:
        account = None
    if account and (not args.update or account.pw_uid == 0 or account.pw_dir != str(HOME) or account.pw_shell != '/bin/bash'
                    or grp.getgrgid(account.pw_gid).gr_name != USER
                    or set(os.getgrouplist(USER, account.pw_gid)) != {account.pw_gid}):
        raise InstallError('Existing deploy account is not an isolated installation account.')
    command('/usr/sbin/sshd', '-t')
    command('/usr/sbin/visudo', '-c')
    # Validate the exact future bundle/config and sudo rule before enabling them.
    with tempfile.TemporaryDirectory(prefix='noknok-install-') as temporary:
        stage = Path(temporary)
        for target, (source, _mode) in files.items():
            if target.parent == BUNDLE:
                shutil.copyfile(source, stage / target.name)
        module_spec = importlib.util.spec_from_file_location('noknok_deploy', SOURCE / 'noknok-release-deploy.py')
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        module.CONFIG, module.BUNDLE = config_path, stage
        try:
            config = module.read_config()
        except (module.DeploymentError, OSError, ValueError, TypeError) as error:
            raise InstallError(str(error)) from error
        sudo_stage = stage / 'sudoers'
        sudo_stage.write_bytes((SOURCE / 'noknok-deploy.sudoers').read_bytes())
        sudo_stage.chmod(0o440)
        command('/usr/sbin/visudo', '-cf', str(sudo_stage))
        for key in ('caddyDataVolume', 'caddyConfigVolume'):
            command('/usr/bin/docker', 'volume', 'inspect', config[key])
        volume_exists = command('/usr/bin/docker', 'volume', 'inspect', config['controlVolume'], allow_failure=True).returncode == 0
        if volume_exists and not args.update:
            raise InstallError('The proposed new control volume already exists; initial installation never adopts or rewrites it.')
        DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
        DATA.chmod(0o700)
        lock = os.open(DATA / 'deploy.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise InstallError('A deployment is running; install after it finishes.') from error
            if not account:
                command('/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', str(HOME), '--shell', '/bin/bash', USER)
            command('/usr/sbin/usermod', '--lock', USER)
            check_ssh_policy(command('/usr/sbin/sshd', '-T', '-C', f'user={USER},host=localhost,addr=127.0.0.1').stdout)
            HOME.mkdir(mode=0o755, exist_ok=True)
            HOME.chmod(0o755)
            (HOME / '.ssh').mkdir(mode=0o755, exist_ok=True)
            trusted_path(HOME / '.ssh')
            (HOME / '.ssh').chmod(0o755)
            for target, (source, mode) in files.items():
                write_atomic(target, source.read_bytes(), mode)
            if not CONFIG.exists():
                write_atomic(CONFIG, config_path.read_bytes(), 0o600)
            write_atomic(HOME / '.ssh' / 'authorized_keys', authorized.encode(), 0o644)
            # Only this newly named control volume is initialized. The legacy
            # control and Caddy volumes are never mounted writable or deleted.
            if command('/usr/bin/docker', 'image', 'inspect', 'node:24-alpine', allow_failure=True).returncode:
                command('/usr/bin/docker', 'pull', 'node:24-alpine')
            if not volume_exists:
                command('/usr/bin/docker', 'volume', 'create', config['controlVolume'])
                command('/usr/bin/docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
                        '--security-opt', 'no-new-privileges:true', '--mount', f"type=volume,src={config['controlVolume']},dst=/data",
                        '--entrypoint', '/bin/sh', 'node:24-alpine', '-c', 'chmod 700 /data && chown 1000:1000 /data')
            command('/usr/bin/docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
                    '--security-opt', 'no-new-privileges:true', '--mount', f"type=volume,src={config['controlVolume']},dst=/data,readonly",
                    '--entrypoint', '/bin/sh', 'node:24-alpine', '-c', 'test "$(stat -c %u:%g:%a /data)" = "1000:1000:700"')
            previous = SUDOERS.read_bytes() if SUDOERS.exists() else None
            write_atomic(SUDOERS, sudo_stage.read_bytes(), 0o440)
            try:
                command('/usr/sbin/visudo', '-c')
                command('/usr/sbin/sshd', '-t')
            except Exception:
                if previous is None:
                    SUDOERS.unlink()
                else:
                    write_atomic(SUDOERS, previous, 0o440)
                raise
        finally:
            os.close(lock)
    print(json.dumps({'status': 'installed', 'user': USER, 'applicationChanged': False, 'sshConfigChanged': False,
                      'next': 'Verify the dedicated SSH key and forwarding restrictions. No application deployment was run.'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-key', required=True, help='Absolute path to the reviewed Ed25519 PUBLIC key')
    parser.add_argument('--config', required=True, help='Absolute path to the prepared root-owned deployment config')
    parser.add_argument('--update', action='store_true', help='Explicitly update fixed code and public key; existing config must be identical')
    try:
        install(parser.parse_args())
    except (InstallError, OSError, ValueError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    main()
