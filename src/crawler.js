/**
 * 小说搜索 / 下载引擎
 * 书源规则格式借鉴 so-novel（https://github.com/freeok/so-novel）的 rules/main.json：
 *   search（搜索页）→ book（详情页）→ toc（目录页）→ chapter（正文页），全部用 CSS 选择器描述，
 *   选择器后可跟 @href / @src 取属性，@js:code 对结果做二次处理（变量 r 为输入，返回值为输出）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT = 15000;

/* ---------------- 书源加载 ---------------- */
let RULES = [];
function loadRules(dir) {
  RULES = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const r of arr) { r.id = RULES.length + 1; r.file = f; RULES.push(r); }
    } catch (e) { console.error('书源文件读取失败', f, e.message); }
  }
  return RULES;
}
const getRule = id => RULES.find(r => r.id === +id);
const listSources = () => RULES.map(r => ({ id: r.id, name: r.name, url: r.url, file: r.file, disabled: !!r.disabled, canSearch: !!(r.search && !r.search.disabled) }));

/* ---------------- HTTP ---------------- */
function decodeBody(buf, contentType) {
  const bytes = new Uint8Array(buf);
  let cs = (contentType || '').match(/charset=["']?([\w-]+)/i)?.[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    cs = head.match(/charset=["']?([\w-]+)/i)?.[1];
  }
  if (cs) { try { return new TextDecoder(cs.toLowerCase()).decode(buf); } catch {} }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('gbk').decode(buf); }
}
async function fetchHtml(url, opt = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeout || DEFAULT_TIMEOUT);
  try {
    const u = new URL(url);
    const headers = { 'User-Agent': UA, 'Referer': u.origin + '/', 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' };
    if (opt.cookies) headers['Cookie'] = opt.cookies;
    const init = { method: opt.method || 'GET', headers, signal: ctrl.signal, redirect: 'follow' };
    if (opt.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = opt.form; }
    const resp = await fetch(url, init);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const html = decodeBody(await resp.arrayBuffer(), resp.headers.get('content-type'));
    return { html, url: resp.url || url };
  } finally { clearTimeout(timer); }
}
function hasCloudflare($) {
  const t = $('title').first().text().trim();
  return ['Just a moment...', '403 Forbidden', 'Attention Required', 'Checking your browser before accessing'].includes(t);
}

