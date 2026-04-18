import asyncio
import os
import sys
import logging
import aiohttp

# Patch requests.get to send GITHUB_TOKEN when Camoufox queries the GitHub API,
# avoiding anonymous rate-limit (60/hr) on first fetch / mmdb download.
if os.getenv('GITHUB_TOKEN'):
    import requests as _rq
    _orig_get = _rq.get
    def _patched_get(url, *a, **kw):
        h = dict(kw.pop('headers', None) or {})
        if 'api.github.com' in url:
            h.setdefault('Authorization', f"Bearer {os.environ['GITHUB_TOKEN']}")
        return _orig_get(url, *a, headers=h, **kw)
    _rq.get = _patched_get
from urllib.parse import urlparse
from browserforge.fingerprints import Screen
from camoufox.async_api import AsyncCamoufox
from playwright_captcha import CaptchaType, ClickSolver, FrameworkType
from playwright_captcha.utils.camoufox_add_init_script.add_init_script import get_addon_path

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

async def main():
    email = os.getenv('EMAIL', '')
    password = os.getenv('PASSWORD', '')
    proxy_server = os.getenv('PROXY_SERVER')
    debug_mode = os.getenv('DEBUG', 'false').lower() == 'true'

    options = {
        'headless': False,
        'humanize': True,
        'geoip': True,
        'os': 'macos',
        'screen': Screen(max_width=1280, max_height=720),
        'window': (1280, 720),
        'locale': 'ja-JP',
        'disable_coop': True,
        'i_know_what_im_doing': True,
        'config': {'forceScopeAccess': True},
        'main_world_eval': True,
        'addons': [os.path.abspath(get_addon_path())]
    }
    
    if proxy_server:
        parsed = urlparse(proxy_server)
        proxy_config = {
            'server': f"{parsed.scheme}://{parsed.hostname}{f':{parsed.port}' if parsed.port else ''}"
        }
        if parsed.username:
            proxy_config['username'] = parsed.username
        if parsed.password:
            proxy_config['password'] = parsed.password
        options['proxy'] = proxy_config
    
    logging.info('Launching Camoufox in Python...')
    async with AsyncCamoufox(**options) as browser:
        context = await browser.new_context()
        page = await context.new_page()
        framework = FrameworkType.CAMOUFOX

        try:
            logging.info('Navigating to login...')
            # Use domcontentloaded to avoid getting stuck on tracking pixels
            await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_selector('#memberid', timeout=30000)
            
            await page.locator('#memberid').fill(email)
            await page.locator('#user_password').fill(password)
            
            logging.info('Logging in...')
            await page.locator('text="ログインする"').click(no_wait_after=True)
            
            # Manually wait for the dashboard to appear instead of waiting for networkidle
            logging.info('Waiting for dashboard to load...')
            await page.wait_for_selector('a[href^="/xapanel/xvps/server/detail?id="]', timeout=30000)

            logging.info('Navigating server details...')
            await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').first.click(no_wait_after=True)
            
            logging.info('Waiting for server detail page...')
            await page.wait_for_selector('text="更新する"', timeout=30000)
            await page.locator('text="更新する"').click()

            logging.info('Proceeding to renewal selection...')
            await page.locator('text="引き続き無料VPSの利用を継続する"').click(no_wait_after=True)
            
            logging.info('Waiting for renewal page or status...')
            
            # Wait for either the captcha image OR the suspension notice section
            # This will raise TimeoutError if neither appears within 30s (correct behavior)
            await page.wait_for_selector('img[src^="data:"], .newApp__suspended', timeout=30000)
            
            # If the suspension notice is visible, skip renewal gracefully
            if await page.locator('.newApp__suspended').is_visible():
                logging.info('SKIP: Renewal is not yet available (detected .newApp__suspended).')
                logging.info('XServer: "利用期限の1日前から更新手続きが可能です。"')
                await page.screenshot(path='skip_renewal.png', full_page=True)
                return

            logging.info('Retrieving captcha...')
            body = await page.eval_on_selector('img[src^="data:"]', 'img => img.src')
            
            # Solve custom image captcha
            async with aiohttp.ClientSession() as session:
                async with session.post('https://captcha-120546510085.asia-northeast1.run.app', data=body) as resp:
                    code = await resp.text()
            
            logging.info(f'Resolved captcha code: {code}')
            
            input_loc = page.locator('[placeholder="上の画像の数字を入力"]')
            await input_loc.focus()
            await input_loc.press_sequentially(code, delay=100)
            
            try:
                # Use playwright-captcha library to handle the Turnstile challenge
                async with ClickSolver(framework=framework, page=page) as solver:
                    await solver.solve_captcha(captcha_container=page, captcha_type=CaptchaType.CLOUDFLARE_TURNSTILE)
                logging.info('Turnstile interaction finished.')
            except Exception as e:
                # Some solvers might throw errors even if the click was successful.
                # We catch and log them as warnings to allow the script to proceed.
                logging.warning(f'Turnstile solve loop exited: {e}')

            await page.wait_for_selector('text="無料VPSの利用を継続する"', timeout=30000)
            await page.screenshot(path='before_click.png', full_page=True)
            
            button = page.locator('text="無料VPSの利用を継続する"')
            is_disabled = False
            try:
                is_disabled = await button.is_disabled()
            except Exception:
                pass
                
            if is_disabled:
                err_msg = 'Final button is DISABLED! Renewal failed or Turnstile verification was unsuccessful.'
                logging.error(err_msg)
                if not debug_mode:
                    raise Exception(err_msg)
            else:
                if debug_mode:
                    logging.info('DEBUG MODE: Final button is ENABLED and ready to click. Skipping click to preserve daily limit.')
                else:
                    logging.info('Executing final renewal submission...')
                    await button.click(timeout=15000, no_wait_after=True)
                    logging.info('Final renewal submitted successfully!')
                    await asyncio.sleep(10)
            
            logging.info('Done!')
        
        except Exception as e:
            logging.error(f'Script Error: {e}')
            sys.exit(1)
        finally:
            await asyncio.sleep(2)
            await context.close()

if __name__ == '__main__':
    asyncio.run(main())
