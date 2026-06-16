const { google } = require('googleapis')

// ─── OAuth Client ────────────────────────────────────────────────────────────

function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
  try {
    const tokens = JSON.parse(process.env.GOOGLE_TOKENS || '{}')
    if (tokens.access_token) oauth2Client.setCredentials(tokens)
  } catch(e) {}
  return oauth2Client
}

// ─── Gmail: filtered fetch ───────────────────────────────────────────────────
// Only surfaces emails that are genuinely actionable — not listing blasts,
// newsletters, automated alerts, or agent mass emails.

async function fetchGmail(gmail) {
  const clientEmails = await searchGmail(gmail,
    'newer_than:3d label:1-Clients', 6)

  const actionable = await searchGmail(gmail,
    'newer_than:2d is:unread -category:promotions -from:noreply ' +
    '-(subject:"just listed") -(subject:"open house") ' +
    '-(subject:"market report") -(subject:"newsletter") ' +
    '-(subject:"price improvement") -(subject:"new to market")', 8)

  const important = await searchGmail(gmail,
    'is:important newer_than:2d -category:promotions -from:noreply', 5)

  return { clientEmails, actionable, important }
}

async function searchGmail(gmail, query, max = 5) {
  try {
    const res = await gmail.users.threads.list({
      userId: 'me', q: query, maxResults: max
    })
    const threads = res.data.threads || []
    const results = []
    for (const t of threads.slice(0, max)) {
      try {
        const full = await gmail.users.threads.get({
          userId: 'me', id: t.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date']
        })
        const msg = full.data.messages?.[0]
        const headers = msg?.payload?.headers || []
        results.push({
          subject: headers.find(h => h.name === 'Subject')?.value || '',
          from:    headers.find(h => h.name === 'From')?.value || '',
          date:    headers.find(h => h.name === 'Date')?.value || '',
          snippet: (msg?.snippet || '').slice(0, 200)
        })
      } catch(e) {}
    }
    return results
  } catch(e) { return [] }
}

// ─── Google Calendar: today + tomorrow ──────────────────────────────────────

async function fetchCalendar(auth) {
  try {
    const calendar = google.calendar({ version: 'v3', auth })
    const now = new Date()
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 2)

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: tomorrow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 15
    })

    return (res.data.items || []).map(e => ({
      title:    e.summary || '(no title)',
      start:    e.start?.dateTime || e.start?.date || '',
      end:      e.end?.dateTime   || e.end?.date   || '',
      location: e.location || '',
      notes:    (e.description || '').slice(0, 200)
    }))
  } catch(e) {
    return []
  }
}

// ─── Drive: CEO Notes ────────────────────────────────────────────────────────

async function fetchCEONotes(drive) {
  try {
    const res = await drive.files.export({
      fileId: '1Efkqza-yGbL0KuiPAFxqk01be1qb82rZU5oOO_eCHpE',
      mimeType: 'text/plain'
    })
    return typeof res.data === 'string' ? res.data.slice(0, 3000) : ''
  } catch(e) { return '' }
}

// ─── Main handler ────────────────────────────────────────────────────────────

