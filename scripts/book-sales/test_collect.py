import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from datetime import date, datetime, timezone
from pathlib import Path

from collect import month_windows, archive_report, configuration, collect, CollectError


class CollectTests(unittest.TestCase):
    def test_rolls_year_and_leap_month_without_inventing_a_daily_date(self):
        self.assertEqual(month_windows(date(2028, 3, 2)), [('2028-01', '2028-01-31'), ('2028-02', '2028-02-29'), ('2028-03', '2028-03-02')])
        self.assertEqual(month_windows(date(2026, 1, 2)), [('2025-11', '2025-11-30'), ('2025-12', '2025-12-31'), ('2026-01', '2026-01-02')])
        with self.assertRaises(CollectError): month_windows(date(2026, 1, 2), '2027-01')

    def test_archives_and_rechecks_hash_before_removing_only_own_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / 'raw.xlsx'
            raw.write_bytes(b'fixture')
            data, digest, target = archive_report(raw, datetime(2026, 10, 23, tzinfo=timezone.utc), root)
            self.assertFalse(raw.exists())
            self.assertEqual(Path(target).read_bytes(), data)
            raw.write_bytes(b'fixture')
            Path(target).write_bytes(b'bad existing copy')
            with self.assertRaises(CollectError): archive_report(raw, datetime(2026, 10, 23, tzinfo=timezone.utc), root)
            self.assertTrue(raw.exists())
            self.assertEqual(Path(target).read_bytes(), b'bad existing copy')

    def test_reads_registered_environment_as_data_and_rejects_token_redirect_target(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.env'
            path.write_text('export INTERNAL_ADMIN_TOKEN="fixture-token"\nBACKOFFICE_URL=https://backoffice.vzyx.xyz\n')
            self.assertEqual(configuration(path), ('https://backoffice.vzyx.xyz', 'fixture-token'))
            path.write_text('INTERNAL_ADMIN_TOKEN=fixture\nBACKOFFICE_URL=https://example.com\n')
            with self.assertRaises(CollectError): configuration(path)

    def test_auth_failure_marks_current_month_even_if_the_first_old_month_fails(self):
        client = Mock()
        client.run_source.return_value = {'errorCode': 'KDP_AUTH_REQUIRED'}
        with patch.dict('sys.modules', {'agent_browser': SimpleNamespace(BrowserClient=lambda **kwargs: client)}):
            result = collect(SimpleNamespace(since=None, dry_run=True, session=None))
        self.assertFalse(result['ok'])
        self.assertEqual(len(result['results']), 3)
        self.assertTrue(all(row['state'] == 'needs_input' for row in result['results']))
        client.release.assert_called_once()


if __name__ == '__main__':
    unittest.main()
