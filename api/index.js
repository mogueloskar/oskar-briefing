const { google } = require('googleapis')

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

async function searchGmail(gmail, query, max = 8) {
  try {
    const res = await gmail.users.threads.list({ userId: 'me', q: query, maxResults: max })
    const threads = res.data.threads || []
    const results = []
    for (const t of threads.slice(0, 5)) {
      try {
        const full = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'metadata', metadataHeaders: ['Subject','From','Date'] })
        const msg = full.data.messages?.[0]
        const headers = msg?.payload?.headers || []
        results.push({
          subject: headers.find(h=>h.name==='Subject')?.value || '',
          from: headers.find(h=>h.name==='From')?.value || '',
          snippet: msg?.snippet || ''
        })
      } catch(e) {}
    }
    return results
  } catch(e) { return [] }
}

module.exports = async (req, res) => {
  // Basic auth check
  const auth = req.headers['authorization']
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Oskar Briefing"')
    return res.status(401).end()
  }
  const [,encoded] = auth.split(' ')
  const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':')
  if (user !== (process.env.BASIC_AUTH_USER||'oskar') || pass !== (process.env.BASIC_AUTH_PASS||'voyage2026')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Oskar Briefing"')
    return res.status(401).end()
  }

  // Handle OAuth callback
  if (req.url.includes('/api/callback')) {
    const url = new URL(req.url, 'https://oskar-briefing.vercel.app')
    const code = url.searchParams.get('code')
    if (code) {
      const oauth2Client = getOAuthClient()
      const { tokens } = await oauth2Client.getToken(code)
      return res.status(200).send(`
        <html><body style="font-family:sans-serif;background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1rem;">
          <h2 style="color:#C8CCBF;font-weight:300;">Gmail Connected Successfully</h2>
          <p style="color:#A89F94;max-width:500px;text-align:center;">Copy the token below and add it as GOOGLE_TOKENS in your Vercel environment variables, then redeploy.</p>
          <textarea style="width:500px;height:100px;background:#2C2C2C;color:#fff;border:1px solid #444;padding:0.75rem;font-size:0.7rem;" readonly>${JSON.stringify(tokens)}</textarea>
          <p style="color:#5E6658;font-size:0.75rem;">After saving to Vercel env vars and redeploying, your briefing will work.</p>
        </body></html>
      `)
    }
  }

  // Handle OAuth login initiation
  if (req.url.includes('/api/login')) {
    const oauth2Client = getOAuthClient()
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/drive.readonly'],
      prompt: 'consent'
    })
    return res.redirect(url)
  }

  // Check if tokens are configured
  const tokens = JSON.parse(process.env.GOOGLE_TOKENS || '{}')
  const hasTokens = !!tokens.access_token

  if (!hasTokens) {
    return res.status(200).send(`
      <html><body style="font-family:sans-serif;background:#F4F1ED;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1rem;">
        <h2 style="font-family:Georgia,serif;font-style:italic;font-weight:300;color:#2C2C2C;">One more step</h2>
        <p style="color:#7B7B7B;max-width:400px;text-align:center;">Connect your Gmail to activate the daily briefing.</p>
        <a href="/api/login" style="background:#5E6658;color:#fff;padding:0.75rem 1.5rem;text-decoration:none;font-size:0.85rem;letter-spacing:0.05em;">Connect Gmail</a>
      </body></html>
    `)
  }

  try {
    const auth = getOAuthClient()
    const gmail = google.gmail({ version: 'v1', auth })
    const drive = google.drive({ version: 'v3', auth })

    // Pull data in parallel
    const [important, unread, clientActivity, ceoNotesRes] = await Promise.all([
      searchGmail(gmail, 'is:important newer_than:2d -category:promotions -from:noreply', 8),
      searchGmail(gmail, 'is:unread newer_than:1d -category:promotions -category:updates -from:noreply', 8),
      searchGmail(gmail, 'newer_than:3d label:1-Clients', 6),
      drive.files.export({ fileId: '1Efkqza-yGbL0KuiPAFxqk01be1qb82rZU5oOO_eCHpE', mimeType: 'text/plain' }).catch(()=>({data:''}))
    ])

    const ceoNotes = typeof ceoNotesRes.data === 'string' ? ceoNotesRes.data.slice(0, 2000) : ''
    const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })

    // Call Anthropic API
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: `You are the executive briefing assistant for Oskar Moguel, a real estate advisor at Compass covering NYC and Fairfield County CT.

Today is ${today}.

CEO NOTES:
${ceoNotes}

IMPORTANT EMAILS (last 2 days):
${important.map(e=>`From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n---\n')}

UNREAD EMAILS (last 24hrs):
${unread.map(e=>`From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n---\n')}

CLIENT FOLDER ACTIVITY:
${clientActivity.map(e=>`From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n---\n')}

PIPELINE:
- Active NYC: 78 Ridge St 1F (seller Philip, co-listed Josh Doyle), Darmon Emily+Julien (offer 515 West End Ave), Varas Diego (new buyer), Dubroff (touring)
- NYC Follow-up: Kraushaar Alfredo (West Village buyer), Wei Damien (saved search), Albee Isabel (HDFC), Detwiler Susan (444 CPW)
- CT Active: Sharon Anne (Easton neighbor, potential seller fall), Shirley (Norwalk buyer $499K preapproved $380K), Rick Lashkari (March 2027 flexible to buy sooner)
- CT Follow-up: Connor Chris (selling LA summer buying CT fall), Lippert (contingent selling Fairfield), Anna Halynski (Greenwich lead via Mark Pruner)
- 2027: Maring Mike (new lease re-engage Mar 2027), Gralla (rented Williamsburg re-engage Mar 2027)
- Team: Josh Doyle (leader), Peter Conn (MD), Victoria Rae

Generate a complete HTML daily briefing dashboard using this exact design:
- Background #F4F1ED, white panels, charcoal #2C2C2C text
- Olive #5E6658 for accents and opportunities
- Warm Stone #A89F94 for labels
- Google Fonts: Cormorant Garamond italic for headlines, DM Sans for body
- Left sidebar 200px charcoal with nav + date
- Focus strip with 4 priority cards
- Two-column inbox + market sections
- Full client sections with ACTION blocks styled as: olive left border, "ACTION" label in olive, bold directive text
- Opportunities in olive-tinted panel, Risks in white panel
- CEO Notes in dark charcoal panel
- Morning perspective quote
- Footer with three brand principles

Return ONLY the complete HTML document, nothing else.`
        }]
      })
    })

    const data = await anthropicRes.json()
    const html = data.content?.[0]?.text || '<html><body>Error generating briefing. Check API key.</body></html>'

    res.setHeader('Content-Type', 'text/html')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).send(html)

  } catch(error) {
    return res.status(500).send(`<html><body style="font-family:sans-serif;padding:2rem;"><h2>Error</h2><pre>${error.message}</pre></body></html>`)
  }
}
