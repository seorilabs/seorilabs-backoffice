#!/usr/bin/env python3
"""격리 개발 서버에서 승인, 원고 적용과 결과 재조회를 실제로 실행한다."""
import argparse
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import uuid
from playwright.sync_api import sync_playwright

spec=importlib.util.spec_from_file_location('supervisor_runner',Path(__file__).with_name('runner.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
BASE='http://127.0.0.1:33370'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--artifacts',type=Path,required=True);parser.add_argument('--cookies',type=Path,required=True);args=parser.parse_args()
    args.artifacts.mkdir(parents=True,exist_ok=True,mode=0o700)
    target='qa-ui-'+uuid.uuid4().hex[:16]
    old='The fox opened the gate. [unfinished]\n';new='The fox opened the gate and found his friends waiting.\n'
    with tempfile.TemporaryDirectory(prefix='supervisor-ui-source-') as temp,sync_playwright() as playwright:
        root=Path(temp);(root/'chapter.md').write_text(old)
        credential=root/'credential.env';credential.write_text('INTERNAL_ADMIN_TOKEN=supervisor-development-only\n');credential.chmod(0o600)
        fake=root/'fake-codex'
        fake.write_text('#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\nsys.stdin.read()\nprint(json.dumps({"type":"thread.started","thread_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}),flush=True)\nPath("chapter.md").write_text('+repr(new)+')\nPath(sys.argv[sys.argv.index("-o")+1]).write_text(json.dumps({"status":"completed","summary":"승인한 문단과 결과 해시를 확인했습니다.","prUrl":""}))\n');fake.chmod(0o700)
        config={'url':BASE,'machineId':'qa-pc','credentialFile':str(credential),'codex':str(fake),'analysisRoot':str(root),'targets':{target:{'path':str(root),'kind':'WRITING','name':'격리 집필 원고'}}}
        client=r.Client(config)
        client.request('targets',{'id':target,'name':'격리 집필 원고','kind':'WRITING','repository':None,'appId':None,'policySha':None,'enabled':True})
        oid='obs-'+uuid.uuid4().hex
        client.request('observations',[{'id':oid,'targetId':target,'problemKey':'unfinished','source':'writing','summary':'격리 원고의 미완료 문단을 직접 확인했습니다.','references':['file:'+target+'/chapter.md#sha256='+r.sha(old.encode())],'observedAt':r.iso(),'expiresAt':'2099-01-01T00:00:00.000Z','waitUntil':None,'samples':1,'minSamples':1}])
        body={'targetId':target,'problemKey':'unfinished','title':'격리 원고의 마지막 문단을 완성한다','problem':'개발 검수용 원고의 마지막 문단이 미완료입니다.','observationIds':[oid],'scope':'chapter.md 한 파일만 승인한 결과로 바꿉니다.','design':'마지막 문장에 친구들이 기다리고 있었다는 결과를 연결합니다.','preview':'변경 전: '+old+'변경 후: '+new,'acceptance':['미완료 표시가 사라진다','승인한 결과 해시가 일치한다'],'tests':'개발 환경에서 원고와 해시를 검증합니다.','testCommands':[['python3','-c','from pathlib import Path; assert "[unfinished]" not in Path("chapter.md").read_text()']],'verification':{'kind':'files','files':[{'path':'chapter.md','sha256':r.sha(new.encode())}]},'tools':['codex','python'],'executor':'codex','timeLimitMinutes':5,'impact':2,'confidence':1,'effortMinutes':5,'deadline':None,'release':None,'binding':{'kind':'files','files':[{'path':'chapter.md','sha256':r.sha(old.encode())}]}}
        proposal=client.request('proposals',body)
        browser=playwright.chromium.launch(headless=True)
        context=browser.new_context(viewport={'width':390,'height':844});context.add_cookies(json.loads(args.cookies.read_text()))
        page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(BASE+'/work/supervisor?id='+proposal['id'])
        page.get_by_role('heading',name=body['title']).wait_for(timeout=30000)
        page.get_by_text('테스트 계획',exact=True).click();page.get_by_text('실행할 테스트 명령',exact=False).last.wait_for()
        page.screenshot(path=str(args.artifacts/'review-mobile.png'),full_page=True)
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        decision={'version':proposal['version'],'digest':proposal['digest'],'decision':'approve'}
        forbidden=context.request.post(BASE+'/api/supervisor/proposals/'+proposal['id']+'/decision',headers={'Authorization':'Bearer supervisor-development-only','X-Supervisor-Machine':'qa-pc','Origin':BASE},data=decision)
        assert forbidden.status==403
        forged=context.request.post(BASE+'/api/supervisor/proposals/'+proposal['id']+'/decision',headers={'Origin':'https://wrong.example'},data=decision)
        assert forged.status==403
        stale=context.request.post(BASE+'/api/supervisor/proposals/'+proposal['id']+'/decision',headers={'Origin':BASE},data={**decision,'version':999})
        assert stale.status==409
        # 서명된 Slack 요청도 다른 사용자와 채널에서는 승인하지 않는다.
        from urllib.parse import urlencode
        payload={'type':'block_actions','api_app_id':'AQA','team':{'id':'TQA'},'user':{'id':'OTHER'},'channel':{'id':'CQA'},'actions':[{'action_id':f"supervisor:approve:{proposal['id']}:{proposal['version']}:{proposal['digest']}"}]}
        raw=urlencode({'payload':json.dumps(payload)})
        ts=str(int(time.time()));signature='v0='+hmac.new(b'supervisor-qa-signing-only',f'v0:{ts}:{raw}'.encode(),hashlib.sha256).hexdigest()
        context.request.post(BASE+'/api/slack/interactions',data='')
        start=time.monotonic();slack=context.request.post(BASE+'/api/slack/interactions',headers={'content-type':'application/x-www-form-urlencoded','x-slack-request-timestamp':ts,'x-slack-signature':signature},data=raw);elapsed=time.monotonic()-start
        (args.artifacts/'slack-ack.json').write_text(json.dumps({'status':slack.status,'seconds':elapsed,'body':slack.text()}))
        assert slack.status==200 and elapsed<3
        page.get_by_role('button',name='진행',exact=True).click();page.get_by_text('PC 실행 대기',exact=True).wait_for()
        repeated=context.request.post(BASE+'/api/supervisor/proposals/'+proposal['id']+'/decision',headers={'Origin':BASE},data=decision);assert repeated.status==200
        page.get_by_label('운영 모드').select_option('ACTIVE')
        claim_id=str(uuid.uuid4());claim=client.request('runs/claim',{'requestId':claim_id});run=claim['run'];assert run
        assert client.request('runs/claim',{'requestId':claim_id})['run']['id']==run['id']
        original_state=r.STATE;r.STATE=args.artifacts/'runner-state';r.STATE.mkdir(mode=0o700)
        try:r.execute(client,config,run)
        finally:r.STATE=original_state
        readback=client.request('runs/'+run['id']);assert readback['run']['status']=='SUCCEEDED' and readback['activeRunId'] is None
        assert (root/'chapter.md').read_text()==new
        page.reload();page.get_by_role('heading',name='완료',exact=True).wait_for(timeout=30000)
        page.screenshot(path=str(args.artifacts/'completed-mobile.png'),full_page=True)
        assert not errors,errors
        mode=context.request.post(BASE+'/api/supervisor/mode',headers={'Origin':BASE},data={'mode':'OBSERVE'});assert mode.status==200
        result={'target':target,'proposalId':proposal['id'],'runId':run['id'],'completedAt':r.iso(),'uiErrors':errors,'slackAckSeconds':elapsed,'originalSha256':r.sha(old.encode()),'resultSha256':r.sha(new.encode()),'verdict':'passed'}
        (args.artifacts/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        browser.close()
if __name__=='__main__':main()
