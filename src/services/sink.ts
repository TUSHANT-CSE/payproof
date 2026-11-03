export interface SinkEntry {
  at: number;
  event: string;
  deliveryId: string;
  orderId: string;
  amount: string;
  signatureOk: boolean;
  body: string;
}

const MAX = 50;
const entries: SinkEntry[] = [];

export function recordSink(entry: SinkEntry): void {
  entries.push(entry);
  while (entries.length > MAX) entries.shift();
}

export function sinkLog(): SinkEntry[] {
  return entries.slice();
}

export function clearSinkLog(): void {
  entries.length = 0;
}
