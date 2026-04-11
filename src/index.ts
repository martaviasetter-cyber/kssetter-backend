import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const app = express()
const PORT = process.env.PORT || 3000

// ── CLIENTS ──
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY! })

// ── MIDDLEWARE ──
app.use(cors())
app.use(express.json({ verify: (req: any, res, buf) => { req.rawBody = buf } }))

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'KS Setter Backend', version: '1.0.0' })
})

// ── AI LEAD CLASSIFIER ──
async function classifyMessage(message: string, senderName: string, channel: string): Promise<{
  status: 'new' | 'follow' | 'booked' | 'closed' | 'cold'
  note: string
  isLead: boolean
}> {
  try {
    const response = await ai.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `Eres un experto en appointment setting. Analiza mensajes de redes sociales y clasifica si son leads potenciales.
      
Responde SOLO con JSON sin markdown:
{
  "isLead": true/false,
  "status": "new" | "follow" | "booked" | "cold",
  "note": "resumen breve del mensaje en español (max 100 chars)"
}

Criterios:
- isLead: true si el mensaje muestra interés en un producto/servicio, hace preguntas de precio, pide info, o es una consulta de negocio
- isLead: false si es spam, saludo genérico sin contexto, o irrelevante
- status "new": primer contacto, pregunta general, interés inicial
- status "follow": ya hubo contacto previo, pide seguimiento, recordatorio
- status "booked": confirma una cita, reunión o llamada
- status "cold": no responde, mensaje frío, sin interés claro`,
      messages: [{
        role: 'user',
        content: `Canal: ${channel}\nRemitente: ${senderName}\nMensaje: "${message}"`
      }]
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
    const result = JSON.parse(text.trim())
    return result
  } catch (e) {
    return { isLead: true, status: 'new', note: message.substring(0, 100) }
  }
}

// ── FIND USER BY CONNECTED ACCOUNT ──
async function findUserByAccount(accountId: string, platform: string): Promise<string | null> {
  const { data } = await sb
    .from('connected_accounts')
    .select('user_id')
    .eq('platform', platform)
    .eq('platform_account_id', accountId)
    .single()
  return data?.user_id || null
}

// ── CREATE OR UPDATE LEAD ──
async function upsertLead(userId: string, senderId: string, senderName: string, channel: string, classification: any) {
  // Check if lead already exists
  const { data: existing } = await sb
    .from('leads')
    .select('id, status')
    .eq('user_id', userId)
    .eq('platform_sender_id', senderId)
    .single()

  if (existing) {
    // Update existing lead if status changed
    if (existing.status !== classification.status) {
      await sb.from('leads').update({
        status: classification.status,
        note: classification.note,
      }).eq('id', existing.id)
    }
    return { action: 'updated', id: existing.id }
  } else {
    // Create new lead
    const { data } = await sb.from('leads').insert({
      user_id: userId,
      name: senderName,
      channel,
      status: classification.status,
      note: classification.note,
      platform_sender_id: senderId,
    }).select().single()
    return { action: 'created', id: data?.id }
  }
}

// ── INSTAGRAM WEBHOOK ──
app.get('/webhook/instagram', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Instagram webhook verified')
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

app.post('/webhook/instagram', async (req, res) => {
  res.sendStatus(200) // Respond immediately to Meta
  
  try {
    const body = req.body
    if (body.object !== 'instagram') return

    for (const entry of body.entry || []) {
      for (const messaging of entry.messaging || []) {
        const senderId = messaging.sender?.id
        const message = messaging.message?.text
        if (!senderId || !message || messaging.message?.is_echo) continue

        // Find which KS Setter user owns this Instagram account
        const userId = await findUserByAccount(entry.id, 'instagram')
        if (!userId) continue

        // Get sender name from Instagram API
        let senderName = 'Instagram User'
        try {
          const r = await fetch(`https://graph.instagram.com/${senderId}?fields=name&access_token=${process.env.INSTAGRAM_TOKEN}`)
          const data = await r.json() as any
          senderName = data.name || senderName
        } catch {}

        // Classify with AI
        const classification = await classifyMessage(message, senderName, 'Instagram DM')
        if (!classification.isLead) continue

        // Create/update lead
        await upsertLead(userId, senderId, senderName, 'Instagram DM', classification)
        console.log(`Instagram lead processed: ${senderName} → ${classification.status}`)
      }
    }
  } catch (err) {
    console.error('Instagram webhook error:', err)
  }
})

// ── WHATSAPP WEBHOOK ──
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified')
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200)

  try {
    const body = req.body
    if (body.object !== 'whatsapp_business_account') return

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages
        if (!messages) continue

        for (const msg of messages) {
          if (msg.type !== 'text') continue
          const senderId = msg.from
          const message = msg.text?.body
          const senderName = change.value?.contacts?.find((c: any) => c.wa_id === senderId)?.profile?.name || `WA ${senderId}`

          const userId = await findUserByAccount(change.value?.metadata?.phone_number_id, 'whatsapp')
          if (!userId) continue

          const classification = await classifyMessage(message, senderName, 'WhatsApp')
          if (!classification.isLead) continue

          await upsertLead(userId, senderId, senderName, 'WhatsApp', classification)
          console.log(`WhatsApp lead processed: ${senderName} → ${classification.status}`)
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err)
  }
})

