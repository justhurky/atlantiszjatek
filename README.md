# Atlantisz elveszett városa

Mélységi kalandjáték bulira, telefonra optimalizálva. A csapat a víz felszínéről indul, és feladatonként egyre mélyebbre merül, míg el nem éri Atlantiszt a helyszíni QR-kapunál.

- **Csapatok:** legfeljebb 5 fő csapatonként, közös haladással.
- **Feladatok:** szobor-fotó, választós kérdések, cápa-kör (időzített ütés), a szfinx három rejtvénye, régi üzenet (kiemelt betűk), QR-kapu.
- **Élő háttér:** WebGL-lel rajzolt, animált tenger (fényoszlopok, fodrozódó fényháló, lebegő részecskék, a mélyben arany derengés), ami a mélységgel együtt sötétedik. Procedurális, ezért 4K-n is éles, mégis csak pár kilobájt; legfeljebb 30 képkocka/mp, rejtett lapon áll, lassú gépen magától visszavesz a minőségből. Gyenge eszközön, csökkentett mozgás beállításnál vagy WebGL nélkül az egyszerű CSS-háttér marad.
- **Extrák:** segítség gomb időbüntetéssel, merülés-animáció, kivetíthető ranglista, admin felület, záróképernyő menetidővel és helyezéssel.
- **Üzembiztonság:** a játék állása fájlba mentődik, így a szerver újraindítása után is folytatható.
- **Adatvédelem:** adatkezelési tájékoztató, kötelező hozzájárulás a fotóhoz, a fotók automatikus törlése, és nincs külső szolgáltató (a betűtípus is saját tárhelyről jön).
- **Stack:** Node.js + Express (backend), vanilla JS + CSS (frontend, build-lépés nélkül), Playwright-tesztek.

---

> **Dokumentáció PDF-ben** (a `docs` mappában):
> [Telepítési útmutató](docs/atlantisz-telepitesi-utmutato.pdf) (a szerverre telepítőnek) ·
> [Szervezői kézikönyv](docs/atlantisz-szervezoi-kezikonyv.pdf) (megoldásokkal, csak szervezőknek) ·
> [Tájékoztató a játékosoknak](docs/atlantisz-jatekosoknak.pdf)

## 0. Gyorsindítás – tesztfázis és élesítés

**Próbajáték egy laptopon (ugyanazon a Wi-Fin a telefonokkal):**

1. Dupla kattintás az **`inditas.bat`** fájlra (első alkalommal telepíti a szükséges csomagokat).
2. A fekete ablak kiírja a **játék címét** (a gép Wi-Fi-címét, pl. `http://192.168.1.20:3000`), a **kapukódot** és a **szervezői linket** QR-kóddal. Ha a Windows tűzfal rákérdez, engedélyezd a magánhálózaton.
3. Admin: ugyanazon a gépen **http://localhost:3000/admin**, a többi szervezőnek a szervezői QR-kód.
4. A próba végén az admin felületen: *Beállítások és QR → Tesztfázis vége → Minden csapat és fotó törlése*.

**Élesben: https://eskivk.grafibee.hu** (lásd a 4. pontban a „Saját szerver" részt):

- A `deploy/szerver-beallitasok.txt` fájl kerül a szerveren a projekt mappájába `.env` néven.
- A titkokat (munkamenet-titok, QR-kapu titka, kapukód) és a szervezői kulcsot a szerver az első induláskor generálja a `data` mappába. **A `data` mappa maradjon meg** a frissítések között, különben új kapukód és új szervezői link készül (és a kinyomtatott kapu-QR érvénytelen lesz).
- A szerveren a játék **csak egy példányban** fusson (a csapatok a memóriában vannak).

## 1. Telepítés és indítás

### Előfeltételek

| Mire | Mit kell telepíteni | Ellenőrzés |
| --- | --- | --- |
| Futtatás | Node.js 18 vagy újabb (ajánlott: 22 LTS) | `node -v` |
| Csomagkezelő | npm (a Node.js-szel együtt jön) | `npm -v` |
| Tesztekhez | Chromium a Playwright-tal (lásd 7. pont) | – |

