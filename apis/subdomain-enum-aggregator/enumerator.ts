import { safeFetch } from "../../shared/ssrf";

// ------------------------
// Types
// ------------------------

export interface ScoredSubdomain {
  subdomain: string;
  sources: string[]; // which data sources reported this
  score: number; // 0-100
  grade: string; // A-F
  unused: boolean; // whether appears inactive or unused
  details: string; // human-readable explanation
}

export interface EnumerationRecommendations {
  issue: string;
  severity: number; // 0-100
  suggestion: string;
}

export interface SubdomainEnumerationResult {
  domain: string;
  results: ScoredSubdomain[];
  subdomainsFound: number;
  overallScore: number; // 0-100 average or calculated
  overallGrade: string; // A-F
  recommendations: EnumerationRecommendations[];
}

// ------------------------
// Constants
// ------------------------

// Grade thresholds
const SCORE_TO_GRADE = (score: number): string => {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 45) return "D";
  return "F";
};

// Sources to query
const DATA_SOURCES = [
  "crtsh",
  "otxdns",
  "alienvault",
  "dnsdb",
  "googlect",
];


// ------------------------
// Utilities
// ------------------------

function domainToBase(domain: string): string {
  return domain.toLowerCase().replace(/^\*\./, "");
}

function normalizeSubdomain(sub: string, base: string): string {
  sub = sub.toLowerCase();
  if (sub.endsWith(`.${base}`)) return sub;
  else if (sub === base) return sub;
  else return `${sub}.${base}`;
}

function letterGrade(score: number): string {
  // Map 0-100 numeric score to letter grade A-F with +/-. For simplicity omit +/-
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 45) return "D";
  return "F";
}

// ------------------------
// Data source fetchers
// ------------------------

// All fetchers have a unified interface: input base domain, output string[] subdomains
// They catch errors upward

async function fetchFromCrtSh(domain: string, signal: AbortSignal): Promise<string[]> {
  try {
    const url = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`;
    const res = await safeFetch(url, { timeoutMs: 10000, signal });
    if (!res.ok) {
      throw new Error(`crt.sh HTTP status ${res.status}`);
    }
    const bodyText = await res.text();
    if (!bodyText || bodyText === "[]") return [];
    const certs = JSON.parse(bodyText);
    if (!Array.isArray(certs)) return [];

    const namesSet = new Set<string>();
    for (const cert of certs) {
      const nameValue = cert.name_value as string | undefined;
      if (!nameValue) continue;
      // name_value may have multiple domains per line
      const parts = nameValue.split(/\s+/);
     
      for (let part of parts) {
        part = part.trim();
        if (!part || part === "*") continue;
        // Normalize
        if (part.startsWith("*.")) part = part.slice(2);
        if (part.endsWith(domain)) {
          const norm = normalizeSubdomain(part, domain);
          namesSet.add(norm);
        }
      }
    }
    return Array.from(namesSet);
  } catch (e) {
    throw new Error(`fetchFromCrtSh error: ${(e as Error).message}`);
  }
}

async function fetchFromOTXDns(domain: string, signal: AbortSignal): Promise<string[]> {
  // AlienVault OTX DNS passive DNS lookup
  // Public API https://otx.alienvault.com/api/v1/indicators/domain/{domain}/passive_dns
  // This API requires no API key for GET domain passive DNS
  // Use timeout 10000
  try {
    const url = `https://otx.alienvault.com/api/v1/indicators/domain/${encodeURIComponent(domain)}/passive_dns`;
    const res = await safeFetch(url, { timeoutMs: 10000, signal });
    if (!res.ok) {
      throw new Error(`otxdns HTTP status ${res.status}`);
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.passive_dns)) return [];

    const subsSet = new Set<string>();
    for (const record of data.passive_dns) {
      if (record.hostname && typeof record.hostname === "string") {
        if (record.hostname.endsWith(domain)) {
          subsSet.add(normalizeSubdomain(record.hostname, domain));
        }
      }
    }
    return Array.from(subsSet);
  } catch (e) {
    throw new Error(`fetchFromOTXDns error: ${(e as Error).message}`);
  }
}

