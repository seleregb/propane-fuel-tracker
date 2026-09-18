import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { BrevoClient } from '@getbrevo/brevo';

const envCandidates = [
  path.resolve(__dirname, '..', '.env'),
  path.resolve(process.cwd(), '.env')
];

for (const envPath of envCandidates) {
  dotenv.config({ path: envPath });
}

const {
  SITE_URL,
  USERNAME,
  PASSWORD,
  ACCOUNT_URL,
  LOGIN_USERNAME_SELECTOR,
  LOGIN_PASSWORD_SELECTOR,
  LOGIN_SUBMIT_SELECTOR,
  TANK_LEVEL_SELECTOR,
  TANK_THRESHOLD,
  EMAIL_FROM,
  EMAIL_TO,
  BREVO_API_KEY
} = process.env;

function required(name: string, val: string | undefined) {
  const normalized = val?.trim();
  if (!normalized) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return normalized;
}

async function sendEmail(subject: string, text: string, attachments: { filename: string; path: string }[] = []) {
  const brevo = new BrevoClient({ 
    apiKey: required('BREVO_API_KEY', BREVO_API_KEY),
    maxRetries: 3,
   });
  const result = await brevo.transactionalEmails.sendTransacEmail({
    subject: subject,
    htmlContent: `<p>${text.replace(/\n/g, '<br>')}</p>`,
    sender: { name: 'Irving Propane Tracker', email: required('EMAIL_FROM', EMAIL_FROM) },
    to: [{ email: required('EMAIL_TO', EMAIL_TO), name: 'John Doe' }],
    attachment: attachments.map(({ filename, path: filePath }) => ({
      name: filename,
      content: fs.readFileSync(filePath).toString('base64'),
      type: 'application/octet-stream'
    }))
  });
  console.log('Email sent. Message ID:', result.messageId);
}

function extractSnippet(source: string, marker: string): string {
  const index = source.indexOf(marker);
  if (index === -1) {
    return source.slice(0, 500);
  }

  const start = Math.max(0, index - 250);
  const end = Math.min(source.length, index + 1000);
  return source.slice(start, end);
}

