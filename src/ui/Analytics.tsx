import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react';
import styled from 'styled-components';
import type { OrgAggregate, OrgIndex } from '@/domain/types';
import { formatBudget, formatNumber, formatPerformance, performanceTone } from '@/ui/format';
import { Dot, Panel, PanelHeader, Pill, State } from '@/ui/styles';
import { useDebouncedValue } from '@/ui/useDebouncedValue';

type SortKey='name'|'level'|'headcount'|'budget'|'performance';
const levelLabels: Record<number,string>={1:'Дивизион',2:'Отдел',3:'Команда'};
const Controls = styled.div`display: flex; gap: 10px; padding: 16px 20px; border-bottom: 1px solid #eef0f5; @media(max-width:600px) { padding: 14px; flex-wrap: wrap; }`;
const SearchBox = styled.div`display: flex; flex: 1; min-width: 150px; align-items: center; gap: 9px; border: 1px solid #e5e7ef; padding: 9px 11px; border-radius: 7px; color: #a0a5b6; input { border: 0; outline: none; width: 100%; min-width: 0; color: #575e77; font-size: 11px; background: transparent; &::placeholder { color: #a0a5b6; } } &:focus-within { border-color: #aaa4eb; box-shadow: 0 0 0 2px #f0eeff; } button { border: 0; background: none; padding: 0; color: #9298af; }`;
const SelectBox = styled.label`border: 1px solid #e5e7ef; border-radius: 7px; display: flex; align-items: center; gap: 7px; padding: 0 10px; color: #959bb0; select { background: white; border: 0; color: #697087; font-size: 10px; padding: 8px 0; max-width: 150px; }`;
const Scroll = styled.div`overflow: auto; max-height: 526px; scrollbar-width: thin; scrollbar-color: #dedfeb transparent;`;
const Table = styled.table`width: 100%; min-width: 640px; border-collapse: collapse; text-align: left; font-size: 11px; font-variant-numeric: tabular-nums; th { position: sticky; top: 0; z-index: 1; background: #fafbfe; border-bottom: 1px solid #e9ecf3; padding: 13px 12px; white-space: nowrap; color: #979caf; font-size: 9px; font-weight: 500; } th:first-child,td:first-child { padding-left: 20px; } th:last-child,td:last-child { padding-right: 20px; } td { padding: 14px 12px; border-bottom: 1px solid #eff1f6; white-space: nowrap; height: 52px; } th:nth-child(n+3), td:nth-child(n+3) { text-align: right; }`;
const SortButton = styled.button`border: 0; background: transparent; color: inherit; padding: 0; display: inline-flex; align-items: center; gap: 6px; font-size: inherit;`;
const Row = styled.tr<{ $selected:boolean }>`cursor: pointer; color: #7e849a; background: ${({$selected})=>$selected?'#f2f0ff':'#fff'}; &:hover { background: ${({$selected})=>$selected?'#eeebff':'#fafaff'}; td:first-child { color: ${({$selected})=>$selected?'#6b60de':'#515870'}; }`;
const Name = styled.span`display: flex; align-items: center; gap: 8px; font-weight: 550; svg { color: #a7aabd; }`;
const Level = styled.span<{ $level:number }>`font-size: 9px; border-radius: 4px; padding: 4px 6px; background: ${({$level})=>$level===1?'#efedfd':$level===2?'#edf3fa':'#f2f4f7'}; color: ${({$level})=>$level===1?'#8274c8':$level===2?'#7b96b9':'#929aab'};`;
const TableFooter = styled.div`display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid #edf0f6; padding: 15px 20px; font-size: 10px; color: #a0a6b7; line-height: 1.5;`;