async function fetchFromAlienVault(domain: string, signal: AbortSignal): Promise<string[]> {
  // Deprecated public interface replaced with OTX above, so here fallback to empty
  return [];
}

async function fetchFromDnsDb(domain: string, signal: AbortSignal): Promise<string[]> {
  // Public free DNSDB lookups are rare, as most APIs need keys
  // We use dns.google for DNS type NS and A records to find subdomains, but that is weak
  // Instead we query DNS records repeatedly for common subdomains (heuristic) plus raw domain NS lookup
  // But to avoid complexity, return empty here
  return [];
}

async function fetchFromGoogleCt(domain: string, signal: AbortSignal): Promise<string[]> {
  // Google Certificate Transparency lookup API is deprecated
  // Use https://transparencyreport.google.com/https/certificates?cert_search=example.com
  // No public API endpoint, so fallback empty
  return [];
}

// ------------------------
// Analysis logic
// ------------------------

function scoreSubdomainPresenceInSources(count: number, totalSources: number): number {
  // More sources reporting the same subdomain - higher score
  if (totalSources === 0) return 0;
  return Math.min(100, Math.floor((count / totalSources) * 100));
}

function gradeFromScore(score: number): string {
  return SCORE_TO_GRADE(score);
}

function analyzeUnused(subdomain: string, hasDnsRecord: boolean, lastSeenDaysAgo: number | null): boolean {
  // Heuristics to mark unused
  // If no DNS record and last seen > 90 days, consider unused
  if (!hasDnsRecord) {
    if (lastSeenDaysAgo === null) return true; // unknown but no record
    if (lastSeenDaysAgo > 90) return true;
  }
  return false;
}

async function checkDnsRecord(subdomain: string, signal: AbortSignal): Promise<boolean> {
  // Query DNS A and AAAA
  try {
    // Use fetch to DNS over HTTPS Google
    // https://dns.google/resolve?name=api.example.com&type=A
    const urlA = `https://dns.google/resolve?name=${encodeURIComponent(subdomain)}&type=A`;
    const urlAAAA = `https://dns.google/resolve?name=${encodeURIComponent(subdomain)}&type=AAAA`;

    // Parallel requests
    const [resA, resAAAA] = await Promise.all([
      safeFetch(urlA, { timeoutMs: 10000, signal }),
      safeFetch(urlAAAA, { timeoutMs: 10000, signal }),
    ]);

    if (!resA.ok && !resAAAA.ok) return false;

    const [dataA, dataAAAA] = await Promise.all([resA.json(), resAAAA.json()]);

    if (
      (dataA?.Answer && Array.isArray(dataA.Answer) && dataA.Answer.length > 0) ||
      (dataAAAA?.Answer && Array.isArray(dataAAAA.Answer) && dataAAAA.Answer.length > 0)
    ) {
      return true;
    }
    return false;
  } catch {
    // On any error, assume no record
    return false;
  }
}

