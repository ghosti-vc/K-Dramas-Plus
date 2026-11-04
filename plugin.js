// K Dramas Plus — Dorama Express para Kino
// apiVersion 9 · busca, Inicio, episodios, servidores por idioma, descargas
// v0.1.4: lista, búsqueda e Inicio solo muestran títulos de la colección "K-Dramas Latino" (ajuste, activado por defecto).
// v0.1.3: con "Latino" (por defecto) solo se usan servidores en español latino.
// v0.1.2: camino rápido (enlace .m3u8 directo, servidores en paralelo) antes del navegador oculto,
//         y recuerda el último servidor que funcionó.
// v0.1.1: lectura de páginas con respaldo por el navegador oculto (kino.browser.page)
//         cuando el sitio responde 503 o la pantalla "Just a moment…" de Cloudflare.

const BASE = "https://doramaexpress.com";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// ---------- textos según el idioma de Kino ----------
function t(es, en) {
  try {
    if (typeof kino !== "undefined" && kino.lang === "en-US") return en;
  } catch (e) {}
  return es;
}

// ---------- utilidades ----------
function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#039;|&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .trim();
}

function requestHeaders() {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": t("es-MX,es;q=0.9,en;q=0.8", "en-US,en;q=0.9"),
    "Referer": BASE + "/",
  };
}

// ¿es la pantalla de verificación de Cloudflare y no la página real?
function isCheckPage(html) {
  const s = String(html || "");
  if (s.length > 30000) return false;
  return /just a moment|cf-chl|checking your browser|un momento/i.test(s);
}

function browserCanReadPages() {
  try {
    return typeof kino.browser === "object" && kino.browser !== null &&
      typeof kino.browser.page === "function";
  } catch (e) {}
  return false;
}

// Lee una página del sitio.
// 1) kino.fetch con headers de navegador (una repetición si responde 503/429).
// 2) Si sigue fallando o llega la pantalla de Cloudflare: navegador oculto (kino.browser.page).
async function fetchPage(path, budgetMs) {
  const url = BASE + path;
  let status = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    let r = null;
    try {
      r = await kino.fetch(url, { headers: requestHeaders() });
    } catch (e) {
      r = null; // red o tiempo agotado: se intenta el respaldo
    }
    if (r) {
      if (r.status === 404) throw kino.error("not_found", "page " + path);
      if (r.ok && !isCheckPage(r.text)) return r.text;
      status = r.status;
      if ((r.status === 503 || r.status === 429) && attempt === 0) {
        await kino.sleep(800);
        continue;
      }
    }
    break;
  }

  // respaldo: navegador oculto (necesita "browser": "pages" en el manifiesto)
  if (browserCanReadPages()) {
    try {
      const page = await kino.browser.page(url, { timeoutMs: budgetMs || 12000 });
      if (page && typeof page.html === "string" && page.html.length > 500 && !isCheckPage(page.html)) {
        return page.html;
      }
    } catch (e) {
      // blocked / busy / timeout / not_allowed / rate_limited: no se insiste
    }
  }

  throw kino.error("unavailable", "http " + status, {
    userMessage: t(
      "El sitio no responde ahora mismo. Prueba de nuevo en unos minutos.",
      "The site is not responding right now. Try again in a few minutes."
    ),
  });
}

function refOf(arg) {
  if (arg && typeof arg === "object") return arg.ref;
  return arg;
}

