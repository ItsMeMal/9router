-- Supabase schema for 9Router provider connections and usage logging
-- Run via: supabase db reset or manually execute in Supabase SQL editor

-- Create provider_connections table
create table if not exists public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  auth_type text not null,
  name text,
  email text,
  api_key text,
  cookies jsonb default '{}',
  test_status text default 'inactive',
  last_tested timestamp,
  last_error text,
  last_error_at timestamp,
  rate_limited_until timestamp,
  expires_in integer,
  error_code text,
  consecutive_use_count integer default 0,
  id_token text,
  last_refresh_at timestamp,
  unavailable_until timestamp,
  backoff_level integer default 0,
  priority integer default 999,
  is_active integer default 0,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

-- Create usage_logs table
create table if not exists public.usage_logs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.provider_connections(id) on delete set null,
  provider text not null,
  tokens_used integer default 0,
  model text,
  timestamp timestamp default now()
);

-- Create indexes for performance
create index if not exists idx_provider_connections_provider on public.provider_connections(provider);
create index if not exists idx_provider_connections_auth_type on public.provider_connections(auth_type);
create index if not exists idx_provider_connections_is_active on public.provider_connections(is_active);
create index if not exists idx_usage_logs_connection_id on public.usage_logs(connection_id);
create index if not exists idx_usage_logs_timestamp on public.usage_logs(timestamp);

-- Enable realtime on usage_logs (optional)
alter publication supabase_realtime add table if not exists public.usage_logs;

comment on table public.provider_connections is '9Router provider connections with auth cookies and health state';
comment on table public.usage_logs is '9Router usage tracking and token consumption log';

-- Row-level security (optional - enable if needed)
-- alter table public.provider_connections enable row level security;
-- alter table public.usage_logs enable row level security;