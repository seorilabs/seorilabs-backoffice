import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
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

    def test_expired_heartbeat_and_empty_git_recover_to_paused(self):
        for empty_git in (False,True):
            with self.subTest(empty_git=empty_git),tempfile.TemporaryDirectory() as temp,patch.object(r,'STATE',Path(temp)):
                root=Path(temp)/'documents';root.mkdir()
                if empty_git:subprocess.run(['git','init','-q',str(root)],check=True)
                journal={'runId':'one','generation':2,'sessionId':None,'pid':None,'identity':None,'root':str(root),'workspace':str(root),'targetId':'book'}
                r.private_json(r.STATE/'active.json',journal)
                pending={'runId':'one','body':{'requestId':'old-heartbeat','generation':2,'kind':'heartbeat'}}
                r.private_json(r.STATE/'outbox.json',pending)
                calls=[]
                class Fake:
                    def request(self,path,body=None):
                        calls.append((path,body))
                        if path=='runs/one':return {'activeRunId':'one','run':{'id':'one','generation':2,'status':'PROCESSING','localState':'UNCERTAIN'}}
                        if body['kind']=='heartbeat':raise r.Rejected(409,'RUN_LEASE_LOST')
                        return {'accepted':True}
                r.recover(Fake())
                self.assertEqual(sum(bool(body) and body['kind']=='paused' for _,body in calls),1)
                self.assertFalse((r.STATE/'active.json').exists())
                self.assertTrue((r.STATE/'rejected-old-heartbeat.json').exists())

    def test_cli_leader_exit_stops_descendant_writer(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);binary=root/'fake-codex';marker=root/'late-write'
            child_code='import time;from pathlib import Path;time.sleep(1);Path('+repr(str(marker))+').write_text("late")'
            binary.write_text('#!/usr/bin/env python3\nimport subprocess,sys\nsys.stdin.read()\nsubprocess.Popen([sys.executable,"-c",'+repr(child_code)+'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nsys.exit(1)\n')
            binary.chmod(0o700)
            with self.assertRaises(r.Waiting):r.codex({'codex':str(binary)},'test',root,time.monotonic()+10,root/'schema.json')
            time.sleep(1.2)
            self.assertFalse(marker.exists(),'종료된 CLI의 자식은 쓸 수 없어야 한다')

    def test_claim_response_loss_reuses_exact_claim_id(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(r,'STATE',Path(temp)):
            intent={'requestId':'one-exact-claim'};r.private_json(r.STATE/'claim-intent.json',intent)
            calls=[]
            class Fake:
                def request(self,path,body=None):
                    calls.append((path,body));return {'run':{'id':'one','checkpoint':{'claimRequestId':intent['requestId']}},'active':None}
            self.assertEqual(r.recover(Fake())['id'],'one')
            self.assertEqual(calls,[('runs/claim',intent)])
            self.assertTrue((r.STATE/'claim-intent.json').exists())

    def test_cancelled_claim_response_loss_reports_stopped_before_cleanup(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(r,'STATE',Path(temp)):
            intent={'requestId':'cancelled-claim'};r.private_json(r.STATE/'claim-intent.json',intent)
            active={'id':'one','generation':1,'status':'CANCELLED','localState':'STOP_REQUESTED','executionOwner':'pc','checkpoint':{'claimRequestId':intent['requestId']}}
            reports=[]
            class Fake:
                machine='pc'
                def request(self,path,body=None):
                    if path=='runs/claim':return {'run':None,'active':active}
                    if path=='runs/one':return {'run':active,'activeRunId':'one'}
                    reports.append(body);return {'accepted':True}
            r.recover(Fake())
            self.assertEqual([report['kind'] for report in reports],['stopped'])
            self.assertTrue(reports[0]['checkpoint']['readbackVerified'])
            self.assertFalse((r.STATE/'claim-intent.json').exists())

    def test_repeated_observation_uses_distinct_fact_identity_and_existing_links(self):
        from urllib.parse import urlparse
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);batches=[]
            config={'targets':{'environment:test':{'path':str(root),'kind':'ENVIRONMENT','name':'test'}}}
            class Fake:
                def request(self,path,body=None):
                    if path=='observations':batches.append(body)
                    return {}
            sources={'incidents':[{'id':'qa-incident','appId':None,'summary':'test incident','lastDetectedAt':r.iso()}]}
            r.observe(Fake(),config,sources);time.sleep(0.005);r.observe(Fake(),config,sources)
            self.assertNotEqual(batches[0][0]['id'],batches[1][0]['id'])
            self.assertEqual(batches[0][0]['problemKey'],batches[1][0]['problemKey'])
            repo=Path(__file__).resolve().parents[2]
            for observation in batches[0]:
                for ref in observation['references']:
                    if ref.startswith('https://backoffice.vzyx.xyz/'):
                        self.assertTrue((repo/'src/app/(app)'/urlparse(ref).path.lstrip('/')/'page.tsx').exists(),ref)

    def test_schema_and_prompts_are_valid(self):
        for name in ('analysis.schema.json','result.schema.json'):
            self.assertEqual(json.loads(Path(__file__).with_name(name).read_text())['type'],'object')
class ObservationContracts(unittest.TestCase):
    def test_unborn_writing_repository_is_observed_without_changing_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(['git', 'init', '--initial-branch=main', str(root)], check=True, capture_output=True)
            (root / 'draft.md').write_text('keep original draft\n')
            class Fake:
                def request(self, path, body=None): return {}
            rows = r.observe(Fake(), {'targets': {'writing:test': {'path': temp, 'kind': 'WRITING', 'name': 'test'}}}, {})
            self.assertEqual(len(rows), 1)
            self.assertIn('첫 커밋 전', rows[0]['summary'])
            self.assertEqual((root / 'draft.md').read_text(), 'keep original draft\n')

    def test_local_fact_contains_measured_disk_space(self):
        with tempfile.TemporaryDirectory() as temp:
            observed = []
            class Fake:
                def request(self, path, body=None):
                    if path == 'observations': observed.extend(body)
                    return {}
            config = {'targets': {'writing:test': {'path': temp, 'kind': 'WRITING', 'name': 'test'}}}
            with patch.object(r.shutil, 'disk_usage', return_value=SimpleNamespace(total=10000, used=5679, free=4321)):
                r.observe(Fake(), config, {})
            self.assertIn('10000 bytes', observed[0]['summary'])
            self.assertIn('4321 bytes', observed[0]['summary'])

    def test_design_uses_live_remote_default_despite_stale_tracking_head(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            def git(root, *args):
                return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.DEVNULL).strip()
            bare = base / 'remote.git'; seed = base / 'seed'; target = base / 'target'
            subprocess.run(['git', 'init', '--bare', '--initial-branch=main', str(bare)], check=True, capture_output=True)
            subprocess.run(['git', 'init', '--initial-branch=main', str(seed)], check=True, capture_output=True)
            git(seed, 'config', 'user.name', 'fixture'); git(seed, 'config', 'user.email', 'fixture@example.invalid'); git(seed, 'config', 'commit.gpgsign', 'false')
            (seed / 'source.txt').write_text('A\n'); git(seed, 'add', 'source.txt'); git(seed, 'commit', '-m', 'first')
            git(seed, 'remote', 'add', 'origin', str(bare)); git(seed, 'push', '-q', 'origin', 'main')
            subprocess.run(['git', 'clone', '-q', str(bare), str(target)], check=True, capture_output=True)
            git(target, 'config', 'user.name', 'fixture'); git(target, 'config', 'user.email', 'fixture@example.invalid'); git(target, 'config', 'commit.gpgsign', 'false')
            original = git(target, 'rev-parse', 'HEAD')
            (target / 'user.txt').write_text('keep this user work\n')
            (seed / 'source.txt').write_text('B\n'); git(seed, 'add', 'source.txt'); git(seed, 'commit', '-m', 'new default')
            expected = git(seed, 'rev-parse', 'HEAD'); git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/new-default')
            git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/new-default')
            self.assertEqual(git(target, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main')
            candidate = {'targetId': 'tool:test', 'design': 'fixture design', 'preview': 'fixture preview', 'scope': 'source.txt', 'release': None, 'testPlan': {'schemaVersion': 1, 'level': 'L1', 'baseline': 'pending', 'changedFeatures': ['fixture'], 'environments': ['dev'], 'redesign': False, 'foundationRerun': False, 'floorOverrides': [], 'release': None}}
            with patch.object(r, 'STATE', base / 'state'):
                result = r.prepare_proposal({'targets': {'tool:test': {'path': str(target), 'kind': 'TOOL'}}}, candidate)
            self.assertEqual(git(target, 'rev-parse', result['binding']['commit'] + '^'), expected)
            self.assertEqual(git(target, 'rev-parse', 'HEAD'), original)
            self.assertEqual((target / 'user.txt').read_text(), 'keep this user work\n')

if __name__=='__main__':unittest.main()