// ---------- parser genérico de ítems (portada, búsquedas, archivos) ----------
function parseItems(html, kinds, limit) {
  const items = [];
  const seen = {};
  const re = /<a\s([^>]*href="https:\/\/doramaexpress\.com\/(serie|movies)\/([a-z0-9-]+)\/"[^>]*)>/g;
  let m;
  while ((m = re.exec(html)) !== null && items.length < limit) {
    const attrs = m[1];
    const section = m[2];
    const slug = m[3];
    if (kinds && kinds.indexOf(section) < 0) continue;
    if (seen[slug]) continue;
    seen[slug] = true;
    const after = html.substr(re.lastIndex, 600);
    const titleM = /title="([^"]*)"/.exec(attrs);
    const imgM = /src="(https:\/\/image\.tmdb\.org\/[^"]+)"/.exec(after) ||
      /src="(https:\/\/doramaexpress\.com\/wp-content\/uploads\/[^"]+)"/.exec(after);
    let title = titleM ? decode(titleM[1]) : "";
    if (!title) {
      const altM = /alt="([^"]*)"/.exec(after);
      if (altM) title = decode(altM[1]);
    }
    // quita sufijos de episodio ("Título: 1x6")
    title = title.replace(/:\s*\d+&#215;\d+\s*$/, "").replace(/:\s*\d+x\d+\s*$/, "").trim();
    if (!title) title = slug.replace(/-/g, " ");
    const it = {
      id: slug,
      ref: section + "/" + slug,
      title: title,
      kind: section === "movies" ? "movie" : "series",
    };
    if (imgM) it.poster = imgM[1];
    items.push(it);
  }
  return items;
}

function sectionOf(html, name) {
  const parts = html.split('sideranking-general-title">');
  for (let i = 1; i < parts.length; i++) {
    const head = parts[i].split("</div>")[0];
    if (head.indexOf(name) === 0) return parts[i];
  }
  return null;
}

// ---------- solo títulos en español latino ----------
// Se usa la colección "K-Dramas Latino" del sitio como lista de títulos que sí tienen audio latino.
const LATINO_PATH = "/coleccion/kdramas-latino/";
let latinoMemo = null;

function onlyLatinoTitles() {
  try {
    if (typeof kino.config === "object" && typeof kino.config.get === "function") {
      const v = kino.config.get("onlyLatinoTitles");
      if (v === false || v === "false") return false;
    }
  } catch (e) {}
  return true;
}

// página con kino.fetch simple: texto, "" si no existe (404) o null si falló
async function quickPage(path) {
  try {
    const r = await kino.fetch(BASE + path, { headers: requestHeaders() });
    if (r.status === 404) return "";
    if (r.ok && !isCheckPage(r.text)) return r.text;
  } catch (e) {}
  return null;
}

// { "serie/slug": true, ... } con toda la colección, o null si no se pudo leer completa
async function loadLatinoSet() {
  if (latinoMemo && Date.now() - latinoMemo.at < 1800000) return latinoMemo.refs;
  const refs = {};
  let complete = false;
  for (let start = 1; start <= 12 && !complete; start += 6) {
    const batch = [];
    for (let p = start; p < start + 6; p++) batch.push(LATINO_PATH + (p > 1 ? "page/" + p + "/" : ""));
    const pages = await Promise.all(batch.map(quickPage));
    for (let i = 0; i < pages.length; i++) {
      if (pages[i] === null) return null;
      const items = pages[i] ? parseItems(pages[i], ["serie", "movies"], 100) : [];
      if (!items.length) { complete = true; break; }
      items.forEach(function (it) { refs[it.ref] = true; });
    }
  }
  if (!complete || !Object.keys(refs).length) return null;
  latinoMemo = { at: Date.now(), refs: refs };
  return refs;
}

function prefetchLatino() {
  if (wantedLang() !== "latino" || !onlyLatinoTitles()) return null;
  return loadLatinoSet().catch(function () { return null; });
}

// deja solo los títulos de la colección latino; si no se pudo leer la colección, no filtra
async function keepLatino(items, pre) {
  if (!items || !items.length) return items;
  if (wantedLang() !== "latino" || !onlyLatinoTitles()) return items;
  let refs = null;
  try { refs = pre ? await pre : await loadLatinoSet(); } catch (e) { refs = null; }
  if (!refs) return items;
  let hasSerie = false;
  let hasMovie = false;
  Object.keys(refs).forEach(function (k) {
    if (k.indexOf("movies/") === 0) hasMovie = true; else hasSerie = true;
  });
  return items.filter(function (it) {
    const isMovie = it.ref.indexOf("movies/") === 0;
    if (isMovie && !hasMovie) return true;   // la colección no trae películas: no se filtran
    if (!isMovie && !hasSerie) return true;
    return !!refs[it.ref];
  });
}

