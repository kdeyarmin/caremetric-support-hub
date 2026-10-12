# Workflow rules

- `git pull` on `main` before starting any task.
- Never commit to `main`. Create one branch per task (e.g. `fix/<short-name>` or `feat/<short-name>`).
- Before pushing, run the build and tests locally: `npm ci` then `npm run check` (runs typecheck, lint, tests, SDK build, and app build). Do not push if it fails.
- Open a pull request for every change. Let CI pass before merging. Do not merge with failing or pending checks.
- Never deploy manually. Railway auto-deploys from `main`; merging the reviewed PR is the deploy.
