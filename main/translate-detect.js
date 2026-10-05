// What language a page is in, from a sample of its text: first by writing
// system (Japanese, Korean, Greek, Arabic…), then, for languages written in
// the Latin alphabet, by their most common short words. Small and local: no
// dictionaries to download, and nothing leaves the computer. A page's
// <html lang> is the fallback, since many sites leave it at "en" whatever
// they're written in.

// Common short words (and letters only one language uses) for each language
// written in the Latin alphabet.
const WORDS = {
  en: 'the and of to in is that for it with as was on are be this by have from or at not but you they which were an has their will would can been more there about what when who we our your',
  es: 'de la que el en y los del se las por un para con no una su al es lo como más pero sus le ya este porque esta entre cuando muy sin sobre también hasta hay donde desde todo nos todos ni otros eso ellos esto qué yo él',
  fr: 'de la le et les des en un du une que est pour qui dans par plus pas au sur ne se ce il sont ou avec son aux mais nous vous leur été cette elle ont je tout sa ses comme aussi très être fait ces même',
  de: 'der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber ich wir',
  it: 'di e il la che è per un in del non una sono le i da si con gli al della lo come ma più anche dei nel alla delle questo ha ci se mi era essere molto cosa sua suo loro quando dove perché ancora',
  pt: 'de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está eu também só pelo pela até isso ela você são',
  nl: 'de en van het een in is dat op te zijn voor met die niet aan er om ook als dan maar bij of uit nog worden door naar kan wordt tot al zo wat hij zij we je ze deze dit was heeft hebben meer over geen ik',
  sv: 'och i att det som en på är av för med till den har de inte om ett han men var jag sig från vi så kan man när hon under också efter eller nu sin där vid mot ska skulle kommer finns vara hade alla andra mycket än här då',
  da: 'og i at det er en til på den af for med de som har ikke der et var om men fra han jeg sig vi kan så efter også eller når skal ved havde hun blev være bliver mange her nu kun dem alle deres hvor hvad mig denne',
  no: 'og i det på som er en til å han av for med at var de ikke den har jeg om et men så seg hun hadde fra vi du kan da ble ut skal vil etter inn når eller nå også hva bare mot være noe blir hvor dette enn meg',
  fi: 'ja on ei se että oli hän mutta kun ole myös sen ovat joka mitä niin kuin tai vain jos nyt hänen sitä jo olla voi kaikki mukaan sekä he me te minä sinä tämä nämä ne siitä jotka vielä koska',
  et: 'ja on ei et see oli kui aga ta ka ning mis nii või siis kes oma seda veel ole nad olla kõik mida pole juba ainult kus selle tema neid sest',
  pl: 'i w nie na się z do że to jest o jak ale po co tak za od przez dla jego czy są już jej tylko który która które oraz tym ich może być był była bardzo także gdy jako ten tego też tej',
  cs: 'a se na v je že s z do to o i pro ve jako by ale jsou k od za po které který která tak jeho jak však byl bylo jen už při také nebo není aby jsem mezi',
  sk: 'a sa na v je že s z do to o aj pre vo ako by ale sú k od za po ktoré ktorý ktorá tak jeho len už pri tiež alebo nie aby som medzi bol bolo môže však',
  ro: 'și de în a la cu care o pe din nu să se un este mai pentru ce sunt au fost ca sau dar prin lui el ei acest această după fi cel cea foarte sale său am',
  hu: 'a az és hogy nem is egy meg de van ez csak már el ki mint volt ha még vagy azt sem után kell lesz minden nagyon ami aki pedig mert amikor lehet között szerint',
  tr: 've bir bu da de için ile olarak çok daha en gibi o ne ama var olan kadar sonra her ki mi değil ise veya şey ben sen biz onlar bunu şu yeni göre ancak tüm aynı oldu olduğu',
  id: 'yang dan di ini itu dengan untuk tidak dari dalam akan pada juga saya ke karena ada bisa oleh mereka kami kita sudah atau seperti lebih harus telah satu hanya tersebut banyak saat bahwa kepada sangat adalah belum masih',
  vi: 'và của là có không được cho một những người các này với trong để đã khi từ cũng như thì đến nhiều về sẽ ra nhưng theo tôi chúng bạn năm rất lại còn nên đó',
  ca: 'de la i el que a en les del per amb un una es no els al com més va o però ha seu són aquest aquesta també ser fer molt quan tot des entre fins',
  hr: 'i je u na se da za su od s a o koji koja koje ne kao iz sa to ali će bi ili sve biti bio bila samo još nakon prema kako što već može ima',
  sl: 'in je v na se da za so z ki pa s tudi ne bi od po kot bo ali pri še iz ga sem smo ste lahko zelo tega kar ker',
  lt: 'ir į kad su yra iš o tai bet kaip buvo jo ne per už apie taip dar nuo tik jau kai dėl ar kuris kuri bus gali savo jų kur',
  lv: 'un ir ar uz no par kas ka lai bet arī vai to tas kā bija pie viņš viņa tik jau nav gan līdz pēc var šo šī tā kur',
  tl: 'ang ng sa na mga at ay ito para hindi si may ko mo niya siya kung din rin pa lang nga kanyang kami tayo',
  sw: 'na ya wa kwa ni za katika la kuwa hiyo hii cha pia lakini kama wake au vya ili sana hata baada',
  af: 'die en van is in het nie te wat op vir met dat word aan sy hy ek ons sal deur ook maar was',
};
const SETS = Object.fromEntries(Object.entries(WORDS).map(([lang, w]) => [lang, new Set(w.split(' '))]));
// Letters (or short endings) that point at one language.
const HINTS = {
  es: /[ñ¿¡]|ción\b/g, pt: /[ãõ]|ção\b|ções\b/g, fr: /[œ]|\b(?:c'|qu'|l'|d')/g, de: /ß/g, pl: /[łąęśźżćń]/g, cs: /[řěů]/g, sk: /[ľĺŕô]/g,
  ro: /[șțşţ]/g, hu: /[őű]/g, tr: /[ğış]/g, vi: /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹơưđ]/g, lt: /[ėįųū]/g, lv: /[āēīķļņģ]/g,
  da: /[æø]/g, no: /[æø]/g, sv: /[åäö]/g, fi: /[äö]/g, et: /[õäöü]/g, ca: /l·l/g,
};

