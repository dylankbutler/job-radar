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

const JSON_SPEC = `Return ONLY a valid JSON array (no markdown fences, no commentary) of objects with these exact fields: title, company, location, level (one of "entry","mid","senior"), fit_score (integer 0-100 for how well it fits the profile), why_fit (one short sentence, under 20 words), url (direct posting link if available), source (site name, e.g. "company careers page", "LinkedIn", "We Work Remotely"). Exclude any role that is senior, staff, principal, director, VP, or head-of level. If nothing current and relevant is found, return [].`;

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (data.error) {
    console.error('API error:', JSON.stringify(data.error));
    return [];
  }
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

async function run() {
  console.log(`Refreshing job radar for ${companies.length} watchlist companies...`);

  const companyResults = [];
  for (const c of companies) {
    const prompt = `Candidate profile: ${profile}\n\nSearch for current open job postings at the company "${c}" (remote roles, or roles based in San Diego, Los Angeles, New York City, or San Francisco) that would suit this candidate. Check their careers page and major job boards. Return up to 3 roles. ${JSON_SPEC}`;
    const jobs = await callClaude(prompt);
    jobs.forEach(j => companyResults.push({ ...j, company: j.company || c, id: jobId(j.title || '', j.company || c) }));
    console.log(`  ${c}: ${jobs.length} role(s) found`);
  }

  const discoveryPrompt = `Candidate profile: ${profile}\n\nSearch broadly across the web (not limited to any specific company) for current open roles fitting this candidate — remote-first companies, or roles based in San Diego, Los Angeles, New York City, or San Francisco. Prioritize established or remote-first-for-years companies over early-stage/Series A-B startups; culture-forward brands (surf, music, outdoor, sustainable fashion) as well as AI evaluation/model quality roles, data analytics roles, and product/UX roles. Avoid postings that emphasize "fast-paced," "wear many hats," or hypergrowth urgency. Return up to 10 roles. ${JSON_SPEC}`;
  const discoveryRaw = await callClaude(discoveryPrompt);
  const discoveryJobs = discoveryRaw.map(j => ({ ...j, id: jobId(j.title || '', j.company || '') }));
  console.log(`  discovery: ${discoveryJobs.length} role(s) found`);

  const filteredCompanies = companyResults.filter(passesSeniorFilter).filter(j => j.id);
  const filteredDiscovery = discoveryJobs.filter(passesSeniorFilter).filter(j => j.id);

  let existing = { companies: [], discovery: [] };
  try {
    existing = JSON.parse(fs.readFileSync('data/jobs.json', 'utf-8'));
  } catch {}

  // merge new results with existing, new entries take priority, old ones fill in behind
  const mergedCompanies = [...filteredCompanies];
  (existing.companies || []).forEach(old => {
    if (!mergedCompanies.some(n => n.id === old.id)) mergedCompanies.push(old);
  });

  const mergedDiscovery = [...filteredDiscovery];
  (existing.discovery || []).forEach(old => {
    if (!mergedDiscovery.some(n => n.id === old.id)) mergedDiscovery.push(old);
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
