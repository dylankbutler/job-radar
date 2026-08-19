import fs from 'fs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

const companies = fs.readFileSync('companies.txt', 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
const profile   = fs.readFileSync('profile.txt',   'utf-8').trim();

// ── Output specs ──────────────────────────────────────────────────────────────

const SCORE_SPEC = `Return ONLY a valid JSON array (no markdown fences) with these exact fields per object: title, company, location, level ("entry"|"mid"|"senior"), fit_score (integer 0-100), why_fit (one sentence ≤20 words), url, source, posted_date (YYYY-MM-DD or null). Exclude any senior/staff/principal/director/VP/head-of/lead role. Return up to 3 best fits. If none relevant, return [].`;

const DISCOVERY_SCORE_SPEC = `Return ONLY a valid JSON array (no markdown fences) with these exact fields per object: title, company, location, level ("entry"|"mid"|"senior"), fit_score (integer 0-100), why_fit (one sentence ≤20 words), url, source, posted_date (YYYY-MM-DD or null). Exclude any senior/staff/principal/director/VP/head-of/lead role. Return the top 15 best-fit roles sorted by fit_score descending. If none relevant, return [].`;

const SEARCH_SPEC = `Return ONLY a valid JSON array (no markdown fences) with these exact fields per object: title, company, location, level ("entry"|"mid"|"senior"), fit_score (integer 0-100), why_fit (one sentence ≤20 words), url, source, posted_date (YYYY-MM-DD or null). Only skip a listing explicitly marked closed or filled. Exclude senior/staff/principal/director/VP/head-of/lead roles. Return up to 3 best fits. If none found, return [].`;

// ── ATS + Workday config ──────────────────────────────────────────────────────
// Slug / URL map so we never guess — add/correct entries here as needed

const ATS = {
  'Surfline':                { greenhouse: 'surfline' },
  'Whatnot':                 { greenhouse: 'whatnot' },
  'National Research Group': { greenhouse: 'nationalresearchgroup' },
  'Clay':                    { lever: 'clay-hq' },
  'Live Nation':             { workday: { base: 'https://livenation.wd1.myworkdayjobs.com', tenant: 'livenation', board: 'LNExternalSite' } },
  'Substack':                { greenhouse: 'substack' },
  'Pinterest':               { greenhouse: 'pinterest' },
  'World Surf League':       { greenhouse: 'worldsurfleague' },
  'BandsinTown':             { lever: 'bandsintown' },
  'IHeart Media':            { workday: { base: 'https://iheartmedia.wd5.myworkdayjobs.com', tenant: 'iheartmedia', board: 'External' } },
  'Automattic':              { greenhouse: 'automattic' },
  'Patagonia':               { workday: { base: 'https://patagonia.wd5.myworkdayjobs.com', tenant: 'patagonia', board: 'Patagonia_Careers' } },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function jobId(title, company) {
  return (title + '|' + company).toLowerCase().replace(/[^a-z0-9|]/g, '').slice(0, 100);
}
function passesSeniorFilter(j) {
  return j.level !== 'senior'
    && !/\b(senior|sr\.?|staff|principal|director|vp|vice\s+president|head\s+of|chief|lead)\b/i.test(j.title || '');
}
function parseWorkdayDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// Pre-filter raw job titles before sending to Claude for scoring
const RELEVANT = /analyst|data|product|research|market|operations|growth|partnerships|coordinator|associate|gtm|strategy|business|intelligence|insights|evaluation/i;
const EXCLUDE  = /engineer|developer|devops|designer|security|legal|counsel|finance|accounting|recruiter|hr |talent|sales\s/i;
function isRelevantTitle(title = '') {
  return RELEVANT.test(title) && !EXCLUDE.test(title);
}

function isFresh(job, maxDays = 5) {
  if (!job.fetched_at) return false;
  return (Date.now() - new Date(job.fetched_at)) / 86400000 <= maxDays;
}

// ── ATS fetchers (live listings only) ────────────────────────────────────────

async function fetchGreenhouse(slug) {
  if (!slug) return null;
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.jobs?.length) return null;
    return { via: 'Greenhouse', jobs: d.jobs.map(j => ({
      raw_title: j.title,
      location:  j.location?.name || 'Unknown',
      url:       j.absolute_url,
      date:      j.updated_at?.slice(0, 10) || null,
    }))};
  } catch { return null; }
}

async function fetchLever(slug) {
  if (!slug) return null;
  try {
    const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) return null;
    return { via: 'Lever', jobs: d.map(j => ({
      raw_title: j.text,
      location:  j.categories?.location || j.categories?.allLocations?.[0] || 'Unknown',
      url:       j.hostedUrl,
      date:      j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : null,
    }))};
  } catch { return null; }
}

