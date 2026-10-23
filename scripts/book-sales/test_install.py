import hashlib
import json
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from install_launchd import previous_install, replace_agent, LABEL, FILES


class InstallTests(unittest.TestCase):
    def test_bootstrap_failure_restores_original_plist_and_job(self):
        with tempfile.TemporaryDirectory() as directory:
            plist = Path(directory) / 'job.plist'
            original = plistlib.dumps({'Label': LABEL, 'original': True})
            plist.write_bytes(original)
            run = Mock(side_effect=[SimpleNamespace(stdout='state = not running'), None,
                                   subprocess.CalledProcessError(1, 'bootstrap'), None])
            with self.assertRaises(subprocess.CalledProcessError): replace_agent(plist, {'Label': LABEL}, original, run)
            self.assertEqual(plist.read_bytes(), original)
            self.assertEqual(run.call_args_list[-1].args[0][1], 'bootstrap')

    def test_rejects_changed_binary_and_keeps_schedule(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            sha = 'a' * 40
            old = home / '.local/share/seorilabs/book-sales' / sha
            old.mkdir(parents=True)
            for name in FILES: (old / name).write_bytes(b'original')
            (old / 'installation.json').write_text(json.dumps({'sourceSha': sha, 'files': {name: hashlib.sha256(b'original').hexdigest() for name in FILES}}))
            plist = home / 'job.plist'
            document = {'Label': LABEL, 'WorkingDirectory': str(old), 'ProgramArguments': [str(home / '.local/share/seorilabs/playwright/venv/bin/python'), str(old / 'collect.py')], 'StartCalendarInterval': {'Hour': 9, 'Minute': 0}, 'EnvironmentVariables': {'TZ': 'Asia/Seoul'}}
            plist.write_bytes(plistlib.dumps(document))
            self.assertEqual(previous_install(home, plist, sha)[1], document)
            (old / 'collect.py').write_bytes(b'changed')
            with self.assertRaises(RuntimeError): previous_install(home, plist, sha)

    def test_running_collector_is_preserved(self):
        run = Mock(return_value=SimpleNamespace(stdout='pid = 123'))
        with self.assertRaises(RuntimeError): replace_agent(Path('/unused'), {}, b'old', run)
        self.assertEqual(run.call_count, 1)
