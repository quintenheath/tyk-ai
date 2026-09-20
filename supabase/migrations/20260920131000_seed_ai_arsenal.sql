insert into public.ai_arsenal (provider, tool_name, model, capabilities, input_types, output_types, availability_status, health_status, privacy_status, commercial_use_status, active, preferred, fallback_priority)
values
  ('gemini', 'Gemini text/vision', 'configured-by-environment', '["text","vision","reasoning"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', true, true, 10),
  ('openrouter', 'OpenRouter text/vision', 'configured-by-environment', '["text","vision"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', true, false, 30),
  ('groq', 'Groq text/vision', 'configured-by-environment', '["text","vision","reasoning"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', true, false, 40),
  ('mistral', 'Mistral text/vision', 'configured-by-environment', '["text","vision"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', true, false, 50),
  ('openai', 'OpenAI text/vision', 'configured-by-environment', '["text","vision","reasoning","document"]', '["text","image"]', '["text","structured_json"]', 'DISCOVERED', 'UNKNOWN', 'NOT_REVIEWED', 'NOT_REVIEWED', false, false, 80)
on conflict (provider, model) do nothing;

insert into public.research_queue (topic, title, description, type, reason, priority, source_type, search_queries, status)
select v.topic, v.title, v.description, v.type, v.reason, v.priority, v.source_type, v.search_queries::jsonb, v.status
from (values
  ('Discover maintained free vision models for TYK', 'Discover maintained free vision models for TYK', 'Evaluate official model documentation, capability, limits, privacy, and maintenance before production use.', 'RESEARCH', 'Continuous AI Arsenal maintenance.', 6, 'other', '["free vision models official documentation","vision model API limits privacy"]', 'queued'),
  ('Check configured AI provider model deprecations and limits', 'Check configured AI provider model deprecations and limits', 'Verify configured provider model names and current limits from official documentation.', 'RESEARCH', 'Continuous AI Arsenal maintenance.', 7, 'other', '["AI provider model deprecation official documentation","API model limits"]', 'queued'),
  ('Review AI provider privacy and commercial-use terms', 'Review AI provider privacy and commercial-use terms', 'Review data handling and commercial-use terms before routing company data.', 'RESEARCH', 'Continuous AI Arsenal maintenance.', 6, 'other', '["AI provider privacy terms","AI API commercial use terms"]', 'queued'),
  ('Benchmark structured JSON extraction capability options', 'Benchmark structured JSON extraction capability options', 'Evaluate documented structured-output support before production routing changes.', 'RESEARCH', 'Continuous AI Arsenal maintenance.', 5, 'other', '["structured output JSON model official documentation"]', 'queued'),
  ('Check AI provider health and fallback availability', 'Check AI provider health and fallback availability', 'Check configured providers for current availability and fallback readiness.', 'RESEARCH', 'Continuous AI Arsenal maintenance.', 8, 'other', '["AI provider status official","AI API availability"]', 'queued')
) as v(topic, title, description, type, reason, priority, source_type, search_queries, status)
where not exists (select 1 from public.research_queue existing where existing.topic = v.topic);