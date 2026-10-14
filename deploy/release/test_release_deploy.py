"""Offline deployment state-machine tests. Docker/curl are always substituted."""
import importlib.util
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import struct
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('release_deploy', SOURCE / 'noknok-release-deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
OLD = 'sha256:' + 'a' * 64
NEW = 'sha256:' + 'b' * 64


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.data = root / 'state'
        self.bundle = root / 'bundle'
        self.bundle.mkdir()
        (self.bundle / 'compose.release.yaml').write_text((SOURCE / 'compose.release.yaml').read_text())
        (root / 'compose.yaml').write_text('services:\n  noknok:\n    build: ..\n    volumes: ["control:/data"]\nvolumes:\n  control: {}\n')
        (root / 'deployment.env').write_text('NOKNOK_DOMAIN=example.test\n')
        self.config = {'domain': 'example.test', 'project': 'noknok', 'controlVolume': 'noknok_control_v2',
                       'caddyDataVolume': 'noknok_caddy_data', 'caddyConfigVolume': 'noknok_caddy_config',
                       'bootstrapCompose': str(root / 'compose.yaml'), 'bootstrapEnv': str(root / 'deployment.env')}
        self.commands = []
        self.current_image = OLD
        self.current_volume = 'noknok_control'
        self.clock = 0
        self.fail_new_health = False
        self.fail_rollback = False
        self.fail_build = False
        self.transcript_storage = 'memory'
        for name, value in [('DATA', self.data), ('BUNDLE', self.bundle), ('run', self.command)]:
            context = patch.object(deploy, name, value)
            context.start()
            self.addCleanup(context.stop)
        for name, value in [('monotonic', lambda: self.clock), ('sleep', self.sleep)]:
            context = patch.object(deploy.time, name, value)
            context.start()
            self.addCleanup(context.stop)

    def sleep(self, seconds):
        self.clock += seconds

    def command(self, *args, **_kwargs):
        self.commands.append(args)
        if args[0] == deploy.CURL:
            return json.dumps({'ok': True, 'mode': 'hosted', 'transcriptStorage': self.transcript_storage})
        self.assertEqual(args[0], deploy.DOCKER)
        if args[1] == 'ps':
            return 'c' * 12
        if args[1:4] == ('inspect', '--format', '{{.Image}}'):
            return self.current_image
        if args[1:4] == ('inspect', '--format', '{{.State.Health.Status}}'):
            return 'unhealthy' if self.fail_new_health and self.current_image == NEW else 'healthy'
        if args[1:3] == ('volume', 'inspect'):
            return '{}'
        if args[1] == 'build':
            if self.fail_build:
                raise deploy.DeploymentError('Synthetic build failure')
            return ''
        if args[1:3] == ('image', 'inspect'):
            return NEW
        if args[1] == 'compose':
            self.assertEqual(args[args.index('--project-name') + 1], self.config['project'])
            env = dict(line.split('=', 1) for line in Path(args[args.index('--env-file') + 1]).read_text().splitlines())
            if 'NOKNOK_IMAGE' in env:
                self.current_image = env['NOKNOK_IMAGE']
                self.current_volume = env['NOKNOK_CONTROL_VOLUME']
            else:
                if self.fail_rollback:
                    raise deploy.DeploymentError('Synthetic rollback failure')
                self.current_image = OLD
                self.current_volume = 'noknok_control'
            self.assertEqual(args[-7:], ('up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'noknok'))
            return ''
        self.fail(f'Unexpected command: {args!r}')

    def state(self):
        return json.loads((self.data / 'state.json').read_text())

    def test_first_registry_release_keeps_legacy_snapshot_and_uses_new_external_volume(self):
        state = deploy.load_state(self.config)
        original = state['current']
        self.assertIsNone(original['version'])
        self.assertEqual(original['image'], OLD)
        self.assertEqual(original['directory'], str(Path(self.config['bootstrapCompose']).parent))
        self.assertEqual(Path(original['compose'][0]).read_text(), Path(self.config['bootstrapCompose']).read_text())
        self.assertEqual(deploy.deploy(self.config, state, '0.1.0')['status'], 'deployed')
        saved = self.state()
        self.assertEqual(saved['previous'], original)
        self.assertEqual(saved['current']['image'], NEW)
        self.assertEqual(saved['highWaterVersion'], '0.1.0')
        self.assertEqual(self.current_volume, 'noknok_control_v2')
        self.assertEqual(Path(original['env']).read_text(), Path(self.config['bootstrapEnv']).read_text())
        self.assertEqual((self.data / 'state.json').stat().st_mode & 0o777, 0o600)
        self.assertTrue(any('NOKNOK_VERSION=0.1.0' in command for command in self.commands))
        self.assertFalse(any(arg in ('down', 'rm', 'prune') for command in self.commands for arg in command))

    def test_failed_health_restores_legacy_image_compose_env_and_volume(self):
        state = deploy.load_state(self.config)
        self.fail_new_health = True
        with self.assertRaisesRegex(deploy.DeploymentError, 'previous deployment was restored'):
            deploy.deploy(self.config, state, '0.1.0')
        self.assertEqual(self.current_image, OLD)
        self.assertEqual(self.current_volume, 'noknok_control')
        self.assertEqual(self.state()['lastFailure']['rollback'], 'succeeded')
        self.assertNotIn('pending', self.state())
        self.assertIsNone(self.state()['highWaterVersion'])

    def test_health_rejects_an_endpoint_with_the_wrong_transcript_storage(self):
        self.transcript_storage = 'disk'
        with self.assertRaisesRegex(deploy.DeploymentError, 'health checks did not pass'):
            deploy.healthy(self.config, OLD)

    def test_failed_rollback_preserves_pending_and_blocks_further_ci(self):
        state = deploy.load_state(self.config)
        self.fail_new_health = self.fail_rollback = True
        with self.assertRaisesRegex(deploy.DeploymentError, 'administrator intervention'):
            deploy.deploy(self.config, state, '0.1.0')
        saved = self.state()
        self.assertEqual(saved['pending']['version'], '0.1.0')
        with self.assertRaisesRegex(deploy.DeploymentError, 'interrupted deployment'):
            deploy.deploy(self.config, saved, '0.1.1')
        self.fail_rollback = False
        self.assertEqual(deploy.rollback(self.config, saved)['status'], 'rolled_back')
        self.assertEqual(self.current_image, OLD)
        self.assertNotIn('pending', self.state())

    def test_build_failure_never_recreates_existing_container(self):
        self.fail_build = True
        with self.assertRaisesRegex(deploy.DeploymentError, 'build failure'):
            deploy.deploy(self.config, deploy.load_state(self.config), '0.1.0')
        self.assertEqual(self.current_image, OLD)
        self.assertFalse(any(command[1] == 'compose' for command in self.commands))

    def test_repeat_is_health_checked_and_downgrades_are_denied_even_after_admin_rollback(self):
        deploy.deploy(self.config, deploy.load_state(self.config), '0.1.0')
        self.commands.clear()
        self.assertEqual(deploy.deploy(self.config, self.state(), '0.1.0')['status'], 'unchanged')
        self.assertFalse(any(command[1] in ('build', 'compose') for command in self.commands))
        deploy.rollback(self.config, self.state())
        self.assertEqual(self.current_image, OLD)
        with self.assertRaisesRegex(deploy.DeploymentError, 'downgrades'):
            deploy.deploy(self.config, self.state(), '0.0.9')

    def test_concurrent_deployment_is_refused_without_mutation(self):
        with deploy.deployment_lock():
            with self.assertRaisesRegex(deploy.DeploymentError, 'Another deployment'):
                with deploy.deployment_lock():
                    self.fail('Second deployment unexpectedly acquired the lock')
        self.assertEqual(self.commands, [])

    def test_privileged_wrapper_rejects_unexpected_commands_and_sudo_rollback(self):
        for args in [[], ['deploy'], ['shell', '1.2.3'], ['deploy', '1.2.3', '--url', 'x'], ['rollback', '1.2.3']]:
            with self.assertRaises(deploy.DeploymentError):
                deploy.main(args)
        with patch.dict(os.environ, {'SUDO_USER': 'noknok-deploy'}):
            with self.assertRaisesRegex(deploy.DeploymentError, 'administrator root'):
                deploy.main(['rollback', 'previous'])
        self.assertEqual(self.commands, [])

    def test_forced_ssh_entry_rejects_shell_escapes_prereleases_and_extra_arguments(self):
        for command in ['', 'bash', 'deploy latest', 'deploy 01.2.3', 'deploy 1.2.3-beta.1', 'deploy 1.2.3+build',
                        'deploy 1.2.3; id', 'deploy 1.2.3\nid', 'deploy $(id)', 'rollback previous', 'deploy 1.2.3 extra']:
            result = subprocess.run(['/bin/bash', str(SOURCE / 'noknok-deploy-ssh')],
                                    env={'PATH': '/usr/bin:/bin', 'SSH_ORIGINAL_COMMAND': command}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 64, command)


installer_spec = importlib.util.spec_from_file_location('release_install', SOURCE / 'install.py')
installer = importlib.util.module_from_spec(installer_spec)
installer_spec.loader.exec_module(installer)


class InstallerPolicyTests(unittest.TestCase):
    def key(self):
        blob = struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32) + bytes(range(32))
        return 'ssh-ed25519 ' + base64.b64encode(blob).decode() + ' ignored-comment'

    def policy(self):
        return {'pubkeyauthentication': 'yes', 'authorizedkeyscommand': 'none', 'trustedusercakeys': 'none',
                'authorizedprincipalscommand': 'none', 'authorizedprincipalsfile': 'none', 'forcecommand': 'none',
                'hostbasedauthentication': 'no', 'gssapiauthentication': 'no', 'passwordauthentication': 'no', 'usepam': 'yes', 'kbdinteractiveauthentication': 'no',
                'permituserenvironment': 'no', 'authorizedkeysfile': '.ssh/authorized_keys .ssh/authorized_keys2',
                'acceptenv': 'LANG LC_*'}

    def test_public_key_is_rewritten_to_one_restricted_entry_without_caller_options(self):
        value = installer.public_key(self.key())
        self.assertTrue(value.startswith('restrict,command="/usr/local/libexec/noknok-deploy-ssh" ssh-ed25519 '))
        self.assertNotIn('ignored-comment', value)
        for invalid in [self.key() + '\n' + self.key(), 'command="id" ' + self.key(), 'not-a-public-key',
                        'ssh-ed25519 AAAA', 'ssh-rsa AAAA']:
            with self.assertRaises(installer.InstallError):
                installer.public_key(invalid)

    def test_ssh_policy_refuses_alternative_authentication_and_startup_environment(self):
        good = self.policy()
        installer.check_ssh_policy('\n'.join(f'{key} {value}' for key, value in good.items()))
        for key, value in [('authorizedkeyscommand', '/usr/bin/custom-auth'), ('trustedusercakeys', '/etc/ssh/ca'),
                           ('authorizedkeysfile', '/etc/shared_keys'), ('acceptenv', 'LANG LC_* BASH_ENV'),
                           ('permituserenvironment', 'yes'), ('kbdinteractiveauthentication', 'yes')]:
            changed = {**good, key: value}
            with self.assertRaises(installer.InstallError):
                installer.check_ssh_policy('\n'.join(f'{name} {setting}' for name, setting in changed.items()))

    def test_update_never_overwrites_a_different_existing_root_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            public = root / 'key.pub'
            public.write_text(self.key())
            incoming = root / 'incoming.json'
            incoming.write_text('{"new":"config"}')
            existing = root / 'existing.json'
            existing.write_text('{"existing":"config"}')
            with patch.object(installer.os, 'geteuid', return_value=0), patch.object(installer, 'trusted_path'), \
                 patch.object(installer, 'CONFIG', existing), patch.object(installer, 'command') as command:
                with self.assertRaisesRegex(installer.InstallError, 'will not overwrite'):
                    installer.install(SimpleNamespace(public_key=str(public), config=str(incoming), update=True))
                command.assert_not_called()
            self.assertEqual(existing.read_text(), '{"existing":"config"}')


if __name__ == '__main__':
    unittest.main()
