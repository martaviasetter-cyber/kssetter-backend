-- Tabla para cuentas conectadas de cada usuario
create table if not exists connected_accounts (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  platform text not null, -- 'instagram', 'whatsapp', 'facebook'
  platform_account_id text not null,
  access_token text,
  created_at timestamptz default now(),
  unique(user_id, platform)
);

alter table connected_accounts enable row level security;

create policy "Users manage own connected accounts" on connected_accounts
  for all using (auth.uid() = user_id);

-- Agregar columna para identificar el sender en plataformas externas
alter table leads add column if not exists platform_sender_id text;

-- Índice para búsquedas rápidas por sender
create index if not exists leads_platform_sender_idx on leads(user_id, platform_sender_id);
