// A2A Protocol v1.0 AgentCard generator.
// Spec: https://a2a-protocol.org/latest/specification/ §4.4.1, §8.5, §14.3.
//
// We expose two shapes:
//   - buildPlatformAgentCard(host)       — one card describing all of APIMesh,
//                                          with one A2A "skill" per registered API
//   - buildPerApiAgentCard(subdomain, h) — one card describing a single API
//
// Reuses the price/endpoint/category data from shared/mpp-manifest.ts so the
// two manifests stay aligned without duplication.

import { registry } from "../apis/registry";
import { buildApiEntry, type ApiEntry } from "./mpp-manifest";

const CONTACT = "c@vtxathlete.com";
const PROTOCOL_VERSION = "1.0";
const AGENT_VERSION = "1.0.0";

interface SupportedInterface {
  url: string;
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON";
  protocolVersion: string;
}

interface AgentCardCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  stateTransitionHistory: boolean;
  extendedAgentCard: boolean;
}

interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  protocolVersion: string;
  provider: { organization: string; url: string };
  iconUrl?: string;
  documentationUrl?: string;
  supportedInterfaces: SupportedInterface[];
  capabilities: AgentCardCapabilities;
  skills: AgentSkill[];
  securitySchemes: Record<string, unknown>;
  security: Array<Record<string, string[]>>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  generated_at: string;
}

function rootFor(host: string): string {
  if (host.endsWith("apimesh.xyz")) return "https://apimesh.xyz";
  return `https://${host}`;
}

function subdomainBase(subdomain: string, host: string): string {
  if (host.endsWith("apimesh.xyz")) return `https://${subdomain}.apimesh.xyz`;
  return `https://${subdomain}.${host.replace(/^[^.]+\./, "")}`;
}

function exampleFor(entry: ApiEntry): string {
  return `${entry.method} ${entry.endpoint}`;
}

function skillFromEntry(entry: ApiEntry): AgentSkill {
  return {
    id: entry.name,
    name: entry.name,
    description: `${entry.description} (price: $${entry.price_usd} per call)`,
    tags: entry.tags,
    examples: [exampleFor(entry)],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
  };
}

// Payment-required security scheme. A2A spec allows custom scheme types via
// the `securitySchemes` map; "Payment" is consistent with HTTP Payment-Required
// (402) and the WWW-Authenticate: Payment challenge that x402 + MPP both use.
function paymentSecuritySchemes(root: string): Record<string, unknown> {
  return {
    x402: {
      type: "Payment",
      protocol: "x402",
      version: "1",
      networks: ["base-mainnet"],
      asset: "USDC",
      description: "Pay per request via x402 (HTTP 402 + WWW-Authenticate: Payment).",
    },
    mpp: {
      type: "Payment",
      protocol: "mpp",
      version: "draft-ryan-httpauth-payment",
      description: "Pay per request via MPP (HTTP 402 + WWW-Authenticate: Payment).",
    },
    apiKey: {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description: "Bearer sk_live_… key purchased at /signup (Stripe).",
      "x-purchase-url": `${root}/signup`,
    },
  };
}

const SECURITY_REQUIREMENT: Array<Record<string, string[]>> = [
  { x402: [] },
  { mpp: [] },
  { apiKey: [] },
];

export function buildPlatformAgentCard(host: string = "apimesh.xyz"): AgentCard {
  const root = rootFor(host);
  const apis = Object.keys(registry)
    .filter(s => s !== "check" && s !== "dashboard" && s !== "landing" && s !== "router")
    .sort()
    .map(s => buildApiEntry(s, host));

  return {
    name: "APIMesh",
    description: `Pay-per-call API marketplace. ${apis.length} web-analysis, SEO, security, and devops APIs exposed as A2A skills for agents.`,
    version: AGENT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    provider: { organization: "APIMesh", url: root },
    iconUrl: `${root}/favicon.ico`,
    documentationUrl: `${root}/openapi.json`,
    supportedInterfaces: [
      {
        url: root,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.1",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extendedAgentCard: false,
    },
    skills: apis.map(skillFromEntry),
    securitySchemes: paymentSecuritySchemes(root),
    security: SECURITY_REQUIREMENT,
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    generated_at: new Date().toISOString(),
  };
}

export function buildPerApiAgentCard(subdomain: string, host: string): AgentCard {
  const root = rootFor(host);
  const base = subdomainBase(subdomain, host);
  const entry = buildApiEntry(subdomain, host);

  return {
    name: subdomain,
    description: entry.description,
    version: AGENT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    provider: { organization: "APIMesh", url: root },
    iconUrl: `${root}/favicon.ico`,
    documentationUrl: `${base}/openapi.json`,
    supportedInterfaces: [
      {
        url: base,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.1",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extendedAgentCard: false,
    },
    skills: [skillFromEntry(entry)],
    securitySchemes: paymentSecuritySchemes(root),
    security: SECURITY_REQUIREMENT,
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    generated_at: new Date().toISOString(),
  };
}

// Note: we deliberately export the shared `contact` constant so future
// /.well-known consumers can keep provider info consistent.
export const PROVIDER_CONTACT = CONTACT;
