# Project rules

- Node.js 24 app with one HTTP process, PostgreSQL 16, browser ES modules and standalone HTML artifacts.
- Put server and generation code in `src/`, the main web interface in `public/` and regression tests in `test/`.
- Keep source filenames in English. Run `npm test` before delivery and verify the main flows in a real browser.
- Keep database data in a PostgreSQL volume and configuration secrets in process environment only.
- Store immutable generated versions and the associated executed checks before making a public artifact available.
- Use an original visual design and a standalone interaction pattern inspired by natural-language app builders.
- Request approval before public deployment, repository publication or other actions reserved by the user's global rules.
- DeepSeek integration and its declarative acceptance protocol live in `src/agent.js` and `src/acceptance.js`. Never execute model output inside the application process.
- The browser runner is a separate service with no network or credentials. Keep its code in `src/qa-worker.js` and its container definition in `deploy/`. The app sends bounded jobs through a Unix socket.
- Model HTML loads in an opaque-origin preview. Store failed or unverified builds as private drafts and publish only the version that passed its browser checks. Keep plan and test metadata in the existing project record.
- New versions are private until the owner publishes a tested version. Public routes check the current publication before serving an artifact. Existing shared versions can enter publication management through an owner action.
- Keep publication state and account tool data in their own PostgreSQL tables. Guest tool data stays in a browser namespace separate from signed-in tools. Keep stage logs and version lineage with the saved generation.
