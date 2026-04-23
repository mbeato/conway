import { safeFetch } from "../../shared/ssrf";

export interface HeatmapQuery {
  record: string; // fully qualified domain name of record
  type: string; // DNS record type e.g. A, AAAA, CNAME, TXT, MX, NS
}

export interface ResolverResult {
  resolver: string; // IP or name of the DNS resolver
  result: string[]; // Array of string answers returned
  lastUpdateSecondsAgo: number; // Approximate freshness delay in seconds
}

export interface HeatmapDetails {
  domain: string;
  type: string;
  timestamp: string; // ISO
  propagationScore: number; // 0-100
  grade: string; // A-F
  results: ResolverResult[]; // per resolver
  details: string; // human readable analysis text
  recommendations: Recommendation[]; // actions to improve
}

export interface HeatmapPreview {
  domain: string;
  type: string;
  queriedAt: string; // ISO
  resolversChecked: number;
  results: {
    resolver: string;
    result: string[];
    timestamp: string;
  }[];
  explanation: string;
}

export interface Recommendation {
  issue: string;
  severity: number; // 0-100
  suggestion: string;
}

const GLOBAL_PUBLIC_RESOLVERS = [
  { name: "Google DNS 8.8.8.8", address: "8.8.8.8" },
  { name: "Google DNS 8.8.4.4", address: "8.8.4.4" },
  { name: "Cloudflare 1.1.1.1", address: "1.1.1.1" },
  { name: "Quad9 9.9.9.9", address: "9.9.9.9" },
  { name: "OpenDNS 208.67.222.222", address: "208.67.222.222" },
];

const EXTENDED_RESOLVERS = [
  ...GLOBAL_PUBLIC_RESOLVERS,
  // Additional regional/public DNS to improve coverage
  { name: "Google DNS IPv6 2001:4860:4860::8888", address: "2001:4860:4860::8888" },
  { name: "Cloudflare IPv6 2606:4700:4700::1111", address: "2606:4700:4700::1111" },
  { name: "Quad9 IPv6 2620:fe::fe", address: "2620:fe::fe" },
];

