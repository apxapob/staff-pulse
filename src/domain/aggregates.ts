import type { OrgAggregate, OrgIndex } from './types';

/** One pass over the index: O(nodes), independent of hierarchy depth. */
export function calculateAggregates(index: OrgIndex): ReadonlyMap<string, OrgAggregate> {
  const aggregates = new Map<string, OrgAggregate>();
  const weightedPerformanceById = new Map<string, number>();

  for (const id of index.postOrderIds) {
    const node = index.nodesById.get(id);
    if (!node) continue;
    let headcount = node.headcount;
    let budget = node.budget;
    let weightedPerformance = node.performance * node.headcount;
    let nodeCount = 1;

    for (const childId of index.childrenById.get(id) ?? []) {
      const child = aggregates.get(childId);
      if (!child) continue;
      headcount += child.headcount;
      budget += child.budget;
      weightedPerformance += weightedPerformanceById.get(childId) ?? 0;
      nodeCount += child.nodeCount;
    }

    weightedPerformanceById.set(id, weightedPerformance);
    aggregates.set(id, {
      headcount,
      budget,
      performance: headcount === 0 ? null : weightedPerformance / headcount,
      nodeCount,
    });
  }

  return aggregates;
}
