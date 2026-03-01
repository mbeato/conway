import { validateExternalUrl, safeFetch } from "../../shared/ssrf";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RobotsTxtCheck {
  allowed: boolean;
  reason: string;
  robotsTxtStatus: number | null;
  matchedRule: string | null;
  matchedAgent: string | null;
}

export interface HttpStatusCheck {
  status: number;
  statusText: string;
  indexable: boolean;
  redirect: boolean;
  redirectLocation: string | null;
}

export interface MetaRobotsCheck {
  found: boolean;
  content: string | null;
  noindex: boolean;
  nofollow: boolean;
}

export interface XRobotsTagCheck {
  found: boolean;
  value: string | null;
  noindex: boolean;
  nofollow: boolean;
}

export interface CanonicalCheck {
  found: boolean;
  href: string | null;
  isSelf: boolean;
  pointsElsewhere: boolean;
}

export interface IndexabilityResult {
  indexable: boolean;
  blocking_reason: string | null;
  checks: {
    robots_txt: RobotsTxtCheck;
    http_status: HttpStatusCheck;
    meta_robots: MetaRobotsCheck;
    x_robots_tag: XRobotsTagCheck;
    canonical: CanonicalCheck;
  };
  url: string;
  checkedAt: string;
}

export interface PreviewResult {
  preview: true;
  indexable: boolean;
  blocking_reason: string | null;
  checks: {
    http_status: HttpStatusCheck;
    meta_robots: MetaRobotsCheck;
  };
  url: string;
  checkedAt: string;
  note: string;
}

// ── Regex patterns ──────────────────────────────────────────────────────────