// ---------- search ----------
export async function search(arg) {
  await Promise.resolve();
  const query = (arg && typeof arg === "object" ? arg.q : arg) || "";
  if (!query.trim()) return [];
  // search tiene 15 s en total: el navegador oculto se limita a ~9 s
  const pre = prefetchLatino();
  const html = await fetchPage("/?s=" + encodeURIComponent(query.trim()), 9000);
  const all = parseItems(html, ["serie", "movies"], 100);
  const items = await keepLatino(all, pre);
  if (!items.length) throw kino.error("not_found", "sin resultados", {
    userMessage: all.length
      ? t("Encontré ese título, pero no está en español latino.", "I found that title, but it is not in Latin Spanish.")
      : t("No encontré nada con ese nombre.", "I found nothing by that name."),
  });
  return items;
}

async function fetchHomeHtml() {
  try {
    return await fetchPage("/", 12000);
  } catch (e) {
    // solo si la portada no existe se prueba /home/ (con un 503 no hay tiempo para otra lectura)
    if (e && e.code === "not_found") return await fetchPage("/home/", 12000);
    throw e;
  }
}

// ---------- home ----------
export async function home() {
  const pre = prefetchLatino();
  const html = await fetchHomeHtml();
  const rows = [];
  const destacadas = sectionOf(html, "Series Destacadas");
  if (destacadas) {
    const items = await keepLatino(parseItems(destacadas, ["serie"], 30), pre);
    if (items.length) rows.push({
      id: "destacadas",
      title: t("Series destacadas", "Featured series"),
      genre: "doramas",
      items: items,
    });
  }
  const dramas = sectionOf(html, "Últimos dramas");
  if (dramas) {
    const items = await keepLatino(parseItems(dramas, ["serie"], 30), pre);
    if (items.length) rows.push({
      id: "dramas",
      title: t("Doramas nuevos", "New dramas"),
      genre: "doramas",
      ref: "serie",
      items: items,
    });
  }
  const peliculas = sectionOf(html, "Últimas películas");
  if (peliculas) {
    const items = await keepLatino(parseItems(peliculas, ["movies"], 30), pre);
    if (items.length) rows.push({
      id: "peliculas",
      title: t("Películas nuevas", "New movies"),
      genre: "peliculas",
      ref: "movies",
      items: items,
    });
  }
  // refuerzo: si las secciones cambiaron de nombre, usa lo que haya en la página
  if (!rows.length) {
    const items = await keepLatino(parseItems(html, ["serie", "movies"], 30), pre);
    if (items.length) rows.push({
      id: "destacadas",
      title: t("Destacados de Dorama Express", "Dorama Express picks"),
      genre: "doramas",
      items: items,
    });
  }
  return rows;
}

// ---------- browse ("Ver más" de las filas) ----------
export async function browse(arg, cursor) {
  await Promise.resolve();
  const ref = refOf(arg) || arg;
  if (!ref || !/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(ref)) {
    throw kino.error("not_found", "ref " + ref);
  }
  const page = cursor ? parseInt(cursor, 10) : 1;
  if (!(page >= 1)) throw kino.error("not_found", "cursor " + cursor);
  const path = "/" + ref + "/" + (page > 1 ? "page/" + page + "/" : "");
  const html = await fetchPage(path, 12000);
  const raw = parseItems(html, ["serie", "movies"], 60);
  const items = await keepLatino(raw);
  const out = { items: items };
  if (raw.length >= 20) out.next = String(page + 1);
  return out;
}

// ---------- categorías (pestaña Categorías) ----------
// Esta función NO lee páginas (Kino no deja usar el navegador oculto aquí).
export async function categories() {
  await Promise.resolve();
  return [
    { id: "series", title: t("Series", "Series"), ref: "serie", genre: "doramas" },
    { id: "movies", title: t("Películas", "Movies"), ref: "movies", genre: "peliculas" },
    { id: "finalizados", title: t("Doramas finalizados", "Completed dramas"), ref: "estado/finalizado", genre: "doramas" },
    { id: "latino", title: t("K-Dramas Latino", "K-Dramas Latino"), ref: "coleccion/kdramas-latino", genre: "doramas" },
  ];
}

