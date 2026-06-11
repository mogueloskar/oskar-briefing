const { google } = require('googleapis')

function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://oskar-briefing.vercel.app/api/callback'
  )
  try {
    const tokens = JSON.parse(process.env.GOOGLE_TOKENS || '{}')
    if (tokens.access_token) oauth2Client.setCredentials(tokens)
  } catch(e) {}
  return oauth2Client
}

async function searchGmail(gmail, query, max = 5) {
  try {
    const res = await gmail.users.threads.list({ userId: 'me', q: query, maxResults: max })
    const threads = res.data.threads || []
    const results = []
    for (const t of threads.slice(0, 4)) {
      try {
        const full = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'metadata', metadataHeaders: ['Subject','From'] })
        const msg = full.data.messages?.[0]
        const headers = msg?.payload?.headers || []
        results.push({
          subject: headers.find(h=>h.name==='Subject')?.value || '',
          from: headers.find(h=>h.name==='From')?.value || '',
          snippet: (msg?.snippet || '').slice(0, 150)
        })
      } catch(e) {}
    }
    return results
  } catch(e) { return [] }
}

module.exports = async (req, res) => {
  // Basic auth
  const authHeader = req.headers['authorization']
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Oskar Briefing"')
    return res.status(401).end()
  }
  const [,encoded] = authHeader.split(' ')
  const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':')
  if (user !== (process.env.BASIC_AUTH_USER||'oskar') || pass !== (process.env.BASIC_AUTH_PASS||'voyage2026')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Oskar Briefing"')
    return res.status(401).end()
  }

  const url = new URL(req.url, 'https://oskar-briefing.vercel.app')
  const path = url.pathname

  // OAuth callback
  if (path.includes('callback')) {
    const code = url.searchParams.get('code')
    if (code) {
      try {
        const oauth2Client = getOAuthClient()
        const { tokens } = await oauth2Client.getToken(code)
        const tokenStr = JSON.stringify(tokens)
        return res.status(200).send(`<!DOCTYPE html>
<html><head><title>Connected</title></head>
<body style="font-family:sans-serif;background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1.5rem;padding:2rem;box-sizing:border-box;">
<h2 style="color:#C8CCBF;font-weight:300;margin:0;">Gmail Connected</h2>
<p style="color:#A89F94;max-width:500px;text-align:center;margin:0;font-size:0.9rem;">Copy the token below. Go to your Vercel project, Settings > Environment Variables, find GOOGLE_TOKENS, edit it and paste this value. Then redeploy.</p>
<textarea onclick="this.select()" style="width:100%;max-width:600px;height:100px;background:#2C2C2C;color:#C8CCBF;border:1px solid #444;padding:0.75rem;font-size:0.65rem;">${tokenStr}</textarea>
</body></html>`)
      } catch(e) {
        return res.status(200).send(`<html><body style="background:#1a1a1a;color:red;padding:2rem;">${e.message}</body></html>`)
      }
    }
  }

  // Login
  if (path.includes('login')) {
    const oauth2Client = getOAuthClient()
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/drive.readonly'],
      prompt: 'consent'
    })
    return res.redirect(302, authUrl)
  }

  // Data endpoint - fast, returns JSON for browser to use
  if (path.includes('data')) {
    let tokens = {}
    try { tokens = JSON.parse(process.env.GOOGLE_TOKENS || '{}') } catch(e) {}
    if (!tokens.access_token) return res.json({ error: 'not_connected' })
    
    try {
      const auth = getOAuthClient()
      const gmail = google.gmail({ version: 'v1', auth })
      const drive = google.drive({ version: 'v3', auth })

      const [important, unread, clients, ceoRes] = await Promise.all([
        searchGmail(gmail, 'is:important newer_than:2d -category:promotions -from:noreply', 5),
        searchGmail(gmail, 'is:unread newer_than:1d -category:promotions -from:noreply', 5),
        searchGmail(gmail, 'newer_than:3d label:1-Clients', 4),
        drive.files.export({ fileId: '1Efkqza-yGbL0KuiPAFxqk01be1qb82rZU5oOO_eCHpE', mimeType: 'text/plain' }).catch(()=>({data:''}))
      ])

      const ceoNotes = typeof ceoRes.data === 'string' ? ceoRes.data.slice(0,1500) : ''
      
      return res.json({ important, unread, clients, ceoNotes, ok: true })
    } catch(e) {
      return res.json({ error: e.message })
    }
  }

  // Check tokens for main page
  let tokens = {}
  try { tokens = JSON.parse(process.env.GOOGLE_TOKENS || '{}') } catch(e) {}
  const hasTokens = !!tokens.access_token

  if (!hasTokens) {
    return res.status(200).send(`<!DOCTYPE html>
<html><head><title>Oskar Briefing</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,300&family=DM+Sans:wght@300;400&display=swap" rel="stylesheet">
</head>
<body style="font-family:'DM Sans',sans-serif;background:#F4F1ED;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:2rem;">
<h2 style="font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:300;color:#2C2C2C;font-size:2.5rem;margin:0;">One more step</h2>
<p style="color:#7B7B7B;max-width:400px;text-align:center;margin:0;font-size:0.9rem;">Connect your Gmail to activate the daily briefing.</p>
<a href="/api/login" style="background:#5E6658;color:#fff;padding:0.85rem 2rem;text-decoration:none;font-size:0.8rem;letter-spacing:0.1em;text-transform:uppercase;">Connect Gmail</a>
</body></html>`)
  }

  // Main page - loads fast, generates briefing in browser using Anthropic API
  const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })
  
  return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Daily Briefing — Oskar Moguel</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{--charcoal:#2C2C2C;--olive:#5E6658;--olive-light:#EEF0EB;--olive-mid:#C8CCBF;--warm-stone:#A89F94;--light-grey:#D9D9D9;--light-stone:#D8D3CB;--bg:#F4F1ED;--white:#fff;--serif:'Cormorant Garamond',Georgia,serif;--sans:'DM Sans',system-ui,sans-serif;}
*{box-sizing:border-box;margin:0;padding:0;}html{font-size:15px;}
body{background:var(--bg);color:var(--charcoal);font-family:var(--sans);font-weight:300;-webkit-font-smoothing:antialiased;}
.shell{display:grid;grid-template-columns:200px 1fr;min-height:100vh;}
.sidebar{background:var(--charcoal);padding:2.25rem 1.5rem;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;}
.sb-brand{font-family:var(--serif);font-size:1.1rem;font-weight:300;font-style:italic;color:var(--light-stone);margin-bottom:0.2rem;}
.sb-sub{font-size:0.58rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--warm-stone);margin-bottom:2rem;}
.sb-date{font-family:var(--serif);font-size:1.35rem;font-weight:300;color:#fff;line-height:1.2;margin-bottom:0.3rem;}
.sb-day{font-size:0.57rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--warm-stone);margin-bottom:2rem;}
.sb-footer{margin-top:auto;padding-top:1.25rem;border-top:0.5px solid rgba(255,255,255,0.08);font-size:0.57rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--warm-stone);line-height:1.8;}
.main{padding:2.75rem 3rem 5rem;max-width:900px;}
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:1.5rem;}
.loading-title{font-family:var(--serif);font-size:2.5rem;font-weight:300;font-style:italic;color:var(--charcoal);}
.loading-sub{font-size:0.8rem;color:var(--warm-stone);letter-spacing:0.1em;text-transform:uppercase;}
.dot-pulse{display:flex;gap:6px;align-items:center;}
.dot{width:6px;height:6px;border-radius:50%;background:var(--olive);animation:pulse 1.4s ease-in-out infinite;}
.dot:nth-child(2){animation-delay:0.2s;}
.dot:nth-child(3){animation-delay:0.4s;}
@keyframes pulse{0%,80%,100%{opacity:0.3;transform:scale(0.8);}40%{opacity:1;transform:scale(1);}}
#briefing-content{display:none;}
</style>
</head>
<body>
<div class="shell">
<aside class="sidebar">
  <p class="sb-brand">Oskar Moguel</p>
  <p class="sb-sub">Daily Briefing</p>
  <p class="sb-day">${new Date().toLocaleDateString('en-US',{weekday:'long'})}</p>
  <p class="sb-date">${new Date().toLocaleDateString('en-US',{month:'long', day:'numeric'})}<br>${new Date().getFullYear()}</p>
  <div class="sb-footer">NYC · Connecticut<br>Compass Real Estate</div>
