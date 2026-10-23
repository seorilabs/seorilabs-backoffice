"""등록된 로컬 KDP Edge로 월별 전체 관측을 수집하고 Backoffice에 전송한다."""
import argparse
import calendar
import fcntl
import hashlib
import json
import os
import shlex
import shutil
import sys
import uuid
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo

from kdp_report import parse_report, ReportError

ACCOUNT = 'kdp-wellknowngeek'
ARTIFACT_ROOT = Path('/Volumes/Data/Backup/agent-artifacts')


class CollectError(RuntimeError):
    pass


def month_windows(today, since=None):
    month = date.fromisoformat(since + '-01') if since else date(today.year, today.month, 1)
    if not since:
        for _ in range(2): month = (month - timedelta(days=1)).replace(day=1)
    if month > today or month.year < 2020: raise CollectError('KDP_PERIOD_INVALID')
    result = []
    while month <= today:
        end = min(today, month.replace(day=calendar.monthrange(month.year, month.month)[1]))
        result.append((month.strftime('%Y-%m'), end.isoformat()))
        month = date(month.year + (month.month == 12), month.month % 12 + 1, 1)
    if len(result) > 120: raise CollectError('KDP_PERIOD_INVALID')
    return result


def archive_report(path, now, root=ARTIFACT_ROOT):
    if not root.is_dir(): raise CollectError('KDP_ARCHIVE_FAILED')
    data = path.read_bytes()
    if not 0 < len(data) <= 16 * 1024 * 1024: raise ReportError('KDP_REPORT_INVALID')
    digest = hashlib.sha256(data).hexdigest()
    directory = root / 'book-sales' / now.date().isoformat()
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (digest + '.xlsx')
    if not target.exists():
        with path.open('rb') as source, target.open('xb') as output:
            shutil.copyfileobj(source, output)
            output.flush()
            os.fsync(output.fileno())
    if target.stat().st_size != len(data) or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        raise CollectError('KDP_ARCHIVE_FAILED')
    if path.resolve() != target.resolve(): path.unlink()
    return data, digest, str(target)


