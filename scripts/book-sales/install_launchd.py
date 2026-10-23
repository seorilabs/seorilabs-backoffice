"""검증된 커밋의 수집기를 별도 설치하고 매일 09:00 KST launchd 작업을 등록한다."""
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

LABEL = 'xyz.seorilabs.book-sales'
FILES = ['collect.py', 'browser_task.py', 'kdp_report.py']


def main():
    here = Path(__file__).resolve().parent
    repo = here.parent.parent
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    for name in FILES:
        tracked = subprocess.check_output(['git', 'show', f'{sha}:scripts/book-sales/{name}'], cwd=repo)
        if tracked != (here / name).read_bytes(): raise RuntimeError('COMMITTED_COLLECTOR_REQUIRED')
    if datetime.now().astimezone().utcoffset() != timedelta(hours=9): raise RuntimeError('HOST_KST_TIME_REQUIRED')
    home = Path.home()
    plist = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    if plist.exists() or plist.is_symlink(): raise RuntimeError('EXISTING_LAUNCH_AGENT_PRESERVED')
    destination = home / '.local/share/seorilabs/book-sales' / sha
    if destination.exists(): raise RuntimeError('EXISTING_INSTALL_PRESERVED')
    destination.mkdir(parents=True, mode=0o700)
    hashes = {}
    for name in FILES:
        shutil.copyfile(here / name, destination / name)
        hashes[name] = hashlib.sha256((destination / name).read_bytes()).hexdigest()
        if hashes[name] != hashlib.sha256((here / name).read_bytes()).hexdigest(): raise RuntimeError('INSTALL_HASH_MISMATCH')
    (destination / 'installation.json').write_text(json.dumps({'sourceSha': sha, 'files': hashes}, indent=2) + '\n')
    logs = home / 'Library/Logs/Seorilabs'
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    plist.parent.mkdir(parents=True, exist_ok=True)
    document = {
        'Label': LABEL,
        'ProgramArguments': [str(home / '.local/share/seorilabs/playwright/venv/bin/python'), str(destination / 'collect.py')],
        'StartCalendarInterval': {'Hour': 9, 'Minute': 0},
        'ProcessType': 'Background', 'WorkingDirectory': str(destination),
        'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'TZ': 'Asia/Seoul', 'PYTHONDONTWRITEBYTECODE': '1'},
        'StandardOutPath': str(logs / 'book-sales.log'), 'StandardErrorPath': str(logs / 'book-sales-error.log'),
    }
    with plist.open('xb') as output: plistlib.dump(document, output)
    plist.chmod(0o600)
    subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True)
    print(json.dumps({'label': LABEL, 'sourceSha': sha, 'schedule': '매일 09:00 KST', 'plist': str(plist), 'installed': str(destination)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