A Node.js-t a https://nodejs.org oldalról töltsd le (LTS verzió).

### Windows (PowerShell)

```powershell
cd D:\atlantiszjatek
npm install
npm start
```

Ha ezt látod, fut a szerver:

```
Atlantisz játék fut: http://localhost:3000
```

Nyisd meg a böngészőben a http://localhost:3000 címet. Az ablakot nyitva kell hagyni, amíg a játékot futtatod. Leállítás: `Ctrl+C` (ilyenkor a szerver még elmenti az állást).

> **Ha a PowerShell nem engedi a scripteket:** futtasd egyszer: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, majd válaszolj `Y`-nal.

### Linux / macOS

```bash
cd atlantisz-jatek
npm install
npm start
```

### Fejlesztői mód (automatikus újraindítással)

```bash
npm run dev
```

---

## 2. Beállítások

**A legegyszerűbb:** a projekt mappájában lévő **`.env`** fájlba írd a beállításokat (soronként `KULCS=érték`, a `#`-tel kezdődő sor megjegyzés). A szerver induláskor beolvassa, így nem kell minden indításnál beírni őket. Sablon: `.env.example`. A terminálban megadott változók elsőbbséget élveznek.

```
BASE_URL=http://192.168.1.20:3000
GAME_END_AT=2026-10-27 22:00
RESULTS_NOTE=Eredményhirdetés 23:00 után, értékes nyereményekkel!
```

Ugyanezek a terminálban is megadhatók:

### Windows (PowerShell), egy munkamenetre

```powershell
$env:BASE_URL="http://192.168.1.20:3000"
$env:GATE_CODE="SAJATKOD"
$env:LETTERS_ANSWER="TITKOS"
npm start
```

### Linux / macOS

```bash
export BASE_URL="http://192.168.1.20:3000"
export LETTERS_ANSWER="TITKOS"
npm start
```

### A játék

| Változó | Alapérték | Mire való |
| --- | --- | --- |
| `PORT` | `3000` | A szerver portja |
| `BASE_URL` | `http://localhost:3000` | A QR-kód ezt a címet használja. Telefonos játékhoz a gép LAN-címe vagy a valódi domain kell |
| `GATE_CODE` | `ATLANTISZ` | A kód, amit a kapu mutat, ha a csapat nem a játék böngészőjével szkennel. **Állíts be sajátot** |
| `GATE_QR_SECRET` | `qr-kapu-2026` | A QR-kódba írt titok. **Élesben kötelező cserélni** |
| `LETTERS_ANSWER` | `ORÁKULUM` | A „régi üzenet" megoldó szava (csak akkor kell, ha más szót szeretnél) |
| `GAME_END_AT` | – | A játék vége, pl. `2026-10-27 22:00`. Utána nem lehet csapatot indítani és válaszolni, a ranglista végleges, a játékosok a „kapu bezárult" képernyőt látják. Fél órával előtte a telefonok figyelmeztetnek |
| `RESULTS_NOTE` | – | A játék végén, a záróképernyőn és a kivetítőn megjelenő megjegyzés, pl. „Eredményhirdetés 23:00 után!" |
| `ADMIN_KEY` | generált | A szervezői link titkos kulcsa (16–128 karakter: betű, szám, `-`, `_`). Ha üres, a szerver első induláskor generál egyet, és a `data/admin-key.txt` fájlba menti |
| `ADMIN_LOCAL` | `1` | A szerver gépéről (`localhost`) az admin felület belépés nélkül megnyílik. `0` = kikapcsolva. `TRUST_PROXY` mellett mindig ki van kapcsolva |
| `ADMIN_SESSION_HOURS` | `24` | Ennyi óráig marad belépve egy szervezői telefon |
| `PUBLIC_BOARD` | bekapcsolva | `0` esetén a kivetíthető ranglista ki van kapcsolva |

### Segítség (tipp)

| Változó | Alapérték | Mire való |
| --- | --- | --- |
| `HINT_AFTER_MS` | 120000 (2 perc) | Ennyi idő után kérhető segítség egy feladatnál |
| `HINT_AFTER_WRONG` | 2 | Vagy ennyi rossz válasz után |
| `HINT_PENALTY_MS` | 120000 (2 perc) | A segítség ára: ennyi hozzáadódik a menetidőhöz |

