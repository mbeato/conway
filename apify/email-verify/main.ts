import { Actor } from "apify";

interface Input {
  email: string;
}

await Actor.init();

const input = await Actor.getInput<Input>();
if (!input?.email) {
  throw new Error("Missing required input: email");
}

const url = `https://email-verify.apimesh.xyz/preview?email=${encodeURIComponent(input.email)}`;
const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) {
  throw new Error(`APIMesh returned ${res.status}: ${await res.text()}`);
}
const result = await res.json();

await Actor.pushData(result);
await Actor.exit();
