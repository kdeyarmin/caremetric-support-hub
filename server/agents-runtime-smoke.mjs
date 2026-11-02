// A manual check of the model runtime against the real Anthropic API: one synthetic call that costs a fraction of a cent.
// It is not part of CI (CI never has a key and never reaches Anthropic). Run it once after setting ANTHROPIC_API_KEY on a
// machine of your own, to see that the key works and that the model behind a tier answers with the structured format:
//
//   HUB_RUNTIME_SMOKE=one-synthetic-call ANTHROPIC_API_KEY=sk-ant-... node server/agents-runtime-smoke.mjs [fast|draft|quality] [basic|concierge]
//
// "basic" (the default) labels the tone of one invented sentence. "concierge" sends the Support Concierge's real prompt and format with an
// invented question and one invented guide, then runs the answer through the same checks a real draft goes through, so you can see how the
// model behaves with the prompt before you switch drafted answers on. Both cost a cent or two at most.
//
// It uses an in-memory stand-in for the database (a five cent budget, no ledger), sends only invented text, and prints the outcome,
// the token counts, the cost and the provider's request id. In concierge mode it also prints the model's draft, which answers the
// invented question and nothing real. It never prints the key.
import { aiModels } from './ai-assistance.mjs';
import { modelRuntime } from './agents/runtime/index.mjs';
import { checkDraft } from './agents/concierge/draft.mjs';
import { buildUserMessage, promptVersion, responseSchema, systemPrompt } from './agents/concierge/prompt.mjs';
import { redact } from './agents/concierge/redact.mjs';

const tier = process.argv[2] ?? 'fast';
const mode = process.argv[3] ?? 'basic';
if (process.env.HUB_RUNTIME_SMOKE !== 'one-synthetic-call') {
  console.error('Set HUB_RUNTIME_SMOKE=one-synthetic-call to spend a fraction of a cent on one real call.');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY.');
  process.exit(2);
}
if (!Object.hasOwn(aiModels, tier) || !['basic', 'concierge'].includes(mode)) {
  console.error(`The tier must be one of ${Object.keys(aiModels).join(', ')}, and the mode basic or concierge.`);
  process.exit(2);
}

const closed = [];
const store = {
  budget: async () => ({ remainingCents: 5 }),
  startRun: async () => 'smoke-run',
  finishRun: async (_id, outcome, usage, summary, errorCode) => { closed.push({ outcome, usage, summary, errorCode }); },
};
const model = modelRuntime({ apiKey: process.env.ANTHROPIC_API_KEY, store, log: line => console.log(line) });

const task = { id: 'smoke', agentKey: 'smoke_test', kind: 'smoke.check', agent: { modelTier: tier } };
const basic = {
  promptVersion: 'smoke.1', maxTokens: 600, effort: 'low',
  system: [{ text: 'You label the tone of one short invented sentence. Answer with the JSON object the format describes.' }],
  user: 'Invented sentence for a smoke test: "The weekly roster export finished without any errors."',
  schema: { type: 'object', additionalProperties: false, required: ['tone'], properties: { tone: { type: 'string', enum: ['positive', 'neutral', 'negative'] } } },
  describe: output => `Tone ${output.tone}.`,
};
// An invented question, with an invented guide, through the Concierge's own prompt, format and scrubbing.
const guides = [{ title: 'Export the staff roster', summary: 'Download a roster for any month.', body: 'Open Reports, choose Staff roster, pick a month and select Export. The file is a CSV.' }];
const question = redact('How do I export the staff roster for last month? You can reach me at pat@example.test or 555-010-0142.');
const concierge = {
  promptVersion, system: [{ text: systemPrompt, cache: true }], schema: responseSchema, effort: 'medium', maxTokens: 4000,
  user: buildUserMessage({ channel: 'email', productSlug: 'carebase', inboundCount: 1, text: question.text, guides }),
  describe: output => `Read: ${output.category}, ${output.urgency}.`,
};

try {
  const result = await model.run(task, mode === 'concierge' ? concierge : basic);
  const shown = { tier, mode, model: result.model, outcome: result.outcome, usage: result.usage, costCents: result.costCents, requestId: result.requestId };
  if (mode === 'concierge') {
    const reading = result.output;
    const checked = checkDraft({ reply: reading.reply, citations: reading.citations, guides, text: question.text, route: 'email' });
    console.log(JSON.stringify({ ...shown, reading: { ...reading, reply: undefined }, draft: reading.reply, checks: checked.ok ? 'passed' : `failed: ${checked.reason}` }, null, 2));
  } else {
    console.log(JSON.stringify({ ...shown, tone: result.output?.tone ?? null }, null, 2));
  }
} catch (error) {
  console.log(JSON.stringify({ tier, mode, failed: error.code ?? 'unknown', transient: error.transient === true, status: error.status ?? null, run: closed.at(-1) ?? null }, null, 2));
  process.exitCode = 1;
}