// ---------- episodes ----------
const GENRE_MAP = {
  "action-adventure": "accion",
  "accion": "accion",
  "action": "accion",
  "aventura": "aventura",
  "adventure": "aventura",
  "animacion": "animacion",
  "animation": "animacion",
  "sci-fi-fantasy": "ciencia-ficcion",
  "sci-fi": "ciencia-ficcion",
  "ciencia-ficcion": "ciencia-ficcion",
  "comedia": "comedia",
  "comedy": "comedia",
  "crimen": "crimen",
  "crime": "crimen",
  "drama": "drama",
  "familia": "familia",
  "family": "familia",
  "fantasia": "fantasia",
  "fantasy": "fantasia",
  "historia": "historia",
  "history": "historia",
  "misterio": "misterio",
  "mystery": "misterio",
  "musical": "musical",
  "romance": "romance",
  "romantico": "romance",
  "suspense": "suspenso",
  "suspenso": "suspenso",
  "thriller": "suspenso",
  "terror": "terror",
  "horror": "terror",
};

export async function episodes(arg) {
  await Promise.resolve();
  const ref = refOf(arg) || arg;
  if (!ref || !/^serie\/[a-z0-9-]+$/.test(ref)) {
    throw kino.error("not_found", "ref " + ref);
  }
  const html = await fetchPage("/" + ref + "/", 12000);

  // info de la serie
  const ogTitle = /<meta property="og:title" content="([^"]*)"/.exec(html);
  const ogDesc = /<meta property="og:description" content="([^"]*)"/.exec(html);
  const posterM = /class="zt-det-poster-img" src="([^"]+)"/.exec(html) ||
    /src="(https:\/\/image\.tmdb\.org\/t\/p\/(w500|original)\/[^"]+)"/.exec(html);
  const series = {};
  if (ogTitle) {
    let title = decode(ogTitle[1]);
    title = title.replace(/^Ver\s+/i, "").split(/\s+En\s+Español/)[0].split(/\s+-\s+DORAMA/)[0].trim();
    if (title) series.title = title;
  }
  if (ogDesc) series.overview = decode(ogDesc[1]).split(/\.\s*Ver\s+online/)[0] + ".";
  const yearM = ogDesc ? /\((\d{4})\)/.exec(ogDesc[1]) : null;
  if (yearM) series.year = yearM[1];
  if (posterM) series.poster = posterM[1];
  const genres = [];
  const gRe = /href="https:\/\/doramaexpress\.com\/genre\/([a-z0-9-]+)\/"/g;
  let g;
  while ((g = gRe.exec(html)) !== null) {
    const mapped = GENRE_MAP[g[1]];
    if (mapped && genres.indexOf(mapped) < 0 && genres.length < 5) genres.push(mapped);
  }
  if (genres.length) series.genres = genres;

  // capítulos
  const episodes = [];
  const seen = {};
  const re = /ypp-ep-card" data-ep-num="(\d+)" data-title="([^"]*)" onclick="window\.location\.href='https:\/\/doramaexpress\.com\/episodio\/([a-z0-9-]+)\/'/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[3];
    const parts = /-(\d+)x(\d+)$/.exec(slug);
    if (!parts || seen[slug]) continue;
    seen[slug] = true;
    episodes.push({
      season: parseInt(parts[1], 10),
      number: parseInt(parts[2], 10),
      ref: "episodio/" + slug,
    });
  }
  episodes.sort(function (a, b) {
    return a.season - b.season || a.number - b.number;
  });

  if (!episodes.length) {
    throw kino.error("not_found", "sin capítulos", {
      userMessage: t("No encontré capítulos de esta serie.", "I found no episodes for this series."),
    });
  }
  return { series: series, episodes: episodes };
}

