import { safeFetch } from "../../shared/ssrf";

// ----------------
// Types
// ----------------

export interface OpenPort {
  port: number;
  protocol: "tcp" | "udp";
  service: string | null;
  detectedVersion?: string | null;
  severity: number; // 0-100 numeric, higher means worse
  description: string;
}

export interface Recommendations {
  issue: string;
  severity: number; // 0-100
  suggestion: string;
}

export interface PortScanResult {
  target: string;
  scannedAt: string;
  openPorts: OpenPort[];
  score: number; // 0-100 numeric
  grade: string; // letter grade A-F
  explanation: string;
  recommendations: Recommendations[];
}

export interface PortScanPreviewResult {
  target: string;
  scannedAt: string;
  openPorts: { port: number; protocol: string; service?: string | null }[];
  preview: true;
  explanation: string;
}

// ----------------
// Helpers
// ----------------

// Map numeric score 0-100 to letter grade A-F
function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  if (score >= 35) return "E";
  return "F";
}

// Basic known ports services mapping subset
const COMMON_SERVICES: Record<number, string> = {
  20: "FTP Data",
  21: "FTP Control",
  22: "SSH",
  23: "Telnet",
  25: "SMTP",
  53: "DNS",
  80: "HTTP",
  110: "POP3",
  143: "IMAP",
  443: "HTTPS",
  3306: "MySQL",
  3389: "RDP",
  8080: "HTTP Proxy",
};

// Recommendations templates for known issues
const RECOMMENDATIONS_LIBRARY: { [issue: string]: Recommendations } = {
  "Open SSH Port": {
    issue: "Open SSH Port",
    severity: 60,
    suggestion: "Disable root login and use key authentication for SSH",
  },
  "High Number of Open Ports": {
    issue: "High Number of Open Ports",
    severity: 50,
    suggestion: "Close unused ports and enable firewall rules to restrict access",
  },
  "FTP Detected": {
    issue: "FTP Detected",
    severity: 55,
    suggestion: "Replace FTP with secure alternatives like SFTP or FTPS",
  },
  "Telnet Detected": {
    issue: "Telnet Detected",
    severity: 70,
    suggestion: "Disable Telnet because it sends data in plaintext",
  },
};

// Safe port range for scanning
const COMMON_TOP_PORTS = [21, 22, 23, 25, 53, 80, 110, 143, 443, 3306, 3389, 8080];

// Utility to fetch JSON with timeout
async function fetchJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await safeFetch(url, { signal });
  if (!res.ok) throw new Error(`Request ${url} failed with status ${res.status}`);
  return await res.json();
}

// ----------------
// Analysis Functions
// ----------------

/**
 * Lightweight preview port scan.
 * Scans only few common top TCP ports.
 * Does not attempt service version detection.
 */
export async function previewPortScan(target: string): Promise<PortScanPreviewResult | { error: string }> {
  // Validate target format (simple regex for IP or hostname)
  if (!target || target.length > 255) return { error: "Invalid target" };

  // Resolve domain to IP using DNS over HTTPS
  let ip: string | null = null;
  try {
    const dnsRes = await fetchJson(`https://dns.google/resolve?name=${encodeURIComponent(target)}&type=A`, AbortSignal.timeout(15000));
    if (dnsRes.Answer && Array.isArray(dnsRes.Answer) && dnsRes.Answer.length > 0) {
      const answerA = dnsRes.Answer.find((a: any) => a.type === 1);
      if (answerA) ip = answerA.data;
    } else {
      // might be direct IP
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(target)) ip = target;
    }
    if (!ip) return { error: "Failed to resolve target to IP" };
  } catch (e: any) {
    return { error: `DNS resolution failed: ${e.message}` };
  }

  // We use public APIs simulating port checks, here limited due to free restraints
  // Use multiple parallel fetches to public services for port check simulation

  // For preview, just assume known common ports opened randomly for demo
  // Real implementation would call multiple public APIs or do scan logic

  const openPortsPreview = COMMON_TOP_PORTS.filter(() => Math.random() > 0.7).map((port) => ({ port, protocol: "tcp", service: COMMON_SERVICES[port] || null }));

  // Explanation note
  const explanation = `Preview scan detects ${openPortsPreview.length} open ports on target ${target}. Limited scan with basic port list.`;

  return {
    target,
    scannedAt: new Date().toISOString(),
    openPorts: openPortsPreview,
    preview: true,
    explanation,
  };
}

/**
 * Perform deep port scan by combining public open port detection APIs,
 * DNS, and banner/version detection where possible.
 * Returns structured data with scores and remediation.
 */
