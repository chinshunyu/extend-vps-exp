import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'
import { mkdir, writeFile } from 'node:fs/promises'

const DEBUG_DIR = 'debug'
const RECORD_FILE = 'recording.webm'

const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
    const proxyUrl = new URL(process.env.PROXY_SERVER)
    proxyUrl.username = ''
    proxyUrl.password = ''
    args.push(`--proxy-server=${proxyUrl}`.replace(/\/$/, ''))
}

const summary = {
    script: 'main.mjs',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    beforeExpiry: null,
    afterExpiry: null,
    steps: [],
    error: null,
}

function stringifyError(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        }
    }
    return {
        name: 'NonErrorThrown',
        message: String(error),
        stack: '',
    }
}

function parseDateFromText(text) {
    if (!text) return null
    const compact = text.replace(/\s+/g, '')
    const match = compact.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/)
    if (!match) return null
    const [, year, month, day] = match
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

function toEpochDay(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
}

async function ensureDebugDir() {
    await mkdir(DEBUG_DIR, { recursive: true })
}

async function writeSummary() {
    summary.finishedAt = new Date().toISOString()
    await ensureDebugDir()
    await writeFile(`${DEBUG_DIR}/summary.json`, JSON.stringify(summary, null, 2))
}

async function writeFailureArtifacts(page, error) {
    const serialized = stringifyError(error)
    summary.error = serialized
    await ensureDebugDir()

    await writeFile(`${DEBUG_DIR}/error.txt`, `${serialized.name}: ${serialized.message}\n\n${serialized.stack ?? ''}\n`)

    if (!page || page.isClosed()) {
        return
    }

    try {
        await page.screenshot({ path: `${DEBUG_DIR}/failure.png`, fullPage: true })
    } catch (screenshotError) {
        await writeFile(`${DEBUG_DIR}/screenshot_error.txt`, String(screenshotError))
    }

    try {
        const html = await page.content()
        await writeFile(`${DEBUG_DIR}/failure.html`, html)
    } catch (htmlError) {
        await writeFile(`${DEBUG_DIR}/html_error.txt`, String(htmlError))
    }
}

async function readDetailExpiry(page) {
    const raw = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tr'))
        for (const row of rows) {
            const text = row.textContent?.replace(/\s+/g, ' ').trim() ?? ''
            if (text.includes('利用期限') || text.includes('契約期限')) {
                return text
            }
        }
        return null
    })

    const parsed = parseDateFromText(raw)
    if (!parsed) {
        throw new Error(`无法解析利用期限，raw=${raw}`)
    }
    return parsed
}

let browser
let page
let recorder

async function runStep(name, fn) {
    const started = Date.now()
    const step = {
        name,
        startedAt: new Date().toISOString(),
        endedAt: null,
        durationMs: null,
        status: 'running',
        url: page?.url?.() ?? '',
        error: null,
    }
    summary.steps.push(step)
    console.log(`[STEP][START] ${name}`)

    try {
        const result = await fn()
        step.status = 'ok'
        return result
    } catch (error) {
        step.status = 'fail'
        step.error = stringifyError(error)
        console.error(`[STEP][FAIL] ${name}:`, error)
        throw error
    } finally {
        step.endedAt = new Date().toISOString()
        step.durationMs = Date.now() - started
        step.url = page?.url?.() ?? ''
        console.log(`[STEP][${step.status.toUpperCase()}] ${name} (${step.durationMs}ms) url=${step.url}`)
    }
}

async function main() {
    await ensureDebugDir()

    await runStep('validate required env', async () => {
        if (!process.env.EMAIL) throw new Error('missing env EMAIL')
        if (!process.env.PASSWORD) throw new Error('missing env PASSWORD')
    })

    browser = await puppeteer.launch({
        defaultViewport: { width: 1080, height: 1024 },
        args,
    })
    ;[page] = await browser.pages()
    const userAgent = await browser.userAgent()
    await page.setUserAgent(userAgent.replace('Headless', ''))
    recorder = await page.screencast({ path: RECORD_FILE })

    await runStep('configure proxy auth', async () => {
        if (!process.env.PROXY_SERVER) return
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    })

    await runStep('goto login page', async () => {
        await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
    })

    await runStep('fill login form', async () => {
        await page.locator('#memberid').fill(process.env.EMAIL)
        await page.locator('#user_password').fill(process.env.PASSWORD)
    })

    await runStep('submit login', async () => {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.locator('text=ログインする').click(),
        ])
    })

    let detailUrl = ''
    await runStep('open server detail page', async () => {
        const detailLinkSelector = 'a[href^="/xapanel/xvps/server/detail?id="]'
        await page.waitForSelector(detailLinkSelector, { timeout: 10000 })
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click(detailLinkSelector),
        ])
        detailUrl = page.url()
        if (!detailUrl.includes('/server/detail')) {
            throw new Error(`unexpected detail url: ${detailUrl}`)
        }
    })

    await runStep('read before expiry', async () => {
        summary.beforeExpiry = await readDetailExpiry(page)
        console.log(`beforeExpiry=${summary.beforeExpiry}`)
    })

    await runStep('open renew form', async () => {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.locator('text=更新する').click(),
        ])
    })

    await runStep('confirm renew flow', async () => {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.locator('text=引き続き無料VPSの利用を継続する').click(),
        ])
    })

    await runStep('solve captcha', async () => {
        const body = await page.$eval('img[src^="data:"]', img => img.src)
        const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
            method: 'POST',
            body,
        }).then(r => r.text())

        if (!/^\d{4,8}$/.test(code.trim())) {
            throw new Error(`captcha service returned invalid code: ${code}`)
        }

        await page.locator('[placeholder="上の画像の数字を入力"]').fill(code.trim())
    })

    await runStep('submit renew request', async () => {
        await page.locator('text=無料VPSの利用を継続する').click()
        await setTimeout(3000)
    })

    await runStep('revisit detail page for assertion', async () => {
        await page.goto(detailUrl, { waitUntil: 'networkidle2' })
        summary.afterExpiry = await readDetailExpiry(page)
        console.log(`afterExpiry=${summary.afterExpiry}`)
    })

    await runStep('assert expiry increased', async () => {
        if (!summary.beforeExpiry || !summary.afterExpiry) {
            throw new Error(`missing expiry data: before=${summary.beforeExpiry}, after=${summary.afterExpiry}`)
        }
        if (toEpochDay(summary.afterExpiry) <= toEpochDay(summary.beforeExpiry)) {
            throw new Error(`renewal assertion failed: before=${summary.beforeExpiry}, after=${summary.afterExpiry}`)
        }
    })

    summary.status = 'success'
}

try {
    await main()
} catch (error) {
    summary.status = 'failed'
    console.error('[FATAL] renewal flow failed:', error)
    await writeFailureArtifacts(page, error)
    process.exitCode = 1
} finally {
    try {
        await writeSummary()
    } catch (summaryError) {
        console.error('failed to write summary:', summaryError)
    }

    try {
        await setTimeout(5000)
    } catch {}

    try {
        if (recorder) {
            await recorder.stop()
        }
    } catch (recorderError) {
        console.error('failed to stop recorder:', recorderError)
        process.exitCode = 1
    }

    try {
        if (browser) {
            await browser.close()
        }
    } catch (browserError) {
        console.error('failed to close browser:', browserError)
        process.exitCode = 1
    }
}
