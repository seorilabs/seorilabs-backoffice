"""MONTH, PERIOD_END, RUN_ID는 수집기가 넣는 비민감 실행 인자다."""


async def main(session):
    from datetime import date
    from playwright.async_api import expect
    from urllib.parse import urlparse
    page = session.page()
    await page.goto('https://kdpreports.amazon.com/royalties', wait_until='domcontentloaded')
    if urlparse(page.url).hostname != 'kdpreports.amazon.com':
        return {'errorCode': 'KDP_AUTH_REQUIRED'}
    phase = 'filters'
    try:
        await page.get_by_role('textbox', name='Start Date', exact=True).wait_for(timeout=30000)
        for label in ['All authors', 'All marketplaces', 'All formats', 'All distributions']:
            await page.get_by_role('button', name=label, exact=True).wait_for(timeout=10000)
        reset = page.get_by_role('button', name='Reset filters', exact=True)
        if await reset.is_enabled(): await reset.click()
        phase = 'dates'
        start, end = date.fromisoformat(MONTH + '-01'), date.fromisoformat(PERIOD_END)
        first = page.get_by_role('textbox', name='Start Date', exact=True)
        last = page.get_by_role('textbox', name='End Date', exact=True)
        # 시작일을 먼저 바꾸면 현재 종료일보다 뒤인 월에는 유효하지 않은 범위가 된다.
        await first.fill(start.strftime('%m/%d/%Y'))
        await first.press('Tab')
        await last.fill(end.strftime('%m/%d/%Y'))
        await last.press('Tab')
        await expect(page.get_by_text('Content is loading', exact=True).filter(visible=True)).to_have_count(0, timeout=30000)
        if await first.input_value() != start.strftime('%m/%d/%Y') or await last.input_value() != end.strftime('%m/%d/%Y'):
            return {'errorCode': 'KDP_REPORT_INVALID'}
        phase = 'download'
        async with page.expect_download(timeout=60000) as info:
            await page.get_by_role('button', name='Download report', exact=True).click()
        download = await info.value
        path = await session.save_download(download, f'kdp-{MONTH}-{RUN_ID}.xlsx')
        return {'path': str(path)}
    except Exception as error:
        return {'errorCode': 'KDP_AUTH_REQUIRED' if urlparse(page.url).hostname != 'kdpreports.amazon.com' else 'KDP_DOWNLOAD_FAILED', 'phase': phase, 'errorType': type(error).__name__}
