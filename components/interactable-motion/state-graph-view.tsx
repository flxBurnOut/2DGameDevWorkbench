'use client';
/* oxlint-disable next/no-img-element -- exact pixel state images */
import { ArrowDown } from 'lucide-react';
import { motionUrl } from '../sprite-generator/open-motion-model';
import { edgeStatusLabels, nodeSourceLabels, type GraphEdge, type GraphNode, type Selection } from './motion-graph';

/** Read-only overview: states and the transitions between them. Editing happens in the centre view. */
export function StateGraphView({ workId, nodes, edges, selection, onSelect, referenceUrl }: {
  workId: string | null; nodes: GraphNode[]; edges: GraphEdge[]; selection: Selection | null;
  onSelect: (value: Selection) => void; referenceUrl: string;
}) {
  const image = (node: GraphNode) => node.index === 0 && referenceUrl ? referenceUrl
    : node.image && workId ? motionUrl(`open-motion/${workId}/${node.image.path}`, { v: node.image.v }) : '';
  return <nav className="im-graph" aria-label="状态图">
    <ol>
      {nodes.map((node, i) => {
        const edge = edges.find(e => e.from === node.index);
        const src = image(node);
        return <li key={node.index}>
          <button className="im-node" aria-pressed={selection?.kind === 'node' && selection.index === node.index}
            onClick={() => onSelect({ kind: 'node', index: node.index })} data-source={node.source}>
            <span className="im-node-thumb">{src ? <img src={src} alt="" decoding="async" /> : <span aria-hidden="true">{String.fromCharCode(65 + i)}</span>}</span>
            <span className="im-node-text"><b title={node.name}>{String.fromCharCode(65 + i)} · {node.name}</b><small>{nodeSourceLabels[node.source]}</small></span>
          </button>
          {edge && <button className="im-edge" aria-pressed={selection?.kind === 'edge' && selection.stage === edge.stage}
            onClick={() => onSelect({ kind: 'edge', stage: edge.stage })} data-status={edge.status}
            aria-label={`过渡 ${i + 1}：${edgeStatusLabels[edge.status]}`}>
            <ArrowDown size={14} aria-hidden="true" />
            <span>过渡 {i + 1}{edge.frames ? ` · ${edge.frames} 帧` : ''}</span>
            <span className="im-pill" data-status={edge.status}>{edgeStatusLabels[edge.status]}</span>
          </button>}
        </li>;
      })}
    </ol>
  </nav>;
}
