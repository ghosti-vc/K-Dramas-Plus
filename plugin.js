// Plugin de Kino: Doramas en audio latino (búsqueda unificada + Inicio).
// Fuentes:
//  - "dm|" Doramed Play (www.doramedplay.com): inicio, búsqueda, episodios y reproducción (MP4 directo).
//  - "dx|" Dorama Express (doramaexpress.com): búsqueda y episodios; su video está detrás de
//    candados del sitio (temporizador, VIP) que el plugin no salta: al reproducir avisa.
// Pendiente: "pn|" Pandrama (bloquea el acceso automatizado).

const DM = "https://www.doramedplay.com";
const DX = "https://doramaexpress.com";
const MAX_RESULTS = 100;

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
  return stripTags(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
}

// Nunca lanza antes del primer await (los Kino viejos abortan la llamada si lo hace).
async function getHtml(url) {
  const r = await kino.fetch(url);
  log("fetch status=" + r.status + " ok=" + r.ok);
  if (!r.ok) {
    if (r.status === 404) throw kino.error("not_found", "el sitio respondió 404");
    if (r.status === 429) throw kino.error("rate_limited", "el sitio respondió 429");
    throw kino.error("unavailable", "el sitio respondió " + r.status);
  }
  return r.text();
}

// ---- Inicio -----------------------------------------------------------------------------------

// Quita el sufijo de tamaño (-185x278) para pedir la imagen original.
function bigPoster(src) {
  return src ? src.replace(/-\d+x\d+\.(jpg|jpeg|png|webp)$/i, ".$1") : undefined;
}

// Lee las tarjetas <article class="item ..."> de un trozo de HTML de Doramed Play (tema Dooplay).
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
    const clean = a[1].replace(/^https:\/\/www\.doramedplay\.com\//, "/");
    items.push({
      id: "dm-" + clean.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80),
      ref: "dm|" + a[1],
      title: title.slice(0, 200),
      kind: a[2] === "movies" ? "movie" : "series",
      year: yearMatch ? Number(yearMatch[1]) : undefined,
      poster: img ? bigPoster(img[1]) : undefined,
    });
  }
  return items;
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
  const [series, movies] = await Promise.allSettled([
    dmHomePage("/tvshows/"),
    dmHomePage("/movies/"),
  ]);
  const rows = [];
  if (series.status === "fulfilled") {
    if (series.value.featured.length) {
      rows.push({ title: tr("Doramas destacados", "Featured dramas"), genre: "doramas", items: series.value.featured });
    }
    if (series.value.recent.length) {
      rows.push({ title: tr("Doramas recién agregados", "Recently added dramas"), genre: "doramas", ref: "tv", items: series.value.recent });
    }
  } else {
    log("home: doramas falló");
  }
  if (movies.status === "fulfilled") {
    if (movies.value.recent.length) {
      rows.push({ title: tr("Películas", "Movies"), genre: "peliculas", ref: "movies", items: movies.value.recent });
    }
  } else {
    log("home: películas falló");
  }
  if (!rows.length) throw kino.error("unavailable", "inicio sin resultados");
  return rows;
}

// ---- Catálogos (Ver más y Categorías) ---------------------------------------------------------

// ref "tv" = doramas, ref "movies" = películas; el cursor es el número de página del sitio.
export async function browse(ref, cursor) {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const r = String(ref || "");
  if (r !== "tv" && r !== "movies") throw kino.error("not_found", "catálogo desconocido");
  const n = Math.max(1, parseInt(cursor, 10) || 1);
  const path = (r === "tv" ? "/tvshows/" : "/movies/") + (n > 1 ? "page/" + n + "/" : "");
  const html = await getHtml(DM + path);
  const i = html.indexOf('id="archive-content"');
  const items = dmCards(i >= 0 ? html.slice(i) : html).slice(0, 100);
  const hasNext = html.indexOf("/page/" + (n + 1) + "/") !== -1;
  const page = { items };
  if (hasNext && items.length) page.next = String(n + 1);
  return page;
}

