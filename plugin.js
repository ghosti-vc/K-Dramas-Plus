// Plugin de Kino: Doramas en audio latino (búsqueda unificada + Inicio).
// Fuentes:
//  - "dm|" Doramed Play (www.doramedplay.com): inicio, búsqueda, episodios y reproducción (MP4 directo).
//  - "dx|" Dorama Express (doramaexpress.com): búsqueda y episodios; su video está detrás de
//    candados del sitio (temporizador, VIP) que el plugin no salta: al reproducir avisa.
//  - "df|" DoramasFox (doramafox.es): inicio, búsqueda, episodios y reproducción. Sus capítulos
//    se abren en reproductores embebidos (Abyss, Playmogo, P2PPlay): se capturan con el navegador
//    oculto de Kino (kino.browser.capture).
// Pendiente: "pn|" Pandrama (bloquea el acceso automatizado).

const DM = "https://www.doramedplay.com";
const DX = "https://doramaexpress.com";
const DF = "https://doramafox.es";
const MAX_RESULTS = 100;
const HOME_ROW = 20;   // títulos por fila en Inicio
const CAT_VIEW = 60;   // títulos que carga cada tanda de "Ver más" y de Categorías
const CAT_MAX = 100;   // tope de Kino por página
// Orden de las filas del Inicio (por id). Lo que no esté aquí va al final.
const HOME_ORDER = ["df-emision", "dm-doramas", "dm-destacados", "df-doramas", "df-peliculas", "dm-peliculas"];

function log(...args) {
  try { kino.log(...args); } catch { /* el registro no debe romper nada */ }
}

// Textos que lee la persona: español por defecto, inglés si kino.lang es "en-US".
function tr(es, en) {
  return (typeof kino !== "undefined" && kino.lang === "en-US") ? en : es;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

function squash(text) {
  let x = stripTags(text).toLowerCase();
  // normalize puede no existir en el motor del plugin: sin él, solo se quitan los símbolos.
  if (typeof x.normalize === "function") x = x.normalize("NFKD");
  return x.replace(/[^a-z0-9]/g, "");
}

// Nunca lanza antes del primer await (los Kino viejos abortan la llamada si lo hace).
async function getHtml(url) {
  const host = String(url).replace(/^https?:\/\//, "").split("/")[0];
  let r;
  try {
    r = await kino.fetch(url);
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 80);
    log("fetch falló host=" + host + " motivo=" + why);
    throw kino.error("unavailable", "fetch falló en " + host, {
      userMessage: tr("No se pudo abrir el sitio. Prueba de nuevo en un rato.", "Could not open the site. Try again in a while."),
    });
  }
  log("fetch status=" + r.status + " ok=" + r.ok);
  if (!r.ok) {
    const um = {
      userMessage: tr(
        "El sitio respondió con el error " + r.status + ". Prueba de nuevo en un rato.",
        "The site answered with error " + r.status + ". Try again in a while."
      ),
    };
    if (r.status === 404) throw kino.error("not_found", "el sitio respondió 404", um);
    if (r.status === 429) throw kino.error("rate_limited", "el sitio respondió 429", um);
    throw kino.error("unavailable", "el sitio respondió " + r.status, um);
  }
  return r.text();
}

// ---- Inicio -----------------------------------------------------------------------------------

// Quita el sufijo de tamaño (-185x278) para pedir la imagen original.
function bigPoster(src) {
  return src ? src.replace(/-\d+x\d+\.(jpg|jpeg|png|webp)$/i, ".$1") : undefined;
}

// Lee las tarjetas <article class="item ..."> de un trozo de HTML de Doramed Play (tema Dooplay).
// Categorías de Kino para cada título (ids de la lista oficial).
function withGenres(item) {
  item.genres = item.kind === "movie" ? ["peliculas", "drama"] : ["series", "drama"];
  return item;
}

function dmCards(chunk) {
  const items = [];
  const seen = new Set();
  for (const b of String(chunk || "").split("<article").slice(1)) {
    const a = /<a href="(https:\/\/www\.doramedplay\.com\/(tvshows|movies)\/[^"]+)"/.exec(b);
    if (!a || seen.has(a[1])) continue;
    const img = /<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/.exec(b);
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(b);
    const title = stripTags(h3 ? h3[1] : (img ? img[2] : ""));
    if (!title) continue;
    seen.add(a[1]);
    const yearMatch = /<span>[^<]*?(\d{4})[^<]*<\/span>/.exec(b);
    // La nota que muestra el sitio (0 a 10); si no se encuentra o es 0, no se manda.
    const ratingMatch = /class="rating"[^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*</.exec(b);
    const rating = ratingMatch ? Number(ratingMatch[1]) : 0;
    const clean = a[1].replace(/^https:\/\/www\.doramedplay\.com\//, "/");
    items.push(withGenres({
      id: "dm-" + clean.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80),
      ref: "dm|" + a[1],
      title: title.slice(0, 200),
      kind: a[2] === "movies" ? "movie" : "series",
      year: yearMatch ? Number(yearMatch[1]) : undefined,
      poster: img ? bigPoster(img[1]) : undefined,
      rating: rating > 0 && rating <= 10 ? rating : undefined,
    }));
  }
  return items;
}

// Lee las tarjetas <article> de un trozo de HTML de DoramasFox (tema Dooplay).
// Series: /series/<slug>/  Películas: /peliculas/<slug>/
function dfCards(chunk) {
  const items = [];
  const seen = new Set();
  for (const b of String(chunk || "").split("<article").slice(1)) {
    const a = /<a href="(https:\/\/doramafox\.es\/(series|peliculas)\/[a-z0-9-]+\/)"/.exec(b);
    if (!a || seen.has(a[1])) continue;
    const img = /<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/.exec(b);
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(b);
    const title = stripTags(h3 ? h3[1] : (img ? img[2] : ""));
    if (!title) continue;
    seen.add(a[1]);
    const yearMatch = /(\d{4})/.exec(stripTags(b).slice(0, 300));
    const clean = a[1].replace(/^https:\/\/doramafox\.es\//, "/");
    items.push(withGenres({
      id: "df-" + clean.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80),
      ref: "df|" + a[1],
      title: title.slice(0, 200),
      kind: a[2] === "peliculas" ? "movie" : "series",
      year: yearMatch ? Number(yearMatch[1]) : undefined,
      poster: img ? bigPoster(img[1]) : undefined,
    }));
  }
  return items;
}

