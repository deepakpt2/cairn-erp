/**
 * Document engine — E5, CAIRN.md §5.2, §5.4, §16.2, D-017
 *
 * The document principle in code: nothing happens to business data without a
 * document, documents are never deleted, and every document can name its
 * predecessors and successors. The document-flow button on every screen and the
 * auditor's drill-through both read from this engine — which is why they can
 * never disagree with each other.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  documentFlowLink,
  documentIndex,
  documentStatusHistory,
} from '../tables/audit-trail';

export interface DocumentRef {
  documentClass: string;
  documentKey: string;
  displayNumber?: string;
}

/** Create a directed predecessor → successor link. Context travels with the link. */
export async function linkDocuments(
  tx: Tx,
  input: {
    client: string;
    predecessor: DocumentRef;
    successor: DocumentRef;
    relationType?: string;
    quantity?: string;
    value?: string;
    currency?: string;
    createdBy: string;
  },
): Promise<void> {
  await tx.insert(documentFlowLink).values({
    id: crypto.randomUUID(),
    client: input.client,
    predecessorClass: input.predecessor.documentClass,
    predecessorKey: input.predecessor.documentKey,
    successorClass: input.successor.documentClass,
    successorKey: input.successor.documentKey,
    relationType: input.relationType ?? 'FOLLOWS',
    linkQuantity: input.quantity,
    linkValue: input.value,
    linkCurrency: input.currency,
    createdBy: input.createdBy,
  });
}

/** Record a status transition. Every transition is attributable and reversible in the log. */
export async function recordStatusChange(
  tx: Tx,
  input: {
    client: string;
    document: DocumentRef;
    previousStatus?: string | null;
    newStatus: string;
    reason?: string;
    changedBy: string;
  },
): Promise<void> {
  await tx.insert(documentStatusHistory).values({
    id: crypto.randomUUID(),
    client: input.client,
    documentClass: input.document.documentClass,
    documentKey: input.document.documentKey,
    previousStatus: input.previousStatus ?? null,
    newStatus: input.newStatus,
    reason: input.reason,
    changedBy: input.changedBy,
  });
}

/** Add a document to the cross-class index so global search and drill-through find it. */
export async function indexDocument(
  tx: Tx,
  input: {
    client: string;
    document: DocumentRef;
    displayNumber: string;
    documentType?: string;
    companyCode?: string;
    postingDate?: Date;
    status?: string;
    summary?: string;
    searchText?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(documentIndex).values({
    id: crypto.randomUUID(),
    client: input.client,
    documentClass: input.document.documentClass,
    documentKey: input.document.documentKey,
    displayNumber: input.displayNumber,
    documentType: input.documentType,
    companyCode: input.companyCode,
    postingDate: input.postingDate,
    status: input.status ?? 'POSTED',
    summary: input.summary,
    searchText: input.searchText,
    metadata: input.metadata ?? {},
  });
}

export interface FlowNode {
  documentClass: string;
  documentKey: string;
  displayNumber?: string;
  relationType?: string;
  quantity?: string | null;
  value?: string | null;
  currency?: string | null;
  children: FlowNode[];
  parents: FlowNode[];
}

/**
 * Walk the document graph from any node. `depth` bounds the traversal so a long
 * chain cannot surprise a request; the UI expands on demand beyond that.
 */
export async function documentFlow(
  tx: Tx,
  input: { client: string; documentClass: string; documentKey: string; depth?: number },
): Promise<FlowNode> {
  const maxDepth = input.depth ?? 10;
  const root: FlowNode = {
    documentClass: input.documentClass,
    documentKey: input.documentKey,
    children: [],
    parents: [],
  };

  await expand(tx, input.client, root, maxDepth, new Set());

  // Fill in display numbers in one pass over the index.
  await attachDisplayNumbers(tx, input.client, root);
  return root;
}

async function expand(
  tx: Tx,
  client: string,
  node: FlowNode,
  depth: number,
  visited: Set<string>,
) {
  const id = `${node.documentClass}|${node.documentKey}`;
  if (depth <= 0 || visited.has(id)) return;
  visited.add(id);

  const links = await tx
    .select()
    .from(documentFlowLink)
    .where(
      and(
        eq(documentFlowLink.client, client),
        eq(documentFlowLink.predecessorClass, node.documentClass),
        eq(documentFlowLink.predecessorKey, node.documentKey),
      ),
    );

  for (const link of links) {
    const child: FlowNode = {
      documentClass: link.successorClass,
      documentKey: link.successorKey,
      relationType: link.relationType,
      quantity: link.linkQuantity,
      value: link.linkValue,
      currency: link.linkCurrency,
      children: [],
      parents: [],
    };
    node.children.push(child);
    await expand(tx, client, child, depth - 1, visited);
  }

  const inverse = await tx
    .select()
    .from(documentFlowLink)
    .where(
      and(
        eq(documentFlowLink.client, client),
        eq(documentFlowLink.successorClass, node.documentClass),
        eq(documentFlowLink.successorKey, node.documentKey),
      ),
    );

  for (const link of inverse) {
    const parent: FlowNode = {
      documentClass: link.predecessorClass,
      documentKey: link.predecessorKey,
      relationType: link.relationType,
      quantity: link.linkQuantity,
      value: link.linkValue,
      currency: link.linkCurrency,
      children: [],
      parents: [],
    };
    node.parents.push(parent);
    await expand(tx, client, parent, depth - 1, visited);
  }
}

async function attachDisplayNumbers(tx: Tx, client: string, node: FlowNode): Promise<void> {
  const seen = new Set<string>();
  const queue: FlowNode[] = [node];
  const pairs: Array<{ class: string; key: string }> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const id = `${current.documentClass}|${current.documentKey}`;
    if (!seen.has(id)) {
      seen.add(id);
      pairs.push({ class: current.documentClass, key: current.documentKey });
    }
    queue.push(...current.children, ...current.parents);
  }
  if (pairs.length === 0) return;

  const indexed = await tx
    .select()
    .from(documentIndex)
    .where(eq(documentIndex.client, client));

  const lookup = new Map<string, string>();
  for (const row of indexed) {
    lookup.set(`${row.documentClass}|${row.documentKey}`, row.displayNumber);
  }
  for (const current of [node, ...collect(node)]) {
    const found = lookup.get(`${current.documentClass}|${current.documentKey}`);
    if (found) current.displayNumber = found;
  }
}

function collect(node: FlowNode): FlowNode[] {
  const out: FlowNode[] = [];
  for (const child of [...node.children, ...node.parents]) {
    out.push(child, ...collect(child));
  }
  return out;
}
