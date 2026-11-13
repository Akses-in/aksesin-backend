import { z } from 'zod';
import { env } from '../config/env.js';

export const OVERPASS_USER_AGENT = 'AksesIn/1.0 (proyek mahasiswa Telkom University)';
export const OVERPASS_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_CHARS = 100 * 1024 * 1024;

export class OverpassUnavailableError extends Error {
  constructor() {
    super('Semua endpoint Overpass gagal.');
    this.name = 'OverpassUnavailableError';
  }
}

// Pesan buatan sendiri yang aman untuk log. Error lain hanya dicatat namanya karena
// pesan SyntaxError dari JSON.parse bisa memuat potongan isi respons provider.
class OverpassAttemptError extends Error {
  override name = 'OverpassAttemptError';
}

export interface OverpassResult {
  elements: unknown[];
  endpoint: string;
}

export type OverpassFetcher = () => Promise<OverpassResult>;
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// `out center meta` memberi titik tengah way/relation serta timestamp edit terakhir.
// Data pengguna OSM yang ikut terbawa (user, uid) tidak pernah disimpan.
export function buildOverpassQuery(timeoutSeconds = 80): string {
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    'area["ISO3166-2"="ID-JK"][admin_level=4]->.jkt;',
    '(',
    '  nwr["amenity"~"^(hospital|clinic|school|university|college|library|townhall|police|bank|community_centre|bus_station|marketplace)$"]["name"](area.jkt);',
    '  nwr["railway"="station"]["name"](area.jkt);',
    '  nwr["public_transport"="station"]["name"](area.jkt);',
    '  nwr["shop"="mall"]["name"](area.jkt);',
    '  nwr["leisure"="park"]["name"](area.jkt);',
    '  nwr["tourism"~"^(museum|attraction)$"]["name"](area.jkt);',
    ');',
    'out center meta;',
  ].join('\n');
}

const overpassEnvelopeSchema = z.object({
  elements: z.array(z.unknown()),
  remark: z.string().optional(),
});

async function requestEndpoint(url: string, query: string, fetchImpl: FetchLike, timeoutMs: number): Promise<unknown[]> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': OVERPASS_USER_AGENT,
    },
    body: new URLSearchParams({ data: query }).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new OverpassAttemptError(`HTTP ${response.status}`);

  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new OverpassAttemptError('Respons terlalu besar');

  const envelope = overpassEnvelopeSchema.parse(JSON.parse(text));
  // Overpass bisa membalas 200 dengan data terpotong saat query kehabisan waktu atau memori.
  if (envelope.remark && /runtime error|timed out|out of memory/i.test(envelope.remark)) {
    throw new OverpassAttemptError('Respons Overpass tidak lengkap');
  }
  return envelope.elements;
}

export async function fetchOverpassElements(options: {
  urls: readonly string[];
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  query?: string;
}): Promise<OverpassResult> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const query = options.query ?? buildOverpassQuery();

  for (const url of options.urls) {
    try {
      const elements = await requestEndpoint(url, query, fetchImpl, options.timeoutMs ?? OVERPASS_TIMEOUT_MS);
      return { elements, endpoint: new URL(url).hostname };
    } catch (error) {
      // Hanya host dan jenis error yang dicatat. Isi respons provider tidak masuk log.
      const reason = error instanceof OverpassAttemptError ? error.message : error instanceof Error ? error.name : 'UnknownError';
      console.warn(`Overpass ${new URL(url).hostname} gagal (${reason}). Mencoba endpoint berikutnya.`);
    }
  }
  throw new OverpassUnavailableError();
}

export function createOverpassFetcher(options?: { urls?: readonly string[]; fetchImpl?: FetchLike; timeoutMs?: number }): OverpassFetcher {
  return () => fetchOverpassElements({
    urls: options?.urls ?? env.OVERPASS_URLS,
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
}
