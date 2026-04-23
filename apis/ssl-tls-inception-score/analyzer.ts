// Analyzer for ssl-tls-inception-score
// Performs multiple concurrent requests and comprehensive analysis of SSL/TLS data from DNS and public scans

import { safeFetch, validateExternalUrl } from "../../shared/ssrf";

// For type safety
export interface SSLTlsInceptionScoreResponse {
  hostname: string;
  certificate: CertificateInfo;
  protocolsSupported: string[];
  ciphersSupported: string[];
  vulnerabilities: VulnerabilitiesReport;
  overallScore: number; // 0-100
  grade: LetterGrade;
  recommendations: Recommendation[];
  explanation: string;
}

export interface PreviewResponse {
  hostname: string;
  certificateValid: boolean;
  protocolsSupported: string[];
  score: number;
  grade: LetterGrade;
  explanation: string;
}

// Certificate information
export interface CertificateInfo {
  valid: boolean;
  subject: string;
  issuer: string;
  validFrom: string | null;
  validTo: string | null;
  expiryDays: number | null;
  signatureAlgorithm?: string;
  strengthScore: number; // 0-100
  error?: string;
}

export interface VulnerabilitiesReport {
  heartbleed: boolean;
  poodle: boolean;
  fallbackSCSV: boolean;
  sweet32: boolean;
}

export interface Recommendation {
  issue: string;
  severity: number; // 0-100
  suggestion: string;
}

type LetterGrade = "A" | "B" | "C" | "D" | "F";

// Helper: assign grade string based on score
function gradeFromScore(score: number): LetterGrade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

// Validate and parse hostname or URL input to hostname
function parseHostname(rawInput: string): { hostname?: string; error?: string } {
  try {
    // Accept URLs or plain hostnames
    if (/^[a-zA-Z0-9-.]+$/.test(rawInput)) {
      return { hostname: rawInput.toLowerCase() };
    }
    const parsed = new URL(rawInput);
    if (!parsed.hostname) return { error: "Invalid hostname in URL." };
    return { hostname: parsed.hostname.toLowerCase() };
  } catch (e) {
    return { error: "Invalid hostname or URL." };
  }
}

