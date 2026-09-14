export interface OrgEmployee {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

/** Each metric belongs to this node; aggregates include its descendants. */
export interface OrgNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly headcount: number;
  readonly budget: number;
  readonly performance: number;
  readonly updatedAt: string;
  /** Direct employees only. Omitted when the source provides metrics without a roster. */
  readonly employees?: readonly OrgEmployee[];
}

export interface OrgIndex {
  readonly nodesById: ReadonlyMap<string, OrgNode>;
  readonly childrenById: ReadonlyMap<string, readonly string[]>;
  readonly rootIds: readonly string[];
  /** A division is at depth 1, a department at 2, and a team at 3. */
  readonly depthById: ReadonlyMap<string, number>;
  /** Children precede parents, allowing aggregation without recursive calls. */
  readonly postOrderIds: readonly string[];
}

export interface OrgAggregate {
  readonly headcount: number;
  readonly budget: number;
  /** Headcount-weighted performance; null when the subtree has no employees. */
  readonly performance: number | null;
  /** Includes the node itself. */
  readonly nodeCount: number;
}

export type ValidationCode =
  | 'array'
  | 'object'
  | 'required'
  | 'string'
  | 'number'
  | 'range'
  | 'datetime'
  | 'duplicate'
  | 'parent'
  | 'cycle';

export interface ValidationIssue {
  readonly path: string;
  readonly code: ValidationCode;
  readonly message: string;
}

export type DatasetValidationResult =
  | { readonly ok: true; readonly nodes: OrgNode[] }
  | { readonly ok: false; readonly errors: ValidationIssue[] };
