import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import sgMail from '@sendgrid/mail';
import { chromium } from 'playwright';

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
  REFILL_BUTTON_SELECTOR,
  REFILL_CONFIRM_SELECTOR,
  SENDGRID_API_KEY,
  SENDGRID_FROM,
  EMAIL_TO
} = process.env;

function required(name: string, val: string | undefined) {
  const normalized = val?.trim();
  if (!normalized) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return normalized;
}

async function sendEmail(subject: string, text: string, attachments: { filename: string; path: string }[] = []) {
  sgMail.setApiKey(required('SENDGRID_API_KEY', SENDGRID_API_KEY));

  const formattedAttachments = attachments.map(({ filename, path: filePath }) => ({
    content: fs.readFileSync(filePath).toString('base64'),
    filename,
    type: 'application/octet-stream',
    disposition: 'attachment'
  }));

  await sgMail.send({
    to: required('EMAIL_TO', EMAIL_TO),
    from: required('SENDGRID_FROM', SENDGRID_FROM),
    subject,
    text,
    attachments: formattedAttachments
  });
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

    await page.getByRole('link', { name: 'Open Tanks Page', exact: true }).click();

    await page.screenshot({ path: screenshotPath, fullPage: true });

    await page.getByRole('tab', { name: 'Tank 2', exact: true }).click();

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const raw = await page.textContent(tankLevelSelector);
    if (!raw) throw new Error('Could not read tank level from selector');

    const normalized = raw.replace(',', '.');
    const pctMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%/);
    const numMatch = pctMatch ? pctMatch : normalized.match(/(\d+(?:\.\d+)?)/);
    if (!numMatch) throw new Error(`Could not parse number from tank text: "${raw}"`);
    const level = parseFloat((numMatch[1] ?? numMatch[0]) as string);
    const threshold = parseFloat(tankThreshold);

    const message = `Tank level parsed: ${level} (threshold ${threshold})`;
    console.log(message);

    if (level <= threshold) {
      if (REFILL_BUTTON_SELECTOR) {
        await page.click(REFILL_BUTTON_SELECTOR);
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
