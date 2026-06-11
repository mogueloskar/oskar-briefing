const http = require('http')
const handler = require('./api/index')

const server = http.createServer((req, res) => {
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (data) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data)) }
  res.send = (data) => { res.end(data) }
  res.redirect = (code, url) => { if(typeof code === 'string'){url=code;code=302} res.statusCode=code; res.setHeader('Location',url); res.end() }
  handler(req, res)
})

const PORT = process.env.PORT || 8080
server.listen(PORT, () => {
  console.log(`Oskar Briefing running on port ${PORT}`)
})
