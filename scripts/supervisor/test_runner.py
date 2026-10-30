import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runner',Path(__file__).with_name('runner.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class SafetyTests(unittest.TestCase):
    def test_original_hash_and_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'book.md').write_text('old')
            binding={'kind':'files','files':[{'path':'book.md','sha256':r.sha(b'old')}]}
            r.verify_binding(root,binding)
            (root/'book.md').write_text('user change')
            with self.assertRaises(r.Waiting):r.verify_binding(root,binding)
            with self.assertRaises(r.Waiting):r.checked_path(root,'../secret')
            (root/'link').symlink_to(root/'book.md')
            with self.assertRaises(r.Waiting):r.checked_path(root,'link')
    def test_no_credentials_in_cli_environment(self):
        with patch.dict(os.environ,{'INTERNAL_ADMIN_TOKEN':'test-only','OPENAI_API_KEY':'test-only','GOOGLE_API_KEY':'test-only'}):
            self.assertNotIn('INTERNAL_ADMIN_TOKEN',r.clean_env())
            self.assertNotIn('OPENAI_API_KEY',r.clean_env())
            self.assertNotIn('GOOGLE_API_KEY',r.clean_env())
    def test_response_loss_keeps_exact_report(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(r,'STATE',Path(temp)):
            class Offline:
                def request(self,*args):raise r.Waiting('offline')
            with self.assertRaises(r.Waiting):r.report(Offline(),{'id':'one','generation':2},'paused','대기',checkpoint={'processStopped':True})
            first=json.loads((Path(temp)/'outbox.json').read_text())
            calls=[]
            class Online:
                def request(self,*args):calls.append(args);return {}
            r.flush_outbox(Online())
            self.assertEqual(calls[0][1],first['body'])
            self.assertFalse((Path(temp)/'outbox.json').exists())
    def test_approved_verification_is_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'book.md').write_text('wrong')
            payload={'testCommands':[['python3','-c','assert 1 == 1']],'verification':{'kind':'files','files':[{'path':'book.md','sha256':r.sha(b'approved')}]}}
            with self.assertRaises(r.Waiting):r.verify_result(root,payload,{},time.monotonic()+10)
    def test_deadline_stops_real_cli_process(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);binary=root/'fake-codex'
            binary.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n')
            binary.chmod(0o700)
            with self.assertRaises(r.Waiting):r.codex({'codex':str(binary)},'test',root,0,root/'schema.json')
    def test_real_cli_session_and_final_result(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);binary=root/'fake-codex'
            binary.write_text("#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\nsys.stdin.read()\nprint(json.dumps({'type':'thread.started','thread_id':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}),flush=True)\nPath(sys.argv[sys.argv.index('-o')+1]).write_text(json.dumps({'status':'completed','summary':'checked','prUrl':''}))\n")
            binary.chmod(0o700)
            result,session=r.codex({'codex':str(binary)},'test',root,time.monotonic()+10,root/'schema.json')
            self.assertEqual(result['status'],'completed')
            self.assertEqual(session,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')

    def test_schema_and_prompts_are_valid(self):
        for name in ('analysis.schema.json','result.schema.json'):
            self.assertEqual(json.loads(Path(__file__).with_name(name).read_text())['type'],'object')
if __name__=='__main__':unittest.main()
