import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'

const WAIT_NAVIGATION_OPTIONS = { waitUntil: 'networkidle2', timeout: 45000 }
const CAPTCHA_INPUT_SELECTOR = '[placeholder*="上の画像"], [placeholder*="数字"], input[name*="captcha" i], input[id*="captcha" i]'

async function clickAndWaitForNavigation(page, clickAction, stepName) {
    await Promise.all([
        page.waitForNavigation(WAIT_NAVIGATION_OPTIONS),
        clickAction(),
    ])
    console.log(`[step:${stepName}] ${page.url()}`)
}

async function extractCaptchaBody(page) {
    const captchaInfo = await page.evaluate(async () => {
        const inputSelector = '[placeholder*="上の画像"], [placeholder*="数字"], input[name*="captcha" i], input[id*="captcha" i]'
        const imageSelectors = [
            'img[src^="data:image"]',
            'img[src^="data:"]',
            'img[src*="captcha" i]',
            'img[alt*="captcha" i]',
            'form img',
            'img',
        ]

        const input = document.querySelector(inputSelector)
        const scope = input?.closest('form') ?? document
        let image = null
        for (const selector of imageSelectors) {
            image = scope.querySelector(selector) || document.querySelector(selector)
            if (image) break
        }

        if (!image) {
            return {
                error: 'captcha-image-not-found',
                imageCount: document.querySelectorAll('img').length,
                title: document.title,
                url: location.href,
            }
        }

        const waitForImageLoaded = async target => {
            if (target.complete && target.naturalWidth > 0) return
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('captcha-image-load-timeout')), 10000)
                target.addEventListener('load', () => {
                    clearTimeout(timer)
                    resolve()
                }, { once: true })
                target.addEventListener('error', () => {
                    clearTimeout(timer)
                    reject(new Error('captcha-image-load-error'))
                }, { once: true })
            })
        }

        try {
            await waitForImageLoaded(image)
        } catch {}

        const rawSrc = image.currentSrc || image.src || image.getAttribute('src') || ''
        if (!rawSrc) {
            return {
                error: 'captcha-image-src-empty',
                title: document.title,
                url: location.href,
            }
        }

        if (rawSrc.startsWith('data:')) {
            return { body: rawSrc, source: 'data-uri', src: rawSrc.slice(0, 120) }
        }

        try {
            const canvas = document.createElement('canvas')
            canvas.width = image.naturalWidth || image.width || 300
            canvas.height = image.naturalHeight || image.height || 60
            const context = canvas.getContext('2d')
            if (!context) throw new Error('canvas-context-not-available')
            context.drawImage(image, 0, 0, canvas.width, canvas.height)
            return { body: canvas.toDataURL('image/png'), source: 'canvas', src: rawSrc.slice(0, 120) }
        } catch {}

        try {
            const absoluteSrc = new URL(rawSrc, location.href).href
            const response = await fetch(absoluteSrc, { credentials: 'include' })
            if (!response.ok) throw new Error(`http-${response.status}`)
            const blob = await response.blob()
            const body = await new Promise((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve(reader.result)
                reader.onerror = () => reject(new Error('file-reader-failed'))
                reader.readAsDataURL(blob)
            })
            return { body, source: 'fetch', src: absoluteSrc }
        } catch (error) {
            return {
                error: `captcha-image-convert-failed:${error?.message ?? String(error)}`,
                src: rawSrc,
                title: document.title,
                url: location.href,
            }
        }
    })

    if (!captchaInfo?.body) {
        throw new Error(`无法获取验证码图片: ${JSON.stringify(captchaInfo)}`)
    }

    console.log('captcha image source:', captchaInfo.source, 'src:', captchaInfo.src)
    return captchaInfo.body
}

const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER)
    proxy_url.username = ''
    proxy_url.password = ''
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

const browser = await puppeteer.launch({
    defaultViewport: { width: 1080, height: 1024 },
    args,
})
const [page] = await browser.pages()
const userAgent = await browser.userAgent()
await page.setUserAgent(userAgent.replace('Headless', ''))
const recorder = await page.screencast({ path: 'recording.webm' })

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }

    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await clickAndWaitForNavigation(page, () => page.locator('text=ログインする').click(), 'login')
    await clickAndWaitForNavigation(page, () => page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click(), 'open-detail')
    await clickAndWaitForNavigation(page, () => page.locator('text=更新する').click(), 'open-renew-index')

    await Promise.all([
        Promise.any([
            page.waitForNavigation(WAIT_NAVIGATION_OPTIONS),
            page.waitForSelector(CAPTCHA_INPUT_SELECTOR, { timeout: WAIT_NAVIGATION_OPTIONS.timeout }),
        ]),
        (async () => {
            const confirmButton = await page.$('[formaction="/xapanel/xvps/server/freevps/extend/conf"]')
            if (confirmButton) {
                await confirmButton.click()
            } else {
                await page.locator('text=引き続き無料VPSの利用を継続する').click()
            }
        })(),
    ])
    console.log('[step:open-renew-confirm]', page.url())

    await page.waitForSelector(CAPTCHA_INPUT_SELECTOR, { timeout: 20000 })
    const body = await extractCaptchaBody(page)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body })
        .then(r => r.text())
        .then(v => v.trim())
    if (!/^\d{4,}$/.test(code)) {
        throw new Error(`验证码识别结果异常: "${code}"`)
    }
    await page.locator(CAPTCHA_INPUT_SELECTOR).first().fill(code)

    await page.waitForFunction(() => {
        const token = document.querySelector('[name="cf-turnstile-response"]')
        return !token || Boolean(token.value)
    }, { timeout: 15000 }).catch(() => {
        console.warn('Cloudflare Turnstile token not ready in 15s, continue submit.')
    })

    await page.locator('text=無料VPSの利用を継続する').click()
} catch (e) {
    console.error(e)
    console.error('current url:', page.url())
    await page.screenshot({ path: 'debug/failure.png', fullPage: true }).catch(() => {})
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
