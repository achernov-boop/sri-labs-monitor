# SRI Labs PR Intelligence Dashboard

A live brand monitoring dashboard that tracks mentions of **SRI Labs**, **DryQ**, **StyleQ**, **CurlQ**, **RenewGlow**, **KeeWee Shampoo**, **StyleWrap Pro**, and **skin research institute** across news and Google Alerts.

---

## Quick Start (2 minutes)

### Step 1 — Install Node.js (if not already installed)
Download from **https://nodejs.org** → choose the LTS version → install it.

### Step 2 — Open Terminal
- **Mac**: Press `Cmd+Space`, type "Terminal", press Enter
- **Windows**: Press `Win+R`, type "cmd", press Enter

### Step 3 — Navigate to this folder
```
cd path/to/sri-labs-monitor
```
(Drag the folder onto the Terminal window to auto-fill the path on Mac)

### Step 4 — Install and run
```
npm install
npm start
```

### Step 5 — Open your browser
Go to → **http://localhost:3000**

The dashboard will start pulling live mentions automatically.

---

## Features

| Feature | Details |
|---|---|
| **News monitoring** | Searches 50,000+ publications via News API |
| **Google Alerts** | 7 live RSS feeds aggregated in real-time |
| **Sentiment analysis** | Automatically scores each mention positive / neutral / negative |
| **Keyword filtering** | Click any product tag to filter the feed |
| **14-day timeline** | Line chart showing mention volume trends |
| **Top sources** | Which publications cover you most |
| **Auto-refresh** | Dashboard refreshes every 10 minutes |
| **Instagram** | Ready to connect once Meta API is approved |

---

## Connecting Instagram

Once your Meta Developer app is approved:

1. Open `server.js` in any text editor (Notepad, TextEdit, VS Code)
2. Find the `INSTAGRAM_HANDLE` field — it already has `sri_labs_`
3. Add your **App ID** and **App Secret** from developers.facebook.com
4. The Instagram section will automatically activate

---

## Updating Keywords

To add or remove tracked keywords, open `server.js` and edit the `KEYWORDS` array:

```javascript
KEYWORDS: [
  'SRI Labs',
  'DryQ',
  'StyleQ',
  // add new terms here
],
```

Save the file and restart the server (`npm start`).

---

## Daily Usage

- The server runs locally — **your data never leaves your computer**
- Leave it running in the background; the browser tab refreshes automatically
- Restart it any time by running `npm start` again
- The News API free tier allows 100 requests/day — more than enough for daily monitoring

---

## Need More?

When you're ready to expand, the codebase is built to add:
- Reddit monitoring
- Full Instagram metrics (with Meta API)
- Email alerts for negative mentions
- Weekly PDF reports
- Competitor keyword tracking