### Mentés, biztonság, korlátok

| Változó | Alapérték | Mire való |
| --- | --- | --- |
| `SESSION_SECRET` | fejlesztői érték | Munkamenet-titok. **Élesben kötelező cserélni**, és újraindításkor ugyanaz maradjon (különben a telefonok kiesnek) |
| `DATA_FILE` | `data/state.json` | Ide mentődik a játék állása (3 másodpercenként, ha változott) |
| `SAVE_INTERVAL_MS` | 3000 | Mentési gyakoriság |
| `NODE_ENV` | – | `production` esetén kötelező a `SESSION_SECRET` és a `GATE_QR_SECRET` |
| `TRUST_PROXY` | – | `1`, ha a szerver HTTPS-proxy (pl. felhős tárhely) mögött fut. **Máskor ne kapcsold be**, mert hamis fejléccel kijátszható lenne az IP-korlát |
| `MEMBER_IDLE_MS` | 3 óra | Ennyi inaktivitás után a tag helye felszabadul |
| `TEAM_TTL_MS` | 12 óra | Ennyi inaktivitás után a csapat törlődik |
| `RATE_LIMIT_PER_MIN` | 60 | Csatlakozási/létrehozási próbálkozások IP-nként percenként |
| `ANSWER_RATE_PER_MIN` | 30 | Válaszküldések csapatonként percenként |
| `MAX_TEAMS` | 500 | Egyszerre létező csapatok maximális száma |
| `UPLOAD_MAX_MB` | 5 | Egy fotó maximális mérete (a telefon tömörít, egy fotó jellemzően 1 MB alatt van) |
| `UPLOAD_DIR` | `uploads/` | A feltöltött fotók mappája |

### Adatvédelem (a `/adatvedelem` oldalon jelenik meg)

| Változó | Példa | Mire való |
| --- | --- | --- |
| `PRIVACY_CONTROLLER` | `Példa HÖK, 9026 Győr, Egyetem tér 1.` | Az adatkezelő neve és címe |
| `PRIVACY_CONTACT` | `adatvedelem@pelda.hu` | Hová írhatnak a játékosok (pl. törlési kérelemmel) |
| `PRIVACY_DPO` | `Dr. Minta Anna, dpo@pelda.hu` | Az adatvédelmi tisztviselő (ha van) |
| `PRIVACY_HOSTING` | `A szervezők saját laptopja` | Hol fut a szerver (vagy a tárhelyszolgáltató neve) |
| `PRIVACY_EVENT` | `Atlantisz-est 2026` | A rendezvény neve |
| `PRIVACY_UPDATED` | `2026. október 13.` | A tájékoztató dátuma |
| `PHOTO_RETENTION_DAYS` | 30 | Ennyi nap után a fotók automatikusan törlődnek |

Amíg az adatkezelő adatai hiányoznak, a tájékoztató jól láthatóan jelzi a kitöltendő mezőket, és a szerver figyelmeztet indításkor.

---

## 3. Helyszíni ellenőrzőlista (a rendezvény előtt)

A legnagyobb kockázat a **helyszíni Wi-Fi**. Az egyetemi és rendezvényhálózatok (pl. eduroam) gyakran elszigetelik egymástól a csatlakozott eszközöket. Ilyenkor a telefonok nem érik el a laptopot, és a játék el sem indul.

