// K Dramas Plus — Dorama Express para Kino
// apiVersion 9 · busca, Inicio, episodios, servidores por idioma, descargas
// v0.1.1: lectura de páginas con respaldo por el navegador oculto (kino.browser.page)
//         cuando el sitio responde 503 o la pantalla "Just a moment…" de Cloudflare.

const BASE = "https://doramaexpress.com";

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
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
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

// ---------- search ----------
export async function search(arg) {
  await Promise.resolve();
  const query = (arg && typeof arg === "object" ? arg.q : arg) || "";
  if (!query.trim()) return [];
  // search tiene 15 s en total: el navegador oculto se limita a ~9 s
  const html = await fetchPage("/?s=" + encodeURIComponent(query.trim()), 9000);
  const items = parseItems(html, ["serie", "movies"], 100);
  if (!items.length) throw kino.error("not_found", "sin resultados", {
    userMessage: t("No encontré nada con ese nombre.", "I found nothing by that name."),
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
  const html = await fetchHomeHtml();
  const rows = [];
  const destacadas = sectionOf(html, "Series Destacadas");
  if (destacadas) {
    const items = parseItems(destacadas, ["serie"], 30);
    if (items.length) rows.push({
      id: "destacadas",
      title: t("Series destacadas", "Featured series"),
      genre: "doramas",
      items: items,
    });
  }
  const dramas = sectionOf(html, "Últimos dramas");
  if (dramas) {
    const items = parseItems(dramas, ["serie"], 30);
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
    const items = parseItems(peliculas, ["movies"], 30);
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
    const items = parseItems(html, ["serie", "movies"], 30);
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
  const items = parseItems(html, ["serie", "movies"], 60);
  const out = { items: items };
  if (items.length >= 20) out.next = String(page + 1);
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

async function captureServer(url) {
  const page = await kino.browser.capture(url, { timeoutMs: 18000 });
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
  // resolve tiene 75 s con el navegador aprobado; se dejan ~12 s para leer la página
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
    const soloLatino = servers.filter(function (s) { return s.lang === "Latino"; });
    if (soloLatino.length) servers = soloLatino;
  } else if (pref === "sub") {
    const soloSub = servers.filter(function (s) { return s.lang === "Subtitulado"; });
    if (soloSub.length) servers = soloSub;
  }

  // copia perezosa: la persona eligió un servidor concreto
  if (pickIdx >= 0) {
    const pick = servers[pickIdx];
    if (!pick) throw kino.error("not_found", "servidor " + pickIdx);
    const stream = await captureServer(pick.url);
    stream.label = pick.lang + " · " + pick.name;
    return stream;
  }

  // primera pasada: prueba hasta 3 servidores
  const tries = Math.min(3, servers.length);
  for (let i = 0; i < tries; i++) {
    try {
      const stream = await captureServer(servers[i].url);
      stream.label = servers[i].lang + " · " + servers[i].name;
      const alts = [];
      for (let j = 0; j < servers.length && alts.length < 8; j++) {
        if (j === i) continue;
        alts.push({ label: servers[j].lang + " · " + servers[j].name, ref: pageRef + "|" + j });
      }
      if (alts.length) stream.alternatives = alts;
      return stream;
    } catch (e) {
      const code = e && e.code;
      if ((code === "blocked" || code === "timeout" || code === "browser_unavailable" || code === "busy") && i < tries - 1) continue;
      throw e;
    }
  }
  throw kino.error("unavailable", "ningún servidor respondió", {
    userMessage: t("Ningún servidor respondió. Prueba de nuevo o elige otro servidor.", "No server answered. Try again or pick another server."),
  });
}
