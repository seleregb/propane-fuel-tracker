import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';

dotenv.config();

const {
  SITE_URL,
  USERNAME,
  PASSWORD,
  ACCOUNT_URL,
  TANK_LEVEL_SELECTOR,
  TANK_THRESHOLD,
  REFILL_BUTTON_SELECTOR,
  REFILL_CONFIRM_SELECTOR,

  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_TO
} = process.env;

function required(name: string, val: any) {
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

async function sendEmail(subject: string, text: string, attachments: { filename: string; path: string }[] = []) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT ? parseInt(SMTP_PORT, 10) : 587,
    secure: false,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  } as any);

  await transporter.sendMail({
    from: SMTP_USER,
    to: EMAIL_TO,
    subject,
    text,
    attachments
  });
}

async function main() {
  try {
    required('SITE_URL', SITE_URL);
    required('USERNAME', USERNAME);
    required('PASSWORD', PASSWORD);
    required('TANK_THRESHOLD', TANK_THRESHOLD);
    required('SMTP_HOST', SMTP_HOST);
    required('SMTP_PORT', SMTP_PORT);
    required('SMTP_USER', SMTP_USER);
    required('SMTP_PASS', SMTP_PASS);
    required('EMAIL_TO', EMAIL_TO);

    const artifactsDir = path.resolve(process.cwd(), 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const screenshotPath = path.join(artifactsDir, `screenshot-${Date.now()}.png`);

    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();

    await page.goto(SITE_URL!, { waitUntil: 'load', timeout: 60000 });

    await page.locator('#email_check').fill(USERNAME!);
    await page.locator('#password_check').fill(PASSWORD!);
    await Promise.all([
      page.locator('#cmdLogin').click(),
      page.waitForLoadState('networkidle')
    ]);

    // Navigate to account page if provided
    if (ACCOUNT_URL) {
      await page.goto(ACCOUNT_URL, { waitUntil: 'load', timeout: 60000 });
    }

    // Take a screenshot of account page
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await page.getByRole('link', { name: 'Open Tanks Page' }).click();
    await page.getByRole('tab', { name: 'Tank 2' }).click();

    // Read tank level
    const raw = await page.textContent(TANK_LEVEL_SELECTOR!);
    if (!raw) throw new Error('Could not read tank level from selector');

    // Attempt to parse number from text (support percentage formats like "42%" or "42 %")
    const normalized = raw.replace(',', '.');
    const pctMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%/);
    const numMatch = pctMatch ? pctMatch : normalized.match(/(\d+(?:\.\d+)?)/);
    if (!numMatch) throw new Error(`Could not parse number from tank text: "${raw}"`);
    const level = parseFloat((numMatch[1] ?? numMatch[0]) as string);
    const threshold = parseFloat(TANK_THRESHOLD!);

    let message = `Tank level parsed: ${level} (threshold ${threshold})`;
    console.log(message);

    if (level <= threshold) {
      // Try to request refill if selector supplied
      if (REFILL_BUTTON_SELECTOR) {
        await page.click(REFILL_BUTTON_SELECTOR);
        // if (REFILL_CONFIRM_SELECTOR) {
        //   await page.waitForSelector(REFILL_CONFIRM_SELECTOR, { timeout: 15000 });
        // }
        // take another screenshot after request
        const screenshotAfter = path.join(artifactsDir, `screenshot-after-${Date.now()}.png`);
        await page.screenshot({ path: screenshotAfter, fullPage: true });
        await browser.close();

        await sendEmail('Propane refill requested', `A refill was requested automatically. ${message}\n\nSee attachments.`, [
          { filename: 'account-before.png', path: screenshotPath },
          { filename: 'account-after.png', path: screenshotAfter }
        ]);

        console.log('Refill requested and email sent.');
        process.exit(0);
      } else {
        await browser.close();
        await sendEmail('Propane refill NEEDED (manual)', `Tank level ${level} is below threshold ${threshold} but REFILL_BUTTON_SELECTOR is not configured. Please request refill manually.`, [
          { filename: 'account.png', path: screenshotPath }
        ]);
        console.log('Threshold reached; emailed manual action.');
        process.exit(0);
      }
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
      // Attempt to capture a screenshot if Playwright is available in error path
      try {
        // dynamic import to avoid exceptions when not available
        const pw = await import('playwright');
        const browser = await pw.chromium.launch({ headless: true });
        const page = await (await browser.newContext()).newPage();
        if (SITE_URL) await page.goto(SITE_URL, { waitUntil: 'load', timeout: 15000 });
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await browser.close();
      } catch (e) {
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