// ---------- servidores de una página (episodio o película) ----------
function parseServers(html) {
  const servers = [];
  const marks = [];
  const langRe = /color:\s*#f8fafc;">(Subtitulado|Latino)</g;
  let l;
  while ((l = langRe.exec(html)) !== null) marks.push({ pos: l.index, lang: l[1] });

  const re = /class="(ypp-card-element[^"]*)"([^>]*)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const cls = m[1];
    const attrs = m[2];
    const urlM = /data-url="([^"]+)"/.exec(attrs);
    if (!urlM) continue; // tarjetas de anuncios
    const locked = /data-locked="1"/.test(attrs) || cls.indexOf("vip") >= 0;
    const after = html.substr(re.lastIndex, 400);
    const nameM = /ypp-card-title">([^<]+)</.exec(after);
    let lang = "Latino";
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].pos < m.index) lang = marks[i].lang;
    }
    servers.push({
      lang: lang,
      name: nameM ? decode(nameM[1]) : t("Servidor", "Server"),
      url: urlM[1],
      free: !locked,
    });
  }
  return servers;
}

async function captureServer(url, timeoutMs) {
  const page = await kino.browser.capture(url, { timeoutMs: timeoutMs || 12000 });
  const first = page.media && page.media[0];
  if (!first || !first.url) throw kino.error("unavailable", "captura vacía");
  const out = { url: first.url };
  if (first.mime) out.mime = first.mime;
  if (first.headers) out.headers = first.headers;
  const subs = page.subtitles || [];
  if (subs.length) {
    out.subtitles = subs.slice(0, 5).map(function (s) { return { lang: "es", url: s.url }; });
  }
  return out;
}

// ---------- camino rápido: sacar el .m3u8 del embed sin abrir el navegador ----------
function cleanText(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\\u0026/g, "&")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");
}

// desempaqueta el "eval(function(p,a,c,k,e,d)…" que usan muchos reproductores
function unpackAll(src) {
  let out = "";
  const re = /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  let m;
  let n = 0;
  while ((m = re.exec(src)) !== null && n < 3) {
    n++;
    try {
      const a = parseInt(m[2], 10);
      let c = parseInt(m[3], 10);
      const k = m[4].split("|");
      const p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      const base = function (num) {
        const hi = num < a ? "" : base(parseInt(num / a, 10));
        const lo = num % a;
        return hi + (lo > 35 ? String.fromCharCode(lo + 29) : lo.toString(36));
      };
      const d = {};
      while (c--) d[base(c)] = k[c] || base(c);
      out += "\n" + p.replace(/\b\w+\b/g, function (w) { return d[w] || w; });
    } catch (e) {}
  }
  return out;
}

