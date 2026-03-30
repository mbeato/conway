import { Actor } from "apify";

interface Input {
  url: string;
}

await Actor.init();

const input = await Actor.getInput<Input>();
if (!input?.url) {
  throw new Error("Missing required input: url");
}

// Call APIMesh core-web-vitals API using free preview endpoint
const url = `https://core-web-vitals.apimesh.xyz/preview?url=${encodeURIComponent(input.url)}`;
const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) {
  throw new Error(`APIMesh returned ${res.status}: ${await res.text()}`);
}
const result = await res.json();

await Actor.pushData(result);
await Actor.exit();
