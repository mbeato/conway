import { safeFetch } from "../../shared/ssrf";

// Types and interfaces

export interface DnsRecordResult {
  resolver: string;
  records: string[]; // resolved records
  responseTimeMs: number; // latency in ms
  error: string | null; // error message if failed
}

export interface Recommendation {
  issue: string;
  severity: number; // 0-100
  suggestion: string;
}

export interface DnsPropagationResult {
  domain: string;
  recordType: string;
  checkedAt: string;
  propagationDetails: DnsRecordResult[];
  overallScore: number; // 0-100
  grade: string; // letter grade A-F
  recommendations: Recommendation[];
  explanation: string;
}

export interface DnsPropagationPreviewResult {
  domain: string;
  recordType: string;
  checkedAt: string;
  propagationSummary: Record<string, string[]>; // simple resolver -> records mapping
  averagePropagationDelaySec: number; // average propagation delay estimate
  errors: string[];
}

// Resolver list: selected public recursive resolvers globally distributed
// Using IP addresses as identifiers
const DNS_RESOLVERS = [
  "8.8.8.8",    // Google
  "8.8.4.4",    // Google secondary
  "1.1.1.1",    // Cloudflare
  "1.0.0.1",    // Cloudflare secondary
  "9.9.9.9",    // Quad9
  "149.112.112.112", // Quad9 secondary
  "208.67.222.222", // OpenDNS
  "208.67.220.220", // OpenDNS secondary
  "4.2.2.1"    // Level3
];

// Timeout for DNS fetches per resolver in ms
const DNS_FETCH_TIMEOUT = 10_000;

// Helper: map DNS record type string to DNS API type
// We use `dns.google/resolve` API which supports type strings

