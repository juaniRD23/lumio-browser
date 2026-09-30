// The only models Lumio offers. Each one supports tools and can see
// screenshots, which the agent needs to operate pages and the Mac.
// Prices come from OpenRouter at runtime when it's reachable.
const MODELS = [
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', short: 'Opus 5.5', maker: 'Anthropic' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', short: 'Sonnet 5.5', maker: 'Anthropic' },
  { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', short: 'Astra 6', maker: 'OpenAI' },
  { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', short: 'Sol 6.1', maker: 'OpenAI' },
  { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', short: 'Sol 5.6', maker: 'OpenAI' },
  { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra', short: 'Terra 5.6', maker: 'OpenAI' },
];
const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

const findModel = (id) => MODELS.find((m) => m.id === id) || null;

module.exports = { MODELS, DEFAULT_MODEL, findModel };
