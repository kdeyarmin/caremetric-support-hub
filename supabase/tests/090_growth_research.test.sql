begin;
select plan(5);

select ok((select tool_allowlist @> array['web_search', 'web_fetch'] from private.agents where key = 'marketing_manager'), 'The Marketing Manager may use the web tools');
select ok(not (select tool_allowlist && array['web_search', 'web_fetch'] from private.agents where key = 'support_concierge'), 'No other agent was given them');
select is((select value from private.hub_settings where key = 'growth.deep_research'), null::jsonb, 'Research with web search starts off');
select ok(not has_function_privilege('authenticated', 'private.growth_research_next(integer)', 'execute'), 'Only the server hands out prospects to research');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-research.v1', 'The research feature is declared');

select * from finish();
rollback;