def configuration(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        fields = shlex.split(line, comments=True)
        if fields and fields[0] == 'export': fields = fields[1:]
        if len(fields) == 1 and '=' in fields[0]:
            key, value = fields[0].split('=', 1)
            values[key] = value
    token = values.get('INTERNAL_ADMIN_TOKEN')
    origin = values.get('BACKOFFICE_URL', 'https://backoffice.vzyx.xyz').rstrip('/')
    url = urlparse(origin)
    if not token or url.username or url.password or url.query or url.fragment or url.path or not (url.scheme == 'https' and url.hostname == 'backoffice.vzyx.xyz' or url.scheme == 'http' and url.hostname in ['localhost', '127.0.0.1']):
        raise CollectError('KDP_BACKOFFICE_CONFIGURATION_INVALID')
    return origin, token


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(config, payload=None, month=None):
    origin, token = config
    url = origin + '/api/admin/book-sales' + ('?month=' + month if month else '')
    data = json.dumps(payload, ensure_ascii=False).encode() if payload else None
    request = Request(url, data=data, headers={'x-admin-token': token, 'content-type': 'application/json'})
    try:
        with build_opener(NoRedirect).open(request, timeout=60) as response:
            result = json.loads(response.read(2_000_001))
            if result.get('ok') is not True: raise CollectError('KDP_BACKOFFICE_RESPONSE_INVALID')
            return result
    except HTTPError as error:
        raise CollectError(f'KDP_BACKOFFICE_HTTP_{error.code}') from None
    except (URLError, TimeoutError, ValueError):
        raise CollectError('KDP_BACKOFFICE_UNAVAILABLE') from None


def collect(args):
    now = datetime.now(timezone.utc)
    windows = month_windows(now.astimezone(ZoneInfo('Asia/Seoul')).date(), args.since)
    config = None if args.dry_run else configuration(Path.home() / '.config/seorilabs/backoffice.env')
    if config: api(config, month=windows[-1][0])  # 배포와 인증부터 확인한다.
    sys.path.insert(0, str(Path.home() / '.agent/scripts'))
    from agent_browser import BrowserClient
    client = BrowserClient(profile=ACCOUNT)
    results = []
    try: lease = client.load_lease(args.session) if args.session else client.acquire(owner_pid=os.getpid())
    except Exception:
        for month, _ in windows:
            if config: api(config, payload={'schemaVersion': 1, 'account': ACCOUNT, 'month': month, 'runId': str(uuid.uuid4()), 'capturedAt': now.isoformat(), 'kind': 'failure', 'errorCode': 'KDP_BROWSER_UNAVAILABLE'})
        return {'ok': False, 'errorCode': 'KDP_BROWSER_UNAVAILABLE'}
    try:
        for index, (month, end) in enumerate(windows):
            run_id = str(uuid.uuid4())
            captured = datetime.now(timezone.utc)
            common = {'schemaVersion': 1, 'account': ACCOUNT, 'month': month, 'runId': run_id, 'capturedAt': captured.isoformat()}
            source = f'MONTH={month!r}\nPERIOD_END={end!r}\nRUN_ID={run_id!r}\n' + Path(__file__).with_name('browser_task.py').read_text()
            try:
                download = client.run_source(lease, source, timeout=120)
                if download.get('errorCode'): raise CollectError(download['errorCode'])
                try: data, digest, archived = archive_report(Path(download['path']), captured)
                except OSError: raise CollectError('KDP_ARCHIVE_FAILED') from None
                rows = parse_report(data, month, end)
                payload = {**common, 'kind': 'snapshot', 'periodEnd': end, 'sourceHash': digest, 'rows': rows}
                if config: api(config, payload=payload)
                results.append({'month': month, 'state': 'observed' if rows else 'empty', 'rows': len(rows), 'sourceHash': digest, 'archive': archived})
            except (CollectError, ReportError) as error:
                code = str(error)
                if code not in ['KDP_AUTH_REQUIRED', 'KDP_DOWNLOAD_FAILED', 'KDP_REPORT_INVALID', 'KDP_ARCHIVE_FAILED']: raise
                pending = windows[index:] if code in ['KDP_AUTH_REQUIRED', 'KDP_ARCHIVE_FAILED'] else [(month, end)]
                for pending_month, _ in pending:
                    if config: api(config, payload={**common, 'month': pending_month, 'kind': 'failure', 'errorCode': code})
                    results.append({'month': pending_month, 'state': 'needs_input' if code == 'KDP_AUTH_REQUIRED' else 'failed', 'errorCode': code})
                if len(pending) > 1 or code in ['KDP_AUTH_REQUIRED', 'KDP_ARCHIVE_FAILED']: break
        return {'ok': len(results) == len(windows) and all(r['state'] in ['observed', 'empty'] for r in results), 'dryRun': args.dry_run, 'results': results}
    finally:
        if not args.session: client.release(lease)


def main():
    parser = argparse.ArgumentParser(description='KDP 월별 판매 보고서 수집')
    parser.add_argument('--since', help='초기 이력 시작 월, 생략하면 현재 월과 이전 두 달')
    parser.add_argument('--session', help='현재 작업이 소유한 기존 Edge 세션 ID')
    parser.add_argument('--dry-run', action='store_true', help='실제 다운로드, 파싱과 NAS 보관만 실행하고 서버에 보내지 않음')
    parser.add_argument('--status', action='store_true', help='최근 월의 서버 저장 결과 조회')
    args = parser.parse_args()
    directory = Path.home() / '.local/state/seorilabs/book-sales'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'collect.lock').open('a+') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'ok': False, 'errorCode': 'KDP_COLLECTION_ALREADY_RUNNING'}))
            return 1
        try:
            result = api(configuration(Path.home() / '.config/seorilabs/backoffice.env'), month=args.since or datetime.now(ZoneInfo('Asia/Seoul')).strftime('%Y-%m')) if args.status else collect(args)
        except Exception as error:
            # 공급자 예외에는 인증 URL이나 비밀값이 들어갈 수 있어 원문을 출력하지 않는다.
            code = str(error) if isinstance(error, (CollectError, ReportError)) else 'KDP_COLLECTION_FAILED'
            result = {'ok': False, 'errorCode': code}
        output = json.dumps(result, ensure_ascii=False)
        (directory / 'last-result.json').write_text(output + '\n')
        print(output)
        return 0 if result.get('ok') else 1


if __name__ == '__main__':
    raise SystemExit(main())
