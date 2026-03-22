import { NextRequest, NextResponse } from 'next/server'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI!

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 })

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })
  const tokens = await tokenRes.json()
  if (tokens.error) return NextResponse.json({ error: tokens.error_description }, { status: 400 })

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  const user = await userRes.json()

  // Show token for saving to Vercel env
  return new NextResponse(
    `<html><body style="font-family:monospace;padding:20px">
    <h2>✅ Google připojen: ${user.email}</h2>
    <p>Zkopíruj tento refresh token a ulož ho jako env var:</p>
    <textarea rows="3" style="width:100%;font-size:12px">${tokens.refresh_token}</textarea>
    <br><br>
    <p>Nebo ho automaticky nastavím — zavři toto okno a jdi zpět do aplikace.</p>
    <script>
      // Post token to /api/google/save-token
      fetch('/api/google/save-token', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({token: '${tokens.refresh_token}', email: '${user.email}'})
      }).then(r => r.json()).then(d => {
        if(d.ok) document.body.innerHTML += '<p style="color:green">✅ Token uložen automaticky!</p>'
      })
    </script>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  )
}