// Trozo de HTML desde un marcador hasta el siguiente <header> o <section>.
function dfSection(html, idStart) {
  const i = html.indexOf(idStart);
  if (i < 0) return "";
  let end = html.indexOf("<header", i);
  const e2 = html.indexOf("<section", i);
  if (end < 0 || (e2 >= 0 && e2 < end)) end = e2;
  return html.slice(i, end > 0 ? end : i + 60000);
}

// Página de inicio de DoramasFox: series nuevas, en emisión y subtituladas.
// La lista oficial del sitio con audio latino: /audio/latino/ (+ page/N/). Mezcla series y películas.
async function dfLatinoPage(n) {
  const html = await getHtml(DF + "/audio/latino/" + (n > 1 ? "page/" + n + "/" : ""));
  return {
    items: dfCards(html),
    hasNext: html.indexOf("/page/" + (n + 1) + "/") !== -1,
  };
}

// Series en emisión (/estado/emision/) solo con audio latino. Se pide con ?audio=latino; si la
// página no trae la marca "term-latino" (el sitio no aplicó el filtro), se dejan solo las tarjetas
// que muestran la bandera latina (mx.png). Sin esa bandera no se puede comprobar: no se muestra.
async function dfEmisionPage(n) {
  const html = await getHtml(DF + "/estado/emision/" + (n > 1 ? "page/" + n + "/" : "") + "?audio=latino");
  const filtered = /<body[^>]*class="[^"]*term-latino/.test(html);
  let items;
  if (filtered) {
    items = dfCards(html);
  } else {
    const blocks = html.split("<article").slice(1).filter((b) => /flags\/mx\.png/i.test(b));
    items = dfCards(blocks.map((b) => "<article" + b).join(""));
  }
  log("df emision filtro=" + (filtered ? "sitio" : "banderas") + " items=" + items.length);
  return { items, hasNext: html.indexOf("/page/" + (n + 1) + "/") !== -1 };
}

// Inicio de DoramasFox: solo lo que el sitio lista con audio latino.
async function dfHomePage() {
  const [page, em] = await Promise.allSettled([dfLatinoPage(1), dfEmisionPage(1)]);
  if (page.status !== "fulfilled") throw page.reason; // sin la lista latina no hay Inicio de Fox
  const out = {
    series: page.value.items.filter((x) => x.kind === "series").slice(0, HOME_ROW),
    movies: page.value.items.filter((x) => x.kind === "movie").slice(0, HOME_ROW),
    emision: em.status === "fulfilled" ? em.value.items.slice(0, HOME_ROW) : [],
  };
  log("df home latino series=" + out.series.length + " peliculas=" + out.movies.length + " emision=" + out.emision.length);
  return out;
}

// Completa "Destacados" con los títulos mejor calificados de la lista reciente
// (sin repetir), hasta "limit". Con notas iguales o sin nota se respeta el orden del sitio.
function fillFeatured(featured, recent, limit) {
  const out = featured.slice();
  const seen = new Set(out.map((x) => x.id));
  const rest = recent
    .filter((x) => !seen.has(x.id))
    .map((x, i) => ({ x, i }))
    .sort((a, b) => ((b.x.rating || 0) - (a.x.rating || 0)) || (a.i - b.i))
    .map((o) => o.x);
  for (const it of rest) {
    if (out.length >= limit) break;
    out.push(it);
  }
  return out.slice(0, limit);
}

// Separa la página en "Destacadas" (carrusel) y "Añadido recientemente" (lista principal).
async function dmHomePage(path) {
  const html = await getHtml(DM + path);
  const iArchive = html.indexOf('id="archive-content"');
  const iFeatured = html.indexOf('id="featured-titles"');
  const recent = iArchive >= 0 ? html.slice(iArchive) : html;
  const featured = (iFeatured >= 0 && iArchive > iFeatured) ? html.slice(iFeatured, iArchive) : "";
  const out = { featured: dmCards(featured).slice(0, 20), recent: dmCards(recent).slice(0, 40) };
  log("pagina " + path + " bytes=" + html.length + " archivo=" + (iArchive >= 0) + " destacadas=" + out.featured.length + " recientes=" + out.recent.length);
  return out;
}

export async function home() {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const [series, movies, fox] = await Promise.allSettled([
    dmHomePage("/tvshows/"),
    dmHomePage("/movies/"),
    dfHomePage(),
  ]);
  // Cada fila NECESITA un "id" único y un "title": Kino descarta las filas que no lo traen.
  const rows = [];
  if (series.status === "fulfilled") {
    const featured = fillFeatured(series.value.featured, series.value.recent, HOME_ROW);
    if (featured.length) {
      rows.push({
        id: "dm-destacados",
        title: tr("Destacados", "Featured"),
        items: featured,
      });
    }
    if (series.value.recent.length) {
      rows.push({
        id: "dm-doramas",
        title: tr("Recién Agregados", "Recently Added"),
        ref: "tv",
        items: series.value.recent.slice(0, HOME_ROW),
      });
    }
  } else {
    log("home: doramas falló");
  }
  if (movies.status === "fulfilled") {
    if (movies.value.recent.length) {
      rows.push({
        id: "dm-peliculas",
        title: tr("Películas", "Movies"),
        ref: "movies",
        items: movies.value.recent.slice(0, HOME_ROW),
      });
    }
  } else {
    log("home: películas falló");
  }
  if (fox.status === "fulfilled") {
    if (fox.value.series.length) {
      rows.push({
        id: "df-doramas",
        title: tr("K Dramas", "K Dramas"),
        ref: "df-tv",
        items: fox.value.series.slice(0, HOME_ROW),
      });
    }
    if (fox.value.emision.length) {
      rows.push({
        id: "df-emision",
        title: tr("En Emisión", "Airing"),
        ref: "df-emision",
        items: fox.value.emision.slice(0, HOME_ROW),
      });
    }
    if (fox.value.movies.length) {
      rows.push({
        id: "df-peliculas",
        title: tr("Películas en Latino", "Latin Spanish Movies"),
        ref: "df-movies",
        items: fox.value.movies.slice(0, HOME_ROW),
      });
    }
  } else {
    log("home: doramafox falló");
  }
  // Kino descarta las filas sin "id" o sin "title" y los títulos sin "id", "ref" y "title":
  // aquí se deja pasar solo lo que los trae, con ids de fila únicos.
  const seenRow = new Set();
  const good = [];
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || !r.id || typeof r.title !== "string" || !r.title) continue;
    if (seenRow.has(r.id)) continue;
    const items = (Array.isArray(r.items) ? r.items : []).filter(
      (x) => x && typeof x.id === "string" && x.id && typeof x.ref === "string" && x.ref && typeof x.title === "string" && x.title
    );
    if (!items.length) continue;
    seenRow.add(r.id);
    const movies = items.filter((x) => x.kind === "movie").length;
    r.items = items;
    r.genre = movies > items.length / 2 ? "peliculas" : "series";
    good.push(r);
  }
  log("home filas=" + good.length + " items=" + good.map((r) => r.id + ":" + r.items.length).join(","));
  if (!good.length) throw kino.error("unavailable", "inicio sin resultados");
  const pos = (r) => { const i = HOME_ORDER.indexOf(r.id); return i < 0 ? HOME_ORDER.length : i; };
  const ordered = good.map((r, i) => ({ r, i })).sort((a, b) => (pos(a.r) - pos(b.r)) || (a.i - b.i)).map((o) => o.r);
  return ordered.slice(0, 20);
}

