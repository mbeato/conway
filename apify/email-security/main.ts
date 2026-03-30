import { Actor } from "apify";

interface Input {
  domain: string;
}

await Actor.init();

const input = await Actor.getInput<Input>();
if (!input?.domain) {
  throw new Error("Missing required input: domain (e.g. example.com)");
}

// Call APIMesh email-security API using free preview endpoint
const url = `https://email-security.apimesh.xyz/preview?domain=${encodeURIComponent(input.domain)}`;
const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) {
  throw new Error(`APIMesh returned ${res.status}: ${await res.text()}`);
}
const result = await res.json();

await Actor.pushData(result);
await Actor.exit();
