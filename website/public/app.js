// Lumio Browser website: recommend the right download, drive the
// "how it works" sequence, and fade sections in.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // ---- which download fits this computer ----
  const ua = navigator.userAgent;
  const isWin = /Windows/i.test(ua);
  const isMac = /Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua);
  const icons = {
    mac: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16.5 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.9-.8-3.1-.8-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.1 1.2 9.5.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7 0 0-2.4-.9-2.4-4zM14.2 5.8c.6-.8 1.1-1.8 1-2.8-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.7-1 2.7 1 .1 2-.5 2.7-1.3z"/></svg>',
    win: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 5.1l7.4-1v7.2H3zM11.3 3.9L21 2.5v8.8h-9.7zM3 12.2h7.4v7.2L3 18.4zM11.3 12.2H21V21l-9.7-1.4z"/></svg>',
  };
  function recommend(key) {
    const card = $(`.dl[data-os="${key}"]`);
    if (!card) return;
    card.classList.add('recommended');
    const btn = $('#hero-download');
    btn.href = card.href;
    btn.querySelector('.os-icon').innerHTML = key === 'win' ? icons.win : icons.mac;
    $('#hero-download-label').textContent = key === 'win' ? 'Download for Windows' : key === 'mac-intel' ? 'Download for Mac (Intel)' : 'Download for Mac';
    $('#hero-fine').innerHTML = `Free · ${key === 'win' ? 'Windows 10/11, 64-bit' : key === 'mac-intel' ? 'macOS 14+, Intel' : 'macOS 14+, Apple silicon'} · <a href="#download">Other downloads</a>`;
  }
  if (isWin) recommend('win');
  else if (isMac) {
    recommend('mac-arm');
    // Chromium browsers can tell Apple silicon from Intel.
    navigator.userAgentData?.getHighEntropyValues?.(['architecture'])
      .then((v) => { if (v.architecture === 'x86') { $('.dl[data-os="mac-arm"]').classList.remove('recommended'); recommend('mac-intel'); } })
      .catch(() => {});
  }

  // ---- latest version from GitHub ----
  fetch('https://api.github.com/repos/juaniRD23/lumio-browser/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => { if (rel?.tag_name) $('#version').textContent = rel.tag_name.replace(/^v/, ''); })
    .catch(() => {});

  // ---- "how it works": the picture follows the step you're reading ----
  const steps = $$('.step');
  const imgs = $$('.step-img');
  const show = (n) => {
    steps.forEach((s) => s.classList.toggle('on', s.dataset.step === n));
    imgs.forEach((i) => i.classList.toggle('on', i.dataset.step === n));
  };
  const stepObserver = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) show(e.target.dataset.step); });
  }, { rootMargin: '-45% 0px -45% 0px' });
  steps.forEach((s) => stepObserver.observe(s));
  show('0');

  // ---- fade sections in as they scroll into view ----
  const targets = $$('.section-head, .mode, .rules li, .tile, .card, .dl, .install, .oss-inner, .faq-list');
  targets.forEach((el) => el.classList.add('fade'));
  const fader = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      fader.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  targets.forEach((el, i) => { el.style.transitionDelay = `${(i % 3) * 70}ms`; fader.observe(el); });
})();