// ---- Catálogos (Ver más y Categorías) ---------------------------------------------------------

// Una página del archivo del sitio (la lista principal de doramas o de películas).
async function dmArchivePage(r, n) {
  const path = (r === "tv" ? "/tvshows/" : "/movies/") + (n > 1 ? "page/" + n + "/" : "");
  const html = await getHtml(DM + path);
  const i = html.indexOf('id="archive-content"');
  return {
    items: dmCards(i >= 0 ? html.slice(i) : html),
    hasNext: html.indexOf("/page/" + (n + 1) + "/") !== -1,
  };
}

// Una página del archivo de DoramasFox: /series/ o /peliculas/ (+ /page/N/).
async function dfArchivePage(r, n) {
  if (r === "df-emision") return dfEmisionPage(n);
  const kind = r === "df-movies" ? "movie" : "series";
  const page = await dfLatinoPage(n);
  return { items: page.items.filter((x) => x.kind === kind), hasNext: page.hasNext };
}

// ref "tv" = doramas, ref "movies" = películas, ref "df-tv" = DoramasFox series,
// ref "df-movies" = DoramasFox películas; el cursor es el número de página del sitio.
// Cada tanda junta varias páginas del sitio hasta llegar a unos 60 títulos (máximo 100).
export async function browse(ref, cursor) {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const r = String(ref || "");
  const isDf = r === "df-tv" || r === "df-movies" || r === "df-emision";
  if (r !== "tv" && r !== "movies" && !isDf) throw kino.error("not_found", "catálogo desconocido");
  const pageFn = isDf ? dfArchivePage : dmArchivePage;
  const n = Math.max(1, parseInt(cursor, 10) || 1);
  const items = [];
  const seen = new Set();
  let p = n;
  let last = n - 1;
  let hasNext = true;
  let rounds = 0;
  while (hasNext && items.length < CAT_VIEW && rounds < 3) {
    rounds++;
    const batch = await Promise.allSettled([0, 1, 2].map((k) => pageFn(r, p + k)));
    let stop = false;
    for (let k = 0; k < batch.length; k++) {
      const res = batch[k];
      if (res.status !== "fulfilled") {
        if (last < n) throw res.reason; // ni la primera página cargó: es un error de verdad
        stop = true;
        break;
      }
      const fresh = res.value.items.filter((x) => !seen.has(x.id));
      if (items.length && items.length + fresh.length > CAT_MAX) { stop = true; break; }
      for (const x of fresh) { seen.add(x.id); items.push(x); }
      last = p + k;
      hasNext = res.value.hasNext;
      if (!hasNext || items.length >= CAT_VIEW) { stop = true; break; }
    }
    if (stop) break;
    p += 3;
  }
  const page = { items: items.slice(0, CAT_MAX) };
  if (hasNext && items.length) page.next = String(last + 1);
  return page;
}

// Las fichas de la sección Categorías del plugin; cada una abre browse(ref, null).
// Cada mosaico lleva "id" (como en el ejemplo del contrato).
export async function categories() {
  await null;
  const [tv, mv, fox] = await Promise.allSettled([dmHomePage("/tvshows/"), dmHomePage("/movies/"), dfHomePage()]);
  const art = (res) => {
    if (res.status !== "fulfilled") return undefined;
    const first = res.value.recent ? res.value.recent[0] : res.value.series[0];
    return first ? first.poster : undefined;
  };
  const artMovies = (res) => (res.status === "fulfilled" && res.value.movies[0] ? res.value.movies[0].poster : undefined);
  const tiles = [
    { id: "doramas", title: tr("Doramas", "Dramas"), ref: "tv", art: art(tv) },
    { id: "peliculas", title: tr("Películas", "Movies"), ref: "movies", art: art(mv) },
    { id: "fox-doramas", title: "Fox · " + tr("Doramas", "Dramas"), ref: "df-tv", art: art(fox) },
    { id: "fox-peliculas", title: "Fox · " + tr("Películas", "Movies"), ref: "df-movies", art: artMovies(fox) },
  ];
  return tiles.map((t) => (t.art ? t : { id: t.id, title: t.title, ref: t.ref }));
}

// ---- Búsqueda unificada -----------------------------------------------------------------------