// Writing systems that belong to one language (or one most likely).
const SCRIPTS = [
  ['el', /\p{Script=Greek}/gu], ['he', /\p{Script=Hebrew}/gu], ['th', /\p{Script=Thai}/gu], ['hi', /\p{Script=Devanagari}/gu],
  ['bn', /\p{Script=Bengali}/gu], ['ta', /\p{Script=Tamil}/gu], ['te', /\p{Script=Telugu}/gu], ['gu', /\p{Script=Gujarati}/gu],
  ['kn', /\p{Script=Kannada}/gu], ['ml', /\p{Script=Malayalam}/gu], ['pa', /\p{Script=Gurmukhi}/gu], ['ka', /\p{Script=Georgian}/gu],
  ['hy', /\p{Script=Armenian}/gu], ['am', /\p{Script=Ethiopic}/gu], ['km', /\p{Script=Khmer}/gu], ['lo', /\p{Script=Lao}/gu],
  ['my', /\p{Script=Myanmar}/gu], ['si', /\p{Script=Sinhala}/gu], ['ru', /\p{Script=Cyrillic}/gu], ['ar', /\p{Script=Arabic}/gu],
];
const count = (text, re) => (text.match(re) || []).length;

// Languages that share a writing system, told apart by their own letters.
function cyrillic(text) {
  if (/[ѓќѕ]/.test(text)) return 'mk';
  if (/[ђћ]/.test(text)) return 'sr';
  if (/[ўЎ]/.test(text)) return 'be';
  if (count(text, /[іїєґІЇЄҐ]/g) > 2) return 'uk';
  if (count(text, /[әғқңөұүһ]/g) > 2) return 'kk';
  if (count(text, /ъ/g) > count(text, /[ыэ]/g) + 2) return 'bg';
  return 'ru';
}
function arabic(text) {
  if (count(text, /[ےٹڈڑں]/g) > 2) return 'ur';
  return count(text, /[یکپچژگ]/g) > count(text, /[يك]/g) ? 'fa' : 'ar';
}

// Guesses the language of `text`. reliable is false when there's too little
// text, or two languages score about the same.
function detect(text) {
  const sample = String(text || '').slice(0, 6000);
  const letters = count(sample, /\p{L}/gu);
  if (letters < 20) return { lang: null, reliable: false };
  const kana = count(sample, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const han = count(sample, /\p{Script=Han}/gu);
  const hangul = count(sample, /\p{Script=Hangul}/gu);
  // One CJK character carries about as much as a short word, so a Japanese
  // page with an English menu is still Japanese.
  if (kana >= 10 && kana >= 0.1 * (kana + han)) return { lang: 'ja', reliable: true };
  if (hangul >= 0.15 * letters) return { lang: 'ko', reliable: true };
  if (han >= 0.15 * letters) return { lang: 'zh', reliable: true };
  for (const [lang, re] of SCRIPTS) {
    const n = count(sample, re);
    if (n < 0.4 * letters) continue;
    const reliable = n >= 20;
    if (lang === 'ru') return { lang: cyrillic(sample), reliable };
    if (lang === 'ar') return { lang: arabic(sample), reliable };
    return { lang, reliable };
  }
  // The Latin alphabet: count each language's common words.
  const lower = sample.toLowerCase();
  const words = lower.match(/\p{L}+(?:['’]\p{L}+)?/gu) || [];
  if (words.length < 8) return { lang: null, reliable: false };
  const scores = Object.entries(SETS).map(([lang, set]) => {
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    const hint = HINTS[lang] ? Math.min(count(lower, HINTS[lang]), words.length * 0.2) : 0;
    return [lang, hits + hint * 0.6];
  }).sort((a, b) => b[1] - a[1]);
  const [[lang, top], [, second]] = scores;
  if (!top) return { lang: null, reliable: false };
  const reliable = words.length >= 20 && top >= Math.max(3, words.length * 0.08) && top >= second * 1.25;
  return { lang, reliable };
}

// "pt-BR" -> "pt"; old and alternate codes -> the ones Lumio uses.
const ALIASES = { iw: 'he', in: 'id', ji: 'yi', nb: 'no', nn: 'no', fil: 'tl', mo: 'ro', sh: 'hr', bs: 'hr' };
function baseLang(tag) {
  const base = String(tag || '').trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(base) || base === 'und' || base === 'mul' || base === 'zxx') return null;
  return ALIASES[base] || base;
}

// The page's language: what its text looks like when that's clear, else its
// <html lang> (or Content-Language), else what the text most likely is.
function pageLanguage({ htmlLang, sample } = {}) {
  const declared = baseLang(htmlLang);
  const guess = detect(sample);
  if (guess.reliable) return { lang: guess.lang, reliable: true };
  if (declared) return { lang: declared, reliable: !guess.lang || guess.lang === declared };
  return { lang: guess.lang, reliable: false };
}

module.exports = { detect, pageLanguage, baseLang };