</aside>
<main class="main">
  <div class="loading" id="loading">
    <p class="loading-title">Good morning, Oskar.</p>
    <div class="dot-pulse"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    <p class="loading-sub" id="loading-msg">Pulling your inbox...</p>
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
    msg.textContent = 'Reading your inbox...';
    const dataRes = await fetch('/api/data', {
      headers: { 'Authorization': 'Basic ' + btoa('${process.env.BASIC_AUTH_USER||'oskar'}:${process.env.BASIC_AUTH_PASS||'voyage2026'}') }
    });
    const data = await dataRes.json();
    
    if (data.error) {
      document.getElementById('loading').innerHTML = '<p style="color:red;font-family:sans-serif;">Error: ' + data.error + '</p>';
      return;
    }

    msg.textContent = 'Generating your briefing...';

    const prompt = \`You are the executive briefing assistant for Oskar Moguel, a real estate advisor at Compass covering NYC and Fairfield County CT. Today is \${TODAY}.

CEO NOTES: \${data.ceoNotes}

IMPORTANT EMAILS: \${data.important.map(e=>e.from+' | '+e.subject+' | '+e.snippet).join(' /// ')}

UNREAD EMAILS: \${data.unread.map(e=>e.from+' | '+e.subject+' | '+e.snippet).join(' /// ')}

CLIENT ACTIVITY: \${data.clients.map(e=>e.from+' | '+e.subject+' | '+e.snippet).join(' /// ')}

PIPELINE:
Active NYC: 78 Ridge St 1F (seller Philip co-listed Josh Doyle 36+ days no offer), Darmon Emily+Julien (offer 515 West End Ave stalled), Varas Diego (new buyer), Dubroff (touring)
NYC Follow-up: Kraushaar Alfredo (West Village buyer off-market penthouse available), Wei Damien (price drop 67 Ave C $769K), Albee Isabel (HDFC last Apr 6), Detwiler Susan (444 CPW no reply)
CT Active: Sharon Anne (Easton neighbor potential seller fall), Shirley (Norwalk buyer $499K preapproved $380K waiting lender), Rick Lashkari (March 2027 flexible sooner)
CT Follow-up: Connor Chris (selling LA summer buying CT fall), Lippert (contingent selling Fairfield), Anna Halynski (Greenwich lead via Mark Pruner)
Team: Josh Doyle (leader), Peter Conn (MD), Victoria Rae

Generate a complete HTML daily briefing dashboard (just the inner content, no html/head/body tags). Use inline styles only. Design: white panels with 1px #D9D9D9 borders, charcoal #2C2C2C text, olive #5E6658 accents, warm stone #A89F94 labels, olive-light #EEF0EB backgrounds for opportunities. Include: 4-card focus strip, inbox priorities, market pulse (NYC + CT two columns), NYC clients (active + follow-up), CT clients, broker radar, opportunities + risks, content idea, CEO notes snapshot, morning perspective. Every client and inbox item ends with ACTION block: background #EEF0EB, border-left 2px solid #5E6658, padding 0.35rem 0.65rem, label ACTION in #5E6658 caps 0.52rem, bold directive text. Return ONLY the HTML content.\`;

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
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const result = await response.json();
    const html = result.content?.[0]?.text || '<p>Error generating briefing.</p>';

    document.getElementById('loading').style.display = 'none';
    const content = document.getElementById('briefing-content');
    content.style.display = 'block';
    content.innerHTML = html;

  } catch(err) {
    document.getElementById('loading').innerHTML = '<p style="color:red;padding:2rem;font-family:sans-serif;">Error: ' + err.message + '</p>';
  }
}

generateBriefing();
</script>
</body>
</html>`)
}
