// The models Lumio offers (all through OpenRouter). Lumio Browser runs one
// inexpensive model that can use tools and read screenshots; web Chat lets
// people choose, with the bigger models on paid plans. Everything is charged
// to the same allowance at the model's real cost, so a cheaper model simply
// goes further.
import { type Plan, planOrder } from './agent.ts';

export type Model = {
  id: string;
  name: string;
  maker: string;
  blurb: string;
  // OpenRouter list price, USD per million tokens (input, output).
  price: { input: number; output: number };
  // The most a provider may charge (so a second provider can take over when
  // the cheapest one is down). Defaults to 1.5x the list price.
  maxPrice?: { input: number; output: number };
  minimumPlan: Plan;
  browser?: boolean; // offered to Lumio Browser
};

export const MODELS: Model[] = [
  // Lumio Browser's model: in our tests on real pages (forms, shopping, canvas
  // clicks, a desktop screenshot) it matched GPT-6 Luna at about a third of the
  // cost per task. maxPrice lets DeepInfra serve it when Novita is down.
  { id: 'inclusionai/ling-3.0-flash-vl', name: 'Ling 3.0 Flash', maker: 'inclusionAI', blurb: 'Fast and light. Goes the furthest on your plan.', price: { input: 0.021, output: 0.062 }, maxPrice: { input: 0.06, output: 0.18 }, minimumPlan: 'free', browser: true },
  { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', maker: 'OpenAI', blurb: 'OpenAI’s fast everyday model.', price: { input: 0.1, output: 0.5 }, minimumPlan: 'free' },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', maker: 'DeepSeek', blurb: 'Quick answers, good at code.', price: { input: 0.02, output: 0.4 }, maxPrice: { input: 0.15, output: 0.6 }, minimumPlan: 'free' },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', maker: 'Google', blurb: 'Smart and quick, with a huge memory.', price: { input: 0.75, output: 3.75 }, minimumPlan: 'plus' },
  { id: 'x-ai/grok-4.7', name: 'Grok 4.7', maker: 'xAI', blurb: 'Sharp reasoning, direct answers.', price: { input: 2, output: 6 }, minimumPlan: 'plus' },
  { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', maker: 'OpenAI', blurb: 'OpenAI’s flagship for hard problems.', price: { input: 2, output: 10 }, minimumPlan: 'plus' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', maker: 'Anthropic', blurb: 'Great writing and careful thinking.', price: { input: 2, output: 10 }, minimumPlan: 'plus' },
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', maker: 'Anthropic', blurb: 'Anthropic’s most capable model.', price: { input: 4, output: 20 }, minimumPlan: 'pro' },
  { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', maker: 'OpenAI', blurb: 'The biggest model. Uses your plan quickly.', price: { input: 10, output: 50 }, minimumPlan: 'pro' },
];

export const CHAT_DEFAULT = 'inclusionai/ling-3.0-flash-vl';
export const BROWSER_DEFAULT = 'inclusionai/ling-3.0-flash-vl';

export const findModel = (id: unknown) => MODELS.find((m) => m.id === id) || null;
export const browserModels = () => MODELS.filter((m) => m.browser);
export const canUse = (plan: Plan, m: Model) => planOrder.indexOf(plan) >= planOrder.indexOf(m.minimumPlan);

// Providers on OpenRouter charge a little differently, so allow up to 1.5x the
// list price (or the model's maxPrice); holds on the allowance use the same
// ceiling (microUSD per token).
export const ceiling = (m: Model) => (m.maxPrice
  ? { prompt: m.maxPrice.input, completion: m.maxPrice.output }
  : { prompt: m.price.input * 1.5, completion: m.price.output * 1.5 });

// 1-4: how quickly the model uses an allowance, for the model picker.
export function costTier(m: Model) {
  const blended = (m.price.input * 3 + m.price.output) / 4;
  return blended < 0.15 ? 1 : blended < 1.5 ? 2 : blended < 5 ? 3 : 4;
}

export const publicModel = (m: Model, plan: Plan) => ({
  id: m.id, name: m.name, maker: m.maker, blurb: m.blurb, minimumPlan: m.minimumPlan, cost: costTier(m), available: canUse(plan, m),
});
