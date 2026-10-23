'use strict';

const { GATE_CODE, LETTERS_ANSWER } = require('./config');

// A tartalom szerveroldalon él: az "answer", "a" és "hint" mezők csak a szerveren vannak.
// A tipp (hint) csak akkor jut el a játékoshoz, ha kérte (és a büntetés jóváíródott).

// Cápa-kör: sebesség (fok/mp), a zöld sáv szélessége (fok), és a sáv kezdetének sorsolási tartománya.
// 0° = felül, óramutató járása szerint. A sávot a szerver minden próbálkozásnál újra sorsolja,
// így nem lehet egy másik csapattól „3 másodpercnél nyomd" típusú tippet kapni.
const SHARK = { speed: 80, greenWidth: 80, zoneMin: 100, zoneMax: 280 };

// A „régi üzenet" szövege: a {kapcsos zárójelbe} tett betűk lesznek kiemelve.
// A betűk szándékosan összekeverve követik egymást: a csapatnak sorba kell raknia őket (ORÁKULUM).
const OLD_MESSAGE = `Az elsüllyedt jóshely
„A tenger nem felejt. Csak vár.”

A régi krónikák szerint Atlantisz bukásának éjszakáján a főpapok elrejtették a város legféltettebb titkát. A temp{l}o{m} mélyén egy ősi szentély állt, amelynek falai között még az istenek hangja is visszhangzott.

Aki lemerészkedik a fekete vízbe, annak először a tenger áramlataival kell szembenéznie. A romok között különös, kék fények táncolnak, mintha elveszett lelkek keresnék a hazavezető {u}tat.

A szentély bejáratát két kőszobor őrzi. Az egyik kezében utolsó lélegzetét visszatartó harcos kardja, a másikéban egy repedt kristálygömb pihen.

A mélyben egy régi felirat figyelmezteti az érkezőket: nem minden igazság való az élőknek, és nem minden tit{o}k kívánja, hogy napvilágra kerüljön. A falakon végigfutó arany erezet mintha {á}ramló csillagfény lenne, amely egyenesen a templom szívéhez vezet.

A terem közepén egy oltár áll, rajta egy olyan tárgy, amelyet a legenda szerint maga Poszeidón hagyott az emberekre, mielőtt a hullámo{k} elnyelték a várost.

Aki megérinti, annak füle mellett suttogni kezd a víz. A hang egy láthatatlan kapu felé hívja, amely csak a megfelelő jelszó kimondásako{r} nyílik meg.

Az utolsó terem mennyezetén csillagképek rajzolódnak ki. Közöttük egy {u}tolsó jel ragyog, amelyet a főpapok hagytak hátra azoknak, akik elég bátrak a múlt megismeréséhez.

A legenda szerint a megfejtés birtokosa meghallhatja Atlantisz utolsó jóslatát. De vigyázz: a tenger csak annak fedi fel a titkát, aki tudja, mit keres.`;

// {x} jelölések → sima szöveg + a kiemelt karakterek helye ([...text] szerinti indexek)
function markLetters(src) {
  const chars = [...src];
  const out = [];
  const marked = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '{' && chars[i + 2] === '}') {
      marked.push(out.length);
      out.push(chars[i + 1]);
      i += 2;
    } else {
      out.push(chars[i]);
    }
  }
  return { text: out.join(''), marked };
}
const OLD = markLetters(OLD_MESSAGE);

