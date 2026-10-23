"""KDP 공식 XLSX의 관측 단위와 통화를 보존한다. 고객 정보와 중복 합계 시트는 읽지 않는다."""
import calendar
import io
import posixpath
import re
import zipfile
from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation
from xml.etree import ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'


class ReportError(ValueError):
    pass


def require(condition):
    if not condition: raise ReportError('KDP_REPORT_INVALID')


def number(value):
    require(bool(re.fullmatch(r'-?\d+(?:\.\d+)?', value)))
    try: result = Decimal(value)
    except InvalidOperation: raise ReportError('KDP_REPORT_INVALID') from None
    require(result.is_finite() and abs(result) < Decimal('1000000000000'))
    return result


def units(value):
    result = number(value)
    require(result == result.to_integral_value() and result >= 0)
    return int(result)


def calendar_date(value):
    try: return date.fromisoformat(value)
    except ValueError: raise ReportError('KDP_REPORT_INVALID') from None


def text_nodes(node):
    return ''.join(t.text or '' for t in node.findall('.//m:t', NS))


def read_sheets(data):
    require(0 < len(data) <= 16 * 1024 * 1024)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            require(len(infos) <= 1000 and len({i.filename for i in infos}) == len(infos))
            require(sum(i.file_size for i in infos) <= 32 * 1024 * 1024)

            def xml(path):
                raw = archive.read(path)
                require(b'<!DOCTYPE' not in raw.upper() and b'<!ENTITY' not in raw.upper())
                return ET.fromstring(raw)

            strings = [text_nodes(v) for v in xml('xl/sharedStrings.xml').findall('m:si', NS)] if 'xl/sharedStrings.xml' in archive.namelist() else []
            rels = {v.attrib['Id']: v for v in xml('xl/_rels/workbook.xml.rels')}
            result = {}
            for sheet in xml('xl/workbook.xml').findall('m:sheets/m:sheet', NS):
                name = sheet.attrib['name']
                require(name not in result)
                rel = rels[sheet.attrib[REL]]
                require(rel.attrib.get('TargetMode') != 'External')
                target = rel.attrib['Target']
                path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
                require(path.startswith('xl/worksheets/') and path.endswith('.xml'))
                rows = []
                for row in xml(path).findall('m:sheetData/m:row', NS):
                    cells = []
                    for cell in row.findall('m:c', NS):
                        match = re.fullmatch(r'([A-Z]+)\d+', cell.attrib.get('r', ''))
                        column = 0
                        if match:
                            for letter in match[1]: column = column * 26 + ord(letter) - 64
                            column -= 1
                        else: column = len(cells)
                        require(column < 200)
                        while len(cells) <= column: cells.append('')
                        value = cell.find('m:v', NS)
                        value = value.text or '' if value is not None else ''
                        if cell.attrib.get('t') == 's': value = strings[int(value)]
                        if cell.attrib.get('t') == 'inlineStr': value = text_nodes(cell)
                        cells[column] = value.strip()
                    if any(cells): rows.append(cells)
                    require(len(rows) <= 20001)
                result[name] = rows
            return result
    except (KeyError, IndexError, ValueError, ET.ParseError, zipfile.BadZipFile, RuntimeError):
        raise ReportError('KDP_REPORT_INVALID') from None


def records(sheets, name, required):
    require(name in sheets and bool(sheets[name]))
    header, *rows = sheets[name]
    require(len(set(header)) == len(header) and set(required).issubset(header))
    require(all(len(row) <= len(header) for row in rows))
    return [dict(zip(header, row + [''] * (len(header) - len(row)))) for row in rows]


def parse_report(data, month, period_end):
    require(bool(re.fullmatch(r'\d{4}-\d{2}', month)))
    start = calendar_date(month + '-01')
    end = calendar_date(period_end)
    require(start <= end and end.strftime('%Y-%m') == month)
    sheets = read_sheets(data)
    require('Combined Sales' in sheets)
    summary = records(sheets, 'Summary', ['Date', 'Royalty (USD)', 'Net Units Sold (Paperback)'])
    require(len(summary) == 1 and summary[0]['Date'] == f'{calendar.month_name[start.month]} {start.year}')
    result = []
    amounts = defaultdict(Decimal)
    net_by_format = defaultdict(int)

    def base(record, day_column, identifier, format_name):
        day = record[day_column]
        require(day == month or (bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', day)) and start <= calendar_date(day) <= end))
        require(bool(record[identifier]) and bool(record['Title']) and bool(record['Marketplace']))
        return {'date': day, 'title': record['Title'], 'identifier': record[identifier], 'marketplace': record['Marketplace'], 'format': format_name}

    for sheet, format_name in [('eBook Royalty', 'ebook'), ('Paperback Royalty', 'paperback'), ('Hardcover Royalty', 'hardcover')]:
        header = next(iter(sheets.get(sheet, [])), [])
        identifier = 'ASIN' if 'ASIN' in header else 'ISBN'
        required = ['Royalty Date', 'Title', identifier, 'Marketplace', 'Units Sold', 'Units Refunded', 'Net Units Sold', 'Royalty', 'Currency', 'Transaction Type']
        for record in records(sheets, sheet, required):
            sold, refunds, net = number(record['Units Sold']), units(record['Units Refunded']), number(record['Net Units Sold'])
            require(sold >= 0 and sold == sold.to_integral_value() and net == sold - refunds)
            require(bool(re.fullmatch(r'[A-Z]{3}', record['Currency'])))
            amount = number(record['Royalty'])
            amounts[record['Currency']] += amount
            net_by_format[format_name] += int(net)
            result.append({**base(record, 'Royalty Date', identifier, format_name), 'kind': 'royalty', 'unitsSold': int(sold), 'refunds': refunds, 'netUnits': int(net), 'royalty': format(amount, 'f'), 'currency': record['Currency'], 'transactionType': record['Transaction Type']})

    for currency, amount in amounts.items():
        require(f'Royalty ({currency})' in summary[0])
        require(abs(number(summary[0][f'Royalty ({currency})']) - amount) <= Decimal('0.005'))
    for key, value in summary[0].items():
        match = re.fullmatch(r'Royalty \(([A-Z]{3})\)', key)
        if match: require(abs(number(value) - amounts[match[1]]) <= Decimal('0.005'))
    for label, fmt in [('Net Units Sold (Paperback)', 'paperback'), ('Net Units Sold (Hardcover)', 'hardcover')]:
        if label in summary[0]: require(number(summary[0][label]) == net_by_format[fmt])

    for record in records(sheets, 'Orders Processed', ['Date', 'Title', 'ASIN', 'Marketplace', 'Paid Units', 'Free Units']):
        result.append({**base(record, 'Date', 'ASIN', 'unknown'), 'kind': 'orders', 'paidUnits': units(record['Paid Units']), 'freeUnits': units(record['Free Units'])})
    kenp_fields = ['Date', 'Title', 'eBook ASIN', 'Marketplace', 'Kindle+ Pages Read', 'Kindle+ Pages Listened', 'Total Kindle+ Pages Read and Listened']
    for record in records(sheets, 'KENP', kenp_fields):
        read, listened = units(record['Kindle+ Pages Read']), units(record['Kindle+ Pages Listened'])
        require(read + listened == units(record['Total Kindle+ Pages Read and Listened']))
        result.append({**base(record, 'Date', 'eBook ASIN', 'ebook'), 'kind': 'kenp', 'pagesRead': read, 'pagesListened': listened})
    require(len(result) <= 20000)
    return result
