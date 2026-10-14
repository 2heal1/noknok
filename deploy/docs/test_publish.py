import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('docs_publish', Path(__file__).parent / 'publish.py')
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)


def archive(extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        for name, content in [('index.html', b'<main>NokNok</main>'), ('guide/getting-started.html', b'guide'), *(extra or [])]:
            info = tarfile.TarInfo(name)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    return output.getvalue()


class DocsTests(unittest.TestCase):
    def test_atomic_publication_and_bad_upload_keeps_existing_site(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(site, 'ROOT', Path(temporary)):
            site.publish('a' * 40, archive())
            first = (site.ROOT / 'current').resolve()
            self.assertEqual(json.loads((first / '_noknok_deployment.json').read_text())['revision'], 'a' * 40)
            for name in ('../secret', '/etc/shadow', 'directory/../../secret', '.env', 'folder/.git/config', 'bad\\path'):
                with self.assertRaises(ValueError):
                    site.publish('b' * 40, archive([(name, b'invalid')]))
                self.assertEqual((site.ROOT / 'current').resolve(), first)
            site.publish('b' * 40, archive([('static/main.js', b'console.log(1)')]))
            self.assertNotEqual((site.ROOT / 'current').resolve(), first)
            self.assertTrue(first.exists())

    def test_links_duplicates_missing_entrypoints_and_limits_are_rejected(self):
        with self.assertRaises(ValueError):
            site.validate_archive(archive([('index.html', b'duplicate')]))
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as tar:
            info = tarfile.TarInfo('escape')
            info.type, info.linkname = tarfile.SYMTYPE, '/etc'
            tar.addfile(info)
        with self.assertRaises(ValueError):
            site.validate_archive(output.getvalue())
        with patch.object(site, 'MAX_CONTENT', 2):
            with self.assertRaises(ValueError):
                site.validate_archive(archive())
        with patch.object(site, 'MAX_FILES', 1):
            with self.assertRaises(ValueError):
                site.validate_archive(archive())

    def test_only_exact_docs_command_is_accepted(self):
        script = str(Path(__file__).parent / 'publish.py')
        for command in ('id', 'deploy 0.1.0', 'docs latest', 'docs ' + 'a' * 40 + '; id', 'docs ' + 'a' * 39):
            result = subprocess.run(['python3', script], env={'SSH_ORIGINAL_COMMAND': command}, capture_output=True)
            self.assertEqual(result.returncode, 64)


if __name__ == '__main__':
    unittest.main()
