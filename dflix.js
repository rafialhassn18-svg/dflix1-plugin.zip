// DFLIX scraper for Nuvio (Legacy tpk / plugin runtime).
// Movies: CineplexBD + ShowTime.  Series: ShowTime only (CineplexBD series not supported).

var CX = "http://cineplexbd.net";
var ST = "http://10.100.100.10";
var UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
var DEFAULT_TMDB_KEY = "7720837cae51542c691532949b360141"; // same default key the DFLIX app uses
var VIDX = /\.(mp4|mkv|avi|m4v|mov|webm|ts|mpg|wmv|flv)(\?|$)/i;
var QUALITY = /(2160p|4k|1080p|720p|480p|WEB-?DL|WEBRip|BluRay|HDRip|DVDRip|HDTV|CAMRip|HDCAM)/i;

var DBG = [];

function tmdbKey() {
  var s = typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS ? SCRAPER_SETTINGS : {};
  return (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY) || s.tmdbKey || DEFAULT_TMDB_KEY;
}

function getText(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function fix(u) {
  return String(u)
    .replace(/%(?![0-9A-Fa-f]{2})/g, "%25")
    .replace(/[ \[\]"<>^`{|}\\]/g, function (c) { return encodeURIComponent(c); })
    .replace(/#/g, "%23");
}

function absUrl(h, base) {
  h = String(h || "");
  if (/^https?:/i.test(h)) return h;
  base = base || CX + "/";
  var origin = (base.match(/^https?:\/\/[^\/]+/i) || [""])[0];
  if (h.charAt(0) === "/") return origin + h;
  return base.replace(/[^\/]*$/, "") + h.replace(/^\.\//, "");
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function baseTitle(s) {
  var cut = String(s || "").split(/[\(\[]|\b(?:19|20)\d{2}\b|2160p|1080p|720p|480p|WEB-?DL|BluRay|HDRip/i)[0];
  return norm(cut);
}

function yearOf(s) {
  var m = String(s || "").match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function titleMatches(title, year, wantTitle, wantYear) {
  if (baseTitle(title) !== norm(wantTitle)) return false;
  var y = Number(year) || yearOf(title);
  if (wantYear && y && Math.abs(y - wantYear) > 1) return false;
  return true;
}

function episodeMatches(name, season, episode) {
  var re = new RegExp("(?:s0*" + season + "[\\s._-]*e0*" + episode + "(?!\\d))|(?:\\b0*" + season + "x0*" + episode + "(?!\\d))", "i");
  return re.test(name);
}

function cxVideos(html, base) {
  var clean = html.replace(/\\\//g, "/");
  var out = clean.match(/https?:\/\/[^"'\s<>\\]+?\.(?:mp4|mkv|m3u8|avi|webm|mov)(?:\?[^"'\s<>\\]*)?/gi) || [];
  var re = /["']([^"'<>]+?\.(?:mp4|mkv|m3u8|avi|webm|mov)(?:\?[^"'<>]*)?)["']/gi, m;
  while ((m = re.exec(clean))) out.push(absUrl(m[1], base));
  var seen = {};
  return out.map(fix).filter(function (u) { if (seen[u]) return false; seen[u] = 1; return true; });
}

function makeStream(label, url, title, withHeaders) {
  var q = (String(title).match(QUALITY) || [])[1] || "Unknown";
  var s = { name: label, title: title, quality: /^\d+p$/i.test(q) ? q.toLowerCase() : q.toUpperCase(), url: url };
  if (withHeaders) s.headers = { "User-Agent": UA };
  return s;
}

function getInfo(tmdbId, mediaType) {
  var kind = mediaType === "movie" ? "movie" : "tv";
  return getText("https://api.themoviedb.org/3/" + kind + "/" + tmdbId + "?api_key=" + tmdbKey()).then(function (t) {
    var j = JSON.parse(t);
    return { name: j.title || j.name || "", year: yearOf(j.release_date || j.first_air_date) };
  });
}

function searchCx(title) {
  return getText(CX + "/search_ajax.php?q=" + encodeURIComponent(title) + "&limit=30")
    .then(function (t) {
      var j = JSON.parse(t);
      var list = (j.results || j || []).map(function (i) {
        var isSeries = String(i.type || "").toLowerCase() === "series";
        return { id: i.id, series: isSeries, title: i.title || "", year: i.year ? Number(i.year) : null,
                 href: absUrl(i.url || (isSeries ? "tview.php?id=" : "view.php?id=") + i.id), category: i.category || "" };
      });
      DBG.push("CX: " + list.length + " result");
      return list;
    })
    .catch(function (e) { DBG.push("CX error: " + (e && e.message)); return []; });
}

// ShowTime search page -> { files: [{title,url,size}], dirs: [{title,url}] }
function searchSt(title) {
  return getText(ST + "/movie/search?search=" + encodeURIComponent(title))
    .then(function (html) {
      var $ = cheerio.load(html), files = [], dirs = [];
      $(".single_movie").toArray().forEach(function (el) {
        var m = $(el);
        var ttl = (m.find("figcaption a").first().text() || "").replace(/\s+/g, " ").trim();
        var dl = m.find("figcaption p a[href]").first().attr("href") || "";
        if (!ttl || !dl) return;
        var url = fix(absUrl(dl, ST + "/"));
        if (VIDX.test(dl)) files.push({ title: ttl, url: url, size: (m.find("h6").first().text() || "").trim() });
        else if (/\/$/.test(dl.split("?")[0]) && /SERIES|SHOW/i.test(dl)) dirs.push({ title: ttl, url: url });
      });
      DBG.push("ST: " + files.length + " file, " + dirs.length + " folder");
      return { files: files, dirs: dirs };
    })
    .catch(function (e) { DBG.push("ST error: " + (e && e.message)); return { files: [], dirs: [] }; });
}

// one folder listing -> its video files and sub-folders
function dirScan(url) {
  return getText(url)
    .then(function (html) {
      var $ = cheerio.load(html), base = fix(url.replace(/\/?$/, "/")), files = [], subs = [], seen = {};
      $("a[href]").toArray().forEach(function (el) {
        var h = $(el).attr("href") || "";
        if (!h || /^(\.\.?\/|\?|#|mailto:|javascript:)/i.test(h)) return;
        var u = /^https?:/i.test(h) ? h : h.charAt(0) === "/" ? (base.match(/^https?:\/\/[^\/]+/i) || [""])[0] + h : base + h.replace(/^\.?\//, "");
        u = u.split("#")[0];
        if (base.indexOf(u.replace(/\/?$/, "/")) === 0 || u.indexOf(base) !== 0 || seen[u]) return;
        seen[u] = 1;
        var rel = u.slice(base.length), name = rel;
        try { name = decodeURIComponent(rel.split("?")[0]); } catch (e) {}
        if (VIDX.test(rel)) files.push({ url: u, name: name });
        else if (/\/$/.test(rel.split("?")[0])) subs.push({ url: u, name: name.replace(/\/$/, "") });
      });
      return { files: files, subs: subs };
    })
    .catch(function () { return null; });
}

function movieStreams(info) {
  return Promise.all([searchCx(info.name), searchSt(info.name)]).then(function (res) {
    var out = [];
    var cxHits = res[0].filter(function (h) { return !h.series && titleMatches(h.title, h.year, info.name, info.year); }).slice(0, 3);
    res[1].files.filter(function (h) { return titleMatches(h.title, null, info.name, info.year); }).forEach(function (h) {
      out.push(makeStream("ShowTime", h.url, h.title + (h.size ? " · " + h.size : ""), false));
    });
    return Promise.all(cxHits.map(function (hit) {
      return getText(hit.href)
        .then(function (html) {
          cxVideos(html, hit.href).forEach(function (u) {
            out.push(makeStream("CineplexBD", u, hit.title + (hit.category ? " · " + hit.category : ""), true));
          });
        })
        .catch(function () {});
    })).then(function () { return out; });
  });
}

function stripSeason(t) {
  return String(t || "").split(/\b(?:season|seasons|complete|s\d{1,2}(?:e\d+)?)\b/i)[0];
}

function noThe(s) { return s.replace(/^the /, ""); }

function seriesNameMatches(folderTitle, wantName) {
  var bt = noThe(baseTitle(stripSeason(folderTitle))), want = noThe(norm(wantName));
  return bt === want || bt.indexOf(want + " ") === 0;
}

// season folder (or a pack with season sub-folders) -> [{s, n, url, name}] like the DFLIX app builds it
function stEpisodes(hit) {
  var sm = String(hit.title).match(/Season\s*(\d+)/i), ds = sm ? String(+sm[1]) : "1";
  return dirScan(hit.url).then(function (r) {
    if (!r) return [];
    var list = r.files.slice();
    var subs = r.subs.slice(0, 16);
    if (list.length || !subs.length) return list;
    return subs.reduce(function (p, sf, k) {
      return p.then(function () {
        return dirScan(sf.url).then(function (q) {
          var nm = sf.name.match(/(?:season|s)[ ._-]*(\d+)/i) || sf.name.match(/(\d+)/);
          var ss = nm ? String(+nm[1]) : String(k + 1);
          (q ? q.files : []).forEach(function (f) { f.ss = ss; list.push(f); });
        });
      });
    }, Promise.resolve()).then(function () { return list; });
  }).then(function (list) {
    list.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    var cnt = {};
    return list.map(function (x) {
      var m = x.name.match(/S(\d{1,2})\s*[._ -]?\s*E(\d{1,3})/i) || x.name.match(/(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?!\d)/i) || x.name.match(/(?:^|[^a-z0-9])E(?:p|pisode)?[._ -]?(\d{1,3})(?:[^0-9]|$)/i);
      var xs = m && m.length > 2 ? String(+m[1]) : null, xn = m ? +m[m.length - 1] : null;
      var sn = xs || x.ss || ds;
      cnt[sn] = (cnt[sn] || 0) + 1;
      return { s: sn, n: xn || cnt[sn], url: x.url, name: x.name };
    });
  });
}

function seriesStreamsSt(info, season, episode) {
  return searchSt(info.name).then(function (res) {
    var hits = res.dirs.filter(function (h) {
      if (!seriesNameMatches(h.title, info.name)) return false;
      var m = h.title.match(/seasons?\s*0*(\d+)(?:\s*(?:-|to|–)\s*0*(\d+))?/i);
      if (!m) return true;
      var a = Number(m[1]), z = m[2] ? Number(m[2]) : a;
      return Number(season) >= a && Number(season) <= z;
    }).slice(0, 8);
    DBG.push("ST series folder: " + hits.length + "/" + res.dirs.length + " matched");
    var out = [];
    return hits.reduce(function (p, hit) {
      return p.then(function () {
        return stEpisodes(hit).then(function (eps) {
          eps.filter(function (e) { return e.s === String(season) && e.n === Number(episode); })
             .forEach(function (e) { out.push(makeStream("ShowTime", e.url, e.name, false)); });
          DBG.push("ST files: " + eps.length);
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  });
}

// CineplexBD series (best effort): series page -> watch id -> episode page -> video links
function seriesStreamsCx(info, season, episode) {
  return searchCx(info.name).then(function (list) {
    var hit = list.filter(function (h) { return h.series && titleMatches(h.title, h.year, info.name, null); })[0];
    if (!hit) { DBG.push("CX series: no match"); return []; }
    var wid = hit.id;
    return getText(CX + "/watch.php?series_id=" + hit.id + "&autoplay=1")
      .then(function (html) {
        var m = html.match(/watch\.php\?[^"'<>]*?\bid=(\d+)[^"'<>]*?\bep=/i) || html.match(/watch\.php\?[^"'<>]*?\bep=[^"'<>]*?\bid=(\d+)/i);
        if (m) wid = m[1];
      })
      .catch(function () {})
      .then(function () {
        var url = CX + "/watch.php?id=" + wid + "&season=" + encodeURIComponent(season) + "&ep=" + episode;
        return getText(url).then(function (html) {
          var vids = cxVideos(html, url);
          DBG.push("CX series: " + vids.length + " link");
          return vids.map(function (u) {
            return makeStream("CineplexBD", u, hit.title + " S" + ("0" + season).slice(-2) + "E" + ("0" + episode).slice(-2), true);
          });
        });
      })
      .catch(function (e) { DBG.push("CX series error: " + (e && e.message)); return []; });
  });
}

function seriesStreams(info, season, episode) {
  return Promise.all([seriesStreamsSt(info, season, episode), seriesStreamsCx(info, season, episode)]).then(function (r) {
    return r[0].concat(r[1]);
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  DBG = [];
  var isMovie = mediaType === "movie";
  if (!isMovie && (!season || !episode)) return Promise.resolve([]);
  return getInfo(tmdbId, mediaType)
    .then(function (info) {
      DBG.push("TMDB: " + (info.name || "no title") + (info.year ? " (" + info.year + ")" : ""));
      if (!info.name) return [];
      return isMovie ? movieStreams(info) : seriesStreams(info, season, episode);
    })
    .catch(function (e) { DBG.push("error: " + (e && e.message)); return []; })
    .then(function (out) {
      if (out.length) return out;
      return [{ name: "DFLIX - no source", title: DBG.join(" | "), quality: "debug", url: "http://debug.invalid/none" }];
    });
}

module.exports = { getStreams: getStreams };