// ── FACEBOOK MESSENGER WEBHOOK ──
app.get('/webhook/facebook', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Facebook webhook verified')
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

app.post('/webhook/facebook', async (req, res) => {
  res.sendStatus(200)

  try {
    const body = req.body
    if (body.object !== 'page') return

    for (const entry of body.entry || []) {
      for (const messaging of entry.messaging || []) {
        const senderId = messaging.sender?.id
        const message = messaging.message?.text
        if (!senderId || !message || messaging.message?.is_echo) continue

        const userId = await findUserByAccount(entry.id, 'facebook')
        if (!userId) continue

        let senderName = 'Facebook User'
        try {
          const r = await fetch(`https://graph.facebook.com/${senderId}?fields=name&access_token=${process.env.FACEBOOK_TOKEN}`)
          const data = await r.json() as any
          senderName = data.name || senderName
        } catch {}

        const classification = await classifyMessage(message, senderName, 'Facebook')
        if (!classification.isLead) continue

        await upsertLead(userId, senderId, senderName, 'Facebook', classification)
        console.log(`Facebook lead processed: ${senderName} → ${classification.status}`)
      }
    }
  } catch (err) {
    console.error('Facebook webhook error:', err)
  }
})

// ── OAUTH: Connect Instagram account ──
app.post('/connect/instagram', async (req, res) => {
  const { userId, accessToken, accountId } = req.body
  if (!userId || !accessToken || !accountId) return res.status(400).json({ error: 'Missing fields' })

  const { error } = await sb.from('connected_accounts').upsert({
    user_id: userId,
    platform: 'instagram',
    platform_account_id: accountId,
    access_token: accessToken,
  }, { onConflict: 'user_id,platform' })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// ── OAUTH: Connect WhatsApp account ──
app.post('/connect/whatsapp', async (req, res) => {
  const { userId, accessToken, phoneNumberId } = req.body
  if (!userId || !accessToken || !phoneNumberId) return res.status(400).json({ error: 'Missing fields' })

  const { error } = await sb.from('connected_accounts').upsert({
    user_id: userId,
    platform: 'whatsapp',
    platform_account_id: phoneNumberId,
    access_token: accessToken,
  }, { onConflict: 'user_id,platform' })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// ================================================================
// KP-SETTER — RUTAS OAUTH PARA CONECTAR REDES SOCIALES
// ================================================================
// Estas rutas van en el archivo src/index.ts del backend en Railway
// Agrégalas ANTES de la línea: app.listen(PORT, () => {
// ================================================================

const META_APP_ID = process.env.META_APP_ID || '943441298220087'
const META_APP_SECRET = process.env.META_APP_SECRET || ''
const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://kssetter-backend-production.up.railway.app'

// ── INSTAGRAM OAUTH ──
// Paso 1: Redirige al usuario a Meta para autorizar
app.get('/oauth/instagram/start', (req, res) => {
  const userId = req.query.user_id as string
  if (!userId) return res.status(400).json({ error: 'user_id required' })

  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: `${BACKEND_URL}/oauth/instagram/callback`,
    scope: 'instagram_basic,instagram_manage_messages,pages_show_list',
    response_type: 'code',
    state: userId // guardamos el userId para usarlo en el callback
  })

  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`)
})

// Paso 2: Meta redirige aquí con el código de autorización
app.get('/oauth/instagram/callback', async (req, res) => {
  const code = req.query.code as string
  const userId = req.query.state as string

  if (!code || !userId) return res.redirect('https://kpsettetter.netlify.app/app.html?error=oauth_failed')

  try {
    // Intercambiar código por token de acceso
    const tokenRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri: `${BACKEND_URL}/oauth/instagram/callback`,
        code
      })
    })
    const tokenData = await tokenRes.json() as any
    const accessToken = tokenData.access_token
    if (!accessToken) throw new Error('No access token received')

    // Obtener la cuenta de Instagram conectada
    const igRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`)
    const igData = await igRes.json() as any

    // Buscar página con Instagram conectado
    let igAccountId = ''
    for (const page of igData.data || []) {
      const igPageRes = await fetch(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`)
      const igPageData = await igPageRes.json() as any
      if (igPageData.instagram_business_account?.id) {
        igAccountId = igPageData.instagram_business_account.id
        break
      }
    }

    if (!igAccountId) throw new Error('No Instagram business account found')

    // Guardar en Supabase
    await sb.from('connected_accounts').upsert({
      user_id: userId,
      platform: 'instagram',
      platform_account_id: igAccountId,
      access_token: accessToken,
    }, { onConflict: 'user_id,platform' })

    res.redirect('https://kpsettetter.netlify.app/app.html?connected=instagram')
  } catch (err: any) {
    console.error('Instagram OAuth error:', err)
    res.redirect('https://kpsettetter.netlify.app/app.html?error=instagram_failed')
  }
})

// ── FACEBOOK MESSENGER OAUTH ──
app.get('/oauth/facebook/start', (req, res) => {
  const userId = req.query.user_id as string
  if (!userId) return res.status(400).json({ error: 'user_id required' })

  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: `${BACKEND_URL}/oauth/facebook/callback`,
    scope: 'pages_messaging,pages_show_list,pages_manage_metadata',
    response_type: 'code',
    state: userId
  })

  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`)
})

app.get('/oauth/facebook/callback', async (req, res) => {
  const code = req.query.code as string
  const userId = req.query.state as string

  if (!code || !userId) return res.redirect('https://kpsettetter.netlify.app/app.html?error=oauth_failed')

  try {
    // Intercambiar código por token
    const tokenRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri: `${BACKEND_URL}/oauth/facebook/callback`,
        code
      })
    })
    const tokenData = await tokenRes.json() as any
    const accessToken = tokenData.access_token
    if (!accessToken) throw new Error('No access token received')

    // Obtener páginas del usuario
    const pagesRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`)
    const pagesData = await pagesRes.json() as any

    if (!pagesData.data || pagesData.data.length === 0) throw new Error('No pages found')

    // Usar la primera página (o la que el usuario seleccionó)
    const page = pagesData.data[0]

    // Guardar en Supabase
    await sb.from('connected_accounts').upsert({
      user_id: userId,
      platform: 'facebook',
      platform_account_id: page.id,
      access_token: page.access_token, // token específico de la página
    }, { onConflict: 'user_id,platform' })

    // Suscribir la página al webhook
    await fetch(`https://graph.facebook.com/v19.0/${page.id}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscribed_fields: ['messages', 'messaging_postbacks'],
        access_token: page.access_token
      })
    })

    res.redirect('https://kpsettetter.netlify.app/app.html?connected=facebook')
  } catch (err: any) {
    console.error('Facebook OAuth error:', err)
    res.redirect('https://kpsettetter.netlify.app/app.html?error=facebook_failed')
  }
})

// ── API: Verificar cuentas conectadas ──
app.get('/connected-accounts/:userId', async (req, res) => {
  const { userId } = req.params
  const { data } = await sb.from('connected_accounts')
    .select('platform, platform_account_id, created_at')
    .eq('user_id', userId)
  res.json({ accounts: data || [] })
})

// ── API: Desconectar cuenta ──
app.delete('/connected-accounts/:userId/:platform', async (req, res) => {
  const { userId, platform } = req.params
  await sb.from('connected_accounts').delete()
    .eq('user_id', userId)
    .eq('platform', platform)
  res.json({ ok: true })
})

app.listen(PORT, () => {
  console.log(`KS Setter Backend running on port ${PORT}`)
})

export default app
