const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3001;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function browserHeaders(referer) {
  var h = {
    'User-Agent': randomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9,en-US;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'DNT': '1',
  };
  if (referer) h['Referer'] = referer;
  return h;
}

var corsOptions = { origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] };
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// ── TRIPLE-LAYER FETCH: Browserless → Playwright+stealth → axios ──
async function fetchRendered(url, opts) {
  opts = opts || {};
  var waitMs = opts.wait || 2000;
  var errors = [];

  var blToken = process.env.BROWSERLESS_TOKEN;
  if (blToken) {
    try {
      var blResp = await axios.post(
        'https://chrome.browserless.io/content?token=' + blToken,
        { url, waitFor: waitMs, stealth: true, userAgent: randomUA() },
        { timeout: 35000, headers: { 'Content-Type': 'application/json' } }
      );
      if (blResp.data && blResp.data.length > 500) return { html: blResp.data, layer: 'browserless' };
      errors.push('browserless: response too short');
    } catch(e) { errors.push('browserless: ' + e.message); }
  }

  try {
    var chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
    var { chromium } = require('playwright-extra');
    var stealth = require('puppeteer-extra-plugin-stealth')();
    chromium.use(stealth);
    var browser = await chromium.launch({
      executablePath: chromiumPath, headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1366,768'],
    });
    var page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-AR,es;q=0.9' });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    await page.evaluate(function() {
      return new Promise(function(resolve) {
        var total = document.body.scrollHeight, pos = 0;
        var timer = setInterval(function() { window.scrollBy(0, 200); pos += 200; if (pos >= total) { clearInterval(timer); resolve(); } }, 80);
      });
    });
    await page.waitForTimeout(waitMs);
    var html = await page.content();
    await browser.close();
    return { html, layer: 'playwright' };
  } catch(e) { errors.push('playwright: ' + e.message); }

  try {
    var resp = await axios.get(url, { headers: browserHeaders(), timeout: 12000, maxRedirects: 5 });
    return { html: resp.data, layer: 'axios' };
  } catch(e) { errors.push('axios: ' + e.message); }

  throw new Error('All layers failed: ' + errors.join(' | '));
}

// ── HELPERS ──
function extractEmails(text) {
  var m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  return m ? [...new Set(m)] : [];
}
function extractPhones(text) {
  var m = text.match(/(\+?\d{1,4}[-.\s]?)?(\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}/g);
  return m ? [...new Set(m.filter(function(p){ return p.replace(/[-.\s]/g,'').length >= 8; }))] : [];
}
function toSlug(str) {
  return str.toLowerCase()
    .replace(/[áàä]/g,'a').replace(/[éèë]/g,'e').replace(/[íìï]/g,'i')
    .replace(/[óòö]/g,'o').replace(/[úùü]/g,'u').replace(/ñ/g,'n')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}

// ── PARSERS ──
function parseComputrabajo(html, region) {
  var $ = cheerio.load(html);
  var jobs = [];
  $('h2').each(function(i, el) {
    var a = $(el).find('a[href*="oferta-de-trabajo"]');
    if (!a.length) return;
    var title = a.text().trim();
    var href = a.attr('href') || '';
    var url = (href.startsWith('http') ? href : 'https://ar.computrabajo.com' + href).split('#')[0];

    // Walk up the DOM to find the job card container (article or div wrapping the whole card)
    var container = $(el).closest('article, [class*="box_offer"], [class*="offerList"]');
    if (!container.length) container = $(el).parent().parent(); // fallback: grandparent

    // Company: look for links to /empresas/ path (plural)
    var company = container.find('a[href*="/empresas/"]').first().text().trim()
               || container.find('a[href*="empresa"]').first().text().trim()
               || '';
    // Also try the .emp_link class used in some Computrabajo variants
    if (!company) company = container.find('.emp_link').text().trim();
    if (!company) company = 'Confidencial';

    // Location: extract text nodes that look like "City, Province" — avoid rating numbers
    var location = '';
    container.find('p, span').each(function() {
      var t = $(this).text().trim();
      // Match "Word, Word" or "Word Word, Word" patterns typical of Argentine cities
      if (!location && /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ].*,\s*[A-ZÁÉÍÓÚÑ]/.test(t) && t.length < 60) {
        location = t;
      }
    });
    if (!location) location = region || 'Argentina';

    if (title && url) jobs.push({ title, company, url, location, snippet: '', source: 'computrabajo' });
  });
  return jobs;
}

