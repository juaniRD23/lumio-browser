// Small built-in lists for Lumio's security features. Picked by hand from
// widely used sites and from the trackers found in public filter lists; they
// are lists of domain names, kept short on purpose.
//
//  - BRANDS: sites people sign in to and that attackers copy. Safe Browsing
//    never blocks them from a downloaded list (their pages host other
//    people's content, like docs.google.com), and lookalike protection
//    compares new sites against them.
//  - INFRA: the address and content networks of those sites. Never blocked,
//    and not used for lookalikes (nobody types gstatic.com).
//  - SHARED: hosting services whose subdomains are other people's sites.
//    A listed subdomain is blocked; the service itself never is, even if a
//    downloaded list names it by mistake.
//  - TRACKERS: ad networks and tracking services, blocked when another site
//    embeds them (Settings › Privacy and security › Tracking protection).
//    Social sign-in, payment and error-reporting scripts are left out, so
//    "Sign in with…" buttons, checkouts and sites' own error reports keep
//    working. So is Google Tag Manager: sites load their own features
//    through it too, and the trackers it loads are blocked by their names.
//  - LOOKALIKE_OK: real, popular sites one letter away from a well-known
//    one (found by checking the 10,000 most visited sites).
// Each entry is a registrable domain or a host; it covers its subdomains.

const BRANDS = [
  // search, mail, social
  'google.com', 'youtube.com', 'gmail.com', 'facebook.com', 'instagram.com', 'whatsapp.com', 'messenger.com', 'meta.com', 'threads.net',
  'twitter.com', 'x.com', 'linkedin.com', 'pinterest.com', 'reddit.com', 'tiktok.com', 'snapchat.com', 'discord.com', 'discord.gg', 'telegram.org',
  'twitch.tv', 'quora.com', 'medium.com', 'yahoo.com', 'bing.com', 'duckduckgo.com', 'baidu.com', 'yandex.ru', 'yandex.com', 'dzen.ru',
  'mail.ru', 'vk.com', 'ok.ru', 'qq.com', 'weibo.com', 'naver.com', 'daum.net', 'kakao.com', 'line.me', 'bilibili.com', 'zoom.us', 'skype.com',
  // Microsoft, Apple, Amazon and other big accounts
  'microsoft.com', 'live.com', 'outlook.com', 'office.com', 'office365.com', 'microsoftonline.com', 'msn.com', 'xbox.com', 'windows.com',
  'apple.com', 'icloud.com', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.co.jp',
  'amazon.in', 'amazon.com.br', 'amazon.com.mx', 'amazon.com.au', 'primevideo.com', 'netflix.com', 'spotify.com', 'adobe.com', 'dropbox.com',
  'box.com', 'github.com', 'gitlab.com', 'stackoverflow.com', 'wikipedia.org', 'wikimedia.org', 'mozilla.org', 'archive.org', 'imdb.com',
  'samsung.com', 'roku.com', 'openai.com', 'chatgpt.com', 'anthropic.com', 'claude.ai', 'canva.com', 'figma.com', 'notion.so', 'slack.com',
  'salesforce.com', 'docusign.com', 'docusign.net', 'okta.com', 'zendesk.com', 'shopify.com', 'godaddy.com', 'namecheap.com', 'cloudflare.com',
  // money
  'paypal.com', 'paypal.me', 'venmo.com', 'cash.app', 'stripe.com', 'wise.com', 'revolut.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com',
  'citi.com', 'capitalone.com', 'americanexpress.com', 'discover.com', 'usbank.com', 'pnc.com', 'hsbc.com', 'barclays.co.uk', 'santander.com',
  'coinbase.com', 'binance.com', 'kraken.com', 'crypto.com', 'blockchain.com', 'metamask.io', 'ledger.com', 'trezor.io', 'robinhood.com',
  'fidelity.com', 'schwab.com', 'vanguard.com', 'intuit.com', 'turbotax.com', 'quickbooks.com', 'mercadolibre.com', 'mercadopago.com',
  // shopping, travel, delivery
  'ebay.com', 'etsy.com', 'walmart.com', 'target.com', 'bestbuy.com', 'costco.com', 'homedepot.com', 'aliexpress.com', 'alibaba.com', 'temu.com',
  'shein.com', 'booking.com', 'airbnb.com', 'expedia.com', 'tripadvisor.com', 'uber.com', 'lyft.com', 'doordash.com', 'instacart.com',
  'fedex.com', 'ups.com', 'usps.com', 'dhl.com',
  // games
  'steampowered.com', 'steamcommunity.com', 'epicgames.com', 'roblox.com', 'ea.com', 'playstation.com', 'nintendo.com', 'battle.net', 'blizzard.com', 'riotgames.com',
  // news
  'nytimes.com', 'cnn.com', 'bbc.com', 'bbc.co.uk', 'theguardian.com', 'washingtonpost.com', 'wsj.com', 'forbes.com', 'bloomberg.com', 'reuters.com', 'espn.com', 'weather.com',
  // phone and internet providers, governments
  'att.com', 'verizon.com', 't-mobile.com', 'xfinity.com', 'comcast.net', 'spectrum.net', 'irs.gov', 'ssa.gov', 'gov.uk',
  // Lumio
  'lumio-usa.online', 'lumio.gw607953.workers.dev', 'lumio-browser.gw607953.workers.dev',
];

