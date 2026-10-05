// Page language detection (main/translate-detect.js): writing systems, common
// words for Latin-alphabet languages, and <html lang> as the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detect, pageLanguage, baseLang } = require('../main/translate-detect.js');

const SAMPLES = {
  en: 'The town council met on Tuesday to discuss the new park. Most of the people who came were happy with the plan, but some of them asked about parking and noise at night.',
  es: 'El ayuntamiento se reunió el martes para hablar del nuevo parque. La mayoría de los vecinos que vinieron estaban contentos con el plan, pero algunos preguntaron por el aparcamiento y el ruido por la noche.',
  fr: 'Le conseil municipal s’est réuni mardi pour parler du nouveau parc. La plupart des habitants qui sont venus étaient contents du projet, mais certains ont posé des questions sur le stationnement et le bruit la nuit.',
  de: 'Der Stadtrat hat sich am Dienstag getroffen, um über den neuen Park zu sprechen. Die meisten Leute, die gekommen sind, waren mit dem Plan zufrieden, aber einige haben nach Parkplätzen und dem Lärm in der Nacht gefragt.',
  it: 'Il consiglio comunale si è riunito martedì per parlare del nuovo parco. La maggior parte delle persone che sono venute era contenta del progetto, ma alcune hanno chiesto del parcheggio e del rumore di notte.',
  pt: 'A câmara municipal reuniu-se na terça-feira para falar do novo parque. A maioria das pessoas que vieram estava contente com o plano, mas algumas perguntaram sobre o estacionamento e o barulho à noite.',
  nl: 'De gemeenteraad kwam dinsdag bij elkaar om over het nieuwe park te praten. De meeste mensen die er waren, waren blij met het plan, maar sommigen vroegen naar parkeren en het lawaai in de nacht.',
  sv: 'Kommunfullmäktige träffades på tisdagen för att prata om den nya parken. De flesta som kom var nöjda med planen, men några frågade om parkering och om det blir mycket ljud på natten.',
  pl: 'Rada miasta zebrała się we wtorek, aby porozmawiać o nowym parku. Większość osób, które przyszły, była zadowolona z planu, ale niektóre pytały o parkowanie i hałas w nocy.',
  tr: 'Belediye meclisi yeni park için salı günü toplandı. Gelenlerin çoğu plandan memnundu, ama bazıları otopark ve gece gürültüsü için soru sordu. Bu konu daha sonra yine konuşulacak.',
  vi: 'Hội đồng thành phố đã họp vào thứ Ba để nói về công viên mới. Hầu hết những người đến đều hài lòng với kế hoạch, nhưng một số người hỏi về chỗ đậu xe và tiếng ồn vào ban đêm.',
  ru: 'Городской совет собрался во вторник, чтобы обсудить новый парк. Большинство пришедших были довольны планом, но некоторые спросили о парковке и шуме ночью.',
  uk: 'Міська рада зібралася у вівторок, щоб обговорити новий парк. Більшість людей, які прийшли, були задоволені планом, але дехто питав про паркування і шум уночі.',
  ja: '市議会は火曜日に新しい公園について話し合いました。来た人のほとんどは計画に満足していましたが、駐車場や夜の騒音について質問する人もいました。',
  zh: '市议会星期二开会讨论新公园。来的大多数人对这个计划很满意，但也有人问到停车和夜间噪音的问题。',
  ko: '시의회는 화요일에 새 공원에 대해 논의했습니다. 온 사람들 대부분은 계획에 만족했지만, 일부는 주차와 밤의 소음에 대해 물었습니다.',
  ar: 'اجتمع مجلس المدينة يوم الثلاثاء لمناقشة الحديقة الجديدة. كان معظم الحاضرين راضين عن الخطة، لكن بعضهم سأل عن مواقف السيارات والضوضاء في الليل.',
  fa: 'شورای شهر روز سه‌شنبه برای گفتگو درباره پارک جدید جلسه گذاشت. بیشتر کسانی که آمدند از طرح راضی بودند، اما چند نفر درباره پارکینگ و سر و صدای شب پرسیدند.',
  el: 'Το δημοτικό συμβούλιο συναντήθηκε την Τρίτη για να συζητήσει το νέο πάρκο. Οι περισσότεροι που ήρθαν ήταν ικανοποιημένοι με το σχέδιο.',
  he: 'מועצת העיר נפגשה ביום שלישי כדי לדון בפארק החדש. רוב האנשים שהגיעו היו מרוצים מהתוכנית, אבל חלקם שאלו על חניה ועל רעש בלילה.',
  hi: 'नगर परिषद ने मंगलवार को नए पार्क पर चर्चा करने के लिए बैठक की। आए हुए अधिकतर लोग योजना से खुश थे, लेकिन कुछ ने पार्किंग और रात के शोर के बारे में पूछा।',
};

test('detects languages by writing system and by their common words', () => {
  const wrong = [];
  for (const [lang, text] of Object.entries(SAMPLES)) {
    const got = detect(text);
    if (got.lang !== lang || !got.reliable) wrong.push(`${lang}: got ${got.lang} (${got.reliable ? 'reliable' : 'unsure'})`);
  }
  assert.deepEqual(wrong, []);
});

test('a little text, or a mix, is unsure; a Japanese page with an English menu is still Japanese', () => {
  assert.deepEqual(detect('Home'), { lang: null, reliable: false });
  assert.equal(detect('OK Cancel Save').reliable, false);
  assert.equal(detect(`Home News Sports Weather Sign in ${SAMPLES.ja}`).lang, 'ja');
});

test('the page’s text wins over a wrong <html lang>; <html lang> covers pages with little text', () => {
  assert.deepEqual(pageLanguage({ htmlLang: 'en', sample: SAMPLES.es }), { lang: 'es', reliable: true });
  assert.deepEqual(pageLanguage({ htmlLang: 'de-AT', sample: 'Login' }), { lang: 'de', reliable: true });
  assert.deepEqual(pageLanguage({ htmlLang: '', sample: 'Login' }), { lang: null, reliable: false });
  assert.equal(baseLang('pt-BR'), 'pt');
  assert.equal(baseLang('iw'), 'he');
  assert.equal(baseLang('nb-NO'), 'no');
  assert.equal(baseLang('x-default'), null);
  assert.equal(baseLang('und'), null);
});