function parseIndeed(html, region) {
  var $ = cheerio.load(html);
  var jobs = [];
  var seen = new Set();
  $('a[href*="/rc/clk"]').each(function(i, el) {
    var href = $(el).attr('href') || '';
    var jkMatch = href.match(/jk=([a-z0-9]+)/i);
    if (!jkMatch) return;
    var jk = jkMatch[1];
    if (seen.has(jk)) return;
    seen.add(jk);
    var url = 'https://ar.indeed.com/viewjob?jk=' + jk;
    var title = $(el).text().trim();
    if (!title || title.length < 3) return;
    var container = $(el).closest('td, li, [class*="result"], [class*="job"]');
    var company = container.find('[class*="company"],[data-testid*="company"]').first().text().trim() || 'Empresa';
    var location = container.find('[class*="location"],[class*="companyLocation"]').first().text().trim() || region || 'Argentina';
    var snippet = container.find('[class*="snippet"],[class*="job-snippet"]').text().replace(/\s+/g,' ').trim().substring(0,200);
    jobs.push({ title, company, url, location, snippet, source: 'indeed' });
  });
  return jobs;
}

function parseBumeran(html, region) {
  var $ = cheerio.load(html);
  var jobs = [];
  $('a[href*="/empleos-"]').each(function(i, el) {
    var href = $(el).attr('href') || '';
    if (!href.includes('/empleos-')) return;
    var url = href.startsWith('http') ? href : 'https://www.bumeran.com.ar' + href;
    var title = $(el).find('h2, h3, [class*="title"]').first().text().trim() || $(el).text().trim();
    if (!title || title.length < 4) return;
    var company = $(el).find('[class*="company"],[class*="empresa"]').first().text().trim() || 'Empresa';
    jobs.push({ title, company, url, location: region || 'Argentina', snippet: '', source: 'bumeran' });
  });
  return jobs;
}

// ── ROUTES ──
app.get('/', function(req, res) {
  res.send('<h1>Nossecutt Scraper v4</h1><p style="color:green">OK</p><p>Sources: Computrabajo + Indeed AR + Bumeran</p><p>Layers: Browserless → Playwright+Stealth → axios</p>');
});

app.post('/scrape', async function(req, res) {
  var url = req.body.url;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (url.includes('linkedin.com')) {
    return res.status(422).json({ error: 'LinkedIn bloquea scraping. Usa Computrabajo, Indeed, Bumeran, Greenhouse o Lever.', blocked: true });
  }
  try {
    var result = await fetchRendered(url, { wait: 2000 });
    var $ = cheerio.load(result.html);
    var title = '', company = '', description = '', location = '';
    if (url.includes('indeed.com')) {
      title = $('h1[class*="jobsearch"], h1[data-testid*="title"], h1').first().text().trim();
      company = $('[data-testid="inlineHeader-companyName"],[class*="companyName"]').first().text().trim() || 'Empresa';
      description = $('[id="jobDescriptionText"],[class*="jobDescriptionText"],[class*="description"]').text().trim() || $('section').text().trim();
      location = $('[data-testid="job-location"],[class*="companyLocation"]').first().text().trim();
    } else if (url.includes('computrabajo.com')) {
      title = $('h1').text().trim();
      company = $('.emp_link').text().trim() || $('a[href*="empresa"]').first().text().trim() || 'Confidencial';
      description = $('.box_border').text().trim() || $('[class*="description"]').text().trim() || $('section').text().trim();
      location = $('.fs16').first().text().trim() || $('[class*="location"]').first().text().trim();
    } else if (url.includes('bumeran.com') || url.includes('zonajobs.com')) {
      title = $('h1').first().text().trim();
      company = $('[class*="company"]').first().text().trim() || 'Confidencial';
      description = $('[class*="description"]').text().trim() || $('article').text().trim();
      location = $('[class*="location"]').first().text().trim();
    } else if (url.includes('greenhouse.io')) {
      title = $('.app-title').text().trim() || $('h1').first().text().trim();
      company = $('.company-name').text().trim() || 'Greenhouse';
      description = $('#content').text().trim() || $('.job-body').text().trim();
      location = $('.location').text().trim();
    } else if (url.includes('lever.co')) {
      title = $('h2').first().text().trim() || $('h1').first().text().trim();
      company = $('.posting-header img').attr('alt') || 'Lever';
      description = $('.section.page-centered').text().trim();
      location = $('.location-tag').text().trim();
    } else {
      title = $('h1').first().text().trim();
      company = $('[class*="company"]').first().text().trim() || 'No identificada';
      description = $('article').text().trim() || $('[class*="description"]').text().trim() || $('main').text().trim();
      location = $('[class*="location"]').first().text().trim();
    }
    description = description.replace(/\s+/g,' ').trim();
    if (description.length > 5000) description = description.substring(0,5000) + '...';
    var rawText = $.text();
    res.json({
      title: title || 'Sin Titulo', company: company || 'Confidencial',
      description: description || 'Sin Descripcion', location: location || 'No especificado',
      emails: extractEmails(rawText), phones: extractPhones(rawText),
      url, layer: result.layer,
    });
  } catch(e) {
    console.error('Scraping error:', e.message);
    res.status(500).json({ error: 'No se pudo scrapear: ' + e.message });
  }
});

