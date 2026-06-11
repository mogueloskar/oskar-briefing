const http = require('http')
const handler = require('./api/index')

const server = http.createServer((req, res) => {
  handler(req, res)
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Oskar Briefing running on port ${PORT}`)
})
