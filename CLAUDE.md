# Project rules

- Node.js 24 app with one HTTP process, PostgreSQL 16, browser ES modules and standalone HTML artifacts.
- Put server and generation code in `src/`, the main web interface in `public/` and regression tests in `test/`.
- Keep source filenames in English. Run `npm test` before delivery and verify the main flows in a real browser.
- Keep database data in a PostgreSQL volume and configuration secrets in process environment only.
- Store immutable generated versions and the associated executed checks before making a public artifact available.
- Use an original visual design and a standalone interaction pattern inspired by natural-language app builders.
- Request approval before public deployment, repository publication or other actions reserved by the user's global rules.
