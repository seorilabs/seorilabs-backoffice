#!/usr/bin/env python3
"""개인 대표 에이전트. 서버 원장과 기존 CLI 인증을 사용한다."""
from __future__ import annotations
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

STATE = Path.home()/'.local/state/seorilabs/supervisor'
UTC = dt.timezone.utc
STOPPING = False

class Waiting(Exception):
    pass

class Rejected(Waiting):
    def __init__(self,status,code):
        self.status=status
        self.code=code
        super().__init__(f'서버가 요청을 거부했습니다 ({status}, {code}).')

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def iso() -> str:
    return dt.datetime.now(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def private_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def checked_path(root: Path, relative: str) -> Path:
    candidate = root/relative
    if Path(relative).is_absolute() or '..' in Path(relative).parts or '.git' in Path(relative).parts:
        raise Waiting('승인한 상대 경로가 아닙니다.')
    if candidate.is_symlink() or not candidate.resolve().is_relative_to(root.resolve()):
        raise Waiting('심볼릭 링크 또는 대상 밖의 경로입니다.')
    return candidate

def clean_env():
    # 모델에 서버 인증, 유료 API와 다른 계정의 자격증명을 넘기지 않는다.
    keys = ('PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SSH_AUTH_SOCK')
    return {key: os.environ[key] for key in keys if key in os.environ}

def command(argv, cwd: Path, timeout=60, monitor=None):
    child = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=clean_env(), start_new_session=True)
    deadline = time.monotonic()+timeout
    try:
        while True:
            if STOPPING:
                raise Waiting('실행기 중단 요청을 확인했습니다.')
            if monitor:
                monitor(child)
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise Waiting('승인한 명령 실행 시간이 끝났습니다.')
            try:
                output,_ = child.communicate(timeout=min(20, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if child.returncode:
            raise Waiting('명령이 완료되지 않았습니다: '+Path(argv[0]).name)
        return output.decode('utf-8', errors='replace').strip()
    finally:
        stop_child(child)

def git(root: Path, *args):
    return command(['git', *args], root)

def verify_binding(root: Path, binding, require_ancestor=True):
    if binding['kind'] == 'git':
        commit = binding['commit']
        if not re.fullmatch(r'[a-f0-9]{40}', commit):
            raise Waiting('설계 커밋이 잘못되었습니다.')
        if require_ancestor:
            git(root, 'merge-base', '--is-ancestor', commit, 'HEAD')
        for path_key, hash_key in [('designPath', 'designSha256'), ('testPlanPath', 'testPlanSha256')]:
            path = binding[path_key]
            checked_path(root, path)
            data = subprocess.run(['git', 'show', f'{commit}:{path}'], cwd=root, capture_output=True, check=True).stdout
            if sha(data) != binding[hash_key]:
                raise Waiting('승인한 설계와 테스트 계획이 바뀌었습니다.')
    else:
        for item in binding['files']:
            path = checked_path(root, item['path'])
            if not path.is_file() or sha(path.read_bytes()) != item['sha256']:
                raise Waiting('승인 후 문서 원본이 바뀌었습니다.')

class Client:
    def __init__(self, config):
        self.base = config['url'].rstrip('/')
        from urllib.parse import urlparse
        parsed = urlparse(self.base)
        if parsed.username or parsed.password or (parsed.scheme != 'https' and parsed.hostname not in ('127.0.0.1', 'localhost')):
            raise Waiting('등록된 HTTPS 서버 주소가 필요합니다.')
        credential = Path(config['credentialFile']).expanduser()
        if credential.stat().st_mode & 0o077:
            raise Waiting('자격증명 파일은 0600 권한이어야 합니다.')
        lines = credential.read_text().splitlines()
        self.token = next((line.partition('=')[2].strip().strip('"\'') for line in lines if line.startswith('INTERNAL_ADMIN_TOKEN=')), '')
        if not self.token:
            raise Waiting('기존 운영 자격증명이 없습니다.')
        self.machine = config['machineId']
    def request(self, path, body=None):
        headers = {'Authorization': 'Bearer '+self.token, 'X-Supervisor-Machine': self.machine, 'Content-Type': 'application/json'}
        req = urllib.request.Request(self.base+'/api/supervisor/'+path, data=None if body is None else json.dumps(body).encode(), headers=headers, method='GET' if body is None else 'POST')
        # 인증 헤더를 다른 origin으로 전달하지 않는다.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                raise Waiting('서버 리디렉션을 거부했습니다.')
        try:
            with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                code=json.loads(error.read(16000)).get('error','REQUEST_REJECTED')
            except (ValueError,OSError):
                code='REQUEST_REJECTED'
            if not isinstance(code,str) or not re.fullmatch(r'[A-Z_]{1,80}',code):code='REQUEST_REJECTED'
            raise Rejected(error.code,code) from None
        except (OSError, ValueError):
            raise Waiting('서버 연결을 확인해야 합니다.') from None

def report(client, run, kind, summary, session=None, evidence=None, checkpoint=None):
    if (STATE/'outbox.json').exists():
        flush_outbox(client)
    body = {'requestId':str(uuid.uuid4()),'generation':run['generation'],'kind':kind,'sessionId':session,'summary':summary,'evidence':evidence or [],'checkpoint':checkpoint or {}}
    outbox = STATE/'outbox.json'
    private_json(outbox, {'runId':run['id'],'body':body})
    result = client.request(f"runs/{run['id']}/report", body)
    outbox.unlink(missing_ok=True)
    return result

def flush_outbox(client):
    path = STATE/'outbox.json'
    if path.exists():
        item = json.loads(path.read_text())
        client.request(f"runs/{item['runId']}/report", item['body'])
        path.unlink()

def process_identity(pid):
    result = subprocess.run(['ps','-p',str(pid),'-o','lstart=','-o','args='],capture_output=True,text=True)
    return result.stdout.strip() if result.returncode == 0 else None

def group_members(group):
    result=subprocess.run(['ps','-axo','pid=,pgid=,stat='],capture_output=True,text=True,timeout=5)
    if result.returncode:
        raise Waiting('작업 프로세스 그룹을 확인하지 못했습니다.')
    members=[]
    for line in result.stdout.splitlines():
        parts=line.split()
        if len(parts)>=3 and parts[1]==str(group) and not parts[2].startswith('Z'):
            members.append(int(parts[0]))
    return members

def stop_group(group):
    for sig,seconds in ((signal.SIGTERM,5),(signal.SIGKILL,5)):
        try:
            os.killpg(group,sig)
        except ProcessLookupError:
            return
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            if not group_members(group):return
            time.sleep(0.1)
    if group_members(group):raise Waiting('작업의 자식 프로세스가 아직 실행 중입니다.')

def stop_child(child):
    # leader가 먼저 종료돼도 같은 그룹의 자식은 계속 쓸 수 있으므로 그룹을 항상 확인한다.
    stop_group(child.pid)
    child.wait(timeout=5)

def codex(config, prompt: str, root: Path, deadline: float, schema: Path, heartbeat=None, journal=None):
    """모델 원시 로그를 저장하지 않고 정확한 세션 ID와 최종 결과만 읽는다."""
    binary = config.get('codex', shutil.which('codex'))
    if not binary:
        raise Waiting('Codex CLI를 찾지 못했습니다.')
    with tempfile.TemporaryDirectory(prefix='supervisor-cli-') as temp:
        output = Path(temp)/'result.json'
        argv = [binary,'exec','--json','--color','never','--output-schema',str(schema),'-o',str(output),'-C',str(root),'-c','approval_policy="never"']
        if heartbeat is None:
            argv.extend(['-s','read-only'])
        # 승인된 작업은 기존 사용자 sandbox 설정을 재사용한다. 전역 설정을 쓰지 않는다.
        argv.append('-')
        child = subprocess.Popen(argv,cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=clean_env(),start_new_session=True)
        session = None
        if journal is not None:
            journal.update(pid=child.pid,identity=process_identity(child.pid))
            private_json(STATE/'active.json',journal)
        try:
            child.stdin.write(prompt.encode())
            child.stdin.close()
            import selectors
            selector = selectors.DefaultSelector()
            selector.register(child.stdout,selectors.EVENT_READ)
            last_beat = 0.0
            buffer = b''
            while selector.get_map():
                if STOPPING or time.monotonic() >= deadline:
                    raise Waiting('승인한 실행 시간이 끝났습니다.')
                if heartbeat and child.poll() is None and time.monotonic()-last_beat >= 25:
                    heartbeat(session)
                    last_beat = time.monotonic()
                for key,_ in selector.select(timeout=1):
                    part = os.read(key.fileobj.fileno(),65536)
                    if not part:
                        selector.unregister(key.fileobj)
                        continue
                    buffer += part
                    while b'\n' in buffer:
                        line,buffer = buffer.split(b'\n',1)
                        try:
                            event = json.loads(line)
                        except ValueError:
                            continue
                        if event.get('type') == 'thread.started':
                            candidate = event.get('thread_id')
                            if not isinstance(candidate,str) or not re.fullmatch(r'[a-f0-9-]{36}',candidate):
                                raise Waiting('CLI 세션 식별자를 확인할 수 없습니다.')
                            if session and session != candidate:
                                raise Waiting('CLI 세션이 바뀌었습니다.')
                            session = candidate
                            if journal is not None:
                                journal['sessionId'] = session
                                private_json(STATE/'active.json',journal)
                    if len(buffer)>2*1024*1024:
                        raise Waiting('CLI 출력 크기를 초과했습니다.')
            child.wait(timeout=5)
            if buffer:
                try:
                    event=json.loads(buffer)
                    candidate=event.get('thread_id')
                    if event.get('type')=='thread.started' and isinstance(candidate,str) and re.fullmatch(r'[a-f0-9-]{36}',candidate):
                        if session and session!=candidate:raise Waiting('CLI 세션이 바뀌었습니다.')
                        session=candidate
                        if journal is not None:
                            journal['sessionId']=session
                            private_json(STATE/'active.json',journal)
                except ValueError:
                    pass
            if child.returncode != 0 or not output.exists() or not session:
                raise Waiting('Codex 실행이 중단됐습니다. 한도와 권한을 확인해야 합니다.')
            return json.loads(output.read_text()),session
        finally:
            stop_child(child)
            if child.stdout:
                child.stdout.close()

def verify_result(root:Path, payload, result, deadline, monitor=None):
    evidence=[]
    for argv in payload['testCommands']:
        output=command(argv,root,max(1,deadline-time.monotonic()),monitor)
        evidence.append('file:test-output-sha256:'+sha(output.encode()))
    proof=payload['verification']
    if proof['kind']=='github-pr':
        url=result.get('prUrl','')
        if not re.fullmatch('https://github.com/'+re.escape(proof['repository'])+r'/pull/\d+',url):
            raise Waiting('승인한 저장소의 PR 결과가 필요합니다.')
        readback=json.loads(command(['gh','pr','view',url,'--json','state,headRefOid,mergeCommit,statusCheckRollup'],root,max(1,deadline-time.monotonic()),monitor))
        if readback['state']!='MERGED' or not readback.get('mergeCommit'):
            raise Waiting('PR 병합 결과를 확인하지 못했습니다.')
        if readback['headRefOid']!=git(root,'rev-parse','HEAD'):
            raise Waiting('PR과 검증한 소스가 다릅니다.')
        if any(check.get('conclusion') not in ('SUCCESS','NEUTRAL','SKIPPED') and check.get('state')!='SUCCESS' for check in readback.get('statusCheckRollup',[])):
            raise Waiting('PR 검사 결과가 통과 상태가 아닙니다.')
        evidence.append(url)
    elif proof['kind']=='files':
        for item in proof['files']:
            if sha(checked_path(root,item['path']).read_bytes())!=item['sha256']:
                raise Waiting('승인한 문서 결과와 다릅니다.')
            evidence.append('file:'+item['path']+'#sha256='+item['sha256'])
    else:
        output=command(proof['argv'],root,max(1,deadline-time.monotonic()),monitor)
        if proof['expectedText'] not in output:
            raise Waiting('외부 상태 재조회 결과가 예상과 다릅니다.')
        evidence.append('file:provider-readback-sha256:'+sha(output.encode()))
    return evidence

def execute(client,config,run):
    p=run['workProposal']['payload']
    mapping=config['targets'].get(p['targetId'])
    if not mapping:
        raise Waiting('PC에 등록된 대상 경로가 없습니다.')
    root=Path(mapping['path']).expanduser().resolve()
    journal={'runId':run['id'],'generation':run['generation'],'sessionId':None,'pid':None,'identity':None,'root':str(root),'targetId':p['targetId']}
    private_json(STATE/'active.json',journal)
    (STATE/'claim-intent.json').unlink(missing_ok=True)
    session=None
    deadline=time.monotonic()+p['timeLimitMinutes']*60
    workspace=root
    try:
        report(client,run,'checkpoint','승인한 원본을 확인하고 실행을 준비합니다.',checkpoint={'phase':'preparing'})
        verify_binding(root,p['binding'],require_ancestor=False)
        if p['binding']['kind']=='git':
            workspace=STATE/'worktrees'/run['id']
            workspace.parent.mkdir(parents=True,exist_ok=True)
            git(root,'worktree','add','-b','supervisor/'+run['id'],str(workspace),p['binding']['commit'])
        else:
            workspace=STATE/'documents'/run['id']
            workspace.mkdir(parents=True,exist_ok=False)
            for item in p['binding']['files']:
                destination=checked_path(workspace,item['path'])
                destination.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(checked_path(root,item['path']),destination)
            git(workspace,'init','-q')
        journal['workspace']=str(workspace)
        private_json(STATE/'active.json',journal)
        prompt=(Path(__file__).with_name('execution.md').read_text()+'\n승인된 검토본:\n'+json.dumps(p,ensure_ascii=False))
        def heartbeat(sid):
            report(client,run,'heartbeat','승인한 작업을 실행하고 있습니다.',sid,checkpoint={'phase':'executing'})
        result,session=codex(config,prompt,workspace,deadline,Path(__file__).with_name('result.schema.json'),heartbeat,journal)
        if result.get('status')!='completed':
            raise Waiting(result.get('summary','추가 확인을 기다립니다.'))
        verify_binding(workspace,p['binding']) if p['binding']['kind']=='git' else None
        def monitor(child):
            journal.update(pid=child.pid,identity=process_identity(child.pid))
            private_json(STATE/'active.json',journal)
            report(client,run,'heartbeat','승인한 테스트와 결과를 다시 확인하고 있습니다.',session,checkpoint={'phase':'verifying'})
        evidence=verify_result(workspace,p,result,deadline,monitor)
        if p['binding']['kind']=='files':
            expected={item['path'] for item in p['binding']['files']}
            actual={item['path'] for item in p['verification'].get('files',[])}
            if p['verification']['kind']!='files' or expected!=actual:
                raise Waiting('승인한 문서 파일 목록과 결과 목록이 다릅니다.')
            verify_binding(root,p['binding'])
            for item in p['verification']['files']:
                destination=checked_path(root,item['path'])
                # 파일마다 적용 직전 원본을 다시 확인한다. 완료 후 불명확한 쓰기는 재적용하지 않는다.
                before=next(f for f in p['binding']['files'] if f['path']==item['path'])
                if sha(destination.read_bytes())!=before['sha256']:
                    raise Waiting('적용 직전에 문서 원본이 바뀌었습니다.')
                fd,name=tempfile.mkstemp(dir=destination.parent)
                with os.fdopen(fd,'wb') as out:
                    out.write(checked_path(workspace,item['path']).read_bytes());out.flush();os.fsync(out.fileno())
                os.chmod(name,destination.stat().st_mode & 0o777)
                os.replace(name,destination)
            evidence=verify_result(root,{**p,'testCommands':[]},result,deadline,monitor)
        report(client,run,'succeeded',result['summary'],session,evidence,{'testsPassed':True,'readbackVerified':True,'processStopped':True})
        (STATE/'active.json').unlink(missing_ok=True)
    except Waiting as error:
        report(client,run,'paused',str(error),session or journal.get('sessionId'),['file:'+p['targetId']+':checkpoint'],{'processStopped':True,'phase':'needs_readback','readbackVerified':False})
        (STATE/'active.json').unlink(missing_ok=True)
    # 미반영 worktree와 문서는 보존한다. 완료한 작업만 운영 정리 명령으로 제거한다.

def recover(client):
    path=STATE/'active.json'
    if not path.exists():
        intent=STATE/'claim-intent.json'
        if intent.exists():
            claim=client.request('runs/claim',json.loads(intent.read_text()))
            if claim.get('run'):
                run=claim['run']
                checkpoint=run.get('checkpoint') or {}
                if checkpoint.get('claimRequestId')==json.loads(intent.read_text())['requestId'] and not checkpoint.get('phase'):
                    return run
                raise Waiting('실행 시작 기록이 있어 자동으로 다시 실행하지 않습니다.')
            active=claim.get('active')
            if active:
                state=client.request('runs/'+active['id'])
                if state['activeRunId']==active['id']:
                    checkpoint=active.get('checkpoint') or {}
                    if active['executionOwner']!=client.machine or checkpoint.get('claimRequestId')!=json.loads(intent.read_text())['requestId'] or checkpoint.get('phase'):
                        raise Waiting('기존 claim의 실제 실행 상태를 확인해야 합니다.')
                    report(client,active,'stopped','claim 응답 유실 뒤 CLI 실행 전 중단을 확인했습니다.',evidence=['file:claim-intent-readback'],checkpoint={'processStopped':True,'readbackVerified':True})
                elif active['status'] not in ('SUCCEEDED','FAILED','CANCELLED','EXPIRED'):
                    raise Waiting('기존 claim의 실제 실행 상태를 확인해야 합니다.')
                intent.unlink();return
            intent.unlink()
        flush_outbox(client)
        return
    j=json.loads(path.read_text())
    if j.get('pid'):
        observed=process_identity(j['pid'])
        if observed is not None and observed!=j.get('identity'):
            raise Waiting('기존 프로세스 식별자가 재사용됐습니다. 원격 상태와 세션을 확인해야 합니다.')
        stop_group(j['pid'])
    # 먼저 중단을 확인한 뒤 서버의 확정 결과와 응답 유실을 대조한다.
    state=client.request('runs/'+j['runId'])
    recorded=state['run']
    if not isinstance(recorded,dict):raise Waiting('서버에서 기존 실행을 찾지 못했습니다.')
    outbox=STATE/'outbox.json'
    if outbox.exists():
        pending=json.loads(outbox.read_text())
        try:
            flush_outbox(client)
        except Rejected as error:
            if error.status!=409 or error.code not in ('RUN_LEASE_LOST','RUN_OWNERSHIP_LOST'):
                raise
            if pending['runId']!=j['runId'] or pending['body']['generation']!=j['generation']:
                raise Waiting('재전송 기록과 실행 세대가 다릅니다.')
            if recorded['generation']!=j['generation']:
                raise Waiting('서버 실행 세대가 달라졌습니다.')
            # 확정 거절된 보고도 보존하고 새 상태 보고만 별도 요청으로 보낸다.
            os.replace(outbox,STATE/('rejected-'+pending['body']['requestId']+'.json'))
    state=client.request('runs/'+j['runId'])
    recorded=state['run']
    if state['activeRunId']!=j['runId']:
        if recorded['status'] not in ('SUCCEEDED','FAILED','CANCELLED','EXPIRED'):
            raise Waiting('서버의 실행 소유권을 확인해야 합니다.')
        path.unlink()
        return
    if recorded.get('localState')=='PAUSED':
        path.unlink()
        return
    root=Path(j.get('workspace',j['root']))
    evidence=['file:'+j['targetId']+':checkpoint']
    if (root/'.git').exists():
        git(root,'status','--porcelain')
        head=subprocess.run(['git','rev-parse','--verify','HEAD'],cwd=root,capture_output=True)
        if head.returncode==0:evidence.append('git:'+head.stdout.decode().strip())
    report(client,{'id':j['runId'],'generation':j['generation']},'paused','재시작 후 기존 프로세스 그룹 중단과 파일 상태를 확인했습니다. 외부 결과는 확인이 필요하며 쓰기를 반복하지 않습니다.',j.get('sessionId'),evidence,{'processStopped':True,'phase':'needs_external_readback'})
    path.unlink()

def observe(client,config,sources):
    observations=[]
    now=iso()
    expiry=(dt.datetime.now(UTC)+dt.timedelta(days=2)).isoformat(timespec='milliseconds').replace('+00:00','Z')
    for target_id,mapping in config['targets'].items():
        root=Path(mapping['path']).expanduser()
        if not root.is_dir():
            continue
        item={'id':target_id,'name':mapping['name'],'kind':mapping['kind'],'repository':mapping.get('repository'),'appId':mapping.get('appId'),'policySha':sources.get('policySha') if mapping['kind']=='APP' else None,'enabled':True}
        client.request('targets',item)
        if (root/'.git').exists():
            remotes=git(root,'remote').splitlines()
            if 'origin' in remotes:git(root,'fetch','-q','origin')
            state=git(root,'status','--porcelain')
            head=git(root,'rev-parse','HEAD')
            summary=f'로컬 HEAD {head}, 변경 항목 {len(state.splitlines())}개. 사용자 작업은 보존한다.'
            refs=['git:'+head]
        else:
            summary='집필 폴더를 확인했다. 원문은 PC에서 검토하고 서버에는 필요한 검토본만 보낸다.'
            refs=['file:registered-writing-folder']
        problem='local-snapshot'
        observations.append({'id':sha((target_id+problem+now).encode()),'targetId':target_id,'problemKey':problem,'source':'local','summary':summary,'references':refs,'observedAt':now,'expiresAt':expiry,'waitUntil':None,'samples':1,'minSamples':1})
    app_targets={item.get('appId'):key for key,item in config['targets'].items() if item.get('appId')}
    for item in sources.get('issues',[]):
        target=app_targets.get(item['appId'])
        if not target or item.get('isBlocked') or item.get('linkedPrUrl'):
            continue
        observed=item['ghUpdatedAt']
        expires=(dt.datetime.fromisoformat(observed.replace('Z','+00:00'))+dt.timedelta(days=7)).isoformat(timespec='milliseconds').replace('+00:00','Z')
        observations.append({'id':sha((item['repoFullName']+str(item['number'])+observed).encode()),'targetId':target,'problemKey':'issue-'+str(item['number']),'source':'github','summary':item['title'],'references':[f"https://github.com/{item['repoFullName']}/issues/{item['number']}"],'observedAt':observed,'expiresAt':expires,'waitUntil':None,'samples':1,'minSamples':1})
    fallback=next((key for key,item in config['targets'].items() if item['kind']=='ENVIRONMENT'),None)
    for group,field,summary in [('incidents','lastDetectedAt',lambda item:item['summary']),('releases','lastObservedAt',lambda item:'마켓에서 읽은 상태: '+item['state']),('reviews','lastObservedAt',lambda item:str(item['rating'])+'점 사용자 리뷰 관측, '+item['store']),('collections','startedAt',lambda item:item['source']+' 수집 '+item['status']+', '+str(item.get('errorCode') or '상세 확인 필요'))]:
        for item in sources.get(group,[]):
            target=app_targets.get(item.get('appId')) or (fallback if not item.get('appId') else None)
            if not target:continue
            observed=item[field]
            expires=(dt.datetime.fromisoformat(observed.replace('Z','+00:00'))+dt.timedelta(days=7)).isoformat(timespec='milliseconds').replace('+00:00','Z')
            observations.append({'id':sha((group+item['id']+observed).encode()),'targetId':target,'problemKey':group+'-'+(sha((item['source']+item.get('target','')+str(item.get('appId'))).encode())[:24] if group=='collections' else item['id']),'resolved':group=='collections' and item['status'] in ('observed','empty','not_applicable'),'source':group,'summary':summary(item),'references':['https://backoffice.vzyx.xyz/'+('feedback' if group in ('reviews','releases') else 'settings/health')+'#'+item['id']],'observedAt':observed,'expiresAt':expires,'waitUntil':None,'samples':1,'minSamples':1})
    for start in range(0,len(observations),100):
        client.request('observations',observations[start:start+100])
    return observations

def prepare_proposal(config,candidate):
    target=config['targets'][candidate['targetId']]
    root=Path(target['path']).expanduser()
    if target['kind'] in ('APP','TOOL','ENVIRONMENT','BOOK') and (root/'.git').exists():
        git(root,'fetch','-q','origin')
        default=git(root,'symbolic-ref','refs/remotes/origin/HEAD')
        baseline=git(root,'rev-parse',default)
        work=STATE/'designs'/str(uuid.uuid4())
        work.parent.mkdir(parents=True,exist_ok=True)
        git(root,'worktree','add','-b','supervisor/design-'+work.name,str(work),baseline)
        path='docs/design/'+dt.date.today().isoformat()+'-supervisor-'+work.name[:8]
        folder=work/path
        folder.mkdir(parents=True)
        design=(candidate['design']+'\n\n## 변경 미리보기\n\n'+candidate['preview']+'\n\n## 승인 범위\n\n'+candidate['scope']+'\n')
        (folder/'design.md').write_text(design)
        plan=candidate.pop('testPlan')
        if plan['release']!=candidate['release']:
            raise Waiting('설계의 출시 범위와 제안의 출시 범위가 다릅니다.')
        plan['baseline']=baseline
        test=json.dumps(plan,ensure_ascii=False,indent=2)+'\n'
        (folder/'test-plan.json').write_text(test)
        git(work,'add',path)
        git(work,'commit','-m','작업 제안의 설계와 테스트 계획을 준비한다')
        commit=git(work,'rev-parse','HEAD')
        candidate['binding']={'kind':'git','commit':commit,'designPath':path+'/design.md','testPlanPath':path+'/test-plan.json','designSha256':sha(design.encode()),'testPlanSha256':sha(test.encode())}
        git(root,'worktree','remove',str(work))
    else:
        candidate.pop('testPlan',None)
        binding=candidate['binding']
        if not isinstance(binding,dict) or binding.get('kind')!='files':
            raise Waiting('비Git 문서의 파일 해시가 필요합니다.')
        verify_binding(root,binding)
    return candidate

def cycle(client,config):
    recovered=recover(client)
    if recovered:
        execute(client,config,recovered)
        return
    snapshot=client.request('snapshot')
    if snapshot['state']['mode']=='PAUSED':
        return
    claim=None
    if snapshot['state']['mode']=='ACTIVE':
        intent={'requestId':str(uuid.uuid4())}
        private_json(STATE/'claim-intent.json',intent)
        claim=client.request('runs/claim',intent)
        if not claim.get('run'):(STATE/'claim-intent.json').unlink(missing_ok=True)
    if claim and claim.get('run'):
        execute(client,config,claim['run'])
        return
    if claim and claim.get('active'):
        raise Waiting('기존 작업 결과를 확인해야 합니다.')
    if snapshot['state']['activeRunId']:
        return
    last_observed=max((o['observedAt'] for o in snapshot['observations'] if o['source']=='local'),default='1970-01-01T00:00:00Z')
    sources=None;observed=None
    if (dt.datetime.now(UTC)-dt.datetime.fromisoformat(last_observed.replace('Z','+00:00'))).total_seconds()>=3600:
        sources=client.request('sources')
        observed=observe(client,config,sources)
    analysis=client.request('analysis/begin',{})
    if analysis:
        try:
            if sources is None:sources=client.request('sources')
            if observed is None:observed=observe(client,config,sources)
            prompt=Path(__file__).with_name('analysis.md').read_text()+'\n등록된 PC 대상:\n'+json.dumps(config['targets'],ensure_ascii=False)+'\n관측과 서버 상태:\n'+json.dumps({'observations':observed,'sources':sources,'proposals':snapshot['proposals']},ensure_ascii=False)
            end=time.monotonic()+max(0,(dt.datetime.fromisoformat(analysis['deadline'].replace('Z','+00:00'))-dt.datetime.now(UTC)).total_seconds())
            result,_=codex(config,prompt,Path(config['analysisRoot']).expanduser(),end,Path(__file__).with_name('analysis.schema.json'))
            for candidate in result['candidates'][:3]:
                if time.monotonic()>=end:raise Waiting('하루 분석 시간이 끝났습니다.')
                prepared=prepare_proposal(config,candidate)
                if time.monotonic()>=end:raise Waiting('하루 분석 시간이 끝났습니다.')
                client.request('proposals',prepared)
        finally:
            client.request('analysis/finish',{'day':analysis['day']})
    if snapshot['state']['mode']=='ACTIVE':
        client.request('publish',{})

def main():
    os.umask(0o077)
    def stop(_signal,_frame):
        global STOPPING
        STOPPING=True
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--once',action='store_true')
    args=parser.parse_args()
    if args.config.stat().st_mode & 0o077:
        raise Waiting('실행기 설정은 0600 권한이어야 합니다.')
    config=json.loads(args.config.read_text())
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (STATE/'runner.lock').open('w') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            return
        client=Client(config)
        while not STOPPING:
            try:
                cycle(client,config)
            except (Waiting,OSError,subprocess.SubprocessError,ValueError,KeyError):
                # 비밀값과 원문, CLI 원시 응답은 출력하지 않는다.
                print(iso()+' 대기: 서버와 기존 작업의 상태 확인이 필요합니다.',flush=True)
            if args.once:
                return
            for _ in range(60):
                if STOPPING:break
                time.sleep(1)
if __name__=='__main__':
    main()
