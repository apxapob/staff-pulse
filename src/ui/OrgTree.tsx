import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Folder,
  Network,
  UserRound,
  Users,
} from 'lucide-react';
import styled from 'styled-components';
import type { OrgAggregate, OrgIndex } from '@/domain/types';
import { getAncestorIds } from '@/domain/tree';
import { formatNumber, performanceTone } from '@/ui/format';
import { Dot, Muted, Panel, PanelHeader, ScrollArea } from '@/ui/styles';

const TreeBody = styled(ScrollArea)`
  padding: 14px 10px 20px;
`;
const Branch = styled.div`
  display: flow-root;
  margin-left: 14px;
  border-left: 1px solid #eceef4;
  padding-left: 9px;
`;
const Row = styled.div<{ $selected: boolean }>`
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  margin: 2px 0;
  border-radius: 7px;
  background: ${({ $selected }) => ($selected ? '#eeecff' : 'transparent')};
  color: ${({ $selected }) => ($selected ? '#655bdd' : '#5b6075')};
  &:hover {
    background: ${({ $selected }) => ($selected ? '#eeecff' : '#f7f8fc')};
  }
`;
const Expand = styled.button`
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: #a1a5b5;
  padding: 5px 2px;
  width: 22px;
  flex-shrink: 0;
`;
const NodeButton = styled.button`
  border: 0;
  background: transparent;
  color: inherit;
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
  text-align: left;
  font-size: 12px;
  padding: 9px 6px 9px 0;
  span:first-of-type {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
`;
const Count = styled.span`
  font-size: 11px;
  color: #9498aa;
  font-variant-numeric: tabular-nums;
  margin-right: 5px;
`;
const EmployeeList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`;
const EmployeeRow = styled.li`
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 9px 8px 28px;
  color: #777b91;
  > div {
    min-width: 0;
  }
  span,
  small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  span {
    color: #5b6075;
    font-size: 12px;
  }
  small {
    margin-top: 3px;
    font-size: 10px;
    color: #9296a8;
  }
`;
const EmptyEmployees = styled.p`
  margin: 8px 9px 8px 28px;
  font-size: 11px;
  line-height: 1.5;
  color: #9296a8;
`;
const IconButton = styled.button`
  border: 0;
  background: transparent;
  color: #9b9fb0;
  padding: 4px;
`;
const Legend = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 15px;
  padding: 15px 22px;
  border-top: 1px solid #eef0f4;
  color: #9094a5;
  font-size: 10px;
  span {
    display: flex;
    align-items: center;
    gap: 5px;
  }
`;

const BranchClip = styled.div<{ $height: number; $open: boolean }>`
  height: ${({ $height, $open }) => ($open ? `${$height}px` : '0px')};
  overflow: hidden;
  transition: height 0.22s ease;
`;
function AnimatedBranch({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <BranchClip $height={height} $open={open} aria-hidden={!open} inert={!open}>
      <Branch ref={ref}>{children}</Branch>
    </BranchClip>
  );
}

export function OrgTree({
  index,
  aggregates,
  selectedId,
  onSelect,
  revealVersion,
}: {
  index: OrgIndex;
  aggregates: ReadonlyMap<string, OrgAggregate>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  revealVersion: number;
}) {
  const [expanded, setExpanded] = useState(
    () => new Set([...index.depthById].filter(([, depth]) => depth <= 2).map(([id]) => id)),
  );
  useEffect(() => {
    if (selectedId) setExpanded((old) => new Set([...old, ...getAncestorIds(index, selectedId)]));
    const timer = setTimeout(() => {
      if (selectedId)
        document.getElementById(`org-node-${selectedId}`)?.scrollIntoView({ block: 'nearest' });
    }, 250);
    return () => clearTimeout(timer);
  }, [index.childrenById, selectedId, revealVersion]);
  const toggle = (id: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const renderNode = (id: string) => {
    const node = index.nodesById.get(id)!;
    const children = index.childrenById.get(id) ?? [];
    const employees = node.employees;
    const canExpand = children.length > 0 || employees !== undefined;
    const totalHeadcount = aggregates.get(id)!.headcount;
    const open = expanded.has(id);
    const Icon = index.depthById.get(id) === 1 ? Network : children.length ? Folder : Users;
    return (
      <div key={id}>
        <Row $selected={selectedId === id}>
          <Expand
            tabIndex={canExpand ? 0 : -1}
            aria-hidden={!canExpand}
            aria-label={`${open ? 'Свернуть' : 'Раскрыть'} ${node.name}`}
            aria-expanded={canExpand ? open : undefined}
            onClick={() => toggle(id)}
          >
            {canExpand && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
          </Expand>
          <NodeButton
            id={`org-node-${id}`}
            onClick={() => onSelect(id)}
            aria-pressed={selectedId === id}
            title={`${node.name}: всего ${totalHeadcount} сотрудников, непосредственно в подразделении — ${node.headcount}; собственная эффективность ${node.performance}%`}
          >
            <Icon size={15} />
            <span>{node.name}</span>
            <Count title={`Всего сотрудников: ${totalHeadcount}`}>
              {formatNumber(totalHeadcount)}
            </Count>
            <Dot $tone={performanceTone(node.performance)} />
          </NodeButton>
        </Row>
        {canExpand && (
          <AnimatedBranch open={open}>
            {employees && (
              <EmployeeList aria-label={`Сотрудники ${node.name}`}>
                {employees.map((employee) => (
                  <EmployeeRow key={employee.id} data-employee-id={employee.id}>
                    <UserRound size={15} aria-hidden="true" />
                    <div title={`${employee.name} · ${employee.role}`}>
                      <span>{employee.name}</span>
                      <small>{employee.role}</small>
                    </div>
                  </EmployeeRow>
                ))}
              </EmployeeList>
            )}
            {children.map(renderNode)}
            {employees?.length === 0 && children.length === 0 && (
              <EmptyEmployees>В подразделении пока нет сотрудников</EmptyEmployees>
            )}
          </AnimatedBranch>
        )}
      </div>
    );
  };
  return (
    <Panel aria-label="Организационная структура">
      <PanelHeader>
        <div>
          <h2>Структура компании</h2>
          <p>{index.nodesById.size} подразделений · все уровни</p>
        </div>
        <IconButton
          title="Свернуть все ветви"
          aria-label="Свернуть все ветви"
          onClick={() => setExpanded(new Set())}
        >
          <ChevronsDownUp size={17} />
        </IconButton>
      </PanelHeader>
      <TreeBody>{index.rootIds.map(renderNode)}</TreeBody>
      <Legend>
        <span>
          <Dot $tone="good" />
          ≥80%
        </span>
        <span>
          <Dot $tone="medium" />
          65–79%
        </span>
        <span>
          <Dot $tone="low" />
          &lt;65%
        </span>
        <Muted>Эффективность</Muted>
      </Legend>
    </Panel>
  );
}