async function readTankLevel(page: any, selector: string, responseText?: string): Promise<number> {
  await page.waitForFunction((targetSelector: string) => {
    const hiddenInput = document.querySelector('input[name="tank_gauge_percent"]') as HTMLInputElement | null;
    if (hiddenInput?.value && hiddenInput.value.trim() !== '') {
      return true;
    }

    const summary = document.querySelector('#tank_gauge_summary');
    if (summary?.textContent?.match(/\d+(?:\.\d+)?\s*%/i)) {
      return true;
    }

    const fallback = document.querySelector(targetSelector);
    return !!(fallback?.textContent?.match(/\d+(?:\.\d+)?\s*%/i));
  }, selector, { timeout: 60000 });

  const html = await page.content();
  const sources = [html, responseText].filter((value): value is string => Boolean(value));

  for (const source of sources) {
    const hiddenInputMatch = source.match(/name=["']tank_gauge_percent["'][^>]*value=["'](\d+(?:\.\d+)?)["']/i);
    if (hiddenInputMatch) {
      return parseFloat(hiddenInputMatch[1]);
    }

    const summaryMatch = source.match(/Percent in tank:\s*(\d+(?:\.\d+)?)\s*%/i);
    if (summaryMatch) {
      return parseFloat(summaryMatch[1]);
    }

    const genericMatch = source.match(/(\d+(?:\.\d+)?)\s*%/i);
    if (genericMatch) {
      return parseFloat(genericMatch[1]);
    }
  }

  console.log('Tank gauge debug:');
  console.log('HTML snippet:', extractSnippet(html, 'tank_gauge'));
  if (responseText) {
    console.log('Response snippet:', extractSnippet(responseText, 'tank_gauge'));
  }

  throw new Error(`Could not find a percentage in tank text for selector: ${selector}`);
}

async function main() {
  try {
    const siteUrl = required('SITE_URL', SITE_URL);
    const username = required('USERNAME', USERNAME);
    const password = required('PASSWORD', PASSWORD);
    const loginUsernameSelector = required('LOGIN_USERNAME_SELECTOR', LOGIN_USERNAME_SELECTOR);
    const loginPasswordSelector = required('LOGIN_PASSWORD_SELECTOR', LOGIN_PASSWORD_SELECTOR);
    const loginSubmitSelector = required('LOGIN_SUBMIT_SELECTOR', LOGIN_SUBMIT_SELECTOR);
    const tankLevelSelector = required('TANK_LEVEL_SELECTOR', TANK_LEVEL_SELECTOR);
    const tankThreshold = required('TANK_THRESHOLD', TANK_THRESHOLD);

    const artifactsDir = path.resolve(process.cwd(), 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const screenshotPath = path.join(artifactsDir, `screenshot-${Date.now()}.png`);

    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();

    await page.goto(siteUrl, { waitUntil: 'load', timeout: 60000 });

    await page.locator(loginUsernameSelector).fill(username);
    await page.locator(loginPasswordSelector).fill(password);
    await Promise.all([
      page.locator(loginSubmitSelector).click(),
      page.waitForLoadState('networkidle')
    ]);

    if (ACCOUNT_URL) {
      await page.goto(ACCOUNT_URL, { waitUntil: 'load', timeout: 60000 });
    }

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const dropdown = page.locator('select#loc_selector');
    await dropdown.waitFor({ state: 'visible', timeout: 60000 });

    const tankResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/user-home') && response.request().method() === 'POST',
      { timeout: 60000 }
    ).catch(() => undefined);

    await dropdown.selectOption({ label: '2' });
    await page.waitForLoadState('networkidle', { timeout: 300000 });
    // await page.waitForSelector('#tank_guage', { state: 'visible', timeout: 60000 });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const tankResponse = await tankResponsePromise;
    let responseText: string | undefined;
    if (tankResponse) {
      responseText = await tankResponse.text();
    }

    const level = await readTankLevel(page, tankLevelSelector, responseText);
    const threshold = parseFloat(tankThreshold);

    const message = `Tank level parsed: ${level} (threshold ${threshold})`;
    console.log(message);

    if (level <= threshold) {
      const screenshotAfter = path.join(artifactsDir, `screenshot-after-${Date.now()}.png`);
      await page.screenshot({ path: screenshotAfter, fullPage: true });
      await browser.close();

      await sendEmail('Propane account update', `Please refill your propane tank. ${message}\n\nSee attachments.`, [
        { filename: 'account-before.png', path: screenshotPath },
        { filename: 'account-after.png', path: screenshotAfter }
      ]);

      console.log('Level below threshold; email sent.');
      process.exit(0);
    } else {
      await browser.close();
      await sendEmail('Propane account check - level OK', `Tank level ${level} is above threshold ${threshold}.`, [
        { filename: 'account.png', path: screenshotPath }
      ]);
      console.log('Level OK; email sent.');
      process.exit(0);
    }
  } catch (err: any) {
    try {
      const artifactsDir = path.resolve(process.cwd(), 'artifacts');
      fs.mkdirSync(artifactsDir, { recursive: true });
      const screenshotPath = path.join(artifactsDir, `error-screenshot-${Date.now()}.png`);
      try {
        const pw = await import('playwright');
        const browser = await pw.chromium.launch({ headless: true });
        const page = await (await browser.newContext()).newPage();
        if (SITE_URL) await page.goto(SITE_URL, { waitUntil: 'load', timeout: 15000 });
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await browser.close();
      } catch {
        // ignore screenshot on error
      }

      await sendEmail('Propane tracker ERROR', `An error occurred: ${err?.message || String(err)}`,
        fs.existsSync(screenshotPath) ? [{ filename: path.basename(screenshotPath), path: screenshotPath }] : []);
    } catch (sendErr) {
      console.error('Failed to send error email:', sendErr);
    }

    console.error('Error:', err);
    process.exit(2);
  }
}

main();
