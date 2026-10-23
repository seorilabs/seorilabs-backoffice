import io
import unittest
import zipfile
from xml.sax.saxutils import escape

from kdp_report import parse_report, ReportError


def workbook(sheets):
    out = io.BytesIO()
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    with zipfile.ZipFile(out, 'w') as archive:
        names = ''.join(f'<sheet name="{name}" sheetId="{i}" r:id="rId{i}"/>' for i, name in enumerate(sheets, 1))
        archive.writestr('xl/workbook.xml', f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{names}</sheets></workbook>')
        rels = ''.join(f'<Relationship Id="rId{i}" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1))
        archive.writestr('xl/_rels/workbook.xml.rels', f'<Relationships>{rels}</Relationships>')
        for i, rows in enumerate(sheets.values(), 1):
            xml = ''.join('<row>' + ''.join(f'<c t="inlineStr"><is><t>{escape(str(v))}</t></is></c>' for v in row) + '</row>' for row in rows)
            archive.writestr(f'xl/worksheets/sheet{i}.xml', f'<worksheet xmlns="{ns}"><sheetData>{xml}</sheetData></worksheet>')
    return out.getvalue()


def sheets():
    royalty = ['Royalty Date', 'Title', 'ASIN', 'Marketplace', 'Units Sold', 'Units Refunded', 'Net Units Sold', 'Royalty', 'Currency', 'Transaction Type']
    return {
        'Summary': [['Date', 'Royalty (USD)', 'Net Units Sold (Paperback)'], ['October 2026', '3.58', '2']],
        'Combined Sales': [royalty, ['2026-10-10', 'Example', 'B000000001', 'Amazon.com', 2, 0, 2, '3.58', 'USD', 'Standard - Paperback']],
        'eBook Royalty': [royalty],
        'Paperback Royalty': [royalty, ['2026-10-10', 'Example', 'B000000001', 'Amazon.com', 3, 1, 2, '3.58', 'USD', 'Standard - Paperback']],
        'Hardcover Royalty': [royalty],
        'Orders Processed': [['Date', 'Title', 'ASIN', 'Marketplace', 'Paid Units', 'Free Units'], ['2026-10-10', 'Example', 'B000000001', 'Amazon.com', 3, 2]],
        'KENP': [['Date', 'Title', 'eBook ASIN', 'Marketplace', 'Kindle+ Pages Read', 'Kindle+ Pages Listened', 'Total Kindle+ Pages Read and Listened'], ['2026-10-10', 'Example', 'B000000002', 'Amazon.co.uk', 42, 7, 49]],
    }


class ReportTests(unittest.TestCase):
    def test_separates_orders_refunds_pages_and_royalties_without_combined_duplicate(self):
        rows = parse_report(workbook(sheets()), '2026-10', '2026-10-23')
        royalties = [r for r in rows if r['kind'] == 'royalty']
        self.assertEqual(len(royalties), 1)
        self.assertEqual(royalties[0]['netUnits'], 2)
        self.assertEqual(royalties[0]['refunds'], 1)
        self.assertEqual(royalties[0]['royalty'], '3.58')
        self.assertEqual(next(r for r in rows if r['kind'] == 'orders')['freeUnits'], 2)
        self.assertEqual(next(r for r in rows if r['kind'] == 'kenp')['pagesListened'], 7)

    def test_preserves_month_grain(self):
        data = sheets()
        for name, rows in data.items():
            if name != 'Summary':
                for row in rows[1:]: row[0] = '2026-10'
        result = parse_report(workbook(data), '2026-10', '2026-10-31')
        self.assertEqual({r['date'] for r in result}, {'2026-10'})

    def test_valid_empty_report(self):
        data = {k: v[:1] for k, v in sheets().items()}
        data['Summary'].append(['October 2026', '0', '0'])
        self.assertEqual(parse_report(workbook(data), '2026-10', '2026-10-23'), [])

    def test_missing_sheet_and_column_fail_instead_of_zero(self):
        data = sheets()
        del data['KENP']
        with self.assertRaises(ReportError): parse_report(workbook(data), '2026-10', '2026-10-23')
        data = sheets()
        data['Paperback Royalty'][0][5] = 'Unknown refund column'
        with self.assertRaises(ReportError): parse_report(workbook(data), '2026-10', '2026-10-23')

    def test_rejects_wrong_period_bad_numbers_and_subtotal(self):
        for column, bad in [(0, '2026-11-01'), (0, '2026-10-32'), (4, '1.5'), (6, '999'), (7, 'NaN')]:
            data = sheets()
            data['Paperback Royalty'][1][column] = bad
            with self.assertRaises(ReportError): parse_report(workbook(data), '2026-10', '2026-10-23')
        data = sheets()
        data['Summary'][1][1] = '999'
        with self.assertRaises(ReportError): parse_report(workbook(data), '2026-10', '2026-10-23')

    def test_keeps_currencies_separate(self):
        data = sheets()
        data['Summary'][0].append('Royalty (GBP)')
        data['Summary'][1].append('0.1234')
        data['eBook Royalty'].append(['2026-10-02', 'Example UK', 'B000000003', 'Amazon.co.uk', 1, 0, 1, '0.123400', 'GBP', '70%'])
        result = parse_report(workbook(data), '2026-10', '2026-10-23')
        self.assertEqual({r['currency'] for r in result if r['kind'] == 'royalty'}, {'USD', 'GBP'})


if __name__ == '__main__':
    unittest.main()
