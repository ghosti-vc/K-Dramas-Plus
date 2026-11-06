// Plugin de Kino: Doramas en audio latino (búsqueda unificada + Inicio).
// Fuentes:
//  - "dm|" Doramed Play (www.doramedplay.com): inicio, búsqueda, episodios y reproducción (MP4 directo).
//  - "dx|" Dorama Express (doramaexpress.com): búsqueda y episodios; su video está detrás de
//    candados del sitio (temporizador, VIP) que el plugin no salta: al reproducir avisa.
// Pendiente: "pn|" Pandrama (bloquea el acceso automatizado).

const DM = "https://www.doramedplay.com";
const DX = "https://doramaexpress.com";
const MAX_RESULTS = 100;
const HOME_ROW = 20;   // títulos por fila en Inicio
const CAT_VIEW = 60;   // títulos que carga cada tanda de "Ver más" y de Categorías
const CAT_MAX = 100;   // tope de Kino por página

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
      userMessage: tr("No se pudo abrir " + host + ": " + why, "Could not open " + host + ": " + why),
    });
  }
  log("fetch status=" + r.status + " ok=" + r.ok);
  if (!r.ok) {
    const um = {
      userMessage: tr(
        host + " respondió con el error " + r.status + ".",
        host + " answered with error " + r.status + "."
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
    items.push({
      id: "dm-" + clean.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80),
      ref: "dm|" + a[1],
      title: title.slice(0, 200),
      kind: a[2] === "movies" ? "movie" : "series",
      year: yearMatch ? Number(yearMatch[1]) : undefined,
      poster: img ? bigPoster(img[1]) : undefined,
      rating: rating > 0 && rating <= 10 ? rating : undefined,
    });
  }
  return items;
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
  const [series, movies] = await Promise.allSettled([
    dmHomePage("/tvshows/"),
    dmHomePage("/movies/"),
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
  log("home filas=" + rows.length + " items=" + rows.map((r) => r.items.length).join(","));
  if (!rows.length) throw kino.error("unavailable", "inicio sin resultados");
  return rows;
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

// ref "tv" = doramas, ref "movies" = películas; el cursor es el número de página del sitio.
// Cada tanda junta varias páginas del sitio hasta llegar a unos 60 títulos (máximo 100).
export async function browse(ref, cursor) {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const r = String(ref || "");
  if (r !== "tv" && r !== "movies") throw kino.error("not_found", "catálogo desconocido");
  const n = Math.max(1, parseInt(cursor, 10) || 1);
  const items = [];
  const seen = new Set();
  let p = n;
  let last = n - 1;
  let hasNext = true;
  let rounds = 0;
  while (hasNext && items.length < CAT_VIEW && rounds < 3) {
    rounds++;
    const batch = await Promise.allSettled([0, 1, 2].map((k) => dmArchivePage(r, p + k)));
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
  const [tv, mv] = await Promise.allSettled([dmHomePage("/tvshows/"), dmHomePage("/movies/")]);
  const art = (res) => (res.status === "fulfilled" && res.value.recent[0]) ? res.value.recent[0].poster : undefined;
  const tiles = [
    { id: "doramas", title: tr("Doramas", "Dramas"), ref: "tv", art: art(tv) },
    { id: "peliculas", title: tr("Películas", "Movies"), ref: "movies", art: art(mv) },
  ];
  return tiles.map((t) => (t.art ? t : { id: t.id, title: t.title, ref: t.ref }));
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
    const extra = found.length ? " [" + found.slice(0, 3).join(", ") + "]" : "";
    throw kino.error("unavailable", "sin video directo", {
      userMessage: tr(
        "Este capítulo solo está en reproductores que el plugin no puede abrir. Prueba otra opción del capítulo o busca el título de nuevo." + extra,
        "This episode is only on players the plugin can't open. Try another option or search the title again." + extra
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