export async function search(query) {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const q = stripTags(query && query.q).slice(0, 100);
  if (!q) return [];
  const enc = encodeURIComponent(q);
  // Dorama Express ya no se busca: su video nunca se reproduce aquí.
  const [dm, df] = await Promise.allSettled([
    dmSearch(enc),
    dfSearch(enc),
  ]);
  const out = [];
  const seen = new Set();
  const add = (item) => {
    const key = squash(item.title);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  // Doramed Play primero: si el título está en las dos, queda el que sí se reproduce.
  if (dm.status === "fulfilled") dm.value.forEach(add);
  if (df.status === "fulfilled") df.value.forEach(add);
  if (!out.length && dm.status === "rejected" && df.status === "rejected") throw dm.reason;
  return out.slice(0, MAX_RESULTS);
}

// ---- Doramed Play -----------------------------------------------------------------------------

async function dmSearch(enc) {
  const html = await getHtml(DM + "/?s=" + enc);
  const items = [];
  const blocks = html.split('<div class="result-item">').slice(1);
  for (const b of blocks) {
    const m = /<div class="title"><a href="([^"]+)">([\s\S]*?)<\/a><\/div>/.exec(b);
    if (!m || !/^https:\/\/www\.doramedplay\.com\/(tvshows|movies)\//.test(m[1])) continue;
    const kind = m[1].indexOf("/movies/") !== -1 ? "movie" : "series";
    const year = /<span class="year">(\d{4})</.exec(b);
    const imgMatch = /<img src="([^"]+)"/.exec(b);
    const poster = imgMatch ? bigPoster(imgMatch[1]) : undefined;
    const desc = /<div class="contenido"><p>([\s\S]*?)<\/p><\/div>/.exec(b);
    const clean = m[1].replace(/^https:\/\/www\.doramedplay\.com\//, "/");
    items.push(withGenres({
      id: "dm-" + clean.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80),
      ref: "dm|" + m[1],
      title: stripTags(m[2]).slice(0, 200),
      kind,
      year: year ? Number(year[1]) : undefined,
      poster,
      overview: desc ? stripTags(desc[1]).slice(0, 400) : undefined,
    }));
  }
  return items;
}

// ---- Dorama Express ---------------------------------------------------------------------------

async function dxSearch(enc) {
  const html = await getHtml(DX + "/?s=" + enc);
  const items = [];
  const blocks = html.split('class="display-item"').slice(1);
  for (const b of blocks) {
    const m = /<a href="(https:\/\/doramaexpress\.com\/(?:serie|pelicula)\/[a-z0-9-]+\/)"[^>]*data-ptype="([a-z]+)"[^>]*title="([^"]*)"/.exec(b);
    if (!m) continue;
    const kind = m[2] === "movies" ? "movie" : "series";
    const img = /<img[^>]*(?:data-original|src)="(https:\/\/image\.tmdb\.org\/[^"]+)"/.exec(b);
    const h3 = /<h3>([^<]*)<\/h3>/.exec(b);
    const title = h3 ? stripTags(h3[1]) : stripTags(m[3]);
    const slug = m[1].replace(/^https:\/\/doramaexpress\.com\//, "").replace(/\/$/, "");
    items.push(withGenres({
      id: "dx-" + slug.replace(/[^a-z0-9-]+/gi, "-").slice(0, 80),
      ref: "dx|" + m[1],
      title: title.slice(0, 200),
      kind,
      poster: img ? img[1] : undefined,
    }));
  }
  return items;
}

// ---- DoramasFox -------------------------------------------------------------------------------

// Búsqueda dentro de la sección de audio latino del sitio (/audio/latino/?s=): solo devuelve
// títulos con audio latino. Cada resultado trae sus banderas de idioma (mx.png = latino);
// si trae banderas y ninguna es latina, se descarta. El sitio también tiene una búsqueda en vivo
// (/wp-json/dooplay/search/) pero pide "nonce" y no se puede usar desde el plugin.
async function dfSearch(enc) {
  const html = await getHtml(DF + "/audio/latino/?s=" + enc);
  const items = [];
  const seen = new Set();
  const blocks = html.split('<div class="result-item">').slice(1);
  for (const b of blocks) {
    const m = /<a href="(https:\/\/doramafox\.es\/(?:series|peliculas)\/[a-z0-9-]+\/)"/.exec(b);
    if (!m) continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const img = /<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/.exec(b);
    const h3 = /<div class="title"><a[^>]*>([\s\S]*?)<\/a>/.exec(b);
    const title = stripTags(h3 ? h3[1] : (img ? img[2] : ""));
    if (!title) continue;
    const flags = [];
    const rf = /<span class="flag\d*"><img[^>]*src=(['"])([^'"]+)\1/g;
    let f;
    while ((f = rf.exec(b))) flags.push(f[2]);
    if (flags.length && !flags.some((u) => /mx\.png/i.test(u))) continue; // sin audio latino
    const year = /<span class="year">(\d{4})</.exec(b);
    const clean = m[1].replace(/^https:\/\/doramafox\.es\//, "/");
    items.push(withGenres({
      id: "df-" + clean.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80),
      ref: "df|" + m[1],
      title: title.slice(0, 200),
      kind: m[1].indexOf("/peliculas/") !== -1 ? "movie" : "series",
      year: year ? Number(year[1]) : undefined,
      poster: img ? bigPoster(img[1]) : undefined,
    }));
  }
  return items;
}

// ---- Episodios --------------------------------------------------------------------------------

export async function episodes(ref) {
  await null; // las validaciones de abajo pueden lanzar: nunca antes del primer await
  const raw = String(ref || "");
  if (!raw.startsWith("dm|") && !raw.startsWith("dx|") && !raw.startsWith("df|")) throw kino.error("not_found", "referencia desconocida");
  const url = raw.slice(3);
  const html = await getHtml(url);
  if (raw.startsWith("dm|")) return dmEpisodes(html, url);
  if (raw.startsWith("dx|")) return dxEpisodes(html, url);
  return dfEpisodes(html, url);
}

function dmEpisodes(html, url) {
  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  // Grupo 3 = la URL (los grupos 1 y 2 son las comillas).
  const p1 = /class=(['"])poster\1[^>]*>\s*<img[^>]*src=(['"])([^'"]+)\2/i.exec(html);
  const p2 = /property=(['"])og:image\1[^>]*content=(['"])([^'"]+)\2/i.exec(html);
  const poster = p1 ? p1[3] : (p2 ? p2[3] : undefined);

  // Dooplay: <div class='numerando'>1 - 2</div><div class='episodiotitle'><a href='...'>Episodio 2</a>
  const eps = [];
  const re = /class=(['"])numerando\1>([^<]*)<\/div>\s*<div class=\1episodiotitle\1>\s*<a href=(['"])([^'"]+)\3[^>]*>([^<]*)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const num = m[2].split("-").map((x) => parseInt(x.trim(), 10));
    if (!/^https:\/\/www\.doramedplay\.com\/episodes\//.test(m[4])) continue;
    const number = Number.isInteger(num[1]) ? num[1] : eps.length + 1;
    eps.push({
      season: Number.isInteger(num[0]) ? num[0] : 1,
      number,
      ref: "dm|" + m[4],
      title: stripTags(m[5]) || (tr("Episodio ", "Episode ") + number),
    });
  }
  if (!eps.length) throw kino.error("not_found", "no se encontró la lista de episodios");
  return {
    series: { title: title ? stripTags(title[1]) : url, poster },
    episodes: eps,
  };
}

function dxEpisodes(html, url) {
  const title = /<h2 class="ypp-hero-title">([^<]*)<\/h2>/.exec(html);
  const poster = /property="og:image" content="([^"]+)"/.exec(html) || /property='og:image' content='([^']+)'/.exec(html);
  const eps = [];
  // <div class="ypp-ep-card" data-ep-num="3" data-title="serie: 1x3" onclick="window.location.href='.../episodio/serie-1x3/'">
  const re = /data-ep-num="(\d+)" data-title="([^"]*)"[^>]*onclick="window\.location\.href='([^']+)'"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!/^https:\/\/doramaexpress\.com\/episodio\//.test(m[3])) continue;
    const sn = /(\d+)x(\d+)\s*$/.exec(m[2]);
    const number = parseInt(m[1], 10) || (sn ? parseInt(sn[2], 10) : eps.length + 1);
    eps.push({
      season: sn ? parseInt(sn[1], 10) : 1,
      number,
      ref: "dx|" + m[3],
      title: tr("Episodio ", "Episode ") + number,
    });
  }
  if (!eps.length) throw kino.error("not_found", "no se encontró la lista de episodios");
  return {
    series: { title: title ? stripTags(title[1]) : url, poster: poster ? poster[1] : undefined },
    episodes: eps,
  };
}

