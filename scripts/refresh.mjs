import fs from 'fs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable.');
  process.exit(1);
}

const companies = fs.readFileSync('companies.txt', 'utf-8')
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean);

const profile = fs.readFileSync('profile.txt', 'utf-8').trim();

const JSON_SPEC = `Return ONLY a valid JSON array (no markdown fences, no commentary) of objects with these exact fields: title, company, location, level (one of "entry","mid","senior"), fit_score (integer 0-100 for how well it fits the profile), why_fit (one short sentence, under 20 words), url (direct posting link if available), source (site name, e.g. "company careers page", "LinkedIn", "We Work Remotely"), posted_date (ISO date string YYYY-MM-DD if the posting date is visible on the listing, otherwise null). CRITICAL: Only include roles that appear to be currently open and active — skip any listing that says "no longer available", "position filled", or "job closed". Only include listings posted within the last 45 days; if the posting date is unknown and you cannot confirm recency, skip it. Exclude any role that is senior, staff, principal, director, VP, or head-of level. If nothing current and relevant is found, return [].`;

const DISCOVERY_SPEC = `Return ONLY a valid JSON array (no markdown fences, no commentary) of objects with these exact fields: title, company, location, level (one of "entry","mid","senior"), fit_score (integer 0-100 for how well it fits the profile), why_fit (one short sentence, under 20 words), url (direct posting link if available), source (site name, e.g. "LinkedIn", "Greenhouse", "We Work Remotely", "company careers page"), posted_date (ISO date string YYYY-MM-DD if visible, otherwise null). Include roles that appear to be open — only skip if a listing explicitly says "closed", "filled", or "no longer available". Do NOT skip roles just because you cannot confirm the exact posting date. Exclude any role that is senior, staff, principal, director, VP, or head-of level. Return the best matches you find even if you are not 100% certain they are still open. If truly nothing relevant is found, return [].`;

async function callClaude(prompt, maxTokens = 2048) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (data.error) {
    console.error('API error:', JSON.stringify(data.error, null, 2));
    console.error('HTTP status:', res.status);
    return [];
  }
  console.log('stop_reason:', data.stop_reason, '| content blocks:', (data.content || []).map(b => b.type));
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch { return []; }
}

function jobId(title, company) {
  return (title + '|' + company).toLowerCase().replace(/[^a-z0-9|]/g, '').slice(0, 100);
}

function passesSeniorFilter(j) {
  const re = /\b(senior|sr\.?|staff|principal|director|vp|vice president|head of|chief|lead)\b/i;
  return j.level !== 'senior' && !re.test(j.title || '');
}

const MAX_AGE_DAYS = 14;
function isFresh(job) {
  if (!job.fetched_at) return false;
  return (Date.now() - new Date(job.fetched_at)) / 86400000 <= MAX_AGE_DAYS;
}

async function run() {
  const now = new Date().toISOString();
  console.log(`Refreshing job radar for ${companies.length} watchlist companies...`);

  const companyResults = [];
  for (const c of companies) {
    const prompt = `Candidate profile: ${profile}\n\nSearch for current open job postings at the company "${c}" (remote roles, or roles based in San Diego, Los Angeles, New York City, or San Francisco) that would suit this candidate. Check their careers page and major job boards. Return up to 3 roles. ${JSON_SPEC}`;
    const jobs = await callClaude(prompt);
    jobs.forEach(j => companyResults.push({ ...j, company: j.company || c, id: jobId(j.title || '', j.company || c), fetched_at: now }));
    console.log(`  ${c}: ${jobs.length} role(s) found`);
  }

  const discoveryPromptA = `Candidate profile: ${profile}\n\nYou are a job search assistant. Search the web for currently open job postings matching this candidate. Run these searches:\n- "entry level data analyst remote 2026 site:greenhouse.io OR site:lever.co"\n- "junior product analyst remote job 2026"\n- "associate business analyst remote hiring now"\n- "growth analyst entry level remote job opening 2026"\n- "data analyst media entertainment remote job"\nReturn up to 6 results from established companies (not early-stage startups). Prioritize roles on Greenhouse, Lever, Workday, or company career pages. ${DISCOVERY_SPEC}`;

  const discoveryPromptB = `Candidate profile: ${profile}\n\nYou are a job search assistant. Search the web for currently open job postings matching this candidate. Run these searches:\n- "AI evaluation analyst remote entry level job 2026"\n- "market research analyst remote junior 2026"\n- "operations analyst remote entry level hiring"\n- "partnerships coordinator remote job 2026 site:linkedin.com"\n- "GTM analyst remote job entry level surf outdoor music brand"\nReturn up to 6 results from established or remote-first companies. Avoid early-stage startups. Look on We Work Remotely, Remote.co, LinkedIn, and company career pages. ${DISCOVERY_SPEC}`;

  const [discoveryRawA, discoveryRawB] = await Promise.all([
    callClaude(discoveryPromptA, 4096),
    callClaude(discoveryPromptB, 4096),
  ]);

  const seen = new Set();
  const discoveryJobs = [...discoveryRawA, ...discoveryRawB]
    .map(j => ({ ...j, id: jobId(j.title || '', j.company || ''), fetched_at: now }))
    .filter(j => j.id && !seen.has(j.id) && seen.add(j.id));
  console.log(`  discovery: ${discoveryJobs.length} role(s) found`);

  const filteredCompanies = companyResults.filter(passesSeniorFilter).filter(j => j.id);
  const filteredDiscovery = discoveryJobs.filter(passesSeniorFilter).filter(j => j.id);

  let existing = { companies: [], discovery: [] };
  try {
    existing = JSON.parse(fs.readFileSync('data/jobs.json', 'utf-8'));
  } catch {}

  // merge: keep old entries only if still within MAX_AGE_DAYS and not replaced by today's run
  const mergedCompanies = [...filteredCompanies];
  (existing.companies || []).forEach(old => {
    if (!mergedCompanies.some(n => n.id === old.id) && isFresh(old)) mergedCompanies.push(old);
  });

  const mergedDiscovery = [...filteredDiscovery];
  (existing.discovery || []).forEach(old => {
    if (!mergedDiscovery.some(n => n.id === old.id) && isFresh(old)) mergedDiscovery.push(old);
  });

  const output = {
    lastUpdated: new Date().toISOString(),
    companies: mergedCompanies,
    discovery: mergedDiscovery
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/jobs.json', JSON.stringify(output, null, 2));
  console.log('Wrote data/jobs.json');
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
