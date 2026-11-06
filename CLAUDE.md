# GoalScope project notes

- Owner's standing instruction: push all changes straight to `main` (GitHub Pages deploys from `main`).
- Data: free ESPN feed is the default. Keyed sources live in `js/sources.js`; keys are entered on the
  in-app Data sources page and stored only in the browser. Never commit API keys.
- Run `npm test` before pushing; tests cover the model and every source parser.
- No build step: plain HTML/CSS/ES modules. Bump the cache name in `sw.js` when shipping changes.
