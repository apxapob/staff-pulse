import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { fetchOrgTree, ORG_QUERY_KEY } from './query';

afterEach(()=>vi.unstubAllGlobals());

describe('API boundary and cache lifecycle', () => {
  it('accepts an empty response and rejects invalid data and HTTP failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('[]')).mockResolvedValueOnce(new Response('[{"id":"bad"}]')).mockResolvedValueOnce(new Response('',{status:503}));
    vi.stubGlobal('fetch',fetchMock);
    const signal = new AbortController().signal;
    expect(await fetchOrgTree(signal)).toEqual([]);
    await expect(fetchOrgTree(signal)).rejects.toThrow();
    await expect(fetchOrgTree(signal)).rejects.toThrow('503');
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal);
  });

  it('deduplicates simultaneous requests and reuses data for five seconds', async () => {
    const client = new QueryClient({defaultOptions:{queries:{staleTime:5_000,retry:false}}});
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]'));
    vi.stubGlobal('fetch',fetchMock);
    const options = {queryKey:ORG_QUERY_KEY,queryFn:({signal}:{signal:AbortSignal})=>fetchOrgTree(signal)};
    await Promise.all([client.fetchQuery(options),client.fetchQuery(options)]);
    await client.fetchQuery(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('aborts in-flight fetch when the final observer unmounts', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch',vi.fn((_url:string, {signal}:{signal:AbortSignal})=>{
      requestSignal=signal;
      return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
    }));
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    const observer = new QueryObserver(client,{queryKey:ORG_QUERY_KEY,queryFn:({signal})=>fetchOrgTree(signal)});
    const unsubscribe=observer.subscribe(()=>{});
    expect(requestSignal?.aborted).toBe(false);
    unsubscribe();
    expect(requestSignal?.aborted).toBe(true);
    client.clear();
  });
});