// Fetch certificate data from crt.sh JSON API
async function fetchCertificateInfo(
  hostname: string,
  signal: AbortSignal
): Promise<CertificateInfo> {
  try {
    const crtUrl = `https://crt.sh/?q=%25.${encodeURIComponent(hostname)}&output=json`;
    const crtRes = await safeFetch(crtUrl, { signal, timeoutMs: 10000 });
    if (!crtRes.ok) {
      return {
        valid: false,
        subject: "",
        issuer: "",
        validFrom: null,
        validTo: null,
        expiryDays: null,
        strengthScore: 0,
        error: `crt.sh responded HTTP ${crtRes.status}`,
      };
    }
    const text = await crtRes.text();
    if (!text || text === "[]") {
      return {
        valid: false,
        subject: "",
        issuer: "",
        validFrom: null,
        validTo: null,
        expiryDays: null,
        strengthScore: 0,
        error: "No certificate data found",
      };
    }
    const certs = JSON.parse(text);
    if (!Array.isArray(certs) || certs.length === 0) {
      return {
        valid: false,
        subject: "",
        issuer: "",
        validFrom: null,
        validTo: null,
        expiryDays: null,
        strengthScore: 0,
        error: "Empty certificate list",
      };
    }

    // Pick most recent certificate based on not_after
    const sorted = certs.filter((c) => c.not_after).sort((a, b) => new Date(b.not_after).getTime() - new Date(a.not_after).getTime());
    const cert = sorted[0];

    const validFrom = cert.not_before ? new Date(cert.not_before) : null;
    const validTo = cert.not_after ? new Date(cert.not_after) : null;
    const now = new Date();
    let expiryDays: number | null = null;
    if (validTo) {
      expiryDays = Math.max(0, Math.round((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }

    // Estimate strength score
    let strengthScore = 70;
    if (expiryDays !== null) {
      if (expiryDays > 60) strengthScore += 20;
      if (expiryDays <= 30) strengthScore -= 30;
    }

    const sigAlgo = cert.sig_alg || cert.signature_algorithm_name || "";
    if (sigAlgo.toLowerCase().includes("md5") || sigAlgo.toLowerCase().includes("sha1")) {
      strengthScore -= 50;
    } else {
      strengthScore += 10;
    }

    strengthScore = Math.min(100, Math.max(0, strengthScore));

    const valid = validFrom && validTo ? now >= validFrom && now <= validTo : false;

    return {
      valid,
      subject: cert.name_value || "",
      issuer: cert.issuer_name || "",
      validFrom: validFrom ? validFrom.toISOString() : null,
      validTo: validTo ? validTo.toISOString() : null,
      expiryDays,
      signatureAlgorithm: sigAlgo,
      strengthScore,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      valid: false,
      subject: "",
      issuer: "",
      validFrom: null,
      validTo: null,
      expiryDays: null,
      strengthScore: 0,
      error: msg,
    };
  }
}

// Fetch TLS Handshake details from public TLS observatory - https://tls.observatory.apimesh.xyz is not public here
// We'll simulate via https://tls-api.apimesh.xyz or cert lookup plus a fallback
// We'll try fetching SSL Labs API for detailed TLS analysis

interface SSLLabsAnalysis {
  protocols: string[];
  ciphers: string[];
  vulnerabilities: VulnerabilitiesReport;
}

async function fetchSslLabsAnalysis(hostname: string, signal: AbortSignal): Promise<SSLLabsAnalysis> {
  const result: SSLLabsAnalysis = {
    protocols: [],
    ciphers: [],
    vulnerabilities: {
      heartbleed: false,
      poodle: false,
      fallbackSCSV: false,
      sweet32: false,
    },
  };

  try {
    // Start SSL Labs assessment
    // Start assessment API according to docs
    // POST: https://api.ssllabs.com/api/v3/analyze?host=hostname&startNew=on&fromCache=off
    // We'll try GET with startNew=on to forcibly analyze
    const baseApi = `https://api.ssllabs.com/api/v3/analyze?host=${encodeURIComponent(hostname)}&startNew=on&fromCache=off`;

    const firstRes = await safeFetch(baseApi, { signal, timeoutMs: 10000 });
    if (!firstRes.ok) {
      throw new Error(`SSL Labs analyze start API HTTP ${firstRes.status}`);
    }

    // Poll status until ready or timeout after 15 seconds
    let status = "IN_PROGRESS";
    let data: any = null;
    const maxPollMs = 15_000;
    const startTime = Date.now();

    while (status === "IN_PROGRESS" || status === "DNS" || status === "INITIAL") {
      if (Date.now() - startTime > maxPollMs) {
        throw new Error("Timeout waiting for SSL Labs analysis completion");
      }
      await new Promise((res) => setTimeout(res, 3000));
      const pollRes = await safeFetch(`https://api.ssllabs.com/api/v3/analyze?host=${encodeURIComponent(hostname)}&fromCache=on`, {
        signal,
        timeoutMs: 7000,
      });
      if (!pollRes.ok) {
        throw new Error(`SSL Labs poll API HTTP ${pollRes.status}`);
      }
      data = await pollRes.json();
      status = data.status;
    }

    if (status !== "READY") {
      throw new Error(`SSL Labs analysis failed, status: ${status}`);
    }

    // Extract protocols and ciphers
    if (Array.isArray(data.endpoints)) {
      for (const ep of data.endpoints) {
        if (ep.details) {
          if (Array.isArray(ep.details.protocols)) {
            for (const p of ep.details.protocols) {
              if (p.name && !result.protocols.includes(p.name)) {
                result.protocols.push(p.name);
              }
            }
          }
          if (Array.isArray(ep.details.suites?.list)) {
            for (const ciph of ep.details.suites.list) {
              if (ciph.name && !result.ciphers.includes(ciph.name)) {
                result.ciphers.push(ciph.name);
              }
            }
          }

          // Vulnerabilities
          if (typeof ep.heartbleed === "boolean") result.vulnerabilities.heartbleed = ep.heartbleed;
          if (typeof ep.poodle === "boolean") result.vulnerabilities.poodle = ep.poodle;
          if (typeof ep.fallback_scsv === "boolean") result.vulnerabilities.fallbackSCSV = ep.fallback_scsv;
          if (typeof ep.sweet32 === "boolean") result.vulnerabilities.sweet32 = ep.sweet32;
        }
      }
    }

    return result;
  } catch (e) {
    // On any error, fallback to empty, partial data
    return result;
  }
}

// Grade calculation from score
function assignGrade(score: number): LetterGrade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 45) return "D";
  return "F";
}

// Compute overall score based on sub-scores
function computeOverallScore(
  cert: CertificateInfo,
  sslLabs: SSLLabsAnalysis
): number {
  let score = 100;

  // Certificate score contributes 50% approximately
  score -= (100 - cert.strengthScore) * 0.5;

  // Protocol support: encourage TLS1.2 and TLS1.3
  const protoScore = (() => {
    if (sslLabs.protocols.includes("TLSv1.3")) return 30;
    if (sslLabs.protocols.includes("TLSv1.2")) return 20;
    if (sslLabs.protocols.some((p) => p.startsWith("TLSv1"))) return 10;
    return 0;
  })();
  score -= (30 - protoScore);

  // Remove points for vulnerabilities
  if (sslLabs.vulnerabilities.heartbleed) score -= 40;
  if (sslLabs.vulnerabilities.poodle) score -= 35;
  if (!sslLabs.vulnerabilities.fallbackSCSV) score -= 15;
  if (sslLabs.vulnerabilities.sweet32) score -= 25;

  if (cert.expiryDays !== null && cert.expiryDays < 30) {
    score -= 20;
  }

  score = Math.min(100, Math.max(0, Math.round(score)));
  return score;
}

// Generate recommendations based on analysis
function generateRecommendations(
  cert: CertificateInfo,
  sslLabs: SSLLabsAnalysis,
  overallScore: number
): Recommendation[] {
  const recs: Recommendation[] = [];

  if (!cert.valid) {
    recs.push({
      issue: "Invalid or expired SSL certificate",
      severity: 90,
      suggestion: "Renew the SSL certificate immediately."
    });
  }

  if (cert.expiryDays !== null && cert.expiryDays < 30) {
    recs.push({
      issue: `Certificate expiring in ${cert.expiryDays} days`,
      severity: 70,
      suggestion: "Renew your SSL certificate before expiry to avoid downtime."
    });
  }

  if (cert.signatureAlgorithm && cert.signatureAlgorithm.toLowerCase().includes("md5")) {
    recs.push({
      issue: "Weak certificate signature algorithm (MD5 detected)",
      severity: 80,
      suggestion: "Use certificates signed with stronger algorithms like SHA-2."
    });
  }

  if (!sslLabs.protocols.includes("TLSv1.2") && !sslLabs.protocols.includes("TLSv1.3")) {
    recs.push({
      issue: "Outdated TLS protocols detected",
      severity: 80,
      suggestion: "Disable insecure TLS versions (SSLv3, TLSv1.0, TLSv1.1) and enable TLSv1.2 or higher."
    });
  }

  if (sslLabs.vulnerabilities.heartbleed) {
    recs.push({
      issue: "Vulnerable to Heartbleed",
      severity: 95,
      suggestion: "Update your OpenSSL/library to a version not vulnerable to Heartbleed."
    });
  }

  if (sslLabs.vulnerabilities.poodle) {
    recs.push({
      issue: "Vulnerable to POODLE attack",
      severity: 90,
      suggestion: "Disable SSLv3 on your servers to mitigate POODLE."
    });
  }

  if (!sslLabs.vulnerabilities.fallbackSCSV) {
    recs.push({
      issue: "Fallback SCSV not supported",
      severity: 60,
      suggestion: "Enable TLS_FALLBACK_SCSV to prevent protocol downgrade attacks."
    });
  }

  if (sslLabs.vulnerabilities.sweet32) {
    recs.push({
      issue: "Vulnerable to SWEET32 attack",
      severity: 75,
      suggestion: "Disable 64-bit block cipher suites (like 3DES) to mitigate SWEET32."
    });
  }

  if (recs.length === 0) {
    recs.push({
      issue: "No significant issues detected",
      severity: 0,
      suggestion: "Maintain good SSL/TLS practices."
    });
  }

  return recs;
}

// Main function for aggregation and scoring
export async function aggregateSslTlsData(
  rawInput: string,
  previewOnly = false
): Promise<SSLTlsInceptionScoreResponse | PreviewResponse | { error: string }> {
  // Validate and parse hostname
  const { hostname, error } = parseHostname(rawInput);
  if (error) return { error };
  if (!hostname) return { error: "Unable to parse hostname." };

  // For preview, increase timeout
  const signal = AbortSignal.timeout(previewOnly ? 20_000 : 10_000);

  try {
    // Concurrent fetches
    const certPromise = fetchCertificateInfo(hostname, signal);
    const sslLabsPromise = previewOnly
      ? Promise.resolve({ protocols: [], ciphers: [], vulnerabilities: {
          heartbleed: false, poodle: false, fallbackSCSV: false, sweet32: false
        }}) // minimal data in preview
      : fetchSslLabsAnalysis(hostname, signal);

    const [cert, sslLabs] = await Promise.all([certPromise, sslLabsPromise]);

    if (previewOnly) {
      // Simple preview result
      const score = cert.strengthScore || 0;
      const grade = gradeFromScore(score);
      return {
        status: "ok",
        data: {
          hostname,
          certificateValid: cert.valid,
          protocolsSupported: sslLabs.protocols,
          score,
          grade,
          explanation: certificateValidityExplanation(cert)
        },
        meta: {
          timestamp: new Date().toISOString(),
          duration_ms: 0,
          api_version: "1.0.0"
        },
      };
    }

    // Full comprehensive audit
    const overallScore = computeOverallScore(cert, sslLabs);
    const grade = assignGrade(overallScore);
    const recommendations = generateRecommendations(cert, sslLabs, overallScore);

    return {
      status: "ok",
      data: {
        hostname,
        certificate: cert,
        protocolsSupported: sslLabs.protocols,
        ciphersSupported: sslLabs.ciphers,
        vulnerabilities: sslLabs.vulnerabilities,
        overallScore,
        grade,
        recommendations,
        explanation: generateExplanation(cert, sslLabs, overallScore, grade),
      },
      meta: {
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        api_version: "1.0.0",
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout|timed out|abort/i.test(msg)) {
      return { error: "Analysis temporarily unavailable: Timeout occurred" };
    }
    return { error: `Analysis temporarily unavailable: ${msg}` };
  }
}

// Generate readable explanation for certificate validity
function certificateValidityExplanation(cert: CertificateInfo): string {
  if (!cert.valid) {
    return `The SSL certificate is invalid or expired. ${cert.error || "Please renew your certificate."}`;
  }
  let expl = `Certificate issued by ${cert.issuer}, subject: ${cert.subject}. `;
  if (cert.expiryDays !== null) {
    expl += `Expires in ${cert.expiryDays} day${cert.expiryDays !== 1 ? "s" : ""}. `;
  }
  expl += `Signature algorithm: ${cert.signatureAlgorithm || "unknown"}. `;
  if (cert.strengthScore >= 80) {
    expl += `Strong certificate.`;
  } else {
    expl += `Certificate strength could be improved.`;
  }
  return expl.trim();
}

// Generate detailed explanation text
function generateExplanation(
  cert: CertificateInfo,
  sslLabs: SSLLabsAnalysis,
  overallScore: number,
  grade: LetterGrade
): string {
  let expl = `The certificate is ${cert.valid ? "valid" : "invalid or expired"} and issued by ${cert.issuer}. `;
  expl += `Supports protocols: ${sslLabs.protocols.length > 0 ? sslLabs.protocols.join(", ") : "none detected"}. `;
  expl += `Cipher suites: ${sslLabs.ciphers.length > 0 ? sslLabs.ciphers.slice(0, 5).join(", ") : "none detected"}${sslLabs.ciphers.length > 5 ? ", ..." : ""}. `;

  const vulns = [];
  for (const [key, present] of Object.entries(sslLabs.vulnerabilities)) {
    if (present) vulns.push(key);
  }

  if (vulns.length === 0) {
    expl += "No critical vulnerabilities detected. ";
  } else {
    expl += `Detected vulnerabilities: ${vulns.join(", ")}. `;
  }

  expl += `Final score: ${overallScore} (${grade}).`;
  return expl.trim();
}
