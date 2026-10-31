#!/usr/bin/env python3
"""검증한 실행 파일만 사용자 LaunchAgent로 설치한다. 기존 설정은 보존한다."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

LABEL='com.seorilabs.personal-supervisor'
SOURCE=Path(__file__).resolve().parent
DEST=Path.home()/'.local/share/seorilabs/supervisor'
FILES=('runner.py','analysis.md','execution.md','analysis.schema.json','result.schema.json')

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--start',action='store_true')
    args=parser.parse_args()
    config=args.config.expanduser().resolve()
    if config.stat().st_mode & 0o077:
        raise SystemExit('설정 파일은 0600 권한이어야 합니다.')
    settings=json.loads(config.read_text())
    for key in ('url','machineId','credentialFile','analysisRoot','targets'):
        if key not in settings:raise SystemExit('설정 누락: '+key)
    dest=DEST;dest.mkdir(parents=True,exist_ok=True,mode=0o700)
    receipt=dest/'installed.json'
    before=json.loads(receipt.read_text()) if receipt.exists() else {}
    for name in FILES:
        path=dest/name
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()!=before.get(name):
            raise SystemExit('기존 사용자 파일을 보존합니다: '+str(path))
    hashes={}
    for name in FILES:
        data=(SOURCE/name).read_bytes()
        (dest/name).write_bytes(data);(dest/name).chmod(0o600)
        hashes[name]=hashlib.sha256(data).hexdigest()
    receipt.write_text(json.dumps(hashes,indent=2)+'\n');receipt.chmod(0o600)
    plist=Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist'
    state=Path.home()/'.local/state/seorilabs/supervisor';state.mkdir(parents=True,exist_ok=True,mode=0o700)
    payload={'Label':LABEL,'ProgramArguments':[sys.executable,str(dest/'runner.py'),'--config',str(config)],'Umask':0o077,'RunAtLoad':True,'KeepAlive':{'SuccessfulExit':False},'ThrottleInterval':60,'ProcessType':'Background','EnvironmentVariables':{'PATH':os.environ.get('PATH','/usr/bin:/bin')},'StandardOutPath':str(state/'runner.log'),'StandardErrorPath':str(state/'runner-error.log')}
    if plist.exists() and plistlib.loads(plist.read_bytes())!=payload:
        raise SystemExit('기존 LaunchAgent를 보존합니다: '+str(plist))
    plist.parent.mkdir(parents=True,exist_ok=True)
    plist.write_bytes(plistlib.dumps(payload));plist.chmod(0o600)
    subprocess.run(['plutil','-lint',str(plist)],check=True)
    print('설치 파일 SHA-256 대조 완료, LaunchAgent 준비됨')
    if args.start:
        subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True)
        subprocess.run(['launchctl','print',f'gui/{os.getuid()}/{LABEL}'],check=True,capture_output=True)
        print('LaunchAgent 등록 확인')
if __name__=='__main__':main()
