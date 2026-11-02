// A manual check of the model runtime against the real Anthropic API: one synthetic call that costs a fraction of a cent.
// It is not part of CI (CI never has a key and never reaches Anthropic). Run it once after setting ANTHROPIC_API_KEY on a
// machine of your own, to see that the key works and that the model behind a tier answers with the structured format:
//
//   HUB_RUNTIME_SMOKE=one-synthetic-call ANTHROPIC_API_KEY=sk-ant-... node server/agents-runtime-smoke.mjs [fast|draft|quality]
//
// It uses an in-memory stand-in for the database (a five cent budget, no ledger), sends only an invented sentence, and prints
// the outcome, the token counts, the cost and the provider's request id. It never prints the answer text or the key.
import { aiModels } from './ai-assistance.mjs';
import { modelRuntime } from './agents/runtime/index.mjs';

const tier = process.argv[2] ?? 'fast';
if (process.env.HUB_RUNTIME_SMOKE !== 'one-synthetic-call') {
  console.error('Set HUB_RUNTIME_SMOKE=one-synthetic-call to spend a fraction of a cent on one real call.');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY.');
  process.exit(2);
}
if (!Object.hasOwn(aiModels, tier)) {
  console.error(`The tier must be one of ${Object.keys(aiModels).join(', ')}.`);
  process.exit(2);
}

const closed = [];
const store = {
  budget: async () => ({ remainingCents: 5 }),
  startRun: async () => 'smoke-run',
  finishRun: async (_id, outcome, usage, summary, errorCode) => { closed.push({ outcome, usage, summary, errorCode }); },
};
const model = modelRuntime({ apiKey: process.env.ANTHROPIC_API_KEY, store, log: line => console.log(line) });

try {
  const result = await model.run(
    { id: 'smoke', agentKey: 'smoke_test', kind: 'smoke.check', agent: { modelTier: tier } },
    {
      promptVersion: 'smoke.1', maxTokens: 600, effort: 'low',
      system: [{ text: 'You label the tone of one short invented sentence. Answer with the JSON object the format describes.' }],
      user: 'Invented sentence for a smoke test: "The weekly roster export finished without any errors."',
      schema: { type: 'object', additionalProperties: false, required: ['tone'], properties: { tone: { type: 'string', enum: ['positive', 'neutral', 'negative'] } } },
      describe: output => `Tone ${output.tone}.`,
    },
  );
  console.log(JSON.stringify({ tier, model: result.model, outcome: result.outcome, tone: result.output?.tone ?? null, usage: result.usage, costCents: result.costCents, requestId: result.requestId }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ tier, failed: error.code ?? 'unknown', transient: error.transient === true, status: error.status ?? null, run: closed.at(-1) ?? null }, null, 2));
  process.exitCode = 1;
}
