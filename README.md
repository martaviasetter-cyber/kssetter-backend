# KS Setter Backend

Backend que recibe webhooks de Meta (Instagram, WhatsApp, Facebook) y crea leads automáticamente en Supabase usando IA para clasificarlos.

## Despliegue en Railway

### 1. Subir a GitHub
1. Crea un repo en github.com llamado `kssetter-backend`
2. Sube todos estos archivos al repo

### 2. Conectar en Railway
1. Ve a railway.app
2. New Project → Deploy from GitHub repo
3. Selecciona `kssetter-backend`
4. Railway detecta el código y lo despliega automáticamente

### 3. Variables de entorno en Railway
En tu proyecto de Railway → Variables, agrega:

| Variable | Valor |
|----------|-------|
| SUPABASE_URL | https://xhhmdzctqflsqkgdlncb.supabase.co |
| SUPABASE_SERVICE_KEY | (tu service role key de Supabase) |
| ANTHROPIC_KEY | (tu API key de Claude) |
| WEBHOOK_VERIFY_TOKEN | kssetter_webhook_2024 |

### 4. Obtener la URL del backend
Railway te da una URL pública tipo:
`https://kssetter-backend-production.up.railway.app`

Esa URL es la que usas en Meta Developers para configurar los webhooks.

## Endpoints

- `GET /` — Health check
- `GET /webhook/instagram` — Verificación de webhook de Instagram
- `POST /webhook/instagram` — Recibe mensajes de Instagram DM
- `GET /webhook/whatsapp` — Verificación de webhook de WhatsApp
- `POST /webhook/whatsapp` — Recibe mensajes de WhatsApp Business
- `GET /webhook/facebook` — Verificación de webhook de Facebook
- `POST /webhook/facebook` — Recibe mensajes de Facebook Messenger
- `POST /connect/instagram` — Conecta cuenta de Instagram de un usuario
- `POST /connect/whatsapp` — Conecta cuenta de WhatsApp de un usuario

## Flujo automático

1. Usuario recibe DM en Instagram/WhatsApp/Facebook
2. Meta envía el mensaje al webhook del backend
3. Backend identifica a qué usuario de KS Setter pertenece la cuenta
4. IA (Claude) analiza el mensaje y lo clasifica como: new, follow, booked, cold
5. Si es un lead válido, se crea o actualiza en Supabase
6. El setter ve el lead aparecer automáticamente en su app
