import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, Folder, Network, Users } from 'lucide-react';
import styled from 'styled-components';
import type { OrgIndex } from '@/domain/types';
import { getAncestorIds } from '@/domain/tree';
import { formatNumber, performanceTone } from '@/ui/format';
import { Dot, Muted, Panel, PanelHeader } from '@/ui/styles';

const TreeBody = styled.div`padding: 14px 10px 20px; max-height: 610px; overflow: auto;`;
const Branch = styled.div`margin-left: 19px; border-left: 1px solid #eceef4; padding-left: 4px;`;
const Row = styled.div<{ $selected: boolean }>`display: flex; align-items: center; gap: 3px; padding: 3px; margin: 2px 0; border-radius: 7px; background: ${({$selected})=>$selected?'#eeecff':'transparent'}; color: ${({$selected})=>$selected?'#655bdd':'#5b6075'}; &:hover { background: ${({$selected})=>$selected?'#eeecff':'#f7f8fc'}; }`;
const Expand = styled.button`border: 0; background: transparent; color: #a1a5b5; padding: 5px 2px; width: 22px; flex-shrink: 0;`;
const NodeButton = styled.button`border: 0; background: transparent; color: inherit; display: flex; align-items: center; gap: 9px; width: 100%; min-width: 0; text-align: left; font-size: 12px; padding: 9px 6px 9px 0; span:first-of-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }`;
const Count = styled.span`font-size: 11px; color: #9498aa; font-variant-numeric: tabular-nums; margin-right: 5px;`;
const IconButton = styled.button`border: 0; background: transparent; color: #9b9fb0; padding: 4px;`;
const Legend = styled.div`display: flex; flex-wrap: wrap; gap: 15px; padding: 15px 22px; border-top: 1px solid #eef0f4; color: #9094a5; font-size: 10px; span { display: flex; align-items: center; gap: 5px; }`;

export function OrgTree({ index, selectedId, onSelect }: { index: OrgIndex; selectedId: string | null; onSelect: (id: string) => void }) {
  const [expanded, setExpanded] = useState(() => new Set([...index.depthById].filter(([,depth])=>depth<=2).map(([id])=>id)));
  useEffect(() => {
    if (selectedId) setExpanded(old => new Set([...old, ...getAncestorIds(index, selectedId)]));
  }, [index, selectedId]);
  const toggle = (id: string) => setExpanded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const renderNode = (id: string) => {
    const node = index.nodesById.get(id)!;
    const children = index.childrenById.get(id) ?? [];
    const open = expanded.has(id);
    const Icon = index.depthById.get(id)===1 ? Network : children.length ? Folder : Users;
    return <div key={id}>
      <Row $selected={selectedId===id}>
        <Expand tabIndex={children.length?0:-1} aria-hidden={!children.length} aria-label={`${open?'Свернуть':'Раскрыть'} ${node.name}`} aria-expanded={children.length?open:undefined} onClick={()=>toggle(id)}>{children.length>0 && (open?<ChevronDown size={13}/>:<ChevronRight size={13}/>)}</Expand>
        <NodeButton onClick={()=>onSelect(id)} aria-pressed={selectedId===id} title={`${node.name}: ${node.headcount} сотрудников, эффективность ${node.performance}%`}><Icon size={15}/><span>{node.name}</span><Count>{formatNumber(node.headcount)}</Count><Dot $tone={performanceTone(node.performance)}/></NodeButton>
      </Row>
      {open && children.length>0 && <Branch>{children.map(renderNode)}</Branch>}
    </div>;
  };
  return <Panel aria-label="Организационная структура">
    <PanelHeader><div><h2>Структура компании</h2><p>{index.nodesById.size} подразделений · все уровни</p></div><IconButton title="Свернуть все ветви" aria-label="Свернуть все ветви" onClick={()=>setExpanded(new Set())}><ChevronsDownUp size={17}/></IconButton></PanelHeader>
    <TreeBody>{index.rootIds.map(renderNode)}</TreeBody>
    <Legend><span><Dot $tone="good"/>≥80%</span><span><Dot $tone="medium"/>65–79%</span><span><Dot $tone="low"/>&lt;65%</span><Muted>Эффективность</Muted></Legend>
  </Panel>;
}
