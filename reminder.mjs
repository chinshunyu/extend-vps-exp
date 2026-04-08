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
    script: 'reminder.mjs',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    expireDate: null,
    tomorrow: null,
    needsReminder: null,
    notificationSent: false,
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

async function readExpireDate(page) {
    const raw = await page.evaluate(() => {
        const termCell = document.querySelector('tr:has(.freeServerIco) .contract__term')
        if (termCell?.textContent) {
            return termCell.textContent
        }

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
        throw new Error(`无法解析到期日，raw=${raw}`)
    }
    return parsed
}

async function ensureLoggedInDashboard(page) {
    const dashboardSelector = 'tr:has(.freeServerIco), .contract__term'
    const loginFormSelector = '#memberid, #user_password'

    try {
        await page.waitForSelector(`${dashboardSelector}, ${loginFormSelector}`, { timeout: 20000 })
    } catch {
        const title = await page.title()
        throw new Error(`登录后页面状态未知，未出现仪表盘或登录表单。url=${page.url()} title=${title}`)
    }

    const hasDashboard = !!(await page.$(dashboardSelector))
    if (hasDashboard) {
        return
    }

    const loginError = await page.evaluate(() => {
        const msg =
            document.querySelector('.errorMessage')?.textContent ||
            document.querySelector('.alert')?.textContent ||
            document.querySelector('.notice')?.textContent
        return msg?.replace(/\s+/g, ' ').trim() || ''
    })

    throw new Error(`登录失败，仍停留在登录页。url=${page.url()} error=${loginError || 'N/A'}`)
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

    await runStep('verify login result', async () => {
        await ensureLoggedInDashboard(page)
    })

    await runStep('read expire date', async () => {
        summary.expireDate = await readExpireDate(page)
        summary.tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' })
        summary.needsReminder = summary.expireDate === summary.tomorrow
        console.log(`expireDate=${summary.expireDate} tomorrow=${summary.tomorrow} needsReminder=${summary.needsReminder}`)
    })

    await runStep('assert expire date is parseable', async () => {
        if (!summary.expireDate || !/^\d{4}-\d{2}-\d{2}$/.test(summary.expireDate)) {
            throw new Error(`expire date assertion failed: ${summary.expireDate}`)
        }
    })

    if (summary.needsReminder) {
        await runStep('send reminder notification', async () => {
            const url =
                'https://script.google.com/macros/s/AKfycbzbAcpAe_LGZsXpxjRl9aOV60q-XmuNC_bj62B5G45vR3vB13THNpoqiZr08AjMn_53Ug/exec?recipient=' +
                encodeURIComponent(process.env.EMAIL)
            const response = await fetch(url)
            if (!response.ok) {
                throw new Error(`reminder webhook failed with status=${response.status}`)
            }
            summary.notificationSent = true
        })
    }

    summary.status = 'success'
}

try {
    await main()
} catch (error) {
    summary.status = 'failed'
    console.error('[FATAL] reminder flow failed:', error)
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