function findHls(text) {
  const raw = String(text);
  const all = cleanText(raw + "\n" + unpackAll(raw));
  const m = /https?:\/\/[^"'\s<>\\{}]+?\.m3u8(?:\?[^"'\s<>\\{}]*)?/.exec(all);
  return m ? m[0] : null;
}

// devuelve { url, headers } si el embed deja ver el .m3u8 y este responde bien; si no, null
async function fastExtract(embedUrl) {
  const r = await kino.fetch(embedUrl, { headers: requestHeaders() });
  if (!r || !r.ok) return null;
  const hls = findHls(r.text);
  if (!hls) return null;
  const headers = { "User-Agent": UA, "Referer": embedUrl };
  const om = /^(https?:\/\/[^\/]+)/.exec(embedUrl);
  if (om) headers["Origin"] = om[1];
  const chk = await kino.fetch(hls, { headers: headers });
  if (!chk || !chk.ok || !/^\s*#EXTM3U/.test(String(chk.text))) return null;
  return { url: hls, headers: headers };
}

// prueba varios servidores a la vez (máximo ~5 s en total)
async function fastScan(list) {
  const results = [];
  const jobs = list.map(function (s, i) {
    results[i] = null;
    return fastExtract(s.url).then(function (r) { results[i] = r; }).catch(function () {});
  });
  await Promise.race([Promise.all(jobs), kino.sleep(5000)]);
  return results;
}

// ---------- recordar el último servidor que funcionó ----------
async function recalledServer() {
  try {
    const v = await kino.storage.get("lastServer");
    if (typeof v === "string") return v;
    if (v && typeof v.value === "string") return v.value;
  } catch (e) {}
  return "";
}

async function rememberServer(name) {
  try {
    await kino.storage.set("lastServer", String(name), { ttlMs: 2592000000 });
  } catch (e) {}
}

// idioma preferido de la persona ("latino", "sub" o "todos")
function wantedLang() {
  try {
    if (typeof kino.config === "object" && typeof kino.config.get === "function") {
      return kino.config.get("lang") || "latino";
    }
  } catch (e) {}
  return "latino";
}

// ---------- resolve ----------
export async function resolve(arg) {
  await Promise.resolve();
  const ref = refOf(arg) || arg;
  if (!ref) throw kino.error("not_found", "ref vacío");
  const parts = String(ref).split("|");
  const pageRef = parts[0];
  const pickIdx = parts.length > 1 ? parseInt(parts[1], 10) : -1;
  if (!/^(episodio|movies)\/[a-z0-9-]+$/.test(pageRef)) {
    throw kino.error("not_found", "ref " + ref);
  }
  const html = await fetchPage("/" + pageRef + "/", 12000);
  let servers = parseServers(html).filter(function (s) { return s.free; });
  if (!servers.length) {
    throw kino.error("unavailable", "sin servidores libres", {
      userMessage: t("Ahora mismo no hay servidores gratuitos para este título.", "There are no free servers for this title right now."),
    });
  }

  // filtro por idioma preferido
  const pref = wantedLang();
  if (pref === "latino") {
    // solo español latino: si no hay, no se cae a subtitulado
    servers = servers.filter(function (s) { return s.lang === "Latino"; });
    if (!servers.length) {
      throw kino.error("unavailable", "sin servidores latino", {
        userMessage: t("Este título no tiene audio en español latino por ahora.", "This title has no Latin Spanish audio right now."),
      });
    }
  } else if (pref === "sub") {
    const soloSub = servers.filter(function (s) { return s.lang === "Subtitulado"; });
    if (soloSub.length) servers = soloSub;
  }

  function labelOf(i) { return servers[i].lang + " · " + servers[i].name; }

  function withAlts(stream, current) {
    const alts = [];
    for (let j = 0; j < servers.length && alts.length < 8; j++) {
      if (j === current) continue;
      alts.push({ label: labelOf(j), ref: pageRef + "|" + j });
    }
    if (alts.length) stream.alternatives = alts;
    return stream;
  }

  // copia perezosa: la persona eligió un servidor concreto
  if (pickIdx >= 0) {
    const pick = servers[pickIdx];
    if (!pick) throw kino.error("not_found", "servidor " + pickIdx);
    let stream = null;
    try { stream = await fastExtract(pick.url); } catch (e) { stream = null; }
    if (!stream) stream = await captureServer(pick.url, 18000);
    stream.label = labelOf(pickIdx);
    await rememberServer(pick.name);
    return stream;
  }

  // orden de prueba: primero el último servidor que funcionó (los índices de las copias no cambian)
  const last = await recalledServer();
  const order = [];
  servers.forEach(function (s, i) { if (last && s.name === last) order.push(i); });
  servers.forEach(function (s, i) { if (order.indexOf(i) < 0) order.push(i); });

  // 1) camino rápido: hasta 6 servidores a la vez, sin navegador oculto
  const scanIdx = order.slice(0, 6);
  const fast = await fastScan(scanIdx.map(function (i) { return servers[i]; }));
  for (let q = 0; q < scanIdx.length; q++) {
    if (fast[q]) {
      const i = scanIdx[q];
      const stream = fast[q];
      stream.label = labelOf(i);
      await rememberServer(servers[i].name);
      return withAlts(stream, i);
    }
  }

  // 2) respaldo: navegador oculto, hasta 3 servidores, 12 s cada uno
  const tries = Math.min(3, order.length);
  for (let q = 0; q < tries; q++) {
    const i = order[q];
    try {
      const stream = await captureServer(servers[i].url, 12000);
      stream.label = labelOf(i);
      await rememberServer(servers[i].name);
      return withAlts(stream, i);
    } catch (e) {
      const code = e && e.code;
      if ((code === "blocked" || code === "timeout" || code === "browser_unavailable" || code === "busy") && q < tries - 1) continue;
      throw e;
    }
  }
  throw kino.error("unavailable", "ningún servidor respondió", {
    userMessage: t("Ningún servidor respondió. Prueba de nuevo o elige otro servidor.", "No server answered. Try again or pick another server."),
  });
}