// En DoramasFox los enlaces de episodio son /episodio/<slug>-1x4-.../ y el número
// viene dentro del slug: es lo más robusto (el HTML envuelve <li> dentro de <a>).
function dfEpisodes(html, url) {
  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const p1 = /class=(['"])poster\1[^>]*>\s*<img[^>]*src=(['"])([^'"]+)\2/i.exec(html);
  const p2 = /property=(['"])og:image\1[^>]*content=(['"])([^'"]+)\2/i.exec(html);
  const poster = p1 ? p1[3] : (p2 ? p2[3] : undefined);

  const eps = [];
  const seen = new Set();
  const re = /href=['"](https:\/\/doramafox\.es\/episodio\/([a-z0-9-]+)\/)['"]/g;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const sn = /(\d+)x(\d+)/.exec(m[2]);
    eps.push({
      season: sn ? parseInt(sn[1], 10) : 1,
      number: sn ? parseInt(sn[2], 10) : eps.length + 1,
      ref: "df|" + m[1],
      title: tr("Episodio ", "Episode ") + (sn ? sn[2] : eps.length),
    });
  }
  if (!eps.length) throw kino.error("not_found", "no se encontró la lista de episodios");
  eps.sort((a, b) => (a.season - b.season) || (a.number - b.number));
  return {
    series: { title: title ? stripTags(title[1]) : url, poster },
    episodes: eps,
  };
}

// ---- Reproducción -----------------------------------------------------------------------------