export function Analytics({index,aggregates,selectedId,onSelect}: {index:OrgIndex;aggregates:ReadonlyMap<string,OrgAggregate>;selectedId:string|null;onSelect:(id:string)=>void}) {
  const [search,setSearch]=useState('');
  const term=useDebouncedValue(search).trim().toLocaleLowerCase('ru');
  const [level,setLevel]=useState('all');
  const [sort,setSort]=useState<{key:SortKey;direction:'asc'|'desc'}>({key:'name',direction:'asc'});
  const rows=useMemo(()=>[...index.nodesById.values()].filter(node=>node.name.toLocaleLowerCase('ru').includes(term)&&(level==='all'||index.depthById.get(node.id)===Number(level))).sort((a,b)=>{
    const aValue=sort.key==='name'?a.name:sort.key==='level'?index.depthById.get(a.id)!:aggregates.get(a.id)![sort.key]??-Infinity;
    const bValue=sort.key==='name'?b.name:sort.key==='level'?index.depthById.get(b.id)!:aggregates.get(b.id)![sort.key]??-Infinity;
    const compared=typeof aValue==='string'?aValue.localeCompare(String(bValue),'ru'):Number(aValue)-Number(bValue);
    return (Number.isNaN(compared)?0:compared)*(sort.direction==='asc'?1:-1)||a.id.localeCompare(b.id);
  }),[index,aggregates,term,level,sort]);
  const columns: {key:SortKey;label:string}[]=[{key:'name',label:'Подразделение'},{key:'level',label:'Уровень'},{key:'headcount',label:'Всего сотрудников'},{key:'budget',label:'Бюджет суммарный'},{key:'performance',label:'Средняя эффективность'}];
  return <Panel aria-label="Аналитика подразделений"><PanelHeader><div><h2>Аналитика подразделений</h2><p>Сводные показатели с учётом всех вложенных команд</p></div><SlidersHorizontal size={16} color="#a1a6b7"/></PanelHeader>
    <Controls><SearchBox><Search size={14}/><input aria-label="Поиск подразделения" placeholder="Поиск по названию подразделения..." value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button aria-label="Очистить поиск" onClick={()=>setSearch('')}><X size={13}/></button>}</SearchBox><SelectBox><SlidersHorizontal size={12}/><select aria-label="Уровень подразделения" value={level} onChange={e=>setLevel(e.target.value)}><option value="all">Все уровни</option><option value="1">Дивизионы</option><option value="2">Отделы</option><option value="3">Команды</option></select></SelectBox></Controls>
    <Scroll><Table aria-label="Аналитическая таблица"><thead><tr>{columns.map(column=><th key={column.key} scope="col" aria-sort={sort.key===column.key?(sort.direction==='asc'?'ascending':'descending'):'none'}><SortButton onClick={()=>setSort({key:column.key,direction:'asc'})} onDoubleClick={()=>setSort({key:column.key,direction:'desc'})} title="Клик — по возрастанию, двойной клик — по убыванию">{column.label}{sort.key===column.key?(sort.direction==='asc'?<ArrowUp size={10}/>:<ArrowDown size={10}/>):<ArrowUpDown size={10}/>}</SortButton></th>)}</tr></thead><tbody>{rows.map(node=>{
      const aggregate=aggregates.get(node.id)!;
      const depth=index.depthById.get(node.id)!;
      return <Row key={node.id} data-node-id={node.id} $selected={selectedId===node.id} aria-selected={selectedId===node.id} onClick={()=>onSelect(node.id)}><td><Name><ChevronRight size={12}/>{node.name}</Name></td><td><Level $level={depth}>{levelLabels[depth]??`Уровень ${depth}`}</Level></td><td>{formatNumber(aggregate.headcount)}</td><td>{formatBudget(aggregate.budget)}</td><td><Pill $tone={performanceTone(aggregate.performance)}><Dot $tone={performanceTone(aggregate.performance)}/>{formatPerformance(aggregate.performance)}</Pill></td></Row>;
    })}</tbody></Table>{!rows.length&&<State><Search size={25}/><h3>Ничего не найдено</h3><p>Попробуйте другое название или измените уровень подразделения.</p></State>}</Scroll>
    <TableFooter><span>Показано {rows.length} из {index.nodesById.size} подразделений</span><span>Двойной клик по заголовку — обратная сортировка</span></TableFooter>
  </Panel>;
}