app.get('/test-search', async function(req, res) {
  var keyword = req.query.q || 'desarrollador';
  var region = req.query.l || '';
  var kSlug = toSlug(keyword);
  var rSlug = region ? toSlug(region) : '';
  var ctUrl = 'https://ar.computrabajo.com/trabajo-de-' + kSlug + (rSlug ? '-en-' + rSlug : '');
  var indeedUrl = 'https://ar.indeed.com/jobs?q=' + encodeURIComponent(keyword) + (region ? '&l=' + encodeURIComponent(region) : '');
  var results = { computrabajo: [], indeed: [], errors: [] };
  try {
    var r = await axios.get(ctUrl, { headers: browserHeaders(), timeout: 12000 });
    results.computrabajo = parseComputrabajo(r.data, region || 'Argentina');
  } catch(e) { results.errors.push('computrabajo: ' + e.message); }
  try {
    var r2 = await axios.get(indeedUrl, { headers: browserHeaders('https://ar.indeed.com'), timeout: 12000 });
    results.indeed = parseIndeed(r2.data, region || 'Argentina');
  } catch(e) { results.errors.push('indeed: ' + e.message); }
  res.json(results);
});

app.post('/search-jobs', async function(req, res) {
  var keyword = req.body.keyword || '';
  var region = req.body.region || '';
  if (!keyword) return res.status(400).json({ error: 'Keyword is required' });
  var kSlug = toSlug(keyword);
  var rSlug = region ? toSlug(region.split(',')[0].trim()) : '';
  var jobs = [], errors = [];

  // 1. Computrabajo (axios, server-side rendered)
  try {
    var ctUrl = 'https://ar.computrabajo.com/trabajo-de-' + kSlug + (rSlug ? '-en-' + rSlug : '');
    var ctResp = await axios.get(ctUrl, { headers: browserHeaders(), timeout: 12000 });
    var ctJobs = parseComputrabajo(ctResp.data, region || 'Argentina');
    console.log('[search-jobs] Computrabajo:', ctJobs.length);
    jobs = jobs.concat(ctJobs);
  } catch(e) { errors.push('computrabajo: ' + e.message); }

  // 2. Indeed Argentina (axios, server-side rendered)
  try {
    var indeedUrl = 'https://ar.indeed.com/jobs?q=' + encodeURIComponent(keyword) + (region ? '&l=' + encodeURIComponent(region) : '');
    var indeedResp = await axios.get(indeedUrl, { headers: browserHeaders('https://ar.indeed.com'), timeout: 12000 });
    var indeedJobs = parseIndeed(indeedResp.data, region || 'Argentina');
    console.log('[search-jobs] Indeed:', indeedJobs.length);
    jobs = jobs.concat(indeedJobs);
  } catch(e) { errors.push('indeed: ' + e.message); }

  // 3. Bumeran (needs browser)
  try {
    var bmUrl = 'https://www.bumeran.com.ar/empleos' + (rSlug ? '-provincia-' + rSlug : '') + '-busqueda-' + kSlug + '.html';
    var bmResult = await fetchRendered(bmUrl, { wait: 3000 });
    var bmJobs = parseBumeran(bmResult.html, region || 'Argentina');
    console.log('[search-jobs] Bumeran:', bmJobs.length, 'via', bmResult.layer);
    jobs = jobs.concat(bmJobs);
  } catch(e) { errors.push('bumeran: ' + e.message); }

  // Deduplicate
  var seen = new Set();
  jobs = jobs.filter(function(j) { if (!j.url || seen.has(j.url)) return false; seen.add(j.url); return true; });
  console.log('[search-jobs] Total:', jobs.length, 'Errors:', errors);
  res.json({ jobs, errors, sources: ['computrabajo','indeed','bumeran'] });
});