const INFRA = [
  'gstatic.com', 'googleapis.com', 'googlevideo.com', 'ggpht.com', 'ytimg.com', 'youtu.be', 'goo.gl', 'forms.gle', 'gvt1.com', 'gvt2.com',
  'fbcdn.net', 'facebook.net', 'cdninstagram.com', 'whatsapp.net', 'wa.me', 'twimg.com', 't.co', 'licdn.com', 'redd.it', 'redditmedia.com', 'redditstatic.com',
  'tiktokcdn.com', 'office.net', 'live.net', 'msauth.net', 'msftauth.net', 'aka.ms', 'sfx.ms', 'apple-cloudkit.com', 'icloud-content.com', 'mzstatic.com',
  'cdn-apple.com', 'media-amazon.com', 'ssl-images-amazon.com', 'amazon.dev', 'nflxso.net', 'nflximg.com', 'nflxvideo.net', 'scdn.co', 'paypalobjects.com',
  'githubusercontent.com', 'githubassets.com', 'wikipedia.com', 'bit.ly', 'tinyurl.com', 'linktr.ee', 'cloudflare-dns.com', 'dns.google', 'jsdelivr.net',
];

const SHARED = [
  'googleusercontent.com', 'appspot.com', 'web.app', 'firebaseapp.com', 'blogspot.com', 'sites.google.com', 'github.io', 'pages.dev', 'workers.dev',
  'vercel.app', 'netlify.app', 'herokuapp.com', 'azurewebsites.net', 'windows.net', 'azureedge.net', 'azurefd.net', 'cloudfront.net',
  'amazonaws.com', 'akamaihd.net', 'akamaized.net', 'fastly.net', 'b-cdn.net', 'r2.dev', 'wixsite.com', 'weebly.com', 'weeblysite.com',
  'webflow.io', 'squarespace.com', 'square.site', 'godaddysites.com', 'wordpress.com', 'tumblr.com', 'sharepoint.com', 'duckdns.org',
  'ddns.net', 'ngrok.io', 'ngrok-free.app', 'gitbook.io', 'notion.site', 'glitch.me', 'replit.app', 'surge.sh', 'myshopify.com',
];

const TRACKERS = [
  // advertising
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', '2mdn.net', 'adtrafficquality.google',
  'adnxs.com', 'adsrvr.org', 'criteo.com', 'criteo.net', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com', 'indexww.com',
  'amazon-adsystem.com', 'advertising.com', 'taboola.com', 'outbrain.com', 'revcontent.com', 'mgid.com', 'smartadserver.com', 'adform.net',
  'bidswitch.net', 'sharethrough.com', 'triplelift.com', '3lift.com', '33across.com', 'yieldmo.com', 'teads.tv', 'media.net', 'contextweb.com',
  'spotxchange.com', 'moatads.com', 'adsafeprotected.com', 'doubleverify.com', 'serving-sys.com', 'flashtalking.com', 'zemanta.com',
  'adroll.com', 'lijit.com', 'sovrn.com', 'gumgum.com', 'sonobi.com', 'yieldlab.net', 'adition.com', 'stickyadstv.com', 'emxdgt.com',
  'unrulymedia.com', 'inmobi.com', 'mathtag.com', 'bounceexchange.com', 'ads-twitter.com', 'ads.linkedin.com', 'px.ads.linkedin.com',
  'ads.yahoo.com', 'analytics.yahoo.com', 'ads.pinterest.com', 'ct.pinterest.com', 'tr.snapchat.com', 'sc-static.net', 'bat.bing.com',
  'adservice.microsoft.com', 'ads.tiktok.com', 'analytics.tiktok.com',
  // analytics, session recording, data brokers
  'google-analytics.com', 'analytics.google.com', 'googletagservices.com', 'hotjar.com', 'hotjar.io', 'mixpanel.com',
  'segment.com', 'segment.io', 'amplitude.com', 'heapanalytics.com', 'fullstory.com', 'mouseflow.com', 'crazyegg.com', 'clarity.ms',
  'nr-data.net', 'kissmetrics.com', 'chartbeat.com', 'chartbeat.net', 'parsely.com', 'scorecardresearch.com', 'comscore.com', 'quantserve.com',
  'quantcount.com', 'quantcast.com', 'imrworldwide.com', 'statcounter.com', 'inspectlet.com', 'luckyorange.com', 'smartlook.com',
  'clicktale.net', 'omtrdc.net', '2o7.net', 'demdex.net', 'everesttech.net', 'bluekai.com', 'krxd.net', 'exelator.com', 'rlcdn.com',
  'agkn.com', 'tapad.com', 'crwdcntrl.net', 'liadm.com', 'id5-sync.com', 'hs-analytics.net', 'hsadspixel.net', 'munchkin.marketo.net',
  'snap.licdn.com', 'mc.yandex.ru', 'mc.yandex.com', 'hm.baidu.com', 'top-fwz1.mail.ru', 'counter.yadro.ru', 'app-measurement.com',
  'app-analytics-services.com',
];

const LOOKALIKE_OK = [
  'tiktokv.com', 'tiktokv.us', 'tiktokv.eu', 'tiktokw.us', 'tiktokw.eu', 'mercadolivre.com', 'mercadolivre.com.br',
  'telegra.ph', 'telegraf.rs', 'archives.gov', 'discovery.com', 'paypay.ne.jp', 'yahoo.co.jp',
];

module.exports = { BRANDS, INFRA, SHARED, TRACKERS, LOOKALIKE_OK };