const META_ROBOTS_RE = /<meta\s+name=["'](?:robots|googlebot)["']\s+content=["']([^"']+)["']/gi;
const META_ROBOTS_REV_RE = /<meta\s+content=["']([^"']+)["']\s+name=["'](?:robots|googlebot)["']/gi;
const CANONICAL_RE = /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i;
const CANONICAL_REV_RE = /<link\s+href=["']([^"']+)["']\s+rel=["']canonical["']/i;

// ── robots.txt parsing ──────────────────────────────────────────────────────

interface RobotRule {
  type: "allow" | "disallow";
  path: string;
}

interface AgentBlock {
  agents: string[];
  rules: RobotRule[];
}

function parseRobotsTxtBlocks(text: string): AgentBlock[] {
  const blocks: AgentBlock[] = [];
  let currentAgents: string[] = [];
  let currentRules: RobotRule[] = [];

  const flushBlock = () => {
    if (currentAgents.length > 0) {
      blocks.push({ agents: currentAgents.slice(), rules: currentRules.slice() });
    }
    currentAgents = [];
    currentRules = [];
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === "user-agent") {
      // If we already have rules, flush current block and start new
      if (currentRules.length > 0) {
        flushBlock();
      }
      currentAgents.push(value.toLowerCase());
    } else if (field === "allow") {
      currentRules.push({ type: "allow", path: value });
    } else if (field === "disallow") {
      currentRules.push({ type: "disallow", path: value });
    }
  }
  flushBlock();
  return blocks;
}

function matchRobotRule(urlPath: string, rulePath: string): boolean {
  if (!rulePath) return false;

  // Handle wildcard and end-of-string anchor per Google's spec
  // Convert rule to regex: * -> .*, $ at end is literal end anchor
  let pattern = rulePath
    .replace(/[.+?^{}()|[\]\\]/g, "\\$&") // escape regex chars except * and $
    .replace(/\*/g, ".*");

  if (pattern.endsWith("$")) {
    pattern = pattern.slice(0, -1) + "$";
  } else {
    pattern = pattern + ".*";
  }

  try {
    return new RegExp("^" + pattern).test(urlPath);
  } catch {
    // Fallback: simple prefix match
    return urlPath.startsWith(rulePath);
  }
}

function checkRobotsTxtRules(blocks: AgentBlock[], urlPath: string): { allowed: boolean; matchedRule: string | null; matchedAgent: string | null } {
  // Prefer Googlebot-specific block, then fallback to wildcard
  let targetBlock: AgentBlock | null = null;
  let matchedAgent: string | null = null;

  for (const block of blocks) {
    if (block.agents.includes("googlebot")) {
      targetBlock = block;
      matchedAgent = "googlebot";
      break;
    }
  }

  if (!targetBlock) {
    for (const block of blocks) {
      if (block.agents.includes("*")) {
        targetBlock = block;
        matchedAgent = "*";
        break;
      }
    }
  }

  if (!targetBlock) {
    return { allowed: true, matchedRule: null, matchedAgent: null };
  }

  // Longest match wins (per Google's robots.txt spec)
  let bestMatch: { type: "allow" | "disallow"; path: string; length: number } | null = null;

  for (const rule of targetBlock.rules) {
    if (matchRobotRule(urlPath, rule.path)) {
      const ruleLength = rule.path.replace(/\*/g, "").length;
      if (!bestMatch || ruleLength > bestMatch.length) {
        bestMatch = { type: rule.type, path: rule.path, length: ruleLength };
      }
    }
  }

  if (!bestMatch) {
    return { allowed: true, matchedRule: null, matchedAgent };
  }

  return {
    allowed: bestMatch.type === "allow",
    matchedRule: `${bestMatch.type}: ${bestMatch.path}`,
    matchedAgent,
  };
}

// ── Layer checks ────────────────────────────────────────────────────────────

async function checkRobotsTxt(parsedUrl: URL): Promise<RobotsTxtCheck> {
  const robotsUrl = `${parsedUrl.origin}/robots.txt`;

  try {
    const res = await safeFetch(robotsUrl, { timeoutMs: 5000 });
    const status = res.status;

    // 4xx = allowed (no restrictions)
    if (status >= 400 && status < 500) {
      return {
        allowed: true,
        reason: "robots.txt returned 4xx (no restrictions)",
        robotsTxtStatus: status,
        matchedRule: null,
        matchedAgent: null,
      };
    }

    // 5xx = blocked (conservative)
    if (status >= 500) {
      return {
        allowed: false,
        reason: "robots.txt returned 5xx (blocked conservatively per Google spec)",
        robotsTxtStatus: status,
        matchedRule: null,
        matchedAgent: null,
      };
    }

    const text = await res.text();
    const blocks = parseRobotsTxtBlocks(text);
    const urlPath = parsedUrl.pathname + parsedUrl.search;
    const result = checkRobotsTxtRules(blocks, urlPath);

    return {
      allowed: result.allowed,
      reason: result.allowed
        ? result.matchedRule
          ? `Allowed by robots.txt (${result.matchedRule})`
          : "No blocking rule found in robots.txt"
        : `Blocked by robots.txt (${result.matchedRule})`,
      robotsTxtStatus: status,
      matchedRule: result.matchedRule,
      matchedAgent: result.matchedAgent,
    };
  } catch (err: any) {
    // Network error fetching robots.txt = treat as allowed
    return {
      allowed: true,
      reason: `robots.txt unreachable (${err?.message || "unknown error"}) — treated as allowed`,
      robotsTxtStatus: null,
      matchedRule: null,
      matchedAgent: null,
    };
  }
}

function checkHttpStatus(status: number, statusText: string, headers: Headers): HttpStatusCheck {
  const redirect = status >= 300 && status < 400;
  const redirectLocation = redirect ? headers.get("location") : null;

  // 200-299 = indexable, everything else is not directly indexable
  const indexable = status >= 200 && status < 300;

  return {
    status,
    statusText,
    indexable,
    redirect,
    redirectLocation,
  };
}

function checkMetaRobots(html: string): MetaRobotsCheck {
  // Reset regex lastIndex
  META_ROBOTS_RE.lastIndex = 0;
  META_ROBOTS_REV_RE.lastIndex = 0;

  const contents: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = META_ROBOTS_RE.exec(html)) !== null) {
    contents.push(match[1].toLowerCase());
  }
  while ((match = META_ROBOTS_REV_RE.exec(html)) !== null) {
    contents.push(match[1].toLowerCase());
  }

  if (contents.length === 0) {
    return { found: false, content: null, noindex: false, nofollow: false };
  }

  const combined = contents.join(", ");
  const noindex = contents.some((c) => c.includes("noindex"));
  const nofollow = contents.some((c) => c.includes("nofollow"));

  return { found: true, content: combined, noindex, nofollow };
}

function checkXRobotsTag(headers: Headers): XRobotsTagCheck {
  const value = headers.get("x-robots-tag");

  if (!value) {
    return { found: false, value: null, noindex: false, nofollow: false };
  }

  const lower = value.toLowerCase();
  return {
    found: true,
    value,
    noindex: lower.includes("noindex"),
    nofollow: lower.includes("nofollow"),
  };
}

function checkCanonical(html: string, url: string): CanonicalCheck {
  const match = CANONICAL_RE.exec(html) || CANONICAL_REV_RE.exec(html);

  if (!match) {
    return { found: false, href: null, isSelf: false, pointsElsewhere: false };
  }

  const href = match[1].trim();

  // Normalize both URLs for comparison (remove trailing slash, fragment)
  let normalizedHref: string;
  let normalizedUrl: string;
  try {
    const canonicalParsed = new URL(href, url);
    normalizedHref = canonicalParsed.origin + canonicalParsed.pathname.replace(/\/+$/, "") + canonicalParsed.search;
    const urlParsed = new URL(url);
    normalizedUrl = urlParsed.origin + urlParsed.pathname.replace(/\/+$/, "") + urlParsed.search;
  } catch {
    return { found: true, href, isSelf: false, pointsElsewhere: true };
  }

  const isSelf = normalizedHref === normalizedUrl;

  return {
    found: true,
    href,
    isSelf,
    pointsElsewhere: !isSelf,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function fullCheck(rawUrl: string): Promise<IndexabilityResult | { error: string }> {
  const validation = validateExternalUrl(rawUrl);
  if ("error" in validation) {
    return { error: validation.error };
  }

  const parsedUrl = validation.url;
  const url = parsedUrl.toString();
  const blockingReasons: string[] = [];

  // 1. robots.txt check
  const robotsTxt = await checkRobotsTxt(parsedUrl);
  if (!robotsTxt.allowed) {
    blockingReasons.push(`robots.txt: ${robotsTxt.reason}`);
  }

  // 2-5. Fetch the actual URL for HTTP status, meta robots, x-robots-tag, canonical
  let httpStatus: HttpStatusCheck;
  let metaRobots: MetaRobotsCheck;
  let xRobotsTag: XRobotsTagCheck;
  let canonical: CanonicalCheck;

  try {
    const res = await safeFetch(url, { timeoutMs: 10000 });

    // 2. HTTP status
    httpStatus = checkHttpStatus(res.status, res.statusText, res.headers);
    if (!httpStatus.indexable) {
      blockingReasons.push(`HTTP status: ${res.status} ${res.statusText}`);
    }

    // 4. X-Robots-Tag (check header before consuming body)
    xRobotsTag = checkXRobotsTag(res.headers);
    if (xRobotsTag.noindex) {
      blockingReasons.push(`X-Robots-Tag: ${xRobotsTag.value}`);
    }

    // Read body for meta robots and canonical
    const html = httpStatus.indexable ? await res.text() : "";

    // 3. Meta robots
    metaRobots = checkMetaRobots(html);
    if (metaRobots.noindex) {
      blockingReasons.push(`Meta robots: ${metaRobots.content}`);
    }

    // 5. Canonical
    canonical = checkCanonical(html, url);
    if (canonical.pointsElsewhere) {
      blockingReasons.push(`Canonical points elsewhere: ${canonical.href}`);
    }
  } catch (err: any) {
    return { error: `Failed to fetch URL: ${err?.message || "unknown error"}` };
  }

  return {
    indexable: blockingReasons.length === 0,
    blocking_reason: blockingReasons.length > 0 ? blockingReasons[0] : null,
    checks: {
      robots_txt: robotsTxt,
      http_status: httpStatus,
      meta_robots: metaRobots,
      x_robots_tag: xRobotsTag,
      canonical,
    },
    url,
    checkedAt: new Date().toISOString(),
  };
}

export async function previewCheck(rawUrl: string): Promise<PreviewResult | { error: string }> {
  const validation = validateExternalUrl(rawUrl);
  if ("error" in validation) {
    return { error: validation.error };
  }

  const url = validation.url.toString();
  const blockingReasons: string[] = [];

  let httpStatus: HttpStatusCheck;
  let metaRobots: MetaRobotsCheck;

  try {
    const res = await safeFetch(url, { timeoutMs: 8000 });

    httpStatus = checkHttpStatus(res.status, res.statusText, res.headers);
    if (!httpStatus.indexable) {
      blockingReasons.push(`HTTP status: ${res.status} ${res.statusText}`);
    }

    const html = httpStatus.indexable ? await res.text() : "";

    metaRobots = checkMetaRobots(html);
    if (metaRobots.noindex) {
      blockingReasons.push(`Meta robots: ${metaRobots.content}`);
    }
  } catch (err: any) {
    return { error: `Failed to fetch URL: ${err?.message || "unknown error"}` };
  }

  return {
    preview: true,
    indexable: blockingReasons.length === 0,
    blocking_reason: blockingReasons.length > 0 ? blockingReasons[0] : null,
    checks: {
      http_status: httpStatus,
      meta_robots: metaRobots,
    },
    url,
    checkedAt: new Date().toISOString(),
    note: "Preview checks HTTP status and meta robots only. Use /check with x402 payment for full 5-layer analysis (robots.txt, canonical, X-Robots-Tag).",
  };
}