1. **Hálózat:** vagy legyen **saját router vagy hotspot** a helyszínen, vagy fusson a játék a **felhőben** (lásd 4. pont).
2. **Próbakör a helyszínen**, valódi telefonokkal: csapat létrehozása, csatlakozás egy második telefonról, egy fotó feltöltése, a QR-kapu beolvasása.
3. **Tűzfal (laptopos futtatásnál):** Windows első indításkor kérdez, engedélyezd a Node.js-t a privát hálózaton.
4. **Gép IP-címe:** `ipconfig` → az aktív adapter IPv4-címe (pl. `192.168.1.20`). A telefonok ezt nyitják meg: `http://192.168.1.20:3000`.
5. **Titkok és kódok:** saját `SESSION_SECRET`, `GATE_QR_SECRET`, `GATE_CODE`. A szervezői linket csak a szervezők kapják meg.
6. **Tartalom:** a képek, a szövegek és a megfejtések már benne vannak a játékban. A `.env`-ben a `GAME_END_AT` (22:00) és a `RESULTS_NOTE` legyen beállítva.
7. **Adatvédelem:** `PRIVACY_*` mezők kitöltve, és a tájékoztatót az adatvédelmi tisztviselő átnézte (lásd 10. pont).
8. **QR-kód** újragenerálva a végleges `BASE_URL`-lel, és kinyomtatva (lásd 6. pont).
9. **Admin felület** megnyitva a szervező telefonján: a **Beállítások és QR** fül ellenőrzőlistáján minden pont zöld legyen (a képeket kivéve, ha azokat még nem tettétek be). A **ranglista** a kivetítőn.

Egy teljes indítás laptopról, helyi hálózaton:

```powershell
$env:NODE_ENV="production"
$env:BASE_URL="http://192.168.1.20:3000"
$env:SESSION_SECRET="<hosszú véletlen szöveg>"
$env:GATE_QR_SECRET="<hosszú véletlen szöveg>"
$env:GATE_CODE="SAJATKOD"
$env:LETTERS_ANSWER="TITKOS"
$env:PRIVACY_CONTROLLER="..."
$env:PRIVACY_CONTACT="..."
npm run qr
npm start
```

Véletlen titok generálása: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## 4. Futtatás felhőben (ajánlott, ha a helyszíni Wi-Fi bizonytalan)

Felhőben a mobilnetes játékosok is elérik a játékot, a kapcsolat HTTPS-en titkosított, és bekapcsol az offline gyorsítótár is.

### Render vagy Railway (GitHub-repóból)

1. Hozz létre egy új **Web Service**-t a GitHub-repóból.
2. Build parancs: `npm ci --omit=dev`, indító parancs: `npm start`.
3. Környezeti változók: `NODE_ENV=production`, `TRUST_PROXY=1`, `BASE_URL=https://<a-te-címed>`, és az összes titok (lásd 2. pont).
4. **Tartós lemez:** ha a mentést és a fotókat meg akarod tartani a szolgáltatás újraindítása után, csatolj lemezt, és állítsd be: `DATA_FILE=/var/data/state.json`, `UPLOAD_DIR=/var/data/uploads`. Az ingyenes csomagok lemeze többnyire nem tartós.
5. Állapot-ellenőrzés útvonala: `/healthz`.

### Saját szerver: eskivk.grafibee.hu (Linux, nginx)

1. Node.js 18+ telepítése, a projekt feltöltése pl. a `/opt/atlantiszjatek` mappába (a `node_modules`, `data`, `uploads` nélkül), majd ott: `npm ci --omit=dev`.
2. `deploy/szerver-beallitasok.txt` → `/opt/atlantiszjatek/.env`.
3. Automatikus indítás: `deploy/atlantisz.service` (systemd; a fájl elején a parancsok).
4. HTTPS és továbbítás: `deploy/nginx-eskivk.conf` (benne a 6 MB-os feltöltési korlát a fotók miatt). Tanúsítvány: `certbot --nginx -d eskivk.grafibee.hu`.
5. Ellenőrzés: `https://eskivk.grafibee.hu/healthz` → `{"ok":true}`. A szervezői link és a kapukód a naplóban: `journalctl -u atlantisz`.

