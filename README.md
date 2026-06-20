# Jajabor AI CRM

Production-shaped telesales CRM for Google Sheets and Google Apps Script. The app is a fast static frontend with a mobile app-style shell, backed by a versioned Apps Script API with token authentication and role-aware lead access.

## What Changed

- No live API URL is hard-coded in the frontend.
- Login uses POST instead of username/password query strings.
- API requests include a signed short-lived token.
- Agents only receive leads assigned to them; admins can see all leads.
- Delete is admin-only.
- Lead rendering uses DOM nodes, not unsafe row HTML strings.
- Mobile UI uses a fixed bottom tab bar, sticky top bar, card lists, and touch-sized controls.
- The Apps Script backend is included under `apps-script/`.

## Files

```text
index.html                Static production frontend
apps-script/Code.gs       Google Apps Script backend
apps-script/appsscript.json
vercel.json               Security headers for Vercel hosting
_headers                  Security headers for Netlify-style hosting
robots.txt                Prevents crawler indexing of the CRM login
manifest.webmanifest      PWA install metadata
sw.js                     Offline app shell service worker
offline.html              Offline fallback page
README.md
```

## Deploy Backend

1. Create or open a Google Sheet.
2. Open Extensions > Apps Script.
3. Copy `apps-script/Code.gs` into the Apps Script editor.
4. Copy `apps-script/appsscript.json` into the manifest file.
5. Run `setupJajaborCrm()` once from the Apps Script editor.
6. Read the generated admin password from Apps Script logs.
7. Deploy > New deployment > Web app.
8. Set "Execute as" to yourself.
9. Set access to "Anyone".
10. Copy the `/exec` web app URL.

If the script is not bound to the Google Sheet, set Script Properties:

```text
SHEET_ID=<your spreadsheet id>
SESSION_SECRET=<long random secret>
```

`SESSION_SECRET` is created automatically by setup if missing, but set your own for controlled rotation.

## Configure Frontend

Paste the new Apps Script `/exec` URL into `index.html`:

```html
<script type="application/json" id="app-config">
  { "apiUrl": "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec" }
</script>
```

Then host `index.html` on GitHub Pages, Netlify, Vercel static hosting, or any HTTPS static host.

## User Management

Run these from Apps Script:

```js
createUser('agent1', 'Agent 1', 'agent', 'change-this-password');
createUser('manager', 'Manager', 'admin', 'change-this-password');
setUserPassword('agent1', 'new-strong-password');
```

Roles:

- `admin`: view all leads, assign leads, delete leads.
- `agent`: view and edit assigned leads only.

## Auto Follow-up Mode

Agents can open `My Leads` or `Follow-ups` and use `Auto Follow-up Mode` to work through callable assigned leads one by one. The browser opens the current lead with a `tel:` link, then the agent records the result with `No Answer + Next`, `Contacted + Next`, or `Interested + Next`; the CRM updates the lead and advances to the next number.

Mobile browsers require user-initiated calls, so this is an assisted calling queue rather than a silent background dialer. Use it only for leads your team is allowed to contact.

## PWA Install

The CRM includes `manifest.webmanifest`, `sw.js`, an offline fallback, and local SVG icons. On Android/Chrome, open the live HTTPS URL and choose `Install app` or `Add to Home screen`. On iPhone, open the site in Safari and choose Share > Add to Home Screen.

The app also shows an in-app install prompt. Chrome/Android can open the native install dialog; iPhone shows the Safari Add to Home Screen instruction because iOS does not expose a native web install prompt event.

The PWA caches the app shell for faster loading. Lead data still requires network access because Google Apps Script remains the live backend.

## Sheet Structure

The setup function creates:

- `Leads`
- `Users`

Do not rename headers unless you also update `CONFIG.leadHeaders` or `CONFIG.userHeaders` in `apps-script/Code.gs`.

## Security Notes

- Retire the old Apps Script deployment URL before going live.
- Do not commit deployed URLs connected to real customer data in public repos.
- Do not use the generated first admin password permanently.
- Rotate `SESSION_SECRET` if tokens may have leaked.
- Keep the Apps Script deployment updated after backend changes.
- Google Apps Script web apps cannot provide the same security controls as a dedicated backend. For larger teams or sensitive data, move the API to a real server with HTTPS-only cookies, rate limiting, audit logs, and database-backed permissions.

## Local Preview

The frontend opens directly in a browser:

```powershell
start .\index.html
```

Login requires a configured deployed API URL.