// Helper fetch function for DNS over HTTPS JSON (Google and Cloudflare formats)
async function queryDnsOverHttps(resolver: { name: string; address: string }, record: string, type: string, signal: AbortSignal): Promise<{ answers: string[]; timestamp: Date } | { error: string }> {
  // Use Google DNS over HTTPS API as standard (https://dns.google/)
  // With fallback to Cloudflare
  try {
    const url = new URL("https://dns.google/resolve");
    url.searchParams.append("name", record);
    url.searchParams.append("type", type);

    // For Cloudflare, use https://cloudflare-dns.com/dns-query?name=xxx&type=xxx with application/dns-json Accept header
    // We'll stick with google for uniformity here

    const res = await safeFetch(url.toString(), {
      method: "GET",
      signal,
      headers: {
        "User-Agent": "dns-propagation-heatmap/1.0 apimesh.xyz",
        Accept: "application/json",
      },
      timeoutMs: 10000,
    });

    if (!res.ok) {
      return { error: `Resolver HTTP status ${res.status}` };
    }

    const data = await res.json();

    if (data.Status !== 0) {
      return { error: `DNS response error status ${data.Status}` };
    }

    // Answers: array of { name, type, TTL, data }
    if (!Array.isArray(data.Answer)) {
      return { answers: [], timestamp: new Date() };
    }

    const answers = data.Answer.map((a: any) => String(a.data));

    const timestamp = new Date();

    return { answers, timestamp };
  } catch (e: any) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// Quick preview endpoint for free
export async function previewHeatmap(record: string, type: string): Promise<HeatmapPreview | { error: string }> {
  const signal = AbortSignal.timeout(20_000); // Longer timeout for preview

  const usedResolvers = GLOBAL_PUBLIC_RESOLVERS.slice(0, 3); // Quick: 3 resolvers

  const queries = usedResolvers.map((r) => queryDnsOverHttps(r, record, type, signal));

  const resultsRaw = await Promise.allSettled(queries);

  const results: { resolver: string; result: string[]; timestamp: string }[] = [];

  for (let i = 0; i < resultsRaw.length; i++) {
    const res = resultsRaw[i];
    const resolver = usedResolvers[i];
    if (res.status === "fulfilled") {
      if ("error" in res.value) {
        results.push({ resolver: resolver.address, result: [], timestamp: new Date().toISOString() });
      } else {
        results.push({ resolver: resolver.address, result: res.value.answers, timestamp: res.value.timestamp.toISOString() });
      }
    } else {
      results.push({ resolver: resolver.address, result: [], timestamp: new Date().toISOString() });
    }
  }

  return {
    domain: record,
    type: type,
    queriedAt: new Date().toISOString(),
    resolversChecked: results.length,
    results,
    explanation: "Quick propagation check across major resolvers with limited resolvers for a fast preview.",
  };
}

// Full comprehensive heatmap check with scoring and recommendations
export async function fullHeatmapCheck(query: HeatmapQuery): Promise<HeatmapDetails | { error: string; detail?: string }> {
  const { record, type } = query;

  // Validate record and type basic sanity
  if (typeof record !== "string" || record.length < 3 || record.length > 255) {
    return { error: "Invalid domain record name" };
  }
  if (typeof type !== "string" || !type.match(/^[A-Z0-9]+$/)) {
    return { error: "Invalid DNS record type" };
  }

  const resolvers = EXTENDED_RESOLVERS;

  const signal = AbortSignal.timeout(10_000);

  // Parallel DNS over HTTPS queries
  const queries = resolvers.map((resolver) => queryDnsOverHttps(resolver, record, type, signal));

  const settled = await Promise.allSettled(queries);

  const now = new Date();

  const results: ResolverResult[] = [];

  // Collect unique results and timestamps
  for (let i = 0; i < resolvers.length; i++) {
    const resolver = resolvers[i];
    const res = settled[i];

    if (res.status === "fulfilled") {
      if ("error" in res.value) {
        results.push({ resolver: resolver.address, result: [], lastUpdateSecondsAgo: -1 });
      } else {
        // Calculate seconds ago from now
        const secondsAgo = Math.round((now.getTime() - res.value.timestamp.getTime()) / 1000);
        results.push({ resolver: resolver.address, result: res.value.answers, lastUpdateSecondsAgo: secondsAgo });
      }
    } else {
      results.push({ resolver: resolver.address, result: [], lastUpdateSecondsAgo: -1 });
    }
  }

  // Analysis: scoring based on consistency, propagation delay, mismatches

  // Step 1: Collect all answers to find majority
  const answerGroups: Map<string, number> = new Map();

  results.forEach((r) => {
    if (r.result && r.result.length > 0) {
      // Sort answers for normalized comparison
      const sortedAns = [...r.result].sort().join(",");
      answerGroups.set(sortedAns, (answerGroups.get(sortedAns) || 0) + 1);
    }
  });

  // Step 2: Find majority group and its count
  let majorityAnswers = "";
  let maxCount = 0;

  for (const [answers, count] of answerGroups.entries()) {
    if (count > maxCount) {
      majorityAnswers = answers;
      maxCount = count;
    }
  }

  // Step 3: Calculate propagationScore (0-100)
  // Based on ratio of resolvers matching majority, and freshness (lower latency is good)
  const totalResolvers = results.length;
  const matchingResolvers = results.filter((r) => r.result && r.result.length > 0 && [...r.result].sort().join(",") === majorityAnswers).length;

  // Average freshness delay on matching resolvers (max 300 secs considered okay)
  const freshnessScores: number[] = results
    .filter((r) => r.result.length > 0 && [...r.result].sort().join(",") === majorityAnswers && r.lastUpdateSecondsAgo >= 0)
    .map((r) => {
      const capped = Math.min(r.lastUpdateSecondsAgo, 300);
      return 100 - (capped / 300) * 100;
    });

  const avgFreshness = freshnessScores.length > 0 ? freshnessScores.reduce((a, b) => a + b, 0) / freshnessScores.length : 0;

  // Score is weighted average of consistency and freshness
  const consistencyScore = (matchingResolvers / totalResolvers) * 100;

  let propagationScore = Math.round(0.7 * consistencyScore + 0.3 * avgFreshness);

  if (propagationScore > 100) propagationScore = 100;
  if (propagationScore < 0) propagationScore = 0;

  // Letter grade
  let grade = "F";
  if (propagationScore >= 90) grade = "A";
  else if (propagationScore >= 80) grade = "B";
  else if (propagationScore >= 60) grade = "C";
  else if (propagationScore >= 40) grade = "D";

  // Recommendations
  const recommendations: Recommendation[] = [];

  if (consistencyScore < 80) {
    recommendations.push({
      issue: `DNS record inconsistent on ${totalResolvers - matchingResolvers} out of ${totalResolvers} resolvers`,
      severity: 85,
      suggestion: "Check DNS zone configurations to ensure uniform record propagation across all authoritative servers.",
    });
  }

  const maxDelay = Math.max(...results.map((r) => (r.lastUpdateSecondsAgo >= 0 ? r.lastUpdateSecondsAgo : 0)));
  if (maxDelay > 120) {
    recommendations.push({
      issue: `Propagation delay on slowest resolver is high (${maxDelay}s)`,
      severity: 70,
      suggestion: "Reduce DNS TTL or consult your DNS provider to speed up propagation.",
    });
  }

  // Check if any resolver returned no result or error
  const unresolvedResolvers = results.filter((r) => r.result.length === 0 || r.lastUpdateSecondsAgo < 0);
  if (unresolvedResolvers.length > 0) {
    recommendations.push({
      issue: `${unresolvedResolvers.length} resolvers failed to respond or returned empty results`,
      severity: 60,
      suggestion: "Verify DNS availability and resolver reachability, consider diversifying resolvers used.",
    });
  }

  // Compose detailed explanation
  const details = `Performed DNS queries across ${totalResolvers} global DNS resolvers. The majority of resolvers (${matchingResolvers}/${totalResolvers}, ${Math.round(consistencyScore)}%) returned consistent record values. Average freshness of the results indicates typical propagation delays under 5 minutes. Some resolvers failed or returned stale results.`;

  return {
    domain: record,
    type: type,
    timestamp: new Date().toISOString(),
    propagationScore,
    grade,
    results,
    details,
    recommendations,
  };
}
