Propane Fuel Tracker (Playwright + TypeScript)

Overview
- Logs into propane provider site, checks tank level, requests refill when below threshold.
- Sends email notifications on success, refill requested, or errors.
- Saves screenshots to artifacts/ and uploads them from CI.

Setup
1. Add repository Secrets (Settings → Secrets):
   - SITE_URL: login page URL
   - ACCOUNT_URL: (optional) direct account page URL
   - USERNAME, PASSWORD
   - LOGIN_USERNAME_SELECTOR, LOGIN_PASSWORD_SELECTOR, LOGIN_SUBMIT_SELECTOR
   - TANK_LEVEL_SELECTOR (CSS selector that contains numeric tank level)
   - TANK_THRESHOLD (number, e.g., 20)
   - REFILL_BUTTON_SELECTOR (optional)
   - REFILL_CONFIRM_SELECTOR (optional)
   - SENDGRID_API_KEY
   - SENDGRID_FROM (verified sender email)
   - EMAIL_TO (email that receives notifications)

Usage
- CI runs on push and daily schedule. The workflow builds TypeScript, runs the checker, and uploads artifacts/ screenshots.
- Locally, copy your secrets into a `.env` file at the repository root and then run:
  1. `npm ci`
  2. `npx playwright install --with-deps`
  3. `npm run build`
  4. `npm run start`

Customize
- Adjust selectors and threshold to match your provider site.
- Improve automation for provider-specific flows (2FA, captchas) manually.

Security
- Keep credentials and selectors in GitHub Secrets. Do not commit .env with real secrets.
