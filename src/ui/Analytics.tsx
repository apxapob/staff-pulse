import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import styled, { keyframes } from 'styled-components';
import type { MetricField } from '@/domain/patch';
import type { OrgAggregate, OrgIndex } from '@/domain/types';
import { formatBudget, formatNumber, formatPerformance, performanceTone } from '@/ui/format';
import { Dot, Panel, PanelHeader, Pill, ScrollArea, State } from '@/ui/styles';
import { useDebouncedValue } from '@/ui/useDebouncedValue';
import {
  selectSearchNodes,
  sortSearchNodes,
  type SearchResult,
  type SearchSortField,
} from '@/search/filter';
import { SmartSearchButton, SmartSearchResult } from '@/ui/SmartSearch';
import { SearchInput } from '@/ui/SearchInput';

type SortKey = SearchSortField;
const levelLabels: Record<number, string> = { 1: 'Дивизион', 2: 'Отдел', 3: 'Команда' };
const Controls = styled.form`
  display: flex;
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid #eef0f5;
  @media (max-width: 600px) {
    padding: 14px;
    flex-wrap: wrap;
  }
`;
const SearchBox = styled.div`
  display: flex;
  flex: 1;
  min-width: 150px;
  align-items: center;
  gap: 9px;
  border: 1px solid #e5e7ef;
  padding: 9px 11px;
  border-radius: 7px;
  color: #a0a5b6;
  input {
    border: 0;
    outline: none;
    width: 100%;
    min-width: 0;
    color: #575e77;
    font-size: 11px;
    background: transparent;
    &::placeholder {
      color: #a0a5b6;
    }
  }
  &:focus-within {
    border-color: #aaa4eb;
    box-shadow: 0 0 0 2px #f0eeff;
  }
  button {
    display: flex;
    align-items: center;
    align-self: stretch;
    flex-shrink: 0;
    border: 0;
    background: none;
    padding: 0;
    color: #9298af;
  }
`;
const SelectBox = styled.label`
  position: relative;
  border: 1px solid #e5e7ef;
  border-radius: 7px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  color: #959bb0;
  select {
    appearance: none;
    background: transparent;
    border: 0;
    outline: none;
    color: #697087;
    font-size: 11px;
    font-weight: 600;
    padding: 8px 18px 8px 0;
    max-width: 150px;
    &:focus-visible {
      outline: none;
    }
  }
  &:focus-within {
    border-color: #aaa4eb;
    box-shadow: 0 0 0 2px #f0eeff;
  }
`;
const SelectArrow = styled(ChevronDown)`
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
`;
const flash = keyframes`from { background-color: #ded9ff; } to { background-color: transparent; }`;
const Cell = styled.td<{ $flash: boolean }>`
  animation: ${({ $flash }) => ($flash ? flash : 'none')} 1.5s ease-out both;
`;
const Table = styled.table`
  width: 100%;
  min-width: 640px;
  border-collapse: collapse;
  text-align: left;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: #fafbfe;
    border-bottom: 1px solid #e9ecf3;
    padding: 13px 12px;
    white-space: nowrap;
    color: #858ba1;
    font-size: 10px;
    font-weight: 500;
  }
  th:first-child,
  td:first-child {
    padding-left: 20px;
  }
  th:last-child,
  td:last-child {
    padding-right: 20px;
  }
  td {
    padding: 14px 12px;
    border-bottom: 1px solid #eff1f6;
    white-space: nowrap;
    height: 52px;
  }
  th:nth-child(n + 3),
  td:nth-child(n + 3) {
    text-align: right;
  }
`;
const SortButton = styled.button`
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: inherit;
`;
const Row = styled.tr<{
  $selected: boolean;
}>`cursor: pointer; color: #7e849a; background: ${({ $selected }) => ($selected ? '#f2f0ff' : '#fff')}; &:hover { background: ${({ $selected }) => ($selected ? '#eeebff' : '#fafaff')}; td:first-child { color: ${({ $selected }) => ($selected ? '#6b60de' : '#515870')}; }`;
const Name = styled.span`
  font-weight: 550;
`;
const Level = styled.span<{ $level: number }>`
  font-size: 9px;
  border-radius: 4px;
  padding: 4px 6px;
  background: ${({ $level }) => ($level === 1 ? '#efedfd' : $level === 2 ? '#edf3fa' : '#f2f4f7')};
  color: ${({ $level }) => ($level === 1 ? '#8274c8' : $level === 2 ? '#7b96b9' : '#929aab')};
`;
const TableFooter = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border-top: 1px solid #edf0f6;
  padding: 15px 20px;
  font-size: 10px;
  color: #a0a6b7;
  line-height: 1.5;
