import { join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";

export interface Subscription {
  id: string;
  agentId: string;
  agentName: string;
  eventTypes: string[];
  excludeActorIds?: string[];
  batchWindow?: number;
  oneShot?: boolean;
  createdAt: string;
}

const VALID_CATEGORY_WILDCARDS = [
  "agent:*",
  "file:*",
  "task:*",
  "git:*",
  "note:*",
  "terminal:*",
  "test:*",
  "build:*",
];

export function getValidCategoryWildcards(): string[] {
  return [...VALID_CATEGORY_WILDCARDS];
}

export function getSubscriptionsDir(workspacePath: string): string {
  return join(workspacePath, ".workspace", "subscriptions");
}

export async function ensureSubscriptionsDir(workspacePath: string): Promise<void> {
  await mkdir(getSubscriptionsDir(workspacePath), { recursive: true });
}

export async function createSubscription(
  workspacePath: string,
  sub: Omit<Subscription, "id" | "createdAt">,
): Promise<Subscription> {
  await ensureSubscriptionsDir(workspacePath);
  const full: Subscription = {
    ...sub,
    id: Bun.randomUUIDv7(),
    createdAt: new Date().toISOString(),
  };
  const filePath = join(getSubscriptionsDir(workspacePath), `${full.id}.json`);
  await Bun.write(filePath, JSON.stringify(full, null, 2) + "\n");
  return full;
}

export async function deleteSubscription(
  workspacePath: string,
  id: string,
): Promise<boolean> {
  const filePath = join(getSubscriptionsDir(workspacePath), `${id}.json`);
  const file = Bun.file(filePath);
  if (!(await file.exists())) return false;
  await Bun.file(filePath).delete();
  return true;
}

export async function getSubscription(
  workspacePath: string,
  id: string,
): Promise<Subscription | null> {
  const filePath = join(getSubscriptionsDir(workspacePath), `${id}.json`);
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return JSON.parse(await file.text()) as Subscription;
}

export async function listSubscriptions(
  workspacePath: string,
): Promise<Subscription[]> {
  const dir = getSubscriptionsDir(workspacePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const subs: Subscription[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = Bun.file(join(dir, entry));
    subs.push(JSON.parse(await file.text()) as Subscription);
  }
  return subs;
}
