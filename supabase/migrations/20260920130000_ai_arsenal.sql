create table if not exists public.ai_arsenal (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  tool_name text not null,
  model text not null,
  capabilities jsonb not null default '[]'::jsonb,
  input_types jsonb not null default '[]'::jsonb,
  output_types jsonb not null default '[]'::jsonb,
  source_url text,
  documentation_url text,
  pricing jsonb not null default '{}'::jsonb,
  rate_limits jsonb not null default '{}'::jsonb,
  context_window integer,
  vision boolean not null default false,
  audio boolean not null default false,
  tts boolean not null default false,
  stt boolean not null default false,
  embedding boolean not null default false,
  structured_output boolean not null default true,
  latency_ms integer,
  reliability numeric,
  quality_score_internal numeric,
  last_checked timestamptz,
  last_tested timestamptz,
  health_status text not null default 'UNKNOWN',
  availability_status text not null default 'DISCOVERED',
  cooldown_until timestamptz,
  failure_count integer not null default 0,
  success_count integer not null default 0,
  privacy_status text not null default 'NOT_REVIEWED',
  commercial_use_status text not null default 'NOT_REVIEWED',
  active boolean not null default true,
  preferred boolean not null default false,
  fallback_priority integer not null default 50,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, model)
);

create index if not exists idx_ai_arsenal_capabilities on public.ai_arsenal using gin (capabilities);
create index if not exists idx_ai_arsenal_health on public.ai_arsenal (health_status, active, fallback_priority);
alter table public.ai_arsenal enable row level security;

insert into public.ai_arsenal (provider, tool_name, model, capabilities, input_types, output_types, availability_status, health_status, privacy_status, commercial_use_status, active, preferred, fallback_priority)
values
  ('gemini', 'Gemini text/vision', 'configured-by-environment', '["text","vision","reasoning"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', true, true, 10),
  ('openrouter', 'OpenRouter text/vision', 'configured-by-environment', '["text","vision"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', true, false, 30),
  ('groq', 'Groq text/vision', 'configured-by-environment', '["text","vision","reasoning"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', true, false, 40),
  ('mistral', 'Mistral text/vision', 'configured-by-environment', '["text","vision"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', true, false, 50),
  ('openai', 'OpenAI text/vision', 'configured-by-environment', '["text","vision","reasoning","document"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', false, false, 80)
on conflict (provider, model) do nothing;

insert into public.research_queue (topic, title, description, type, reason, priority, source_type, search_queries, status)
values
  ('Discover maintained free vision models for TYK', 'Discover maintained free vision models for TYK', 'Evaluate official model documentation, capability, limits, privacy, and maintenance before production use.', 'AI_DISCOVERY', 'Continuous AI Arsenal maintenance.', 6, 'official_documentation', '["free vision models official documentation","vision model API limits privacy"]', 'queued'),
  ('Check configured AI provider model deprecations and limits', 'Check configured AI provider model deprecations and limits', 'Verify configured provider model names and current limits from official documentation.', 'AI_MODEL_UPDATE', 'Continuous AI Arsenal maintenance.', 7, 'official_documentation', '["AI provider model deprecation official documentation","API model limits"]', 'queued'),
  ('Review AI provider privacy and commercial-use terms', 'Review AI provider privacy and commercial-use terms', 'Review data handling and commercial-use terms before routing company data.', 'AI_SECURITY_REVIEW', 'Continuous AI Arsenal maintenance.', 6, 'official_documentation', '["AI provider privacy terms","AI API commercial use terms"]', 'queued'),
  ('Benchmark structured JSON extraction capability options', 'Benchmark structured JSON extraction capability options', 'Evaluate documented structured-output support before production routing changes.', 'AI_BENCHMARK', 'Continuous AI Arsenal maintenance.', 5, 'official_documentation', '["structured output JSON model official documentation"]', 'queued'),
  ('Check AI provider health and fallback availability', 'Check AI provider health and fallback availability', 'Check configured providers for current availability and fallback readiness.', 'AI_PROVIDER_HEALTH', 'Continuous AI Arsenal maintenance.', 8, 'official_documentation', '["AI provider status official","AI API availability"]', 'queued')
on conflict (topic, entity_id) do nothing;