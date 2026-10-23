# VWAB Arena

Scoreservice en scorebord voor de competitie-modus van de -inator spellen.

- `src/index.js` – Cloudflare Worker (API): scores inzenden, top 10, ranking, beheer.
- `schema.sql` – D1-database.
- `public/index.html` – scorebord voor het grote scherm (`?game=invasie`, `?interval=4000`).
- `public/admin.html` – beheer: naam verbergen, nieuwe ronde, export.
- `.github/workflows/deploy.yml` – zet de Worker op Cloudflare en het scorebord op GitHub Pages.

## Secrets (Settings → Secrets and variables → Actions)
- `CLOUDFLARE_API_TOKEN` – token met Workers Scripts: Edit en D1: Edit
- `CLOUDFLARE_ACCOUNT_ID` – account-id uit het Cloudflare-dashboard
- `ADMIN_KEY` – zelfgekozen beheerwachtwoord voor admin.html
