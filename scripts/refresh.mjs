import fs from 'fs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

const companies = fs.readFileSync('companies.txt', 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
const profile   = fs.readFileSync('profile.txt',   'utf-8').trim();

// Spec for scoring ATS data (no date validation needed — ATS only returns live jobs)
const SCORE_SPEC = `Return ONLY a valid JSON array (no markdown fences) of objects with these exact fields: title, company, location, level ("entry"|"mid"|"senior"), fit_score (integer 0-100), why_fit (one sentence ≤20 words), url, source, posted_date (YYYY-MM-DD or null). Exclude any role that is senior, staff, principal, director, VP, head-of, or lead level. Return up to 3 best-fit roles. If none are relevant, return [].`;

// Spec for web search fallback — permissive on dates since we already restrict via search operators
const SEARCH_SPEC = `Return ONLY a valid JSON array (no markdown fences) of objects with these exact fields: title, company, location, level ("entry"|"mid"|"senior"), fit_score (integer 0-100), why_fit (one sentence ≤20 words), url, source, posted_date (YYYY-MM-DD or null). Only skip a listing if it is explicitly marked closed or filled. Exclude senior/staff/principal/director/VP/head-of/lead roles. Return up to 3 best-fit roles. If none found, return [].`;

// Spec for discovery — broadest, prioritize returning results
const DISCOVERY_SPEC = `Return ONLY a valid JSON array (no markdown fences) of objects with these exact fields: title, company, location, level ("entry"|"mid"|"senior"), fit_score (integer 0-100), why_fit (one sentence ≤20 words), url, source, posted_date (YYYY-MM-DD or null). Only skip a listing if it is explicitly marked closed or filled — do NOT skip because you cannot confirm a date. Exclude senior/staff/principal/director/VP/head-of/lead roles. Return up to 8 best matches even if you are not certain they are still open.`;

function jobId(title, company) {
  return (title + '|' + company).toLowerCase().replace(/[^a-z0-9|]/g, '').slice(0, 100);
}
function passesSeniorFilter(j) {
  return j.level !== 'senior' && !/\b(senior|sr\.?|staff|principal|director|vp|vice\s+president|head\s+of|chief|lead)\b/i.test(j.title || '');
}

// ── ATS API fetchers ─────────────────────────────────────────────────────────

async function fetchGreenhouse(company) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
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

async function fetchLever(company) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
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

async function fetchAshby(company) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  try {
    const r = await fetch('https://api.ashbyhq.com/posting-public.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationHostedJobsPageName: slug }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const jobs = d.results;
    if (!Array.isArray(jobs) || !jobs.length) return null;
    return { via: 'Ashby', jobs: jobs.map(j => ({
      raw_title: j.title,
      location:  j.locationName || j.isRemote ? 'Remote' : 'Unknown',
      url:       `https://jobs.ashbyhq.com/${slug}/${j.id}`,
      date:      j.publishedDate?.slice(0, 10) || null,
    }))};
  } catch { return null; }
}

// ── Claude caller ────────────────────────────────────────────────────────────

async function callClaude(prompt, { maxTokens = 2048, useSearch = true } = {}) {
  const body = {
    model: 'claude-haiku-4-5',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const res  = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) { console.error('API error:', JSON.stringify(data.error)); return []; }
  console.log(`  stop_reason: ${data.stop_reason}`);
  const text    = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const match   = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch { return []; }
}

// ── Expiry ───────────────────────────────────────────────────────────────────

const MAX_AGE_DAYS = 14;
function isFresh(job) {
  if (!job.fetched_at) return false;
  return (Date.now() - new Date(job.fetched_at)) / 86400000 <= MAX_AGE_DAYS;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const now           = new Date().toISOString();
  const today         = now.slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  console.log(`Refreshing job radar for ${companies.length} watchlist companies (today: ${today})...`);

  const companyResults = [];
  for (const c of companies) {
    // 1. Try live ATS APIs first — these only return currently open positions
    const ats = await fetchGreenhouse(c) || await fetchLever(c) || await fetchAshby(c);

    let jobs;
    if (ats) {
      const listing = ats.jobs.slice(0, 40)
        .map(j => `- "${j.raw_title}" | ${j.location} | posted ${j.date || 'unknown'} | ${j.url}`)
        .join('\n');
      const prompt = `Today is ${today}. Candidate profile:\n${profile}\n\nBelow are ALL currently open positions at ${c} pulled live from their ${ats.via} job board. Score and filter to the best fits:\n\n${listing}\n\n${SCORE_SPEC}`;
      jobs = await callClaude(prompt, { maxTokens: 1024, useSearch: false });
      console.log(`  ${c}: ${jobs.length} role(s) [${ats.via} API — ${ats.jobs.length} total open]`);
    } else {
      // 2. Fall back to web search with date operator
      const prompt = `Today is ${today}. Candidate profile:\n${profile}\n\nSearch for currently open jobs at "${c}" by checking their company careers page directly. Use queries like:\n- "site:${c.toLowerCase().replace(/\s+/g, '')}.com careers jobs"\n- "${c} greenhouse jobs after:${thirtyDaysAgo}"\n- "${c} lever jobs after:${thirtyDaysAgo}"\nOnly use the company's own careers page, Greenhouse, Lever, or Ashby. Do NOT use ZipRecruiter, BuiltIn, Indeed, or job aggregators — they index stale listings. ${SEARCH_SPEC}`;
      jobs = await callClaude(prompt, { maxTokens: 1024, useSearch: true });
      console.log(`  ${c}: ${jobs.length} role(s) [web search fallback]`);
    }

    jobs.forEach(j => companyResults.push({
      ...j,
      company:    j.company || c,
      id:         jobId(j.title || '', j.company || c),
      fetched_at: now,
    }));
  }

  // Discovery: two parallel web searches with date operators covering all role types
  console.log('  Running discovery searches...');
  const [rawA, rawB] = await Promise.all([
    callClaude(
      `Today is ${today}. Candidate profile:\n${profile}\n\nSearch for currently open entry-level jobs. Use date-restricted queries targeting company career pages and reputable boards only (Greenhouse, Lever, Ashby, We Work Remotely, Remote.co, LinkedIn). Do NOT use ZipRecruiter, BuiltIn, Indeed, or Glassdoor — they index stale listings. Queries:\n- "data analyst remote entry level site:greenhouse.io after:${thirtyDaysAgo}"\n- "product analyst associate remote site:lever.co after:${thirtyDaysAgo}"\n- "junior business analyst remote after:${thirtyDaysAgo}"\n- "data analyst media entertainment remote site:greenhouse.io 2026"\n${DISCOVERY_SPEC}`,
      { maxTokens: 4096, useSearch: true }
    ),
    callClaude(
      `Today is ${today}. Candidate profile:\n${profile}\n\nSearch for currently open entry-level jobs. Use date-restricted queries targeting company career pages and reputable boards only (Greenhouse, Lever, Ashby, We Work Remotely, Remote.co). Do NOT use ZipRecruiter, BuiltIn, Indeed, or Glassdoor. Queries:\n- "AI evaluation analyst remote entry level site:greenhouse.io after:${thirtyDaysAgo}"\n- "market research analyst remote junior site:lever.co after:${thirtyDaysAgo}"\n- "operations analyst remote entry level after:${thirtyDaysAgo}"\n- "strategy analyst remote entry level surf outdoor music brand 2026"\n${DISCOVERY_SPEC}`,
      { maxTokens: 4096, useSearch: true }
    ),
  ]);

  const seen = new Set();
  const discoveryJobs = [...rawA, ...rawB]
    .map(j => ({ ...j, id: jobId(j.title || '', j.company || ''), fetched_at: now }))
    .filter(j => j.id && !seen.has(j.id) && seen.add(j.id));
  console.log(`  discovery: ${discoveryJobs.length} role(s) found`);

  const filteredCompanies = companyResults.filter(passesSeniorFilter).filter(j => j.id);
  const filteredDiscovery = discoveryJobs.filter(passesSeniorFilter).filter(j => j.id);

  let existing = { companies: [], discovery: [] };
  try { existing = JSON.parse(fs.readFileSync('data/jobs.json', 'utf-8')); } catch {}

  const mergedCompanies = [...filteredCompanies];
  (existing.companies || []).forEach(old => {
    if (!mergedCompanies.some(n => n.id === old.id) && isFresh(old)) mergedCompanies.push(old);
  });

  const mergedDiscovery = [...filteredDiscovery];
  (existing.discovery || []).forEach(old => {
    if (!mergedDiscovery.some(n => n.id === old.id) && isFresh(old)) mergedDiscovery.push(old);
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
