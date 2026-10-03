// Site tips the AI saves for itself (main/site-tips.js): a short note on how
// to get things done on a site, given back at the start of the next task there.
const { siteOf } = require('../../site-tips');

const tools = [
  {
    name: 'save_site_tip',
    risk: 'read',
    icon: 'list',
    description: 'Remember a short tip about how to do things on a site, for next time.',
    parameters: { type: 'object', properties: { site: { type: 'string' }, tip: { type: 'string' } }, required: ['site', 'tip'] },
    label: (a) => `Remembering a tip for ${siteOf(String(a.site || '')) || 'this site'}`,
    run(a, ctx) {
      if (!ctx.siteTipsStore) throw new Error('Site tips aren’t kept in this window.');
      const saved = ctx.siteTipsStore.add(a.site, a.tip);
      return { text: `Saved a tip for ${saved.site}.`, summary: saved.site };
    },
  },
];

module.exports = { tools, NAMES: new Set(tools.map((t) => t.name)) };