async function fetchAshby(slug) {
  if (!slug) return null;
  try {
    const r = await fetch('https://api.ashbyhq.com/posting-public.list', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ organizationHostedJobsPageName: slug }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.results?.length) return null;
    return { via: 'Ashby', jobs: d.results.map(j => ({
      raw_title: j.title,
      location:  j.isRemote ? 'Remote' : (j.locationName || 'Unknown'),
      url:       `https://jobs.ashbyhq.com/${slug}/${j.id}`,
      date:      j.publishedDate?.slice(0, 10) || null,
    }))};
  } catch { return null; }
}

async function fetchWorkday({ base, tenant, board }) {
  try {
    const r = await fetch(`${base}/wday/cxs/${tenant}/${board}/jobs`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.jobPostings?.length) return null;
    return { via: 'Workday', jobs: d.jobPostings.map(j => ({
      raw_title: j.title,
      location:  j.locationsText || 'Unknown',
      url:       `${base}${j.externalPath}`,
      date:      parseWorkdayDate(j.postedOn),
    }))};
  } catch { return null; }
}

// ── Discovery API fetchers ────────────────────────────────────────────────────

async function fetchRemotive() {
  const categories = ['data', 'product', 'marketing', 'business', 'all-others'];
  const results = (await Promise.all(categories.map(async cat => {
    try {
      const r = await fetch(`https://remotive.com/api/remote-jobs?category=${cat}&limit=30`);
      if (!r.ok) return [];
      const d = await r.json();
      return (d.jobs || []).map(j => ({
        raw_title: j.title,
        company:   j.company_name,
        location:  j.candidate_required_location || 'Remote',
        url:       j.url,
        date:      j.published_date?.slice(0, 10) || null,
        source:    'Remotive',
      }));
    } catch { return []; }
  }))).flat();
  return results;
}

async function fetchJobicy() {
  const tags = ['analyst', 'data', 'marketing', 'operations', 'product'];
  const results = (await Promise.all(tags.map(async tag => {
    try {
      const r = await fetch(`https://jobicy.com/api/v2/remote-jobs?count=20&tag=${tag}`);
      if (!r.ok) return [];
      const d = await r.json();
      return (d.jobs || []).map(j => ({
        raw_title: j.jobTitle,
        company:   j.companyName,
        location:  j.jobGeo || 'Remote',
        url:       j.url,
        date:      j.pubDate?.slice(0, 10) || null,
        source:    'Jobicy',
      }));
    } catch { return []; }
  }))).flat();
  return results;
}

// ── URL health check ──────────────────────────────────────────────────────────

async function checkUrl(url, timeoutMs = 4000) {
  if (!url) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    return r.ok;
  } catch { return false; }
}

async function filterDead(jobs) {
  if (!jobs.length) return jobs;
  const healthy = await Promise.all(jobs.map(j => checkUrl(j.url)));
  const kept = jobs.filter((_, i) => healthy[i]);
  const dropped = jobs.length - kept.length;
  if (dropped) console.log(`    URL check: dropped ${dropped} dead link(s)`);
  return kept;
}

// ── Claude ────────────────────────────────────────────────────────────────────