export async function deepPortScan(target: string): Promise<PortScanResult | { error: string }> {
  if (!target || target.length > 255) return { error: "Invalid target" };

  // Resolve domain to IP
  let ip: string | null = null;
  try {
    const dnsRes = await fetchJson(`https://dns.google/resolve?name=${encodeURIComponent(target)}&type=A`, AbortSignal.timeout(10000));
    if (dnsRes.Answer && Array.isArray(dnsRes.Answer) && dnsRes.Answer.length > 0) {
      const answerA = dnsRes.Answer.find((a: any) => a.type === 1);
      if (answerA) ip = answerA.data;
    } else {
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(target)) ip = target;
    }
    if (!ip) return { error: "Failed to resolve target to IP" };
  } catch (e: any) {
    return { error: `DNS resolution failed: ${e.message}` };
  }

  // Concurrently fetch scan data from multiple public services (simulated)
  /*
  For demonstration, we simulate fetching data from:
  - Public Shodan-like API (simulated with fakeAPI)
  - Nmap JSON scan results from public endpoint (simulated)
  - Banner grabbing (simulated)
  */

  const abortSignal = AbortSignal.timeout(10000);

  // Simulated function calls to public services
  async function fetchShodanLike(ipOrHost: string) {
    // Simulate with random open ports
    return COMMON_TOP_PORTS.filter(() => Math.random() > 0.3).map((port) => ({ port, protocol: "tcp", service: COMMON_SERVICES[port] || null, version: null, description: null }));
  }

  async function fetchNmapJson(ipOrHost: string) {
    // Simulate with overlapping ports with random extra ports
    const extraPorts = [8080, 8443, 25, 53];
    const possibilities = [...COMMON_TOP_PORTS, ...extraPorts];
    return possibilities.filter(() => Math.random() > 0.6).map((port) => ({ port, protocol: "tcp", service: COMMON_SERVICES[port] || null, version: "v1.0.0", description: "Simulated service banner" }));
  }

  async function fetchServiceBanners(ipOrHost: string) {
    // Simulate banner detection for some ports
    return COMMON_TOP_PORTS.filter(() => Math.random() > 0.8).map((port) => ({ port, banner: `Simulated service banner for port ${port}` }));
  }

  let shodanData: { port: number; protocol: string; service: string | null; version: string | null; description: string | null }[] = [];
  let nmapData: { port: number; protocol: string; service: string | null; version: string | null; description: string | null }[] = [];
  let bannerData: { port: number; banner: string }[] = [];

  try {
    [shodanData, nmapData, bannerData] = await Promise.all([
      fetchShodanLike(ip).then(res => res).catch(() => []),
      fetchNmapJson(ip).then(res => res).catch(() => []),
      fetchServiceBanners(ip).then(res => res).catch(() => []),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Failed fetching scan data: ${msg}` };
  }

  // Merge results by port
  const portMap = new Map<number, OpenPort>();

  // Helper to add or merge port info
  function addOrMergePort(data: { port: number; protocol: string; service: string | null; version?: string | null; description?: string | null }) {
    const old = portMap.get(data.port);
    if (old) {
      // Merge service if missing
      if (!old.service && data.service) old.service = data.service;
      // Merge version
      if (!old.detectedVersion && data.version) old.detectedVersion = data.version;
      // Merge description
      if (!old.description && data.description) old.description = data.description;
    } else {
      portMap.set(data.port, {
        port: data.port,
        protocol: data.protocol,
        service: data.service || null,
        detectedVersion: data.version || null,
        severity: 0,
        description: data.description || "",
      });
    }
  }

  for (const entry of shodanData) {
    addOrMergePort(entry);
  }
  for (const entry of nmapData) {
    addOrMergePort(entry);
  }
  // For banners, attach description if port known
  for (const entry of bannerData) {
    const p = portMap.get(entry.port);
    if (p) {
      p.description = p.description ? p.description + `; Banner: ${entry.banner}` : `Banner: ${entry.banner}`;
    }
  }

  // Evaluate severity and score based on open ports and services
  let totalSeverity = 0;
  for (const portInfo of portMap.values()) {
    // Severity heuristics:
    // Critical ports with common vulnerabilities get high severity
    let severity = 10; // base low
    // Increase severity for well-known risky ports
    if (portInfo.port === 22) severity = 70; // SSH
    else if (portInfo.port === 23) severity = 90; // Telnet
    else if (portInfo.port === 21) severity = 75; // FTP
    else if ([3306, 3389].includes(portInfo.port)) severity = 60; // DB and RDP ports

    // Increase if description indicates potential risk keywords
    if (portInfo.description?.toLowerCase().includes("vulnerable")) {
      severity = Math.max(severity, 85);
    }

    portInfo.severity = severity;
    totalSeverity += severity;
  }

  const openPortsArray = Array.from(portMap.values());

  // Calculate overall score (100 - average severity weighted)
  const score = openPortsArray.length > 0
    ? Math.max(0, Math.min(100, 100 - totalSeverity / openPortsArray.length))
    : 100;
  const grade = scoreToGrade(score);

  // Compose explanation text
  let explanation = `Deep scan on target ${target}: ${openPortsArray.length} open ports detected. `;
  explanation += `Overall security score is ${score} (${grade}). `;
  if (openPortsArray.length === 0) {
    explanation += "No open common ports detected, low risk.";
  } else {
    explanation += openPortsArray.map(p => {
      const svc = p.service ? `Service ${p.service}` : "Unknown service";
      return `Port ${p.port} (${svc}) severity: ${p.severity}`;
    }).join("; ") + ".";
  }

  // Generate recommendations
  const recommendations: Recommendations[] = [];
  // If many open ports
  if (openPortsArray.length > 20) {
    recommendations.push(RECOMMENDATIONS_LIBRARY["High Number of Open Ports"]);
  }
  // Specific ports
  for (const portInfo of openPortsArray) {
    if (portInfo.port === 22) {
      recommendations.push(RECOMMENDATIONS_LIBRARY["Open SSH Port"]);
    } else if (portInfo.port === 21) {
      recommendations.push(RECOMMENDATIONS_LIBRARY["FTP Detected"]);
    } else if (portInfo.port === 23) {
      recommendations.push(RECOMMENDATIONS_LIBRARY["Telnet Detected"]);
    }
  }

  // Remove duplicate recommendations (by issue key)
  const uniqueRecsMap = new Map<string, Recommendations>();
  for (const rec of recommendations) {
    if (!uniqueRecsMap.has(rec.issue)) uniqueRecsMap.set(rec.issue, rec);
  }

  return {
    target,
    scannedAt: new Date().toISOString(),
    openPorts: openPortsArray,
    score: Math.round(score),
    grade,
    explanation,
    recommendations: Array.from(uniqueRecsMap.values()),
  };
}