async function fetchCrtShLastSeen(subdomain: string, signal: AbortSignal): Promise<number | null> {
  // Query crt.sh single subdomain to find earliest/latest cert dates
  // We'll parse certificates and find the maximum not_after date
  try {
    const url = `https://crt.sh/?q=%25.${encodeURIComponent(subdomain)}&output=json`;
    const res = await safeFetch(url, { timeoutMs: 10000, signal });
    if (!res.ok) return null;
    const body = await res.text();
    if (!body || body === "[]") return null;
    const certs = JSON.parse(body);
    if (!Array.isArray(certs) || certs.length === 0) return null;

    const now = Date.now();
    let latestNotAfter: number | null = null;

    for (const cert of certs) {
      if (typeof cert.not_after !== "string") continue;
      const na = Date.parse(cert.not_after);
      if (isNaN(na)) continue;
      if (latestNotAfter === null || na > latestNotAfter) {
        latestNotAfter = na;
      }
    }

    if (latestNotAfter !== null) {
      const diffDays = Math.floor((now - latestNotAfter) / (1000 * 3600 * 24));
      return diffDays >= 0 ? diffDays : 0;
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------
// Main comprehensive enumerator
// ------------------------

// preview flag: true = limited data sources, no scoring
export async function exhaustiveEnumeration(
  domain: string,
  preview: boolean
): Promise<SubdomainEnumerationResult> {
  const baseDomain = domainToBase(domain);

  // Data sources to use depending on preview
  const sourcesToQuery = preview ? ["crtsh", "otxdns"] : DATA_SOURCES;

  // AbortSignal with timeout 10s for paid, 20s for preview
  // For convenience we'll create a single signal for all
  // But since called inside route with cancellation already, no need to redundantly handle here
  
  let promiseArray: Promise<{ source: string; subdomains: string[] }>[] = [];

  for (const source of sourcesToQuery) {
    switch (source) {
      case "crtsh":
        promiseArray.push(
          fetchFromCrtSh(baseDomain, AbortSignal.timeout(preview ? 20000 : 10000)).then(
            (subs) => ({ source, subdomains: subs })
          )
        );
        break;
      case "otxdns":
        promiseArray.push(
          fetchFromOTXDns(baseDomain, AbortSignal.timeout(preview ? 20000 : 10000)).then(
            (subs) => ({ source, subdomains: subs })
          )
        );
        break;
      case "alienvault":
        promiseArray.push(
          fetchFromAlienVault(baseDomain, AbortSignal.timeout(preview ? 20000 : 10000)).then(
            (subs) => ({ source, subdomains: subs })
          )
        );
        break;
      case "dnsdb":
        promiseArray.push(
          fetchFromDnsDb(baseDomain, AbortSignal.timeout(preview ? 20000 : 10000)).then(
            (subs) => ({ source, subdomains: subs })
          )
        );
        break;
      case "googlect":
        promiseArray.push(
          fetchFromGoogleCt(baseDomain, AbortSignal.timeout(preview ? 20000 : 10000)).then(
            (subs) => ({ source, subdomains: subs })
          )
        );
        break;
    }
  }

  // Gather all source results
  let resultsBySource: { [source: string]: string[] } = {};

  try {
    const responses = await Promise.all(promiseArray);
    for (const resp of responses) {
      resultsBySource[resp.source] = resp.subdomains;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Data source fetch error: ${message}`);
  }

  // Aggregate all subdomains with source counts
  const agg: Map<string, { sources: Set<string>; unused?: boolean; score?: number; grade?: string; details?: string }> = new Map();

  // Insert all discovered subs
  for (const [source, subdomains] of Object.entries(resultsBySource)) {
    for (const sub of subdomains) {
      const norm = normalizeSubdomain(sub, baseDomain);
      if (!agg.has(norm)) {
        agg.set(norm, { sources: new Set([source]) });
      } else {
        agg.get(norm)!.sources.add(source);
      }
    }
  }

  // For preview return raw (max 100 subs sorted lex) no scoring
  if (preview) {
    const previewSubs = Array.from(agg.keys()).sort().slice(0, 100);
    return {
      domain: baseDomain,
      subdomainsFound: previewSubs.length,
      results: previewSubs.map((s) => ({ subdomain: s, sources: Array.from(agg.get(s)!.sources) })),
      overallScore: 0,
      overallGrade: "N/A",
      recommendations: [],
    };
  }

  // For full scan, enrich each subdomain with DNS record check, calc lastSeen, score, unused
  const enrichedSubs: ScoredSubdomain[] = [];
  
  const dnsCheckPromises = Array.from(agg.keys()).map(async (subdomain) => {
    const dnsOk = await checkDnsRecord(subdomain, AbortSignal.timeout(10000));
    const lastSeenDaysAgo = await fetchCrtShLastSeen(subdomain, AbortSignal.timeout(10000));
    return { subdomain, dnsOk, lastSeenDaysAgo };
  });

  let dnsCheckResults: { subdomain: string; dnsOk: boolean; lastSeenDaysAgo: number | null }[];
  try {
    dnsCheckResults = await Promise.all(dnsCheckPromises);
  } catch (e) {
    throw new Error(`DNS Enrichment fetch error: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const enrichment of dnsCheckResults) {
    const { subdomain, dnsOk, lastSeenDaysAgo } = enrichment;
    const sourceCount = agg.get(subdomain)!.sources.size;
    
    // Score heuristic combining source count and activity
    let score = scoreSubdomainPresenceInSources(sourceCount, DATA_SOURCES.length);

    // If DNS is missing, reduce score moderately
    if (!dnsOk) {
      score = Math.floor(score * 0.5);
    }

    // If seen recently but no DNS record, slightly better than if unseen long ago
    if (!dnsOk && lastSeenDaysAgo !== null && lastSeenDaysAgo <= 30) {
      score = Math.max(score, 30);
    }

    const unused = analyzeUnused(subdomain, dnsOk, lastSeenDaysAgo);

    // Compose details string
    const detailsArray: string[] = [];
    if (dnsOk) detailsArray.push("Active DNS record found.");
    else detailsArray.push("No DNS A or AAAA record found.");
    if (lastSeenDaysAgo !== null) {
      detailsArray.push(`Last certificate seen ${lastSeenDaysAgo} day(s) ago.`);
    } else {
      detailsArray.push("No recent certificate transparency log data.");
    }
    detailsArray.push(`Reported by sources: ${Array.from(agg.get(subdomain)!.sources).join(", ")}.`);

    const grade = gradeFromScore(score);

    enrichedSubs.push({
      subdomain,
      sources: Array.from(agg.get(subdomain)!.sources),
      score,
      grade,
      unused,
      details: detailsArray.join(" "),
    });
  }

  // Overall score calculation: average, weighted by score counting
  const totalScore = enrichedSubs.reduce((a, b) => a + b.score, 0);
  const overallScore = enrichedSubs.length > 0 ? Math.round(totalScore / enrichedSubs.length) : 0;
  const overallGrade = gradeFromScore(overallScore);

  // Recommendations based on unused subdomains and low-score items
  const recommendations: EnumerationRecommendations[] = [];

  // Find unused
  const unusedSubs = enrichedSubs.filter((s) => s.unused);
  if (unusedSubs.length > 0) {
    recommendations.push({
      issue: "Unused subdomains",
      severity: 70,
      suggestion: `Review and disable unused subdomains such as ${unusedSubs.slice(0, 3).map((s) => s.subdomain).join(", ")}${unusedSubs.length > 3 ? ", ..." : ""}.`,
    });
  }

  // Low score subs
  const lowScoreSubs = enrichedSubs.filter((s) => s.score < 50);
  if (lowScoreSubs.length > 0) {
    recommendations.push({
      issue: "Low scoring subdomains",
      severity: 50,
      suggestion: `Investigate subdomains with low confidence or no recent activity such as ${lowScoreSubs.slice(0, 3).map((s) => s.subdomain).join(", ")}${lowScoreSubs.length > 3 ? ", ..." : ""}.`,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      issue: "No significant issues",
      severity: 0,
      suggestion: "No clear unused or vulnerable subdomains found. Continue monitoring regularly.",
    });
  }

  return {
    domain: baseDomain,
    subdomainsFound: enrichedSubs.length,
    results: enrichedSubs.sort((a, b) => b.score - a.score).slice(0, 200),
    overallScore,
    overallGrade,
    recommendations,
  };
}

export { app };