`;

export function Analytics({
  index,
  aggregates,
  selectedId,
  onSelect,
  changedFields,
  changeVersion,
}: {
  index: OrgIndex;
  aggregates: ReadonlyMap<string, OrgAggregate>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  changedFields: ReadonlyMap<string, ReadonlySet<MetricField>>;
  changeVersion: string | null;
}) {
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [smartResult, setSmartResult] = useState<{ query: string; result: SearchResult } | null>(
    null,
  );
  const activeFilter = smartResult?.query === search ? smartResult.result.filter : null;
  const term = useDebouncedValue(search).trim().toLocaleLowerCase('ru');
  const [level, setLevel] = useState('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({
    key: 'name',
    direction: 'asc',
  });
  const rows = useMemo(() => {
    const nodes = [...index.nodesById.values()];
    const matching = activeFilter
      ? selectSearchNodes(
          activeFilter,
          nodes,
          index.depthById,
          aggregates,
          level === 'all' ? null : Number(level),
        )
      : nodes.filter(
          (node) =>
            node.name.toLocaleLowerCase('ru').includes(term) &&
            (level === 'all' || index.depthById.get(node.id) === Number(level)),
        );
    return sortSearchNodes(
      matching,
      { field: sort.key, direction: sort.direction },
      index.depthById,
      aggregates,
    );
  }, [index, aggregates, term, level, sort, activeFilter]);
  const activeId = rows.some((node) => node.id === focusedId) ? focusedId : rows[0]?.id;
  const navigate = (event: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    const position = rows.findIndex((node) => node.id === id);
    let next = position;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
      next = Math.min(rows.length - 1, position + 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(0, position - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (event.key === 'Enter') {
      event.preventDefault();
      onSelect(id);
      return;
    } else return;
    event.preventDefault();
    const nextId = rows[next]?.id;
    if (nextId) {
      setFocusedId(nextId);
      rowRefs.current.get(nextId)?.focus();
    }
  };
  const columns: { key: SortKey; label: string }[] = [
    { key: 'name', label: 'Подразделение' },
    { key: 'level', label: 'Уровень' },
    { key: 'headcount', label: 'Всего сотрудников' },
    { key: 'budget', label: 'Бюджет суммарный' },
    { key: 'performance', label: 'Средняя эффективность' },
  ];
  return (
    <Panel aria-label="Аналитика подразделений">
      <PanelHeader>
        <div>
          <h2>Аналитика подразделений</h2>
          <p>Сводные показатели с учётом всех вложенных команд</p>
        </div>
      </PanelHeader>
      <Controls onSubmit={(event) => event.preventDefault()}>
        <SearchBox>
          <Search size={14} />
          <SearchInput
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSmartResult(null);
            }}
          />
          {search && (
            <button
              type="button"
              aria-label="Очистить поиск"
              onClick={() => {
                setSearch('');
                setSmartResult(null);
              }}
            >
              <X size={13} />
            </button>
          )}
        </SearchBox>
        <SelectBox>
          <SlidersHorizontal size={12} />
          <select
            aria-label="Уровень подразделения"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            <option value="all">Все уровни</option>
            <option value="1">Дивизионы</option>
            <option value="2">Отделы</option>
            <option value="3">Команды</option>
          </select>
          <SelectArrow size={12} aria-hidden="true" />
        </SelectBox>
        <SmartSearchButton
          query={search}
          onApply={(result) => {
            setSmartResult({ query: search, result });
            if (result.filter.sort)
              setSort({ key: result.filter.sort.field, direction: result.filter.sort.direction });
          }}
        />
      </Controls>
      {activeFilter && smartResult && (
        <SmartSearchResult
          result={smartResult.result}
          onClear={() => {
            setSmartResult(null);
            setSearch('');
          }}
        />
      )}
      <ScrollArea>
        <Table aria-label="Аналитическая таблица">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sort.key === column.key
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <SortButton
                    onClick={() => setSort({ key: column.key, direction: 'asc' })}
                    onDoubleClick={() => setSort({ key: column.key, direction: 'desc' })}
                    title="Клик — по возрастанию, двойной клик — по убыванию"
                  >
                    {column.label}
                    {sort.key === column.key ? (
                      sort.direction === 'asc' ? (
                        <ArrowUp size={10} />
                      ) : (
                        <ArrowDown size={10} />
                      )
                    ) : (
                      <ArrowUpDown size={10} />
                    )}
                  </SortButton>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((node) => {
              const aggregate = aggregates.get(node.id)!;
              const depth = index.depthById.get(node.id)!;
              const flashes = changedFields.get(node.id);
              const cellKey = (field: MetricField) =>
                `${node.id}-${field}-${flashes?.has(field) ? changeVersion : 0}`;
              return (
                <Row
                  ref={(element) => {
                    if (element) rowRefs.current.set(node.id, element);
                    else rowRefs.current.delete(node.id);
                  }}
                  tabIndex={activeId === node.id ? 0 : -1}
                  onFocus={() => setFocusedId(node.id)}
                  onKeyDown={(event) => navigate(event, node.id)}
                  key={node.id}
                  data-node-id={node.id}
                  $selected={selectedId === node.id}
                  aria-selected={selectedId === node.id}
                  onClick={() => onSelect(node.id)}
                >
                  <td>
                    <Name>{node.name}</Name>
                  </td>
                  <td>
                    <Level $level={depth}>{levelLabels[depth] ?? `Уровень ${depth}`}</Level>
                  </td>
                  <Cell
                    key={cellKey('headcount')}
                    $flash={Boolean(flashes?.has('headcount'))}
                    data-flash={flashes?.has('headcount') || undefined}
                  >
                    {formatNumber(aggregate.headcount)}
                  </Cell>
                  <Cell
                    key={cellKey('budget')}
                    $flash={Boolean(flashes?.has('budget'))}
                    data-flash={flashes?.has('budget') || undefined}
                  >
                    {formatBudget(aggregate.budget)}
                  </Cell>
                  <Cell
                    key={cellKey('performance')}
                    $flash={Boolean(flashes?.has('performance'))}
                    data-flash={flashes?.has('performance') || undefined}
                  >
                    <Pill $tone={performanceTone(aggregate.performance)}>
                      <Dot $tone={performanceTone(aggregate.performance)} />
                      {formatPerformance(aggregate.performance)}
                    </Pill>
                  </Cell>
                </Row>
              );
            })}
          </tbody>
        </Table>
        {!rows.length && (
          <State>
            <Search size={25} />
            <h3>Ничего не найдено</h3>
            <p>Попробуйте другое название или измените уровень подразделения.</p>
          </State>
        )}
      </ScrollArea>
      <TableFooter>
        <span>
          Показано {rows.length} из {index.nodesById.size} подразделений
        </span>
        <span>↑↓ навигация · Enter выбрать</span>
      </TableFooter>
    </Panel>
  );
}
