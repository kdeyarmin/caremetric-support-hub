# Workflow rules

- `git pull` on `main` before starting any task.
- Never commit to `main`. Create one branch per task (e.g. `fix/<short-name>` or `feat/<short-name>`).
- Before pushing, run the build and tests locally: `npm ci` then `npm run check` (runs typecheck, lint, tests, SDK build, and app build). Do not push if it fails.
- Open a pull request for every change. Let CI pass before merging. Do not merge with failing or pending checks.
- Never deploy manually. Railway auto-deploys from `main`; merging the reviewed PR is the deploy.

# Configuration: settings, not Railway variables

- Never add a Railway variable for anything that is not a secret. On/off switches, addresses, links, account ids, API
  versions and limits are Hub settings: a row in a migration plus an entry in `settingsCatalog` (`server/hub-settings.mjs`),
  read live with `settings.reader(key)` / `live()`. The owner changes them on the Settings page (`/admin/settings`).
- Only secrets (API keys, tokens, signing keys) and the service's wiring (database URL, port, public origin, the Telnyx
  sign-in profile) are Railway variables. `docs/SETTINGS.md` lists both.
- In user-facing text and docs, name the setting as the page shows it (for example "Settings → AI team → Run the AI
  team"), never a variable the owner would have to set in Railway.