**cPanel-es tárhelyen** („Setup Node.js App"): Application root a projekt mappája, Application startup file: `src/server.js`, a környezeti változók a `szerver-beallitasok.txt` szerint (vagy a `.env` fájl a mappában). Fontos: egyetlen példány fusson.

### Docker

A repóban van `Dockerfile` (Node 22, nem root felhasználó, beépített állapot-ellenőrzés):

```bash
docker build -t atlantisz .
docker run -p 3000:3000 -e NODE_ENV=production -e SESSION_SECRET=... -e GATE_QR_SECRET=... \
  -v atlantisz-data:/app/data -v atlantisz-uploads:/app/uploads atlantisz
```

> A Dockerfile a szokásos minta szerint készült, de Docker-környezetben nem volt kipróbálva. Az első éles használat előtt futtass vele egy próbát.

---

## 5. Admin felület – minden egy helyen (`/admin`)

Jelszó nincs, mégis csak a szervezők nyithatják meg:

- **A szerver gépén** egyszerűen nyisd meg: `http://localhost:3000/admin`. Itt mindig belépés nélkül megnyílik.
- **A szervezők telefonján:** indításkor a konzol kiírja a **szervezői linket** (`http://<cím>/admin/<titkos kulcs>`) és egy QR-kódot. Ugyanez a QR az admin felület *Beállítások és QR* fülén, a **Szervezői hozzáférés** résznél is megjeleníthető. Egyszer kell megnyitni vagy beolvasni: a telefon utána 24 óráig belépve marad, és a kulcs eltűnik a címsorból.
- **Mindenki más** (a játékosok is) az `/admin` címen csak egy „Nincs ilyen oldal" oldalt lát; az admin fájlok és műveletek sem érhetők el. A kulcs-találgatást percenként 10 próbálkozás után zároljuk.
- **Ha a link rossz kezekbe került:** *Új link, a régi kiléptetése* gomb. Ekkor a régi linkkel belépett telefonok azonnal kiesnek, a többi szervezőnek az új QR-t kell beolvasnia.

Telefonon is használható, 5 másodpercenként frissül.

A felület tetején látszanak az összesítő számok (csapatok, játékosok, célba ért csapatok, fotók). Ha valami még hiányzik a rendezvény előtt, egy figyelmeztető sáv jelzi, és egy kattintással a Beállítások fülre visz.

| Fül | Mit mutat, mit lehet csinálni |
| --- | --- |
| **Csapatok** | Hol tartanak a csapatok (állomásonként), és csapatonként: létszám, aktuális állomás, mióta vannak ott, utolsó aktivitás, felhasznált segítség. Jelzi, ha egy csapat elakadt (10 perce ugyanott) vagy inaktív. Gombok: *Átléptetés*, *Visszaállítás*, *Törlés* (a fotókkal együtt). |
| **Ranglista** | Az élő ranglista (ugyanaz, amit a célba ért csapatok a telefonjukon látnak), menetidővel és büntetéssel. Innen nyitható a kivetítő nézet (`/ranglista`). |
| **Fotók** | Az összes feltöltött fotó csapatonként, a közzétételi hozzájárulás jelölésével („Közzétehető" / „Csak belső"). *Fotók törlése*: egy törlési kérelem azonnal teljesíthető. |
| **Napló** | Élő eseménynapló: csapat létrehozása, csatlakozás, kilépés, megoldott állomás, segítség kérése, fotó feltöltése, QR-kapu szkennelése, célba érés, és minden admin-művelet. |
| **Beállítások és QR** | **Ellenőrzőlista a rendezvény előtt** (beállított állomások, saját titkok, telefonról elérhető QR-cím, kitöltött tájékoztató, a feladatok képei, mentés). Itt van a **szervezői hozzáférés** QR-kódja és linkje is (kérésre jelenik meg, hogy ne lehessen vállon át lefotózni).. **A kapu QR-kódja** megtekinthető és letölthető nyomtatáshoz. Az aktuális beállítások, és linkek a tájékoztatóhoz és a kivetítőhöz. |

Védelem: jelszó (időzítés-független összehasonlítás), percenként 10 hibás próbálkozás után zárolás, új munkamenet-azonosító belépéskor, a módosító kérések csak JSON-ként fogadhatók el.

> Az eseménynapló csak a szerver memóriájában van (a legutóbbi 300 esemény), újraindításkor üresen indul. A csapatok és a haladás viszont mentődnek.

### Kivetíthető ranglista (`/ranglista`)

Nagy betűs, projektorra tervezett oldal, 5 másodpercenként frissül. Csak a csapatnevet, a mélységet és a menetidőt mutatja, a csapatkódot nem. Kikapcsolható: `PUBLIC_BOARD=0`.

---

## 6. QR-kapu (a helyszínre)

**Belépő QR-kód (előre kinyomtatható):** az admin felület *Beállítások és QR* fülén, a *QR-kód a játékhoz* résznél. Van kész **A4-es plakát** (világos, kevés tintás és sötét változat; a böngésző nyomtatás ablakában PDF-be is menthető), és letölthető **SVG** (nyomdába, bármekkorára nagyítható) vagy 2000 px-es PNG formátumban. A QR-kód közepén az **ESK és az IVK közös emblémája** van (a két logó egybeolvasztva, a piros és a zöld szirommal), az alján pedig a két HÖK logója. A logó miatt a kód a legerősebb hibajavítással készül, így ugyanolyan biztosan beolvasható, mint egy sima QR-kód. A kód a `BASE_URL` címre mutat, ezért nyomtatás előtt állítsd be a **végleges** címet (fix IP-cím vagy domain). Ha a cím localhost, a felület figyelmeztet. A kapu QR-kódjához ugyanígy van A4-es plakát.

A QR-kód legegyszerűbben az **admin felület Beállítások és QR fülén** tölthető le. Ott az is látszik, milyen címre mutat. Parancssorból is elkészíthető:

```powershell
$env:BASE_URL="http://192.168.1.20:3000"   # felhőben: a valódi https:// cím
npm run qr                                 # létrejön: public\assets\qr-kapu.png
```

- Ha a csapat **ugyanazzal a böngészővel** olvassa be a QR-kódot, amelyben a játék fut, a kapu **magától kinyílik**, kódot nem kell beírni. Így a kódot más csapatnak sem lehet elárulni.
- Ha a kamera **másik böngészőt** nyit meg, a kapu oldala mutatja a `GATE_CODE`-ot, amit a játékba kell beírni.
- Ha egy csapat **túl korán** szkenneli, a kapu zárva marad, és kódot sem mutat.

A QR-kódot újra kell generálni, amikor a `BASE_URL` vagy a `GATE_QR_SECRET` változik.

---

## 7. Tesztek

```bash
npm test             # minden: egység-, szerver- és böngésző (mobil) teszt
npm run test:server  # csak a gyors szerver- és egység-tesztek
```

Első alkalommal a böngésző-tesztekhez: `npx playwright install chromium`. Saját Chrome-mal is futhat: `$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"`.

A tesztek lefedik többek között: csapat-létszám, párhuzamos és késve érkező válaszok, a sorsolt cápa-sáv határait, mentést és visszatöltést (sérült mentéssel is), segítséget és büntetést, QR-kapu viselkedését, ranglistát, hozzájárulást, automatikus fotótörlést, biztonsági fejléceket, admin jogosultságokat, hálózati hibát, offline betöltést, képtömörítést és a 320 px-es kijelzőt.

A tesztek minden futáskor ideiglenes mappába mentenek és töltenek fel, a projekt `uploads/` és `data/` mappáját nem érintik.

---

## 8. Csapatok, segítség, záróképernyő

- Az első telefon **létrehozza a csapatot**, és kap egy 5 karakteres kódot. A többiek ezzel **csatlakoznak**, legfeljebb 5-en.
- Minden tag ugyanazt a haladást látja (4 másodpercenként frissül). Ha két tag egyszerre válaszol, az első számít, a második a friss állapotot látja.
- **Segítség:** 2 perc vagy 2 rossz válasz után kérhető, és 2 perc büntetéssel jár. Ha egy tag kéri, a többiek is látják, és nem kell újra fizetni érte.
- **Merülés:** állomásváltáskor rövid „lemerülés" animáció mutatja az új mélységet.
- **Cápa-kör:** a zöld sáv minden próbálkozásnál máshol van. A cél-sáv világos és csíkos (színtévesztőknek is látható), és belépéskor a telefon rezeg (ha támogatja).
- **Képernyő:** játék közben a telefon nem alszik el (HTTPS-en vagy `localhost`-on működik).
- **Záróképernyő:** menetidő, helyezés, felhasznált segítség, és a csapat saját pózfotói.
- **Élő ranglista a telefonon:** a célba ért csapat a záróképernyőn követheti a ranglistát. 5 másodpercenként frissül, a saját csapat ki van emelve, és a helyezés is élőben változik, ahogy más csapatok célba érnek. Ez a kivetítő kikapcsolásától (`PUBLIC_BOARD=0`) függetlenül működik, de csak célba érés után érhető el.

---

## 9. Feladatok sorrendje

| Mélység | Feladat | Típus |
| --- | --- | --- |
| 10 m | Az élő szobor (fotó a görög pózról) | `upload` |
| 25 m | Ki látható a képen? (Széchenyi István vagy Poszeidón) | `choice` |
| 40 m | Istenek felismerése | `choice` |
| 60 m | Melyik isten bosszúja süllyesztette el Atlantiszt? (**Zeusz**, Platón Kritiasza szerint) | `choice` |
| 80 m | Ki írta le Atlantisz legendáját? (Platón) | `choice` |
| 100 m | Cápa-kör (időzített ütés a sorsolt zöld sávban) | `shark` |
| 120 m | A szfinx 3 rejtvénye (az első a klasszikus „reggel négy lábon…") | `riddles` |
| 140 m | A régi üzenet (kiemelt betűkből szó) | `letters` |
| 160 m | Atlantisz kapuja (QR-kód) | `gate` |
| 200 m | Megérkezés Atlantiszba | – |

---

## 10. Adatkezelés és GDPR

> **Fontos:** a tájékoztató gondos sablon, de **nem jogi tanács**. A rendezvény előtt ellenőriztessétek az intézmény adatvédelmi tisztviselőjével, különösen a jogalapokat és a megőrzési időt.

### Mit kezel a játék?

| Adat | Hol | Meddig |
| --- | --- | --- |
| Csapatnév, haladás | Memória + mentésfájl (`data/state.json`) | Legfeljebb 12 óra inaktivitásig |
| Munkamenet-süti (véletlen azonosító) | A telefonon; a szerveren memória + mentésfájl | 6 óra |
| **Pózfotók** | `uploads/` | `PHOTO_RETENTION_DAYS` (alapból 30 nap), utána automatikusan törlődnek |
| Feltöltési napló (idő, csapatnév, fájlnév, hozzájárulás) | `uploads/uploads.log` | A fotóval együtt törlődik |
| IP-cím | Csak memória, a próbálkozás-korláthoz | Legfeljebb 1 perc |

Nincs regisztráció, nincs név, e-mail-cím vagy telefonszám, nincs analitika, és nincs külső szolgáltató. A betűtípusok saját tárhelyről jönnek, mert a Google Fonts betöltése a játékosok IP-címét a Google-nek küldené.

### Mit tesz a játék a megfelelésért?

- **Tájékoztató:** `/adatvedelem` (a láblécből és a fotó-feltöltésnél is elérhető), a NAIH elérhetőségével.
- **Kötelező hozzájárulás a fotóhoz:** a feltöltés csak akkor megy át, ha a csapat jelöli, hogy a fotón szereplők hozzájárultak. Ezt a szerver is ellenőrzi.
- **Önkéntes közzétételi hozzájárulás:** külön jelölőnégyzet, az admin felületen látszik.
- **Automatikus törlés** a megőrzési idő után (fájl, napló, csapat-adat).
- **Törlési kérelem:** az admin felületen a *Fotók törlése* gombbal azonnal teljesíthető.
- **Kézi takarítás** a rendezvény után: `npm run clean:uploads`.
- **Hozzáférés:** a fotókat csak a szervezők (szervezői link vagy a szerver gépe) és a saját csapat látja.

---

## 11. A tartalom helye

A feladatok szövege, képei és megoldásai a `src/stages.js` fájlban vannak:

- **Régi üzenet:** az `OLD_MESSAGE` szövegben a `{kapcsos zárójelbe}` tett betűk lesznek kiemelve (félkövér arany). A megoldó szó a stage `answer` mezője (most: ORÁKULUM), vagy a `LETTERS_ANSWER` változó.
- **Képek:** `public/assets/images/` (lásd az ottani README-t). A választós kérdéseknél az `answer` lehet egy lista is (több helyes válasz).

---

## 12. Hibaelhárítás

| Tünet | Ok | Megoldás |
| --- | --- | --- |
| `Cannot find module 'compression'` | Nincs `npm install` | Futtasd: `npm install` |
| `EADDRINUSE` (port foglalt) | Már fut egy szerver | Állítsd le (`Ctrl+C`), vagy: `$env:PORT="3001"` |
| Telefonról nem nyílik meg | Rossz IP, tűzfal, más Wi-Fi, vagy a hálózat elszigeteli az eszközöket | Ellenőrizd az IP-t és a tűzfalat; ha a hálózat elszigetel: saját router vagy felhő (3–4. pont) |
| A QR-kód `localhost`-ra mutat | Nem állítottad be a `BASE_URL`-t | `$env:BASE_URL=...`, majd `npm run qr` |
| Újraindítás után a telefonok kiesnek | Más `SESSION_SECRET`-tel indult újra | Mindig ugyanazzal a titokkal indítsd |
| A tagok kiesnek HTTPS-proxy mögött | A szerver nem tudja, hogy HTTPS-en fut | `TRUST_PROXY=1` |
| A „régi üzenet" állomáson elakadnak | Nem találják ki a szót | Segítség gomb, vagy az admin felületen léptesd át őket |
| Az `/admin` „Nincs ilyen oldal" | Nem a szerver gépén vagy, és nem nyitottad meg a szervezői linket | Nyisd meg a konzolon kiírt szervezői linket, vagy a szerver gépén a `localhost:3000/admin` címet |
| A szervezői telefon kiesett | Valaki új szervezői linket készített, vagy lejárt a 24 óra | Olvasd be újra a szervezői QR-kódot |
| Sérült mentés miatt üresen indult | A `data/state.json` nem volt olvasható | A szerver félretette `state.json.corrupt-...` néven; az ok a konzolon látszik |
| `npm test` böngésző-hibát ad | Nincs Chromium | `npx playwright install chromium` |

---

## Projekt szerkezete

```
atlantisz-jatek/
├── src/
│   ├── server.js        # Express szerver, csapatok, API, admin, kapu, ranglista
│   ├── config.js        # beállítások (környezeti változókból)
│   ├── stages.js        # az állomások tartalma, megoldásai és tippjei
│   ├── persistence.js   # mentés fájlba (csapatok + munkamenetek), atomikus írással
│   ├── pages.js         # szerveroldali oldalak: QR-kapu, adatkezelési tájékoztató
│   └── utils.js         # válasz-ellenőrzés (ékezet-érzéketlen)
├── public/
│   ├── index.html       # a játék (játékosok)
│   ├── admin.html       # admin felület (/admin)
│   ├── ranglista.html   # kivetíthető ranglista (/ranglista)
│   ├── css/             # style.css, admin.css, ranglista.css
│   ├── js/              # app.js, ocean.js (élő háttér), admin.js, ranglista.js
│   ├── fonts/           # saját tárhelyről kiszolgált betűtípusok: Cinzel, Alegreya Sans, Cormorant (SIL OFL 1.1)
│   ├── sw.js            # service worker (offline váz)
│   └── assets/          # képek, QR-kód
├── scripts/
│   ├── make-qr.js       # QR-kód generálása (npm run qr)
│   └── clean-uploads.js # feltöltött fotók törlése (npm run clean:uploads)
├── tests/               # egység-, szerver- és böngésző-tesztek
├── Dockerfile           # konténeres futtatás
├── .env.example         # beállítások sablonja
└── package.json
```

## Licencek

A betűtípusok (Cinzel, Alegreya Sans, Cormorant Garamond) a SIL Open Font License 1.1 alatt állnak, a licencszövegek a `public/fonts/` mappában vannak. A Cinzel a címeké és a mélység-kijelzőé, az Alegreya Sans a felület szövegeié, a Cormorant Garamond a nyitómondaté.
