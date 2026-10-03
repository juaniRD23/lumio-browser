// Which Lumio this is: the normal app, or Lumio Beta, a separate app (own
// name, icon, profile and update channel) for trying new versions first.
// `node build/package.mjs --beta` puts flavor.json in the beta build.
const fs = require('fs');
const path = require('path');

let beta = process.env.LUMIO_FLAVOR === 'beta'; // tests
try { beta = beta || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flavor.json'), 'utf8')).beta === true; } catch { /* the normal app */ }

module.exports = beta
  ? { beta: true, name: 'Lumio Beta', bundleId: 'online.lumio-usa.browser.beta', assetPrefix: 'Lumio-Beta' }
  : { beta: false, name: 'Lumio Browser', bundleId: 'online.lumio-usa.browser', assetPrefix: 'Lumio-Browser' };
