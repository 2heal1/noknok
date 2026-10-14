#!/usr/bin/python3
"""Root-only, fixed-policy release deployment. No shell, uploaded code or paths."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone

CONFIG = Path('/etc/noknok/deploy.json')
BUNDLE = Path('/usr/local/lib/noknok-deploy')
DATA = Path('/var/lib/noknok-deploy')
DOCKER = '/usr/bin/docker'
CURL = '/usr/bin/curl'
STABLE = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\Z')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}\Z')
SAFE_NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z')


class DeploymentError(Exception):
    pass


def version_tuple(value):
    if not isinstance(value, str) or not STABLE.fullmatch(value):
        raise DeploymentError('Expected an exact stable version.')
    return tuple(map(int, value.split('.')))


def trusted(path, directory=False):
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise DeploymentError('Deployment files must be root-owned and not writable by other users.')


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    trusted(path, directory=True)


def save(path, value):
    private_dir(path.parent)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, sort_keys=True, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_config():
    trusted(CONFIG.parent, directory=True)
    trusted(CONFIG)
    config = json.loads(CONFIG.read_text())
    expected = {'domain', 'project', 'controlVolume', 'caddyDataVolume', 'caddyConfigVolume', 'bootstrapCompose', 'bootstrapEnv'}
    if set(config) != expected:
        raise DeploymentError('Deployment configuration fields do not match the fixed schema.')
    if not isinstance(config['domain'], str) or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', config['domain']) or '..' in config['domain']:
        raise DeploymentError('Invalid deployment domain.')
    for key in ('project', 'controlVolume', 'caddyDataVolume', 'caddyConfigVolume'):
        if not isinstance(config[key], str) or not SAFE_NAME.fullmatch(config[key]):
            raise DeploymentError('Invalid deployment project or volume name.')
    for key in ('bootstrapCompose', 'bootstrapEnv'):
        path = Path(config[key])
        if not path.is_absolute():
            raise DeploymentError('Bootstrap paths must be absolute administrator-owned files.')
        trusted(path)
    trusted(BUNDLE, directory=True)
    for name in ('Dockerfile.release', 'fetch-package.ts', 'compose.release.yaml', 'Caddyfile.hosted'):
        trusted(BUNDLE / name)
    return config


def run(*args, timeout=60):
    # Fixed executable paths and a clean environment prevent SSH/PATH/Docker
    # environment variables from redirecting a privileged deployment.
    try:
        result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout,
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'})
        return result.stdout.strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise DeploymentError(f'{Path(args[0]).name} {args[1]} failed or timed out.') from error


def container_image(config):
    containers = run(DOCKER, 'ps', '-aq', '--filter', f"label=com.docker.compose.project={config['project']}",
                     '--filter', 'label=com.docker.compose.service=noknok').splitlines()
    if len(containers) != 1 or not re.fullmatch(r'[a-f0-9]{12,64}', containers[0]):
        raise DeploymentError('Expected exactly one existing NokNok container; bootstrap it as an administrator first.')
    image = run(DOCKER, 'inspect', '--format', '{{.Image}}', containers[0])
    if not IMAGE.fullmatch(image):
        raise DeploymentError('Could not identify the existing immutable image ID.')
    return containers[0], image


def snapshot_dir():
    private_dir(DATA / 'snapshots')
    return Path(tempfile.mkdtemp(prefix='release-', dir=DATA / 'snapshots'))


def copy_private(source, destination):
    shutil.copyfile(source, destination)
    destination.chmod(0o600)


def bootstrap(config, image):
    directory = snapshot_dir()
    original = Path(config['bootstrapCompose'])
    copy_private(original, directory / 'compose.yaml')
    copy_private(Path(config['bootstrapEnv']), directory / 'deployment.env')
    (directory / 'image.yaml').write_text('services:\n  noknok:\n    image: ' + image + '\n')
    return {'version': None, 'image': image, 'compose': [str(directory / 'compose.yaml'), str(directory / 'image.yaml')],
            'env': str(directory / 'deployment.env'), 'directory': str(original.parent), 'kind': 'bootstrap'}


def admin_key_hash():
    # Optional operator-only configuration, never supplied by the SSH deploy caller.
    path = CONFIG.with_name('admin-key.sha256')
    if not path.exists():
        return ''
    trusted(path)
    if path.stat().st_mode & 0o077 or path.stat().st_size > 65:
        raise DeploymentError('Admin key digest must be an owner-only file with a SHA-256 digest.')
    value = path.read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', value):
        raise DeploymentError('Admin key digest is invalid.')
    return value


def release_spec(config, version, image):
    directory = snapshot_dir()
    copy_private(BUNDLE / 'compose.release.yaml', directory / 'compose.yaml')
    values = {'NOKNOK_IMAGE': image, 'NOKNOK_DOMAIN': config['domain'], 'NOKNOK_CONTROL_VOLUME': config['controlVolume'],
              'NOKNOK_CADDY_DATA_VOLUME': config['caddyDataVolume'], 'NOKNOK_CADDY_CONFIG_VOLUME': config['caddyConfigVolume'],
              'NOKNOK_CADDYFILE': str(BUNDLE / 'Caddyfile.hosted'), 'NOKNOK_ADMIN_KEY_HASH': admin_key_hash()}
    env = directory / 'deployment.env'
    env.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
    env.chmod(0o600)
    return {'version': version, 'image': image, 'compose': [str(directory / 'compose.yaml')],
            'env': str(env), 'directory': str(directory), 'kind': 'release'}


def activate(config, spec):
    args = [DOCKER, 'compose', '--project-name', config['project'], '--project-directory', spec['directory'], '--env-file', spec['env']]
    for path in spec['compose']:
        args.extend(['--file', path])
    # Never down, remove volumes, pull a caller-specified image, build during
    # rollback, recreate Caddy, or touch unrelated services.
    run(*args, 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'noknok', timeout=120)


def healthy(config, spec):
    image = spec['image']
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            container, actual = container_image(config)
            if actual != image:
                raise DeploymentError('Running image does not match the selected release.')
            status = run(DOCKER, 'inspect', '--format', '{{.State.Health.Status}}', container)
            if status == 'healthy':
                value = json.loads(run(CURL, '--fail', '--silent', '--show-error', '--max-time', '10', '--max-filesize', '1048576',
                                       '--proto', '=https', '--tlsv1.2', f"https://{config['domain']}/health", timeout=15))
                if isinstance(value, dict) and value.get('ok') is True and value.get('mode') == 'hosted':
                    current_contract = value.get('transcriptStorage') == 'participant' and value.get('deliveryStorage') == 'pending_memory'
                    # Only an administrator-captured pre-registry snapshot may
                    # use the old health contract when restoring that service.
                    bootstrap_contract = spec.get('kind') == 'bootstrap' and value.get('transcriptStorage') == 'memory'
                    if current_contract or bootstrap_contract:
                        return
        except (DeploymentError, ValueError):
            pass
        time.sleep(2)
    raise DeploymentError('The running container and public HTTPS health checks did not pass.')


def load_state(config):
    path = DATA / 'state.json'
    _, image = container_image(config)
    if path.exists():
        trusted(path)
        state = json.loads(path.read_text())
        if state.get('schema') != 1:
            raise DeploymentError('Unsupported deployment state schema.')
        if not state.get('pending') and state['current']['image'] != image:
            raise DeploymentError('Container drift detected; reconcile deployment state as an administrator.')
        return state
    # Source-built dev versions are intentionally not interpreted as published
    # semver: the first registry deployment can take over an older dev build.
    return {'schema': 1, 'current': bootstrap(config, image), 'previous': None, 'highWaterVersion': None}


def policy_fingerprint():
    fingerprint = hashlib.sha256()
    for name in ('Dockerfile.release', 'compose.release.yaml', 'fetch-package.ts'):
        fingerprint.update(name.encode())
        fingerprint.update((BUNDLE / name).read_bytes())
    return fingerprint.hexdigest()


def deploy(config, state, version):
    requested = version_tuple(version)
    if state.get('pending'):
        raise DeploymentError('An interrupted deployment needs administrator rollback previous before retrying.')
    if state.get('highWaterVersion') and requested < version_tuple(state['highWaterVersion']):
        raise DeploymentError('Automatic downgrades are refused; use administrator rollback previous.')
    policy = policy_fingerprint()
    if state['current']['version'] == version and state['current'].get('policyFingerprint') == policy:
        healthy(config, state['current'])
        return {'status': 'unchanged', 'version': version}
    for key in ('controlVolume', 'caddyDataVolume', 'caddyConfigVolume'):
        run(DOCKER, 'volume', 'inspect', config[key])
    tag = f'noknok-release:{version}'
    # This build context is installed by an administrator, never uploaded by CI.
    run(DOCKER, 'build', '--pull', '--file', str(BUNDLE / 'Dockerfile.release'), '--build-arg', f'NOKNOK_VERSION={version}',
        '--tag', tag, str(BUNDLE), timeout=600)
    image = run(DOCKER, 'image', 'inspect', '--format', '{{.Id}}', tag)
    if not IMAGE.fullmatch(image):
        raise DeploymentError('Build did not return an immutable image ID.')
    manifest = json.loads(run(DOCKER, 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                              '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '32',
                              '--entrypoint', 'node', image, '-e',
                              'const fs=require("node:fs"),p="/app/dist/runtime-fingerprint.json";process.stdout.write(fs.existsSync(p)?fs.readFileSync(p,"utf8"):JSON.stringify({schema:0}))'))
    # A release built before fingerprints existed cannot prove equality; deploy
    # it normally rather than assuming its runtime is unchanged.
    missing = isinstance(manifest, dict) and manifest == {'schema': 0}
    if not missing and (not isinstance(manifest, dict) or manifest.get('schema') != 1 or not re.fullmatch(r'[a-f0-9]{64}', str(manifest.get('sha256', '')))):
        raise DeploymentError('Published package has no valid runtime fingerprint.')
    # Policy changes must also take effect, even if application bytes are equal.
    digest = hashlib.sha256((str(manifest.get('sha256', '')) + policy).encode()).hexdigest()
    if not missing and state['current'].get('runtimeFingerprint') == digest:
        healthy(config, state['current'])
        state.update(highWaterVersion=version, lastCheckedVersion=version, checkedAt=timestamp())
        save(DATA / 'state.json', state)
        return {'status': 'unchanged-runtime', 'version': version, 'runningVersion': state['current']['version']}
    candidate = release_spec(config, version, image)
    candidate['policyFingerprint'] = policy
    if not missing:
        candidate['runtimeFingerprint'] = digest
    previous = state['current']
    state['pending'] = candidate
    save(DATA / 'state.json', state)
    try:
        activate(config, candidate)
        healthy(config, candidate)
    except BaseException:
        # The state retains pending when rollback fails or the process is killed;
        # subsequent CI runs must not blindly overwrite an uncertain deployment.
        try:
            activate(config, previous)
            healthy(config, previous)
        except Exception:
            state['lastFailure'] = {'version': version, 'rollback': 'failed', 'at': timestamp()}
            save(DATA / 'state.json', state)
            raise DeploymentError('Deployment and automatic rollback failed; administrator intervention required.')
        state.pop('pending', None)
        state['lastFailure'] = {'version': version, 'rollback': 'succeeded', 'at': timestamp()}
        save(DATA / 'state.json', state)
        raise DeploymentError('Release health failed; the previous deployment was restored.')
    state.update(current=candidate, previous=previous, highWaterVersion=version, deployedAt=timestamp())
    state.pop('pending', None)
    state.pop('lastFailure', None)
    save(DATA / 'state.json', state)
    return {'status': 'deployed', 'version': version, 'image': image}


def rollback(config, state):
    target = state['current'] if state.get('pending') else state.get('previous')
    if not target:
        raise DeploymentError('No previous deployment is available.')
    old = state['current']
    state['pending'] = target
    save(DATA / 'state.json', state)
    activate(config, target)
    healthy(config, target)
    state.update(current=target, previous=old if target != old else state.get('previous'), deployedAt=timestamp())
    state.pop('pending', None)
    save(DATA / 'state.json', state)
    return {'status': 'rolled_back', 'version': target['version'], 'image': target['image']}


def timestamp():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def deployment_lock():
    private_dir(DATA)
    path = DATA / 'deploy.lock'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        trusted(path)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise DeploymentError('Another deployment is running; retry after it finishes.') from error
        yield
    finally:
        os.close(fd)


def main(args):
    if len(args) != 2 or args[0] not in ('deploy', 'rollback'):
        raise DeploymentError('Usage: noknok-release-deploy deploy VERSION | rollback previous')
    if args[0] == 'deploy':
        version_tuple(args[1])
    elif args[1] != 'previous' or os.environ.get('SUDO_USER') not in (None, 'root'):
        raise DeploymentError('Rollback is only available from an administrator root session.')
    if os.geteuid() != 0:
        raise DeploymentError('The fixed deployment wrapper must run as root.')
    config = read_config()
    with deployment_lock():
        state = load_state(config)
        result = deploy(config, state, args[1]) if args[0] == 'deploy' else rollback(config, state)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise DeploymentError('Deployment interrupted.')
    for name in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(name, interrupted)
    try:
        main(sys.argv[1:])
    except (DeploymentError, OSError, ValueError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
