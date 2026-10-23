"""검증된 커밋의 수집기를 별도 설치하고 매일 09:00 KST launchd 작업을 등록한다."""
import hashlib
import argparse
import json
import os
import plistlib
import shutil
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

LABEL = 'xyz.seorilabs.book-sales'
FILES = ['collect.py', 'browser_task.py', 'kdp_report.py']


def previous_install(home, plist, expected):
    if plist.is_symlink() or plist.stat().st_uid != os.getuid(): raise RuntimeError('EXISTING_LAUNCH_AGENT_PRESERVED')
    original = plist.read_bytes()
    document = plistlib.loads(original)
    old = home / '.local/share/seorilabs/book-sales' / expected
    if old.is_symlink() or old.stat().st_uid != os.getuid(): raise RuntimeError('INSTALL_OWNER_MISMATCH')
    manifest = json.loads((old / 'installation.json').read_text())
    if manifest['sourceSha'] != expected or set(manifest['files']) != set(FILES): raise RuntimeError('INSTALL_SOURCE_MISMATCH')
    for name in FILES:
        file = old / name
        if file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != manifest['files'][name]: raise RuntimeError('INSTALL_HASH_MISMATCH')
    if document.get('Label') != LABEL or document.get('WorkingDirectory') != str(old) or document.get('ProgramArguments') != [str(home / '.local/share/seorilabs/playwright/venv/bin/python'), str(old / 'collect.py')] or document.get('StartCalendarInterval') != {'Hour': 9, 'Minute': 0} or document.get('EnvironmentVariables', {}).get('TZ') != 'Asia/Seoul':
        raise RuntimeError('EXISTING_LAUNCH_AGENT_PRESERVED')
    return original, document


def replace_agent(plist, document, original, run=subprocess.run):
    domain = f'gui/{os.getuid()}'
    if original is not None:
        state = run(['launchctl', 'print', f'{domain}/{LABEL}'], check=True, capture_output=True, text=True)
        if 'pid = ' in state.stdout: raise RuntimeError('COLLECTOR_CURRENTLY_RUNNING')
        run(['launchctl', 'bootout', domain, str(plist)], check=True, capture_output=True)
    try:
        with plist.open('wb' if original is not None else 'xb') as output: plistlib.dump(document, output)
        plist.chmod(0o600)
        run(['launchctl', 'bootstrap', domain, str(plist)], check=True, capture_output=True)
    except Exception:
        if original is not None:
            plist.write_bytes(original)
            run(['launchctl', 'bootstrap', domain, str(plist)], check=True, capture_output=True)
        else: plist.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--replace-source', help='현재 설치와 해시가 일치할 때만 지정한 이전 커밋에서 교체')
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    repo = here.parent.parent
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    for name in FILES:
        tracked = subprocess.check_output(['git', 'show', f'{sha}:scripts/book-sales/{name}'], cwd=repo)
        if tracked != (here / name).read_bytes(): raise RuntimeError('COMMITTED_COLLECTOR_REQUIRED')
    if datetime.now().astimezone().utcoffset() != timedelta(hours=9): raise RuntimeError('HOST_KST_TIME_REQUIRED')
    home = Path.home()
    plist = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    original, previous = (None, None)
    if plist.exists() or plist.is_symlink():
        if not args.replace_source or len(args.replace_source) != 40 or any(c not in '0123456789abcdef' for c in args.replace_source): raise RuntimeError('EXISTING_LAUNCH_AGENT_PRESERVED')
        original, previous = previous_install(home, plist, args.replace_source)
    elif args.replace_source: raise RuntimeError('EXPECTED_INSTALL_MISSING')
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
    if previous:
        document = {**previous, 'ProgramArguments': document['ProgramArguments'], 'WorkingDirectory': document['WorkingDirectory']}
    replace_agent(plist, document, original)
    print(json.dumps({'label': LABEL, 'sourceSha': sha, 'schedule': '매일 09:00 KST', 'plist': str(plist), 'installed': str(destination)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
