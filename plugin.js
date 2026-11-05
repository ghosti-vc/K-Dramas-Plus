// Plugin de Kino: Doramas en audio latino (búsqueda unificada).
// Fuentes:
//  - "dm|" Doramed Play (www.doramedplay.com): búsqueda, episodios y reproducción (MP4 directo).
//  - "dx|" Dorama Express (doramaexpress.com): búsqueda y episodios; su video está detrás de
//    candados del sitio (temporizador, VIP) que el plugin no salta: al reproducir avisa.
// Pendiente: "pn|" Pandrama (bloquea el acceso automatizado).

const DM = "https://www.doramedplay.com";
const DX = "https://doramaexpress.com";
const MAX_RESULTS = 100;

function log(...args) {
  try { kino.log(...args); } catch { /* el registro no debe romper nada */ }
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
  if (!r.ok) throw kino.error("unavailable", "el sitio respondió " + r.status);
  return r.text();
}

// ---- Búsqueda unificada -----------------------------------------------------------------------

export async function search(query) {
  const q = stripTags(query && query.q).slice(0, 100);
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
    let img = /<img src="([^"]+)"/.exec(b);
    if (img) img = img[1].replace(/-\d+x\d+\.(jpg|jpeg|png|webp)$/i, ".$1");
    const desc = /<div class="contenido"><p>([\s\S]*?)<\/p><\/div>/.exec(b);
    const clean = m[1].replace(/^https:\/\/www\.doramedplay\.com\//, "/");
    items.push({
      id: "dm-" + clean.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80),
      ref: "dm|" + m[1],
      title: stripTags(m[2]).slice(0, 200),
      kind,
      year: year ? year[1] : undefined,
      poster: img ? img[1] : undefined,
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
  let poster = /class=(['"])poster\1[^>]*>\s*<img[^>]*src=(['"])([^'"]+)\2/i.exec(html);
  if (!poster) poster = /property=(['"])og:image\1[^>]*content=(['"])([^'"]+)\2/i.exec(html) || /<meta property="og:image" content="([^"]+)"/.exec(html);

  // Dooplay: <div class='numerando'>1 - 2</div><div class='episodiotitle'><a href='...'>Episodio 2</a>
  const eps = [];
  const re = /class=(['"])numerando\1>([^<]*)<\/div>\s*<div class=\1episodiotitle\1>\s*<a href=(['"])([^'"]+)\3[^>]*>([^<]*)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const num = m[2].split("-").map((x) => parseInt(x.trim(), 10));
    if (!/^https:\/\/www\.doramedplay\.com\/episodes\//.test(m[4])) continue;
    eps.push({
      season: Number.isInteger(num[0]) ? num[0] : 1,
      number: Number.isInteger(num[1]) ? num[1] : eps.length + 1,
      ref: "dm|" + m[4],
      title: stripTags(m[5]) || ("Episodio " + (num[1] || eps.length + 1)),
    });
  }
  if (!eps.length) throw kino.error("not_found", "no se encontró la lista de episodios");
  return {
    series: { title: title ? stripTags(title[1]) : url, poster: poster ? poster[1] : undefined },
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
      title: "Episodio " + number,
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
      u = mm ? decodeURIComponent(mm[1]) : "";
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
  if (raw.startsWith("dmurl|")) return { url: raw.slice(6), mime: /\.(m3u8)(\?|$)/i.test(raw) ? "application/x-mpegurl" : "video/mp4" };

  // Dorama Express: su video está detrás de candados del sitio (espera, VIP, ruleta).
  // El plugin no los salta; busca la misma serie en Doramed Play en su lugar.
  if (raw.startsWith("dx|")) {
    throw kino.error("unavailable", "dorama express con candado", {
      userMessage: "Dorama Express solo reproduce en su web, con esperas y anuncios. Busca el título de nuevo: si está en Doramed Play, aquí sí se reproduce.",
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
      userMessage: "Este capítulo solo está en reproductores que el plugin no puede abrir. Prueba otra opción del capítulo o busca el título de nuevo.",
    });
  }
  const out = { url: playable[0].url, mime: playable[0].mime };
  if (playable.length > 1) {
    out.alternatives = playable.slice(1, 6).map((p, i) => ({ label: "Opción " + (i + 2), ref: "dmurl|" + p.url }));
  }
  return out;
}