// Las fichas de la sección Categorías del plugin; cada una abre browse(ref, null).
export async function categories() {
  await null;
  const [tv, mv] = await Promise.allSettled([dmHomePage("/tvshows/"), dmHomePage("/movies/")]);
  const art = (res) => (res.status === "fulfilled" && res.value.recent[0]) ? res.value.recent[0].poster : undefined;
  const tiles = [
    { title: tr("Doramas", "Dramas"), ref: "tv", art: art(tv) },
    { title: tr("Películas", "Movies"), ref: "movies", art: art(mv) },
  ];
  return tiles.map((t) => (t.art ? t : { title: t.title, ref: t.ref }));
}

// ---- Búsqueda unificada -----------------------------------------------------------------------

export async function search(query) {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const q = stripTags(query && query.q).slice(0, 100);
  if (!q) return [];
  const enc = encodeURIComponent(q);
  const [dm, dx] = await Promise.allSettled([
    dmSearch(enc),
    dxSearch(enc),
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
  if (dx.status === "fulfilled") dx.value.forEach(add);
  if (!out.length && dm.status === "rejected" && dx.status === "rejected") throw dm.reason;
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
    items.push({
      id: "dm-" + clean.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80),
      ref: "dm|" + m[1],
      title: stripTags(m[2]).slice(0, 200),
      kind,
      year: year ? Number(year[1]) : undefined,
      poster,
      overview: desc ? stripTags(desc[1]).slice(0, 400) : undefined,
    });
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
    items.push({
      id: "dx-" + slug.replace(/[^a-z0-9-]+/gi, "-").slice(0, 80),
      ref: "dx|" + m[1],
      title: title.slice(0, 200),
      kind,
      poster: img ? img[1] : undefined,
    });
  }
  return items;
}

// ---- Episodios --------------------------------------------------------------------------------

export async function episodes(ref) {
  await null; // las validaciones de abajo pueden lanzar: nunca antes del primer await
  const raw = String(ref || "");
  if (!raw.startsWith("dm|") && !raw.startsWith("dx|")) throw kino.error("not_found", "referencia desconocida");
  const url = raw.slice(3);
  const html = await getHtml(url);
  return raw.startsWith("dm|") ? dmEpisodes(html, url) : dxEpisodes(html, url);
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

export async function resolve(ref) {
  await null; // las validaciones de abajo pueden lanzar: nunca antes del primer await
  const raw = String(ref || "");

  // Alternativa elegida por la persona: ya es una URL reproducible.
  if (raw.startsWith("dmurl|")) {
    const u = raw.slice(6);
    if (!/^https:\/\//.test(u)) throw kino.error("not_found", "alternativa inválida");
    return { url: u, mime: /\.m3u8(\?|$)/i.test(u) ? "application/x-mpegurl" : "video/mp4" };
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

  if (!raw.startsWith("dm|")) throw kino.error("not_found", "referencia desconocida");
  const html = await getHtml(raw.slice(3));

  const playable = [];
  const re = /<iframe[^>]*src=(['"])([^'"]+)\1[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const p = playableFromIframe(decodeEntities(m[2]));
    if (p && !playable.some((x) => x.url === p.url)) playable.push(p);
  }
  if (!playable.length) {
    throw kino.error("unavailable", "sin video directo", {
      userMessage: tr(
        "Este capítulo solo está en reproductores que el plugin no puede abrir. Prueba otra opción del capítulo o busca el título de nuevo.",
        "This episode is only on players the plugin can't open. Try another option or search the title again."
      ),
    });
  }
  const out = { url: playable[0].url, mime: playable[0].mime };
  if (playable.length > 1) {
    out.alternatives = playable.slice(1, 6).map((p, i) => ({
      label: tr("Opción ", "Option ") + (i + 2),
      ref: "dmurl|" + p.url,
    }));
  }
  return out;
}