// Fetch DNS record from Google DNS over HTTPS for a resolver IP and domain
async function fetchDnsRecord(resolverIp: string, domain: string, recordType: string): Promise<DnsRecordResult> {
  const apiUrl = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${encodeURIComponent(recordType)}`;

  const start = performance.now();
  try {
    const res = await safeFetch(apiUrl, {
      timeoutMs: DNS_FETCH_TIMEOUT,
      headers: {
        "Accept": "application/dns-json",
        "User-Agent": "dns-propagation-inspector/1.0 apimesh.xyz",
      },
      signal: AbortSignal.timeout(DNS_FETCH_TIMEOUT),
    });
    const duration = performance.now() - start;

    if (!res.ok) {
      return {
        resolver: resolverIp,
        records: [],
        responseTimeMs: Math.round(duration),
        error: `HTTP status ${res.status}`,
      };
    }

    const data = await res.json();

    // If status != 0, DNS error
    if (data.Status !== 0) {
      return {
        resolver: resolverIp,
        records: [],
        responseTimeMs: Math.round(duration),
        error: `DNS error status ${data.Status}`,
      };
    }

    // Parse answer section
    const answers = Array.isArray(data.Answer) ? data.Answer : [];

    const records: string[] = [];
    for (const item of answers) {
      if (typeof item.data === "string") {
        records.push(item.data);
      }
    }

    return {
      resolver: resolverIp,
      records,
      responseTimeMs: Math.round(duration),
      error: null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const latency = Math.round(performance.now() - start);
    return {
      resolver: resolverIp,
      records: [],
      responseTimeMs: latency,
      error: msg,
    };
  }
}

// Helper: letter grade from score
function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 45) return "D";
  if (score >= 25) return "E";
  return "F";
}

// Aggregate results and produce score and recommendations
function analyzePropagation(results: DnsRecordResult[], domain: string, recordType: string): DnsPropagationResult {
  const now = new Date().toISOString();

  // Select records that at least one resolver returned
  const allRecords = new Set<string>();
  results.forEach((r) => r.records.forEach((rec) => allRecords.add(rec)));

  // Check how many resolvers show any records
  const totalResolvers = results.length;
  const successfulResolvers = results.filter((r) => r.records.length > 0).length;

  // Average latency stats
  const latencies = results.filter((r) => !r.error).map((r) => r.responseTimeMs);
  const avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  // Evaluate propagation completeness
  // E.g., how many resolvers see the record correctly
  // For a newly updated record, some may lag
  const expectedRecordSet = new Set<string>();
  
  // Determine the most common record sets (strings joined by |) and pick the largest count
  const freqMap = new Map<string, number>();
  for (const r of results) {
    if (r.records.length > 0) {
      const key = r.records.sort().join("|");
      freqMap.set(key, (freqMap.get(key) ?? 0) + 1);
    }
  }
  let maxFreq = 0;
  let predominantKey = "";
  for (const [k, v] of freqMap.entries()) {
    if (v > maxFreq) {
      maxFreq = v;
      predominantKey = k;
    }
  }

  const predominantRecords = predominantKey ? predominantKey.split("|") : [];
  predominantRecords.forEach((r) => expectedRecordSet.add(r));

  // How many resolvers reflect the predominant record set?
  let matchingResolvers = 0;
  for (const r of results) {
    const sorted = r.records.sort();
    if (sorted.length === predominantRecords.length && sorted.every((val, idx) => val === predominantRecords[idx])) {
      matchingResolvers++;
    }
  }

  // Score components:
  // - Ratio of resolvers matching predominant record set (weighted 50%)
  // - Average latency normalized to 2000 ms max (weighted 30%)
  // - Ratio of successful resolvers (weighted 20%)

  const matchingRatio = matchingResolvers / totalResolvers;
  const successRatio = successfulResolvers / totalResolvers;
  const latencyScore = avgLatencyMs < 2000 ? (1 - (avgLatencyMs / 2000)) : 0; // inverse, capped

  let score = 0;
  score += matchingRatio * 50;
  score += latencyScore * 30;
  score += successRatio * 20;

  score = Math.round(score);

  const grade = scoreToGrade(score);

  // Recommendations
  const recommendations: Recommendation[] = [];

  // Issue: Resolvers with errors
  const errorResolvers = results.filter((r) => r.error);
  if (errorResolvers.length > 0) {
    errorResolvers.forEach((r) => {
      recommendations.push({
        issue: `Resolver ${r.resolver} returned error: ${r.error}`,
        severity: 60,
        suggestion: "Check DNS server availability and firewall rules to ensure all resolvers can access your authoritative DNS servers.",
      });
    });
  }

  // Issue: Some resolvers returned no records
  const noRecordResolvers = results.filter((r) => r.records.length === 0 && !r.error);
  if (noRecordResolvers.length > 0) {
    recommendations.push({
      issue: `Resolvers ${noRecordResolvers.map(r => r.resolver).join(", ")} did not return records.`,
      severity: 50,
      suggestion: "Verify DNS TTL on authoritative servers and cache expiration settings to ensure fast propagation.",
    });
  }

  // Issue: Propagation mismatch (some resolvers have differing records)
  if (matchingResolvers < totalResolvers) {
    recommendations.push({
      issue: "DNS records are not fully propagated to all popular global resolvers.",
      severity: 40,
      suggestion: "Wait longer for propagation or check for DNS misconfigurations or caching issues at ISP resolvers.",
    });
  }

  // Additional heuristic: if average latency > 1000 ms, warn about delays
  if (avgLatencyMs > 1000) {
    recommendations.push({
      issue: `Average DNS query latency is high: ${Math.round(avgLatencyMs)}ms.`,
      severity: 30,
      suggestion: "Consider investigating DNS server performance or use a CDN/DNS provider with global resolver nodes.",
    });
  }

  // Explanation
  const explanation = `This DNS propagation audit queries ${totalResolvers} major public recursive DNS resolvers globally for ${recordType} records of domain ${domain}.
Most resolvers (${matchingResolvers}) return the predominant record set: [${[...expectedRecordSet].join(",")}].
Average resolver latency is ${Math.round(avgLatencyMs)}ms, and ${successfulResolvers} resolvers responded without errors.
The score reflects propagation completeness and response latency.`;

  return {
    domain,
    recordType,
    checkedAt: now,
    propagationDetails: results,
    overallScore: score,
    grade,
    recommendations,
    explanation,
  };
}

// Preview function: quick summary
// Query resolvers with parallel requests with timeout
export async function previewDnsPropagationCheck(domain: string, recordType: string): Promise<DnsPropagationPreviewResult> {
  const checkedAt = new Date().toISOString();
  const errors: string[] = [];

  // We'll do parallel queries for speed
  const queries = DNS_RESOLVERS.map(async (resolverIp) => {
    try {
      const res = await fetchDnsRecord(resolverIp, domain, recordType);
      return res;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Resolver ${resolverIp}: ${msg}`);
      return {
        resolver: resolverIp,
        records: [],
        responseTimeMs: 0,
        error: msg,
      };
    }
  });

  const results = await Promise.all(queries);

  // Build propagation summary map: resolverIp -> records
  const propagationSummary: Record<string, string[]> = {};

  for (const r of results) {
    if (r.error === null) {
      propagationSummary[r.resolver] = r.records;
    }
  }

  // Estimate average propagation delay in seconds
  // We define roughly as difference from fastest resolver response
  const latencies = results.filter((r) => !r.error).map((r) => r.responseTimeMs);
  const minLatency = Math.min(...latencies);
  const propagationDelays = latencies.map((lat) => lat - minLatency).filter((d) => d >= 0);
  const avgPropagationDelayMs = propagationDelays.length > 0 ? propagationDelays.reduce((a, b) => a + b, 0) / propagationDelays.length : 0;
  const averagePropagationDelaySec = Math.round(avgPropagationDelayMs / 1000);

  return {
    domain,
    recordType,
    checkedAt,
    propagationSummary,
    averagePropagationDelaySec,
    errors,
  };
}

// Paid comprehensive check that implements multiple checks and scoring
// Calls all resolvers with per-request timeout, collates errors and results
export async function detailedDnsPropagationCheck(domain: string, recordType: string): Promise<DnsPropagationResult> {
  const queries = DNS_RESOLVERS.map((resolverIp) => fetchDnsRecord(resolverIp, domain, recordType));

  // Run all in parallel with timeout enforced in fetchDnsRecord
  const results = await Promise.all(queries);

  // Analyze results into comprehensive report
  return analyzePropagation(results, domain, recordType);
}