/* ---------------- 选择器 / 提取 ---------------- */
function splitQuery(q) {
  // "css@href@js:code"  → { sel, attr, js }
  const jsIdx = q.indexOf('@js:');
  const javaIdx = q.indexOf('@java:');
  let head = q, js = null, java = null;
  const cut = [jsIdx, javaIdx].filter(i => i >= 0).sort((a, b) => a - b)[0];
  if (cut !== undefined) head = q.slice(0, cut);
  if (jsIdx >= 0) js = q.slice(jsIdx + 4, javaIdx > jsIdx ? javaIdx : undefined);
  if (javaIdx >= 0) java = q.slice(javaIdx + 6);
  let sel = head, attr = null;
  const at = head.indexOf('@');
  if (at > 0) { sel = head.slice(0, at); attr = head.slice(at + 1); }
  return { sel: sel.trim(), attr, js: js && js.trim(), java: java && java.trim() };
}
function runDsl(q, value) {
  const { js, java } = splitQuery(q);
  let r = value;
  if (js) {
    try { r = vm.runInNewContext(js + ';r', { r, console }, { timeout: 3000 }); }
    catch (e) { console.error('@js 执行失败:', e.message); }
  }
  if (java) {
    if (/base64\.decode/.test(java)) { try { r = Buffer.from(String(r).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'); } catch {} }
  }
  return r == null ? '' : String(r);
}
function absUrl(base, href) { if (!href) return ''; try { return new URL(href, base).href; } catch { return href; } }
function select($, root, q) {
  const { sel } = splitQuery(q);
  if (!sel || sel === '/html') return $.root();
  return root ? $(root).find(sel) : $(sel);
}
// type: text | html | href | src | content
function extract($, root, q, type, baseUrl) {
  if (!q) return '';
  const { sel, attr } = splitQuery(q);
  if (!type) type = attr === 'href' ? 'href' : attr === 'src' ? 'src' : /^meta\[/.test(sel) ? 'content' : 'text';
  const els = select($, root, q);
  if (!els.length) return '';
  let raw;
  if (type === 'text') raw = els.map((i, e) => $(e).text()).get().join(' ').trim();
  else if (type === 'html') raw = els.map((i, e) => $.html(e)).get().join('');
  else if (type === 'href' || type === 'src') raw = absUrl(baseUrl, els.first().attr(type));
  else raw = els.first().attr('content') || els.first().attr('value') || '';
  return runDsl(q, raw);
}

/* ---------------- 搜索 ---------------- */
function buildForm(dataStr, keyword) {
  // "{searchkey: %s, searchtype: all}" 这种宽松格式
  const body = String(dataStr || '{}').trim().replace(/^\{|\}$/g, '');
  const p = new URLSearchParams();
  for (const kv of body.split(',')) {
    const i = kv.indexOf(':'); if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k) p.append(k, v === '%s' ? keyword : v);
  }
  return p.toString();
}
async function searchOne(rule, keyword) {
  const r = rule.search;
  if (!r || r.disabled || rule.disabled) return [];
  let url = r.url.includes('@js:') ? runDsl(r.url, keyword) : r.url.replace('%s', encodeURIComponent(keyword));
  const opt = { method: (r.method || 'get').toUpperCase(), cookies: r.cookies, timeout: (r.timeout || 15) * 1000 };
  if (opt.method === 'POST') opt.form = buildForm(r.data, keyword);
  const page = await fetchHtml(url, opt);
  let html = page.html;
  if (r.result.includes('@js:')) html = runDsl(r.result, html);
  const $ = cheerio.load(html);
  if (hasCloudflare($)) throw new Error('站点有 Cloudflare 人机验证');
  const list = [];
  const items = select($, null, r.result);
  if (!items.length && rule.book && rule.book.bookName && select($, null, rule.book.bookName).length) {
    // 完全匹配时直接跳到了详情页
    const name = extract($, null, rule.book.bookName, null, page.url);
    if (name) list.push({ sourceId: rule.id, sourceName: rule.name, url: page.url, bookName: name, author: extract($, null, rule.book.author, null, page.url), latestChapter: extract($, null, rule.book.latestChapter, null, page.url) });
    return list;
  }
  items.each((i, el) => {
    const bookName = extract($, el, r.bookName, 'text', page.url);
    if (!bookName) return;
    list.push({
      sourceId: rule.id, sourceName: rule.name,
      url: extract($, el, r.bookName, 'href', page.url),
      bookName,
      author: extract($, el, r.author, null, page.url),
      category: extract($, el, r.category, null, page.url),
      latestChapter: extract($, el, r.latestChapter, null, page.url),
      lastUpdateTime: extract($, el, r.lastUpdateTime, null, page.url).replace(/\d{2}:\d{2}(:\d{2})?/, '').trim(),
      status: extract($, el, r.status, null, page.url),
      wordCount: extract($, el, r.wordCount, null, page.url)
    });
  });
  return list.slice(0, 30);
}
/** 聚合搜索：所有书源并发，逐个回调 onSource({sourceId, name, ok, count, error}) */
async function search(keyword, onSource) {
  const all = [];
  await Promise.all(RULES.filter(r => r.search && !r.search.disabled && !r.disabled).map(async rule => {
    try {
      const res = await searchOne(rule, keyword);
      all.push(...res);
      onSource && onSource({ sourceId: rule.id, name: rule.name, ok: true, count: res.length });
    } catch (e) {
      onSource && onSource({ sourceId: rule.id, name: rule.name, ok: false, error: e.message });
    }
  }));
  // 书名完全匹配的排前面
  const kw = keyword.trim();
  all.sort((a, b) => (b.bookName === kw) - (a.bookName === kw));
  return all;
}

/* ---------------- 目录 ---------------- */
async function getToc(rule, bookUrl) {
  const t = rule.toc || {}, b = rule.book || {};
  let id = null;
  if (b.url) { const m = bookUrl.match(new RegExp(b.url.split('@js:')[0])); if (m) id = m[1]; }
  let baseUri = t.baseUri && id != null ? t.baseUri.replace('%s', id) : (t.baseUri || bookUrl);
  let url = t.url && id != null ? t.url.replace('%s', id) : bookUrl;
  const timeout = (t.timeout || 15) * 1000;

  const urls = [url];
  const firstPage = await fetchHtml(url, { timeout });
  let $ = cheerio.load(firstPage.html);
  if (hasCloudflare($)) throw new Error('目录页有 Cloudflare 人机验证');
  const pages = [{ $, url: firstPage.url }];

  if (t.nextPage) {
    const els = select($, null, t.nextPage);
    if (els.length && els.first().attr('value') !== undefined && !els.first().attr('href')) {
      // <option value="..."> 一次性列出所有分页
      els.each((i, e) => { const u = absUrl(firstPage.url, $(e).attr('value')); if (u && !urls.includes(u)) urls.push(u); });
    } else {
      let cur$ = $, curUrl = firstPage.url;
      for (let guard = 0; guard < 500; guard++) {
        const href = extract(cur$, null, t.nextPage, 'href', curUrl) || extract(cur$, null, t.nextPage, 'content', curUrl);
        if (!href || !/^https?:/.test(href) || urls.includes(href)) break;
        urls.push(href);
        const pg = await fetchHtml(href, { timeout });
        cur$ = cheerio.load(pg.html); curUrl = pg.url;
        pages.push({ $: cur$, url: curUrl });
      }
    }
    // option 分页模式需要逐页抓取
    for (let i = 1; i < urls.length && pages.length < urls.length; i++) {
      const pg = await fetchHtml(urls[i], { timeout });
      pages.push({ $: cheerio.load(pg.html), url: pg.url });
    }
  }

  const chapters = [];
  for (const pg of pages) {
    let items;
    if (t.list) {
      const raw = runDsl(t.list, $.html ? pg.$.html() : '');
      const l$ = cheerio.load(raw);
      items = select(l$, null, t.item).map((i, e) => ({ title: l$(e).text().trim(), href: l$(e).attr('href') })).get();
    } else {
      items = select(pg.$, null, t.item).map((i, e) => ({ title: pg.$(e).text().trim(), href: pg.$(e).attr('href') })).get();
    }
    if (t.isDesc) items.reverse();
    for (const it of items) if (it.href) chapters.push({ title: it.title, url: absUrl(baseUri.includes('%s') ? pg.url : (t.baseUri ? baseUri : pg.url), it.href) });
  }
  // 去重（有些站目录顶部有“最新章节”重复项）
  const seen = new Set();
  return chapters.filter(c => !seen.has(c.url) && seen.add(c.url));
}

/* ---------------- 正文 ---------------- */
function cleanContent(rule, title, html) {
  const c = rule.chapter;
  let h = html.replace(/[​﻿­]/g, '');
  if (c.filterTxt) { try { h = h.replace(new RegExp(c.filterTxt, 'g'), ''); } catch {} }
  const $ = cheerio.load('<div id="__root">' + h + '</div>', null, false);
  if (c.filterTag) { try { $('#__root').find(c.filterTag).remove(); } catch {} }
  $('#__root').find('script, style').remove();
  let paras = [];
  const root = $('#__root');
  if (c.paragraphTagClosed) {
    // 每个块级子元素为一段
    const blocks = root.find('p, div, span, br').length ? null : null;
    root.children().each((i, e) => {
      const txt = $(e).text().replace(/ /g, ' ').trim();
      if (txt) paras.push(txt);
      else if (e.tagName === 'br') return;
    });
    if (!paras.length) paras = root.text().split(/\n+/);
  } else {
    let inner = root.html() || '';
    const tagRe = c.paragraphTag ? new RegExp(c.paragraphTag.replace(/<br>/g, '<br\\s*/?>'), 'gi') : /<br\s*\/?>/gi;
    for (const line of inner.split(tagRe)) {
      const txt = cheerio.load('<p>' + line + '</p>', null, false)('p').text().replace(/ /g, ' ').trim();
      if (txt) paras.push(txt);
    }
  }
  paras = paras.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (c.filterTxt) { try { const re = new RegExp(c.filterTxt); paras = paras.map(p => p.replace(re, '').trim()).filter(Boolean); } catch {} }
  // 去掉正文开头重复的章节名
  if (paras.length && title && paras[0].replace(/\s/g, '') === title.replace(/\s/g, '')) paras.shift();
  return paras;
}
async function getChapter(rule, ch) {
  const c = rule.chapter;
  const timeout = (c.timeout || 15) * 1000;
  let url = ch.url, htmlParts = [], title = '';
  for (let guard = 0; guard < 30; guard++) {
    const pg = await fetchHtml(url, { timeout });
    const $ = cheerio.load(pg.html);
    if (hasCloudflare($)) throw new Error('Cloudflare 人机验证');
    if (!title) title = extract($, null, c.title, 'text', pg.url) || ch.title;
    const html = extract($, null, c.content, 'html', pg.url);
    if (!html) throw new Error('正文为空');
    htmlParts.push(html);
    if (!c.nextPage) break;
    const nextEls = select($, null, c.nextPage);
    if (!nextEls.length) break;
    const next = absUrl(pg.url, nextEls.first().attr('href'));
    const txt = nextEls.text();
    if (!next || next === url) break;
    if (!/[-_]\d+\.html?$/.test(next) && /(下一章|没有了|>>|书末页)/.test(txt)) break;
    if (c.nextChapterLink && new RegExp(c.nextChapterLink).test(next)) break;
    url = next;
  }
  return { title: title || ch.title, paras: cleanContent(rule, title || ch.title, htmlParts.join('')) };
}

/* ---------------- 整本下载 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function downloadBook(rule, bookUrl, { onProgress, signal, limit } = {}) {
  let toc = await getToc(rule, bookUrl);
  if (limit) toc = toc.slice(0, limit);
  if (!toc.length) throw new Error('未解析到目录，书源可能已失效');
  const crawl = rule.crawl || {};
  const concurrency = crawl.concurrency || 5;
  const minI = (crawl.minInterval || 0) * 1000, maxI = (crawl.maxInterval || 0.2) * 1000;
  const maxAttempts = crawl.maxAttempts || 3;
  const results = new Array(toc.length);
  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < toc.length) {
      if (signal && signal.aborted) return;
      const i = next++;
      const ch = toc[i];
      let ok = false;
      for (let a = 1; a <= maxAttempts && !ok; a++) {
        try {
          await sleep(minI + Math.random() * (maxI - minI));
          results[i] = await getChapter(rule, ch);
          ok = true;
        } catch (e) {
          if (a === maxAttempts) { results[i] = { title: ch.title, paras: ['（本章下载失败：' + e.message + '）'] }; failed++; }
          else await sleep(1000 * a);
        }
      }
      done++;
      onProgress && onProgress({ done, total: toc.length, failed, title: ch.title });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, toc.length) }, worker));
  if (signal && signal.aborted) throw new Error('已取消');
  const text = results.map(r => r.title + '\n\n' + r.paras.map(p => '　　' + p).join('\n')).join('\n\n\n');
  return { text, chapters: toc.length, failed };
}

module.exports = { loadRules, listSources, getRule, search, searchOne, getToc, getChapter, downloadBook };