const STAGES = [
  {
    id: 'statue',
    type: 'upload',
    depth: 10,
    title: 'Az élő szobor',
    intro: 'A tengerfenéken görög szobrok őrzik az utat. Csak az jut tovább, aki megelevenedik előttük.',
    instructions: 'Válassz egy szobrot a képek közül, utánozd a pózát, fényképezd le és töltsd fel!',
    // a név a kép alatt látszik, így a csapat meg tudja mondani, melyiket választotta
    references: [
      // F. J. Bosio szobra (Louvre): Héraklész a kígyóvá változott Akhelóosz folyamistennel küzd
      { src: '/assets/images/statues/herakles-es-akheloosz.jpg', name: 'Héraklész és Akhelóosz' },
      { src: '/assets/images/statues/apollon.jpg', name: 'Apollón' },
      { src: '/assets/images/statues/tancolo-nimfak.jpg', name: 'Táncoló nimfák' },
    ],
    hint: 'Nem kell tökéletesnek lennie: a testtartás és a karok helyzete számít. Egy csapattag pózoljon, egy másik fotózzon.',
    successText: 'A kő megmozdul, a víz lejjebb húzza a kaput.',
  },
  {
    id: 'who-is-it',
    type: 'choice',
    depth: 25,
    title: 'Ki látható a képen?',
    intro: 'A hullámok között alak rajzolódik ki. Ismerd fel, kit ábrázol!',
    question: 'Ki látható a képen?',
    image: '/assets/images/szechenyi-feju-poszeidon.jpg',
    imageAlt: 'Széchenyi-fejű Poszeidón',
    options: ['Széchenyi István', 'Poszeidón'],
    // A képen Széchenyi István arcú Poszeidón látható: mindkét válasz helyes
    answer: ['Poszeidón', 'Széchenyi István'],
    hint: 'Nézd meg jól az arcot és a kezében tartott háromágú szigonyt is! Itt nem lehet rosszul választani.',
    successText: 'Mindkettő igaz! Ő a Széchenyi-fejű Poszeidón: a tenger ura az egyetem névadójának arcát viseli.',
  },
  {
    id: 'gods',
    type: 'choice',
    depth: 40,
    title: 'Istenek felismerése',
    intro: 'Egy istenszobor lép ki a homokból. Kiről van szó?',
    question: 'Melyik istent ábrázolja a szobor?',
    image: '/assets/images/hadesz.jpg',
    imageAlt: 'Istenszobor', // a név itt a megoldás lenne
    options: ['Zeusz', 'Poszeidón', 'Hádész', 'Héphaisztosz'],
    answer: 'Hádész', // a lábánál a háromfejű Kerberosz
    hint: 'Figyeld, mit tart a kezében, vagy ki van mellette: villám (Zeusz), háromágú szigony (Poszeidón), háromfejű kutya (Hádész), kalapács (Héphaisztosz).',
    successText: 'Az istenszobor szeme felragyog, és továbbenged.',
  },
  {
    id: 'quiz-poseidon',
    type: 'choice',
    depth: 60,
    title: 'Az elsüllyedt város titka',
    intro: 'A legenda szerint Atlantiszt egyetlen nap és éjszaka alatt nyelte el a tenger, miután az istenek haragja lesújtott rá.',
    question: 'Melyik isten bosszúja süllyesztette el Atlantiszt?',
    options: ['Zeusz', 'Poszeidón', 'Apollón', 'Athéné'],
    // Platón Kritiasza szerint Zeusz hívja össze az isteneket, hogy megbüntesse a gőgössé vált várost.
    // Poszeidón a város alapítója és védőistene volt, nem a büntetője.
    answer: 'Zeusz',
    hint: 'Platón Kritiasz című művében az istenek királya hívja össze a többi istent, hogy döntsön a város büntetéséről. Poszeidón a város védőistene volt.',
    successText: 'Igen! Platón szerint Zeusz, az istenek királya ítélte el a gőgössé vált várost.',
  },
  {
    id: 'quiz-philosopher',
    type: 'choice',
    depth: 80,
    title: 'A legenda írnoka',
    intro: 'Az elveszett város története az ókori bölcsek írásaiban maradt fenn.',
    question: 'Ki írta le Atlantisz legendáját az ókori görög filozófusok közül?',
    options: ['Püthagorasz', 'Thalész', 'Platón'],
    answer: 'Platón',
    hint: 'Szókratész tanítványa volt, és Athénban megalapította az Akadémiát.',
    successText: 'Platón szavai visszhangoznak a mélyben.',
  },
  {
    id: 'shark',
    type: 'shark',
    depth: 100,
    title: 'A cápa köre',
    intro: 'Egy cápa köröz a romok körül, és csak akkor mozdul el, ha elég gyors vagy.',
    instructions: 'Nyomd meg az „Üss!" gombot, amikor a cápa a zöld, csíkos szakaszba ér! A szakasz minden körben máshol van.',
    hint: 'Ne a zöld szakasz legelején nyomd: várd meg, míg a cápa a szakasz közepére ér. Ha a telefonod tud rezegni, belépéskor jelez.',
    successText: 'A cápa a zöld sávban üt, és elúszik. Az út szabad.',
  },
  {
    id: 'sphinx',
    type: 'riddles',
    depth: 120,
    title: 'A szfinx kérdései',
    intro: 'A szfinx három rejtvényt tesz fel. Mindet meg kell fejteni, hogy tovább juthass.',
    riddles: [
      {
        // A klasszikus szfinx-rejtvény (Oidipusz-monda)
        q: 'Mi az, ami reggel négy lábon jár, délben két lábon, este pedig három lábon?',
        a: ['ember', 'az ember', 'emberek', 'az emberek'],
        hint: 'Gondolj egy egész életre: a reggel a csecsemőkor, a dél a felnőttkor, az este az öregkor, amikor a bot a harmadik láb.',
      },
      {
        q: 'Minél több van belőle, annál kevesebbet látsz. Mi az?',
        a: ['sötétség', 'a sötétség', 'sotetseg'],
        hint: 'Itt, a mélyben egyre több van belőle, és a napfény már nem ér el ide.',
      },
      {
        q: 'Van városa, de nincs háza; van hegye, de nincs fája; van vize, de nincs hala. Mi az?',
        a: ['térkép', 'a térkép', 'terkep'],
        hint: 'A kalózok is ezzel indulnak a kincs felé.',
      },
    ],
    successText: 'A szfinx bólint, és elhallgat. A kőkapu moccan.',
  },
  {
    id: 'old-message',
    type: 'letters',
    depth: 140,
    title: 'A régi üzenet',
    intro: 'Az ősi kőtáblán egy üzenet olvasható. Egyes betűk ki vannak emelve.',
    question: 'Gyűjtsd össze a kiemelt betűket, keverd össze őket, és fejtsd meg az ősi jelszót!',
    text: OLD.text,
    marked: OLD.marked,
    // felülírható a LETTERS_ANSWER környezeti változóval
    answer: LETTERS_ANSWER || 'ORÁKULUM',
    hint: 'Nyolc betű, és nincsenek sorrendben. Az üzenet címe is súg: így hívták az ókori jóshelyeket, ahol az istenek üzentek az embereknek (mint Delphoi).',
    successText: 'A szó felolvasása után a tábla megnyílik, és feltárja a kaput.',
  },
  {
    id: 'atlantis-gate',
    type: 'gate',
    depth: 160,
    title: 'Atlantisz kapuja',
    intro: 'A kőkapu zárva áll. A helyszínen elrejtett QR-kód nyitja meg.',
    question:
      'Keressétek meg a helyszínen a QR-kódot, és olvassátok be a telefon kamerájával. Ha a kamera ezt a böngészőt nyitja meg, a kapu magától kinyílik. Ha nem, írjátok be ide a kódot, amit a kapu mutat.',
    answer: GATE_CODE,
    hint: 'A QR-kódot ugyanazzal a telefonnal olvassátok be, amelyen a játék fut. Ha más böngésző nyílik meg, a kapu oldalán kiírt kódot írjátok be ide.',
    successText: 'A kapu feltárul, és a fény Atlantisz felé vezet!',
  },
];

module.exports = { STAGES, SHARK };