// Un iframe de Doramed Play puede ser un jwplayer/?source=<url codificada> (MP4 directo,
// por lo general en archive.org) u otro reproductor (VK y similares), que se descarta.
function playableFromIframe(src) {
  let u = src;
  if (src.indexOf("jwplayer/?source=") !== -1) {
    try {
      u = new URLSearchParams(new URL(src).search).get("source") || "";
    } catch {
      const mm = /source=([^&'"]+)/.exec(src);
      try { u = mm ? decodeURIComponent(mm[1]) : ""; } catch { u = ""; }
    }
  }
  if (!/^https:\/\//.test(u)) return null;
  if (/\.(mp4|m4v|webm)(\?|$)/i.test(u)) return { url: u, mime: "video/mp4" };
  if (/\.m3u8(\?|$)/i.test(u)) return { url: u, mime: "application/x-mpegurl" };
  return null;
}

// ---- OK.ru (reproductor embebido que usan algunos capítulos de Doramed Play) ------------------

const OK_EMBED = /(?:https?:)?\/\/(?:www\.|m\.)?ok\.ru\/videoembed\/(\d+)/i;
const OK_ORDER = ["mobile", "lowest", "low", "sd", "hd", "full", "quad", "ultra"];
const OK_LABEL = { mobile: "144p", lowest: "240p", low: "360p", sd: "480p", hd: "720p", full: "1080p", quad: "1440p", ultra: "2160p" };
const OK_HEADERS = { Referer: "https://ok.ru/" };

// Abre la página del reproductor, lee el JSON que trae (data-options -> flashvars.metadata)
// y arma el Stream: la mejor calidad MP4 hasta 1080p, las demás como alternativas y el HLS si lo hay.
async function okResolve(id) {
  const html = await getHtml("https://ok.ru/videoembed/" + id);
  const attr = /data-options="([^"]*)"/.exec(html) || /data-options='([^']*)'/.exec(html);
  if (!attr) {
    log("okru: sin data-options id=" + id + " bytes=" + html.length);
    throw okUnavailable();
  }
  let md = null;
  try {
    const opts = JSON.parse(decodeEntities(attr[1]));
    md = opts && opts.flashvars ? opts.flashvars.metadata : null;
    if (typeof md === "string") md = JSON.parse(md);
  } catch (e) {
    log("okru: no se pudo leer el JSON id=" + id);
    md = null;
  }
  if (!md || typeof md !== "object") {
    log("okru: sin metadata id=" + id);
    throw okUnavailable();
  }
  const vids = (Array.isArray(md.videos) ? md.videos : [])
    .filter((v) => v && typeof v.url === "string" && /^https:\/\//.test(v.url) && OK_ORDER.indexOf(v.name) >= 0)
    .sort((a, b) => OK_ORDER.indexOf(b.name) - OK_ORDER.indexOf(a.name)); // la mejor primero
  const hlsRaw = md.hlsManifestUrl || md.ondemandHls || md.hlsMasterPlaylistUrl;
  const hls = typeof hlsRaw === "string" && /^https:\/\//.test(hlsRaw) ? hlsRaw : null;
  log("okru: id=" + id + " mp4=" + vids.map((v) => v.name).join(",") + " hls=" + (hls ? "si" : "no"));

  const limit = OK_ORDER.indexOf("full");
  const primary = vids.find((v) => OK_ORDER.indexOf(v.name) <= limit) || vids[0];
  if (!primary && !hls) throw okUnavailable();

  // Copias: primero las calidades menores a la elegida (de mayor a menor), luego el HLS y al final las mayores.
  const copy = (v) => ({ url: v.url, mime: "video/mp4", headers: OK_HEADERS, label: "OK · " + OK_LABEL[v.name] });
  const pi = primary ? OK_ORDER.indexOf(primary.name) : -1;
  const copies = [];
  if (primary) {
    for (const v of vids) if (OK_ORDER.indexOf(v.name) < pi) copies.push(copy(v));
    if (hls) copies.push({ url: hls, mime: "application/x-mpegurl", headers: OK_HEADERS, label: "OK · HLS" });
    for (const v of vids.slice().reverse()) if (OK_ORDER.indexOf(v.name) > pi) copies.push(copy(v));
  }

  const out = primary
    ? { url: primary.url, mime: "video/mp4", label: "OK · " + OK_LABEL[primary.name] }
    : { url: hls, mime: "application/x-mpegurl", label: "OK · HLS" };
  out.headers = OK_HEADERS;
  out.expiresInSeconds = 1800;
  if (copies.length) out.alternatives = copies.slice(0, 8);
  return out;
}

function okUnavailable() {
  return kino.error("unavailable", "okru sin video", {
    userMessage: tr(
      "Este capítulo ya no está disponible en el reproductor del sitio. Prueba otra opción o busca el título de nuevo.",
      "This episode is no longer available on the site's player. Try another option or search the title again."
    ),
  });
}

// ---- PeerTube de Doramed (video.doramed.tv): el reproductor de sus capítulos nuevos -----------

const PT_HOST = "video.doramed.tv";
const PT_EMBED = /(?:https?:)?\/\/video\.doramed\.tv\/videos\/embed\/([A-Za-z0-9_-]+)/i;
const PT_HEADERS = { Referer: "https://video.doramed.tv/" };

function ptUnavailable() {
  return kino.error("unavailable", "peertube sin video", {
    userMessage: tr(
      "Este capítulo ya no está disponible en el reproductor del sitio. Prueba otra opción o busca el título de nuevo.",
      "This episode is no longer available on the site's player. Try another option or search the title again."
    ),
  });
}

// Pide a la API de PeerTube los datos del video y arma el Stream: MP4 directo si lo hay
// (la mejor calidad hasta 1080p) y el HLS como alternativa, o el HLS solo si no hay MP4.
async function ptResolve(id) {
  const txt = await getHtml("https://" + PT_HOST + "/api/v1/videos/" + id);
  let v = null;
  try { v = JSON.parse(txt); } catch (e) { log("peertube: JSON inválido id=" + id); }
  if (!v || typeof v !== "object") throw ptUnavailable();

  const resOf = (f) => Number(f && f.resolution && f.resolution.id) || 0;
  const mp4 = (Array.isArray(v.files) ? v.files : [])
    .filter((f) => f && typeof f.fileUrl === "string" && /^https:\/\//.test(f.fileUrl))
    .sort((a, b) => resOf(b) - resOf(a)); // la mejor primero
  let hls = null;
  for (const pl of (Array.isArray(v.streamingPlaylists) ? v.streamingPlaylists : [])) {
    if (pl && typeof pl.playlistUrl === "string" && /^https:\/\//.test(pl.playlistUrl)) { hls = pl.playlistUrl; break; }
  }
  log("peertube: id=" + id + " mp4=" + mp4.map(resOf).join(",") + " hls=" + (hls ? "si" : "no"));
  if (!mp4.length && !hls) throw ptUnavailable();

  const label = (f) => "Doramed · " + (resOf(f) ? resOf(f) + "p" : "MP4");
  const primary = mp4.find((f) => resOf(f) <= 1080) || mp4[0];
  const copy = (f) => ({ url: f.fileUrl, mime: "video/mp4", headers: PT_HEADERS, label: label(f) });
  const copies = [];
  if (primary) {
    const pr = resOf(primary);
    for (const f of mp4) if (resOf(f) < pr) copies.push(copy(f));
    if (hls) copies.push({ url: hls, mime: "application/x-mpegurl", headers: PT_HEADERS, label: "Doramed · HLS" });
    for (const f of mp4.slice().reverse()) if (resOf(f) > pr) copies.push(copy(f));
  }

  const out = primary
    ? { url: primary.fileUrl, mime: "video/mp4", label: label(primary) }
    : { url: hls, mime: "application/x-mpegurl", label: "Doramed · HLS" };
  out.headers = PT_HEADERS;
  out.expiresInSeconds = 1800;
  if (copies.length) out.alternatives = copies.slice(0, 8);
  return out;
}

// ---- DoramasFox: opciones de reproductor y captura con el navegador oculto --------------------

// Lee las opciones de reproductor de la página del capítulo o película.
// Cada <li class='dooplay_player_option'> trae data-type, data-post, data-nume,
// el nombre en <span class='title'> y el idioma en la bandera (<img .../flags/mx.png>).
// La opción "trailer" (YouTube) se salta. El orden preferido es: Latino, Subtitulado, Inglés.
function dfOptions(html) {
  const opts = [];
  const re = /<li[^>]*class=(['"])dooplay_player_option\1[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const li = m[0];
    const chunk = html.slice(m.index, m.index + 1200);
    const attr = (name) => {
      const a = new RegExp("data-" + name + "=(['\"])([^'\"]+)\\1").exec(li);
      return a ? a[2] : "";
    };
    const type = attr("type");
    const post = attr("post");
    const nume = attr("nume");
    const name = /<span class=(['"])title\1>([^<]*)<\/span>/.exec(chunk);
    const flag = /<img src=(['"])([^'"]*\/flags\/[^'"]+)\1/.exec(chunk);
    if (!type || !post || !nume || nume === "trailer") continue;
    let lang = tr("Subtitulado", "Subbed");
    if (flag && /mx\.png/i.test(flag[2])) lang = "Latino";
    else if (flag && /en\.png/i.test(flag[2])) lang = tr("Inglés", "English");
    else if (flag && /Picsart/i.test(flag[2])) lang = tr("Subtitulado", "Subbed");
    if (lang !== "Latino" && name && /latino/i.test(name[2]) && !(flag && /en\.png/i.test(flag[2]))) lang = "Latino";
    opts.push({
      post, type, nume,
      name: name ? stripTags(name[2]) : nume,
      lang,
      rank: lang === "Latino" ? 0 : (lang === tr("Subtitulado", "Subbed") ? 1 : 2),
    });
  }
  opts.sort((a, b) => a.rank - b.rank);
  log("df opciones=" + opts.length + " " + opts.map((o) => o.lang + "/" + o.name).join(","));
  return opts;
}

// Abre el reproductor embebido con el navegador oculto de Kino y toma el video que encuentra.
async function dfCapture(embedUrl, ms) {
  if (typeof kino === "undefined" || !kino.browser || typeof kino.browser.capture !== "function") {
    throw kino.error("unavailable", "este Kino no trae navegador", {
      userMessage: tr(
        "Tu versión de Kino no puede abrir este reproductor. Actualiza la app y prueba de nuevo.",
        "Your Kino version can't open this player. Update the app and try again."
      ),
    });
  }
  // headers: Referer de la página del sitio para la primera carga del reproductor.
  const copts = { timeoutMs: ms || 12000, headers: { Referer: DF + "/" } };
  // DIAGNÓSTICO: con captureAll (Kino 0.9.54+) y returnCookiesOnTimeout, al agotarse el tiempo Kino
  // devuelve las peticiones que hizo la página en vez de fallar; se anotan en el registro.
  const diag = kino.browser.captureAll === true;
  // alsoMatch ["."]: recoge TODAS las peticiones (máx. 20), no solo las que parecen video.
  if (diag) { copts.captureAll = true; copts.returnCookiesOnTimeout = true; copts.alsoMatch = ["."]; }
  const page = await kino.browser.capture(embedUrl, copts);
  const media = (page && Array.isArray(page.media) && page.media.length) ? page.media : [];
  log("df captura media=" + media.length + " timedOut=" + !!(page && page.timedOut) + " diag=" + diag);
  if (page && page.finalUrl) {
    try { const fu = new URL(page.finalUrl); log("df final " + fu.host + fu.pathname.slice(0, 40)); } catch (e) { /* url rara */ }
  }
  if (page && Array.isArray(page.requests)) {
    log("df req total=" + page.requests.length);
    for (const q of page.requests.slice(0, 25)) {
      try {
        const u = new URL(q.url);
        log("df req " + q.method + " " + u.host + u.pathname.slice(0, 60));
      } catch (e) { /* url rara: se salta */ }
    }
  }
  const first = media.find((x) => x && typeof x.url === "string" && /^https?:\/\//.test(x.url));
  if (!first) {
    throw kino.error("unavailable", "captura sin video", {
      userMessage: tr(
        "El reproductor de este capítulo no entregó el video. Prueba otra opción o busca el título de nuevo.",
        "This episode's player didn't return the video. Try another option or search the title again."
      ),
    });
  }
  const out = { url: first.url };
  // El video suele exigir el Referer y el User-Agent con que lo pidió el reproductor: se pasan tal cual.
  if (first.headers && typeof first.headers === "object" && Object.keys(first.headers).length) out.headers = first.headers;
  if (first.mime) out.mime = first.mime;
  else if (first.mimeType) out.mime = first.mimeType;
  else if (/\.m3u8(\?|$)/i.test(first.url)) out.mime = "application/x-mpegurl";
  else out.mime = "video/mp4";
  if (page.subtitles && page.subtitles.es) out.subtitles = { es: page.subtitles.es };
  return out;
}

// Pide a la API de DoramasFox la URL del reproductor de una opción y la captura.
async function dfTryOption(opt, captureMs) {
  const api = DF + "/wp-json/dooplayer/v2/" + opt.post + "/" + opt.type + "/" + opt.nume;
  const txt = await getHtml(api);
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { log("df: JSON inválido post=" + opt.post + " nume=" + opt.nume); }
  const embed = j && typeof j.embed_url === "string" ? j.embed_url : "";
  if (!/^https?:\/\//.test(embed)) {
    throw kino.error("unavailable", "la opción no trajo reproductor", {
      userMessage: tr(
        "Esta opción ya no está disponible en el sitio. Prueba otra opción del capítulo.",
        "This option is no longer available on the site. Try another option for this episode."
      ),
    });
  }
  log("df api post=" + opt.post + " nume=" + opt.nume + " embed=" + embed.slice(0, 60));
  const stream = await dfCapture(embed, captureMs);
  stream.label = opt.lang + " · " + opt.name;
  return stream;
}

function dfNoVideo(opts) {
  return kino.error("unavailable", "doramafox sin video", {
    userMessage: tr(
      "Ninguna opción de este capítulo entregó el video. Busca el título en Doramed Play.",
      "No option for this episode returned the video. Search the title on Doramed Play."
    ),
  });
}

export async function resolve(ref) {
  await null; // las validaciones de abajo pueden lanzar: nunca antes del primer await
  const raw = String(ref || "");

  // Alternativa elegida por la persona: ya es una URL reproducible.
  if (raw.startsWith("dmurl|")) {
    const u = raw.slice(6);
    if (!/^https:\/\//.test(u)) throw kino.error("not_found", "alternativa inválida");
    return { url: u, mime: /\.m3u8(\?|$)/i.test(u) ? "application/x-mpegurl" : "video/mp4" };
  }

  // Copia perezosa de OK.ru elegida por la persona (o por el cambio automático).
  if (raw.startsWith("okru|")) {
    const id = raw.slice(5);
    if (!/^\d{1,20}$/.test(id)) throw kino.error("not_found", "id de okru inválido");
    return okResolve(id);
  }

  // Copia perezosa de una opción de DoramasFox (o cambio automático a otra opción).
  if (raw.startsWith("dfopt|")) {
    const parts = raw.slice(6).split("|");
    if (parts.length !== 3) throw kino.error("not_found", "opción de doramafox inválida");
    const opt = { post: parts[0], type: parts[1], nume: parts[2], lang: tr("Otra opción", "Other option"), name: "" };
    return dfTryOption(opt);
  }

  // Dorama Express: su video está detrás de candados del sitio (espera, VIP, ruleta).
  // El plugin no los salta; la persona puede buscar la misma serie en Doramed Play.
  if (raw.startsWith("dx|")) {
    throw kino.error("unavailable", "dorama express con candado", {
      userMessage: tr(
        "Dorama Express solo reproduce en su web, con esperas y anuncios. Busca el título de nuevo: si está en Doramed Play, aquí sí se reproduce.",
        "Dorama Express only plays on its own site, with waits and ads. Search the title again: if it is on Doramed Play, it plays here."
      ),
    });
  }

  // DoramasFox: página de un capítulo o película; se prueban sus opciones en orden
  // (Latino primero) hasta que una entregue el video. Las demás quedan como alternativas.
  if (raw.startsWith("df|")) {
    const html = await getHtml(raw.slice(3));
    const all = dfOptions(html);
    const opts = all.filter((o) => o.lang === "Latino"); // solo audio latino
    if (!all.length) {
      throw kino.error("unavailable", "doramafox sin opciones", {
        userMessage: tr(
          "Este título no tiene reproductores disponibles. Prueba otra opción o busca el título de nuevo.",
          "This title has no available players. Try another option or search the title again."
        ),
      });
    }
    if (!opts.length) {
      throw kino.error("unavailable", "doramafox sin audio latino", {
        userMessage: tr(
          "Este título no tiene audio latino en esta fuente. Busca el título en Doramed Play.",
          "This title has no Latin Spanish audio on this source. Search the title on Doramed Play."
        ),
      });
    }
    let lastErr = null;
    const t0 = Date.now();
    // resolve tiene 20 s en total. Con varias opciones cada una tiene ~8 s (así se prueban todas);
    // con una sola se le da hasta 15 s. No se empieza otra opción si ya no alcanza.
    const each = opts.length > 1 ? 8000 : 15000;
    for (const opt of opts.slice(0, 3)) {
      const left = 17000 - (Date.now() - t0);
      if (left < 5000) break;
      try {
        const stream = await dfTryOption(opt, Math.min(each, left - 1500));
        const alts = [];
        for (const o of opts) {
          if (o === opt) continue;
          alts.push({
            label: o.lang + " · " + o.name,
            ref: "dfopt|" + o.post + "|" + o.type + "|" + o.nume,
          });
        }
        if (alts.length) stream.alternatives = alts.slice(0, 8);
        return stream;
      } catch (e) {
        lastErr = e;
        log("df opción falló post=" + opt.post + " nume=" + opt.nume + " motivo=" + String((e && (e.code || e.message)) || e).slice(0, 80));
        // blocked, busy o timeout del reproductor: se prueba la siguiente opción.
      }
    }
    throw dfNoVideo(opts);
  }

  if (!raw.startsWith("dm|")) throw kino.error("not_found", "referencia desconocida");
  const html = await getHtml(raw.slice(3));

  const playable = [];
  const okIds = [];
  const ptIds = [];
  const re = /<iframe[^>]*src=(['"])([^'"]+)\1[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const src = decodeEntities(m[2]);
    const ok = OK_EMBED.exec(src);
    if (ok) {
      if (okIds.indexOf(ok[1]) < 0) okIds.push(ok[1]);
      continue;
    }
    const pt = PT_EMBED.exec(src);
    if (pt) {
      if (ptIds.indexOf(pt[1]) < 0) ptIds.push(pt[1]);
      continue;
    }
    const p = playableFromIframe(src);
    if (p && !playable.some((x) => x.url === p.url)) playable.push(p);
  }
  log("resolve: directos=" + playable.length + " peertube=" + ptIds.length + " okru=" + okIds.length);

  // Sin video directo pero con PeerTube de Doramed: se resuelve; si falla y hay OK.ru, se prueba OK.ru.
  if (!playable.length && ptIds.length) {
    try {
      return await ptResolve(ptIds[0]);
    } catch (e) {
      log("peertube falló id=" + ptIds[0]);
      if (!okIds.length) throw e;
    }
  }

  // Sin video directo pero con OK.ru: se resuelve el primero y los demás quedan como copias perezosas.
  if (!playable.length && okIds.length) {
    const first = await okResolve(okIds[0]);
    const lazy = okIds.slice(1, 4).map((id, i) => ({ label: tr("Opción ", "Option ") + (i + 2), ref: "okru|" + id }));
    const alts = (first.alternatives || []).concat(lazy).slice(0, 8);
    if (alts.length) first.alternatives = alts;
    return first;
  }

  if (!playable.length) {
    // Diagnóstico: lista los dominios de los reproductores que trae la página del capítulo.
    const found = [];
    const rf = /<iframe[^>]*src=(['"])([^'"]+)\1/g;
    let f;
    while ((f = rf.exec(html))) {
      const h = decodeEntities(f[2]).replace(/^(?:https?:)?\/\//, "").split(/[\/?#]/)[0];
      if (h && found.indexOf(h) < 0) found.push(h);
    }
    log("resolve: reproductores=" + found.join(","));
    throw kino.error("unavailable", "sin video directo", {
      userMessage: tr(
        "Este capítulo solo está en reproductores que el plugin no puede abrir. Prueba otra opción del capítulo o busca el título de nuevo.",
        "This episode is only on players the plugin can't open. Try another option or search the title again."
      ),
    });
  }
  const out = { url: playable[0].url, mime: playable[0].mime };
  const alts = playable.slice(1, 6).map((p, i) => ({
    label: tr("Opción ", "Option ") + (i + 2),
    ref: "dmurl|" + p.url,
  }));
  // Si además hay OK.ru, queda como copia perezosa: solo se abre si hace falta.
  for (const id of okIds.slice(0, 2)) alts.push({ label: "OK", ref: "okru|" + id });
  if (alts.length) out.alternatives = alts.slice(0, 8);
  return out;
}