async function callClaude(prompt, { maxTokens = 1024, useSearch = false } = {}) {
  const body = {
    model:    'claude-haiku-4-5',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const res  = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) { console.error('API error:', JSON.stringify(data.error)); return []; }

  const text    = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const match   = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch { return []; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const now   = new Date().toISOString();
  const today = now.slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  console.log(`Refreshing ${companies.length} watchlist companies (${today})...`);

  // ── Watchlist ──────────────────────────────────────────────────────────────
  const companyResults = [];
  const atsScanned = new Set(); // companies where ATS gave us the complete open-job list

  for (const c of companies) {
    const cfg  = ATS[c] || {};
    // For companies not in the ATS map, try common slug variations automatically
    const slug = c.toLowerCase().replace(/[^a-z0-9]/g, '');
    const ats  = await fetchGreenhouse(cfg.greenhouse ?? slug)
             || await fetchLever(cfg.lever ?? slug)
             || await fetchAshby(cfg.ashby ?? slug)
             || (cfg.workday ? await fetchWorkday(cfg.workday) : null);

    let jobs;
    if (ats) {
      atsScanned.add(c.toLowerCase()); // ATS is authoritative; old results for this company will be dropped
      const listing = ats.jobs.slice(0, 40)
        .map(j => `- "${j.raw_title}" | ${j.location} | ${j.date || 'no date'} | ${j.url}`)
        .join('\n');
      const prompt = `Today is ${today}. Candidate profile:\n${profile}\n\nAll currently open positions at ${c} (live from ${ats.via}):\n${listing}\n\nScore and pick up to 3 best-fit roles. ${SCORE_SPEC}`;
      jobs = await callClaude(prompt, { maxTokens: 1024, useSearch: false });
      console.log(`  ${c}: ${jobs.length} role(s) [${ats.via} — ${ats.jobs.length} open total]`);
    } else {
      // Web search fallback — only for companies with no known ATS
      const prompt = `Today is ${today}. Candidate profile:\n${profile}\n\nSearch for open jobs at "${c}" using their careers page or Greenhouse/Lever/Ashby board (not job aggregators). Use after:${thirtyDaysAgo} to restrict to recent listings. ${SEARCH_SPEC}`;
      jobs = await callClaude(prompt, { maxTokens: 1024, useSearch: true });
      jobs = await filterDead(jobs);
      console.log(`  ${c}: ${jobs.length} role(s) [web search fallback — no ATS found]`);
    }

    jobs.forEach(j => companyResults.push({
      ...j, company: j.company || c,
      id: jobId(j.title || '', j.company || c), fetched_at: now,
    }));
  }

  // ── Discovery — no web search, only live job APIs ──────────────────────────
  console.log('  Fetching discovery from Remotive + Jobicy...');

  const [remotiveRaw, jobicyRaw] = await Promise.all([fetchRemotive(), fetchJobicy()]);

  // Deduplicate, pre-filter by title relevance, cap at 60 for scoring
  const seen = new Set();
  const discoveryPool = [...remotiveRaw, ...jobicyRaw]
    .filter(j => j.raw_title && j.url && !seen.has(j.url) && seen.add(j.url))
    .filter(j => isRelevantTitle(j.raw_title));

  console.log(`  Discovery pool: ${discoveryPool.length} relevant jobs from APIs`);

  let discoveryJobs = [];
  if (discoveryPool.length) {
    const listing = discoveryPool.slice(0, 60)
      .map(j => `- "${j.raw_title}" at ${j.company} | ${j.location} | posted ${j.date || 'unknown'} | ${j.source} | ${j.url}`)
      .join('\n');
    const prompt = `Today is ${today}. Candidate profile:\n${profile}\n\nBelow are currently open remote jobs pulled live from Remotive and Jobicy (no stale data). Score and filter for the best fits — prioritize culture-forward brands (surf, music, outdoor, media, AI), established remote-first companies, and roles at the entry-to-mid level. Avoid early-stage startups.\n\n${listing}\n\n${DISCOVERY_SCORE_SPEC}`;
    const scored = await callClaude(prompt, { maxTokens: 4096, useSearch: false });

    // Re-attach source URL from pool if Claude dropped it, then health-check
    const withUrls = scored.map(j => {
      const match = discoveryPool.find(p =>
        p.raw_title?.toLowerCase() === j.title?.toLowerCase() &&
        p.company?.toLowerCase() === j.company?.toLowerCase()
      );
      return {
        ...j,
        url:         j.url || match?.url || '',
        source:      j.source || match?.source || '',
        posted_date: j.posted_date || match?.date || null,
        id:          jobId(j.title || '', j.company || ''),
        fetched_at:  now,
      };
    });
    discoveryJobs = await filterDead(withUrls.filter(j => j.url));
  }

  console.log(`  Discovery: ${discoveryJobs.length} role(s) scored`);

  // ── Merge + expire ─────────────────────────────────────────────────────────
  const filteredCompanies = companyResults.filter(passesSeniorFilter).filter(j => j.id);
  const filteredDiscovery = discoveryJobs.filter(passesSeniorFilter).filter(j => j.id);

  let existing = { companies: [], discovery: [] };
  try { existing = JSON.parse(fs.readFileSync('data/jobs.json', 'utf-8')); } catch {}

  // For ATS-covered companies, today's API results are the complete source of truth —
  // don't carry forward old results (the job may have been filled since last run).
  // For web-search-only companies, keep results up to 5 days as a best-effort cache.
  const mergedCompanies = [...filteredCompanies];
  (existing.companies || []).forEach(old => {
    const co = (old.company || '').toLowerCase();
    if (atsScanned.has(co)) return; // ATS already gave us the full picture for this company
    if (!mergedCompanies.some(n => n.id === old.id) && isFresh(old, 5)) mergedCompanies.push(old);
  });

  // Discovery: keep recent results (5 days) to smooth over day-to-day API variation
  const mergedDiscovery = [...filteredDiscovery];
  (existing.discovery || []).forEach(old => {
    if (!mergedDiscovery.some(n => n.id === old.id) && isFresh(old, 5)) mergedDiscovery.push(old);
  });

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/jobs.json', JSON.stringify({
    lastUpdated: now,
    companies:   mergedCompanies,
    discovery:   mergedDiscovery,
  }, null, 2));
  console.log('Wrote data/jobs.json');
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