module.exports = async (req, res) => {

  // Basic auth
  const authHeader = req.headers['authorization']
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Oskar Briefing"')
    return res.status(401).end()
  }
  const [, encoded] = authHeader.split(' ')
  const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':')
  if (
    user !== (process.env.BASIC_AUTH_USER || 'oskar') ||
    pass !== (process.env.BASIC_AUTH_PASS || 'voyage2026')
  ) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Oskar Briefing"')
    return res.status(401).end()
  }

  const url  = new URL(req.url, 'https://oskar-briefing.vercel.app')
  const path = url.pathname

  // ── OAuth callback ──────────────────────────────────────────────────────
  if (path.includes('callback')) {
    const code = url.searchParams.get('code')
    if (code) {
      try {
        const oauth2Client = getOAuthClient()
        const { tokens } = await oauth2Client.getToken(code)
        const tokenStr = JSON.stringify(tokens)
        return res.status(200).send(`<!DOCTYPE html>
<html><head><title>Connected</title></head>
<body style="font-family:'Inter',sans-serif;background:#2F3130;color:#F5F3EF;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1.5rem;padding:2rem;box-sizing:border-box;">
<h2 style="color:#E8E5DF;font-weight:400;margin:0;font-size:1.4rem;">Gmail + Calendar Connected</h2>
<p style="color:#6A6D69;max-width:500px;text-align:center;margin:0;font-size:0.85rem;line-height:1.6;">Copy the token below. In your Railway project go to Variables, find GOOGLE_TOKENS, and replace the value with this. Then redeploy.</p>
<textarea onclick="this.select()" style="width:100%;max-width:600px;height:100px;background:#1a1a1a;color:#D9D7D2;border:1px solid #444;padding:0.75rem;font-size:0.65rem;border-radius:6px;">${tokenStr}</textarea>
</body></html>`)
      } catch(e) {
        return res.status(200).send(`<html><body style="background:#2F3130;color:#e05;padding:2rem;">${e.message}</body></html>`)
      }
    }
  }

  // ── Login — now includes Calendar scope ─────────────────────────────────
  if (path.includes('login')) {
    const oauth2Client = getOAuthClient()
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/calendar.readonly'
      ],
      prompt: 'consent'
    })
    return res.redirect(302, authUrl)
  }

  // ── Data endpoint ────────────────────────────────────────────────────────
  if (path.includes('data')) {
    let tokens = {}
    try { tokens = JSON.parse(process.env.GOOGLE_TOKENS || '{}') } catch(e) {}
    if (!tokens.access_token) return res.json({ error: 'not_connected' })

    try {
      const auth    = getOAuthClient()
      const gmail   = google.gmail({ version: 'v1', auth })
      const drive   = google.drive({ version: 'v3', auth })

      const [gmailData, calendar, ceoNotes] = await Promise.all([
        fetchGmail(gmail),
        fetchCalendar(auth),
        fetchCEONotes(drive)
      ])

      return res.json({
        clientEmails: gmailData.clientEmails,
        actionable:   gmailData.actionable,
        important:    gmailData.important,
        calendar,
        ceoNotes,
        ok: true
      })
    } catch(e) {
      return res.json({ error: e.message })
    }
  }

  // ── Token check for main page ────────────────────────────────────────────
  let tokens = {}
  try { tokens = JSON.parse(process.env.GOOGLE_TOKENS || '{}') } catch(e) {}
  const hasTokens = !!tokens.access_token

  if (!hasTokens) {
    return res.status(200).send(`<!DOCTYPE html>
<html><head><title>Oskar Briefing</title>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@1,400&family=Inter:wght@300;400&display=swap" rel="stylesheet">
</head>
<body style="font-family:'Inter',sans-serif;background:#F5F3EF;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:2rem;">
<h2 style="font-family:'EB Garamond',serif;font-style:italic;font-weight:400;color:#2F3130;font-size:2.5rem;margin:0;">One more step</h2>
<p style="color:#6A6D69;max-width:400px;text-align:center;margin:0;font-size:0.9rem;line-height:1.6;">Connect Gmail, Drive, and Calendar to activate the daily briefing.</p>
<a href="/api/login" style="background:#6B7463;color:#fff;padding:0.85rem 2rem;text-decoration:none;font-size:0.75rem;letter-spacing:0.12em;text-transform:uppercase;border-radius:6px;">Connect Google</a>
</body></html>`)
  }

  // ── Main page ────────────────────────────────────────────────────────────
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })

  return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Daily Briefing — Oskar Moguel</title>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{
  --charcoal:#2F3130;--olive:#6B7463;--olive-light:rgba(107,116,99,0.10);
  --midgrey:#6A6D69;--lightgrey:#D9D7D2;--lightstone:#F5F3EF;--greige:#E8E5DF;--white:#fff;
  --serif:'EB Garamond',Georgia,serif;--sans:'Inter',system-ui,sans-serif;
  --radius:14px;--shadow:0 1px 4px rgba(47,49,48,0.06),0 4px 20px rgba(47,49,48,0.05);
}
*{box-sizing:border-box;margin:0;padding:0;}
html{font-size:16px;}
body{background:var(--lightstone);color:var(--charcoal);font-family:var(--sans);-webkit-font-smoothing:antialiased;}
.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh;}
.sidebar{background:var(--charcoal);padding:2.5rem 1.75rem;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;}
.sb-brand{font-family:var(--serif);font-size:1.2rem;font-style:italic;color:#E8E5DF;margin-bottom:0.25rem;font-weight:400;}
.sb-sub{font-size:0.6rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--midgrey);margin-bottom:2.5rem;}
.sb-day{font-size:0.6rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--midgrey);margin-bottom:0.4rem;}
.sb-date{font-family:var(--serif);font-size:1.65rem;color:#F5F3EF;line-height:1.2;margin-bottom:2.5rem;font-weight:400;}
.sb-divider{height:1px;background:rgba(255,255,255,0.08);margin-bottom:1.5rem;}
.sb-footer{margin-top:auto;padding-top:1.5rem;border-top:1px solid rgba(255,255,255,0.07);font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--midgrey);line-height:2;}
.main{padding:3.5rem 3.5rem 6rem;max-width:960px;}
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:65vh;gap:1.75rem;}
.loading-title{font-family:var(--serif);font-size:2.75rem;font-style:italic;color:var(--charcoal);font-weight:400;}
.loading-sub{font-size:0.65rem;color:var(--midgrey);letter-spacing:0.18em;text-transform:uppercase;}
.dot-pulse{display:flex;gap:7px;align-items:center;}
.dot{width:5px;height:5px;border-radius:50%;background:var(--olive);animation:pulse 1.4s ease-in-out infinite;}
.dot:nth-child(2){animation-delay:0.2s;}
.dot:nth-child(3){animation-delay:0.4s;}
@keyframes pulse{0%,80%,100%{opacity:0.25;transform:scale(0.75);}40%{opacity:1;transform:scale(1);}}
#briefing-content{display:none;}
</style>
</head>
<body>
<div class="shell">
<aside class="sidebar">
  <p class="sb-brand">Oskar Moguel</p>
  <p class="sb-sub">Daily Briefing</p>
  <div class="sb-divider"></div>
  <p class="sb-day">${new Date().toLocaleDateString('en-US',{weekday:'long'})}</p>
  <p class="sb-date">${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric'})}<br>${new Date().getFullYear()}</p>
  <div class="sb-footer">NYC · Connecticut<br>Compass Real Estate</div>
</aside>
<main class="main">
  <div class="loading" id="loading">
    <p class="loading-title">Good morning, Oskar.</p>
    <div class="dot-pulse"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    <p class="loading-sub" id="loading-msg">Reading your world...</p>
  </div>
  <div id="briefing-content"></div>
</main>
</div>

<script>
const ANTHROPIC_KEY = '${process.env.ANTHROPIC_API_KEY}';
const TODAY = '${today}';

async function generateBriefing() {
  const msg = document.getElementById('loading-msg');
  try {
    msg.textContent = 'Reading Gmail, Calendar, and CEO Notes...';
    const dataRes = await fetch('/api/data', {
      headers: { 'Authorization': 'Basic ' + btoa('${process.env.BASIC_AUTH_USER||'oskar'}:${process.env.BASIC_AUTH_PASS||'voyage2026'}') }
    });
    const data = await dataRes.json();
    if (data.error) {
      document.getElementById('loading').innerHTML = '<p style="color:#c0392b;font-family:sans-serif;padding:2rem;">Error: ' + data.error + '</p>';
      return;
    }

    msg.textContent = 'Generating your briefing...';

    const calendarText = data.calendar && data.calendar.length
      ? data.calendar.map(e => e.start + ' | ' + e.title + (e.location ? ' @ ' + e.location : '') + (e.notes ? ' | ' + e.notes : '')).join(' /// ')
      : 'No calendar events found for today or tomorrow.';

    const prompt = \`You are the trusted executive assistant for Oskar Moguel, a luxury real estate advisor at Compass covering NYC and Fairfield County CT. Today is \${TODAY}.

Your role is to produce a beautifully formatted HTML daily briefing that functions as a true relationship management system — not an inbox summary. Your job is to surface what matters, prioritize relationships, and ensure no client falls through the cracks.

═══════════════════════════════════════
DATA SOURCES
═══════════════════════════════════════

[CEO NOTES — highest confidence, treat as ground truth]
\${data.ceoNotes}

[GMAIL — CLIENT EMAILS, label:1-Clients]
\${(data.clientEmails||[]).map(e=>e.from+' | '+e.subject+' | '+e.date+' | '+e.snippet).join(' /// ')}

[GMAIL — ACTIONABLE UNREAD]
\${(data.actionable||[]).map(e=>e.from+' | '+e.subject+' | '+e.date+' | '+e.snippet).join(' /// ')}

[GMAIL — IMPORTANT]
\${(data.important||[]).map(e=>e.from+' | '+e.subject+' | '+e.date+' | '+e.snippet).join(' /// ')}

[CALENDAR — TODAY + TOMORROW]
\${calendarText}

[PIPELINE — hardcoded baseline, treat as inferred unless confirmed by CEO Notes or Gmail]
NYC Active: 78 Ridge St 1F (seller Philip, co-listed Josh Doyle, 36+ days, no offer), Emily+Julien Darmon (offer on 515 West End Ave stalled), Diego Varas (new buyer), Dubroff (touring)
NYC Follow-up: Alfredo Kraushaar (West Village, off-market penthouse available), Damien Wei (price drop 67 Ave C $769K), Isabel Albee (HDFC, last contact Apr 6), Susan Detwiler (444 CPW, no reply)
CT Active: Sharon Anne (Easton neighbor, potential fall seller), Shirley (Norwalk buyer, $499K preapproved ~$380K, waiting on lender), Rick Lashkari (timeline March 2027, open to sooner)
CT Follow-up: Chris Connor (selling LA summer, buying CT fall), Lippert (contingent, selling Fairfield), Anna Halynski (Greenwich lead via Mark Pruner)
Team: Josh Doyle (team leader), Peter Conn (MD), Victoria Rae

═══════════════════════════════════════
CONFIDENCE LABELING — apply to every item
═══════════════════════════════════════

Every piece of information must carry one of three labels rendered as a small inline badge:

CONFIRMED — written directly in CEO Notes by Oskar, or a direct email from the person
INFERRED — AI is connecting dots between two or more sources
NEEDS CONFIRMATION — conflicting, incomplete, or uncertain information

Render each label as a tiny inline badge:
• CONFIRMED: background #E8E5DF, color #2F3130, text "✓ Confirmed"
• INFERRED: background rgba(107,116,99,0.12), color #6B7463, text "~ Inferred"
• NEEDS CONFIRMATION: background rgba(180,100,60,0.10), color #8B4513, text "? Needs Confirmation"

Badge style: font-family Inter, font-size 10px, font-weight 500, letter-spacing 0.1em, padding 3px 8px, border-radius 4px, display inline-block, margin-left 8px, vertical-align middle.

═══════════════════════════════════════
FOLLOW-UP STATUS — apply to every client
═══════════════════════════════════════

Every client card must show one status indicator:

🔴 Reach Out Today — active deal, negotiation, offer, inspection, attorney issue, lender issue, closing, or time-sensitive question
🟠 Follow Up Soon — warm client, no meaningful contact in 30+ days, timeline approaching
🟢 Keep Visible — 14–30 days, still relevant, no immediate action needed
⚪ Waiting On Them — Oskar recently reached out, waiting for response

Render as: emoji + small uppercase label in Inter 10px, letter-spacing 0.14em, color #6A6D69.

═══════════════════════════════════════
DESIGN SYSTEM — inline styles only
═══════════════════════════════════════

PALETTE: charcoal #2F3130, midgrey #6A6D69, lightgrey #D9D7D2, lightstone #F5F3EF, olive #6B7463, olive-light rgba(107,116,99,0.10), greige #E8E5DF, white #ffffff.

SECTION LABEL (use for every section heading):
<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;margin-top:48px;">
  <span style="font-family:'Inter',sans-serif;font-size:10px;font-weight:500;letter-spacing:0.22em;text-transform:uppercase;color:#6A6D69;white-space:nowrap;">SECTION NAME</span>
  <div style="flex:1;height:1px;background:#D9D7D2;"></div>
</div>

CLIENT CARD (use for every client in radar, active deals, etc.):
<div style="background:#ffffff;border:1px solid #D9D7D2;border-radius:14px;padding:24px 26px;margin-bottom:16px;box-shadow:0 1px 4px rgba(47,49,48,0.05),0 4px 16px rgba(47,49,48,0.04);">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
    <h3 style="font-family:'EB Garamond',serif;font-size:26px;font-weight:400;color:#2F3130;margin:0;">Client Name</h3>
    <span>[follow-up status emoji + label]</span>
  </div>
  <div style="font-size:13px;color:#6A6D69;margin-bottom:10px;display:flex;gap:10px;flex-wrap:wrap;">
    <span>Buyer / Seller</span><span>·</span><span>NYC / CT</span><span>·</span><span>Last contact: [date or timeframe]</span>
    <span>[confidence badge]</span>
  </div>
  <p style="font-size:16px;color:#2F3130;line-height:1.6;margin-bottom:14px;">Status and context.</p>
  <div style="background:#E8E5DF;border-left:3px solid #6B7463;border-radius:0 8px 8px 0;padding:12px 16px;">
    <div style="font-family:'Inter',sans-serif;font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:#6B7463;margin-bottom:6px;">SUGGESTED NEXT STEP</div>
    <p style="font-size:16px;color:#2F3130;line-height:1.45;margin:0;">Specific action.</p>
  </div>
</div>

PRIORITY CARD (4-card top strip only — who needs me today):
<div style="background:#ffffff;border:1px solid #D9D7D2;border-radius:14px;padding:28px 22px 0;position:relative;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 1px 4px rgba(47,49,48,0.05),0 4px 16px rgba(47,49,48,0.04);">
  <span style="font-family:'EB Garamond',serif;font-size:52px;color:#D9D7D2;position:absolute;top:10px;right:16px;line-height:1;">1</span>
  <span style="font-size:10px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:#6A6D69;margin-bottom:8px;">🔴 Urgent</span>
  <h3 style="font-family:'EB Garamond',serif;font-size:28px;font-weight:400;color:#2F3130;line-height:1.15;margin-bottom:8px;">Name</h3>
  <p style="font-size:15px;color:#6A6D69;line-height:1.5;flex:1;margin:0;">Why they need you today.</p>
  <div style="height:3px;background:#6B7463;margin:20px -22px 0;"></div>
</div>
Priority grid: display grid, grid-template-columns repeat(4,1fr), gap 18px, margin-bottom 48px. First card background #E8E5DF.

INBOX CARD (urgent inbox section only):
<div style="background:#ffffff;border:1px solid #D9D7D2;border-radius:14px;margin-bottom:20px;overflow:hidden;box-shadow:0 1px 4px rgba(47,49,48,0.05),0 4px 16px rgba(47,49,48,0.04);">
  <div style="padding:20px 26px 16px;border-bottom:1px solid #D9D7D2;display:flex;align-items:flex-start;gap:14px;">
    <span style="font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;padding:4px 10px;border-radius:4px;background:rgba(107,116,99,0.10);color:#6B7463;white-space:nowrap;margin-top:3px;">ACTION</span>
    <p style="font-family:'EB Garamond',serif;font-size:22px;font-weight:400;color:#2F3130;line-height:1.25;margin:0;">Subject</p>
  </div>
  <div style="padding:12px 26px;font-size:14px;color:#6A6D69;border-bottom:1px solid #D9D7D2;">From · date · [confidence badge]</div>
  <div style="padding:14px 26px;font-family:'EB Garamond',serif;font-size:17px;font-style:italic;color:#6A6D69;line-height:1.65;border-bottom:1px solid #D9D7D2;">Why this matters.</div>
  <div style="margin:14px 18px 16px;background:#E8E5DF;border-left:3px solid #6B7463;border-radius:0 8px 8px 0;padding:14px 18px;">
    <div style="font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:#6B7463;margin-bottom:8px;">ACTION</div>
    <p style="font-family:'EB Garamond',serif;font-size:19px;font-weight:500;color:#2F3130;line-height:1.45;margin:0;">Specific action.</p>
  </div>
</div>

WAITING-ON CARD:
<div style="background:#ffffff;border:1px solid #D9D7D2;border-radius:10px;padding:18px 22px;margin-bottom:12px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;">
  <div>
    <p style="font-family:'EB Garamond',serif;font-size:20px;color:#2F3130;margin-bottom:4px;">Person / Party</p>
    <p style="font-size:14px;color:#6A6D69;line-height:1.5;">What you're waiting on. [confidence badge]</p>
  </div>
  <span style="font-size:10px;font-weight:500;letter-spacing:0.12em;text-transform:uppercase;color:#6A6D69;white-space:nowrap;padding-top:4px;">⚪ Waiting</span>
</div>

MARKET TILE (used in market intelligence section):
Two-column panel: background #ffffff, border 1px solid #D9D7D2, border-radius 14px, overflow hidden.
Each tile: padding 18px, border-right + border-bottom 1px solid #D9D7D2.
Signal tile bg #E8E5DF, Opportunity tile bg rgba(107,116,99,0.08), others #ffffff.
Tile label: Inter 10px uppercase letter-spacing 0.16em color #6A6D69.
Tile heading: EB Garamond 18px color #2F3130.
Tile note: Inter 14px color #6A6D69.

CEO MEMORY CARD:
<div style="background:#E8E5DF;border-radius:10px;padding:16px 20px;margin-bottom:10px;">
  <p style="font-size:15px;color:#2F3130;line-height:1.6;margin:0;">Memory excerpt. [confidence badge always = CONFIRMED]</p>
</div>

PULL QUOTE (morning perspective, final section):
<div style="background:#6B7463;border-radius:14px;padding:32px 36px 28px;margin-top:32px;">
  <div style="font-family:'EB Garamond',serif;font-size:64px;color:rgba(255,255,255,0.18);line-height:0.7;margin-bottom:10px;">"</div>
  <p style="font-family:'EB Garamond',serif;font-size:20px;font-style:italic;color:#ffffff;line-height:1.6;margin:0;">Insight here.</p>
</div>

TWO-COLUMN LAYOUT (market intelligence, relationship momentum):
display:grid; grid-template-columns:1fr 1fr; gap:24px; align-items:start;

═══════════════════════════════════════
SECTIONS — render in this exact order
═══════════════════════════════════════

1. WHO NEEDS ME TODAY
   Max 4 items. Only true urgent action: active negotiations, offers, inspections, attorney/lender issues, time-sensitive questions. Use the priority card grid. If calendar has meetings today, surface the most relevant one as a priority card. Each card must show confidence badge.

2. RELATIONSHIP MOMENTUM
   3–5 clients who would benefit from hearing from Oskar today — a market update, a check-in, a relevant listing, or a kind word. Not urgent, but high value. Use client cards. Show follow-up status and confidence badge. Briefly explain why today is a good moment to reach out.

3. WAITING ON
   Everyone Oskar is currently waiting to hear back from — clients, attorneys, lenders, co-brokers, boards. Use waiting-on cards. Show confidence badge on each.

4. CLIENT FOLLOW-UP RADAR
   All active and warm clients. Show every person from the pipeline. For each: name, buyer/seller/prospect, market (NYC/CT), last known contact, status, follow-up urgency, confidence badge, and a specific suggested next step. Group by urgency: 🔴 first, then 🟠, then 🟢, then ⚪.

5. URGENT INBOX
   Only emails that require a response or action today. Do NOT include listing blasts, newsletters, open house invitations, automated alerts, or agent mass emails. Each email gets an inbox card with confidence badge.

6. ACTIVE DEALS AND LISTINGS
   All active transactions. Offers, negotiations, inspections, pricing discussions, listings with no offer. Each deal gets a client card with confidence badge and a clear next step.

7. MARKET INTELLIGENCE
   Only market information directly relevant to one of Oskar's active clients or listings. No generic news. Two-column layout with market tiles. Label each tile with the client it is relevant to.

8. CEO MEMORY
   Surface 4–8 key reminders extracted from CEO Notes. These are memory items, not tasks. Use CEO memory cards. All carry CONFIRMED badge.

9. MORNING PERSPECTIVE
   One pull quote — an editorial insight, a strategic observation about the day, or a motivating thought. Write it in Oskar's voice: confident, clear, relationship-first. No clichés.

═══════════════════════════════════════
RULES
═══════════════════════════════════════

• Client-first, not inbox-first. Relationships take priority over emails.
• Never overstate. If uncertain, use INFERRED or NEEDS CONFIRMATION.
• Never create artificial urgency. Only use 🔴 when genuinely time-sensitive.
• If calendar has a meeting with a client today, reflect that in their card and in section 1 if relevant.
• No client should disappear simply because they are not urgent. Keep everyone visible.
• Return ONLY the HTML content. No html/head/body tags. No markdown. No explanation.\`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 10000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const result = await response.json();
    const html = result.content?.[0]?.text || '<p style="color:#c0392b;padding:2rem;">Error generating briefing.</p>';

    document.getElementById('loading').style.display = 'none';
    const content = document.getElementById('briefing-content');
    content.style.display = 'block';
    content.innerHTML = html;

  } catch(err) {
    document.getElementById('loading').innerHTML = '<p style="color:#c0392b;padding:2rem;font-family:sans-serif;">Error: ' + err.message + '</p>';
  }
}

generateBriefing();
</script>
</body>
</html>`)
}
