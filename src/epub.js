/** epub → 纯文本（按 spine 顺序，章节标题取自 toc 或页内标题） */
const JSZip = require('jszip');
const cheerio = require('cheerio');
const path = require('path').posix;

async function epubToText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async p => { const f = zip.file(p) || zip.file(decodeURIComponent(p)); return f ? f.async('string') : null; };

  const container = await read('META-INF/container.xml');
  if (!container) throw new Error('不是有效的 epub 文件');
  const opfPath = cheerio.load(container, { xmlMode: true })('rootfile').first().attr('full-path');
  const opfDir = path.dirname(opfPath);
  const opf = cheerio.load(await read(opfPath), { xmlMode: true });
  const title = opf('metadata > dc\\:title, metadata > title').first().text().trim();
  const author = opf('metadata > dc\\:creator, metadata > creator').first().text().trim();

  const manifest = {};
  opf('manifest > item').each((i, e) => { manifest[opf(e).attr('id')] = { href: opf(e).attr('href'), type: opf(e).attr('media-type'), props: opf(e).attr('properties') || '' }; });
  const resolve = href => path.normalize(path.join(opfDir === '.' ? '' : opfDir, href.split('#')[0]));

  // 目录：epub3 nav 或 epub2 ncx → href → 标题
  const tocMap = {};
  const navItem = Object.values(manifest).find(m => m.props.includes('nav'));
  const ncxId = opf('spine').attr('toc');
  if (navItem) {
    const $ = cheerio.load(await read(resolve(navItem.href)) || '', { xmlMode: true });
    $('nav a').each((i, e) => { const h = $(e).attr('href'); if (h) tocMap[path.normalize(path.join(path.dirname(resolve(navItem.href)), h.split('#')[0]))] ||= $(e).text().trim(); });
  } else if (ncxId && manifest[ncxId]) {
    const $ = cheerio.load(await read(resolve(manifest[ncxId].href)) || '', { xmlMode: true });
    $('navPoint').each((i, e) => { const h = $(e).find('content').attr('src'); if (h) tocMap[path.normalize(path.join(path.dirname(resolve(manifest[ncxId].href)), h.split('#')[0]))] ||= $(e).find('text').first().text().trim(); });
  }

  const out = [];
  const spine = opf('spine > itemref').map((i, e) => opf(e).attr('idref')).get();
  for (const id of spine) {
    const m = manifest[id]; if (!m || !/html|xml/.test(m.type)) continue;
    const file = resolve(m.href);
    const html = await read(file); if (!html) continue;
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer').remove();
    let heading = tocMap[file] || $('h1, h2, h3').first().text().trim();
    const paras = [];
    $('body').find('p, h1, h2, h3, h4, div, li, blockquote').each((i, e) => {
      if ($(e).children('p, div, h1, h2, h3').length) return;   // 只取叶子块
      const t = $(e).text().replace(/\s+/g, ' ').trim();
      if (t) paras.push(t);
    });
    if (!paras.length) { const t = $('body').text().replace(/\s+/g, ' ').trim(); if (t) paras.push(t); }
    if (heading && paras[0] === heading) paras.shift();
    if (heading) out.push(heading);
    out.push(...paras.map(p => '　　' + p), '');
  }
  return { title, author, text: out.join('\n') };
}
module.exports = { epubToText };