app.post('/search-contacts', async function(req, res) {
  var title = req.body.title, company = req.body.company;
  if (!title || !company) return res.status(400).json({ error: 'Title and Company required' });
  try {
    var q1 = '"' + title + '" "' + company + '" trabajo OR contacto OR email';
    var q2 = '"' + company + '" Recursos Humanos OR RRHH email';
    var r1 = await fetchRendered('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q1), { wait: 1000 });
    var r2 = await fetchRendered('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q2), { wait: 1000 });
    var emails = [], urls = [];
    [cheerio.load(r1.html), cheerio.load(r2.html)].forEach(function($) {
      $('.result__body').each(function(i, el) {
        var href = $(el).find('.result__url').attr('href') || '';
        if (href.includes('uddg=')) href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]);
        urls.push(href);
        emails = emails.concat(extractEmails($(el).find('.result__snippet').text()));
      });
    });
    var crawl = urls.filter(function(u){ return u && !u.includes('google') && !u.includes('duckduckgo'); }).slice(0,2);
    for (var i = 0; i < crawl.length; i++) {
      try { var cr = await fetchRendered(crawl[i], { wait: 1000 }); emails = emails.concat(extractEmails(cr.html)); } catch(e2) {}
    }
    res.json({ emails: [...new Set(emails)], alternativeLinks: [...new Set(urls)].slice(0,4) });
  } catch(e) { res.status(500).json({ error: 'Failed: ' + e.message }); }
});

app.post('/send-email', async function(req, res) {
  var to = req.body.to, subject = req.body.subject, html = req.body.html, text = req.body.text;
  var gmailUser = req.body.gmailUser, gmailAppPassword = req.body.gmailAppPassword;
  if (!to || !subject || (!html && !text)) return res.status(400).json({ error: 'Missing params' });
  var nodemailer = require('nodemailer');
  var user = gmailUser || 'camaleoncv.app@gmail.com';
  var pass = gmailAppPassword || 'uxbz ozwe gkvq hoxs';
  try {
    var t = nodemailer.createTransport({ service:'gmail', auth:{ user, pass } });
    var info = await t.sendMail({ from: user, to, subject, text, html });
    res.json({ success: true, messageId: info.messageId });
  } catch(e) { res.status(500).json({ error: 'Email failed: ' + e.message }); }
});

app.post('/gemini', async function(req, res) {
  var prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  var apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey;
    var resp = await axios.post(url, { contents:[{ parts:[{ text: prompt }] }] }, { headers:{ 'Content-Type':'application/json' } });
    res.json({ text: resp.data.candidates[0].content.parts[0].text });
  } catch(e) { res.status(500).json({ error: 'Gemini error: ' + e.message }); }
});

app.get('/health', function(req, res) {
  res.json({ status:'ok', time: new Date(), layers: ['browserless','playwright','axios'], sources: ['computrabajo','indeed','bumeran'], version: 4 });
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Nossecutt scraper v4 on port', PORT);
  console.log('Browserless:', process.env.BROWSERLESS_TOKEN ? 'SET' : 'NOT SET');
});
