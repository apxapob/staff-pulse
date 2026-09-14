import styled, { createGlobalStyle, keyframes } from 'styled-components';

export const GlobalStyles = createGlobalStyle`
  :root { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; color: #25283c; background: #f6f7fa; font-synthesis: none; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 360px; }
  button, input, select { font: inherit; }
  button { cursor: pointer; }
  button:disabled { cursor: wait; opacity: .6; }
  button, a, input, select { -webkit-tap-highlight-color: transparent; }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, tr:focus-visible { outline: 3px solid #aaa4fa; outline-offset: 3px; }
  a { color: inherit; }
  svg { flex-shrink: 0; vertical-align: middle; }
  ::selection { background: #e5e2ff; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } }
`;

export const Panel = styled.section`
  background: white;
  border: 1px solid #e8eaf0;
  border-radius: 14px;
  min-width: 0;
  overflow: hidden;
`;
export const ScrollArea = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: #dedfeb transparent;
`;
export const PanelHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 21px 22px;
  border-bottom: 1px solid #eef0f4;
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 650;
  }
  p {
    margin: 6px 0 0;
    font-size: 12px;
    color: #8a8e9f;
  }
`;
export const Button = styled.button<{ $primary?: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid ${({ $primary }) => ($primary ? '#625be7' : '#e2e4ec')};
  background: ${({ $primary }) => ($primary ? '#625be7' : 'white')};
  color: ${({ $primary }) => ($primary ? 'white' : '#555a70')};
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  transition: background 0.15s;
  &:hover {
    background: ${({ $primary }) => ($primary ? '#5149d3' : '#f7f7fc')};
  }
`;
export const Muted = styled.span`
  color: #8c90a1;
  font-size: 12px;
`;
export const Dot = styled.span<{ $tone?: 'good' | 'medium' | 'low' }>`
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: ${({ $tone }) => ($tone === 'low' ? '#ed8b71' : $tone === 'medium' ? '#e9b455' : '#51ae94')};
  flex-shrink: 0;
`;
export const Pill = styled.span<{ $tone: 'good' | 'medium' | 'low' }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 7px;
  color: ${({ $tone }) => ($tone === 'low' ? '#b36450' : $tone === 'medium' ? '#a87929' : '#378b73')};
  background: ${({ $tone }) => ($tone === 'low' ? '#fff0ea' : $tone === 'medium' ? '#fff7e7' : '#edf8f3')};
  white-space: nowrap;
`;
const shimmer = keyframes`from { opacity: .45; } to { opacity: 1; }`;
export const Skeleton = styled.div`
  height: 38px;
  background: #f0f1f6;
  border-radius: 6px;
  margin: 12px 24px;
  animation: ${shimmer} 1s alternate infinite;
  &:nth-child(even) {
    margin-left: 52px;
  }
`;
export const State = styled.div`
  padding: 70px 24px;
  text-align: center;
  color: #868a9d;
  svg {
    color: #8c86e8;
    margin-bottom: 10px;
  }
  h2,
  h3 {
    color: #383c53;
    font-size: 17px;
  }
  p {
    font-size: 13px;
    line-height: 1.7;
    max-width: 470px;
    margin: 12px auto 20px;
  }
`;
