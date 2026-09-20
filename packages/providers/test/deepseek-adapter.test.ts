import { afterEach, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../src/openai-compatible';

afterEach(() => vi.unstubAllGlobals());
it('injects the DeepSeek URL, key, model and accounting identifier', async () => {
  const fetchMock = vi.fn(async () => new Response('data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n'));
  vi.stubGlobal('fetch', fetchMock);
  const adapter = new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com/v1///', apiKey: 'sk-test', model: 'deepseek-reasoner', providerKey: 'deepseek' });
  const events = [];
  for await (const event of adapter.streamChat([{ role: 'user', content: 'hello' }])) events.push(event);
  expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/v1/chat/completions', expect.objectContaining({
    headers: expect.objectContaining({ authorization: 'Bearer sk-test' }),
    body: expect.stringContaining('"model":"deepseek-reasoner"'),
  }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ model: 'deepseek-reasoner', providerKey: 'deepseek' }) }));
});
